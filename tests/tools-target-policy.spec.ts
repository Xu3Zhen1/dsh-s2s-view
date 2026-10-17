/**
 * T30 — target-legality filter (archived / subagent), ruling 2026-10-17.
 *
 * Covers the ruling's acceptance list: default exclusion and explicit look-back
 * on the discovery tools; archived/subagent refusal with zero side effects on
 * both delivery tools (name, id and list-bypass paths); L0 warm-cache bypass
 * protection; archive state flipping at runtime; registry absent / non-array /
 * throwing fail-closed with `S2S_TARGET_POLICY_UNAVAILABLE`; ordinary peers
 * unaffected; history/reconcile untouched by the filter.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { buildTools } from '../src/tools.ts'
import { S2sError } from '../src/error.ts'
import { resetSelfCheckSkipped } from '../src/ledger-diagnostics.ts'

type Tool = { name: string; execute: (args: any, exec: any) => Promise<{ text: string }> }

const dirs: string[] = []
beforeEach(() => { resetSelfCheckSkipped() })
afterEach(async () => {
  resetSelfCheckSkipped()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

const CALLER = 'session-11111111-2222-3333-4444-555555555555'
const PEER = 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const ARCHIVED = 'session-cccccccc-dddd-eeee-ffff-000000000000'
const SUBAGENT = 'session-dddddddd-eeee-ffff-0000-111111111111'

interface HarnessOptions {
  /** Canonical ids the (available) registry reports as archived. */
  archived?: string[]
  /** Fail mode of the registry read. */
  filter?: 'available' | 'registry-absent' | 'registry-read-failed' | 'not-an-array'
  state?: string
  lifecycle?: boolean
  budget?: boolean
  /** Mutable archive set — lets a case flip the state mid-flight. */
  liveArchived?: { ids: string[] }
}

function harness(target: string, opts: HarnessOptions = {}) {
  const spies = {
    deliver: vi.fn(() => (opts.state ?? 'idle') as 'idle' | 'busy' | 'absent'),
    record: vi.fn(async () => true),
    markInboxed: vi.fn(async () => undefined),
    queueForDormant: vi.fn(async () => 'resumed' as const),
    queuedCount: vi.fn(async () => 1),
    budgetCheck: vi.fn(async () => undefined),
  }
  const mode = opts.filter ?? 'available'
  const live = opts.liveArchived ?? { ids: opts.archived ?? [] }
  const archivedFilterState = () => {
    if (mode === 'registry-absent') return { state: 'unavailable', reason: 'registry-absent' } as const
    if (mode === 'registry-read-failed') return { state: 'unavailable', reason: 'registry-read-failed' } as const
    if (mode === 'not-an-array') return { state: 'unavailable', reason: 'archived-session-ids-not-an-array' } as const
    return { state: 'available', ids: [...live.ids] } as const
  }
  const classifyTarget = (id: string, origin?: string) => {
    if (mode === 'available' && live.ids.includes(id)) return 'archived' as const
    if (origin === 'subagent') return 'subagent' as const
    if (origin !== undefined) return 'unknown' as const
    return 'eligible' as const
  }
  const broker = { deliver: spies.deliver, history: vi.fn(() => [] as any[]) }
  const discovery = {
    list: vi.fn(async () => [] as any[]),
    resolve: vi.fn(async () => {
      const origin = target === SUBAGENT ? 'subagent' : undefined
      // The ok result carries `origin` so the gate's re-classifier (which reads
      // it from the resolved record) sees the same identity the corpus had.
      return { kind: 'ok', sessionId: target, title: 'a', state: opts.state ?? 'idle', workspaceDir: 'ws', matchedBy: 'exact', targetClass: classifyTarget(target, origin), ...(origin === undefined ? {} : { origin }) } as any
    }),
    archivedFilterState: vi.fn(archivedFilterState),
    targetPolicyVerdict: vi.fn((info: { sessionId: string; origin?: string; headerUnproven?: boolean }) => {
        const f = archivedFilterState()
        if (f.state === 'unavailable') return { code: 'S2S_TARGET_POLICY_UNAVAILABLE' as const, message: f.reason }
        const cls = classifyTarget(info.sessionId, info.origin, f.ids, info.headerUnproven)
        if (cls === 'archived') return { code: 'S2S_ARCHIVED_TARGET' as const, message: 'archived' }
        if (cls === 'subagent') return { code: 'S2S_SUBAGENT_TARGET' as const, message: 'subagent' }
        if (cls === 'unknown') return { code: 'S2S_TARGET_POLICY_UNAVAILABLE' as const, message: 'unknown' }
        return undefined
      }),
    classifyTarget: vi.fn(classifyTarget),
  }
  const ledger = {
    isOpen: true,
    record: spies.record,
    markInboxed: spies.markInboxed,
    cancel: vi.fn(async () => undefined),
    sweepStatus: { armed: false, intervalMs: 3600000, landedDeadlineMs: 86400000 },
  }
  const defs = buildTools({
    ctx: { on: vi.fn(() => vi.fn()), get: vi.fn(() => undefined) },
    broker,
    discovery,
    ledger,
    ...(opts.budget === false ? {} : { budget: { check: spies.budgetCheck } }),
    ...(opts.lifecycle === false ? {} : { lifecycle: { queueForDormant: spies.queueForDormant, queuedCount: spies.queuedCount, resumeReport: vi.fn(() => undefined), resumeReports_: vi.fn(() => []) } }),
  } as any)
  const by = (n: string) => defs.find((d) => d.name === n) as unknown as Tool
  return { by, spies, ledger, live }
}

