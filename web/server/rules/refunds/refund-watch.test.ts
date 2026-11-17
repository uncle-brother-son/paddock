import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { audit } from '@/server/audit'
import type { Db } from '@/server/db'
import { closeStuckItem } from '@/server/rules/orders/close-stuck'
import { reconcile } from '@/server/rules/orders/reconcile'
import { reconcileRunOutputSchema, stuckListOutputSchema } from '@/contracts'
import { stuckList, WATCH_WORDS, watchWords } from '@/server/rules/orders/stuck-list'
import { startTestDatabase, type TestDatabase } from '@/server/rules/testing/database'
import { FakeStripe } from '@/server/stripe/fake'
import type { CardPart } from './pipeline'
import { claimWatchEntries, REFUND_WATCH, refundSeen, refundsForRow, stillGoing, toWatch, WATCH_DAYS, WATCH_READ_HOURS, watchEnded, WATCHES_DUE_SQL, WATCHES_WAITING_SQL, type WatchDetails, type WatchDue } from './refund-watch'
import { checkWatchedRefund } from './refund-watch-settle'

// Brief W32: the refund watch's own pieces. What a watched refund does to a booking, an order, a membership's refund,
// an event booking and a compensation is tested through the routes, beside each subject's own tests
// (bookings/refunds.test.ts, bookings/cancel.test.ts, orders/refund-lines.test.ts, orders/membership-refund.test.ts,
// events/cancel-places.test.ts, orders/membership.test.ts). Here: which statuses are watched, what the finished row
// keeps, the words for every kind of line, and a watch whose subject no longer exists. Stripe is only ever the fake.
// Brief W32a: every card refund is watched for 50 days whatever its first status; which watches a run reads, in what
// order, inside its budget (W32 review S1); and what a read that ends nothing counts as (S2).

let database: TestDatabase
let db: Db
beforeAll(async () => {
  database = await startTestDatabase({ schema: 'live' })
  db = database.db
})
afterAll(() => database.stop())
beforeEach(async () => {
  await db.query('DELETE FROM audit_log')
})

const by = { actor: { type: 'system' as const, id: null }, requestId: 'w32-watch' }
const part = (orderId: string, paymentIntentId: string, amount: number): CardPart => ({ orderId, paymentIntentId, amount, lines: [{ lineId: crypto.randomUUID(), amount }] })
const watchRows = async () => (await db.query<{ id: string; details: Record<string, unknown> }>('SELECT id, details FROM audit_log WHERE action = $1 ORDER BY at, id', [REFUND_WATCH])).map((row) => row.details)
const due = async (days = WATCH_DAYS, hours = WATCH_READ_HOURS, most = 50) => db.query<WatchDue>(WATCHES_DUE_SQL, [days, hours, most])
/** Time passes for the watch's rows: each is that much older (the database's clock is the real one in this file). */
const older = (interval: string) => db.query(`UPDATE audit_log SET at = at - $1::interval WHERE action = $2`, [interval, REFUND_WATCH])
const waiting = async () => (await db.query<{ waiting: number }>(WATCHES_WAITING_SQL))[0]?.waiting
const runReconcile = (stripe: FakeStripe) => reconcile(db, stripe, { actor: { type: 'system', id: null }, requestId: crypto.randomUUID(), maxItems: 50, budgetMs: 60_000 })

/** A paid fake PaymentIntent with one refund of `pence` on it, answered pending. */
async function aPendingRefund(stripe: FakeStripe, pence = 2000): Promise<{ paymentIntentId: string; refundId: string }> {
  stripe.addCustomer('cus_w32')
  const intent = await stripe.paymentIntents.create({ amount: 4000, currency: 'gbp', customer: 'cus_w32', payment_method: 'pm_w32', off_session: true, confirm: true })
  stripe.refundsStayPending = true
  const refund = await stripe.refunds.create({ payment_intent: intent.id, amount: pence }, { idempotencyKey: crypto.randomUUID() })
  stripe.refundsStayPending = false
  return { paymentIntentId: intent.id, refundId: refund.id }
}

