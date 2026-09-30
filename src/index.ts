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
import { S2sLedger } from './ledger.ts'
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
  ctx.plugin(S2sLedger)
  // Opening is async and `storageDomain` is optional (Q2 allows a self-built
  // fallback), so a failure must not abort mounting the plugin — the tools are
  // still useful without a ledger. It must, however, be *loud*: a silently
  // absent ledger turns every later status read into an invention (G9).
  void (async function() {
    const ledger = ctx.get('s2sLedger') as S2sLedger | undefined
    if (ledger === undefined) return
    try {
      await ledger.open()
    } catch (error: unknown) {
      ctx.logger.warn(
        `s2s: the durable ledger could not be opened (${String(error)}); `
        + 'messages will not be tracked and s2s_status will have nothing to report.',
      )
    }
  })()
  ctx.plugin(toolsPlugin)
  ctx.plugin(digestPlugin)
}

