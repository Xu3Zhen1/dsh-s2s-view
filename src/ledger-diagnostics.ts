/**
 * Runtime facts about the entry plugin's ledger handshake, readable from tools.
 *
 * **Why this is a module of its own.** The first attempt at fixing the ledger
 * race passed every local probe and did nothing on the real host. The plugin
 * logger is never persisted there, so "the `storageDomain` callback never fired"
 * and "it fired, and the store still was not visible" left *identical* evidence
 * afterwards — nothing. Several rounds were spent on that ambiguity.
 *
 * These counters are written by `src/index.ts` at mount time and read back by
 * `s2s_status`, so the handshake can be inspected in the running process instead
 * of modelled locally. It lives here rather than in `index.ts` so `tools.ts` can
 * import it without creating an `index -> tools -> index` cycle.
 *
 * A mutable object (not individual exports) because writers assign fields over
 * time and readers must observe the latest values.
 */

/** One reading of "can we see the ledger right now, and why not". */
export interface LedgerProbe {
  /** Where in the lifecycle this reading was taken. */
  at: string
  /** Epoch ms. */
  t: number
  /** `ctx.get('s2sLedger') !== undefined` on the plugin's own context. */
  selfGet: boolean
  /** `ctx.get('s2sLedger') !== undefined` through the injected child context. */
  childGet: boolean
  /**
   * Whether the service implementation EXISTS at all, ignoring the ACTIVE gate.
   *
   * This is the discriminator the review asked for: `selfGet=false` with
   * `implPresent=true` means the service is registered but its providing fiber is
   * not ACTIVE (cordis `_getImpl` returns undefined when `fiber.state !== 2`),
   * which is a lifecycle problem. `implPresent=false` means it was never
   * registered on the store we can reach — a different problem entirely.
   */
  implPresent: boolean
  /** The providing fiber's state when found; `null` when no impl was found. */
  implFiberState: number | null
  /** Our own fiber's state at this instant. */
  selfFiberState: number | null
  /** Probe context: which hook produced this row. */
  via: string
}

