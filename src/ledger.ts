/**
 * The s2s ledger: a durable index over what was sent and what became of it.
 *
 * **It is not a second source of truth.** A delivery's truth is the target
 * session's log — this ledger only records what s2s did and caches what it has
 * been able to verify, so that a caller can ask "what happened to that message"
 * without re-reading every session. Losing the ledger costs a rebuild, never a
 * fact. (That asymmetry is why the `sessions` table may be treated as cache
 * while `messages` is authoritative for *s2s's own attempts*.)
 *
 * Storage is the DSH storage domain (`ctx.storageDomain`, opened over
 * `ledgerDomain`). When that service is absent the ledger has no durable home;
 * this module deliberately **fails loudly** rather than pretending to work —
 * a ledger that silently keeps nothing is worse than no ledger, because the
 * status it reports would be invented.
 *
 * @module dsh-s2s/ledger
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { S2sError } from './error.ts'
import { readSessionLog } from './history.ts'
import {
  LEDGER_LIMITS,
  MESSAGES_TABLE,
  MESSAGE_STATUSES,
  TERMINAL_STATUSES,
  ledgerDomain,
  type MessageRecord,
  type MessageStatus,
} from './ledger-schema.ts'

/**
 * Run a ledger write **without ever failing the caller**.
 *
 * The ledger is optional infrastructure: the plan treats `storageDomain` as
 * optional (Q2 names a self-built JSON fallback) and the desktop profile mounts
 * no storage backend at all. When it is absent the `S2sLedger` service still
 * exists in the context — it simply never opened — so an unguarded `record()`
 * throws `s2s ledger: used before open()` and **the message is never delivered**.
 *
 * That is a measured outage, not a hypothetical: a deployment with no storage
 * backend turned an optional bookkeeping step into a total delivery failure.
 * Bookkeeping must never outrank delivery. The failure stays visible (G9: no
 * silent degradation) through a warning naming the operation, and the caller
 * proceeds.
 *
 * It lives next to the service rather than in one of its callers because both
 * delivery paths need it (the live path in `tools.ts`, the dormant path in
 * `lifecycle.ts`) and two copies would drift: the guard's whole value is that
 * it is applied *everywhere* a ledger write happens.
 *
 * @param ledger - the ledger service, or `undefined` when none is mounted.
 * @param operation - the ledger method name, for the warning.
 * @param run - the actual call, invoked only when a ledger is present.
 */
export async function noteLedger(
  ledger: S2sLedger | undefined,
  operation: string,
  run: () => Promise<void>,
): Promise<void> {
  if (ledger === undefined) return
  try {
    await run()
  } catch (error: unknown) {
    ledger.warn(operation, error)
  }
}

/** What a caller supplies when recording an outgoing message. */export interface S2sLedgerRecordInput {
  /** Idempotency key; also the primary key. */
  msgId: string
  /** Sender label (the tool's `from`, or an agent id). */
  from: string
  /** Target **as addressed** — the name or id the caller actually wrote. */
  to: string
  /** Body; truncated to `LEDGER_LIMITS.textMaxChars` with `truncated` set. */
  text: string
  /** Optional context label. */
  replyTo?: string
  /** Stable identity; null until P3 fills it. */
  fromLineage?: string | null
  toLineage?: string | null
  /** Enqueue time; defaults to now. Injectable so tests can pin it. */
  createdAt?: number
}

/** What `query()` filters on. All fields are conjunctive. */
export interface S2sLedgerQuery {
  /** Exact primary key. */
  msgId?: string
  /** Matches the resolved target, or the addressing string when unresolved. */
  sessionId?: string
  /** Matches either lineage column (P3; empty in P2). */
  lineage?: string
  /** Only records created at or after this epoch ms. */
  since?: number
}

/** Where the ledger's bytes actually live, for honest reporting in tool output. */
export type S2sLedgerBackend = 'storage-domain'

