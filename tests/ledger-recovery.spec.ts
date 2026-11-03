import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import * as sqliteStorage from '@deepseek-ai/dsh-storage-sqlite'
import { S2sLedger } from '../src/ledger.ts'
import { LEDGER_LIMITS, TERMINAL_STATUSES } from '../src/ledger-schema.ts'

/**
 * T13 / I2 — "startup must repair interrupted state".
 *
 * The invariant has two halves and only one of them is about wording: a crash must
 * not lose queued work, and terminal states must not be revived. Both are asserted
 * here against a real sqlite-backed ledger, because the thing being tested is the
 * *persisted* state a second process would read, not an in-memory field.
 *
 * ★ Why the must-fail case is constructed through `expireZombies()` instead of by
 * writing a `dead_letter` row into the table: §5 requires the input to be built
 * inside the check's own subject area and then *executed*. A row poked straight
 * into storage would prove that the filter compares strings, not that a real
 * terminal row survives — and "the subject was not selected" is exactly the fact
 * under test. The construction path used below is the only one that produces
 * `dead_letter` today (an unreadable target log past the deadline).
 */

const dirs: string[] = []
const disposers: Array<() => Promise<void>> = []

afterEach(async () => {
  // Close before removing: an open sqlite handle makes `rm` fail EBUSY, which
  // shows up as a red test pointing at cleanup instead of at the code.
  for (const dispose of disposers.splice(0)) {
    try { await dispose() } catch { /* cleanup must not mask the real result */ }
  }
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

async function openLedger() {
  const root = await mkdtemp(join(tmpdir(), 's2s-t13-'))
  dirs.push(root)
  const ctx = new Context()
  ctx.logger.warn = vi.fn() as never
  await ctx.plugin(Storage)
  await ctx.plugin(sqliteStorage, { path: join(root, 'storage.db') })
  const facility = new DomainFacility(ctx, { backend: 'sqlite', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility as never)
  const ledger = new S2sLedger(ctx, { timerIntervalMs: 0 })
  await ledger.open()
  disposers.push(async () => {
    await ledger.close()
    await ctx.fiber.dispose()
  })
  return { ctx, ledger }
}

describe('T13 startup self-check', () => {
  it('★ markDelivering wins the CAS on a queued row, sets `delivering`, counts the attempt', async () => {
    const { ledger } = await openLedger()
    await ledger.record({ msgId: 'm-1', from: 'alice', to: 'sess-1', text: 'hello' })

    expect(await ledger.markDelivering('m-1')).toBe(true)

    const row = await ledger.get('m-1')
    expect(row?.status).toBe('delivering')
    // The attempt counter only becomes meaningful once something advances it; this
    // is that something. Before this method existed it was `attempts: 0` forever.
    expect(row?.attempts).toBe(1)
  })

  it('★★ a second markDelivering on the same row LOSES — so only one caller may deliver', async () => {
    const { ledger } = await openLedger()
    await ledger.record({ msgId: 'm-1', from: 'alice', to: 'sess-1', text: 'hello' })

    expect(await ledger.markDelivering('m-1')).toBe(true)
    expect(await ledger.markDelivering('m-1')).toBe(false)

    const row = await ledger.get('m-1')
    // Not just "still delivering": the losing call must not have counted a second
    // attempt either, or the retry budget would shrink without a retry happening.
    expect(row?.status).toBe('delivering')
    expect(row?.attempts).toBe(1)
  })

  it('markDelivering refuses to drag a handed-over row backwards', async () => {
    const { ledger } = await openLedger()
    await ledger.record({ msgId: 'm-1', from: 'alice', to: 'sess-1', text: 'hello' })
    await ledger.markInboxed('m-1', 'sess-1')

    expect(await ledger.markDelivering('m-1')).toBe(false)
    expect((await ledger.get('m-1'))?.status).toBe('inboxed')
  })

  it('markDelivering on a missing row reports false and invents no row', async () => {
    const { ledger } = await openLedger()

    expect(await ledger.markDelivering('never-recorded')).toBe(false)
    // Inventing one here would hide a `record()` that never ran — the same defect
    // `markInboxed` documents and refuses.
    expect(await ledger.get('never-recorded')).toBeUndefined()
  })

  it('★★ a row stuck in `delivering` is returned to `queued` with an immediate retry', async () => {
    const { ledger } = await openLedger()
    await ledger.record({ msgId: 'm-1', from: 'alice', to: 'sess-1', text: 'hello' })
    expect(await ledger.markDelivering('m-1')).toBe(true)

    // Model the crash: nothing else runs, the row simply sits in `delivering`.
    const now = Date.now() + 60_000
    const result = await ledger.recoverInterrupted({ now })

    expect(result.reset).toBe(1)
    const row = await ledger.get('m-1')
    expect(row?.status).toBe('queued')
    // Immediate, not the old stamp: the attempt that was in flight never finished,
    // so there is no backoff to honour. Parking until a future stamp would delay a
    // retry for a reason that never happened.
    expect(row?.nextAttemptAt).toBe(now)
  })

  it('★★ `dead_letter` is NOT revived — and the terminal set is disjoint from `delivering`', async () => {
    const { ledger } = await openLedger()
    await ledger.record({ msgId: 'm-dead', from: 'alice', to: 'sess-1', text: 'hello' })
    await ledger.markInboxed('m-dead', 'sess-1')

    // No session-query is mounted, so this read fails and stamps `unreadableSince`.
    await ledger.reconcile('sess-1')
    const stamped = await ledger.get('m-dead')
    expect(typeof stamped?.unreadableSince).toBe('number')

    const expired = await ledger.expireZombies({ now: (stamped!.unreadableSince as number) + LEDGER_LIMITS.landedDeadlineMs + 1 })
    expect(expired.expired).toBe(1)
    const died = await ledger.get('m-dead')
    expect(died?.status).toBe('dead_letter')
    expect(typeof died?.lastError).toBe('string')

    const recovered = await ledger.recoverInterrupted({ now: Date.now() })
    expect(recovered.reset).toBe(0)
    const after = await ledger.get('m-dead')
    expect(after?.status).toBe('dead_letter')
    // Terminal means terminal: reviving it would re-deliver a message the ledger
    // already gave up on, which is the failure I2 names explicitly. The reason text
    // must survive too — a revived row would typically lose or rewrite it.
    expect(after?.lastError).toBe(died?.lastError)

    // The mechanism behind "cannot be selected": the pass filters on `delivering`,
    // so a status in TERMINAL_STATUSES can never match. If someone later adds
    // `delivering` to that list, this assertion fails before the behaviour rots.
    expect((TERMINAL_STATUSES as readonly string[]).includes('delivering')).toBe(false)
  })

  it('recoverInterrupted is idempotent — the second pass resets nothing', async () => {
    const { ledger } = await openLedger()
    await ledger.record({ msgId: 'm-1', from: 'alice', to: 'sess-1', text: 'hello' })
    await ledger.markDelivering('m-1')

    expect((await ledger.recoverInterrupted()).reset).toBe(1)
    expect((await ledger.recoverInterrupted()).reset).toBe(0)
  })

  it('recoverInterrupted leaves queued and handed-over rows alone', async () => {
    const { ledger } = await openLedger()
    await ledger.record({ msgId: 'm-q', from: 'alice', to: 'sess-1', text: 'queued' })
    await ledger.record({ msgId: 'm-i', from: 'alice', to: 'sess-1', text: 'handed' })
    await ledger.markInboxed('m-i', 'sess-1')
    const before = await ledger.get('m-q')

    expect((await ledger.recoverInterrupted()).reset).toBe(0)

    const after = await ledger.get('m-q')
    expect(after?.status).toBe('queued')
    // A queued row that was never attempted must keep its original stamp: rewriting
    // it would make an unattempted message look like a recovered one.
    expect(after?.nextAttemptAt).toBe(before?.nextAttemptAt)
    expect((await ledger.get('m-i'))?.status).toBe('inboxed')
  })

  it('`requeued` is pinned at 0 while the retry half is unwired (stated, not silent)', async () => {
    const { ledger } = await openLedger()
    await ledger.record({ msgId: 'm-1', from: 'alice', to: 'sess-1', text: 'hello' })
    await ledger.markDelivering('m-1')

    const result = await ledger.recoverInterrupted()
    // This is a placeholder contract, not a measurement: the plan's second startup
    // job ("re-judge rows that never landed") reads `attempts` / `nextAttemptAt`,
    // and nothing advances either yet. Asserting 0 keeps the gap visible in the
    // suite; when the retry half lands this assertion is what has to change.
    expect(result.requeued).toBe(0)
  })

  it('★ a failed attempt rolls back to queued and records why, keeping the attempt count', async () => {
    // `absent` is the ordinary failure (the resolved session had no live agent), so
    // this is not an exotic path: without the rollback the row sits in `delivering`
    // until the next start, i.e. an undeliverable message becomes one that is retried
    // only after a restart.
    const { ledger } = await openLedger()
    await ledger.record({ msgId: 'm-1', from: 'alice', to: 'sess-1', text: 'gone' })
    expect(await ledger.markDelivering('m-1')).toBe(true)

    expect(await ledger.markAttemptFailed('m-1', 'broker reported absent')).toBe(true)

    const row = await ledger.get('m-1')
    expect(row?.status).toBe('queued')
    expect(row?.lastError).toBe('broker reported absent')
    // The attempt really happened: decrementing would make `maxRetries` exhaustion
    // (once that half is wired) under-count a message that keeps failing.
    expect(row?.attempts).toBe(1)
    // No backoff yet — the retry half is a separate task, and a future `nextAttemptAt`
    // would be a value nothing reads.
    expect(row?.nextAttemptAt).toBeTypeOf('number')
  })

  it('★ markAttemptFailed refuses anything that is not an in-flight attempt', async () => {
    // Three distinct must-not-roll-back cases, each for a different reason:
    //   queued     — nothing was in flight, so "failed" would be a fiction
    //   inboxed    — the message WAS handed over; a late failure report from a racing
    //                attempt must not un-deliver it
    //   cancelled  — terminal; a judgement is never revived
    // Constructed AND executed, not merely named: each row is driven into the state
    // and then the call is required to report `false` and leave the status untouched.
    const { ledger } = await openLedger()
    await ledger.record({ msgId: 'm-q', from: 'alice', to: 'sess-1', text: 'q' })
    await ledger.record({ msgId: 'm-i', from: 'alice', to: 'sess-1', text: 'i' })
    await ledger.markInboxed('m-i', 'sess-1')
    await ledger.record({ msgId: 'm-c', from: 'alice', to: 'sess-1', text: 'c' })
    await ledger.cancel('m-c', 'cancelled by the test')

    expect(await ledger.markAttemptFailed('m-q', 'should not apply')).toBe(false)
    expect(await ledger.markAttemptFailed('m-i', 'should not apply')).toBe(false)
    expect(await ledger.markAttemptFailed('m-c', 'should not apply')).toBe(false)
    expect(await ledger.markAttemptFailed('m-missing', 'should not apply')).toBe(false)

    expect((await ledger.get('m-q'))?.status).toBe('queued')
    expect((await ledger.get('m-q'))?.lastError).toBeNull()
    expect((await ledger.get('m-i'))?.status).toBe('inboxed')
    expect((await ledger.get('m-c'))?.status).toBe('cancelled')
    // Nothing was invented for the missing id — the same rule `markInboxed` follows.
    expect(await ledger.get('m-missing')).toBeUndefined()
  })

  it('★ the rollback survives a crash boundary: interrupted work is repaired, failed work is not', async () => {
    // The two paths must be distinguishable after a restart, which is the whole point
    // of `delivering` being persisted. A row that FAILED was rolled back by the live
    // process (status `queued`); a row that was INTERRUPTED is still `delivering` and
    // the self-check repairs it. If the rollback were missing, both would look the
    // same and only the restart would distinguish them — too late to act on.
    const { ledger } = await openLedger()
    await ledger.record({ msgId: 'm-failed', from: 'alice', to: 'sess-1', text: 'f' })
    await ledger.markDelivering('m-failed')
    await ledger.markAttemptFailed('m-failed', 'absent')

    await ledger.record({ msgId: 'm-stuck', from: 'alice', to: 'sess-1', text: 's' })
    await ledger.markDelivering('m-stuck')

    expect(await ledger.markDelivering('m-stuck')).toBe(false) // already in flight

    expect((await ledger.recoverInterrupted()).reset).toBe(1)
    expect((await ledger.get('m-stuck'))?.status).toBe('queued')
    expect((await ledger.get('m-failed'))?.status).toBe('queued')
    // The recovered row is immediately retryable; the failed one already was.
    expect((await ledger.get('m-failed'))?.lastError).toBe('absent')
    expect((await ledger.get('m-stuck'))?.attempts).toBe(1)
  })

  it('★★ the delivery gate: every refusal reason is its own case, and its own rule', async () => {
    // A boolean gate was a real defect: "false" was read as "carry on", which would
    // hand over a message the ledger had recorded as `cancelled` — sending something
    // explicitly cancelled is a behavioural error, not a duplicate. Each row below is
    // driven into its state and then the gate is required to report that reason, so
    // no two rows can pass by accident.
    const { ledger } = await openLedger()

    await ledger.record({ msgId: 'm-queued', from: 'alice', to: 'sess-1', text: 'q' })
    expect(await ledger.claimDelivery('m-queued')).toEqual({ decision: 'deliver', reason: 'claimed' })
    expect((await ledger.get('m-queued'))?.status).toBe('delivering')

    // Missing row: deliver anyway (T6b), and do NOT invent one.
    expect(await ledger.claimDelivery('m-missing')).toEqual({ decision: 'deliver', reason: 'untracked' })
    expect(await ledger.get('m-missing')).toBeUndefined()

    // Already handed over ⇒ delivering again would duplicate it.
    expect(await ledger.claimDelivery('m-queued')).toEqual({ decision: 'refuse', reason: 'in-flight' })

    await ledger.record({ msgId: 'm-inboxed', from: 'alice', to: 'sess-1', text: 'i' })
    await ledger.markInboxed('m-inboxed', 'sess-1')
    expect(await ledger.claimDelivery('m-inboxed')).toEqual({ decision: 'refuse', reason: 'delivered' })

    await ledger.record({ msgId: 'm-cancelled', from: 'alice', to: 'sess-1', text: 'c' })
    await ledger.cancel('m-cancelled', 'cancelled by the test')
    expect(await ledger.claimDelivery('m-cancelled')).toEqual({ decision: 'refuse', reason: 'terminal' })
  })

  it('★ a refused claim leaves the row exactly as it was (no attempt was started)', async () => {
    const { ledger } = await openLedger()
    await ledger.record({ msgId: 'm-c', from: 'alice', to: 'sess-1', text: 'c' })
    await ledger.cancel('m-c', 'cancelled by the test')
    const before = await ledger.get('m-c')

    await ledger.claimDelivery('m-c')

    const after = await ledger.get('m-c')
    expect(after?.status).toBe('cancelled')
    // A refusal must not count as an attempt: `attempts` is the honest count the retry
    // half will use, and bumping it for a delivery that never started would inflate it.
    expect(after?.attempts).toBe(before?.attempts)
    expect(after?.revision).toBe(before?.revision)
  })

  it('★ a late failure report cannot un-deliver a message that already landed', async () => {
    // The rollback is whitelisted on `delivering`, and this is the case that makes
    // the whitelist load-bearing rather than decorative: a racing attempt reports
    // failure after the row was advanced to `inboxed`. Rolling back would erase a
    // real delivery, so the call must report false and change nothing.
    const { ledger } = await openLedger()
    await ledger.record({ msgId: 'm-1', from: 'alice', to: 'sess-1', text: 'late' })
    expect(await ledger.markDelivering('m-1')).toBe(true)

    await ledger.markInboxed('m-1', 'sess-1')
    // The row now carries the resolved session; the rollback must not clear it.
    const landed = await ledger.get('m-1')
    expect(landed?.status).toBe('inboxed')

    expect(await ledger.markAttemptFailed('m-1', 'late failure from a racing attempt')).toBe(false)

    const after = await ledger.get('m-1')
    expect(after?.status).toBe('inboxed')
    expect(after?.resolvedSessionId).toBe(landed?.resolvedSessionId)
    expect(after?.lastError).toBe(landed?.lastError)
  })

  it('★ the rollback advances `revision`, so its CAS protection is real', async () => {
    // `putIfUnchanged` is only a guard if a successful write moves `revision`; if it
    // did not, two concurrent rollbacks would both believe they won.
    const { ledger } = await openLedger()
    await ledger.record({ msgId: 'm-1', from: 'alice', to: 'sess-1', text: 'r' })
    await ledger.markDelivering('m-1')
    const before = await ledger.get('m-1')

    expect(await ledger.markAttemptFailed('m-1', 'nobody there')).toBe(true)

    const after = await ledger.get('m-1')
    expect(after?.revision).toBeGreaterThan(before?.revision ?? -1)
  })
})