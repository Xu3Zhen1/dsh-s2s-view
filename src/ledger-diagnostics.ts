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
  /** Set synchronously inside `apply()`, so it is true even if the callback never runs. */
  injectRegistered?: boolean
  /** How many times the `storageDomain` injection callback ran. */
  injectFired?: number
  injectFiredAt?: number
  /** Whether the ledger service was visible from inside that callback. */
  ledgerVisibleInCallback?: boolean
  /** Whether `open()` resolved. */
  openSucceeded?: boolean
  /** Why `open()` rejected, verbatim. */
  openError?: string
}

/** Shared, mutable handshake record. */
export const ledgerDiagnostics: LedgerDiagnostics = {}