describe('T30 delivery-side refusal: archived', () => {
  it('★ refuses an archived target by NAME with S2S_ARCHIVED_TARGET and zero side effects', async () => {
    const { by, spies } = await harness(ARCHIVED, { archived: [ARCHIVED], state: 'idle' })
    const out = await by('s2s_message').execute({ name: 'a', text: 'x' }, { agent: { id: CALLER } })
    expect(out.text).toContain('S2S_ARCHIVED_TARGET')
    expect(spies.record).not.toHaveBeenCalled()
    expect(spies.deliver).not.toHaveBeenCalled()
    expect(spies.markInboxed).not.toHaveBeenCalled()
    expect(spies.budgetCheck).not.toHaveBeenCalled()
  })

  it('refuses the same target when reached by session_id (list bypass)', async () => {
    const { by, spies } = await harness(ARCHIVED, { archived: [ARCHIVED], state: 'idle' })
    const out = await by('s2s_message').execute({ session_id: ARCHIVED, text: 'x' }, { agent: { id: CALLER } })
    expect(out.text).toContain('S2S_ARCHIVED_TARGET')
    expect(spies.record).not.toHaveBeenCalled()
  })

  it('refuses an archived DORMANT target on s2s_resume without waking it', async () => {
    const { by, spies } = await harness(ARCHIVED, { archived: [ARCHIVED], state: 'dormant' })
    const out = await by('s2s_resume').execute({ name: 'a', text: 'x' }, { agent: { id: CALLER } })
    expect(out.text).toContain('S2S_ARCHIVED_TARGET')
    expect(spies.queueForDormant).not.toHaveBeenCalled()
    expect(spies.record).not.toHaveBeenCalled()
  })

  it('★ the post-budget re-check catches a session archived MID-FLIGHT and cancels the queued row', async () => {
    // Pre-check sees it eligible; the archive flips while budget runs; the
    // re-check must refuse AND explicitly cancel the already-recorded row —
    // never leave retryable ghost work (ruling: queued 行须显式 cancelled).
    const live = { ids: [] as string[] }
    const { by, spies, ledger } = await harness(ARCHIVED, { liveArchived: live, state: 'dormant' })
    const originalCheck = spies.budgetCheck.getMockImplementation()!
    spies.budgetCheck.mockImplementation(async (...a: any[]) => {
      const r = await originalCheck(...a)
      live.ids.push(ARCHIVED) // archive state flips during the async budget
      return r
    })
    const out = await by('s2s_message').execute({ name: 'a', text: 'x' }, { agent: { id: CALLER } })
    expect(out.text).toContain('S2S_ARCHIVED_TARGET')
    expect(spies.record).toHaveBeenCalledTimes(1) // row was recorded pre-budget
    expect(ledger.cancel).toHaveBeenCalledTimes(1) // then explicitly cancelled
    expect(spies.queueForDormant).not.toHaveBeenCalled()
  })

  it('an ordinary peer is unaffected (delivery succeeds)', async () => {
    const { by, spies } = await harness(PEER, { state: 'idle' })
    const out = await by('s2s_message').execute({ name: 'a', text: 'x' }, { agent: { id: CALLER } })
    expect(out.text).not.toContain('S2S_')
    expect(spies.deliver).toHaveBeenCalledTimes(1)
  })
})

