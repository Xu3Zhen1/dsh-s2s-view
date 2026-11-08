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
import { ledgerDiagnostics, recordUntrackedDelivery } from './ledger-diagnostics.ts'
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

/**
 * What a delivery gate decided, **with the reason**. A boolean is not enough here.
 *
 * The boolean version is what made a real mistake possible: "the CAS returned false"
 * was read as "carry on and deliver", which would hand over a message that the
 * ledger had already recorded as `cancelled` — sending something explicitly
 * cancelled is a behavioural error, not a duplicate. The other false causes are
 * milder but still wrong to deliver: `inboxed`/`landed` means it already arrived,
 * and `delivering` means another attempt is in flight.
 *
 * So the gate reports why, and each reason has its own rule (see `claimDelivery`).
 * `untracked` is the one case where delivery proceeds despite a refusal to record:
 * bookkeeping must never outrank delivery (T6b).
 */
export type DeliveryClaim =
  | { readonly decision: 'deliver'; readonly reason: 'claimed' | 'untracked' }
  | {
      readonly decision: 'refuse'
      /**
       * `backoff` — a retry is scheduled but not yet due (T18).
       *
       * It sits with the refusals rather than with the deliveries because the row
       * must not be handed over yet; it differs from every other refusal in being
       * **temporary** — the reason will stop applying on its own when
       * `nextAttemptAt` passes, with no state change in between. Callers must
       * therefore keep the message queued instead of dropping it: treating a
       * temporary refusal as permanent is what turns a backoff into a
       * permanently stalled message.
       */
      readonly reason: 'in-flight' | 'delivered' | 'terminal' | 'not-queued' | 'cas-lost' | 'backoff'
    }

/**
 * How long to wait before the next attempt on a row (T18).
 *
 * `retryBackoffBaseMs * 2^(attempts-1)`, capped at `retryBackoffMaxMs`, plus a
 * jitter of at most a quarter of that step.
 *
 * Three properties this has to hold, each of which a plausible simpler version
 * breaks:
 *
 * - **Non-decreasing in `attempts`.** The plan's T18 wording asks for backoff to
 *   be monotone. A *decreasing* delay would retry a hopeless target faster the
 *   more often it failed, which is the opposite of backing off. The jitter is
 *   therefore not `±`: a symmetric jitter can make attempt 3 wait less than
 *   attempt 2. Making the jitter **additive and proportional to the step**
 *   (`[0, step/4]`) keeps attempt *n+1* at least `2*step` against attempt *n*'s
 *   `step + step/4`, so monotonicity survives the jitter instead of fighting it.
 * - **Bounded.** Uncapped doubling reaches 12 days by attempt 20, i.e. past the
 *   24 h zombie deadline — the row would be judged dead before its own retry was
 *   due. Capping at `retryBackoffMaxMs` keeps retries inside the rescue window.
 * - **Deterministic per row, varied across rows.** The jitter is derived from
 *   `msgId`, so the same row always computes the same instant (a replayed call
 *   cannot invent a different schedule), while two rows that failed in the same
 *   millisecond still spread out instead of retrying in lockstep. Randomised
 *   jitter would give the second property and lose the first.
 *
 * `attempts` is the count AFTER the attempt that just failed (the caller
 * increments before handing over), so attempt 1 waits `retryBackoffBaseMs`.
 */
