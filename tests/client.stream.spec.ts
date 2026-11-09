/**
 * T20 — an idle live stream must keep reading as `live`.
 *
 * Why this file exists: the first shipped version of the change stream turned
 * *silence* into *degradation*. `useChangeStream` armed an interval that
 * declared the channel unavailable once `STREAM_IDLE_MS` (80s) had passed with
 * no change frame, and `lastChangeAt` was written **only** by a change frame — so a
 * panel opened onto a quiet ledger started at `lastChangeAt = 0` and aged out during
 * the first interval, permanently (the effect then unmounted and could never
 * re-arm). Real-machine evidence 2026-11-09: the panel rendered
 * `降级：实时通道不可用`, while 10 of 12 connection samples over 60s showed an
 * unchanged socket set — a healthy stream reported as dead.
 *
 * The host cannot help here: its keepalive is an SSE comment line (`:`), which
 * `EventSource` never surfaces, so the browser has no traffic to observe on an
 * idle-but-live connection. Counting change frames therefore measures activity,
 * never liveness. This file pins the corrected contract:
 *
 *   1. an idle stream stays `events` (this is the regression that shipped);
 *   2. a closed stream still drops to `polling` (the fallback is not orphaned);
 *   3. `ready` alone is enough to enter `events` without any change frame.
 *
 * The subject is the shipped assembly (`lib/client.js`), not a re-implementation,
 * so the assertion covers what the browser actually loads.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

interface Loaded {
  exports: Record<string, any>
  React: Record<string, any>
}

/**
 * A React stand-in whose hooks are real enough to drive the stream hook.
 *
 * The hook returns the state captured **during that call**, so a state setter
 * only becomes visible on the next render. The stand-in therefore resets its
 * hook cursor at the start of every call (see `begin()`), which is what makes a
 * second call behave like a re-render: `useState` hands back the value the
 * setter stored, and `useEffect` re-runs only when its dependencies changed.
 */
function makeReact(): { React: Record<string, any>; begin: () => void } {
  const states: unknown[] = []
  const effects: Array<{ deps?: unknown[]; cleanup?: () => void }> = []
  const refs: Array<{ current: unknown }> = []
  let cursor = 0

  const same = (a?: unknown[], b?: unknown[]): boolean =>
    a !== undefined && b !== undefined && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))

  const React = {
    Fragment: Symbol('Fragment'),
    createElement: () => ({ type: 'div', props: {} }),
    useState(initial: unknown): [unknown, (next: unknown) => void] {
      const index = cursor++
      if (!(index in states)) states[index] = initial
      const set = (next: unknown): void => {
        states[index] = typeof next === 'function' ? (next as (p: unknown) => unknown)(states[index]) : next
      }
      return [states[index], set]
    },
    useRef(initial: unknown): { current: unknown } {
      const index = cursor++
      if (!(index in refs)) refs[index] = { current: initial }
      return refs[index]
    },
    useMemo(factory: () => unknown): unknown {
      return factory()
    },
    useCallback(fn: unknown): unknown {
      return fn
    },
    useEffect(fn: () => (() => void) | undefined, deps?: unknown[]): void {
      const index = cursor++
      const previous = effects[index]
      if (previous !== undefined && same(previous.deps, deps)) return
      previous?.cleanup?.()
      effects[index] = { deps, cleanup: fn() }
    },
  }

  /** Start a render pass: hook positions are counted from zero again. */
  const begin = (): void => { cursor = 0 }

  return { React, begin }
}

interface FakeEventSource {
  readyState: number
  listeners: Map<string, Array<(event: unknown) => void>>
  url: string
  close: () => void
  addEventListener: (type: string, fn: (event: unknown) => void) => void
  removeEventListener: (type: string, fn: (event: unknown) => void) => void
  emit: (type: string, data?: unknown) => void
}

/** The last constructed source, so a test can drive frames into the hook. */
let lastSource: FakeEventSource | undefined

function installEventSource(): void {
  class Fake implements FakeEventSource {
    static readonly CONNECTING = 0
    static readonly OPEN = 1
    static readonly CLOSED = 2
    readyState = 0
    listeners = new Map<string, Array<(event: unknown) => void>>()
    url: string
    close = (): void => { this.readyState = 2 }
    constructor(url: string) {
      this.url = url
      lastSource = this
    }
    addEventListener(type: string, fn: (event: unknown) => void): void {
      const list = this.listeners.get(type) ?? []
      list.push(fn)
      this.listeners.set(type, list)
    }
    removeEventListener(type: string, fn: (event: unknown) => void): void {
      this.listeners.set(type, (this.listeners.get(type) ?? []).filter(f => f !== fn))
    }
    emit(type: string, data?: unknown): void {
      for (const fn of this.listeners.get(type) ?? []) fn({ data: data === undefined ? undefined : JSON.stringify(data) })
    }
  }
  ;(globalThis as Record<string, unknown>).EventSource = Fake
}

