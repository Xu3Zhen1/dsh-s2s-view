# AGENTS.md — working rules for this repository

`dsh-s2s` is a same-host session-to-session interconnect plugin for DSH
(DeepSeek Harness). It is a **cordis plugin**: in-process broker, no ports, no
websocket, sessions addressed by title, dormant sessions awakenable.

Read `REPOSITORY.md` for the layout and `USAGE.md` for the tool surface.
This file holds the rules that are **not** obvious from the code.

---

## 1. Three invariants (never violate)

- **I1 — Delivery is not "success" until confirmed.**
  A tool return value must never claim more than actually happened. Writing into
  a target's inbox is *not* delivery; only the message appearing in the target's
  session log is. Wording must track the real state (`Queued` / `Delivered` /
  `Replied`), never an unconditional "Delivered".

- **I2 — The queue must be durable and recoverable.**
  A crash must not lose queued work, and startup must repair interrupted state
  (rows stuck mid-delivery are reset; terminal states such as `dead_letter`
  must **not** be revived).

- **I3 — Never write into another session's log.**
  This is the hard red line (`SOLUTION.md` §8.3). The only legitimate read is
  `sessionQuery.readSession()` — it replay-validates and does **not** make the
  session live.

Derived invariants worth keeping in mind: a resolved session id must exist in
the current corpus (no ghost sessions), and one `msgId` may be delivered a
bounded number of times.

---

## 2. Two environment facts that will bite you

- **`docs/` is in `.gitignore` but several files under it are already tracked.**
  ⇒ A newly added document **silently fails to enter the repo**. Use
  `git add -f <path>` for anything under `docs/`, and verify with
  `git ls-files <path>`.

- **Byte-for-byte comparison against the deployment depends on `eol=lf`.**
  `.gitattributes` normalizes line endings; the browser half is hand-written JS
  whose whitespace is part of the CSS string literals, so re-indenting it
  changes bytes. Do not reformat `src/client/index.js`.

---

## 3. Build chain (do not shortcut it)

```
pnpm run build   # tsc -p tsconfig.json && tsdown && node scripts/build-history-surface.mjs && node scripts/verify-bundle.mjs
```

- The `tsdown` entry is **`lib/types/index.js`** (the `tsc` output), **not
  `src/`**. Running `tsdown` alone re-emits the *previous* build — this has
  caused a real incident. Always go through `pnpm run build`.
- `lib/` is generated and git-ignored; it is produced by `prepare` on install.
- The client half is assembled **by package name** (`packages/client/modules`
  resolves a bare package name, then `dsh.client.platform === 'web'`). Subpath
  specifiers are **skipped silently** and assembly failure is **silent**. Never
  rename the package.

## 4. Verification gates (see `plan/开发计划书-初稿.md` §5 for the full table)

| Gate | Meaning |
|---|---|
| G1 | `pnpm run typecheck` → 0 errors |
| G2 | `pnpm test` → never below the current baseline (125 at M0 entry; 132 after M0) — only ever add |
| G3 | `pnpm run build` all green |
| G4 | Client-half assembly is ACTIVE (failure is silent — verify explicitly) |
| G5 | Host route returns non-404 |
| G6 | Product byte anchors match (or the anchor is updated with a stated reason) |
| G7 | Live end-to-end: message lands in the target's log |
| G8 | Wake fidelity: waking a session must not lose its preset layer (**test with a dormant target** — a live target is a tautology) |
| G9 | No silent degradation: every fallback path must leave an observable trace |

- `pnpm test` may fail with `spawn EPERM` under a restricted sandbox (vitest
  spawns children over pipes). That is a sandbox artifact, **not** a code fault —
  re-run with wider permissions before believing it.

## 5. Working rules learned the hard way

- **Hand-written artifacts must be copied into the repo in the same turn they
  are produced.** A 456-line source file once vanished from all three trees
  because it was never committed; it had to be rebuilt byte-by-byte from session
  logs. `.gitignore`d generated output is fine — hand-written source is not.
- **Use the full build chain, then verify the artifact.** "The tests pass" is not
  evidence that the bundle contains your change; grep the built `lib/index.js`.
- **A judge criterion must cite data that actually exists.** In this repo a
  criterion once read an event that is emitted in-process and *never persisted*,
  so it silently never fired. Count the event first; zero occurrences means the
  criterion cannot work.
- **Distinguish checking against yourself from checking against a reference.**
  "Before vs after" (self-consistent) cannot detect that you built the *wrong*
  thing. Compare against a freshly created object of the same kind.