export interface LedgerDiagnostics {
  /**
   * Whether the ledger service was visible from `apply()` scope — the reference
   * the fix actually uses. If this is false on the real host, the fix is void and
   * the problem is service lifecycle, not timing.
   */
  outerLedgerVisible?: boolean
  /**
   * Whether `domainCtx.get('s2sLedger')` worked *inside* the inject callback.
   *
   * Kept alongside `outerLedgerVisible` because the review requires the two to be
   * distinguishable: the measured failure was this lookup returning undefined
   * while the store was present, and the fix works around that rather than
   * explaining it.
   */
  callbackLedgerVisible?: boolean
  /** Set synchronously inside `apply()`, so it is true even if the callback never runs. */
  injectRegistered?: boolean
  /** How many times the `storageDomain` injection callback ran. */
  injectFired?: number
  injectFiredAt?: number
  /** Whether `open()` was reached — separates "never called" from "called and failed". */
  openCalled?: boolean
  /** Whether `open()` resolved. */
  openSucceeded?: boolean
  /** Why `open()` rejected, or why it was never attempted, verbatim. */
  openError?: string
  /**
   * How many rows the startup self-check returned from `delivering` to `queued`
   * (T13 / I2).
   *
   * Non-zero means the previous process ended mid-attempt and that work was
   * rescued. **A zero is not a healthy reading on its own**: it means either
   * "nothing was interrupted" or "the self-check never ran". That ambiguity is
   * why {@link interruptedResetError} and the probe row sit beside it — the same
   * two-sided shape as `domainReleaseError` / `domainReleasedCount`.
   */
  interruptedReset?: number
  /**
   * How many rows the startup self-check **re-judged** (T13's second job).
   *
   * The unit is rows, and that is why the name carries it: {@link tick} reports a
   * field called `reconciled` that counts **sessions**, so a bare `reconciled` here
   * would be a second number of the same name that cannot be compared with the
   * first — and no check would go red when someone compared them anyway.
   *
   * **Every value, including the boring one:**
   * - `undefined` — the self-check has not run (the ledger never opened), so this
   *   is "no reading", not "clean".
   * - `0` — the pass ran and judged nothing. Reachable and honest: no row was
   *   waiting to be re-judged, e.g. every row was terminal or already landed.
   * - `> 0` — that many rows were judged. This counts rows *examined*, **not** rows
   *   found landed: a row whose target log could not be read was judged too, and
   *   gets stamped `unreadableSince`, which starts the same 24 h `landedDeadlineMs`
   *   clock {@link tick} starts. So a non-zero value here can end in `dead_letter`
   *   rather than in `landed`, and reading it as "deliveries confirmed" overstates it.
   *
   * Paired with {@link interruptedResetError} for the same reason that field exists:
   * a failed self-check leaves rows untouched, and without a persisted error the
   * only trace would be a `warn` that is gone after the fact.
   */
  interruptedReconciledRows?: number
  /**
   * Why the startup self-check could not run, verbatim.
   *
   * Same reasoning as `domainReleaseError`: plugin logger output is not persisted,
   * so a self-check that throws and is only `warn`ed is invisible after the fact.
   * A failed self-check is not cosmetic — it leaves rows stuck in `delivering`
   * that no live path will ever retry.
   */
  interruptedResetError?: string
  /**
   * Why releasing the storage domain on teardown failed, verbatim.
   *
   * Teardown must not throw, but it must not be silent either: a failed release
   * is exactly what leaves the domain claimed for the rest of the process, so the
   * next mount dies with `domain 's2s' is already open`. Without this field that
   * failure is invisible — cordis would otherwise route the rejection to
   * `logger.error`, and plugin logger output is not persisted anywhere, so it is
   * unrecoverable after the fact.
   */
  domainReleaseError?: string
  /**
   * How many times teardown actually released a storage domain in this process.
   *
   * A failure trace alone cannot be read correctly: `domainReleaseError` being
   * unset means *either* "released cleanly" *or* "teardown never had a domain to
   * release" — the two are indistinguishable from that field alone, so the
   * absence of an error cannot support the claim "the release ran". This counter
   * makes the pair separable: `count > 0` proves the path executed, `count === 0`
   * proves it never did. Only incremented when a domain (or an in-flight open)
   * actually existed, so a plugin that never opened stays at 0 rather than
   * inflating the number.
   */
  domainReleasedCount?: number
  /**
   * How many times `open()` successfully acquired a storage domain.
   *
   * The pair with `domainReleasedCount` narrows the search. `acquired - released`
   * is the number of domains currently held, and that remainder cannot exceed the
   * number of live instances — so:
   *
   *     acquired - released >  mountedInstances  ⇒ a release was definitely skipped
   *     acquired - released <= mountedInstances  ⇒ consistent, but NOT a proof
   *
   * Only the inequality is sound. An earlier version of this comment claimed
   * equality (`remainder == mountedInstances`), which is false whenever a live
   * instance holds no domain — `mountedInstances` counts construction while this
   * counter increments only after `facility.open()` resolves, and `open()` is
   * called later by the mount path and may fail. See `mountedInstances`.
   *
   * What it still cannot do: prove pairing. 5 acquired, 3 released, 2 live passes
   * even if one release acted on the wrong domain. And `released > 0` proves
   * occurrence, never correctness.
   *
   * Incremented only after `facility.open()` resolves, so a failed open does not
   * inflate it.
   */
  domainAcquiredCount?: number
  /**
   * How many `S2sLedger` instances are alive in this process right now.
   *
   * ★ This is NOT the denominator for the release-completeness check, and an
   * earlier comment here claimed it was. The two counters do not share a start:
   * `mountedInstances` is incremented in the constructor while `domainAcquiredCount`
   * is incremented only after `facility.open()` resolves, and `open()` is called
   * separately by the mount path (`index.ts`) and can fail (`facility` undefined
   * throws). So a live instance may hold no domain at all, and
   * `acquired - released == mountedInstances` is simply false in that state.
   *
   * It is a runtime measurement rather than a config count, which is still worth
   * having — the config lists one mount while a reload can leave two instances
   * alive. But it bounds the remainder from above, it does not equal it: see the
   * one-directional rule in `releaseDomainCount`'s companion comment and in
   * `AGENTS.md` §5.
   *
   * Incremented on construction, decremented in the teardown effect, floored at 0
   * so a double dispose cannot drive it negative.
   */
  mountedInstances?: number
  /**
   * When this process began, sampled from `process.uptime()` at module load.
   *
   * The cold-start criterion needs a clock that is independent of the plugin's
   * own lifecycle hooks: `procStart` is it. `Date.now() - process.uptime()*1000`
   * is the process's own start instant, so every handshake timestamp must be
   * `>= procStart` and a reading from a previous process cannot satisfy that.
   */
  procStart?: number
  /** Wall-clock `Date.now()` when `open()` was invoked. */
  openCalledAt?: number
  /** Wall-clock `Date.now()` when `open()` resolved successfully. */
  openSucceededAt?: number
  /**
   * Wall-clock `Date.now()` of the first `s2s_*` tool call in this process.
   *
   * Sampled from the `tools/pre-execute` waterfall rather than from inside
   * `s2s_status`. That distinction is the whole point: a stamp written by the
   * status handler would be produced BY the act of reading the status, so it
   * could never show that `open()` succeeded before any tool ran (the original
   * criterion had exactly that observer effect).
   */
  firstS2sToolCallAt?: number
  /** Name of that first tool call, for the record. */
  firstS2sToolCallName?: string
  /**
   * Whether the `tools/pre-execute` listener was actually attached.
   *
   * This exists because the first version of the sampler silently did nothing:
   * it called `tools.on(...)` — the `tools` service exposes only `register()`;
   * listeners belong on `ctx` — behind a type guard and a swallowing `catch`.
   * On the real host `firstS2sToolCallAt` therefore stayed `n/a` with no error
   * anywhere. G9 forbids a degradation that leaves no trace, so the outcome is
   * now recorded and rendered.
   */
  toolCallSamplerAttached?: boolean
  /** Why attaching the sampler failed, verbatim, when it did. */
  toolCallSamplerError?: string
  /**
   * The same reading taken at four points in the lifecycle, because a single
   * reading cannot tell "never registered" from "registered then invisible".
   *
   * Every earlier round suffered from exactly that: one number, no series, so
   * every explanation stayed equally consistent with it.
   */
  probes?: LedgerProbe[]
  /**
   * Deliveries whose `markInboxed()` found no row to advance.
   *
   * This is the G9 hole that let a real defect hide: `s2s_resume` delivered a
   * message without ever calling `record()`, so `markInboxed` hit its
   * `row === undefined` branch, warned through the plugin logger — and the
   * plugin logger is **never persisted**, so afterwards "it was tracked" and
   * "it silently was not" had identical evidence. Measured on the real host:
   * the target's log carried the message while the ledger held zero rows for it
   * and `s2s_reconcile` reported `examined=0`.
   *
   * These entries are read back by `s2s_status`, so the failure is obtainable
   * from the running process. Deliberately process-scoped and bounded: this is a
   * *diagnostic read-back*, not a second persistence protocol — the ledger row
   * remains the only durable record of a delivery.
   */
  untrackedDeliveries?: UntrackedDelivery[]
  /**
   * T30: the last post-gate refusal whose queued-row cancellation did not
   * provably succeed (cancel threw, or the ledger was not open). The row then
   * REMAINS `queued` — this field is the only process-level trace that a refusal
   * left work behind. Read back by `s2s_status`.
   */
  lastSelfRefusalCancelFailure?: SelfRefusalCancelFailure
}

