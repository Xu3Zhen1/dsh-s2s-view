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
   * The same reading taken at four points in the lifecycle, because a single
   * reading cannot tell "never registered" from "registered then invisible".
   *
   * Every earlier round suffered from exactly that: one number, no series, so
   * every explanation stayed equally consistent with it.
   */
  probes?: LedgerProbe[]
}

/** Shared, mutable handshake record. */
export const ledgerDiagnostics: LedgerDiagnostics = {}

/** How many probe rows to keep. Four lifecycle points; the cap only guards against repeats. */
const MAX_PROBES = 12

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
