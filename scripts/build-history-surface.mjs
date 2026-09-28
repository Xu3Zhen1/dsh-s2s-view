/**
 * Assemble `lib/client.js` from its tracked source.
 *
 * The browser half is plain authored JavaScript (`src/client/index.js`), not
 * TypeScript: this fork trims the browser package, so upstream's `clientBundle`
 * (TypeScript + CSS-modules pipeline) is not wired up here. Restoring that
 * pipeline is the eventual goal; until then this script is what makes the file
 * reproducible instead of hand-edited inside `node_modules`.
 *
 * The shell around the body is the same one upstream's `clientBundle` emits as
 * banner/intro/footer, so the artifact keeps the shape every out-of-tree client
 * half in the profile has and `window.__ModuleLoader__` keeps working.
 *
 * The HOST half (`src/host/index.js` → `lib/s2s-history-host.mjs`) is copied
 * verbatim: it is a plain ESM module with no imports, so there is nothing to
 * bundle. It is copied rather than consumed in place because the profile mounts
 * it by RELATIVE PATH from `cordis.patch.yml`, and the deployed file must sit
 * beside that patch — `lib/` is the one place this package already publishes.
 *
 * A dry run compares the assembly against the artifact currently deployed and
 * fails on any byte difference. That check is the point: it proves the split
 * lost nothing, so the deployed behavior is still described by the source.
 *
 * Usage:
 *   node scripts/build-history-surface.mjs                 # write lib/client.js
 *   node scripts/build-history-surface.mjs --check <file>  # compare only, write nothing
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const shell = JSON.parse(readFileSync(join(root, 'src', 'client', '.shell.json'), 'utf8'))
const body = readFileSync(join(root, 'src', 'client', 'index.js'), 'utf8')

const assembled = shell.header + shell.shellPrologue + shell.intro + body + shell.footer

const checkAt = process.argv.indexOf('--check')
if (checkAt >= 0) {
  const target = process.argv[checkAt + 1]
  if (target === undefined) {
    console.error('usage: node scripts/build-history-surface.mjs --check <file>')
    process.exit(2)
  }
  const expected = readFileSync(target, 'utf8')
  if (expected === assembled) {
    console.log(`build-history-surface: ok — assembly is byte-identical to ${target}`)
    console.log(`              ${Buffer.byteLength(assembled)} bytes`)
    process.exit(0)
  }
  console.error(`build-history-surface: MISMATCH against ${target}`)
  console.error(`  expected ${Buffer.byteLength(expected)} bytes, assembled ${Buffer.byteLength(assembled)} bytes`)
  const limit = Math.min(expected.length, assembled.length)
  for (let i = 0; i < limit; i += 1) {
    if (expected[i] !== assembled[i]) {
      console.error(`  first difference at byte ${i}:`)
      console.error(`    deployed : ${JSON.stringify(expected.slice(Math.max(0, i - 40), i + 40))}`)
      console.error(`    assembled: ${JSON.stringify(assembled.slice(Math.max(0, i - 40), i + 40))}`)
      break
    }
  }
  process.exit(1)
}

const outFile = join(root, 'lib', 'client.js')
mkdirSync(dirname(outFile), { recursive: true })
writeFileSync(outFile, assembled)
console.log(`build-history-surface: wrote ${outFile} (${Buffer.byteLength(assembled)} bytes)`)

// The host half is copied verbatim — see the module comment for why it lives in
// `lib/` and why nothing is bundled.
const hostSource = join(root, 'src', 'host', 'index.js')
const hostOut = join(root, 'lib', 's2s-history-host.mjs')
const host = readFileSync(hostSource, 'utf8')
writeFileSync(hostOut, host)
console.log(`build-history-surface: wrote ${hostOut} (${Buffer.byteLength(host)} bytes)`)
