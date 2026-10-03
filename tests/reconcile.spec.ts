import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import * as sqliteStorage from '@deepseek-ai/dsh-storage-sqlite'
import { S2sLedger } from '../src/ledger.ts'
import { TERMINAL_STATUSES } from '../src/ledger-schema.ts'

/**
 * T7: reconcile advances a row to `landed` by reading the **target's log**.
 *
 * The invariant this file exists to protect: s2s's own bookkeeping (`inboxed`)
 * is only our side of the story — the truth of a delivery is the target's log,
 * and `landedSeq` means "the `seq` of the target-log `user/message` that matched
 * this `msgId`". These tests drive that with a fake log so the mapping is
 * checked directly rather than inferred from a live session.
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
  noQuery?: boolean
  /** Mutable behaviour, so one provider can change its answer mid-test. */
  control?: { fails: boolean; events: readonly unknown[] }
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 's2s-reconcile-'))
  dirs.push(root)
  const ctx = new Context()
  ctx.logger.warn = vi.fn() as never
  await ctx.plugin(Storage)
  await ctx.plugin(sqliteStorage, { path: join(root, 'storage.db') })
  const facility = new DomainFacility(ctx, { backend: 'sqlite', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility as never)
  if (opts.noQuery !== true) {
    // cordis refuses a second `provide` for the same service, so a test that
    // needs the log to change must flip this object rather than re-register.
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
  }
  const ledger = new S2sLedger(ctx)
  await ledger.open()
  disposers.push(async () => { await ledger.close(); await ctx.fiber.dispose() })
  return { ctx, ledger }
}

