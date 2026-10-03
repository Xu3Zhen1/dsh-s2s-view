/**
 * Durable delivery history: what s2s actually sent, read back after a restart.
 *
 * **Why this module exists.** `s2s_history` used to read `broker.history()`,
 * which is a process-scoped `Map` capped at 200 entries. A host restart emptied
 * it, so a reader saw "no messages" with no way to tell that from "none were
 * ever sent" — and the *index* (`s2s_sessions`) kept working, because it reads
 * the session corpus rather than that Map. The asymmetry is what made the
 * symptom look like a bug in history specifically.
 *
 * **Why not simply read the ledger.** The planned fix was "history reads the
 * ledger", but the ledger is optional infrastructure: this deployment mounts no
 * `storageDomain` at all, so `open()` fails and a ledger-only read returns the
 * same empty list for a different reason. A fix that changes the explanation
 * without changing the symptom is not a fix.
 *
 * **The durable source.** Every delivery carries a `msgId` in its first line
 * (`[s2s message] msgId=…` / `[s2s-lifecycle message] msgId=…`), written into
 * the **target's session log**. That token exists precisely so a delivery can be
 * matched to its log entry after a restart, and the ledger's own `landed`
 * derivation already depends on it. Reading it back is therefore not a new
 * source of truth — it is the same one, addressed directly.
 *
 * Sources are merged and **labelled**: a reader is told which source answered,
 * because "the ledger says X" and "the log says X" carry different confidence
 * and different failure modes.
 *
 * @module dsh-s2s/history
 */
import type { Context } from '@deepseek-ai/cordis'
import type { S2sLedger } from './ledger.ts'

/** One delivered message, as reconstructed from whichever source answered. */
export interface HistoryEntry {
  /** The delivery's idempotency token, when the source recorded one. */
  readonly msgId: string | undefined
  readonly from: string
  readonly at: number
  readonly replyTo?: string
  /** First line of the body, trimmed for display. */
  readonly preview: string
  /** Which source produced this entry. Never inferred — always recorded. */
  readonly source: 'ledger' | 'session-log' | 'memory'
  /**
   * The log record's `seq`, when this came from a session log.
   *
   * Carried (not displayed) because the ledger's `landedSeq` contract *is* this
   * number: `reconcile` reads a log through this same parser and writes it back.
   */
  readonly seq?: number
}

/** The merged result, plus what the reader must know to trust it. */
export interface HistoryResult {
  readonly entries: readonly HistoryEntry[]
  /** Sources that were consulted and what each yielded. Order = precedence. */
  readonly sources: readonly { readonly name: HistoryEntry['source']; readonly ok: boolean; readonly note: string; readonly count: number }[]
}

/** Bound one read so a slow session cannot stall the tool. */
const READ_TIMEOUT_MS = 8_000

/** How many entries a session-log scan will return at most. */
const LOG_SCAN_LIMIT = 200

/**
 * One `user/message` record that carries an s2s header, reduced for display.
 *
 * The header format is shared with the browser half (`src/client/index.js`
 * parses it) and with the ledger's `landed` derivation, so it is matched by the
 * same shape those two use: `[s2s message]` / `[s2s-lifecycle message]` followed
 * by `key=value` pairs on the first line.
 */
const HEADER_RE = /^\[s2s(?:-lifecycle)? message\]\s+(.*)$/

/** Parse the `key=value` pairs of one s2s header line. */
function parseHeader(line: string): Record<string, string> | undefined {
  const m = HEADER_RE.exec(line.trim())
  if (m === null) return undefined
  const fields: Record<string, string> = {}
  for (const part of m[1]!.split(/\s+/)) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    fields[part.slice(0, eq)] = part.slice(eq + 1)
  }
  return fields
}

/** Epoch ms from an ISO instant, or `undefined` when unparseable. */
function timeOf(iso: string | undefined): number | undefined {
  if (iso === undefined) return undefined
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : undefined
}

/**
 * Read deliveries back out of one session's log.
 *
 * Why the log and not the ledger: the log is written by the host for every
 * delivered message regardless of whether any storage backend is mounted, so it
 * is the only source that survives a restart in a storage-less deployment.
 *
 * This is also the primitive `reconcile` uses to advance a row to `landed`: the
 * ledger's contract is "the `seq` of the target-log `user/message` that matched
 * this `msgId`", so the `seq` is returned rather than discarded. One parser, so
 * history and reconcile can never disagree about what a landed delivery is.
 *
 * @param ctx - context carrying `sessionQuery` (optional infrastructure).
 * @param sessionId - the session whose log to read (the **target**).
 * @param timeoutMs - bound on the read; a slow session must not stall a caller.
 * @returns entries found, or `undefined` when the read failed (so the caller can
 *   report "could not read" rather than "nothing there").
 */
