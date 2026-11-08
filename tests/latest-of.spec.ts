import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { S2sDiscoveryService } from '../src/discovery.ts'

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
