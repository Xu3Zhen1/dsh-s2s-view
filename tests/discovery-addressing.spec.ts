/**
 * Items ①, ④ and ⑤ of the name-lookup fix (ruling 2026-10-15).
 *
 * These pin the *addressing* semantics that the real failure exposed: the caller
 * passed a correct target (both a title prefix and the short id shown by
 * `s2s_sessions`) and was told `No session named …`. The ruling allows exactly
 * two new fallbacks and forbids guessing:
 *
 * - ① title PREFIX only, and only when exactly one candidate matches;
 * - ④ canonical / bare id / unique id prefix;
 * - ⑤ a capped, prefix-ranked candidate list (never the whole corpus).
 *
 * The fail-closed rule matters more than the convenience: every ambiguous case
 * below must return `ambiguous`, never a chosen session.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { S2sDiscoveryService } from '../src/discovery.ts'

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tmpCache(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 's2s-addr-'))
  dirs.push(dir)
  return join(dir, 'title-cache.json')
}

function rec(id: string, cwd: string, live = false) { return { header: { id, cwd }, live } }

async function harness(records: unknown[], titles: Record<string, string>) {
  const ctx = new Context()
  ctx.provide('agents', { get: () => undefined })
  ctx.provide('sessionQuery', {
    listSessions: async () => records,
    readTitle: async (id: unknown) => (titles[String(id)] !== undefined ? { title: titles[String(id)] } : undefined),
    readTitleSnapshots: async (ids: readonly unknown[]) => ids.map(id => (titles[String(id)] !== undefined ? { title: titles[String(id)] } : undefined)),
  })
  await ctx.plugin(S2sDiscoveryService, { cachePath: await tmpCache() })
  return ctx.get('s2sDiscovery') as S2sDiscoveryService
}

// Realistic uuids: the short id shown by listings is the first 8 chars of the
// uuid part, which is exactly what the failing call passed.
const ID_A = 'session-9f4b6738-79f2-474d-8018-14c9ac49af62'
// Same first uuid group as ID_A, so the 8-char short id `9f4b6738` genuinely
// collides between them — that is the shortest form the listings display.
const ID_B = 'session-9f4b6738-aaaa-bbbb-cccc-dddddddddddd'
const ID_C = 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

describe('④ id addressing: canonical, bare uuid, unique short prefix', () => {
  it('resolves the canonical id (regression guard)', async () => {
    const d = await harness([rec(ID_A, '/w')], { [ID_A]: '重做目标寻找方法， 建议采用' })
    const r = await d.resolve(undefined, ID_A)
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') {
      expect(r.sessionId).toBe(ID_A)
      expect(r.matchedBy).toBe('exact')
    }
  })

  it('★ resolves the BARE uuid for the same session (id, not title)', async () => {
    const d = await harness([rec(ID_A, '/w')], { [ID_A]: '重做目标寻找方法， 建议采用' })
    const r = await d.resolve(undefined, '9f4b6738-79f2-474d-8018-14c9ac49af62')
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') expect(r.sessionId).toBe(ID_A)
  })

  it('★ resolves the SHORT id that s2s_sessions displays', async () => {
    // This is the exact shape of the real failure: the listing showed
    // `[9f4b6738]` and passing that back could not resolve.
    const d = await harness([rec(ID_A, '/w')], { [ID_A]: '重做目标寻找方法， 建议采用' })
    const r = await d.resolve(undefined, '9f4b6738')
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') {
      expect(r.sessionId).toBe(ID_A)
      expect(r.matchedBy).toBe('id-prefix')
    }
  })

  it('refuses a short prefix that collides, and says which sessions collided', async () => {
    // Both uuids start with `9f4b67`, so the prefix is genuinely ambiguous.
    const d = await harness([rec(ID_A, '/w'), rec(ID_B, '/w')], { [ID_A]: '甲', [ID_B]: '乙' })
    const r = await d.resolve(undefined, '9f4b6738')
    expect(r.kind).toBe('ambiguous')
    if (r.kind === 'ambiguous') expect(r.candidates.map(c => c.sessionId).sort()).toEqual([ID_A, ID_B].sort())
  })

  it('an unknown id is not-found, and does not silently become a title lookup', async () => {
    // The ruling: never fall back to name and pretend the id worked.
    const d = await harness([rec(ID_A, '/w')], { [ID_A]: '甲' })
    const r = await d.resolve(undefined, 'ffffffff')
    expect(r.kind).toBe('not-found')
  })

  it('does not treat an arbitrary title or path as an id', async () => {
    const d = await harness([rec(ID_A, '/w')], { [ID_A]: '甲' })
    const r = await d.resolve(undefined, 'F:\\DSH\\MCAutoBuild')
    expect(r.kind).toBe('not-found')
  })

  it('★ SHAPE GATE: a letter-bearing fragment that prefixes an id is NOT an id', async () => {
    // The reviewer's static-review blocker: the first id-prefix implementation
    // accepted ANY string, so `session-abcdef12-…` would have resolved from the
    // input `abcdef12`. A letter-bearing fragment is a title/path, never an id —
    // the gate must reject it before prefix matching runs.
    const d = await harness([rec(ID_A, '/w')], { [ID_A]: '甲' })
    const r = await d.resolve(undefined, 'abcdef12')
    expect(r.kind).toBe('not-found')
  })

  it('★ SHAPE GATE: a workspace path that prefixes an id is NOT an id', async () => {
    const d = await harness([rec(ID_A, '/w')], { [ID_A]: '甲' })
    // `9f4b` is a real prefix of ID_A, but `9f4b/path` carries a non-hex char.
    const r = await d.resolve(undefined, '9f4b/path')
    expect(r.kind).toBe('not-found')
  })

  it('★ SHAPE GATE: a Chinese title fragment is NOT an id', async () => {
    const d = await harness([rec(ID_A, '/w')], { [ID_A]: '甲' })
    const r = await d.resolve(undefined, '重做目标寻找方法')
    expect(r.kind).toBe('not-found')
  })

  it('SHAPE GATE: a short hex prefix shorter than the displayed id is rejected', async () => {
    // Below the 8-char minimum that `shortId()` prints, `9f` is too little
    // evidence to select a session even though it is hex.
    const d = await harness([rec(ID_A, '/w')], { [ID_A]: '甲' })
    const r = await d.resolve(undefined, '9f')
    expect(r.kind).toBe('not-found')
  })

  it('SHAPE GATE: a full-hex uuid shorter than 36 chars still resolves as a prefix', async () => {
    // `9f4b6738-79f2-474d-8018` is a genuine (>= 8 char) hex prefix — a user
    // truncating a uuid must keep working.
    const d = await harness([rec(ID_A, '/w')], { [ID_A]: '甲' })
    const r = await d.resolve(undefined, '9f4b6738-79f2-474d-8018')
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') expect(r.sessionId).toBe(ID_A)
  })

  it('★ SHAPE GATE: a letter fragment that WOULD prefix a non-uuid id stays not-found', async () => {
    // The genuinely falsifying case for the gate. On a host whose ids are not
    // UUIDs (the ruling explicitly allows that shape), a word like `build` is a
    // prefix of `session-build-01` — without the gate it would resolve as an
    // id-prefix, i.e. an arbitrary fragment selecting a session. The gate makes
    // it not-found; only the full canonical id addresses such a session.
    const d = await harness([rec('session-build-01', '/w')], { 'session-build-01': '甲' })
    const r = await d.resolve(undefined, 'build')
    expect(r.kind).toBe('not-found')
  })

  it('a non-uuid id still resolves by its full canonical form (shape gate does not break it)', async () => {
    const d = await harness([rec('session-build-01', '/w')], { 'session-build-01': '甲' })
    const r = await d.resolve(undefined, 'session-build-01')
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') expect(r.sessionId).toBe('session-build-01')
  })

  it('an ambiguous id does NOT fall through to a title match', async () => {
    // A short id collides; a session also has that exact title. The id branch
    // must answer ambiguous rather than quietly resolve by title.
    const d = await harness([rec(ID_A, '/w'), rec(ID_B, '/w')], { [ID_A]: '9f4b67', [ID_B]: '乙' })
    const r = await d.resolve(undefined, '9f4b6738')
    expect(r.kind).toBe('ambiguous')
  })
})

describe('① unique title-prefix fallback (never contains)', () => {
  it('★ resolves a unique title PREFIX, and reports it as such', async () => {
    // The real case: the stored title carries a suffix the caller omitted.
    const d = await harness([rec(ID_A, '/w')], { [ID_A]: '重做目标寻找方法， 建议采用' })
    const r = await d.resolve('重做目标寻找方法', undefined)
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') {
      expect(r.sessionId).toBe(ID_A)
      expect(r.matchedBy).toBe('title-prefix')
      // The actual title must be preserved, not replaced by the needle.
      expect(r.title).toBe('重做目标寻找方法， 建议采用')
    }
  })

  it('an exact title still reports exact (the fallback does not mask it)', async () => {
    const d = await harness([rec(ID_A, '/w')], { [ID_A]: '重做目标寻找方法， 建议采用' })
    const r = await d.resolve('重做目标寻找方法， 建议采用', undefined)
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') expect(r.matchedBy).toBe('exact')
  })

  it('REFUSES when two titles share the prefix (ambiguous, not a guess)', async () => {
    const d = await harness([rec(ID_A, '/w'), rec(ID_B, '/w')], { [ID_A]: '重做目标寻找方法， 建议采用', [ID_B]: '重做目标寻找方法， 另一个方案' })
    const r = await d.resolve('重做目标寻找方法', undefined)
    expect(r.kind).toBe('ambiguous')
  })

  it('a no-prefix title stays not-found', async () => {
    const d = await harness([rec(ID_A, '/w')], { [ID_A]: '完全不同的标题' })
    const r = await d.resolve('重做目标寻找方法', undefined)
    expect(r.kind).toBe('not-found')
  })

  it('does NOT do arbitrary contains matching', async () => {
    // The needle appears in the MIDDLE of the only title. The ruling rejects
    // contains matching, so this must stay not-found.
    const d = await harness([rec(ID_A, '/w')], { [ID_A]: '前缀部分 重做目标寻找方法 后缀部分' })
    const r = await d.resolve('重做目标寻找方法', undefined)
    expect(r.kind).toBe('not-found')
  })

  it('a prefix match is not applied when an exact match exists elsewhere', async () => {
    // Exact wins; the prefix candidate must not steal the resolution.
    const d = await harness([rec(ID_A, '/w'), rec(ID_B, '/w')], { [ID_A]: '开发', [ID_B]: '开发计划书' })
    const r = await d.resolve('开发', undefined)
    expect(r.kind).toBe('ok')
    if (r.kind === 'ok') {
      expect(r.sessionId).toBe(ID_A)
      expect(r.matchedBy).toBe('exact')
    }
  })
})

describe('⑤ not-found candidate diagnostics are capped and prefix-ranked', () => {
  it('caps the list and reports how many were withheld', async () => {
    const titles: Record<string, string> = {}
    const records: unknown[] = []
    for (let i = 0; i < 30; i++) {
      const id = 'session-' + String(i).padStart(8, '0') + '-1111-2222-3333-444455556666'
      records.push(rec(id, '/w'))
      titles[id] = '无关标题 ' + i
    }
    const d = await harness(records, titles)
    const r = await d.resolve('重做目标寻找方法', undefined)
    expect(r.kind).toBe('not-found')
    if (r.kind === 'not-found') {
      expect(r.candidates.length).toBeLessThanOrEqual(8)
      expect(r.totalCandidates).toBe(30)
    }
  })

  it('ranks a CONTAINING title ahead of unrelated ones (diagnostic only)', async () => {
    // The needle is in the middle, so item ① must NOT resolve it (contains is
    // forbidden for delivery). But it is the obvious answer to show the stuck
    // caller, so it leads the candidate list.
    const titles: Record<string, string> = {}
    const records: unknown[] = []
    for (let i = 0; i < 10; i++) {
      const id = 'session-' + String(i).padStart(8, '0') + '-1111-2222-3333-444455556666'
      records.push(rec(id, '/w'))
      titles[id] = '无关标题 ' + i
    }
    records.push(rec(ID_C, '/w'))
    titles[ID_C] = '前缀部分 重做目标寻找方法 后缀部分'
    const d = await harness(records, titles)
    const r = await d.resolve('重做目标寻找方法', undefined)
    expect(r.kind).toBe('not-found')
    if (r.kind === 'not-found') {
      // Still not-found (contains is never a resolution), but the containing
      // session is what the receipt shows first.
      expect(r.candidates[0]?.sessionId).toBe(ID_C)
    }
  })

  it('the not-found list never exceeds the cap even with a huge corpus', async () => {
    const titles: Record<string, string> = {}
    const records: unknown[] = []
    for (let i = 0; i < 120; i++) {
      const id = 'session-' + String(i).padStart(8, '0') + '-aaaa-bbbb-cccc-dddddddddddd'
      records.push(rec(id, '/w'))
      titles[id] = 'x' + i
    }
    const d = await harness(records, titles)
    const r = await d.resolve('不存在的名字', undefined)
    expect(r.kind).toBe('not-found')
    if (r.kind === 'not-found') {
      expect(r.candidates.length).toBe(8)
      expect(r.totalCandidates).toBe(120)
    }
  })
})
