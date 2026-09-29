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

/**
 * Resume once and run the `setup` the lifecycle supplied — the setup is what a
 * real registry awaits before publishing the Agent, so asserting on it without
 * running it would prove nothing.
 */
async function resumeOnce(
  requestHeader?: { provider: string; model: string },
  opts: {
    presetId?: string
    presetsAbsent?: boolean
    observeFails?: boolean
    resolveFails?: boolean
    mountFails?: boolean
  } = {},
) {
  const mailboxDir = await mkdtemp(join(tmpdir(), 's2s-lm-'))
  dirs.push(mailboxDir)
  const ctx = new Context()
  // Capture the service's own logger, not console: that is what the code calls.
  const warn = vi.fn()
  ctx.logger.warn = warn as never
  const agent = makeAgent(requestHeader)
  const mount = vi.fn(async () => {
    if (opts.mountFails === true) throw new Error('mount exploded')
    return {}
  })
  const resolve = vi.fn(async (id?: string) => {
    if (opts.resolveFails === true) throw new Error('resolve exploded')
    return { id: id ?? 'default-preset' }
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
  const setup = (resume.mock.calls[0]![0] as { setup?: (c: Context) => unknown }).setup
  // The resumed Agent's scoped ctx carries the Agent (the host's setup contract).
  const agentCtx = Object.assign(new Context(), { agent })
  if (setup !== undefined) await setup(agentCtx)
  return { resume, agent, mount, resolve, setup, agentCtx, warn }
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

  it('rejects a setup ctx that carries no scoped Agent, like the host does', async () => {
    // The host's own setup throws 'Agent setup has no scoped Agent'
    // (session-controller/src/agent.ts, asserted by agent.host.spec.ts:446).
    // Mirroring that means a broken composition fails loudly instead of
    // publishing an Agent with no model selection installed.
    const mailboxDir = await mkdtemp(join(tmpdir(), 's2s-lm-'))
    dirs.push(mailboxDir)
    const ctx = new Context()
    ctx.provide('agentPresets', {
      resolve: async () => ({ id: 'p1' }),
      mount: async () => ({}),
    } as never)
    ctx.provide('sessionQuery', { observeSession: async () => ({ projections: { values: { agentPreset: null } } }) } as never)
    const resume = vi.fn(async () => ({ agent: makeAgent() }))
    ctx.provide('agents', { get: () => undefined, resume } as never)
    await ctx.plugin(s2sApply, { lifecycle: { autoResume: 'allow', mailboxDir } })
    const lifecycle = ctx.get('s2sLifecycle') as S2sLifecycleService
    await lifecycle.queueForDormant({ sessionId: 'sess-1', from: 'a', text: 't', msgId: 'm1' })
    const setup = (resume.mock.calls[0]![0] as { setup?: (c: Context) => unknown }).setup
    expect(setup).toBeTypeOf('function')
    // A bare Context has no `.agent` accessor value — the host rejects this too.
    await expect(setup!(new Context())).rejects.toThrow('no scoped Agent')
  })
})
