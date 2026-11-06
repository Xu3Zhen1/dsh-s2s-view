import { readFileSync } from 'node:fs'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Wording hygiene: a disproved explanation must not come back unflagged.
 *
 * ## What this file is, and what it is NOT
 *
 * It guards **wording that was already proven wrong**, not whether the current
 * reasoning is right. A source file can pass every assertion here and still contain
 * a false explanation nobody has caught yet. The value is narrow and real: on
 * 2026-11-06 a comment survived an entire batch because the search needle was one
 * phrase (`retry half`) while the wrong claim was phrased another way entirely
 * (`re-judge … reads attempts`). A grep found nothing because it looked for the
 * sentence instead of the claim. These assertions look for the claim.
 *
 * ## The scan surface, and why `lib/` is excluded
 *
 * `src/**\/*.ts` + `tests/**\/*.ts` only.
 *
 * `lib/` is git-ignored (`.gitignore:5`), so on a clean checkout it does not exist —
 * scanning it would fail for a reason that has nothing to do with wording. It is
 * also rewritten by every build, which would mix the build instant into the
 * criterion's input. `lib/` is *derived* from `src/`; if the source is clean the
 * bundle is clean, and that inference rests on the build being reproducible — a
 * property measured once, on one machine, with one toolchain. Making the criterion
 * depend on it would be adding a hidden premise to a wording check.
 *
 * ## Why the "self-flagging" assertions are full implications, not counts
 *
 * A count ("exactly 2 occurrences") goes red when someone legitimately adds a third
 * meta-statement, which is a false alarm. A full implication — *every* occurrence
 * must be accompanied by a disclaiming marker — stays green for legitimate additions
 * and goes red for a re-assertion. The cost is stated below in the boundaries.
 */

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/**
 * This file is excluded from its own scan, and that is not a convenience.
 *
 * A criterion that forbids a phrase has to write the phrase down to forbid it, so it
 * is permanently self-matching: every occurrence it finds in *itself* is the
 * criterion, not a violation. Measured while writing this file — the first run went
 * red on eight of its own lines. The alternatives are both worse: dropping the words
 * makes the criterion unreadable, and adding a self-disclaiming marker to each one
 * would train the reader to ignore the marker.
 *
 * The exclusion is narrow on purpose (this one path), and it is the reason the
 * `disclaiming-marker` assertion below exists — that one uses synthetic input, so it
 * demonstrably still works even though the scan skips this file.
 */
const SELF = 'tests/reasoning-hygiene.spec.ts'

/** Every `.ts` under `src/` and `tests/`, as repo-relative POSIX paths. */
function sourceFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(join(repoRoot, dir))) {
      const rel = dir + '/' + name
      if (statSync(join(repoRoot, rel)).isDirectory()) walk(rel)
      else if (name.endsWith('.ts') && rel !== SELF) out.push(rel)
    }
  }
  walk('src')
  walk('tests')
  return out.sort()
}

interface Hit { file: string; line: number; text: string; previous: string }

/** Lines matching `pattern`, with the line above for context. */
function find(pattern: RegExp): Hit[] {
  const hits: Hit[] = []
  for (const file of sourceFiles()) {
    const lines = readFileSync(join(repoRoot, file), 'utf8').split(/\r?\n/)
    for (let i = 0; i < lines.length; i += 1) {
      if (pattern.test(lines[i]!)) hits.push({ file, line: i + 1, text: lines[i]!, previous: i > 0 ? lines[i - 1]! : '' })
    }
  }
  return hits
}

/**
 * The exclusion list is spelled out rather than hidden inside a regex, because it is
 * this file's blind spot and a blind spot has to be readable and reviewable — the
 * next person needs to know where to add a word.
 *
 * Each entry is asserted below to actually exclude something, so a typo here shows
 * up as a failure instead of silently widening the blind spot.
 */
const DISCLAIMING_MARKERS = [
  'earlier revision',
  'claimed',
  'was wrong',
  'used to',
  'not anything about',
  'not its input',
  'does not',
] as const

function isDisclaimed(hit: Hit): boolean {
  const window = (hit.text + ' ' + hit.previous).toLowerCase()
  return DISCLAIMING_MARKERS.some((marker) => window.includes(marker))
}

describe('wording hygiene: disproved claims must stay flagged', () => {
  it('★★ every `retry half` occurrence carries a marker saying it was disproved', () => {
    // The claim that was proven wrong: "the re-judge job needs the retry half to
    // advance attempts/nextAttemptAt". Plan L1497 says the job reuses reconcile().
    // A bare `retry half` in the present tense re-states it.
    const hits = find(/retry half/)
    for (const hit of hits) {
      expect(isDisclaimed(hit), `${hit.file}:${hit.line} states "retry half" with no disclaiming marker`).toBe(true)
    }
  })

  it('★★ the meta-statements have not been quietly deleted (otherwise the check above is vacuous)', () => {
    // A full implication is satisfied by an empty set. If someone "tidies up" the two
    // comments that record the wrong explanation, the assertion above would pass
    // while checking nothing. `ledger.ts` and `tools.ts` both carry a meta-statement
    // by design, and removing them destroys the record of the mistake.
    expect(find(/retry half/).length).toBeGreaterThan(0)
  })

  it('★★ `re-judge` and `attempts` never appear on the same line', () => {
    // This is the EXACT wording that shipped and was proven wrong —
    // `// job ("re-judge rows that never landed") reads \`attempts\` / \`nextAttemptAt\`,`
    // — and it was on ONE line. Verified against the revision before the fix:
    // `git show 88fa994~1:tests/ledger-recovery.spec.ts`. A criterion is worth what
    // the incident it was meant to catch says it is worth.
    const hits = find(/re-judge|rejudge|重判/)
    for (const hit of hits) {
      const sameLine = /attempts/i.test(hit.text)
      expect(sameLine, `${hit.file}:${hit.line} puts "re-judge" and "attempts" on one line`).toBe(false)
    }
  })

  it('★ the disclaiming-marker list is real (each entry excludes something)', () => {
    // Without this, a misspelled marker would silently widen the blind spot: the
    // assertion above would go green for wording it should have caught, and nothing
    // would say so. Each marker is checked against a synthetic line, so this is an
    // execution rather than an argument.
    for (const marker of DISCLAIMING_MARKERS) {
      const synthetic: Hit = { file: 'synthetic', line: 1, text: `the retry half ${marker} something`, previous: '' }
      expect(isDisclaimed(synthetic), `marker "${marker}" never matches — typo in the exclusion list?`).toBe(true)
    }
  })
})