/** One `markInboxed()` that had nothing to advance. */
export interface UntrackedDelivery {
  /** The id whose row was missing. */
  msgId: string
  /** Where the delivery nevertheless went. */
  resolvedSessionId: string
  /** Epoch ms; sampled here because nothing else records this event. */
  at: number
}

/** Shared, mutable handshake record. */
export const ledgerDiagnostics: LedgerDiagnostics = {}

/**
 * T30: the LAST post-gate refusal whose queued-row cancellation did NOT provably
 * succeed. Written by the delivery tools when `ledger.cancel` throws or the
 * ledger is not open — the row then REMAINS queued, and this is the only trace
 * that a refusal left work behind (G9: no silent degradation).
 */
export interface SelfRefusalCancelFailure {
  readonly msgId: string
  readonly at: number
  readonly error: string
}

// Bounded by design: only the most recent failure matters for the status line;
// older ones are visible on their rows (status stays `queued` with the refusal
// in `lastError`).

/**
 * Record a failed/unavailable queued-row cancellation after a target-policy
 * refusal. Never throws.
 */
export function recordSelfRefusalCancelFailure(entry: SelfRefusalCancelFailure): void {
  try {
    ledgerDiagnostics.lastSelfRefusalCancelFailure = entry
  } catch {}
}

