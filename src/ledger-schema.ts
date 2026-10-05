/**
 * The ledger domain: the durable record of what s2s sent and what became of it.
 *
 * This module is the **single declaration site** for the domain's identity,
 * its record schemas, and the numeric constants the rest of the ledger reads.
 * Everything else (the runtime in `ledger.ts`, the tools, the tests) imports
 * from here rather than restating a field list or a default, so a change to
 * the shape happens in one place.
 *
 * Why the ledger exists at all: a delivery's *truth* is the target session's
 * log — the ledger is an **index and cache over it**, never a second source of
 * truth. That is why the `sessions` table is explicitly rebuildable and why
 * nothing here is allowed to become the only copy of a fact.
 *
 * @module dsh-s2s/ledger-schema
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/** Domain name; also the backend unit name. Must match the storage `UNIT_NAME_RE`. */
export const LEDGER_DOMAIN = 's2s'

/** Domain format version. Bumped only for breaking layout changes (see §13.1b/R16). */
export const LEDGER_DOMAIN_VERSION = 1

/** Table holding one record per message. */
export const MESSAGES_TABLE = 'messages'

/** Table holding the session index cache. */
export const SESSIONS_TABLE = 'sessions'

/**
 * Message lifecycle states.
 *
 * This is the **single definition** of the state set (the plan's §12.3 state
 * machine is the prose form of it). `timeout` is deliberately absent: it had no
 * inbound transition — expiry routes to `queued` (retry) or `dead_letter`, so a
 * `timeout` row could never be written and a reader could never match it.
 */
export const MESSAGE_STATUSES = [
  'queued',
  'delivering',
  'inboxed',
  'landed',
  'consumed',
  'legacy_unverifiable',
  'dead_letter',
  'cancelled',
] as const

/** Terminal statuses: a record here must never be advanced or revived. */
export const TERMINAL_STATUSES = ['dead_letter', 'cancelled', 'legacy_unverifiable'] as const

/**
 * Numeric constants. The plan (§13.1b) requires these to have exactly one
 * definition site; import them instead of writing the number again.
 */
export const LEDGER_LIMITS = {
  /** How long a target log may stay unreadable before `landed` is judged unreachable. */
  landedDeadlineMs: 24 * 60 * 60 * 1000,
  /**
   * How often the ledger sweeps on its own (T24).
   *
   * The sweep is what makes `landedDeadlineMs` real: a deadline is only reached
   * if something advances the clock, and before this the only caller of
   * `reconcile()` was a tool a human had to invoke. An hour is frequent enough
   * that a 24 h deadline is honoured to within ~4%, and rare enough that the
   * cost is a log decode per tracked target per hour, not a poll.
   */
  sweepIntervalMs: 60 * 60 * 1000,
  /** Delivery attempts before a message is dead-lettered. */
  maxRetries: 3,
  /** Rolling retention window for the ledger. */
  retentionDays: 30,
  /** Row cap for the ledger (whichever of this and `retentionDays` hits first). */
  retentionRows: 10000,
  /** TTL for a `reconcile()` log read. */
  reconcileTtlMs: 5000,
  /**
   * Shorter TTL for a reconcile read that **failed**.
   *
   * A momentarily unreadable log usually recovers quickly; caching the failure
   * for the full `reconcileTtlMs` would keep the row at a stale `inboxed` purely
   * because nobody looked again — the gap would sustain itself.
   */
  reconcileFailureTtlMs: 500,
  /** Sessions reconciled in one request. */
  maxSessionsPerRequest: 8,
  /** Fallback thaw for a handover gate left frozen by a crashed roll. */
  rollTimeoutMs: 600000,
  /** Longest message body stored; longer text is truncated and flagged. */
  textMaxChars: 8000,
  /** Clamp for a `nextAttemptAt` implausibly far in the future (clock jump guard). */
  nextAttemptAtClampMs: 24 * 60 * 60 * 1000,
} as const

/** Message status as a value type. */
export type MessageStatus = (typeof MESSAGE_STATUSES)[number]

/**
 * One ledger row: a message s2s was asked to deliver, plus the state derived
 * for it. Fields marked optional in the plan are `.nullish()` rather than
 * `.optional()` — the medium round-trips JSON, and a cleared field must be
 * storable as an explicit `null`, not only as an absent key.
 */
