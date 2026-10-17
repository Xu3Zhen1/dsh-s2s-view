/**
 * T29 — self-target hard refusal (ruling 2026-10-17; revised per review
 * `审查-T29-1fb4190-退修-20261017.md`).
 *
 * The real defect: `s2s_message` / `s2s_resume` used the caller id only as the
 * sender label, so a session could send an s2s message to *itself* — and
 * `s2s_resume` could wake itself, fabricating lifecycle activity on the caller.
 *
 * The refusal is a REAL `S2sError` (`S2S_SELF_TARGET`) thrown by the tool body
 * and rendered by a wrapper; the review requires asserting the domain error
 * code separately from the visible text. The caller-identity-unavailable
 * fail-open must be observable on EVERY path that actually sends or queues.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { S2sError } from '../src/error.ts'
import { buildTools } from '../src/tools.ts'
import { resetSelfCheckSkipped } from '../src/ledger-diagnostics.ts'

// The skipped-check record is a module-level singleton: reset around every case
// so one case's entry cannot turn another case's "nothing recorded" assertion
// into a false pass (same discipline as ledgerDiagnostics.untrackedDeliveries).
beforeEach(() => { resetSelfCheckSkipped() })
afterEach(() => { resetSelfCheckSkipped() })

type Tool = { name: string; execute: (args: any, exec: any) => Promise<{ text: string }> }

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

const SELF = 'session-9f4b6738-79f2-474d-8018-14c9ac49af62'
const SIBLING = 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const IDLE = 'idle' as const

/**
 * Tool family wired to spies for EVERY side effect the refusal must avoid.
 * `budget` is a spy too — the review requires proving `budget.check` never runs
 * on a self refusal, which a missing key cannot prove.
 */
function harness(target: string, opts: { state?: string; lifecycle?: boolean; budget?: boolean; resolve?: unknown } = {}) {
  const spies = {
    deliver: vi.fn(() => (opts.state ?? IDLE) as 'idle' | 'busy' | 'absent'),
    record: vi.fn(async () => true),
    markInboxed: vi.fn(async () => undefined),
    queueForDormant: vi.fn(async () => 'resumed' as const),
    queuedCount: vi.fn(async () => 1),
    budgetCheck: vi.fn(async () => undefined),
  }
  const broker = { deliver: spies.deliver, history: vi.fn(() => [] as any[]) }
  const discovery = {
    list: vi.fn(async () => [] as any[]),
    resolve: opts.resolve ?? vi.fn(async () => ({ kind: 'ok', sessionId: target, title: 'a', state: opts.state ?? IDLE, workspaceDir: 'ws' }) as any),
    // T29 cases run against an AVAILABLE filter (empty archive) so the T30 gate
    // passes and the T29 assertions stay meaningful. The T30 suite below drives
    // the unavailable/archived/subagent stubs explicitly.
    archivedFilterState: vi.fn(() => ({ state: 'available', ids: [] as string[] }) as const),
    targetPolicyVerdict: vi.fn(() => undefined),
    classifyTarget: vi.fn((id: string, origin?: string) => (origin === 'subagent' ? 'subagent' : 'eligible') as const),
  }
  const ledger = {
    record: spies.record,
    markInboxed: spies.markInboxed,
    // s2s_status renders the sweep block from this; the stub just needs the
    // shape (the status suite asserts its own values elsewhere).
    sweepStatus: { armed: false, intervalMs: 3600000, landedDeadlineMs: 86400000 },
  }
  const defs = buildTools({
    // `s2s_status` attaches its sampler through ctx.on; without a context it
    // throws before rendering anything (observed when the status read-back case
    // was first added).
    ctx: { on: vi.fn(() => vi.fn()) },
    broker,
    discovery,
    ledger,
    ...(opts.budget === false ? {} : { budget: { check: spies.budgetCheck } }),
    ...(opts.lifecycle === false ? {} : { lifecycle: { queueForDormant: spies.queueForDormant, queuedCount: spies.queuedCount, resumeReport: vi.fn(() => undefined), resumeReports_: vi.fn(() => []) } }),
  } as any)
  const by = (n: string) => defs.find((d) => d.name === n) as unknown as Tool
  return { by, spies }
}

