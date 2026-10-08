import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { buildTools } from '../src/tools.ts'
import { S2sLedger } from '../src/ledger.ts'
import {
  ledgerDiagnostics,
  recordFirstS2sToolCall,
  type LedgerDiagnostics,
} from '../src/ledger-diagnostics.ts'

/**
 * The cold-start clock on `s2s_status`.
 *
 * Why these fields exist. The original acceptance criterion read
 * "`openOk` must appear before `tools-first-execution` in the first
 * `handshake-series:`". That is unobservable by construction: `tools.ts` records
 * `tools-first-execution` from *inside the s2s_status handler*, so the act of
 * reading the status is what creates the row the criterion compares against.
 * The reviewer accepted the objection and replaced it with a timestamp order:
 *
 *     procStart <= openCalledAt <= openSucceededAt < firstS2sToolCallAt
 *
 * `firstS2sToolCallAt` must come from an independent in-process sample, so it is
 * written on the `tools/pre-execute` waterfall — the first `s2s_*` call of any
 * kind stamps it, and `recordFirstS2sToolCall` is idempotent because the
 * criterion is about the FIRST call.
 *
 * These tests pin the rendering and the sampler's monotonicity. They claim
 * nothing about the real host; the ordering is validated there.
 */

const saved: LedgerDiagnostics = { ...ledgerDiagnostics }
afterEach(() => {
  for (const k of Object.keys(ledgerDiagnostics) as Array<keyof LedgerDiagnostics>) {
    delete ledgerDiagnostics[k]
  }
  Object.assign(ledgerDiagnostics, saved)
  for (const k of Object.keys(saved) as Array<keyof LedgerDiagnostics>) delete saved[k]
})

function makeStatus() {
  const ctx = new Context()
  const ledger = new S2sLedger(ctx, { timerIntervalMs: 0 })
  const defs = buildTools({
    ctx,
    broker: { deliver: () => 'idle', history: () => [] } as never,
    discovery: {
      list: async () => [],
      resolve: async () => ({ kind: 'not-found', name: 'x', candidates: [] }),
    } as never,
    ledger,
  } as never)
  const status = defs.find((d) => d.name === 's2s_status') as unknown as {
    execute(args: object, exec: object): Promise<{ text: string }>
  }
  return { ctx, status }
}

function lineWith(text: string, prefix: string): string {
  return text.split('\n').find((l) => l.startsWith(prefix)) ?? ''
}

