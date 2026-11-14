/**
 * T21 — the `shell.overlay` dock, plus the T20 refresh contract it shares.
 *
 * Why this file exists at all: the browser half is authored JavaScript, and
 * every gate this repository had before it was either host-side (vitest) or
 * string-level (verify-bundle markers). That combination was green on
 * 2026-11-09 while the delivered T20 code wired the change stream to
 * `feed.refresh` — a key `useFeed` never returned. Every pushed frame threw
 * before refreshing anything: a live stream, a stale feed, and no red gate.
 * A marker cannot see a contract between two places; rendering the component
 * and reading the props it hands down can.
 *
 * The test loads the SAME assembly `scripts/build-history-surface.mjs` writes
 * (`lib/client.js`), so it exercises the shipped artifact rather than a
 * re-implementation of it. React is stubbed with the hook subset the client
 * half uses: this is a single-pass smoke render, not a reconciler — effects are
 * not run, state setters do not re-render, and nothing touches the network.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

interface RNode {
  type: unknown
  props: Record<string, unknown> & { children?: unknown }
}

/** The hook subset `src/client/index.js` uses, with effects deliberately inert. */
function makeReact(): Record<string, unknown> {
  return {
    Fragment: Symbol('Fragment'),
    createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): RNode {
      return {
        type,
        props: { ...(props || {}), children: children.length <= 1 ? children[0] : children },
      }
    },
    useState(initial: unknown): [unknown, (next: unknown) => void] {
      return [typeof initial === 'function' ? (initial as () => unknown)() : initial, () => {}]
    },
    useRef(initial: unknown): { current: unknown } {
      return { current: initial }
    },
    useMemo(factory: () => unknown): unknown {
      return factory()
    },
    useCallback(callback: unknown): unknown {
      return callback
    },
    useEffect(): undefined {
      // Single-pass smoke render: no effects means no fetch, no EventSource and
      // no timer — the surface is judged on the tree it produces, not on traffic.
      return undefined
    },
    useSyncExternalStore(_subscribe: unknown, getSnapshot: () => unknown): unknown {
      return getSnapshot()
    },
  }
}

/** Session-list source snapshot: an empty corpus is a valid list. */
function emptySessions(): Record<string, unknown> {
  return {
    subscribe: () => () => {},
    getSnapshot: () => ({ ids: [], byId: {}, current: undefined }),
  }
}

/** Workspace source snapshot: no workspaces registered yet. */
function emptyWorkspaces(): Record<string, unknown> {
  return {
    subscribe: () => () => {},
    getSnapshot: () => ({ items: [], archivedSessionIds: [] }),
  }
}

interface Loaded {
  exports: Record<string, any>
  React: Record<string, any>
}

/**
 * Assemble and evaluate the browser half exactly as the build emits it.
 * @param flags - which persisted surface flags start out ON.
 * @returns the exports the module loader captured.
 */
