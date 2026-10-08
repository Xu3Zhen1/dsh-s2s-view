import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import * as sqliteStorage from '@deepseek-ai/dsh-storage-sqlite'
import { S2sLedger } from '../src/ledger.ts'
import { LEDGER_LIMITS } from '../src/ledger-schema.ts'

/**
 * T24 mechanism layer: the zombie deadline, driven by an injected `now`.
 *
 * The real host cannot produce this evidence: `sweepIntervalMs` is 3600s and
 * `landedDeadlineMs` is 24h, so a verification window can never observe the
 * transition. Injecting `now` is what makes the *mechanism* checkable at all —
 * and the reviewer's ruling is explicit that this layer and the real-host layer
 * are reported separately, never merged into one "T24 passed".
 *
 * The dangerous failure is not "a zombie was missed"; it is a **wrongful kill** —
 * a row that is merely *not yet* landed being reported as dead. That is why
 * three of the cases below are exclusions, and why they are the ones most worth
 * keeping green.
 *
 * Deliberately NOT asserted here: the sweep callback firing on a real timer.
 * That remains unobserved on the host and must be reported as unobserved.
 */

const dirs: string[] = []
const disposers: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of disposers.splice(0)) {
    try { await dispose() } catch { /* cleanup must not mask the real result */ }
  }
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

async function harness(opts: { readFails?: boolean; events?: readonly unknown[] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 's2s-t24-'))
  dirs.push(root)
  const ctx = new Context()
  ctx.logger.warn = vi.fn() as never
  await ctx.plugin(Storage)
  await ctx.plugin(sqliteStorage, { path: join(root, 'storage.db') })
  const facility = new DomainFacility(ctx, { backend: 'sqlite', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility as never)
  ctx.provide('sessionQuery', {
    readSession: async () => {
      if (opts.readFails === true) throw new Error('log unreadable')
      return { events: opts.events ?? [] }
    },
  } as never)
  const ledger = new S2sLedger(ctx, { timerIntervalMs: 0 })
  await ledger.open()
  disposers.push(async () => { await ledger.close(); await ctx.fiber.dispose() })
  return { ctx, ledger }
}

function tableOf(ledger: S2sLedger) {
  const domain = (ledger as unknown as { domain: { table(n: string): { get(k: string): any; put(k: string, v: any): Promise<void> } } }).domain
  return domain.table('messages')
}

async function inboxed(ledger: S2sLedger, msgId: string, to = 'sess-1') {
  await ledger.record({ msgId, from: 'alice', to, text: 'x' })
  await ledger.markInboxed(msgId, to)
}

const DEADLINE = LEDGER_LIMITS.landedDeadlineMs

