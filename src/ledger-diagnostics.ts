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
}

/** Shared, mutable handshake record. */
export const ledgerDiagnostics: LedgerDiagnostics = {}
