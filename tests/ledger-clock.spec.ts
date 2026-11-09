/**
 * T27 — monotonic backoff under a clock rollback, and the `nextAttemptAt` clamp.
 *
 * Spec (plan §6 R14 / L1442 / L1531): retries must stay monotone across a wall-clock
 * rollback, and a stamp implausibly far ahead (> 24 h) must be clamped **and logged**.
 *
 * Two things this file deliberately does NOT do:
 *
 * - **It does not test `performance.now()`.** The delay is derived from `attempts`, so
 *   no elapsed time is measured and there is no "rollback makes the delay wrong" entry
 *   point. The monotonic clock is also unusable for a *persisted* schedule: its zero
 *   point resets with the process, while `nextAttemptAt` must survive restarts — the
 *   spec concedes this itself ("持久化仍存 wall-clock nextAttemptAt").
 * - **It does not settle for "the stamp did not go backwards".** The trap here is
 *   `max(now, previous) + delay`, which is monotone but re-adds the previous stamp's
 *   remainder on every failure. The ★★★ case below pins the correct instant exactly.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import * as sqliteStorage from '@deepseek-ai/dsh-storage-sqlite'
import { nextAttemptAtAfterFailure, retryBackoffMs, S2sLedger } from '../src/ledger.ts'
import { LEDGER_LIMITS } from '../src/ledger-schema.ts'
import { readClampedNextAttempts, resetClampedNextAttempts } from '../src/ledger-diagnostics.ts'
import { buildTools } from '../src/tools.ts'
import type { Tool } from '@deepseek-ai/dsh-tools'

const H = 60 * 60 * 1000

const dirs: string[] = []
const disposers: Array<() => Promise<void>> = []
afterEach(async () => {
  // Close ledgers BEFORE removing their directories: an open sqlite handle makes
  // `rm` fail with EBUSY, which would look like a logic failure.
  for (const dispose of disposers.splice(0)) {
    try { await dispose() } catch { /* cleanup must not mask the real result */ }
  }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
  resetClampedNextAttempts()
})

