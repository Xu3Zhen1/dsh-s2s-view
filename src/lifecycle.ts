/**
 * The session-lifecycle service: durable mailbox plus resume-and-deliver for
 * dormant (done) sessions. A message for a dormant session is enqueued; when
 * `autoResume: 'allow'` the service resumes the session through the agent
 * registry and drains the mailbox into it via the same idle-aware injection
 * the mesh uses. Resumed sessions are left live-idle on purpose — the
 * service never disposes an agent it resumed (see OQ-5: dispose semantics
 * are still under review; auto-sleeping a human's session is worse than
 * leaving it parked).
 * @module dsh-s2s/lifecycle
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type AgentSetup, type ModelSelection } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { S2sError } from './error.ts'
import { noteLedger, type S2sLedger } from './ledger.ts'
import { S2S_MESSAGE_SOURCE } from './source.ts'
import { S2sMailbox, type MailboxEntry } from './mailbox.ts'

/** Lifecycle knobs. */
export interface LifecycleConfig {
  /** Master switch; the entry plugin only mounts the service when set. */
  readonly enabled?: boolean
  /** Whether a queued message may resume the dormant session (default deny). */
  readonly autoResume?: 'allow' | 'deny'
  /** Mailbox root override; defaults to ~/.dsh/s2s/mailboxes. */
  readonly mailboxDir?: string
}

/** A minimal resumed-agent handle (structural; avoids coupling to internals). */
interface ResumedHandle {
  readonly agent: Agent
  readonly dispose?: () => void | Promise<void>
}

/**
 * What the last resume of one session actually composed.
 *
 * The three trace branches in `resumedSetup` write to the **logger**, and a
 * logger is not a durable artifact on this host: the session transcript keeps
 * only `{type,seq,time,data}` records, `~/.dsh` has no host log directory, and
 * the mailbox is empty once a wake drains. An external reviewer therefore had
 * no way to tell "restored its own preset" from "silently got the deployment
 * default" — the information existed only inside the running process.
 *
 * This record is that information, kept where a tool can read it back
 * (`s2s_status`), so the observation survives the call that produced it.
 */
export interface ResumePresetReport {
  /** The preset id recorded for the session, or `undefined` when none was. */
  readonly recorded: string | undefined
  /** The preset id actually mounted. */
  readonly mounted: string
  /** True when `mounted !== recorded` — the default stood in for the record. */
  readonly substituted: boolean
  /** Text of the trace that was emitted, for one-glance comparison. */
  readonly detail: string
}

/** The last resume this process performed for one session. */
export interface ResumeReport {
  readonly sessionId: string
  readonly at: number
  /** `undefined` when the preset service was missing or resolve/mount failed. */
  readonly preset: ResumePresetReport | undefined
  /** Why the preset half is absent, when it is. */
  readonly presetUnavailableReason?: string
}

/**
 * The `setup` runtime contract, which the published type lags.
 *
 * `AgentSetup` declares a single `agentCtx` parameter, but the shipping
 * 0.2.0-rc.2 host hands over the Agent itself as a **second** argument —
 * verified in the deployed bundle (`resources/app.asar`):
 *
 *     setup?.(prepared.agent.ctx, prepared.agent)
 *
 * The context alone is not enough: it is the *unpublished* Agent scope, which
 * carries no scoped Agent, so `agentCtx.get('agent')` yields `undefined`. A
 * setup that reads only the context cannot compose the Agent at all — measured
 * on 0.2.0-rc.2, every dormant wake died with
 * `s2s lifecycle: Agent setup has no scoped Agent`.
 *
 * The second parameter is optional so this stays assignable to `AgentSetup`,
 * which keeps hosts that still pass one argument working.
 */
type ScopedAgentSetup = (agentCtx: Context, agent?: Agent) => void | Promise<void>

/**
 * The lifecycle service. Mounted only when a `lifecycle` config block is
 * present, so deployments that never target dormant sessions pay nothing.
 */
export class S2sLifecycleService extends Service {
  static inject = ['agents']

