import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
// Import the module namespace, not just `apply`: cordis reads the plugin's
// `name`/`inject` metadata off the mounted object, and `inject: ['storage']` is
// what lets the backend reach `ctx.storage`.
import * as sqliteStorage from '@deepseek-ai/dsh-storage-sqlite'
import {
  LEDGER_DOMAIN,
  LEDGER_DOMAIN_VERSION,
  LEDGER_LIMITS,
  MESSAGE_STATUSES,
  MESSAGES_TABLE,
  SESSIONS_TABLE,
  ledgerDomain,
  messageRecordSchema,
  sessionRecordSchema,
  type MessageRecord,
} from '../src/ledger-schema.ts'

const dirs: string[] = []
afterEach(async () => {
  // The sqlite backend keeps the DB (plus -shm/-wal) open until its fiber is
  // disposed; each test disposes its own context, so removal is safe here.
  // `force` also absorbs any lingering handle on platforms that lag the close.
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

/** Open a storage context + sqlite backend + domain facility over `root`. */
async function mountFacility(root: string) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  // `dsh-storage-sqlite` rides node:sqlite, so no native build is needed.
  // (`dsh-storage-json` is not installed in this repo.)
  await ctx.plugin(sqliteStorage, { path: join(root, 'storage.db') })
  // The backend registers itself under `'sqlite'` (its own service key), which
  // is not the same string as the plugin's `name`.
  const facility = new DomainFacility(ctx, { backend: 'sqlite', routes: {} })
  ctx.storage.mount('domain', facility)
  return { ctx, facility }
}

/**
 * Open the real ledger domain over the real JSON backend.
 *
 * The plan's T4 acceptance is "a unit test can open it", so this deliberately
 * uses the production vocabulary (`defineDomain` + `DomainFacility.open`) and a
 * real on-disk backend rather than a hand-rolled stub — a stub would only prove
 * the zod schema parses, not that the domain declaration is acceptable to the
 * runtime.
 */
async function openLedger(root?: string) {
  const dir = root ?? await mkdtemp(join(tmpdir(), 's2s-ledger-'))
  if (root === undefined) dirs.push(dir)
  const { ctx, facility } = await mountFacility(dir)
  const domain = await facility.open(ledgerDomain)
  return { ctx, domain, root: dir }
}

function validMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Date.now()
  return {
    msgId: 'm-1',
    from: 'alice',
    to: 'bob',
    text: 'hello',
    truncated: false,
    createdAt: now,
    updatedAt: now,
    attempts: 0,
    maxRetries: LEDGER_LIMITS.maxRetries,
    nextAttemptAt: now,
    status: 'queued',
    ...overrides,
  }
}