export function retryBackoffMs(msgId: string, attempts: number): number {
  const MAX_SHIFT = 30
  const n = Math.min(Math.max(Math.trunc(attempts) || 1, 1), MAX_SHIFT)
  const step = Math.min(LEDGER_LIMITS.retryBackoffBaseMs * 2 ** (n - 1), LEDGER_LIMITS.retryBackoffMaxMs)
  // FNV-1a over the id, reduced to [0, 1). Only the row's identity feeds it, so the
  // value is stable for one row across attempts and across process restarts.
  let hash = 0x811c9dc5
  for (let i = 0; i < msgId.length; i++) {
    hash ^= msgId.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  const jitter = Math.floor((hash / 0x100000000) * (step / 4))
  return step + jitter
}

/**
 * Is this row's retry clock due? The single judgment of "due", in one place (T18).
 *
 * Deliberately a pure function over a row: two callers need this answer — the
 * delivery gate ({@link claimDelivery}) and the mailbox filter that decides which
 * queued entries may be *taken* (T19) — and if each computed it, the two would
 * drift until a message was judged due by one and not-due by the other, which
 * presents as "it retried and then immediately refused" with no single culprit.
 *
 * Missing stamp (`null`/`undefined`) means due: a row that was never scheduled
 * (or came from an older schema) must not be blocked forever by an absent field.
 */
export function dueByClock(row: { nextAttemptAt?: number | null }, now: number): boolean {
  const at = row.nextAttemptAt
  if (at === null || at === undefined) return true
  return at <= now
}

/**
 * What a failed-attempt report actually did — three outcomes, not two.
 *
 * `not-applicable` covers both "no such row" and "the row is not in `delivering`"
 * (a terminal row, or one a racing attempt already advanced). Those are the same
 * answer to the caller — this report changed nothing — so they share a name on
 * purpose rather than pretending to distinguish what the caller cannot act on.
 */
export type AttemptFailureOutcome =
  | { readonly outcome: 'rolled-back' }
  | { readonly outcome: 'dead-lettered' }
  | { readonly outcome: 'not-applicable' }

/**
 * Same guard as {@link noteLedger}, but for a call whose RETURN VALUE the caller
 * needs (the delivery gate's decision).
 *
 * `undefined` means "no ledger mounted, or the call failed" — deliberately not
 * distinguished, for the same reason as `noteLedger`: the caller must decide what
 * to do *without* that bookkeeping, and must never read missing bookkeeping as a
 * prohibition. A gate that refused because the ledger was absent would let
 * bookkeeping outrank delivery, which T6b forbids.
 */
export async function readLedger<T>(
  ledger: S2sLedger | undefined,
  operation: string,
  run: () => Promise<T>,
): Promise<T | undefined> {
  if (ledger === undefined) return undefined
  try {
    return await run()
  } catch (error: unknown) {
    // The warning must not be able to break the caller. Measured: the first version
    // called `ledger.warn()` unconditionally, and the test doubles here carry only
    // the methods their scenario exercises — so a double without `claimDelivery`
    // threw, and then the diagnostic itself threw `ledger.warn is not a function`,
    // turning a degraded gate into a failed send. A diagnostic that can throw is not
    // a diagnostic (G9), and "the ledger cannot answer the gate" must degrade to
    // "no gate", i.e. deliver — bookkeeping never outranks delivery (T6b).
    const warn = (ledger as { warn?: (operation: string, error: unknown) => void }).warn
    if (typeof warn === 'function') {
      try { warn.call(ledger, operation, error) } catch { /* never mask the original */ }
    }
    return undefined
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

/**
 * What one `pruneRetention()` pass examined and destroyed (T22).
 *
 * `pruned` alone is a count, and on a ledger that is the only copy of its records
 * a count is not an audit trail: it says how many rows vanished without saying
 * which part of history they covered. So the age span of the removed batch is
 * part of the result. It is absent for an empty candidate set, which is a
 * different fact from "the span was zero".
 */
export interface RetentionPruneResult {
  /** Rows eligible for pruning (`dead_letter` excluded — see the method). */
  readonly examined: number
  /** Rows that satisfied the age window or the row budget. */
  readonly candidates: number
  /** Rows actually deleted; `0` under `dryRun`, and always `<= candidates`. */
  readonly pruned: number
  /** True when nothing was deleted by design. */
  readonly dryRun: boolean
  /** `createdAt` of the oldest removed candidate; absent when none. */
  readonly oldestCreatedAt?: number
  /** `createdAt` of the newest removed candidate; absent when none. */
  readonly newestCreatedAt?: number
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
  private lastSweep: { at: number; reconciled: number; expired: number; pruned: number; skipped: boolean } | undefined

  constructor(ctx: Context, config: LedgerConfig = {}) {
    super(ctx, 's2sLedger')
    this.timerIntervalMs = config.timerIntervalMs ?? LEDGER_LIMITS.sweepIntervalMs
    if (this.timerIntervalMs > 0) {
      this.armedAt = Date.now()
      this.timer = setInterval(() => {
        void this.tick().catch((error: unknown) => {
          this.ctx.logger.warn('s2s ledger: sweep failed: ' + String(error))
        })
      }, this.timerIntervalMs)
      this.timer.unref?.()
    }
    this.ctx.effect(() => () => { if (this.timer !== undefined) clearInterval(this.timer) }, 's2sLedger.timer')
    // ★ Count live instances from the runtime, not from config.
    //
    // The incompleteness check is `acquired - released == live instances`, so the
    // right-hand side has to be observable, and it has to be a *runtime* fact. The
    // config file reporting one mount is not enough: a reload or a re-composition
    // creates a second live instance while the config still lists one, and that is
    // exactly the moment a release is most likely to be skipped. Substituting a
    // config value there would make the check fail precisely when it matters.
    //
    // Declared here (construction) and decremented in the same effect that releases
    // the domain, so increment and decrement are symmetric on the teardown path.
    ledgerDiagnostics.mountedInstances = (ledgerDiagnostics.mountedInstances ?? 0) + 1
    this.ctx.effect(() => () => {
      ledgerDiagnostics.mountedInstances = Math.max(0, (ledgerDiagnostics.mountedInstances ?? 0) - 1)
    }, 's2sLedger.instanceCount')
    // ★ Release the storage domain when this plugin instance goes away.
    //
    // Without this the domain handle outlives the plugin: the store keeps the
    // name `s2s` registered for the process, so a later mount of this same
    // plugin — a reload, or a re-composition — gets
    // `domain 's2s' is already open` and the ledger stays shut for the whole
    // process. Measured 2026-10-29 on this machine: `fired=1 openCalled=true
    // openOk=false openError=DomainError: domain 's2s' is already open`, while
    // `s2s.json` held 4.1 MB written at 20:47 the previous evening — i.e. an
    // earlier instance had opened it and never let go.
    //
    // `close()` is intentionally tolerant (it no-ops when never opened and when
    // the open is still in flight we wait for it first), because disposing a
    // plugin that failed to open must not throw during teardown.
    this.ctx.effect(() => () => this.releaseDomain(), 's2sLedger.domain')
  }

  /**
   * Best-effort teardown for the storage domain.
   *
   * Awaited by the effect hook above so the store actually sees the close before
   * a replacement instance tries to claim the same name.
   *
   * **A failure here is recorded, not swallowed.** Cordis would surface it
   * anyway: `_unload()` wraps every disposable in try/catch and calls
   * `logger.error(reason)` (verified in `@deepseek-ai/cordis` lib/index.js).
   * Adding a silent `.catch(() => {})` on top of that therefore *removes* an
   * observable trace rather than preventing one — a G9 violation, because a
   * failed release is precisely the condition that leaves the domain claimed and
   * makes the next mount fail. So the error is kept in a readable field
   * (`domainReleaseError`) and warned, while still not propagating: "teardown
   * must not throw" and "teardown must not be silent" are two separate
   * requirements, and this satisfies both.
   */
  private releaseDomain(): Promise<void> {
    const self = this
    // Join an in-flight open first.
    //
    // ★ PREVENTIVE, NOT PROVEN NECESSARY. Without the join we would close
    // `undefined` and the pending open would then register a domain nobody holds
    // a reference to. The reasoning is sound but has NO test behind it: the
    // mutant that drops the join (`MUT-NOJOIN`) leaves the suite fully green,
    // because every prior case disposes *after* `open()` has settled — at which
    // point `this.opening` is already undefined, so this branch never runs.
    // The concurrency case added alongside this comment exercises the branch; it
    // does not prove the join is required for correctness. Do not cite this as a
    // measured necessity.
    const pending = this.opening
    const hadDomain = this.domain !== undefined || pending !== undefined
    return (pending === undefined ? Promise.resolve() : pending.catch(function() {}))
      .then(function() { return self.close() })
      .then(function() {
        // Success needs a trace too, not just failure. Without this the absence of
        // `domainReleaseError` cannot distinguish "released successfully" from
        // "teardown never reached the release path at all" — both leave the field
        // unset. Recording the attempt makes the two separable when reading
        // `s2s_status`; the value is how many releases this process performed.
        if (hadDomain) {
          ledgerDiagnostics.domainReleasedCount = (ledgerDiagnostics.domainReleasedCount ?? 0) + 1
        }
      })
      .catch(function(error: unknown) {
        ledgerDiagnostics.domainReleaseError = String(error)
        self.ctx.logger.warn(
          's2s ledger: releasing the storage domain failed (' + String(error) + '); '
          + 'the domain may stay claimed for this process, so a later mount can fail '
          + "with `domain 's2s' is already open`.",
        )
      })
  }

  private readonly timerIntervalMs: number

  /**
   * When the sweep timer was armed. The timer's first tick is one full interval
   * after THIS instant, so it is the only honest base for a "next pass" estimate
   * before any pass has happened.
   *
   * ★ It used to be `Date.now()` — the moment the reader asked. That made the
   * reported due time drift forward every time the status was sampled, and it
   * disagreed with the timer: measured 2026-11-02, the armed-at + 1h tick fired
   * at 07:06:57 while the reading taken at 06:20:49 predicted 07:20:49, off by
   * 13.9 minutes for a 60-minute interval. A field that answers "when is it due?"
   * must not depend on when you asked.
   */
  private armedAt?: number

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
    last?: { at: number; reconciled: number; expired: number; pruned: number; skipped: boolean }
    /** Epoch ms of the next due pass; absent when the sweep is disarmed. */
    nextSweepAt?: number
    /** How long a row may stay unreadable before it is declared a zombie. */
    landedDeadlineMs: number
  } {
    const last = this.lastSweep
    // Due time is derived from the last pass when there was one, otherwise from
    // the moment the timer was armed — never from `Date.now()`. Reading the
    // status must not move the thing it reports.
    const base = last === undefined ? (this.armedAt ?? Date.now()) : last.at
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
  async tick(opts: { now?: number } = {}): Promise<{ reconciled: number; expired: number; examined: number; pruned: number }> {
    const now = opts.now ?? Date.now()
    if (this.domain === undefined) {
      // Recorded even though nothing can be done: otherwise an open-less
      // deployment looks identical to one where the timer never fired, and the
      // difference is exactly what an operator needs to see (T9/T24).
      this.lastSweep = { at: now, reconciled: 0, expired: 0, pruned: 0, skipped: true }
      return { reconciled: 0, expired: 0, examined: 0, pruned: 0 }
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
    // Retention last, deliberately: a row must get its chance to become
    // `dead_letter` above before this pass may consider removing it. Pruning
    // first would tidy away the very rows the sweep exists to judge, and — worse
    // — could delete a row that was about to be preserved as `dead_letter`.
    // `dead_letter` is excluded inside `pruneRetention` itself, so the ordering
    // is about giving the judgement a chance, not about the protection.
    let pruned = 0
    try {
      const retention = await this.pruneRetention({ now })
      pruned = retention.pruned
      if (pruned > 0) {
        // Only when something was actually destroyed. A quieter rule would log
        // "pruned 0" on every hourly pass and bury the pass where it mattered.
        this.ctx.logger.warn(
          's2s ledger: pruned ' + pruned + ' row(s) past the retention window ('
          + LEDGER_LIMITS.retentionDays + 'd / ' + LEDGER_LIMITS.retentionRows + ' rows), '
          + 'covering ' + new Date(retention.oldestCreatedAt ?? now).toISOString()
          + ' .. ' + new Date(retention.newestCreatedAt ?? now).toISOString()
          + '; dead_letter rows are never pruned.',
        )
      }
    } catch (error) {
      // Degrade, never throw: a failed prune must not break the sweep timer. The
      // error is recorded through the same channel the reconcile failures use.
      this.warn('retention', error)
    }
    this.lastSweep = { at: now, reconciled, expired: sweep.expired, pruned, skipped: false }
    return { reconciled, expired: sweep.expired, examined: sweep.examined, pruned }
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
        // Paired with `domainReleasedCount`. A release counter alone proves only
        // "a release happened", never "no release was missed" — it cannot be read
        // against any expected value, because nothing states how many unloads a
        // process should see. Counting acquisitions too makes the pair checkable:
        // in steady state `acquired - released` is the number of domains still
        // open, so a value above the number of live instances means a teardown
        // skipped the release path.
        ledgerDiagnostics.domainAcquiredCount = (ledgerDiagnostics.domainAcquiredCount ?? 0) + 1
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
   * Roll a FAILED delivery attempt back, or terminate it when the retries are spent.
   *
   * Why this exists: marking the attempt (`markDelivering`) without an undo turns
   * every undeliverable message into one that is retried only after a process
   * restart — it sits in `delivering` until `recoverInterrupted()` runs. `absent`
   * is the ordinary case of that (the resolved session had no live agent), not an
   * exotic one, so the rollback is load-bearing.
   *
   * The load-bearing-ness is measured, not asserted: `tools-ledger.spec.ts`'s
   * "does NOT mark inboxed when the broker reports absent" asserts the row is still
   * `queued` afterwards. That assertion was written before `delivering` existed and
   * stays green only when this rollback runs — so the existing I1 contract guards
   * the new transition instead of a test this batch wrote for itself.
   *
   * `attempts` is deliberately NOT decremented: the attempt really happened, and it
   * is the honest count the exhaustion branch below reads.
   *
   * ★ `nextAttemptAt` used to be written as `now`, with the comment "nothing reads a
   * future stamp yet, and writing one would be a value with no consumer. Backoff
   * belongs with the dispatcher that reads it, which does not exist." That was true
   * when it was written and is no longer: {@link claimDelivery} refuses with
   * `backoff` while `nextAttemptAt` is in the future (T18), and the lifecycle's
   * fallback pass (T19) is what wakes up to retry once it passes. The stamp now
   * schedules something, so the rollback writes a real instant and the old comment
   * had to go — left in place it would have claimed the opposite of the code
   * directly beneath it.
   *
   * `absent` COUNTS as an attempt on purpose. The plan groups "`deliver()` throws /
   * returns absent" together as one failure kind, and if a message addressed to a
   * session that has permanently gone did not count, it would re-queue forever with
   * no terminal exit. Counting it is what gives an undeliverable message a way to
   * stop — via the exhaustion branch below.
   *
   * Returns what actually happened rather than a boolean: three distinct outcomes
   * exist (rolled back to `queued`, terminated as `dead_letter`, or nothing to do)
   * and a boolean can express only two of them. This is the same lesson as
   * `claimDelivery` — a two-valued return over a three-valued decision silently
   * collapses one case into another.
   */
  async markAttemptFailed(msgId: string, reason: string): Promise<AttemptFailureOutcome> {
    const domain = this.opened()
    const table = domain.table(MESSAGES_TABLE)
    const now = Date.now()
    let outcome: AttemptFailureOutcome = { outcome: 'not-applicable' }
    await this.serialize(async () => {
      const row = table.get(msgId)
      if (row === undefined) return
      // Only an in-flight attempt can fail. A terminal row must never be revived
      // (`dead_letter` is a judgement, not a retry state), and a row that already
      // reached `inboxed`/`landed` must keep that — a late failure report from a
      // racing attempt cannot un-deliver a message that did land.
      if (row.status !== 'delivering') return
      // The retries are spent ⇒ the honest terminal state, not another requeue.
      // Without this branch a message that can never be delivered cycles forever;
      // `dead_letter` previously had exactly one inbound edge (`expireZombies`, for
      // a landed-but-unreadable log) and this is the second, independent one.
      const exhausted = (row.attempts ?? 0) >= (row.maxRetries ?? 0)
      // T18: a rolled-back row is scheduled, not made immediately eligible again.
      // Exhausted rows get `now` because they are terminal — nothing will consult
      // their stamp again, and writing a future one would imply a retry that has
      // been ruled out.
      const nextAttemptAt = exhausted ? now : now + retryBackoffMs(msgId, row.attempts ?? 0)
      const wrote = await this.putIfUnchanged(row.revision ?? 0, {
        ...row,
        status: exhausted ? 'dead_letter' : 'queued',
        lastError: exhausted
          ? reason + ' — giving up after ' + (row.attempts ?? 0) + ' attempt(s) (maxRetries '
            + (row.maxRetries ?? 0) + ')'
          : reason,
        nextAttemptAt,
        updatedAt: now,
      })
      if (wrote) outcome = { outcome: exhausted ? 'dead-lettered' : 'rolled-back' }
    })
    return outcome
  }

  /**
   * CAS `queued` → `delivering`, the persistent intermediate state of §12.3.
   *
   * Why this is written to the store and not kept in memory: the point of the state
   * is to survive a crash. If the process dies between the CAS and the target log
   * gaining the message, the row is left on disk as `delivering` and
   * {@link recoverInterrupted} puts it back in `queued`. An in-memory flag would die
   * with the process and leave nothing to recover — which is the only reason T13
   * has any work to do.
   *
   * Returns whether this call won the transition. A caller that loses must not
   * deliver: that is §12.3's duplicate-delivery guard, and it is why this is a
   * compare-and-set rather than an assignment.
   *
   * ★ Without this method the enum's `delivering` member had no inbound write
   * anywhere in `src/`, so T13's subject — a row stuck mid-delivery — could not
   * exist. A recovery pass for an unreachable state reports a green result while
   * exercising nothing (§5, and the plan's own §12.3 note that a state with no
   * inbound edge is a dead state).
   */
  async markDelivering(msgId: string): Promise<boolean> {
    const domain = this.opened()
    const table = domain.table(MESSAGES_TABLE)
    let won = false
    await this.serialize(async () => {
      const row = table.get(msgId)
      // A missing row means the caller delivered without recording. Not ours to
      // invent — same reasoning as `markInboxed`: a fabricated row would hide the
      // caller's bug instead of surfacing it.
      if (row === undefined) return
      // Only a `queued` row may start an attempt. A row already handed over, or a
      // terminal one, must not be dragged backwards by a late caller.
      if (row.status !== 'queued') return
      won = await this.putIfUnchanged(row.revision ?? 0, {
        ...row,
        status: 'delivering',
        attempts: (row.attempts ?? 0) + 1,
        updatedAt: Date.now(),
      })
    })
    return won
  }

  /**
   * The **delivery gate**: decide whether this attempt may hand the message over,
   * and claim it if so. `markDelivering` alone was not enough — its boolean cannot
   * say *why* a refusal happened, and "refused ⇒ carry on" is the wrong default for
   * three of the four refusal causes.
   *
   * Reason → rule (each is separately tested, see `ledger-recovery.spec.ts`):
   * ```
   * untracked   → DELIVER   the row was never recorded; bookkeeping must not
   *                          outrank delivery (T6b), and the caller records the
   *                          missing row as a diagnostic instead of inventing one
   * claimed     → DELIVER   the CAS won; the row is now `delivering`
   * in-flight   → REFUSE    another attempt holds the row; delivering here would
   *                          be the duplicate §12.3 exists to prevent
   * delivered   → REFUSE    inboxed/landed/consumed: it already arrived, and a
   *                          second hand-over would create a second message
   * terminal    → REFUSE    dead_letter/cancelled/legacy_unverifiable: handing over
   *                          a message the ledger already judged is a behavioural
   *                          error, not a duplicate — the worst of the false cases
   * not-queued  → REFUSE    an unexpected status; refuse rather than guess
   * cas-lost    → REFUSE    the CAS lost to a concurrent writer; we do not own the row
   * ```
   *
   * The pre-read decides the reason, but the DECISION is taken from the CAS: if the
   * status changes between the read and the CAS, the CAS loses and the answer is
   * still `refuse` (`cas-lost`). So a stale read can mislabel a refusal, and cannot
   * turn a deliberate refusal into a delivery.
   *
   * The one exception is the `untracked` branch, and it is deliberate: a row created
   * between this read and the hand-over is NOT re-checked, because T6b puts delivery
   * above bookkeeping. So there — and only there — a stale read can let a message
   * through, including one that was recorded and cancelled inside that window.
   * Closing it would need a second read immediately before the hand-over, which still
   * leaves a window, costs a round trip on every send, and would re-open the T6b
   * violation the first read exists to avoid. The exposure is bounded to msgIds this
   * caller generated, which no other path records-and-cancels behind our back.
   *
   * Recorded this way on purpose: a comment that says "never" tells the next reader
   * not to check the branch at all. An absolute qualifier has to be enumerable
   * branch-by-branch, or it is an unverified universal claim wearing a fact's clothes.
   */
  async claimDelivery(msgId: string, opts: { now?: number } = {}): Promise<DeliveryClaim> {
    const domain = this.opened()
    const table = domain.table(MESSAGES_TABLE)
    const row = table.get(msgId)
    if (row === undefined) return { decision: 'deliver', reason: 'untracked' }
    if ((TERMINAL_STATUSES as readonly string[]).includes(row.status)) return { decision: 'refuse', reason: 'terminal' }
    if (row.status === 'inboxed' || row.status === 'landed' || row.status === 'consumed') return { decision: 'refuse', reason: 'delivered' }
    if (row.status === 'delivering') return { decision: 'refuse', reason: 'in-flight' }
    if (row.status !== 'queued') return { decision: 'refuse', reason: 'not-queued' }
    // T18, the consumer of `nextAttemptAt`. This check is the whole reason that
    // field exists: before it, the backoff instant was written by
    // `markAttemptFailed` and read by nothing, so a "backoff" that never delayed
    // anything was indistinguishable from no backoff at all.
    //
    // Placement matters. It sits AFTER every permanent refusal, so a row that is
    // terminal or already delivered is still refused for that reason rather than
    // for its clock — otherwise a dead-lettered row with a future stamp would
    // report `backoff` and a caller would re-queue it forever. And it sits BEFORE
    // the CAS, so a not-yet-due row is never dragged into `delivering`: spending
    // an attempt (and incrementing `attempts` toward the dead-letter limit) on a
    // retry that was already scheduled to wait would exhaust a message's retries
    // while it was still adhering to its own schedule.
    //
    // `now` is injectable for the same reason `tick()`'s is: the decision is about
    // a clock, and a test that had to sleep for the real backoff would be slow and
    // flaky instead of exact.
    const now = opts.now ?? Date.now()
    if (!dueByClock(row, now)) return { decision: 'refuse', reason: 'backoff' }
    const won = await this.markDelivering(msgId)
    return won ? { decision: 'deliver', reason: 'claimed' } : { decision: 'refuse', reason: 'cas-lost' }
  }

  /**
   * Read-only "is this row's retry due right now?" (T18, used by T19).
   *
   * This is **not** a substitute for {@link claimDelivery} and must never be used
   * as the delivery decision: it changes no state, so two callers can both get
   * `true` and both go on to deliver. Its one job is to let a caller decide
   * whether an entry is worth *taking* — the mailbox filter in `lifecycle` uses it
   * to skip entries whose retry is still in the future **without removing them
   * from disk**.
   *
   * Why that matters concretely: the obvious alternative was to let the drain take
   * every entry and re-enqueue the not-due ones. But `mailbox.drain()` deletes each
   * file as it reads it, so "take then put back" opens a crash window between the
   * delete and the rewrite. Dying inside it leaves a message with no mailbox file
   * and a ledger row still `queued` — and `recoverInterrupted()` only repairs
   * `delivering` rows, so nothing would ever look for it again. That is the
   * "permanently stalled" state this batch exists to remove, re-created every backoff
   * interval. Answering the question before taking removes the window instead of
   * narrowing it.
   *
   * `true` for a missing row is deliberate, not defensive: the message was never
   * recorded, and bookkeeping must not outrank delivery (T6b). `true` for a
   * non-`queued` row is also deliberate — the real answer for those is a *reason*
   * (`terminal` / `delivered` / `in-flight`), which only the gate can report, so
   * the filter must let them through and let the gate say why.
   */
  async isDue(msgId: string, now: number = Date.now()): Promise<boolean> {
    const domain = this.opened()
    const row = domain.table(MESSAGES_TABLE).get(msgId)
    if (row === undefined) return true
    if (row.status !== 'queued') return true
    return dueByClock(row, now)
  }

  /**
   * Startup self-check: the "repair interrupted state" half of I2 (T13).
   *
   * A row can only be sitting in `delivering` because the process died mid-attempt:
   * every live path either completes it to `inboxed` or returns it to `queued`. This
   * pass finds those rows and returns them to `queued` with an immediate
   * `nextAttemptAt`, so the work is retried rather than lost.
   *
   * Terminal states are never revived. The selection is `status === 'delivering'`,
   * and `'delivering'` is not a member of {@link TERMINAL_STATUSES}, so a terminal
   * row cannot be selected at all. That disjointness is asserted in
   * `tests/ledger-recovery.spec.ts` rather than re-checked here, because a guard on
   * an already-excluded status can never fire and would read as protection it is
   * not providing.
   *
   * ★ The second job IS wired now, and it returns `reconciledRows` — deliberately
   * NOT `reconciled`. That name is already taken by {@link tick}, where it counts
   * **sessions** (`reconciled += 1` per target). This pass counts **rows**
   * (`+= result.examined`). Two fields called `reconciled` holding 3 and 47 would be
   * compared by the next reader, and nothing would go red when they were wrong to
   * compare them. The unit lives in the name instead of in a comment, for the same
   * reason this project keeps rejecting comments as guards.
   *
   * The plan's field name was `requeued`, which promised a state change it never
   * performed: it read as "requeued" while always being 0, so the zero was at least
   * honest that nothing was implemented. A wrong name turning non-zero would have
   * been read as a requeue count, so the rename lands with the wiring.
   *
   * The plan assigns this pass two jobs (`L1258`: "复位卡住的 delivering、重判未 landed")
   * and is explicit about what the second one is (`L1497`): *"T13 的职责是重判未 landed
   * 的行，它必须复用 T7 的 `reconcile()` 判据，因此 T7 是 T13 的硬前置"*. So the
   * judgement is a **read of the target logs** — the same landed/unreadable decision
   * `reconcile()` already makes — not anything about the row's own counters.
   *
   * An earlier revision of this comment claimed the second job needed the retry half
   * to advance counters. That was wrong: it would have made the gap look dependent on
   * a task the plan does not link it to. The real dependency is T7, already implemented.
   *
   * `reconciledRows` counts rows **judged**, not rows judged to have landed. A row
   * whose log is unreadable is still judged (and stamped `unreadableSince`, which is
   * what `expireZombies` later acts on), so it counts. Reading this number as
   * "deliveries confirmed" would overstate it; the landing count lives in
   * `reconcile()`'s result. That stamp is the one real side effect of judging here:
   * an unreadable log at startup starts the same 24 h clock `tick()` starts.
   */
  async recoverInterrupted(opts: { now?: number } = {}): Promise<{ reset: number; reconciledRows: number }> {
    const domain = this.opened()
    const now = opts.now ?? Date.now()
    const table = domain.table(MESSAGES_TABLE)
    let reset = 0
    // Snapshot first: the loop writes back rows in the table it is iterating.
    for (const [, row] of [...table.entries()]) {
      if (row.status !== 'delivering') continue
      const recovered = await this.serialize(async () => this.putIfUnchanged(row.revision ?? 0, {
        ...row,
        status: 'queued',
        // Immediate retry: the attempt that was in flight never completed, so
        // there is no backoff to honour. Keeping the old stamp would park the row
        // until a backoff elapsed for an attempt that never ran.
        nextAttemptAt: now,
        updatedAt: now,
      }))
      if (recovered) reset += 1
    }
    // ── Job 2: re-judge rows that were handed over but never confirmed landed ──
    //
    // ★ This runs OUTSIDE the per-row `serialize()` above, and that placement is
    // load-bearing rather than stylistic: `reconcile()` takes the same serialization
    // chain, which is a tail promise. Wrapping the whole pass in one `serialize()`
    // and calling `reconcile()` inside it would await a link chained behind the one
    // we are currently inside — the pass would wait on itself and the startup
    // self-check would hang instead of failing loudly.
    //
    // Enumerate the targets the same way `tick()` does (only sessions this ledger
    // actually has a stake in, bounded by `maxSessionsPerRequest`) rather than
    // reconciling every known session: a startup pass must not decode logs for
    // sessions it holds no rows for.
    const targets = new Set<string>()
    for (const [, row] of [...table.entries()]) {
      if ((TERMINAL_STATUSES as readonly string[]).includes(row.status)) continue
      if (row.status === 'landed' || row.status === 'consumed') continue
      if (row.resolvedSessionId === null || row.resolvedSessionId === undefined) continue
      targets.add(row.resolvedSessionId)
    }
    let reconciledRows = 0
    for (const sessionId of [...targets].slice(0, LEDGER_LIMITS.maxSessionsPerRequest)) {
      try {
        // `useCache: false` for the same reason `tick()` uses it: a startup pass is
        // the re-examination of reality, not a repeat of a question asked moments
        // ago, and a cached read would let a log that has just gone away still look
        // readable. (At startup the cache is empty; this keeps the intent explicit
        // so a later caller reusing this pass does not silently inherit a stale hit.)
        const result = await this.reconcile(sessionId, { now, useCache: false })
        reconciledRows += result.examined
      } catch (error) {
        // Per-target isolation: one unreadable log must not stop the remaining
        // targets from being re-judged (the plan's per-row failure isolation rule).
        this.warn('reconcile', error)
      }
    }
    return { reset, reconciledRows }
  }

  /**
   * Cancel a queued row with the reason visible on the row (T30).
   *
   * The post-budget target-policy re-check can refuse a delivery whose row was
   * already recorded seconds earlier. The ruling requires that row be explicitly
   * `cancelled` — never left as retryable ghost work. The refusal text lands in
   * the row's error field so `s2s_status` / `s2s_reconcile` can show WHY it was
   * cancelled, not just that it was.
   *
   * The return is STRUCTURED because "the call did not throw" proves nothing:
   * the row may be missing, already handed off, or terminal — and `putIfUnchanged`
   * losing its CAS race means the state on disk is NOT what this call intended.
   * The caller must branch on the outcome; only `cancelled` proves the row is
   * no longer queued.
   *
   * Terminal and already-advancing rows are left untouched (same rule as
   * `markInboxed`): cancelling a delivered message would erase evidence.
   *
   * @param msgId - the queued row to cancel.
   * @param reason - the policy refusal text, stored verbatim on the row.
   * @returns what actually happened on storage.
   */
  async cancel(msgId: string, reason: string): Promise<
    { outcome: 'cancelled'; revision: number } |
    { outcome: 'not-found' } |
    { outcome: 'not-cancellable'; status: string } |
    { outcome: 'conflict' }
  > {
    const domain = this.opened()
    const table = domain.table(MESSAGES_TABLE)
    let result: { outcome: 'cancelled'; revision: number } | { outcome: 'not-found' } | { outcome: 'not-cancellable'; status: string } | { outcome: 'conflict' } = { outcome: 'conflict' }
    await this.serialize(async () => {
      const row = table.get(msgId)
      if (row === undefined) {
        result = { outcome: 'not-found' }
        return
      }
      if (row.status === 'inboxed' || row.status === 'landed' || row.status === 'consumed') {
        result = { outcome: 'not-cancellable', status: row.status }
        return
      }
      if ((TERMINAL_STATUSES as readonly string[]).includes(row.status)) {
        result = { outcome: 'not-cancellable', status: row.status }
        return
      }
      const changed = await this.putIfUnchanged(row.revision ?? 0, {
        ...row,
        status: 'cancelled',
        lastError: reason,
        updatedAt: Date.now(),
      })
      result = changed ? { outcome: 'cancelled', revision: (row.revision ?? 0) + 1 } : { outcome: 'conflict' }
    })
    return result
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
   * Rolling retention: drop rows that are both older than `retentionDays` and
   * beyond the newest `retentionRows` (T22, plan §13.1b / §13.6).
   *
   * ★ This is the only method in the ledger that **destroys** rows, and the plan
   * is explicit that the ledger is the sole copy (`L1483`: "唯一副本，须备份策略").
   * Everything below follows from that one fact:
   *
   * - **`dead_letter` is never pruned.** The plan states it directly (`L1489`:
   *   "`dead_letter` 不自动清理（它们是待人工处置的证据）"). Those rows are the
   *   record of a delivery someone still has to deal with; expiring them by age
   *   would delete the reason they exist.
   * - **Count before deleting.** The candidate set is computed first, reported in
   *   full, and only then removed — so `pruned` is a number this pass can be held
   *   to, not a claim made after the fact.
   * - **Deletion is reported, never silent.** `delete()` resolves `false` when the
   *   row was already gone (another writer removed it), which is not a failure and
   *   must not be counted as one. `pruned` counts what actually disappeared.
   * - **Both bounds apply, whichever bites first** (`L1489`: "取先到者"). A row is
   *   dropped only if it is outside the row budget *and* past the age window, so a
   *   burst of recent rows can never evict a day of history by itself.
   *
   * Ordering note: candidates are sorted oldest-first and the newest
   * `retentionRows` are kept, so the row cap trims history in age order rather
   * than by key order — a `msgId` sort would drop an arbitrary subset.
   *
   * @param opts.now - injectable clock; tests cross the window without waiting.
   * @param opts.dryRun - compute and report the candidate set, delete nothing.
   *   Used by callers that want the answer before the first real prune.
   * @returns what was examined, what was pruned, and the age span of the removed
   *   batch (the audit trail a bare count cannot provide).
   */
  async pruneRetention(
    opts: { now?: number; dryRun?: boolean } = {},
  ): Promise<RetentionPruneResult> {
    const domain = this.opened()
    const now = opts.now ?? Date.now()
    const dryRun = opts.dryRun === true
    return this.serialize(async () => {
      const table = domain.table(MESSAGES_TABLE)
      const cutoff = now - LEDGER_LIMITS.retentionDays * 24 * 60 * 60 * 1000
      // Only prunable rows are candidates: `dead_letter` is excluded by name
      // rather than by "is it terminal", because the plan protects exactly one
      // terminal state and `cancelled` / `legacy_unverifiable` are not it.
      const prunable = [...table.entries()]
        .map(([msgId, row]) => ({ msgId, row }))
        .filter(({ row }) => row.status !== 'dead_letter')
        .sort((a, b) => a.row.createdAt - b.row.createdAt)
      // The row budget keeps the NEWEST `retentionRows` among prunable rows; the
      // age window then trims whatever is still older than the cutoff. Applying
      // both is what "whichever hits first" means in practice.
      const overBudget = Math.max(0, prunable.length - LEDGER_LIMITS.retentionRows)
      const candidates = prunable.filter((entry, index) => index < overBudget || entry.row.createdAt < cutoff)
      let pruned = 0
      for (const { msgId, row } of candidates) {
        if (dryRun) continue
        // CAS-style guard: re-read at delete time so a row that changed status
        // since the snapshot (say, landed or moved to `dead_letter` by a racing
        // pass) is not destroyed on the strength of a stale read.
        //
        // ★ This second layer is DEFENCE IN DEPTH and cannot be made to fail on
        // its own: the filter above already excludes `dead_letter`, so on the
        // ordinary path no such row ever reaches this line, and a test that tries
        // to put one here has to bypass that filter — which is the mutation
        // itself. Measured 2026-11-08: removing only this re-check leaves the full
        // suite green. (To re-derive: delete the `current.status === 'dead_letter'`
        // clause below and run the whole suite; it stays green. That is why this
        // branch has no direct case.) The layer is still worth keeping — it is the
        // only thing standing between a status change that lands *between* snapshot
        // and delete and an irreversible removal — but its existence is proved only
        // indirectly, by the mutant that removes BOTH layers (that one does go red).
        // Do not read a green run as evidence that this branch is exercised.
        const current = table.get(msgId)
        if (current === undefined || current.status === 'dead_letter') continue
        if ((current.revision ?? 0) !== (row.revision ?? 0)) continue
        const removed = await table.delete(msgId)
        // `false` means it was already absent — another writer got there first.
        // That is not this pass removing it, so it must not be counted (I1).
        if (removed) pruned += 1
      }
      const oldest = candidates.length === 0 ? undefined : candidates[0]!.row.createdAt
      const newest = candidates.length === 0 ? undefined : candidates[candidates.length - 1]!.row.createdAt
      return {
        examined: prunable.length,
        candidates: candidates.length,
        pruned,
        dryRun,
        ...(oldest === undefined ? {} : { oldestCreatedAt: oldest }),
        ...(newest === undefined ? {} : { newestCreatedAt: newest }),
      }
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