  /** How many sessions' resume reports to keep (oldest dropped first). */
  private static readonly RESUME_REPORT_LIMIT = 200

  private readonly config: LifecycleConfig
  private readonly mailbox: S2sMailbox
  /** Resumed handles are kept alive for the process lifetime (see OQ-5). */
  private readonly resumed = new Map<string, ResumedHandle>()
  /**
   * What the last resume composed, per session, for `s2s_status` to read back.
   * Bounded like the mailbox: a wake is rare and this is a diagnostic, so the
   * oldest entry is dropped rather than growing without limit.
   */
  private readonly resumeReports = new Map<string, ResumeReport>()
  private readonly offCreated: () => void

  constructor(ctx: Context, config: LifecycleConfig = {}) {
    super(ctx, 's2sLifecycle')
    this.config = config
    this.mailbox = new S2sMailbox(config.mailboxDir)
    // A wake can also arrive because someone manually reopened the session;
    // drain on agent creation so the queue clears no matter who resumed.
    this.offCreated = this.ctx.root.on('agent/created', ({ agent }) => {
      void this.drain(String(agent.id)).catch((error: unknown) => {
        this.ctx.logger.warn(`s2s lifecycle: drain failed for ${String(agent.id)}: ${String(error)}`)
      })
    })
    this.ctx.effect(() => this.offCreated, 's2sLifecycle.listener')
  }

  /**
   * Queue one message for a (presumed dormant) session and, when allowed,
   * resume it and deliver immediately.
   * @returns `'resumed'` when the session was resumed and drained now,
   *   `'queued'` when the entry waits in the mailbox.
   */
  async queueForDormant(entry: { sessionId: string; from: string; text: string; replyTo?: string; msgId: string }): Promise<'queued' | 'resumed'> {
    const record: MailboxEntry = {
      msgId: entry.msgId,
      from: entry.from,
      text: entry.text,
      ...(entry.replyTo === undefined ? {} : { replyTo: entry.replyTo }),
      createdAt: Date.now(),
    }
    await this.mailbox.enqueue(entry.sessionId, record)
    if (this.config.autoResume !== 'allow') return 'queued'
    // Defensive: a live session must never be resumed again (duplicate
    // identity is rejected loud by the registry). But a message for an
    // already-live session (e.g. one a previous s2s resume left live-idle per
    // OQ-5) must still be delivered — drain the queued mailbox instead of
    // stalling it. `s2s_resume` routes live sessions here too, so without this
    // a live target would silently queue with no delivery.
    if (this.ctx.agents.get(SessionId(entry.sessionId)) !== undefined) {
      await this.drain(entry.sessionId)
      return 'resumed'
    }
    const registry = this.ctx.agents as typeof this.ctx.agents & {
      resume?: (options: { resumeSessionId: string; setup?: AgentSetup }) => Promise<ResumedHandle>
    }
    if (typeof registry.resume !== 'function') {
      this.ctx.logger.warn('s2s lifecycle: agent registry has no resume capability; message stays queued')
      return 'queued'
    }
    // A dormant resume through AgentRegistry.resume does NOT run the host's
    // composeAgent, so the resumed Agent gets a fresh scoped world with no
    // preset layer at all (tools and prompt sections silently missing). Pass a
    // setup that reproduces the host's composition. See `resumedSetup`.
    const setup = await this.resumedSetup(entry.sessionId)
    const handle = await registry.resume({
      resumeSessionId: entry.sessionId,
      ...(setup === undefined ? {} : { setup: setup }),
    })
    this.resumed.set(entry.sessionId, handle)
    await this.drain(entry.sessionId)
    return 'resumed'
  }

