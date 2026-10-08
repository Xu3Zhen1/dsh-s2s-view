import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import * as sqliteStorage from '@deepseek-ai/dsh-storage-sqlite'
import { buildTools } from '../src/tools.ts'
import { S2sLedger } from '../src/ledger.ts'

/**
 * T26: the reconcile pass has to be *reachable*, not just correct.
 *
 * T7 built `reconcile()` and T8 gave it a cache, but nothing called it, so an
 * `inboxed` row stayed `inboxed` forever and "tracked" read like "delivered".
 * These tests drive the tool surface that makes it runnable, and check that the
 * wording never claims more than actually happened (I1).
 */

type Tool = { name: string; execute: (args: any, exec: any) => Promise<{ text: string }> | { text: string } }

const dirs: string[] = []
const disposers: Array<() => Promise<void>> = []
afterEach(async () => {
  // Close ledgers before removing their directories: an open sqlite handle makes
  // `rm` fail EBUSY, which surfaces as a red test pointing at cleanup rather
  // than at the code under test.
  for (const dispose of disposers.splice(0)) {
    try { await dispose() } catch { /* cleanup must not mask the real result */ }
  }
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

/** One `user/message` record carrying an s2s header at a known `seq`. */
function s2sRecord(seq: number, msgId: string, from = 'alice') {
  return {
    type: 'user/message',
    seq,
    time: Date.now(),
    data: {
      source: { kind: 'dsh-s2s' },
      content: [{ type: 'text', text: `[s2s message] msgId=${msgId} from=${from} at=2026-10-03T10:00:00.000Z\nbody` }],
    },
  }
}

/** A real ledger over sqlite, wired into the tool family, with a fake log. */
async function harness(opts: { events?: readonly unknown[]; readFails?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 's2s-tools-reconcile-'))
  dirs.push(root)
  const ctx = new Context()
  ctx.logger.warn = vi.fn() as never
  await ctx.plugin(Storage)
  await ctx.plugin(sqliteStorage, { path: join(root, 'storage.db') })
  const facility = new DomainFacility(ctx, { backend: 'sqlite', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility as never)
  ctx.provide('sessionQuery', {
    readSession: async () => {
      if (opts.readFails === true) throw new Error('log unreadable')
      return { events: opts.events ?? [] }
    },
  } as never)
  const ledger = new S2sLedger(ctx)
  await ledger.open()
  disposers.push(async () => { await ledger.close(); await ctx.fiber.dispose() })

  const broker = { deliver: vi.fn(() => 'idle' as const), history: vi.fn(() => [] as any[]) }
  const discovery = {
    list: vi.fn(async () => [] as any[]),
    resolve: vi.fn(async () => ({ kind: 'ok', sessionId: 'sess-1', title: 'a', state: 'live-idle', workspaceDir: 'ws' }) as any),
  }
  const defs = buildTools({ ctx, broker, discovery, ledger } as any)
  const by = (n: string) => defs.find((d) => d.name === n) as unknown as Tool
  return { ctx, ledger, by, broker, discovery }
}

/** Record + hand over one message, leaving it `inboxed`. */
async function inboxed(ledger: S2sLedger, msgId: string, to = 'sess-1') {
  await ledger.record({ msgId, from: 'alice', to, text: 'x' })
  await ledger.markInboxed(msgId, to)
}

describe('s2s_reconcile (T26 wiring)', () => {
  it('★ advances an inboxed row to landed when the log has it', async () => {
    const { ctx, ledger, by } = await harness({ events: [s2sRecord(399, 'm-1')] })
    await inboxed(ledger, 'm-1')

    const out = await by('s2s_reconcile').execute({ name: 'a' }, { agent: { id: 'sess-a' } })

    expect(out.text).toContain('Advanced 1 of 1')
    const [row] = await ledger.query({ sessionId: 'sess-1' })
    expect(row).toMatchObject({ status: 'landed', landedSeq: 399 })
    await ctx.fiber.dispose()
  })

  it('★ does NOT claim delivery when the log does not contain the msgId', async () => {
    // The whole point of landing: our own `inboxed` bookkeeping is not evidence.
    const { ctx, ledger, by } = await harness({ events: [s2sRecord(10, 'other')] })
    await inboxed(ledger, 'm-1')

    const out = await by('s2s_reconcile').execute({ name: 'a' }, { agent: { id: 'sess-a' } })

    expect(out.text).toContain('none newly landed')
    expect(out.text).not.toContain('Advanced')
    const [row] = await ledger.query({ sessionId: 'sess-1' })
    expect(row!.status).toBe('inboxed')
    await ctx.fiber.dispose()
  })

  it('★ says an unreadable log is not evidence that nothing landed', async () => {
    // "I could not check" and "it did not land" are different facts. Collapsing
    // them would turn a broken read into a silent claim about delivery.
    const { ctx, ledger, by } = await harness({ readFails: true })
    await inboxed(ledger, 'm-1')

    const out = await by('s2s_reconcile').execute({ name: 'a' }, { agent: { id: 'sess-a' } })

    expect(out.text).toContain('Could NOT read the session log')
    expect(out.text).toContain('NOT evidence that nothing landed')
    expect(out.text).toContain('log=UNREADABLE')
    const [row] = await ledger.query({ sessionId: 'sess-1' })
    expect(row!.status).toBe('inboxed')
    await ctx.fiber.dispose()
  })

  it('says there is nothing to reconcile when the ledger is mounted but not open', async () => {
    // The real storageDomain-less deployment: reconcile cannot run, and the
    // answer must be why — not an empty "no rows".
    const root = await mkdtemp(join(tmpdir(), 's2s-tools-reconcile-closed-'))
    dirs.push(root)
    const ctx = new Context()
    const ledger = new S2sLedger(ctx) // deliberately NOT opened
    const broker = { deliver: vi.fn(() => 'idle' as const), history: vi.fn(() => [] as any[]) }
    const discovery = { list: vi.fn(async () => [] as any[]), resolve: vi.fn(async () => ({ kind: 'ok', sessionId: 'sess-1', title: 'a', state: 'live-idle', workspaceDir: 'ws' }) as any) }
    const defs = buildTools({ ctx, broker, discovery, ledger } as any)
    const tool = defs.find((d) => d.name === 's2s_reconcile') as unknown as Tool

    const out = await tool.execute({ name: 'a' }, { agent: { id: 'sess-a' } })
    expect(out.text).toContain('mounted but NOT OPEN')
    await ctx.fiber.dispose()
  })

  it('says so when no ledger is mounted at all', async () => {
    const broker = { deliver: vi.fn(() => 'idle' as const), history: vi.fn(() => [] as any[]) }
    const discovery = { list: vi.fn(async () => [] as any[]), resolve: vi.fn(async () => ({ kind: 'ok', sessionId: 'sess-1', title: 'a', state: 'live-idle', workspaceDir: 'ws' }) as any) }
    const defs = buildTools({ broker, discovery } as any)
    const tool = defs.find((d) => d.name === 's2s_reconcile') as unknown as Tool

    const out = await tool.execute({ name: 'a' }, { agent: { id: 'sess-a' } })
    expect(out.text).toContain('No ledger is mounted')
  })

  it('still resolves the target before touching the ledger', async () => {
    const { ctx, by, discovery } = await harness({ events: [] })
    const out = await by('s2s_reconcile').execute({}, { agent: { id: 'sess-a' } })
    expect(out.text).toContain('Provide a name or session_id')
    expect(discovery.resolve).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('★ reports use_cache=false as bypassing the cache', async () => {
    // T8's cache is the reason a stale read can hide a landing; the tool must be
    // able to force a fresh one and must say when it did.
    const { ctx, ledger, by } = await harness({ events: [s2sRecord(7, 'm-1')] })
    await inboxed(ledger, 'm-1')

    const out = await by('s2s_reconcile').execute({ name: 'a', use_cache: false }, { agent: { id: 'sess-a' } })

    expect(out.text).toContain('cache=bypassed')
    await ctx.fiber.dispose()
  })
})

describe('s2s_status reconcile exposure (T26)', () => {
  it('★ stamps the sample with an `as of` time and the backend the numbers came from', async () => {
    // T26: a status read is a point-in-time sample. Live session data drifts
    // (the same probe has read 209 then 215), so a reading is not reusable for
    // later comparison without its instant — and the numbers mean different
    // things depending on which store answered.
    const { ctx, by } = await harness({ events: [] })
    const out = await by('s2s_status').execute({}, { agent: { id: 'sess-a' } })
    expect(out.text).toMatch(/as of: \d{4}-\d{2}-\d{2}T[\d:.]+Z \(t=\d+\)/)
    expect(out.text).toContain('backend=storage-domain')
    expect(out.text).toContain('point-in-time sample')
    await ctx.fiber.dispose()
  })

  it('★ separates a ledger that could not open from no ledger at all', async () => {
    const root = await mkdtemp(join(tmpdir(), 's2s-status-asof-closed-'))
    dirs.push(root)
    const ctx = new Context()
    const ledger = new S2sLedger(ctx) // deliberately NOT opened
    const broker = { deliver: vi.fn(() => 'idle' as const), history: vi.fn(() => [] as any[]) }
    const discovery = { list: vi.fn(async () => [] as any[]), resolve: vi.fn(async () => ({ kind: 'ok', sessionId: 'sess-1', title: 'a', state: 'live-idle', workspaceDir: 'ws' }) as any) }
    const defs = buildTools({ ctx, broker, discovery, ledger } as any)
    const status = defs.find((d) => d.name === 's2s_status') as unknown as Tool

    const out = await status.execute({}, { agent: { id: 'sess-a' } })
    // "no ledger" and "a ledger that could not open" are different diagnoses;
    // the header must not flatten them into one.
    expect(out.text).toContain('backend=none (ledger constructed but not open)')
    await ctx.fiber.dispose()
  })

  it('★ names s2s_reconcile so an inboxed row is not mistaken for delivered', async () => {
    const { ctx, by } = await harness({ events: [] })
    const out = await by('s2s_status').execute({}, { agent: { id: 'sess-a' } })
    expect(out.text).toContain('reconcile: available via s2s_reconcile')
    expect(out.text).toContain('NOT proof of delivery')
    await ctx.fiber.dispose()
  })

  it('says reconcile is unavailable when the ledger cannot answer', async () => {
    const root = await mkdtemp(join(tmpdir(), 's2s-status-reconcile-closed-'))
    dirs.push(root)
    const ctx = new Context()
    const ledger = new S2sLedger(ctx) // deliberately NOT opened
    const broker = { deliver: vi.fn(() => 'idle' as const), history: vi.fn(() => [] as any[]) }
    const discovery = { list: vi.fn(async () => [] as any[]), resolve: vi.fn(async () => ({ kind: 'ok', sessionId: 'sess-1', title: 'a', state: 'live-idle', workspaceDir: 'ws' }) as any) }
    const defs = buildTools({ ctx, broker, discovery, ledger } as any)
    const status = defs.find((d) => d.name === 's2s_status') as unknown as Tool

    const out = await status.execute({}, { agent: { id: 'sess-a' } })
    expect(out.text).toContain('reconcile: unavailable')
    await ctx.fiber.dispose()
  })
})

describe('T9 wording honesty (I1) and sweep observability', () => {
  it('★ the live-delivery line names what is NOT yet proven', async () => {
    // The old line printed a bare `Delivered to …`, which a reader takes as "it
    // is in the target's log". That is the one claim the project reserves for
    // `landed`, so the wording must stop short of it and say where to confirm.
    const { ctx, by } = await harness({ events: [] })
    const out = await by('s2s_message').execute({ name: 'a', text: 'x' }, { agent: { id: 'sess-a' } })

    expect(out.text).toContain('Handed to')
    expect(out.text).toContain('NOT that it is in the target\'s log yet')
    expect(out.text).toContain('s2s_reconcile')
    expect(out.text).not.toContain('Delivered to')
    await ctx.fiber.dispose()
  })

  it('★ the absent case says the message reached nobody, and does not claim delivery', async () => {
    // The worst instance of the old wording: `Delivered to "a" (state=absent)`
    // asserted delivery for a message handed to no one.
    const { ctx } = await harness({ events: [] })
    const defs = buildTools({
      ctx,
      broker: { deliver: vi.fn(() => 'absent' as const), history: vi.fn(() => [] as any[]) },
      discovery: { list: vi.fn(async () => [] as any[]), resolve: vi.fn(async () => ({ kind: 'ok', sessionId: 'sess-1', title: 'a', state: 'live-idle', workspaceDir: 'ws' }) as any) },
      ledger: ctx.get('s2sLedger') as never,
    } as any)
    const msg = defs.find((d) => d.name === 's2s_message') as unknown as Tool
    const out = await msg.execute({ name: 'a', text: 'x' }, { agent: { id: 'sess-a' } })

    expect(out.text).toContain('NOT delivered')
    expect(out.text).toContain('reached nobody')
    expect(out.text).not.toContain('Delivered to')
    await ctx.fiber.dispose()
  })

  it('★ ★ s2s_status reports whether the sweep is armed, and whether it did anything', async () => {
    // T24 armed a timer whose effect was unobservable. This is the line that
    // makes "the sweep is alive here" checkable on a real host instead of only
    // provable by a unit test.
    const root = await mkdtemp(join(tmpdir(), 's2s-sweep-status-'))
    dirs.push(root)
    const ctx = new Context()
    const ledger = new S2sLedger(ctx, { timerIntervalMs: 0 }) // not opened, timer off
    const broker = { deliver: vi.fn(() => 'idle' as const), history: vi.fn(() => [] as any[]) }
    const discovery = { list: vi.fn(async () => [] as any[]), resolve: vi.fn(async () => ({ kind: 'ok', sessionId: 'sess-1', title: 'a', state: 'live-idle', workspaceDir: 'ws' }) as any) }
    const defs = buildTools({ ctx, broker, discovery, ledger } as any)
    const status = defs.find((d) => d.name === 's2s_status') as unknown as Tool

    const out = await status.execute({}, { agent: { id: 'sess-a' } })
    // Timer deliberately off in this harness ⇒ the line must say DISARMED rather
    // than pretend a sweep exists.
    expect(out.text).toContain('sweep: DISARMED')
    expect(out.text).toContain('only when s2s_reconcile is called by hand')
    await ctx.fiber.dispose()
  })

  it('★ ★ an armed-but-unopened sweep says it ran but could do nothing', async () => {
    // The real `desktop` shape: timer armed, ledger never opens. Saying just
    // "sweep ran at T" would look healthy; the SKIPPED note is what exposes that
    // the timer is alive while its effect is not.
    const root = await mkdtemp(join(tmpdir(), 's2s-sweep-skipped-'))
    dirs.push(root)
    const ctx = new Context()
    const ledger = new S2sLedger(ctx, { timerIntervalMs: 60_000 })
    const broker = { deliver: vi.fn(() => 'idle' as const), history: vi.fn(() => [] as any[]) }
    const discovery = { list: vi.fn(async () => [] as any[]), resolve: vi.fn(async () => ({ kind: 'ok', sessionId: 'sess-1', title: 'a', state: 'live-idle', workspaceDir: 'ws' }) as any) }
    const defs = buildTools({ ctx, broker, discovery, ledger } as any)
    const status = defs.find((d) => d.name === 's2s_status') as unknown as Tool

    // Before any tick: armed, nothing recorded yet.
    const before = await status.execute({}, { agent: { id: 'sess-a' } })
    expect(before.text).toContain('sweep: armed every 60s')
    expect(before.text).toContain('has NOT run yet in this process')

    // Drive one tick on an unopened ledger — the exact production situation.
    await ledger.tick()
    const after = await status.execute({}, { agent: { id: 'sess-a' } })
    expect(after.text).toContain('sweep: armed every 60s')
    expect(after.text).toContain('SKIPPED')
    expect(after.text).toContain('The timer is alive; its effect is not')
    await ctx.fiber.dispose()
  })

  it('★ publishes the sweep schedule, so "not due yet" is distinguishable from "not armed"', async () => {
    // Within a verification window the 1h interval means the callback cannot be
    // observed, and silence is exactly what an un-armed timer would also produce.
    // Publishing the due time and the zombie deadline is what turns that silence
    // into a checkable schedule (G9).
    const root = await mkdtemp(join(tmpdir(), 's2s-sweep-schedule-'))
    dirs.push(root)
    const ctx = new Context()
    const ledger = new S2sLedger(ctx, { timerIntervalMs: 60_000 })
    const broker = { deliver: vi.fn(() => 'idle' as const), history: vi.fn(() => [] as any[]) }
    const discovery = { list: vi.fn(async () => [] as any[]), resolve: vi.fn(async () => ({ kind: 'ok', sessionId: 'sess-1', title: 'a', state: 'live-idle', workspaceDir: 'ws' }) as any) }
    const defs = buildTools({ ctx, broker, discovery, ledger } as any)
    const status = defs.find((d) => d.name === 's2s_status') as unknown as Tool

    const out = await status.execute({}, { agent: { id: 'sess-a' } })
    expect(out.text).toContain('Next pass due at')
    expect(out.text).toContain('24h before it is a zombie')

    // The value must come from the single source of truth, not a copied literal.
    const { LEDGER_LIMITS } = await import('../src/ledger-schema.ts')
    expect(ledger.sweepStatus.landedDeadlineMs).toBe(LEDGER_LIMITS.landedDeadlineMs)
    await ctx.fiber.dispose()
  })

  it('a disarmed sweep publishes no due time (it has none)', async () => {
    // Negative control for the field above: with the timer off there is no next
    // pass, and inventing one would claim a schedule that does not exist.
    const root = await mkdtemp(join(tmpdir(), 's2s-sweep-disarmed-schedule-'))
    dirs.push(root)
    const ctx = new Context()
    const ledger = new S2sLedger(ctx, { timerIntervalMs: 0 })
    const broker = { deliver: vi.fn(() => 'idle' as const), history: vi.fn(() => [] as any[]) }
    const discovery = { list: vi.fn(async () => [] as any[]), resolve: vi.fn(async () => ({ kind: 'ok', sessionId: 'sess-1', title: 'a', state: 'live-idle', workspaceDir: 'ws' }) as any) }
    const defs = buildTools({ ctx, broker, discovery, ledger } as any)
    const status = defs.find((d) => d.name === 's2s_status') as unknown as Tool

    expect(ledger.sweepStatus.nextSweepAt).toBeUndefined()
    const out = await status.execute({}, { agent: { id: 'sess-a' } })
    expect(out.text).toContain('sweep: DISARMED')
    expect(out.text).not.toContain('Next pass due at')
    await ctx.fiber.dispose()
  })
})