describe('cold-start clock', () => {
  it('★ stamps procStart at module load, so it precedes anything this process does', () => {
    // procStart is derived from process.uptime(), i.e. the process's own start.
    // It must therefore be at or before "now" — never in the future.
    expect(ledgerDiagnostics.procStart).toBeTypeOf('number')
    expect(ledgerDiagnostics.procStart as number).toBeLessThanOrEqual(Date.now())
  })

  it('★ keeps only the FIRST tool call — later calls must not move the boundary', () => {
    // The criterion compares openSucceededAt against the FIRST call. If a later
    // call overwrote the stamp, a genuinely late open could be made to look
    // early by simply calling another tool, which would make the whole check
    // self-defeating.
    delete ledgerDiagnostics.firstS2sToolCallAt
    delete ledgerDiagnostics.firstS2sToolCallName

    recordFirstS2sToolCall('s2s_status')
    const first = ledgerDiagnostics.firstS2sToolCallAt
    expect(ledgerDiagnostics.firstS2sToolCallName).toBe('s2s_status')

    recordFirstS2sToolCall('s2s_message')
    recordFirstS2sToolCall('s2s_sessions')

    expect(ledgerDiagnostics.firstS2sToolCallAt).toBe(first)
    expect(ledgerDiagnostics.firstS2sToolCallName).toBe('s2s_status')
  })

  it('★ renders COLD-START-OK when open demonstrably preceded any tool call', async () => {
    const base = Date.UTC(2026, 9, 9, 0, 0, 0)
    ledgerDiagnostics.procStart = base
    ledgerDiagnostics.openCalledAt = base + 1000
    ledgerDiagnostics.openSucceededAt = base + 2000
    ledgerDiagnostics.firstS2sToolCallAt = base + 3000
    ledgerDiagnostics.openSucceeded = true

    const { ctx, status } = makeStatus()
    const text = (await status.execute({}, { agent: { id: 's' } })).text

    const clock = lineWith(text, 'handshake-clock:')
    expect(clock).toContain('procStart=2026-10-09T00:00:00.000Z')
    expect(clock).toContain('openCalledAt=2026-10-09T00:00:01.000Z')
    expect(clock).toContain('openOkAt=2026-10-09T00:00:02.000Z')
    expect(clock).toContain('firstS2sToolCallAt=2026-10-09T00:00:03.000Z')

    const verdict = lineWith(text, 'handshake-coldstart:')
    expect(verdict).toContain('COLD-START-OK')
    await ctx.fiber.dispose()
  })

  it('★★ FALSIFICATION: an open that happened after a tool call is NOT cold start', async () => {
    // This is the assertion that gives the criterion teeth. Swap the order so
    // open() lands *after* the first tool call — the real failure mode the
    // reviewer is guarding against ("delayed self-healing").
    //
    // If this test still said COLD-START-OK, the check would be vacuous: it
    // would pass for a run that only ever opened the ledger because someone
    // called a tool.
    const base = Date.UTC(2026, 9, 9, 0, 0, 0)
    ledgerDiagnostics.procStart = base
    ledgerDiagnostics.firstS2sToolCallAt = base + 1000
    ledgerDiagnostics.openCalledAt = base + 2000
    ledgerDiagnostics.openSucceededAt = base + 3000
    ledgerDiagnostics.openSucceeded = true

    const { ctx, status } = makeStatus()
    const text = (await status.execute({}, { agent: { id: 's' } })).text
    const verdict = lineWith(text, 'handshake-coldstart:')

    expect(verdict).toContain('openSucceededAt<firstS2sToolCallAt=false')
    expect(verdict).toContain('COLD-START-NOT-PROVEN')
    expect(verdict).not.toContain('COLD-START-OK')
    await ctx.fiber.dispose()
  })

  it('★★ FALSIFICATION: a broken internal order is NOT cold start', async () => {
    // openSucceededAt before openCalledAt cannot happen in a correct run, so the
    // renderer must not report success on it — a monotonicity break means the
    // clock was not sampled where it claims to have been.
    const base = Date.UTC(2026, 9, 9, 0, 0, 0)
    ledgerDiagnostics.procStart = base
    ledgerDiagnostics.openCalledAt = base + 2000
    ledgerDiagnostics.openSucceededAt = base + 1000
    ledgerDiagnostics.firstS2sToolCallAt = base + 3000

    const { ctx, status } = makeStatus()
    const text = (await status.execute({}, { agent: { id: 's' } })).text
    const verdict = lineWith(text, 'handshake-coldstart:')

    expect(verdict).toContain('procStart<=openCalledAt<=openSucceededAt=false')
    expect(verdict).toContain('COLD-START-NOT-PROVEN')
    await ctx.fiber.dispose()
  })

  it('★ reports unknown rather than guessing before any s2s_* call is seen', async () => {
    // On the very first status call there is normally no stamp yet — this call
    // is itself the first s2s_* call, and the stamp is taken on the pipeline,
    // not by this handler. Reporting "incomplete" would hide a passed check;
    // reporting OK would invent one.
    const base = Date.UTC(2026, 9, 9, 0, 0, 0)
    delete ledgerDiagnostics.firstS2sToolCallAt
    ledgerDiagnostics.procStart = base
    ledgerDiagnostics.openCalledAt = base + 1000
    ledgerDiagnostics.openSucceededAt = base + 2000

    const { ctx, status } = makeStatus()
    const text = (await status.execute({}, { agent: { id: 's' } })).text
    const verdict = lineWith(text, 'handshake-coldstart:')

    expect(verdict).toContain('unknown')
    expect(verdict).not.toContain('COLD-START-OK')
    await ctx.fiber.dispose()
  })

  it('★ says incomplete when open never ran, instead of implying a passing order', async () => {
    const base = Date.UTC(2026, 9, 9, 0, 0, 0)
    delete ledgerDiagnostics.openCalledAt
    delete ledgerDiagnostics.openSucceededAt
    ledgerDiagnostics.procStart = base
    ledgerDiagnostics.firstS2sToolCallAt = base + 1000

    const { ctx, status } = makeStatus()
    const text = (await status.execute({}, { agent: { id: 's' } })).text
    const verdict = lineWith(text, 'handshake-coldstart:')

    expect(verdict).toContain('incomplete')
    expect(verdict).not.toContain('COLD-START-OK')
    await ctx.fiber.dispose()
  })

  it('★ the sampler never throws, whatever it is handed', () => {
    // It runs inside the tool pipeline: a diagnostic must not be able to break
    // a tool call.
    delete ledgerDiagnostics.firstS2sToolCallAt
    expect(() => recordFirstS2sToolCall(undefined as never)).not.toThrow()
    expect(() => recordFirstS2sToolCall('' as never)).not.toThrow()
  })
})
