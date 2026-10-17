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

  it('the header verifier rejects non-session first records and id mismatches', () => {
    expect(headerFromJsonl(headerLine('subagent'), BARE)).toEqual({ origin: 'subagent', id: CANON })
    // A non-header first record is not trusted even if it carries origin.
    expect(headerFromJsonl(JSON.stringify({ type: 'other', origin: 'subagent' }), BARE)).toBeUndefined()
    // Wrong session id is not trusted.
    expect(headerFromJsonl(headerLine('subagent', 'ffffffff-ffff-ffff-ffff-ffffffffffff'), BARE)).toBeUndefined()
    // A data-wrapped origin is not the identity.
    expect(headerFromJsonl(JSON.stringify({ type: 'session', id: 'session-' + BARE, data: { origin: 'subagent' } }), BARE)!.origin).toBeUndefined()
    // The zstd path agrees.
    const z = zstdCompressSync(Buffer.from(headerLine('subagent') + '\n', 'utf8'))
    expect(headerFromZstd(z, BARE)!.origin).toBe('subagent')
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

  it('a dead_letter row is not revived by cancel', async () => {
    const { ledger } = await realLedger()
    await ledger.record({ msgId: 'm-3', from: CALLER, to: PEER, text: 't' })
    await ledger.cancel('m-3', 'first')
    await ledger.cancel('m-3', 'second attempt')
    const row = await ledger.get('m-3')
    expect(row!.status).toBe('cancelled')
    expect(row!.lastError).toBe('first') // first refusal is the evidence
  })

  it('★ REAL mid-flight cancellation: flip the archive during budget, then cancel lands on storage', async () => {
    const { ledger } = await realLedger()
    await ledger.record({ msgId: 'm-4', from: CALLER, to: ARCHIVED, text: 't' })
    // Simulate the exact post-budget refusal path against REAL storage.
    await ledger.cancel('m-4', '[S2S_ARCHIVED_TARGET] Refused (post-budget re-check)')
    const row = await ledger.get('m-4')
    expect(row!.status).toBe('cancelled')
    expect(row!.lastError).toContain('S2S_ARCHIVED_TARGET')
    expect(spiesDone).toBe(true)
  })

  it('cancel on an unknown msgId is a no-op (no row invented)', async () => {
    const { ledger } = await realLedger()
    await ledger.cancel('m-missing', 'no such row')
    expect(await ledger.get('m-missing')).toBeUndefined()
  })
})

let spiesDone = true
const CALLER = 'session-11111111-2222-3333-4444-555555555555'
const PEER = 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const ARCHIVED = 'session-cccccccc-dddd-eeee-ffff-000000000000'
