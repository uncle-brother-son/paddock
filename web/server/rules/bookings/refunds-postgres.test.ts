import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Db, Tx } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import { fixtures, insert } from '@/server/rules/testing/database'
import { deferred, Refused, waitingOn } from '@/server/rules/testing/race'
import { startRealPostgres, type RealPostgres } from '@/server/rules/testing/real-postgres'
import { FakeStripe } from '@/server/stripe/fake'
import { finishClaim, owedArrived, partRefund, readClaim, refundOwed, type RefundOptions } from './refunds'

// Brief W21 on real Postgres 17.6, each Worker client on its own connection: two refunds racing on one booking (store
// credit, and the card), the press's R2 racing reconcile's on one claim, and Refund the rest racing It already arrived.
// Each race holds the booking's lock open until Postgres reports both sides waiting on it, so none can pass by timing.

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

let publicType: string
let band: string
let staffId: string
beforeAll(async () => {
  publicType = await fixtures.serviceType(first)
  band = await fixtures.band(first, { price: '20.00' })
  staffId = await insert(first, 'staff', { role: 'staff', first_name: 'Jo', last_name: 'Staff', email: 'w21-race@example.com', can_issue_refunds: true })
})

let day = 0
function nextSlot(): { start_time: string; end_time: string } {
  day += 1
  const start = new Date(Date.UTC(2032, 2, day, 10))
  return { start_time: start.toISOString(), end_time: new Date(start.getTime() + 3_600_000).toISOString() }
}

/** A public booking for two (£40) paid on the card: its order, booking line and the fake's PaymentIntent. */
async function cardBooking(stripe: FakeStripe): Promise<{ bookingId: string; orderId: string; lineId: string }> {
  const customerId = await fixtures.customer(first)
  const slot = nextSlot()
  const sessionId = await fixtures.session(first, { service_type_id: publicType, band_id: band, capacity: 10, total_booked: 2, ...slot })
  const bookingId = await fixtures.booking(first, { session_id: sessionId, customer_id: customerId, price_paid: '40', party_size: 2, band_id: band, redemption_source: 'paid', ...slot })
  stripe.addCustomer('cus_w21')
  const intent = await stripe.paymentIntents.create({ amount: 4000, currency: 'gbp', customer: 'cus_w21', payment_method: 'pm_w21', off_session: true, confirm: true })
  const orderId = await insert(first, 'orders', { customer_id: customerId, order_total: '40.00', payment_status: 'paid', stripe_payment_intent_id: intent.id, payment_method: 'card', order_source: 'staff_created' })
  const lineId = await insert(first, 'order_line_items', { order_id: orderId, booking_id: bookingId, item_type: 'booking', quantity: 1, unit_price: '40.00', line_total: '40.00' })
  return { bookingId, orderId, lineId }
}

const options = (stripe: FakeStripe): RefundOptions => ({ actor: { type: 'staff', id: staffId }, requestId: 'w21-race', stripe: () => stripe })

/** The booking's lock held open on `third` until finished. */
async function holdingTheBooking(bookingId: string) {
  const release = deferred()
  let announce: (pid: number) => void = () => {}
  const ready = new Promise<number>((resolve) => {
    announce = resolve
  })
  const done = third
    .transaction(async (tx: Tx) => {
      await tx.query('SELECT id FROM bookings WHERE id = $1 FOR NO KEY UPDATE', [bookingId])
      announce((await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]?.pid as number)
      await release.promise
    })
    .catch((err: unknown) => {
      if (!(err instanceof Refused)) throw err
    })
  const pid = await ready
  return {
    pid,
    async finish() {
      release.resolve()
      await done
    },
  }
}

