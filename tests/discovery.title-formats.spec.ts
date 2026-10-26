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

import { loadSrcTree, locateAcross, methodBody, stripComments } from './helpers/source-slice.ts'

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
    // filename array anywhere under src/, this goes red.
    //
    // ★ SCAN THE WHOLE SOURCE TREE, not one file. Cross-review (2026-10-26)
    // pointed out the real limit: strength comes from HOW MANY FILES the check
    // looks at, not from exporting the constant. Measured then: across all 19
    // `src/**/*.ts` files there is exactly ONE literal filename array and THREE
    // occurrences of the log names — so widening the scan is green today and
    // covers a future third reader in another module for free.
    const { readdir: readDir, readFile: readSource } = await import('node:fs/promises')
    // Shared instrumentation (module scope) — see the block near the top. NOT
    // redefined here: the reverse test must exercise the SAME slice logic, or
    // it stops guarding anything.
    const { paths, codes } = await loadSrcTree(new URL('../src/', import.meta.url))
    // Proves the scan is not vacuously green over an empty set.
    expect(codes.length).toBeGreaterThan(10)
    const all = codes.join('\n')
    // 1. The constant exists, once, with the newest-first order.
    const defs = all.match(/const SESSION_LOG_CANDIDATES = \['session\.v4\.jsonl\.zstd', 'session\.jsonl\.zstd'\] as const/g) ?? []
    expect(defs).toHaveLength(1)
    // 2. Exactly ONE literal filename array in the whole tree (that definition).
    //    A second one means some reader went back to hardcoding.
    const literalArraySites = all.match(/\[[^\]]*'session\.(?:v4\.)?jsonl\.zstd'[^\]]*\]/g) ?? []
    expect(literalArraySites).toHaveLength(1)
    // 3. The plain-log name is not hand-spelled anywhere else.
    const plainLiterals = (all.match(/'session\.jsonl'/g) ?? []).length
    expect(plainLiterals).toBe(1)
    // 4. Both known readers consume the constant — asserted as a SET of the
    //    functions that mention it, NOT as a count. A bare `uses.length === 3`
    //    was the wrong shape: a legitimate third reader would redden it for the
    //    wrong reason, and a third reader is exactly what this check welcomes.
    for (const reader of ['readOriginFromFs', 'readTitleFromFs']) {
      const found = locateAcross(codes, reader, paths)
      // Fail loudly if the declaration shape changed, rather than silently
      // passing over an empty slice.
      expect(found === undefined, 'declaration of ' + reader + ' not found — update this check').toBe(false)
      // ★ A method body MUST NOT exceed the file that holds it. This invariant
      //   is what turned a runaway cross-file slice into a loud failure.
      expect(found!.body.length).toBeLessThanOrEqual(found!.fileLen)
      expect(found!.body).toContain('SESSION_LOG_CANDIDATES')
    }
  })

  it('★ a hardcoded reader stays RED even when a third reader follows it (slice-boundary reverse test)', async () => {
    // ★ Why this test exists: an earlier slice implementation ended at the next
    // `private async` in a CONCATENATED source, so readTitleFromFs' slice ran on
    // into later files (37,257 chars in a 27,083-char file) and reported this
    // exact scenario as 7/7 green.
    //
    // ★★ It calls locateAcross() — the SAME function the criterion above uses.
    // The first version of this test carried its OWN copy of the slice logic
    // (`methodBody2`). Cross-review destroyed it with one experiment: revert the
    // real criterion to the cross-file form AND delete the length invariant ⇒
    // 8/8 still passed. The reverse test was decoration. Sharing the
    // implementation is the whole point; re-inline it and the guard evaporates.
    //
    // Mutation is applied to an IN-MEMORY copy of the tree — never the real file.
    const { readFile } = await import('node:fs/promises')
    const { paths, codes } = await loadSrcTree(new URL('../src/', import.meta.url))

    // (a) hardcode readTitleFromFs WITHOUT a literal filename array (string
    //     concatenation sidesteps the `literalArraySites` check on purpose, so
    //     only the per-reader assertion can catch it).
    let targetIdx = -1
    let mutated = ''
    for (let i = 0; i < codes.length; i++) {
      // note: `codes` is comment-stripped; mutate the RAW file and re-strip.
      const raw = await readFile(new URL('file://' + paths[i]!), 'utf8')
      if (!raw.includes('for (const name of SESSION_LOG_CANDIDATES) {')) continue
      if (!raw.includes('private async readTitleFromFs(')) continue
      const m = raw.replace(
        'for (const name of SESSION_LOG_CANDIDATES) {',
        "for (const name of ['session.' + 'v4.jsonl.zstd', 'session.' + 'jsonl.zstd']) {",
      )
      if (m === raw) continue
      targetIdx = i
      mutated = m
      break
    }
    expect(targetIdx).toBeGreaterThan(-1)
    // (b) a legitimate third reader appended AFTER readTitleFromFs.
    const withThird = mutated.trimEnd()
      + '\n\nexport function zzThirdReader(dir: string): string[] {\n  return SESSION_LOG_CANDIDATES.map((n) => dir + n)\n}\n'

    const codes2 = codes.slice()
    codes2[targetIdx] = stripComments(withThird)

    const found = locateAcross(codes2, 'readTitleFromFs', paths)
    expect(found).toBeDefined()
    // THE ASSERTION THAT MATTERS: the hardcoded reader must be caught by the
    // very function the real criterion calls.
    expect(found!.body).not.toContain('SESSION_LOG_CANDIDATES')
    // ...while the third reader is legitimately present in the same tree, i.e.
    // this is exactly the future scenario the criterion is supposed to welcome.
    expect(codes2[targetIdx]).toContain('zzThirdReader')
  })

  it('★ helper is the ONLY slicer: degrading it reddens every criterion that uses it', async () => {
    // ★★ What this test can and cannot claim — stated plainly, because the
    // previous version claimed too much and was itself decoration.
    //
    // CANNOT be defended in-test: someone editing THIS spec to inline a private
    // copy. A test cannot prevent edits to itself; the earlier attempt to do so
    // scanned its own source text and produced a self-referentially true
    // assertion (slice ran to end-of-file and contained its own expect line;
    // measured reverseAt 7943, slice 2168, file 10111).
    //
    // CAN be guaranteed by structure, and IS the threat model that matters:
    // the slicers live in `tests/helpers/source-slice.ts`, so they are the only
    // implementation in play, and degrading them MUST redden the criteria that
    // depend on them. That is a behaviour property, verified by mutation:
    // making `methodBody` over-reach reddens BOTH the per-reader criterion and
    // the reverse test together (measured: 2 failed).
    //
    // So this test asserts the load-bearing coupling rather than file text:
    // the shared slicer, run on a known-good tree, must isolate the method —
    // and a naive over-reaching slicer must NOT, i.e. the two are not
    // interchangeable and the criterion is not satisfied by accident.
    const { paths, codes } = await loadSrcTree(new URL('../src/', import.meta.url))
    for (const reader of ['readOriginFromFs', 'readTitleFromFs']) {
      const shared = locateAcross(codes, reader, paths)
      expect(shared).toBeDefined()
      // Must find the constant inside the method...
      expect(shared!.body).toContain('SESSION_LOG_CANDIDATES')
      // ...and must not swallow the rest of the file (or later files).
      expect(shared!.body.length).toBeLessThanOrEqual(shared!.fileLen)
      // A naive slicer that runs to end of file is a DIFFERENT answer, which is
      // what makes the assertions above discriminating rather than tautological.
      const owning = codes.findIndex((c) => methodBody(c, reader) !== undefined)
      expect(owning).toBeGreaterThan(-1)
      const naive = codes[owning]!.slice(codes[owning]!.indexOf('private async ' + reader + '('))
      expect(shared!.body === naive).toBe(false)
    }
  })
})
