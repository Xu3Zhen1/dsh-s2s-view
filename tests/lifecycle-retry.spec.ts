/**
 * T19 — the fallback retry pass, and the property it exists to protect.
 *
 * T18 gives a failed delivery a future `nextAttemptAt`. Something has to look
 * again once that instant passes, and no event marks the moment, so the lifecycle
 * wakes on its own every `retryIntervalMs`.
 *
 * Two design decisions get their own cases here because they are easy to get
 * wrong silently:
 *
 * 1. **Decide before taking.** `mailbox.drain` deletes each entry as it reads it,
 *    so "take everything, put the not-due ones back" has a crash window between
 *    delete and rewrite in which the message exists in neither the mailbox nor
 *    `recoverInterrupted`'s subject (that pass repairs only `delivering` rows).
 *    The `keep` filter closes that window instead of narrowing it, and the case
 *    below asserts the file is still on disk — the observable consequence.
 * 2. **Two paths, one delivery.** `agent/created` and the timer can both reach the
 *    same session. The invariant is "at most one hand-over", and it is asserted by
 *    counting actual deliveries, not by inspecting a return value.
 */
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import * as sqliteStorage from '@deepseek-ai/dsh-storage-sqlite'
import { apply as s2sApply, S2sLifecycleService } from '../src/index.ts'
import { S2sLedger } from '../src/ledger.ts'
import { S2sMailbox } from '../src/mailbox.ts'

const dirs: string[] = []
const disposers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of disposers.splice(0)) {
    try { await dispose() } catch { /* cleanup must not mask the real result */ }
  }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

/**
 * A lifecycle with `retryIntervalMs: 0` so the timer never fires during a test and
 * `retryDue()` can be driven with an explicit clock. `withLedger: false` builds the
 * "ledger unavailable" configuration the pass must survive.
 */
async function harness(opts: { withLedger?: boolean; timerMs?: number } = {}) {
  const withLedger = opts.withLedger ?? true
  const timerMs = opts.timerMs ?? 0
  const mailboxDir = await tmp('s2s-retry-mb-')
  const ctx = new Context()
  ctx.logger.warn = vi.fn() as never
  const followups: unknown[] = []
  const agent = {
    id: 'sess-1',
    status: 'idle',
    session: { requestHeader: () => undefined },
    ctx: new Context(),
    followup: (message: unknown) => { followups.push(message) },
    inject: () => {},
  }
  let live = false
  ctx.provide('agents', {
    get: (id: unknown) => live && String(id) === 'sess-1' ? agent : undefined,
    resume: vi.fn(async () => { live = true; return { agent, dispose: vi.fn() } }),
  } as never)
  let ledger: S2sLedger | undefined
  if (withLedger) {
    const root = await tmp('s2s-retry-db-')
    await ctx.plugin(Storage)
    await ctx.plugin(sqliteStorage, { path: join(root, 'storage.db') })
    const facility = new DomainFacility(ctx, { backend: 'sqlite', routes: {} })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility as never)
  }
  await ctx.plugin(s2sApply, { lifecycle: { autoResume: 'deny', mailboxDir, retryIntervalMs: timerMs } })
  const lifecycle = ctx.get('s2sLifecycle') as S2sLifecycleService
  if (withLedger) {
    ledger = ctx.get('s2sLedger') as S2sLedger
    await new Promise(resolve => setTimeout(resolve, 0))
    if (!ledger.isOpen) await ledger.open()
    disposers.push(async () => { await ledger!.close(); await ctx.fiber.dispose() })
  } else {
    disposers.push(async () => { await ctx.fiber.dispose() })
  }
  return { ctx, lifecycle, ledger, followups, mailboxDir, setLive: (value: boolean) => { live = value } }
}

/** Names of the queued files for one session — the on-disk truth, not a count. */
async function mailboxFiles(mailboxDir: string, sessionId: string): Promise<string[]> {
  const names = await readdir(join(mailboxDir, sessionId)).catch(() => [] as string[])
  return names.filter(name => name.endsWith('.json'))
}

