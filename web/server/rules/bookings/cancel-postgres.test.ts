import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Db, Tx } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import { fixtures, insert } from '@/server/rules/testing/database'
import { deferred, Refused, waitingOn } from '@/server/rules/testing/race'
import { startRealPostgres, type RealPostgres } from '@/server/rules/testing/real-postgres'
import { FakeStripe } from '@/server/stripe/fake'
import { cancelAndRefund, cancelCredit, type CancelOptions } from './cancel'
import { partRefund, type RefundOptions } from './refunds'

// Brief W23 on real Postgres 17.6, each Worker client on its own connection: two tabs cancelling the same booking (one
// refund, one cancel), a Cancel & Refund racing a Part refund on one booking (never more back than was paid), and two
// tabs cancelling a pass booking (its session back once). Each race holds the booking's lock open until Postgres reports
// both presses waiting on it, so neither can pass by timing.

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
let addonId: string
beforeAll(async () => {
  publicType = await fixtures.serviceType(first)
  band = await fixtures.band(first, { price: '20.00' })
  staffId = await insert(first, 'staff', { role: 'staff', first_name: 'Jo', last_name: 'Staff', email: 'w23-race@example.com', can_issue_refunds: true })
  addonId = await insert(first, 'addons', { name: 'Towel', base_price: '5.00', sku: 'TOWEL' })
})

let day = 0
function nextSlot(): { start_time: string; end_time: string } {
  day += 1
  const start = new Date(Date.UTC(2032, 3, day, 10))
  return { start_time: start.toISOString(), end_time: new Date(start.getTime() + 3_600_000).toISOString() }
}

/**
 * A public booking for three (£60) paid on the card, with a £5 Towel on the same order (£65): Sam (seat 1) and Bea (£20,
 * paid). Its order, booking line, add-on line, and the fake's PaymentIntent.
 */
async function cardBookingWithAGuest(stripe: FakeStripe): Promise<{ bookingId: string; sessionId: string; guestId: string; addonLineId: string }> {
  const customerId = await fixtures.customer(first)
  const slot = nextSlot()
  const sessionId = await fixtures.session(first, { service_type_id: publicType, band_id: band, capacity: 10, total_booked: 3, ...slot })
  const bookingId = await fixtures.booking(first, { session_id: sessionId, customer_id: customerId, price_paid: '60', party_size: 3, band_id: band, redemption_source: 'paid', ...slot })
  await insert(first, 'booking_guests', { booking_id: bookingId, guest_type: 'account_holder', guest_name: 'Sam Test', unit_price: '20.00', pay_by: 'paid' })
  await insert(first, 'booking_guests', { booking_id: bookingId, guest_type: 'additional_guest', guest_name: 'Alex Guest', unit_price: '20.00', pay_by: 'paid' })
  const guestId = await insert(first, 'booking_guests', { booking_id: bookingId, guest_type: 'additional_guest', guest_name: 'Bea Guest', unit_price: '20.00', pay_by: 'paid' })
  stripe.addCustomer('cus_w23')
  const intent = await stripe.paymentIntents.create({ amount: 6500, currency: 'gbp', customer: 'cus_w23', payment_method: 'pm_w23', off_session: true, confirm: true })
  const orderId = await insert(first, 'orders', { customer_id: customerId, order_total: '65.00', payment_status: 'paid', stripe_payment_intent_id: intent.id, payment_method: 'card', order_source: 'staff_created' })
  await insert(first, 'order_line_items', { order_id: orderId, booking_id: bookingId, item_type: 'booking', quantity: 1, unit_price: '60.00', line_total: '60.00' })
  const addonLineId = await insert(first, 'addon_order_lines', { booking_id: bookingId, addon_id: addonId, quantity: 1, price_at_purchase: '5.00', sku_at_purchase: 'TOWEL', redemption_source: 'paid', order_id: orderId })
  return { bookingId, sessionId, guestId, addonLineId }
}

const options = (stripe: FakeStripe): CancelOptions & RefundOptions => ({ actor: { type: 'staff', id: staffId }, requestId: 'w23-race', stripe: () => stripe, canIssueRefunds: true })

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
const state = async (bookingId: string, sessionId: string) =>
  (
    await first.query<{ price_paid: string; party_size: number; total_booked: number; guests: number }>(
      `SELECT b.price_paid::text AS price_paid, b.party_size, s.total_booked, (SELECT count(*)::int FROM booking_guests g WHERE g.booking_id = b.id) AS guests
       FROM bookings b JOIN sessions s ON s.id = $2 WHERE b.id = $1`,
      [bookingId, sessionId]
    )
  )[0]