/**
 * T30: the LATEST drain-refusal cancellation outcomes (bounded, latest last).
 *
 * The lifecycle owns the cancel for refused messages — including the
 * `agent/created` bypass, where no tool call is involved and a logger line is
 * NOT a ledger proof. Every refusal's structured cancel outcome lands here so
 * `s2s_status` can render it; the per-row durable state remains the row itself
 * (cancelled / still-queued with the reason).
 */
export interface DrainRefusalOutcome {
  readonly sessionId: string
  readonly msgId: string
  readonly code: string
  /** Structured cancel outcome: `cancelled`, `not-cancelled (…)`, `cancel-failed: …`, `cancel-unavailable (…)`. */
  readonly cancelOutcome: string
  readonly at: number
}

const drainRefusalOutcomes: DrainRefusalOutcome[] = []
const MAX_DRAIN_REFUSAL_OUTCOMES = 20

/** Record one refused message's cancel outcome. Never throws. */
export function recordDrainRefusalOutcome(entry: DrainRefusalOutcome): void {
  try {
    drainRefusalOutcomes.push(entry)
    while (drainRefusalOutcomes.length > MAX_DRAIN_REFUSAL_OUTCOMES) drainRefusalOutcomes.shift()
  } catch {}
}

/** Read-only view for `s2s_status` (latest last). */
export function readDrainRefusalOutcomes(): readonly DrainRefusalOutcome[] {
  return drainRefusalOutcomes
}

/** Test isolation. */
export function resetDrainRefusalOutcomes(): void {
  drainRefusalOutcomes.length = 0
}

/**
 * One `nextAttemptAt` that the clock-jump guard had to pull back (T27, plan §6 R14).
 *
 * The spec says an implausible stamp must be "clamped **and logged**". A logger is
 * not a durable artifact on this host — the session transcript keeps only
 * `{type,seq,time,data}` records and `~/.dsh` has no host log directory — so a
 * logger-only trace cannot be verified afterwards. That is why this is a record
 * with a reader instead of a `logger.warn` alone (G9: no silent degradation).
 *
 * `previousAt` is kept beside the two derived instants because the three numbers
 * tell different stories: `previousAt` explains WHY the clamp fired (a stamp left
 * far in the future by a clock jump), while `intendedAt`→`clampedTo` shows what the
 * guard did about it. A record carrying only the clamped value would look like a
 * normal scheduling decision.
 */
export interface ClampedNextAttempt {
  readonly msgId: string
  /** The instant the backoff would have scheduled, before the guard. */
  readonly intendedAt: number
  /** The instant actually written. */
  readonly clampedTo: number
  /** The stamp already on the row when the guard fired (the reason it fired). */
  readonly previousAt: number
  readonly at: number
}

const clampedNextAttempts: ClampedNextAttempt[] = []
const MAX_CLAMPED_NEXT_ATTEMPTS = 20

/** Record one clamped stamp. Never throws. */
export function recordClampedNextAttempt(entry: ClampedNextAttempt): void {
  try {
    clampedNextAttempts.push(entry)
    while (clampedNextAttempts.length > MAX_CLAMPED_NEXT_ATTEMPTS) clampedNextAttempts.shift()
  } catch {}
}

/** Read-only view for `s2s_status` (latest last). */
export function readClampedNextAttempts(): readonly ClampedNextAttempt[] {
  return clampedNextAttempts
}

/** Test isolation. */
export function resetClampedNextAttempts(): void {
  clampedNextAttempts.length = 0
}

/**
 * Self-target check skipped because the host gave no caller id (T29).
 *
 * The ruling allows the explicit fail-open only if it is observable on every
 * path that actually sends or queues. The receipt covers the happy return, but
 * budget/queue/delivery can THROW after resolution — and a thrown error would
 * otherwise erase the receipt. This bounded process-level record survives that:
 * written before the first side effect, read back by `s2s_status`.
 *
 * Bounded like `untrackedDeliveries`. The recorded fact is a **resolved
 * attempt**, not a delivery: the event lands before any budget/queue/deliver
 * side effect, so the reader must not treat it as proof that anything was sent.
 * No message text is ever recorded here.
 */