describe('ledger domain spec (T4)', () => {
  it('opens the real domain over the sqlite backend', async () => {
    const { ctx, domain } = await openLedger()
    // `Domain` exposes `name`; there is no public `spec` property.
    expect(domain.name).toBe(LEDGER_DOMAIN)
    expect(ledgerDomain.version).toBe(LEDGER_DOMAIN_VERSION)
    const messages = domain.table(MESSAGES_TABLE)
    expect(messages.size).toBe(0)
    expect([...messages.keys()]).toEqual([])
    await domain.close()
    await ctx.fiber.dispose()
  })

  it('round-trips a message through durability and reopens it', async () => {
    const { ctx, domain, root } = await openLedger()
    await domain.table(MESSAGES_TABLE).put('m-1', validMessage() as unknown as MessageRecord)
    expect(domain.table(MESSAGES_TABLE).get('m-1')).toMatchObject({ msgId: 'm-1', status: 'queued' })
    await domain.close()
    await ctx.fiber.dispose()

    // Reopen the same directory: the record must survive, or the ledger is not
    // the durable index the plan requires.
    const reopened = await openLedger(root)
    expect(reopened.domain.table(MESSAGES_TABLE).get('m-1')).toMatchObject({ msgId: 'm-1', text: 'hello' })
    await reopened.domain.close()
    await reopened.ctx.fiber.dispose()
  })

  it('declares every lifecycle state, and no state without a transition', () => {
    // §12.3 is the prose state machine; this pins the value set so a state
    // cannot be added or removed without the plan and the schema moving together.
    expect([...MESSAGE_STATUSES].sort()).toEqual([
      'cancelled', 'consumed', 'dead_letter', 'delivering',
      'inboxed', 'landed', 'legacy_unverifiable', 'queued',
    ])
    // `timeout` was removed: it had no inbound transition (expiry routes to
    // queued or dead_letter), so it could never be written.
    expect(MESSAGE_STATUSES).not.toContain('timeout')
  })

  it('rejects an unknown status rather than storing it', () => {
    expect(messageRecordSchema.safeParse(validMessage({ status: 'timeout' })).success).toBe(false)
    expect(messageRecordSchema.safeParse(validMessage({ status: 'nonsense' })).success).toBe(false)
    expect(messageRecordSchema.safeParse(validMessage()).success).toBe(true)
  })

  it('accepts null for the optional fields the plan marks nullable', () => {
    const parsed = messageRecordSchema.safeParse(validMessage({
      resolvedSessionId: null,
      resolvedAt: null,
      fromLineage: null,
      toLineage: null,
      landedSeq: null,
      replyTo: null,
      lastError: null,
      unreadableSince: null,
    }))
    // These are the P2 transition values: lineage is contractually null until
    // P3, and a cleared `unreadableSince` must be storable as an explicit null.
    expect(parsed.success).toBe(true)
  })

  it('requires a non-empty msgId, since it is the primary and idempotency key', () => {
    expect(messageRecordSchema.safeParse(validMessage({ msgId: '' })).success).toBe(false)
    expect(messageRecordSchema.safeParse(validMessage({ msgId: 'm-1' })).success).toBe(true)
  })

  it('requires integers where the plan says so, and rejects negatives', () => {
    expect(messageRecordSchema.safeParse(validMessage({ attempts: -1 })).success).toBe(false)
    expect(messageRecordSchema.safeParse(validMessage({ attempts: 1.5 })).success).toBe(false)
    expect(messageRecordSchema.safeParse(validMessage({ maxRetries: -1 })).success).toBe(false)
  })

  it('keeps session cache rows parseable and defaults openTurn', () => {
    const parsed = sessionRecordSchema.safeParse({
      sessionId: 'session-1',
      workspaceDir: 'G:\\ws',
      lastSeenAt: 1,
    })
    expect(parsed.success).toBe(true)
    // Defaulted, so a writer that omits it does not produce an invalid record.
    expect(parsed.success && parsed.data.openTurn).toBe(false)
  })

  it('routes messages and sessions to distinct tables', async () => {
    const { ctx, domain } = await openLedger()
    await domain.table(SESSIONS_TABLE).put('session-1', {
      sessionId: 'session-1',
      workspaceDir: 'G:\\ws',
      lastSeenAt: 1,
      openTurn: false,
    })
    expect(domain.table(SESSIONS_TABLE).size).toBe(1)
    expect(domain.table(MESSAGES_TABLE).size).toBe(0)
    await domain.close()
    await ctx.fiber.dispose()
  })

  it('exposes one definition site for every numeric constant', () => {
    // §13.1b: constants live here and nowhere else. Pin the values so a change
    // to the plan's table cannot drift from the code silently.
    expect(LEDGER_LIMITS).toEqual({
      landedDeadlineMs: 24 * 60 * 60 * 1000,
      maxRetries: 3,
      retentionDays: 30,
      retentionRows: 10000,
      reconcileTtlMs: 5000,
      maxSessionsPerRequest: 8,
      rollTimeoutMs: 600000,
      textMaxChars: 8000,
      nextAttemptAtClampMs: 24 * 60 * 60 * 1000,
    })
  })
})