  /**
   * Build the pre-publication `setup` for a resumed Agent, mirroring the host's
   * `ApiSessionAgentController.composeAgent` (`packages/api/session-controller`).
   *
   * Why this exists: `AgentRegistry.resume` mints a fresh scoped world and only
   * the caller's `setup` populates it. The web host supplies its own for
   * GUI-driven resumes; a dormant wake from here has no such caller, so without
   * this the Agent comes up with **no preset**: ~26 preset-registered tools and
   * their prompt sections vanish while the session stays alive and answers
   * normally — a silent, hard-to-notice degradation.
   *
   * The preset id is read from the **`agentPreset` Session projection**, the
   * same source the host uses, and never from the creation-time header alone:
   * a session may switch presets while still blank.
   *
   * @param sessionId - the dormant session being resumed.
   * @returns the setup callback, or `undefined` when it cannot be composed
   *   (no preset service, or the session cannot be observed) — in which case
   *   the caller resumes exactly as before rather than failing the delivery.
   *
   * **This is a MIRROR, not a reuse, and it has an exit condition.** It cannot
   * call the host's `composeAgent` because the controller that owns it is a
   * `private` field (`session-controller/src/index.ts`), so there is no
   * injectable service for it. `composeAgent` itself is already `public`; the
   * host only needs to expose that instance (a one-line `provide` plus a type
   * declaration, not a refactor). **If the host exposes it, delete this method
   * and call the host's implementation** — two copies drift silently, since
   * nothing here fails to compile when `composeAgent` changes.
   */
  private async resumedSetup(sessionId: string): Promise<ScopedAgentSetup | undefined> {
    const presets = this.ctx.get('agentPresets') as
      | { resolve(id?: string): Promise<{ id: string }>; mount(agentCtx: Context, id?: string): Promise<unknown> }
      | undefined
    if (presets === undefined) {
      // Mirror the host exactly: with no preset service it still supplies a
      // setup, just without the mount (`composeAgent`: `return { setup: (agentCtx)
      // => { this.installSelection(agentCtx) } }`). Returning no setup at all
      // would ALSO drop the model-selection binding and reintroduce the
      // unbound-`{{model}}` failure this code originally existed to fix.
      // G9: the fallback announces itself — the preset layer will be missing.
      this.ctx.logger.warn(
        's2s lifecycle: no `agentPresets` service in this composition — the resumed session will NOT get its preset '
        + 'layer (tools and prompt sections may be missing). Resuming anyway; install the presets plugin to fix this.',
      )
      this.rememberResume(sessionId, undefined, 'no `agentPresets` service in this composition')
      return async (agentCtx: Context, agent?: Agent) => { this.installSelection(agentCtx, agent) }
    }
    let presetId: string | undefined
    try {
      const query = this.ctx.get('sessionQuery') as
        | { observeSession(id: SessionId): Promise<{ projections?: { values: { agentPreset?: string | null } } }> }
        | undefined
      if (query !== undefined) {
        const observation = await query.observeSession(SessionId(sessionId))
        presetId = observation.projections?.values.agentPreset ?? undefined
      }
    } catch (error: unknown) {
      this.ctx.logger.warn(
        `s2s lifecycle: could not observe "${sessionId}" to resolve its agent preset (${String(error)}); `
        + 'falling back to the deployment default preset.',
      )
    }
    try {
      const resolvedId = (await presets.resolve(presetId)).id
      // G9: make the preset a resumed session actually gets **observable**.
      // Which preset was mounted is otherwise invisible in every artifact — the
      // transcript records the *permission* preset, not the agent preset — so
      // "restored the session's own preset" and "got the deployment default"
      // look identical. An adversarial review of wake fidelity (G8) flagged
      // exactly this: the layer's presence was provable, its identity was not.
      // The three branches below are the whole discriminator; the happy path is
      // traced at `info` so that "no substitution happened" is a positive
      // record rather than an argument from silence.
      if (presetId === undefined) {
        this.ctx.logger.warn(
          `s2s lifecycle: "${sessionId}" has no recorded agent preset — resuming with the deployment default `
          + `"${resolvedId}". Its tool set and prompt sections may differ from how it was created.`,
        )
      } else if (resolvedId !== presetId) {
        this.ctx.logger.warn(
          `s2s lifecycle: the agent preset "${presetId}" recorded for "${sessionId}" resolved to "${resolvedId}" `
          + '(not the recorded preset) — the session resumes with a SUBSTITUTED preset.',
        )
      } else {
        this.ctx.logger.info(
          `s2s lifecycle: resuming "${sessionId}" with its recorded agent preset "${resolvedId}".`,
        )
      }
      // Same discriminator, in a form that outlives the process: the logger
      // above is unreadable after the fact on this host, so `s2s_status` reads
      // this instead.
      this.rememberResume(sessionId, {
        recorded: presetId,
        mounted: resolvedId,
        substituted: presetId !== undefined && resolvedId !== presetId,
        detail: presetId === undefined
          ? `no recorded preset; mounted the deployment default "${resolvedId}"`
          : resolvedId !== presetId
            ? `recorded "${presetId}" but mounted "${resolvedId}" (substituted)`
            : `mounted its recorded preset "${resolvedId}"`,
      })
      return async (agentCtx: Context, agent?: Agent) => {
        this.installSelection(agentCtx, agent)
        await presets.mount(agentCtx, resolvedId)
      }
    } catch (error: unknown) {
      // Preset lookup/mount failed: keep the model-selection half rather than
      // handing back no setup at all, and make the loss loud (G9).
      this.ctx.logger.warn(
        `s2s lifecycle: could not resolve/mount preset for "${sessionId}" (${String(error)}); `
        + 'the session resumes WITHOUT its preset layer.',
      )
      return async (agentCtx: Context, agent?: Agent) => { this.installSelection(agentCtx, agent) }
    }
  }

