/**
 * s2s digest — session-history facts for the model, without message bodies.
 *
 * One call answers: which conversations exist, grouped under their session id,
 * when each was last touched, and whether its last turn is still open. A row
 * carries the LAST EVENT'S TYPE and the time it landed — never its text — so
 * the view stays cheap in context and safe to hand around.
 *
 * ## Where the facts come from, and why it is only ONE optional dependency
 *
 * `SessionCorpus.listSessions()` returns session HEADERS. A header carries the
 * id and the creation time but no last-activity time, so "where did it stop"
 * cannot be answered from the corpus alone:
 *
 * - `readTitleSnapshots()` gives titles, but folds them out of a full log read
 *   internally and exposes no events.
 * - `observeSession()` also builds a full replay-validated log per session, but
 *   it is synchronous and restores a Session object — a read-shaped call with a
 *   write-shaped cost — so a 19-session menu would block the event loop.
 * - `readSession()` returns the balanced log at I/O cost only, and its only
 *   deep tie to the session package is one static replay-validate call.
 *
 * This module therefore reads `sessionQuery.readSession()` and reduces each log
 * to a timeline of `{ seq, type, time }` — types and times, no payloads. The
 * single session-package call is PROBED once per process and the capability is
 * reported honestly: when it is unavailable the menu still lists every
 * conversation, with the timeline column marked unavailable instead of the
 * whole call failing.
 *
 * @module dsh-s2s/digest
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/** Cordis plugin name of the digest tool family. */
export const name = 's2s-digest'

/** Services the digest tool consumes; a missing one degrades, never throws. */
export const inject = ['tools']

/** Public tool name, also the key the harness prompt refers to. */
export const DIGEST_TOOL_NAME = 's2s_digest'

/** Conversations rendered by one call. */
const DEFAULT_LIMIT = 20

/** Hard cap on conversations rendered by one call. */
const MAX_LIMIT = 200

/** Per-session log deadline: one slow log must not hold up the whole digest. */
const READ_TIMEOUT_MS = 8_000

/** Session-package import specifier; the one cross-package tie this view has. */
const SESSION_PACKAGE = '@deepseek-ai/dsh-session'

/** Event types that frame a turn without being a move inside it. */
const STRUCTURAL_EVENT_TYPES = new Set([
  'turn/start',
  'step/start',
  'step/end',
  'assistant/chunk',
  'session/meta',
  'request/header',
])

/** One reduced timeline fact: type and time only, never the payload. */
interface TimelineFact {
  readonly seq: number
  readonly type: string
  readonly time: number | undefined
}

/** One session's digest row. */
interface DigestRow {
  readonly sessionId: string
  readonly title: string | undefined
  readonly createdAt: number | undefined
  readonly lastAt: number | undefined
  readonly lastType: string | undefined
  readonly lastSeq: number | undefined
  readonly openTurn: boolean
  readonly readError: string | undefined
}

/** Why the timeline capability is unavailable, when it is. */
interface TimelineCapability {
  readonly read: ((sessionId: string) => Promise<TimelineFact[]>) | undefined
  readonly reason: string | undefined
}

/** Cached probe result: the session module is resolved once per process. */
let capability: TimelineCapability | undefined

/** Structural view of the host's `sessionQuery` service. */
interface SessionQueryLike {
  listSessions(signal?: AbortSignal): Promise<unknown>
  readTitleSnapshots(sessionIds: readonly string[], signal?: AbortSignal): Promise<unknown>
}

/** Structural view of the parts of the session package this view replays. */
interface SessionModuleLike {
  /**
   * The `Session` **class**, not a module-level `create`.
   *
   * `@deepseek-ai/dsh-session` exports `Session` (with a *static* `create`), plus
   * `SessionStore` etc. — it has never exported a bare `create`. An earlier
   * revision probed `mod.create`, which is always `undefined`, so the timeline
   * column reported "Session.create is not exported by this host revision" on
   * every host including the 0.1.x ones it was written against. The capability
   * probe must look where the function actually lives.
   */
  Session?: {
    create?: (id: string, seed: readonly unknown[], header: unknown, inheritedEventCount: unknown) => unknown
  }
}

/** The shape `readSession` resolves to, as far as this view reads it. */
interface StoredLog {
  readonly session: { readonly id: string } | undefined
  readonly events: readonly unknown[]
  readonly inheritedEventCount: unknown
}

