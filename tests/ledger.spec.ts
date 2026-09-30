import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import * as sqliteStorage from '@deepseek-ai/dsh-storage-sqlite'
import { S2sLedger } from '../src/ledger.ts'
import { LEDGER_LIMITS } from '../src/ledger-schema.ts'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

/** Build a context whose `storageDomain` service is mounted, like the host's. */
async function harness() {
  const root = await mkdtemp(join(tmpdir(), 's2s-ledger-'))
  dirs.push(root)
  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(sqliteStorage, { path: join(root, 'storage.db') })
  const facility = new DomainFacility(ctx, { backend: 'sqlite', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility as never)
  const ledger = new S2sLedger(ctx)
  return { ctx, ledger, facility }
}

describe('S2sLedger skeleton (T5)', () => {
  it('records a message as queued and reads it back by msgId', async () => {
    const { ctx, ledger } = await harness()
    await ledger.open()
    await ledger.record({ msgId: 'm-1', from: 'alice', to: 'bob', text: 'hello' })

    const rows = await ledger.query({ msgId: 'm-1' })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      msgId: 'm-1',
      from: 'alice',
      to: 'bob',
      text: 'hello',
      status: 'queued',
    })
    await ledger.close()
    await ctx.fiber.dispose()
  })

  it('starts a row immediately eligible for its first attempt', async () => {
    const { ctx, ledger } = await harness()
    await ledger.open()
    const at = 1_700_000_000_000
    await ledger.record({ msgId: 'm-1', from: 'a', to: 'b', text: 'x', createdAt: at })

    const [row] = await ledger.query({ msgId: 'm-1' })
    // A fresh row must not be stranded behind a backoff it never earned.
    expect(row).toMatchObject({
      attempts: 0,
      maxRetries: LEDGER_LIMITS.maxRetries,
      nextAttemptAt: at,
      createdAt: at,
      updatedAt: at,
    })
    await ledger.close()
    await ctx.fiber.dispose()
  })

  it('leaves the optional fields null, not absent', async () => {
    const { ctx, ledger } = await harness()
    await ledger.open()
    await ledger.record({ msgId: 'm-1', from: 'a', to: 'b', text: 'x' })

    const [row] = await ledger.query({ msgId: 'm-1' })
    // A cleared field must round-trip as an explicit null; an absent key would
    // read as "never set" and lose the distinction the P2 status output makes.
    expect(row!.resolvedSessionId).toBeNull()
    expect(row!.landedSeq).toBeNull()
    expect(row!.lastError).toBeNull()
    expect(row!.unreadableSince).toBeNull()
    expect(row!.fromLineage).toBeNull()
    await ledger.close()
    await ctx.fiber.dispose()
  })

  it('overwrites on a repeated msgId rather than appending', async () => {
    const { ctx, ledger } = await harness()
    await ledger.open()
    await ledger.record({ msgId: 'm-1', from: 'a', to: 'b', text: 'first' })
    await ledger.record({ msgId: 'm-1', from: 'a', to: 'b', text: 'second' })

    const rows = await ledger.query()
    // The id is the idempotency key: a retried tool call must not create a
    // second row for one message.
    expect(rows).toHaveLength(1)
    expect(rows[0]!.text).toBe('second')
    await ledger.close()
    await ctx.fiber.dispose()
  })

  it('finds a still-queued row by the address it was sent to', async () => {
    const { ctx, ledger } = await harness()
    await ledger.open()
    await ledger.record({ msgId: 'm-1', from: 'a', to: 'session-9', text: 'x' })

    // `resolvedSessionId` is null while queued, so matching only on it would
    // hide exactly the rows a status query is most likely to be asked about.
    const rows = await ledger.query({ sessionId: 'session-9' })
    expect(rows.map((r) => r.msgId)).toEqual(['m-1'])
    await ledger.close()
    await ctx.fiber.dispose()
  })

  it('truncates an oversized body and flags it', async () => {
    const { ctx, ledger } = await harness()
    await ledger.open()
    const long = 'x'.repeat(LEDGER_LIMITS.textMaxChars + 500)
    await ledger.record({ msgId: 'm-1', from: 'a', to: 'b', text: long })

    const [row] = await ledger.query({ msgId: 'm-1' })
    expect(row!.text).toHaveLength(LEDGER_LIMITS.textMaxChars)
    expect(row!.truncated).toBe(true)
    await ledger.close()
    await ctx.fiber.dispose()
  })

  it('filters by since and orders oldest first, stably', async () => {
    const { ctx, ledger } = await harness()
    await ledger.open()
    const base = 1_700_000_000_000
    await ledger.record({ msgId: 'm-b', from: 'a', to: 'b', text: 'b', createdAt: base + 10 })
    await ledger.record({ msgId: 'm-a', from: 'a', to: 'b', text: 'a', createdAt: base + 10 })
    await ledger.record({ msgId: 'm-c', from: 'a', to: 'b', text: 'c', createdAt: base + 20 })

    const all = await ledger.query()
    // Same timestamp ⇒ tie-broken by msgId, so the order cannot flap between reads.
    expect(all.map((r) => r.msgId)).toEqual(['m-a', 'm-b', 'm-c'])

    const recent = await ledger.query({ since: base + 15 })
    expect(recent.map((r) => r.msgId)).toEqual(['m-c'])
    await ledger.close()
    await ctx.fiber.dispose()
  })

  it('survives a reopen, because the ledger is the durable index', async () => {
    const root = await mkdtemp(join(tmpdir(), 's2s-ledger-'))
    dirs.push(root)
    const path = join(root, 'storage.db')

    const first = new Context()
    await first.plugin(Storage)
    await first.plugin(sqliteStorage, { path })
    const facility1 = new DomainFacility(first, { backend: 'sqlite', routes: {} })
    first.storage.mount('domain', facility1)
    first.provide('storageDomain', facility1 as never)
    const ledger1 = new S2sLedger(first)
    await ledger1.open()
    await ledger1.record({ msgId: 'm-keep', from: 'a', to: 'b', text: 'persisted' })
    await ledger1.close()
    await first.fiber.dispose()

    const second = new Context()
    await second.plugin(Storage)
    await second.plugin(sqliteStorage, { path })
    const facility2 = new DomainFacility(second, { backend: 'sqlite', routes: {} })
    second.storage.mount('domain', facility2)
    second.provide('storageDomain', facility2 as never)
    const ledger2 = new S2sLedger(second)
    await ledger2.open()
    const rows = await ledger2.query({ msgId: 'm-keep' })
    expect(rows[0]!.text).toBe('persisted')
    await ledger2.close()
    await second.fiber.dispose()
  })

  it('refuses to pretend it works when storageDomain is absent (G9)', async () => {
    const ctx = new Context()
    const ledger = new S2sLedger(ctx)
    expect(ledger.isOpen).toBe(false)
    expect(ledger.backend).toBeUndefined()
    // A ledger that silently keeps nothing would make every later status read
    // fabricated, so the absence must be an error rather than a no-op.
    await expect(ledger.open()).rejects.toThrow(/storageDomain/)
    await ctx.fiber.dispose()
  })

  it('reports its backing store once open', async () => {
    const { ctx, ledger } = await harness()
    await ledger.open()
    expect(ledger.backend).toBe('storage-domain')
    expect(ledger.isOpen).toBe(true)
    await ledger.close()
    await ctx.fiber.dispose()
  })

  it('is idempotent on open', async () => {
    const { ctx, ledger } = await harness()
    // Reopening one domain name is rejected by the facility by design, so the
    // second call must short-circuit rather than throw.
    await ledger.open()
    await ledger.open()
    expect(ledger.isOpen).toBe(true)
    await ledger.close()
    await ctx.fiber.dispose()
  })

  it('rejects use before open', async () => {
    // A separate context: `s2sLedger` is a Service, so one context registers one
    // instance — a second `new S2sLedger(ctx)` on the same ctx is a name clash.
    const root = await mkdtemp(join(tmpdir(), 's2s-ledger-'))
    dirs.push(root)
    const ctx = new Context()
    await ctx.plugin(Storage)
    await ctx.plugin(sqliteStorage, { path: join(root, 'storage.db') })
    const fresh = new S2sLedger(ctx)
    await expect(fresh.record({ msgId: 'm-1', from: 'a', to: 'b', text: 'x' }))
      .rejects.toThrow(/before open/)
    await expect(fresh.query()).rejects.toThrow(/before open/)
    await ctx.fiber.dispose()
  })
})
