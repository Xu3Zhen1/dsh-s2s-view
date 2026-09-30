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

type Tool = { name: string; execute: (args: any, exec: any) => Promise<{ text: string }> | { text: string } }

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

/** A real ledger over sqlite, plus the tool family wired to it. */
async function harness(opts: { deliver?: 'idle' | 'busy' | 'absent' } = {}) {
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

  const broker = {
    deliver: vi.fn(() => (opts.deliver ?? 'idle') as 'idle' | 'busy' | 'absent'),
    history: vi.fn(() => [] as any[]),
  }
  const discovery = {
    list: vi.fn(async () => [] as any[]),
    resolve: vi.fn(async () => ({ kind: 'ok', sessionId: 'sess-1', title: 'a', state: 'live-idle', workspaceDir: 'ws' }) as any),
  }
  const defs = buildTools({ broker, discovery, ledger } as any)
  const by = (n: string) => defs.find((d) => d.name === n) as unknown as Tool
  return { ctx, ledger, by, broker, discovery }
}

describe('s2s_message ledger wiring (T6)', () => {
  it('records a delivered message and advances it to inboxed', async () => {
    const { ctx, ledger, by } = await harness({ deliver: 'idle' })
    const out = await by('s2s_message').execute({ name: 'a', text: 'hello' }, { agent: { id: 'sess-a' } })
    expect(out.text).toContain('Delivered to')

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
    expect(out.text).toContain('Delivered to')
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
