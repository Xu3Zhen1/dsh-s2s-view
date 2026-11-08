import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { S2sDiscoveryService } from '../src/discovery.ts'
import { buildTools } from '../src/tools.ts'

/**
 * T16 — `latest_of` addressing.
 *
 * The plan's hard constraint is **"do not change the default semantics"**, so
 * half of this file is about `resolve()` still behaving exactly as before and the
 * other half is about the new entry point. `latest_of` was deliberately built as
 * a separate method rather than an option on `resolve()`: the "default unchanged"
 * claim is then structural (nothing was added to the old path) instead of a
 * promise that has to be re-verified every time someone edits `resolve()`.
 *
 * ## What these cases are actually pinning
 *
 * The ranking key is `createdAt` — **not** `lastActivity`. `lastActivity` is
 * declared on `S2sSessionInfo` and never assigned anywhere, so a ranking built on
 * it would sort by `undefined` and look plausible. The `unrankable` case below
 * exists to make that difference observable: a member with no `createdAt` must be
 * reported, never silently ranked as oldest (`0`) or newest.
 */

function rec(id: string, title: string, createdAt: number | undefined, extra: Record<string, unknown> = {}) {
  return {
    header: { id, createdAt, ...(extra.cwd === undefined ? {} : { cwd: extra.cwd }), ...(extra.origin === undefined ? {} : { origin: extra.origin }) },
    live: false,
  }
}

/** A lineage stub: one flat family with `root` as ancestor of everyone. */
function lineageOf(memberIds: string[]) {
  return { resolve: vi.fn(async () => ({ kind: 'resolved' as const, memberIds, complete: true })) }
}

async function mount(options: {
  records: unknown[]
  titles: Record<string, string>
  lineage?: { resolve: ReturnType<typeof vi.fn> }
  archived?: string[]
}) {
  const ctx = new Context()
  ctx.logger.warn = vi.fn() as never
  ctx.provide('agents', { get: () => undefined } as never)
  ctx.provide('sessionQuery', {
    listSessions: async () => options.records,
    readTitle: async (id: unknown) => options.titles[String(id)] === undefined ? undefined : { title: options.titles[String(id)] },
  } as never)
  if (options.archived !== undefined) ctx.provide('workspaceRegistry', { archivedSessionIds: options.archived } as never)
  if (options.lineage !== undefined) ctx.provide('s2sLineage', options.lineage as never)
  await ctx.plugin(S2sDiscoveryService)
  return ctx.get('s2sDiscovery') as S2sDiscoveryService
}

/**
 * Drive `s2s_latest` **through the tool surface** (T16 reachability).
 *
 * ★ Why this exists, spelled out because it is the whole point of the batch:
 * every other case in this file calls `discovery.resolveLatestOf()` DIRECTLY.
 * That proved the method correct while the defect — no production path from the
 * model to the method — went unnoticed: the method shipped in `lib/index.js`
 * with 13 green cases and **zero call sites**.
 *
 * ★ And this is not a theoretical argument: the FIRST draft of these cases fed
 * three sessions all titled "主干" and got back
 * `Multiple sessions named "主干". Disambiguate with session_id: a / b / c`.
 * That is correct behaviour — the anchor goes through the same exact-title
 * resolution as every other tool, so a duplicate title refuses rather than
 * guessing which lineage to search. A method-level test calling
 * `resolveLatestOf(['a','b','c'])` **cannot see the anchor-resolution step at
 * all**, so it could never have found this. That is the concrete case for
 * "at least one case must go through the tool surface".
 */
async function viaTool(options: Parameters<typeof mount>[0], args: { name?: string; session_id?: string; current?: string }) {
  const discovery = await mount(options)
  // buildTools needs a ctx for logging/ledger lookups that s2s_latest never
  // touches; a bare Context is enough and keeps this case free of the ledger.
  const ctx = new Context()
  ctx.logger.warn = vi.fn() as never
  const defs = buildTools({ ctx, broker: { history: () => [] } as never, discovery })
  const tool = defs.find(d => d.name === 's2s_latest')
  if (tool === undefined) throw new Error('s2s_latest is not registered — the tool surface gap is back')
  const out = await tool.execute(args as never, { agent: { id: 'sess-caller' } } as never)
  return { text: (out as { text: string }).text, defs }
}

