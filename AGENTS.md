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
  of when you measure.
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
  scope you used. (2026-10-26: two lines, two sessions, twenty minutes apart —
  both searched for a phrase that wrapped across `L150`/`L151`, both got 0, both
  nearly reported a real change as missing. The rule already existed in a skill;
  what failed is that a casual one-off search does not consult a skill.)
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
- **A familiar error string is a search key, not a fresh mystery.** Before you
  start hypothesising about a symptom, grep this repo — `plan/开发计划书-初稿.md`,
  the handoff pages, `AGENTS.md` — for the exact message. The same text often has
  prior form, and the prior write-up usually already says which branches were
  eliminated and why. Re-deriving them costs the investigation and produces the
  same dead ends.
  Two traps in the other direction, both measured here:
  - **Same string, different mechanism.** `already open` appears in this project
    for two unrelated things: `S2sLifecycle` avoiding a double *wake* of one
    session (`'resumed'` vs `'already-live'`, already tested), and the storage
    domain rejecting a second *open* of `s2s` (this one had no teardown and was
    only fixed in `88f0bd7`). Matching words is not matching causes — read the
    mechanism before reusing the diagnosis.
  - **Prior form is not coverage.** A search that finds nothing is also
    information: the ledger-domain release had `already open` / `close()` /
    释放 / teardown / 卸载 all at **0** occurrences in a 190 KB plan, so the
    defect was genuinely new rather than an unexecuted plan item. Say which of
    the two you found.
  (2026-10-29: the exact string `domain 's2s' is already open` had already been
  written up for `30798cf` — a concurrent-open race fixed with a shared in-flight
  promise. It was not consulted, so a dozen tool calls went into ruling out
  multiple-instance mounts, which that write-up had already ruled out.)

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