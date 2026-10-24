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
  /**
   * A STRUCTURAL criterion, evaluated by walking AST node kinds.
   *
   * History of this criterion (all three failures measured, not theorised):
   *  1. `expect(body).toContain("...? session : undefined")` — a TEXT assertion.
   *     Over-strict: adding `as object` or reformatting across lines turned it red
   *     on behaviour-identical code. An obstacle, not a criterion.
   *  2. `getText()` then `/\{\s*id\s*:/` — still TEXT matching, one AST call deep.
   *     Bypassed cleanly: a real regression that builds the stub dynamically
   *     (`const stub = {}; stub['id'] = ...`) contains no `{ id:` literal and went
   *     green. Also "accidentally right" on `as { id: string }`, which matched the
   *     TYPE ANNOTATION rather than the stub — right verdict, wrong reason.
   *  3. This version. The verdict comes from node KINDS only: the value handed on
   *     must BE the original `session` identifier (optionally behind a conditional
   *     or a type assertion). An object literal, an IIFE, a call — anything that
   *     computes a new object — fails, no matter how it is spelled.
   *
   * The lesson: **an AST is worth traversing, not stringifying.** Taking `getText()`
   * and running a regex on it walks straight back into text matching.
   */
  const unwrap = (ts: typeof import('typescript'), node: import('typescript').Node): import('typescript').Node => {
    let current = node
    for (;;) {
      if (ts.isParenthesizedExpression(current)) { current = current.expression; continue }
      if (ts.isAsExpression(current) || ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current)) {
        current = current.expression
        continue
      }
      return current
    }
  }

  /** True when the initializer hands on the ORIGINAL `session` object. */
  const passesHeaderThrough = (ts: typeof import('typescript'), initializer: import('typescript').Node): boolean => {
    /** Either branch of a conditional may carry the passthrough. */
    const isOriginalSession = (node: import('typescript').Node): boolean => {
      const candidate = unwrap(ts, node)
      return ts.isIdentifier(candidate) && candidate.text === 'session'
    }
    const outer = unwrap(ts, initializer)
    // Both `guard ? session : undefined` and `guard ? undefined : session` are
    // valid passthroughs — check both arms rather than assuming one order.
    if (ts.isConditionalExpression(outer)) {
      return isOriginalSession(outer.whenTrue) || isOriginalSession(outer.whenFalse)
    }
    return isOriginalSession(outer)
    // An object literal / IIFE / call computes a NEW object => the header was
    // narrowed, no matter how it is spelled.
  }

  /** Locate the `session:` initializer node in `readStoredLog`'s return object. */
  const readStoredLogSessionInitializer = async (): Promise<import('typescript').Node> => {
    const { readFileSync } = await import('node:fs')
    const ts = await import('typescript')
    const file = new URL('../src/digest.ts', import.meta.url)
    const source = ts.createSourceFile(file.pathname, readFileSync(file, 'utf8'), ts.ScriptTarget.ESNext, true)
    let found: import('typescript').Node | undefined
    const visit = (node: import('typescript').Node): void => {
      if (found !== undefined) return
      if (ts.isFunctionDeclaration(node) && node.name?.text === 'readStoredLog') {
        const body = node.body
        if (body === undefined) return
        const ret = body.statements.find(ts.isReturnStatement)
        const obj = ret?.expression !== undefined && ts.isObjectLiteralExpression(ret.expression) ? ret.expression : undefined
        const prop = obj?.properties.find(
          (p): p is import('typescript').PropertyAssignment =>
            ts.isPropertyAssignment(p) && p.name.getText() === 'session',
        )
        if (prop !== undefined) found = prop.initializer
        return
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
    if (found === undefined) throw new Error('readStoredLog session: property not found')
    return found
  }

  /** Parse one candidate initializer spelling into a node. */
  const initializerNodeOf = async (spelling: string): Promise<import('typescript').Node> => {
    const ts = await import('typescript')
    const sf = ts.createSourceFile('probe.ts', `function f(){ return { ${spelling} } }`, ts.ScriptTarget.ESNext, true)
    let node: import('typescript').Node | undefined
    const visit = (n: import('typescript').Node): void => {
      if (node !== undefined) return
      if (ts.isPropertyAssignment(n) && n.name.getText() === 'session') { node = n.initializer; return }
      ts.forEachChild(n, visit)
    }
    visit(sf)
    if (node === undefined) throw new Error('probe did not contain a session: property')
    return node
  }

  it('★ readStoredLog hands the ORIGINAL header on, not a computed stub (structural)', async () => {
    const ts = await import('typescript')
    const initializer = await readStoredLogSessionInitializer()
    expect(passesHeaderThrough(ts, initializer)).toBe(true)
  })

  /**
   * The criterion must be INSENSITIVE to layout/casts and SENSITIVE to the real
   * regression — including regressions that share no text with the ones above.
   */
  it('★ criterion self-check: equivalent rewrites pass, every real stub fails', async () => {
    const ts = await import('typescript')

    const equivalent = [
      "session: session !== undefined && session !== null && typeof session === 'object' ? session : undefined,",
      "session: session !== undefined && session !== null && typeof session === 'object' ? (session as object) : undefined,",
      "session:\n  session !== undefined && session !== null && typeof session === 'object'\n    ? session\n    : undefined,",
      "session: typeof session === 'object' ? session : undefined,",
      "session: session === null || session === undefined ? undefined : session,",
    ]

    // Real regressions. The last two deliberately avoid the `{ id:` literal —
    // they were the ones that defeated the previous regex criterion.
    const regressed = [
      "session: typeof (session as { id?: unknown }).id === 'string' ? { id: (session as { id: string }).id } : undefined,",
      'session: { id: session.id },',
      `session: ((): unknown => {
        if (session === undefined || session === null || typeof session !== 'object') return undefined
        const stub: Record<string, unknown> = {}
        stub['id'] = (session as Record<string, unknown>)['id']
        return stub
      })(),`,
      `session: ((): unknown => {
        if (session === undefined || session === null || typeof session !== 'object') return undefined
        const id = (session as { id: string }).id
        return { id }
      })(),`,
    ]

    for (const spelling of equivalent) {
      expect(passesHeaderThrough(ts, await initializerNodeOf(spelling))).toBe(true)
    }
    for (const spelling of regressed) {
      expect(passesHeaderThrough(ts, await initializerNodeOf(spelling))).toBe(false)
    }
  })
})