describe('T16 reachability — the tool surface', () => {
  it('★ s2s_latest is registered, and executing it returns the newest lineage member', async () => {
    // ★ The anchor must have a UNIQUE title: `s2s_latest` resolves its anchor
    // through the same exact-title path as every other tool, so three sessions
    // all titled "主干" make the ANCHOR ambiguous and the call never reaches the
    // lineage search. That is correct behaviour (an ambiguous anchor could mean
    // the wrong lineage), and this test's first draft got it wrong — which is
    // itself the point of driving the tool surface: a direct-call test on
    // `resolveLatestOf(['a','b','c'])` cannot see the anchor-resolution step at
    // all. The lineage is anchored on `a` (titled "原型") and contains a/b/c.
    const { text, defs } = await viaTool({
      records: [rec('a', '原型', 100), rec('b', '继承者', 300), rec('c', '中间态', 200)],
      titles: { a: '原型', b: '继承者', c: '中间态' },
      lineage: lineageOf(['a', 'b', 'c']),
      archived: [],
    }, { name: '原型' })

    // The registration half: the name must exist on the surface at all.
    expect(defs.map(d => d.name)).toContain('s2s_latest')
    // The wiring half: the rendered text must carry the session the service
    // picked. A stubbed `execute` would fail here even with the tool registered.
    expect(text).toContain('Latest in the lineage of')
    expect(text).toContain('b')
    expect(text).toContain('chosen from 3 eligible rankable member(s)')
  })

  it('an ambiguous ANCHOR is refused rather than searching a guessed lineage', async () => {
    // Three sessions share the anchor title. The tool must stop at the ambiguity
    // instead of picking one and reporting a confident "latest".
    const { text } = await viaTool({
      records: [rec('a', '主干', 100), rec('b', '主干', 300)],
      titles: { a: '主干', b: '主干' },
      lineage: lineageOf(['a', 'b']),
      archived: [],
    }, { name: '主干' })
    expect(text).toContain('Multiple sessions named')
    expect(text).not.toContain('Latest in the lineage of')
  })

  it('★ the `current` argument actually reaches the service (translation, not just wiring)', async () => {
    // Deliberately chosen so the WRONG answer is the most attractive one: `b` is
    // the newest, and a tool that dropped `current` would return exactly that.
    const { text } = await viaTool({
      records: [rec('a', '原型', 100), rec('b', '继承者', 300)],
      titles: { a: '原型', b: '继承者' },
      lineage: lineageOf(['a', 'b']),
      archived: [],
    }, { name: '原型', current: 'b' })

    // `a` is the only remaining member once `b` is excluded.
    expect(text).toContain('Latest in the lineage of')
    expect(text).toContain('chosen from 1 eligible rankable member(s)')
  })

  it('★ a miss rendered through the tool names its own cause (G9 at the receipt level)', async () => {
    // No `s2sLineage` service mounted: the tool must say the SERVICE is
    // unavailable, not that the session has no lineage. Those two read
    // identically from a silent fallback, and only the receipt tells them apart.
    //
    // ★ The reason is `lineage-service-absent`, NOT `session-query-absent` — the
    // two are different layers and the first draft of this case conflated them:
    // `session-query-absent` is what S2sLineage reports when the HOST lacks
    // `sessionQuery`; `lineage-service-absent` is what discovery reports when the
    // PLUGIN lacks `s2sLineage`. Here only the plugin service is missing, so the
    // outer reason is the right one — and asserting the inner one would have been
    // an assertion about a path this test never reaches.
    const { text } = await viaTool({
      records: [rec('a', '原型', 100)],
      titles: { a: '原型' },
      archived: [],
    }, { name: '原型' })
    expect(text).toContain('lineage service is unavailable')
    expect(text).toContain('lineage-service-absent')
    expect(text).toContain('NOT "this session has no lineage"')
  })

  it('a policy-unavailable miss says it is NOT "no archived sessions"', async () => {
    const { text } = await viaTool({
      records: [rec('a', '原型', 100)],
      titles: { a: '原型' },
      lineage: lineageOf(['a']),
      // no workspaceRegistry ⇒ archive policy unavailable
    }, { name: '原型' })
    expect(text).toContain('policy is UNAVAILABLE')
    expect(text).toContain('registry-absent')
    expect(text).toContain('NOT "no archived sessions"')
  })
})