/** What one `reconcile()` pass over a target's log changed (and could not). */
export interface ReconcileResult {
  readonly sessionId: string
  /** Rows belonging to this target that were eligible for landing. */
  readonly examined: number
  /** Rows advanced to `landed` with a `landedSeq`. */
  readonly landed: number
  /** True when the target's log could not be read at all. */
  readonly unreadable: boolean
  /** Deliveries visible in the log, when it was readable. */
  readonly seenInLog?: number
}

export class S2sLedger extends Service {
  /**
   * `storageDomain` is looked up lazily through `ctx.get` rather than declared
   * in `inject`: the plan treats it as optional (Q2 names a self-built JSON
   * fallback), and `inject` would make the whole plugin fail to mount without
   * it. The absence is surfaced in `open()` instead.
   */
  private domain: Domain<typeof ledgerDomain> | undefined

  constructor(ctx: Context) {
    super(ctx, 's2sLedger')
  }

  /** The backing store in use, or `undefined` before a successful `open()`. */
  get backend(): S2sLedgerBackend | undefined {
    return this.domain === undefined ? undefined : 'storage-domain'
  }

  /** Whether the ledger is ready to serve reads and writes. */
  get isOpen(): boolean {
    return this.domain !== undefined
  }

  /**
   * Open the durable ledger.
   *
   * Idempotent: a second call returns without reopening (the facility rejects a
   * duplicate open of one domain name by design, so re-opening would throw).
   *
   * @throws S2sError when no `storageDomain` service is mounted. Returning
   *   quietly would leave every later status read fabricated.
   */
  async open(): Promise<void> {
    if (this.domain !== undefined) return
    const facility = this.ctx.get('storageDomain') as
      | { open(spec: typeof ledgerDomain): Promise<Domain<typeof ledgerDomain>> }
      | undefined
    if (facility === undefined) {
      throw new S2sError(
        's2s ledger: the `storageDomain` service is not mounted, so the ledger has no durable store. '
        + 'Mount the storage-domain plugin (or wait for the self-built JSON fallback).',
        'S2S_LEDGER',
      )
    }
    this.domain = await facility.open(ledgerDomain)
  }

  /** Close the domain. Safe to call when never opened. */
  async close(): Promise<void> {
    const domain = this.domain
    this.domain = undefined
    if (domain !== undefined) await domain.close()
  }

  private opened(): Domain<typeof ledgerDomain> {
    const domain = this.domain
    if (domain === undefined) {
      throw new S2sError('s2s ledger: used before open()', 'S2S_LEDGER')
    }
    return domain
  }

  /**
   * Record one outgoing message. The row starts `queued` — s2s has accepted it
   * and nothing has been delivered yet. `attempts` starts at 0 and
   * `nextAttemptAt` at the enqueue instant, so an untouched row is immediately
   * eligible for its first attempt.
   *
   * Writing the same `msgId` twice overwrites rather than appending: the id is
   * the idempotency key, and a caller that retries a tool call must not create
   * a second row for one message.
   *
   * @param input - the message as the caller supplied it.
   */
  async record(input: S2sLedgerRecordInput): Promise<void> {
    const domain = this.opened()
    const createdAt = input.createdAt ?? Date.now()
    const { text, truncated } = this.truncate(input.text)
    const row: MessageRecord = {
      msgId: input.msgId,
      from: input.from,
      to: input.to,
      resolvedSessionId: null,
      resolvedAt: null,
      fromLineage: input.fromLineage ?? null,
      toLineage: input.toLineage ?? null,
      text,
      truncated,
      createdAt,
      updatedAt: createdAt,
      attempts: 0,
      maxRetries: LEDGER_LIMITS.maxRetries,
      nextAttemptAt: createdAt,
      status: 'queued',
      landedSeq: null,
      replyTo: input.replyTo ?? null,
      lastError: null,
      unreadableSince: null,
    }
    await domain.table(MESSAGES_TABLE).put(row.msgId, row)
  }