- **Report counts with their scope, timestamp, and definition.** Live data
  drifts; the same probe reads 209 then 215. Prefer claims that hold regardless
  of when you measure. **The same applies to format claims: name where the
  standard comes from.** A line-width or style-conformance report means nothing
  without a stated rule; if the rule lives in a config file or a linter, cite it —
  and if there is none, then "I wrapped at 80 columns" is a preference, not a
  finding. Measured 2026-11-02: "no over-long lines" was reported for this file
  against an invented 80-column threshold. The repo has no `.editorconfig`, no
  prettier or markdownlint config and no lint script, and the file itself runs to
  135 columns in places. The threshold needed a source before the claim carried
  any weight — and the "fix" that followed was decoration against a rule that did
  not exist.
- **When the plausible counting bases disagree, do not pick one — say so.** A
  count is only meaningful against a definition. If "how many" comes out as 6 by
  leftover artefacts, 5 by affected working trees and 2 by at-risk commits, the
  honest statement is that no single number exists, plus the bases and why they
  differ. Picking one and silently dropping the others is how an unverifiable
  number gets quoted as fact later. (2026-10-26: a rule about not writing
  unverified claims shipped with an unverified count of incidents — no test can
  catch that, because a wrong number in a document turns nothing red.)
- **A `0` from a line-oriented search is not evidence that a string is absent.**
  Whatever tool you reach for first — `Select-String`, `grep` without `-z`,
  `awk` — matches per line, so a needle that spans a line break always returns
  0. That `0` looks exactly like a confirmed absence and invites you to act on
  it. Normalise whitespace over the whole file before concluding, and state the
  scope you used — **including which revision**, because a needle quoted from an
  uncommitted change reads 0 against `HEAD` and non-zero against the tree.
  **Name the case sensitivity too, and hold it constant.** The two scopes people
  reach for differ there by default: `Select-String` matches case-insensitively
  while a bare `[regex]::Matches` does not. So a needle differing only in case
  reads 1 line-wise and 0 normalised — a pair that looks exactly like a line break
  if case is left implicit. Measured 2026-11-02: a check reported as "normalised 0,
  line-wise 1" was read as an anomaly, and the cause was capitalisation, not
  wrapping. Two scopes that differ in more than one dimension cannot isolate
  either cause, so a "double-scope" comparison is only meaningful once every axis
  except the one under test is pinned.
  When the check covers several needles, **list them**. "The other three were
  fine" names nothing, and it reads as a statement about all the rest when it is
  only a statement about that list — the same finite-sample-as-completeness-claim
  failure recorded above, arriving in the reporting instead of the measuring.
  **Two different causes produce that `0`, and they need different responses.**
  Either the needle wraps (normalise and it appears), or **the needle is
  misremembered** (normalise and it still reads 0, while the region holds a
  similar-but-different phrase) — so a zero *after* normalising is not yet
  evidence of absence; read the region first.
  And a third trap that shows up only once you write the example down: **quoting a
  needle verbatim into the document makes that needle permanently self-matching.**
  A rule that cites "the string I searched for" can never be re-checked with that
  string again — the hit is the citation. The measured case is spelled out here
  **on purpose**, because deleting the needle would delete the evidence: a needle
  typed wrongly as `that is how this rule gets …` read 0 against the revision
  before this paragraph existed, and reads 1 against any tree that quotes it —
  including this one, where the hit is this sentence. The self-match is expected
  and is the point; an unexplained one is what misleads. So quote a needle if you
  must, but say which revision each reading came from, label the self-match, and
  re-check against a revision that predates the example — otherwise the example
  destroys its own evidence.
  (2026-10-26: two lines, two sessions, twenty minutes apart — both searched for
  a phrase that wrapped across `L150`/`L151`, both got 0, both nearly reported a
  real change as missing. The rule already existed in a skill;
  what failed is that a casual one-off search does not consult a skill.)
- **A hit is not an attribution: after a merged search, re-search each needle on
  its own.** `a|b` returning a line tells you *something* matched, not *which
  something*. Before citing a hit as evidence for a particular term, run that
  term alone over the same scope. This is adjacent to the rule above but
  distinct: that one is about **scope** (where you looked), this is about
  **attribution** (what matched).
  Measured 2026-10-29, `docs/ledger-backup-and-schema-upgrades.md`:
  ```
  Select-String -Pattern '30798cf|already open'   → 1 hit, L20
  same line, each needle tested separately        → '30798cf' True
                                                    'already open' False
  ```
  That hit was reported as "docs/ contains `already open`" and sent a reviewer
  chasing a file that has zero occurrences of it. Both lines of this session then
  made the mirror-image error: one side assumed *where* a prior write-up lived
  without checking, the other assumed *which* needle a hit belonged to without
  checking. Same root — **the evidence existed, but its link to the conclusion
  was never verified.**