export async function readSessionLog(
  ctx: Context,
  sessionId: string,
  timeoutMs = READ_TIMEOUT_MS,
): Promise<HistoryEntry[] | undefined> {
  const query = ctx.get('sessionQuery') as
    | { readSession(id: string): Promise<unknown> }
    | undefined
  if (query === undefined) return undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let record: unknown
  try {
    record = await Promise.race([
      query.readSession(sessionId),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error(`timed out after ${timeoutMs}ms`)) }, timeoutMs)
      }),
    ])
  } catch (error: unknown) {
    ctx.logger.warn(
      `s2s history: could not read the log of "${sessionId}" (${String(error)}); `
      + 'session-log history is unavailable for this session.',
    )
    return undefined
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  const events = (record as { events?: unknown } | undefined)?.events
  if (!Array.isArray(events)) return undefined

  const out: HistoryEntry[] = []
  for (const raw of events) {
    const event = raw as { type?: unknown; seq?: unknown; time?: unknown; data?: unknown }
    if (event.type !== 'user/message') continue
    const data = event.data as { content?: unknown; source?: { kind?: unknown } } | undefined
    // Only s2s's own deliveries: a user could paste a message that looks like a
    // header, and `source.kind` is the host's own attribution, not text.
    if (data?.source?.kind !== 'dsh-s2s') continue
    const content = data.content
    if (!Array.isArray(content)) continue
    const text = content.map((c) => (c as { text?: unknown })?.text ?? '').join('')
    const lines = text.split('\n')
    const fields = parseHeader(lines[0] ?? '')
    if (fields === undefined) continue
    const body = lines.slice(1).join(' ').trim()
    out.push({
      msgId: fields.msgId,
      from: fields.from ?? '(unknown)',
      at: timeOf(fields.at) ?? (typeof event.time === 'number' ? event.time : 0),
      ...(fields.replyTo === undefined || fields.replyTo === '-' ? {} : { replyTo: fields.replyTo }),
      preview: (body.length > 0 ? body : (lines[0] ?? '')).slice(0, 160),
      ...(typeof event.seq === 'number' ? { seq: event.seq } : {}),
      source: 'session-log',
    })
    if (out.length >= LOG_SCAN_LIMIT) break
  }
  return out
}

/**
 * Merge the durable sources for one session's delivery history.
 *
 * Precedence is ledger → session log → in-process memory, and each source
 * reports separately: a reader must be able to see *which* one answered, since
 * "the ledger tracked it" and "the target's log shows the header" are different
 * claims. Entries are de-duplicated by `msgId` (first source wins), then sorted
 * newest first.
 *
 * @param ctx - context carrying the optional services.
 * @param sessionId - the session to report on.
 * @param opts.ledger - the ledger service, when one is mounted.
 * @param opts.memory - process-scoped entries, used only as a last resort.
 * @param opts.limit - maximum entries to return (default 50).
 */
export async function readHistory(
  ctx: Context,
  sessionId: string,
  opts: { ledger?: S2sLedger | undefined; memory?: readonly HistoryEntry[] | undefined; limit?: number } = {},
): Promise<HistoryResult> {
  const limit = opts.limit ?? 50
  const sources: { name: HistoryEntry['source']; ok: boolean; note: string; count: number }[] = []
  const merged: HistoryEntry[] = []

  // 1. Ledger — authoritative for *s2s's own attempts*, when it is usable.
  const ledger = opts.ledger
  if (ledger === undefined) {
    sources.push({ name: 'ledger', ok: false, note: 'not mounted', count: 0 })
  } else if (!ledger.isOpen) {
    sources.push({ name: 'ledger', ok: false, note: 'mounted but not open (no storageDomain?)', count: 0 })
  } else {
    try {
      const rows = await ledger.query({ sessionId })
      for (const row of rows) {
        merged.push({
          msgId: row.msgId,
          from: row.from,
          at: row.createdAt,
          ...(row.replyTo === null || row.replyTo === undefined ? {} : { replyTo: row.replyTo }),
          preview: row.text.slice(0, 160),
          source: 'ledger',
        })
      }
      sources.push({ name: 'ledger', ok: true, note: 'open', count: rows.length })
    } catch (error: unknown) {
      sources.push({ name: 'ledger', ok: false, note: `query failed: ${String(error)}`, count: 0 })
    }
  }

  // 2. The target's session log — the source that survives a restart with no
  //    storage backend at all.
  const logged = await readSessionLog(ctx, sessionId)
  if (logged === undefined) {
    sources.push({ name: 'session-log', ok: false, note: 'no sessionQuery mounted, or the read failed', count: 0 })
  } else {
    sources.push({ name: 'session-log', ok: true, note: 'read', count: logged.length })
    merged.push(...logged)
  }

  // 3. In-process memory — last resort, and only what this process saw.
  const memory = opts.memory ?? []
  if (memory.length > 0) {
    sources.push({ name: 'memory', ok: true, note: 'process-scoped only', count: memory.length })
    merged.push(...memory)
  } else {
    sources.push({ name: 'memory', ok: false, note: 'empty (process-scoped: a restart clears it)', count: 0 })
  }

  // De-duplicate by msgId with source precedence preserved; entries without an
  // id cannot be de-duplicated, so they are all kept.
  const seen = new Set<string>()
  const deduped: HistoryEntry[] = []
  for (const entry of merged) {
    if (entry.msgId !== undefined) {
      if (seen.has(entry.msgId)) continue
      seen.add(entry.msgId)
    }
    deduped.push(entry)
  }
  deduped.sort((a, b) => b.at - a.at)

  return { entries: deduped.slice(0, limit), sources }
}
