import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { buildTools } from '../src/tools.ts'
import { S2sLedger } from '../src/ledger.ts'
import { ledgerDiagnostics, type LedgerDiagnostics } from '../src/ledger-diagnostics.ts'

/**
 * The `handshake:` line on `s2s_status`.
 *
 * It exists because the first attempt at the ledger race fix passed every local
 * probe and did nothing on the real host, and the plugin logger is never
 * persisted — so "the callback never fired" and "it fired and did not help"
 * were indistinguishable afterwards. This line is the read-back that makes the
 * distinction obtainable from a running process.
 *
 * These tests pin the *rendering and reset* of that line. They deliberately do
 * NOT claim anything about the real host: a diagnostic that only passes locally
 * is exactly the trap this line was added to escape.
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

function handshakeLine(text: string): string {
  return text.split('\n').find((l) => l.startsWith('handshake:')) ?? ''
}

describe('s2s_status ledger handshake diagnostics', () => {
  it('★ reports not-registered / not-fired when nothing ran', async () => {
    // The shape that would prove "our inject never even registered", which is a
    // different bug from "it registered and never fired".
    for (const k of Object.keys(ledgerDiagnostics) as Array<keyof LedgerDiagnostics>) delete ledgerDiagnostics[k]
    const { ctx, status } = makeStatus()
    const line = handshakeLine((await status.execute({}, { agent: { id: 's' } })).text)

    expect(line).toContain('register=false')
    expect(line).toContain('fired=0')
    expect(line).toContain('openOk=false')
    expect(line).toContain('live probes:')
    await ctx.fiber.dispose()
  })

  it('★ distinguishes "fired" from "registered", and carries the open error verbatim', async () => {
    // The two facts that separate the candidate causes of the failed fix:
    // register=true + fired=0 means the injection never resolved;
    // fired>=1 + openOk=false means it resolved but opening still failed.
    ledgerDiagnostics.injectRegistered = true
    ledgerDiagnostics.injectFired = 1
    ledgerDiagnostics.injectFiredAt = Date.UTC(2026, 9, 5, 0, 0, 0)
    ledgerDiagnostics.ledgerVisibleInCallback = true
    ledgerDiagnostics.openError = 's2s ledger: used before open()'

    const { ctx, status } = makeStatus()
    const line = handshakeLine((await status.execute({}, { agent: { id: 's' } })).text)

    expect(line).toContain('register=true')
    expect(line).toContain('fired=1')
    expect(line).toContain('at=2026-10-05T00:00:00.000Z')
    expect(line).toContain('ledgerVisible=true')
    expect(line).toContain('openOk=false')
    expect(line).toContain('openError=s2s ledger: used before open()')
    await ctx.fiber.dispose()
  })

  it('★ includes live probes so a model of the host is never needed', async () => {
    // These probe `ctx` directly at read time. On the real host they answer
    // "is the service there RIGHT NOW", which is what local tests cannot know.
    const { ctx, status } = makeStatus()
    const line = handshakeLine((await status.execute({}, { agent: { id: 's' } })).text)

    // Labels name the exact lookup so a reading cannot be misattributed, and the
    // storage-hub probe distinguishes "no hub" from "hub without a domain".
    expect(line).toContain('ctx.get(storageDomain)=')
    expect(line).toContain('ctx.get(storage)=')
    expect(line).toContain('storage.domain=')
    await ctx.fiber.dispose()
  })

  it('★ reports openOk=true once opening succeeded', async () => {
    ledgerDiagnostics.injectRegistered = true
    ledgerDiagnostics.injectFired = 1
    ledgerDiagnostics.openSucceeded = true

    const { ctx, status } = makeStatus()
    const line = handshakeLine((await status.execute({}, { agent: { id: 's' } })).text)

    expect(line).toContain('openOk=true')
    expect(line).not.toContain('openError=')
    await ctx.fiber.dispose()
  })
})