- **"The reading was right, the question was wrong" has four distinct causes,
  and they need four different guards.** Do not lump them into "unclear scope":
  - *Scope* — the conclusion depends on an undeclared needle, range, case or
    unit. Guard: state the scope, and report every plausible scope side by side.
  - *Baseline* — every reading is correct but compared against the wrong
    interval or the wrong starting state. Guard: name the baseline, not just the
    reading.
  - *Time* — a single sample treated as a standing fact. Guard: say "as of", and
    say whether it can be re-sampled.
  - *Object* — the number is right but about something other than the thing
    asked (an mtime that shows last-write, not content read; a stale reason kept
    after the fact changed). Guard: name what the probe actually measures.
  Declaring scope fixes the first and nothing else. Collapsing all four into one
  root is how you end up believing you have guarded ②③④ after only reading a
  rule about ①.
- **Every observable field needs a stated value→fact table, or it cannot be read.**
  This is the same gap as the four causes above, but at the *design* end rather
  than the reading end: a guard that says "absence of X is healthy" is not
  readable unless it also says which facts produce absence. Measured four times
  in one session, and it was a different field each time:
  ```
  domainReleaseError unset   ⇒ "released cleanly" OR "teardown never ran"
                               — absence alone cannot tell them apart
  domainReleased >= 1        ⇒ "happened at least once" but never "nothing skipped";
                               no reference value existed to compare against
  "N - M is normally 0 or 1" ⇒ an empirical range, not a criterion: 1 could be
                               "one instance still holds the domain" or "one
                               release was skipped and the balance hid it"
  s2s.json mtime stale       ⇒ read as "the ledger is not writing"; it was a
                               batched flush, and the sample predated the write
  ```
  The guard, in two parts: **① when you add a counter or a diagnostic field, say
  what each of its values means — including the boring value.** A counter with no
  "should be N, because …" is a number, not a criterion. **② when a check can
  only prove "something happened" and not "nothing was missed", say so** — that
  is the difference between "the release ran once" and "every unload released",
  and only the latter licenses a completeness claim. Two-sided counters exist for
  exactly this: one side alone always leaves the denominator unstated.
  Corollary that keeps biting: **a freshly started process with `released = 0`
  is not evidence that release never runs** — nothing has been unloaded yet.
  Same shape as "absent ≠ not executed", one level up.

  **③ A criterion is only as readable as its least-readable term.** If a judgment
  compares two quantities, both have to come from the same surface. A term that
  must be reconstructed by hand — from a config file, or from memory — turns a
  machine-checkable criterion back into a human guess.
  Measured 2026-11-01: the completeness rule was written as
  `acquired - released == live instances`, but nothing reported the live instance
  count, so the right-hand side had to be read out of `cordis.patch.yml`. That is
  wrong in the one case the rule exists for: on a reload or re-composition the
  config still lists one mount while two instances are alive, so a config-derived
  denominator keeps the check green exactly when a domain is still held. Fixed by
  making the count a runtime field (`mountedInstances`).
  So: **when a criterion needs a quantity, ask whether that quantity is on the
  same surface as the rest of the evidence.** If not, either expose it or say
  plainly which part of the judgment is human-supplied.

  Two limits of paired counters, worth stating so nobody reads more into them:
  a net difference is a **conservation check, not a pairing proof** — 5 acquired,
  3 released, 2 live passes even if one release acted on the wrong domain
  (cross-instance mismatch); proving pairing needs each release to carry the
  identity of the acquisition it answers. And a count proves *occurrence*, not
  *correctness* — `released > 0` never says the release did the right thing.

  The same gap has a periodic form: **"it fired N times in a row" is not "it fires
  reliably".** Every additional interval you assert costs one more sample, so any
  claim of periodicity must state how many intervals were observed. Measured
  2026-11-02: the hourly sweep was finally seen to fire (first tick at
  `procStart + 3601.4s`, `reconciled=8`) — enough to say "it fired at least once",
  not "it fires hourly". The two families are the same failure — **a finite sample
  carrying a completeness claim** — and the fix is the same: publish the count.

  **④ A value that cannot be produced inside its observation window is not a
  sample to wait for — it is an unreadable field.** Say which window, explicitly.
  Measured 2026-11-02: `domainReleasedCount` advances only when a plugin instance
  is unloaded, and `ledgerDiagnostics` is a module-level singleton. Inside one
  host process the only unload is at host exit — where the increment does happen,
  but the process ends before anything can read it, and the next start begins at
  zero. So `released > 0` needs a mid-process re-composition, which cannot be
  triggered from outside. "Wait for a reload" is not a plan; the evidence's
  acquisition condition is not ours to arrange.
  **The window boundary must be named**, or "cannot be produced" and "has not
  arrived yet" stay indistinguishable — and `"from now on"` is not a window: under
  it, `cannot be produced` degrades into `might still arrive`, which is exactly
  what this rule exists to prevent. A field like this is still worth keeping (it
  is live the moment a re-composition happens, and it caught the real defect
  before), but the claim resting on it must be withdrawn rather than deferred:
  say "not obtainable here", not "not obtained yet".
  And "cannot be produced" must be **mechanical**, not merely *not yet observed*.
  The test: can you name the event that would produce it, and is that event inside
  our control? Here it can be named (`a mid-process re-composition`) and it is
  not (`nothing we run triggers one`), so the conclusion is mechanical. If you
  cannot name the missing event — "it hasn't shown up in the logs yet" — that is a
  thin sample, not an impossibility, and calling it one is how this rule gets
  used as an excuse to stop looking.