export const messageRecordSchema = z.object({
  /** Primary key and idempotency key. */
  msgId: z.string().min(1),
  /** Sender label (the tool's `from`, or an agent id). */
  from: z.string(),
  /** Target **as addressed** (name or session id), kept to audit how it was named at the time. */
  to: z.string(),
  /**
   * Resolution snapshot. Written at `markInboxed()`; `null` while queued.
   * If an implementation pre-resolves, it must also stamp `resolvedAt`.
   */
  resolvedSessionId: z.string().nullish(),
  /** When the pre-resolution happened, if any. */
  resolvedAt: z.number().nullish(),
  /** Stable identity; P3 fills these, P2 leaves them `null` (contract, not an oversight). */
  fromLineage: z.string().nullish(),
  toLineage: z.string().nullish(),
  /** Body, truncated to `LEDGER_LIMITS.textMaxChars`. */
  text: z.string(),
  /** True when `text` was shortened; the original length is not stored. */
  truncated: z.boolean().default(false),
  /** Enqueue epoch ms. */
  createdAt: z.number(),
  /** Last state-change epoch ms. */
  updatedAt: z.number(),
  /** Delivery attempts so far. */
  attempts: z.number().int().min(0),
  /** Attempt budget for this row. */
  maxRetries: z.number().int().min(0),
  /** Earliest epoch ms at which the next attempt is allowed. */
  nextAttemptAt: z.number(),
  status: z.enum(MESSAGE_STATUSES),
  /** `seq` of the target-log `user/message` that matched this `msgId`. */
  landedSeq: z.number().nullish(),
  /** Context label from the sender. */
  replyTo: z.string().nullish(),
  /** Last failure reason — auditable, not merely a boolean. */
  lastError: z.string().nullish(),
  /**
   * When the target log first became unreadable. Cleared on a successful read.
   * Persisted on purpose: kept only in memory it would reset across a restart
   * and a zombie row would never reach its deadline.
   */
  unreadableSince: z.number().nullish(),
})

/** One ledger row. */
export type MessageRecord = z.infer<typeof messageRecordSchema>

/**
 * One row of the session index cache. This table is **derived data**: it is
 * rebuilt from `sessionQuery` plus the logs, so losing it costs a rebuild and
 * never a fact.
 */
export const sessionRecordSchema = z.object({
  sessionId: z.string().min(1),
  /** Most recently observed title; absent when the session has none yet. */
  title: z.string().nullish(),
  workspaceDir: z.string(),
  /** Last observed activity epoch ms. */
  lastSeenAt: z.number(),
  /** Last event type observed — the raw material for `s2s_digest`. */
  lastEventType: z.string().nullish(),
  /** Whether a turn is still open (no closing `turn/end`). */
  openTurn: z.boolean().default(false),
})

/** One session-cache row. */
export type SessionRecord = z.infer<typeof sessionRecordSchema>

/**
 * The ledger domain declaration.
 *
 * `invalidRecords` is deliberately **left at the default (reject)**: a corrupt
 * record fails the whole `open` with `invalid-record` naming the table and key.
 * That is the right behaviour for `messages`, which is authoritative — quietly
 * dropping the row that explained a delivery would hide the very thing the
 * ledger exists to show. The cost is that one damaged `sessions` row also
 * blocks the open; since `sessions` is rebuildable, a future revision can move
 * that table behind a separate domain (or take `backup-and-skip` and accept the
 * looser guarantee for `messages` too — the option is domain-wide, not per
 * table, so the two cannot be set independently here).
 */
export const ledgerDomain = defineDomain({
  name: LEDGER_DOMAIN,
  version: LEDGER_DOMAIN_VERSION,
  tables: {
    // The phantom key parameter is the **key space**, not one key: passing
    // `'msgId'` would type every lookup as the literal `"msgId"` and reject real
    // ids. Caught by `pnpm run typecheck` the moment the ledger used the table.
    [MESSAGES_TABLE]: domainTable<string, MessageRecord>(messageRecordSchema),
    [SESSIONS_TABLE]: domainTable<string, SessionRecord>(sessionRecordSchema),
  },
})

/** Table key types, recovered from the spec for callers that build keys. */
export type LedgerTables = {
  readonly messages: MessageRecord
  readonly sessions: SessionRecord
}