describe('T19 mailbox: decide before taking', () => {
  it('★★ a kept entry is NOT removed — the file is unchanged on disk', async () => {
    // ★ The crash-window case. The assertion is on the directory listing, not on the
    // return value: "the entry was not taken" is only true if the file is still
    // there, and a return-value assertion would pass even if it had been deleted.
    const dir = await tmp('s2s-mailbox-keep-')
    const mailbox = new S2sMailbox(dir)
    await mailbox.enqueue('sess-1', { msgId: 'm1', from: 'a', text: 'held', createdAt: 1 })
    expect(await mailboxFiles(dir, 'sess-1')).toHaveLength(1)

    const taken = await mailbox.drain('sess-1', { keep: () => false })
    expect(taken).toEqual([])
    expect(await mailboxFiles(dir, 'sess-1')).toHaveLength(1)

    // …and the same entry is still deliverable once it is allowed through.
    const delivered = await mailbox.drain('sess-1', { keep: () => true })
    expect(delivered.map(entry => entry.msgId)).toEqual(['m1'])
    expect(await mailboxFiles(dir, 'sess-1')).toHaveLength(0)
  })

  it('★ a filter that THROWS does not consume the entry either', async () => {
    // The mailbox must not invent a policy on top of the caller's: a throwing filter
    // means the caller could not decide, and the safe side of "could not decide" is
    // to leave the message where it is.
    const dir = await tmp('s2s-mailbox-throw-')
    const mailbox = new S2sMailbox(dir)
    await mailbox.enqueue('sess-1', { msgId: 'm1', from: 'a', text: 'x', createdAt: 1 })
    const taken = await mailbox.drain('sess-1', { keep: () => { throw new Error('no answer') } })
    expect(taken).toEqual([])
    expect(await mailboxFiles(dir, 'sess-1')).toHaveLength(1)
  })
})

