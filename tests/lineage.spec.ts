import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { S2sLineage } from '../src/lineage.ts'
import type { LineageRecordLike, LineageTraceLike } from '../src/lineage.ts'

/**
 * T15 / P3 — lineage resolution over the host's `sessionQuery.traceSession()`.
 *
 * The plan asks for two branches to be covered by test: `complete: false` and
 * `unresolvedParentId`. They are not two independent facts — the host's type is
 * `{…} & ({complete:true, root} | {complete:false, unresolvedParentId})`, so the
 * second only ever occurs on the first. The cases below are therefore built as
 * *shapes of the union*, and each asserts the field the other arm must **not**
 * carry: a result that reported both would satisfy a naive "did you set it?"
 * check while being impossible on the host side.
 *
 * ★ Why the degraded cases are asserted through `degraded()` **and** the call
 * count, not only through `kind === 'unavailable'`: G9 forbids a silent fallback,
 * and "unavailable" alone is exactly what a silent fallback would also return.
 * The observable trace is what distinguishes "asked and was refused" from
 * "never asked" — the same two-causes-one-reading trap this repo keeps hitting.
 */

/** One corpus record in the shape the host hands back. */
function rec(id: string, parent?: string): LineageRecordLike {
  return parent === undefined
    ? { header: { id }, live: false }
    : { header: { id, parentSession: parent }, live: false }
}

/**
 * Mount the service the way the host does — through `ctx.plugin`.
 *
 * ★ This is not ceremony: `ctx.inject(['sessionQuery'], …)` inside the
 * constructor only runs when cordis *mounts* the plugin. A bare
 * `new S2sLineage(ctx)` leaves `queryService` permanently undefined, and every
 * case then "passes" for the wrong reason — it would be testing the
 * `session-query-absent` branch over and over. The failure mode is invisible
 * because the absent branch is a legitimate answer; hence the mount.
 */
async function mount(service?: unknown): Promise<{ ctx: Context; lineage: S2sLineage; warn: ReturnType<typeof vi.fn> }> {
  const ctx = new Context()
  const warn = vi.fn()
  ctx.logger.warn = warn as never
  if (service !== undefined) ctx.provide('sessionQuery', service as never)
  await ctx.plugin(S2sLineage)
  const lineage = ctx.get('s2sLineage') as S2sLineage
  return { ctx, lineage, warn }
}

describe('S2sLineage.resolve — complete lineage', () => {
  it('reports the root, the ancestor chain and the recursive descendants', async () => {
    const trace: LineageTraceLike = {
      target: rec('b', 'a'),
      ancestors: [rec('a')],
      descendants: [
        { session: rec('c', 'b'), descendants: [{ session: rec('d', 'c'), descendants: [] }] },
      ],
      complete: true,
      root: rec('a'),
    }
    const traceSession = vi.fn(async () => trace)
    const { lineage } = await mount({ traceSession })

    const result = await lineage.resolve('b')

    expect(result.kind).toBe('resolved')
    if (result.kind !== 'resolved') return
    expect(result.complete).toBe(true)
    expect(result.rootId).toBe('a')
    expect(result.ancestorIds).toEqual(['a'])
    // Depth-first, and the grandchild proves the walk recurses rather than
    // stopping at one level — a single-level walk would still pass a "c is in
    // there" check, so the assertion names `d` specifically.
    expect(result.descendantIds).toEqual(['c', 'd'])
    expect(result.memberIds).toEqual(['b', 'a', 'c', 'd'])
    // The complete arm carries no `unresolvedParentId`; reporting one would be a
    // state the host's union cannot produce.
    expect('unresolvedParentId' in result).toBe(false)
    expect(result.degradedReasons).toEqual([])
    expect(traceSession).toHaveBeenCalledTimes(1)
  })

  it('treats a parentless session as its own root', async () => {
    const trace: LineageTraceLike = {
      target: rec('solo'),
      ancestors: [],
      descendants: [],
      complete: true,
      root: rec('solo'),
    }
    const { lineage } = await mount({ traceSession: vi.fn(async () => trace) })
    const result = await lineage.resolve('solo')

    expect(result.kind).toBe('resolved')
    if (result.kind !== 'resolved') return
    expect(result.rootId).toBe('solo')
    expect(result.ancestorIds).toEqual([])
    expect(result.memberIds).toEqual(['solo'])
  })
})

