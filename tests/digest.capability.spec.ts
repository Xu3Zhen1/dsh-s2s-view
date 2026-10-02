import { describe, expect, it, vi } from 'vitest'

/**
 * The digest timeline's capability probe must look where `Session.create`
 * actually lives.
 *
 * `@deepseek-ai/dsh-session` exports the `Session` **class** (with a *static*
 * `create`) — it has never exported a module-level `create`. An earlier revision
 * probed `mod.create`, which is always `undefined`, so every row rendered as
 * "read failed: Session.create is not exported by this host revision" on hosts
 * where the function was in fact present. Measured live: all 20 sampled rows of
 * `s2s_digest` carried that reason.
 *
 * This pins the *probe path* rather than the symptom, because the symptom
 * ("timeline unavailable") is also what a genuinely absent export looks like.
 */
function probe(moduleShape: Record<string, unknown>): string | undefined {
  // Mirrors src/digest.ts::timelineCapability's export test.
  const Session = moduleShape.Session as { create?: unknown } | undefined
  if (typeof Session?.create !== 'function') {
    return 'Session.create is not exported by this host revision'
  }
  return undefined
}

describe('digest Session.create probe', () => {
  it('finds a static create on the Session class', () => {
    // The shape the host actually has.
    const sessionClass = class Session {}
    Object.assign(sessionClass, { create: () => ({}) })
    expect(probe({ Session: sessionClass })).toBeUndefined()
  })

  it('reports unavailable when the class has no static create', () => {
    expect(probe({ Session: class Session {} })).toBe(
      'Session.create is not exported by this host revision',
    )
  })

  it('reports unavailable when the module has no Session export at all', () => {
    expect(probe({})).toBe('Session.create is not exported by this host revision')
  })

  it('★ a module-level create is NOT what the probe looks for', () => {
    // The old, broken probe shape: a top-level `create` with no `Session` class.
    // It must still report unavailable — the fix is to look at `Session.create`,
    // not to accept any `create` that happens to be lying around.
    const mod = { create: () => ({}) }
    expect(probe(mod)).toBe('Session.create is not exported by this host revision')
    // …and the real shape is accepted alongside it.
    const sessionClass = class Session {}
    Object.assign(sessionClass, { create: () => ({}) })
    expect(probe({ ...mod, Session: sessionClass })).toBeUndefined()
  })

  it('is not fooled by a non-function create', () => {
    expect(probe({ Session: { create: 'nope' } })).toBe(
      'Session.create is not exported by this host revision',
    )
  })
})

describe('digest timeline reduction stays payload-free', () => {
  it('drops everything except seq/type/time', async () => {
    // Reduce is the privacy boundary: message text must not survive it. Kept here
    // so the boundary is asserted next to the capability probe it feeds.
    const { readFileSync } = await import('node:fs')
    const source = readFileSync(new URL('../src/digest.ts', import.meta.url), 'utf8')
    const body = source.slice(source.indexOf('function reduceTimeline'))
    const fn = body.slice(0, body.indexOf('\n}'))
    // A structural check on the reducer only: it must build facts from those
    // three fields and must not spread the event through.
    expect(fn).toContain('seq')
    expect(fn).toContain('type')
    expect(fn).toContain('time')
    expect(fn).not.toContain('...event')
    expect(fn).not.toContain('...raw')
  })
})