/** W32a: the same, answered `succeeded`, as Stripe answers most refunds (and its 5126 test card's, which then fails). */
async function aSucceededRefund(stripe: FakeStripe, pence = 2000): Promise<{ paymentIntentId: string; refundId: string }> {
  stripe.addCustomer('cus_w32')
  const intent = await stripe.paymentIntents.create({ amount: 4000, currency: 'gbp', customer: 'cus_w32', payment_method: 'pm_w32', off_session: true, confirm: true })
  const refund = await stripe.refunds.create({ payment_intent: intent.id, amount: pence }, { idempotencyKey: crypto.randomUUID() })
  return { paymentIntentId: intent.id, refundId: refund.id }
}

/** A watch on a compensation's refund (nothing to owe a failure on), written by hand. */
const watchingCompensation = (refund: { paymentIntentId: string; refundId: string }, status: string) =>
  watching({ ...refund, amount: 20, status, livemode: false, on: 'compensation', subjectId: crypto.randomUUID(), orderId: null, claimId: null, lines: [] })
const checkedRows = async (refundId: string) => (await watchRows()).filter((row) => row['state'] === 'checked' && row['refundId'] === refundId)

/** A `watching` row written by hand, for a subject the tests choose. */
async function watching(details: Omit<WatchDetails, 'state'>): Promise<void> {
  await db.transaction((tx) => audit.recordAll(tx, [{ actorType: 'system', actorId: null, action: REFUND_WATCH, entityType: 'refund_watch', entityId: details.refundId, requestId: 'w32-watch', details: { state: 'watching', ...details } }]))
}

describe('which refunds are watched', () => {
  it('everything short of succeeded that is not an end: pending, requires_action, and a status this code does not know', () => {
    expect(['pending', 'requires_action', 'something_new', null, undefined].map((status) => stillGoing(status))).toEqual([true, true, true, true, true])
    expect(['succeeded', 'failed', 'canceled'].map((status) => stillGoing(status))).toEqual([false, false, false])
  })

  it('W32a (lead call 1): every refund Stripe accepted is watched, succeeded included; only one already at an end is not', () => {
    expect(['succeeded', 'pending', 'requires_action', 'something_new', null, undefined].map((status) => toWatch(status))).toEqual([true, true, true, true, true, true])
    expect(['failed', 'canceled'].map((status) => toWatch(status))).toEqual([false, false])
  })

  it('the finished row keeps the refund of each part that went, whatever its status, and each gets a watch (W32a: the succeeded one too)', () => {
    const first = part('order-1', 'pi_1', 20)
    const second = part('order-2', 'pi_2', 30)
    const refunds = [refundSeen(first, { id: 're_1', status: 'succeeded' }), refundSeen(second, { id: 're_2', status: 'requires_action' })]
    expect(refundsForRow([first, second], refunds)).toEqual({
      refunds: [
        { orderId: 'order-1', paymentIntentId: 'pi_1', refundId: 're_1', status: 'succeeded', amount: 20 },
        { orderId: 'order-2', paymentIntentId: 'pi_2', refundId: 're_2', status: 'requires_action', amount: 30 },
      ],
    })
    const entries = claimWatchEntries({ id: 'claim-1', on: 'booking', subjectId: 'booking-1', livemode: true }, [first, second], refunds, by)
    expect(entries.map((entry) => [entry.action, entry.entityType, entry.entityId])).toEqual([
      [REFUND_WATCH, 'refund_watch', 're_1'],
      [REFUND_WATCH, 'refund_watch', 're_2'],
    ])
    expect(entries[0]?.details).toEqual({ state: 'watching', refundId: 're_1', paymentIntentId: 'pi_1', amount: 20, status: 'succeeded', livemode: true, on: 'booking', subjectId: 'booking-1', orderId: null, claimId: 'claim-1', lines: first.lines })
    expect(entries[1]?.details).toEqual({ state: 'watching', refundId: 're_2', paymentIntentId: 'pi_2', amount: 30, status: 'requires_action', livemode: true, on: 'booking', subjectId: 'booking-1', orderId: null, claimId: 'claim-1', lines: second.lines })
    // A refund recorded as failed or cancelled at once never went: nothing to watch.
    expect(claimWatchEntries({ id: 'claim-1', on: 'booking', subjectId: 'booking-1', livemode: true }, [first], [refundSeen(first, { id: 're_3', status: 'failed' })], by)).toEqual([])
    // An order's or an event booking's watch names the order the money would be owed on.
    expect(claimWatchEntries({ id: 'claim-2', on: 'event_booking', subjectId: 'eb-1', livemode: false }, [second], refunds, by)).toMatchObject([{ details: { on: 'event_booking', subjectId: 'eb-1', orderId: 'order-2' } }])
  })

  it('no refund known for a part (a claim finished with nothing gone, or owed): nothing on the row, nothing watched', () => {
    expect(refundsForRow([], [])).toEqual({})
    expect(refundsForRow([], undefined)).toEqual({})
    expect(claimWatchEntries({ id: 'claim-1', on: 'order', subjectId: 'order-1', livemode: false }, [], undefined, by)).toEqual([])
    // A refund for a part that didn't go is never kept or watched.
    const never = part('order-9', 'pi_9', 10)
    expect(refundsForRow([], [refundSeen(never, { id: 're_9', status: 'pending' })])).toEqual({})
    expect(claimWatchEntries({ id: 'claim-1', on: 'order', subjectId: 'order-9', livemode: false }, [], [refundSeen(never, { id: 're_9', status: 'pending' })], by)).toEqual([])
  })
})

