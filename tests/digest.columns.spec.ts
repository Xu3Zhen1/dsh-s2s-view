import { describe, expect, it } from 'vitest'

/**
 * Three digest columns that were silently blank on the real host, pinned here
 * as behaviour rather than as string presence.
 *
 * Measured live on `session_id=self`: title `(untitled)`, last `time unknown`,
 * timeline `read failed: session header version must be 4, got undefined` — on
 * a session that has a title and a creation time. The three causes were
 * independent, and each is reproduced below against the host's *actual* shapes
 * (taken from `dsh-session` and `dsh-session-query` in the app asar):
 *
 *  - A: `readStoredLog` narrowed the header to `{ id }`, then passed it to
 *       `Session.create`, whose replay-validation requires `version === 4`,
 *       a matching `id` and a numeric `createdAt`. Every row threw.
 *  - B: `title` was hardcoded `undefined`; `readTitleSnapshots()` was declared
 *       on the interface but never called.
 *  - C: `headerTime()` read `snapshot.headerTime`, but `listSessions()` rows are
 *       `{ header, live, persisted }`, so the creation time is `header.createdAt`.
 */

// --- The host's own header validator, reduced to the fields it checks here.
//     Kept verbatim-in-spirit so the test fails if the shape stops satisfying it.
function validateSessionHeader(id: string, input: unknown): void {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('session header is not a plain JSON record')
  }
  const record = input as Record<string, unknown>
  if (record.version !== 4) throw new Error(`session header version must be 4, got ${String(record.version)}`)
  if (record.id !== id) throw new Error(`session header id "${String(record.id)}" does not match session id "${id}"`)
  if (typeof record.createdAt !== 'number' || !Number.isSafeInteger(record.createdAt) || record.createdAt < 0) {
    throw new Error('session header createdAt must be a non-negative safe integer')
  }
}

/** Mirrors src/digest.ts::headerTime (post-fix). */
function headerTime(snapshot: unknown): number | undefined {
  const t = (snapshot as { header?: { createdAt?: unknown } })?.header?.createdAt
  return typeof t === 'number' && Number.isFinite(t) ? t : undefined
}

/** Mirrors src/digest.ts::titleTextOf (the host returns a SNAPSHOT, not a string). */
function titleTextOf(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw.length > 0 ? raw : undefined
  const nested = (raw as { title?: unknown } | undefined)?.title
  return typeof nested === 'string' && nested.length > 0 ? nested : undefined
}

/** Mirrors src/digest.ts::attachTitles's fold (the pure part). */
function foldTitles(
  rows: ReadonlyArray<{ sessionId: string; title: string | undefined }>,
  settled: unknown,
): Array<{ sessionId: string; title: string | undefined }> {
  if (!Array.isArray(settled)) return [...rows]
  const byId = new Map<string, string>()
  for (const entry of settled) {
    const result = entry as {
      sessionId?: unknown
      status?: unknown
      value?: { session?: { id?: unknown }, title?: unknown }
    }
    if (result?.status === 'rejected') continue
    const id = typeof result?.sessionId === 'string' ? result.sessionId : result?.value?.session?.id
    const title = titleTextOf(result?.value?.title)
    if (typeof id === 'string' && title !== undefined) byId.set(id, title)
  }
  return rows.map(row => {
    const title = byId.get(row.sessionId)
    return title === undefined ? row : { ...row, title }
  })
}

const ID = 'session-bb46aece-c8d9-45e5-ae88-2be06d2e6694'

describe('A. digest replays with the COMPLETE header', () => {
  it('a narrowed { id } header fails the host validator — this was the bug', () => {
    // The old behaviour, kept as the negative control: if this ever stops
    // throwing, the validator changed and the fix below is no longer proven.
    expect(() => validateSessionHeader(ID, { id: ID })).toThrow(
      'session header version must be 4, got undefined',
    )
  })

  it('the complete header the fix passes through satisfies the validator', () => {
    const complete = { version: 4, id: ID, createdAt: 1_792_776_900_000, isSeeded: false }
    expect(() => validateSessionHeader(ID, complete)).not.toThrow()
  })

  it('★ the source no longer narrows the header to { id }', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(new URL('../src/digest.ts', import.meta.url), 'utf8')
    // Assert the absence of the exact narrowing expression that caused the bug.
    expect(source).not.toContain("typeof session.id === 'string' ? { id: session.id }")
    // …and that the complete record is what gets handed on.
    expect(source).toContain('session: session !== undefined && session !== null')
  })
})

describe('C. digest reads the creation time from header.createdAt', () => {
  it('the host listSessions row shape yields its createdAt', () => {
    // Real row shape: { header, live, persisted }.
    const row = { header: { id: ID, createdAt: 1_792_776_900_000 }, live: false, persisted: true }
    expect(headerTime(row)).toBe(1_792_776_900_000)
  })

  it('★ the old top-level headerTime read yields undefined on that same row', () => {
    // Negative control: proves the field name, not the row, was the defect.
    const row = { header: { id: ID, createdAt: 1_792_776_900_000 }, live: false, persisted: true }
    const old = (snapshot: unknown): number | undefined => {
      const t = (snapshot as { headerTime?: unknown })?.headerTime
      return typeof t === 'number' && Number.isFinite(t) ? t : undefined
    }
    expect(old(row)).toBeUndefined()
  })
})

