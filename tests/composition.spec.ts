import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply as s2sApply } from '../src/index.ts'

async function harness() {
  const ctx = new Context()
  const registered: Array<{ name: string }> = []
  ctx.provide('tools', { register: (d: { name: string }) => { registered.push(d); return () => {} } } as never)
  const agent = { id: 'sess-1', status: 'idle', followup: vi.fn(), inject: vi.fn() }
  ctx.provide('agents', { get: (id: unknown) => String(id) === 'sess-1' ? agent : undefined } as never)
  ctx.provide('sessions', { list: () => [] } as never)
  ctx.provide('sessionQuery', { listSessions: async () => [], readTitle: async () => undefined } as never)
  await ctx.plugin(s2sApply, { lifecycle: { autoResume: 'deny' } })
  return { ctx, registered, agent }
}

describe('s2s composition', () => {
  it('mounts broker + discovery and registers the 9 tools', async () => {
    const { ctx, registered } = await harness()
    expect(ctx.get('s2sBroker')).toBeDefined()
    expect(ctx.get('s2sDiscovery')).toBeDefined()
    // NOTE (observed, not assumed): src/index.ts mounts toolsPlugin *before*
    // digestPlugin, yet `s2s_digest` registers *first* here. The order below is
    // what this harness actually produces — don't "fix" it to match
    // src/index.ts. Update this list whenever a tool is added or removed.
    expect(registered.map(t => t.name)).toEqual(['s2s_digest', 's2s_peers', 's2s_sessions', 's2s_message', 's2s_resume', 's2s_status', 's2s_reconcile', 's2s_history', 's2s_schedule'])
    await ctx.fiber.dispose()
  })

  /**
   * T15: the lineage service must be mounted by `apply()`.
   *
   * ★ This is not a formality — it is the assertion for a defect observed in this
   * very batch. `src/lineage.ts` type-checked, its 13 unit tests passed, and
   * `pnpm run build` reported all green, yet `lib/index.js` contained **zero**
   * occurrences of `s2sLineage`: nothing imported it, so `tsdown` tree-shook it
   * away and the product stayed byte-identical to the previously deployed copy
   * (`D993F02E…` / 222757 B before, `F9D94B09…` / 230368 B after mounting). A
   * unit test against the class cannot catch that, because the class is fine —
   * what is missing is the *mount*. So the criterion has to live here, where
   * composition is the subject.
   *
   * The pair below is what makes it discriminating: mount ⇒ present, and the
   * negative half proves the assertion reports absence rather than being true
   * because everything is always present.
   */
  it('mounts the lineage service (T15) — and a bare Context does not have it', async () => {
    const { ctx } = await harness()
    expect(ctx.get('s2sLineage')).toBeDefined()
    await ctx.fiber.dispose()

    const bare = new Context()
    expect(bare.get('s2sLineage')).toBeUndefined()
    await bare.fiber.dispose()
  })
})

