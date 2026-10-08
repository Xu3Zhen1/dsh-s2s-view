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

