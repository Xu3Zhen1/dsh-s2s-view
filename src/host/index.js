/**
 * s2s history host half — one read-only route over the session corpus.
 *
 * The browser half needs message bodies to render the group-chat feed. The
 * framework's own `session.page` RPC cannot serve that: it pages *backwards
 * from a cursor*, and the only way to learn a cursor is a `session.follow`
 * opening frame — whose delivery path also promotes the conversation, i.e.
 * resumes an Agent for a session the user is merely browsing. A passive
 * history panel must not wake conversations.
 *
 * `ctx.sessionQuery.readSession()` is the read documented as replay-validating
 * "one complete logical session log WITHOUT making it live", so this route is
 * built on it and returns records in the SAME shape `session.page` returns —
 * the client half then has one parser, not two.
 *
 * ## Why it registers under `/api` instead of a bare path
 *
 * A bare `ctx.webServer.register` route would answer anyone who can reach the
 * loopback port, bypassing the browser authentication `/api` enforces (that is
 * exactly what a hand-rolled Host/Origin check would be re-implementing, badly).
 * `ctx.connection.fetch.register` mounts an exact route INSIDE the `/api`
 * prefix, so the shared handler applies its trust fence and browser-session
 * authentication before this code runs — and the browser then reaches it with
 * the same-origin cookie it already uses for every other API call.
 *
 * Mounted as a plain module by the profile's `cordis.patch.yml`, so the
 * dsh-s2s package itself is untouched: its `lib/` is gitignored and rebuilt by
 * its own `pnpm run build`, and a hand-edit there would trip the upstream
 * `verify-bundle.mjs` freshness gate.
 *
 * @module s2s-history-host
 */

/** Cordis plugin name used by loader diagnostics. */
export const name = 's2s-history-host'

/** Services consumed: the authenticated API seat and the session corpus reader. */
export const inject = ['connection', 'sessionQuery']

/** Exact route below `/api`; the browser half asks for this same path. */
const ROUTE = '/api/s2s-history/messages'

/** Conversations one request may read; the panel pages through the rest. */
const MAX_SESSIONS_PER_REQUEST = 8

/** Messages returned per conversation (the tail — oldest first, newest last). */
const MESSAGES_PER_SESSION = 60

/** Cache lifetime for one conversation's extracted records. */
const CACHE_TTL_MS = 5_000

/** Bound on cached conversations; this is a paging convenience, not a store. */
const CACHE_MAX_ENTRIES = 64

/** Event types that carry conversation text. */
const MESSAGE_TYPES = new Set(['user/message', 'assistant/message'])

/** Session ids this route will read; anything else is dropped, not escaped. */
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/**
 * Reduce one complete log to message-bearing records.
 *
 * Only append-surface `user/message` and `assistant/message` events carry
 * conversation text: a replacement op rewrites an earlier surface entry rather
 * than adding a turn, and every other event type is machinery. Excerpts are cut
 * to the last `MESSAGES_PER_SESSION` messages, because the feed reads
 * conversations newest-first and a request should not pay for the deep past.
 * @param {readonly object[]} events - complete session event log.
 * @returns {object[]} records shaped like `SessionHistoryRecord`.
 */
function recordsOf(events) {
  const kept = []
  for (const event of events) {
    if (!MESSAGE_TYPES.has(event.type)) continue
    if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') continue
    kept.push(event)
  }
  const tail = kept.slice(Math.max(0, kept.length - MESSAGES_PER_SESSION))
  return tail.map(event => ({ type: 'event', event }))
}

/**
 * Install the route, bound to the plugin's own fiber.
 * @param {object} ctx - host context carrying `connection` and `sessionQuery`.
 */
export function apply(ctx) {
  /** @type {Map<string, { at: number, records: object[] }>} */
  const cache = new Map()

  const readCached = async (sessionId) => {
    const hit = cache.get(sessionId)
    const now = Date.now()
    if (hit !== undefined && now - hit.at < CACHE_TTL_MS) return hit.records
    // readSession replays and validates the whole log without attaching the
    // Session, so browsing history never makes a conversation live.
    const snapshot = await ctx.sessionQuery.readSession(sessionId)
    const records = recordsOf(snapshot.events)
    cache.set(sessionId, { at: now, records })
    if (cache.size > CACHE_MAX_ENTRIES) {
      let oldestKey
      let oldestAt = Infinity
      for (const [key, entry] of cache) {
        if (entry.at < oldestAt) { oldestAt = entry.at; oldestKey = key }
      }
      if (oldestKey !== undefined) cache.delete(oldestKey)
    }
    return records
  }

  const fetch = async (request) => {
    const url = new URL(request.url)
    const ids = String(url.searchParams.get('ids') || '')
      .split(',')
      .map(id => id.trim())
      .filter(id => SAFE_SESSION_ID.test(id))
      .slice(0, MAX_SESSIONS_PER_REQUEST)

    const sessions = []
    for (const sessionId of ids) {
      try {
        sessions.push({ sessionId, records: await readCached(sessionId), failed: false })
      } catch (error) {
        // One unreadable conversation (corrupt, or deleted between listing and
        // reading) must not fail the batch: the panel reports it per row and
        // renders the rest.
        sessions.push({
          sessionId,
          records: [],
          failed: true,
          why: String(error === null || error === undefined ? 'unreadable' : (error.message || error)),
        })
      }
    }

    return Response.json({ sessions }, { headers: { 'cache-control': 'no-store' } })
  }

  ctx.effect(
    () => ctx.connection.fetch.register({ path: ROUTE, methods: ['GET', 'HEAD'], fetch }),
    's2s-history-host: read-only route',
  )
}
