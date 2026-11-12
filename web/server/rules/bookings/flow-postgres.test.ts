import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Db, Tx } from '@/server/db'
import { finaliseFlowInTransaction, readFlow, undoFlowInTransaction, type FlowRow } from '@/server/rules/orders/reader-flow'
import { fixtures, insert } from '@/server/rules/testing/database'
import { deferred, Refused, waitingOn } from '@/server/rules/testing/race'
import { startRealPostgres, type RealPostgres } from '@/server/rules/testing/real-postgres'
import { FakeStripe } from '@/server/stripe/fake'
import { chargeCardFlow, settleCardFlow, writeFlowRecord, type CardFlowSnapshot } from './flow'
import { lockAndLoadBooking } from './load-booking'
import { lockForBooking } from './locks'

// W17 on real Postgres 17.6, Worker clients on separate connections: a card flow's C2 and undo racing on one record,
// two runs of the same flow at once (a second press and reconcile), and the booking's place in LOCK_ORDER. Each race
// holds one side open until Postgres reports the other waiting on it, so none can pass by timing.

let pg: RealPostgres
let first: Db
let second: Db
let third: Db

beforeAll(async () => {
  pg = await startRealPostgres()
  first = pg.connect()
  second = pg.connect()
  third = pg.connect()
})
afterAll(() => pg.stop())

let serviceType: string
let staffId: string
beforeAll(async () => {
  serviceType = await fixtures.serviceType(first)
  staffId = await insert(first, 'staff', { role: 'staff', first_name: 'Jo', last_name: 'Staff', email: 'w17-race@example.com' })
})

/** A session time no other test has used: sessions are unique by service type and start. */
let minutes = 0
function nextSlot(): { start_time: string; end_time: string } {
  minutes += 90
  const start = new Date(Date.UTC(2031, 0, 1) + minutes * 60_000)
  return { start_time: start.toISOString(), end_time: new Date(start.getTime() + 60 * 60_000).toISOString() }
}

const actor = () => ({ actor: { type: 'staff' as const, id: staffId }, requestId: 'w17-race' })

