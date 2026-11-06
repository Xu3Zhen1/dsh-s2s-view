import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import * as sqliteStorage from '@deepseek-ai/dsh-storage-sqlite'
import { apply as s2sApply, S2sLifecycleService } from '../src/index.ts'
import { S2sLedger } from '../src/ledger.ts'

/**
 * Batch 43: the §12.3 delivery gate on the DORMANT path.
 *
 * Why a separate file (and not an addition to `lifecycle.spec.ts`): that file's
 * existing assertions are the contract this batch must not weaken — `drain()` only
 * advances a row once a real hand-over happened, and a policy refusal re-queues.
 * Keeping the new cases here means a red here is this batch's fault, while a red
 * there is a broken contract. The two are not interchangeable, so they do not share
 * a file.
 *
 * The harness is its own copy on purpose: importing `ledger-recovery.spec.ts`'s
 * would let a change over there silently alter what these cases measure.
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

interface Harness {
  ctx: Context
  lifecycle: S2sLifecycleService
  ledger: S2sLedger
  followups: unknown[]
  goLive: () => Promise<void>
  agent: { followup: (message: unknown) => void; inject: (message: unknown) => void }
}

/**
 * A real sqlite-backed ledger under a real lifecycle service.
 *
 * `autoResume: 'deny'` keeps `queueForDormant` from waking anything, so the message
 * stays in the mailbox by itself; `goLive()` then flips the agent lookup so the NEXT
 * `drain()` is the one that attempts the hand-over. That separation matters: it is
 * the difference between "the enqueue path" and "the delivery path", and only the
 * latter is under test here.
 */
async function harness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 's2s-b43-'))
  dirs.push(root)
  const mailboxDir = await mkdtemp(join(tmpdir(), 's2s-b43-mail-'))
  dirs.push(mailboxDir)

  const ctx = new Context()
  await ctx.plugin(Storage)
  await ctx.plugin(sqliteStorage, { path: join(root, 'storage.db') })
  const facility = new DomainFacility(ctx, { backend: 'sqlite', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility as never)

  const followups: unknown[] = []
  const agent = {
    id: 'sess-1',
    status: 'idle',
    session: { requestHeader: () => undefined },
    ctx: new Context(),
    followup: (message: unknown) => { followups.push(message) },
    inject: () => {},
  }
  let live = false
  ctx.provide('agents', {
    get: (id: unknown) => live && String(id) === 'sess-1' ? agent : undefined,
    resume: vi.fn(async () => {
      live = true
      return { agent, dispose: vi.fn() }
    }),
  } as never)

  await ctx.plugin(s2sApply, { lifecycle: { autoResume: 'deny', mailboxDir } })
  const lifecycle = ctx.get('s2sLifecycle') as S2sLifecycleService
  const ledger = ctx.get('s2sLedger') as S2sLedger
  // `apply()` opens the ledger in a floating async block; yield a macrotask so that
  // settles, then open only if it did not (the facility rejects a duplicate domain
  // open, so racing it directly would throw).
  await new Promise((resolve) => setTimeout(resolve, 0))
  if (!ledger.isOpen) await ledger.open()
  disposers.push(async () => { await ledger.close(); await ctx.fiber.dispose() })

  return {
    ctx,
    lifecycle,
    ledger,
    followups,
    agent,
    goLive: async () => { live = true },
  }
}

