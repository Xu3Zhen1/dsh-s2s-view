/**
 * T18 — retry backoff and its **consumer**.
 *
 * This batch exists because `nextAttemptAt` used to have three writers and zero
 * readers: `markAttemptFailed` wrote a stamp that nothing ever consulted, so a
 * "backoff" that delayed nothing was indistinguishable from no backoff at all.
 * The tests below therefore come in two families and both are required:
 *
 * - **production side** — what `retryBackoffMs` computes (monotone, bounded,
 *   deterministic).
 * - **consumption side** — that `claimDelivery` actually *uses* it. A backoff
 *   whose value is perfect and whose gate ignores it is the exact defect this
 *   project keeps paying for, and only a consumption-side case can see it.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import * as sqliteStorage from '@deepseek-ai/dsh-storage-sqlite'
import { dueByClock, retryBackoffMs, S2sLedger } from '../src/ledger.ts'
import { LEDGER_LIMITS } from '../src/ledger-schema.ts'

const dirs: string[] = []
const disposers: Array<() => Promise<void>> = []
afterEach(async () => {
  // Close the ledger BEFORE removing its directory: an open sqlite handle makes
  // `rm` fail with EBUSY and turns a correct test into a red one.
  for (const dispose of disposers.splice(0)) {
    try { await dispose() } catch { /* cleanup must not mask the real result */ }
  }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function openLedger(name: string) {
  const root = await mkdtemp(join(tmpdir(), `s2s-backoff-${name}-`))
  dirs.push(root)
  const ctx = new Context()
  ctx.logger.warn = vi.fn() as never
  await ctx.plugin(Storage)
  await ctx.plugin(sqliteStorage, { path: join(root, 'storage.db') })
  const facility = new DomainFacility(ctx, { backend: 'sqlite', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility as never)
  // `timerIntervalMs: 0` so the sweep is driven explicitly rather than firing
  // during a test; the backoff code under test has no timer of its own.
  const ledger = new S2sLedger(ctx, { timerIntervalMs: 0 })
  await ledger.open()
  disposers.push(async () => { await ledger.close(); await ctx.fiber.dispose() })
  return { ctx, ledger }
}

describe('T18 retry backoff — production side', () => {
  it('★ is non-decreasing in `attempts` despite the jitter', () => {
    // The plan asks for monotone backoff. A symmetric `±` jitter — the obvious way
    // to write "exponential + jitter" — can make attempt 3 wait LESS than attempt 2,
    // so monotonicity is the property that decides how the jitter has to be shaped:
    // additive and proportional to the step, never a random offset around it.
    const id = 'msg-monotone'
    let previous = 0
    for (let attempts = 1; attempts <= 12; attempts += 1) {
      const delay = retryBackoffMs(id, attempts)
      expect(delay).toBeGreaterThanOrEqual(previous)
      previous = delay
    }
  })

  it('★ doubles per attempt until the cap, then stops growing', () => {
    const id = 'msg-double'
    expect(retryBackoffMs(id, 1)).toBeLessThanOrEqual(LEDGER_LIMITS.retryBackoffBaseMs * 1.25)
    // Attempt n+1 is at least double the floor of attempt n; the cap is what stops
    // the growth, and without it attempt 20 would schedule ~12 days out — past the
    // 24 h zombie deadline, so the row would be dead before its retry was due.
    expect(retryBackoffMs(id, 6)).toBeGreaterThan(retryBackoffMs(id, 5))
    expect(retryBackoffMs(id, 30)).toBeLessThanOrEqual(LEDGER_LIMITS.retryBackoffMaxMs * 1.25)
    // Saturated: past the cap the delay stops growing (compares two DIFFERENT
    // attempt counts; a self-comparison here would be a tautology that can never fail).
    expect(retryBackoffMs(id, 30)).toBeGreaterThanOrEqual(retryBackoffMs(id, 6))
  })

  it('★ is bounded below the clock-jump clamp, whatever the attempt count', () => {
    // `nextAttemptAtClampMs` guards a clock jump; a backoff that could exceed it
    // would mean the guard and the scheduler disagreed about the largest legal
    // instant, and the clamp would silently rewrite a legitimate schedule.
    for (const attempts of [1, 2, 5, 40, 1000, -3, 0, 1.7]) {
      const delay = retryBackoffMs('msg-bounds', attempts)
      expect(Number.isFinite(delay)).toBe(true)
      expect(delay).toBeGreaterThan(0)
      expect(delay).toBeLessThan(LEDGER_LIMITS.nextAttemptAtClampMs)
    }
  })

  it('★ is deterministic per row and varied across rows', () => {
    // Deterministic: a replayed call must not invent a different schedule for the
    // same row. Varied: two rows that failed in the same millisecond must not retry
    // in lockstep — that spreading is the entire reason for jittering at all, and
    // a per-call random would achieve it while losing determinism.
    expect(retryBackoffMs('row-a', 3)).toBe(retryBackoffMs('row-a', 3))
    const spread = new Set(['row-a', 'row-b', 'row-c', 'row-d', 'row-e'].map(id => retryBackoffMs(id, 3)))
    expect(spread.size).toBeGreaterThan(1)
  })
})

describe('T18 retry backoff — consumption side (the gate)', () => {
  it('★★ claimDelivery refuses while the backoff is running, then delivers once it elapses', async () => {
    // ★ The consumption-side case. If `claimDelivery` ignored `nextAttemptAt` — the
    // state this project shipped with — this test would pass a claim on the second
    // line and the refusal assertion below would go red. That is the mutation
    // `M-b`/`M-c` in the batch report.
    const { ledger } = await openLedger('gate')
    await ledger.record({ msgId: 'm-gate', from: 'a', to: 's', text: 'x' })
    expect((await ledger.claimDelivery('m-gate')).decision).toBe('deliver')
    await ledger.markAttemptFailed('m-gate', 'broker reported absent')

    const row = (await ledger.get('m-gate'))!
    const stamp = row.nextAttemptAt
    expect(typeof stamp).toBe('number')
    expect(stamp).toBeGreaterThan(Date.now())

    // One millisecond BEFORE the stamp: still backing off.
    expect(await ledger.claimDelivery('m-gate', { now: stamp - 1 })).toEqual({ decision: 'refuse', reason: 'backoff' })
    // Exactly AT the stamp: due. The boundary is used, not "somewhere inside the
    // window" — a case one millisecond inside passes for `<` AND `<=` and therefore
    // proves nothing about which operator was written.
    expect(await ledger.claimDelivery('m-gate', { now: stamp })).toEqual({ decision: 'deliver', reason: 'claimed' })
  })

  it('★ scheduling a retry does not spend it: a refused claim leaves `attempts` alone', async () => {
    // The gate sits BEFORE the CAS on purpose. If it sat after, a not-yet-due retry
    // would be dragged into `delivering` and `attempts` would advance — so a message
    // adhering to its own schedule would exhaust its retries and be dead-lettered
    // for waiting correctly.
    const { ledger } = await openLedger('spend')
    await ledger.record({ msgId: 'm-spend', from: 'a', to: 's', text: 'x' })
    await ledger.claimDelivery('m-spend')
    await ledger.markAttemptFailed('m-spend', 'absent')
    const before = (await ledger.get('m-spend'))!
    expect(before.status).toBe('queued')
    expect(before.attempts).toBe(1)
    await ledger.claimDelivery('m-spend') // refused: backoff
    const after = (await ledger.get('m-spend'))!
    expect(after.status).toBe('queued')
    expect(after.attempts).toBe(before.attempts)
    expect(after.revision).toBe(before.revision)
  })

  it('★★ the last attempt dead-letters and does NOT schedule another retry', async () => {
    const { ledger } = await openLedger('exhaust')
    await ledger.record({ msgId: 'm-dead', from: 'a', to: 's', text: 'gone' })
    const limit = (await ledger.get('m-dead'))!.maxRetries
    for (let i = 0; i < limit; i += 1) {
      await ledger.claimDelivery('m-dead', { now: Date.now() + 10 * 60 * 1000 })
      await ledger.markAttemptFailed('m-dead', 'absent')
    }
    const dead = (await ledger.get('m-dead'))!
    expect(dead.status).toBe('dead_letter')
    // A terminal row must not carry a future retry stamp: that would imply a retry
    // the ledger has explicitly ruled out, and a status reader would show it as
    // "waiting" forever.
    expect(dead.nextAttemptAt).toBeLessThanOrEqual(Date.now() + 1000)
  })

  it('★★★ the dead-letter transition happens exactly once (not once per late report)', async () => {
    // T18's second acceptance clause: "超 maxRetries 只进一次 dead_letter". The
    // clause is about the COUNT, so the assertion has to count transitions rather
    // than just check the final status — a status-only check passes even if every
    // late report re-dead-letters the row.
    const { ledger } = await openLedger('once')
    await ledger.record({ msgId: 'm-once', from: 'a', to: 's', text: 'gone' })
    const limit = (await ledger.get('m-once'))!.maxRetries
    const outcomes: string[] = []
    for (let i = 0; i < limit; i += 1) {
      await ledger.claimDelivery('m-once', { now: Date.now() + 10 * 60 * 1000 })
      outcomes.push((await ledger.markAttemptFailed('m-once', 'absent')).outcome)
    }
    expect(outcomes.filter(outcome => outcome === 'dead-lettered')).toHaveLength(1)
    expect(outcomes.at(-1)).toBe('dead-lettered')

    const deadOnce = (await ledger.get('m-once'))!
    // Late reports after the transition change nothing at all: not the outcome, not
    // the attempt count, not the error text.
    for (let i = 0; i < 3; i += 1) {
      expect(await ledger.markAttemptFailed('m-once', 'late report')).toEqual({ outcome: 'not-applicable' })
    }
    const still = (await ledger.get('m-once'))!
    expect(still.status).toBe('dead_letter')
    expect(still.attempts).toBe(deadOnce.attempts)
    expect(still.lastError).toBe(deadOnce.lastError)
  })
})

describe('T18/T19 shared clock judgment', () => {
  it('★ dueByClock is the single "is it time" rule, and a missing stamp means due', () => {
    // A missing stamp must read as DUE. The alternative — treat it as "not yet" —
    // would let a row from an older schema (or one never scheduled) sit queued
    // forever, which is the permanent-stall shape this batch removes.
    expect(dueByClock({ nextAttemptAt: null }, 1000)).toBe(true)
    expect(dueByClock({}, 1000)).toBe(true)
    expect(dueByClock({ nextAttemptAt: 1000 }, 999)).toBe(false)
    expect(dueByClock({ nextAttemptAt: 1000 }, 1000)).toBe(true)
    expect(dueByClock({ nextAttemptAt: 1000 }, 1001)).toBe(true)
  })

  it('★ isDue answers without changing anything (it is a filter, not a claim)', async () => {
    // `isDue` exists so a mailbox entry can be left on disk instead of taken and
    // put back (that round trip has a crash window). That safety depends on it
    // being read-only, so the read-only-ness is asserted rather than trusted: a
    // future "optimisation" that marks the row while checking would silently
    // consume the attempt.
    const { ledger } = await openLedger('isdue')
    await ledger.record({ msgId: 'm-due', from: 'a', to: 's', text: 'x' })
    await ledger.claimDelivery('m-due')
    await ledger.markAttemptFailed('m-due', 'absent')
    const before = (await ledger.get('m-due'))!

    expect(await ledger.isDue('m-due', before.nextAttemptAt - 1)).toBe(false)
    expect(await ledger.isDue('m-due', before.nextAttemptAt)).toBe(true)

    const after = (await ledger.get('m-due'))!
    expect(after.status).toBe(before.status)
    expect(after.attempts).toBe(before.attempts)
    expect(after.revision).toBe(before.revision)
    // And an untracked id is "due": bookkeeping must never block a delivery (T6b).
    expect(await ledger.isDue('m-unknown', Date.now())).toBe(true)
  })
})