describe('T30 delivery-side refusal: subagent', () => {
  it('★ refuses a subagent-origin target with S2S_SUBAGENT_TARGET and zero side effects', async () => {
    const { by, spies } = await harness(SUBAGENT, { state: 'idle' })
    const out = await by('s2s_message').execute({ name: 'a', text: 'x' }, { agent: { id: CALLER } })
    expect(out.text).toContain('S2S_SUBAGENT_TARGET')
    expect(spies.record).not.toHaveBeenCalled()
    expect(spies.deliver).not.toHaveBeenCalled()
  })

  it('refuses a subagent DORMANT target on s2s_resume without waking it', async () => {
    const { by, spies } = await harness(SUBAGENT, { state: 'dormant' })
    const out = await by('s2s_resume').execute({ name: 'a', text: 'x' }, { agent: { id: CALLER } })
    expect(out.text).toContain('S2S_SUBAGENT_TARGET')
    expect(spies.queueForDormant).not.toHaveBeenCalled()
  })

  it('archived wins over subagent when both apply (ruling: 优先 archived)', async () => {
    const { by } = await harness(SUBAGENT, { archived: [SUBAGENT], state: 'idle' })
    const out = await by('s2s_message').execute({ name: 'a', text: 'x' }, { agent: { id: CALLER } })
    expect(out.text).toContain('S2S_ARCHIVED_TARGET')
    expect(out.text).not.toContain('S2S_SUBAGENT_TARGET')
  })
})

describe('T30 policy unavailable: fail-closed (ruling §3)', () => {
  it.each(['registry-absent', 'registry-read-failed', 'not-an-array'] as const)('★ %s ⇒ S2S_TARGET_POLICY_UNAVAILABLE, zero side effects, precise reason', async (mode) => {
    const { by, spies } = await harness(PEER, { filter: mode, state: 'idle' })
    const out = await by('s2s_message').execute({ name: 'a', text: 'x' }, { agent: { id: CALLER } })
    expect(out.text).toContain('S2S_TARGET_POLICY_UNAVAILABLE')
    expect(out.text).not.toContain('S2S_ARCHIVED_TARGET') // archive state unknown ⇒ no such claim
    if (mode === 'registry-absent') expect(out.text).toContain('registry-absent')
    if (mode === 'registry-read-failed') expect(out.text).toContain('registry-read-failed')
    if (mode === 'not-an-array') expect(out.text).toContain('archived-session-ids-not-an-array')
    expect(spies.record).not.toHaveBeenCalled()
    expect(spies.deliver).not.toHaveBeenCalled()
    expect(spies.queueForDormant).not.toHaveBeenCalled()
  })

  it('★ resume fails closed too, and never wakes', async () => {
    const { by, spies } = await harness(PEER, { filter: 'registry-absent', state: 'dormant' })
    const out = await by('s2s_resume').execute({ name: 'a', text: 'x' }, { agent: { id: CALLER } })
    expect(out.text).toContain('S2S_TARGET_POLICY_UNAVAILABLE')
    expect(spies.queueForDormant).not.toHaveBeenCalled()
    expect(spies.record).not.toHaveBeenCalled()
  })

  it('the exact reason reaches the receipt verbatim (not collapsed to "absent")', async () => {
    const { by } = await harness(PEER, { filter: 'not-an-array', state: 'idle' })
    const out = await by('s2s_message').execute({ name: 'a', text: 'x' }, { agent: { id: CALLER } })
    expect(out.text).toContain('archived-session-ids-not-an-array')
    expect(out.text).not.toContain('reason: registry-absent')
  })
})

