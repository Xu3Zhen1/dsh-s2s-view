import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import * as sqliteStorage from '@deepseek-ai/dsh-storage-sqlite'
import { apply as s2sApply } from '../src/index.ts'
import { S2sLedger } from '../src/ledger.ts'
import { LEDGER_DOMAIN } from '../src/ledger-schema.ts'

/**
 * The measured defect: the ledger raced the host's asynchronously-built storage
 * chain.
 *
 * The host patches in `storage` + `storage-json` and `dsh-storage-domain`
 * provides `storageDomain` **inside** its own `ctx.inject([backendKey], …)`
 * callback — so at plugin-mount time the service is legitimately absent. The
 * old code asked `ctx.get('storageDomain')` once, threw, and never retried, so
 * the ledger stayed shut for the whole process and `s2s_status` reported "no
 * storageDomain" forever. That report was read (by us) as "the environment has
 * no store" for several rounds — the environment was fine; the timing was not.
 *
 * These tests pin the fix: the plugin must WAIT for the service and open once it
 * arrives, and must still work (untracked, not crash) when it never arrives.
 */

const dirs: string[] = []
const disposers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of disposers.splice(0)) {
    try { await dispose() } catch { /* cleanup must not mask the real result */ }
  }
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

/** Minimal deps so `s2sApply` can mount without the rest of the host. */
function stubHost(ctx: Context): void {
  ctx.provide('tools', { register: () => () => {} } as never)
  ctx.provide('agents', { get: () => undefined } as never)
  ctx.provide('sessions', { list: () => [] } as never)
  ctx.provide('sessionQuery', { listSessions: async () => [], readTitle: async () => undefined } as never)
}

describe('ledger open waits for the storage chain (measured race)', () => {
  it('★★ opens the ledger when storageDomain appears LATE, not at mount time', async () => {
    // The exact production shape: mount first, provide the store later.
    const root = await mkdtemp(join(tmpdir(), 's2s-race-'))
    dirs.push(root)
    const ctx = new Context()
    ctx.logger.warn = vi.fn() as never
    stubHost(ctx)

    await ctx.plugin(s2sApply, {})
    const ledger = ctx.get('s2sLedger') as S2sLedger
    // Not yet: the host has not provided the service.
    expect(ledger.isOpen).toBe(false)

    // Now the chain finishes — storage hub + a real sqlite facility.
    await ctx.plugin(Storage)
    await ctx.plugin(sqliteStorage, { path: join(root, 'storage.db') })
    const facility = new DomainFacility(ctx, { backend: 'sqlite', routes: {} })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility as never)

    // The fix's whole point: it opens WITHOUT anyone calling open() again.
    await vi.waitFor(() => { expect(ledger.isOpen).toBe(true) }, { timeout: 2000 })

    disposers.push(async () => { await ledger.close(); await ctx.fiber.dispose() })
  })

  it('★★ the late-opened ledger is actually usable (write then read back)', async () => {
    const root = await mkdtemp(join(tmpdir(), 's2s-race-usable-'))
    dirs.push(root)
    const ctx = new Context()
    ctx.logger.warn = vi.fn() as never
    stubHost(ctx)
    await ctx.plugin(s2sApply, {})
    const ledger = ctx.get('s2sLedger') as S2sLedger

    await ctx.plugin(Storage)
    await ctx.plugin(sqliteStorage, { path: join(root, 'storage.db') })
    const facility = new DomainFacility(ctx, { backend: 'sqlite', routes: {} })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility as never)
    await vi.waitFor(() => { expect(ledger.isOpen).toBe(true) }, { timeout: 2000 })

    await ledger.record({ msgId: 'm-1', from: 'alice', to: 'sess-1', text: 'durable' })
    const rows = await ledger.query()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.msgId).toBe('m-1')
    expect(rows[0]!.text).toBe('durable')
    disposers.push(async () => { await ledger.close(); await ctx.fiber.dispose() })
  })

  it('★ does NOT crash or hang when storageDomain never appears (still optional)', async () => {
    // The real `inject` semantics, probe-verified: an absent service withholds
    // the callback without throwing and without stalling the mount. The tools
    // must keep working untracked.
    const ctx = new Context()
    ctx.logger.warn = vi.fn() as never
    stubHost(ctx)
    await ctx.plugin(s2sApply, {})
    await new Promise((r) => setTimeout(r, 120))

    const ledger = ctx.get('s2sLedger') as S2sLedger
    expect(ledger).toBeDefined()
    expect(ledger.isOpen).toBe(false)
    expect(ledger.backend).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('★ open() at mount time would lose the race — documents why inject is required', async () => {
    // Guards the reasoning, not just the behaviour: an eager lookup returns
    // undefined, which is precisely what the old code threw on.
    const root = await mkdtemp(join(tmpdir(), 's2s-race-eager-'))
    dirs.push(root)
    const ctx = new Context()
    ctx.logger.warn = vi.fn() as never
    stubHost(ctx)

    const ledger = new S2sLedger(ctx, { timerIntervalMs: 0 })
    // Eager: service not yet provided.
    await expect(ledger.open()).rejects.toThrow(/not available yet/)
    expect(ledger.isOpen).toBe(false)

    // Later it IS available, and the same instance can then be opened — proving
    // the failure was timing, not a missing capability.
    await ctx.plugin(Storage)
    await ctx.plugin(sqliteStorage, { path: join(root, 'storage.db') })
    const facility = new DomainFacility(ctx, { backend: 'sqlite', routes: {} })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility as never)
    await ledger.open()
    expect(ledger.isOpen).toBe(true)
    expect(ledger.backend).toBe('storage-domain')
    disposers.push(async () => { await ledger.close(); await ctx.fiber.dispose() })
  })

  it('★ the ledger domain name is unchanged (no schema/domain drift from this fix)', async () => {
    // The fix is about *when* we open, not *what* we open.
    expect(LEDGER_DOMAIN).toBe('s2s')
  })
})
