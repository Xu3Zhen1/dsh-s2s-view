// Fix missing commas where the codemod inserted methods after a multi-line
// list/resolve entry (pattern: `...])\n<indent>archivedFilterState`).
import { readFileSync, writeFileSync } from 'node:fs'

for (const f of ['tests/tools-cases.spec.ts', 'tests/tools-ledger.spec.ts', 'tests/tools-reconcile.spec.ts']) {
  let t = readFileSync(f, 'utf8')
  const before = (t.match(/\)\s*\n(\s*archivedFilterState)/g) || []).length
  t = t.replace(/\)(\s*\n\s*archivedFilterState)/g, ',$1')
  writeFileSync(f, t)
  console.log(f, 'fixed:', before)
}