  /**
   * Record what the last resume composed, for `s2s_status` to read back later.
   *
   * This exists because the trace it mirrors goes to the logger, and a logger
   * leaves nothing an outside reader can inspect on this host. Keeping it here
   * — next to the resume that produced it — is what turns "the layer was
   * present" into "the layer was *this* preset", which is exactly the question
   * an adversarial review could not answer.
   *
   * @param sessionId - the session that was resumed.
   * @param preset - the preset outcome, or `undefined` when none applied.
   * @param unavailableReason - why the preset half is missing, when it is.
   */
  private rememberResume(sessionId: string, preset: ResumePresetReport | undefined, unavailableReason?: string): void {
    // Bounded like the mailbox: wakes are rare and this is diagnostic state, so
    // drop the oldest rather than growing without limit.
    if (this.resumeReports.size >= S2sLifecycleService.RESUME_REPORT_LIMIT) {
      const oldest = this.resumeReports.keys().next()
      if (oldest.done !== true) this.resumeReports.delete(oldest.value)
    }
    this.resumeReports.set(sessionId, {
      sessionId,
      at: Date.now(),
      preset,
      ...(unavailableReason === undefined ? {} : { presetUnavailableReason: unavailableReason }),
    })
  }

  /** The last resume report for one session, or `undefined` if never resumed. */
  resumeReport(sessionId: string): ResumeReport | undefined {
    return this.resumeReports.get(sessionId)
  }

  /** Every resume report still remembered, newest first. */
  resumeReports_(): ResumeReport[] {
    return [...this.resumeReports.values()].sort((a, b) => b.at - a.at)
  }