describe('T24 mechanism: zombie deadline via injected now', () => {
  it('★ an overdue unreadable row becomes dead_letter, with an auditable reason', async () => {
    const { ledger } = await harness({ readFails: true })
    await inboxed(ledger, 'm-z1')
    const table = tableOf(ledger)
    const row = table.get('m-z1')
    const startedAt = 1_700_000_000_000
    await table.put('m-z1', { ...row, unreadableSince: startedAt })

    const now = startedAt + DEADLINE + 1
    const swept = await ledger.expireZombies({ now })
    expect(swept.expired).toBe(1)

    const after = table.get('m-z1')
    expect(after.status).toBe('dead_letter')
    // The reason must be auditable, not a boolean: how long, and since when.
    expect(String(after.lastError)).toContain('unreadable')
    expect(String(after.lastError)).toContain(new Date(startedAt).toISOString())
    expect(after.unreadableSince ?? null).toBeNull()
  })

  it('★ is idempotent: a second sweep does not re-kill or bump the revision', async () => {
    const { ledger } = await harness({ readFails: true })
    await inboxed(ledger, 'm-z2')
    const table = tableOf(ledger)
    const row = table.get('m-z2')
    const startedAt = 1_700_000_000_000
    await table.put('m-z2', { ...row, unreadableSince: startedAt })

    const now = startedAt + DEADLINE + 1
    expect((await ledger.expireZombies({ now })).expired).toBe(1)
    const afterFirst = table.get('m-z2')

    const second = await ledger.expireZombies({ now: now + 60_000 })
    expect(second.expired).toBe(0)
    const afterSecond = table.get('m-z2')
    expect(afterSecond.status).toBe('dead_letter')
    expect(afterSecond.revision).toBe(afterFirst.revision)
  })

  it('★★ NEGATIVE: unreadableSince=null is NOT a zombie, even long past the deadline', async () => {
    // The most important exclusion. The row is readable and simply does not
    // contain this msgId yet — i.e. "not landed", not "unreachable". Killing it
    // would report a delivery as abandoned when nothing was wrong.
    const { ledger } = await harness({ events: [] })
    await inboxed(ledger, 'm-z3')
    const table = tableOf(ledger)
    const row = table.get('m-z3')
    await table.put('m-z3', { ...row, unreadableSince: null })

    const swept = await ledger.expireZombies({ now: Date.now() + DEADLINE * 10 })
    expect(swept.expired).toBe(0)
    const after = table.get('m-z3')
    expect(after.status).toBe('inboxed')
    expect(after.landedSeq ?? null).toBeNull()
  })

  it('★★ NEGATIVE: a queued row is never a zombie (it was never handed over)', async () => {
    const { ledger } = await harness({ readFails: true })
    await ledger.record({ msgId: 'm-z4', from: 'alice', to: 'sess-1', text: 'x' })
    const table = tableOf(ledger)
    const row = table.get('m-z4')
    expect(row.status).toBe('queued')
    await table.put('m-z4', { ...row, unreadableSince: 1 })

    const swept = await ledger.expireZombies({ now: Date.now() + DEADLINE * 10 })
    expect(swept.expired).toBe(0)
    expect(table.get('m-z4').status).toBe('queued')
  })

  it('★★ NEGATIVE: terminal rows are never re-labelled', async () => {
    const { ledger } = await harness({ readFails: true })
    await inboxed(ledger, 'm-z5')
    const table = tableOf(ledger)
    const row = table.get('m-z5')
    await table.put('m-z5', { ...row, status: 'cancelled', unreadableSince: 1 })

    const swept = await ledger.expireZombies({ now: Date.now() + DEADLINE * 10 })
    expect(swept.expired).toBe(0)
    const after = table.get('m-z5')
    expect(after.status).toBe('cancelled')
  })

  it('★ BOUNDARY: the deadline is INCLUSIVE — exactly at it is already overdue', async () => {
    // Pinned as an assertion rather than left to a comment, because the
    // `<` vs `<=` choice is the kind of thing that silently flips in a refactor.
    //
    // Read off the source, not assumed: `expireZombies` does
    //   `if (now - since < landedDeadlineMs) continue`
    // so at `now - since === landedDeadlineMs` the guard is false and the row
    // IS expired. The boundary is inclusive on the expiring side.
    const { ledger } = await harness({ readFails: true })
    await inboxed(ledger, 'm-z6')
    const table = tableOf(ledger)
    const row = table.get('m-z6')
    const startedAt = 1_700_000_000_000
    await table.put('m-z6', { ...row, unreadableSince: startedAt })

    // One ms SHORT of the deadline: still not overdue.
    const justBefore = await ledger.expireZombies({ now: startedAt + DEADLINE - 1 })
    expect(justBefore.expired).toBe(0)
    expect(table.get('m-z6').status).toBe('inboxed')

    // Exactly at the deadline: expired (inclusive).
    const atDeadline = await ledger.expireZombies({ now: startedAt + DEADLINE })
    expect(atDeadline.expired).toBe(1)
    expect(table.get('m-z6').status).toBe('dead_letter')
  })

  it('★ CONTROL: the sweep can still kill a genuine zombie (exclusions did not disarm it)', async () => {
    // Guards against the exclusions above being satisfied by a sweep that never
    // kills anything. Without this, all the negatives could pass vacuously.
    const { ledger } = await harness({ readFails: true })
    await inboxed(ledger, 'm-z7')
    const table = tableOf(ledger)
    const row = table.get('m-z7')
    await table.put('m-z7', { ...row, unreadableSince: 1 })

    const swept = await ledger.expireZombies({ now: Date.now() + DEADLINE * 2 })
    expect(swept.expired).toBe(1)
    expect(table.get('m-z7').status).toBe('dead_letter')
  })

  it('★ tick() is safe when the ledger was never opened', async () => {
    // The real-host criterion the reviewer accepts: an unopened ledger must
    // return zeros rather than throw. (Constructed WITHOUT open().)
    const root = await mkdtemp(join(tmpdir(), 's2s-t24-closed-'))
    dirs.push(root)
    const ctx = new Context()
    ctx.logger.warn = vi.fn() as never
    const ledger = new S2sLedger(ctx, { timerIntervalMs: 0 })
    disposers.push(async () => { await ledger.close(); await ctx.fiber.dispose() })

    const result = await ledger.tick({ now: Date.now() })
    expect(result).toEqual({ reconciled: 0, expired: 0, examined: 0 })
  })
})