describe('S2sLineage.resolve — incomplete lineage (the plan\'s two branches)', () => {
  it('carries complete:false together with the parent that could not be resolved', async () => {
    const trace: LineageTraceLike = {
      target: rec('b', 'missing'),
      ancestors: [], // the host stopped immediately: the first parent is unresolvable
      descendants: [],
      complete: false,
      unresolvedParentId: 'missing',
    }
    const { lineage } = await mount({ traceSession: vi.fn(async () => trace) })
    const result = await lineage.resolve('b')

    expect(result.kind).toBe('resolved')
    if (result.kind !== 'resolved') return
    expect(result.complete).toBe(false)
    expect(result.unresolvedParentId).toBe('missing')
    // `rootId` must not claim a root it never reached: with no ancestors the
    // honest answer is the target itself, not a fabricated ancestor.
    expect(result.rootId).toBe('b')
    // A partial trace is still usable and must NOT be flagged as degraded — it is
    // an answer, not a failure. Folding the two together would make "could not
    // trace to the root" indistinguishable from "could not ask".
    expect(result.degradedReasons).toEqual([])
  })

  it('keeps the ancestors it did reach when the chain stops partway', async () => {
    const trace: LineageTraceLike = {
      target: rec('c', 'b'),
      ancestors: [rec('b', 'gone')],
      descendants: [],
      complete: false,
      unresolvedParentId: 'gone',
    }
    const { lineage } = await mount({ traceSession: vi.fn(async () => trace) })
    const result = await lineage.resolve('c')

    expect(result.kind).toBe('resolved')
    if (result.kind !== 'resolved') return
    expect(result.complete).toBe(false)
    expect(result.unresolvedParentId).toBe('gone')
    // The reached ancestor is retained; the root is the deepest one known.
    expect(result.ancestorIds).toEqual(['b'])
    expect(result.rootId).toBe('b')
  })

  it('flags a partial trace that omits the stopping parent, rather than inventing one', async () => {
    // A host-side bug shape: `complete:false` with no `unresolvedParentId`.
    // The answer stays usable, but the *reason* is now unstated, which is a
    // degradation even though the trace itself returned.
    const trace = {
      target: rec('b'),
      ancestors: [],
      descendants: [],
      complete: false,
    } as unknown as LineageTraceLike
    const { lineage } = await mount({ traceSession: vi.fn(async () => trace) })
    const result = await lineage.resolve('b')

    expect(result.kind).toBe('resolved')
    if (result.kind !== 'resolved') return
    expect(result.complete).toBe(false)
    expect('unresolvedParentId' in result).toBe(false)
    expect(result.degradedReasons).toContain('trace-malformed')
  })
})