  /**
   * Report a ledger operation that failed, **without letting it break the caller**.
   *
   * Callers guard their writes with this so an unopened or broken ledger degrades
   * to "untracked" rather than failing the delivery, while still leaving an
   * observable trace (G9). It lives here because the service owns its logger.
   *
   * @param operation - the ledger method that failed (named in the message).
   * @param error - the thrown value.
   */
  warn(operation: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error)
    this.ctx.logger.warn(
      `s2s: ledger.${operation}() failed (${message}); `
      + 'the message is still delivered, but it will not be tracked.',
    )
  }

  /**
   * Advance a row to `inboxed`: s2s has handed the message to a **live** agent,
   * which is strictly more than "we accepted it" and strictly less than "it is
   * in the target's log".
   *
   * This is the only place `resolvedSessionId` is written (the plan's §13.1
   * responsibility split): `record()` deliberately leaves it `null` while
   * queued, and the broker — which has already resolved the id — passes it here
   * **once**, rather than the ledger caching a second resolution.
   *
   * Never regresses: a row already at or past `inboxed`, and a terminal row, are
   * left alone. Delivery paths can race (a retry after a late success), and
   * resurrecting a `dead_letter` by touching it here would erase the evidence
   * that it failed.
   *
   * @param msgId - the row to advance.
   * @param resolvedSessionId - the id the message was actually delivered into.
   */
  async markInboxed(msgId: string, resolvedSessionId: string): Promise<void> {
    const domain = this.opened()
    const table = domain.table(MESSAGES_TABLE)
    const row = table.get(msgId)
    if (row === undefined) {
      // Reachable if a caller delivers without recording first. Not fatal to the
      // delivery, but it must not pass unremarked — a ledger silently missing
      // rows is worse than one that says it is missing them (G9).
      this.ctx.logger.warn(
        `s2s ledger: markInboxed("${msgId}") found no recorded row; the delivery is not tracked. `
        + 'Record the message before delivering it.',
      )
      return
    }
    if (row.status === 'inboxed' || row.status === 'landed' || row.status === 'consumed') return
    if ((TERMINAL_STATUSES as readonly string[]).includes(row.status)) return
    await table.put(msgId, {
      ...row,
      status: 'inboxed',
      resolvedSessionId,
      updatedAt: Date.now(),
    })
  }

  /**
   * Reconcile tracked rows against the **target's log**: a delivery that s2s
   * handed over is not yet "delivered" in the only sense the plan accepts — the
   * truth of a delivery is the target session's log (`inboxed` is our side of
   * the story, `landed` is the target's).
   *
   * `landedSeq` is defined in the schema as *the `seq` of the target-log
   * `user/message` that matched this `msgId`*, so this reads the log through the
   * **same parser `s2s_history` uses** (`readSessionLog`) rather than a second
   * implementation: history renders those records, this advances rows by them,
   * and one parser means the two cannot disagree about what landed means.
   *
   * Only rows that could plausibly have landed are examined: already-`landed`/
   * `consumed` and terminal rows are skipped, and a row without a recorded
   * `resolvedSessionId` has no log to read. Progress is **monotonic** — this
   * never walks a row backwards, and never revives a terminal one.
   *
   * A log that cannot be read is reported, not silently treated as "nothing
   * landed": `unreadableSince` is stamped so a caller can apply the
   * `landedDeadlineMs` deadline, and it is cleared on a successful read.
   *
   * @param sessionId - the target whose log to reconcile against.
   * @param opts.now - injectable clock, so tests can pin times.
   * @returns what changed, and what could not be read.
   */
  async reconcile(sessionId: string, opts: { now?: number } = {}): Promise<ReconcileResult> {
    const domain = this.opened()
    const now = opts.now ?? Date.now()
    const entries = await readSessionLog(this.ctx, sessionId, LEDGER_LIMITS.reconcileTtlMs)
    const unreadable = entries === undefined
    let examined = 0
    let landed = 0
    const table = domain.table(MESSAGES_TABLE)
    // The `seq` of the log record that carries each msgId, which is exactly what
    // `landedSeq` means.
    const seqByMsgId = new Map<string, number>()
    for (const entry of entries ?? []) {
      if (entry.msgId !== undefined && entry.seq !== undefined) seqByMsgId.set(entry.msgId, entry.seq)
    }

    for (const [, row] of table.entries()) {
      if (row.resolvedSessionId !== sessionId) continue
      if (row.status === 'landed' || row.status === 'consumed') continue
      if ((TERMINAL_STATUSES as readonly string[]).includes(row.status)) continue
      examined += 1
      if (unreadable) {
        // Recorded so a caller can enforce the deadline; never silently ignored.
        if (row.unreadableSince === null || row.unreadableSince === undefined) {
          await table.put(row.msgId, { ...row, unreadableSince: now, updatedAt: now })
        }
        continue
      }
      const seq = seqByMsgId.get(row.msgId)
      if (seq === undefined) {
        // Readable log, no matching record: the delivery has not landed *yet*.
        // Clear any stale unreadable marker — the log is readable now.
        if (row.unreadableSince !== null && row.unreadableSince !== undefined) {
          await table.put(row.msgId, { ...row, unreadableSince: null, updatedAt: now })
        }
        continue
      }
      await table.put(row.msgId, {
        ...row,
        status: 'landed',
        landedSeq: seq,
        unreadableSince: null,
        updatedAt: now,
      })
      landed += 1
    }
    return {
      sessionId,
      examined,
      landed,
      unreadable,
      ...(entries === undefined ? {} : { seenInLog: entries.length }),
    }
  }

  /**
   * Read records back. With no filter this is every record, oldest first.
   *
   * `sessionId` matches the **resolved** target when there is one, and falls
   * back to the addressing string while the row is still `queued` (a caller
   * that addressed the session by its id leaves that id in `to`, and matching
   * only on `resolvedSessionId` would hide every not-yet-delivered row — the
   * ones a status query is most likely to be asked about).
   *
   * @param q - conjunctive filters.
   * @returns matching records, sorted by `createdAt` then `msgId` so the order
   *   is stable when two rows share a timestamp.
   */
  async query(q: S2sLedgerQuery = {}): Promise<MessageRecord[]> {
    const domain = this.opened()
    const out: MessageRecord[] = []
    for (const [, row] of domain.table(MESSAGES_TABLE).entries()) {
      if (q.msgId !== undefined && row.msgId !== q.msgId) continue
      if (q.sessionId !== undefined
        && row.resolvedSessionId !== q.sessionId
        && row.to !== q.sessionId) continue
      if (q.lineage !== undefined
        && row.fromLineage !== q.lineage
        && row.toLineage !== q.lineage) continue
      if (q.since !== undefined && row.createdAt < q.since) continue
      out.push({ ...row })
    }
    out.sort((a, b) => a.createdAt === b.createdAt
      ? (a.msgId < b.msgId ? -1 : a.msgId > b.msgId ? 1 : 0)
      : a.createdAt - b.createdAt)
    return out
  }

  /** One record by primary key, or `undefined`. */
  async get(msgId: string): Promise<MessageRecord | undefined> {
    return this.opened().table(MESSAGES_TABLE).get(msgId)
  }

  /**
   * Shorten a body to the stored limit.
   * @param text - the full body.
   * @returns the stored text and whether it was cut.
   */
  private truncate(text: string): { text: string; truncated: boolean } {
    const limit = LEDGER_LIMITS.textMaxChars
    if (text.length <= limit) return { text, truncated: false }
    return { text: text.slice(0, limit), truncated: true }
  }
}

/** Re-exported so callers can name a status without importing the schema. */
export type { MessageStatus }
export { MESSAGE_STATUSES }
