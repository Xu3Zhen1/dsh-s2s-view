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

/**
 * Exact route the browser half opens to be TOLD when to re-read.
 *
 * ## Why this cannot subscribe to `domain/changed` on the browser side
 *
 * `domain/changed` is an in-process Host event (`dsh-storage-domain`'s writes
 * emit it on the Host context). The browser can only observe Host events listed
 * in `API_REMOTE_FORWARDED_EVENTS` (`dsh-api-remotes/src/remote-events.ts`), and
 * that array does not contain it — forwarding one more event is a change to the
 * DSH packages themselves, not to this repo. So the subscription has to happen
 * HERE, in the same process as the ledger, and the browser learns about it over
 * an ordinary HTTP stream.
 *
 * ## Why two signals and not one
 *
 * The ledger only records s2s deliveries. The panel's message tab renders
 * ordinary conversation, which appends to a session log WITHOUT touching the
 * ledger — so a ledger-only signal would leave the panel stale exactly when the
 * user is typing. Both signals are therefore wired:
 *
 *   `domain/changed`  (domain `s2s`) — a delivery changed state
 *   `session/event`   (message types, append surface only) — a conversation grew
 *
 * ★ This is a deliberate WIDENING of plan §14 T20 ("panel driven by
 * `domain/changed`"), recorded as such rather than passed off as the literal
 * spec: the literal reading would make the panel miss ordinary turns.
 */
const EVENTS_ROUTE = '/api/s2s-history/events'

/** Exported so a test can pin the literal the browser half hard-codes. */
export { EVENTS_ROUTE }

/** The ledger's domain name; a change to any other domain is not ours. */
const LEDGER_DOMAIN = 's2s'

/**
 * Idle comment interval, in ms.
 *
 * A stream with no traffic is indistinguishable from a dropped carrier, and a
 * half-open socket would leave the panel frozen with no error. `25s` sits under
 * the common 30s idle-proxy timeout and costs one comment per period.
 */
const KEEPALIVE_MS = 25_000

/**
 * How many concurrent streams this Host will hold.
 *
 * One per open panel is the design; the cap exists so a reload loop (or several
 * browser windows) cannot grow an unbounded set of timers and closures.
 */
const MAX_STREAMS = 8

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

/**
 * Whether one session event is something the feed would render.
 *
 * Deliberately the SAME predicate {@link recordsOf} applies, so "the panel was
 * told to re-read" and "the re-read has something new" cannot drift apart: a
 * replacement op rewrites an earlier surface entry instead of adding a turn, and
 * machinery events carry no conversation text.
 * @param {object} event - one appended session event.
 * @returns {boolean} true when the feed would show it.
 */