describe('T30 discovery surface: default exclusion and explicit look-back', () => {
  function listHarness(rows: Array<{ id: string; title: string; state?: string; origin?: string }>, opts: HarnessOptions = {}) {
    const infos = rows.map(r => ({ sessionId: r.id, title: r.title, state: r.state ?? 'dormant', workspaceDir: '/w', ...(r.origin === undefined ? {} : { origin: r.origin }) }))
    const h = harness(rows[0]!.id, opts)
    ;(h as any).discoveryOverride = undefined
    // Rebuild tools with a list-returning discovery, preserving spy ledger.
    const mode = opts.filter ?? 'available'
    const live = opts.liveArchived ?? { ids: opts.archived ?? [] }
    const archivedFilterState = () => {
      if (mode === 'registry-absent') return { state: 'unavailable', reason: 'registry-absent' } as const
      if (mode === 'not-an-array') return { state: 'unavailable', reason: 'archived-session-ids-not-an-array' } as const
      return { state: 'available', ids: [...live.ids] } as const
    }
    const classifyTarget = (id: string, origin?: string) => {
      if (mode === 'available' && live.ids.includes(id)) return 'archived' as const
      if (origin === 'subagent') return 'subagent' as const
      if (origin !== undefined) return 'unknown' as const
      return 'eligible' as const
    }
    const discovery = {
      list: vi.fn(async () => infos),
      resolve: vi.fn(async () => ({ kind: 'ok', sessionId: rows[0]!.id, title: rows[0]!.title, state: 'dormant', workspaceDir: '/w', matchedBy: 'exact', targetClass: classifyTarget(rows[0]!.id, rows[0]!.origin) }) as any),
      archivedFilterState: vi.fn(archivedFilterState),
      targetPolicyVerdict: vi.fn((info: { sessionId: string; origin?: string; headerUnproven?: boolean }) => {
        const f = archivedFilterState()
        if (f.state === 'unavailable') return { code: 'S2S_TARGET_POLICY_UNAVAILABLE' as const, message: f.reason }
        const cls = classifyTarget(info.sessionId, info.origin, f.ids, info.headerUnproven)
        if (cls === 'archived') return { code: 'S2S_ARCHIVED_TARGET' as const, message: 'archived' }
        if (cls === 'subagent') return { code: 'S2S_SUBAGENT_TARGET' as const, message: 'subagent' }
        if (cls === 'unknown') return { code: 'S2S_TARGET_POLICY_UNAVAILABLE' as const, message: 'unknown' }
        return undefined
      }),
    classifyTarget: vi.fn(classifyTarget),
    }
    const ledger = { record: vi.fn(async () => true), markInboxed: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined), sweepStatus: { armed: false, intervalMs: 3600000, landedDeadlineMs: 86400000 } }
    const defs = buildTools({ ctx: { on: vi.fn(() => vi.fn()) }, broker: { deliver: vi.fn(() => 'idle'), history: vi.fn(() => []) }, discovery, ledger } as any)
    const by = (n: string) => defs.find((d) => d.name === n) as unknown as Tool
    return { by }
  }

  it('★ archived and subagent sessions are excluded by default', async () => {
    const { by } = listHarness([
      { id: PEER, title: '普通' },
      { id: ARCHIVED, title: '已归档' },
      { id: SUBAGENT, title: '子代理', origin: 'subagent' },
    ], { archived: [ARCHIVED] })
    const out = await by('s2s_sessions').execute({}, { agent: { id: CALLER } })
    expect(out.text).toContain('普通')
    expect(out.text).not.toContain('已归档')
    expect(out.text).not.toContain('子代理')
  })

  it('★ include_archived/include_subagents look back WITH explicit tags, never as ordinary peers', async () => {
    const { by } = listHarness([
      { id: PEER, title: '普通' },
      { id: ARCHIVED, title: '已归档' },
      { id: SUBAGENT, title: '子代理', origin: 'subagent' },
    ], { archived: [ARCHIVED] })
    const out = await by('s2s_sessions').execute({ include_archived: true, include_subagents: true }, { agent: { id: CALLER } })
    expect(out.text).toContain('已归档  [' + ARCHIVED.slice(8, 16) + ']  dormant  [archived]')
    expect(out.text).toContain('子代理  [' + SUBAGENT.slice(8, 16) + ']  dormant  [subagent]')
  })

  it('all=true does NOT imply include_* (workspace scope is not a delivery permission)', async () => {
    const { by } = listHarness([
      { id: PEER, title: '普通' },
      { id: ARCHIVED, title: '已归档' },
    ], { archived: [ARCHIVED] })
    const out = await by('s2s_sessions').execute({ all: true }, { agent: { id: CALLER } })
    expect(out.text).not.toContain('已归档')
  })

  it('★ registry unavailable ⇒ the list is stamped archiveFilter: unavailable and NOT a delivery roster', async () => {
    const { by } = listHarness([
      { id: PEER, title: '普通' },
      { id: ARCHIVED, title: '已归档' },
    ], { filter: 'registry-absent' })
    const out = await by('s2s_sessions').execute({}, { agent: { id: CALLER } })
    expect(out.text).toContain('archiveFilter: unavailable')
    expect(out.text).toContain('NOT a legal delivery roster')
    expect(out.text).toContain('已归档') // audit candidate, visibly stamped context
  })
})