/** The three side-effect groups a self refusal must leave untouched. */
function expectNoSideEffects(spies: ReturnType<typeof harness>['spies']): void {
  expect(spies.record).not.toHaveBeenCalled()
  expect(spies.markInboxed).not.toHaveBeenCalled()
  expect(spies.deliver).not.toHaveBeenCalled()
  expect(spies.queueForDormant).not.toHaveBeenCalled()
  expect(spies.queuedCount).not.toHaveBeenCalled()
  expect(spies.budgetCheck).not.toHaveBeenCalled()
}

describe('T29 s2s_message: refusal shape and zero side effects', () => {
  it('★ refuses a canonical self target; spies prove record/budget/deliver/markInboxed never ran', async () => {
    const { by, spies } = await harness(SELF)
    const out = await by('s2s_message').execute({ name: 'a', text: 'hello' }, { agent: { id: SELF } })
    expect(out.text).toContain('S2S_SELF_TARGET')
    expectNoSideEffects(spies)
  })

  it('the visible refusal renders the REAL domain error code', async () => {
    // Review must-fix 2: the code must exist on a thrown S2sError, not only as a
    // string fragment. Assert via a direct throw-and-catch of the same class.
    let code: string | undefined
    try {
      throw new S2sError('probe', 'S2S_SELF_TARGET')
    } catch (e) {
      expect(e).toBeInstanceOf(S2sError)
      code = (e as S2sError).code
    }
    expect(code).toBe('S2S_SELF_TARGET')
    // And the receipt text is the wrapper's rendering of that code.
    const { by } = await harness(SELF)
    const out = await by('s2s_message').execute({ name: 'a', text: 'x' }, { agent: { id: SELF } })
    expect(out.text.startsWith('[S2S_SELF_TARGET] ')).toBe(true)
  })

  it('refuses the BARE-uuid spelling and the bare caller form', async () => {
    const bare = SELF.replace(/^session-/, '')
    const { by, spies } = await harness(SELF)
    expect((await by('s2s_message').execute({ session_id: bare, text: 'x' }, { agent: { id: SELF } })).text).toContain('S2S_SELF_TARGET')
    expect((await by('s2s_message').execute({ name: 'a', text: 'x' }, { agent: { id: bare } })).text).toContain('S2S_SELF_TARGET')
    expectNoSideEffects(spies)
  })

  it('refuses the unique SHORT-prefix self reference', async () => {
    const { by, spies } = await harness(SELF)
    const out = await by('s2s_message').execute({ session_id: '9f4b6738', text: 'x' }, { agent: { id: SELF } })
    expect(out.text).toContain('S2S_SELF_TARGET')
    expectNoSideEffects(spies)
  })

  it('★ a forged args.from can NOT bypass the real-caller judgment', async () => {
    const { by, spies } = await harness(SELF)
    const out = await by('s2s_message').execute({ name: 'a', text: 'x', from: 'someone-else' }, { agent: { id: SELF } })
    expect(out.text).toContain('S2S_SELF_TARGET')
    expectNoSideEffects(spies)
  })

  it('★ a forged args.from = TARGET does not fabricate a refusal of a sibling (review must-fix 3)', async () => {
    // If the code trusted args.from as identity, from === target would refuse
    // this send; the real caller is a different session, so it must pass.
    const { by, spies } = await harness(SIBLING)
    const out = await by('s2s_message').execute({ name: 'a', text: 'x', from: SIBLING }, { agent: { id: SELF } })
    expect(out.text).not.toContain('S2S_SELF_TARGET')
    expect(spies.deliver).toHaveBeenCalledTimes(1)
    expect(spies.record).toHaveBeenCalledTimes(1)
  })

  it('whitespace-only caller id counts as identity unavailable, not as self', async () => {
    // Review: undefined / empty / pure whitespace are uniformly "unavailable".
    const { by } = await harness(SELF)
    const out = await by('s2s_message').execute({ name: 'a', text: 'x' }, { agent: { id: '   ' } })
    expect(out.text).not.toContain('S2S_SELF_TARGET')
    expect(out.text).toContain('caller identity unavailable')
  })
})