describe('the words for each kind of line (brief W32 item 6)', () => {
  const watch = { amount: 20, refundId: 're_1', paymentIntentId: 'pi_1' }
  it('every line says what happened to the money and what to do, and ends with Mark sorted', () => {
    const lines = [
      watchWords({ ...watch, on: 'booking' }, 'failed', 20),
      watchWords({ ...watch, on: 'order' }, 'failed', 20),
      watchWords({ ...watch, on: 'event_booking' }, 'failed', 20),
      watchWords({ ...watch, on: 'compensation' }, 'failed', 0),
      watchWords({ ...watch, on: 'order' }, 'failed', 0),
      watchWords({ ...watch, on: 'booking' }, 'expired', 0),
      watchWords({ ...watch, on: 'compensation', step: 'late-refund' }, 'failed', 0),
    ]
    expect(lines).toEqual([
      WATCH_WORDS.bookingFailed(20, 're_1'),
      WATCH_WORDS.orderFailed(20, 're_1'),
      WATCH_WORDS.eventFailed(20, 're_1'),
      WATCH_WORDS.compensationFailed(20, 'pi_1'),
      WATCH_WORDS.goneFailed(20, 'pi_1'),
      WATCH_WORDS.expired(20, 're_1'),
      WATCH_WORDS.lateFailed(20, 'pi_1'),
    ])
    for (const line of lines) expect(line.endsWith('Then press Mark sorted (needs the Issue refunds permission).')).toBe(true)
    expect(new Set(lines).size).toBe(lines.length)
    expect(WATCH_WORDS.goneFailed(20, 'pi_1')).toBe(
      "A card refund of £20.00 (payment pi_1) was accepted by Stripe and then failed, so the money never reached the customer, and what it was for no longer exists, so it can't be listed as money still to refund. Give the customer the money back by hand (refund the payment in Stripe, or add store credit), or tell a manager. Then press Mark sorted (needs the Issue refunds permission)."
    )
    expect(WATCH_WORDS.expired(20, 're_1')).toBe(
      "A card refund of £20.00 (re_1) has been waiting at Stripe for more than 50 days, so the automatic check has stopped watching it. It is still recorded as refunded. Look at the refund in Stripe: if it went through, there is nothing more to do; if it failed, the customer has not had the money, so give it back by hand (store credit, or a refund in Stripe) and tell a manager. If Stripe still shows it pending, don't give anything back: tell a manager and leave this line until Stripe says how it ended. Then press Mark sorted (needs the Issue refunds permission)."
    )
    // W32a (lead call 2): the days are the watch's own figure, 50 (Stripe can fail a pending refund on day 45).
    expect(WATCH_DAYS).toBe(50)
    // W32a (W32 review S3): a late payment's automatic refund that failed later has its own words.
    expect(WATCH_WORDS.lateFailed(20, 'pi_1')).toBe(
      "An automatic refund of £20.00 (payment pi_1) for a payment that went through after its order or change had been cancelled was accepted by Stripe and then failed, so the customer has not had the money back. Refund that payment in Stripe by hand (or tell a manager if Stripe won't). Then press Mark sorted (needs the Issue refunds permission)."
    )
  })
})