export interface SelfCheckSkippedEvent {
  /** Tool whose resolution proceeded without a self check. */
  tool: string
  /** Canonical target id the attempt was addressed to. */
  target: string
  /** Epoch ms. */
  at: number
}

const MAX_SELF_CHECK_SKIPPED = 10

/**
 * Bounded record of skipped self-target checks, latest last. Read by
 * `s2s_status`; retains at most {@link MAX_SELF_CHECK_SKIPPED} entries and is
 * process-scoped (a restart clears it). N here is the *retained* count, not a
 * process-lifetime total.
 */
const selfCheckSkipped: SelfCheckSkippedEvent[] = []

/**
 * Record that a resolution proceeded without a self-target check because the
 * caller id was unavailable. Never throws — called on the delivery path, before
 * the first side effect.
 *
 * @param tool - the tool name.
 * @param target - the resolved target id.
 */
export function recordSelfCheckSkipped(tool: string, target: string): void {
  try {
    selfCheckSkipped.push({ tool, target, at: Date.now() })
    while (selfCheckSkipped.length > MAX_SELF_CHECK_SKIPPED) selfCheckSkipped.shift()
  } catch {
    // Diagnostics never break the caller.
  }
}

/** Read-only view for `s2s_status`: the bounded list itself (latest last). */
export function readSelfCheckSkipped(): readonly SelfCheckSkippedEvent[] {
  return selfCheckSkipped
}

/** Test isolation: clear the bounded record (module-level singleton, like untrackedDeliveries). */
export function resetSelfCheckSkipped(): void {
  selfCheckSkipped.length = 0
}

// Sampled once, at module load: `process.uptime()` counts from process start, so
// this is the process's own beginning and no earlier reading can precede it.
// Wrapped because a hostile/odd embedding may not expose `process`.
try {
  ledgerDiagnostics.procStart = Date.now() - Math.round(process.uptime() * 1000)
} catch {
  // Leave it undefined; the handshake renders it as unknown rather than lying.
}

/**
 * Record the first `s2s_*` tool invocation of this process, once.
 *
 * Idempotent by design: the criterion compares against the FIRST call, so later
 * calls must not move the stamp. Never throws — this runs inside the tool
 * pipeline, and a diagnostic must not be able to break a tool call.
 *
 * @param toolName - the name of the tool about to execute.
 */
export function recordFirstS2sToolCall(toolName: string): void {
  try {
    if (ledgerDiagnostics.firstS2sToolCallAt !== undefined) return
    ledgerDiagnostics.firstS2sToolCallAt = Date.now()
    ledgerDiagnostics.firstS2sToolCallName = toolName
  } catch {
    // Diagnostics never break the caller.
  }
}

/** How many probe rows to keep. Four lifecycle points; the cap only guards against repeats. */
const MAX_PROBES = 12

/**
 * How many untracked-delivery entries to keep.
 *
 * Bounded rather than grown: this exists so a reader can see that the failure
 * happens *and which message it happened to*, not as an audit log. The durable
 * per-message record is the ledger row — the whole point is that there wasn't
 * one.
 */
const MAX_UNTRACKED_DELIVERIES = 10

/**
 * Record a delivery that could not be tracked because its row was never written.
 *
 * Called from the ledger's `markInboxed()` when `table.get(msgId)` misses. It
 * never throws: this runs on the delivery path, and a diagnostic must not be
 * able to turn "untracked" into "undelivered".
 *
 * @param msgId - the id whose row was absent.
 * @param resolvedSessionId - the session the message was handed to anyway.
 */
export function recordUntrackedDelivery(msgId: string, resolvedSessionId: string): void {
  try {
    const list = ledgerDiagnostics.untrackedDeliveries ?? []
    list.push({ msgId, resolvedSessionId, at: Date.now() })
    while (list.length > MAX_UNTRACKED_DELIVERIES) list.shift()
    ledgerDiagnostics.untrackedDeliveries = list
  } catch {
    // Diagnostics never break the caller.
  }
}

/**
 * Read the service-resolution state without ever throwing.
 *
 * Diagnostic code must not be the thing that breaks the tool it exists to
 * explain — that lesson cost a test round already (three existing tests build
 * the tools without a `ctx`).
 *
 * `implPresent` reaches into cordis internals deliberately. There is no public
 * API that distinguishes "not registered" from "registered but its fiber is not
 * ACTIVE", and that distinction is precisely the open question: `_getImpl`
 * returns `undefined` for both. The lookups are wrapped so an internal shape
 * change degrades to `false`/`null` instead of throwing inside a tool call.
 */
