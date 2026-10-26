import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { S2sScheduleService } from '../src/schedule.ts'
import '../src/types.ts'

const dirs: string[] = []
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })

async function makeService(agentsGet: (id: unknown) => unknown, lifecycle?: unknown) {
  const dir = await mkdtemp(join(tmpdir(), 's2s-sched-'))
  dirs.push(dir)
  const ctx = new Context()
  ctx.provide('agents', { get: agentsGet } as never)
  if (lifecycle !== undefined) ctx.provide('s2sLifecycle', lifecycle as never)
  await ctx.plugin(S2sScheduleService, { dir, timerIntervalMs: 0 })
  const svc = ctx.get('s2sSchedule') as S2sScheduleService
  return { ctx, svc, dir }
}

function idleAgent() {
  const followups: unknown[] = []
  const agent = {
    id: 'sess-1',
    status: 'idle' as const,
    session: { requestHeader: () => undefined } as never,
    ctx: new Context(),
    followup: (m: unknown) => { followups.push(m) },
    inject: () => {},
  }
  return { agent, followups }
}

function busyAgent() {
  const followups: unknown[] = []
  const agent = {
    id: 'sess-1',
    status: 'running' as const,
    session: { requestHeader: () => undefined } as never,
    ctx: new Context(),
    followup: (m: unknown) => { followups.push(m) },
    inject: () => {},
  }
  return { agent, followups }
}