describe('a watch whose subject no longer exists', () => {
  it.each(['order', 'booking', 'event_booking'] as const)('a failed refund on a %s that is gone: nothing to owe it on, so it ends as a line for a person; nothing is sent', async (on) => {
    const stripe = new FakeStripe()
    const { paymentIntentId, refundId } = await aPendingRefund(stripe)
    const subjectId = crypto.randomUUID()
    await watching({ refundId, paymentIntentId, amount: 20, status: 'pending', livemode: false, on, subjectId, orderId: on === 'booking' ? null : crypto.randomUUID(), claimId: crypto.randomUUID(), lines: [] })
    stripe.settleRefund(refundId, 'failed')
    const before = stripe.calls.length
    const ran = await runReconcile(stripe)
    expect(ran.items).toMatchObject([{ kind: 'refund', id: refundId, outcome: 'refund_failed', reason: 'refund_failed_later' }])
    // Only the list of the payment's refunds was read.
    expect(stripe.calls.slice(before).map((call) => call.method)).toEqual(['refunds.list'])
    expect((await watchRows()).find((row) => row['state'] === 'failed')).toMatchObject({ refundId, amount: 20, owed: 0, status: 'failed', gone: true })
    const listed = (await stuckList(db)).watched
    expect(listed).toMatchObject([{ refundId, on, customerName: null, owed: 0, state: 'failed', words: WATCH_WORDS.goneFailed(20, paymentIntentId) }])
    expect(await watchEnded(db, refundId)).toBe(true)
    expect((await runReconcile(stripe)).items).toEqual([])
  })
})

