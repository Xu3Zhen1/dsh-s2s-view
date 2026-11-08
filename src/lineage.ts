/**
 * Session lineage for the s2s seam (P3 / T15).
 *
 * One question, asked of `sessionQuery.traceSession()`: *given any session, what
 * is its lineage root and who else is in it?* s2s consumes that answer; it never
 * builds a lineage table of its own. `parentSession` (recorded by DSH in the
 * session header) plus the host's trace is the whole source of truth — a second
 * table would be a third truth, which the plan forbids (§3.1).
 *
 * ## Why the host service, not the log
 *
 * `traceSession` is a real, public host capability, not an assumption:
 * `async traceSession(sessionId: SessionId, signal?: AbortSignal):
 * Promise<SessionLineageTrace>`, and the host itself calls it the same way
 * (`const lineage = await this.ctx.sessionQuery.traceSession(source.id)` then
 * iterates `lineage.ancestors`). The trace type is
 * `{ target, ancestors, descendants } & ({ complete: true, root } |
 * { complete: false, unresolvedParentId })` — i.e. the host already models the
 * partial case, and so must we.
 *
 * ## The two-shape return, and why `complete: false` is a first-class result
 *
 * A lineage that could not be traced to its root is **not** an error and **not**
 * an empty lineage: it is a lineage whose upper bound is unknown. Collapsing it
 * into either "resolved" or "no lineage" loses the one fact the caller needs
 * (how far the chain was followed), so `complete` is carried through to the
 * caller instead of being decided here.
 *
 * ## Degradation is observable (G9)
 *
 * `sessionQuery` is an optional dependency — this plugin supports hosts back to
 * `0.1.0-rc.6`, and a missing service is a normal condition, not a fault. But a
 * silent fallback is exactly the failure G9 forbids: a caller that asked a
 * lineage question and got "no lineage" back would never learn that nothing was
 * ever asked. So every degraded answer names its reason, and {@link S2sLineage}
 * exposes {@link S2sLineage.degradedReasons} so the fact can be surfaced rather
 * than swallowed.
 *
 * @module dsh-s2s/lineage
 */
import { Service, type Context } from '@deepseek-ai/cordis'

/** One node of the recursive descendant tree, structurally consumed. */
export interface LineageNodeLike {
  readonly session: LineageRecordLike
  readonly descendants: readonly LineageNodeLike[]
}

/** The record shape s2s actually reads; everything else is host-internal. */
export interface LineageRecordLike {
  readonly header: { readonly id: unknown; readonly createdAt?: unknown; readonly parentSession?: unknown }
  readonly live?: boolean
}

/**
 * The host's `SessionLineageTrace`, restated structurally.
 *
 * Restated rather than imported on purpose: the plugin declares no dependency on
 * the host's internals, and `sessionQuery` is reached structurally everywhere
 * else in this codebase (`discovery.ts` does the same for `listSessions`). The
 * union is preserved so an incomplete trace cannot be misread as complete.
 */
export type LineageTraceLike =
  & {
    readonly target: LineageRecordLike
    readonly ancestors: readonly LineageRecordLike[]
    readonly descendants: readonly LineageNodeLike[]
  }
  & (
    | { readonly complete: true; readonly root: LineageRecordLike }
    | { readonly complete: false; readonly unresolvedParentId: unknown }
  )

/** The host service face used here — one method, capability-probed. */
interface SessionQueryLineageLike {
  traceSession?(sessionId: unknown, signal?: AbortSignal): Promise<LineageTraceLike>
}

/**
 * Why a lineage answer is degraded. Each value is a fact about *this* process,
 * not a synonym for "not found" — the distinction is the whole point of G9.
 */
export type S2sLineageDegradedReason =
  /** No `sessionQuery` service: the host is too old or the service is unmounted. */
  | 'session-query-absent'
  /** The service exists but exposes no `traceSession` (host predates the method). */
  | 'trace-session-absent'
  /** `traceSession` threw. The message is carried separately, not folded in. */
  | 'trace-threw'
  /** The trace came back without a usable target id. */
  | 'trace-malformed'