describe('T19 fallback pass', () => {
  it('★★ a pass without a usable ledger reports SKIPPED, not "nothing due"', async () => {
    // "I cannot decide" and "I decided there was nothing" are different facts; a
    // zero would merge them and make an inert pass read as healthy.
    const { lifecycle } = await harness({ withLedger: false })
    await expect(lifecycle.retryDue()).resolves.toEqual({ sessions: 0, drained: 0 })
    const status = lifecycle.getLastRetryStatus()
    expect(status?.skipped).toBe('ledger-closed')
  })

  it('★★ a due entry is delivered by the pass, with no event to trigger it', async () => {
    const { lifecycle, ledger, followups, setLive } = await harness()
    setLive(true)
    // A row whose clock is already past: recorded 10 minutes ago, so `nextAttemptAt`
    // (which starts at `createdAt`) is due.
    await ledger!.record({ msgId: 'm-due', from: 'a', to: 'sess-1', text: 'retry me', createdAt: Date.now() - 10 * 60 * 1000 })
    await lifecycle.queueForDormant({ sessionId: 'sess-1', from: 'a', text: 'retry me', msgId: 'm-due' })

    expect(await lifecycle.retryDue()).toEqual({ sessions: 1, drained: 1 })
    expect(followups).toHaveLength(1)
    const row = (await ledger!.get('m-due'))!
    expect(row.status).toBe('inboxed')
  })

  it('★★★ a backed-off entry is LEFT IN THE MAILBOX, not taken and put back', async () => {
    // This is the whole point of the `keep` filter, observed from outside: the
    // message stays on disk, nothing is delivered, and the pass reports that it is
    // waiting rather than pretending the queue was empty.
    const { lifecycle, ledger, followups, mailboxDir, setLive } = await harness()
    setLive(true)
    await ledger!.record({ msgId: 'm-wait', from: 'a', to: 'sess-1', text: 'not yet', createdAt: Date.now() - 10 * 60 * 1000 })
    await lifecycle.queueForDormant({ sessionId: 'sess-1', from: 'a', text: 'not yet', msgId: 'm-wait' })
    // One failed attempt starts the backoff, so the row is now scheduled in the future.
    await ledger!.claimDelivery('m-wait')
    await ledger!.markAttemptFailed('m-wait', 'absent')

    // ★ Counting the rewrite is what separates "never taken" from "taken and put
    // back". Both leave a file behind, so the file-existence assertion above passes
    // either way — verified: a mutant whose filter records the wait but returns
    // `true` (take-then-requeue) left all eight cases green. A re-enqueue is the
    // observable difference, and a re-enqueue is exactly the crash window (delete
    // then rewrite) that the decide-first design exists to avoid.
    const enqueue = vi.spyOn(S2sMailbox.prototype, 'enqueue')
    const pass = await lifecycle.retryDue()
    expect(pass.drained).toBe(0)
    expect(followups).toHaveLength(0)
    expect(enqueue).not.toHaveBeenCalled()
    enqueue.mockRestore()
    // The observable that separates "kept on purpose" from "lost": the file is still there.
    expect(await mailboxFiles(mailboxDir, 'sess-1')).toHaveLength(1)
    // And the row is still queued, not consumed by a claim that should not have happened.
    const row = (await ledger!.get('m-wait'))!
    expect(row.status).toBe('queued')
    expect(row.attempts).toBe(1)
    expect(lifecycle.getLastRetryStatus()?.waited).toBeGreaterThan(0)
  })

  it('★ a live-agent-less session is skipped without error', async () => {
    // A dormant target cannot receive anything; waking it is `autoResume`'s decision,
    // not the retry pass's. It must not throw, and it must not count as a drain.
    const { lifecycle, ledger, followups, mailboxDir } = await harness()
    await ledger!.record({ msgId: 'm-dorm', from: 'a', to: 'sess-1', text: 'x', createdAt: Date.now() - 10 * 60 * 1000 })
    await lifecycle.queueForDormant({ sessionId: 'sess-1', from: 'a', text: 'x', msgId: 'm-dorm' })
    expect(await lifecycle.retryDue()).toEqual({ sessions: 1, drained: 0 })
    expect(followups).toHaveLength(0)
    // Nothing was taken: the message is still waiting for the session to wake. This
    // is the assertion that separates "skipped, still queued" from "silently drained".
    expect(await mailboxFiles(mailboxDir, 'sess-1')).toHaveLength(1)
  })

  it('★★★ two paths reaching one session still deliver exactly once', async () => {
    // ★ The T19 invariant "两路径不重复投递", measured by counting hand-overs. Both
    // paths are started together so they race for the same mailbox entry; the claim
    // CAS is what must hold the line. A return-value assertion would not show a
    // double delivery — only the count does.
    const { lifecycle, ledger, followups, setLive } = await harness()
    setLive(true)
    await ledger!.record({ msgId: 'm-race', from: 'a', to: 'sess-1', text: 'once', createdAt: Date.now() - 10 * 60 * 1000 })
    await lifecycle.queueForDormant({ sessionId: 'sess-1', from: 'a', text: 'once', msgId: 'm-race' })

    await Promise.all([
      lifecycle.retryDue(),            // timer path
      lifecycle.drain('sess-1'),       // agent/created path
    ])
    expect(followups).toHaveLength(1)
    expect((await ledger!.get('m-race'))!.status).toBe('inboxed')
  })

  it('★★★ the armed timer actually calls the pass (not just retryDue())', async () => {
    // ★ The consumption side of T19, one level up from the gate: `retryDue()` can be
    // perfect while the interval was never connected to it. No case that calls
    // `retryDue()` directly can see that — it would stay green with the timer
    // unimplemented, which is exactly the zero-consumer shape this project keeps
    // paying for. Nothing here calls `retryDue()`; the delivery can only come from
    // the interval.
    //
    // The service is constructed directly rather than through the plugin because the
    // plugin's config surface forwards only `enabled`/`autoResume`/`mailboxDir`, and
    // `retryIntervalMs` is deliberately a service-level knob for tests (production
    // wants the 30 s default). Passing 25 ms through the plugin would have been
    // silently dropped — a knob that exists but cannot be set reads exactly like one
    // that works.
    const mailboxDir = await tmp('s2s-retry-timer-mb-')
    const root = await tmp('s2s-retry-timer-db-')
    const ctx = new Context()
    ctx.logger.warn = vi.fn() as never
    await ctx.plugin(Storage)
    await ctx.plugin(sqliteStorage, { path: join(root, 'storage.db') })
    const facility = new DomainFacility(ctx, { backend: 'sqlite', routes: {} })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility as never)
    const followups: unknown[] = []
    const agent = {
      id: 'sess-1',
      status: 'idle',
      session: { requestHeader: () => undefined },
      ctx: new Context(),
      followup: (message: unknown) => { followups.push(message) },
      inject: () => {},
    }
    ctx.provide('agents', { get: (id: unknown) => String(id) === 'sess-1' ? agent : undefined, resume: vi.fn() } as never)
    const ledger = new S2sLedger(ctx, { timerIntervalMs: 0 })
    await ledger.open()
    const lifecycle = new S2sLifecycleService(ctx, { autoResume: 'deny', mailboxDir, retryIntervalMs: 25 })
    disposers.push(async () => { await ledger.close(); await ctx.fiber.dispose() })

    await ledger.record({ msgId: 'm-timer', from: 'a', to: 'sess-1', text: 'wake up', createdAt: Date.now() - 10 * 60 * 1000 })
    await lifecycle.queueForDormant({ sessionId: 'sess-1', from: 'a', text: 'wake up', msgId: 'm-timer' })

    const deadline = Date.now() + 3000
    while (followups.length === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(followups).toHaveLength(1)
  })
})