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

import { isExactSpan, loadSrcTree, locateAcross, methodBody, spanIsExact, stripComments } from './helpers/source-slice.ts'

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
      // ★★ Exactness is now a property of the SPAN (parser-derived), not a
      //   length comparison. The old `body.length <= fileLen` invariant only
      //   caught the cross-FILE shape: an end-of-file over-reach still measured
      //   shorter than the file (8,980 / 7,389 vs 27,083) and sailed through.
      //   See tests/helpers/source-slice.ts for the four failed string attempts.
      const owning = codes.find((c) => methodBody(c, reader) !== undefined)!
      expect(spanIsExact(owning, reader)).toBe(true)
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

  it('★ the slicer\'s span is EXACT: it isolates the method and nothing beyond it', async () => {
    // ★★ What this test can and cannot claim — stated plainly, because the two
    // previous versions claimed more than they delivered.
    //
    // CANNOT be defended in-test: someone editing THIS spec to inline a private
    // copy of the slicer. A test cannot prevent edits to itself; the earlier
    // attempt scanned its own source text and produced a self-referentially true
    // assertion (reverseAt 7943, slice 2168, file 10111 — the slice ran to EOF
    // and contained its own `expect(...)` line).
    //
    // CAN be asserted, and is the property that actually matters: the span the
    // slicer returns must be EXACTLY a method — not a prefix of one, not a
    // method plus trailing members, not an over-reach to end-of-file.
    //
    // ★ Two earlier "discriminating" contrasts were wrong and are gone:
    //   · `body.length <= fileLen` — an end-of-file over-reach is still shorter
    //     than the file (8,980 and 7,389 vs 27,083), so it never fired;
    //   · `body === naiveSlicerOutput` — the two differed only by LEADING
    //     WHITESPACE (`"  private as"` vs `"private asyn"`), so inequality was
    //     guaranteed by an indent, not by competence. Verified: with
    //     trimStart() on both sides the over-reach becomes EQUAL.
    //
    // `spanIsExact` instead asserts three parser-level properties, including
    // "re-parsing the span alone yields exactly this one method with an
    // identical body" — an end-of-file over-reach cannot satisfy that because
    // the trailing material is not part of the method node.
    const { paths, codes } = await loadSrcTree(new URL('../src/', import.meta.url))
    expect(codes.length).toBeGreaterThan(10) // not vacuously green over an empty set
    for (const reader of ['readOriginFromFs', 'readTitleFromFs']) {
      const owning = codes.find((c) => methodBody(c, reader) !== undefined)
      expect(owning === undefined, 'declaration of ' + reader + ' not found').toBe(false)
      expect(spanIsExact(owning!, reader)).toBe(true)
      // And the span really is the criterion's input, i.e. the constant lives
      // inside it.
      const found = locateAcross(codes, reader, paths)
      expect(found).toBeDefined()
      expect(found!.body).toContain('SESSION_LOG_CANDIDATES')
    }
  })

  it('★ isExactSpan is FALSIFIABLE: it rejects inexact spans, not just accepts exact ones', async () => {
    // ★★ THIS TEST EXISTS BECAUSE THE PREDICATE HAD NO NEGATIVE CONTROL.
    // The earlier version only exposed `spanIsExact(fileCode, name)` and only
    // ever asserted `.toBe(true)` on real files. Cross-review replaced the whole
    // body with `return true` and the suite stayed 9/9 GREEN — i.e. "always
    // yes" and "correct" were indistinguishable, so the predicate had shown no
    // discriminating power at all. (Proven here as a mutation: `always true`
    // must redden this test; `always false` already did.)
    //
    // `isExactSpan` takes the span directly, so both directions are asserted:
    // an exact span must pass and every known-inexact shape must fail.
    const { paths, codes } = await loadSrcTree(new URL('../src/', import.meta.url))
    const reader = 'readOriginFromFs'
    const owning = codes.find((c) => methodBody(c, reader) !== undefined)!
    const exact = methodBody(owning, reader)!
    const at = owning.indexOf('private async ' + reader + '(')

    // 1. POSITIVE: the real span is exact.
    expect(isExactSpan(exact, reader)).toBe(true)

    // 2. NEGATIVE — over-reach: starts at the declaration and continues past the
    //    method's end, built from the PARSER's span endpoints so it cannot
    //    coincide with the exact span.
    //
    //    ★★ This was previously written as
    //         const overreach = owning.slice(at)
    //         if (overreach !== exact) { expect(...).toBe(false) }
    //       i.e. a CONDITIONAL negative control. Cross-review proved the defect
    //       is LIVE, not hypothetical: forcing `overreach === exact` (the shape
    //       you get if the method becomes the last member of its file) produced
    //       "1 passed | 10 skipped" — the assertion silently vanished and the
    //       suite stayed green. Its validity therefore depended on an unrelated
    //       code-layout fact (that another method happens to follow this one).
    //       A control that can be skipped is not a control.
    //
    //    ★ Note the difference from a tautology, because it looks similar:
    //         if (a !== b) { expect(...) }      ← OLD: when a === b the whole
    //                                             assertion VANISHES, test green
    //         expect(a !== b).toBe(true)        ← NEW: when a === b this
    //                                             assertion itself goes RED
    //      The new form asserts the PRECONDITION, so it is only inert while the
    //      precondition holds — and when it stops holding it fails loudly with a
    //      message that says the negative control is no longer valid. That is
    //      the opposite of a tautology: it is a tripwire whose "always true"
    //      holds only in the good world. (Cross-review measured it: weakening
    //      the guard to `expect(true).toBe(true)` leaves 1 passed | 10 skipped,
    //      i.e. the guard is what stops the skip.)
    const exactEnd = at + exact.length
    const overreach = owning.slice(at, exactEnd + 200)
    expect(overreach !== exact).toBe(true) // guard the guard: fails loudly if layout changes
    expect(overreach.length).toBeGreaterThan(exact.length)
    expect(isExactSpan(overreach, reader)).toBe(false)
    // 3. NEGATIVE — truncated by one character.
    expect(isExactSpan(exact.slice(0, exact.length - 1), reader)).toBe(false)
    // 4. NEGATIVE — missing the declaration entirely.
    expect(isExactSpan('const x = 1', reader)).toBe(false)
    // 5. NEGATIVE — empty span.
    expect(isExactSpan('', reader)).toBe(false)
    // 6. NEGATIVE — wrong method name.
    expect(isExactSpan(exact, 'readTitleFromFs')).toBe(false)
    // 7. NEGATIVE — two declarations spliced together (the shape an over-reach
    //    that swallows a following method produces).
    const other = methodBody(codes.find((c) => methodBody(c, 'readTitleFromFs') !== undefined)!, 'readTitleFromFs')!
    expect(isExactSpan(exact + '\n\n' + other, reader)).toBe(false)
    // The positive case above must be a real, non-trivial span, otherwise the
    // "exact" branch could be satisfied by something degenerate.
    expect(exact.length).toBeGreaterThan(200)
  })

  it('★ spanIsExact covers the "method absent" branch (it returned false, untested)', async () => {
    // ★★ WHY THIS EXISTS. Cross-review found `spanIsExact`'s
    // `if (body === undefined) return false` guard had ZERO coverage: the only
    // two call sites both fed it a file that DOES declare the method, so the
    // guard never executed. Two mutations proved it —
    //   · turning that `return false` into `return true`, and
    //   · deleting the guard outright
    // both left the suite 10/10 GREEN (verified here; SHA256 confirmed changed,
    // so the mutation really applied).
    //
    // This is the SAME defect class as the missing negative control, one layer
    // down: `isExactSpan` got its negatives, but its wrapper kept a branch that
    // only ever saw positive input. "The reading was of the right content" does
    // not imply "every branch of that content was executed" — that needs
    // per-branch negatives, not better fingerprints.
    const { paths, codes } = await loadSrcTree(new URL('../src/', import.meta.url))
    const reader = 'readOriginFromFs'

    // A real source file that genuinely does NOT declare the method.
    const noDecl = codes.find((c) => methodBody(c, reader) === undefined)
    expect(noDecl === undefined, 'expected some src file without ' + reader).toBe(false)
    expect(spanIsExact(noDecl!, reader)).toBe(false)

    // And a name that exists nowhere at all — the branch must not care WHY the
    // method is missing.
    const owning = codes.find((c) => methodBody(c, reader) !== undefined)!
    expect(spanIsExact(owning, 'thisMethodDoesNotExistAnywhere')).toBe(false)

    // Positive control in the same test, so a wrapper that simply always
    // returns false cannot satisfy the two negatives above.
    expect(spanIsExact(owning, reader)).toBe(true)
  })
})