- **A familiar error string is a search key, not a fresh mystery.** Before you
  start hypothesising about a symptom, search the **whole workspace** for the
  exact message — `plan/**` (**including the 回执/复核/送审/裁定 files**),
  `docs/**`, the handoff pages, `AGENTS.md`. The same text often has prior form,
  and the prior write-up usually already says which branches were eliminated and
  why. Re-deriving them costs the investigation and produces the same dead ends.
  **Where the records actually live: the `回执`/`复核` files, not the plan.**
  Measured 2026-10-29 on the string `already open`: `plan/回执-*.md` = **1 hit**,
  `plan/开发计划书-初稿.md` (190 KB) = **0**. The plan records *conclusions*; the
  receipts record *investigations*, including what was ruled out. Searching only
  the plan returns 0 and reads as "no prior form" — which is the failure this
  rule exists to prevent, inverted.
  Two traps in the other direction, both measured here:
  - **Same string, different mechanism.** `already open` appears in this project
    for two unrelated things: `S2sLifecycle` avoiding a double *wake* of one
    session (`'resumed'` vs `'already-live'`, already tested), and the storage
    domain rejecting a second *open* of `s2s` (this one had no teardown and was
    only fixed in `88f0bd7`). Matching words is not matching causes — read the
    mechanism before reusing the diagnosis.
  - **Prior form is not coverage.** A search that finds nothing is also
    information: the ledger-domain release had `already open` / `close()` /
    释放 / teardown / 卸载 all at **0** occurrences in the 190 KB plan, so that
    defect was genuinely new rather than an unexecuted plan item. Say which of
    the two you found — but only after searching the receipt files too.
  (2026-10-29: the exact string `domain 's2s' is already open` had already been
  written up in `plan/回执-审查会话-30798cf重启验收判据.md` L77 — a concurrent-open
  race fixed with a shared in-flight promise. It was not consulted, so a dozen
  tool calls went into ruling out multiple-instance mounts, which that write-up
  had already ruled out. The first version of *this very rule* then cited the
  190 KB plan as the place to look; a reviewer checked and found 0 hits there.
  A rule about not repeating past investigations had mis-stated where the past
  investigation was written down.)

---

## 6. Session identity is NOT inherited — read it, then claim it

This workspace is a multi-session effort (implementation line, git line, review line, plan
owner, successors). A new session inherits **none of that**: the role file sits outside the
auto-loaded instruction chain, so nothing brings it in.

- **Automatic (and the only automatic part)**: the Team identity line
  (`You are the Team Lead named "lead".`), injected from *live Team membership*. If the
  session is not a live Team member, that section is simply absent — and nothing reports it.
  It says *what the harness thinks you are*, never *which line of this project you hold*.
- **Not automatic**: which line you are, your write scope, and who currently holds a role.
  Those live in `..\handoff\接手页-<date>.md` (take the newest) and the whiteboard under
  `%USERPROFILE%\.dsh\memory\workspaces\--G--dsh-s2s-view--\handoff\PLAN.md`.
- **So, before the first edit of every session**: read the newest handoff page, then the
  whiteboard, then claim an identity. Do not infer your role from the prompt's wording.

**Claiming is a written act, not a greeting.** Append to the handoff page:

```
本角色自 <YYYY-MM-DD HH:mm> 起由 <8-hex id> 持有；旧 id <old-id> 停止出裁定。
```