describe('T29 s2s_message: the fail-open marker is on EVERY send/queue path (review must-fix 1)', () => {
  const noIdentity = {}

  it('marker on the live-delivered path', async () => {
    const { by } = await harness(SIBLING, { state: 'idle' })
    const out = await by('s2s_message').execute({ name: 'a', text: 'x' }, noIdentity)
    expect(out.text).toContain('caller identity unavailable')
  })

  it('marker on the broker-absent path (and side effects did run)', async () => {
    const { by, spies } = await harness(SIBLING, { state: 'absent' })
    const out = await by('s2s_message').execute({ name: 'a', text: 'x' }, noIdentity)
    expect(out.text).toContain('NOT delivered')
    expect(out.text).toContain('caller identity unavailable')
    expect(spies.record).toHaveBeenCalledTimes(1) // left queued, as designed
  })

  it('marker on the dormant-resumed path (side effects happened)', async () => {
    const { by, spies } = await harness(SIBLING, { state: 'dormant' })
    const out = await by('s2s_message').execute({ name: 'a', text: 'x' }, noIdentity)
    expect(out.text).toContain('Woke')
    expect(out.text).toContain('caller identity unavailable')
    expect(spies.record).toHaveBeenCalledTimes(1)
    expect(spies.queueForDormant).toHaveBeenCalledTimes(1)
  })

  it('marker on the dormant-queued path (autoResume off)', async () => {
    const { by, spies } = await harness(SIBLING, { state: 'dormant', lifecycle: false })
    const out = await by('s2s_message').execute({ name: 'a', text: 'x' }, noIdentity)
    expect(out.text).toContain('no lifecycle is configured')
    expect(out.text).toContain('caller identity unavailable')
    expect(spies.record).toHaveBeenCalledTimes(1)
  })
})

