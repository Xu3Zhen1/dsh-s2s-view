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
import { readSessionLog, type HistoryEntry } from './history.ts'
import { recordUntrackedDelivery } from './ledger-diagnostics.ts'
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
 * The ledger is optional infrastructure: `storageDomain` is an optional service,
 * and a deployment may mount no storage backend at all. When it is absent the
 * `S2sLedger` service still exists in the context — it simply never opened — so
 * an unguarded `record()` throws `s2s ledger: used before open()` and **the
 * message is never delivered**.
 *
 * That is a measured outage, not a hypothetical: a deployment with no usable
 * storage backend turned an optional bookkeeping step into a total delivery
 * failure. Bookkeeping must never outrank delivery. The failure stays visible
 * (G9: no silent degradation) through a warning naming the operation, and the
 * caller proceeds.
 *
 * ★ Corrected 2026-10-09: an earlier version of this comment stated as measured
 * fact that "the desktop profile mounts no storage backend at all". That was the
 * retracted diagnosis. `storageDomain` is present and usable on this host (three
 * live probes read PRESENT); the ledger failed to open because cordis withholds
 * a service while its providing fiber is not ACTIVE, so `open()` ran one turn too
 * early. The ledger now opens. The guard is still required — optional
 * infrastructure may genuinely be absent elsewhere — but it is not evidence that
 * it is absent here.
 *
 * It lives next to the service rather than in one of its callers because both
 * delivery paths need it (the live path in `tools.ts`, the dormant path in
 * `lifecycle.ts`) and two copies would drift: the guard's whole value is that
 * it is applied *everywhere* a ledger write happens.
 *
 * @param ledger - the ledger service, or `undefined` when none is mounted.
 * @param operation - the ledger method name, for the warning.
 * @param run - the actual call, invoked only when a ledger is present.
 * @returns whether the write actually happened. `false` covers both "no ledger"
 *   and "the write failed" — callers need that distinction to avoid pointing a
 *   reader at evidence that does not exist (a confirmation pointer is only valid
 *   when a row was really written).
 */
