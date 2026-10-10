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
 * T8-2: make the log-read cache **observable**, without changing what it does.
 *
 * Why this exists: `s2s_reconcile` already printed `cache=honoured|bypassed`, and
 * that was read as evidence of a cache hit. It is not — it only reports what the
 * *caller* asked for (`use_cache: false`). A caller can honour the cache and
 * still miss, and an entry can exist while being too old to use. So the reported
 * fact and the inferred fact disagreed, which is the failure mode these fields
 * remove.
 *
 * The two fields are computed from the pass's own freshness decision:
 *   - `cacheHit` — did this pass reuse a cached read?
 *   - `logReads` — how many times did it actually read the log (0 or 1)?
 *
 * `logReads` is a count rather than a boolean because it is the measurable
 * thing: "the second call inside the TTL did not re-read" becomes a direct
 * assertion instead of a timing inference.
 *
 * Scope note: read-only. No new persistence, no change to what `reconcile`
 * decides or writes — asserted by the behaviour cases below still expecting the
 * same statuses.
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

/** One `user/message` record carrying an s2s header at a known `seq`. */
function s2sRecord(seq: number, msgId: string, from = 'alice') {
  return {
    type: 'user/message',
    seq,
    time: Date.now(),
    data: {
      source: { kind: 'dsh-s2s' },
      content: [{ type: 'text', text: `[s2s message] msgId=${msgId} from=${from} at=2026-10-03T10:00:00.000Z\nbody` }],
    },
  }
}