describe('T29 s2s_resume: refusal, fail-open marker, no regression', () => {
  it('★ refuses waking the calling session itself; queue/record never ran', async () => {
    const { by, spies } = await harness(SELF, { state: 'dormant' })
    const out = await by('s2s_resume').execute({ name: 'a', text: 'wake me' }, { agent: { id: SELF } })
    expect(out.text).toContain('S2S_SELF_TARGET')
    expectNoSideEffects(spies)
  })

  it('refuses the short-prefix self wake', async () => {
    const { by, spies } = await harness(SELF, { state: 'dormant' })
    const out = await by('s2s_resume').execute({ session_id: '9f4b6738', text: 'x' }, { agent: { id: SELF } })
    expect(out.text).toContain('S2S_SELF_TARGET')
    expectNoSideEffects(spies)
  })

  it('★ args.from = TARGET does not fabricate a refusal (review must-fix 3, resume direction)', async () => {
    const { by, spies } = await harness(SIBLING, { state: 'dormant' })
    const out = await by('s2s_resume').execute({ name: 'a', text: 'x', from: SIBLING }, { agent: { id: SELF } })
    expect(out.text).not.toContain('S2S_SELF_TARGET')
    expect(spies.queueForDormant).toHaveBeenCalledTimes(1)
  })

  it('marker on the queued wake path (via s2s_message dormant, an independent path)', async () => {
    // Kept as its own path: s2s_message's dormant branch queues without waking.
    const ctxHarness = harness(SIBLING, { state: 'dormant' })
    ctxHarness.spies.queueForDormant.mockResolvedValue('queued')
    const out = await ctxHarness.by('s2s_message').execute({ name: 'a', text: 'x' }, {})
    expect(out.text).toContain('Queued for')
    expect(out.text).toContain('caller identity unavailable')
    expect(ctxHarness.spies.record).toHaveBeenCalledTimes(1)
  })

  it('★ marker on the s2s_resume QUEUED branch (a real return, not a profile absence)', async () => {
    // Review must-fix 2: the queued return exists at
    // `outcome === 'resumed' ? … : 'Session … is dormant; queued …'`. The earlier
    // note claiming "s2s_resume has no queued return" was wrong — autoResume is
    // profile configuration, not an argument, and the branch is reachable by
    // mocking queueForDormant to report 'queued'.
    const { by, spies } = await harness(SIBLING, { state: 'dormant' })
    spies.queueForDormant.mockResolvedValue('queued')
    const out = await by('s2s_resume').execute({ name: 'a', text: 'x' }, {})
    expect(out.text).toContain('is dormant; queued (')
    expect(out.text).toContain('caller identity unavailable')
    expect(spies.queueForDormant).toHaveBeenCalledTimes(1)
  })

  it('★ s2s_message no-lifecycle branch carries the marker (records first, then reports)', async () => {
    // Review must-fix 2: the message no-lifecycle test was missing entirely.
    // This branch records the row BEFORE reporting "not handed", so it must not
    // be silent about the skipped check.
    const { by, spies } = await harness(SIBLING, { state: 'dormant', lifecycle: false })
    const out = await by('s2s_message').execute({ name: 'a', text: 'x' }, {})
    expect(out.text).toContain('no lifecycle is configured')
    expect(out.text).toContain('caller identity unavailable')
    expect(spies.record).toHaveBeenCalledTimes(1)
  })

  it('★ resume RESUMED path carries the marker (the real resume receipt)', async () => {
    // Correction of the previous round: the marker cases above exercised
    // s2s_message's dormant branch, NOT s2s_resume's own receipt.
    const { by, spies } = await harness(SIBLING, { state: 'dormant' })
    const out = await by('s2s_resume').execute({ name: 'a', text: 'x' }, {})
    expect(out.text).toContain('resumed and the queued message(s)')
    expect(out.text).toContain('caller identity unavailable')
    expect(spies.queueForDormant).toHaveBeenCalledTimes(1)
  })

  it('★ resume lifecycle-missing branch returns BEFORE resolution (no marker applies)', async () => {
    // Correction of my own over-claim: s2s_resume checks lifecycle BEFORE
    // resolving, so this branch has no resolution, no side effects and — by the
    // ruling's own wording ("all post-resolution returns") — no marker
    // requirement. The post-resolution no-lifecycle twin is s2s_message's, and
    // it IS covered (see the message suite).
    const { by, spies } = await harness(SIBLING, { state: 'dormant', lifecycle: false })
    const out = await by('s2s_resume').execute({ name: 'a', text: 'x' }, {})
    // The resume wording differs from the message one: "s2s lifecycle is not
    // configured" (this branch returns before any resolution).
    expect(out.text).toContain('lifecycle is not configured')
    expect(out.text).not.toContain('caller identity unavailable')
    expect(spies.record).not.toHaveBeenCalled()
  })

  it('★ THROWN budget error: same object re-thrown, evidence retained', async () => {
    const { resetSelfCheckSkipped, readSelfCheckSkipped } = await import('../src/ledger-diagnostics.ts')
    resetSelfCheckSkipped()
    const h = harness(SIBLING, { state: 'idle' })
    const boom = new Error('budget exploded')
    h.spies.budgetCheck.mockRejectedValue(boom)
    // The ORIGINAL exception object escapes unchanged (not a rewritten one).
    await expect(h.by('s2s_message').execute({ name: 'a', text: 'x' }, {})).rejects.toBe(boom)
    const skipped = readSelfCheckSkipped()
    expect(skipped.length).toBe(1)
    expect(skipped[0]!.tool).toBe('s2s_message')
    expect(skipped[0]!.target).toBe(SIBLING)
    // And the status reads it back.
    const out = await h.by('s2s_status').execute({}, { agent: { id: SELF } })
    expect(out.text).toContain('self-target check skipped for 1 recent resolved attempt(s)')
    expect(out.text).toContain('s2s_message -> ' + SIBLING)
  })

  it('★ THROWN delivery error: same object re-thrown, evidence retained', async () => {
    const { resetSelfCheckSkipped, readSelfCheckSkipped } = await import('../src/ledger-diagnostics.ts')
    resetSelfCheckSkipped()
    const h = harness(SIBLING, { state: 'idle' })
    const boom = new Error('deliver exploded')
    h.spies.deliver.mockImplementation(() => { throw boom })
    await expect(h.by('s2s_message').execute({ name: 'a', text: 'x' }, {})).rejects.toBe(boom)
    const skipped = readSelfCheckSkipped()
    expect(skipped.length).toBe(1)
    expect(skipped[0]!.tool).toBe('s2s_message')
    const out = await h.by('s2s_status').execute({}, { agent: { id: SELF } })
    expect(out.text).toContain('self-target check skipped for 1 recent resolved attempt(s)')
  })

  it('★ THROWN queue error (message): same object re-thrown, evidence retained', async () => {
    const { resetSelfCheckSkipped, readSelfCheckSkipped } = await import('../src/ledger-diagnostics.ts')
    resetSelfCheckSkipped()
    const h = harness(SIBLING, { state: 'dormant' })
    const boom = new Error('queue exploded')
    h.spies.queueForDormant.mockRejectedValue(boom)
    await expect(h.by('s2s_message').execute({ name: 'a', text: 'x' }, {})).rejects.toBe(boom)
    const skipped = readSelfCheckSkipped()
    expect(skipped.length).toBe(1)
    expect(skipped[0]!.tool).toBe('s2s_message')
  })

  it('★ THROWN queue error (resume): same object re-thrown — the resume write point bears load', async () => {
    const { resetSelfCheckSkipped, readSelfCheckSkipped } = await import('../src/ledger-diagnostics.ts')
    resetSelfCheckSkipped()
    const h = harness(SIBLING, { state: 'dormant' })
    const boom = new Error('resume queue exploded')
    h.spies.queueForDormant.mockRejectedValue(boom)
    await expect(h.by('s2s_resume').execute({ name: 'a', text: 'x' }, {})).rejects.toBe(boom)
    const skipped = readSelfCheckSkipped()
    expect(skipped.length).toBe(1)
    expect(skipped[0]!.tool).toBe('s2s_resume')
    expect(skipped[0]!.target).toBe(SIBLING)
  })

  it('★ the retained list caps at 10 and keeps the MOST RECENT entries in order', async () => {
    const { resetSelfCheckSkipped, readSelfCheckSkipped } = await import('../src/ledger-diagnostics.ts')
    resetSelfCheckSkipped()
    // 12 attempts: the first 2 must be evicted, the last 10 retained, order kept.
    for (let i = 0; i < 12; i++) {
      const h = harness(SIBLING, { state: 'dormant' })
      h.spies.queueForDormant.mockRejectedValue(new Error('boom ' + i))
      await expect(h.by('s2s_message').execute({ name: 'a', text: 'x' }, {})).rejects.toThrow('boom ' + i)
    }
    const skipped = readSelfCheckSkipped()
    expect(skipped.length).toBe(10)
    expect(skipped[0]!.target).toBe(SIBLING)
    // Monotonic timestamps prove the retained window is the most recent 10.
    for (let i = 1; i < skipped.length; i++) {
      expect(skipped[i]!.at).toBeGreaterThanOrEqual(skipped[i - 1]!.at)
    }
  })

  it('★ CAP EVICTION PROOF: distinct targets show the retained window is exactly the LAST 10 inputs', async () => {
    // The review's evidence gap: 12 sends to the SAME target with monotonic
    // timestamps cannot distinguish "keep the newest 10" from "keep the oldest
    // 10" — both produce an identical-looking list. Distinct canonical targets
    // make the window observable: after 12 pushes, the retained targets must be
    // EXACTLY inputs 3..12 (0-indexed 2..11), in input order. Driven through
    // `recordSelfCheckSkipped` directly so the eviction itself is what is under
    // test, not the tool pipeline.
    const { resetSelfCheckSkipped, readSelfCheckSkipped, recordSelfCheckSkipped } = await import('../src/ledger-diagnostics.ts')
    resetSelfCheckSkipped()
    const targets: string[] = []
    for (let i = 0; i < 12; i++) {
      const t = 'session-' + String(i).padStart(8, '0') + '-aaaa-bbbb-cccc-dddddddddddd'
      targets.push(t)
      recordSelfCheckSkipped('s2s_message', t)
    }
    const skipped = readSelfCheckSkipped()
    expect(skipped.length).toBe(10)
    // The two OLDEST inputs (00…, 01…) must be gone.
    expect(skipped.map(s => s.target)).not.toContain(targets[0])
    expect(skipped.map(s => s.target)).not.toContain(targets[1])
    // The retained window is EXACTLY inputs 3..12, in input order.
    expect(skipped.map(s => s.target)).toEqual(targets.slice(2))
  })

  it('★ s2s_status reads the skipped record back, and identity-present sends do not record it', async () => {
    const { resetSelfCheckSkipped, readSelfCheckSkipped } = await import('../src/ledger-diagnostics.ts')
    resetSelfCheckSkipped()
    const { by, spies } = await harness(SIBLING, { state: 'dormant' })
    // A send WITH identity: no skipped record.
    await by('s2s_message').execute({ name: 'a', text: 'x' }, { agent: { id: SELF } })
    expect(readSelfCheckSkipped().length).toBe(0)
    // A send WITHOUT identity: one record, readable via s2s_status.
    await by('s2s_message').execute({ name: 'a', text: 'x' }, {})
    const skipped = readSelfCheckSkipped()
    expect(skipped.length).toBe(1)
    const status = by('s2s_status')
    const out = await status.execute({}, { agent: { id: SELF } })
    expect(out.text).toContain('self-target check skipped for 1 recent resolved attempt(s)')
    expect(out.text).toContain('s2s_message -> ' + SIBLING)
    expect(spies.record).toHaveBeenCalledTimes(2) // both sends recorded rows
    resetSelfCheckSkipped()
  })

  it('wakes a sibling dormant session as before (no regression)', async () => {
    const { by, spies } = await harness(SIBLING, { state: 'dormant' })
    const out = await by('s2s_resume').execute({ name: 'a', text: 'x' }, { agent: { id: SELF } })
    expect(out.text).not.toContain('S2S_SELF_TARGET')
    expect(spies.queueForDormant).toHaveBeenCalledTimes(1)
    expect(spies.record).toHaveBeenCalledTimes(1)
  })
})

