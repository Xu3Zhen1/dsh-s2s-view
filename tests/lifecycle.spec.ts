import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import * as sqliteStorage from '@deepseek-ai/dsh-storage-sqlite'
import { apply as s2sApply, S2sLifecycleService } from '../src/index.ts'
import { S2sLedger } from '../src/ledger.ts'

const dirs: string[] = []
const disposers: Array<() => Promise<void>> = []
afterEach(async () => {
  // Close ledgers / dispose contexts BEFORE removing their directories: an open
  // sqlite handle makes `rm` fail with EBUSY and turns a clean test into a red one.
  for (const dispose of disposers.splice(0)) {
    try { await dispose() } catch { /* cleanup must not mask the real result */ }
  }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function harness(autoResume: 'allow' | 'deny') {
  const mailboxDir = await mkdtemp(join(tmpdir(), 's2s-life-'))
  dirs.push(mailboxDir)
  const ctx = new Context()
  const followups: unknown[] = []
  const injections: unknown[] = []
  const agent = {
    id: 'sess-1',
    status: 'idle',
    // The lifecycle installs agent-scoped model selection on resume; give the
    // fake the minimal session + scoped ctx that path touches.
    session: { requestHeader: () => undefined },
    ctx: new Context(),
    followup: (message: unknown) => { followups.push(message) },
    inject: (message: unknown) => { injections.push(message) },
  }
  let live = false
  const resume = vi.fn(async () => {
    live = true
    return { agent, dispose: vi.fn() }
  })
  ctx.provide('agents', {
    get: (id: unknown) => live && String(id) === 'sess-1' ? agent : undefined,
    resume,
  } as never)
  await ctx.plugin(s2sApply, { lifecycle: { autoResume, mailboxDir } })
  const lifecycle = ctx.get('s2sLifecycle') as S2sLifecycleService
  return { ctx, lifecycle, resume, followups, injections, setLive: (value: boolean) => { live = value } }
}

/**
 * The same shape as `harness`, plus a **real, opened** ledger (sqlite over the
 * storage domain) so the dormant path's bookkeeping can be observed rather than
 * mocked. `storageDomain` must be mounted *before* the plugin, because `apply()`
 * opens the ledger asynchronously.
 */
async function ledgerHarness(autoResume: 'allow' | 'deny') {
  const root = await mkdtemp(join(tmpdir(), 's2s-t6b-'))
  dirs.push(root)
  const mailboxDir = await mkdtemp(join(tmpdir(), 's2s-life-'))
  dirs.push(mailboxDir)
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(sqliteStorage, { path: join(root, 'storage.db') })
  const facility = new DomainFacility(ctx, { backend: 'sqlite', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility as never)

  const followups: unknown[] = []
  const agent = {
    id: 'sess-1',
    status: 'idle',
    session: { requestHeader: () => undefined },
    ctx: new Context(),
    followup: (message: unknown) => { followups.push(message) },
    inject: () => {},
  }
  let live = false
  const resume = vi.fn(async () => {
    live = true
    return { agent, dispose: vi.fn() }
  })
  ctx.provide('agents', {
    get: (id: unknown) => live && String(id) === 'sess-1' ? agent : undefined,
    resume,
  } as never)
  await ctx.plugin(s2sApply, { lifecycle: { autoResume, mailboxDir } })
  const lifecycle = ctx.get('s2sLifecycle') as S2sLifecycleService
  const ledger = ctx.get('s2sLedger') as S2sLedger
  // `apply()` opens it in a floating async block; yield a macrotask so that
  // settles, then open only if it did not (the facility rejects a duplicate
  // domain open, so racing it directly would throw).
  await new Promise((resolve) => setTimeout(resolve, 0))
  if (!ledger.isOpen) await ledger.open()
  disposers.push(async () => { await ledger.close(); await ctx.fiber.dispose() })
  return { ctx, lifecycle, ledger, followups, resume }
}

describe('s2s lifecycle', () => {
  it('queues, resumes, and drains when autoResume=allow', async () => {
    const { lifecycle, resume, followups } = await harness('allow')
    const outcome = await lifecycle.queueForDormant({ sessionId: 'sess-1', from: 'alice', text: 'hello dormant', msgId: 'm1' })
    expect(outcome).toBe('resumed')
    expect(resume).toHaveBeenCalledTimes(1)
    // This harness mounts no `agentPresets` service, so the lifecycle takes its
    // documented degraded path: it still resumes, warns, and supplies only the
    // model-selection half of the setup (mirroring the host's `composeAgent`,
    // which does the same when `agentPresets` is absent). The full setup
    // including `presets.mount` is covered in lifecycle.model.spec.ts.
    expect(resume.mock.calls[0]![0]).toMatchObject({ resumeSessionId: 'sess-1' })
    expect(typeof (resume.mock.calls[0]![0] as { setup?: unknown }).setup).toBe('function')
    expect(followups).toHaveLength(1)
    expect(String((followups[0] as { content: { text: string }[] }).content[0]!.text)).toContain('[s2s-lifecycle message]')
    // The dormant path must carry the same msgId token as the broker's live
    // path, or a dormant delivery could never be matched to its log entry.
    expect(String((followups[0] as { content: { text: string }[] }).content[0]!.text)).toContain('msgId=m1')
    expect(String((followups[0] as { content: { text: string }[] }).content[0]!.text)).toContain('hello dormant')
    // Producer-owned kind: session format v4 refuses the retired `plugin` wrapper.
    const source = (followups[0] as { source: { kind: string; plugin?: string } }).source
    expect(source.kind).not.toBe('plugin')
    expect(source.plugin).toBeUndefined()
    expect(source.kind).toBe('dsh-s2s')
    expect(await lifecycle.queuedCount('sess-1')).toBe(0)
  })

  it('only queues when autoResume=deny', async () => {
    const { lifecycle, resume } = await harness('deny')
    const outcome = await lifecycle.queueForDormant({ sessionId: 'sess-1', from: 'alice', text: 'hold', msgId: 'm1' })
    expect(outcome).toBe('queued')
    expect(resume).not.toHaveBeenCalled()
    expect(await lifecycle.queuedCount('sess-1')).toBe(1)
  })

  it('delivers to an already-live session instead of stalling (never re-resumes)', async () => {
    const { lifecycle, resume, setLive, followups } = await harness('allow')
    setLive(true)
    const outcome = await lifecycle.queueForDormant({ sessionId: 'sess-1', from: 'alice', text: 'hi', msgId: 'm1' })
    expect(outcome).toBe('resumed')
    expect(resume).not.toHaveBeenCalled() // live session: never resume again
    expect(followups).toHaveLength(1) // delivered to the live idle agent
    expect(String((followups[0] as { content: { text: string }[] }).content[0]!.text)).toContain('hi')
    expect(await lifecycle.queuedCount('sess-1')).toBe(0) // no leftover
  })

  it('★ records WHY no preset was composed when the target was already live (T10)', async () => {
    // Found on the running host: this path returns before `resumedSetup`, so the
    // preset decision is never made — and before this fix nothing was recorded
    // either, so `s2s_status` printed "resumes: none recorded in this process"
    // for a wake that had visibly succeeded. An observation that exists but is
    // never recorded is indistinguishable from no observation at all.
    const { lifecycle, setLive } = await harness('allow')
    setLive(true)
    await lifecycle.queueForDormant({ sessionId: 'sess-1', from: 'alice', text: 'hi', msgId: 'm1' })

    const report = lifecycle.resumeReport('sess-1')
    expect(report).toBeDefined()
    expect(report!.preset).toBeUndefined()
    expect(String(report!.presetUnavailableReason)).toContain('already live')
  })

  it('rejects unsafe session ids loud', async () => {
    const { lifecycle } = await harness('deny')
    await expect(lifecycle.queueForDormant({ sessionId: '../evil', from: 'a', text: 't', msgId: 'm' })).rejects.toThrow(/unsafe/)
  })

  it('queues when the agent registry has no resume capability', async () => {
    const mailboxDir = await mkdtemp(join(tmpdir(), 's2s-life-'))
    dirs.push(mailboxDir)
    const ctx = new Context()
    ctx.provide('agents', { get: () => undefined } as never) // no resume
    await ctx.plugin(s2sApply, { lifecycle: { autoResume: 'allow', mailboxDir } })
    const lifecycle = ctx.get('s2sLifecycle') as S2sLifecycleService
    const outcome = await lifecycle.queueForDormant({ sessionId: 'sess-1', from: 'alice', text: 'x', msgId: 'm' })
    expect(outcome).toBe('queued')
  })

  it('★ advances a dormant delivery to inboxed (T6b)', async () => {
    // Before T6b the row stayed `queued` for the whole wake: the dormant path
    // handed the message to a live agent but never said so, so a status query
    // could not tell a delivered wake from a stuck queue entry.
    const { lifecycle, ledger } = await ledgerHarness('allow')
    await ledger.record({ msgId: 'm1', from: 'alice', to: 'sess-1', text: 'hello dormant' })
    const outcome = await lifecycle.queueForDormant({ sessionId: 'sess-1', from: 'alice', text: 'hello dormant', msgId: 'm1' })
    expect(outcome).toBe('resumed')

    const [row] = await ledger.query()
    expect(row).toMatchObject({ status: 'inboxed', resolvedSessionId: 'sess-1' })
    // §13.1: `record()` left it null; the delivery path is what fills it in.
    expect(row!.to !== null).toBe(true)
  })

  it('★ does NOT mark inboxed when the message was only queued (I1, T6b)', async () => {
    // autoResume=deny: nothing was handed to anybody. Advancing the row here
    // would report an acceptance that never happened — the overclaim I1 forbids,
    // and the dormant counterpart of the live path's `absent` case.
    const { lifecycle, ledger, resume } = await ledgerHarness('deny')
    await ledger.record({ msgId: 'm1', from: 'alice', to: 'sess-1', text: 'hold' })
    const outcome = await lifecycle.queueForDormant({ sessionId: 'sess-1', from: 'alice', text: 'hold', msgId: 'm1' })
    expect(outcome).toBe('queued')
    expect(resume).not.toHaveBeenCalled()

    const [row] = await ledger.query()
    expect(row!.status).toBe('queued')
    expect(row!.resolvedSessionId).toBeNull()
  })

  it('★ still drains when the ledger exists but was never opened (T6b)', async () => {
    // The real deployment shape: a `storageDomain`-less host still registers
    // `S2sLedger`, so `ledger !== undefined` while every write throws
    // `used before open()`. Bookkeeping must never outrank delivery on the
    // dormant path either — and the loss must not be silent (G9).
    const { lifecycle, followups, ctx } = await harness('allow')
    const warn = vi.fn()
    ctx.logger.warn = warn as never
    await lifecycle.queueForDormant({ sessionId: 'sess-1', from: 'alice', text: 'x', msgId: 'm1' })

    expect(followups).toHaveLength(1) // the wake happened regardless
    const text = warn.mock.calls.map((c) => String(c[0])).join('\n')
    expect(text).toContain('ledger.markInboxed() failed')
  })
})
