import { copyFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import * as sqliteStorage from '@deepseek-ai/dsh-storage-sqlite'
import { S2sLedger } from '../src/ledger.ts'
import { messageRecordSchema, type MessageRecord } from '../src/ledger-schema.ts'

/**
 * T25: a backup + schema-upgrade **drill**, not just a document.
 *
 * The discipline this file exists to make可执行 (see
 * `docs/ledger-backup-and-schema-upgrades.md`):
 *   1. the bytes live in a file whose path the *host profile* chooses, not us;
 *   2. additive-only upgrades (optional / defaulted fields) must read an OLD
 *      file without any migration step;
 *   3. the backup must actually be usable to roll back.
 *
 * Step 3 is the one that is easy to fake: asserting "the backup file exists" is
 * not rollback evidence. These tests restore the backup and re-open with the
 * pre-change code path, which is what proves the copy is good.
 */

const dirs: string[] = []
const disposers: Array<() => Promise<void>> = []
afterEach(async () => {
  // Close ledgers before removing their directories: an open sqlite handle makes
  // `rm` fail EBUSY, which surfaces as a red test pointing at cleanup rather
  // than at the code under test.
  for (const dispose of disposers.splice(0)) {
    try { await dispose() } catch { /* cleanup must not mask the real result */ }
  }
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

/** A real sqlite-backed ledger, opened over an explicit `path`. */
async function openLedger(dbPath: string) {
  const ctx = new Context()
  ctx.logger.warn = vi.fn() as never
  await ctx.plugin(Storage)
  await ctx.plugin(sqliteStorage, { path: dbPath })
  const facility = new DomainFacility(ctx, { backend: 'sqlite', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility as never)
  const ledger = new S2sLedger(ctx, { timerIntervalMs: 0 })
  await ledger.open()
  return { ctx, ledger }
}

/** Open, run, and fully close — so the bytes are settled before we copy them. */
async function seed(dbPath: string, fn: (ledger: S2sLedger) => Promise<void>) {
  const { ctx, ledger } = await openLedger(dbPath)
  await fn(ledger)
  await ledger.close()
  await ctx.fiber.dispose()
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

describe('T25 ledger backup + schema upgrade drill', () => {
  it('★ the ledger file is real, non-empty, and its path comes from the caller', async () => {
    // The discipline's first premise: there is exactly one file, and *we* did not
    // choose its location — the profile's backend config did. Here we pass it in
    // explicitly to model that, and assert the bytes actually landed.
    const root = await mkdtemp(join(tmpdir(), 's2s-t25-seed-'))
    dirs.push(root)
    const dbPath = join(root, 'storage.db')

    await seed(dbPath, async (ledger) => {
      await ledger.record({ msgId: 'm-1', from: 'alice', to: 'sess-1', text: 'hello' })
      await ledger.markInboxed('m-1', 'sess-1')
    })

    const st = await stat(dbPath)
    expect(st.size).toBeGreaterThan(0)
    expect(await sha256(dbPath)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('★★ a backup copy is byte-identical, and survives the original being replaced', async () => {
    const root = await mkdtemp(join(tmpdir(), 's2s-t25-backup-'))
    dirs.push(root)
    const dbPath = join(root, 'storage.db')
    const bakPath = join(root, 'storage.db.bak-20261005-000000')

    await seed(dbPath, async (ledger) => {
      await ledger.record({ msgId: 'm-1', from: 'alice', to: 'sess-1', text: 'v1' })
    })
    const before = await sha256(dbPath)

    // The documented backup step: a whole-file copy, then VERIFY (not just copy).
    await copyFile(dbPath, bakPath)
    expect(await sha256(bakPath)).toBe(before)
    expect((await stat(bakPath)).size).toBe((await stat(dbPath)).size)

    // Then the ledger changes — which is what makes the backup worth having.
    await seed(dbPath, async (ledger) => {
      await ledger.record({ msgId: 'm-2', from: 'alice', to: 'sess-1', text: 'v2' })
    })
    expect(await sha256(dbPath)).not.toBe(before)

    // ★ Rollback: restore the backup and confirm the ORIGINAL content is back.
    await copyFile(bakPath, dbPath)
    expect(await sha256(dbPath)).toBe(before)
  })

  it('★★ ★ rollback is real: the restored file re-opens and yields the pre-change rows', async () => {
    // This is the step that separates a drill from a claim. Restoring bytes is
    // not enough — the restored file must actually be *readable by the ledger*,
    // with exactly the rows that existed when the backup was taken.
    const root = await mkdtemp(join(tmpdir(), 's2s-t25-rollback-'))
    dirs.push(root)
    const dbPath = join(root, 'storage.db')
    const bakPath = join(root, 'storage.db.bak-20261005-000000')

    await seed(dbPath, async (ledger) => {
      await ledger.record({ msgId: 'keep-me', from: 'alice', to: 'sess-1', text: 'original' })
      await ledger.markInboxed('keep-me', 'sess-1')
    })
    await copyFile(dbPath, bakPath)

    // A later, unwanted change…
    await seed(dbPath, async (ledger) => {
      await ledger.record({ msgId: 'added-later', from: 'alice', to: 'sess-1', text: 'oops' })
    })

    // …is rolled back.
    await copyFile(bakPath, dbPath)

    const { ctx, ledger } = await openLedger(dbPath)
    disposers.push(async () => { await ledger.close(); await ctx.fiber.dispose() })
    const rows = await ledger.query()
    expect(rows.map((r) => r.msgId).sort()).toEqual(['keep-me'])
    expect(rows[0]!.text).toBe('original')
    expect(rows[0]!.status).toBe('inboxed')
  })

  it('★★ an additive (defaulted) field reads an OLD file with no migration', async () => {
    // The rule the plan cares about: additive-only upgrades must not require a
    // migration step. `revision` (added in T23) is the live precedent — it is
    // `.default(0)`, so a file written before it existed still loads.
    const root = await mkdtemp(join(tmpdir(), 's2s-t25-additive-'))
    dirs.push(root)
    const dbPath = join(root, 'storage.db')

    await seed(dbPath, async (ledger) => {
      await ledger.record({ msgId: 'old-row', from: 'alice', to: 'sess-1', text: 'legacy' })
    })

    // Model the pre-change shape: parse a row that has NO `revision` key at all,
    // exactly as a row written before that field existed would look.
    const { ctx, ledger } = await openLedger(dbPath)
    disposers.push(async () => { await ledger.close(); await ctx.fiber.dispose() })
    const stored = (await ledger.get('old-row'))! as Record<string, unknown>
    const withoutNewField = { ...stored }
    delete withoutNewField.revision

    const parsed = messageRecordSchema.safeParse(withoutNewField)
    expect(parsed.success).toBe(true)
    // The default is what makes the upgrade non-breaking.
    expect((parsed as { data: MessageRecord }).data.revision).toBe(0)
  })

  it('★★ a BREAKING change is rejected loudly rather than silently dropped', async () => {
    // The other half of the discipline: `invalidRecords` stays `reject`, so a row
    // the schema no longer understands fails the read instead of vanishing. A
    // silently dropped row would erase the very evidence the ledger exists for.
    const base = {
      msgId: 'm-1', from: 'a', to: 'b', resolvedSessionId: 'sess-1', resolvedAt: 1,
      fromLineage: null, toLineage: null, text: 'x', truncated: false,
      createdAt: 1, updatedAt: 1, attempts: 0, maxRetries: 3, nextAttemptAt: 1,
      status: 'queued', landedSeq: null, replyTo: null, lastError: null, unreadableSince: null,
    }
    // An unknown status (what a breaking change looks like from the old data's side).
    expect(messageRecordSchema.safeParse({ ...base, status: 'was-renamed' }).success).toBe(false)
    // A required field removed.
    const missingText = { ...base } as Record<string, unknown>
    delete missingText.text
    expect(messageRecordSchema.safeParse(missingText).success).toBe(false)
    // Control: the unmodified shape still validates, so the checks above are not
    // passing merely because the schema rejects everything.
    expect(messageRecordSchema.safeParse(base).success).toBe(true)
  })

  it('★ the documented path is NOT invented: this deployment has no ledger file', async () => {
    // Guards the document's central honest claim. `src/ledger.ts` never sets a
    // path — it reads `storageDomain` from the host — so on a host without the
    // storage family there is no file to back up. If a future change made the
    // ledger self-host a file, this assertion's premise should be revisited
    // deliberately rather than by accident.
    const src = await readFile(join(process.cwd(), 'src', 'ledger.ts'), 'utf8')
    expect(src).toContain("this.ctx.get('storageDomain')")
    // No self-chosen filesystem path in the ledger.
    expect(src).not.toMatch(/join\([^)]*storage\.db/)
  })
})
