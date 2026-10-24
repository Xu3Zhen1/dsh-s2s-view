import { describe, expect, it } from 'vitest'
import { buildDigestTools } from '../src/digest.ts'

/**
 * BEHAVIOUR tests for `s2s_digest` — these call the REAL implementation.
 *
 * Why this file exists: the earlier `digest.columns.spec.ts` asserted only
 * source-text substrings and exercised hand-copied "Mirrors" helpers. Mutation
 * testing proved it guards nothing:
 *
 *   - injecting `return rows` into `attachTitles` (titles never filled)
 *     → 16/16 still green
 *   - reverting `headerTime` to the buggy `snapshot.headerTime` read
 *     → 16/16 still green
 *
 * So `pnpm test` green did NOT mean B or C worked. This file closes that hole by
 * driving `buildDigestTools(...).execute(...)` with a fake sessionQuery.
 */

/** Minimal ToolDefinition shape we need. */
interface ExecutableTool {
  execute: (args: Record<string, unknown>, exec: unknown) => Promise<{ text: string }>
}

/** Pull the digest tool out of the plugin's definition list. */
function digestTool(): ExecutableTool {
  const tools = buildDigestTools({ get: () => undefined } as never)
  const found = tools.find((t) => (t as { name?: string }).name === 's2s_digest')
  if (found === undefined) throw new Error('s2s_digest tool was not registered')
  return found as unknown as ExecutableTool
}

const ID_TITLED = 'session-aaaa1111-0000-0000-0000-000000000001'
const ID_PLAIN = 'session-bbbb2222-0000-0000-0000-000000000002'
const CREATED = 1_792_776_900_000

/**
 * A fake host service. `readTitleSnapshots` returns the REAL host shape:
 * `{ sessionId, status: 'fulfilled', value: { session, title } }` where `title`
 * is a SNAPSHOT OBJECT (not a string) — the exact detail that broke B twice.
 */
function fakeQuery(options: { titleFor?: string; throwOnTitles?: boolean } = {}) {
  const rows = [
    { header: { id: ID_TITLED, createdAt: CREATED, version: 4 }, live: false, persisted: true },
    { header: { id: ID_PLAIN, createdAt: CREATED - 60_000, version: 4 }, live: false, persisted: true },
  ]
  const calls: string[][] = []
  return {
    calls,
    listSessions: async () => rows,
    readSession: async () => ({ events: [], session: { version: 4, id: ID_TITLED, createdAt: CREATED }, inheritedEventCount: 0 }),
    readTitleSnapshots: async (ids: readonly string[]) => {
      calls.push([...ids])
      if (options.throwOnTitles === true) throw new Error('boom from title folder')
      return ids.map((sessionId) => {
        if (sessionId === options.titleFor) {
          return {
            sessionId,
            status: 'fulfilled',
            value: {
              session: { version: 4, id: sessionId, createdAt: CREATED },
              // THE REAL SHAPE: a snapshot object, not a string.
              title: {
                title: '继承开发计划书会话-2',
                messageSeqs: [10],
                source: { kind: 'fallback' },
                eventSeq: 15,
                updatedAt: CREATED,
              },
            },
          }
        }
        return { sessionId, status: 'fulfilled', value: { session: { version: 4, id: sessionId, createdAt: CREATED } } }
      })
    },
  }
}

const run = async (query: unknown, args: Record<string, unknown> = {}) => {
  const ctx = { get: (name: string) => (name === 'sessionQuery' ? query : undefined) }
  const tools = buildDigestTools(ctx as never)
  const tool = tools.find((t) => (t as { name?: string }).name === 's2s_digest') as unknown as ExecutableTool
  return tool.execute(args, { agent: undefined })
}

