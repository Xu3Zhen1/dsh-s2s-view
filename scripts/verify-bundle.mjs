/**
 * Post-build assertion: the emitted bundle must contain every marker the
 * current source declares.
 *
 * Why this exists: `tsdown` bundles `lib/types/**` (the `tsc` output), not
 * `src/`. Running tsdown alone therefore re-emits the PREVIOUS build, and a
 * fix can ship, pass CI, and still not be in the artifact the host loads. That
 * happened for real: three fixes went out while every build silently produced
 * stale output, so "rebuilt and it changed nothing" looked like a code bug.
 *
 * Each marker below is a name or literal that only exists when the matching
 * source file made it into the bundle. Adding a fix that must be observable
 * from outside? Add its marker here.
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// The two halves are verified independently. They are built by different tools
// (`tsc`+`tsdown` for the host, `build-history-surface.mjs` for the browser half), and a
// failure in one must not stop the other from being checked — otherwise a host
// build error hides a stale client artifact, or the reverse.
const hostPath = join(root, 'lib', 'index.js')
let hostFailed = false

/** @type {readonly { marker: string, why: string }[]} */
const REQUIRED = [
  { marker: 'cachedPredecessorTitle', why: 'L1 predecessor-title face (session discovery titles)' },
  { marker: 'shortId', why: 'non-prefixed short session id in tool output' },
  { marker: 'onPersistError', why: 'title-cache write failure reporting' },
  { marker: 'dsh-s2s', why: 'producer-owned message source kind' },
]

if (!existsSync(hostPath)) {
  console.error('verify-bundle: lib/index.js is MISSING — run the host build (tsc && tsdown)')
  hostFailed = true
} else {
  const bundle = readFileSync(hostPath, 'utf8')
  const missing = REQUIRED.filter(({ marker }) => !bundle.includes(marker))
  if (missing.length > 0) {
    console.error('verify-bundle: lib/index.js is STALE — missing markers:')
    for (const { marker, why } of missing) console.error(`  - ${marker}  (${why})`)
    console.error('\nDid you run `tsdown` without `tsc`? The bundle reads lib/types/, which tsc produces.')
    console.error('Run the full build: npm run build')
    hostFailed = true
  } else {
    console.log(`verify-bundle: ok — ${REQUIRED.length} markers present in lib/index.js`)
  }
}

// ---------------------------------------------------------------------------
// Browser half (`lib/client.js`).
//
// This one gets a STRICTER check than markers, because the assembled artifact
// can be reproduced exactly: `scripts/build-history-surface.mjs` wraps
// `src/client/index.js`, so "stale" here means the file on disk is not what the
// source assembles to. Byte comparison catches both failure modes at once — an
// edited source that was never rebuilt, AND an artifact hand-edited in place
// (which is precisely how this file drifted out of the repository to begin
// with: `lib/` is gitignored, so a hand-edit survived only until the next
// install).
//
// Markers are checked as well, because they name the specific defects that were
// fixed in this file and would otherwise be re-broken silently by a rewrite.
// ---------------------------------------------------------------------------
const shell = JSON.parse(readFileSync(join(root, 'src', 'client', '.shell.json'), 'utf8'))
const body = readFileSync(join(root, 'src', 'client', 'index.js'), 'utf8')
const assembled = shell.header + shell.shellPrologue + shell.intro + body + shell.footer
const clientPath = join(root, 'lib', 'client.js')

/** Defects fixed in the browser half; a rewrite that loses one fails the build. */
const CLIENT_REQUIRED = [
  { marker: 'group !== currentGroup', why: 'ungrouped group emitted once (session read/rendered twice)' },
  { marker: 'let rendered = 0', why: 'render cap scope (was per-workspace, documented as global)' },
  { marker: "'feed.capped'", why: 'cap notice distinct from body-truncation wording' },
  { marker: 'dsw-alias-bg-layer-2', why: 'panel surface from the framework palette, not a missing --dsh-*' },
  { marker: 'dsw-specific-bubble', why: 'message card fill from the framework bubble token' },
  { marker: 'border-radius:8px', why: 'message card frame (a frame around each message, not a divider between)' },
]

let clientFailed = false
if (!existsSync(clientPath)) {
  console.error('verify-bundle: lib/client.js is MISSING — run: npm run build:client')
  clientFailed = true
} else {
  const client = readFileSync(clientPath, 'utf8')

  if (client !== assembled) {
    console.error('verify-bundle: lib/client.js does NOT match src/client/index.js')
    console.error(`  on disk:   ${Buffer.byteLength(client)} bytes`)
    console.error(`  assembled: ${Buffer.byteLength(assembled)} bytes`)
    const limit = Math.min(client.length, assembled.length)
    for (let i = 0; i < limit; i += 1) {
      if (client[i] !== assembled[i]) {
        console.error(`  first difference at byte ${i}`)
        break
      }
    }
    console.error('\nRun: npm run build:client')
    clientFailed = true
  }

  const clientMissing = CLIENT_REQUIRED.filter(({ marker }) => !client.includes(marker))
  if (clientMissing.length > 0) {
    console.error('verify-bundle: lib/client.js is missing markers:')
    for (const { marker, why } of clientMissing) console.error(`  - ${marker}  (${why})`)
    clientFailed = true
  }

  if (!clientFailed) {
    console.log(
      `verify-bundle: ok — lib/client.js matches source byte-for-byte`
      + ` (${Buffer.byteLength(client)} bytes, ${CLIENT_REQUIRED.length} markers present)`,
    )
  }
}

// ---------------------------------------------------------------------------
// Host half of the history surface (`lib/s2s-history-host.mjs`).
//
// Copied verbatim from `src/host/index.js`, so the same byte comparison applies.
// It is checked here for the same reason as the client half: the file was
// authored inside the profile — mounted by relative path from `cordis.patch.yml`
// — and existed nowhere else on this machine, so a reinstall would have taken
// the route with it.
// ---------------------------------------------------------------------------
const hostSourcePath = join(root, 'src', 'host', 'index.js')
const hostOutPath = join(root, 'lib', 's2s-history-host.mjs')
let hostHalfFailed = false

if (!existsSync(hostOutPath)) {
  console.error('verify-bundle: lib/s2s-history-host.mjs is MISSING — run: npm run build:client')
  hostHalfFailed = true
} else {
  const hostSource = readFileSync(hostSourcePath, 'utf8')
  const hostOut = readFileSync(hostOutPath, 'utf8')
  if (hostOut !== hostSource) {
    console.error('verify-bundle: lib/s2s-history-host.mjs does NOT match src/host/index.js')
    console.error(`  on disk: ${Buffer.byteLength(hostOut)} bytes`)
    console.error(`  source:  ${Buffer.byteLength(hostSource)} bytes`)
    console.error('\nRun: npm run build:client')
    hostHalfFailed = true
  } else {
    console.log(
      `verify-bundle: ok — lib/s2s-history-host.mjs matches source`
      + ` (${Buffer.byteLength(hostOut)} bytes)`,
    )
  }
}

if (hostFailed || clientFailed || hostHalfFailed) process.exit(1)

