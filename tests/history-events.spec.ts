import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
// The host half is authored JavaScript (it is copied verbatim into `lib/` by
// `scripts/build-history-surface.mjs`, not bundled), so this suite exercises the
// same file that ships.
import { apply, EVENTS_ROUTE } from '../src/host/index.js'

/**
 * What these cover (plan §14 T20).
 *
 * The panel used to re-read on its own 5s timer. It is now supposed to be DRIVEN
 * by the host: the host subscribes to the in-process change events and pushes a
 * frame per change. Two things follow, and both are easy to get wrong in a way
 * that still looks green:
 *
 * 1. **The signal must actually reach an open stream.** A subscription that is
 *    registered but never fires produces exactly the same observable state as a
 *    quiet system — no traffic. So each signal is asserted by observing a frame.
 * 2. **Silence must be readable.** "Nothing changed" and "this build has no
 *    subscriber" are indistinguishable from outside, which is the G9 failure
 *    mode. The opening `ready` frame is therefore asserted to exist and to name
 *    what is wired, not just to be non-empty.
 */

/** A host context whose two injected services are minimal fakes. */
function makeHost() {
  const ctx = new Context()
  ctx.logger.warn = vi.fn() as never
  /** Routes registered through `ctx.connection.fetch.register`. */
  const routes = new Map<string, (request: Request) => Promise<Response>>()
  ctx.provide('connection', {
    fetch: {
      register: (route: { path: string, fetch: (request: Request) => Promise<Response> }) => {
        routes.set(route.path, route.fetch)
        // The disposer must actually REMOVE the entry: `ctx.effect` runs it on
        // dispose, and a fake that only returns a resolved promise would make the
        // post-disposal assertion pass for the wrong reason (or, here, fail it).
        return () => {
          routes.delete(route.path)
          return Promise.resolve()
        }
      },
    },
  } as never)
  ctx.provide('sessionQuery', {
    readSession: async () => ({ events: [] }),
  } as never)
  apply(ctx)
  return { ctx, routes }
}

/** One parsed SSE frame: `event:` name plus its `data:` payload. */
interface Frame { event: string, data: string }

/**
 * Read frames from a stream response until `wanted` frames arrived or the
 * stream ends. Bounded so a broken stream fails the test instead of hanging it.
 *
 * ★ `wanted` is a FLOOR, not a ceiling. Draining continues until a read yields
 * nothing new (the stream is still open, so `read()` would block) — a helper that
 * stopped at exactly `wanted` silently discarded extra frames, and that made a
 * "only this domain counts" assertion pass while the mutation it was supposed to
 * catch was live. The observed count is returned so a test can assert equality
 * and thereby notice the surplus.
 */
async function readFrames(response: Response, wanted: number): Promise<Frame[]> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  const frames: Frame[] = []
  let buffer = ''

  const parse = () => {
    for (;;) {
      const cut = buffer.indexOf('\n\n')
      if (cut < 0) return
      const block = buffer.slice(0, cut)
      buffer = buffer.slice(cut + 2)
      let event = ''
      let data = ''
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7)
        else if (line.startsWith('data: ')) data = line.slice(6)
      }
      if (event !== '') frames.push({ event, data })
    }
  }

  for (let guard = 0; guard < 40; guard += 1) {
    // Wait for `wanted` frames first, then keep draining whatever else the
    // stream already produced. A blocking `read()` would hang once the buffer is
    // empty, so the drain phase is race-with-a-ticks-timer.
    const step = await Promise.race([
      reader.read(),
      new Promise<{ value?: undefined, done: true }>(resolve => {
        setTimeout(() => { resolve({ done: true }) }, frames.length >= wanted ? 5 : 50)
      }),
    ])
    if (step.done === true || step.value === undefined) {
      if (frames.length >= wanted) break
      continue
    }
    buffer += decoder.decode(step.value, { stream: true })
    parse()
  }
  await reader.cancel()
  return frames
}

/** Give the stream's `start()` a tick to enqueue before reading. */
const settle = () => new Promise(resolve => { setTimeout(resolve, 0) })