export function probeLedger(ctx: unknown, child: unknown, via: string): LedgerProbe {
  const row: LedgerProbe = {
    at: new Date().toISOString(),
    t: Date.now(),
    selfGet: false,
    childGet: false,
    implPresent: false,
    implFiberState: null,
    selfFiberState: null,
    via,
  }
  const safeGet = function (target: unknown): boolean {
    if (target === undefined || target === null) return false
    try {
      return (target as { get(n: string): unknown }).get('s2sLedger') !== undefined
    } catch {
      return false
    }
  }
  row.selfGet = safeGet(ctx)
  if (child !== undefined) row.childGet = safeGet(child)

  try {
    const internals = ctx as {
      fiber?: { state?: number }
      reflect?: { store?: Record<string, unknown> }
    }
    row.selfFiberState = internals?.fiber?.state ?? null
    const store = internals?.reflect?.store
    if (store !== undefined && store !== null) {
      for (const key of Object.keys(store)) {
        const impl = store[key] as { name?: string; fiber?: { state?: number } } | undefined
        if (impl?.name === 's2sLedger') {
          row.implPresent = true
          row.implFiberState = impl.fiber?.state ?? null
          break
        }
      }
    }
  } catch {
    // Internals moved; the row still carries the public readings.
  }
  return row
}

/** Append a probe row, keeping the list bounded. */
export function recordProbe(ctx: unknown, child: unknown, via: string): void {
  try {
    const list = ledgerDiagnostics.probes ?? []
    list.push(probeLedger(ctx, child, via))
    while (list.length > MAX_PROBES) list.shift()
    ledgerDiagnostics.probes = list
  } catch {
    // Diagnostics never break the caller.
  }
}

/**
 * How many turns to keep re-reading the ledger before giving up.
 *
 * The measured host series needed exactly one (retrievable on the next turn),
 * but this is a bound, not a schedule: the loop re-reads and stops as soon as
 * the service appears. Eight turns is free and still finite.
 */
export const LEDGER_READY_MAX_TURNS = 8

/** Outcome of {@link waitForLedger}. */
export interface LedgerWaitResult<T> {
  /** The service, once retrievable. */
  value: T | undefined
  /** How many unsuccessful reads preceded success (`0` = visible immediately). */
  turns: number
  /**
   * True when the bound was hit without the service ever appearing.
   *
   * Kept distinct from `value === undefined` alone so the caller can report
   * "never became retrievable" rather than implying an `open()` failed.
   */
  exhausted: boolean
}

/**
 * Re-read a service until it becomes retrievable, then hand it back.
 *
 * **Why this exists as a pure function.** The real defect was a lifecycle gate:
 * cordis withholds a service while its *providing fiber* is not yet ACTIVE
 * (`_getImpl`: `if (strict && impl.fiber.state !== 2) return`). On the measured
 * host the service was invisible at callback time and visible one turn later.
 *
 * This cannot be exercised through a real cordis context in a unit test — six
 * local probes could not reproduce the host's ordering, and cordis gives each
 * fiber its own context object, so patching `get` in the test does not intercept
 * the plugin's calls (that mistake produced a vacuous test that passed with the
 * retry removed). Taking `read` as a parameter makes the seam testable with a
 * deterministic fake while the production call site stays trivially thin.
 *
 * @param read — one fresh attempt; return `undefined` when not yet retrievable.
 * @param maxTurns — bound on unsuccessful attempts (default {@link LEDGER_READY_MAX_TURNS}).
 * @param wait — yields to the scheduler between attempts; injectable for tests.
 * @param onTurn — called with the turn number after each unsuccessful read.
 */
export async function waitForLedger<T>(
  read: () => T | undefined,
  maxTurns: number = LEDGER_READY_MAX_TURNS,
  wait: () => Promise<void> = function() { return Promise.resolve() },
  onTurn?: (turn: number) => void,
): Promise<LedgerWaitResult<T>> {
  let turns = 0
  for (;;) {
    const value = read()
    if (value !== undefined) return { value, turns, exhausted: false }
    turns += 1
    onTurn?.(turns)
    if (turns >= maxTurns) return { value: undefined, turns, exhausted: true }
    await wait()
  }
}

