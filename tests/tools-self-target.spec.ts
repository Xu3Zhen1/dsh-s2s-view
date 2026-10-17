/**
 * T29 — self-target hard refusal (ruling 2026-10-17).
 *
 * The real defect: `s2s_message` / `s2s_resume` used the caller id only as the
 * sender label, so a session could send an s2s message to *itself* — semantic
 * noise, a self-loop seed, and for `s2s_resume` a fabricated lifecycle wake on
 * the caller. The ruling requires a hard refusal judged against the REAL caller
 * id (`exec.agent.id`), never the model-writable `args.from`, placed after
 * resolution and BEFORE any record / budget / queue / deliver / resume — so a
 * refused self-send leaves no trace at all.
 *
 * The canonical/bare/short-prefix forms are all covered by exact normalized
 * comparison, because `resolve()` has already expanded a unique short prefix to
 * the one full id it can only be.
 */
import { describe, expect, it, vi } from 'vitest'
import { buildTools } from '../src/tools.ts'

type Tool = { name: string; execute: (args: any, exec: any) => Promise<{ text: string }> }

const SELF = 'session-9f4b6738-79f2-474d-8018-14c9ac49af62'

function harness(target: string, opts: { state?: string; lifecycle?: unknown } = {}) {
  const deliver = vi.fn(() => (opts.state ?? 'idle') as 'idle' | 'busy' | 'absent')
  const queueForDormant = vi.fn(async () => 'resumed' as const)
  const queuedCount = vi.fn(async () => 1)
  const broker = { deliver, history: vi.fn(() => [] as any[]) }
  const discovery = {
    list: vi.fn(async () => [] as any[]),
    resolve: vi.fn(async () => ({ kind: 'ok', sessionId: target, title: 'a', state: opts.state ?? 'live-idle', workspaceDir: 'ws' }) as any),
  }
  const ledger = {
    record: vi.fn(async () => true),
    markInboxed: vi.fn(async () => undefined),
    reconcile: vi.fn(),
  }
  const defs = buildTools({
    broker,
    discovery,
    ledger,
    ...(opts.lifecycle === undefined ? {} : { lifecycle: { queueForDormant, queuedCount } }),
  } as any)
  const by = (n: string) => defs.find((d) => d.name === n) as unknown as Tool
  return { by, deliver, queueForDormant, ledger }
}

