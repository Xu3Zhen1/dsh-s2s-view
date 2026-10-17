// Fix the 5 multi-line list sites in tools-cases.spec.ts where the codemod
// inserted methods between the array closer `],` and vi.fn's own `)`.
import { readFileSync, writeFileSync } from 'node:fs'

const f = 'tests/tools-cases.spec.ts'
let t = readFileSync(f, 'utf8')
// `    ], \n      archivedFilterState` ⇒ close vi.fn: `    ]), \n ...`
const before = (t.match(/\], \n(\s*archivedFilterState)/g) || []).length
t = t.replace(/\], \n(\s*archivedFilterState)/g, ']), \n$1')
writeFileSync(f, t)
console.log('fixed:', before)