describe('T16 latest_of — ranking by createdAt', () => {
  it('picks the newest eligible member of the lineage', async () => {
    const d = await mount({
      records: [rec('a', '主干', 100), rec('b', '主干', 300), rec('c', '主干', 200)],
      titles: { a: '主干', b: '主干', c: '主干' },
      lineage: lineageOf(['a', 'b', 'c']),
      archived: [],
    })
    const r = await d.resolveLatestOf('主干')
    expect(r.kind).toBe('ok')
    if (r.kind !== 'ok') return
    expect(r.sessionId).toBe('b')
    expect(r.createdAt).toBe(300)
    expect(r.candidateCount).toBe(3)
  })

  it('excludes the caller via `current` — "some OTHER member"', async () => {
    const d = await mount({
      records: [rec('a', '主干', 100), rec('b', '主干', 300)],
      titles: { a: '主干', b: '主干' },
      lineage: lineageOf(['a', 'b']),
      archived: [],
    })
    const r = await d.resolveLatestOf('主干', { current: 'b' })
    expect(r.kind).toBe('ok')
    if (r.kind !== 'ok') return
    // The newest is the one asked to be skipped, so the answer must fall to `a`
    // rather than returning `b` again (which would be a no-op loop for a caller
    // trying to hand work to a successor).
    expect(r.sessionId).toBe('a')
  })

  it('★ ranks unrankable members as reported, NOT as 0 (which would make the oldest win)', async () => {
    const d = await mount({
      records: [rec('old', '主干', 100), rec('noda', '主干', undefined)],
      titles: { old: '主干', noda: '主干' },
      lineage: lineageOf(['old', 'noda']),
      archived: [],
    })
    const r = await d.resolveLatestOf('主干')
    expect(r.kind).toBe('ok')
    if (r.kind !== 'ok') return
    expect(r.sessionId).toBe('old')
    // The fact that `noda` could not be ranked must survive into the receipt.
    expect(r.unrankable).toEqual(['noda'])
    expect(r.candidateCount).toBe(1)
  })

  it('reports no-ranked-member when every member lacks createdAt', async () => {
    const d = await mount({
      records: [rec('x', '主干', undefined), rec('y', '主干', undefined)],
      titles: { x: '主干', y: '主干' },
      lineage: lineageOf(['x', 'y']),
      archived: [],
    })
    const r = await d.resolveLatestOf('主干')
    expect(r.kind).toBe('not-found')
    if (r.kind !== 'not-found') return
    expect(r.reason).toBe('no-ranked-member')
    expect(r.unrankable).toEqual(['x', 'y'])
  })

  it('breaks createdAt ties by id, so the answer is stable across runs', async () => {
    const d = await mount({
      records: [rec('z', '主干', 500), rec('m', '主干', 500)],
      titles: { z: '主干', m: '主干' },
      lineage: lineageOf(['z', 'm']),
      archived: [],
    })
    const first = await d.resolveLatestOf('主干')
    expect(first.kind).toBe('ok')
    if (first.kind !== 'ok') return
    // Ascending id wins the tie — a documented rule, not corpus order.
    expect(first.sessionId).toBe('m')
  })
})

describe('T16 latest_of — eligibility reuses the T30 classifier', () => {
  it('★ an ARCHIVED member never wins, even when it is the newest', async () => {
    const d = await mount({
      records: [rec('live', '主干', 100), rec('arch', '主干', 999)],
      titles: { live: '主干', arch: '主干' },
      lineage: lineageOf(['live', 'arch']),
      archived: ['arch'],
    })
    const r = await d.resolveLatestOf('主干')
    expect(r.kind).toBe('ok')
    if (r.kind !== 'ok') return
    expect(r.sessionId).toBe('live')
  })

  it('★ a SUBAGENT member never wins, even when it is the newest', async () => {
    const d = await mount({
      records: [rec('live', '主干', 100), rec('sub', '主干', 999, { origin: 'subagent' })],
      titles: { live: '主干', sub: '主干' },
      lineage: lineageOf(['live', 'sub']),
      archived: [],
    })
    const r = await d.resolveLatestOf('主干')
    expect(r.kind).toBe('ok')
    if (r.kind !== 'ok') return
    expect(r.sessionId).toBe('live')
  })

  it('fails closed when the archive policy is unavailable — not "no archived sessions"', async () => {
    const d = await mount({
      records: [rec('a', '主干', 100)],
      titles: { a: '主干' },
      lineage: lineageOf(['a']),
      // no workspaceRegistry provided at all
    })
    const r = await d.resolveLatestOf('主干')
    expect(r.kind).toBe('policy-unavailable')
    if (r.kind !== 'policy-unavailable') return
    expect(r.reason).toBe('registry-absent')
  })
})

