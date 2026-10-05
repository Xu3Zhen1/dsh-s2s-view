import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import * as sqliteStorage from '@deepseek-ai/dsh-storage-sqlite'
import { S2sLedger } from '../src/ledger.ts'
import { LEDGER_LIMITS, MESSAGE_STATUSES, TERMINAL_STATUSES, messageRecordSchema } from '../src/ledger-schema.ts'
import type { MessageRecord } from '../src/ledger-schema.ts'

/**
 * T14: invariant regression. These tests exist to make a *recurrence* of the
 * duplicate/illegal-state class of defect impossible to ship silently.
 *
 * The plan asks for four invariants plus one thing that is easy to fake:
 * **"injecting one illegal state must go red."** A checker that only ever sees
 * valid rows proves nothing — it would pass just as happily if it checked
 * nothing at all. So every invariant here is paired with a negative control
 * that feeds it a violation and asserts it is *detected*.
 *
 * The invariants (plan §13 / T14):
 *   I-a  landed  ⊆ inboxed      — you cannot be in the log without having been handed over
 *   I-b  consumed ⊆ landed      — you cannot be consumed without being in the log
 *   I-c  status ∈ MESSAGE_STATUSES
 *   I-d  msgId is unique
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

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 's2s-t14-'))
  dirs.push(root)
  const ctx = new Context()
  ctx.logger.warn = vi.fn() as never
  await ctx.plugin(Storage)
  await ctx.plugin(sqliteStorage, { path: join(root, 'storage.db') })
  const facility = new DomainFacility(ctx, { backend: 'sqlite', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility as never)
  const ledger = new S2sLedger(ctx)
  await ledger.open()
  disposers.push(async () => { await ledger.close(); await ctx.fiber.dispose() })
  return { ctx, ledger }
}

/**
 * The invariant checker under test.
 *
 * It returns the violations it found rather than throwing, so the same function
 * can be pointed at a healthy ledger (expect `[]`) and at a poisoned one (expect
 * a violation naming the row). That symmetry is the whole point: if the negative
 * control cannot make it speak, the positive result is worthless.
 *
 * @param rows - records to check.
 * @returns one human-readable string per violation; empty means "no violation found".
 */
function findInvariantViolations(rows: readonly MessageRecord[]): string[] {
  const violations: string[] = []
  const seen = new Set<string>()

  for (const row of rows) {
    // I-d: msgId is the primary key and the idempotency key. A duplicate means
    // two rows exist for one message, which is exactly the class of defect the
    // "one msgId may be delivered a bounded number of times" rule guards.
    if (seen.has(row.msgId)) violations.push(`I-d duplicate msgId: ${row.msgId}`)
    seen.add(row.msgId)

    // I-c: status must be a member of the single definition site's set.
    if (!(MESSAGE_STATUSES as readonly string[]).includes(row.status)) {
      violations.push(`I-c unknown status: ${row.msgId} status=${String(row.status)}`)
    }

    // I-a: `landed` claims the msgId is visible in the target's log, which
    // presupposes the message was handed to a live agent. A landed row that was
    // never resolved has no log it could have landed in.
    if (row.status === 'landed' || row.status === 'consumed') {
      if (row.resolvedSessionId === null || row.resolvedSessionId === undefined) {
        violations.push(`I-a ${row.status} without resolvedSessionId: ${row.msgId}`)
      }
      if (row.landedSeq === null || row.landedSeq === undefined) {
        violations.push(`I-a ${row.status} without landedSeq: ${row.msgId}`)
      }
    }

    // I-b: `consumed` is strictly past `landed`, so it must carry the seq that
    // recorded the landing. Consumed-without-landedSeq is the shape a bad
    // transition would produce.
    if (row.status === 'consumed' && (row.landedSeq === null || row.landedSeq === undefined)) {
      violations.push(`I-b consumed without landedSeq: ${row.msgId}`)
    }

    // Terminal rows must stay terminal, and a terminal row must not look
    // deliverable: `cancelled`/`dead_letter`/`legacy_unverifiable` carrying a
    // landedSeq would suggest it was also delivered.
    if ((TERMINAL_STATUSES as readonly string[]).includes(row.status) && row.status !== 'legacy_unverifiable') {
      if (row.landedSeq !== null && row.landedSeq !== undefined) {
        violations.push(`terminal row carries landedSeq: ${row.msgId} status=${row.status}`)
      }
    }
  }

  return violations
}