function isFeedWorthy(event) {
  if (!MESSAGE_TYPES.has(event.type)) return false
  return event.surfaceOp === undefined || event.surfaceOp === 'append'
}

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

  /**
   * Live change streams, one per open panel.
   *
   * Each entry owns a controller whose `close()` tears down the stream; the Set
   * exists so plugin unload can close every one of them (a fibre disposed while
   * a browser is still holding a socket would otherwise leave the stream open
   * forever — the browser sees a connection that never delivers).
   * @type {Set<{ close: () => void, signal: (reason: string) => void }>}
   */
  const streams = new Set()

  /** Counters behind the "no silent degradation" rule (G9). */
  const streamStats = { opened: 0, closed: 0, refused: 0, ledgerSignals: 0, sessionSignals: 0 }

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

  /** Encoder for the change stream; one instance, these frames are tiny. */
  const encoder = new TextEncoder()

  /**
   * Open one change stream for a browser panel.
   *
   * The opening frame is NOT decoration. It states, unconditionally, that the
   * route is mounted and both Host subscriptions are attached — which is the
   * only way a reader can tell "nothing changed yet" from "this build has no
   * subscriber at all". Those two states are otherwise identical (no traffic),
   * and that ambiguity is exactly what G9 forbids leaving silent.
   * @param {Request} request - the browser's stream request.
   * @returns {Promise<Response>} an open event stream.
   */
  const openStream = async (request) => {
    if (streams.size >= MAX_STREAMS) {
      streamStats.refused += 1
      return new Response(
        `s2s-history: ${String(MAX_STREAMS)} change streams are already open `
        + `(opened=${String(streamStats.opened)} closed=${String(streamStats.closed)} `
        + `refused=${String(streamStats.refused)})`,
        { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } },
      )
    }

    let heartbeat
    let entry
    const body = new ReadableStream({
      start(controller) {
        let open = true
        const write = (frame) => {
          if (!open) return
          try {
            controller.enqueue(encoder.encode(frame))
          } catch {
            // The reader went away between the abort signal and this write.
            open = false
          }
        }
        const finish = () => {
          if (!open) return
          open = false
          if (heartbeat !== undefined) clearInterval(heartbeat)
          streams.delete(entry)
          streamStats.closed += 1
          try {
            controller.close()
          } catch {
            // Already closed by the carrier.
          }
        }

        entry = {
          close: finish,
          signal: (reason, sessionId) => {
            if (reason === 'ledger') streamStats.ledgerSignals += 1
            if (reason === 'session') streamStats.sessionSignals += 1
            // The session id rides along so the panel can tell "one of the
            // conversations I am showing grew" from "something unrelated moved"
            // without a round trip. `reason` stays because the two signals mean
            // different things: a ledger write changed a delivery's state, an
            // append added conversation text.
            const data = sessionId === undefined ? { reason } : { reason, sessionId }
            write(`event: change\ndata: ${JSON.stringify(data)}\n\n`)
          },
        }
        streams.add(entry)
        streamStats.opened += 1

        write('retry: 3000\n')
        write(`event: ready\ndata: ${JSON.stringify({
          wired: { 'domain/changed': LEDGER_DOMAIN, 'session/event': 'message+append' },
          streams: { open: streams.size, max: MAX_STREAMS },
          counts: { ...streamStats },
        })}\n\n`)

        // An idle stream and a dead carrier look the same from the browser, so
        // the stream says something on a schedule.
        heartbeat = setInterval(() => { write(': keepalive\n\n') }, KEEPALIVE_MS)
        if (typeof heartbeat === 'object' && heartbeat !== null && 'unref' in heartbeat) {
          heartbeat.unref()
        }

        // The carrier aborts the request when the socket closes; that is the one
        // signal that fires for a browser tab the user simply closed.
        if (request.signal !== undefined) {
          request.signal.addEventListener('abort', finish, { once: true })
        }
      },
      cancel() {
        // Reader cancelled (navigating away without an abort): same teardown.
        if (entry !== undefined) entry.close()
      },
    })

    return new Response(body, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        // `no-store` keeps a proxy from buffering the whole stream, and the
        // explicit `no-transform`/keep-alive pair says the same thing to caches.
        'cache-control': 'no-store, no-transform',
        'x-accel-buffering': 'no',
      },
    })
  }

  // `requestBody: 'buffered'` is REQUIRED, not decorative. The Connection
  // shared handler resolves `requestBodyMode` as `route.requestBody` for a
  // matched exact route and only falls back to `'buffered'` for UNMATCHED
  // paths — so omitting this field yields `undefined`, which the bridge reads
  // as "streaming" and then attaches a body to this GET. `new Request(...,
  // { method: 'GET', body })` throws `Request with GET/HEAD method cannot have
  // body`, and the Host webserver's error middleware turns any handler
  // exception into an empty 400. Declaring the mode selects the buffered
  // (no-body) branch this read-only route actually needs.
  ctx.effect(
    () => ctx.connection.fetch.register({
      path: ROUTE,
      methods: ['GET', 'HEAD'],
      requestBody: 'buffered',
      fetch,
    }),
    's2s-history-host: read-only route',
  )

  // ---------------------------------------------------------------------------
  // Signal 1: the ledger (plan §14 T20, taken literally).
  //
  // `domain/changed` fires once per durable domain write, after the backend
  // acknowledged durability, in write-chain order. Only the `s2s` domain is ours;
  // any other domain's write is not a reason to re-read the panel.
  // ---------------------------------------------------------------------------
  ctx.effect(
    () => ctx.on('domain/changed', (change) => {
      if (change === undefined || change === null) return
      if (change.domain !== LEDGER_DOMAIN) return
      for (const stream of streams) stream.signal('ledger')
    }),
    's2s-history-host: ledger change signal',
  )

  // ---------------------------------------------------------------------------
  // Signal 2: conversation growth (the deliberate widening of T20 — see
  // EVENTS_ROUTE's comment for why a ledger-only signal would leave the panel
  // stale while the user is typing).
  //
  // `session/event` is the post-commit append feed: callbacks run after the log
  // push, and a listener failure is contained, so this cannot make an append
  // fail. The predicate is shared with `recordsOf`, so the signal and the payload
  // agree by construction.
  // ---------------------------------------------------------------------------
  ctx.effect(
    () => ctx.on('session/event', (session, event) => {
      if (event === undefined || event === null) return
      if (!isFeedWorthy(event)) return
      const sessionId = session === undefined || session === null ? undefined : session.id
      for (const stream of streams) stream.signal('session', sessionId)
    }),
    's2s-history-host: session append signal',
  )

  // ---------------------------------------------------------------------------
  // The stream route itself.
  //
  // `requestBody` is NOT passed here: `ConnectionFetchRoute` on this host
  // (`@deepseek-ai/dsh-client-connection` 0.1.2-rc.1) declares only `path`,
  // `methods` and `fetch`, and neither `lib/index.js` nor its browser face reads
  // any `requestBody` property — the HTTP bridge attaches a body only when the
  // incoming request actually carried one (`...chunks.length > 0 ? { body } : {}`).
  // That makes this a GET with no body, which is what the stream wants.
  //
  // ★ The neighbouring `/messages` route above still passes `requestBody:
  // 'buffered'` and its comment claims the field is REQUIRED. That mechanism was
  // measured absent on this host version; the field is harmless and left alone
  // (out of scope for this batch), but nobody should read that comment as an
  // explanation of anything.
  // ---------------------------------------------------------------------------
  ctx.effect(
    () => ctx.connection.fetch.register({
      path: EVENTS_ROUTE,
      methods: ['GET'],
      fetch: openStream,
    }),
    's2s-history-host: change stream route',
  )

  // Disposing the plugin must close every stream it opened: a disposed fibre with
  // a live socket leaves the browser holding a connection that will never deliver
  // again, and nothing on either side would report it.
  ctx.effect(
    () => () => {
      for (const stream of [...streams]) stream.close()
      streams.clear()
    },
    's2s-history-host: stream teardown',
  )
}
