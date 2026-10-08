import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import * as sqliteStorage from '@deepseek-ai/dsh-storage-sqlite'
import { buildTools } from '../src/tools.ts'
import { S2sLedger } from '../src/ledger.ts'
import { ledgerDiagnostics } from '../src/ledger-diagnostics.ts'

type Tool = { name: string; execute: (args: any, exec: any) => Promise<{ text: string }> | { text: string } }

const dirs: string[] = []
const disposers: Array<() => Promise<void>> = []
// `ledgerDiagnostics` is a module-level singleton shared by the whole run, so an
// untracked-delivery entry written by one case would leak into the next and
// silently turn a "reports nothing" assertion into a false failure. Reset it
// around every case; the assertions here are about what *this* case recorded.
beforeEach(() => { delete ledgerDiagnostics.untrackedDeliveries })
afterEach(async () => {
  delete ledgerDiagnostics.untrackedDeliveries
  // Close ledgers BEFORE removing their directories: an open sqlite handle makes
  // `rm` fail with EBUSY, which surfaces as a red test pointing at cleanup
  // rather than at the code under test.
  for (const dispose of disposers.splice(0)) {
    try { await dispose() } catch { /* cleanup must not mask the real result */ }
  }
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

/** A real ledger over sqlite, plus the tool family wired to it. */
async function harness(opts: { deliver?: 'idle' | 'busy' | 'absent'; state?: string; lifecycle?: unknown } = {}) {
  const root = await mkdtemp(join(tmpdir(), 's2s-t6-'))
  dirs.push(root)
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(sqliteStorage, { path: join(root, 'storage.db') })
  const facility = new DomainFacility(ctx, { backend: 'sqlite', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility as never)
  const ledger = new S2sLedger(ctx)
  await ledger.open()
  disposers.push(async () => { await ledger.close(); await ctx.fiber.dispose() })

  const broker = {
    deliver: vi.fn(() => (opts.deliver ?? 'idle') as 'idle' | 'busy' | 'absent'),
    history: vi.fn(() => [] as any[]),
  }
  const discovery = {
    list: vi.fn(async () => [] as any[]),
    resolve: vi.fn(async () => ({ kind: 'ok', sessionId: 'sess-1', title: 'a', state: opts.state ?? 'live-idle', workspaceDir: 'ws' }) as any),
  }
  const defs = buildTools({
    broker,
    discovery,
    ledger,
    ...(opts.lifecycle === undefined ? {} : { lifecycle: opts.lifecycle }),
  } as any)
  const by = (n: string) => defs.find((d) => d.name === n) as unknown as Tool
  return { ctx, ledger, by, broker, discovery }
}

describe('s2s_status (T10)', () => {
  it('★ says the ledger is mounted-but-not-open instead of looking empty', async () => {
    // The real `storageDomain`-less deployment: `ledger !== undefined` while
    // never opened. Before T10 a reader saw empty history and had no way to tell
    // "nothing was ever tracked" from "tracking is silently off".
    const root = await mkdtemp(join(tmpdir(), 's2s-status-'))
    dirs.push(root)
    const ctx = new Context()
    const ledger = new S2sLedger(ctx) // constructed, deliberately NOT opened
    const broker = { deliver: vi.fn(() => 'idle' as const), history: vi.fn(() => [] as any[]) }
    const discovery = { list: vi.fn(async () => [] as any[]), resolve: vi.fn(async () => ({ kind: 'ok', sessionId: 'sess-1', title: 'a', state: 'live-idle', workspaceDir: 'ws' }) as any) }
    const defs = buildTools({ broker, discovery, ledger } as any)
    const status = defs.find((d) => d.name === 's2s_status') as unknown as Tool

    const out = await status.execute({}, { agent: { id: 'sess-a' } })
    expect(out.text).toContain('mounted but NOT OPEN')
    expect(out.text).toContain('storageDomain')
    await ctx.fiber.dispose()
  })

  it('reports the ledger as open and its backend when it is', async () => {
    const { ctx, by } = await harness({ deliver: 'idle' })
    const out = await by('s2s_status').execute({}, { agent: { id: 'sess-a' } })
    expect(out.text).toContain('ledger: open')
    expect(out.text).toContain('backend=storage-domain')
  })

  it('★ declares that history is not durable across restarts', async () => {
    // The user-visible symptom this addresses: after a restart `s2s_history`
    // shows nothing, which is indistinguishable from "no messages ever sent"
    // unless the tool says so out loud.
    const { ctx, by } = await harness({ deliver: 'idle' })
    const out = await by('s2s_status').execute({}, { agent: { id: 'sess-a' } })
    // T11 made history durable; the line must reflect WHICH source answers
    // rather than repeating the obsolete "process-scoped only" claim. This
    // harness HAS an open ledger, so both sources are live.
    expect(out.text).toContain('durable read path ACTIVE')
    expect(out.text).toContain('last resort, not the read path')
    expect(out.text).not.toContain('history: process-scoped only')
    await ctx.fiber.dispose()
  })

  it('★ names the session-log fallback when the ledger cannot answer (T11)', async () => {
    // The deployment shape that produced the user-reported symptom: no
    // `storageDomain`, so the ledger is mounted but never opens. The status line
    // must say the log fallback carries the read path, not that history is lost.
    const root = await mkdtemp(join(tmpdir(), 's2s-status-noledger-'))
    dirs.push(root)
    const ctx = new Context()
    const ledger = new S2sLedger(ctx) // constructed, deliberately NOT opened
    const broker = { deliver: vi.fn(() => 'idle' as const), history: vi.fn(() => [] as any[]) }
    const discovery = { list: vi.fn(async () => [] as any[]), resolve: vi.fn(async () => ({ kind: 'ok', sessionId: 'sess-1', title: 'a', state: 'live-idle', workspaceDir: 'ws' }) as any) }
    const defs = buildTools({ ctx, broker, discovery, ledger } as any)
    const status = defs.find((d) => d.name === 's2s_status') as unknown as Tool

    const out = await status.execute({}, { agent: { id: 'sess-a' } })
    expect(out.text).toContain('falls back to the TARGET\'S SESSION LOG')
    expect(out.text).toContain('durable across restarts')
    await ctx.fiber.dispose()
  })

  it('says lifecycle is not configured rather than omitting the section', async () => {
    const { by } = await harness({ deliver: 'idle' })
    const out = await by('s2s_status').execute({}, { agent: { id: 'sess-a' } })
    expect(out.text).toContain('lifecycle not configured')
  })
})

describe('s2s_message ledger wiring (T6)', () => {
  it('records a delivered message and advances it to inboxed', async () => {
    const { ctx, ledger, by } = await harness({ deliver: 'idle' })
    const out = await by('s2s_message').execute({ name: 'a', text: 'hello' }, { agent: { id: 'sess-a' } })
    expect(out.text).toContain('Handed to')

    const rows = await ledger.query()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'inboxed', from: 'sess-a', text: 'hello' })
    await ledger.close()
    await ctx.fiber.dispose()
  })

  it('writes the resolved session id at delivery, not at record time', async () => {
    const { ctx, ledger, by } = await harness({ deliver: 'idle' })
    await by('s2s_message').execute({ name: 'a', text: 'x' }, { agent: { id: 'sess-a' } })

    const [row] = await ledger.query()
    // §13.1 responsibility split: `record()` leaves this null (it has not
    // resolved anything), the broker passes it once at markInboxed.
    expect(row!.resolvedSessionId).toBe('sess-1')
    expect(row!.resolvedAt).toBeNull()
    await ledger.close()
    await ctx.fiber.dispose()
  })

  it('★ does NOT mark inboxed when the broker reports absent (I1)', async () => {
    const { ctx, ledger, by } = await harness({ deliver: 'absent' })
    const out = await by('s2s_message').execute({ name: 'a', text: 'gone' }, { agent: { id: 'sess-a' } })
    expect(out.text).toContain('absent')

    const [row] = await ledger.query()
    // The agent vanished between resolve and deliver, so the message reached
    // nobody. Marking it `inboxed` would report an acceptance that never
    // happened — the exact overclaim invariant I1 forbids.
    expect(row!.status).toBe('queued')
    expect(row!.resolvedSessionId).toBeNull()
    await ledger.close()
    await ctx.fiber.dispose()
  })

  it('records a `busy` delivery as inboxed (context injection still lands)', async () => {
    const { ctx, ledger, by } = await harness({ deliver: 'busy' })
    await by('s2s_message').execute({ name: 'a', text: 'x' }, { agent: { id: 'sess-a' } })
    expect((await ledger.query())[0]!.status).toBe('inboxed')
    await ledger.close()
    await ctx.fiber.dispose()
  })

  it('still delivers when no ledger is mounted', async () => {
    const broker = { deliver: vi.fn(() => 'idle' as const), history: vi.fn(() => [] as any[]) }
    const discovery = { list: vi.fn(async () => [] as any[]), resolve: vi.fn(async () => ({ kind: 'ok', sessionId: 'sess-1', title: 'a', state: 'live-idle', workspaceDir: 'ws' }) as any) }
    const defs = buildTools({ broker, discovery } as any)
    const msg = defs.find((d) => d.name === 's2s_message') as unknown as Tool
    // The ledger is optional; its absence must not break sending.
    const out = await msg.execute({ name: 'a', text: 'x' }, { agent: { id: 'sess-a' } })
    expect(out.text).toContain('Handed to')
  })

  it('★ still delivers when the ledger exists but was never opened', async () => {
    // The real deployment shape that broke: a `storageDomain`-less host still
    // registers the `S2sLedger` service, so `ledger !== undefined` while every
    // write throws `used before open()`. Guarding only on `undefined` therefore
    // missed it and the whole delivery failed. Measured as `s2s_message` →
    // `Error: s2s ledger: used before open()` with no message ever sent.
    const root = await mkdtemp(join(tmpdir(), 's2s-t6b-'))
    dirs.push(root)
    const ctx = new Context()
    const ledger = new S2sLedger(ctx) // constructed, deliberately NOT opened
    const warn = vi.fn()
    ctx.logger.warn = warn as never
    const broker = { deliver: vi.fn(() => 'idle' as const), history: vi.fn(() => [] as any[]) }
    const discovery = { list: vi.fn(async () => [] as any[]), resolve: vi.fn(async () => ({ kind: 'ok', sessionId: 'sess-1', title: 'a', state: 'live-idle', workspaceDir: 'ws' }) as any) }
    const defs = buildTools({ broker, discovery, ledger } as any)
    const msg = defs.find((d) => d.name === 's2s_message') as unknown as Tool

    const out = await msg.execute({ name: 'a', text: 'x' }, { agent: { id: 'sess-a' } })
    // Delivery outranks bookkeeping: the message must go out regardless.
    expect(out.text).toContain('Handed to')
    expect(broker.deliver).toHaveBeenCalledTimes(1)
    // …but the loss of tracking must not be silent (G9).
    expect(warn).toHaveBeenCalled()
    expect(String(warn.mock.calls.at(-1)![0])).toContain('ledger')
    await ctx.fiber.dispose()
  })

  it('keeps `to` as the addressing string the caller wrote', async () => {
    const { ctx, ledger, by } = await harness({ deliver: 'idle' })
    await by('s2s_message').execute({ name: 'some-title', text: 'x' }, { agent: { id: 'sess-a' } })

    const [row] = await ledger.query()
    // `to` is kept verbatim so a later audit can see how the target was named,
    // which is why query() also matches on it.
    expect(row!.to).toBe('some-title')
    expect(row!.resolvedSessionId).toBe('sess-1')
    await ledger.close()
    await ctx.fiber.dispose()
  })
})

describe('s2s_resume ledger wiring (T6b dormant path)', () => {
  /** A lifecycle stub that hands over one message and lets `drain` mark it. */
  function lifecycleStub(ledger: S2sLedger, outcome: 'resumed' | 'queued' = 'resumed') {
    return {
      queueForDormant: vi.fn(async (entry: { sessionId: string; msgId: string }) => {
        // Mirror the real `drain()`: the dormant path's `markInboxed` is what
        // advances the row, and it can only work if a row already exists.
        if (outcome === 'resumed') await ledger.markInboxed(entry.msgId, entry.sessionId)
        return outcome
      }),
      queuedCount: vi.fn(async () => 0),
    }
  }

  it('★ records the wake BEFORE queueing, so drain can advance it (the defect)', async () => {
    // Measured on the real host: a dormant `s2s_resume` put the message in the
    // target's log while the ledger held ZERO rows for it, and `s2s_reconcile`
    // reported `examined=0` forever. Cause: this entry generated a `msgId` and
    // called `queueForDormant` without ever calling `record()`, so `drain()`'s
    // `markInboxed()` hit its `row === undefined` branch — which only warned
    // through a logger that is never persisted.
    const { ctx, ledger, by } = await harness({ deliver: 'idle', state: 'dormant' })
    const stub = lifecycleStub(ledger)
    const defs = buildTools({
      broker: { deliver: vi.fn(), history: vi.fn(() => []) },
      discovery: { list: vi.fn(async () => []), resolve: vi.fn(async () => ({ kind: 'ok', sessionId: 'sess-1', title: 'a', state: 'dormant', workspaceDir: 'ws' }) as any) },
      lifecycle: stub,
      ledger,
    } as any)
    const resume = defs.find((d) => d.name === 's2s_resume') as unknown as Tool

    const out = await resume.execute({ name: 'a', text: 'wake it' }, { agent: { id: 'sess-a' } })
    expect(out.text).toContain('resumed')

    const rows = await ledger.query()
    // Before the fix this was 0 rows: the wake was untracked.
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'inboxed', from: 'sess-a', text: 'wake it', resolvedSessionId: 'sess-1' })
    expect(rows[0]!.msgId).toMatch(/^wake-/)
    await ledger.close()
    await ctx.fiber.dispose()
  })

  it('★ the record is written before the handover, not repaired afterwards', async () => {
    // Ordering matters, not just the end state: `markInboxed` must not be the
    // thing that creates the row. It would fabricate a `record` and hide a
    // caller that forgot one — and the row would carry no `text`/`from`/`to`.
    const { ctx, ledger } = await harness({ deliver: 'idle', state: 'dormant' })
    let rowsAtHandover: number | undefined
    const stub = {
      queueForDormant: vi.fn(async () => {
        rowsAtHandover = (await ledger.query()).length
        return 'queued' as const
      }),
      queuedCount: vi.fn(async () => 1),
    }
    const defs = buildTools({
      broker: { deliver: vi.fn(), history: vi.fn(() => []) },
      discovery: { list: vi.fn(async () => []), resolve: vi.fn(async () => ({ kind: 'ok', sessionId: 'sess-1', title: 'a', state: 'dormant', workspaceDir: 'ws' }) as any) },
      lifecycle: stub,
      ledger,
    } as any)
    const resume = defs.find((d) => d.name === 's2s_resume') as unknown as Tool

    await resume.execute({ name: 'a', text: 'x' }, { agent: { id: 'sess-a' } })
    expect(rowsAtHandover).toBe(1)
    const [row] = await ledger.query()
    // A row created by `markInboxed` would have these empty.
    expect(row!.from).toBe('sess-a')
    expect(row!.text).toBe('x')
    await ledger.close()
    await ctx.fiber.dispose()
  })

  it('★ does not point at s2s_reconcile when the wake was not tracked', async () => {
    // I1, one level removed: the claim here is about the EVIDENCE. With no
    // ledger mounted `record()` is a no-op, so the row does not exist and
    // `s2s_reconcile` structurally cannot ever see this wake. Naming it would
    // hand the reader a confirmation path that is guaranteed to answer "nothing".
    const ctx = new Context()
    const stub = { queueForDormant: vi.fn(async () => 'resumed' as const), queuedCount: vi.fn(async () => 0) }
    const defs = buildTools({
      ctx,
      broker: { deliver: vi.fn(), history: vi.fn(() => []) },
      discovery: { list: vi.fn(async () => []), resolve: vi.fn(async () => ({ kind: 'ok', sessionId: 'sess-1', title: 'a', state: 'dormant', workspaceDir: 'ws' }) as any) },
      lifecycle: stub,
    } as any)
    const resume = defs.find((d) => d.name === 's2s_resume') as unknown as Tool

    const out = await resume.execute({ name: 'a', text: 'x' }, { agent: { id: 'sess-a' } })
    expect(out.text).toContain('resumed')
    expect(out.text).toContain('NOT tracked in the ledger')
    expect(out.text).not.toContain('confirmed by s2s_reconcile')
    await ctx.fiber.dispose()
  })

  it('★ does not claim confirmation when the record itself fails', async () => {
    // The work order's wording rule: "if the record write fails, the line must
    // report it honestly and must not claim the log is confirmed." An open ledger
    // whose write throws is just as untracked as a missing one — which is why the
    // gate is `noteLedger`'s return value rather than `ledger.isOpen`.
    const ctx = new Context()
    const warn = vi.fn()
    ctx.logger.warn = warn as never
    const failing = {
      isOpen: true,
      backend: 'storage-domain',
      record: vi.fn(async () => { throw new Error('write blew up') }),
      warn: vi.fn(),
    }
    const stub = { queueForDormant: vi.fn(async () => 'resumed' as const), queuedCount: vi.fn(async () => 0) }
    const defs = buildTools({
      ctx,
      broker: { deliver: vi.fn(), history: vi.fn(() => []) },
      discovery: { list: vi.fn(async () => []), resolve: vi.fn(async () => ({ kind: 'ok', sessionId: 'sess-1', title: 'a', state: 'dormant', workspaceDir: 'ws' }) as any) },
      lifecycle: stub,
      ledger: failing,
    } as any)
    const resume = defs.find((d) => d.name === 's2s_resume') as unknown as Tool

    const out = await resume.execute({ name: 'a', text: 'x' }, { agent: { id: 'sess-a' } })
    // The wake still happened (bookkeeping never outranks delivery)…
    expect(stub.queueForDormant).toHaveBeenCalledTimes(1)
    expect(out.text).toContain('resumed')
    // …but the line must not point at a confirmation source that has no row.
    expect(out.text).toContain('NOT tracked in the ledger')
    expect(out.text).not.toContain('confirmed by s2s_reconcile')
    expect(failing.warn).toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('★ still wakes when the ledger exists but was never opened', async () => {
    // Delivery outranks bookkeeping on this entry too — the same invariant the
    // live path and `s2s_message`'s dormant branch already carry.
    const ctx = new Context()
    const ledger = new S2sLedger(ctx) // constructed, deliberately NOT opened
    const warn = vi.fn()
    ctx.logger.warn = warn as never
    const stub = { queueForDormant: vi.fn(async () => 'resumed' as const), queuedCount: vi.fn(async () => 0) }
    const defs = buildTools({
      ctx,
      broker: { deliver: vi.fn(), history: vi.fn(() => []) },
      discovery: { list: vi.fn(async () => []), resolve: vi.fn(async () => ({ kind: 'ok', sessionId: 'sess-1', title: 'a', state: 'dormant', workspaceDir: 'ws' }) as any) },
      lifecycle: stub,
      ledger,
    } as any)
    const resume = defs.find((d) => d.name === 's2s_resume') as unknown as Tool

    const out = await resume.execute({ name: 'a', text: 'x' }, { agent: { id: 'sess-a' } })
    expect(out.text).toContain('resumed')
    expect(stub.queueForDormant).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls.at(-1)![0])).toContain('ledger')
    await ctx.fiber.dispose()
  })
})