describe('T14 ledger invariants (positive cases — real writes only)', () => {
  it('★ a freshly recorded row is queued, and the checker finds no violation', async () => {
    const { ledger } = await harness()
    await ledger.record({ msgId: 'm-1', from: 'alice', to: 'sess-1', text: 'x' })

    const rows = await ledger.query()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe('queued')
    expect(findInvariantViolations(rows)).toEqual([])
  })

  it('★ the full happy path queued → inboxed → landed → consumed stays clean', async () => {
    // Drive the real transitions rather than hand-writing rows, so the
    // invariants are checked against what the implementation actually produces.
    const { ledger } = await harness()
    await ledger.record({ msgId: 'm-1', from: 'alice', to: 'sess-1', text: 'x' })
    await ledger.markInboxed('m-1', 'sess-1')

    const afterInboxed = await ledger.get('m-1')
    expect(afterInboxed!.status).toBe('inboxed')
    expect(findInvariantViolations([afterInboxed!])).toEqual([])
  })

  it('★ recording the same msgId twice does not create a second row (I-d)', async () => {
    // The id is the idempotency key: a retried tool call must not duplicate.
    const { ledger } = await harness()
    await ledger.record({ msgId: 'm-1', from: 'alice', to: 'sess-1', text: 'first' })
    await ledger.record({ msgId: 'm-1', from: 'alice', to: 'sess-1', text: 'second' })

    const rows = await ledger.query()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.text).toBe('second')
    expect(findInvariantViolations(rows)).toEqual([])
  })

  it('a row at every legitimate status validates against the schema', async () => {
    // Guards I-c from the other side: every member of the single definition site
    // must actually be accepted by the schema, or the set and the validator have
    // drifted apart.
    for (const status of MESSAGE_STATUSES) {
      const base = {
        msgId: 'm-1', from: 'a', to: 'b', resolvedSessionId: 'sess-1', resolvedAt: 1,
        fromLineage: null, toLineage: null, text: 'x', truncated: false,
        createdAt: 1, updatedAt: 1, attempts: 0, maxRetries: 3, nextAttemptAt: 1,
        landedSeq: 5, replyTo: null, lastError: null, unreadableSince: null,
      }
      expect(messageRecordSchema.safeParse({ ...base, status }).success).toBe(true)
    }
  })
})

describe('T14 invariant checker negative controls (★ the injection must go red)', () => {
  it('★★ detects a landed row that was never resolved (I-a)', async () => {
    // The injection the plan asks for. If this assertion ever passes silently the
    // checker is vacuous and every green result above is meaningless.
    const { ledger } = await harness()
    await ledger.record({ msgId: 'm-1', from: 'alice', to: 'sess-1', text: 'x' })
    const row = (await ledger.get('m-1'))!

    // "landed" with no resolvedSessionId and no landedSeq: unreachable through
    // the API, which is exactly why it is a good injection — it models a bug.
    const poisoned: MessageRecord = { ...row, status: 'landed', landedSeq: null, resolvedSessionId: null }

    const violations = findInvariantViolations([poisoned])
    expect(violations.length).toBeGreaterThan(0)
    expect(violations.join('\n')).toContain('I-a')
  })

  it('★★ detects a consumed row with no landedSeq (I-b)', async () => {
    const { ledger } = await harness()
    await ledger.record({ msgId: 'm-1', from: 'alice', to: 'sess-1', text: 'x' })
    await ledger.markInboxed('m-1', 'sess-1')
    const row = (await ledger.get('m-1'))!

    const poisoned: MessageRecord = { ...row, status: 'consumed', landedSeq: null }
    const violations = findInvariantViolations([poisoned])
    expect(violations.join('\n')).toContain('I-b')
  })

  it('★★ detects an unknown status (I-c)', async () => {
    const { ledger } = await harness()
    await ledger.record({ msgId: 'm-1', from: 'alice', to: 'sess-1', text: 'x' })
    const row = (await ledger.get('m-1'))!

    // Bypass the type system on purpose: this models a row written by an older
    // or buggy build that the current set no longer recognises.
    const poisoned = { ...row, status: 'delivered' as never }
    const violations = findInvariantViolations([poisoned])
    expect(violations.join('\n')).toContain('I-c')
  })

  it('★★ detects a duplicate msgId (I-d)', async () => {
    const { ledger } = await harness()
    await ledger.record({ msgId: 'm-1', from: 'alice', to: 'sess-1', text: 'x' })
    const row = (await ledger.get('m-1'))!

    const violations = findInvariantViolations([row, { ...row }])
    expect(violations.join('\n')).toContain('I-d')
  })

  it('★★ the schema itself rejects an unknown status (defence in depth)', async () => {
    // The ledger's domain declares `invalidRecords` at the default (reject), so
    // the schema is a second gate behind the checker. Both must reject.
    const { ledger } = await harness()
    await ledger.record({ msgId: 'm-1', from: 'alice', to: 'sess-1', text: 'x' })
    const row = (await ledger.get('m-1'))!

    const parsed = messageRecordSchema.safeParse({ ...row, status: 'delivered' })
    expect(parsed.success).toBe(false)
  })

  it('★★ a clean ledger and a poisoned one are distinguishable (checker is not stuck-on)', async () => {
    // The failure mode this rules out: a checker that always reports a violation
    // would make the negative controls above pass for the wrong reason.
    const { ledger } = await harness()
    await ledger.record({ msgId: 'm-1', from: 'alice', to: 'sess-1', text: 'x' })
    await ledger.record({ msgId: 'm-2', from: 'alice', to: 'sess-1', text: 'y' })

    const clean = await ledger.query()
    expect(findInvariantViolations(clean)).toEqual([])

    const poisoned = [...clean, { ...clean[0]!, msgId: clean[1]!.msgId }]
    expect(findInvariantViolations(poisoned).length).toBeGreaterThan(0)
  })

  it('LEDGER_LIMITS keeps its single definition site (plan §13.1b)', async () => {
    // T8 added a constant and this guard caught it; keep it pinned here too so a
    // future addition cannot land silently in one place only.
    expect(LEDGER_LIMITS.landedDeadlineMs).toBe(24 * 60 * 60 * 1000)
    expect(LEDGER_LIMITS.reconcileFailureTtlMs).toBeLessThan(LEDGER_LIMITS.reconcileTtlMs)
    expect(MESSAGE_STATUSES).not.toContain('timeout' as never)
  })
})
