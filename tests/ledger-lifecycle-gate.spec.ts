import { describe, expect, it, vi } from 'vitest'
import { LEDGER_READY_MAX_TURNS, waitForLedger } from '../src/ledger-diagnostics.ts'

/**
 * The lifecycle gate, at the only seam that is honestly testable.
 *
 * Measured on the real host (f256fce series):
 *   apply-entry             selfGet=false selfFiberState=1
 *   storage-domain-callback selfGet=false selfFiberState=1
 *   callback-microtask      selfGet=true  selfFiberState=2
 * cordis withholds a service while its PROVIDING fiber is not ACTIVE
 * (`_getImpl`: `if (strict && impl.fiber.state !== 2) return`), so a single
 * lookup at callback time legitimately returns undefined, and one turn later it
 * does not.
 *
 * **Why these test `waitForLedger` and not the plugin through a context.** An
 * earlier version of this file patched `ctx.get` and drove the real plugin. It
 * passed with the retry removed, i.e. it proved nothing: cordis hands each fiber
 * its own context object, so the patch never intercepted the plugin's calls.
 * That is recorded here rather than quietly deleted — a test that cannot fail is
 * worse than no test, and this file already produced one.
 */

/** Yields once without real timers. */
const tick = (): Promise<void> => Promise.resolve()

describe('waitForLedger — re-read a gated service until it appears', () => {
  it('★★ retries past the gate and returns the value from a LATER turn', async () => {
    // The host shape: invisible on attempt 1, visible on attempt 2.
    let reads = 0
    const value = { ok: true }
    const result = await waitForLedger(
      function() { reads += 1; return reads >= 2 ? value : undefined },
      8, tick,
    )

    expect(result.value).toBe(value)
    expect(result.turns).toBe(1)
    expect(result.exhausted).toBe(false)
    expect(reads).toBe(2)
  })

  it('★★ fails against a single-shot read (the behaviour that shipped twice)', async () => {
    // Guards the real defect: with maxTurns=1 the loop must NOT silently succeed
    // on a gated service. If someone reverts the retry, this goes red.
    const gated = function() { return undefined as { ok: boolean } | undefined }
    const result = await waitForLedger(gated, 1, tick)

    expect(result.value).toBeUndefined()
    expect(result.exhausted).toBe(true)
    expect(result.turns).toBe(1)
  })

  it('★ returns immediately when the service is already retrievable', async () => {
    const value = { ok: true }
    const read = vi.fn(function() { return value })
    const result = await waitForLedger(read, 8, tick)

    expect(result.value).toBe(value)
    expect(result.turns).toBe(0)
    expect(read).toHaveBeenCalledTimes(1)
    // No needless waiting when the first read already succeeded.
    expect(result.exhausted).toBe(false)
  })

  it('★ is bounded: it stops instead of retrying forever', async () => {
    let reads = 0
    const result = await waitForLedger(function() { reads += 1; return undefined }, 8, tick)

    expect(result.exhausted).toBe(true)
    expect(reads).toBe(8)
    expect(result.turns).toBe(8)
  })

  it('★ reports each unsuccessful turn so the host reading can show the wait', async () => {
    const turns: number[] = []
    let reads = 0
    await waitForLedger(function() { reads += 1; return reads >= 3 ? {} : undefined }, 8, tick, function(t) { turns.push(t) })

    expect(turns).toEqual([1, 2])
  })

  it('★ the default bound is the small finite number the code claims', async () => {
    // Keeps the documented constant honest; the host needed exactly one turn.
    expect(LEDGER_READY_MAX_TURNS).toBe(8)
    let reads = 0
    await waitForLedger(function() { reads += 1; return undefined }, undefined, tick)
    expect(reads).toBe(8)
  })

  it('★ an immediately-visible service costs exactly one read (no regression to polling)', async () => {
    let reads = 0
    await waitForLedger(function() { reads += 1; return { ok: true } }, 8, tick)
    expect(reads).toBe(1)
  })
})
