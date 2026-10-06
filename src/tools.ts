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
import { readHistory } from './history.ts'
import { ledgerDiagnostics } from './ledger-diagnostics.ts'

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
    return 'No session named "' + resolved.name + '" (a rename becomes visible after the next title checkpoint; list actual names with s2s_sessions).\n' + lines.join('\n')
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

export function buildTools(deps: { ctx: Context; broker: S2sBroker; discovery: S2sDiscoveryService; lifecycle?: S2sLifecycleService; budget?: S2sBudget; schedule?: S2sScheduleService; ledger?: S2sLedger }): ToolDefinition[] {
  const ctx = deps.ctx
  const broker = deps.broker, discovery = deps.discovery, lifecycle = deps.lifecycle, budget = deps.budget, schedule = deps.schedule, ledger = deps.ledger
  const resolve = async function(name: string | undefined, sessionId: string | undefined): Promise<S2sResolveResult | { kind: 'err'; reason: string }> {
    if ((name === undefined || name.length === 0) && (sessionId === undefined || sessionId.length === 0)) {
      return { kind: 'err', reason: 'Provide a name (the session title) or a session_id.' }
    }
    return discovery.resolve(name, sessionId)
  }
  return [
    defineTool({
      name: 's2s_peers',
      description: 'List live sessions in the current project (all=true lists every project) with title (name) and state. Use the title in s2s_message / s2s_resume.',
      parameters: { all: { type: 'boolean', description: 'List sessions across all projects (default: current project only).' } },
      output: OUTPUT,
      execute: async function(args, exec) {
        const infos = await discovery.list()
        const scoped = args.all === true ? infos : sameProjectAsCaller(infos, exec)
        const sessions = scoped.filter(function(s) { return s.state !== 'dormant' })
        if (sessions.length === 0) return { text: 'No live sessions.' }
        return { text: sessions.map(function(s) { return (s.title ?? '(untitled)') + '  [' + shortId(s.sessionId) + ']  ' + s.state }).join('\n') }
      },
    }),
    defineTool({
      name: 's2s_sessions',
      description: 'List known sessions in the current project (all=true lists every project) with lifecycle state (live-idle/live-busy/dormant). Show title, short id, state. Use the title as the addr in s2s_message / s2s_resume.',
      parameters: {
        all: { type: 'boolean', description: 'List sessions across all projects (default: current project only).' },
        query: { type: 'string', description: 'Optional substring filter over session title, session id, or workspace directory name.' },
      },
      output: OUTPUT,
      execute: async function(args, exec) {
        const allInfos = await discovery.list()
        const scoped = args.all === true ? allInfos : sameProjectAsCaller(allInfos, exec)
        const sessions = (args.query === undefined || args.query.length === 0)
          ? scoped
          : scoped.filter(function(s) { const needle = (args.query as string).toLowerCase(); return (s.title ?? '').toLowerCase().includes(needle) || s.sessionId.toLowerCase().includes(needle) || s.workspaceDir.toLowerCase().includes(needle) })
        if (sessions.length === 0) return { text: 'No sessions found.' }
        return { text: sessions.map(function(s) { return (s.title ?? '(untitled)') + '  [' + shortId(s.sessionId) + ']  ' + s.state + '  ws=' + s.workspaceDir + (s.lastActivity === undefined ? '' : '  last=' + new Date(s.lastActivity).toISOString()) }).join('\n') }
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
      execute: async function(args, exec) {
        const resolved = await resolve(args.name, args.session_id)
        if (resolved.kind === 'err') return { text: resolved.reason }
        if (resolved.kind !== 'ok') return { text: displayResolve(resolved) }
        const from = args.from ?? String(exec.agent?.id ?? 'unknown')
        const msgId = 'm-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
        // Record before delivering: the row must exist for the delivery to
        // advance it, and a message that is lost mid-flight is exactly the one a
        // status query later needs to find.
        await noteLedger(ledger, 'record', function() {
          return ledger!.record({ msgId: msgId, from: from, to: args.name ?? args.session_id ?? resolved.sessionId, text: args.text, ...(args.reply_to === undefined ? {} : { replyTo: args.reply_to }) })
        })
        let warn: string | undefined
        if (budget !== undefined) {
          const result = await budget.check(from, resolved.sessionId, 0, buildThread(broker, from, resolved.sessionId), modelOf(exec))
          if (result?.verdict === 'warn') warn = result.reason
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
            return { text: 'NOT delivered: "' + labelOf(resolved) + '" resolved but had no live agent (broker state=absent), so the message reached nobody (left queued).' + (warn === undefined ? '' : '\n[s2s-budget] ' + warn) }
          }
          const how = state === 'idle' ? 'as a follow-up turn' : 'by context injection (the target was mid-turn)'
          return { text: 'Handed to "' + labelOf(resolved) + '" ' + how + ' — state=' + state + '. This means the agent accepted it, NOT that it is in the target\'s log yet; that is what s2s_reconcile (or s2s_history) confirms.' + (warn === undefined ? '' : '\n[s2s-budget] ' + warn) }
        }
        if (lifecycle === undefined) return { text: '"' + labelOf(resolved) + '" is dormant and no lifecycle is configured; use s2s_resume with autoResume=allow to wake it.' }
        const outcome = await lifecycle.queueForDormant({ sessionId: resolved.sessionId, from: from, text: args.text, msgId: msgId, ...(args.reply_to === undefined ? {} : { replyTo: args.reply_to }) })
        const queued = await lifecycle.queuedCount(resolved.sessionId)
        // T9: `drain()` hands the queue to the agent, which is the same handover
        // the live path reports — so the same restraint applies. The old wording
        // said a bare "delivered", which a reader takes as "it is in the log".
        const base = outcome === 'resumed'
          ? 'Woke "' + labelOf(resolved) + '" and handed the queued message(s) to it (queue now: ' + queued + '). Log presence is confirmed by s2s_reconcile / s2s_history.'
          : 'Queued for "' + labelOf(resolved) + '" (' + queued + ' total). It is dormant and autoResume is off, so nothing has been delivered yet.'
        return { text: base + (warn === undefined ? '' : '\n[s2s-budget] ' + warn) }
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
      execute: async function(args, exec) {
        if (lifecycle === undefined) return { text: 's2s lifecycle is not configured: add a lifecycle config block to enable waking dormant sessions.' }
        const resolved = await resolve(args.name, args.session_id)
        if (resolved.kind === 'err') return { text: resolved.reason }
        if (resolved.kind !== 'ok') return { text: displayResolve(resolved) }
        S2sLifecycleService.assertSafeSessionId(resolved.sessionId)
        const from = args.from ?? String(exec.agent?.id ?? 'unknown')
        const msgId = 'wake-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
        const outcome = await lifecycle.queueForDormant({ sessionId: resolved.sessionId, from: from, text: args.text, msgId: msgId })
        const queued = await lifecycle.queuedCount(resolved.sessionId)
        // T9: same restraint as `s2s_message` — a wake hands the queue over, it
        // does not put anything in the target's log on its own.
        return { text: outcome === 'resumed'
          ? 'Session "' + labelOf(resolved) + '" resumed and the queued message(s) were handed to it (queue now: ' + queued + '). Log presence is confirmed by s2s_reconcile / s2s_history.'
          : 'Session "' + labelOf(resolved) + '" is dormant; queued (' + queued + ' total) — nothing delivered yet.' }
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
            lines.push('sweep: armed every ' + Math.round(sw.intervalMs / 1000) + 's, but has NOT run yet in this process '
              + '(nothing recorded since the last restart).')
          } else {
            const ageS = Math.round((sampledAt - sw.last.at) / 1000)
            const when = new Date(sw.last.at).toISOString()
            lines.push('sweep: armed every ' + Math.round(sw.intervalMs / 1000) + 's; last attempt ' + when
              + ' (' + ageS + 's ago), reconciled=' + sw.last.reconciled + ' expired=' + sw.last.expired
              + (sw.last.skipped
                ? ' — SKIPPED: the ledger is not open, so the sweep ran but could do nothing. The timer is alive; its effect is not.'
                : ' — executed against the store.'))
          }
        }

        // ★ Ledger handshake diagnostics.
        //
        // The first attempt at the race fix passed every local probe and did
        // nothing on the real host. Since the plugin logger is never persisted,
        // "the callback never fired" and "it fired but the store still was not
        // there" look identical afterwards. This line carries the handshake out
        // through the tool surface so the next iteration is driven by evidence
        // from the running process rather than by local models of it.
        //
        // Guarded on `ctx` because a diagnostic must never be the thing that
        // breaks the tool it is meant to explain — a harness that builds the
        // tools without a context still has to be able to ask for status.
        {
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
        if (!ledger.isOpen) return { text: 'The ledger is mounted but NOT OPEN (no storageDomain), so delivery state is not being tracked and there is nothing to reconcile. See s2s_status.' }
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
          'cache=' + (args.use_cache === false ? 'bypassed' : 'honoured'),
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
}

