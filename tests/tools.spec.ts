import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply as toolsApply } from '../src/tools.ts'

describe('s2s tools', () => {
  it('registers the 9-tool family and disposes on teardown', async () => {
    const ctx = new Context()
    const registered: Array<{ name: string }> = []
    let disposer: () => void = () => {}
    ctx.provide('tools', { register: (d: { name: string }) => { registered.push(d); disposer = vi.fn(); return disposer } } as never)
    ctx.provide('s2sBroker', { deliver: vi.fn(), history: vi.fn(() => []) } as never)
    ctx.provide('s2sDiscovery', { list: async () => [], resolve: async () => ({ kind: 'not-found', name: 'x', candidates: [] }) } as never)
    await ctx.plugin(toolsApply)
    // Both test files assert the registered tool-name list, but they cover
    // DIFFERENT plugin sets: this one mounts only `toolsApply` (so no
    // `s2s_digest`), while `tests/composition.spec.ts` mounts the full set
    // including `digestPlugin`. A tool added to `tools.ts` must therefore be
    // added to BOTH lists; a tool that another plugin provides belongs only in
    // the file that mount that plugin. (Getting this wrong in the "both must
    // move together" direction is the cheaper mistake — a red test — but it
    // teaches the wrong rule for the next tool that is not ours.)
    //
    // The stub discovery above deliberately lacks `resolveLatestOf`: registration
    // must not depend on any service METHOD existing, only on the service being
    // present. That is why `s2s_latest` still registers here.
    expect(registered.map(t => t.name)).toEqual(['s2s_peers', 's2s_sessions', 's2s_latest', 's2s_message', 's2s_resume', 's2s_status', 's2s_reconcile', 's2s_history', 's2s_schedule'])
    await ctx.fiber.dispose()
    expect(disposer).toHaveBeenCalled()
  })
})

