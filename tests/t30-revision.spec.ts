/**
 * T30 revision tests (review `审查-T30-9f4e2b9-阻断与范围-20261017.md`).
 *
 * Blocker 1: FS identity MUST come from the real top-level session header
 * (`{type:"session", origin, id, …}` — measured on this host), verified by type
 * AND id; `data.origin` on non-header events must not impersonate a header; a
 * missing/corrupt/mismatched header is UNPROVEN and fails closed.
 *
 * Blocker 2: warm and cold name resolution run the SAME priority order
 * (eligible exact → eligible prefix → excluded diagnostic).
 *
 * Blocker 3: `ledger.cancel` against REAL storage — queued→cancelled with
 * revision/lastError, terminal and inboxed rows not regressed, and a real
 * mid-flight cancellation.
 */
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { buildTools } from '../src/tools.ts'
import { S2sLedger } from '../src/ledger.ts'
import { S2sDiscoveryService, headerFromJsonl, headerFromZstd } from '../src/discovery.ts'
import Storage from '@deepseek-ai/dsh-storage'
import * as sqliteStorage from '@deepseek-ai/dsh-storage-sqlite'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'

const dirs: string[] = []
const disposers: Array<() => Promise<void>> = []
afterEach(async () => {
  // Close ledgers BEFORE removing their directories: an open sqlite handle
  // makes `rm` fail with EBUSY (observed on the first run of this suite).
  for (const dispose of disposers.splice(0)) {
    try { await dispose() } catch { /* cleanup must not mask the real result */ }
  }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

const BARE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const CANON = 'session-' + BARE

/** A real-shaped session header line (top-level fields, as measured). */
function headerLine(origin: string | undefined, bareId = BARE): string {
  return JSON.stringify({
    type: 'session', version: 4, id: 'session-' + bareId, createdAt: 1700000000000,
    cwd: '/w', isSeeded: false, ...(origin === undefined ? {} : { origin }), agentPreset: 'p',
  })
}

async function mountWithLog(origin: string | undefined, opts: { corrupt?: boolean; mismatched?: boolean; registry?: unknown } = {}) {
  const root = await mkdtemp(join(tmpdir(), 's2s-t30r-'))
  dirs.push(root)
  const wsDir = join(root, '--G-dsh-s2s-view--')
  const sdir = join(wsDir, 'session-' + BARE)
  await mkdir(sdir, { recursive: true })
  if (opts.corrupt === true) {
    await writeFile(join(sdir, 'session.v4.jsonl.zstd'), 'not actually zstd', 'utf8')
  } else {
    const bareId = opts.mismatched === true ? 'ffffffff-ffff-ffff-ffff-ffffffffffff' : BARE
    const header = headerLine(origin, bareId)
    const follower = JSON.stringify({ type: 'subagent/descriptor', seq: 1, time: 1, data: { origin: 'subagent', note: 'an impostor: data.origin must NOT be read as identity' } })
    const z = zstdCompressSync(Buffer.from(header + '\n' + follower + '\n', 'utf8'))
    await writeFile(join(sdir, 'session.v4.jsonl.zstd'), z)
  }
  const ctx = new Context()
  ctx.provide('agents', { get: () => undefined })
  if (opts.registry !== null) ctx.provide('workspaceRegistry', opts.registry ?? { archivedSessionIds: [] })
  // NO sessionQuery provided: the FS fallback path is where the header reading
  // actually runs.
  await ctx.plugin(S2sDiscoveryService, { cachePath: join(root, 'c.json'), sessionsRoot: root })
  return { d: ctx.get('s2sDiscovery') as S2sDiscoveryService, ctx }
}

describe('T30 blocker 1: FS identity reads the REAL top-level header', () => {
  it('★ a real-shaped subagent header (origin at TOP level) classifies subagent', async () => {
    const { d } = await mountWithLog('subagent')
    const infos = await d.list()
    expect(infos[0]!.origin).toBe('subagent')
    expect(infos[0]!.headerUnproven).toBeUndefined()
    const cls = d.classifyTarget(CANON, infos[0]!.origin, [], infos[0]!.headerUnproven)
    expect(cls).toBe('subagent')
  })

  it('★ an ordinary header (no origin field) is eligible — proven, not guessed', async () => {
    const { d } = await mountWithLog(undefined)
    const infos = await d.list()
    expect(infos[0]!.origin).toBeUndefined()
    expect(infos[0]!.headerUnproven).toBeUndefined()
    const cls = d.classifyTarget(CANON, infos[0]!.origin, [], infos[0]!.headerUnproven)
    expect(cls).toBe('eligible')
  })

  it('★ a `data.origin` on a NON-header event must NOT impersonate the identity', async () => {
    // The follower line carries data.origin='subagent'; the real header has no
    // origin. The old reader scanned event.data.origin and misread this as a
    // subagent. The header-verified reader must classify eligible.
    const { d } = await mountWithLog(undefined)
    const infos = await d.list()
    expect(infos[0]!.origin).toBeUndefined()
    const cls = d.classifyTarget(CANON, infos[0]!.origin, [], infos[0]!.headerUnproven)
    expect(cls).toBe('eligible')
  })

  it('★ a CORRUPT log is header-unproven ⇒ unknown (fail-closed, not eligible)', async () => {
    const { d } = await mountWithLog('subagent', { corrupt: true })
    const infos = await d.list()
    expect(infos[0]!.headerUnproven).toBe(true)
    const cls = d.classifyTarget(CANON, infos[0]!.origin, [], infos[0]!.headerUnproven)
    expect(cls).toBe('unknown')
  })

  it('★ a MISMATCHED id (log of another session) is unproven ⇒ unknown', async () => {
    const { d } = await mountWithLog('subagent', { mismatched: true })
    const infos = await d.list()
    expect(infos[0]!.headerUnproven).toBe(true)
    const cls = d.classifyTarget(CANON, infos[0]!.origin, [], infos[0]!.headerUnproven)
    expect(cls).toBe('unknown')
  })

  it('the header verifier decides on the FIRST non-empty record only, and unrecognized origins stay unrecognized', () => {
    expect(headerFromJsonl(headerLine('subagent'), BARE).reading).toEqual({ origin: 'subagent', id: CANON })
    // A non-header first record is not trusted even if it carries origin…
    expect(headerFromJsonl(JSON.stringify({ type: 'other', origin: 'subagent' }), BARE).reading).toBe('unrecognized')
    // …and a LATER well-formed session record cannot revive it.
    const impostorThenHeader = JSON.stringify({ type: 'other', origin: 'subagent' }) + '\n' + headerLine('subagent')
    expect(headerFromJsonl(impostorThenHeader, BARE).reading).toBe('unrecognized')
    // Wrong session id is not trusted.
    expect(headerFromJsonl(headerLine('subagent', 'ffffffff-ffff-ffff-ffff-ffffffffffff'), BARE).reading).toBe('unrecognized')
    // A data-wrapped origin is not the identity.
    expect(headerFromJsonl(JSON.stringify({ type: 'session', id: 'session-' + BARE, data: { origin: 'subagent' } }), BARE).reading).toEqual({ origin: undefined, id: CANON })
    // An origin that is present but NOT a non-empty string is unrecognized.
    expect(headerFromJsonl(JSON.stringify({ type: 'session', id: 'session-' + BARE, origin: 42 }), BARE).reading).toBe('unrecognized')
    expect(headerFromJsonl(JSON.stringify({ type: 'session', id: 'session-' + BARE, origin: '' }), BARE).reading).toBe('unrecognized')
    // The zstd path agrees, and a bad FIRST frame followed by a good one stays unrecognized.
    const z = zstdCompressSync(Buffer.from(headerLine('subagent') + '\n', 'utf8'))
    expect(headerFromZstd(z, BARE).reading).toEqual({ origin: 'subagent', id: CANON })
    const badFirst = zstdCompressSync(Buffer.from('not json\n', 'utf8'))
    const goodSecond = zstdCompressSync(Buffer.from(headerLine('subagent') + '\n', 'utf8'))
    expect(headerFromZstd(Buffer.concat([badFirst, goodSecond]), BARE).reading).toBe('unrecognized')
  })

  it('★ a warm title cache does not skip the header check (identity still verified)', async () => {
    const { d } = await mountWithLog('subagent')
    await d.list() // warm the title cache
    const infos = await d.list() // second call: cache-served titles
    expect(infos[0]!.origin).toBe('subagent') // identity still read from the header
  })
})

describe('T30 blocker 2: warm and cold name resolution share one priority order', () => {
  function corpusHarness(rows: Array<{ id: string; title: string; archived?: boolean; origin?: string }>) {
    const live = { ids: rows.filter(r => r.archived === true).map(r => r.id) }
    const rootP = mkdtemp(join(tmpdir(), 's2s-t30w-')).then(root => { dirs.push(root); return root })
    const ctx = new Context()
    ctx.provide('agents', { get: () => undefined })
    ctx.provide('workspaceRegistry', { archivedSessionIds: live.ids })
    ctx.provide('sessionQuery', {
      listSessions: async () => rows.map(r => ({ header: { id: r.id, cwd: '/w', ...(r.origin === undefined ? {} : { origin: r.origin }) }, live: false })),
      readTitle: async (id: unknown) => {
        const row = rows.find(r => r.id === id)
        return row !== undefined ? { title: row.title } : undefined
      },
      readTitleSnapshots: async () => [],
    })
    return { ctx, live, rootP }
  }

  it('★ archived owner warm-cached + NEW eligible same title ⇒ the ELIGIBLE one wins (warm == cold)', async () => {
    const OLD = 'session-11111111-1111-1111-1111-111111111111'
    const NEW = 'session-22222222-2222-2222-2222-222222222222'
    const { ctx, rootP } = corpusHarness([
      { id: OLD, title: '同名', archived: true },
      { id: NEW, title: '同名' },
    ])
    const rroot = await rootP
    await ctx.plugin(S2sDiscoveryService, { cachePath: join(rroot, 'c.json') })
    const d = ctx.get('s2sDiscovery') as S2sDiscoveryService
    // Warm the cache (OLD is discovered first, cached under the shared title)…
    await d.list()
    // …then resolve by title: the ELIGIBLE session must win on the warm path,
    // exactly as the cold path prefers it.
    const r = await d.resolve('同名', undefined)
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') expect(r.sessionId).toBe(NEW)
  })

  it('an EXCLUDED exact hit resolves its identity for refusal, never an ok', async () => {
    const OLD = 'session-11111111-1111-1111-1111-111111111111'
    const { ctx, rootP } = corpusHarness([{ id: OLD, title: '已归档名', archived: true }])
    const rroot = await rootP
    await ctx.plugin(S2sDiscoveryService, { cachePath: join(rroot, 'c.json') })
    const d = ctx.get('s2sDiscovery') as S2sDiscoveryService
    const r = await d.resolve('已归档名', undefined)
    expect(r.kind).toBe('ok') // identity resolved…
    if (r.kind === 'ok') expect(r.targetClass).toBe('archived') // …but classified for refusal
  })

  it('an eligible PREFIX beats an excluded EXACT (priority order, not exact-first)', async () => {
    // Archived session titled exactly "开发"; eligible session titled
    // "开发计划书" (a prefix of nothing, but the needle "开发" is a prefix of
    // it). No eligible exact exists ⇒ the eligible PREFIX must win over the
    // excluded exact.
    const ARC = 'session-33333333-3333-3333-3333-333333333333'
    const PRE = 'session-44444444-4444-4444-4444-444444444444'
    const { ctx, rootP } = corpusHarness([
      { id: ARC, title: '开发', archived: true },
      { id: PRE, title: '开发计划书' },
    ])
    const rroot = await rootP
    await ctx.plugin(S2sDiscoveryService, { cachePath: join(rroot, 'c.json') })
    const d = ctx.get('s2sDiscovery') as S2sDiscoveryService
    const r = await d.resolve('开发', undefined)
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') {
      expect(r.sessionId).toBe(PRE)
      expect(r.matchedBy).toBe('title-prefix')
    }
  })

  it('ID prefix colliding with both eligible and excluded candidates stays ambiguous (documented policy)', async () => {
    // The ruling requires the id-prefix policy to be explicit: a short id that
    // matches one eligible AND one excluded session is ambiguous — never a
    // guess, never silently resolved to the eligible one.
    const A = 'session-9f4b6738-79f2-474d-8018-14c9ac49af62'
    const B = 'session-9f4b6738-aaaa-bbbb-cccc-dddddddddddd'
    const { ctx, rootP } = corpusHarness([
      { id: A, title: '甲' },
      { id: B, title: '乙', archived: true },
    ])
    const rroot = await rootP
    await ctx.plugin(S2sDiscoveryService, { cachePath: join(rroot, 'c.json') })
    const d = ctx.get('s2sDiscovery') as S2sDiscoveryService
    const r = await d.resolve(undefined, '9f4b6738')
    expect(r.kind).toBe('ambiguous')
  })
})

describe('T30 blocker 3: real storage-backed ledger.cancel', () => {
  async function realLedger() {
    const root = await mkdtemp(join(tmpdir(), 's2s-cancel-'))
    dirs.push(root)
    const ctx = new Context()
    await ctx.plugin(Storage)
    await ctx.plugin(sqliteStorage, { path: join(root, 'storage.db') })
    const facility = new DomainFacility(ctx, { backend: 'sqlite', routes: {} })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility as never)
    const ledger = new S2sLedger(ctx)
    await ledger.open()
    disposers.push(async () => { await ledger.close(); await ctx.fiber.dispose() })
    return { ledger, root }
  }

  it('★ queued → cancelled with the reason on the row (revision/lastError)', async () => {
    const { ledger } = await realLedger()
    await ledger.record({ msgId: 'm-1', from: CALLER, to: PEER, text: 't' })
    await ledger.cancel('m-1', 'policy refusal reason')
    const row = await ledger.get('m-1')
    expect(row!.status).toBe('cancelled')
    expect(row!.lastError).toBe('policy refusal reason')
    expect(row!.revision).toBeDefined()
  })

  it('★ a terminal row is NOT regressed by cancel', async () => {
    const { ledger } = await realLedger()
    await ledger.record({ msgId: 'm-2', from: CALLER, to: PEER, text: 't' })
    await ledger.markInboxed('m-2', PEER)
    await ledger.cancel('m-2', 'late refusal')
    const row = await ledger.get('m-2')
    expect(row!.status).toBe('inboxed') // untouched
    expect(row!.lastError ?? null).toBeNull() // no refusal was written to it
  })

  it('★ terminal rows are not revived by cancel (inboxed tested directly; dead_letter needs an unreadable log, declared)', async () => {
    // Honest scope note: producing a REAL dead_letter requires a row stamped
    // `unreadableSince` by a failed reconcile — this environment has no injection
    // entry for that (the standing T24 boundary: real-host expired>0 unobserved).
    // The terminal-state guard IS exercised directly through `inboxed`, which
    // runs the same not-cancellable branch as dead_letter.
    const { ledger } = await realLedger()
    await ledger.record({ msgId: 'm-3', from: CALLER, to: PEER, text: 't' })
    await ledger.markInboxed('m-3', PEER)
    await ledger.cancel('m-3', 'late refusal')
    const row = await ledger.get('m-3')
    expect(row!.status).toBe('inboxed') // untouched by the refusal
    expect(row!.lastError ?? null).toBeNull()
  })

  it('★ cancel writes the refusal and the revision INCREASES (before/after)', async () => {
    const { ledger } = await realLedger()
    await ledger.record({ msgId: 'm-4', from: CALLER, to: ARCHIVED, text: 't' })
    const before = await ledger.get('m-4')
    const revBefore = before!.revision ?? 0
    const result = await ledger.cancel('m-4', '[S2S_ARCHIVED_TARGET] Refused (post-budget re-check)')
    expect(result.outcome).toBe('cancelled')
    const row = await ledger.get('m-4')
    expect(row!.status).toBe('cancelled')
    expect(row!.lastError).toContain('S2S_ARCHIVED_TARGET')
    expect(row!.revision ?? 0).toBeGreaterThan(revBefore)
  })

  it('cancel reports its structured outcome honestly (not-found / not-cancellable)', async () => {
    const { ledger } = await realLedger()
    await ledger.record({ msgId: 'm-5', from: CALLER, to: PEER, text: 't' })
    await ledger.markInboxed('m-5', PEER)
    const handedOff = await ledger.cancel('m-5', 'late refusal')
    expect(handedOff.outcome).toBe('not-cancellable')
    expect((handedOff as { status?: string }).status).toBe('inboxed')
    const missing = await ledger.cancel('m-missing', 'x')
    expect(missing.outcome).toBe('not-found')
  })

  it('★ REAL tool-level mid-flight: buildTools + real storage ledger + archive flipped during the budget barrier', async () => {
    // The review's required shape: a REAL buildTools over a REAL storage ledger,
    // a budget spy that flips the archive state mid-flight (the barrier), and
    // assertions that NO handover happened and the row ended cancelled.
    const root = await mkdtemp(join(tmpdir(), 's2s-cancel-'))
    dirs.push(root)
    const ctx = new Context()
    await ctx.plugin(Storage)
    await ctx.plugin(sqliteStorage, { path: join(root, 'storage.db') })
    const facility = new DomainFacility(ctx, { backend: 'sqlite', routes: {} })
    ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility as never)
    const ledger = new S2sLedger(ctx)
    await ledger.open()
    disposers.push(async () => { await ledger.close(); await ctx.fiber.dispose() })
    const live = { ids: [] as string[] }
    const discovery = {
      list: vi.fn(async () => [] as any[]),
      resolve: vi.fn(async () => ({ kind: 'ok', sessionId: ARCHIVED, title: 'a', state: 'dormant', workspaceDir: 'ws', matchedBy: 'exact', targetClass: 'eligible' }) as any),
      archivedFilterState: vi.fn(() => ({ state: 'available', ids: [...live.ids] }) as const),
      classifyTarget: vi.fn((id: string) => (live.ids.includes(id) ? 'archived' : 'eligible') as const),
    }
    const queueForDormant = vi.fn(async () => 'resumed' as const)
    const queuedCount = vi.fn(async () => 1)
    let budgetCalls = 0
    const budget = { check: vi.fn(async () => { budgetCalls++; if (budgetCalls === 1) live.ids.push(ARCHIVED); return undefined }) }
    const defs = buildTools({
      ctx: { on: vi.fn(() => vi.fn()), get: vi.fn(() => undefined) },
      broker: { deliver: vi.fn(() => 'idle'), history: vi.fn(() => []) },
      discovery,
      ledger,
      budget,
      lifecycle: { queueForDormant, queuedCount, resumeReport: vi.fn(() => undefined), resumeReports_: vi.fn(() => []) },
    } as any)
    const msg = defs.find((d) => d.name === 's2s_message') as unknown as Tool
    const out = await msg.execute({ name: 'a', text: 'x' }, { agent: { id: CALLER } })
    expect(out.text).toContain('[S2S_ARCHIVED_TARGET]')
    expect(out.text).toContain('cancel outcome: cancelled')
    expect(queueForDormant).not.toHaveBeenCalled() // no handover
    // The row on REAL storage is cancelled with the refusal.
    const row = await ledger.get(await firstMsgId(ledger))
    expect(row!.status).toBe('cancelled')
    expect(row!.lastError).toContain('is an archived session') // the refusal reason, verbatim
  })
})
const CALLER = 'session-11111111-2222-3333-4444-555555555555'
const PEER = 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const ARCHIVED = 'session-cccccccc-dddd-eeee-ffff-000000000000'

/** The single row this test just recorded (query returns newest first). */
async function firstMsgId(ledger: S2sLedger): Promise<string> {
  const rows = await ledger.query({})
  return rows[0]!.msgId
}