describe('T29 integration: real discovery in the loop (review must-fix 3)', () => {
  it('★ a real discovery→buildTools short-id SELF wake is refused', async () => {
    // The constant-mock harness cannot prove the short-id path integrates with
    // resolution; this wires the REAL discovery service.
    const dir = await mkdtemp(join(tmpdir(), 's2s-t29-'))
    dirs.push(dir)
    const ctx = new Context()
    ctx.provide('agents', { get: () => undefined })
    ctx.provide('sessionQuery', {
      listSessions: async () => [{ header: { id: SELF, cwd: '/w' }, live: false }],
      readTitle: async (id: unknown) => (String(id) === SELF ? { title: '甲' } : undefined),
      readTitleSnapshots: async () => [],
    })
    const { S2sDiscoveryService } = await import('../src/discovery.ts')
    await ctx.plugin(S2sDiscoveryService, { cachePath: join(dir, 'c.json') })
    const discovery = ctx.get('s2sDiscovery')
    const deliver = vi.fn(() => IDLE)
    const ledger = { record: vi.fn(async () => true), markInboxed: vi.fn(async () => undefined), sweepStatus: { armed: false, intervalMs: 3600000, landedDeadlineMs: 86400000 } }
    const defs = buildTools({ broker: { deliver, history: vi.fn(() => []) }, discovery, ledger } as any)
    const msg = defs.find((d) => d.name === 's2s_message') as unknown as Tool
    const out = await msg.execute({ session_id: '9f4b6738', text: 'x' }, { agent: { id: SELF } })
    expect(out.text).toContain('S2S_SELF_TARGET')
    expect(deliver).not.toHaveBeenCalled()
    expect(ledger.record).not.toHaveBeenCalled()
  })

  it('an ambiguous id collision (both params) leaves no side effects', async () => {
    // Two sessions share the requested short prefix: resolution must answer
    // ambiguous BEFORE any side effect, even when name is also passed.
    const A = 'session-9f4b6738-79f2-474d-8018-14c9ac49af62'
    const B = 'session-9f4b6738-aaaa-bbbb-cccc-dddddddddddd'
    const dir = await mkdtemp(join(tmpdir(), 's2s-t29-'))
    dirs.push(dir)
    const ctx = new Context()
    ctx.provide('agents', { get: () => undefined })
    ctx.provide('sessionQuery', {
      listSessions: async () => [
        { header: { id: A, cwd: '/w' }, live: false },
        { header: { id: B, cwd: '/w' }, live: false },
      ],
      readTitle: async (id: unknown) => (String(id) === A ? { title: '甲' } : String(id) === B ? { title: '乙' } : undefined),
      readTitleSnapshots: async () => [],
    })
    const { S2sDiscoveryService } = await import('../src/discovery.ts')
    await ctx.plugin(S2sDiscoveryService, { cachePath: join(dir, 'c.json') })
    const discovery = ctx.get('s2sDiscovery')
    const deliver = vi.fn(() => IDLE)
    const ledger = { record: vi.fn(async () => true), markInboxed: vi.fn(async () => undefined), sweepStatus: { armed: false, intervalMs: 3600000, landedDeadlineMs: 86400000 } }
    const defs = buildTools({ broker: { deliver, history: vi.fn(() => []) }, discovery, ledger } as any)
    const msg = defs.find((d) => d.name === 's2s_message') as unknown as Tool
    const out = await msg.execute({ name: '甲', session_id: '9f4b6738', text: 'x' }, { agent: { id: SELF } })
    expect(out.text).toContain('Multiple sessions named')
    expect(deliver).not.toHaveBeenCalled()
    expect(ledger.record).not.toHaveBeenCalled()
  })
})