/** A ledger over sqlite plus a `sessionQuery` answering with a fixed event log. */
async function harness(opts: {
  events?: readonly unknown[]
  readFails?: boolean
  /** Mutable behaviour, so one provider can change its answer mid-test. */
  control?: { fails: boolean; events: readonly unknown[] }
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 's2s-t8-2-'))
  dirs.push(root)
  const ctx = new Context()
  ctx.logger.warn = vi.fn() as never
  await ctx.plugin(Storage)
  await ctx.plugin(sqliteStorage, { path: join(root, 'storage.db') })
  const facility = new DomainFacility(ctx, { backend: 'sqlite', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility as never)
  // cordis refuses a second `provide` for the same service, so a test that needs
  // the log to change must flip this object rather than re-register.
  ctx.provide('sessionQuery', {
    readSession: async () => {
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

  /** Count every real log read, whoever asks for it. */
  let reads = 0
  const query = ctx.get('sessionQuery') as { readSession(id: string): Promise<unknown> }
  const inner = query.readSession.bind(query)
  query.readSession = async (id: string) => { reads += 1; return await inner(id) }
  return { ctx, ledger, reads: () => reads }
}

async function inboxed(ledger: S2sLedger, msgId = 'm-1') {
  await ledger.record({ msgId, from: 'alice', to: 'sess-1', text: 'x' })
  await ledger.markInboxed(msgId, 'sess-1')
}

describe('reconcile read-cache observability (T8-2)', () => {
  it('★ reports a miss then a hit, and the read count is what proves it', async () => {
    const { ledger, reads } = await harness({ events: [s2sRecord(7, 'm-1')] })
    await inboxed(ledger)

    const first = await ledger.reconcile('sess-1')
    expect(first.cacheHit).toBe(false)
    expect(first.logReads).toBe(1)

    const second = await ledger.reconcile('sess-1')
    expect(second.cacheHit).toBe(true)
    expect(second.logReads).toBe(0)
    // Cross-check against the provider: the field agrees with reality.
    expect(reads()).toBe(1)
  })

  it('★ `use_cache: false` forces a miss even with a fresh entry', async () => {
    // The distinction that makes the old field useless as a hit signal: the
    // caller can bypass the cache, and then a read happens regardless of age.
    const { ledger, reads } = await harness({ events: [s2sRecord(7, 'm-1')] })
    await inboxed(ledger)

    await ledger.reconcile('sess-1')
    const bypassed = await ledger.reconcile('sess-1', { useCache: false })
    expect(bypassed.cacheHit).toBe(false)
    expect(bypassed.logReads).toBe(1)
    expect(reads()).toBe(2)
  })

  it('★ NEGATIVE: a stale entry is a miss, not a hit', async () => {
    // Falsifies "cacheHit == an entry exists": past the success TTL the pass must
    // read again, and saying otherwise would hide a stale read.
    const { ledger, reads } = await harness({ events: [s2sRecord(7, 'm-1')] })
    await inboxed(ledger)

    const base = 1_700_000_000_000
    await ledger.reconcile('sess-1', { now: base })
    const later = await ledger.reconcile('sess-1', { now: base + LEDGER_LIMITS.reconcileTtlMs + 1 })
    expect(later.cacheHit).toBe(false)
    expect(later.logReads).toBe(1)
    expect(reads()).toBe(2)
  })

  it('★ NEGATIVE: a cached FAILED read is fresh only inside the shorter TTL', async () => {
    // The failure TTL being shorter is the whole point of T8. At an instant past
    // it but still well inside the success TTL, the entry must count as stale.
    const control = { fails: true, events: [s2sRecord(7, 'm-1')] as readonly unknown[] }
    const { ledger, reads } = await harness({ control })
    await inboxed(ledger)

    const base = 1_700_000_000_000
    const failed = await ledger.reconcile('sess-1', { now: base })
    expect(failed.unreadable).toBe(true)
    expect(failed.cacheHit).toBe(false)
    expect(failed.logReads).toBe(1)

    control.fails = false
    const recovered = await ledger.reconcile('sess-1', { now: base + LEDGER_LIMITS.reconcileFailureTtlMs + 1 })
    expect(recovered.cacheHit).toBe(false)
    expect(recovered.logReads).toBe(1)
    expect(recovered.unreadable).toBe(false)
    expect(reads()).toBe(2)
  })

  it('★ NEGATIVE: inside the failure TTL the failed read IS a hit (no re-read)', async () => {
    // The other side of the same rule, so the check cannot pass by always
    // reporting a miss.
    const control = { fails: true, events: [s2sRecord(7, 'm-1')] as readonly unknown[] }
    const { ledger, reads } = await harness({ control })
    await inboxed(ledger)

    const base = 1_700_000_000_000
    await ledger.reconcile('sess-1', { now: base })
    const again = await ledger.reconcile('sess-1', { now: base + LEDGER_LIMITS.reconcileFailureTtlMs - 1 })
    expect(again.cacheHit).toBe(true)
    expect(again.logReads).toBe(0)
    expect(reads()).toBe(1)
  })

  it('★ the new fields do not change what reconcile decides', async () => {
    // Read-only means read-only: same statuses, same landedSeq, same counts.
    const { ledger } = await harness({ events: [s2sRecord(399, 'm-1')] })
    await inboxed(ledger)

    const result = await ledger.reconcile('sess-1')
    expect(result).toMatchObject({ examined: 1, landed: 1, unreadable: false, seenInLog: 1 })
    const [row] = await ledger.query({ sessionId: 'sess-1' })
    expect(row).toMatchObject({ status: 'landed', landedSeq: 399 })
  })

  it('★ logCacheStatus is readable without running a pass, and mirrors the rule', async () => {
    // `s2s_status` needs this: reconciling in order to inspect the cache would
    // mutate the thing being inspected.
    const { ledger } = await harness({ events: [s2sRecord(7, 'm-1')] })
    await inboxed(ledger)

    expect(ledger.logCacheStatus()).toMatchObject({ sessions: 0, fresh: 0 })
    await ledger.reconcile('sess-1')
    expect(ledger.logCacheStatus()).toMatchObject({ sessions: 1, fresh: 1 })
    // Reading it must not consume or alter the entry.
    expect(ledger.logCacheStatus().sessions).toBe(1)
    expect(ledger.logCacheStatus(Date.now() + LEDGER_LIMITS.reconcileTtlMs + 1).fresh).toBe(0)
  })
})