describe('reading a watched refund', () => {
  it('Stripe does not answer: nothing is concluded, and the next run reads it again', async () => {
    const stripe = new FakeStripe()
    const { paymentIntentId, refundId } = await aPendingRefund(stripe)
    await watching({ refundId, paymentIntentId, amount: 20, status: 'pending', livemode: false, on: 'compensation', subjectId: crypto.randomUUID(), orderId: null, claimId: null, lines: [] })
    stripe.failNext('refunds.list', { kind: 'unreachable' })
    const [first] = await due()
    expect(await checkWatchedRefund(db, stripe, first as WatchDue, by, undefined)).toMatchObject({ outcome: 'waiting', reason: 'unclear' })
    expect(await watchEnded(db, refundId)).toBe(false)
    // W32a: the read is kept, with the last status known.
    expect(await checkedRows(refundId)).toEqual([{ state: 'checked', refundId, status: 'pending', reason: 'unclear' }])
    stripe.settleRefund(refundId, 'succeeded')
    // W32a (call 1): succeeded is not the end of a watch before its days are up: Stripe can still fail it.
    expect(await checkWatchedRefund(db, stripe, first as WatchDue, by, undefined)).toMatchObject({ outcome: 'waiting', reason: 'succeeded_so_far' })
    expect(await watchEnded(db, refundId)).toBe(false)
    // Past its days it ends, quietly.
    const [atTheEnd] = await due(-1)
    expect(atTheEnd).toMatchObject({ expired: true, lastStatus: 'succeeded' })
    expect(await checkWatchedRefund(db, stripe, atTheEnd as WatchDue, by, undefined)).toEqual({ outcome: 'succeeded' })
    // A second look at an ended watch changes nothing.
    expect(await checkWatchedRefund(db, stripe, atTheEnd as WatchDue, by, undefined)).toEqual({ outcome: 'ended_elsewhere' })
    expect((await watchRows()).map((row) => row['state']).sort()).toEqual(['checked', 'checked', 'succeeded', 'watching'])
    expect((await stuckList(db)).watched).toEqual([])
  })

  it('W32a: past its days and Stripe not readable: a watch that last read succeeded is not ended on a guess (no answer: read again; the other mode: ended quietly); one still going ends for a person', async () => {
    const stripe = new FakeStripe()
    const gone = await aSucceededRefund(stripe)
    const pending = await aPendingRefund(stripe)
    const otherMode = await aSucceededRefund(stripe)
    await watchingCompensation(gone, 'succeeded')
    await watchingCompensation(pending, 'pending')
    await watching({ ...otherMode, amount: 20, status: 'succeeded', livemode: true, on: 'compensation', subjectId: crypto.randomUUID(), orderId: null, claimId: null, lines: [] })
    const atTheEnd = async (refundId: string) => (await due(-1)).find((row) => row.details.refundId === refundId) as WatchDue
    stripe.failNext('refunds.list', { kind: 'unreachable' })
    expect(await checkWatchedRefund(db, stripe, await atTheEnd(gone.refundId), by, undefined)).toMatchObject({ outcome: 'waiting', reason: 'unclear' })
    expect(await watchEnded(db, gone.refundId)).toBe(false)
    stripe.failNext('refunds.list', { kind: 'unreachable' })
    expect(await checkWatchedRefund(db, stripe, await atTheEnd(pending.refundId), by, undefined)).toMatchObject({ outcome: 'expired' })
    const before = stripe.calls.length
    expect(await checkWatchedRefund(db, stripe, await atTheEnd(otherMode.refundId), by, undefined)).toEqual({ outcome: 'succeeded' })
    expect(stripe.calls.length).toBe(before)
    expect((await stuckList(db)).watched).toMatchObject([{ refundId: pending.refundId, state: 'expired' }])
    // Stripe answers again: the first one ends quietly too.
    expect(await checkWatchedRefund(db, stripe, await atTheEnd(gone.refundId), by, undefined)).toEqual({ outcome: 'succeeded' })
    expect(await due(-1)).toEqual([])
  })

  it('the due list: only watches with no end; a sorted one is not read again, and the days decide `expired`', async () => {
    const stripe = new FakeStripe()
    const { paymentIntentId, refundId } = await aPendingRefund(stripe)
    await watching({ refundId, paymentIntentId, amount: 20, status: 'pending', livemode: false, on: 'compensation', subjectId: crypto.randomUUID(), orderId: null, claimId: null, lines: [] })
    expect((await due()).map((row) => [row.details.refundId, row.expired])).toEqual([[refundId, false]])
    // Past its days (the row is a millisecond old, so the test asks for "older than a day from now"): this run ends
    // it for a person, since Stripe still shows it pending.
    const [first] = await due(-1)
    expect(first?.expired).toBe(true)
    expect(await checkWatchedRefund(db, stripe, first as WatchDue, by, undefined)).toMatchObject({ outcome: 'expired' })
    expect(await due(-1)).toEqual([])
    const listed = (await stuckList(db)).watched
    expect(listed).toMatchObject([{ refundId, state: 'expired' }])
    // The route's own output check takes a watch that ran out, as it takes one that failed.
    expect(stuckListOutputSchema.parse(await stuckList(db)).watched).toMatchObject([{ refundId, state: 'expired', owed: 0 }])
    // Mark sorted, by a person, with a reason: off the list, and still never read again.
    expect(await waiting()).toBe(0)
    const closed = await closeStuckItem(db, { kind: 'refund_watch', orderId: listed[0]?.watchId as string, reason: 'Checked in Stripe: it went through' }, { actor: { type: 'staff', id: 'staff-1' }, requestId: 'w32-close' })
    expect(closed).toMatchObject({ closed: true, kind: 'refund_watch', message: 'Marked as sorted. It is no longer listed.' })
    expect((await stuckList(db)).watched).toEqual([])
    expect(await due(-1)).toEqual([])
    expect((await watchRows()).find((row) => row['state'] === 'sorted')).toMatchObject({ refundId, was: 'expired', byHand: { why: 'Checked in Stripe: it went through' } })
    // A watch id that isn't one is refused with nothing changed.
    expect(await closeStuckItem(db, { kind: 'refund_watch', orderId: crypto.randomUUID(), reason: 'No such watch' }, { actor: { type: 'staff', id: 'staff-1' }, requestId: 'w32-close-2' })).toMatchObject({ closed: false, reason: 'not_listed' })
  })
})

