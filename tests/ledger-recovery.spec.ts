import { mkdtemp, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
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

/**
 * A ledger whose `sessionQuery` answers with a REGULARLY READABLE log.
 *
 * `logs` maps a session id to the `user/message` events its log contains, already
 * in the shape `readSessionLog` parses (`msgId` + `seq` + `source.kind = 'dsh-s2s'`).
 * A session missing from the map reads as an empty (but readable) log — the case
 * where nothing has landed *yet*.
 */
async function openLedgerWithLog(logs: Record<string, Array<{ msgId: string; seq: number }>>) {
  const root = await mkdtemp(join(tmpdir(), 's2s-t13-log-'))
  dirs.push(root)
  const ctx = new Context()
  ctx.logger.warn = vi.fn() as never
  await ctx.plugin(Storage)
  await ctx.plugin(sqliteStorage, { path: join(root, 'storage.db') })
  const facility = new DomainFacility(ctx, { backend: 'sqlite', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility as never)
  ctx.provide('sessionQuery', {
    async readSession(sessionId: string) {
      const entries = logs[sessionId] ?? []
      return {
        events: entries.map((e) => ({
          type: 'user/message',
          seq: e.seq,
          time: 0,
          // The msgId lives in the s2s header on the FIRST line, not in `data`:
          // `readSessionLog` parses `[s2s message] key=value …` and takes `msgId`
          // from there. Building the stub with `data.msgId` would produce a log the
          // real parser ignores, i.e. a test that passes by never landing anything.
          data: {
            source: { kind: 'dsh-s2s' },
            content: [{ text: '[s2s message] msgId=' + e.msgId + ' from=alice to=sess\nbody' }],
          },
        })),
      }
    },
  } as never)
  const ledger = new S2sLedger(ctx, { timerIntervalMs: 0 })
  await ledger.open()
  disposers.push(async () => {
    await ledger.close()
    await ctx.fiber.dispose()
  })
  return { ctx, ledger }
}

/**
 * A ledger that counts how many target logs the startup pass actually reads.
 *
 * The count is incremented inside `readSession`, so it measures real reads rather
 * than the shape of the `slice()` expression. That distinction is the whole point:
 * "the bound is written in the code" and "the bound holds" are different claims,
 * and only the second one can fail.
 */
async function openLedgerCountingReads() {
  const root = await mkdtemp(join(tmpdir(), 's2s-t13-count-'))
  dirs.push(root)
  const ctx = new Context()
  ctx.logger.warn = vi.fn() as never
  await ctx.plugin(Storage)
  await ctx.plugin(sqliteStorage, { path: join(root, 'storage.db') })
  const facility = new DomainFacility(ctx, { backend: 'sqlite', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility as never)
  const readCount = { value: 0 }
  ctx.provide('sessionQuery', {
    async readSession() {
      readCount.value += 1
      return { events: [] }
    },
  } as never)
  const ledger = new S2sLedger(ctx, { timerIntervalMs: 0 })
  await ledger.open()
  disposers.push(async () => {
    await ledger.close()
    await ctx.fiber.dispose()
  })
  return { ctx, ledger, readCount }
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

  it('★★ the second job is WIRED: rows handed over but not landed are re-judged', async () => {
    // ★ This case found a real semantic while it was being written, and the finding
    // is the reason it is shaped this way: `record()` alone does NOT make a row
    // eligible for the re-judge, because a freshly recorded row has no
    // `resolvedSessionId` — there is no target log to read, so there is nothing to
    // judge. Eligibility requires an actual handover (`markInboxed`), which is also
    // the only state in which "handed over but never confirmed landed" is true.
    const { ledger } = await openLedger()
    await ledger.record({ msgId: 'm-1', from: 'alice', to: 'sess-1', text: 'hello' })
    await ledger.markInboxed('m-1', 'sess-1')

    const result = await ledger.recoverInterrupted()
    // `reset` and `reconciledRows` measure different things and both are real now:
    // nothing was stuck in `delivering`, but the handover IS re-judged against the
    // target log. Getting 0 here would mean the second job is still unwired.
    expect(result.reset).toBe(0)
    expect(result.reconciledRows).toBe(1)
    // The name is not decoration: `tick()` reports `reconciled` in SESSIONS. This
    // field counts ROWS, so it must not answer to the same word.
    expect('reconciled' in result).toBe(false)
    expect('reconciledRows' in result).toBe(true)
  })

  it('★★ a row already confirmed landed is NOT re-judged (the second job has a scope)', async () => {
    // The guard that makes `reconciledRows` mean something: without it every pass
    // would report every row forever, and the count would be a constant rather than
    // a measurement. Driven through `reconcile()`'s own positive path — a mounted
    // session query that returns a log containing the msgId — so this is the real
    // landing decision, not a status poked into storage.
    const { ledger } = await openLedgerWithLog({ 'sess-1': [{ msgId: 'm-land', seq: 7 }] })
    await ledger.record({ msgId: 'm-land', from: 'alice', to: 'sess-1', text: 'hi' })
    await ledger.markInboxed('m-land', 'sess-1')
    expect((await ledger.reconcile('sess-1')).landed).toBe(1)
    expect((await ledger.get('m-land'))?.status).toBe('landed')

    const result = await ledger.recoverInterrupted()
    // Landed rows are excluded from the re-judge, so nothing is examined.
    expect(result.reconciledRows).toBe(0)
    expect((await ledger.get('m-land'))?.status).toBe('landed')
  })

  it('★★ an UNREADABLE log still counts as judged — and starts the same deadline a sweep starts', async () => {
    // The honest reading of `reconciledRows` is "rows judged", never "deliveries
    // confirmed": a row whose log cannot be read is judged too. That is not a
    // cosmetic distinction, because the judgement stamps `unreadableSince`, and
    // `expireZombies` later turns that stamp into `dead_letter` after
    // `landedDeadlineMs`. So a startup pass CAN begin a 24 h clock — the side effect
    // this case exists to prove rather than to assume.
    const { ledger } = await openLedger()
    await ledger.record({ msgId: 'm-1', from: 'alice', to: 'sess-1', text: 'hello' })
    await ledger.markInboxed('m-1', 'sess-1')

    // No session-query mounted ⇒ the read fails.
    const now = Date.now()
    const result = await ledger.recoverInterrupted({ now })

    expect(result.reconciledRows).toBe(1)
    const row = await ledger.get('m-1')
    // Judged-but-unreadable: still `inboxed` (nothing was landed) AND stamped.
    expect(row?.status).toBe('inboxed')
    expect(row?.unreadableSince).toBe(now)

    // And the chain completes: the stamp is what the sweep acts on.
    const expired = await ledger.expireZombies({ now: now + LEDGER_LIMITS.landedDeadlineMs + 1 })
    expect(expired.expired).toBe(1)
    expect((await ledger.get('m-1'))?.status).toBe('dead_letter')
  })

  it('★★ the rendered startup line says "judged", never "confirmed" (I1: never claim more than happened)', async () => {
    // Found by mutation: replacing "RE-JUDGED" with "CONFIRMED" in the s2s_status
    // wording left the whole suite green. That is the exact overclaim I1 forbids —
    // `reconciledRows` counts rows LOOKED AT, and an unreadable log is one of them,
    // so a row counted here can still end in `dead_letter` rather than `landed`.
    // Saying "confirmed" would claim more than happened, to a human reading status.
    //
    // The subject of this criterion is the wording in the renderer, so the source
    // text IS the thing being tested (same shape as `reasoning-hygiene.spec.ts`).
    // It is deliberately narrow: it pins the two words this batch introduced, and
    // would not catch a third phrasing of the same overclaim.
    const src = readFileSync(new URL('../src/tools.ts', import.meta.url), 'utf8')
    const line = src.split('\n').find((l) => l.includes('rows RE-JUDGED against their'))
    expect(line, 'the startup-self-check renderer lost its "RE-JUDGED" wording').toBeDefined()
    // The over-claim must not appear on the same rendered fragment.
    expect(line).not.toMatch(/CONFIRMED against their/i)
    expect(src).not.toMatch(/rows CONFIRMED against their/i)
    // And the honest qualifier has to survive alongside the count, or "judged" is
    // asserted without the reason it is not "confirmed".
    expect(src).toMatch(/Judged is not confirmed/i)
  })


  it('★ the startup pass is BOUNDED — at most maxSessionsPerRequest target logs are read', async () => {
    // A startup pass blocks the process, so "how many logs may it read" has to be a
    // number, not "however many rows are waiting". The bound is asserted by counting
    // the reads the pass actually performed, not by trusting the slice expression:
    // one target beyond the limit must go unread.
    const extra = LEDGER_LIMITS.maxSessionsPerRequest + 2
    const { ledger, readCount } = await openLedgerCountingReads()
    for (let i = 0; i < extra; i += 1) {
      await ledger.record({ msgId: 'm-' + i, from: 'alice', to: 'sess-' + i, text: 't' })
      await ledger.markInboxed('m-' + i, 'sess-' + i)
    }

    const result = await ledger.recoverInterrupted()

    expect(readCount.value).toBe(LEDGER_LIMITS.maxSessionsPerRequest)
    // The count reports what was judged, so it must match the bounded reads —
    // a bigger number would mean rows were judged without a log read.
    expect(result.reconciledRows).toBeLessThanOrEqual(LEDGER_LIMITS.maxSessionsPerRequest)
  })

  it('★ a failed attempt rolls back to queued and records why, keeping the attempt count', async () => {
    // `absent` is the ordinary failure (the resolved session had no live agent), so
    // this is not an exotic path: without the rollback the row sits in `delivering`
    // until the next start, i.e. an undeliverable message becomes one that is retried
    // only after a restart.
    const { ledger } = await openLedger()
    await ledger.record({ msgId: 'm-1', from: 'alice', to: 'sess-1', text: 'gone' })
    expect(await ledger.markDelivering('m-1')).toBe(true)

    expect(await ledger.markAttemptFailed('m-1', 'broker reported absent')).toEqual({ outcome: 'rolled-back' })

    const row = await ledger.get('m-1')
    expect(row?.status).toBe('queued')
    expect(row?.lastError).toBe('broker reported absent')
    // The attempt really happened: decrementing would make `maxRetries` exhaustion
    // (once that half is wired) under-count a message that keeps failing.
    expect(row?.attempts).toBe(1)
    // T18 changed what this means. It used to be `now` — an immediately re-claimable
    // row — with the note "a future `nextAttemptAt` would be a value nothing reads".
    // That is no longer true: `claimDelivery` refuses with `backoff` while the stamp
    // is in the future. So the assertion is now the stronger one — the stamp must be
    // AHEAD of the row's own creation, i.e. the rollback schedules a retry instead of
    // making the row instantly eligible. `now` would pass a `toBeTypeOf('number')`
    // check too, which is why the weaker assert could not see this change at all.
    expect(row?.nextAttemptAt).toBeTypeOf('number')
    expect(row!.nextAttemptAt).toBeGreaterThan(row!.createdAt)
  })

  it('★★★ attempts are spent ⇒ dead_letter, not another requeue (the second inbound edge)', async () => {
    // Before this branch existed, `dead_letter` had exactly one inbound edge
    // (`expireZombies`, for a landed-but-unreadable log). A message addressed to a
    // session that is permanently gone failed, rolled back, and was retried forever:
    // no terminal exit. `maxRetries` was declared and never compared.
    const { ctx, ledger } = await openLedger('exhaust')
    await ledger.record({ msgId: 'm-x', from: 'a', to: 's', text: 'gone forever' })
    const limit = (await ledger.get('m-x'))!.maxRetries

    // `absent` counts as an attempt on purpose (plan §12.3 groups "throws / absent"
    // together), so each cycle is claim → fail until the budget is gone.
    //
    // ★ T18 made the plain `claimDelivery('m-x')` stop working here, and that is the
    // behaviour change, not a broken test: after the first failure the row carries a
    // future `nextAttemptAt`, so a clock-less claim correctly refuses with `backoff`.
    // This loop is about EXHAUSTION, so it advances `now` past the backoff rather than
    // pretending the delay is not there. The delay itself is asserted separately in
    // `ledger-backoff.spec.ts`; folding a "claims immediately" assumption back in here
    // would re-hide the very gate this batch adds.
    for (let i = 0; i < limit; i += 1) {
      expect((await ledger.claimDelivery('m-x', { now: Date.now() + 10 * 60 * 1000 })).decision).toBe('deliver')
      const outcome = await ledger.markAttemptFailed('m-x', 'broker reported absent')
      // Every attempt but the last returns the row to `queued`; the last one ends it.
      expect(outcome).toEqual({ outcome: i + 1 === limit ? 'dead-lettered' : 'rolled-back' })
    }

    const dead = await ledger.get('m-x')
    expect(dead?.status).toBe('dead_letter')
    expect(dead?.attempts).toBe(limit)
    expect(dead?.lastError).toContain('giving up after')
    // Terminal means terminal: a fourth failure report changes nothing, and the row
    // is not selectable for delivery again.
    expect(await ledger.markAttemptFailed('m-x', 'late')).toEqual({ outcome: 'not-applicable' })
    expect(await ledger.claimDelivery('m-x')).toEqual({ decision: 'refuse', reason: 'terminal' })
    expect((await ledger.get('m-x'))?.status).toBe('dead_letter')

    await ledger.close()
    await ctx.fiber.dispose()
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

    expect(await ledger.markAttemptFailed('m-q', 'should not apply')).toEqual({ outcome: 'not-applicable' })
    expect(await ledger.markAttemptFailed('m-i', 'should not apply')).toEqual({ outcome: 'not-applicable' })
    expect(await ledger.markAttemptFailed('m-c', 'should not apply')).toEqual({ outcome: 'not-applicable' })
    expect(await ledger.markAttemptFailed('m-missing', 'should not apply')).toEqual({ outcome: 'not-applicable' })

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

    expect(await ledger.markAttemptFailed('m-1', 'late failure from a racing attempt')).toEqual({ outcome: 'not-applicable' })

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

    expect(await ledger.markAttemptFailed('m-1', 'nobody there')).toEqual({ outcome: 'rolled-back' })

    const after = await ledger.get('m-1')
    expect(after?.revision).toBeGreaterThan(before?.revision ?? -1)
  })
})