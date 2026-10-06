/**
 * dsh-s2s entry plugin: same-host session-to-session interconnection.
 * No hub / network mesh — delivery is in-process via S2sBroker; dormant
 * sessions are woken via AgentRegistry.resume (lifecycle); names (titles)
 * address sessions (discovery). Config blocks gate optional features, so
 * a bare mount is just the broker + discovery + tools.
 * @module dsh-s2s
 */
import type { Context } from '@deepseek-ai/cordis'
import './types.ts'
import { S2sBroker } from './broker.ts'
import { S2sDiscoveryService } from './discovery.ts'
import { S2sLifecycleService, type LifecycleConfig } from './lifecycle.ts'
import { S2sBudget, type BudgetConfig } from './budget.ts'
import { buildSemanticJudge } from './judge.ts'
import { S2sScheduleService, type ScheduleConfig } from './schedule.ts'
import { S2sLedger, type LedgerConfig } from './ledger.ts'
import { ledgerDiagnostics } from './ledger-diagnostics.ts'
import * as toolsPlugin from './tools.ts'
import * as digestPlugin from './digest.ts'

export { S2sError } from './error.ts'
export type { S2sErrorCode } from './error.ts'
export { S2sBroker } from './broker.ts'
export type { S2sDeliverInput, S2sBrokerRecord, S2sDeliverState } from './broker.ts'
export { S2sDiscoveryService } from './discovery.ts'
export type { S2sSessionInfo, S2sResolveResult } from './discovery.ts'
export { S2sLifecycleService } from './lifecycle.ts'
export type { LifecycleConfig } from './lifecycle.ts'
export { S2sMailbox } from './mailbox.ts'
export type { MailboxEntry } from './mailbox.ts'
export { S2sBudget } from './budget.ts'
export type { BudgetConfig } from './budget.ts'
export { S2sScheduleService } from './schedule.ts'
export type { ScheduleConfig } from './schedule.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-s2s'

/** Services the entry plugin itself consumes (children declare their own). */
export const inject: string[] = []

/** One plugin configuration: broker + discovery always on; lifecycle/budget optional. */
export interface Config {
  readonly lifecycle?: { enabled?: boolean; autoResume?: string; mailboxDir?: string }
  readonly budget?: BudgetConfig
  readonly schedule?: ScheduleConfig
  /** Ledger tuning. `timerIntervalMs: 0` disables the automatic sweep (tests). */
  readonly ledger?: LedgerConfig
}

/**
 * Mount the s2s core: the in-process broker + session discovery + tools, and
 * (when configured) the lifecycle wake path and the anti-loop budget.
 *
 * `config` defaults to `{}`: a bare mount (broker + discovery + tools only) is
 * a supported shape, and a profile row that declares no `config` block at all
 * hands `undefined`. Reading `config.lifecycle` then threw
 * `Cannot read properties of undefined (reading 'lifecycle')`, so the bare
 * mount this function documents was the one shape that could not mount.
 * (Upstream fix `v0.4.0-s2s.13`; taken here while 0.2.x support was being added.)
 */