/** A trace that resolved, whether or not it reached the root. */
export interface S2sLineageResolved {
  readonly kind: 'resolved'
  readonly sessionId: string
  /** Root of the known chain; equals the target when the target has no parent. */
  readonly rootId: string
  /** True when the host followed the chain all the way; false when it stopped. */
  readonly complete: boolean
  /** Set only when `complete === false` — the parent id that could not be resolved. */
  readonly unresolvedParentId?: string
  /** Ancestor ids, root-most first as the host returns them. Never includes the target. */
  readonly ancestorIds: readonly string[]
  /** Every descendant id in the tree, depth-first. Never includes the target. */
  readonly descendantIds: readonly string[]
  /** Target plus all relatives — the ids a `latest_of` scan may choose from. */
  readonly memberIds: readonly string[]
  /** Degraded sub-facts that did not prevent an answer (e.g. an unreadable ancestor id). */
  readonly degradedReasons: readonly S2sLineageDegradedReason[]
}

/** A trace that could not be obtained. Still an answer: it names why. */
export interface S2sLineageUnavailable {
  readonly kind: 'unavailable'
  readonly sessionId: string
  readonly reason: S2sLineageDegradedReason
  /** The thrown message, verbatim, when `reason === 'trace-threw'`. */
  readonly detail?: string
  readonly degradedReasons: readonly S2sLineageDegradedReason[]
}

export type S2sLineageResult = S2sLineageResolved | S2sLineageUnavailable

/** Read a record's id as a string, or `undefined` when it is not a usable id. */
function idOf(record: LineageRecordLike | undefined): string | undefined {
  if (record === undefined || record === null) return undefined
  const id = record.header?.id
  if (id === undefined || id === null) return undefined
  const text = String(id)
  return text.length === 0 ? undefined : text
}

/** Depth-first walk of the descendant tree, tolerant of a missing/stunted branch. */
function collectDescendants(nodes: readonly LineageNodeLike[] | undefined, out: string[]): void {
  if (!Array.isArray(nodes)) return
  for (const node of nodes) {
    const id = idOf(node?.session)
    if (id === undefined) continue
    out.push(id)
    collectDescendants(node?.descendants, out)
  }
}

/**
 * Lineage resolution over the host's `sessionQuery`.
 *
 * Stateless and cheap: one host call per {@link resolve}, no cache. The host
 * already lists its corpus per call, and a lineage that is a few hundred
 * milliseconds stale is not a hazard for addressing — caching here would add a
 * second staleness clock to reason about for no measured gain (T8's TTL was for
 * `reconcile`, whose per-row log reads were the expensive part).
 */
export class S2sLineage extends Service {
  private queryService: SessionQueryLineageLike | undefined
  /** Last degradation, kept for diagnostics so a momentary absence is not lost. */
  private lastDegradedReason: S2sLineageDegradedReason | undefined
  private lastDegradedDetail: string | undefined

  constructor(ctx: Context) {
    super(ctx, 's2sLineage')
    ctx.inject(['sessionQuery'], (sctx) => {
      this.queryService = (sctx as unknown as { sessionQuery: SessionQueryLineageLike }).sessionQuery
    })
  }

  /**
   * The most recent degradation, or `undefined` when nothing has degraded.
   *
   * Exposed so a caller can distinguish "this target genuinely has no lineage"
   * from "the lineage question could not be asked in this process" — the two
   * read identically from {@link resolve} alone if the reason is dropped.
   */
  degraded(): { readonly reason: S2sLineageDegradedReason; readonly detail?: string } | undefined {
    if (this.lastDegradedReason === undefined) return undefined
    return this.lastDegradedDetail === undefined
      ? { reason: this.lastDegradedReason }
      : { reason: this.lastDegradedReason, detail: this.lastDegradedDetail }
  }

  /** Record a degradation once, on the way out, so it is never silent (G9). */
  private degrade(reason: S2sLineageDegradedReason, detail?: string): S2sLineageDegradedReason {
    this.lastDegradedReason = reason
    this.lastDegradedDetail = detail
    const suffix = detail === undefined ? '' : `: ${detail}`
    this.ctx.logger?.warn(`s2s lineage: degraded (${reason})${suffix} — lineage questions will answer "unavailable", not "no lineage"`)
    return reason
  }

