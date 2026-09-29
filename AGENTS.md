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
