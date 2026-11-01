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
import { ledgerDiagnostics } from '../src/ledger-diagnostics.ts'
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

  it('★★★ the ledger registers a teardown hook that releases the domain', async () => {
    // The measured defect (2026-10-29, real machine): after an earlier instance
    // had opened the domain, the next attempt reported
    //   `DomainError: domain 's2s' is already open`
    // and the ledger stayed shut for the whole process — every write degraded to
    // "untracked". `s2s.json` held 4.1 MB written the previous evening, so an
    // earlier instance HAD opened it and never let go: `close()` was called from
    // tests only, and the constructor's `ctx.effect` released the timer but not
    // the domain.
    //
    // This test does not call `close()` by hand. It disposes the ledger's own
    // plugin fiber (the same thing a reload does) and then asks a brand-new
    // instance to claim the SAME domain name against the SAME backend.
    const root = await mkdtemp(join(tmpdir(), 's2s-release-'))
    dirs.push(root)
    const ctx = new Context()
    ctx.logger.warn = vi.fn() as never
    stubHost(ctx)

    await ctx.plugin(Storage)
    await ctx.plugin(sqliteStorage, { path: join(root, 'storage.db') })
    const facility = new DomainFacility(ctx, { backend: 'sqlite', routes: {} })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility as never)

    // First instance: mount as a real plugin and dispose THAT fiber. Disposing
    // the whole ctx would also remove the `storageDomain` provider, which is a
    // different question from the defect.
    const firstFiber = await ctx.plugin(S2sLedger)
    const first = ctx.get('s2sLedger') as S2sLedger
    await first.open()
    expect(first.isOpen).toBe(true)
    await firstFiber.dispose()
    // The effect hook's teardown is async; cordis does not await it for us.
    await vi.waitFor(() => { expect(first.isOpen).toBe(false) }, { timeout: 2000 })

    // A reload: same domain name, same facility. Before the fix this threw
    // `domain 's2s' is already open`; now the teardown gave it back.
    const second = new S2sLedger(ctx)
    await second.open()
    expect(second.isOpen).toBe(true)
    // Usable, not merely "open" in the bookkeeping sense.
    await second.record({ msgId: 'm-after-reload', from: 'alice', to: 'sess-1', text: 'post-reload' })
    const rows = await second.query()
    expect(rows.some((r) => r.msgId === 'm-after-reload')).toBe(true)
    disposers.push(async () => { await second.close(); await ctx.fiber.dispose() })
  })

  it('★★ disposing a plugin that never opened must not throw', async () => {
    // Teardown has to tolerate the common shape: the host never provided
    // `storageDomain`, so `open()` never ran. A release hook that assumes an
    // open domain would turn every such shutdown into an error.
    const ctx = new Context()
    ctx.logger.warn = vi.fn() as never
    stubHost(ctx)
    const ledger = new S2sLedger(ctx)
    expect(ledger.isOpen).toBe(false)
    await expect(ctx.fiber.dispose()).resolves.toBeUndefined()
    expect(ledger.isOpen).toBe(false)
  })

  it('★★★ dispose DURING an in-flight open still releases the domain (the join branch)', async () => {
    // Why this exists: the ★★★ test above disposes AFTER `await open()` settled,
    // so `this.opening` is already undefined there and the "join the pending open
    // first" branch in `releaseDomain` never executes. Measured: deleting that
    // join (`MUT-NOJOIN`) leaves the whole suite green — i.e. the branch had no
    // coverage at all, and the comment claiming the join is necessary was
    // reasoning without evidence.
    //
    // This test does not prove the join is *required* for correctness either. It
    // proves something narrower and checkable: disposing while an open is in
    // flight does not wedge the domain, and the domain is free afterwards.
    const root = await mkdtemp(join(tmpdir(), 's2s-inflight-'))
    dirs.push(root)
    const ctx = new Context()
    ctx.logger.warn = vi.fn() as never
    stubHost(ctx)

    await ctx.plugin(Storage)
    await ctx.plugin(sqliteStorage, { path: join(root, 'storage.db') })
    const facility = new DomainFacility(ctx, { backend: 'sqlite', routes: {} })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility as never)

    const fiber = await ctx.plugin(S2sLedger)
    const ledger = ctx.get('s2sLedger') as S2sLedger
    // Start the open and dispose WITHOUT awaiting the open first — this is the
    // only shape in which `this.opening` is still set when teardown runs.
    const opening = ledger.open()
    const disposing = fiber.dispose()
    await Promise.allSettled([opening, disposing])

    // Whatever happened to the open, the name must be free for the next mount.
    const second = new S2sLedger(ctx)
    await second.open()
    expect(second.isOpen).toBe(true)
    disposers.push(async () => { await second.close(); await ctx.fiber.dispose() })
  })

  it('★ a failed domain release is RECORDED, not swallowed', async () => {
    // The earlier version ended `releaseDomain` with `.catch(() => {})`. Cordis
    // already routes a rejected disposable to `logger.error`, so that catch did
    // not prevent an error — it deleted the only trace of one. A failed release
    // is exactly what leaves the domain claimed, so it has to be readable.
    const ctx = new Context()
    ctx.logger.warn = vi.fn() as never
    stubHost(ctx)
    const ledger = new S2sLedger(ctx)
    // Force close() to fail, then release: the error must land in the field.
    const boom = new Error('ZZ_RELEASE_BOOM')
    ;(ledger as unknown as { close: () => Promise<void> }).close = () => Promise.reject(boom)
    ;(ledger as unknown as { domain: unknown }).domain = { close: () => Promise.reject(boom) }
    const release = (ledger as unknown as { releaseDomain: () => Promise<void> }).releaseDomain()
    await expect(release).resolves.toBeUndefined()
    expect(ledgerDiagnostics.domainReleaseError).toContain('ZZ_RELEASE_BOOM')
  })

  it('★★ a successful release is COUNTED, so "no error" is not mistaken for "did not run"', async () => {
    // `domainReleaseError` being unset has two possible causes: the release ran
    // and succeeded, or teardown never had a domain to release. Reading the
    // absence of an error as "the release worked" is unsound unless something
    // distinguishes them. The counter is that something.
    const before = ledgerDiagnostics.domainReleasedCount ?? 0

    // (a) A ledger that opened a real domain: releasing must bump the counter.
    const withDomain = new S2sLedger(new Context())
    ;(withDomain as unknown as { domain: unknown }).domain = { close: () => Promise.resolve() }
    await (withDomain as unknown as { releaseDomain: () => Promise<void> }).releaseDomain()
    expect(ledgerDiagnostics.domainReleasedCount ?? 0).toBe(before + 1)

    // (b) A ledger that never opened: nothing to release, so the counter must NOT
    // move — otherwise the number would stop distinguishing the two causes.
    const neverOpened = new S2sLedger(new Context())
    await (neverOpened as unknown as { releaseDomain: () => Promise<void> }).releaseDomain()
    expect(ledgerDiagnostics.domainReleasedCount ?? 0).toBe(before + 1)
  })

  it('★★ a release counter alone cannot prove completeness — the acquired/released PAIR can', async () => {
    // Why the pair exists: `domainReleasedCount` has no reference value. Nothing
    // says how many unloads a process *should* see, so `released >= 1` only proves
    // "at least once" and never "nothing was skipped". Counting acquisitions gives
    // the missing denominator: `acquired - released` is the number of domains still
    // open, so a positive remainder that no live instance accounts for means a
    // teardown skipped the release path.
    //
    // This case pins the invariant directly, so a future edit that moves one
    // increment without the other goes red here.
    const acquired0 = ledgerDiagnostics.domainAcquiredCount ?? 0
    const released0 = ledgerDiagnostics.domainReleasedCount ?? 0

    // A real open on a real facility: acquired must advance by exactly one.
    const root = await mkdtemp(join(tmpdir(), 's2s-pair-'))
    dirs.push(root)
    const ctx = new Context()
    ctx.logger.warn = vi.fn() as never
    stubHost(ctx)
    await ctx.plugin(Storage)
    await ctx.plugin(sqliteStorage, { path: join(root, 'storage.db') })
    const facility = new DomainFacility(ctx, { backend: 'sqlite', routes: {} })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility as never)

    const first = new S2sLedger(ctx)
    await first.open()
    expect(ledgerDiagnostics.domainAcquiredCount ?? 0).toBe(acquired0 + 1)
    // Still open ⇒ not yet released: the pair must stay unbalanced by exactly one.
    expect((ledgerDiagnostics.domainAcquiredCount ?? 0) - (ledgerDiagnostics.domainReleasedCount ?? 0)).toBe(
      acquired0 - released0 + 1,
    )

    // Releasing through the teardown path ⇒ the pair rebalances. That equality is
    // the completeness property: every acquisition is matched by a release.
    // Note it must go through `releaseDomain`, not `close()`: `close()` only closes
    // the domain handle, while the counter tracks the *teardown path*. Asserting
    // against `close()` would be measuring a different thing than the counter does.
    await (first as unknown as { releaseDomain: () => Promise<void> }).releaseDomain()
    expect((ledgerDiagnostics.domainAcquiredCount ?? 0) - (ledgerDiagnostics.domainReleasedCount ?? 0)).toBe(
      acquired0 - released0,
    )
    disposers.push(async () => { await ctx.fiber.dispose() })
  })

  it('★★ mountedInstances is a RUNTIME count — two live instances show as 2, and teardown brings it back', async () => {
    // The completeness check is `acquired - released == mountedInstances`, so the
    // right-hand side has to be observable at runtime. It must NOT be taken from
    // the config file: a reload or re-composition produces a second live instance
    // while the config still lists one mount, and that overlap is exactly when a
    // release is most likely to be skipped. This case pins the runtime property —
    // the count follows live objects, not configuration.
    const base = ledgerDiagnostics.mountedInstances ?? 0

    const ctxA = new Context()
    ctxA.logger.warn = vi.fn() as never
    stubHost(ctxA)
    const first = new S2sLedger(ctxA)
    expect(ledgerDiagnostics.mountedInstances ?? 0).toBe(base + 1)

    // A second instance on its OWN context — this is the reload / re-composition
    // overlap: two live instances exist while the config file still lists one
    // mount. A config-derived count would read 1 here and the check would pass
    // while a domain is actually still held. (Two instances on ONE context is not
    // the real shape: cordis rejects duplicate service registration, so the
    // overlap always comes from separate contexts.)
    const ctxB = new Context()
    ctxB.logger.warn = vi.fn() as never
    stubHost(ctxB)
    const secondLive = new S2sLedger(ctxB)
    expect(ledgerDiagnostics.mountedInstances ?? 0).toBe(base + 2)

    // Disposing one context brings the count down by exactly one, leaving the
    // other instance still visible — that is what "live" has to mean.
    await ctxB.fiber.dispose()
    expect(ledgerDiagnostics.mountedInstances ?? 0).toBe(base + 1)

    await ctxA.fiber.dispose()
    expect(ledgerDiagnostics.mountedInstances ?? 0).toBe(base)
    expect(ledgerDiagnostics.mountedInstances ?? 0).toBeGreaterThanOrEqual(0)
    void first
    void secondLive

    // A double dispose must not drive it negative — the floor is part of the
    // contract, because a negative denominator would make the check pass silently.
    await ctxA.fiber.dispose()
    expect(ledgerDiagnostics.mountedInstances ?? 0).toBe(base)
  })

  it('★★ the floor at zero is ENFORCED, not just documented', async () => {
    // Why this case exists, separately: removing `Math.max(0, …)` left the whole
    // suite green (measured 2026-11-01, 12/12 passed under MUT-NOFLOOR). The
    // previous case could not catch it — it disposes matched pairs, so the counter
    // never goes below its own starting value. A floor that nothing exercises is a
    // comment, not a contract, and the failure it guards is silent by construction:
    // a negative denominator makes `acquired - released == mountedInstances`
    // compare against a number that can never be reached, so the check stops
    // reporting anything at all.
    //
    // Force the unmatched case: start from a known baseline, then drive a teardown
    // when nothing is mounted.
    const base = ledgerDiagnostics.mountedInstances ?? 0
    expect(base).toBeGreaterThanOrEqual(0)

    ledgerDiagnostics.mountedInstances = 0
    // An extra teardown with no instance to match it is exactly the shape that
    // would go negative without the floor.
    const ctx = new Context()
    ctx.logger.warn = vi.fn() as never
    stubHost(ctx)
    const orphan = new S2sLedger(ctx)
    // Undo the construction's own increment so the teardown below is unmatched.
    ledgerDiagnostics.mountedInstances = 0
    await ctx.fiber.dispose()

    expect(ledgerDiagnostics.mountedInstances).toBe(0)
    expect(ledgerDiagnostics.mountedInstances ?? 0).not.toBe(-1)
    void orphan

    ledgerDiagnostics.mountedInstances = base
  })
})