export async function noteLedger(
  ledger: S2sLedger | undefined,
  operation: string,
  run: () => Promise<void>,
): Promise<boolean> {
  if (ledger === undefined) return false
  try {
    await run()
    return true
  } catch (error: unknown) {
    ledger.warn(operation, error)
    return false
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

/** One cached log read, with the instant it was taken. */
interface LogCacheEntry {
  readonly at: number
  /** `undefined` encodes "the read failed" — a negative result, cached too. */
  readonly entries: readonly HistoryEntry[] | undefined
}

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
  /**
   * Whether this pass reused a cached log read instead of reading again.
   *
   * Distinct from the tool's `cache=honoured|bypassed`, which only reports what
   * the *caller asked for* (`use_cache: false`). That field was once mistaken
   * for evidence of a hit — it is not: a caller can ask for the cache and still
   * miss, and a cache entry can exist while being too old to use. This one is
   * computed from the actual freshness test, so it is the hit/miss fact.
   */
  readonly cacheHit: boolean
  /**
   * How many times this pass actually read the target's log.
   *
   * `0` when a fresh cache entry was reused, `1` otherwise. Reported as a count
   * rather than a boolean because it is the measurable thing: it makes "the
   * second call inside the TTL did not re-read" checkable directly, instead of
   * inferred from timing.
   */
  readonly logReads: number
}

/** What one `expireZombies()` sweep examined and killed (T24). */
export interface ZombieSweepResult {
  /** Rows eligible to be zombies (handed over, not terminal). */
  readonly examined: number
  /** Rows dead-lettered by this sweep. */
  readonly expired: number
}

/** Ledger configuration. */
export interface LedgerConfig {
  /**
   * Auto-sweep interval (ms). Defaults to `LEDGER_LIMITS.sweepIntervalMs`;
   * `0` disables the timer, which is what tests do so they can call `tick()`
   * with a pinned clock instead of waiting on wall time.
   */
  readonly timerIntervalMs?: number
}

export class S2sLedger extends Service {
  /**
   * The store behind the domain, once a caller has successfully opened it.
   *
   * Callers are responsible for *when* they call `open()`: the host provides
   * `storageDomain` asynchronously (its domain plugin does so inside an
   * `inject` callback), so opening at mount time races the chain. `src/index.ts`
   * therefore waits on `ctx.inject(['storageDomain'], …)` rather than calling
   * `open()` eagerly — see the note there.
   *
   * An earlier revision of this comment claimed `inject` "would make the whole
   * plugin fail to mount" without the service. **That is false** and was
   * measured: injecting a service that never appears leaves the plugin mounted
   * and its fiber ACTIVE, withholding only the callback. The false claim is what
   * justified the eager `ctx.get` lookup, and that lookup is what hit the race.
   */
  private domain: Domain<typeof ledgerDomain> | undefined
  /**
   * In-flight `open()`, shared by concurrent callers.
   *
   * `open()` awaits the facility, so the `domain` guard alone lets two callers
   * through and the store answers `domain 's2s' is already open`. Holding the
   * promise here makes a second caller join the first instead of racing it.
   */
  private opening: Promise<void> | undefined
  /**
   * Per-session cache of the last log read, bounded by
   * `LEDGER_LIMITS.reconcileTtlMs`.
   *
   * Reconciling means decoding a target's whole log, and a status read can be
   * asked repeatedly in a short window; without this, one slow session costs a
   * full decode per question. The **negative** result is cached too: a target
   * whose log cannot be read must not be re-read (and re-warned) on every pass.
   */
  private readonly logCache = new Map<string, LogCacheEntry>()

  /**
   * Auto-sweep timer handle, and the interval it was armed with.
   *
   * **The trigger decision (T24).** `reconcile()` advances rows, but a row only
   * moves when *someone asks*. Before this, the deadline in
   * `LEDGER_LIMITS.landedDeadlineMs` was inert: it was only ever consulted by a
   * `reconcile()` that nothing ran automatically, so a zombie row could sit at
   * `inboxed` indefinitely and the deadline would never be reached. A deadline
   * without a clock is documentation, not behaviour.
   *
   * So the sweep is driven by its own interval, mirroring `S2sScheduleService`:
   * armed in the constructor, `unref()`'d so it never holds the process open,
   * disposed through `ctx.effect`, and skippable for tests via
   * `timerIntervalMs: 0` in favour of calling `tick()` with a pinned clock.
   */
  private timer?: ReturnType<typeof setInterval>

  /**
   * What the most recent sweep did, for `s2s_status` to report.
   *
   * T24 armed a timer whose effect was **unobservable**: under a profile without
   * `storageDomain` the ledger never opens, so `tick()` returns early every hour
   * and nothing anywhere recorded that it ran. That made "the sweep is alive"
   * provable only by a unit test — the thing could silently stop working on the
   * real host and nobody could tell.
   *
   * `skipped` separates two situations a lone timestamp would merge: "the sweep
   * ran and had work to do" vs "the sweep ran but the ledger has no store, so it
   * could do nothing". Without that distinction an inert sweep looks healthy.
   */
  private lastSweep: { at: number; reconciled: number; expired: number; skipped: boolean } | undefined

  constructor(ctx: Context, config: LedgerConfig = {}) {
    super(ctx, 's2sLedger')
    this.timerIntervalMs = config.timerIntervalMs ?? LEDGER_LIMITS.sweepIntervalMs
    if (this.timerIntervalMs > 0) {
      this.timer = setInterval(() => {
        void this.tick().catch((error: unknown) => {
          this.ctx.logger.warn('s2s ledger: sweep failed: ' + String(error))
        })
      }, this.timerIntervalMs)
      this.timer.unref?.()
    }
    this.ctx.effect(() => () => { if (this.timer !== undefined) clearInterval(this.timer) }, 's2sLedger.timer')
  }

  private readonly timerIntervalMs: number

  /**
   * The automatic sweep's interval and last outcome, for self-report (T9/T24).
   *
   * Exposed as a read-only view so `s2s_status` can state whether a sweep is
   * even *armed* and what the last one achieved — the difference between "this
   * feature exists in the bundle" and "this feature is running here".
   *
   * `nextSweepAt` and `landedDeadlineMs` were added because the two constants
   * make the sweep unobservable inside a verification window: the interval is 1h
   * and the deadline 24h, so "the timer is armed but has not fired yet" and "the
   * timer is not armed at all" both show up as a missing `last`. Publishing when
   * the next pass is *due* — and how long a row may stay unreadable before it is
   * a zombie — lets a reader see that the schedule is real instead of inferring
   * it from silence. Purely additive: no behaviour depends on these fields.
   */
  get sweepStatus(): {
    armed: boolean
    intervalMs: number
    last?: { at: number; reconciled: number; expired: number; skipped: boolean }
    /** Epoch ms of the next due pass; absent when the sweep is disarmed. */
    nextSweepAt?: number
    /** How long a row may stay unreadable before it is declared a zombie. */
    landedDeadlineMs: number
  } {
    const last = this.lastSweep
    // Due time is derived from the last pass when there was one, otherwise from
    // now: the timer's first tick is one full interval after construction.
    const base = last === undefined ? Date.now() : last.at
    return {
      armed: this.timer !== undefined,
      intervalMs: this.timerIntervalMs,
      ...(last === undefined ? {} : { last }),
      ...(this.timer === undefined ? {} : { nextSweepAt: base + this.timerIntervalMs }),
      landedDeadlineMs: LEDGER_LIMITS.landedDeadlineMs,
    }
  }

  /**
   * One automatic sweep: advance tracked rows against their logs, then give the
   * ones whose log never recovered an exit.
   *
   * Order matters. Reconcile first, so a row whose log has become readable is
   * landed (and its `unreadableSince` cleared) rather than counted as a zombie
   * by the sweep that follows in the same pass. Doing it the other way would
   * kill a delivery that had just become verifiable.
   *
   * Never throws: a ledger that cannot serve the sweep must degrade quietly (G9
   * warns) rather than break the host's timer.
   *
   * @param opts.now - injectable clock; tests pin it to cross deadlines.
   * @returns how many targets were reconciled and how many rows were expired.
   */
  async tick(opts: { now?: number } = {}): Promise<{ reconciled: number; expired: number; examined: number }> {
    const now = opts.now ?? Date.now()
    if (this.domain === undefined) {
      // Recorded even though nothing can be done: otherwise an open-less
      // deployment looks identical to one where the timer never fired, and the
      // difference is exactly what an operator needs to see (T9/T24).
      this.lastSweep = { at: now, reconciled: 0, expired: 0, skipped: true }
      return { reconciled: 0, expired: 0, examined: 0 }
    }
    // Which targets actually have a row worth advancing? Reconciling every known
    // session would decode logs for sessions this ledger has no stake in, and
    // `maxSessionsPerRequest` bounds a single request for the same reason.
    const targets = new Set<string>()
    for (const [, row] of this.domain.table(MESSAGES_TABLE).entries()) {
      if ((TERMINAL_STATUSES as readonly string[]).includes(row.status)) continue
      if (row.status === 'landed' || row.status === 'consumed') continue
      if (row.resolvedSessionId === null || row.resolvedSessionId === undefined) continue
      targets.add(row.resolvedSessionId)
    }
    let reconciled = 0
    for (const sessionId of [...targets].slice(0, LEDGER_LIMITS.maxSessionsPerRequest)) {
      try {
        // `useCache: false` on purpose. The cache exists to collapse repeated
        // *questions* inside a short window; a scheduled sweep is the opposite —
        // it is the periodic re-examination of reality, and reusing a read taken
        // up to `reconcileTtlMs` ago would let a log that has just gone away
        // still look readable, delaying (or wrongly skipping) the zombie verdict
        // that this sweep exists to reach.
        await this.reconcile(sessionId, { now, useCache: false })
        reconciled += 1
      } catch (error) {
        this.warn('reconcile', error)
      }
    }
    const sweep = await this.expireZombies({ now })
    if (sweep.expired > 0) {
      // A death is worth a line: it is the only way a passive observer learns
      // that a delivery was abandoned rather than still in flight.
      this.ctx.logger.warn('s2s ledger: dead-lettered ' + sweep.expired + ' zombie row(s) whose target log stayed unreadable past the deadline')
    }
    this.lastSweep = { at: now, reconciled, expired: sweep.expired, skipped: false }
    return { reconciled, expired: sweep.expired, examined: sweep.examined }
  }

  /**
   * Serializes **every** read-modify-write pass over the messages table (T23).
   *
   * Every mutation here is read-decide-write: `markInboxed`, `reconcile` and
   * `expireZombies` all read a row, compute the next state, then `put` a row
   * derived from that read. Two such passes that interleave can both decide from
   * the *same* stale snapshot, and then the later `put` silently **erases** the
   * earlier one's decision — measured directly: a `reconcile` landing a row to
   * `landed`/`landedSeq=42` was undone by an `expireZombies` that had read the
   * row before that landing, leaving it `dead_letter` with a null seq. A lost
   * update is worse than a slow one: the row ends up in a state no code path
   * would ever have chosen.
   *
   * This is reachable now that the ledger sweeps on a timer while a tool can
   * call `s2s_reconcile` at the same instant, so the two do not merely race in
   * theory.
   *
   * One promise chain, not a lock library: each pass appends itself and awaits
   * its predecessor, so passes run strictly one at a time in arrival order.
   * `Tail` is deliberately *not* reset on failure — a rejected link must not
   * swallow the passes queued behind it (each caller sees its own error).
   */
  private tail: Promise<unknown> = Promise.resolve()

  /**
   * Run one read-modify-write pass with exclusive access to the messages table.
   *
   * @param fn - the pass; its result is returned to the caller.
   * @returns whatever `fn` returns, after all earlier passes have settled.
   */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn)
    // Keep the chain alive without letting one failure reject the next link.
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * Write a row **only if** it has not changed since it was read (T23 CAS).
   *
   * Serialization alone would leave one hole: a caller that reads a row, awaits
   * something slow (a log decode is the real case — `reconcile` awaits
   * `readSessionLog` between reading and writing), and then writes, still
   * reverts whatever happened in the meantime. Because the awaited work happens
   * *inside* the serialized pass this cannot occur through the chain, but the
   * check is what makes the guarantee local to the write rather than a property
   * of every caller remembering to queue.
   *
   * @param expectedRevision - the `revision` observed when the row was read.
   * @param next - the row to store.
   * @returns true when the write happened, false when it was refused as stale.
   */
  private async putIfUnchanged(expectedRevision: number, next: MessageRecord): Promise<boolean> {
    const table = this.opened().table(MESSAGES_TABLE)
    const current = table.get(next.msgId)
    if (current !== undefined && (current.revision ?? 0) !== expectedRevision) {
      // Refused, not failed: the other writer's decision already moved the row,
      // and silently overwriting it is exactly the lost update this prevents.
      return false
    }
    await table.put(next.msgId, { ...next, revision: expectedRevision + 1 })
    return true
  }

  /**
   * Drop cached log reads so the next `reconcile()` sees the real thing.
   *
   * This matters because the cache holds a *read*: right after delivering to a
   * session, a cached read taken moments earlier does not contain the new
   * message, and reconciling against it would report "not landed" for a
   * delivery that is in fact there. Callers invalidate on delivery rather than
   * waiting the TTL out.
   *
   * @param sessionId - one session, or every session when omitted.
   */
  invalidateLogCache(sessionId?: string): void {
    if (sessionId === undefined) this.logCache.clear()
    else this.logCache.delete(sessionId)
  }

  /** The backing store in use, or `undefined` before a successful `open()`. */
  get backend(): S2sLedgerBackend | undefined {
    return this.domain === undefined ? undefined : 'storage-domain'
  }

  /**
   * How the log-read cache looks right now, for self-report (T8-2).
   *
   * Read-only view of state `reconcile()` already maintains — it answers none of
   * the questions `s2s_reconcile` answers per call (that tool reports the
   * hit/miss and read count of *its own* pass). This exists so `s2s_status` can
   * show whether any entry is live at all without running a pass and thereby
   * changing the very thing being observed.
   *
   * `entries` is deliberately not exposed: only whether an entry is *usable now*
   * matters here, and the payload belongs to `s2s_history`.
   *
   * @param now - injected clock, so the freshness test matches `reconcile`'s.
   */
  logCacheStatus(now: number = Date.now()): {
    sessions: number
    fresh: number
    /** Age of the oldest entry in ms, or `undefined` when empty. */
    oldestAgeMs?: number
    successTtlMs: number
    failureTtlMs: number
  } {
    let fresh = 0
    let oldest: number | undefined
    for (const [, entry] of this.logCache) {
      if (oldest === undefined || entry.at < oldest) oldest = entry.at
      // Mirrors reconcile()'s decision exactly: a failed read (no `entries`) is
      // usable only inside the shorter failure TTL.
      const ttl = entry.entries === undefined
        ? Math.min(LEDGER_LIMITS.reconcileTtlMs, LEDGER_LIMITS.reconcileFailureTtlMs)
        : LEDGER_LIMITS.reconcileTtlMs
      if (now - entry.at < ttl) fresh += 1
    }
    return {
      sessions: this.logCache.size,
      fresh,
      ...(oldest === undefined ? {} : { oldestAgeMs: now - oldest }),
      successTtlMs: LEDGER_LIMITS.reconcileTtlMs,
      failureTtlMs: LEDGER_LIMITS.reconcileFailureTtlMs,
    }
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
  /**
   * Open the durable ledger.
   *
   * Idempotent: a second call returns without reopening (the facility rejects a
   * duplicate open of one domain name by design, so re-opening would throw).
   *
   * **Callers must not call this at mount time.** The host provides
   * `storageDomain` asynchronously, so an eager call loses the race and — since
   * this method only asks once — leaves the ledger shut for the whole process.
   * `src/index.ts` waits on the service with `ctx.inject` for exactly this
   * reason.
   *
   * @throws S2sError when no `storageDomain` is available *at this instant*.
   *   Returning quietly would leave every later status read fabricated.
   */
  async open(): Promise<void> {
    if (this.domain !== undefined) return
    // ★ Concurrent callers must share ONE open. The guard above is not enough:
    // `facility.open()` is awaited below, so a second caller arriving during that
    // await also passes the guard and opens the same domain again — the store
    // rejects it with `domain 's2s' is already open`. This became reachable once
    // the mount path began waiting for its own service, because the wait can now
    // overlap an explicit `open()` from elsewhere (T6b tests do exactly that).
    if (this.opening === undefined) {
      // Note: deliberately no `#private` method and no detached helper — a cordis
      // `Service` instance can be a callable proxy, which rejects `#` brand
      // checks with "Receiver must be an instance of class". A local closure keeps
      // `this` bound to whatever object `open()` was invoked on.
      const self = this
      this.opening = (async function(): Promise<void> {
        // Kept spelled `this.ctx.get('storageDomain')` on purpose: `ledger-backup`
        // asserts that exact text to prove the ledger never chooses its own path
        // (it asks the host for the store instead of self-hosting a file).
        const facility = (function(this: S2sLedger) {
          return this.ctx.get('storageDomain')
        }).call(self) as
          | { open(spec: typeof ledgerDomain): Promise<Domain<typeof ledgerDomain>> }
          | undefined
        if (facility === undefined) {
          throw new S2sError(
            's2s ledger: `storageDomain` is not available yet, so the ledger has no durable store. '
            + 'Note the host provides it asynchronously — wait for it (ctx.inject([\'storageDomain\'], …)) '
            + 'instead of calling open() at mount time, or history reads will have nothing durable to answer from.',
            'S2S_LEDGER',
          )
        }
        self.domain = await facility.open(ledgerDomain)
      })()
      // Cleared either way: a failed open must not wedge every later attempt.
      void this.opening.catch(function() {}).finally(function() { self.opening = undefined })
    }
    return this.opening
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
      revision: 0,
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
    // Serialized: this is a read-decide-write, and a `reconcile`/sweep pass
    // running at the same instant would otherwise be able to write back a row
    // derived from the pre-inboxed snapshot, discarding this transition.
    await this.serialize(async () => {
      const row = table.get(msgId)
      if (row === undefined) {
        // Reachable if a caller delivers without recording first. Not fatal to the
        // delivery, but it must not pass unremarked — a ledger silently missing
        // rows is worse than one that says it is missing them (G9).
        //
        // The warning alone was not enough, and that was measured: `s2s_resume`
        // delivered without ever calling `record()`, this branch swallowed the
        // transition, and the plugin logger is never persisted — so the ledger
        // showed zero rows while the target's log held the message, with nothing
        // anywhere saying why. `recordUntrackedDelivery` is the read-back that
        // makes this branch externally visible (`s2s_status`). It is a diagnostic,
        // not a fallback: writing the row here would invent a `record` that never
        // happened and hide the caller's bug.
        this.ctx.logger.warn(
          `s2s ledger: markInboxed("${msgId}") found no recorded row; the delivery is not tracked. `
          + 'Record the message before delivering it.',
        )
        recordUntrackedDelivery(msgId, resolvedSessionId)
        return
      }
      if (row.status === 'inboxed' || row.status === 'landed' || row.status === 'consumed') return
      if ((TERMINAL_STATUSES as readonly string[]).includes(row.status)) return
      await this.putIfUnchanged(row.revision ?? 0, {
        ...row,
        status: 'inboxed',
        resolvedSessionId,
        updatedAt: Date.now(),
      })
    })
    // The target's log has just gained (or is about to gain) this delivery, so
    // any cached read of it is stale by construction.
    this.invalidateLogCache(resolvedSessionId)
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
   * @param opts.useCache - honour the per-session read cache (default true);
   *   pass `false` to force a fresh read.
   * @returns what changed, and what could not be read.
   */
  async reconcile(sessionId: string, opts: { now?: number; useCache?: boolean } = {}): Promise<ReconcileResult> {
    const domain = this.opened()
    const now = opts.now ?? Date.now()
    const useCache = opts.useCache !== false
    const cached = useCache ? this.logCache.get(sessionId) : undefined
    // A cached entry is only usable while it is fresh. Note this caches the
    // **read**, not the decision, and a *failed* read is cached for far less
    // time: a log that was momentarily unreadable usually becomes readable
    // again quickly, and caching the failure for the full TTL would make the
    // gap self-perpetuating (the row would keep its stale `inboxed` status
    // purely because nobody looked again).
    const ttl = cached?.entries === undefined
      ? Math.min(LEDGER_LIMITS.reconcileTtlMs, LEDGER_LIMITS.reconcileFailureTtlMs)
      : LEDGER_LIMITS.reconcileTtlMs
    const fresh = cached !== undefined && now - cached.at < ttl
    // The whole pass — including the log read — runs under the serialization
    // chain. Reading outside it would let an `expireZombies` pass decide the row
    // is a zombie while this one is still decoding the log, and whichever writes
    // last would win on a stale view (the measured lost update).
    return this.serialize(async () => {
      const entries = fresh ? cached.entries : await readSessionLog(this.ctx, sessionId, LEDGER_LIMITS.reconcileTtlMs)
      if (!fresh) this.logCache.set(sessionId, { at: now, entries })
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

      // Re-read every row inside the pass: a cached iteration taken before the
      // await above would be the stale snapshot this method must not decide from.
      for (const [, row] of [...table.entries()]) {
        if (row.resolvedSessionId !== sessionId) continue
        if (row.status === 'landed' || row.status === 'consumed') continue
        if ((TERMINAL_STATUSES as readonly string[]).includes(row.status)) continue
        examined += 1
        const revision = row.revision ?? 0
        if (unreadable) {
          // Recorded so a caller can enforce the deadline; never silently ignored.
          if (row.unreadableSince === null || row.unreadableSince === undefined) {
            await this.putIfUnchanged(revision, { ...row, unreadableSince: now, updatedAt: now })
          }
          continue
        }
        const seq = seqByMsgId.get(row.msgId)
        if (seq === undefined) {
          // Readable log, no matching record: the delivery has not landed *yet*.
          // Clear any stale unreadable marker — the log is readable now.
          if (row.unreadableSince !== null && row.unreadableSince !== undefined) {
            await this.putIfUnchanged(revision, { ...row, unreadableSince: null, updatedAt: now })
          }
          continue
        }
        const wrote = await this.putIfUnchanged(revision, {
          ...row,
          status: 'landed',
          landedSeq: seq,
          unreadableSince: null,
          updatedAt: now,
        })
        // Only count a landing that actually stuck: a refused CAS means another
        // pass moved the row first, so reporting it here would overstate what
        // this pass did (I1).
        if (wrote) landed += 1
      }
      return {
        sessionId,
        examined,
        landed,
        unreadable,
        ...(entries === undefined ? {} : { seenInLog: entries.length }),
        // Read-only observability (T8-2). `fresh` is the actual decision this pass
        // made; `logReads` counts the read that only happened when it was not.
        // Both are derived from the pass itself, so neither can drift from what
        // the code did — which is the whole point of reporting them.
        cacheHit: fresh,
        logReads: fresh ? 0 : 1,
      }
    })
  }

  /**
   * Give rows whose log never became readable an exit (T24).
   *
   * A row stuck at `inboxed` because its target log is gone is a **zombie**: it
   * will never land, and without a deadline it would sit there forever looking
   * like a delivery still in flight. Once `unreadableSince` is older than
   * `LEDGER_LIMITS.landedDeadlineMs`, `landed` is judged **unreachable** and the
   * row becomes `dead_letter` — a terminal state that keeps the evidence
   * (`lastError` records why) instead of hiding it.
   *
   * Three deliberate exclusions, each a way this could do harm:
   *
   * - **Only rows that were actually handed over.** A `queued` row was never
   *   delivered, so an unreadable log says nothing about it; dead-lettering it
   *   would destroy a message that is merely waiting.
   * - **Only rows with an unreadable log.** `unreadableSince` is stamped solely
   *   by a failed `reconcile()` read and cleared by a successful one, so a
   *   readable log with no matching record is "not landed *yet*" — never a
   *   zombie. This is the negative case the plan insists on: a normally
   *   undelivered message must not be killed.
   * - **Never a terminal row.** `dead_letter`/`cancelled`/`legacy_unverifiable`
   *   are final, and re-dead-lettering would rewrite their timestamps.
   *
   * Idempotent by construction: the first pass writes the terminal status, and
   * every later pass skips it, so a row transitions **at most once**.
   *
   * @param opts.now - injectable clock, so tests can cross the deadline without waiting.
   * @returns what was examined and what was dead-lettered.
   */
  async expireZombies(opts: { now?: number } = {}): Promise<ZombieSweepResult> {
    const domain = this.opened()
    const now = opts.now ?? Date.now()
    return this.serialize(async () => {
      let examined = 0
      let expired = 0
      const table = domain.table(MESSAGES_TABLE)
      // Read inside the pass and honour the CAS: if a `reconcile` landed this row
      // since, the write is refused and the landing survives. That is the whole
      // point — a sweep must never undo a successful delivery.
      for (const [, row] of [...table.entries()]) {
        if ((TERMINAL_STATUSES as readonly string[]).includes(row.status)) continue
        // Only a handed-over row can be a zombie; see the exclusions above.
        if (row.status !== 'inboxed' && row.status !== 'delivering') continue
        examined += 1
        const since = row.unreadableSince
        // No unreadable stamp ⇒ the last read succeeded (or never happened), so
        // there is no evidence the landing is unreachable. Leave it alone.
        if (since === null || since === undefined) continue
        if (now - since < LEDGER_LIMITS.landedDeadlineMs) continue
        const died = await this.putIfUnchanged(row.revision ?? 0, {
          ...row,
          status: 'dead_letter',
          // Auditable reason, not merely a boolean: a reader must be able to see
          // that this died of an unreadable log and when it started.
          lastError: 'landed unreachable: the target log stayed unreadable for '
            + Math.round((now - since) / 1000) + 's (deadline '
            + Math.round(LEDGER_LIMITS.landedDeadlineMs / 1000) + 's), first unreadable at '
            + new Date(since).toISOString(),
          unreadableSince: null,
          updatedAt: now,
        })
        if (died) expired += 1
      }
      return { examined, expired }
    })
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