export function apply(ctx: Context, config: Config = {}): void {
  ctx.plugin(S2sBroker)
  ctx.plugin(S2sDiscoveryService)
  if (config.lifecycle !== undefined) {
    ctx.plugin(S2sLifecycleService, {
      ...(config.lifecycle.enabled === undefined ? {} : { enabled: config.lifecycle.enabled }),
      autoResume: config.lifecycle.autoResume === 'allow' ? 'allow' : 'deny',
      ...(config.lifecycle.mailboxDir === undefined ? {} : { mailboxDir: config.lifecycle.mailboxDir }),
    })
  }
  if (config.budget !== undefined) {
    // An injected semantic judge drives the anti-loop semantic layer; its model call degrades to the counting caps on any failure.
    const judge = config.budget.semantic?.enabled ? buildSemanticJudge(ctx) : undefined
    ctx.provide('s2sBudget', new S2sBudget(config.budget, judge))
  }
  if (config.schedule !== undefined) {
    ctx.plugin(S2sScheduleService, config.schedule)
  }
  ctx.plugin(S2sLedger, config.ledger ?? {})
  // Wait for `storageDomain` to *appear* instead of racing it (measured defect).
  //
  // The host builds its storage chain asynchronously: `dsh-base` patches in
  // `storage` + `storage-json`, and `@deepseek-ai/dsh-storage-domain` provides
  // `storageDomain` only **inside** its own `ctx.inject([backendServiceKey], …)`
  // callback. So at the moment this plugin mounts, `ctx.get('storageDomain')` is
  // legitimately `undefined` — not because the host lacks a store, but because
  // the chain has not finished. The previous code asked once, threw, and never
  // retried, so the ledger stayed shut for the whole process and `s2s_status`
  // reported "no storageDomain" forever. Measured on this machine: `~/.dsh/storages`
  // exists and is actively written by the host's own projection cache, which is
  // what proved the environment was never the problem.
  //
  // `ctx.inject` is the right shape for that: probe-verified that injecting a
  // service which never appears does NOT throw and does NOT stall mounting (the
  // fiber stays ACTIVE, only the callback is withheld), and that the callback
  // fires by itself once the service is provided. So this neither races, nor
  // polls with a magic timeout, nor changes `S2sLedger.inject`.
  //
  // The ledger stays **optional**: if the host never provides the service, this
  // callback simply never runs and the tools keep working untracked (I1/G9 —
  // absence is reported by `s2s_status`, never invented).
  //
  // ★ Diagnostics + the stable-reference fix (review verdict: fix and instrument
  // in ONE deploy, so the next restart yields both evidence and, if it works, a
  // working ledger).
  //
  // Measured on the real host (commit d4a7f69, `s2s_status`):
  //   register=true fired=1 ledgerVisible=false openOk=false
  //   live probes: ctx.get(storageDomain)=PRESENT ctx.get(storage)=PRESENT storage.domain=PRESENT
  // i.e. the injection DID fire and the store IS present, but looking the ledger
  // up from INSIDE the callback returned undefined, so `open()` was never called.
  // The old code did exactly that lookup, so the lookup is the blocker.
  //
  // The fix: capture the reference here, in `apply()` scope, and hand it to the
  // callback. This differs from `domainCtx.get(...)` in a way that is measurable
  // rather than assumed — `tools.ts` already proves an `apply()`-scope lookup
  // works on this host (that is how `s2s_status` reports ledger state at all).
  //
  // `callbackLedgerVisible` is kept because the review explicitly requires the
  // distinction: if the outer lookup is ALSO invisible on the real host, this is
  // NOT a fix and the next step is service lifecycle / `ctx.plugin` semantics —
  // not another guess. `openCalled` separates "never reached" from "reached and
  // failed", which is the ambiguity that cost several rounds.
  // NOTE the ordering hazard, which a test caught in the first cut of this fix:
  // `ctx.plugin(S2sLedger, …)` above is asynchronous, so capturing the reference
  // here — at `apply()` top level — reads it BEFORE the service registers and
  // yields `undefined`. The capture must therefore happen lazily, INSIDE the
  // callback (which only runs once `storageDomain` exists, long after our own
  // service registered), while still reading through `ctx` rather than through
  // the injected child context. That keeps the one property the measurement
  // supports (an `apply()`-scope `ctx` lookup works on the real host — that is
  // how `s2s_status` reports ledger state at all) without racing our own service.
  ledgerDiagnostics.injectRegistered = true
  ctx.inject(['storageDomain'], function(domainCtx) {
    ledgerDiagnostics.injectFired = (ledgerDiagnostics.injectFired ?? 0) + 1
    ledgerDiagnostics.injectFiredAt = Date.now()
    // Captured through the outer `ctx`, NOT `domainCtx` — see the note above.
    const ledger = ctx.get('s2sLedger') as S2sLedger | undefined
    ledgerDiagnostics.outerLedgerVisible = ledger !== undefined
    // Recorded for the record only: the measured failure was this lookup being
    // undefined while the store itself was present.
    ledgerDiagnostics.callbackLedgerVisible = domainCtx.get('s2sLedger') !== undefined
    if (ledger === undefined) {
      // Distinct wording, so a reading cannot be mistaken for "open failed".
      ledgerDiagnostics.openError = 'not attempted: ctx.get(\'s2sLedger\') was undefined at callback time'
      return
    }
    ledgerDiagnostics.openCalled = true
    void ledger.open().then(function() {
      ledgerDiagnostics.openSucceeded = true
    }).catch(function(error: unknown) {
      ledgerDiagnostics.openError = String(error)
      // Loud, never fatal: a silently absent ledger turns every later status
      // read into an invention.
      domainCtx.logger.warn(
        `s2s: the durable ledger could not be opened (${String(error)}); `
        + 'messages will not be tracked and s2s_status will have nothing to report.',
      )
    })
  })
  ctx.plugin(toolsPlugin)
  ctx.plugin(digestPlugin)
}