/** Text output contract shared with the other s2s model tools. */
const OUTPUT = {
  schema: { type: 'object' as const, additionalProperties: false as const, properties: { text: { type: 'string' as const, required: true as const } } },
  render(_args: object, value: { text: string }): ContentBlock[] {
    return [{ type: 'text', text: value.text }]
  },
}

/** Error message of an unknown thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Short display form of a session id: the uuid part, first 8 characters. */
function shortId(sessionId: string): string {
  return sessionId.replace(/^session-/, '').slice(0, 8)
}

/** Render an epoch-ms instant as the caller's local calendar time. */
function localTime(epochMs: number | undefined): string {
  if (epochMs === undefined || !Number.isFinite(epochMs)) return 'time unknown'
  const d = new Date(epochMs)
  if (Number.isNaN(d.getTime())) return 'time unknown'
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Epoch ms of a finished session's header time. */
function headerTime(snapshot: unknown): number | undefined {
  const t = (snapshot as { headerTime?: unknown })?.headerTime
  return typeof t === 'number' && Number.isFinite(t) ? t : undefined
}

/** Session id of one `irreversible.list` row. */
function listRowId(snapshot: unknown): string | undefined {
  const id = (snapshot as { header?: { id?: unknown } })?.header?.id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/**
 * Reduce a balanced event log to timeline facts.
 *
 * Payloads are dropped at the boundary: only `seq`, `type`, and `time` leave
 * this function, so no message text can reach the model through this view.
 * @param events - events in ascending seq order.
 * @returns the reduced timeline.
 */
function reduceTimeline(events: readonly unknown[]): TimelineFact[] {
  const facts: TimelineFact[] = []
  for (let i = 0; i < events.length; i++) {
    const event = events[i] as { seq?: unknown; type?: unknown; time?: unknown } | undefined
    const type = event?.type
    if (typeof type !== 'string') continue
    facts.push({
      seq: typeof event?.seq === 'number' ? event.seq : i,
      type,
      time: typeof event?.time === 'number' && Number.isFinite(event.time) ? event.time : undefined,
    })
  }
  return facts
}

/**
 * Resolve the timeline capability once per process.
 *
 * The probe replays an empty log under a session id that cannot be stored, so
 * the call must fail: HOW it fails decides whether the export exists. A missing
 * export yields no reader plus a reason, which the caller renders as an
 * unavailable column rather than a failed call.
 * @returns the cached capability.
 */
async function timelineCapability(): Promise<TimelineCapability> {
  if (capability !== undefined) return capability
  let mod: SessionModuleLike
  try {
    mod = (await import(SESSION_PACKAGE)) as SessionModuleLike
  } catch (error: unknown) {
    capability = { read: undefined, reason: `session package not importable: ${messageOf(error)}` }
    return capability
  }
  if (typeof mod.Session?.create !== 'function') {
    capability = { read: undefined, reason: 'Session.create is not exported by this host revision' }
    return capability
  }
  try {
    mod.Session.create('s2s-digest-probe', [], {}, 0)
  } catch (error: unknown) {
    if (error instanceof TypeError) {
      capability = { read: undefined, reason: 'Session.create is exported but not callable on this host' }
      return capability
    }
  }
  const create = mod.Session.create
  capability = {
    read: async (sessionId: string): Promise<TimelineFact[]> => {
      const log = await readStoredLog(sessionId)
      // Replay-validate before folding: a corrupt log must be reported as that
      // session's read error instead of silently producing a wrong timeline.
      create(sessionId, log.events, log.session, log.inheritedEventCount)
      return reduceTimeline(log.events)
    },
    reason: undefined,
  }
  return capability
}

/** Read one stored log through the host's session-query service. */
async function readStoredLog(sessionId: string): Promise<StoredLog> {
  const query = currentQuery
  if (query === undefined) throw new Error('sessionQuery is not mounted')
  const record = await withDeadline(query.readSession(sessionId), READ_TIMEOUT_MS)
  if (record === undefined || record === null) throw new Error('session-query returned no log')
  const events = (record as { events?: unknown }).events
  if (!Array.isArray(events)) throw new Error('session-query returned no event log')
  const session = (record as { session?: { id?: unknown } }).session
  return {
    session: session !== undefined && typeof session.id === 'string' ? { id: session.id } : undefined,
    events,
    inheritedEventCount: (record as { inheritedEventCount?: unknown }).inheritedEventCount ?? 0,
  }
}

/** Bound one awaited read so a single slow session cannot stall the digest. */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error(`timed out after ${ms}ms`)) }, ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** The `sessionQuery` service bound for the current call. */
let currentQuery: (SessionQueryLike & { readSession(sessionId: string): Promise<unknown> }) | undefined

