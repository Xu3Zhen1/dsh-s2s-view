// One-shot codemod v2: append the T30 stub methods to EVERY inline discovery
// object literal in the legacy tool specs, by brace-matching from
// `discovery: {` / `const discovery = {` to its closing `}`.
import { readFileSync, writeFileSync } from 'node:fs'

const files = [
  'tests/tools-ledger.spec.ts',
  'tests/tools-reconcile.spec.ts',
  'tests/tools-cases.spec.ts',
]

// Returns the index just past the matching `}` for the `{` at `open`.
function matchBrace(text, open) {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

let total = 0
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  let out = ''
  let cursor = 0
  let count = 0
  while (true) {
    const rest = text.slice(cursor)
    const m = rest.match(/discovery(:\s*\{| = \{)/)
    if (m === null) { out += rest; break }
    const objStart = cursor + m.index + m[0].length - 1 // position of `{`
    const objEnd = matchBrace(text, objStart)
    if (objEnd < 0) { out += rest; break }
    const body = text.slice(objStart + 1, objEnd)
    if (body.includes('archivedFilterState')) {
      // Already stubbed (shared harness) — keep as-is.
      out += text.slice(cursor, objEnd + 1)
      cursor = objEnd + 1
      continue
    }
    const indentMatch = text.slice(cursor, objStart).match(/(\n)([ \t]*)[^\n]*$/)
    const indent = indentMatch ? indentMatch[2] : '  '
    out += text.slice(cursor, objEnd) + '\n' + indent + '  ' +
      "archivedFilterState: vi.fn(() => ({ state: 'available', ids: [] as string[] }))," + '\n' + indent + '  ' +
      "classifyTarget: vi.fn((id: string, origin?: string) => (origin === 'subagent' ? 'subagent' : origin !== undefined ? 'unknown' : 'eligible'))," +
      text.slice(objEnd, objEnd + 1)
    cursor = objEnd + 1
    count++
  }
  writeFileSync(file, out)
  console.log(file, 'stubs patched:', count)
  total += count
}
console.log('total:', total)
