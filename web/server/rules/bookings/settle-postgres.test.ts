import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ApiError } from '@/server/http/errors'
import type { Db, Tx } from '@/server/db'
import { finaliseFlowInTransaction, readFlow } from '@/server/rules/orders/reader-flow'
import { reconcile } from '@/server/rules/orders/reconcile'
import { undoInTransaction, undoOrder } from '@/server/rules/orders/undo-order'
import { fixtures, insert } from '@/server/rules/testing/database'
import { deferred, Refused, waitingOn } from '@/server/rules/testing/race'
import { startRealPostgres, type RealPostgres } from '@/server/rules/testing/real-postgres'
import { FakeStripe } from '@/server/stripe/fake'
import { chargeCardFlow } from './flow'
import { lockAndLoadBooking } from './load-booking'
import { settleBooking } from './settle'

// Brief W19 on real Postgres 17.6, each Worker client on its own connection: two Settles at once on one booking, the
// press's C2 racing reconcile's, and W17 review S2 (step C's undo and a booking change's C1 take the booking in
// LOCK_ORDER, so they queue rather than deadlock). Each race holds one side open until Postgres reports the other
// waiting on it, so none can pass by timing.

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
  staffId = await insert(first, 'staff', { role: 'staff', first_name: 'Jo', last_name: 'Staff', email: 'w19-race@example.com' })
})

let minutes = 0
function nextSlot(): { start_time: string; end_time: string } {
  minutes += 90
  const start = new Date(Date.UTC(2032, 0, 1) + minutes * 60_000)
  return { start_time: start.toISOString(), end_time: new Date(start.getTime() + 60 * 60_000).toISOString() }
}

const options = (stripe: FakeStripe) => ({ actor: { type: 'staff' as const, id: staffId }, requestId: 'w19-race', stripe: () => stripe })

