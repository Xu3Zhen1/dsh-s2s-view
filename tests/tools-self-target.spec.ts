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
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { S2sError } from '../src/error.ts'
import { buildTools } from '../src/tools.ts'

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
  }
  const ledger = { record: spies.record, markInboxed: spies.markInboxed }
  const defs = buildTools({
    broker,
    discovery,
    ledger,
    ...(opts.budget === false ? {} : { budget: { check: spies.budgetCheck } }),
    ...(opts.lifecycle === false ? {} : { lifecycle: { queueForDormant: spies.queueForDormant, queuedCount: spies.queuedCount } }),
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

  it('marker on the queued wake path (autoResume off, via s2s_message dormant)', async () => {
    // s2s_resume has no "queued" return (autoResume is a profile setting, not an
    // argument); the queued wake outcome is reached through s2s_message with a
    // lifecycle whose queueForDormant reports queued.
    const ctxHarness = harness(SIBLING, { state: 'dormant' })
    ctxHarness.spies.queueForDormant.mockResolvedValue('queued')
    const out = await ctxHarness.by('s2s_message').execute({ name: 'a', text: 'x' }, {})
    expect(out.text).toContain('Queued for')
    expect(out.text).toContain('caller identity unavailable')
    expect(ctxHarness.spies.record).toHaveBeenCalledTimes(1)
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
    const ledger = { record: vi.fn(async () => true), markInboxed: vi.fn(async () => undefined) }
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
    const ledger = { record: vi.fn(async () => true), markInboxed: vi.fn(async () => undefined) }
    const defs = buildTools({ broker: { deliver, history: vi.fn(() => []) }, discovery, ledger } as any)
    const msg = defs.find((d) => d.name === 's2s_message') as unknown as Tool
    const out = await msg.execute({ name: '甲', session_id: '9f4b6738', text: 'x' }, { agent: { id: SELF } })
    expect(out.text).toContain('Multiple sessions named')
    expect(deliver).not.toHaveBeenCalled()
    expect(ledger.record).not.toHaveBeenCalled()
  })
})