function loadClient(flags: { open?: boolean; dockOpen?: boolean } = {}): Loaded {
  const shell = JSON.parse(readFileSync(join(root, 'src', 'client', '.shell.json'), 'utf8'))
  const body = readFileSync(join(root, 'src', 'client', 'index.js'), 'utf8')
  const assembled = shell.header + shell.shellPrologue + shell.intro + body + shell.footer

  const stored = new Map<string, string>()
  if (flags.open === true) stored.set('dsh-s2s:history-open', '1')
  if (flags.dockOpen === true) stored.set('dsh-s2s:dock-open', '1')

  let definition: { factory: (require: (id: string) => unknown) => Record<string, any> } | undefined
  const window = {
    __ModuleLoader__: {
      load(captured: typeof definition): void { definition = captured },
    },
    localStorage: {
      getItem: (key: string): string | null => (stored.has(key) ? stored.get(key)! : null),
      setItem: (key: string, value: string): void => { stored.set(key, value) },
      removeItem: (key: string): void => { stored.delete(key) },
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
  // file's scope; window/document are passed in because the artifact is a
  // browser script, not a module.
  // eslint-disable-next-line no-new-func
  const run = new Function('window', 'document', assembled) as (w: unknown, d: unknown) => void
  run(window, document)

  expect(definition).toBeDefined()
  const React = makeReact()
  const exports = definition!.factory((id: string) => {
    if (id === 'react') return React
    if (id === 'react-dom') return {}
    throw new Error(`unexpected require(${id}) in the client half`)
  })
  return { exports, React }
}

/** Slot/effect/locale/services context — only the faces `apply` actually uses. */
function makeCtx(): Record<string, any> {
  const ctx: Record<string, any> = {
    injected: [] as string[],
    registered: [] as Array<{ spec: Record<string, any>; component: unknown }>,
    openedSessionIds: [] as string[],
    uiWorkspace: { openSession: (sessionId: string) => { ctx.openedSessionIds.push(sessionId) } },
    effect: (fn: () => unknown): (() => void) => { fn(); return () => {} },
    locale: { register: () => {}, bind: () => (key: string) => key },
    get: (name: string): unknown => {
      if (name === 'sessions') return { list: emptySessions() }
      if (name === 'workspaces') return { list: emptyWorkspaces() }
      return undefined
    },
  }
  ctx.slots = {
    injected: ctx.injected,
    registered: ctx.registered,
    inject(name: string, factory: () => unknown): unknown {
      ctx.injected.push(name)
      return factory()
    },
    register(spec: Record<string, any>, component: unknown): () => void {
      ctx.registered.push({ spec, component })
      return () => {}
    },
  }
  return ctx
}

/** Flatten a tree of elements, expanding function components exactly once. */
function collect(node: unknown): RNode[] {
  const out: RNode[] = []
  const walk = (current: unknown): void => {
    if (current === null || current === undefined || typeof current !== 'object') return
    if (Array.isArray(current)) {
      for (const child of current) walk(child)
      return
    }
    const element = current as RNode
    if (!('type' in element)) return
    out.push(element)
    if (typeof element.type === 'function') {
      walk((element.type as (props: unknown) => unknown)(element.props))
      return
    }
    walk(element.props.children)
  }
  walk(node)
  return out
}

describe('T21 · the shell.overlay dock', () => {
  it('registers into shell.overlay BESIDE the sidebar panel, under its own id', () => {
    const { exports } = loadClient()
    const ctx = makeCtx()
    exports.apply(ctx)

    expect(ctx.injected).toContain('sidebar.footer.action')
    expect(ctx.injected).toContain('shell.overlay')

    const panel = ctx.registered.find((row) => row.spec.name === 'sidebar.footer.action')
    const dock = ctx.registered.find((row) => row.spec.name === 'shell.overlay')
    expect(panel).toBeDefined()
    expect(dock).toBeDefined()
    expect(panel!.spec.id).toBe('s2s-history')
    // A list slot needs an entry id, and the id must not collide with the panel's.
    expect(dock!.spec.id).toBe('s2s-dock')
    expect(exports.DOCK_ID).toBe('s2s-dock')
  })

  it('opens indexed and history sessions through uiWorkspace', () => {
    const { exports } = loadClient()
    const ctx = makeCtx()
    exports.apply(ctx)

    const sessionId = 'session-target'
    for (const name of ['sidebar.footer.action', 'shell.overlay']) {
      const slot = ctx.registered.find((row: { spec: Record<string, any> }) => row.spec.name === name)
      expect(slot).toBeDefined()
      const props = slot!.spec.inject()
      props.openSession(sessionId)
    }

    expect(ctx.openedSessionIds).toEqual([sessionId, sessionId])
  })

  it('draws NOTHING while closed — the overlay layer stays click-through', () => {
    const { exports } = loadClient({ dockOpen: false })
    const ctx = makeCtx()
    exports.apply(ctx)
    const dock = ctx.registered.find((row) => row.spec.name === 'shell.overlay')!
    const props = { ...(dock.spec.inject() as object), t: (key: string) => key }
    expect(exports.HistoryDock(props)).toBeNull()
  })

  it('★ keeps click-through while open: host opts OUT of pointer events, only the card opts IN, and no mask is drawn', () => {
    const { exports } = loadClient({ dockOpen: true })
    const ctx = makeCtx()
    exports.apply(ctx)
    const dock = ctx.registered.find((row) => row.spec.name === 'shell.overlay')!
    const tree = exports.HistoryDock({ ...(dock.spec.inject() as object), t: (key: string) => key })
    const nodes = collect(tree)

    const host = nodes.find((node) => node.props.className === 's2s-h-dock')
    const card = nodes.find((node) => node.props.className === 's2s-h-dockcard')
    expect(host).toBeDefined()
    expect(card).toBeDefined()
    // The acceptance, mechanically: the host box must not intercept, the card
    // must. A missing declaration here would leave the frame's own
    // `.overlayLayer > *{pointer-events:auto}` in force and swallow clicks.
    expect((host!.props.style as Record<string, unknown>).pointerEvents).toBe('none')
    expect((card!.props.style as Record<string, unknown>).pointerEvents).toBe('auto')

    // No modal mask in the dock: a mask would cover the app it floats above.
    expect(nodes.filter((node) => String(node.props.className || '').includes('s2s-h-mask'))).toHaveLength(0)

    // Same surface, different container: the dock renders the shared class and
    // declares itself a region rather than a dialog.
    const surface = nodes.find((node) => String(node.props.className || '').includes('s2s-h-panel'))
    expect(surface).toBeDefined()
    expect(String(surface!.props.className)).toContain('is-dock')
    expect(surface!.props.role).toBe('region')
  })

  it('★ T20 contract: the feed handed to a surface EXPOSES refresh, because the change stream calls it', () => {
    const { exports, React } = loadClient({ open: true })
    const ctx = makeCtx()
    exports.apply(ctx)

    // Direct contract check: the first T20 cut returned no `refresh` here, so
    // the stream's callback threw on every frame and the feed never re-read.
    const feed = exports.useFeed(React, [], () => undefined, false, false)
    expect(typeof feed.refresh).toBe('function')
    expect(typeof feed.reload).toBe('function')

    // And through the real tree: the panel receives that same reader.
    const panelRegistration = ctx.registered.find((row) => row.spec.name === 'sidebar.footer.action')!
    const tree = exports.HistoryAction({ ...(panelRegistration.spec.inject() as object), t: (key: string) => key })
    const panelElement = collect(tree).find((node) => node.type === exports.HistoryPanel)
    expect(panelElement).toBeDefined()
    expect(typeof (panelElement!.props.feed as Record<string, unknown>).refresh).toBe('function')
  })

  it('the panel is still a modal: exactly one mask, and a dialog surface (not the dock)', () => {
    const { exports } = loadClient({ open: true })
    const ctx = makeCtx()
    exports.apply(ctx)
    const panelRegistration = ctx.registered.find((row) => row.spec.name === 'sidebar.footer.action')!
    const nodes = collect(exports.HistoryAction({
      ...(panelRegistration.spec.inject() as object),
      t: (key: string) => key,
    }))

    expect(nodes.filter((node) => String(node.props.className || '').includes('s2s-h-mask'))).toHaveLength(1)
    const surface = nodes.find((node) => String(node.props.className || '').includes('s2s-h-panel'))
    expect(surface).toBeDefined()
    expect(String(surface!.props.className)).not.toContain('is-dock')
    expect(surface!.props.role).toBe('dialog')
  })
})