/**
 * Load the shipped client assembly the same way the browser does.
 *
 * Mirrors `tests/client.dock.spec.ts`: the artifact is a browser script that
 * registers itself on `window.__ModuleLoader__`, so `window`/`document` are
 * passed in explicitly rather than reached for from module scope.
 * @returns the module exports plus the React stand-in control surface.
 */
function loadClient(): Loaded & { rerender: () => void } {
  const assembled = readFileSync(join(root, 'lib', 'client.js'), 'utf8')
  let definition: { factory: (require: (id: string) => unknown) => Record<string, any> } | undefined
  const window = {
    __ModuleLoader__: {
      load(captured: typeof definition): void { definition = captured },
    },
    localStorage: {
      getItem: (): string | null => null,
      setItem: (): void => {},
      removeItem: (): void => {},
    },
  }
  const document = {
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '', setAttribute() {} }),
    head: { appendChild() {} },
    addEventListener() {},
    removeEventListener() {},
  }

  // `new Function` rather than eval so the assembled text cannot reach this
  // file's scope.
  // eslint-disable-next-line no-new-func
  const run = new Function('window', 'document', assembled) as (w: unknown, d: unknown) => void
  run(window, document)

  if (definition === undefined) throw new Error('client bundle did not register with the module loader')

  const { React, begin } = makeReact()
  const exports = definition.factory((id: string) => {
    if (id === 'react') return React
    if (id === 'react-dom') return {}
    throw new Error(`unexpected require(${id}) in the client half`)
  })

  /**
   * One render pass, exactly as React would drive it: hook positions restart,
   * effects are diffed against the previous pass.
   * @param active - whether the feed tab is showing.
   * @returns the state the hook returned for this pass.
   */
  const render = (active = true): Record<string, any> => {
    begin()
    return exports.useChangeStream(React, active, () => {})
  }

  return { exports, React, render }
}

/** The source the hook just opened; throws rather than silently passing. */
function source(): FakeEventSource {
  if (lastSource === undefined) throw new Error('useChangeStream did not open an EventSource')
  return lastSource
}

beforeEach(() => {
  vi.useFakeTimers()
  lastSource = undefined
  installEventSource()
})

afterEach(() => {
  vi.useRealTimers()
  delete (globalThis as Record<string, unknown>).EventSource
})

describe('useChangeStream: silence is not death', () => {
  it('keeps an idle-but-live stream reporting `events`, not `polling`', () => {
    const { exports, render } = loadClient()
    expect(typeof exports.useChangeStream).toBe('function')

    // First pass opens the connection; the host then sends its first frame.
    render()
    source().readyState = 1
    source().emit('ready')
    expect(render().mode).toBe('events')

    // ★ The regression: ten minutes of silence on a perfectly healthy stream.
    // The first shipped version armed an 80s interval and flipped to `polling`
    // here, permanently, because `lastChangeAt` only advanced on a change frame.
    vi.advanceTimersByTime(10 * 60_000)
    expect(render().mode).toBe('events')
  })

  it('still drops to `polling` when the source is actually closed', () => {
    const { render } = loadClient()
    render()
    source().readyState = 1
    source().emit('ready')
    expect(render().mode).toBe('events')

    source().readyState = 2
    source().emit('error')
    expect(render().mode).toBe('polling')
  })

  it('enters `events` on `ready` alone, with no change frame', () => {
    const { render } = loadClient()
    render()
    source().readyState = 1
    source().emit('ready')
    const state = render()
    expect(state.mode).toBe('events')
    // `ready` proves the channel negotiated; it is not a change notification.
    expect(state.changes).toBe(0)
  })

  it('counts change frames and records the last reason', () => {
    const { render } = loadClient()
    render()
    source().readyState = 1
    source().emit('ready')
    source().emit('change', { reason: 'ledger' })
    const state = render()
    expect(state.changes).toBe(1)
    expect(state.lastReason).toBe('ledger')
    expect(state.mode).toBe('events')
  })

  it('names the timestamp for what it measures, not for liveness', () => {
    const { render } = loadClient()
    render()
    source().readyState = 1
    source().emit('ready')
    source().emit('change', { reason: 'ledger' })
    const state = render()

    // The field records when the last change frame arrived. It is NOT a
    // heartbeat: the host's keepalive is an SSE comment line, which EventSource
    // never surfaces, so this value says nothing about whether the socket lives.
    // It was called `lastAt` while an idle watchdog compared it against a
    // threshold — the name invited exactly that misreading, and the resulting
    // bug was a healthy stream reported as dead. The identifier is the guard,
    // not a comment: comments do not survive every transform, names do.
    expect(Object.hasOwn(state, 'lastChangeAt')).toBe(true)
    expect(Object.hasOwn(state, 'lastAt')).toBe(false)
  })
})
