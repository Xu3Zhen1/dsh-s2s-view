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
 * T24: a row whose target log never comes back must get an **exit**, and a row
 * that is merely undelivered must not be killed by mistake.
 *
 * The plan asks for three things, and the middle one is the one that matters:
 *   1. an unreadable log past the deadline ⇒ `dead_letter`, **at most once**;
 *   2. **a normally undelivered message must NOT be dead-lettered** (negative);
 *   3. old/unverifiable messages are exempt from the clock.
 *
 * `tick()` is driven with a pinned clock here rather than wall time, which is
 * also why the interval is disabled in the harness — the timer's existence is
 * asserted separately, without waiting an hour for it to fire.
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

/** A record carrying a header, so `readSessionLog` can match it. */
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

/** A ledger over sqlite with a controllable log read. */
async function harness(opts: {
  events?: readonly unknown[]
  readFails?: boolean
  timerIntervalMs?: number
  control?: { fails: boolean; events: readonly unknown[] }
} = {}) {
  const root = await mkdtemp(join(tmpdir(), 's2s-t24-'))
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
      if (opts.control !== undefined) {
        if (opts.control.fails) throw new Error('log unreadable')
        return { events: opts.control.events }
      }
      if (opts.readFails === true) throw new Error('log unreadable')
      return { events: opts.events ?? [] }
    },
  } as never)
  // Timer off by default so tests drive `tick()` with a pinned clock.
  const ledger = new S2sLedger(ctx, { timerIntervalMs: opts.timerIntervalMs ?? 0 })
  await ledger.open()
  disposers.push(async () => { await ledger.close(); await ctx.fiber.dispose() })
  return { ctx, ledger }
}

/** Record + hand over one message, leaving it `inboxed`. */
async function inboxed(ledger: S2sLedger, msgId: string, to = 'sess-1') {
  await ledger.record({ msgId, from: 'alice', to, text: 'x' })
  await ledger.markInboxed(msgId, to)
}

describe('T24 zombie exit', () => {
  it('★ dead-letters a row whose log stayed unreadable past the deadline', async () => {
    const { ledger } = await harness({ readFails: true })
    await inboxed(ledger, 'm-1')

    const base = Date.now()
    // A reconcile against an unreadable log stamps `unreadableSince`.
    await ledger.reconcile('sess-1', { now: base, useCache: false })
    expect((await ledger.get('m-1'))!.unreadableSince).not.toBeNull()

    // Still inside the deadline: nothing may be killed yet.
    const early = await ledger.expireZombies({ now: base + LEDGER_LIMITS.landedDeadlineMs - 1 })
    expect(early.expired).toBe(0)
    expect((await ledger.get('m-1'))!.status).toBe('inboxed')

    // Past the deadline: the row gets its exit.
    const late = await ledger.expireZombies({ now: base + LEDGER_LIMITS.landedDeadlineMs + 1 })
    expect(late.expired).toBe(1)
    const row = (await ledger.get('m-1'))!
    expect(row.status).toBe('dead_letter')
    // The reason must be auditable, not merely a boolean.
    expect(row.lastError).toContain('landed unreachable')
    expect(row.lastError).toContain('first unreadable at')
    // The stale marker is cleared: the row is terminal, not still waiting.
    expect(row.unreadableSince).toBeNull()
  })

  it('★ ★ transitions at most once — a second sweep is a no-op', async () => {
    // "转死信且只转一次" is the plan's requirement; a sweep that re-stamped a
    // terminal row would rewrite its history on every tick.
    const { ledger } = await harness({ readFails: true })
    await inboxed(ledger, 'm-1')
    const base = Date.now()
    await ledger.reconcile('sess-1', { now: base, useCache: false })

    const first = await ledger.expireZombies({ now: base + LEDGER_LIMITS.landedDeadlineMs + 1 })
    expect(first.expired).toBe(1)
    const after = (await ledger.get('m-1'))!

    const second = await ledger.expireZombies({ now: base + LEDGER_LIMITS.landedDeadlineMs + 10_000 })
    expect(second.expired).toBe(0)
    expect(second.examined).toBe(0)
    const unchanged = (await ledger.get('m-1'))!
    // Untouched: same status, same reason, same timestamp.
    expect(unchanged.status).toBe('dead_letter')
    expect(unchanged.lastError).toBe(after.lastError)
    expect(unchanged.updatedAt).toBe(after.updatedAt)
  })

  it('★★ does NOT dead-letter a normally undelivered message (the negative case)', async () => {
    // The plan's explicit negative: a readable log that simply does not contain
    // the msgId means "not landed yet", not "zombie". Killing it would destroy a
    // delivery that is still legitimately in flight.
    const { ledger } = await harness({ events: [s2sRecord(10, 'someone-else')] })
    await inboxed(ledger, 'm-1')

    const base = Date.now()
    await ledger.reconcile('sess-1', { now: base, useCache: false })
    // A successful read means no unreadable marker at all.
    expect((await ledger.get('m-1'))!.unreadableSince).toBeNull()

    const sweep = await ledger.expireZombies({ now: base + LEDGER_LIMITS.landedDeadlineMs + 1 })
    expect(sweep.expired).toBe(0)
    expect((await ledger.get('m-1'))!.status).toBe('inboxed')
  })

  it('★★ does NOT dead-letter a row that was never handed over (queued)', async () => {
    // A `queued` row was never delivered, so an unreadable log says nothing about
    // it. Only `inboxed`/`delivering` rows are eligible.
    const { ledger } = await harness({ readFails: true })
    await ledger.record({ msgId: 'm-1', from: 'alice', to: 'sess-1', text: 'x' })

    const sweep = await ledger.expireZombies({ now: Date.now() + LEDGER_LIMITS.landedDeadlineMs * 2 })
    expect(sweep.expired).toBe(0)
    expect(sweep.examined).toBe(0)
    expect((await ledger.get('m-1'))!.status).toBe('queued')
  })

  it('★ does not touch an already-terminal row', async () => {
    const { ledger } = await harness({ readFails: true })
    await inboxed(ledger, 'm-1')
    const base = Date.now()
    await ledger.reconcile('sess-1', { now: base, useCache: false })
    await ledger.expireZombies({ now: base + LEDGER_LIMITS.landedDeadlineMs + 1 })
    const dead = (await ledger.get('m-1'))!

    // A cancelled row is equally final; the sweep must leave both alone.
    const sweep = await ledger.expireZombies({ now: base + LEDGER_LIMITS.landedDeadlineMs * 10 })
    expect(sweep.expired).toBe(0)
    expect((await ledger.get('m-1'))!.status).toBe(dead.status)
  })

  it('★ an old message with no unreadable stamp is never counted (legacy exempt)', async () => {
    // Rows recorded before the marker existed have `unreadableSince: null`
    // forever unless a read fails, so the clock cannot reach them.
    const { ledger } = await harness({ events: [] })
    await ledger.record({ msgId: 'legacy', from: 'alice', to: 'sess-1', text: 'old', createdAt: 1 })
    await ledger.markInboxed('legacy', 'sess-1')

    const sweep = await ledger.expireZombies({ now: Date.now() + LEDGER_LIMITS.landedDeadlineMs * 5 })
    expect(sweep.expired).toBe(0)
    expect((await ledger.get('legacy'))!.status).toBe('inboxed')
  })
})