describe('S2sLineage.resolve — degraded paths are observable (G9)', () => {
  it('reports session-query-absent when the host provides no service', async () => {
    // No `provide` call at all: this is the rc.6-era host, not a fault.
    const { lineage, warn } = await mount()

    const result = await lineage.resolve('x')

    expect(result.kind).toBe('unavailable')
    if (result.kind !== 'unavailable') return
    expect(result.reason).toBe('session-query-absent')
    // The trace names its own cause — the receipt must not have to guess.
    expect(result.degradedReasons).toEqual(['session-query-absent'])
    expect(lineage.degraded()).toEqual({ reason: 'session-query-absent' })
    // ★ The observable half: a silent fallback would return the same `kind`
    // without ever writing anything. Asserting the warn fired is what separates
    // "degraded and said so" from "degraded and pretended".
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('session-query-absent')
  })

  it('reports trace-session-absent when the service predates the method', async () => {
    const { lineage, warn } = await mount({ listSessions: vi.fn(async () => []) })
    const result = await lineage.resolve('x')

    expect(result.kind).toBe('unavailable')
    if (result.kind !== 'unavailable') return
    expect(result.reason).toBe('trace-session-absent')
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('carries the thrown message verbatim instead of collapsing it', async () => {
    const thrown = new Error('corpus resolution failed')
    const { lineage, warn } = await mount({ traceSession: vi.fn(async () => { throw thrown }) })
    const result = await lineage.resolve('x')

    expect(result.kind).toBe('unavailable')
    if (result.kind !== 'unavailable') return
    expect(result.reason).toBe('trace-threw')
    expect(result.detail).toBe('corpus resolution failed')
    // Two distinct failures must not read alike: the thrown text survives in
    // `degraded()` too, so a caller inspecting state sees the real reason.
    expect(warn.mock.calls[0]?.[0]).toContain('corpus resolution failed')
  })

  it('reports trace-malformed when the trace carries no usable target id', async () => {
    const trace = {
      target: { header: {} },
      ancestors: [],
      descendants: [],
      complete: true,
      root: { header: { id: 'a' } },
    } as unknown as LineageTraceLike
    const { lineage } = await mount({ traceSession: vi.fn(async () => trace) })
    const result = await lineage.resolve('x')

    expect(result.kind).toBe('unavailable')
    if (result.kind !== 'unavailable') return
    expect(result.reason).toBe('trace-malformed')
  })

  it('never throws, even when the host throws a non-Error', async () => {
    // `resolve` must not turn an addressing nicety into a delivery failure: an
    // escaped exception here would abort a send that could have proceeded.
    const { lineage } = await mount({ traceSession: vi.fn(async () => { throw 'plain string' }) })
    const result = await lineage.resolve('x')

    expect(result.kind).toBe('unavailable')
    if (result.kind !== 'unavailable') return
    expect(result.reason).toBe('trace-threw')
    expect(result.detail).toBe('plain string')
  })
})

describe('S2sLineage — invariants that keep the answer usable for addressing', () => {
  it('never lists the target among its own relatives', async () => {
    // Defence against a host tree that reports the target as its own descendant
    // (or an ancestor list that echoes it): either would make a `latest_of` scan
    // pick the session it was asked to replace.
    const trace: LineageTraceLike = {
      target: rec('self'),
      ancestors: [rec('self')],
      descendants: [{ session: rec('self'), descendants: [] }],
      complete: true,
      root: rec('self'),
    }
    const { lineage } = await mount({ traceSession: vi.fn(async () => trace) })
    const result = await lineage.resolve('self')

    expect(result.kind).toBe('resolved')
    if (result.kind !== 'resolved') return
    expect(result.ancestorIds).toEqual([])
    // The target is dropped from the relative list outright, not merely from
    // `memberIds`: `descendantIds` is consumed on its own by callers that walk
    // the tree, so leaving `self` there would hand them a cycle.
    expect(result.descendantIds).toEqual([])
    // `memberIds` is what `latest_of` will scan, and it must contain the target
    // exactly once — no duplicate that would double-count it in a ranking.
    expect(result.memberIds).toEqual(['self'])
    expect(result.memberIds.filter(id => id === 'self')).toHaveLength(1)
  })

  it('forwards the abort signal to the host', async () => {
    // Cancellation must reach the host, or a wide `latest_of` scan cannot be
    // bounded by the caller's own deadline.
    const traceSession = vi.fn(async (_id: unknown, _signal?: AbortSignal) => ({
      target: rec('a'),
      ancestors: [],
      descendants: [],
      complete: true,
      root: rec('a'),
    }) as LineageTraceLike)
    const { lineage } = await mount({ traceSession })
    const controller = new AbortController()

    await lineage.resolve('a', controller.signal)

    expect(traceSession.mock.calls[0]?.[1]).toBe(controller.signal)
  })

  it('tolerates a missing descendants array without losing the answer', async () => {
    const trace = {
      target: rec('a'),
      ancestors: [],
      complete: true,
      root: rec('a'),
    } as unknown as LineageTraceLike
    const { lineage } = await mount({ traceSession: vi.fn(async () => trace) })
    const result = await lineage.resolve('a')

    expect(result.kind).toBe('resolved')
    if (result.kind !== 'resolved') return
    expect(result.descendantIds).toEqual([])
    expect(result.memberIds).toEqual(['a'])
  })
})