async function blockedBy(holder: number): Promise<number> {
  const giveUpAt = Date.now() + 4_000
  while (Date.now() < giveUpAt) {
    const rows = await pg.admin.unsafe<{ pid: number }[]>('SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))', [holder])
    if (rows[0]) return rows[0].pid
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Nothing waited on the holder.')
}

/** `work` inside a transaction on `db`, held open after it until finished. */
async function holding<T>(db: Db, work: (tx: Tx) => Promise<T>) {
  const release = deferred()
  let announce: (value: { pid: number; result: T }) => void = () => {}
  const ready = new Promise<{ pid: number; result: T }>((resolve) => {
    announce = resolve
  })
  const done = db
    .transaction(async (tx) => {
      const result = await work(tx)
      announce({ pid: (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]?.pid as number, result })
      await release.promise
    })
    .catch((err: unknown) => {
      if (!(err instanceof Refused)) throw err
    })
  const { pid, result } = await Promise.race([ready, done.then(() => Promise.reject(new Error('The holder ended early.')))])
  return {
    pid,
    result,
    async finish() {
      release.resolve()
      await done
    },
  }
}

/**
 * A lapsed £20 seat whose Settle on the saved card has been through C1: the booking confirmed and paid, its record
 * pending with no PaymentIntent, as Settle's C1 (W19) writes them. Answers the ids.
 */
async function settleOnCard(stripe: FakeStripe): Promise<{ bookingId: string; pendingId: string; customerId: string; sessionId: string }> {
  const stripeCustomer = `cus_${crypto.randomUUID().slice(0, 8)}`
  stripe.addCustomer(stripeCustomer)
  const customerId = await fixtures.customer(first, { stripe_customer_id: stripeCustomer, saved_payment_method_id: 'pm_saved' })
  const slot = nextSlot()
  const sessionId = await fixtures.session(first, { service_type_id: serviceType, total_booked: 1, ...slot })
  // With its times: a booking with none is an unbounded range to bookings_no_cross_session_overlap.
  const bookingId = await fixtures.booking(first, { session_id: sessionId, customer_id: customerId, price_paid: '20', status: 'confirmed', redemption_source: 'paid', ...slot })
  await insert(first, 'booking_guests', { booking_id: bookingId, guest_type: 'account_holder', guest_name: 'Sam Test', unit_price: '20', pay_by: 'paid' })
  const snapshot: CardFlowSnapshot = {
    customer_id: customerId,
    description: `Payment to settle lapsed-membership booking (${bookingId})`,
    booking_id: bookingId,
    old_status: 'payment_needed',
    old_redemption_source: 'membership_credit',
    old_redeemed_membership_id: null,
    old_credit_period_id: null,
    old_price_paid: '0.00',
    old_payment_due_by: null,
    old_seat1_pay_by: 'membership_credit',
    amount: 20,
    method: 'card',
    channel: 'staff',
    request_id: 'w17-race',
    stripe_customer_id: stripeCustomer,
    payment_method_id: 'pm_saved',
    livemode: false,
  }
  const pendingId = await first.transaction((tx) => writeFlowRecord(tx, { flow: 'settle', recordId: bookingId, expectedAmount: 20, snapshot }))
  return { bookingId, pendingId, customerId, sessionId }
}

const cardRow = async (pendingId: string) => (await readFlow(first, pendingId)) as FlowRow & { snapshot: CardFlowSnapshot }
const bookingStatus = async (bookingId: string) => (await first.query<{ status: string }>('SELECT status FROM bookings WHERE id = $1', [bookingId]))[0]?.status
const cardOrders = async (customerId: string) => (await first.query<{ n: number }>("SELECT count(*)::int AS n FROM orders WHERE customer_id = $1 AND payment_method = 'card'", [customerId]))[0]?.n

describe("a card flow's C2 and undo racing on one record", () => {
  it('C2 first: the undo waits on the flow\'s row, then finds it finalised and gives nothing back', async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const flow = await settleOnCard(stripe)
    const charge = await chargeCardFlow(stripe, await cardRow(flow.pendingId))
    if (charge.outcome !== 'answered') throw new Error('not charged')
    const c2 = await holding(first, () => finaliseFlowInTransaction(first, flow.pendingId, charge.paymentIntent, actor()))
    expect(c2.result).toMatchObject({ finalised: true, alreadyFinalised: false })
    const undo = undoFlowInTransaction(second, flow.pendingId, { ...actor(), why: 'race' })
    const waiter = await blockedBy(c2.pid)
    expect(await waitingOn(pg, waiter)).toEqual(['pending_reader_payments'])
    await c2.finish()
    expect(await undo).toEqual({ undone: false, reason: 'already_finalised' })
    expect(await bookingStatus(flow.bookingId)).toBe('confirmed')
    expect(await cardOrders(flow.customerId)).toBe(1)
  })

  it('the undo first: C2 waits on the flow\'s row, then finds it undone and keeps the payment for reconcile\'s refund', async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const flow = await settleOnCard(stripe)
    const charge = await chargeCardFlow(stripe, await cardRow(flow.pendingId))
    if (charge.outcome !== 'answered') throw new Error('not charged')
    const undo = await holding(first, () => undoFlowInTransaction(first, flow.pendingId, { ...actor(), why: 'race' }))
    expect(undo.result).toEqual({ undone: true, problems: [] })
    const c2 = finaliseFlowInTransaction(second, flow.pendingId, charge.paymentIntent, actor())
    const waiter = await blockedBy(undo.pid)
    expect(await waitingOn(pg, waiter)).toEqual(['pending_reader_payments'])
    await undo.finish()
    expect(await c2).toEqual({ finalised: false, reason: 'charged_without_record' })
    expect(await bookingStatus(flow.bookingId)).toBe('payment_needed')
    expect(await cardOrders(flow.customerId)).toBe(0)
    const kept = await first.query("SELECT 1 FROM audit_log WHERE entity_id = $1 AND action = 'reader_payment.charge_without_record'", [flow.pendingId])
    expect(kept).toHaveLength(1)
  })

  it('two runs of the same flow at once (a second press and reconcile): one charge, one order, both told it is finished (20 rounds)', async () => {
    for (let round = 0; round < 20; round += 1) {
      const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
      const flow = await settleOnCard(stripe)
      const [a, b] = await Promise.all([settleCardFlow(second, stripe, flow.pendingId, actor()), settleCardFlow(third, stripe, flow.pendingId, actor())])
      expect([a.outcome, b.outcome]).toEqual(['finished', 'finished'])
      expect(stripe.netPence).toBe(2000)
      expect(await cardOrders(flow.customerId)).toBe(1)
      expect((await readFlow(first, flow.pendingId))?.status).toBe('finalised')
    }
  })

  it('a decline racing a second press: undone once, the store of claims given back once (20 rounds)', async () => {
    for (let round = 0; round < 20; round += 1) {
      const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
      const flow = await settleOnCard(stripe)
      const { fakeStripeErrors } = await import('@/server/stripe/fake')
      stripe.failNext('paymentIntents.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
      const outcomes = await Promise.all([settleCardFlow(second, stripe, flow.pendingId, actor()), settleCardFlow(third, stripe, flow.pendingId, actor())])
      // Stripe saved the decline against the key, so both see it; one undid, the other found it undone (or not open).
      expect(outcomes.every((outcome) => outcome.outcome === 'declined' || (outcome.outcome === 'not_open' && outcome.state === 'cancelled'))).toBe(true)
      expect(await bookingStatus(flow.bookingId)).toBe('payment_needed')
      const undos = await first.query("SELECT 1 FROM audit_log WHERE entity_id = $1 AND action = 'reader_payment.cancel'", [flow.pendingId])
      expect(undos).toHaveLength(1)
      expect(stripe.netPence).toBe(0)
    }
  })
})

