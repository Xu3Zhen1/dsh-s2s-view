import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply as s2sApply, S2sLifecycleService } from '../src/index.ts'

// Spy on the exported installModelSelection so we can assert the lifecycle
// installs the agent-scoped model-selection hooks while composing the resumed
// Agent, and that the selection resolves the session's last model
// (binding {{model}}/{{provider}}).
const { installSpy } = vi.hoisted(() => ({ installSpy: vi.fn() }))
vi.mock('@deepseek-ai/dsh-agent', async () => {
  const actual = await vi.importActual<typeof import('@deepseek-ai/dsh-agent')>('@deepseek-ai/dsh-agent')
  return { ...actual, installModelSelection: installSpy as unknown as typeof actual.installModelSelection }
})

const dirs: string[] = []
afterEach(async () => {
  installSpy.mockClear()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

function makeAgent(requestHeader?: { provider: string; model: string }) {
  const agentCtx = new Context()
  return {
    id: 'sess-1',
    status: 'idle',
    session: { requestHeader: () => (requestHeader === undefined ? undefined : { config: requestHeader }) },
    ctx: agentCtx,
    followup: () => {},
    inject: () => {},
  }
}

/** The `setup` the lifecycle hands the registry, in the host's calling shape. */
type SetupFn = (agentCtx: Context, agent?: unknown) => unknown

interface SetupOpts {
  presetId?: string
  /** Force `presets.resolve()` to answer with this id (simulates substitution). */
  resolveTo?: string
  presetsAbsent?: boolean
  observeFails?: boolean
  resolveFails?: boolean
  mountFails?: boolean
}

/**
 * Build the lifecycle, wake a dormant session through it, and capture the
 * `setup` it handed the registry. Deliberately does NOT run that setup: each
 * test chooses which calling convention to exercise.
 */
async function composeSetup(
  requestHeader?: { provider: string; model: string },
  opts: SetupOpts = {},
) {
  const mailboxDir = await mkdtemp(join(tmpdir(), 's2s-lm-'))
  dirs.push(mailboxDir)
  const ctx = new Context()
  // Capture the service's own logger, not console: that is what the code calls.
  const warn = vi.fn()
  const info = vi.fn()
  ctx.logger.warn = warn as never
  ctx.logger.info = info as never
  const agent = makeAgent(requestHeader)
  const mount = vi.fn(async () => {
    if (opts.mountFails === true) throw new Error('mount exploded')
    return {}
  })
  const resolve = vi.fn(async (id?: string) => {
    if (opts.resolveFails === true) throw new Error('resolve exploded')
    return { id: opts.resolveTo ?? id ?? 'default-preset' }
  })
  if (opts.presetsAbsent !== true) {
    ctx.provide('agentPresets', { resolve, mount } as never)
  }
  ctx.provide('sessionQuery', {
    observeSession: async () => {
      if (opts.observeFails === true) throw new Error('observe exploded')
      return { projections: { values: { agentPreset: opts.presetId ?? null } } }
    },
  } as never)
  const resume = vi.fn(async () => ({ agent }))
  ctx.provide('agents', { get: () => undefined, resume } as never)
  await ctx.plugin(s2sApply, { lifecycle: { autoResume: 'allow', mailboxDir } })
  const lifecycle = ctx.get('s2sLifecycle') as S2sLifecycleService
  await lifecycle.queueForDormant({ sessionId: 'sess-1', from: 'alice', text: 'wake', msgId: 'm1' })
  const setup = (resume.mock.calls[0]![0] as { setup?: SetupFn }).setup
  return { resume, agent, mount, resolve, setup, warn, info, lifecycle }
}

/**
 * Resume once and run the `setup` the lifecycle supplied **the way the shipping
 * host calls it**: `setup(agentCtx, agent)` — the unpublished Agent scope as the
 * first argument, the Agent itself as the second (verified in the deployed
 * `resources/app.asar`). The setup is what a real registry awaits before
 * publishing the Agent, so asserting on it without running it would prove
 * nothing.
 */
async function resumeOnce(
  requestHeader?: { provider: string; model: string },
  opts: SetupOpts = {},
) {
  const composed = await composeSetup(requestHeader, opts)
  const agentCtx = new Context()
  if (composed.setup !== undefined) await composed.setup(agentCtx, composed.agent)
  return { ...composed, agentCtx }
}

describe('s2s lifecycle wake fidelity (the {{model}} + preset fix)', () => {
  it('supplies a setup that installs model selection binding the session model', async () => {
    const { setup, agentCtx, agent } = await resumeOnce({ provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' })
    expect(setup).toBeTypeOf('function')
    expect(installSpy).toHaveBeenCalledTimes(1)
    const [agentCtxArg, selection] = installSpy.mock.calls.at(-1)!
    expect(agentCtxArg).toBe(agent.ctx)
    // selection resolves the session's last model config
    expect(selection.current).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' })
    // the mutable selection accepts a picked value (setter path)
    selection.current = { provider: 'zhipu-glm', model: 'glm-5.3-flash' }
    expect(selection.current).toEqual({ provider: 'zhipu-glm', model: 'glm-5.3-flash' })
    expect(agentCtx).toBeDefined()
  })

  it('mounts the preset during setup — the layer whose loss dropped 26 tools', async () => {
    const { mount, resolve } = await resumeOnce({ provider: 'p', model: 'm' }, { presetId: 'ops-default' })
    // Preset id must come from the Session projection, not the creation header.
    expect(resolve).toHaveBeenCalledWith('ops-default')
    expect(mount).toHaveBeenCalledTimes(1)
  })

  it('leaves selection.current undefined when the session has no logged model', async () => {
    await resumeOnce(undefined)
    const [, selection] = installSpy.mock.calls.at(-1)!
    expect(selection.current).toBeUndefined()
  })

  it('still resumes, and warns, when no preset service is mounted (G9)', async () => {
    // G9 (no silent degradation): the wake must succeed AND leave a trace.
    const { resume, warn } = await resumeOnce({ provider: 'p', model: 'm' }, { presetsAbsent: true })
    expect(resume).toHaveBeenCalledTimes(1)
    const setup = (resume.mock.calls[0]![0] as { setup?: unknown }).setup
    expect(typeof setup).toBe('function')
    expect(warn).toHaveBeenCalled()
    expect(String(warn.mock.calls.at(-1)![0])).toContain('agentPresets')
  })

  it('keeps model selection and warns when the preset cannot be observed (G9)', async () => {
    const { resume, warn } = await resumeOnce({ provider: 'p', model: 'm' }, { observeFails: true })
    expect(resume).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalled()
    // The model-selection half must survive a failed observation.
    const [, selection] = installSpy.mock.calls.at(-1)!
    expect(selection.current).toEqual({ provider: 'p', model: 'm' })
  })

  it('keeps model selection and warns when resolve/mount throws (G9)', async () => {
    const { resume, warn } = await resumeOnce({ provider: 'p', model: 'm' }, { resolveFails: true })
    expect(resume).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalled()
    const [, selection] = installSpy.mock.calls.at(-1)!
    expect(selection.current).toEqual({ provider: 'p', model: 'm' })
  })

  it('surfaces a mount failure instead of silently publishing a bare Agent (G9)', async () => {
    // Mount runs INSIDE setup, which the registry awaits before publishing, so a
    // throwing mount must propagate rather than be swallowed — a half-composed
    // Agent is exactly the silent degradation R18 was.
    await expect(resumeOnce({ provider: 'p', model: 'm' }, { mountFails: true })).rejects.toThrow('mount exploded')
  })

  it('★ takes the Agent from setup\'s SECOND argument — the 0.2.0-rc.2 contract', async () => {
    // Regression for the defect the running host reported. The shipped host
    // calls `setup?.(prepared.agent.ctx, prepared.agent)` (verified in the
    // deployed `resources/app.asar`), and the context it hands over is the
    // UNPUBLISHED Agent scope: it carries no scoped Agent, so
    // `agentCtx.get('agent')` finds nothing and every dormant wake died with
    // `s2s lifecycle: Agent setup has no scoped Agent`.
    //
    // The ctx below is deliberately bare — no `.agent` anywhere — so this test
    // fails against the previous code and can only pass by reading the second
    // argument.
    const { setup, agent } = await composeSetup({ provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' })
    await expect((setup as SetupFn)(new Context(), agent)).resolves.toBeUndefined()
    expect(installSpy).toHaveBeenCalledTimes(1)
    const [agentCtxArg, selection] = installSpy.mock.calls.at(-1)!
    // The selection must be installed on the Agent's own scope.
    expect(agentCtxArg).toBe(agent.ctx)
    expect(selection.current).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' })
  })

  it('still accepts a host that passes only the scope (older contract)', async () => {
    // The second parameter is optional on purpose: hosts that call
    // `setup(agentCtx)` alone must keep working through the `ctx.get` fallback.
    const { setup, agent } = await composeSetup({ provider: 'p', model: 'm' })
    const agentCtx = new Context()
    agentCtx.provide('agent', agent as never)
    await (setup as SetupFn)(agentCtx)
    const [agentCtxArg, selection] = installSpy.mock.calls.at(-1)!
    expect(agentCtxArg).toBe(agent.ctx)
    expect(selection.current).toEqual({ provider: 'p', model: 'm' })
  })

  it('rejects a setup that has neither a second argument nor a scoped Agent, like the host does', async () => {
    // The host's own setup throws 'Agent setup has no scoped Agent'
    // (session-controller/src/agent.ts, asserted by agent.host.spec.ts:446).
    // Mirroring that means a broken composition fails loudly instead of
    // publishing an Agent with no model selection installed.
    const { setup } = await composeSetup({ provider: 'p', model: 'm' })
    expect(setup).toBeTypeOf('function')
    // A bare Context has no scoped Agent, and no second argument is passed.
    await expect(setup!(new Context())).rejects.toThrow('no scoped Agent')
  })

  it('★ probes the scoped Agent with ctx.get, never with a property read', async () => {
    // cordis resolves `ctx.<service>` through a proxy that THROWS
    // `cannot get property "agent" without inject` for an undeclared service, so
    // `if (agentCtx.agent === undefined)` never runs — the read IS the failure.
    // Measured on the desktop host (0.2.0-rc.2): a dormant `s2s_resume` died with
    // exactly that error before the probe was switched to `ctx.get`.
    //
    // This guards the single-argument fallback path: the plugin's OWN error must
    // surface, never cordis's proxy error.
    //
    // The installed cordis here is 4.0.1, which does NOT throw on a bare read, so
    // a plain `new Context()` cannot reproduce it (a first version of this test
    // passed against the buggy code — a test that proved nothing). The throwing
    // proxy is therefore simulated explicitly: an own accessor that throws, which
    // is also how the host shadows `agent` on an Agent's own ctx.
    const { setup } = await composeSetup({ provider: 'p', model: 'm' })

    // A ctx that throws on `.agent` — the 0.2.x shape with no scoped agent.
    function throwingCtx(): Context {
      const c = new Context()
      Object.defineProperty(c, 'agent', {
        get() { throw new Error('cannot get property "agent" without inject') },
        configurable: true,
      })
      return c
    }
    // The plugin's OWN error must surface, never cordis's proxy error.
    await expect((setup as SetupFn)(throwingCtx())).rejects.toThrow('no scoped Agent')
    await expect((setup as SetupFn)(throwingCtx())).rejects.not.toThrow('without inject')
  })

  it('★ traces the deployment default when the session has no recorded preset (G9)', async () => {
    // The gap an adversarial review flagged on wake fidelity (G8): the mounted
    // preset was invisible in every artifact, so "restored the session's own
    // preset" and "silently got the deployment default" were indistinguishable.
    // `presetId = null` (no recorded preset) is exactly that case.
    const { warn } = await resumeOnce({ provider: 'p', model: 'm' })
    const last = String(warn.mock.calls.at(-1)![0])
    expect(last).toContain('no recorded agent preset')
    expect(last).toContain('default-preset') // the id actually mounted, not just "the default"
  })

  it('★ traces a SUBSTITUTED preset when resolve answers with another id (G9)', async () => {
    const { warn } = await resumeOnce(
      { provider: 'p', model: 'm' },
      { presetId: 'ops-default', resolveTo: 'fallback-preset' },
    )
    const last = String(warn.mock.calls.at(-1)![0])
    expect(last).toContain('ops-default') // what the session recorded
    expect(last).toContain('fallback-preset') // what it actually got
    expect(last).toContain('SUBSTITUTED')
  })

  it('traces the happy path positively — no substitution is a record, not silence (G9)', async () => {
    // Deliberately NOT `warn).not.toHaveBeenCalled()`: the point is that the
    // absence of a substitution warning is backed by a positive `info` record.
    const { info, warn } = await resumeOnce({ provider: 'p', model: 'm' }, { presetId: 'ops-default' })
    const warnText = warn.mock.calls.map((c) => String(c[0])).join('\n')
    expect(warnText).not.toContain('no recorded agent preset')
    expect(warnText).not.toContain('SUBSTITUTED')
    const trace = info.mock.calls.map((c) => String(c[0])).join('\n')
    expect(trace).toContain('ops-default')
  })

  it('★ keeps the same discriminator where a tool can read it back (T10)', async () => {
    // The traces above go to the logger, and on this host a logger leaves
    // nothing an outside reader can inspect: the transcript keeps no logger
    // output, `~/.dsh` has no host log directory, and a drained mailbox is
    // empty. So the identical discriminator is recorded on the service for
    // `s2s_status` to read after the fact. Verified: reading it back needs no
    // logger at all.
    const { lifecycle } = await resumeOnce(
      { provider: 'p', model: 'm' },
      { presetId: 'ops-default', resolveTo: 'fallback-preset' },
    )
    const report = lifecycle.resumeReport('sess-1')
    expect(report).toBeDefined()
    expect(report!.preset).toMatchObject({ recorded: 'ops-default', mounted: 'fallback-preset', substituted: true })
    expect(report!.preset!.detail).toContain('fallback-preset')
  })

  it('records an as-recorded resume as NOT substituted (T10)', async () => {
    // The positive case must be as readable as the alarming one, or "no warning
    // in the log" stays the only evidence that nothing was replaced.
    const { lifecycle } = await resumeOnce({ provider: 'p', model: 'm' }, { presetId: 'ops-default' })
    const report = lifecycle.resumeReport('sess-1')
    expect(report!.preset).toMatchObject({ recorded: 'ops-default', mounted: 'ops-default', substituted: false })
    expect(lifecycle.resumeReports_()).toHaveLength(1)
  })

  it('records why the preset half is missing when no preset service is mounted (T10)', async () => {
    const { lifecycle } = await resumeOnce({ provider: 'p', model: 'm' }, { presetsAbsent: true })
    const report = lifecycle.resumeReport('sess-1')
    expect(report!.preset).toBeUndefined()
    expect(String(report!.presetUnavailableReason)).toContain('agentPresets')
  })
})
