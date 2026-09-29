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
 * The lifecycle service. Mounted only when a `lifecycle` config block is
 * present, so deployments that never target dormant sessions pay nothing.
 */
export class S2sLifecycleService extends Service {
  static inject = ['agents']

  private readonly config: LifecycleConfig
  private readonly mailbox: S2sMailbox
  /** Resumed handles are kept alive for the process lifetime (see OQ-5). */
  private readonly resumed = new Map<string, ResumedHandle>()
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
  private async resumedSetup(sessionId: string): Promise<AgentSetup | undefined> {
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
      return async (agentCtx: Context) => { this.installSelection(agentCtx) }
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
      return async (agentCtx: Context) => {
        this.installSelection(agentCtx)
        await presets.mount(agentCtx, resolvedId)
      }
    } catch (error: unknown) {
      // Preset lookup/mount failed: keep the model-selection half rather than
      // handing back no setup at all, and make the loss loud (G9).
      this.ctx.logger.warn(
        `s2s lifecycle: could not resolve/mount preset for "${sessionId}" (${String(error)}); `
        + 'the session resumes WITHOUT its preset layer.',
      )
      return async (agentCtx: Context) => { this.installSelection(agentCtx) }
    }
  }

  /**
   * Install the Session-local model selection that the host installs during
   * preset setup. Kept as the single place that does this (the host's
   * `selectionFor` mirrors it): before, this ran *in addition to* the missing
   * preset mount, which is what made the degradation lopsided.
   *
   * @param agentCtx - the Agent's scoped context, valid only inside `setup`.
   */
  private installSelection(agentCtx: Context): void {
    const agent = (agentCtx as Context & { agent?: Agent }).agent
    // Fail loud, exactly as the host does: a setup that cannot see its scoped
    // Agent is a broken composition, not a case to pass over. Silent return here
    // would let a half-composed Agent be published — the same class of defect as
    // the missing preset layer (G9: no silent degradation).
    if (agent === undefined) throw new S2sError('s2s lifecycle: Agent setup has no scoped Agent', 'S2S_LIFECYCLE')
    let picked: ModelSelection | undefined
    const selection = {
      get current() {
        if (picked !== undefined) return picked
        const logged = agent.session.requestHeader()?.config
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
    installModelSelection(agent.ctx, selection)
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
