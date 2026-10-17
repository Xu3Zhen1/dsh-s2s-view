/**
 * Model-facing s2s tools: peers (live), sessions (all w/ titles), message
 * (send / wake), resume (explicit wake), history (durable, multi-source),
 * status (self-report), reconcile (advance tracked rows against a log).
 * @module dsh-s2s/tools
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { S2sBroker } from './broker.ts'
import type { S2sDiscoveryService, S2sResolveResult, S2sSessionInfo } from './discovery.ts'
import { S2sLifecycleService } from './lifecycle.ts'
import type { S2sBudget, S2sThreadEntry } from './budget.ts'
import type { S2sScheduleService } from './schedule.ts'
import { noteLedger, type S2sLedger } from './ledger.ts'
import { S2sError, type S2sErrorCode } from './error.ts'
import type { S2sArchiveFilterState, S2sTargetClass } from './discovery.ts'
import { readHistory } from './history.ts'
import { ledgerDiagnostics, readSelfCheckSkipped, recordFirstS2sToolCall, recordProbe, recordSelfCheckSkipped, recordSelfRefusalCancelFailure } from './ledger-diagnostics.ts'

function textRender(_args: object, value: { text: string }): ContentBlock[] {
  return [{ type: 'text', text: value.text }]
}

const OUTPUT = {
  schema: { type: 'object' as const, additionalProperties: false as const, properties: { text: { type: 'string' as const, required: true as const } } },
  render: textRender,
}

function labelOf(r: Extract<S2sResolveResult, { kind: 'ok' }>): string {
  return r.title ?? r.sessionId
}

/**
 * How a resolution found its target, rendered for the receipt.
 *
 * The ruling requires the receipt to distinguish these: two of them are
 * fallbacks, and a caller that asked for an exact title must be able to tell
 * whether it got the exact session or an approximation. Returns `''` for an
 * exact hit so the common case stays uncluttered, and an explicit phrase
 * otherwise.
 *
 * @param r - a successful resolution.
 */
function matchNoteOf(r: Extract<S2sResolveResult, { kind: 'ok' }>): string {
  if (r.matchedBy === 'title-prefix') {
    return ' [matched by TITLE PREFIX, not exact — actual title: "' + (r.title ?? '(untitled)') + '"]'
  }
  if (r.matchedBy === 'id-prefix') {
    return ' [matched by ID PREFIX — full id: ' + r.sessionId + ']'
  }
  return ''
}

/**
 * Short display form of a session id.
 *
 * A real session id is the full `session-<uuid>` string — that exact form is
 * what `ctx.agents.get(SessionId(...))`, the mailbox path, and
 * `registry.resume({ resumeSessionId })` all require, so it is never rewritten.
 * For display we drop the `session-` container prefix first: slicing the raw
 * string would show `session-` for every titled session (the uuid starts at
 * offset 8), which is what a display bug looked like.
 *
 * @param sessionId - the canonical, prefixed session id.
 * @returns the first 8 characters of the uuid part.
 */
function shortId(sessionId: string): string {
  return sessionId.replace(/^session-/, '').slice(0, 8)
}

function describeCandidates(cands: { title?: string; sessionId: string; state: string; workspaceDir: string }[]): string[] {
  return cands.map(function(c) { return '- ' + (c.title ?? '(untitled)') + ' [' + shortId(c.sessionId) + '] ' + c.state + ' ws=' + c.workspaceDir })
}

function displayResolve(resolved: Extract<S2sResolveResult, { kind: 'not-found' | 'ambiguous' }>): string {
  if (resolved.kind === 'not-found') {
    const lines = resolved.candidates.length === 0 ? ['No sessions match.'] : describeCandidates(resolved.candidates)
    // Item ⑤: never print the whole corpus. Say how much was left out so the
    // reader knows the list is a suggestion, not the complete set — a truncated
    // list presented as complete is its own kind of overclaim.
    const hidden = (resolved.totalCandidates ?? resolved.candidates.length) - resolved.candidates.length
    if (hidden > 0) lines.push('… and ' + hidden + ' more (use s2s_sessions to list all)')
    return 'No session named "' + resolved.name + '" (a rename becomes visible after the next title checkpoint; list actual names with s2s_sessions). Names must match EXACTLY or be a unique TITLE PREFIX.\n' + lines.join('\n')
  }
  return 'Multiple sessions named "' + resolved.name + '". Disambiguate with session_id:\n' + resolved.candidates.map(function(c) { return '- ' + c.sessionId + ' (' + c.workspaceDir + ')' }).join('\n')
}

function buildThread(broker: S2sBroker, from: string, to: string): S2sThreadEntry[] {
  const records = [
    ...broker.history(to).filter((r) => r.from === from),
    ...broker.history(from).filter((r) => r.from === to),
  ]
  return records.sort((a, b) => a.createdAt - b.createdAt).map((r) => ({ from: r.from, text: r.text, at: r.createdAt }))
}

function modelOf(exec: unknown): { provider?: string; model?: string; reasoningEffort?: string } | undefined {
  const agent = (exec as { agent?: { session?: { requestHeader?: () => { config?: { provider?: string; model?: string; reasoningEffort?: string } } } } } | undefined)?.agent
  const cfg = agent?.session?.requestHeader?.()?.config
  if (cfg === undefined) return undefined
  return {
    ...(cfg.provider === undefined ? {} : { provider: cfg.provider }),
    ...(cfg.model === undefined ? {} : { model: cfg.model }),
    ...(cfg.reasoningEffort === undefined ? {} : { reasoningEffort: cfg.reasoningEffort }),
  }
}

function sameProjectAsCaller(infos: readonly S2sSessionInfo[], exec: unknown): readonly S2sSessionInfo[] {
  const callerId = (exec as { agent?: { id?: string } } | undefined)?.agent?.id
  if (callerId === undefined) return infos
  const caller = infos.find((info) => info.sessionId === callerId)
  if (caller === undefined) return infos
  return infos.filter((info) => info.workspaceDir === caller.workspaceDir)
}

/**
 * Normalized session id for self-target comparison (T29).
 *
 * The canonical id is `session-<uuid>`; callers may pass the bare uuid or the
 * short form shown by listings. Self-ness must be judged on the normalized
 * pair so none of those spellings sneaks past the guard.
 */
function normalizedSessionId(value: string): string {
  return value.trim().toLowerCase().replace(/^session-/, '')
}

/**
 * The caller id the self-target check must judge on, or `undefined` when the
 * host provided none. `undefined`, empty and whitespace-only are all "identity
 * unavailable" — a blank string is not an identity (T29 review).
 */