describe('W32a (W32 review S1): which watched refunds a run reads, and in what order, inside its budget', () => {
  /** `count` payments, each with one refund answered `status` and a watch on it. The refunds' ids, in the order made. */
  async function manyWatched(stripe: FakeStripe, count: number, status: 'pending' | 'succeeded'): Promise<string[]> {
    const ids: string[] = []
    for (let n = 0; n < count; n += 1) {
      const refund = status === 'pending' ? await aPendingRefund(stripe) : await aSucceededRefund(stripe)
      await watchingCompensation(refund, status)
      ids.push(refund.refundId)
    }
    return ids
  }
  /**
   * Ten other items a run meets every time, ahead of the watches: late payments whose PaymentIntent Stripe can't
   * read, so each is tried again (and left unclear) on every run.
   */
  async function tenOtherItems(): Promise<void> {
    await db.transaction((tx) =>
      audit.recordAll(
        tx,
        Array.from({ length: 10 }, (_, n) => ({
          actorType: 'system' as const,
          actorId: null,
          action: 'order.charge_without_order',
          entityType: 'order',
          entityId: crypto.randomUUID(),
          requestId: 'w32a-budget',
          details: { paymentIntentId: `pi_not_in_stripe_${n}`, amount: 1000 },
        }))
      )
    )
  }
  /** How many times each refund has been read: its `checked` rows. */
  async function reads(ids: readonly string[]): Promise<number[]> {
    const rows = await watchRows()
    return ids.map((id) => rows.filter((row) => row['state'] === 'checked' && row['refundId'] === id).length)
  }
  const listsIn = (stripe: FakeStripe, from: number) => stripe.calls.slice(from).filter((call) => call.method === 'refunds.list').length

  it('120 watched refunds still pending and 10 other items: each run of 50 reads the 40 read longest ago, so every one is read every third run; none is starved, nothing is sent', async () => {
    const stripe = new FakeStripe()
    const ids = await manyWatched(stripe, 120, 'pending')
    await tenOtherItems()
    for (let round = 1; round <= 2; round += 1) {
      for (let n = 1; n <= 3; n += 1) {
        const from = stripe.calls.length
        const ran = await runReconcile(stripe)
        // The ten others are the run's items; a watch's read that ends nothing is no item, and nothing waits behind it.
        expect(ran).toMatchObject({ checked: 10, left: 0, deferred: 0, refundsWaiting: 120 })
        expect(ran.items.map((item) => item.reason)).toEqual(Array.from({ length: 10 }, () => 'unclear'))
        expect(listsIn(stripe, from)).toBe(40)
        const read = await reads(ids)
        // After n runs of a round: 40 x n of them read `round` times, the others once fewer.
        expect(read.filter((times) => times === round)).toHaveLength(40 * n)
        expect(read.filter((times) => times === round - 1)).toHaveLength(120 - 40 * n)
        await older('5 minutes')
      }
    }
    expect(await reads(ids)).toEqual(ids.map(() => 2))
    expect(stripe.calls.filter((call) => call.method === 'refunds.create')).toHaveLength(120)
    expect((await stuckList(db)).watched).toEqual([])
  }, 120_000)

  it('120 watched refunds that read succeeded and 10 other items: none is read before a day is up; then every one is read within three runs, and once a day after that', async () => {
    const stripe = new FakeStripe()
    const ids = await manyWatched(stripe, 120, 'succeeded')
    await tenOtherItems()
    const run = async () => {
      const from = stripe.calls.length
      const ran = await runReconcile(stripe)
      expect(ran).toMatchObject({ checked: 10, left: 0, deferred: 0, refundsWaiting: 0 })
      await older('5 minutes')
      return listsIn(stripe, from)
    }
    // Just recorded, and 23 hours 55 minutes on: nothing to read yet.
    expect(await run()).toBe(0)
    await older('23 hours 50 minutes')
    expect(await run()).toBe(0)
    // A day after they were recorded all 120 fall due at once: three runs (15 minutes) read every one, once.
    expect([await run(), await run(), await run()]).toEqual([40, 40, 40])
    expect(await reads(ids)).toEqual(ids.map(() => 1))
    expect(await run()).toBe(0)
    // And the same a day later: each is read once a day, whatever else a run has to do.
    await older('23 hours 40 minutes')
    expect([await run(), await run(), await run(), await run()]).toEqual([40, 40, 40, 0])
    expect(await reads(ids)).toEqual(ids.map(() => 2))
    expect((await watchRows()).filter((row) => row['state'] === 'checked').every((row) => row['status'] === 'succeeded' && row['reason'] === 'succeeded_so_far')).toBe(true)
  }, 120_000)

  it('the list decides: one still going is due every run, one that reads succeeded once a day; the one read longest ago comes first; never more than the run can take; a staff run reads whatever is oldest', async () => {
    const stripe = new FakeStripe()
    const pending = await aPendingRefund(stripe)
    const gone = await aSucceededRefund(stripe)
    await watchingCompensation(gone, 'succeeded')
    await older('1 minute')
    await watchingCompensation(pending, 'pending')
    const dueIds = async (...args: Parameters<typeof due>) => (await due(...args)).map((row) => row.details.refundId)
    // Only the pending one is due on the schedule; a staff run (0 hours) takes both, the one recorded first first.
    expect(await dueIds()).toEqual([pending.refundId])
    expect(await dueIds(WATCH_DAYS, 0)).toEqual([gone.refundId, pending.refundId])
    expect(await dueIds(WATCH_DAYS, 0, 1)).toEqual([gone.refundId])
    // A staff run reads both: the succeeded one's read is kept, so the next staff run takes the pending one first.
    await reconcile(db, stripe, { actor: { type: 'staff', id: 'staff-1' }, requestId: crypto.randomUUID(), maxItems: 10, budgetMs: 60_000, watchReadHours: 0 })
    expect(await reads([gone.refundId, pending.refundId])).toEqual([1, 1])
    // A day on, the succeeded one is due on the schedule again; the pending one was due all along.
    await older('23 hours')
    expect(await dueIds()).toEqual([pending.refundId])
    await older('1 hour')
    expect((await dueIds()).sort()).toEqual([gone.refundId, pending.refundId].sort())
    // A pending refund that goes through is then read once a day like any other, until its days are up.
    stripe.settleRefund(pending.refundId, 'succeeded')
    await runReconcile(stripe)
    expect(await dueIds()).toEqual([])
    expect(await dueIds(-1)).toHaveLength(2)
  })
})

