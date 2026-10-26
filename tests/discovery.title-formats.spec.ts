import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import zlib from 'node:zlib'
import { S2sDiscoveryService } from '../src/discovery.ts'

/**
 * The L4 on-disk title scan must read the SAME file the host actually appends to.
 *
 * Why this file exists (found 2026-10-26 while auditing "historical conclusions
 * were built on v3"): `readOriginFromFs` searches
 * `session.v4.jsonl.zstd` → `session.jsonl.zstd` → `session.jsonl`, but
 * `readTitleFromFs` — the L4 title fallback — only looked at the two OLD names.
 * On a v4-only session (the current format: measured 314 of 417 session dirs,
 * and 380 v4 logs total vs 103 v3 logs whose newest mtime is 2026-09-30) that
 * means L4 returns `undefined` and the caller reports "no title", which is
 * indistinguishable from "the session has no title". That is the same
 * `catch → return undefined` silence as the `(untitled)` digest defect.
 *
 * These tests pin the search order and — more importantly — the fact that a
 * v4-only log is readable at all. A test that only writes `session.jsonl.zstd`
 * (like `discovery.zstd.spec.ts` does) cannot see this gap: it passes before and
 * after the fix, so it is zero-coupling with respect to the real deployment.
 */

const dirs: string[] = []
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })

async function mount(root: string) {
  const ctx = new Context()
  ctx.provide('agents', { get: () => undefined } as never)
  // No `sessionQuery` and no projection cache: force discovery onto L4.
  await ctx.plugin(S2sDiscoveryService, { sessionsRoot: root })
  return ctx.get('s2sDiscovery') as S2sDiscoveryService
}

async function sessionDir(root: string, name: string, id: string) {
  const sdir = join(root, name, 'session-' + id)
  await mkdir(sdir, { recursive: true })
  return sdir
}

const titleLine = (title: string): string => `{"type":"session/title","data":{"title":"${title}"}}\n`
const headerLine = (id: string): string => `{"type":"session","version":4,"id":"${id}","cwd":"/ws"}\n`