/** Whether a type string is a move rather than turn framing. */
function isMove(type: string): boolean {
  return !STRUCTURAL_EVENT_TYPES.has(type)
}

/**
 * Fold one reduced timeline into the row's "where did it stop" facts.
 * @param facts - reduced timeline in ascending seq order.
 * @returns the tail facts, or undefined for an empty log.
 */
function summarizeTimeline(facts: readonly TimelineFact[]): {
  lastAt: number | undefined
  lastType: string | undefined
  lastSeq: number | undefined
  openTurn: boolean
} {
  if (facts.length === 0) {
    return { lastAt: undefined, lastType: undefined, lastSeq: undefined, openTurn: false }
  }
  const tail = facts[facts.length - 1] as TimelineFact
  let lastMove: TimelineFact | undefined
  for (let i = facts.length - 1; i >= 0; i--) {
    const fact = facts[i] as TimelineFact
    if (isMove(fact.type)) { lastMove = fact; break }
  }
  // A tail of pure turn framing means the log ends mid-turn: the turn opened
  // and never closed, which is exactly the "stopped here" signal this view is
  // for. The newest move before that framing is what it stopped on.
  const openTurn = STRUCTURAL_EVENT_TYPES.has(tail.type) && tail.type !== 'session/meta'
  const reported = openTurn ? (lastMove ?? tail) : tail
  return {
    lastAt: reported.time ?? tail.time ?? facts[0]?.time,
    lastType: reported.type,
    lastSeq: reported.seq,
    openTurn,
  }
}

/** Labels for the `who` column. */
const ACTOR_OF_TYPE: Readonly<Record<string, string>> = {
  'user/message': 'user',
  'assistant/message': 'assistant',
  'tool/call': 'assistant',
  'tool/result': 'tool',
  'todo/write': 'assistant',
  'turn/end': 'turn',
}

/** The actor implied by an event type, for the row's `who` column. */
function actorOf(type: string): string {
  return ACTOR_OF_TYPE[type] ?? 'system'
}

/** Session id used when the caller asked for its own session. */
const SELF = 'self'

/**
 * Resolve which session ids to render.
 * @param all - every known row for the host.
 * @param requested - the caller's `session_id` filter, when given.
 * @param callerId - the calling session's id, when the harness supplied one.
 * @returns the selected rows plus a note when a filter matched nothing.
 */
function selectRows(
  all: readonly DigestRow[],
  requested: string | undefined,
  callerId: string | undefined,
): { rows: DigestRow[]; note: string | undefined } {
  if (requested === undefined || requested.length === 0) return { rows: [...all], note: undefined }
  const wanted = requested === SELF && callerId !== undefined ? callerId : requested
  const exact = all.filter(row => row.sessionId === wanted)
  if (exact.length > 0) return { rows: exact, note: undefined }
  const partial = all.filter(row => row.sessionId.includes(wanted) || (row.title ?? '').includes(wanted))
  if (partial.length > 0) {
    return { rows: partial, note: `matched ${partial.length} session(s) by id/title substring "${requested}"` }
  }
  return { rows: [], note: `no known session matches "${requested}"` }
}

/** Render one row as a single menu line. */
function renderRow(row: DigestRow): string {
  const flags: string[] = []
  if (row.openTurn) flags.push('OPEN TURN')
  if (row.readError !== undefined) flags.push(`read failed: ${row.readError}`)
  const where = row.lastType === undefined
    ? (row.readError === undefined ? 'empty log' : 'timeline unavailable')
    : `${actorOf(row.lastType)} -> ${row.lastType}  #${row.lastSeq}`
  return `- ${row.title ?? '(untitled)'}  [${shortId(row.sessionId)}]  `
    + `last=${localTime(row.lastAt ?? row.createdAt)}  ${where}`
    + (flags.length === 0 ? '' : `  [${flags.join('; ')}]`)
}

/**
 * Build the digest text for one host.
 * @param ctx - plugin context, used to reach the host's services.
 * @param args - caller filters.
 * @returns the rendered digest, or an explanation when the source is absent.
 */