describe('s2s schedule service', () => {
  it('create + list + cancel round-trip', async () => {
    const { svc } = await makeService(() => undefined)
    const job = await svc.create({ targetSessionId: 'sess-1', text: 'hello', everySeconds: 600 })
    expect(job.id).toMatch(/^sched-/)
    expect(job.enabled).toBe(true)
    expect(job.everySeconds).toBe(600)
    expect(job.nextAt).toBeGreaterThan(Date.now())
    const list = await svc.list()
    expect(list).toHaveLength(1)
    expect(list[0]!.text).toBe('hello')
    expect(await svc.cancel(job.id)).toBe(true)
    expect(await svc.cancel(job.id)).toBe(false)
    expect(await svc.list()).toHaveLength(0)
  })

  it('create validates inputs', async () => {
    const { svc } = await makeService(() => undefined)
    await expect(svc.create({ id: '../evil', targetSessionId: 'sess-1', text: 'x', everySeconds: 600 })).rejects.toThrow(/unsafe schedule id/)
    await expect(svc.create({ targetSessionId: '../evil', text: 'x', everySeconds: 600 })).rejects.toThrow(/unsafe target session/)
    await expect(svc.create({ targetSessionId: 'sess-1', text: '', everySeconds: 600 })).rejects.toThrow(/must not be empty/)
    await expect(svc.create({ targetSessionId: 'sess-1', text: 'x' })).rejects.toThrow(/exactly one/)
    await expect(svc.create({ targetSessionId: 'sess-1', text: 'x', everySeconds: 600, atIso: new Date(Date.now() + 60000).toISOString() })).rejects.toThrow(/exactly one/)
    await expect(svc.create({ targetSessionId: 'sess-1', text: 'x', everySeconds: 0 })).rejects.toThrow(/positive/)
  })

  it('sub-5-minute everySeconds collapses to a one-shot at', async () => {
    const { svc } = await makeService(() => undefined)
    const job = await svc.create({ targetSessionId: 'sess-1', text: 'x', everySeconds: 60 })
    expect(job.everySeconds).toBeUndefined()
    expect(job.atIso).toBeDefined()
  })

  it('tick retries a one-shot whose target is busy, then injects once idle (regression)', async () => {
    const { agent, followups } = busyAgent()
    const { svc } = await makeService((id) => String(id) === 'sess-1' ? agent : undefined)
    const job = await svc.create({ targetSessionId: 'sess-1', text: 'must-land', atIso: new Date(Date.now() - 1000).toISOString() })
    // busy: not injected, not dropped, next fire pushed forward
    expect(await svc.tick(Date.now())).toBe(0)
    expect(followups).toHaveLength(0)
    let after = (await svc.list())[0]!
    expect(after.enabled).toBe(true)
    const retryAt = after.nextAt
    // target becomes idle: the one-shot lands exactly once then retires
    agent.status = 'idle'
    expect(await svc.tick(retryAt + 1)).toBe(1)
    expect(followups).toHaveLength(1)
    after = (await svc.list())[0]!
    expect(after.enabled).toBe(false)
  })
  it('tick injects into an idle target via followup', async () => {
    const { agent, followups } = idleAgent()
    const { svc } = await makeService((id) => String(id) === 'sess-1' ? agent : undefined)
    const job = await svc.create({ targetSessionId: 'sess-1', text: 'run it', everySeconds: 600 })
    const now = job.nextAt + 1
    expect(await svc.tick(now)).toBe(1)
    expect(followups).toHaveLength(1)
    const msg = followups[0] as { content: { text: string }[]; source: { kind: string } }
    // Producer-owned kind: session format v4 refuses the retired `plugin` wrapper.
    expect(msg.source.kind).toBe('dsh-s2s')
    expect(msg.content[0]!.text).toContain('run it')
    expect(msg.content[0]!.text).toContain('[s2s schedule]')
  })

  it('tick pushes a busy target forward without injecting', async () => {
    const { agent, followups } = busyAgent()
    const { svc } = await makeService((id) => String(id) === 'sess-1' ? agent : undefined)
    const job = await svc.create({ targetSessionId: 'sess-1', text: 'x', everySeconds: 600 })
    const now = job.nextAt + 1
    expect(await svc.tick(now)).toBe(0)
    expect(followups).toHaveLength(0)
    const after = (await svc.list())[0]!
    expect(after.nextAt).toBe(now + 600000)
  })

  it('tick delegates an absent (dormant) target to the lifecycle when mounted', async () => {
    const q = vi.fn(async () => 'resumed')
    const { svc } = await makeService(() => undefined, { queueForDormant: q })
    const job = await svc.create({ targetSessionId: 'sess-1', text: 'wake me', everySeconds: 600 })
    expect(await svc.tick(job.nextAt + 1)).toBe(1)
    expect(q).toHaveBeenCalledTimes(1)
    expect(q.mock.calls[0]![0]).toMatchObject({ sessionId: 'sess-1', from: 's2s-schedule', text: 'wake me' })
  })

  it('★ tick does NOT count a target-policy REFUSAL as fired (I1)', async () => {
    // Found while auditing the discarded return value: `fired += 1` used to run
    // unconditionally after `queueForDormant`, so a job whose message the target
    // policy refused (archived/subagent/unknown target) incremented the success
    // count AND had its one-shot consumed by `settleMissed` — a prompt that was
    // cancelled reported as delivered, and gone forever.
    //
    // Both halves are asserted: the count must not include it, AND the refusal
    // must leave a trace. A fix that silently skipped counting would pass the
    // first assertion while being equally unobservable (the G9 rule this repo
    // keeps re-learning: "no trace" is indistinguishable from "fine").
    const q = vi.fn(async () => ({
      kind: 'refused' as const,
      code: 'S2S_ARCHIVED_TARGET' as const,
      message: 'the session is archived',
      items: [{ msgId: 'm-1', code: 'S2S_ARCHIVED_TARGET' as const, message: 'the session is archived', cancelOutcome: 'cancelled' }],
    }))
    const { svc, ctx } = await makeService(() => undefined, { queueForDormant: q })
    const warn = vi.fn()
    ctx.logger.warn = warn as never
    const job = await svc.create({ targetSessionId: 'sess-1', text: 'must-not-vanish', atIso: new Date(Date.now() - 1000).toISOString() })
    expect(await svc.tick(job.nextAt + 1)).toBe(0) // NOT fired
    expect(q).toHaveBeenCalledTimes(1)
    // Loud retirement, naming the policy code — not a silent skip.
    const text = warn.mock.calls.map((c) => String(c[0])).join('\n')
    expect(text).toContain('REFUSED')
    expect(text).toContain('S2S_ARCHIVED_TARGET')
    expect(text).toContain('NOT delivered')
    // The one-shot is retired rather than retried every second against an
    // ineligible target (that would be a 1s infinite loop).
    const after = (await svc.list())[0]!
    expect(after.enabled).toBe(false)
  })

  it('tick still counts a QUEUED dormant handover (autoResume=deny)', async () => {
    // The other side of the same branch: `'queued'` means the entry really is in
    // the mailbox and will be drained on reopen. Counting it is honest, and
    // retrying instead would enqueue a duplicate every tick.
    const q = vi.fn(async () => 'queued' as const)
    const { svc } = await makeService(() => undefined, { queueForDormant: q })
    const job = await svc.create({ targetSessionId: 'sess-1', text: 'hold it', everySeconds: 600 })
    expect(await svc.tick(job.nextAt + 1)).toBe(1)
    expect(q).toHaveBeenCalledTimes(1)
  })

  it('tick counts both already-live and resumed handovers', async () => {
    // The three-way outcome split must not accidentally drop these two, which
    // ARE successful handovers even though only one of them resumed anything.
    for (const outcome of ['resumed', 'already-live'] as const) {
      const q = vi.fn(async () => outcome)
      const { svc } = await makeService(() => undefined, { queueForDormant: q })
      const job = await svc.create({ targetSessionId: 'sess-1', text: 'wake', everySeconds: 600 })
      expect(await svc.tick(job.nextAt + 1)).toBe(1)
    }
  })

  it('tick retries (never drops) a one-shot whose target is absent with no lifecycle', async () => {
    const { svc } = await makeService(() => undefined)
    const job = await svc.create({ targetSessionId: 'sess-1', text: 'once', atIso: new Date(Date.now() - 1000).toISOString() })
    expect(await svc.tick(Date.now())).toBe(0)
    const after = (await svc.list())[0]!
    expect(after.enabled).toBe(true) // not dropped; retried
    expect(after.nextAt).toBeGreaterThan(Date.now())
  })

  it('a one-shot idle target fires once then disables', async () => {
    const { agent, followups } = idleAgent()
    const { svc } = await makeService((id) => String(id) === 'sess-1' ? agent : undefined)
    const job = await svc.create({ targetSessionId: 'sess-1', text: 'once', atIso: new Date(Date.now() - 1000).toISOString() })
    expect(await svc.tick(Date.now())).toBe(1)
    expect(followups).toHaveLength(1)
    const after = (await svc.list())[0]!
    expect(after.enabled).toBe(false)
  })

  it('reloads persisted jobs on a fresh instance (replay)', async () => {
    const { svc, dir } = await makeService(() => undefined)
    await svc.create({ targetSessionId: 'sess-1', text: 'persist', everySeconds: 600 })
    const ctx2 = new Context()
    ctx2.provide('agents', { get: () => undefined } as never)
    await ctx2.plugin(S2sScheduleService, { dir, timerIntervalMs: 0 })
    const svc2 = ctx2.get('s2sSchedule') as S2sScheduleService
    expect(await svc2.list()).toHaveLength(1)
    expect((await svc2.list())[0]!.text).toBe('persist')
  })

  it('skips a corrupt job file on load', async () => {
    const { writeFile } = await import('node:fs/promises')
    const { svc, dir } = await makeService(() => undefined)
    await writeFile(join(dir, 'bad.json'), 'not json', 'utf8')
    const ctx2 = new Context()
    ctx2.provide('agents', { get: () => undefined } as never)
    await ctx2.plugin(S2sScheduleService, { dir, timerIntervalMs: 0 })
    const svc2 = ctx2.get('s2sSchedule') as S2sScheduleService
    expect(await svc2.list()).toHaveLength(0)
  })

  it('★ a corrupt job file is SKIPPED but not SILENT (G9)', async () => {
    // The old body was `catch { /* skip a corrupt job file */ }` — the job was
    // dropped with no trace anywhere, and the plugin logger is not persisted in
    // this host, so afterwards nothing could distinguish "that prompt was never
    // scheduled" from "it was scheduled and silently lost". Same defect family
    // as the `(untitled)` digest column and the discarded queueForDormant value.
    const { writeFile } = await import('node:fs/promises')
    const { dir } = await makeService(() => undefined)
    await writeFile(join(dir, 'bad.json'), 'not json', 'utf8')
    await writeFile(join(dir, 'noid.json'), JSON.stringify({ text: 'has no id' }), 'utf8')
    await writeFile(join(dir, 'good.json'), JSON.stringify({ id: 'ok-1', targetSessionId: 'sess-1', text: 'kept', nextAt: Date.now() + 60000, enabled: true, createdAt: Date.now() }), 'utf8')

    const ctx2 = new Context()
    const warn = vi.fn()
    ctx2.logger.warn = warn as never
    ctx2.provide('agents', { get: () => undefined } as never)
    await ctx2.plugin(S2sScheduleService, { dir, timerIntervalMs: 0 })
    const svc2 = ctx2.get('s2sSchedule') as S2sScheduleService
    // The good job still loads; the two bad ones do not.
    expect(await svc2.list()).toHaveLength(1)
    // …but both are RECORDED with their reason, and both warned.
    expect(svc2.loadErrors).toHaveLength(2)
    expect(svc2.loadErrors.join('\n')).toContain('bad.json')
    expect(svc2.loadErrors.join('\n')).toContain('noid.json')
    const said = warn.mock.calls.map((c) => String(c[0])).join('\n')
    expect(said).toContain('will NOT fire')
    expect(said).toContain('SKIPPED')
  })

  it('★ a schedule directory that does not exist is GENUINELY EMPTY (no false alarm)', async () => {
    // The other side of the same branch, and the reason the code must special-case
    // ENOENT: a deployment that never scheduled anything has no directory, and
    // reporting that as an error would make the normal state look broken.
    //
    // ★ MEASURED BOUNDARY (2026-10-26): on Windows `readdir` reports **ENOENT**
    // for a path whose parent is a regular FILE (`ENOTDIR` is not surfaced), so
    // "path blocked by a file" and "directory absent" are INDISTINGUISHABLE
    // here. I could not construct a portable non-ENOENT failure, so the
    // error branch is asserted only structurally (below) and its runtime path
    // stays unverified. Say so rather than claim coverage.
    const ctx2 = new Context()
    const warn = vi.fn()
    ctx2.logger.warn = warn as never
    ctx2.provide('agents', { get: () => undefined } as never)
    const missing = await mkdtemp(join(tmpdir(), 's2s-sched-'))
    dirs.push(missing)
    await ctx2.plugin(S2sScheduleService, { dir: join(missing, 'never-created', 'schedules'), timerIntervalMs: 0 })
    const svc2 = ctx2.get('s2sSchedule') as S2sScheduleService
    expect(await svc2.list()).toHaveLength(0)
    expect(svc2.loadErrors).toHaveLength(0) // absent ≠ unreadable
    expect(warn).not.toHaveBeenCalled()
  })

  it('★ load() distinguishes ENOENT from other readdir failures (structural)', async () => {
    // Structural because the runtime failure is not constructible on Windows
    // (see the test above). This pins the guard itself: the error branch must
    // test the code and must NOT be an unconditional `.catch(() => [])`, which
    // was the original defect — an unreadable directory read as "no jobs".
    const { readFile: readSource } = await import('node:fs/promises')
    const src = await readSource(new URL('../src/schedule.ts', import.meta.url), 'utf8')
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n')
    // The old silent form must be gone.
    expect(code).not.toContain(".catch(() => [] as string[])")
    expect(code).not.toContain('catch { /* skip a corrupt job file */ }')
    // And the classification must key on ENOENT explicitly.
    expect(code).toContain("code !== 'ENOENT'")
    expect(code).toContain('loadErrors.push')
  })

  it('★ loadErrors is READABLE from s2s_status — through a REAL load(), not a hand-set array', async () => {
    // Cross-review caught the first version of this test reading a HAND-SET
    // array (`svc.loadErrors = [...]`). That proves the renderer prints whatever
    // it is given; it does not touch the thing this batch fixed — whether what
    // `load()` produced can reach the report. Worse, hand-setting masked a real
    // defect (fixed below): `ready` was un-awaited, so status read an EMPTY
    // array right after mount and said "0 failed" while a file had just been
    // dropped.
    //
    // So: write a genuinely corrupt job file, mount, then call the real tool
    // with NO manual assignment and NO manual wait — the tool itself must
    // await the replay.
    const { writeFile } = await import('node:fs/promises')
    const { buildTools } = await import('../src/tools.ts')
    const dir = await mkdtemp(join(tmpdir(), 's2s-sched-'))
    dirs.push(dir)
    await writeFile(join(dir, 'bad.json'), 'not json', 'utf8')
    const ctx = new Context()
    ctx.provide('agents', { get: () => undefined } as never)
    await ctx.plugin(S2sScheduleService, { dir, timerIntervalMs: 0 })
    const defs = buildTools({
      ctx,
      broker: { deliver: vi.fn(), history: vi.fn(() => []) },
      discovery: {
        list: vi.fn(async () => []),
        resolve: vi.fn(async () => ({ kind: 'not-found', name: 'x', candidates: [] }) as any),
        archivedFilterState: vi.fn(() => ({ state: 'available', ids: [] as string[] })),
        targetPolicyVerdict: vi.fn(() => undefined),
        classifyTarget: vi.fn(() => 'eligible' as const),
      },
    } as any)
    const status = defs.find((d) => d.name === 's2s_status') as unknown as { execute: (a: any, e: any) => Promise<{ text: string }> }
    // Called IMMEDIATELY — no await, no sleep. If the tool does not await the
    // replay, this is exactly the call that used to report 0.
    const out = await status.execute({}, { agent: { id: 'sess-a' } })
    expect(out.text).toContain('schedule replay: 1 persisted job(s) FAILED to load')
    expect(out.text).toContain('bad.json')
    expect(out.text).not.toContain('schedule replay: 0 persisted job(s) failed')
  })

  it('★ the mount-time replay is AWAITED before the report is computed (race)', async () => {
    // The defect in isolation, without the tool: reading straight after mount
    // must already see the failure. Measured before the fix: 0 at t=0, 1 at
    // t=50 ms — i.e. the self-report lied at the only moment it mattered.
    const { writeFile } = await import('node:fs/promises')
    const dir = await mkdtemp(join(tmpdir(), 's2s-sched-'))
    dirs.push(dir)
    await writeFile(join(dir, 'bad.json'), 'not json', 'utf8')
    const ctx = new Context()
    ctx.provide('agents', { get: () => undefined } as never)
    await ctx.plugin(S2sScheduleService, { dir, timerIntervalMs: 0 })
    const svc = ctx.get('s2sSchedule') as S2sScheduleService
    // `ready` is public precisely so a reader can join it instead of racing it.
    await svc.ready
    expect(svc.loadErrors).toHaveLength(1)
  })

  it('★ an UNREADABLE schedule dir is behaviourally verifiable (ENOTDIR) — not just structural', async () => {
    // ★ CORRECTION (2026-10-26, cross-review): I previously recorded this branch
    // as "runtime-unconstructible" because I only tried `readdir(<parent is a
    // file>/sub)`, which yields ENOENT on Windows. The right shape is to make
    // the configured `dir` ITSELF a regular file:
    //     readdir(<parent is a file>/sub) => ENOENT
    //     readdir(<dir itself is a file>) => ENOTDIR   ← the non-ENOENT branch
    // So the branch DOES have behaviour evidence; the "cannot verify" note in
    // docs was wrong and has been retracted.
    const { writeFile } = await import('node:fs/promises')
    const root = await mkdtemp(join(tmpdir(), 's2s-sched-'))
    dirs.push(root)
    const asFile = join(root, 'schedules')
    await writeFile(asFile, 'this is a file, not a directory', 'utf8')

    const ctx = new Context()
    const warn = vi.fn()
    ctx.logger.warn = warn as never
    ctx.provide('agents', { get: () => undefined } as never)
    await ctx.plugin(S2sScheduleService, { dir: asFile, timerIntervalMs: 0 })
    const svc = ctx.get('s2sSchedule') as S2sScheduleService
    await svc.ready // the replay must have completed before we judge it

    expect(svc.loadErrors).toHaveLength(1)
    expect(svc.loadErrors[0]).toContain('ENOTDIR')
    // and it is loud, not silent
    const said = warn.mock.calls.map((c) => String(c[0])).join('\n')
    expect(said).toContain('may be MISSING')
  })

  it('s2s_status says so when nothing failed to load (no false alarm)', async () => {
    const { buildTools } = await import('../src/tools.ts')
    const ctx = new Context()
    ctx.provide('agents', { get: () => undefined } as never)
    await ctx.plugin(S2sScheduleService, { dir: join(await mkdtemp(join(tmpdir(), 's2s-sched-'))), timerIntervalMs: 0 })
    const defs = buildTools({
      ctx,
      broker: { deliver: vi.fn(), history: vi.fn(() => []) },
      discovery: {
        list: vi.fn(async () => []),
        resolve: vi.fn(async () => ({ kind: 'not-found', name: 'x', candidates: [] }) as any),
        archivedFilterState: vi.fn(() => ({ state: 'available', ids: [] as string[] })),
        targetPolicyVerdict: vi.fn(() => undefined),
        classifyTarget: vi.fn(() => 'eligible' as const),
      },
    } as any)
    const status = defs.find((d) => d.name === 's2s_status') as unknown as { execute: (a: any, e: any) => Promise<{ text: string }> }
    const out = await status.execute({}, { agent: { id: 'sess-a' } })
    expect(out.text).toContain('schedule replay: 0 persisted job(s) failed to load')
  })

  it('★ a FAILED mount-time replay reports UNKNOWN instead of throwing (defensive branch)', async () => {
    // Cross-review caught this branch as UNTESTED and effectively unreachable:
    // `load()` swallows its own errors into `loadErrors`, so `ready` almost
    // never rejects. Two honest options were open — delete the branch, or pin
    // it with a test. Deleting would mean that if `load()` ever starts
    // rejecting, `s2s_status` dies rather than reporting. So the branch stays,
    // and this test pins its wording AND the "never throw" property by
    // injecting a rejecting `ready` (readonly is compile-time only).
    const { buildTools } = await import('../src/tools.ts')
    const ctx = new Context()
    ctx.provide('agents', { get: () => undefined } as never)
    await ctx.plugin(S2sScheduleService, { dir: await mkdtemp(join(tmpdir(), 's2s-sched-')), timerIntervalMs: 0 })
    const svc = ctx.get('s2sSchedule') as S2sScheduleService
    // Force the defensive path: a replay that rejects.
    Object.defineProperty(svc, 'ready', {
      value: Promise.reject(new Error('synthetic replay failure')),
      configurable: true,
    })
    const defs = buildTools({
      ctx,
      broker: { deliver: vi.fn(), history: vi.fn(() => []) },
      discovery: {
        list: vi.fn(async () => []),
        resolve: vi.fn(async () => ({ kind: 'not-found', name: 'x', candidates: [] }) as any),
        archivedFilterState: vi.fn(() => ({ state: 'available', ids: [] as string[] })),
        targetPolicyVerdict: vi.fn(() => undefined),
        classifyTarget: vi.fn(() => 'eligible' as const),
      },
    } as any)
    const status = defs.find((d) => d.name === 's2s_status') as unknown as { execute: (a: any, e: any) => Promise<{ text: string }> }
    // Must NOT throw, and must say the report is unknown rather than "0 failed".
    const out = await status.execute({}, { agent: { id: 'sess-a' } })
    expect(out.text).toContain('schedule replay: UNKNOWN')
    expect(out.text).toContain('replay itself FAILED')
    expect(out.text).toContain('synthetic replay failure')
  })
})