function realCallerId(exec: unknown): string | undefined {
  const raw = (exec as { agent?: { id?: string } } | undefined)?.agent?.id
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/**
 * Is the resolved target the calling session itself? (T29)
 *
 * Judged against the **real** caller id from the execution context — never the
 * model-writable `args.from`. The comparison is exact on normalized ids, which
 * covers canonical, bare-uuid and case variants; a *unique* short-prefix self
 * reference is covered too, because by then `resolve()` has already expanded the
 * prefix to the one full id it can only be.
 *
 * @returns true when the target is provably the caller's own session.
 */
function isSelfTarget(exec: unknown, resolvedSessionId: string): boolean {
  const callerId = realCallerId(exec)
  if (callerId === undefined) return false
  return normalizedSessionId(callerId) === normalizedSessionId(resolvedSessionId)
}

/**
 * Whether the self-target check actually ran (T29).
 *
 * The ruling forbids two silent failure modes when the host gives no caller id:
 * reading `args.from` as "not self" (it is model-writable), and claiming
 * protection that never executed. The chosen fail-open is therefore explicit:
 * the send proceeds — it cannot be PROVEN to be self — and the receipt carries a
 * fixed marker so the skipped check is greppable in every transcript.
 */
function selfCheckNote(exec: unknown): string {
  return realCallerId(exec) === undefined
    ? ' [s2s] caller identity unavailable — self-target check skipped (args.from is not trusted as identity).'
    : ''
}

/**
 * The T30 target-policy gate (ruling 2026-10-17 §3).
 *
 * Runs on a resolved `ok` target BEFORE any record/queue/deliver/resume, and —
 * per the ruling — AGAIN after the async budget, immediately before the actual
 * handover, to narrow the archive-state race. The class is RECOMPUTED on every
 * invocation from the fresh registry reading (`resolved.targetClass` is only a
 * snapshot taken at resolve time).
 *
 * Fail-closed on an unavailable policy: unlike the T29 caller-identity
 * fail-open (explicitly approved for that single case), the ruling does NOT
 * extend compatibility to archive policy — when the registry cannot answer,
 * the delivery is refused with `S2S_TARGET_POLICY_UNAVAILABLE` and the precise
 * reason, because refusing is the only state that cannot be a silent
 * mis-delivery to an archived session.
 *
 * @returns `undefined` when the target is eligible; otherwise the refusal text
 *   prefixed with the stable code.
 */
/**
 * Read the filter state defensively: a discovery without the T30 methods (test
 * stubs, older builds) reports unavailable — the fail-closed answer — rather
 * than throwing. Real services always carry the methods (class members).
 */
function safeFilterState(discovery: S2sDiscoveryService): S2sArchiveFilterState {
  try {
    if (typeof discovery.archivedFilterState !== 'function') return { state: 'unavailable', reason: 'registry-absent' }
    return discovery.archivedFilterState()
  } catch {
    return { state: 'unavailable', reason: 'registry-read-failed' }
  }
}

/**
 * Classify defensively: a discovery without the T30 method (test stubs, older
 * builds) yields `unknown` — the fail-closed answer — rather than throwing.
 * Real services always carry the method (a class member).
 */
function safeClassify(discovery: S2sDiscoveryService, filter: S2sArchiveFilterState): (info: { sessionId: string; origin?: string }) => S2sTargetClass {
  return (info) => {
    try {
      if (typeof discovery.classifyTarget !== 'function') return 'unknown'
      return discovery.classifyTarget(info.sessionId, info.origin, filter.state === 'available' ? filter.ids : undefined)
    } catch {
      return 'unknown'
    }
  }
}

/**
 * The T30 target-policy verdict (ruling 2026-10-17 §3), returned STRUCTURED.
 *
 * The refusal is `{code, message}` — the caller throws the `S2sError` itself.
 * Deriving the code from `message.startsWith` is forbidden by `error.ts`
 * ("route on code, never parsing message") and produced a second copy of every
 * code at the throw sites in the first version; that is exactly the defect this
 * shape removes.
 *
 * `recorded` distinguishes the two gate positions. It must be the REAL
 * `noteLedger` return — "the call did not throw" is not evidence a row exists.
 * The verdict text NEVER claims the cancellation already succeeded: whether the
 * row was actually cancelled is proven separately by the caller, from the
 * structured `ledger.cancel` result, and rendered as an explicit
 * `[cancel outcome: …]` suffix.
 */
function targetPolicyVerdict(resolved: Extract<S2sResolveResult, { kind: 'ok' }>, filter: S2sArchiveFilterState, classify: (info: { sessionId: string; origin?: string; headerUnproven?: boolean }) => S2sTargetClass, recorded: boolean): { code: S2sErrorCode; message: string } | undefined {
  const queueNote = recorded
    ? ' A queued row exists for this message; its cancellation outcome is reported separately.'
    : ' No message was recorded, queued, delivered, or woken.'
  if (filter.state === 'unavailable') {
    return {
      code: 'S2S_TARGET_POLICY_UNAVAILABLE',
      message: 'Refused: the target-legality filter could not answer (' + filter.reason + '), so this delivery cannot be proven legitimate.' + queueNote,
    }
  }
  const cls = classify({ sessionId: resolved.sessionId, ...(resolved.origin === undefined ? {} : { origin: resolved.origin }), ...(resolved as { headerUnproven?: true }).headerUnproven === true ? { headerUnproven: true } : {} })
  if (cls === 'archived') {
    return {
      code: 'S2S_ARCHIVED_TARGET',
      message: 'Refused: "' + labelOf(resolved) + '" is an archived session. Archived sessions are not delivery targets; unarchive it first if it must receive messages.' + queueNote,
    }
  }
  if (cls === 'subagent') {
    return {
      code: 'S2S_SUBAGENT_TARGET',
      message: 'Refused: "' + labelOf(resolved) + '" is a subagent session (origin=subagent). Subagents are not independent conversation targets.' + queueNote,
    }
  }
  if (cls === 'unknown') {
    // NOT a subagent code: an unproven/unrecognized identity is a policy-
    // availability fact, and the ruling requires the specific reason.
    return {
      code: 'S2S_TARGET_POLICY_UNAVAILABLE',
      message: 'Refused: "' + labelOf(resolved) + '" has no provable session identity (header unreadable or unrecognized origin'
        + ((resolved as { headerUnproven?: true }).headerUnproven === true ? ' — no trusted session header could be read' : '')
        + '), so the target policy cannot classify it as an ordinary peer.' + queueNote,
    }
  }
  return undefined
}

export function buildTools(deps: { ctx: Context; broker: S2sBroker; discovery: S2sDiscoveryService; lifecycle?: S2sLifecycleService; budget?: S2sBudget; schedule?: S2sScheduleService; ledger?: S2sLedger }): ToolDefinition[] {
  const ctx = deps.ctx
  const broker = deps.broker, discovery = deps.discovery, lifecycle = deps.lifecycle, budget = deps.budget, schedule = deps.schedule, ledger = deps.ledger
  const resolve = async function(name: string | undefined, sessionId: string | undefined): Promise<S2sResolveResult | { kind: 'err'; reason: string }> {
    if ((name === undefined || name.length === 0) && (sessionId === undefined || sessionId.length === 0)) {
      return { kind: 'err', reason: 'Provide a name (the session title) or a session_id.' }
    }
    return discovery.resolve(name, sessionId)
  }
  /**
   * T30 discovery filtering (shared by s2s_peers / s2s_sessions / s2s_digest).
   *
   * Default: excluded targets are dropped. With `include_*` the excluded rows
   * stay but are explicitly tagged, so a look-back can never read as a list of
   * ordinary peers. The filter capability state is always rendered when it is
   * not `available` — the ruling forbids packaging an unfiltered list as a
   * legal delivery roster.
   */
  const applyTargetPolicyToList = function(infos: readonly S2sSessionInfo[], args: { include_archived?: boolean; include_subagents?: boolean }): { rows: Array<{ line: string; info: S2sSessionInfo }>; note: string } {
    const filter = safeFilterState(discovery)
    const note = filter.state === 'unavailable'
      ? ' [archiveFilter: unavailable (' + filter.reason + ') — archived status unknown; this list is NOT a legal delivery roster]'
      : ''
    const eligible: Array<{ line: string; info: S2sSessionInfo }> = []
    const tagged: Array<{ line: string; info: S2sSessionInfo }> = []
    for (const s of infos) {
      const cls = discovery.classifyTarget(s.sessionId, s.origin, filter.state === 'available' ? filter.ids : undefined)
      const line = (s.title ?? '(untitled)') + '  [' + shortId(s.sessionId) + ']  ' + s.state + (cls === 'archived' ? '  [archived]' : cls === 'subagent' ? '  [subagent]' : cls === 'unknown' ? '  [origin-unknown]' : '')
      const row = { line, info: s }
      if (cls === 'eligible') eligible.push(row)
      else if (cls === 'archived' && args.include_archived === true) tagged.push(row)
      else if (cls === 'subagent' && args.include_subagents === true) tagged.push(row)
      else if (cls === 'unknown') tagged.push(row)
    }
    return { rows: [...eligible, ...tagged], note }
  }
  return [
    defineTool({
      name: 's2s_peers',
      description: 'List live sessions in the current project (all=true lists every project) with title (name) and state. Use the title in s2s_message / s2s_resume.',
      parameters: {
        all: { type: 'boolean', description: 'List sessions across all projects (default: current project only).' },
        include_archived: { type: 'boolean', description: 'Also list archived sessions, explicitly tagged [archived]. Audit only — not delivery permission.' },
        include_subagents: { type: 'boolean', description: 'Also list subagent sessions, explicitly tagged [subagent]. Audit only — not delivery permission.' },
      },
      output: OUTPUT,
      execute: async function(args, exec) {
        const infos = await discovery.list()
        const scoped = args.all === true ? infos : sameProjectAsCaller(infos, exec)
        const live = scoped.filter(function(s) { return s.state !== 'dormant' })
        const { rows, note } = applyTargetPolicyToList(live, args)
        if (rows.length === 0) return { text: 'No live sessions.' + note }
        return { text: rows.map(function(r) { return r.line }).join('\n') + note }
      },
    }),
    defineTool({
      name: 's2s_sessions',
      description: 'List known sessions in the current project (all=true lists every project) with lifecycle state (live-idle/live-busy/dormant). Show title, short id, state. Use the title as the addr in s2s_message / s2s_resume.',
      parameters: {
        all: { type: 'boolean', description: 'List sessions across all projects (default: current project only).' },
        query: { type: 'string', description: 'Optional substring filter over session title, session id, or workspace directory name.' },
        include_archived: { type: 'boolean', description: 'Also list archived sessions, explicitly tagged [archived]. Audit only — not delivery permission.' },
        include_subagents: { type: 'boolean', description: 'Also list subagent sessions, explicitly tagged [subagent]. Audit only — not delivery permission.' },
      },
      output: OUTPUT,
      execute: async function(args, exec) {
        const allInfos = await discovery.list()
        const scoped = args.all === true ? allInfos : sameProjectAsCaller(allInfos, exec)
        const sessions = (args.query === undefined || args.query.length === 0)
          ? scoped
          : scoped.filter(function(s) { const needle = (args.query as string).toLowerCase(); return (s.title ?? '').toLowerCase().includes(needle) || s.sessionId.toLowerCase().includes(needle) || s.workspaceDir.toLowerCase().includes(needle) })
        const { rows, note } = applyTargetPolicyToList(sessions, args)
        if (rows.length === 0) return { text: 'No sessions found.' + note }
        return { text: rows.map(function(r) { const s = r.info; return r.line + '  ws=' + s.workspaceDir + (s.lastActivity === undefined ? '' : '  last=' + new Date(s.lastActivity).toISOString()) }).join('\n') + note }
      },
    }),
    defineTool({
      name: 's2s_message',
      description: 'Send a message to a session by its NAME (title, refreshed live) or session_id. Delivers immediately to a live session; to a dormant one it queues and, when lifecycle autoResume=allow, also resumes.',
      parameters: {
        name: { type: 'string', description: 'Target session title (from s2s_sessions). Primary addressing.' },
        session_id: { type: 'string', description: 'Fallback exact session id (when a name is ambiguous).' },
        text: { type: 'string', required: true, description: 'Message text.' },
        reply_to: { type: 'string', description: 'Optional context label for the receiver.' },
        from: { type: 'string', description: 'Optional sender label (defaults to your agent id).' },
      },
      output: OUTPUT,
      // T29 (review must-fix 2): the self refusal is a real `S2sError` thrown by
      // the body; this wrapper renders domain errors into the receipt so the
      // machine-routable `code` exists on the thrown object AND the caller sees a
      // stable text form. Route on `code`, never on the message.
      execute: async function(args, exec) {
        try {
          return await (async function(): Promise<{ text: string }> {
            const resolved = await resolve(args.name, args.session_id)
            if (resolved.kind === 'err') return { text: resolved.reason }
            if (resolved.kind !== 'ok') return { text: displayResolve(resolved) }
            // T29: a session must not message itself. Judged against the REAL caller
            // id (`exec.agent.id`), never `args.from`, which the model can fill with
            // anything. This runs after resolution but BEFORE any record, budget
            // count, queue entry, delivery or wake — a refused self-send must leave
            // no trace at all. The receipt suggests `s2s_schedule`, the supported way
            // to give one's own session a later step.
            if (isSelfTarget(exec, resolved.sessionId)) {
              throw new S2sError(
                'Refused: "' + labelOf(resolved) + '" is the calling session itself (caller id ' + String(exec.agent?.id) + '). A session cannot send an s2s message to itself. To schedule a later step for your own session, use s2s_schedule.',
                'S2S_SELF_TARGET',
              )
            }
            // T30 pre-check: ONE shared verdict — the identity comes from the
            // resolved record (origin + provenance) and the registry snapshot is
            // taken once inside it. `recorded=false`: nothing is on the ledger.
            const verdict = discovery.targetPolicyVerdict(resolved)
            if (verdict !== undefined) throw new S2sError(verdict.message, verdict.code)
            const from = args.from ?? String(exec.agent?.id ?? 'unknown')
            const msgId = 'm-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
            // Item ①/④: a fallback match must be visible on the receipt, and this is
            // the receipt where it matters most — delivering to a session chosen by
            // prefix is exactly where an unstated approximation would be harmful.
            const matchNote = matchNoteOf(resolved)
            // T29 observability: if the host gave no caller id, the self check could
            // not run — say so on the receipt AND in the bounded process-level
            // diagnostics, so a budget/queue/delivery throw cannot erase the fact
            // that an unchecked send proceeded (review: the error path must keep
            // the skipped evidence; the exception itself is re-thrown unchanged).
            const callerNote = selfCheckNote(exec)
            if (callerNote.length > 0) recordSelfCheckSkipped('s2s_message', resolved.sessionId)
            // Record before delivering: the row must exist for the delivery to
            // advance it, and a message that is lost mid-flight is exactly the one a
            // status query later needs to find. The return is the REAL recorded
            // flag for the post-budget refusal (T30: "a row exists" must be proven).
            const recorded = await noteLedger(ledger, 'record', function() {
              return ledger!.record({ msgId: msgId, from: from, to: args.name ?? args.session_id ?? resolved.sessionId, text: args.text, ...(args.reply_to === undefined ? {} : { replyTo: args.reply_to }) })
            })
            let warn: string | undefined
            if (budget !== undefined) {
              // hop is 0 by design here: `maxHops` currently bounds only *forwarded*
              // chains (messages carrying a hop count), not direct sends — the
              // judgment is `hop >= maxHops`, so a direct send at hop 0 never trips
              // it. For direct sends the active budget protections are the per-pair
              // rate limit and (when configured) the semantic judge. Do not change
              // this to hop=1 without a separate ruling: it would alter budget
              // behavior, not just docs (T29 scope).
              const result = await budget.check(from, resolved.sessionId, 0, buildThread(broker, from, resolved.sessionId), modelOf(exec))
              if (result?.verdict === 'warn') warn = result.reason
            }
            // T30 post-budget re-check: the archive state may have flipped while
            // the budget ran. The shared verdict re-reads the registry ONCE
            // inside itself, and the resolved record carries the identity
            // (origin + provenance) — so this classifies exactly as the
            // pre-check did. `recorded` is the real noteLedger return.
            const rerefusal = discovery.targetPolicyVerdict(resolved)
            if (rerefusal !== undefined) {
              // The cancel result is OBSERVABLE either way (ruling: cancel 失败
              // 不得被吞). `ledger.cancel` returns a STRUCTURED outcome — "did
              // not throw" proves nothing (the row may be missing, handed off,
              // terminal, or the CAS may have lost). Only `cancelled` counts as
              // a cancellation; everything else is reported as not-cancelled,
              // and the message is NEVER handed over regardless.
              let cancelOutcome = 'cancel-unavailable'
              if (ledger !== undefined && ledger.isOpen) {
                try {
                  const result = await ledger.cancel(msgId, rerefusal.message)
                  if (result.outcome === 'cancelled') cancelOutcome = 'cancelled'
                  else cancelOutcome = 'not-cancelled (' + result.outcome + (result.outcome === 'not-cancellable' ? ': ' + result.status : '') + ')'
                } catch (error) {
                  cancelOutcome = 'cancel-failed'
                  recordSelfRefusalCancelFailure({ msgId, at: Date.now(), error: String(error) })
                }
              } else {
                recordSelfRefusalCancelFailure({ msgId, at: Date.now(), error: 'ledger not open — queued row could NOT be cancelled' })
              }
              throw new S2sError(rerefusal.message + ' [cancel outcome: ' + cancelOutcome + ']', rerefusal.code)
            }
            if (resolved.state !== 'dormant') {
              const state = broker.deliver(resolved.sessionId, { from: from, text: args.text, msgId: msgId, ...(args.reply_to === undefined ? {} : { replyTo: args.reply_to }) })
              // `absent` means no live agent was there after all — the message was
              // handed to nobody, so the ledger must keep it `queued`. Marking it
              // `inboxed` on `absent` would report an acceptance that never happened,
              // which is exactly the overclaiming invariant I1 forbids.
              if (state !== 'absent') {
                await noteLedger(ledger, 'markInboxed', function() { return ledger!.markInboxed(msgId, resolved.sessionId) })
              }
              // T9: the wording must not outrun the fact. `broker.deliver` returning
              // a state means the message was handed to the live agent — it is NOT
              // evidence the target's log now contains it, which is the only sense of
              // "delivered" this project accepts (I1). The old line printed an
              // unqualified `Delivered to …` even on the `absent` branch, i.e. for a
              // message that reached nobody. Three outcomes now read differently.
              if (state === 'absent') {
                return { text: 'NOT delivered: "' + labelOf(resolved) + '" resolved but had no live agent (broker state=absent), so the message reached nobody (left queued).' + callerNote + (warn === undefined ? '' : '\n[s2s-budget] ' + warn) }
              }
              const how = state === 'idle' ? 'as a follow-up turn' : 'by context injection (the target was mid-turn)'
              return { text: 'Handed to "' + labelOf(resolved) + '"' + matchNote + ' ' + how + ' — state=' + state + '. This means the agent accepted it, NOT that it is in the target\'s log yet; that is what s2s_reconcile (or s2s_history) confirms.' + callerNote + (warn === undefined ? '' : '\n[s2s-budget] ' + warn) }
            }
            if (lifecycle === undefined) return { text: '"' + labelOf(resolved) + '" is dormant and no lifecycle is configured; use s2s_resume with autoResume=allow to wake it.' + callerNote }
            const outcome = await lifecycle.queueForDormant({ sessionId: resolved.sessionId, from: from, text: args.text, msgId: msgId, ...(args.reply_to === undefined ? {} : { replyTo: args.reply_to }) })
            if (outcome === 'refused') {
              // The lifecycle's LAST-moment gate (just before registry.resume)
              // refused — the target's legality flipped inside the async
              // setup/resume window. The message stays in the mailbox (the
              // user's queue); the recorded row must be explicitly cancelled —
              // using the SAME shared verdict and ONLY its structured cancel
              // result (review blocker 3: "the call did not throw" proves
              // nothing).
              const refusal = discovery.targetPolicyVerdict(resolved)
              const code = refusal?.code ?? 'S2S_TARGET_POLICY_UNAVAILABLE'
              const message = refusal?.message ?? 'Refused at the handover point by the target policy.'
              let cancelOutcome = 'cancel-unavailable'
              if (ledger !== undefined && ledger.isOpen) {
                try {
                  const result = await ledger.cancel(msgId, message)
                  if (result.outcome === 'cancelled') cancelOutcome = 'cancelled'
                  else cancelOutcome = 'not-cancelled (' + result.outcome + (result.outcome === 'not-cancellable' ? ': ' + result.status : '') + ')'
                } catch (error) {
                  cancelOutcome = 'cancel-failed'
                  recordSelfRefusalCancelFailure({ msgId, at: Date.now(), error: String(error) })
                }
              } else {
                recordSelfRefusalCancelFailure({ msgId, at: Date.now(), error: 'ledger not open — queued row could NOT be cancelled' })
              }
              throw new S2sError(message + ' [cancel outcome: ' + cancelOutcome + ']', code)
            }
            const queued = await lifecycle.queuedCount(resolved.sessionId)
            // T9: `drain()` hands the queue to the agent, which is the same handover
            // the live path reports — so the same restraint applies. The old wording
            // said a bare "delivered", which a reader takes as "it is in the log".
            const base = outcome === 'resumed'
              ? 'Woke "' + labelOf(resolved) + '"' + matchNote + ' and handed the queued message(s) to it (queue now: ' + queued + '). Log presence is confirmed by s2s_reconcile / s2s_history.'
              : 'Queued for "' + labelOf(resolved) + '" (' + queued + ' total). It is dormant and autoResume is off, so nothing has been delivered yet.'
            return { text: base + callerNote + (warn === undefined ? '' : '\n[s2s-budget] ' + warn) }
          })()
        } catch (error: unknown) {
          // Only the T29 self refusal is rendered. Other S2sError codes keep their existing contract (e.g. the unsafe-id guard in s2s_resume is asserted to REJECT upstream), so this wrapper must not swallow them.
          // T30: the three target-policy codes join the approved render set (the ruling permits exactly these; other S2sError contracts, e.g. the unsafe-id guard, still reject upstream).
          if (error instanceof S2sError && ['S2S_SELF_TARGET', 'S2S_ARCHIVED_TARGET', 'S2S_SUBAGENT_TARGET', 'S2S_TARGET_POLICY_UNAVAILABLE'].includes(error.code)) return { text: '[' + error.code + '] ' + error.message }
          throw error
        }
      },
    }),
    defineTool({
      name: 's2s_resume',
      description: 'Wake a dormant (done) session by NAME (title) or session_id and deliver one message. With autoResume=allow resumes immediately; with deny queues.',
      parameters: {
        name: { type: 'string', description: 'Target session title. Primary addressing.' },
        session_id: { type: 'string', description: 'Fallback exact session id when a name is ambiguous.' },
        text: { type: 'string', required: true, description: 'Message text to deliver after the wake.' },
        from: { type: 'string', description: 'Sender label.' },
      },
      output: OUTPUT,
      // T29 (review must-fix 2): same domain-error wrapper as s2s_message.
      execute: async function(args, exec) {
        try {
          return await (async function(): Promise<{ text: string }> {
            if (lifecycle === undefined) return { text: 's2s lifecycle is not configured: add a lifecycle config block to enable waking dormant sessions.' }
            const resolved = await resolve(args.name, args.session_id)
            if (resolved.kind === 'err') return { text: resolved.reason }
            if (resolved.kind !== 'ok') return { text: displayResolve(resolved) }
            // T29, same gate as s2s_message: waking one's own session is a self-send
            // through the mailbox, so it is refused before any record, queue entry or
            // resume — a dormant wake would otherwise fabricate lifecycle activity on
            // the caller itself.
            if (isSelfTarget(exec, resolved.sessionId)) {
              throw new S2sError(
                'Refused: "' + labelOf(resolved) + '" is the calling session itself (caller id ' + String(exec.agent?.id) + '). A session cannot wake itself. To schedule a later step for your own session, use s2s_schedule.',
                'S2S_SELF_TARGET',
              )
            }
            // T30 pre-check, same as s2s_message: ONE shared verdict over the
            // resolved record's authoritative identity.
            const verdict = discovery.targetPolicyVerdict(resolved)
            if (verdict !== undefined) throw new S2sError(verdict.message, verdict.code)
            S2sLifecycleService.assertSafeSessionId(resolved.sessionId)
            const from = args.from ?? String(exec.agent?.id ?? 'unknown')
            // T29: same skipped-check record as s2s_message — a wake that proceeds
            // without identity evidence must be visible even if queue/record throws.
            if (selfCheckNote(exec).length > 0) recordSelfCheckSkipped('s2s_resume', resolved.sessionId)
            const msgId = 'wake-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
            // Record before queueing, exactly as `s2s_message` does. Without this the
            // dormant `drain()` reaches `markInboxed()` with no row to advance: the
            // wake was delivered, the ledger kept nothing, and `s2s_reconcile`
            // reported `examined=0` forever. Measured on the real host — the target's
            // log held `[s2s-lifecycle message] msgId=wake-…` while the ledger had
            // zero rows for it. `markInboxed` must not be the one to create the row:
            // that would fabricate a `record` and hide a missing one.
            const recorded = await noteLedger(ledger, 'record', function() {
              return ledger!.record({ msgId: msgId, from: from, to: args.name ?? args.session_id ?? resolved.sessionId, text: args.text })
            })
            // T30 post-record re-check: refuse with the queued row explicitly
            // cancelled (never retryable ghost work). ONE shared verdict — the
            // registry snapshot and the classification are taken inside it.
            // `recorded` is the REAL noteLedger return — "record did not throw"
            // is not evidence a row exists.
            const rerefusal = discovery.targetPolicyVerdict(resolved)
            if (rerefusal !== undefined) {
              let cancelOutcome = 'cancel-unavailable'
              if (ledger !== undefined && ledger.isOpen) {
                try {
                  const result = await ledger.cancel(msgId, rerefusal.message)
                  if (result.outcome === 'cancelled') cancelOutcome = 'cancelled'
                  else cancelOutcome = 'not-cancelled (' + result.outcome + (result.outcome === 'not-cancellable' ? ': ' + result.status : '') + ')'
                } catch (error) {
                  cancelOutcome = 'cancel-failed'
                  recordSelfRefusalCancelFailure({ msgId, at: Date.now(), error: String(error) })
                }
              } else {
                recordSelfRefusalCancelFailure({ msgId, at: Date.now(), error: 'ledger not open — queued row could NOT be cancelled' })
              }
              throw new S2sError(rerefusal.message + ' [cancel outcome: ' + cancelOutcome + ']', rerefusal.code)
            }
            const outcome = await lifecycle.queueForDormant({ sessionId: resolved.sessionId, from: from, text: args.text, msgId: msgId })
            const queued = await lifecycle.queuedCount(resolved.sessionId)
            // T9: same restraint as `s2s_message` — a wake hands the queue over, it
            // does not put anything in the target's log on its own.
            //
            // The confirmation pointer is only offered when this process actually
            // recorded the row. An unopened or absent ledger makes `record()` a
            // no-op, and naming `s2s_reconcile` in that state would point the reader
            // at a source that structurally cannot answer — the overclaim I1 forbids,
            // one level removed (the claim is about the evidence, not the delivery).
            // That is why the gate is `noteLedger`'s own return, not `ledger.isOpen`:
            // an open ledger whose write threw is just as untracked.
            const confirm = recorded
              ? ' Log presence is confirmed by s2s_reconcile / s2s_history.'
              : ' This message is NOT tracked in the ledger, so s2s_reconcile cannot see it — read the target\'s own log with s2s_history instead.'
            return { text: outcome === 'resumed'
              ? 'Session "' + labelOf(resolved) + '"' + matchNoteOf(resolved) + ' resumed and the queued message(s) were handed to it (queue now: ' + queued + ').' + confirm + selfCheckNote(exec)
              : 'Session "' + labelOf(resolved) + '" is dormant; queued (' + queued + ' total) — nothing delivered yet.' + selfCheckNote(exec) }
          })()
        } catch (error: unknown) {
          // Only the T29 self refusal is rendered. Other S2sError codes keep their existing contract (e.g. the unsafe-id guard in s2s_resume is asserted to REJECT upstream), so this wrapper must not swallow them.
          // T30: the three target-policy codes join the approved render set (the ruling permits exactly these; other S2sError contracts, e.g. the unsafe-id guard, still reject upstream).
          if (error instanceof S2sError && ['S2S_SELF_TARGET', 'S2S_ARCHIVED_TARGET', 'S2S_SUBAGENT_TARGET', 'S2S_TARGET_POLICY_UNAVAILABLE'].includes(error.code)) return { text: '[' + error.code + '] ' + error.message }
          throw error
        }
      },
    }),
    defineTool({
      name: 's2s_status',
      description: 'Report what s2s knows about itself: ledger backend and whether it opened, per-session queue depth, the last resume\'s preset outcome, and whether history is durable. Use it to tell a real degradation from a silent one.',
      parameters: {
        session_id: { type: 'string', description: 'Optional: restrict the per-session sections to one session id.' },
      },
      output: OUTPUT,
      execute: async function(args) {
        const lines: string[] = []

        // T26: a status read is a *sample*, and every number below is only true
        // as of the instant it was taken. Live session data drifts, so the
        // reading is worthless for later comparison without its timestamp, and
        // the numbers mean different things depending on which store answered.
        const sampledAt = Date.now()
        const backendOf = ledger === undefined ? 'none (no ledger mounted)' : ledger.isOpen ? String(ledger.backend) : 'none (ledger constructed but not open)'
        lines.push('as of: ' + new Date(sampledAt).toISOString() + ' (t=' + sampledAt + '), backend=' + backendOf
          + ' — these numbers are a point-in-time sample and will drift.')

        // Ledger: the single most load-bearing optional dependency. Its absence
        // must be stated as a fact, not left to be inferred from empty results.
        if (ledger === undefined) {
          lines.push('ledger: NOT MOUNTED — nothing is being tracked durably.')
        } else if (!ledger.isOpen) {
          lines.push('ledger: mounted but NOT OPEN — every write degrades to "untracked" (bookkeeping never blocks delivery). '
            + 'Cause: no `storageDomain` service (or its open failed). s2s_status/history have nothing durable to read.')
        } else {
          lines.push('ledger: open (backend=' + String(ledger.backend) + ').')
        }

        // ★ Untracked deliveries — the read-back for a failure that used to be
        // invisible. `markInboxed()` warns through the plugin logger when its row
        // is missing, and that logger is never persisted, so "the delivery was
        // tracked" and "it silently was not" left identical evidence. Measured on
        // the real host: a dormant wake landed in the target's log while the
        // ledger held zero rows for it. Printed only when non-empty, because a
        // permanent "0" line trains the reader to skip it.
        const untracked = ledgerDiagnostics.untrackedDeliveries ?? []
        if (untracked.length > 0) {
          lines.push('ledger UNTRACKED deliveries: ' + untracked.length + ' delivery(ies) could not be tracked '
            + '(no row to advance at handover — the sending entry never recorded it):')
          for (const u of untracked) {
            lines.push('  ' + u.msgId + ' -> ' + u.resolvedSessionId + '  at=' + new Date(u.at).toISOString())
          }
          lines.push('  These appear in the target\'s session log but are absent from the ledger, so s2s_reconcile cannot see them. Read them with s2s_history.')
        }

        // T29: recent resolutions that proceeded WITHOUT a self-target check
        // (caller id unavailable at the time). Printed only when non-empty, for
        // the same reason as the block above. Wording is deliberately NOT
        // "sent"/"queued": the event is recorded BEFORE the first side effect, so
        // a budget/queue/delivery throw may mean nothing was handed at all. This
        // block is the surviving evidence in exactly that case.
        const skipped = readSelfCheckSkipped()
        if (skipped.length > 0) {
          lines.push('self-target check skipped for ' + skipped.length + ' recent resolved attempt(s)'
            + ' (caller identity unavailable; retained <= 10, process-scoped — not a delivery-success record):')
          for (const s of skipped) {
            lines.push('  ' + s.tool + ' -> ' + s.target + '  at=' + new Date(s.at).toISOString())
          }
        }

        // History durability: T11 gave history a durable read path, so the old
        // flat "process-scoped only" claim is no longer true and must not be
        // printed. What matters now is *which* source can answer.
        const ledgerAnswers = ledger !== undefined && ledger.isOpen
        lines.push('history: ' + (ledgerAnswers
          ? 'durable read path ACTIVE on both sources (ledger + the target\'s session log).'
          : 'the ledger cannot answer (not open), so history falls back to the TARGET\'S SESSION LOG — '
            + 'still durable across restarts, but only for deliveries whose header landed in that log.')
          + ' The in-process buffer is process-scoped and a restart clears it; it is a last resort, not the read path.')

        // Resume reports: the G9 discriminator that used to exist only in the
        // logger. This is the read-back that makes it externally checkable.
        const reports = lifecycle === undefined
          ? []
          : (args.session_id === undefined ? lifecycle.resumeReports_() : [lifecycle.resumeReport(args.session_id)].filter(function(r) { return r !== undefined }))
        if (lifecycle === undefined) {
          lines.push('resumes: lifecycle not configured — dormant wakes are unavailable.')
        } else if (reports.length === 0) {
          lines.push('resumes: none recorded in this process.')
        } else {
          lines.push('resumes: ' + reports.length + ' recorded in this process (newest first):')
          for (const r of reports) {
            const when = new Date(r.at).toISOString()
            const preset = r.preset === undefined
              ? 'preset=NOT APPLIED (' + (r.presetUnavailableReason ?? 'unknown reason') + ')'
              : 'preset=' + (r.preset.substituted ? 'SUBSTITUTED' : 'as-recorded') + ' [' + r.preset.detail + ']'
            lines.push('  ' + r.sessionId + '  at=' + when + '  ' + preset)
          }
        }

        // Queue depth is the one per-session number that needs no ledger: the
        // mailbox is on disk, so it is honest even on a storage-less host.
        if (lifecycle !== undefined) {
          const targets = args.session_id === undefined
            ? [...new Set(reports.map(function(r) { return r.sessionId }))]
            : [args.session_id]
          for (const id of targets) {
            const queued = await lifecycle.queuedCount(id)
            lines.push('queue: ' + id + ' = ' + queued + ' message(s) waiting.')
          }
        }

        // Reconcile exposure (T26). Without this the reconcile pass existed in
        // the code but nothing could run it, so `inboxed` rows silently stayed
        // `inboxed` forever and "tracked" looked like "delivered". Naming the
        // tool here is what makes the gap findable from the self-report.
        lines.push(ledgerAnswers
          ? 'reconcile: available via s2s_reconcile — rows advance from inboxed to landed only when the ' 
            + 'msgId is visible in the target\'s session log; until that pass runs, an inboxed row is NOT proof of delivery.'
          : 'reconcile: unavailable — it needs the ledger, which is not open, so deliveries cannot advance beyond what '
            + 'the target log itself shows (read them with s2s_history).')

        // T8-2: the log-read cache, readable without running a pass. Reading it
        // through `s2s_reconcile` would be self-defeating here — the act of
        // reconciling mutates the cache being inspected.
        if (ledgerAnswers) {
          const lc = ledger.logCacheStatus(sampledAt)
          lines.push('reconcile cache: ' + lc.sessions + ' session(s) cached, ' + lc.fresh + ' usable now'
            + (lc.oldestAgeMs === undefined ? '' : ' (oldest entry ' + Math.round(lc.oldestAgeMs / 1000) + 's old)')
            + ' — success TTL=' + (lc.successTtlMs / 1000) + 's, failure TTL=' + (lc.failureTtlMs / 1000)
            + 's. A failed read uses the shorter TTL on purpose, so a momentary outage recovers quickly.')
        }

        // Sweep exposure (T24). The ledger arms a timer, but "armed" and
        // "achieving something" are different facts, and on a host without
        // `storageDomain` every tick returns early — so this line must report the
        // last attempt AND whether it could do anything. Without it the timer is
        // only provable by a unit test and could stop working unnoticed.
        if (ledger === undefined) {
          lines.push('sweep: no ledger is mounted, so no automatic sweep exists.')
        } else {
          const sw = ledger.sweepStatus
          if (!sw.armed) {
            lines.push('sweep: DISARMED (interval=' + sw.intervalMs + 'ms) — no automatic pass will run; '
              + 'rows advance only when s2s_reconcile is called by hand.')
          } else if (sw.last === undefined) {
            // The schedule is printed even with nothing to report yet: the
            // interval is 1h and the deadline 24h, so within a verification
            // window "armed, not yet due" and "never armed" would otherwise look
            // identical — both are simply a missing `last` (G9).
            lines.push('sweep: armed every ' + Math.round(sw.intervalMs / 1000) + 's, but has NOT run yet in this process '
              + '(nothing recorded since the last restart).'
              + (sw.nextSweepAt === undefined ? '' : ' Next pass due at ' + new Date(sw.nextSweepAt).toISOString() + '.')
              + ' A row may stay unreadable for ' + Math.round(sw.landedDeadlineMs / 3600000) + 'h before it is a zombie.')
          } else {
            const ageS = Math.round((sampledAt - sw.last.at) / 1000)
            const when = new Date(sw.last.at).toISOString()
            lines.push('sweep: armed every ' + Math.round(sw.intervalMs / 1000) + 's; last attempt ' + when
              + ' (' + ageS + 's ago), reconciled=' + sw.last.reconciled + ' expired=' + sw.last.expired
              + (sw.last.skipped
                ? ' — SKIPPED: the ledger is not open, so the sweep ran but could do nothing. The timer is alive; its effect is not.'
                : ' — executed against the store.')
              + (sw.nextSweepAt === undefined ? '' : ' Next pass due at ' + new Date(sw.nextSweepAt).toISOString() + '.')
              + ' A row may stay unreadable for ' + Math.round(sw.landedDeadlineMs / 3600000) + 'h before it is a zombie.')
          }
        }

        // ★ Ledger handshake diagnostics.
        //
        // Two fixes failed on the real host while every local model passed. A
        // single reading per round could not separate the remaining causes, so
        // this prints a SERIES and the one discriminator that matters: whether
        // the service implementation exists but is gated off (lifecycle) versus
        // never being reachable at all. This tool's own execution is the fourth
        // lifecycle point — the one where `tools.ts` is known to succeed.
        //
        // Guarded on `ctx` because a diagnostic must never be the thing that
        // breaks the tool it is meant to explain — a harness that builds the
        // tools without a context still has to be able to ask for status.
        {
          recordProbe(ctx, undefined, 'tools-first-execution')
          const d = ledgerDiagnostics
          const probe = function(name: string): string {
            if (ctx === undefined) return 'n/a (no ctx)'
            try {
              return ctx.get(name) === undefined ? 'undefined' : 'PRESENT'
            } catch (error: unknown) {
              return 'THREW(' + String(error) + ')'
            }
          }
          const hubProbe = (function(): string {
            if (ctx === undefined) return 'n/a (no ctx)'
            try {
              const hub = ctx.get('storage') as { domain?: unknown } | undefined
              return hub === undefined ? 'no storage hub' : (hub.domain === undefined ? 'undefined' : 'PRESENT')
            } catch (error: unknown) {
              return 'THREW(' + String(error) + ')'
            }
          })()
          lines.push('handshake: register=' + String(d.injectRegistered === true)
            + ' fired=' + String(d.injectFired ?? 0)
            + (d.injectFiredAt === undefined ? '' : ' at=' + new Date(d.injectFiredAt).toISOString())
            + ' outerLedgerVisible=' + String(d.outerLedgerVisible)
            + ' callbackLedgerVisible=' + String(d.callbackLedgerVisible)
            + ' openCalled=' + String(d.openCalled === true)
            + ' openOk=' + String(d.openSucceeded === true)
            + (d.openError === undefined ? '' : ' openError=' + d.openError)
            + '  |  live probes: ctx.get(storageDomain)=' + probe('storageDomain')
            + ' ctx.get(storage)=' + probe('storage')
            + ' storage.domain=' + hubProbe)

          // The cold-start clock. Rendered as ISO so it can be compared against
          // the host process's Start time by eye; the criterion itself is
          // procStart <= openCalledAt <= openSucceededAt < firstS2sToolCallAt.
          // `firstS2sToolCallAt` is sampled on the tool pipeline, NOT here — a
          // stamp written by this handler would be produced by the act of
          // reading it, which is the observer effect this replaced.
          const iso = function(ms: number | undefined): string {
            return ms === undefined ? 'n/a' : new Date(ms).toISOString()
          }
          const order = (function(): string {
            const p = d.procStart
            const c = d.openCalledAt
            const s = d.openSucceededAt
            const f = d.firstS2sToolCallAt
            if (p === undefined || c === undefined || s === undefined) return 'incomplete'
            if (f === undefined) {
              // Distinguish "no call yet" from "the sampler never attached": the
              // latter would otherwise look identical forever, which is how the
              // first version of this sampler failed silently on the real host.
              if (d.toolCallSamplerAttached !== true) {
                return 'unknown (the tool-call sampler is NOT attached'
                  + (d.toolCallSamplerError === undefined ? '' : ': ' + d.toolCallSamplerError) + ')'
              }
              return 'unknown (no s2s_* tool call observed yet)'
            }
            const monotone = p <= c && c <= s
            const cold = s < f
            return 'procStart<=openCalledAt<=openSucceededAt=' + String(monotone)
              + ' openSucceededAt<firstS2sToolCallAt=' + String(cold)
              + ((monotone && cold) ? ' => COLD-START-OK' : ' => COLD-START-NOT-PROVEN')
          })()
          lines.push('handshake-clock: procStart=' + iso(d.procStart)
            + ' openCalledAt=' + iso(d.openCalledAt)
            + ' openOkAt=' + iso(d.openSucceededAt)
            + ' firstS2sToolCallAt=' + iso(d.firstS2sToolCallAt)
            + (d.firstS2sToolCallName === undefined ? '' : ' (' + d.firstS2sToolCallName + ')')
            + ' injectFiredAt=' + iso(d.injectFiredAt)
            + ' sampler=' + (d.toolCallSamplerAttached === true
              ? 'attached'
              : 'NOT-ATTACHED' + (d.toolCallSamplerError === undefined ? '' : '(' + d.toolCallSamplerError + ')')))
          lines.push('handshake-coldstart: ' + order)

          // The series. Each row answers "can we see the ledger here, and if not,
          // does the implementation exist anyway, and what state is its fiber in".
          // `implPresent=true` + `selfGet=false` ⇒ registered but gated (lifecycle).
          // `implPresent=false` ⇒ never reachable on this store (a different problem).
          const rows = d.probes ?? []
          if (rows.length === 0) {
            lines.push('handshake-series: (no readings recorded)')
          } else {
            for (const r of rows) {
              lines.push('handshake-series: ' + r.via
                + ' selfGet=' + String(r.selfGet)
                + ' childGet=' + String(r.childGet)
                + ' implPresent=' + String(r.implPresent)
                + ' implFiberState=' + String(r.implFiberState)
                + ' selfFiberState=' + String(r.selfFiberState))
            }
          }
        }

        return { text: lines.join('\n') }
      },
    }),
    defineTool({
      name: 's2s_reconcile',
      description: 'Advance tracked deliveries for a target from `inboxed` to `landed` by checking whether they actually appear in that target\'s session log. A row is only `landed` once its msgId is visible in the log; this is the step that turns "written into the inbox" into "delivered". Safe to call repeatedly: progress is monotonic and terminal rows are never revived.',
      parameters: {
        name: { type: 'string', description: 'Target session title.' },
        session_id: { type: 'string', description: 'Exact session id.' },
        use_cache: { type: 'boolean', description: 'Honour the short-lived log-read cache (default true). Pass false to force a fresh read of the target log.' },
      },
      output: OUTPUT,
      execute: async function(args) {
        if (ledger === undefined) return { text: 'No ledger is mounted, so there is nothing to reconcile: delivery state is not being tracked in this process.' }
        if (!ledger.isOpen) return { text: 'The ledger is mounted but NOT OPEN, so delivery state is not being tracked and there is nothing to reconcile. Run s2s_status and read its `handshake:` line for why it failed (do not assume the host lacks a store — `storageDomain` is present here).' }
        const resolved = (args.name !== undefined || args.session_id !== undefined) ? await resolve(args.name, args.session_id) : { kind: 'err' as const, reason: 'Provide a name or session_id.' }
        if (resolved.kind === 'err') return { text: resolved.reason }
        if (resolved.kind !== 'ok') return { text: displayResolve(resolved) }
        const result = await ledger.reconcile(resolved.sessionId, {
          ...(args.use_cache === undefined ? {} : { useCache: args.use_cache }),
        })
        const label = labelOf(resolved)
        const head = result.unreadable
          ? 'Could NOT read the session log for "' + label + '": ' + result.examined + ' tracked row(s) examined, none advanced. The log being unreadable is NOT evidence that nothing landed — the rows keep their previous status and are marked as awaiting a readable log.'
          : result.landed === 0
            ? 'Read the session log for "' + label + '": ' + result.examined + ' tracked row(s) examined, none newly landed.'
            : 'Advanced ' + result.landed + ' of ' + result.examined + ' tracked row(s) for "' + label + '" to landed.'
        const detail = [
          'examined=' + result.examined,
          'landed=' + result.landed,
          'log=' + (result.unreadable ? 'UNREADABLE' : 'readable (' + (result.seenInLog ?? 0) + ' deliver(ies) visible)'),
          // T8-2: the two facts must not be conflated. `cache=` is what the CALLER
          // asked for; `cacheHit`/`logReads` are what the pass actually did. A
          // caller can honour the cache and still miss, so `cache=honoured` was
          // never evidence of a hit — it was once read that way and gave a wrong
          // answer. Both are printed so the difference is visible.
          'cache=' + (args.use_cache === false ? 'bypassed' : 'honoured'),
          'cacheHit=' + (result.cacheHit ? 'hit' : 'miss'),
          'logReads=' + result.logReads,
        ]
        return { text: head + '\n' + detail.join('  ') }
      },
    }),
    defineTool({
      name: 's2s_history',
      description: 'Recent messages for a session, merged from every durable source. The ledger is authoritative when it is open; the target\'s session log is read as the fallback that survives a restart without a storage backend. Each line names its source, and a source that answered with nothing says so rather than looking like "no messages".',
      parameters: {
        name: { type: 'string', description: 'Target session title.' },
        session_id: { type: 'string', description: 'Exact session id.' },
        limit: { type: 'number', description: 'Max messages (default 50).' },
      },
      output: OUTPUT,
      execute: async function(args) {
        const resolved = (args.name !== undefined || args.session_id !== undefined) ? await resolve(args.name, args.session_id) : { kind: 'err' as const, reason: 'Provide a name or session_id.' }
        if (resolved.kind === 'err') return { text: resolved.reason }
        if (resolved.kind !== 'ok') return { text: displayResolve(resolved) }
        // T11: the durable read path. `broker.history` is process-scoped and a
        // restart empties it, which used to make "nothing was ever sent" and
        // "everything was lost at restart" print identically.
        const memory = broker.history(resolved.sessionId, { limit: 200 }).map(function(r) {
          return { msgId: r.msgId, from: r.from, at: r.createdAt, ...(r.replyTo === undefined ? {} : { replyTo: r.replyTo }), preview: r.text.slice(0, 160), source: 'memory' as const }
        })
        const result = await readHistory(ctx, resolved.sessionId, {
          ...(ledger === undefined ? {} : { ledger: ledger }),
          memory: memory,
          ...(args.limit === undefined ? {} : { limit: args.limit }),
        })
        const provenance = 'sources: ' + result.sources.map(function(s) {
          return s.name + '=' + (s.ok ? String(s.count) : 'UNAVAILABLE(' + s.note + ')')
        }).join(', ')
        if (result.entries.length === 0) {
          return { text: 'No messages found for "' + labelOf(resolved) + '".\n' + provenance }
        }
        const lines = result.entries.map(function(e) {
          const when = new Date(e.at).toISOString()
          const id = e.msgId === undefined ? '' : ' msgId=' + e.msgId
          return '[' + when + '] (' + e.source + ') ' + e.from + id + ' -> ' + e.preview
        })
        return { text: lines.join('\n') + '\n' + provenance }
      },
    }),
    defineTool({
      name: 's2s_schedule',
      description: 'Schedule a prompt to be injected into a session on a timer. action=list lists jobs; create (every_seconds periodic, or at_iso one-shot) schedules; cancel (job_id) removes one.',
      parameters: {
        action: { type: 'string', required: true, description: 'list | create | cancel' },
        text: { type: 'string', description: 'Prompt text to inject (create).' },
        every_seconds: { type: 'number', description: 'Periodic interval in seconds (create); <300 collapses to a one-shot at now+interval.' },
        at_iso: { type: 'string', description: 'One-shot ISO instant (create).' },
        session_id: { type: 'string', description: 'Target session (default: this session).' },
        job_id: { type: 'string', description: 'Job id to cancel.' },
      },
      output: OUTPUT,
      execute: async function(args, exec) {
        if (schedule === undefined) return { text: 's2s schedule is not configured: add a schedule config block to enable scheduled injection.' }
        if (args.action === 'list') {
          const jobs = await schedule.list()
          if (jobs.length === 0) return { text: 'No scheduled jobs.' }
          return { text: jobs.map(function(j) { return '- ' + j.id + ' [' + shortId(j.targetSessionId) + '] ' + (j.everySeconds !== undefined ? 'every ' + j.everySeconds + 's' : 'at ' + (j.atIso ?? '')) + (j.enabled ? '' : ' (disabled)') }).join('\n') }
        }
        if (args.action === 'create') {
          if (args.text === undefined || args.text.length === 0) return { text: 'create needs a text.' }
          const target = args.session_id ?? String(exec.agent?.id ?? '')
          if (target.length === 0) return { text: 'create needs a session_id (or run from a session).' }
          const job = await schedule.create({
            targetSessionId: target,
            text: args.text,
            ...(args.every_seconds === undefined ? {} : { everySeconds: args.every_seconds }),
            ...(args.at_iso === undefined ? {} : { atIso: args.at_iso }),
          })
          return { text: 'Scheduled ' + job.id + ' -> ' + target + ' ' + (job.everySeconds !== undefined ? 'every ' + job.everySeconds + 's' : 'at ' + (job.atIso ?? '')) + '.' }
        }
        if (args.action === 'cancel') {
          if (args.job_id === undefined || args.job_id.length === 0) return { text: 'cancel needs a job_id.' }
          const ok = await schedule.cancel(args.job_id)
          return { text: ok ? 'Cancelled ' + args.job_id + '.' : 'No job ' + args.job_id + '.' }
        }
        return { text: 'action must be list | create | cancel.' }
      },
    }),
  ]
}

/** Cordis plugin name of the tool family. */
export const name = 's2s-tools'

export const inject = ['s2sBroker', 's2sDiscovery', 'tools']

export function apply(ctx: Context): void {
  const tools = ctx.get('tools') as { register(definition: ToolDefinition): () => void }
  // Independent cold-start sampler, registered on the tool pipeline rather than
  // inside `s2s_status`: the stamp must be produced by the FIRST s2s_* call of
  // any kind, because a stamp written by the status handler is created BY the
  // act of reading the status and can never establish that `open()` came first.
  //
  // The listener goes on `ctx` — the event bus — NOT on the `tools` service.
  // `ToolRuntime` exposes only `register()`. An earlier version called
  // `tools.on(...)` behind a `typeof === 'function'` guard with a swallowing
  // `catch`, so the sampler was never attached and the failure was invisible:
  // `firstS2sToolCallAt` stayed `n/a` on the real host with no error anywhere.
  // A silent no-op is exactly what G9 forbids, so attachment is now recorded
  // and any failure is surfaced in `s2s_status` instead of being dropped.
  try {
    // `tools/pre-execute` is a WATERFALL: a listener owns the continuation and
    // must call `next()` and return its decision. Returning `void` type-errors
    // here, and would have broken every tool call had the listener ever been
    // attached — which the previous silent non-attachment conveniently hid.
    const dispose = ctx.on('tools/pre-execute', function(
      exec: { name?: string },
      next: () => Promise<unknown>,
    ) {
      const calledName = exec?.name
      if (typeof calledName === 'string' && calledName.indexOf('s2s_') === 0) {
        recordFirstS2sToolCall(calledName)
      }
      return next()
    } as never)
    ledgerDiagnostics.toolCallSamplerAttached = typeof dispose === 'function'
  } catch (error: unknown) {
    ledgerDiagnostics.toolCallSamplerError = String(error)
  }
  const broker = ctx.get('s2sBroker') as S2sBroker
  const discovery = ctx.get('s2sDiscovery') as S2sDiscoveryService
  const lifecycle = ctx.get('s2sLifecycle') as S2sLifecycleService | undefined
  const budget = ctx.get('s2sBudget') as S2sBudget | undefined
  const schedule = ctx.get('s2sSchedule') as S2sScheduleService | undefined
  // Optional like the others: the tools must still work when no ledger is
  // mounted, they just cannot report delivery state.
  const ledger = ctx.get('s2sLedger') as S2sLedger | undefined
  const disposers = buildTools({ ctx: ctx, broker: broker, discovery: discovery, ...(lifecycle === undefined ? {} : { lifecycle: lifecycle }), ...(budget === undefined ? {} : { budget: budget }), ...(schedule === undefined ? {} : { schedule: schedule }), ...(ledger === undefined ? {} : { ledger: ledger }) }).map(function(d) { return tools.register(d) })
  ctx.effect(function() { return function() { for (const d of disposers) d() } }, 's2s-tools.disposers')
  // T30: the lifecycle's own gates (before `registry.resume` and inside
  // `drain`, which `agent/created` can trigger without any tool call) run the
  // SAME policy the tools run — injected here so every handover point shares
  // one verdict source. The check resolves the target's AUTHORITATIVE identity
  // through discovery (origin + header provenance), then hands it to the shared
  // verdict — it never re-classifies a bare id with `origin=undefined` (that was
  // review blocker 1). A corpus miss is `unknown` (fail-closed), not eligible.
  lifecycle?.setTargetPolicyCheck(async function(sessionId) {
    const identity = await discovery.authoritativeIdentity(sessionId)
    if (identity === undefined) {
      return { code: 'S2S_TARGET_POLICY_UNAVAILABLE' as const, message: 'the session id is not in the authoritative corpus; its target policy cannot be evaluated' }
    }
    return discovery.targetPolicyVerdict(identity)
  })
}