async function blockedBy(holder: number): Promise<number> {
  const giveUpAt = Date.now() + 4_000
  while (Date.now() < giveUpAt) {
    const rows = await pg.admin.unsafe<{ pid: number }[]>('SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))', [holder])
    if (rows[0]) return rows[0].pid
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Nothing waited on the holder.')
}

/**
 * The sessions queued behind `holder`, once `count` of them are: blocked by it, or by one already queued for the same
 * row (Postgres queues the second behind the first's tuple lock).
 */
async function allBlockedBy(holder: number, count: number): Promise<number[]> {
  const giveUpAt = Date.now() + 4_000
  while (Date.now() < giveUpAt) {
    const rows = await pg.admin.unsafe<{ pid: number }[]>(
      `WITH RECURSIVE queued(pid) AS (
         SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))
         UNION
         SELECT a.pid FROM pg_stat_activity a JOIN queued q ON q.pid = ANY(pg_blocking_pids(a.pid))
       ) SELECT pid FROM queued`,
      [holder]
    )
    if (rows.length >= count) return rows.map((row) => row.pid)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Fewer than ${count} waited on the holder.`)
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

/** A member's £20 seat whose credit lapsed: awaiting payment, with a saved card. */
async function lapsedSeat(stripe: FakeStripe): Promise<{ bookingId: string; customerId: string }> {
  const stripeCustomer = `cus_${crypto.randomUUID().slice(0, 8)}`
  stripe.addCustomer(stripeCustomer)
  const customerId = await fixtures.customer(first, { stripe_customer_id: stripeCustomer, saved_payment_method_id: 'pm_saved' })
  const slot = nextSlot()
  const sessionId = await fixtures.session(first, { service_type_id: serviceType, total_booked: 1, ...slot })
  const bookingId = await fixtures.booking(first, {
    session_id: sessionId,
    customer_id: customerId,
    price_paid: '0',
    status: 'payment_needed',
    redemption_source: 'membership_credit',
    ...slot,
  })
  await insert(first, 'booking_guests', { booking_id: bookingId, guest_type: 'account_holder', guest_name: 'Mo Member', unit_price: '20', pay_by: 'membership_credit' })
  return { bookingId, customerId }
}

const onCard = { payment: { method: 'card' }, figures: { amountDue: 20, toCollect: 20 } }
const statusOf = async (bookingId: string) => (await first.query<{ status: string; price_paid: string }>('SELECT status, price_paid::text AS price_paid FROM bookings WHERE id = $1', [bookingId]))[0]
const cardOrders = async (customerId: string) => (await first.query<{ n: number }>("SELECT count(*)::int AS n FROM orders WHERE customer_id = $1 AND payment_method = 'card'", [customerId]))[0]?.n
const outcome = (promise: Promise<unknown>) =>
  promise.then(
    (value) => ({ settled: value }),
    (err: unknown) => ({ refused: err instanceof ApiError ? (err.details as { reason?: string }).reason : String(err) })
  )

describe('two Settles at once on one booking (C1 takes the booking first)', () => {
  it('both wait on the booking; one settles with one charge, the other is refused as no longer awaiting payment', async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const { bookingId, customerId } = await lapsedSeat(stripe)
    const gate = await holding(first, (tx) => tx.query('SELECT id FROM bookings WHERE id = $1 FOR NO KEY UPDATE', [bookingId]))
    const a = outcome(settleBooking(second, bookingId, onCard, options(stripe)))
    const b = outcome(settleBooking(third, bookingId, onCard, options(stripe)))
    const waiters = await allBlockedBy(gate.pid, 2)
    for (const waiter of waiters) expect(await waitingOn(pg, waiter)).toEqual(['bookings'])
    await gate.finish()
    const answers = await Promise.all([a, b])
    expect(answers.filter((answer) => 'settled' in answer)).toHaveLength(1)
    expect(answers.filter((answer) => 'refused' in answer).map((answer) => (answer as { refused: string }).refused)).toEqual(['booking_not_payment_needed'])
    expect(stripe.calls.filter((call) => call.method === 'paymentIntents.create')).toHaveLength(1)
    expect(await statusOf(bookingId)).toEqual({ status: 'confirmed', price_paid: '20.00' })
    expect(await cardOrders(customerId)).toBe(1)
  })
})

describe("the press's C2 racing reconcile's (brief W19 Tests: finalise racing reconcile)", () => {
  it("the press's C2 holds the record; reconcile's C2 waits on it, then finds it finalised: one order, no charge from reconcile", async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const { bookingId, customerId } = await lapsedSeat(stripe)
    // C1 committed and the press got no clear answer (held); the record is past the window.
    stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
    stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
    expect(await outcome(settleBooking(first, bookingId, onCard, options(stripe)))).toMatchObject({ refused: 'payment_unconfirmed' })
    const pendingId = (await first.query<{ id: string }>("SELECT id FROM pending_reader_payments WHERE record_id = $1 AND status = 'pending'", [bookingId]))[0]?.id as string
    await first.query("UPDATE pending_reader_payments SET created_at = created_at - interval '20 minutes' WHERE id = $1", [pendingId])
    const row = (await readFlow(first, pendingId)) as Parameters<typeof chargeCardFlow>[1]
    const charge = await chargeCardFlow(stripe, row)
    if (charge.outcome !== 'answered') throw new Error('not charged')
    const press = await holding(first, () => finaliseFlowInTransaction(first, pendingId, charge.paymentIntent, { actor: { type: 'staff', id: staffId }, requestId: 'w19-press' }))
    expect(press.result).toMatchObject({ finalised: true, alreadyFinalised: false })
    const sent = stripe.calls.length
    const run = reconcile(second, stripe, { actor: { type: 'system', id: null }, requestId: 'w19-reconcile', maxItems: 50, budgetMs: 120_000 })
    const waiter = await blockedBy(press.pid)
    expect(await waitingOn(pg, waiter)).toEqual(['pending_reader_payments'])
    await press.finish()
    const result = await run
    expect(result.items.find((item) => item.id === pendingId)).toMatchObject({ outcome: 'settled_elsewhere', detail: 'finalised' })
    expect(stripe.calls.slice(sent).map((call) => call.method)).toEqual(['paymentIntents.list'])
    expect(await cardOrders(customerId)).toBe(1)
  })
})

describe("W17 review S2: step C's undo and a booking change's C1 take the booking in LOCK_ORDER", () => {
  /** A card order held pending (T1 committed), which made Mo's booking: what reconcile's undo, or the manual close, undoes. */
  async function heldCardOrder(): Promise<{ orderId: string; bookingId: string; customerId: string }> {
    const customerId = await fixtures.customer(first, { stripe_customer_id: `cus_${crypto.randomUUID().slice(0, 8)}`, saved_payment_method_id: 'pm_saved' })
    const slot = nextSlot()
    const sessionId = await fixtures.session(first, { service_type_id: serviceType, total_booked: 1, ...slot })
    const bookingId = await fixtures.booking(first, { session_id: sessionId, customer_id: customerId, price_paid: '20', status: 'confirmed', redemption_source: 'paid', ...slot })
    await insert(first, 'booking_guests', { booking_id: bookingId, guest_type: 'account_holder', guest_name: 'Mo Member', unit_price: '20', pay_by: 'paid' })
    const orderId = await insert(first, 'orders', {
      customer_id: customerId,
      order_total: '20',
      payment_status: 'pending',
      order_source: 'staff_created',
      reader_payment: JSON.stringify({ method: 'card', request_id: 'w19-s2', expected_amount: 20, created_at: new Date().toISOString() }),
    })
    await insert(first, 'order_line_items', { order_id: orderId, item_type: 'booking', quantity: 1, unit_price: '20', line_total: '20', booking_id: bookingId })
    return { orderId, bookingId, customerId }
  }
  const undoOptions = { actor: { type: 'system' as const, id: null }, requestId: 'w19-s2', why: 'S2 race' }

  it("C1 holding the booking: the undo waits on the booking, holding no customer lock, then finishes; nothing deadlocks", async () => {
    const { orderId, bookingId, customerId } = await heldCardOrder()
    const c1 = await holding(first, (tx) => lockAndLoadBooking(tx, { bookingId, ownSession: false }))
    const undo = undoOrder(second, orderId, undoOptions)
    const waiter = await blockedBy(c1.pid)
    expect(await waitingOn(pg, waiter)).toEqual(['bookings'])
    await c1.finish()
    expect(await undo).toMatchObject({ undone: true })
    expect(await statusOf(bookingId)).toBeUndefined()
    void customerId
  })

  it('the undo holding the booking (and then the customer): C1 waits on the booking, then finds it gone', async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const { orderId, bookingId } = await heldCardOrder()
    const undo = await holding(first, (tx) => undoInTransaction(tx, orderId, undoOptions))
    expect(undo.result).toMatchObject({ undone: true })
    const c1 = outcome(settleBooking(second, bookingId, { payment: { method: 'cash', confirmedCashAmount: 20 } }, options(stripe)))
    const waiter = await blockedBy(undo.pid)
    expect(await waitingOn(pg, waiter)).toEqual(['bookings'])
    await undo.finish()
    expect(await c1).toEqual({ refused: 'booking_not_found' })
  })

  it("the undo waiting on the booking holds nothing after it: the customer is still free (the old order took the customer first)", async () => {
    const { orderId, bookingId, customerId } = await heldCardOrder()
    const gate = await holding(first, (tx) => tx.query('SELECT id FROM bookings WHERE id = $1 FOR NO KEY UPDATE', [bookingId]))
    const undo = undoOrder(second, orderId, undoOptions)
    await blockedBy(gate.pid)
    // The undo is queued on the booking; the customer it gives back to is not locked by it yet.
    const free = await third.transaction(async (tx) => (await tx.query<{ id: string }>('SELECT id FROM customers WHERE id = $1 FOR NO KEY UPDATE NOWAIT', [customerId])).length)
    expect(free).toBe(1)
    await gate.finish()
    expect(await undo).toMatchObject({ undone: true })
  })

  it('control: the old order (the customer first, then the booking) against C1 (the booking, then the customer) does deadlock', async () => {
    const { bookingId, customerId } = await heldCardOrder()
    // The crossing itself, in two plain transactions with the old order.
    const a = pg.connect()
    const b = pg.connect()
    const hold = deferred()
    const aDone = a.transaction(async (tx) => {
      await tx.query('SELECT id FROM customers WHERE id = $1 FOR NO KEY UPDATE', [customerId])
      await hold.promise
      await tx.query('SELECT id FROM bookings WHERE id = $1 FOR UPDATE', [bookingId])
    })
    const bDone = b.transaction(async (tx) => {
      await tx.query('SELECT id FROM bookings WHERE id = $1 FOR NO KEY UPDATE', [bookingId])
      hold.resolve()
      await new Promise((resolve) => setTimeout(resolve, 200))
      await tx.query('SELECT id FROM customers WHERE id = $1 FOR NO KEY UPDATE', [customerId])
    })
    const settled = await Promise.allSettled([aDone, bDone])
    const failures = settled.filter((s) => s.status === 'rejected').map((s) => String((s as PromiseRejectedResult).reason?.detail ?? (s as PromiseRejectedResult).reason))
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatch(/40P01|deadlock/)
  })
})

