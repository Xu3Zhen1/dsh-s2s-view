/**
 * Source-slicing helpers for structural criteria, kept OUTSIDE the spec file.
 *
 * ★★ Why this file exists (2026-10-26, three rounds of cross-review).
 *
 * The criterion "the two on-disk readers share ONE candidate list" is
 * structural: it has to look at the source text, because both readers behave
 * identically at runtime once they consume the shared constant. Extracting a
 * method's body from source is therefore part of the criterion — and getting it
 * wrong silently widens or narrows what the criterion can see.
 *
 * It went wrong three times, each time in a way that looked fine:
 *   1. Located the method at its first textual mention — usually the doc
 *      comment that NAMES it, ~8.5k chars before the real declaration.
 *   2. Ended the slice at the next `private async ` in the CONCATENATED
 *      multi-file text, so the last method of a file ran on into the NEXT
 *      files. Measured: a 37,257-char slice inside a 27,083-char file. This
 *      produced a false green — a hardcoded reader plus a third reader appended
 *      after it passed 7/7.
 *   3. Used brace matching, but the signature's return type may itself contain
 *      braces (`Promise<{ origin: …; headerProven: boolean }>`), so the balanced
 *      scan closed on the return type. Measured: a 137-char body, cut
 *      mid-signature.
 *
 * The current implementation is line-based: a body ends at the first later line
 * whose indentation equals the declaration's and whose text is `}`.
 *
 * ★★ Why it lives here rather than in the spec. A reverse test must prove that
 * the criterion is still doing its job; to do that it has to call the SAME
 * code. When these helpers sat inside the spec, the reverse test grew its own
 * copy, so it exercised a different implementation and stayed green even after
 * the real one was reverted (verified: 8/8 green with the real criterion and its
 * length invariant both broken). Guards were then added in the form of source
 * scans — and one of those assertions was satisfied by its own needle, i.e. it
 * was self-referentially true (verified: `reverseBody` ran to end of file and
 * contained its own `expect(...)` line).
 *
 * The lesson is structural, not a matter of better needles: a duplicate
 * implementation is impossible to SHARE by accident only if sharing is the only
 * option. Keeping the helpers in a separate module means a private copy has to
 * be written deliberately and visibly, instead of arising as a convenience.
 * "What you can exclude structurally, do not try to detect by scanning."
 */

/** Strip comments. A doc comment that merely NAMES an identifier must never
 *  satisfy a structural assertion — that is how an assertion comes to be
 *  satisfied by prose instead of by code. */
export const stripComments = (s: string): string => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n')

/**
 * Extract one method's source from ONE file's text.
 *
 * Deliberately line-based and file-local; see the header for the three earlier
 * implementations this replaces and the measurements that killed them.
 */
export const methodBody = (fileCode: string, name: string): string | undefined => {
  const ls = fileCode.split('\n')
  let start = -1
  let indent = ''
  for (let i = 0; i < ls.length; i++) {
    if (ls[i]!.includes('private async ' + name + '(')) {
      start = i
      indent = (ls[i]!.match(/^\s*/) ?? [''])[0]!
      break
    }
  }
  if (start < 0) return undefined
  for (let i = start + 1; i < ls.length; i++) {
    if (ls[i] === indent + '}') return ls.slice(start, i + 1).join('\n')
  }
  return undefined // no terminator ⇒ the caller asserts loudly
}

/** Locate a method across a set of already-comment-stripped file texts. */
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

/** Read and comment-strip every `.ts`/`.js` file under `root`. */
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
  for (const f of files) codes.push(stripComments(await readFile(f, 'utf8')))
  return { paths: files.map((f) => f.pathname), codes }
}