describe('★ untracked deliveries are readable back (G9)', () => {
  it('★ s2s_status reports a delivery whose markInboxed found no row', async () => {
    // The hole that hid the `s2s_resume` defect: `markInboxed` warned through the
    // plugin logger, which is never persisted, so "it was tracked" and "it
    // silently was not" had identical evidence afterwards. This is the read-back.
    const { ctx, ledger, by } = await harness({ deliver: 'idle' })
    // Advance a row that was never recorded — exactly what the dormant path did.
    await ledger.markInboxed('wake-untracked-1', 'sess-1')

    const out = await by('s2s_status').execute({}, { agent: { id: 'sess-a' } })
    expect(out.text).toContain('ledger UNTRACKED deliveries: 1')
    expect(out.text).toContain('wake-untracked-1 -> sess-1')
    expect(out.text).toContain('s2s_reconcile cannot see them')
    await ledger.close()
    await ctx.fiber.dispose()
  })

  it('says nothing about untracked deliveries when there are none', async () => {
    // A permanent "0" line trains the reader to skip it, so the section is
    // absent rather than zeroed.
    const { ctx, by } = await harness({ deliver: 'idle' })
    const out = await by('s2s_status').execute({}, { agent: { id: 'sess-a' } })
    expect(out.text).not.toContain('UNTRACKED')
    await ctx.fiber.dispose()
  })

  it('★ a normal tracked delivery is NOT reported as untracked', async () => {
    // Negative control: without this, a status line that always fired would look
    // like proof the read-back works.
    const { ctx, ledger, by } = await harness({ deliver: 'idle' })
    await by('s2s_message').execute({ name: 'a', text: 'fine' }, { agent: { id: 'sess-a' } })
    const out = await by('s2s_status').execute({}, { agent: { id: 'sess-a' } })
    expect(out.text).not.toContain('UNTRACKED')
    expect((await ledger.query())[0]!.status).toBe('inboxed')
    await ledger.close()
    await ctx.fiber.dispose()
  })
})