describe('s2s history change stream (T20)', () => {
  it('advertises the route the browser half asks for', () => {
    // Pinned literally: the browser half hard-codes this same path, and a rename
    // on one side only would leave a panel that silently never updates.
    expect(EVENTS_ROUTE).toBe('/api/s2s-history/events')
  })

  it('opens with a ready frame that NAMES both wired signals', async () => {
    const { routes } = makeHost()
    const open = routes.get(EVENTS_ROUTE)
    expect(open).toBeDefined()

    const response = await open!(new Request('http://dsh.internal' + EVENTS_ROUTE))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')

    const frames = await readFrames(response, 1)
    expect(frames).toHaveLength(1)
    expect(frames[0]!.event).toBe('ready')
    const ready = JSON.parse(frames[0]!.data)
    // The point of this frame: a reader can prove the subscription is IN this
    // build. Without it, "no changes yet" and "nothing is listening" are the same
    // observation.
    expect(ready.wired).toEqual({ 'domain/changed': 's2s', 'session/event': 'message+append' })
    expect(ready.streams).toEqual({ open: 1, max: 8 })
  })

  it('★ pushes a frame when a LEDGER write lands, and only for the s2s domain', async () => {
    const { ctx, routes } = makeHost()
    const response = await routes.get(EVENTS_ROUTE)!(new Request('http://dsh.internal' + EVENTS_ROUTE))
    await settle()

    // Another domain writing is not a reason to re-read this panel.
    ctx.emit('domain/changed', { domain: 'workspaces', table: 't', key: 'k', operation: 'put', value: {} })
    // The ledger's own domain is.
    ctx.emit('domain/changed', { domain: 's2s', table: 'deliveries', key: 'm-1', operation: 'put', value: {} })

    const frames = await readFrames(response, 2)
    // ★ Equality, not `≥`: a `workspaces` write that ALSO produced a frame would
    // show up as a third frame. Asserting only "the second frame says ledger"
    // leaves the surplus unobserved — which is exactly how this assertion passed
    // while the domain filter was deleted (mutation M1 survived).
    expect(frames.map(frame => frame.event)).toEqual(['ready', 'change'])
    expect(JSON.parse(frames[1]!.data)).toEqual({ reason: 'ledger' })
  })

  it('★ pushes a frame when a conversation APPENDS a message', async () => {
    const { ctx, routes } = makeHost()
    const response = await routes.get(EVENTS_ROUTE)!(new Request('http://dsh.internal' + EVENTS_ROUTE))
    await settle()

    ctx.emit('session/event', { id: 'sess-1' }, { type: 'user/message', seq: 7, time: 1, data: {} })

    const frames = await readFrames(response, 2)
    expect(frames.map(frame => frame.event)).toEqual(['ready', 'change'])
    // The session id rides along so the panel can tell a growth in a conversation
    // it is showing from unrelated activity.
    expect(JSON.parse(frames[1]!.data)).toEqual({ reason: 'session', sessionId: 'sess-1' })
  })

  it('ignores session events the feed would not render', async () => {
    const { ctx, routes } = makeHost()
    const response = await routes.get(EVENTS_ROUTE)!(new Request('http://dsh.internal' + EVENTS_ROUTE))
    await settle()

    // Machinery: not a message type.
    ctx.emit('session/event', { id: 'sess-1' }, { type: 'usage', seq: 1, time: 1, data: {} })
    // A surface REPLACEMENT rewrites an earlier entry instead of adding a turn,
    // so re-reading produces nothing new and the signal would be noise.
    ctx.emit('session/event', { id: 'sess-1' }, {
      type: 'assistant/message', seq: 2, time: 2, data: {}, surfaceOp: { op: 'replace', start: 1, end: 1 },
    })
    // This one must fire, and it is the discriminator: if the two ignored events
    // above had fired, the frame below would not be the first change frame.
    ctx.emit('session/event', { id: 'sess-2' }, { type: 'assistant/message', seq: 3, time: 3, data: {} })

    const frames = await readFrames(response, 2)
    // Equality again: the two ignored events above must produce NOTHING, so a
    // surplus third frame is the failure signal.
    expect(frames.map(frame => frame.event)).toEqual(['ready', 'change'])
    expect(JSON.parse(frames[1]!.data)).toEqual({ reason: 'session', sessionId: 'sess-2' })
  })

  it('refuses past the stream cap instead of growing without bound, and says so', async () => {
    const { routes } = makeHost()
    const open = routes.get(EVENTS_ROUTE)!
    const live: Response[] = []
    for (let index = 0; index < 8; index += 1) {
      live.push(await open(new Request('http://dsh.internal' + EVENTS_ROUTE)))
    }
    const refused = await open(new Request('http://dsh.internal' + EVENTS_ROUTE))
    expect(refused.status).toBe(503)
    // The body names the counts: a bare 503 would be unreadable ("are streams
    // leaking, or is this the cap working?").
    const text = await refused.text()
    expect(text).toContain('8')
    expect(text).toContain('refused=1')
    for (const response of live) await readFrames(response, 1)
  })

  it('closes every stream when the plugin is disposed', async () => {
    const { ctx, routes } = makeHost()
    const response = await routes.get(EVENTS_ROUTE)!(new Request('http://dsh.internal' + EVENTS_ROUTE))
    await settle()

    await ctx.fiber.dispose()

    // After disposal the stream must END, not fall silent: a browser holding a
    // socket that will never deliver again has no way to notice.
    const reader = response.body!.getReader()
    let done = false
    for (let guard = 0; guard < 10 && !done; guard += 1) {
      const step = await reader.read()
      done = step.done === true
    }
    expect(done).toBe(true)
    // And the route is unregistered, so a reconnect gets a 404 rather than a
    // socket that opens and then never delivers.
    expect(routes.has(EVENTS_ROUTE)).toBe(false)
  })
})
