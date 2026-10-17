// Fix the missing comma after single-line discovery stubs (codemod follow-up).
import { readFileSync, writeFileSync } from 'node:fs'

for (const f of ['tests/tools-ledger.spec.ts', 'tests/tools-reconcile.spec.ts', 'tests/tools-cases.spec.ts']) {
  let t = readFileSync(f, 'utf8')
  const before = (t.match(/as any\)\s*\n\s*archivedFilterState/g) || []).length
  t = t.replace(/(as any\))\s*\n(\s*archivedFilterState)/g, '$1,\n$2')
  writeFileSync(f, t)
  console.log(f, 'commas fixed:', before)
}
