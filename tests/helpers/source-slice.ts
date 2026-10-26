/**
 * Source-slicing helpers for structural criteria, kept OUTSIDE the spec file.
 *
 * ★★★ WHY THIS IS AST-BASED AND NOT LINE-BASED (2026-10-26, five cross-review
 * rounds). The string/line approach failed FOUR times, each time looking fine:
 *
 *   1. Located the method at its first textual mention — usually the doc comment
 *      that NAMES it, ~8.5k chars before the real declaration.
 *   2. Ended the slice at the next `private async ` in the CONCATENATED
 *      multi-file text, so the last method of a file ran on into the NEXT files
 *      (37,257-char slice inside a 27,083-char file). False green: a hardcoded
 *      reader plus an appended third reader passed 7/7.
 *   3. Brace matching — the signature's return type can contain braces
 *      (`Promise<{ origin: …; headerProven: boolean }>`), so the scan closed on
 *      the return type: a 137-char body, cut mid-signature.
 *   4. Line-based, ending at the first line with the same indent that equals
 *      `}`. This fixed (2) and (3), so it was believed correct. Then BOTH
 *      supporting invariants turned out to be shape-specific:
 *        · `body.length <= fileLen` catches only the cross-FILE over-reach — an
 *          end-of-file over-reach is still shorter than its file (measured:
 *          8,980 and 7,389 vs 27,083), so it passed;
 *        · `body === naiveSlicerOutput` differed only by LEADING WHITESPACE
 *          (`"  private as"` vs `"private asyn"`), so the inequality was
 *          guaranteed by an indent rather than by competence (verified: with
 *          trimStart() on both sides the over-reach becomes EQUAL).
 *
 * The pattern across all four: each fix was designed against the KNOWN failure
 * shape and broke on the next one. "I defended against that form" is not
 * "I defended against that class of error" — the twin of "I could not construct
 * it" ≠ "it cannot be constructed".
 *
 * The AST removes the class instead of the instance: the boundary is whatever
 * the parser says the node's extent is. Indentation, inline return-type braces,
 * first-mention comments, file boundaries and end-of-file over-reach all stop
 * being inputs to the answer. Cost is negligible — `typescript` is already a
 * dependency and `tests/digest.behaviour.spec.ts` reads a source file the same
 * way.
 *
 * ★ And why it lives in a separate module: a reverse test must exercise the SAME
 * implementation as the criterion it guards. When these helpers sat inside the
 * spec, the reverse test grew its own copy and stayed green after the real one
 * was reverted (verified: 8/8 green with both the criterion and its invariant
 * broken). A separate module makes a copy visible dead code instead of a silent
 * substitute.
 */

import ts from 'typescript'

/** Strip comments. Kept for checks that legitimately look at text (e.g. "is
 *  there exactly one literal filename array"). NOT used to find boundaries. */
export const stripComments = (s: string): string => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n')

/** Parse one file. */
export const parseSource = (fileName: string, text: string): ts.SourceFile =>
  ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

interface MethodSpan { name: string; body: string }

/** Every class method in the file, with extents taken from the AST.
 *  `getStart`/`getEnd` exclude leading/trailing trivia, so the span is the
 *  declaration itself — no indentation assumptions, no brace counting, no
 *  doc-comment confusion, no end-of-file over-reach. */
export const methodsIn = (file: ts.SourceFile, text: string): MethodSpan[] => {
  const out: MethodSpan[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isMethodDeclaration(node) && node.name !== undefined && ts.isIdentifier(node.name)) {
      const start = node.getStart(file)
      const end = node.getEnd()
      out.push({ name: node.name.text, body: text.slice(start, end) })
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return out
}

/** Extract one method's source from ONE file's text, boundary from the parser.
 *  Returns `undefined` when the file does not declare that method. */
export const methodBody = (fileCode: string, name: string): string | undefined => {
  const file = parseSource('probe.ts', fileCode)
  return methodsIn(file, fileCode).find((m) => m.name === name)?.body
}

/** Locate a method across a set of file texts. */
export const locateAcross = (
  codes: string[],
  name: string,
  paths: string[],
): { file: string; body: string; fileLen: number } | undefined => {
  for (let i = 0; i < codes.length; i++) {
    const body = methodBody(codes[i]!, name)
    if (body !== undefined) return { file: paths[i]!, body, fileLen: codes[i]!.length }
  }
  return undefined
}

/** Read every `.ts`/`.js` file under `root`. Raw text — the AST path needs no
 *  comment stripping, and stripping first would shift offsets for text checks. */
export async function loadSrcTree(root: URL): Promise<{ paths: string[]; codes: string[] }> {
  const { readdir, readFile } = await import('node:fs/promises')
  const walk = async (dir: URL): Promise<URL[]> => {
    const out: URL[] = []
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const child = new URL(e.name + (e.isDirectory() ? '/' : ''), dir)
      if (e.isDirectory()) { if (e.name !== 'node_modules') out.push(...await walk(child)) }
      else if (e.name.endsWith('.ts') || e.name.endsWith('.js')) out.push(child)
    }
    return out
  }
  const files = await walk(root)
  const codes: string[] = []
  for (const f of files) codes.push(await readFile(f, 'utf8'))
  return { paths: files.map((f) => f.pathname), codes }
}

/**
 * Exactness self-test for a method span, expressed as properties of the SPAN
 * rather than as a scan of any file's text:
 *
 *  1. it contains the declaration;
 *  2. it contains exactly ONE method declaration (an over-reach that swallows a
 *     following method violates this);
 *  3. re-parsing the span on its own yields exactly one method whose body equals
 *     the span — i.e. the span is exactly a method, not a prefix of one and not
 *     a method plus trailing material.
 *
 * Property (3) is what covers the end-of-file over-reach that (2) cannot catch
 * for a method already last in its file: trailing material is not part of the
 * method node, so the reparse cannot equal the span.
 */
export const spanIsExact = (fileCode: string, name: string): boolean => {
  const body = methodBody(fileCode, name)
  if (body === undefined) return false
  if (!body.includes('private async ' + name + '(')) return false
  if ((body.match(/private async /g) ?? []).length !== 1) return false
  const wrapped = 'class X {\n' + body + '\n}'
  const reparsed = parseSource('span.ts', wrapped)
  const again = methodsIn(reparsed, wrapped)
  return again.length === 1 && again[0]!.name === name && again[0]!.body === body
}