async function allBlockedBy(holderPid: number, count: number): Promise<number[]> {
  const giveUpAt = Date.now() + 4_000
  while (Date.now() < giveUpAt) {
    const rows = await pg.admin.unsafe<{ pid: number }[]>(
      `WITH RECURSIVE queued(pid) AS (
         SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))
         UNION
         SELECT a.pid FROM pg_stat_activity a JOIN queued q ON q.pid = ANY(pg_blocking_pids(a.pid))
       ) SELECT pid FROM queued`,
      [holderPid]
    )
    if (rows.length >= count) return rows.map((row) => row.pid)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Fewer than ${count} waited on the holder.`)
}

const outcome = (promise: Promise<unknown>) =>
  promise.then(
    (value) => ({ answered: value as Record<string, unknown> }),
    (err: unknown) => ({ refused: err instanceof ApiError ? ((err.details as { reason?: string } | undefined)?.reason ?? err.code) : String(err) })
  )
const bookingRow = async (bookingId: string) =>
  (
    await first.query<{ price_paid: string; part_refunded_amount: string; refund_owed_amount: string }>(
      'SELECT price_paid::text AS price_paid, part_refunded_amount::text AS part_refunded_amount, refund_owed_amount::text AS refund_owed_amount FROM bookings WHERE id = $1',
      [bookingId]
    )
  )[0]
const creditRefunds = async (bookingId: string) =>
  (await first.query<{ amount: string }>("SELECT amount::text AS amount FROM store_credit_transactions WHERE booking_id = $1 AND reason = 'refund'", [bookingId])).map((row) => row.amount)
const finishedRows = async (bookingId: string) =>
  (await first.query<{ n: number }>("SELECT count(*)::int AS n FROM audit_log WHERE action = 'booking.refund_finished' AND entity_id = $1", [bookingId]))[0]?.n

describe('two refunds racing (D-plan 4.11 item 5)', () => {
  it('two Part refunds to store credit: both wait on the booking; one gives £30, the other is refused (only £10 left) with the figures', async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const { bookingId } = await cardBooking(stripe)
    const gate = await holdingTheBooking(bookingId)
    const a = outcome(partRefund(first, bookingId, { amount: 30, refundMethod: 'credit', reason: 'Goodwill' }, options(stripe)))
    const b = outcome(partRefund(second, bookingId, { amount: 30, refundMethod: 'credit', reason: 'Goodwill' }, options(stripe)))
    const waiters = await allBlockedBy(gate.pid, 2)
    for (const waiter of waiters) expect(await waitingOn(pg, waiter)).toEqual(['bookings'])
    await gate.finish()
    const answers = await Promise.all([a, b])
    expect(answers.filter((answer) => 'answered' in answer)).toHaveLength(1)
    expect(answers.filter((answer) => 'refused' in answer)).toEqual([{ refused: 'more_than_left' }])
    expect(await bookingRow(bookingId)).toEqual({ price_paid: '10.00', part_refunded_amount: '30.00', refund_owed_amount: '0.00' })
    expect(await creditRefunds(bookingId)).toEqual(['30.00'])
  })

  it('two Part refunds to the card: one refund is sent; the other is refused (held claim or too little left), never a second refund', async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const { bookingId } = await cardBooking(stripe)
    const gate = await holdingTheBooking(bookingId)
    const a = outcome(partRefund(first, bookingId, { amount: 30, refundMethod: 'card', reason: 'Goodwill' }, options(stripe)))
    const b = outcome(partRefund(second, bookingId, { amount: 30, refundMethod: 'card', reason: 'Goodwill' }, options(stripe)))
    await allBlockedBy(gate.pid, 2)
    await gate.finish()
    const answers = await Promise.all([a, b])
    expect(answers.filter((answer) => 'answered' in answer)).toHaveLength(1)
    const refused = answers.find((answer) => 'refused' in answer) as { refused: string }
    expect(['refund_open', 'more_than_left']).toContain(refused.refused)
    expect(stripe.calls.filter((call) => call.method === 'refunds.create')).toHaveLength(1)
    expect(await bookingRow(bookingId)).toMatchObject({ price_paid: '10.00', part_refunded_amount: '30.00' })
    expect(await finishedRows(bookingId)).toBe(1)
  })

  it("Refund the rest racing It already arrived on £20 owed: one wins, the other finds nothing owed", async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const { bookingId } = await cardBooking(stripe)
    await first.query('UPDATE bookings SET refund_owed_amount = 20 WHERE id = $1', [bookingId])
    const gate = await holdingTheBooking(bookingId)
    const a = outcome(refundOwed(first, bookingId, { amount: 20, refundMethod: 'credit' }, options(stripe)))
    const b = outcome(owedArrived(second, bookingId, { amount: 20, reason: 'Seen in Stripe' }, options(stripe)))
    await allBlockedBy(gate.pid, 2)
    await gate.finish()
    const answers = await Promise.all([a, b])
    expect(answers.filter((answer) => 'answered' in answer)).toHaveLength(1)
    expect(answers.filter((answer) => 'refused' in answer)).toEqual([{ refused: 'nothing_owed' }])
    expect(await bookingRow(bookingId)).toMatchObject({ price_paid: '20.00', refund_owed_amount: '0.00' })
  })
})

describe("the press's R2 racing reconcile's on one held claim", () => {
  it('both wait on the booking; one records the card part, the other finds it finished: recorded once, one finished row', async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const { bookingId, lineId } = await cardBooking(stripe)
    stripe.failNext('refunds.create', { kind: 'lost_response' })
    stripe.failNext('refunds.create', { kind: 'lost_response' })
    const held = (await partRefund(first, bookingId, { amount: 25, refundMethod: 'card', reason: 'Goodwill' }, options(stripe))) as { held?: { claimId: string } }
    const claim = await readClaim(first, held.held?.claimId ?? '')
    if (!claim) throw new Error('No claim.')
    const went = { went: claim.details.plan.card, owed: 0 }
    const gate = await holdingTheBooking(bookingId)
    const a = outcome(finishClaim(first, claim, went, { actor: { type: 'staff', id: staffId }, requestId: 'press', how: 'press' }))
    const b = outcome(finishClaim(second, claim, went, { actor: { type: 'system', id: null }, requestId: 'reconcile', how: 'reconcile' }))
    await allBlockedBy(gate.pid, 2)
    await gate.finish()
    const answers = (await Promise.all([a, b])) as Array<{ answered?: unknown }>
    expect(answers.filter((answer) => answer.answered !== null && answer.answered !== undefined)).toHaveLength(1)
    expect(answers.filter((answer) => answer.answered === null)).toHaveLength(1)
    const line = (await first.query<{ card: string }>('SELECT card_refunded_amount::text AS card FROM order_line_items WHERE id = $1', [lineId]))[0]
    expect(line?.card).toBe('25')
    expect(await finishedRows(bookingId)).toBe(1)
  })
})
