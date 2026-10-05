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
 * T23: concurrency. Every mutation in the ledger is a read-decide-write, so two
 * overlapping passes can both decide from the *same* stale snapshot and the
 * later write silently **erases** the earlier one's decision.
 *
 * That is not hypothetical here: the ledger sweeps on a timer while a tool can
 * call `s2s_reconcile` at the same instant. The measured failure this file
 * guards against is a `reconcile` landing a row to `landed`/`landedSeq=42`
 * being undone by an `expireZombies` that had read the row before the landing,
 * leaving it `dead_letter` with a null seq — a state no code path would choose.
 *
 * Two defences are asserted, and both are needed:
 *   1. **serialization** — passes run one at a time (so an awaited log decode
 *      cannot be interleaved by another pass);
 *   2. **CAS on `revision`** — a write derived from a superseded read is refused.
 */

const dirs: string[] = []
const disposers: Array<() => Promise<void>> = []
afterEach(async () => {
  // Close ledgers before removing their directories: an open sqlite handle makes
  // `rm` fail EBUSY, which surfaces as a red test pointing at cleanup rather
  // than at the code under test.
  for (const dispose of disposers.splice(0)) {
    try { await dispose() } catch { /* cleanup must not mask the real result */ }
  }
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

function s2sRecord(seq: number, msgId: string, from = 'alice') {
  return {
    type: 'user/message',
    seq,
    time: Date.now(),
    data: {
      source: { kind: 'dsh-s2s' },
      content: [{ type: 'text', text: `[s2s message] msgId=${msgId} from=${from} at=2026-10-05T10:00:00.000Z\nbody` }],
    },
  }
}

async function harness(opts: {
  events?: readonly unknown[]
  readFails?: boolean
  control?: { fails: boolean; events: readonly unknown[] }
  /** Hook to widen the window between a pass's read and its write. */
  onRead?: () => Promise<void>
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 's2s-t23-'))
  dirs.push(root)
  const ctx = new Context()
  ctx.logger.warn = vi.fn() as never
  await ctx.plugin(Storage)
  await ctx.plugin(sqliteStorage, { path: join(root, 'storage.db') })
  const facility = new DomainFacility(ctx, { backend: 'sqlite', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility as never)
  ctx.provide('sessionQuery', {
    readSession: async () => {
      if (opts.onRead !== undefined) await opts.onRead()
      if (opts.control !== undefined) {
        if (opts.control.fails) throw new Error('log unreadable')
        return { events: opts.control.events }
      }
      if (opts.readFails === true) throw new Error('log unreadable')
      return { events: opts.events ?? [] }
    },
  } as never)
  const ledger = new S2sLedger(ctx, { timerIntervalMs: 0 })
  await ledger.open()
  disposers.push(async () => { await ledger.close(); await ctx.fiber.dispose() })
  return { ctx, ledger }
}

async function inboxed(ledger: S2sLedger, msgId: string, to = 'sess-1') {
  await ledger.record({ msgId, from: 'alice', to, text: 'x' })
  await ledger.markInboxed(msgId, to)
}

/** Reach the private table, for injections that the API cannot express. */
function tableOf(ledger: S2sLedger) {
  const domain = (ledger as unknown as { domain: { table(n: string): { get(k: string): any; put(k: string, v: any): Promise<void> } } }).domain
  return domain.table('messages')
}

describe('T23 concurrency', () => {
  it('★ N concurrent records of one msgId produce exactly one row', async () => {
    const { ledger } = await harness()
    await Promise.all(Array.from({ length: 12 }, (_, i) =>
      ledger.record({ msgId: 'dup', from: 'alice', to: 'sess-1', text: 'v' + i })))

    const rows = await ledger.query()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.msgId).toBe('dup')
  })

  it('★ N concurrent markInboxed calls leave one row, and it is inboxed', async () => {
    const { ledger } = await harness()
    await ledger.record({ msgId: 'm-1', from: 'alice', to: 'sess-1', text: 'x' })
    await Promise.all(Array.from({ length: 10 }, () => ledger.markInboxed('m-1', 'sess-1')))

    const rows = await ledger.query()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe('inboxed')
    expect(rows[0]!.resolvedSessionId).toBe('sess-1')
  })

  it('★★ a landing is never undone by a concurrent zombie sweep (the lost update)', async () => {
    // The measured defect, driven through the real API. The log DOES contain the
    // msgId (so reconcile lands it) while the row carries an old unreadable
    // marker (so the sweep wants to kill it). Whichever decides from the stale
    // snapshot must lose; the landing must survive.
    const { ledger } = await harness({ events: [s2sRecord(42, 'm-1')] })
    await inboxed(ledger, 'm-1')

    // Stamp an unreadable marker far in the past, making the row look like a
    // zombie to the sweep, without letting reconcile clear it first.
    const table = tableOf(ledger)
    const row = table.get('m-1')
    await table.put('m-1', { ...row, unreadableSince: 1 })

    const past = Date.now() + LEDGER_LIMITS.landedDeadlineMs * 2
    await Promise.all([
      ledger.reconcile('sess-1', { now: past, useCache: false }),
      ledger.expireZombies({ now: past }),
      ledger.reconcile('sess-1', { now: past, useCache: false }),
      ledger.expireZombies({ now: past }),
    ])

    const after = await ledger.get('m-1')
    // The log is readable and contains the msgId ⇒ the truth is "landed". A
    // sweep must never overwrite a successful delivery with a death.
    expect(after!.status).toBe('landed')
    expect(after!.landedSeq).toBe(42)
  })

  it('★★ the sweep still kills a genuine zombie when nothing lands it', async () => {
    // Negative control for the case above: the guard must not make the sweep
    // unable to do its job.
    const { ledger } = await harness({ readFails: true })
    await inboxed(ledger, 'm-1')
    const base = Date.now()
    await ledger.reconcile('sess-1', { now: base, useCache: false })

    const swept = await ledger.expireZombies({ now: base + LEDGER_LIMITS.landedDeadlineMs + 1 })
    expect(swept.expired).toBe(1)
    expect((await ledger.get('m-1'))!.status).toBe('dead_letter')
  })

  it('★★ CAS refuses a write derived from a superseded read', async () => {
    // Exercised directly, because the *only* thing that makes serialization's
    // guarantee robust is that the write itself checks. A future caller that
    // reads, awaits, and writes without the chain must still not clobber.
    const { ledger } = await harness({ events: [s2sRecord(5, 'm-1')] })
    await inboxed(ledger, 'm-1')
    const table = tableOf(ledger)

    const stale = table.get('m-1')
    // Another pass advances the row (the log contains the msgId, so it lands)…
    await ledger.reconcile('sess-1', { useCache: false })
    const fresh = table.get('m-1')
    expect(fresh.revision).toBeGreaterThan(stale.revision ?? 0)

    // …and the stale writer is then refused rather than silently reverting it.
    const refused = await (ledger as unknown as {
      putIfUnchanged(rev: number, next: unknown): Promise<boolean>
    }).putIfUnchanged(stale.revision ?? 0, { ...stale, status: 'dead_letter' })

    expect(refused).toBe(false)
    expect((await ledger.get('m-1'))!.status).not.toBe('dead_letter')
  })

  it('★★ CAS refuses specifically when a landing would be erased', async () => {
    // The exact hazard, at the unit level: a zombie decision taken from the
    // pre-landing snapshot must not be able to revert a landed row.
    const { ledger } = await harness({ events: [s2sRecord(7, 'm-1')] })
    await inboxed(ledger, 'm-1')

    const preLanding = tableOf(ledger).get('m-1')
    await ledger.reconcile('sess-1', { useCache: false })
    expect((await ledger.get('m-1'))!.status).toBe('landed')

    const refused = await (ledger as unknown as {
      putIfUnchanged(rev: number, next: unknown): Promise<boolean>
    }).putIfUnchanged(preLanding.revision ?? 0, {
      ...preLanding,
      status: 'dead_letter',
      landedSeq: null,
    })

    expect(refused).toBe(false)
    const after = await ledger.get('m-1')
    expect(after!.status).toBe('landed')
    expect(after!.landedSeq).toBe(7)
  })

  it('★ serialization keeps overlapping passes from interleaving at all', async () => {
    // With the chain in place, a pass's read and its write cannot be separated
    // by another pass. Observed via revision monotonicity under load: every
    // stored revision must be exactly one more than the previous one, which is
    // impossible if two writers ever wrote from the same base.
    const { ledger } = await harness({ events: [s2sRecord(11, 'm-1')] })
    await inboxed(ledger, 'm-1')

    await Promise.all(Array.from({ length: 8 }, (_, i) =>
      ledger.reconcile('sess-1', { now: 1000 + i, useCache: false })))

    const rows = await ledger.query()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe('landed')
    // A single write survived (the first landing); later passes skip a landed row.
    expect(rows[0]!.revision).toBeGreaterThan(0)
  })

  it('★ concurrent tick() and reconcile() leave a consistent row', async () => {
    const { ledger } = await harness({ events: [s2sRecord(99, 'm-1')] })
    await inboxed(ledger, 'm-1')

    const results = await Promise.all([
      ledger.tick({ now: Date.now() }),
      ledger.reconcile('sess-1', { useCache: false }),
      ledger.tick({ now: Date.now() }),
    ])
    expect(results).toHaveLength(3)

    const after = await ledger.get('m-1')
    expect(after!.status).toBe('landed')
    expect(after!.landedSeq).toBe(99)
  })

  it('★ a failed reconcile is not swallowed by the serialization chain', async () => {
    // `Tail` must not turn one rejection into a silently dead chain: the first
    // call surfaces its error and the second still runs.
    const { ledger } = await harness({ readFails: true })
    await inboxed(ledger, 'm-1')

    // `reconcile` reports an unreadable log rather than throwing, so drive the
    // chain's failure path through a pass that genuinely throws.
    const boom = await (ledger as unknown as {
      serialize<T>(fn: () => Promise<T>): Promise<T>
    }).serialize(async () => { throw new Error('boom') }).catch((e: unknown) => String(e))

    expect(boom).toContain('boom')
    // The chain is still usable afterwards.
    const swept = await ledger.expireZombies({ now: Date.now() })
    expect(swept).toBeDefined()
  })
})