  /**
   * Resolve one session's lineage.
   *
   * Never throws: a caller asking "who is in this session's lineage" must be
   * able to act on the answer even when the host cannot provide one, and an
   * exception here would turn an addressing nicety into a delivery failure.
   *
   * @param sessionId - any session id; it need not be live.
   * @param signal - optional cancellation, forwarded to the host.
   */
  async resolve(sessionId: string, signal?: AbortSignal): Promise<S2sLineageResult> {
    const degraded: S2sLineageDegradedReason[] = []
    const self = String(sessionId)

    const service = this.queryService
    if (service === undefined || service === null) {
      const reason = this.degrade('session-query-absent')
      return { kind: 'unavailable', sessionId: self, reason, degradedReasons: [reason] }
    }
    const trace = service.traceSession
    if (typeof trace !== 'function') {
      const reason = this.degrade('trace-session-absent')
      return { kind: 'unavailable', sessionId: self, reason, degradedReasons: [reason] }
    }

    let result: LineageTraceLike
    try {
      result = await trace.call(service, self, signal)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const reason = this.degrade('trace-threw', detail)
      return { kind: 'unavailable', sessionId: self, reason, detail, degradedReasons: [reason] }
    }

    const targetId = idOf(result?.target)
    if (targetId === undefined) {
      const reason = this.degrade('trace-malformed', 'trace carried no usable target id')
      return { kind: 'unavailable', sessionId: self, reason, degradedReasons: [reason] }
    }

    const ancestorIds: string[] = []
    for (const ancestor of Array.isArray(result.ancestors) ? result.ancestors : []) {
      const id = idOf(ancestor)
      if (id === undefined) {
        // An unreadable ancestor is a real gap in the chain: the answer stays
        // usable, but calling it "complete" would overstate how far we got.
        degraded.push('trace-malformed')
        continue
      }
      if (id === targetId) continue
      ancestorIds.push(id)
    }

    const descendantIds: string[] = []
    collectDescendants(result.descendants, descendantIds)
    // A host tree that reports the target among its own descendants would make a
    // `latest_of` scan rank the session it was asked to replace. Drop it from the
    // relative set *before* building `memberIds`, so the target appears exactly
    // once there — and keep `descendantIds` honest by dropping it too, since the
    // only descendant that could equal the target is the target itself.
    const related = new Set<string>()
    for (const id of ancestorIds) related.add(id)
    for (const id of descendantIds) related.add(id)
    related.delete(targetId)
    const descendantsOfTarget = descendantIds.filter(id => id !== targetId)

    // `complete` is only trustworthy when the union actually says which arm it is.
    // The intersection form above cannot narrow on `result.complete` alone, so the
    // arm is selected once, explicitly, and both fields are read from that arm.
    const completeArm = result as { readonly complete?: unknown; readonly root?: LineageRecordLike }
    const declaredComplete = completeArm.complete === true
    const declaredRootId = declaredComplete ? idOf(completeArm.root) : undefined
    const rootId = declaredComplete ? declaredRootId ?? targetId : ancestorIds[0] ?? targetId
    if (declaredComplete && declaredRootId === undefined) degraded.push('trace-malformed')

    const unresolvedParentId = declaredComplete ? undefined : ((): string | undefined => {
      const raw = (result as { unresolvedParentId?: unknown }).unresolvedParentId
      if (raw === undefined || raw === null) {
        // `complete: false` without the parent that stopped us: the partial
        // answer is still the answer, but the reason is now unstated.
        degraded.push('trace-malformed')
        return undefined
      }
      return String(raw)
    })()

    const resolved: S2sLineageResolved = {
      kind: 'resolved',
      sessionId: targetId,
      rootId,
      complete: declaredComplete,
      ancestorIds,
      descendantIds: descendantsOfTarget,
      memberIds: [targetId, ...ancestorIds, ...descendantsOfTarget],
      degradedReasons: degraded,
    }
    if (unresolvedParentId === undefined) return resolved
    return { ...resolved, unresolvedParentId }
  }
}