async function buildDigest(
  ctx: Context,
  args: { session_id?: string; limit?: number; running_only?: boolean },
  callerId: string | undefined,
): Promise<string> {
  const query = ctx.get('sessionQuery') as (SessionQueryLike & { readSession(sessionId: string): Promise<unknown> }) | undefined
  if (query === undefined) {
    return 's2s_digest needs the host session-query service, which is not mounted here. '
      + 'Mount the session-query + session-query-sqlite bundles in the profile, then retry.'
  }
  currentQuery = query

  const listed = await query.listSessions()
  const rows: DigestRow[] = Array.isArray(listed)
    ? listed.flatMap((entry): DigestRow[] => {
      const id = listRowId(entry)
      if (id === undefined) return []
      return [{
        sessionId: id,
        title: undefined,
        createdAt: headerTime(entry),
        lastAt: undefined,
        lastType: undefined,
        lastSeq: undefined,
        openTurn: false,
        readError: undefined,
      }]
    })
    : []

  const cap = await timelineCapability()
  const rowsWithTimeline: DigestRow[] = []
  for (const row of rows) {
    if (cap.read === undefined) {
      rowsWithTimeline.push({ ...row, readError: cap.reason })
      continue
    }
    try {
      const facts = await cap.read(row.sessionId)
      rowsWithTimeline.push({ ...row, ...summarizeTimeline(facts) })
    } catch (error: unknown) {
      rowsWithTimeline.push({ ...row, readError: messageOf(error) })
    }
  }

  const selected = selectRows(rowsWithTimeline, args.session_id, callerId)
  const filtered = args.running_only === true
    ? selected.rows.filter(row => row.openTurn || row.readError === undefined)
    : selected.rows
  const ordered = [...filtered].sort((a, b) => (b.lastAt ?? b.createdAt ?? 0) - (a.lastAt ?? a.createdAt ?? 0))

  const limit = args.limit === undefined || !Number.isFinite(args.limit)
    ? DEFAULT_LIMIT
    : Math.min(Math.max(Math.floor(args.limit), 1), MAX_LIMIT)
  const shown = ordered.slice(0, limit)

  const header = `${DIGEST_TOOL_NAME}: ${shown.length} of ${ordered.length} conversation(s)`
    + (rows.length !== ordered.length ? ` (from ${rows.length} known)` : '')
    + (args.running_only === true ? ', opened turns only' : '')
  const lines = [header, '']
  if (shown.length === 0) {
    lines.push(selected.note ?? 'nothing to show')
  } else {
    for (const row of shown) lines.push(renderRow(row))
  }
  if (ordered.length > shown.length) {
    lines.push(`... ${ordered.length - shown.length} more not shown; raise limit or filter with session_id.`)
  }
  if (selected.note !== undefined && shown.length > 0) lines.push(`(${selected.note})`)
  lines.push('')
  lines.push('rows carry the last event TYPE and time only — no message text. Use session_event_read for content.')
  return lines.join('\n')
}

/**
 * Build the digest tool definition.
 * @param ctx - plugin context, forwarded to the tool body so it can reach
 *   `sessionQuery` at call time (the tool outlives this function).
 */
export function buildDigestTools(ctx: Context): ToolDefinition[] {
  return [
    defineTool({
      name: DIGEST_TOOL_NAME,
      description: 'List known sessions with where each one stopped: title, short id, last-activity time, the last event type, and whether its turn is still open. Titles, ids, types and times only — never message content. Use it to find the session to resume, then session_event_read for the actual content.',
      parameters: {
        session_id: { type: 'string', description: 'Optional filter: an exact session id, an id/title substring, or "self" for the calling session.' },
        limit: { type: 'number', description: `Max rows (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT}).` },
        running_only: { type: 'boolean', description: 'Only rows whose last turn is still open (no closing turn/end).' },
      },
      output: OUTPUT,
      isConcurrencySafe: () => true,
      execute: async function(args, exec) {
        const callerId = (exec as { agent?: { id?: string } } | undefined)?.agent?.id
        return { text: await buildDigest(ctx, args, callerId) }
      },
    }),
  ]
}

/**
 * Register the digest tool on the plugin's context.
 * @param ctx - plugin context carrying the tool registry.
 */
export function apply(ctx: Context): void {
  const tools = ctx.get('tools') as { register(definition: ToolDefinition): () => void } | undefined
  if (tools === undefined) return
  const disposers = buildDigestTools(ctx).map(definition => tools.register(definition))
  ctx.effect(() => () => { for (const dispose of disposers) dispose() }, 's2s-digest.disposers')
}