describe('batch 43: the delivery gate on the dormant path', () => {
  it('★ a CANCELLED row is dropped at the hand-over, not delivered', async () => {
    const h = await harness()
    await h.ledger.record({ msgId: 'm-cx', from: 'alice', to: 'sess-1', text: 'cancel me' })
    await h.ledger.cancel('m-cx', 'cancelled before the drain ran')

    const queued = await h.lifecycle.queueForDormant({ sessionId: 'sess-1', from: 'alice', text: 'cancel me', msgId: 'm-cx' })
    expect(queued).toBe('queued')
    expect(h.followups.length).toBe(0)

    await h.goLive()
    const result = await h.lifecycle.drain('sess-1')

    // The behavioural error the gate exists to prevent: an explicitly cancelled
    // message reaching a live agent. Nothing was handed over, and the drain says why.
    expect(h.followups.length).toBe(0)
    expect(result.delivered).toBe(0)
    expect(result.refused.map((r) => r.code)).toContain('S2S_LEDGER')

    // Dropped, not re-queued: a cancelled message that goes back in the mailbox is a
    // message that will be refused again on every future drain — an infinite loop that
    // looks like a queue.
    expect(await h.lifecycle.queuedCount('sess-1')).toBe(0)

    // The row is untouched: refusing to deliver must not advance or revive it.
    expect((await h.ledger.get('m-cx'))?.status).toBe('cancelled')
  })

  it('★ a THROWN hand-over rolls the row back from `delivering` to `queued`', async () => {
    const h = await harness()
    await h.ledger.record({ msgId: 'm-th', from: 'alice', to: 'sess-1', text: 'boom' })

    const queued = await h.lifecycle.queueForDormant({ sessionId: 'sess-1', from: 'alice', text: 'boom', msgId: 'm-th' })
    expect(queued).toBe('queued')

    await h.goLive()
    h.agent.followup = () => { throw new Error('hand-over exploded') }

    let broke = false
    try {
      await h.lifecycle.drain('sess-1')
    } catch {
      broke = true
    }
    // Either shape is acceptable — the drain may swallow or propagate. What must hold
    // is the ROW, so the assertion below is the load-bearing one.
    expect(typeof broke).toBe('boolean')

    const row = await h.ledger.get('m-th')
    // Without the rollback this is `delivering` — the row would sit there until the
    // next process start repaired it, which is the "retried only after a restart"
    // failure the claim exists to avoid.
    expect(row?.status).toBe('queued')
    // The attempt really happened, so the count is honest and not rolled back.
    expect(row?.attempts).toBe(1)
    expect(row?.lastError).toContain('dormant hand-over threw')
    expect(row?.lastError).toContain('hand-over exploded')
  })


  it('★ an IN-FLIGHT refusal is re-queued, not dropped — it is the temporary one', async () => {
    // Five refusal reasons split into two kinds needing OPPOSITE handling:
    //   in-flight   TEMPORARY — another attempt owns the row right now
    //   terminal / delivered / not-queued / cas-lost  PERMANENT — the state will not
    //               change by itself, so re-queueing repeats the same refusal forever
    // For in-flight the state does advance: the holder either succeeds (next claim says
    // `delivered` => drop) or fails (row rolls back to `queued` => next claim says
    // `claimed` => deliver). Dropping it would lose a message about to become
    // deliverable.
    //
    // Names checked BEFORE writing this time: the harness exposes `goLive()`, and the
    // service exposes `queuedCount()`. The previous attempt used `resume` and
    // `pendingCount`, neither of which exists, and had to be withdrawn.
    const h = await harness()
    await h.ledger.record({ msgId: 'm-inflight', from: 'alice', to: 'sess-1', text: 'hold' })
    expect(await h.lifecycle.queueForDormant({ sessionId: 'sess-1', from: 'alice', text: 'hold', msgId: 'm-inflight' })).toBe('queued')

    // Put the row where another in-flight attempt would have left it.
    expect(await h.ledger.claimDelivery('m-inflight')).toEqual({ decision: 'deliver', reason: 'claimed' })
    expect((await h.ledger.get('m-inflight'))?.status).toBe('delivering')

    await h.goLive()
    const result = await h.lifecycle.drain('sess-1')

    // Nothing handed over, and nothing counted as delivered...
    expect(h.followups.length).toBe(0)
    expect(result.delivered).toBe(0)
    // ...but the message is STILL QUEUED. That is the whole difference from the
    // permanent refusals: the drop path would have consumed it.
    expect(await h.lifecycle.queuedCount('sess-1')).toBe(1)
    // The row is untouched — re-queueing is the mailbox's business, not the ledger's.
    expect((await h.ledger.get('m-inflight'))?.status).toBe('delivering')
    // And the drain says why, instead of looking like a silent no-op.
    expect(result.refused.map((r) => r.msgId)).toContain('m-inflight')
    expect(result.refused.some((r) => r.cancelOutcome.includes('requeued'))).toBe(true)
  })
})
