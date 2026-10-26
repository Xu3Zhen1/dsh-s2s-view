import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply as s2sApply } from '../src/index.ts'

const dirs: string[] = []
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })

describe('s2s entry apply config gating', () => {
  it('mounts budget and schedule when configured', async () => {
    const mailboxDir = await mkdtemp(join(tmpdir(), 's2s-idx-'))
    dirs.push(mailboxDir)
    const ctx = new Context()
    ctx.provide('tools', { register: vi.fn(() => () => {}) } as never)
    ctx.provide('agents', { get: () => undefined, resume: vi.fn() } as never)
    ctx.provide('sessions', { list: () => [] } as never)
    ctx.provide('sessionQuery', { listSessions: async () => [], readTitle: async () => undefined } as never)
    await ctx.plugin(s2sApply, { lifecycle: { autoResume: 'allow', mailboxDir }, budget: {}, schedule: { timerIntervalMs: 0 } })
    expect(ctx.get('s2sBroker')).toBeDefined()
    expect(ctx.get('s2sDiscovery')).toBeDefined()
    expect(ctx.get('s2sBudget')).toBeDefined()
    expect(ctx.get('s2sSchedule')).toBeDefined()
    expect(ctx.get('s2sLifecycle')).toBeDefined()
    await ctx.fiber.dispose()
  })
})

// A profile row that declares no `config` block hands the loader's value as
// `undefined`. The documented bare mount (broker + discovery + tools) must still
// mount; reading `config.lifecycle` off `undefined` used to throw
// `Cannot read properties of undefined (reading 'lifecycle')`.
// (Upstream fix v0.4.0-s2s.13, taken alongside the 0.2.x peer widening.)
describe('s2s entry apply bare mount', () => {
  function harness() {
    const ctx = new Context()
    ctx.provide('tools', { register: vi.fn(() => () => {}) } as never)
    ctx.provide('agents', { get: () => undefined, resume: vi.fn() } as never)
    ctx.provide('sessions', { list: () => [] } as never)
    ctx.provide('sessionQuery', { listSessions: async () => [], readTitle: async () => undefined } as never)
    return ctx
  }

  it('mounts with no config argument at all', async () => {
    const ctx = harness()
    await ctx.plugin(s2sApply)
    expect(ctx.get('s2sBroker')).toBeDefined()
    expect(ctx.get('s2sDiscovery')).toBeDefined()
    // Optional blocks stay unmounted on a bare mount.
    expect(ctx.get('s2sLifecycle')).toBeUndefined()
    expect(ctx.get('s2sBudget')).toBeUndefined()
    expect(ctx.get('s2sSchedule')).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('mounts when config is explicitly undefined', async () => {
    const ctx = harness()
    await ctx.plugin(s2sApply, undefined)
    expect(ctx.get('s2sBroker')).toBeDefined()
    expect(ctx.get('s2sDiscovery')).toBeDefined()
    await ctx.fiber.dispose()
  })
})

// ★★★ THE WIRING ITSELF (cross-review, 2026-10-26).
//
// Everything above tests that `apply` mounts the right services. schedule.spec.ts
// tests that `buildTools` reports the right thing given a `scheduleConfigured`
// value. Neither tests the line CONNECTING them:
//
//     ctx.plugin(toolsPlugin, { scheduleConfigured: config.schedule !== undefined })
//
// Cross-review proved the gap: deleting that argument, or hardcoding `false`,
// left the suite 483/483 GREEN. All status tests build `buildTools({...})` by
// hand (42 such sites; `s2s_status` appears 0 times in this file).
//
// ★ Why the obvious end-to-end test does NOT work (I tried it first, and it was
// a false green): with a schedule block configured the service MOUNTS, so the
// report is the mounted-state one and the wiring value never changes the text.
// Dropping the wire is only observable when a block IS configured but the
// service is MISSING — a state the real plugin cannot enter. So the only honest
// way to pin the connection is to observe the argument itself.
//
// ★ And this is exactly the shape review warned about: `scheduleConfigured`
// defaults to false, false renders as the BENIGN reading, so a dropped wire
// would make a configured host report "NOT CONFIGURED (benign)" — the precise
// misreport this fix exists to remove, behind a fully green suite.
describe('s2s_status wiring: config.schedule -> the value handed to toolsPlugin', () => {
  async function wiringFor(config: unknown): Promise<unknown> {
    const ctx = new Context()
    ctx.provide('tools', { register: vi.fn(() => () => {}) } as never)
    ctx.provide('agents', { get: () => undefined, resume: vi.fn() } as never)
    ctx.provide('sessions', { list: () => [] } as never)
    ctx.provide('sessionQuery', { listSessions: async () => [], readTitle: async () => undefined } as never)
    const seen: Array<{ name: unknown; config: unknown }> = []
    const original = ctx.plugin.bind(ctx)
    // Record every plugin mount before letting it through, so the assertion is
    // about what the REAL apply() passes, not about a reimplementation of it.
    vi.spyOn(ctx, 'plugin').mockImplementation(((p: any, c?: any) => {
      seen.push({ name: p, config: c })
      return (original as any)(p, c)
    }) as any)
    await ctx.plugin(s2sApply, config)
    await ctx.fiber.dispose()
    // Identify the toolsPlugin mount by the ONLY thing that distinguishes it:
    // it is the mount whose config carries `scheduleConfigured`. Matching on the
    // module identity is not reliable here (the spied value is the module
    // namespace, and several plugins export `apply`), so the key we are testing
    // is also the key we select on.
    const toolsMount = seen.find(function (s) {
      return s.config !== null && typeof s.config === 'object' && 'scheduleConfigured' in (s.config as object)
    })
    return toolsMount === undefined ? 'NO-TOOLS-MOUNT-WITH-scheduleConfigured' : (toolsMount.config as any).scheduleConfigured
  }

  it('WITH a schedule block, toolsPlugin receives scheduleConfigured = true', async () => {
    const mailboxDir = await mkdtemp(join(tmpdir(), 's2s-wire-'))
    dirs.push(mailboxDir)
    const got = await wiringFor({ lifecycle: { autoResume: 'allow', mailboxDir }, schedule: { timerIntervalMs: 0 } })
    // If the wire is dropped or hardcoded, this is `false` or the sentinel.
    expect(got).toBe(true)
  })

  it('WITHOUT a schedule block, toolsPlugin receives scheduleConfigured = false', async () => {
    const mailboxDir = await mkdtemp(join(tmpdir(), 's2s-wire-'))
    dirs.push(mailboxDir)
    const got = await wiringFor({ lifecycle: { autoResume: 'allow', mailboxDir } })
    // The reverse direction: a wire hardcoded to `true` would make every host
    // report MOUNT FAILED.
    expect(got).toBe(false)
  })
})
