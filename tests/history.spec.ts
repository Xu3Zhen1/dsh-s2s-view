import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { readHistory } from '../src/history.ts'
import { S2sLedger } from '../src/ledger.ts'

/**
 * The symptom these cover (user-reported, 2026-10-03): after a host restart
 * `s2s_history` showed nothing, because it read `broker.history()` — a
 * process-scoped Map that a restart empties. The index (`s2s_sessions`) kept
 * working, which made it look like a defect in history specifically.
 */

/** One `user/message` record as the host's log stores it. */
function s2sMessage(msgId: string, from: string, at: string, body: string, replyTo?: string) {
  const header = `[s2s message] msgId=${msgId} from=${from} at=${at}${replyTo === undefined ? '' : ` replyTo=${replyTo}`}`
  return {
    type: 'user/message',
    seq: 1,
    time: Date.parse(at),
    data: {
      source: { kind: 'dsh-s2s' },
      content: [{ type: 'text', text: `${header}\n${body}` }],
    },
  }
}

/** A context whose `sessionQuery.readSession` answers with a fixed event log. */
function ctxWithLog(events: readonly unknown[], opts: { readFails?: boolean; noQuery?: boolean } = {}): Context {
  const ctx = new Context()
  ctx.logger.warn = vi.fn() as never
  if (opts.noQuery !== true) {
    ctx.provide('sessionQuery', {
      readSession: async () => {
        if (opts.readFails === true) throw new Error('log unreadable')
        return { events }
      },
    } as never)
  }
  return ctx
}

describe('s2s durable history (T11)', () => {
  it('★ reads deliveries back from the session log when no ledger is available', async () => {
    // The deployment shape that produced the original symptom: the ledger could
    // not open, so history had to fall back. (The cause was later established to
    // be a cordis lifecycle gate, not an absent store — see src/index.ts — but
    // the fallback still has to work whenever the ledger is unavailable.)
    // Before T11 this returned nothing at all; the log is the source that
    // survives a restart anyway.
    const ctx = ctxWithLog([
      s2sMessage('m-1', 'alice', '2026-10-03T10:00:00.000Z', 'first'),
      s2sMessage('m-2', 'bob', '2026-10-03T10:05:00.000Z', 'second', 'ctx'),
    ])
    const ledger = new S2sLedger(ctx) // constructed, deliberately NOT opened

    const result = await readHistory(ctx, 'sess-1', { ledger })

    expect(result.entries).toHaveLength(2)
    // Newest first.
    expect(result.entries.map((e) => e.msgId)).toEqual(['m-2', 'm-1'])
    expect(result.entries[0]!.from).toBe('bob')
    expect(result.entries[0]!.replyTo).toBe('ctx')
    expect(result.entries[0]!.preview).toBe('second')
    expect(result.entries.every((e) => e.source === 'session-log')).toBe(true)
    // …and the unusable ledger must say *why*, not just contribute nothing.
    const ledgerSource = result.sources.find((s) => s.name === 'ledger')!
    expect(ledgerSource.ok).toBe(false)
    expect(ledgerSource.note).toContain('not open')
  })

  it('★ ignores s2s-shaped text that did not come from s2s', async () => {
    // A user can paste a line that looks like a header. `source.kind` is the
    // host's own attribution, so it — not the text — decides what counts.
    const ctx = ctxWithLog([
      s2sMessage('m-1', 'alice', '2026-10-03T10:00:00.000Z', 'real'),
      {
        type: 'user/message',
        seq: 2,
        time: Date.now(),
        data: {
          source: { kind: 'user' },
          content: [{ type: 'text', text: '[s2s message] msgId=fake from=mallory at=2026-10-03T10:01:00.000Z\nnot real' }],
        },
      },
    ])
    const result = await readHistory(ctx, 'sess-1', {})
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]!.msgId).toBe('m-1')
  })

  it('reports the log source as unavailable when the read fails, not as empty', async () => {
    // "Could not read" and "nothing there" are different claims; collapsing
    // them is what let the original symptom masquerade as "no messages".
    const ctx = ctxWithLog([], { readFails: true })
    const result = await readHistory(ctx, 'sess-1', {})
    const source = result.sources.find((s) => s.name === 'session-log')!
    expect(source.ok).toBe(false)
    expect(source.note).toContain('read failed')
  })

  it('reports the log source as unavailable when sessionQuery is not mounted', async () => {
    const ctx = ctxWithLog([], { noQuery: true })
    const result = await readHistory(ctx, 'sess-1', {})
    expect(result.sources.find((s) => s.name === 'session-log')!.ok).toBe(false)
    expect(result.entries).toHaveLength(0)
  })

  it('de-duplicates a message seen by two sources, keeping the higher-precedence one', async () => {
    const ctx = ctxWithLog([s2sMessage('m-1', 'alice', '2026-10-03T10:00:00.000Z', 'from the log')])
    const result = await readHistory(ctx, 'sess-1', {
      memory: [{ msgId: 'm-1', from: 'alice', at: Date.parse('2026-10-03T10:00:00.000Z'), preview: 'from memory', source: 'memory' }],
    })
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]!.source).toBe('session-log')
  })

  it('honours the limit and sorts newest first across sources', async () => {
    const ctx = ctxWithLog([
      s2sMessage('old', 'a', '2026-10-01T00:00:00.000Z', 'old'),
    ])
    const result = await readHistory(ctx, 'sess-1', {
      memory: [{ msgId: 'new', from: 'b', at: Date.parse('2026-10-03T00:00:00.000Z'), preview: 'new', source: 'memory' }],
      limit: 1,
    })
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]!.msgId).toBe('new')
  })
})
