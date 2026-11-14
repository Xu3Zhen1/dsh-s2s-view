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
  const routes = new Map<string, { fetch: (request: Request) => Promise<Response>, requestBody?: string }>()
  ctx.provide('connection', {
    fetch: {
      register: (route: { path: string, fetch: (request: Request) => Promise<Response>, requestBody?: string }) => {
        routes.set(route.path, { fetch: route.fetch, requestBody: route.requestBody })
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
 * Read frames from a stream response until the stream goes QUIET.
 *
 * ★ Two properties this helper must have, and an earlier version had only the
 * first — that gap is what let mutation M1 survive:
 *
 * 1. **`wanted` is a FLOOR, not a ceiling.** The drain keeps going after the
 *    first `wanted` frames. A helper that stopped at exactly `wanted` discarded
 *    extra frames, which made "only the s2s domain counts" pass while the
 *    mutation it exists to catch was live.
 * 2. ★ **The drain must prove the stream is QUIET, and must not report a
 *    timeout as if it were quiet.** A false positive on either side ruins the
 *    assertion: still-quiet-but-not-yet-read looks exactly like "nothing more
 *    came". So the return value carries `quiet: boolean` and the caller asserts
 *    it — a drain that hit the timeout with no frames after the floor returns
 *    `quiet: false` and the test fails loudly instead of passing on a race.
 *
 * Why a timer is needed at all: the stream stays OPEN by design (SSE), so
 * `read()` never resolves once the buffer is empty. Waiting for the reader to
 * end would hang forever; a bounded quiet-window is the only terminating probe.
 *
 * @param response - the stream response.
 * @param wanted - minimum frames to wait for before entering the quiet window.
 * @returns the frames seen, plus whether the stream was proven quiet.
 */
async function readFrames(response: Response, wanted: number): Promise<{ frames: Frame[], quiet: boolean }> {
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

  /**
   * Read with a deadline. `timedOut` is the discriminator the old helper threw
   * away: a deadline reached while below the floor means "not enough arrived",
   * and a deadline reached above the floor means "the stream is quiet".
   */
  const readWithDeadline = async (ms: number): Promise<
    { kind: 'chunk', value: Uint8Array } | { kind: 'end' } | { kind: 'timeout' }
  > => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const expiry = new Promise<{ kind: 'timeout' }>(resolve => {
      timer = setTimeout(() => { resolve({ kind: 'timeout' }) }, ms)
    })
    try {
      const step = await Promise.race([
        reader.read().then(outcome => (outcome.done === true
          ? { kind: 'end' as const }
          : { kind: 'chunk' as const, value: outcome.value })),
        expiry,
      ])
      return step
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  const FLOOR_DEADLINE_MS = 500
  const QUIET_WINDOW_MS = 60
  /**
   * ★ Overall bound, and it must expire BEFORE the runner's own timeout.
   *
   * Found by mutation M7 (suppress the `ready` frame): the floor was never met,
   * so the loop kept waiting and the suite died on vitest's 5s test timeout —
   * five tests "failed" without this helper ever returning. That reads as a
   * passing criterion and is not one: a case that fails by being KILLED never
   * exercises the assertion it was written for. With this bound the helper
   * returns `quiet: false` on its own terms and the explicit `expect(quiet)`
   * below is what fails.
   */
  const FLOOR_BUDGET_MS = 2_400
  const floorDeadline = Date.now() + FLOOR_BUDGET_MS

  for (let guard = 0; guard < 400; guard += 1) {
    const floorMet = frames.length >= wanted
    if (!floorMet && Date.now() > floorDeadline) {
      await reader.cancel()
      return { frames, quiet: false }
    }
    const step = await readWithDeadline(floorMet ? QUIET_WINDOW_MS : FLOOR_DEADLINE_MS)
    if (step.kind === 'end') {
      await reader.cancel()
      // A closed stream is unambiguously complete.
      return { frames, quiet: true }
    }
    if (step.kind === 'timeout') {
      // Above the floor and nothing for a whole quiet window ⇒ proven quiet.
      // Below the floor ⇒ the stream is open but starved; that is NOT quiet.
      if (floorMet) {
        await reader.cancel()
        return { frames, quiet: true }
      }
      continue
    }
    buffer += decoder.decode(step.value, { stream: true })
    parse()
  }
  await reader.cancel()
  return { frames, quiet: false }
}

/** Give the stream's `start()` a tick to enqueue before reading. */
const settle = () => new Promise(resolve => { setTimeout(resolve, 0) })

/**
 * Read a stream and assert it was PROVEN quiet.
 *
 * Every assertion below compares a full sequence, so the drain has to be
 * trustworthy: `quiet === false` means the helper hit its bound without ever
 * proving the stream stopped, and an equality assert on a partial read is
 * worthless. Failing here (rather than returning the frames) is the whole point —
 * a timeout must never be read as "nothing more came".
 */
async function drain(response: Response, wanted: number): Promise<Frame[]> {
  const { frames, quiet } = await readFrames(response, wanted)
  expect(quiet).toBe(true)
  return frames
}

describe('s2s history change stream (T20)', () => {
  it('advertises the route the browser half asks for', () => {
    // Pinned literally: the browser half hard-codes this same path, and a rename
    // on one side only would leave a panel that silently never updates.
    expect(EVENTS_ROUTE).toBe('/api/s2s-history/events')
  })

  it('registers the SSE GET as buffered for the current Fetch bridge', () => {
    const { routes } = makeHost()
    expect(routes.get(EVENTS_ROUTE)?.requestBody).toBe('buffered')
  })

  it('opens with a ready frame that NAMES both wired signals', async () => {
    const { routes } = makeHost()
    const open = routes.get(EVENTS_ROUTE)?.fetch
    expect(open).toBeDefined()

    const response = await open!(new Request('http://dsh.internal' + EVENTS_ROUTE))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/event-stream')

    const frames = await drain(response, 1)
    // Equality: a second frame here would mean the opening frame is duplicated.
    expect(frames.map(frame => frame.event)).toEqual(['ready'])
    const ready = JSON.parse(frames[0]!.data)
    // The point of this frame: a reader can prove the subscription is IN this
    // build. Without it, "no changes yet" and "nothing is listening" are the same
    // observation.
    expect(ready.wired).toEqual({ 'domain/changed': 's2s', 'session/event': 'message+append' })
    expect(ready.streams).toEqual({ open: 1, max: 8 })
  })

  it('★ pushes a frame when a LEDGER write lands, and only for the s2s domain', async () => {
    const { ctx, routes } = makeHost()
    const response = await routes.get(EVENTS_ROUTE)?.fetch!(new Request('http://dsh.internal' + EVENTS_ROUTE))
    await settle()

    // Another domain writing is not a reason to re-read this panel.
    ctx.emit('domain/changed', { domain: 'workspaces', table: 't', key: 'k', operation: 'put', value: {} })
    // The ledger's own domain is.
    ctx.emit('domain/changed', { domain: 's2s', table: 'deliveries', key: 'm-1', operation: 'put', value: {} })

    const frames = await drain(response, 2)
    // ★ Equality, not `≥`: a `workspaces` write that ALSO produced a frame would
    // show up as a third frame. Asserting only "the second frame says ledger"
    // leaves the surplus unobserved — which is exactly how this assertion passed
    // while the domain filter was deleted (mutation M1 survived).
    expect(frames.map(frame => frame.event)).toEqual(['ready', 'change'])
    expect(JSON.parse(frames[1]!.data)).toEqual({ reason: 'ledger' })
  })

  it('★ pushes a frame when a conversation APPENDS a message', async () => {
    const { ctx, routes } = makeHost()
    const response = await routes.get(EVENTS_ROUTE)?.fetch!(new Request('http://dsh.internal' + EVENTS_ROUTE))
    await settle()

    ctx.emit('session/event', { id: 'sess-1' }, { type: 'user/message', seq: 7, time: 1, data: {} })

    const frames = await drain(response, 2)
    expect(frames.map(frame => frame.event)).toEqual(['ready', 'change'])
    // The session id rides along so the panel can tell a growth in a conversation
    // it is showing from unrelated activity.
    expect(JSON.parse(frames[1]!.data)).toEqual({ reason: 'session', sessionId: 'sess-1' })
  })

  it('ignores session events the feed would not render', async () => {
    const { ctx, routes } = makeHost()
    const response = await routes.get(EVENTS_ROUTE)?.fetch!(new Request('http://dsh.internal' + EVENTS_ROUTE))
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

    const frames = await drain(response, 2)
    // Equality again: the two ignored events above must produce NOTHING, so a
    // surplus third frame is the failure signal.
    expect(frames.map(frame => frame.event)).toEqual(['ready', 'change'])
    expect(JSON.parse(frames[1]!.data)).toEqual({ reason: 'session', sessionId: 'sess-2' })
  })

  it('refuses past the stream cap instead of growing without bound, and says so', async () => {
    const { routes } = makeHost()
    const open = routes.get(EVENTS_ROUTE)?.fetch!
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
    for (const response of live) expect((await drain(response, 1)).map(f => f.event)).toEqual(['ready'])
  })

  it('closes every stream when the plugin is disposed', async () => {
    const { ctx, routes } = makeHost()
    const response = await routes.get(EVENTS_ROUTE)?.fetch!(new Request('http://dsh.internal' + EVENTS_ROUTE))
    await settle()

    await ctx.fiber.dispose()

    // After disposal the stream must END, not fall silent: a browser holding a
    // socket that will never deliver again has no way to notice. The loop is
    // bounded by a deadline as well, so a stream that neither ends nor delivers
    // fails here instead of hanging the run.
    const reader = response.body!.getReader()
    let done = false
    const deadline = Date.now() + 2_000
    while (!done && Date.now() < deadline) {
      const step = await Promise.race([
        reader.read(),
        new Promise<{ done?: undefined }>(resolve => { setTimeout(() => { resolve({}) }, 100) }),
      ])
      if (step.done === true) done = true
    }
    expect(done).toBe(true)
    // And the route is unregistered, so a reconnect gets a 404 rather than a
    // socket that opens and then never delivers.
    expect(routes.has(EVENTS_ROUTE)).toBe(false)
  })
})
