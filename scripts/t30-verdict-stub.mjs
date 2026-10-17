// Make the two T30 spec harness stubs' `targetPolicyVerdict` DELEGATE to their
// own classifyTarget + archivedFilterState, instead of the previous no-op stub
// (which silently made every refusal disappear once the tools switched to the
// shared verdict).
import { readFileSync, writeFileSync } from 'node:fs'

const OLD = `targetPolicyVerdict: vi.fn(() => undefined),`
const NEW = [
  `targetPolicyVerdict: vi.fn((info: { sessionId: string; origin?: string; headerUnproven?: boolean }) => {`,
  `        const f = archivedFilterState()`,
  `        if (f.state === 'unavailable') return { code: 'S2S_TARGET_POLICY_UNAVAILABLE' as const, message: f.reason }`,
  `        const cls = classifyTarget(info.sessionId, info.origin, f.ids, info.headerUnproven)`,
  `        if (cls === 'archived') return { code: 'S2S_ARCHIVED_TARGET' as const, message: 'archived' }`,
  `        if (cls === 'subagent') return { code: 'S2S_SUBAGENT_TARGET' as const, message: 'subagent' }`,
  `        if (cls === 'unknown') return { code: 'S2S_TARGET_POLICY_UNAVAILABLE' as const, message: 'unknown' }`,
  `        return undefined`,
  `      }),`,
].join('\n')

for (const f of ['tests/tools-target-policy.spec.ts', 'tests/t30-revision.spec.ts']) {
  let t = readFileSync(f, 'utf8')
  const n = (t.match(new RegExp(OLD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length
  t = t.split(OLD).join(NEW)
  writeFileSync(f, t)
  console.log(f, 'patched:', n)
}
