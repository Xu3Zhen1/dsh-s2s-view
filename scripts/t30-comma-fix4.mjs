// Repair the two sites where the codemod split an empty `resolve: vi.fn()`.
import { readFileSync, writeFileSync } from 'node:fs'

const f = 'tests/tools-cases.spec.ts'
let t = readFileSync(f, 'utf8')
const n = (t.match(/resolve: vi\.fn\(, \n/g) || []).length
t = t.replace(
  /resolve: vi\.fn\(, \n/g,
  "resolve: vi.fn(async () => ({ kind: 'ok', sessionId: 's1', title: 'a', state: 'dormant', workspaceDir: 'ws' }) as any),\n",
)
writeFileSync(f, t)
console.log('repaired:', n)