- Sessions are addressed by an 8-hex id prefix. A role-table row naming an old id is **not**
  evidence that the old session is still the holder — it is usually stale text.
- **A stale pointer fails silently**: delivering to an old id still returns a success receipt.
  Verify against the receipt's actual title / target state, not against "it looked sent".
- If you cannot find a row for your own id anywhere, that is the defect, not a formality —
  an unregistered holder reads as *passing* checks that never mention it. Register, then work.

Cross-line rules for this file's §1: I1 (never claim more than happened) applies to identity
too — do not write that a role was handed over until the new holder has written its own claim.

---

## 7. Multiple lines share one working tree — claim a file before you mutate it

This repository is worked by several concurrent sessions (implementation, git, cross-review)
in the **same** checkout. On 2026-10-26 this cost us repeatedly: a mutation injected for
verification was left in the tree while another line ran its gate; in at least two of those
episodes a leftover string sat one `git add -A` away from being committed as if it were the
fix (one of them already staged); and a temporary probe file was picked up by the test runner
and inflated the suite count. **No single incident count is asserted here on purpose** —
"how many" depends on the unit (leftover artefacts / affected trees / at-risk commits) and
the three bases do not agree. The enumerated list with per-item evidence lives in the
handoff page.

**`git checkout -- <file>` and `git restore <file>` are WRITE operations, not recovery.** They
overwrite whatever is there without asking. One line "restoring" a file silently erased another
line's in-flight mutation, and the other line's own "restore verified = true" then passed
*because the file was already clean* — it could not tell "I restored it" from "someone else did".
If you are about to run either command on a file you did not just write, claim it first.

The protocol (**six** steps; all six ran end to end on 2026-10-26, and step 6 was added
*by* that run — the hand-back opened a 115-second ownerless window in which a fourth
party mutated the file nobody had claimed):

1. **Declare before mutating.** Say which files, the **baseline blob** you captured, the
   **sha16** it corresponds to, a deadline, and what you will NOT touch.
   ```
   占用 <file> 基线 blob=<git hash-object> sha16=<16hex>/<bytes> 至 <HH:mm>
   还原后应达 = 同上 blob/sha16 ｜ 不动 = <files>
   ```
2. **Get an explicit ack** from whoever else is editing. A silent tree is not an ack.
3. **Work only inside the window**, on exactly the declared files.
4. **Self-prove the restore**, do not assert it:
   ```
   git diff HEAD -- <file>            → EMPTY
   git hash-object <file>             → equals the baseline blob you declared
   git status --porcelain             → only the other line's expected entries remain
   ```
   Note the asymmetry: a **mismatch proves** someone else wrote; a **match only shows no
   coarse interference** (mtimes are forgeable, so this is evidence, not proof).
5. **The other line independently re-checks** the blob before committing.
6. **Announce the hand-back with the restored blob.** Releasing the window silently leaves it
   ownerless: on 2026-10-26 a restore at `20:57:06` and an unrelated mutation at `20:59:01`
   fell into exactly that 115-second gap, and nobody had declared the file in between.
   ```
   已归还 <file> blob=<git hash-object> ｜ 此后任何写入（含 checkout/restore）须重新声明
   ```

**Before any commit, the staging set must be a subset of your own declared expectation list.**
```
residual@<HH:mm:ss> HEAD=<sha> : ?? = […] ｜ M = […] ｜ src/ diff = […]
expected for this batch = […]      ← anything outside it: STOP and ask who owns it
```
Anything outside the list is **not** automatically yours to commit. This check has already
prevented one commit that would have silently reverted a verified fix.

Two limits worth stating: the protocol binds only lines that know it (hence it lives here, in
the auto-loaded file, not in a handoff page), and it cannot attribute blame when two lines
mutate the same file inside overlapping windows — so **avoid overlapping windows entirely**.

Related, and the same failure shape: `mtime` cannot prove what a file *contained* when read,
and a hash compared across tools is only meaningful if both sides hash **bytes** (PowerShell
`Out-String` re-wraps lines; use `Get-FileHash` or `git hash-object` against the file).

**Use file-level backup + copy-back for mutations, not `git checkout`/`git restore`.**
A ban without a substitute gets routed around: `Copy-Item` the file aside, mutate, copy it
back, then prove it with `git hash-object`. Reserve `git checkout -- <file>` for the single
case it is actually for — reverting your *own* uncommitted work in a tree you alone hold.

**`git stash` is the same shape.** It rewrites the working tree, and its name reads like
"archive" rather than "overwrite" — which makes it the easiest of the three to mistake for a
safe read. If you must shelve work in a shared tree, copy the files aside instead.