describe('s2s discovery L4 title read across log formats', () => {
  it('★ reads a title from a v4-ONLY session log (the current format)', async () => {
    const root = await mkdtemp(join(tmpdir(), 's2s-v4-'))
    dirs.push(root)
    const sdir = await sessionDir(root, 'ws-a', 'v4only')
    await writeFile(join(sdir, 'session.v4.jsonl.zstd'),
      zlib.zstdCompressSync(Buffer.from(headerLine('v4only') + titleLine('现行格式'), 'utf8')))

    const d = await mount(root)
    const list = await d.list()
    expect(list.length).toBe(1)
    expect(list[0]!.sessionId).toBe('v4only')
    // The whole point: NOT undefined. Before the fix this was undefined and the
    // tool printed `(untitled)` for a perfectly healthy session.
    expect(list[0]!.title).toBe('现行格式')
    await d.ctx.fiber.dispose()
  })

  it('★ prefers v4 over v3 when BOTH exist (v4 is the live log, v3 is frozen)', async () => {
    const root = await mkdtemp(join(tmpdir(), 's2s-v4-'))
    dirs.push(root)
    const sdir = await sessionDir(root, 'ws-a', 'both')
    // The real deployment shape: v3 was frozen on 2026-09-30 and still sits next
    // to the live v4 log. Reading v3 would report a stale title forever.
    await writeFile(join(sdir, 'session.jsonl.zstd'),
      zlib.zstdCompressSync(Buffer.from(titleLine('旧v3标题'), 'utf8')))
    await writeFile(join(sdir, 'session.v4.jsonl.zstd'),
      zlib.zstdCompressSync(Buffer.from(headerLine('both') + titleLine('现行v4标题'), 'utf8')))

    const d = await mount(root)
    const list = await d.list()
    expect(list[0]!.title).toBe('现行v4标题')
    expect(list[0]!.title).not.toBe('旧v3标题')
    await d.ctx.fiber.dispose()
  })

  it('falls back to v3 when there is no v4 log (older sessions keep working)', async () => {
    const root = await mkdtemp(join(tmpdir(), 's2s-v4-'))
    dirs.push(root)
    const sdir = await sessionDir(root, 'ws-a', 'v3only')
    await writeFile(join(sdir, 'session.jsonl.zstd'),
      zlib.zstdCompressSync(Buffer.from(titleLine('只有v3'), 'utf8')))

    const d = await mount(root)
    const list = await d.list()
    expect(list[0]!.title).toBe('只有v3')
    await d.ctx.fiber.dispose()
  })

  it('falls back to plain jsonl only after both zstd formats are absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 's2s-v4-'))
    dirs.push(root)
    const sdir = await sessionDir(root, 'ws-a', 'plain')
    await writeFile(join(sdir, 'session.jsonl'), titleLine('明文回退'), 'utf8')

    const d = await mount(root)
    const list = await d.list()
    expect(list[0]!.title).toBe('明文回退')
    await d.ctx.fiber.dispose()
  })

  it('a corrupt v4 log does not fall through to v3 (no silent downgrade)', async () => {
    // Same rule `readOriginFromFs` already follows: "log exists but cannot be
    // decoded" is a finding, not a reason to guess at an older format. Guessing
    // here would resurrect a stale v3 title and hide the corruption.
    const root = await mkdtemp(join(tmpdir(), 's2s-v4-'))
    dirs.push(root)
    const sdir = await sessionDir(root, 'ws-a', 'corrupt')
    await writeFile(join(sdir, 'session.v4.jsonl.zstd'), 'not actually zstd', 'utf8')
    await writeFile(join(sdir, 'session.jsonl.zstd'),
      zlib.zstdCompressSync(Buffer.from(titleLine('不该被读到'), 'utf8')))

    const d = await mount(root)
    const list = await d.list()
    expect(list[0]!.title).toBeUndefined()
    await d.ctx.fiber.dispose()
  })

  it('a v4 log that decodes but carries NO title still shadows v3 (no silent downgrade)', async () => {
    // Distinct from the corrupt case and easier to get wrong: the v4 log is
    // perfectly readable, it simply has no `session/title` event (a session the
    // user never renamed). Falling back to v3 here would answer with a title
    // that the LIVE log does not contain — a stale answer dressed as a fresh
    // one. Cross-review found this branch uncovered: flipping its `return
    // undefined` to `continue` left the whole suite green.
    const root = await mkdtemp(join(tmpdir(), 's2s-v4-'))
    dirs.push(root)
    const sdir = await sessionDir(root, 'ws-a', 'titleless')
    await writeFile(join(sdir, 'session.v4.jsonl.zstd'),
      zlib.zstdCompressSync(Buffer.from(headerLine('titleless') + '{"type":"session/note","data":{"n":1}}\n', 'utf8')))
    await writeFile(join(sdir, 'session.jsonl.zstd'),
      zlib.zstdCompressSync(Buffer.from(titleLine('只存在于v3的旧标题'), 'utf8')))

    const d = await mount(root)
    const list = await d.list()
    expect(list[0]!.title).toBeUndefined()
    expect(list[0]!.title).not.toBe('只存在于v3的旧标题')
    await d.ctx.fiber.dispose()
  })

  it('★ the two on-disk readers share ONE candidate list (no second place to drift)', async () => {
    // The defect CLASS, not just the defect: `readOriginFromFs` and
    // `readTitleFromFs` each hardcoded their own filename list, and only the
    // title one was wrong. A per-file fix would leave the next reader free to
    // drift again, so the order now comes from one module constant
    // (`SESSION_LOG_CANDIDATES`). This asserts the SHARING — a source-level
    // check is the only way to see "there is exactly one list", since both
    // readers behave identically at runtime once the constant is used.
    //
    // Deliberately structural (AST-free grep): if someone reintroduces a literal
    // filename array in this module, this goes red.
    const { readFile: readSource } = await import('node:fs/promises')
    const src = await readSource(new URL('../src/discovery.ts', import.meta.url), 'utf8')
    // Strip comments first — this repo's own discipline: a docstring that merely
    // MENTIONS the identifier must not satisfy a structural assertion, or the
    // assertion is satisfied by prose and stops guarding the code.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n')
    // 1. The constant exists and is the newest-first order.
    expect(code).toContain("const SESSION_LOG_CANDIDATES = ['session.v4.jsonl.zstd', 'session.jsonl.zstd'] as const")
    // 2. No reader builds its own list: exactly ONE literal filename array in
    //    real code (the constant's own definition). A second one means a reader
    //    went back to hardcoding.
    const literalArraySites = code.match(/\[[^\]]*'session\.(?:v4\.)?jsonl\.zstd'[^\]]*\]/g) ?? []
    expect(literalArraySites).toHaveLength(1)
    // 3. Both readers consume it (1 definition + 2 uses).
    const uses = code.match(/SESSION_LOG_CANDIDATES/g) ?? []
    expect(uses.length).toBe(3)
    // 4. And the plain-log name is not hand-spelled beside them either.
    const plainLiterals = (code.match(/'session\.jsonl'/g) ?? []).length
    expect(plainLiterals).toBe(1) // only SESSION_LOG_PLAIN's definition
  })
})
