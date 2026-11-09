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
  // T20: the panel is driven by the host's change stream. These three markers
  // name the properties that make the claim checkable from the outside, and each
  // one is a fact that a rewrite could silently undo:
  { marker: '/api/s2s-history/events', why: 'T20: the panel subscribes to the change stream (not a 5s poll)' },
  { marker: "'feed.live'", why: 'T20: the panel SAYS it is event-driven, so "quiet" and "disabled" differ' },
  { marker: "'feed.polling'", why: 'T20: the degraded fallback is reported, not silent (G9)' },
  // ★ Negative marker: the old 5s poll constant must be GONE. `FEED_FALLBACK_MS`
  // replaced it, and re-introducing a 5s timer is exactly the regression L1568
  // forbids. Checked as an absence because that is what the spec states.
  { marker: 'FEED_REFRESH_MS', why: 'T20: the 5s poll constant must NOT be present', absent: true },
  // T21: the dock is a SECOND container for the SAME surface, mounted in the
  // frame's `shell.overlay` seat. The first four markers name the seat, the
  // entry id, and the shared surface class — losing any of them means the dock
  // silently stopped being "the same component in another container". The two
  // pointer-events markers are the click-through acceptance itself; they are
  // INLINE in the source on purpose (the frame's `.overlayLayer > *` rule has
  // the same specificity), so their literal shape is the contract.
  { marker: "'shell.overlay'", why: 'T21: the dock occupies the frame overlay seat' },
  { marker: "'s2s-dock'", why: 'T21: dock entry id (a list-slot entry needs one)' },
  { marker: 's2s-h-panel is-dock', why: 'T21: dock reuses the panel surface class (same component, one container changed)' },
  { marker: "pointerEvents: 'none'", why: 'T21: the dock host does not intercept clicks (click-through kept)' },
  { marker: "pointerEvents: 'auto'", why: 'T21: only the card opts back into pointer events' },
  // ★ Negative marker with a count: the dock must not be a MODAL copy. The mask
  // is the thing that would cover the app under the floating card, so it exists
  // exactly once — in the panel wrapper — and the dock path must never add a
  // second one. A plain presence check cannot tell one mask from two.
  { marker: "className: 's2s-h-mask'", why: 'T21: the modal mask exists exactly once (panel only)', count: 1 },
  // ★ T20 defect lock, found 2026-11-09 by READING the delivered code while the
  // whole gate set was green: `useFeed` never exposed `refresh`, yet the change
  // stream was wired to `feed.refresh` — every pushed frame threw before doing
  // anything, so the stream looked live while the feed stayed stale. Two
  // markers are needed because the defect was a CONTRACT between two places:
  // either half alone can be re-broken by a rename that keeps the other side
  // compiling. (The behaviour is covered separately by tests/client.dock.spec.ts;
  // these two keep the source-level contract from disappearing silently.)
  { marker: 'refresh: refresh', why: 'T20: useFeed EXPOSES the reader the change stream calls (the missing key threw on every frame)' },
  { marker: 'feedRefreshRef.current = feed.refresh', why: 'T20: the change stream is wired to that exposed reader' },
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

  const clientMissing = CLIENT_REQUIRED.filter(({ marker, absent, count }) => {
    const present = client.includes(marker)
    // `count` is the third shape a marker can take: "present, but exactly N
    // times". It exists because the T21 dock shares the panel's surface, so the
    // question is not whether the modal mask exists (the panel needs it) but
    // whether the DOCK added a second one — and a presence check would pass on
    // both the right tree and the wrong one.
    if (count !== undefined) return client.split(marker).length - 1 !== count
    // `absent: true` inverts the check: the marker names something that must NOT
    // be there (the retired 5s poll constant). Without the inversion the list
    // could only ever assert presence, and "the poll is gone" — which is the
    // actual M5 exit condition — would be unrepresentable.
    return absent === true ? present : !present
  })
  if (clientMissing.length > 0) {
    console.error('verify-bundle: lib/client.js markers are wrong:')
    for (const { marker, why, absent, count } of clientMissing) {
      const found = client.split(marker).length - 1
      const reading = count !== undefined
        ? `  [expected exactly ${String(count)}, found ${String(found)}]`
        : absent === true ? '  [unexpectedly PRESENT]' : '  [missing]'
      console.error(`  - ${marker}  (${why})${reading}`)
    }
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

/**
 * Properties of the host half that must survive a rewrite (T20).
 *
 * The byte comparison above already proves the file matches its source; these
 * markers name WHY the change exists, so a future edit that keeps the bytes
 * self-consistent but drops a signal fails here.
 */
const HOST_HALF_REQUIRED = [
  { marker: "'domain/changed'", why: 'T20 signal 1: the ledger subscription is wired' },
  { marker: "'session/event'", why: 'T20 signal 2: conversation growth is wired (the deliberate widening)' },
  { marker: 'text/event-stream', why: 'T20: the change route answers as a stream, not a one-shot JSON' },
  { marker: 'event: ready', why: 'T20: the opening frame proves the subscriber is IN this build (G9)' },
]

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
      + ` (${Buffer.byteLength(hostOut)} bytes, ${HOST_HALF_REQUIRED.length} markers present)`,
    )
    const hostMissing = HOST_HALF_REQUIRED.filter(({ marker }) => !hostOut.includes(marker))
    if (hostMissing.length > 0) {
      console.error('verify-bundle: lib/s2s-history-host.mjs is missing markers:')
      for (const { marker, why } of hostMissing) console.error(`  - ${marker}  (${why})`)
      hostHalfFailed = true
    }
  }
}

if (hostFailed || clientFailed || hostHalfFailed) process.exit(1)