describe('two tabs cancelling the same booking (brief W23 Tests; D-plan 4.11 item 5)', () => {
  it('Cancel & Refund with the towel ticked: both wait on the booking; one cancels with one £65 card refund, the other finds it cancelled', async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const { bookingId, sessionId, addonLineId } = await cardBookingWithAGuest(stripe)
    const press = (db: Db) => outcome(cancelAndRefund(db, bookingId, { refundMethod: 'card', addonLineIds: [addonLineId], confirmed: { refund: 60, addonsRefund: 5 } }, options(stripe)))
    const gate = await holdingTheBooking(bookingId)
    const a = press(first)
    const b = press(second)
    const waiters = await allBlockedBy(gate.pid, 2)
    for (const waiter of waiters) expect(await waitingOn(pg, waiter)).toEqual(['bookings'])
    await gate.finish()
    const answers = await Promise.all([a, b])
    expect(answers.filter((answer) => 'answered' in answer)).toHaveLength(1)
    // The second press runs R1 once the first's R1 has committed: its claim is still open while its card part is sent
    // (refund_open), or finished already (already_cancelled). Either way nothing is cancelled or refunded twice.
    const refused = answers.filter((answer): answer is { refused: string } => 'refused' in answer).map((answer) => answer.refused)
    expect(refused).toHaveLength(1)
    expect(['refund_open', 'already_cancelled']).toContain(refused[0])
    expect(stripe.calls.filter((call) => call.method === 'refunds.create').map((call) => (call.params as { amount: number }).amount)).toEqual([6500])
    expect(await state(bookingId, sessionId)).toMatchObject({ price_paid: '60.00', total_booked: 0 })
    expect((await first.query<{ status: string }>('SELECT status FROM bookings WHERE id = $1', [bookingId]))[0]?.status).toBe('cancelled')
  })

  it('Cancel & Refund racing a Part refund: each runs at most once, and never more back than was paid', async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const { bookingId } = await cardBookingWithAGuest(stripe)
    const gate = await holdingTheBooking(bookingId)
    const a = outcome(cancelAndRefund(first, bookingId, { refundMethod: 'card', addonLineIds: [], confirmed: { refund: 60, addonsRefund: 0 } }, options(stripe)))
    const b = outcome(partRefund(second, bookingId, { amount: 20, refundMethod: 'card', reason: 'Goodwill' }, options(stripe)))
    await allBlockedBy(gate.pid, 2)
    await gate.finish()
    const answers = await Promise.all([a, b])
    // Whichever went second was refused: after the cancel, as cancelled (or its claim still open); after the part refund,
    // as its claim still open, or its figures moved (£40 left).
    const refused = answers.filter((answer): answer is { refused: string } => 'refused' in answer).map((answer) => answer.refused)
    expect(refused).toHaveLength(1)
    expect(refused.every((reason) => ['already_cancelled', 'refund_changed', 'refund_open'].includes(reason))).toBe(true)
    const pence = stripe.calls.filter((call) => call.method === 'refunds.create').reduce((total, call) => total + (call.params as { amount: number }).amount, 0)
    expect(pence).toBeLessThanOrEqual(6000)
  })

  it('Cancel & return credit, two tabs on a pass booking: one cancel, the pass session back once', async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const customerId = await fixtures.customer(first)
    const slot = nextSlot()
    const sessionId = await fixtures.session(first, { service_type_id: publicType, band_id: band, capacity: 10, total_booked: 1, ...slot })
    const passTypeId = await insert(first, 'session_pass_types', { name: 'Five', price: '50.00', sessions_included: 5, level: 'all_access' })
    const passId = await insert(first, 'customer_session_passes', { customer_id: customerId, pass_type_id: passTypeId, sessions_remaining: 2, expiry_date: '2040-01-01' })
    const bookingId = await fixtures.booking(first, {
      session_id: sessionId,
      customer_id: customerId,
      price_paid: '0',
      party_size: 1,
      band_id: band,
      redemption_source: 'session_pass_credit',
      redeemed_session_pass_id: passId,
      ...slot,
    })
    await insert(first, 'booking_guests', { booking_id: bookingId, guest_type: 'account_holder', guest_name: 'Sam Test', unit_price: '20.00', pay_by: 'session_pass_credit' })
    const gate = await holdingTheBooking(bookingId)
    const a = outcome(cancelCredit(first, bookingId, {}, options(stripe)))
    const b = outcome(cancelCredit(second, bookingId, {}, options(stripe)))
    await allBlockedBy(gate.pid, 2)
    await gate.finish()
    const answers = await Promise.all([a, b])
    expect(answers.filter((answer) => 'answered' in answer)).toHaveLength(1)
    expect(answers.filter((answer) => 'refused' in answer)).toEqual([{ refused: 'not_cancellable' }])
    expect((await first.query<{ n: number }>('SELECT sessions_remaining AS n FROM customer_session_passes WHERE id = $1', [passId]))[0]?.n).toBe(3)
    expect((await first.query<{ n: number }>('SELECT total_booked AS n FROM sessions WHERE id = $1', [sessionId]))[0]?.n).toBe(0)
  })
})