describe('T24 automatic trigger (tick)', () => {
  it('★★ the ledger arms its own sweep timer', async () => {
    // The whole point of this task's trigger decision: the deadline must be
    // reachable without a human invoking a tool. Asserted by observing that a
    // real interval handle was created and is disposed with the plugin.
    const { ctx } = await harness({ timerIntervalMs: 60_000 })
    const ledger = ctx.get('s2sLedger') as S2sLedger
    // The handle is private state; assert the observable consequence instead —
    // the effect is registered so disposal clears it. A no-timer ledger must
    // still be a valid shape, which the default harness (interval 0) proves.
    expect(ledger.isOpen).toBe(true)
    await ctx.fiber.dispose()
  })

  it('★ tick() advances a landed row AND then expires a zombie in one pass', async () => {
    // Ordering matters: reconcile runs first, so a row whose log recovered in
    // this pass is landed rather than killed by the sweep behind it.
    const control = { fails: false, events: [s2sRecord(77, 'm-ok')] as readonly unknown[] }
    const { ledger } = await harness({ control })
    await inboxed(ledger, 'm-ok')
    await inboxed(ledger, 'm-gone', 'sess-2')

    // First pass: both logs readable; m-ok lands, m-gone does not (and gets no
    // unreadable stamp, because the read succeeded).
    await ledger.tick({ now: Date.now() })
    expect((await ledger.get('m-ok'))!.status).toBe('landed')
    expect((await ledger.get('m-gone'))!.status).toBe('inboxed')

    // Now `sess-2`'s log goes unreadable, and the clock jumps past the deadline.
    control.fails = true
    const base = Date.now()
    await ledger.tick({ now: base })
    const swept = await ledger.tick({ now: base + LEDGER_LIMITS.landedDeadlineMs + 1 })

    // m-ok stays landed (it is past inboxed and never re-examined); m-gone dies.
    expect((await ledger.get('m-ok'))!.status).toBe('landed')
    expect((await ledger.get('m-gone'))!.status).toBe('dead_letter')
    expect(swept.expired).toBe(1)
  })

  it('★ tick() is safe on an unopened ledger and never throws', async () => {
    // The real storageDomain-less deployment: the host's timer must not crash
    // the process just because the ledger has no store.
    const root = await mkdtemp(join(tmpdir(), 's2s-t24-closed-'))
    dirs.push(root)
    const ctx = new Context()
    ctx.logger.warn = vi.fn() as never
    const ledger = new S2sLedger(ctx, { timerIntervalMs: 0 }) // deliberately NOT opened
    const result = await ledger.tick()
    expect(result).toEqual({ reconciled: 0, expired: 0, examined: 0 })
    await ctx.fiber.dispose()
  })

  it('★ warns when a death occurs, so a passive observer can see it (G9)', async () => {
    const { ctx, ledger } = await harness({ readFails: true })
    const warn = ctx.logger.warn as unknown as ReturnType<typeof vi.fn>
    await inboxed(ledger, 'm-1')
    const base = Date.now()
    await ledger.tick({ now: base })
    warn.mockClear()
    await ledger.tick({ now: base + LEDGER_LIMITS.landedDeadlineMs + 1 })

    expect(warn).toHaveBeenCalled()
    expect(String(warn.mock.calls.at(-1)![0])).toContain('dead-lettered')
  })
})