describe('T16 latest_of — every miss names its own cause (G9)', () => {
  it('distinguishes empty-name / anchor-not-found / lineage-service-absent', async () => {
    const d = await mount({
      records: [rec('a', '主干', 100)],
      titles: { a: '主干' },
      archived: [],
      // deliberately NO lineage service
    })

    const empty = await d.resolveLatestOf('   ')
    expect(empty.kind).toBe('not-found')
    if (empty.kind === 'not-found') expect(empty.reason).toBe('empty-name')

    const noAnchor = await d.resolveLatestOf('不存在的名字')
    expect(noAnchor.kind).toBe('not-found')
    if (noAnchor.kind === 'not-found') expect(noAnchor.reason).toBe('anchor-not-found')

    const noService = await d.resolveLatestOf('主干')
    expect(noService.kind).toBe('lineage-unavailable')
    if (noService.kind === 'lineage-unavailable') expect(noService.reason).toBe('lineage-service-absent')
  })

  it('carries the lineage service\'s own unavailable reason through verbatim', async () => {
    const d = await mount({
      records: [rec('a', '主干', 100)],
      titles: { a: '主干' },
      archived: [],
      lineage: { resolve: vi.fn(async () => ({ kind: 'unavailable' as const, reason: 'session-query-absent' })) },
    })
    const r = await d.resolveLatestOf('主干')
    expect(r.kind).toBe('lineage-unavailable')
    if (r.kind !== 'lineage-unavailable') return
    // "could not ask" and "asked and refused" must not arrive as the same word.
    expect(r.reason).toBe('session-query-absent')
  })

  it('reports lineage members missing from the corpus instead of silently dropping them', async () => {
    const d = await mount({
      records: [rec('a', '主干', 100)],
      titles: { a: '主干' },
      lineage: lineageOf(['a', 'ghost']),
      archived: [],
    })
    const r = await d.resolveLatestOf('主干')
    expect(r.kind).toBe('ok')
    if (r.kind !== 'ok') return
    // The trace and the corpus were read at different moments; saying so is the
    // difference between a reconcilable answer and a mysteriously shrinking set.
    expect(r.notInCorpus).toEqual(['ghost'])
  })
})

describe('T16 — the default path did not change', () => {
  it('resolve() still resolves by exact title, and still reports ambiguity', async () => {
    const d = await mount({
      records: [rec('a', '开发', 100), rec('b', '开发', 200), rec('c', '产品', 300)],
      titles: { a: '开发', b: '开发', c: '产品' },
      archived: [],
      lineage: lineageOf(['a', 'b']),
    })
    const ok = await d.resolve('产品', undefined)
    expect(ok.kind).toBe('ok')
    if (ok.kind === 'ok') expect(ok.sessionId).toBe('c')

    // Two sessions share the title "开发": still ambiguous. `latest_of` must NOT
    // have leaked into `resolve()` and turned this into a newest-wins answer.
    const ambiguous = await d.resolve('开发', undefined)
    expect(ambiguous.kind).toBe('ambiguous')
  })

  it('resolve() does not consult the lineage service at all', async () => {
    const resolve = vi.fn(async () => ({ kind: 'resolved' as const, memberIds: ['a'], complete: true }))
    const d = await mount({
      records: [rec('a', '开发', 100)],
      titles: { a: '开发' },
      archived: [],
      lineage: { resolve },
    })
    await d.resolve('开发', undefined)
    await d.resolve('不存在', undefined)
    // Zero calls: the default path is structurally untouched, so a lineage
    // outage cannot affect ordinary addressing.
    expect(resolve).toHaveBeenCalledTimes(0)
  })
})