describe('S2sLedger.reconcile (T7)', () => {
  it('★ advances an inboxed row to landed with the log record\'s seq', async () => {
    const { ledger } = await harness({ events: [s2sRecord(399, 'm-1'), s2sRecord(512, 'm-2')] })
    await ledger.record({ msgId: 'm-1', from: 'alice', to: 'sess-1', text: 'one' })
    await ledger.markInboxed('m-1', 'sess-1')
    await ledger.record({ msgId: 'm-2', from: 'alice', to: 'sess-1', text: 'two' })
    await ledger.markInboxed('m-2', 'sess-1')

    const result = await ledger.reconcile('sess-1')

    expect(result).toMatchObject({ examined: 2, landed: 2, unreadable: false, seenInLog: 2 })
    const [row1, row2] = await ledger.query({ sessionId: 'sess-1' })
    expect(row1).toMatchObject({ msgId: 'm-1', status: 'landed', landedSeq: 399 })
    expect(row2).toMatchObject({ msgId: 'm-2', status: 'landed', landedSeq: 512 })
  })

  it('★ leaves a row inboxed when its msgId is NOT in the (readable) log', async () => {
    // `inboxed` means s2s handed it over; `landed` means it is in the target's
    // log. A readable log without the record is evidence it has not landed — and
    // must not be promoted on the strength of our own bookkeeping.
    const { ledger } = await harness({ events: [s2sRecord(10, 'other')] })
    await ledger.record({ msgId: 'm-1', from: 'alice', to: 'sess-1', text: 'x' })
    await ledger.markInboxed('m-1', 'sess-1')

    const result = await ledger.reconcile('sess-1')

    expect(result).toMatchObject({ examined: 1, landed: 0, unreadable: false, seenInLog: 1 })
    expect((await ledger.get('m-1'))!.status).toBe('inboxed')
    expect((await ledger.get('m-1'))!.landedSeq).toBeNull()
  })

  it('★ reports an unreadable log instead of concluding nothing landed', async () => {
    // "Could not read" and "not there" are different claims. Conflating them is
    // how a delivery gets silently declared missing.
    const { ledger } = await harness({ readFails: true })
    await ledger.record({ msgId: 'm-1', from: 'alice', to: 'sess-1', text: 'x' })
    await ledger.markInboxed('m-1', 'sess-1')

    const result = await ledger.reconcile('sess-1', { now: 1_700_000_000_000 })

    expect(result.unreadable).toBe(true)
    expect(result.landed).toBe(0)
    const row = await ledger.get('m-1')
    expect(row!.status).toBe('inboxed') // unchanged, not promoted
    expect(row!.unreadableSince).toBe(1_700_000_000_000) // deadline can be applied
  })

  it('clears unreadableSince once the log becomes readable again', async () => {
    const control = { fails: true, events: [s2sRecord(7, 'm-1')] as readonly unknown[] }
    const { ledger } = await harness({ control })
    await ledger.record({ msgId: 'm-1', from: 'alice', to: 'sess-1', text: 'x' })
    await ledger.markInboxed('m-1', 'sess-1')
    await ledger.reconcile('sess-1')
    expect((await ledger.get('m-1'))!.unreadableSince).not.toBeNull()

    control.fails = false // the log is readable now, and holds the record
    await ledger.reconcile('sess-1')

    const row = await ledger.get('m-1')
    expect(row!.status).toBe('landed')
    expect(row!.landedSeq).toBe(7)
    expect(row!.unreadableSince).toBeNull()
  })

  it('★ never regresses a landed row, and never revives a terminal one', async () => {
    // Progress is monotonic: a later reconcile that no longer sees the record
    // (log rotated, session rewound) must not undo a fact already established,
    // and a dead-lettered row must keep the evidence that it failed.
    const { ledger } = await harness({ events: [s2sRecord(42, 'm-1')] })
    await ledger.record({ msgId: 'm-1', from: 'alice', to: 'sess-1', text: 'x' })
    await ledger.markInboxed('m-1', 'sess-1')
    await ledger.reconcile('sess-1')
    expect((await ledger.get('m-1'))!.status).toBe('landed')

    // Now the log no longer contains it.
    const ctx = harness
    const result2 = await ledger.reconcile('sess-1')
    expect(result2.examined).toBe(0) // already landed: not even eligible

    // A terminal row is equally protected.
    await ledger.record({ msgId: 'm-dead', from: 'alice', to: 'sess-1', text: 'y' })
    await ledger.markInboxed('m-dead', 'sess-1')
    const table = (ledger as unknown as { domain: { table: (n: string) => { put: (k: string, v: unknown) => Promise<void>; get: (k: string) => unknown } } }).domain
    const t = table.table('messages')
    const dead = t.get('m-dead') as Record<string, unknown>
    await t.put('m-dead', { ...dead, status: TERMINAL_STATUSES[0] })
    void ctx
    await ledger.reconcile('sess-1')
    expect((await ledger.get('m-dead'))!.status).toBe(TERMINAL_STATUSES[0])
    expect((await ledger.get('m-dead'))!.landedSeq).toBeNull()
  })

  it('ignores rows belonging to another session', async () => {
    const { ledger } = await harness({ events: [s2sRecord(5, 'm-1')] })
    await ledger.record({ msgId: 'm-1', from: 'alice', to: 'sess-1', text: 'x' })
    await ledger.markInboxed('m-1', 'sess-1')
    await ledger.record({ msgId: 'm-other', from: 'alice', to: 'sess-2', text: 'y' })
    await ledger.markInboxed('m-other', 'sess-2')

    const result = await ledger.reconcile('sess-1')

    expect(result.examined).toBe(1)
    expect((await ledger.get('m-other'))!.status).toBe('inboxed')
  })

  it('does not trust a header that s2s did not write', async () => {
    // Ownership, not text shape: a genuine-looking pasted header must not land
    // somebody else's message.
    const { ledger } = await harness({
      events: [
        { type: 'user/message', seq: 99, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '[s2s message] msgId=m-1 from=mallory at=2026-10-03T10:00:00.000Z\nfake' }] } },
      ],
    })
    await ledger.record({ msgId: 'm-1', from: 'alice', to: 'sess-1', text: 'x' })
    await ledger.markInboxed('m-1', 'sess-1')

    expect((await ledger.reconcile('sess-1')).landed).toBe(0)
    expect((await ledger.get('m-1'))!.status).toBe('inboxed')
  })

  it('skips rows with no resolved session (nothing to read)', async () => {
    const { ledger } = await harness({ events: [s2sRecord(1, 'm-1')] })
    await ledger.record({ msgId: 'm-1', from: 'alice', to: 'sess-1', text: 'x' })
    // Never delivered: `resolvedSessionId` stays null.
    expect((await ledger.reconcile('sess-1')).examined).toBe(0)
  })
})