describe('W32a (W32 review S2): what a read of a watched refund counts as', () => {
  it('a read that ends nothing is no item, and is in neither `refunds` nor `left`; the ones still on their way are counted as waiting on Stripe; only a failure or a watch that ran out is left for a person', async () => {
    const stripe = new FakeStripe()
    const pending = await aPendingRefund(stripe)
    const other = await aPendingRefund(stripe)
    const gone = await aSucceededRefund(stripe)
    await watchingCompensation(pending, 'pending')
    await watchingCompensation(other, 'pending')
    await watchingCompensation(gone, 'succeeded')
    const staffRun = () => reconcile(db, stripe, { actor: { type: 'staff', id: 'staff-1' }, requestId: crypto.randomUUID(), maxItems: 10, budgetMs: 60_000, watchReadHours: 0 })
    // All three are read (three lists), and the run has nothing to say but how many are waiting on Stripe.
    const from = stripe.calls.length
    const quiet = await staffRun()
    expect(quiet).toEqual({ checked: 0, finalised: 0, undone: 0, refunds: 0, left: 0, deferred: 0, stripeRefused: false, refundsWaiting: 2, items: [] })
    // The run's contract carries the figure (the staff app's types are made from it).
    expect(reconcileRunOutputSchema.parse(quiet).refundsWaiting).toBe(2)
    expect(stripe.calls.slice(from).map((call) => call.method)).toEqual(['refunds.list', 'refunds.list', 'refunds.list'])
    expect(await waiting()).toBe(2)
    // One over the run's items waits for the next run, and is not "deferred": nothing is held up by it.
    expect(await reconcile(db, stripe, { actor: { type: 'system', id: null }, requestId: crypto.randomUUID(), maxItems: 1, budgetMs: 60_000 })).toMatchObject({ checked: 0, deferred: 0, refundsWaiting: 2, items: [] })
    // One goes through: no longer waiting, still nothing for a person. The other fails: one item, left for a person.
    stripe.settleRefund(pending.refundId, 'succeeded')
    stripe.settleRefund(other.refundId, 'failed')
    const ran = await staffRun()
    expect(ran).toMatchObject({ checked: 1, refunds: 1, left: 1, deferred: 0, refundsWaiting: 0 })
    expect(ran.items).toMatchObject([{ kind: 'refund', id: other.refundId, outcome: 'refund_failed', reason: 'refund_failed_later' }])
    // The refund that succeeded first and fails afterwards (Stripe's 5126 shape): found by the next read, left for a person.
    stripe.settleRefund(gone.refundId, 'failed')
    const again = await staffRun()
    expect(again).toMatchObject({ checked: 1, refunds: 1, left: 1, refundsWaiting: 0 })
    expect(again.items).toMatchObject([{ kind: 'refund', id: gone.refundId, outcome: 'refund_failed', reason: 'refund_failed_later' }])
    expect((await stuckList(db)).watched.map((line) => line.refundId).sort()).toEqual([other.refundId, gone.refundId].sort())
    // Nothing was ever sent by a run.
    expect(stripe.calls.filter((call) => call.method === 'refunds.create')).toHaveLength(3)
  })

  it('a watch that runs out while the refund is still pending is left for a person; one that reads succeeded at the end ends with no item', async () => {
    const stripe = new FakeStripe()
    const pending = await aPendingRefund(stripe)
    const gone = await aSucceededRefund(stripe)
    await watchingCompensation(pending, 'pending')
    await watchingCompensation(gone, 'succeeded')
    await older(`${WATCH_DAYS} days 1 hour`)
    const ran = await runReconcile(stripe)
    expect(ran).toMatchObject({ checked: 1, refunds: 1, left: 1, refundsWaiting: 0 })
    expect(ran.items).toMatchObject([{ kind: 'refund', id: pending.refundId, outcome: 'refund_failed', reason: 'watch_expired' }])
    expect((await watchRows()).filter((row) => row['state'] !== 'watching').map((row) => [row['refundId'], row['state']]).sort()).toEqual([[pending.refundId, 'expired'], [gone.refundId, 'succeeded']].sort())
    expect((await stuckList(db)).watched).toMatchObject([{ refundId: pending.refundId, state: 'expired' }])
    expect((await runReconcile(stripe)).items).toEqual([])
  })
})

