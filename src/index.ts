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
import { ledgerDiagnostics, recordProbe } from './ledger-diagnostics.ts'
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
  // ★ Last directed real-host probe round (review verdict: "continue once, but
  // make this the final directed round").
  //
  // Two rounds of fixes failed on the host while every local model passed, and a
  // single reading per round could not separate the remaining explanations. So
  // this round records a SERIES — the same reading at four lifecycle points —
  // plus the one thing that distinguishes the surviving hypotheses: whether the
  // service implementation EXISTS but is gated off, versus never being visible at
  // all. See `LedgerProbe` for why that pair is the discriminator.
  //
  // Stop-loss agreed with the review: if `implPresent=true` with a non-ACTIVE
  // fiber, pick a lifecycle-compatible fix and verify once. If the impl is absent,
  // or the states contradict, or the mechanism still cannot be told apart —
  // stop chasing cordis and evaluate the self-built JSON backend instead.
  recordProbe(ctx, undefined, 'apply-entry')
  ledgerDiagnostics.injectRegistered = true
  ctx.inject(['storageDomain'], function(domainCtx) {
    ledgerDiagnostics.injectFired = (ledgerDiagnostics.injectFired ?? 0) + 1
    ledgerDiagnostics.injectFiredAt = Date.now()
    recordProbe(ctx, domainCtx, 'storage-domain-callback')
    // Microtask and macrotask re-reads: if the service becomes visible one tick
    // later, the cause is scheduling, not registration — a distinction no
    // same-tick reading can make.
    void Promise.resolve().then(function() { recordProbe(ctx, domainCtx, 'callback-microtask') })
    setTimeout(function() { recordProbe(ctx, domainCtx, 'callback-macrotask') }, 0)
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

