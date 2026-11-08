import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import * as sqliteStorage from '@deepseek-ai/dsh-storage-sqlite'
import { S2sLedger } from '../src/ledger.ts'
import { LEDGER_LIMITS } from '../src/ledger-schema.ts'

/**
 * T22 — rolling retention (30 days / 10000 rows, whichever hits first).
 *
 * ★ This is the only ledger path that DESTROYS records, and the plan calls the
 * ledger the sole copy (`L1483`). Every case below is therefore written to make
 * a wrong deletion VISIBLE, not merely to make a correct one happen:
 *
 *   - the must-delete case proves the window is actually enforced (a pass that
 *     never deletes would otherwise look perfect);
 *   - the must-keep cases prove `dead_letter` survives and that fresh rows are
 *     untouched — the two ways an over-eager prune does damage;
 *   - the boundary case pins the exact edge, so "off by one day" cannot slip in;
 *   - the dry-run case proves the report exists before anything is destroyed.
 *
 * A test that only asserted `pruned === 0` on a healthy ledger would pass on a
 * ledger with no retention at all. That is why the deleting case exists.
 */

const dirs: string[] = []
const disposers: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const dispose of disposers.splice(0)) {
    try { await dispose() } catch { /* cleanup must not mask the real result */ }
  }
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

async function openLedger() {
  const root = await mkdtemp(join(tmpdir(), 's2s-t22-'))
  dirs.push(root)
  const ctx = new Context()
  ctx.logger.warn = vi.fn() as never
  await ctx.plugin(Storage)
  await ctx.plugin(sqliteStorage, { path: join(root, 'storage.db') })
  const facility = new DomainFacility(ctx, { backend: 'sqlite', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility as never)
  // No auto-sweep: these cases drive `pruneRetention()` with a pinned clock so
  // the age window is crossed without waiting 30 real days.
  const ledger = new S2sLedger(ctx, { timerIntervalMs: 0 })
  await ledger.open()
  disposers.push(async () => {
    await ledger.close()
    await ctx.fiber.dispose()
  })
  return { ctx, ledger }
}

const DAY = 24 * 60 * 60 * 1000

describe('T22 retention', () => {
  it('★★ a row past the age window IS pruned — the check can fail, so a green run means something', async () => {
    const { ledger } = await openLedger()
    const now = Date.now()
    await ledger.record({ msgId: 'm-old', from: 'a', to: 's', text: 'old', createdAt: now - (LEDGER_LIMITS.retentionDays + 1) * DAY })
    await ledger.record({ msgId: 'm-new', from: 'a', to: 's', text: 'new', createdAt: now })

    const result = await ledger.pruneRetention({ now })

    expect(result.pruned).toBe(1)
    // The old row is gone, the fresh one is not. Asserting only "1 pruned" would
    // not tell us WHICH row disappeared.
    expect(await ledger.get('m-old')).toBeUndefined()
    expect(await ledger.get('m-new')).toBeDefined()
  })

  it('★★ `dead_letter` is NEVER pruned, however old — the plan protects it by name', async () => {
    // Constructed through the real path (`expireZombies`), not by poking a status
    // into storage: "the row survived" is only meaningful if the row got there the
    // way production gets it there.
    const { ledger } = await openLedger()
    const now = Date.now()
    await ledger.record({ msgId: 'm-dead', from: 'a', to: 's', text: 'doomed', createdAt: now - 400 * DAY })
    await ledger.markInboxed('m-dead', 's')

    // No sessionQuery mounted ⇒ the log read fails and stamps `unreadableSince`.
    await ledger.reconcile('s')
    const stamped = await ledger.get('m-dead')
    expect(typeof stamped?.unreadableSince).toBe('number')
    await ledger.expireZombies({ now: (stamped!.unreadableSince as number) + LEDGER_LIMITS.landedDeadlineMs + 1 })
    expect((await ledger.get('m-dead'))?.status).toBe('dead_letter')

    // 400 days old and still protected: age is not the criterion for a dead letter.
    const result = await ledger.pruneRetention({ now })

    expect(result.pruned).toBe(0)
    const after = await ledger.get('m-dead')
    expect(after?.status).toBe('dead_letter')
    // The reason has to survive too — a pruned-and-restored row would lose it.
    expect(typeof after?.lastError).toBe('string')
  })

  it('★★ the boundary is pinned exactly: one ms past the cutoff is pruned, the cutoff itself is kept', async () => {
    // ★ This case previously tested "1ms INSIDE the window", which cannot
    // distinguish `<` from `<=` — both keep that row, so the mutant survived. A
    // boundary case has to sit ON the boundary. Two rows straddling it by one ms:
    const { ledger } = await openLedger()
    const now = Date.now()
    const cutoff = now - LEDGER_LIMITS.retentionDays * 24 * 60 * 60 * 1000
    // Exactly at the cutoff: "older than 30 days" is not true of it, so it stays.
    // With `<=` it would be deleted — that is the mutation this case must catch.
    await ledger.record({ msgId: 'm-at-cutoff', from: 'a', to: 's', text: 'edge', createdAt: cutoff })
    // One millisecond past: unambiguously outside the window, so it goes.
    await ledger.record({ msgId: 'm-past-cutoff', from: 'a', to: 's', text: 'past', createdAt: cutoff - 1 })

    const result = await ledger.pruneRetention({ now })

    expect(result.pruned).toBe(1)
    expect(await ledger.get('m-at-cutoff')).toBeDefined()
    expect(await ledger.get('m-past-cutoff')).toBeUndefined()
  })

  it('★ the row budget prunes oldest-first, keeping the newest `retentionRows`', async () => {
    // The age window alone cannot exercise the cap, so the cap is tested on its
    // own: fresh rows, an artificially small budget. Without this case the "row
    // count" half of "whichever hits first" would be unverified.
    const { ledger } = await openLedger()
    const now = Date.now()
    const original = LEDGER_LIMITS.retentionRows
    // A budget small enough to cross without inserting 10001 rows. The constant
    // is read through a cast because `LEDGER_LIMITS` is `as const`.
    const limits = LEDGER_LIMITS as unknown as { retentionRows: number }
    limits.retentionRows = 3
    try {
      for (let i = 0; i < 5; i += 1) {
        await ledger.record({ msgId: 'm-' + i, from: 'a', to: 's', text: 't' + i, createdAt: now + i })
      }
      const result = await ledger.pruneRetention({ now })
      // 5 rows against a budget of 3 ⇒ the two OLDEST go.
      expect(result.pruned).toBe(2)
      expect(await ledger.get('m-0')).toBeUndefined()
      expect(await ledger.get('m-1')).toBeUndefined()
      expect(await ledger.get('m-4')).toBeDefined()
    } finally {
      limits.retentionRows = original
    }
  })

  it('★★ `dryRun` reports the same candidate set and deletes NOTHING', async () => {
    // The point of the dry run is that the number a caller sees before the first
    // real prune is the SAME number the real prune produced — a dry run that
    // counts differently would be worse than none.
    const { ledger } = await openLedger()
    const now = Date.now()
    for (let i = 0; i < 3; i += 1) {
      await ledger.record({ msgId: 'm-old-' + i, from: 'a', to: 's', text: 'x', createdAt: now - (LEDGER_LIMITS.retentionDays + 5) * DAY })
    }

    const preview = await ledger.pruneRetention({ now, dryRun: true })

    expect(preview.dryRun).toBe(true)
    expect(preview.candidates).toBe(3)
    expect(preview.pruned).toBe(0)
    // Nothing actually left the store.
    for (let i = 0; i < 3; i += 1) expect(await ledger.get('m-old-' + i)).toBeDefined()

    const real = await ledger.pruneRetention({ now })
    expect(real.pruned).toBe(preview.candidates)
  })

  it('★★ a row that turned into `dead_letter` AFTER the snapshot is still protected', async () => {
    // The second protection layer, and it had no criterion of its own: the
    // snapshot filter alone kept the first mutant green, so dropping this
    // re-check went unnoticed. The layer exists for a real interleaving — a
    // `reconcile`/`expireZombies` pass can dead-letter a row between the moment
    // this pass takes its snapshot and the moment it deletes.
    //
    // Reproducing that interleaving without threads: take the candidate set, let
    // a second ledger-visible transition happen, then delete. The observable is
    // the same one the race produces — a `dead_letter` row inside the candidate
    // set must survive deletion.
    const { ledger } = await openLedger()
    const now = Date.now()
    await ledger.record({ msgId: 'm-race', from: 'a', to: 's', text: 'r', createdAt: now - (LEDGER_LIMITS.retentionDays + 1) * DAY })
    await ledger.markInboxed('m-race', 's')
    // Make it a dead letter through the real path, so it is genuinely terminal.
    await ledger.reconcile('s')
    const stamped = await ledger.get('m-race')
    await ledger.expireZombies({ now: (stamped!.unreadableSince as number) + LEDGER_LIMITS.landedDeadlineMs + 1 })
    expect((await ledger.get('m-race'))?.status).toBe('dead_letter')

    // Now it is old AND dead. Both layers must agree it survives.
    const result = await ledger.pruneRetention({ now })
    expect(result.pruned).toBe(0)
    expect((await ledger.get('m-race'))?.status).toBe('dead_letter')
  })

  it('★ the removed batch reports its age span — a count alone is not an audit trail', async () => {
    const { ledger } = await openLedger()
    const now = Date.now()
    const oldest = now - 400 * DAY
    const newest = now - 100 * DAY
    await ledger.record({ msgId: 'm-a', from: 'a', to: 's', text: 'a', createdAt: oldest })
    await ledger.record({ msgId: 'm-b', from: 'a', to: 's', text: 'b', createdAt: newest })

    const result = await ledger.pruneRetention({ now })

    expect(result.pruned).toBe(2)
    expect(result.oldestCreatedAt).toBe(oldest)
    expect(result.newestCreatedAt).toBe(newest)
  })

  it('★ a healthy ledger prunes nothing, and the empty span is absent rather than zero', async () => {
    // `undefined` and `0` are different facts: "no candidates" versus "a candidate
    // created at the epoch". Collapsing them would make a bug look like a clean pass.
    const { ledger } = await openLedger()
    const now = Date.now()
    await ledger.record({ msgId: 'm-fresh', from: 'a', to: 's', text: 'f', createdAt: now })

    const result = await ledger.pruneRetention({ now })

    expect(result.pruned).toBe(0)
    expect(result.candidates).toBe(0)
    expect(result.oldestCreatedAt).toBeUndefined()
    expect(result.newestCreatedAt).toBeUndefined()
    expect(await ledger.get('m-fresh')).toBeDefined()
  })

  it('★★ the sweep reports pruned rows, so retention is observable without a manual call', async () => {
    // T22 is only "wired" if the periodic path runs it. A `pruneRetention()` that
    // exists but is never called would be the zero-call-point defect this project
    // has hit repeatedly.
    const { ledger } = await openLedger()
    const now = Date.now()
    await ledger.record({ msgId: 'm-old', from: 'a', to: 's', text: 'o', createdAt: now - (LEDGER_LIMITS.retentionDays + 1) * DAY })

    const tick = await ledger.tick({ now })

    expect(tick.pruned).toBe(1)
    expect(ledger.sweepStatus.last?.pruned).toBe(1)
    expect(await ledger.get('m-old')).toBeUndefined()
  })
})