describe('LOCK_ORDER with the booking (W17): booking, customer, sessions, credit periods, pass, memberships, gift card', () => {
  async function aBooking(stripe: FakeStripe) {
    const flow = await settleOnCard(stripe)
    return flow
  }

  it('a booking change waits on the booking another change holds', async () => {
    const flow = await aBooking(new FakeStripe())
    const holder = await holding(third, (tx) => tx.query('SELECT id FROM bookings WHERE id = $1 FOR NO KEY UPDATE', [flow.bookingId]))
    const locking = second.transaction((tx) => lockForBooking(tx, { bookingId: flow.bookingId, ownSession: true }))
    expect(await waitingOn(pg, await blockedBy(holder.pid))).toEqual(['bookings'])
    await holder.finish()
    expect(await locking).toMatchObject({ bookingId: flow.bookingId, customerId: flow.customerId, sessionIds: [flow.sessionId] })
  })

  it('lockAndLoadBooking locks, then reads: the booking, seat 1 first, and its open card flow', async () => {
    const flow = await aBooking(new FakeStripe())
    const loaded = await second.transaction((tx) => lockAndLoadBooking(tx, { bookingId: flow.bookingId }))
    expect(loaded?.locks).toMatchObject({ bookingId: flow.bookingId, customerId: flow.customerId, sessionIds: [flow.sessionId] })
    expect(loaded?.booking).toMatchObject({ id: flow.bookingId, status: 'confirmed', pricePaid: 20, seats: [{ guestType: 'account_holder', unitPrice: 20 }] })
    expect(loaded?.booking.openFlows).toEqual([expect.objectContaining({ id: flow.pendingId, flow: 'settle', method: 'card' })])
    expect(await second.transaction((tx) => lockAndLoadBooking(tx, { bookingId: crypto.randomUUID() }))).toBeNull()
  })

  it('then the customer: with the booking free and the customer held, it waits on the customer', async () => {
    const flow = await aBooking(new FakeStripe())
    const holder = await holding(third, (tx) => tx.query('SELECT id FROM customers WHERE id = $1 FOR NO KEY UPDATE', [flow.customerId]))
    const locking = second.transaction((tx) => lockForBooking(tx, { bookingId: flow.bookingId, ownSession: true }))
    expect(await waitingOn(pg, await blockedBy(holder.pid))).toEqual(['customers'])
    await holder.finish()
    await locking
  })

  it('then the sessions, in id order: with the booking and customer free, it waits on a held session', async () => {
    const flow = await aBooking(new FakeStripe())
    const other = await fixtures.session(first, { service_type_id: serviceType, ...nextSlot() })
    const holder = await holding(third, (tx) => tx.query('SELECT id FROM sessions WHERE id = $1 FOR NO KEY UPDATE', [other]))
    const locking = second.transaction((tx) => lockForBooking(tx, { bookingId: flow.bookingId, ownSession: true, sessionIds: [other] }))
    expect(await waitingOn(pg, await blockedBy(holder.pid))).toEqual(['sessions'])
    await holder.finish()
    expect((await locking)?.sessionIds).toEqual([flow.sessionId, other].sort())
  })

  it('then the gift card, last', async () => {
    const flow = await aBooking(new FakeStripe())
    const giftCard = await insert(first, 'gift_cards', {
      code: `W17-${crypto.randomUUID().slice(0, 8)}`,
      type: 'monetary',
      original_value: '40.00',
      remaining_balance: '40.00',
      origin: 'customer_purchase',
      expiry_date: '2030-01-01',
    })
    const holder = await holding(third, (tx) => tx.query('SELECT id FROM gift_cards WHERE id = $1 FOR NO KEY UPDATE', [giftCard]))
    const locking = second.transaction((tx) => lockForBooking(tx, { bookingId: flow.bookingId, ownSession: true, giftCardId: giftCard }))
    expect(await waitingOn(pg, await blockedBy(holder.pid))).toEqual(['gift_cards'])
    await holder.finish()
    expect((await locking)?.giftCardId).toBe(giftCard)
  })

  it("a flow's C2 takes its row, then the booking: with a change holding the booking, C2 waits on the booking", async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const flow = await settleOnCard(stripe)
    const charge = await chargeCardFlow(stripe, await cardRow(flow.pendingId))
    if (charge.outcome !== 'answered') throw new Error('not charged')
    const change = await holding(third, (tx) => lockForBooking(tx, { bookingId: flow.bookingId, ownSession: true }))
    const c2 = finaliseFlowInTransaction(second, flow.pendingId, charge.paymentIntent, actor())
    expect(await waitingOn(pg, await blockedBy(change.pid))).toEqual(['bookings'])
    await change.finish()
    expect(await c2).toMatchObject({ finalised: true })
  })

  it('two moves the opposite ways between the same two sessions never deadlock (30 free-running rounds)', async () => {
    for (let round = 0; round < 30; round += 1) {
      const a = await aBooking(new FakeStripe())
      const b = await aBooking(new FakeStripe())
      const move = (db: Db, bookingId: string, to: string) =>
        db.transaction(async (tx) => {
          const held = await lockForBooking(tx, { bookingId, ownSession: true, sessionIds: [to] })
          await tx.query('UPDATE sessions SET updated_at = now() WHERE id = ANY($1::uuid[])', [held?.sessionIds ?? []])
          return held?.sessionIds
        })
      const [one, two] = await Promise.all([move(second, a.bookingId, b.sessionId), move(third, b.bookingId, a.sessionId)])
      expect(one).toEqual([a.sessionId, b.sessionId].sort())
      expect(two).toEqual([a.sessionId, b.sessionId].sort())
    }
  })

  it('control: the same two sessions locked in the order each move names them (not sorted) do deadlock', async () => {
    const a = await aBooking(new FakeStripe())
    const b = await aBooking(new FakeStripe())
    const bothHoldOne = { count: 0, all: deferred() }
    const unsorted = (db: Db, own: string, to: string) =>
      db.transaction(async (tx) => {
        await tx.query('SELECT id FROM sessions WHERE id = $1 FOR NO KEY UPDATE', [own])
        bothHoldOne.count += 1
        if (bothHoldOne.count === 2) bothHoldOne.all.resolve()
        await bothHoldOne.all.promise
        await tx.query('SELECT id FROM sessions WHERE id = $1 FOR NO KEY UPDATE', [to])
      })
    const outcomes = await Promise.allSettled([unsorted(second, a.sessionId, b.sessionId), unsorted(third, b.sessionId, a.sessionId)])
    const failed = outcomes.filter((outcome) => outcome.status === 'rejected')
    // Each holds one session and waits for the other's. Postgres aborts one after its deadlock_timeout (1 s), or the
    // Worker's client gives up on it at its own limit first: either way, one of the two can never finish.
    expect(failed).toHaveLength(1)
    expect(String((failed[0] as PromiseRejectedResult).reason)).toMatch(/deadlock|took too long to respond/i)
  })

  it("a booking change and that booking's card flow finishing never deadlock (20 free-running rounds)", async () => {
    for (let round = 0; round < 20; round += 1) {
      const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
      const flow = await settleOnCard(stripe)
      const [finished, changed] = await Promise.all([
        settleCardFlow(second, stripe, flow.pendingId, actor()),
        third.transaction(async (tx) => {
          const held = await lockForBooking(tx, { bookingId: flow.bookingId, ownSession: true })
          await tx.query('UPDATE bookings SET special_requests = $1 WHERE id = $2', ['Quiet please', flow.bookingId])
          return held?.bookingId
        }),
      ])
      expect(finished.outcome).toBe('finished')
      expect(changed).toBe(flow.bookingId)
    }
  })
})