  /**
   * Install the Session-local model selection that the host installs during
   * preset setup. Kept as the single place that does this (the host's
   * `selectionFor` mirrors it): before, this ran *in addition to* the missing
   * preset mount, which is what made the degradation lopsided.
   *
   * @param agentCtx - the Agent's scoped context, valid only inside `setup`.
   * @param agent - the Agent the host passes as `setup`'s second argument; the
   *   scope alone is not enough, because it is still unpublished and therefore
   *   has no scoped Agent to read.
   */
  private installSelection(agentCtx: Context, agent: Agent | undefined): void {
    // The order matters: take the host's explicit second argument first (that is
    // the 0.2.0-rc.2 contract), and only then fall back to the scope, which
    // keeps hosts that call `setup(agentCtx)` alone working.
    //
    // The fallback is `ctx.get`, NOT a property read: cordis resolves
    // `ctx.<service>` through a proxy that **throws** `cannot get property
    // "agent" without inject` for a service the context did not declare, so a
    // defensive `=== undefined` check never runs — reading the property is
    // itself the failure. `ctx.get` is the only correct probe for an optional
    // seam.
    //
    // Measured on the desktop host (0.2.0-rc.2): the property read threw
    // `Error: cannot get property "agent" without inject`, and after switching
    // to `ctx.get` the read simply found nothing (this throw) — because the
    // scope handed to `setup` is unprepared. Hence the second argument.
    const scoped = agent ?? (agentCtx.get('agent') as Agent | undefined)
    // Fail loud, exactly as the host does: a setup that cannot see its scoped
    // Agent is a broken composition, not a case to pass over. Silent return here
    // would let a half-composed Agent be published — the same class of defect as
    // the missing preset layer (G9: no silent degradation).
    if (scoped === undefined) throw new S2sError('s2s lifecycle: Agent setup has no scoped Agent', 'S2S_LIFECYCLE')
    let picked: ModelSelection | undefined
    const selection = {
      get current() {
        if (picked !== undefined) return picked
        const logged = scoped.session.requestHeader()?.config
        if (logged === undefined) return undefined
        return {
          provider: logged.provider,
          model: logged.model,
          ...(logged.reasoningEffort === undefined ? {} : { reasoningEffort: logged.reasoningEffort }),
        }
      },
      set current(next: ModelSelection | undefined) {
        picked = next
      },
      assembled: undefined,
    }
    // The Agent's own scope, not the composition scope: the selection is
    // Agent-scoped, and the two are the same object in the host's own call.
    installModelSelection(scoped.ctx, selection)
  }

  /**
   * Drain the mailbox into the live agent for one session. Delivered via
   * follow-up turn when idle, plain context injection when busy (same
   * idle-aware shape as mesh inbound). Public: tests and the resume tool
   * path call it directly after a wake.
   */
  async drain(sessionId: string): Promise<number> {
    const agent = this.ctx.agents.get(SessionId(sessionId))
    if (agent === undefined) return 0
    // T6b: the row for a dormant message was created by the caller
    // (`s2s_message` records before dispatch) and stayed `queued` for the whole
    // wake, so a status query could not tell a delivered wake from a stuck one.
    // The handover below **is** the dormant path's `inboxed` moment — the same
    // meaning the live path gives it in `broker.deliver`'s non-`absent` branch
    // (`tools.ts`). Resolved once per drain; the ledger is optional.
    const ledger = this.ctx.get('s2sLedger') as S2sLedger | undefined
    const entries = await this.mailbox.drain(sessionId)
    for (const entry of entries) {
      // Same `msgId=` header as the broker's live path: the ledger derives
      // `landed` by finding this token in the target's session log, so both
      // delivery paths must emit it or dormant deliveries can never land.
      const text = `[s2s-lifecycle message] msgId=${entry.msgId} from=${entry.from} queued-at=${new Date(entry.createdAt).toISOString()} replyTo=${entry.replyTo ?? '-'}
${entry.text}`
      const userMessage = createUserMessage({
        content: [{ type: 'text', text }],
        source: S2S_MESSAGE_SOURCE,
      })
      if (agent.status === 'idle') {
        agent.followup(userMessage)
      } else {
        agent.inject(userMessage)
      }
      // Guarded, like the live path: bookkeeping never outranks delivery (an
      // unopened ledger must not abort the drain), and the loss stays loud (G9).
      await noteLedger(ledger, 'markInboxed', () => ledger!.markInboxed(entry.msgId, sessionId))
    }
    return entries.length
  }

  /** Queued message count for one session (tool-facing). */
  async queuedCount(sessionId: string): Promise<number> {
    return this.mailbox.count(sessionId)
  }

  /** Reject unsafe ids early so tools can report a clean error. */
  static assertSafeSessionId(sessionId: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId)) {
      throw new S2sError(`s2s lifecycle: unsafe session id ${JSON.stringify(sessionId)}`, 'S2S_LIFECYCLE')
    }
  }
}