async function openLedger(name: string) {
  const root = await mkdtemp(join(tmpdir(), `s2s-clock-${name}-`))
  dirs.push(root)
  const ctx = new Context()
  const warn = vi.fn()
  ctx.logger.warn = warn as never
  await ctx.plugin(Storage)
  await ctx.plugin(sqliteStorage, { path: join(root, 'storage.db') })
  const facility = new DomainFacility(ctx, { backend: 'sqlite', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility as never)
  const ledger = new S2sLedger(ctx, { timerIntervalMs: 0 })
  await ledger.open()
  disposers.push(async () => { await ledger.close(); await ctx.fiber.dispose() })
  return { ctx, ledger, warn }
}



describe('T27 nextAttemptAtAfterFailure — the arithmetic', () => {
  it('★★★ the floor applies to the RESULT, not the base (no accumulated over-delay)', () => {
    // ★ git-line's counterexample, which the first design got wrong. Writing
    // `base = max(now, previous); at = base + delay` is monotone and still wrong:
    // with a stamp already 1 s ahead it schedules `now + 1000 + delay`, adding the
    // old remainder on every failure. The correct instant is `now + delay`.
    const msgId = 'm-reverse'
    const now = 1_000_000
    const delay = retryBackoffMs(msgId, 1)
    const previousAt = now + 1000
    const scheduled = nextAttemptAtAfterFailure(msgId, 1, now, previousAt)
    expect(scheduled.at).toBe(now + delay)
    expect(scheduled.at).not.toBe(previousAt + delay)
    expect(scheduled.clamped).toBe(false)
  })

  it('★★ a wall clock that jumps BACKWARDS never pulls the stamp in', () => {
    // The rollback case the spec names. The stamp is already a minute in the future
    // when the clock jumps back an hour: the new instant must not be earlier than
    // what was already promised, or a retry would become due sooner than scheduled.
    const msgId = 'm-rollback'
    const t0 = 5_000_000
    const previousAt = t0 + 60_000
    const rolledBackNow = t0 - 1 * H
    const scheduled = nextAttemptAtAfterFailure(msgId, 1, rolledBackNow, previousAt)
    expect(scheduled.at).toBe(previousAt)
    expect(scheduled.at).toBeGreaterThan(rolledBackNow)
  })

  it('★★ a stamp implausibly far ahead is clamped to the 24h ceiling', () => {
    const msgId = 'm-clamp'
    const now = 10_000_000
    const previousAt = now + 48 * H
    const scheduled = nextAttemptAtAfterFailure(msgId, 1, now, previousAt)
    expect(scheduled.clamped).toBe(true)
    expect(scheduled.at).toBe(now + LEDGER_LIMITS.nextAttemptAtClampMs)
    // `intendedAt` stays the honest pre-guard instant, so a reader can see WHY it fired.
    expect(scheduled.intendedAt).toBe(now + retryBackoffMs(msgId, 1))
  })

  it('★ a normal failure schedules now + backoff and reports no clamp', () => {
    const msgId = 'm-normal'
    const now = 20_000_000
    const scheduled = nextAttemptAtAfterFailure(msgId, 2, now, 0)
    expect(scheduled.clamped).toBe(false)
    expect(scheduled.at).toBe(now + retryBackoffMs(msgId, 2))
  })
})

describe('T27 markAttemptFailed — the clamp is applied, recorded and logged', () => {
  it('★★★ a far-future stamp is pulled back, recorded for read-back, and warned about', async () => {
    // The clamp has to leave a trace an auditor can retrieve. The logger alone is not
    // durable on this host (no host log dir; transcripts keep only events), so the
    // record is the half that makes the guard checkable after the fact — and the log
    // is kept beside it because the spec asks for "记日志" in so many words.
    const { ledger, warn } = await openLedger('apply')
    const now = Date.now()
    const far = now + 48 * H
    // Reach the guard through the PUBLIC path: a row recorded with a stamp 48 h out
    // (what a forward clock jump leaves behind on disk), claimed once it is due, then
    // failed. At the failure the previous stamp is still far in the future, which is
    // exactly the state the clamp exists for. Writing the row through the storage
    // table directly would prove less and couple this spec to the schema layout.
    await ledger.record({ msgId: 'm-far', from: 'a', to: 's', text: 'x', createdAt: far })
    expect(await ledger.claimDelivery('m-far', { now: far + 1 })).toEqual({ decision: 'deliver', reason: 'claimed' })

    expect(await ledger.markAttemptFailed('m-far', 'absent')).toEqual({ outcome: 'rolled-back' })

    const row = (await ledger.get('m-far'))!
    expect(row.status).toBe('queued')
    // Pulled back to the ceiling, not left 48 h out (which would be past the 24 h
    // zombie deadline — the row would be judged dead before its own retry was due).
    expect(row.nextAttemptAt).toBeGreaterThanOrEqual(now + LEDGER_LIMITS.nextAttemptAtClampMs - 5000)
    expect(row.nextAttemptAt).toBeLessThanOrEqual(Date.now() + LEDGER_LIMITS.nextAttemptAtClampMs)

    const records = readClampedNextAttempts()
    expect(records).toHaveLength(1)
    expect(records[0]!.msgId).toBe('m-far')
    expect(records[0]!.previousAt).toBe(far)
    expect(records[0]!.clampedTo).toBe(row.nextAttemptAt)
    expect(warn.mock.calls.some((call) => String(call[0]).includes('clamped'))).toBe(true)
  })

  it('★ a normal rollback records nothing (the guard must not fire on ordinary failures)', async () => {
    const { ledger } = await openLedger('quiet')
    await ledger.record({ msgId: 'm-ok', from: 'a', to: 's', text: 'x' })
    await ledger.claimDelivery('m-ok')
    expect(await ledger.markAttemptFailed('m-ok', 'absent')).toEqual({ outcome: 'rolled-back' })
    expect(readClampedNextAttempts()).toHaveLength(0)
  })
})

describe('T27 observability — the clamp has a reader in s2s_status', () => {
  async function statusTool(ledger: S2sLedger, ctx: Context): Promise<Tool> {
    const broker = { deliver: vi.fn(() => 'idle' as const), history: vi.fn(() => [] as never[]) }
    const discovery = {
      list: vi.fn(async () => [] as never[]),
      resolve: vi.fn(async () => ({ kind: 'ok', sessionId: 'sess-1', title: 'a', state: 'live-idle', workspaceDir: 'ws' }) as never),
      archivedFilterState: vi.fn(() => ({ state: 'available', ids: [] as string[] })),
      targetPolicyVerdict: vi.fn(() => undefined),
      classifyTarget: vi.fn((id: string, origin?: string) => (origin === 'subagent' ? 'subagent' : origin !== undefined ? 'unknown' : 'eligible')),
    }
    const defs = buildTools({ ctx, broker, discovery, ledger } as never)
    return defs.find((d) => d.name === 's2s_status') as unknown as Tool
  }

  it('★★ the guard line is present even with zero clamps (absence must be readable)', async () => {
    // "no line" would mean two opposite things: the guard never fired, or the guard is
    // not in this build. An always-present line keeps them apart.
    const { ledger, ctx } = await openLedger('render-empty')
    const status = await statusTool(ledger, ctx)
    const out = await status.execute({}, { agent: { id: 'sess-a' } } as never)
    expect(out.text).toContain('clock-jump guard: no nextAttemptAt clamp applied in this process')
  })

  it('★★★ a recorded clamp is RENDERED, so deleting the render line goes red', async () => {
    // ★ The consumption side. A record nobody reads is indistinguishable from no
    // record — the T22 lesson. This case is what makes a deleted render line go red
    // (and it is also why M-h, "clamp applied but not recorded", cannot pass).
    const { ledger, ctx } = await openLedger('render-full')
    const far = Date.now() + 48 * H
    await ledger.record({ msgId: 'm-far', from: 'a', to: 's', text: 'x', createdAt: far })
    expect(await ledger.claimDelivery('m-far', { now: far + 1 })).toEqual({ decision: 'deliver', reason: 'claimed' })
    await ledger.markAttemptFailed('m-far', 'absent')

    const status = await statusTool(ledger, ctx)
    const out = await status.execute({}, { agent: { id: 'sess-a' } } as never)
    expect(out.text).toContain('clock-jump guard: 1 nextAttemptAt clamp(s) applied')
    expect(out.text).toContain('m-far')
    expect(out.text).toContain('clamped-to=')
  })
})