describe('T29: self-target refusal (s2s_message)', () => {
  it('★ refuses a canonical self target with the S2S_SELF_TARGET code, before any record/deliver', async () => {
    const { by, deliver, ledger } = await harness(SELF)
    const out = await by('s2s_message').execute({ name: 'a', text: 'hello' }, { agent: { id: SELF } })
    expect(out.text).toContain('S2S_SELF_TARGET')
    // No side effect at all: no delivery, no ledger row.
    expect(deliver).not.toHaveBeenCalled()
    expect(ledger.record).not.toHaveBeenCalled()
    expect(ledger.markInboxed).not.toHaveBeenCalled()
  })

  it('refuses the BARE-uuid spelling of the same session', async () => {
    const { by } = await harness(SELF)
    const bare = SELF.replace(/^session-/, '')
    const out = await by('s2s_message').execute({ session_id: bare, text: 'x' }, { agent: { id: SELF } })
    expect(out.text).toContain('S2S_SELF_TARGET')
  })

  it('refuses when the caller id itself is the bare form of the target', async () => {
    // Hosts may report the caller without the container prefix.
    const { by, deliver } = await harness(SELF)
    const out = await by('s2s_message').execute({ name: 'a', text: 'x' }, { agent: { id: SELF.replace(/^session-/, '') } })
    expect(out.text).toContain('S2S_SELF_TARGET')
    expect(deliver).not.toHaveBeenCalled()
  })

  it('refuses the unique SHORT-prefix self reference (the listed display form)', async () => {
    // resolve() expanded the short prefix to the full id; the guard must still
    // see it as the caller.
    const { by, deliver, ledger } = await harness(SELF)
    const out = await by('s2s_message').execute({ session_id: '9f4b6738', text: 'x' }, { agent: { id: SELF } })
    expect(out.text).toContain('S2S_SELF_TARGET')
    expect(deliver).not.toHaveBeenCalled()
    expect(ledger.record).not.toHaveBeenCalled()
  })

  it('★ a forged args.from can NOT bypass the real-caller judgment', async () => {
    // The model controls args.from; the guard must use exec.agent.id only.
    const { by, deliver } = await harness(SELF)
    const out = await by('s2s_message').execute({ name: 'a', text: 'x', from: 'someone-else' }, { agent: { id: SELF } })
    expect(out.text).toContain('S2S_SELF_TARGET')
    expect(deliver).not.toHaveBeenCalled()
  })

  it('★ a forged args.from does NOT create a false self refusal either', async () => {
    // The inverse: claiming the target is yourself via args.from must not block
    // a legitimate send to a sibling session.
    const { by, deliver } = await harness('session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    const out = await by('s2s_message').execute({ name: 'a', text: 'x', from: SELF }, { agent: { id: 'session-11111111-2222-3333-4444-555555555555' } })
    expect(out.text).not.toContain('S2S_SELF_TARGET')
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it('delivers to a sibling session as before (no regression)', async () => {
    const { by, deliver, ledger } = await harness('session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    const out = await by('s2s_message').execute({ name: 'a', text: 'fine' }, { agent: { id: SELF } })
    expect(out.text).not.toContain('S2S_SELF_TARGET')
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(ledger.record).toHaveBeenCalledTimes(1)
  })
})

describe('T29: self-target refusal (s2s_resume)', () => {
  it('★ refuses waking the calling session itself, before record/queue', async () => {
    const { by, queueForDormant, ledger } = await harness(SELF, { state: 'dormant', lifecycle: {} })
    const out = await by('s2s_resume').execute({ name: 'a', text: 'wake me' }, { agent: { id: SELF } })
    expect(out.text).toContain('S2S_SELF_TARGET')
    expect(queueForDormant).not.toHaveBeenCalled()
    expect(ledger.record).not.toHaveBeenCalled()
  })

  it('refuses the short-prefix self wake', async () => {
    const { by, queueForDormant } = await harness(SELF, { state: 'dormant', lifecycle: {} })
    const out = await by('s2s_resume').execute({ session_id: '9f4b6738', text: 'x' }, { agent: { id: SELF } })
    expect(out.text).toContain('S2S_SELF_TARGET')
    expect(queueForDormant).not.toHaveBeenCalled()
  })

  it('a forged args.from cannot make the wake pass or fail falsely', async () => {
    const { by, queueForDormant } = await harness(SELF, { state: 'dormant', lifecycle: {} })
    const out = await by('s2s_resume').execute({ name: 'a', text: 'x', from: 'not-me' }, { agent: { id: SELF } })
    expect(out.text).toContain('S2S_SELF_TARGET')
    expect(queueForDormant).not.toHaveBeenCalled()
  })

  it('wakes a sibling dormant session as before (no regression)', async () => {
    const { by, queueForDormant, ledger } = await harness('session-bbbbbbbb-2222-3333-4444-555555555555', { state: 'dormant', lifecycle: {} })
    const out = await by('s2s_resume').execute({ name: 'a', text: 'x' }, { agent: { id: SELF } })
    expect(out.text).not.toContain('S2S_SELF_TARGET')
    expect(queueForDormant).toHaveBeenCalledTimes(1)
    expect(ledger.record).toHaveBeenCalledTimes(1)
  })
})

describe('T29: caller identity unavailable (documented fail-open, observable)', () => {
  it('does NOT claim self-protection when the host provides no agent id', async () => {
    // Ruling: caller identity unavailable must NOT be silently read as
    // "not self" via args.from, and must not be silently claimed as protected.
    // The implemented choice: allow the send (it cannot be PROVEN to be self)
    // with an explicit, greppable marker on the receipt — so the gap is visible
    // rather than silent.
    const { by } = await harness(SELF)
    const out = await by('s2s_message').execute({ name: 'a', text: 'x' }, {})
    expect(out.text).not.toContain('S2S_SELF_TARGET')
    expect(out.text).toContain('caller identity unavailable')
  })

  it('the marker appears on the resume path too', async () => {
    const { by } = await harness(SELF, { state: 'dormant', lifecycle: {} })
    const out = await by('s2s_resume').execute({ name: 'a', text: 'x' }, {})
    expect(out.text).toContain('caller identity unavailable')
  })
})