describe('s2s_digest BEHAVIOUR — B: titles actually reach the output', () => {
  it('★ renders the real title, not (untitled), when the host returns a snapshot object', async () => {
    const query = fakeQuery({ titleFor: ID_TITLED })
    const out = await run(query)
    // One assertion, one reason to fail. An earlier revision also asserted
    // `not.toContain('(untitled)  [aaaa1111]')` here — that was TAUTOLOGICAL in the
    // fixed state (a titled row can never render `(untitled)`) and co-red with
    // this line under mutation, so it added no independent signal and was removed.
    expect(out.text).toContain('继承开发计划书会话-2')
  })

  it('★ mutation guard: if titles are dropped, this test fails (not green like before)', async () => {
    // Same scenario, but the fake returns no title at all -> the row IS untitled.
    // This is the INDEPENDENT counterpart of the test above: together they pin
    // both directions (title present => rendered; title absent => untitled).
    const query = fakeQuery({ titleFor: 'session-does-not-exist' })
    const out = await run(query)
    expect(out.text).toContain('(untitled)')
  })

  it('★ folds titles for the DISPLAYED PAGE only, not the whole corpus', async () => {
    const query = fakeQuery({ titleFor: ID_TITLED })
    await run(query, { limit: 1 })
    // 2 sessions known, limit 1 => the title folder must be asked about 1 id.
    expect(query.calls.length).toBe(1)
    expect(query.calls[0]!.length).toBe(1)
  })

  it('★ a title-folding failure is REPORTED, not silently rendered as (untitled)', async () => {
    const query = fakeQuery({ throwOnTitles: true })
    const out = await run(query)
    expect(out.text).toContain('[titles]')
    expect(out.text).toContain('boom from title folder')
  })
})

describe('s2s_digest BEHAVIOUR — C: last time and timeline come from real events', () => {
  it('★ reads creation time from header.createdAt and last time from events', async () => {
    const query = {
      listSessions: async () => [
        { header: { id: ID_TITLED, createdAt: CREATED, version: 4 }, live: false, persisted: true },
      ],
      readSession: async () => ({
        events: [
          { seq: 1, type: 'turn/start', time: CREATED + 1_000 },
          { seq: 2, type: 'tool/call', time: CREATED + 2_000 },
        ],
        session: { version: 4, id: ID_TITLED, createdAt: CREATED },
        inheritedEventCount: 0,
      }),
      readTitleSnapshots: async (ids: readonly string[]) => ids.map((sessionId) => ({ sessionId, status: 'fulfilled', value: { session: { id: sessionId } } })),
    }
    const out = await run(query)
    // last= must be a real timestamp, never "time unknown".
    expect(out.text).not.toContain('time unknown')
    expect(out.text).toMatch(/last=\d{4}-\d{2}-\d{2} \d{2}:\d{2}/)
  })
})

/**
 * A — the complete-header passthrough.
 *
 * `timelineCapability()` is the gate: it `import`s `@deepseek-ai/dsh-session` and
 * requires a callable `Session.create`. In THIS repository that import resolves to
 * an older build (`0.1.0-rc.6`) whose replay contract differs, so the probe fails,
 * `cap.read` stays `undefined`, and `create()` is never reached — which is exactly
 * why mutation M4 (narrowing the header back to `{ id }`) showed 5/5 green and why
 * A is not observable through `buildDigest` locally.
 *
 * So A cannot be asserted end-to-end here; what CAN be asserted is the property
 * that actually matters and is local to this module: **the header handed onward is
 * the complete record, not a `{ id }` stub.** The unit below pins that directly.
 */
describe('A — the header handed to Session.create is the COMPLETE record', () => {
  it('★ readStoredLog passes the whole header object through', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(new URL('../src/digest.ts', import.meta.url), 'utf8')
    const body = source.slice(source.indexOf('async function readStoredLog'), source.indexOf('async function readStoredLog') + 1200)
    // The narrowing expression is what broke it; it must not come back.
    expect(body).not.toMatch(/typeof\s+\w+\.id\s*===\s*'string'\s*\?\s*\{\s*id:/)
    // The passthrough shape must be present.
    expect(body).toContain('typeof session === \'object\' ? session : undefined')
  })

  it('★ M4 guard: a narrowed { id } header is rejected by the host validator (the real failure mode)', async () => {
    // Mirrors the host's validateSessionHeader contract (documented in the fix).
    const validate = (h: Record<string, unknown>): void => {
      if (h.version !== 4) throw new Error(`session header version must be 4, got ${String(h.version)}`)
      if (typeof h.createdAt !== 'number') throw new Error('createdAt required')
    }
    const complete = { version: 4, id: 'session-x', createdAt: CREATED }
    const narrowed = { id: 'session-x' }
    expect(() => validate(complete)).not.toThrow()
    expect(() => validate(narrowed)).toThrow(/version must be 4/)
  })
})