describe("the stuck list's contract stays readable by the staff app published before W32 (brief W32 item 6)", () => {
  it('every field that app copies is still there under its own name, and the new lines are in one field of their own (`watched`), which it ignores', async () => {
    const stripe = new FakeStripe()
    const { paymentIntentId, refundId } = await aPendingRefund(stripe)
    await watching({ refundId, paymentIntentId, amount: 20, status: 'pending', livemode: false, on: 'compensation', subjectId: crypto.randomUUID(), orderId: null, claimId: null, lines: [] })
    stripe.settleRefund(refundId, 'failed')
    await runReconcile(stripe)
    const listed = await stuckList(db)
    // The published getStuckReaderPayments reads exactly these six, by name; anything else in the answer is dropped.
    // W36 adds `steps` (a membership's Stripe step left to do), as `watched` was added: a field of its own, which that
    // app drops too (memberships/left.test.ts holds that a step is only ever there).
    // W41 adds `paymentDates` (a payment date change on hold) the same way (memberships/payment-date.test.ts).
    expect(Object.keys(listed).sort()).toEqual(['alert', 'checkout', 'claims', 'flows', 'paymentDates', 'refunds', 'steps', 'warnings', 'watched'])
    expect(listed).toMatchObject({ checkout: [], flows: [], claims: [], refunds: [], warnings: [], alert: null })
    expect(listed.watched).toHaveLength(1)
    // The route's own output check takes it, and none of the older fields carries the new close kind.
    const parsed = stuckListOutputSchema.parse(listed)
    expect(parsed.watched[0]?.close).toEqual({ kind: 'refund_watch', orderId: listed.watched[0]?.watchId })
    const older = [...parsed.checkout, ...parsed.flows, ...parsed.claims, ...parsed.refunds, ...parsed.warnings]
    expect(older.some((item) => item.close?.kind === 'refund_watch')).toBe(false)
  })
})