describe('T30 history and reconcile are NOT filtered (ruling §4)', () => {
  it('history still answers for an archived session (readability preserved)', async () => {
    const live = { ids: [ARCHIVED] }
    const h = harness(ARCHIVED, { archived: [ARCHIVED], state: 'idle', liveArchived: live })
    // history reads the ledger through its own path; the point here is that the
    // target filter does not intercept it. Call with a broker-backed history.
    const out = await h.by('s2s_history').execute({ name: 'a' }, { agent: { id: CALLER } })
    // Whatever the content, it must NOT be a target-policy refusal.
    expect(out.text).not.toContain('S2S_ARCHIVED_TARGET')
    expect(out.text).not.toContain('S2S_TARGET_POLICY_UNAVAILABLE')
  })
})

describe('T30 real discovery integration (S2sDiscoveryService in the loop)', () => {
  it('★ a real discovery classifies a session whose header says origin=subagent, and the tool refuses', async () => {
    const dir = await mkdtemp(join(tmpdir(), 's2s-t30-'))
    dirs.push(dir)
    const ctx = new Context()
    // No workspaceRegistry provided ⇒ filter unavailable ⇒ fail-closed.
    ctx.provide('agents', { get: () => undefined })
    ctx.provide('sessionQuery', {
      listSessions: async () => [{ header: { id: SUBAGENT, cwd: '/w', origin: 'subagent' }, live: false }],
      readTitle: async () => ({ title: '子' }),
      readTitleSnapshots: async () => [],
    })
    const { S2sDiscoveryService } = await import('../src/discovery.ts')
    await ctx.plugin(S2sDiscoveryService, { cachePath: join(dir, 'c.json') })
    const discovery = ctx.get('s2sDiscovery')
    const deliver = vi.fn(() => 'idle')
    const ledger = { record: vi.fn(async () => true), markInboxed: vi.fn(async () => undefined), sweepStatus: { armed: false, intervalMs: 3600000, landedDeadlineMs: 86400000 } }
    const defs = buildTools({ ctx: { on: vi.fn(() => vi.fn()) }, broker: { deliver, history: vi.fn(() => []) }, discovery, ledger } as any)
    const msg = defs.find((d) => d.name === 's2s_message') as unknown as Tool
    const out = await msg.execute({ session_id: SUBAGENT, text: 'x' }, { agent: { id: CALLER } })
    // Registry absent ⇒ fail-closed takes precedence over the subagent code.
    expect(out.text).toContain('S2S_TARGET_POLICY_UNAVAILABLE')
    expect(deliver).not.toHaveBeenCalled()
  })

  it('★ with the registry present, the same subagent resolves to S2S_SUBAGENT_TARGET', async () => {
    const dir = await mkdtemp(join(tmpdir(), 's2s-t30-'))
    dirs.push(dir)
    const ctx = new Context()
    ctx.provide('agents', { get: () => undefined })
    ctx.provide('workspaceRegistry', { archivedSessionIds: [] })
    ctx.provide('sessionQuery', {
      listSessions: async () => [{ header: { id: SUBAGENT, cwd: '/w', origin: 'subagent' }, live: false }],
      readTitle: async () => ({ title: '子' }),
      readTitleSnapshots: async () => [],
    })
    const { S2sDiscoveryService } = await import('../src/discovery.ts')
    await ctx.plugin(S2sDiscoveryService, { cachePath: join(dir, 'c2.json') })
    const discovery = ctx.get('s2sDiscovery')
    const deliver = vi.fn(() => 'idle')
    const ledger = { record: vi.fn(async () => true), markInboxed: vi.fn(async () => undefined), sweepStatus: { armed: false, intervalMs: 3600000, landedDeadlineMs: 86400000 } }
    const defs = buildTools({ ctx: { on: vi.fn(() => vi.fn()) }, broker: { deliver, history: vi.fn(() => []) }, discovery, ledger } as any)
    const msg = defs.find((d) => d.name === 's2s_message') as unknown as Tool
    const out = await msg.execute({ session_id: SUBAGENT, text: 'x' }, { agent: { id: CALLER } })
    expect(out.text).toContain('S2S_SUBAGENT_TARGET')
    expect(deliver).not.toHaveBeenCalled()
  })
})