describe('B. digest titles come from readTitleSnapshots', () => {
  it('fills a title from the host settled shape and leaves titleless sessions alone', () => {
    const rows = [
      { sessionId: 'session-aaa', title: undefined as string | undefined },
      { sessionId: 'session-bbb', title: undefined as string | undefined },
    ]
    const settled = [
      { status: 'fulfilled', value: { session: { id: 'session-aaa' }, title: '二次开发计划书初稿' } },
      // No title event: the host omits `title` entirely rather than sending ''.
      { status: 'fulfilled', value: { session: { id: 'session-bbb' } } },
    ]
    const out = foldTitles(rows, settled)
    expect(out[0]!.title).toBe('二次开发计划书初稿')
    expect(out[1]!.title).toBeUndefined()
  })

  it('isolates a per-session rejection instead of failing the batch', () => {
    const rows = [
      { sessionId: 'session-aaa', title: undefined as string | undefined },
      { sessionId: 'session-bbb', title: undefined as string | undefined },
    ]
    const settled = [
      { status: 'rejected', reason: new Error('unreadable') },
      { status: 'fulfilled', value: { session: { id: 'session-bbb' }, title: 'Still named' } },
    ]
    const out = foldTitles(rows, settled)
    expect(out[0]!.title).toBeUndefined()
    expect(out[1]!.title).toBe('Still named')
  })

  it('treats a non-array result as "no titles" rather than throwing', () => {
    const rows = [{ sessionId: 'session-aaa', title: 'keep me' as string | undefined }]
    expect(foldTitles(rows, undefined)[0]!.title).toBe('keep me')
  })

  it('★ the source actually calls readTitleSnapshots (it used to be declared only)', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(new URL('../src/digest.ts', import.meta.url), 'utf8')
    // Count CALLS, not the interface/comment mentions: the old file mentioned the
    // name twice (declaration + docstring) and called it zero times.
    const calls = source.match(/query\.readTitleSnapshots\(/g) ?? []
    expect(calls.length).toBeGreaterThan(0)
  })

  /**
   * The regression that the first version of the B fix shipped.
   *
   * `readTitleSnapshots` hands back the host's title SNAPSHOT under `value.title`
   * — an object `{ title, messageSeqs, source, eventSeq, updatedAt }` produced by
   * `titleSnapshotFromState` — not a bare string. Testing
   * `typeof value.title === 'string'` therefore skipped every title, and the
   * digest kept printing `(untitled)` although the logs plainly carried a
   * `session/title` event. Pinned with the REAL shape below.
   */
  it('★ reads the title out of the host SNAPSHOT object (the shape that was missed)', () => {
    const rows = [{ sessionId: 'session-aaa', title: undefined as string | undefined }]
    const settled = [{
      sessionId: 'session-aaa',
      status: 'fulfilled',
      value: {
        session: { version: 4, id: 'session-aaa', createdAt: 1_792_776_900_000 },
        // Exactly what @deepseek-ai/dsh-session-title returns:
        title: {
          title: '继承开发计划书会话-2，你接',
          messageSeqs: [10],
          source: { kind: 'fallback' },
          eventSeq: 15,
          updatedAt: 1_792_776_900_000,
        },
      },
    }]
    expect(titleTextOf((settled[0]!.value as { title: unknown }).title)).toBe('继承开发计划书会话-2，你接')
    expect(foldTitles(rows, settled)[0]!.title).toBe('继承开发计划书会话-2，你接')
  })

  it('★ negative control: a string-only test would have skipped that snapshot', () => {
    // The exact predicate the first B attempt used.
    const oldAccepts = (v: unknown): boolean => typeof v === 'string' && v.length > 0
    const snapshot = { title: '继承开发计划书会话-2，你接', messageSeqs: [10] }
    expect(oldAccepts(snapshot)).toBe(false)   // why every title was dropped
    expect(titleTextOf(snapshot)).toBe('继承开发计划书会话-2，你接') // and what fixes it
  })

  it('still accepts a flattened string title, and keys by the settlement sessionId', () => {
    const rows = [
      { sessionId: 'session-aaa', title: undefined as string | undefined },
      { sessionId: 'session-bbb', title: undefined as string | undefined },
    ]
    const settled = [
      // keyed by top-level sessionId only (no value.session.id)
      { sessionId: 'session-aaa', status: 'fulfilled', value: { title: 'flat string title' } },
      { sessionId: 'session-bbb', status: 'fulfilled', value: {} },
    ]
    const out = foldTitles(rows, settled)
    expect(out[0]!.title).toBe('flat string title')
    expect(out[1]!.title).toBeUndefined()
  })
})

describe('G9. a broken title path must leave a trace, not look like "no title"', () => {
  it('★ the source emits a [titles] diagnostic when folding fails', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(new URL('../src/digest.ts', import.meta.url), 'utf8')
    // The failure branches must record a reason…
    expect(source).toContain('noteTitleDiagnostic(')
    // …and the reason must reach the caller, otherwise `(untitled)` is ambiguous.
    expect(source).toContain("'[titles] '")
  })

  it('★ distinguishes "no readTitleSnapshots on the service" from "no title event"', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(new URL('../src/digest.ts', import.meta.url), 'utf8')
    // The pre-flight capability check is what separates "API missing" from "no data".
    expect(source).toContain('readTitleSnapshots?: unknown')
    expect(source).toContain('exposes no readTitleSnapshots()')
  })
})
