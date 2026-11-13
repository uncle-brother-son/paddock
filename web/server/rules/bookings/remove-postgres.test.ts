import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Db, Tx } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import { fixtures, insert } from '@/server/rules/testing/database'
import { deferred, Refused, waitingOn } from '@/server/rules/testing/race'
import { startRealPostgres, type RealPostgres } from '@/server/rules/testing/real-postgres'
import { FakeStripe } from '@/server/stripe/fake'
import { removeAddon, type RemoveAddonOptions } from './remove-addon'
import { removeGuest, type RemoveGuestOptions } from './remove-guest'

// Brief W22 on real Postgres 17.6, each Worker client on its own connection: two tabs removing the same guest (W02
// finding 11: the old lock didn't stop a second refund), and two removing the same add-on. Each race holds the
// booking's lock open until Postgres reports both presses waiting on it, so neither can pass by timing.

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
  staffId = await insert(first, 'staff', { role: 'staff', first_name: 'Jo', last_name: 'Staff', email: 'w22-race@example.com', can_issue_refunds: true })
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
  stripe.addCustomer('cus_w22')
  const intent = await stripe.paymentIntents.create({ amount: 6500, currency: 'gbp', customer: 'cus_w22', payment_method: 'pm_w22', off_session: true, confirm: true })
  const orderId = await insert(first, 'orders', { customer_id: customerId, order_total: '65.00', payment_status: 'paid', stripe_payment_intent_id: intent.id, payment_method: 'card', order_source: 'staff_created' })
  await insert(first, 'order_line_items', { order_id: orderId, booking_id: bookingId, item_type: 'booking', quantity: 1, unit_price: '60.00', line_total: '60.00' })
  const addonLineId = await insert(first, 'addon_order_lines', { booking_id: bookingId, addon_id: addonId, quantity: 1, price_at_purchase: '5.00', sku_at_purchase: 'TOWEL', redemption_source: 'paid', order_id: orderId })
  return { bookingId, sessionId, guestId, addonLineId }
}

const options = (stripe: FakeStripe): RemoveGuestOptions & RemoveAddonOptions => ({ actor: { type: 'staff', id: staffId }, requestId: 'w22-race', stripe: () => stripe, canIssueRefunds: true })

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
const creditRefunds = async (bookingId: string) =>
  (await first.query<{ amount: string }>("SELECT amount::text AS amount FROM store_credit_transactions WHERE booking_id = $1 AND reason = 'refund'", [bookingId])).map((row) => row.amount)

describe('two tabs removing the same guest (W02 finding 11, D-plan 4.11 item 5)', () => {
  it('to store credit: both wait on the booking; one removes and gives £20, the other finds the guest gone', async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const { bookingId, sessionId, guestId } = await cardBookingWithAGuest(stripe)
    const gate = await holdingTheBooking(bookingId)
    const a = outcome(removeGuest(first, guestId, { confirmedRefundAmount: 20, refundMethod: 'credit' }, options(stripe)))
    const b = outcome(removeGuest(second, guestId, { confirmedRefundAmount: 20, refundMethod: 'credit' }, options(stripe)))
    const waiters = await allBlockedBy(gate.pid, 2)
    for (const waiter of waiters) expect(await waitingOn(pg, waiter)).toEqual(['bookings'])
    await gate.finish()
    const answers = await Promise.all([a, b])
    expect(answers.filter((answer) => 'answered' in answer)).toHaveLength(1)
    expect(answers.filter((answer) => 'refused' in answer)).toEqual([{ refused: 'guest_not_found' }])
    expect(await state(bookingId, sessionId)).toEqual({ price_paid: '40.00', party_size: 2, total_booked: 2, guests: 2 })
    expect(await creditRefunds(bookingId)).toEqual(['20.00'])
  })

  it('to the card: one refund is sent, one place released; never a second refund', async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const { bookingId, sessionId, guestId } = await cardBookingWithAGuest(stripe)
    const gate = await holdingTheBooking(bookingId)
    const a = outcome(removeGuest(first, guestId, { confirmedRefundAmount: 20, refundMethod: 'card' }, options(stripe)))
    const b = outcome(removeGuest(second, guestId, { confirmedRefundAmount: 20, refundMethod: 'card' }, options(stripe)))
    await allBlockedBy(gate.pid, 2)
    await gate.finish()
    const answers = await Promise.all([a, b])
    expect(answers.filter((answer) => 'answered' in answer)).toHaveLength(1)
    expect(answers.filter((answer) => 'refused' in answer)).toEqual([{ refused: 'guest_not_found' }])
    expect(stripe.calls.filter((call) => call.method === 'refunds.create')).toHaveLength(1)
    expect(await state(bookingId, sessionId)).toEqual({ price_paid: '40.00', party_size: 2, total_booked: 2, guests: 2 })
  })

  it("both tabs see the guest before either press (what the old code's claim raced on); the second press, after the first, finds it gone", async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const { bookingId, guestId } = await cardBookingWithAGuest(stripe)
    // Both reads before either change: what two tabs saw before the claim was the guest's own row.
    const seen = await Promise.all([first, second].map(async (db) => (await db.query<{ id: string }>('SELECT id FROM booking_guests WHERE id = $1', [guestId])).length))
    expect(seen).toEqual([1, 1])
    // With the lock, the second waits and reads again after the first committed: gone.
    await removeGuest(first, guestId, { confirmedRefundAmount: 20, refundMethod: 'credit' }, options(stripe))
    expect(await outcome(removeGuest(second, guestId, { confirmedRefundAmount: 20, refundMethod: 'credit' }, options(stripe)))).toEqual({ refused: 'guest_not_found' })
    expect(await creditRefunds(bookingId)).toEqual(['20.00'])
  })
})

describe('two tabs removing the same add-on', () => {
  it('to the card: both wait on the booking; one refund of £5, the other finds it removed', async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const { bookingId, addonLineId } = await cardBookingWithAGuest(stripe)
    const gate = await holdingTheBooking(bookingId)
    const a = outcome(removeAddon(first, addonLineId, { refund: 'card', confirmed: { refund: 5 } }, options(stripe)))
    const b = outcome(removeAddon(second, addonLineId, { refund: 'card', confirmed: { refund: 5 } }, options(stripe)))
    await allBlockedBy(gate.pid, 2)
    await gate.finish()
    const answers = await Promise.all([a, b])
    expect(answers.filter((answer) => 'answered' in answer)).toHaveLength(1)
    expect(answers.filter((answer) => 'refused' in answer)).toEqual([{ refused: 'already_removed' }])
    expect(stripe.calls.filter((call) => call.method === 'refunds.create').map((call) => (call.params as { amount: number }).amount)).toEqual([500])
    const line = (await first.query<{ card: string; method: string }>('SELECT card_refunded_amount::text AS card, refund_method AS method FROM addon_order_lines WHERE id = $1', [addonLineId]))[0]
    expect(line).toEqual({ card: '5', method: 'card' })
  })

  it('a guest removal racing an add-on removal on one booking: each refunded at most once; the second goes through after, or is refused while the first\'s refund is still open', async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const { bookingId, sessionId, guestId, addonLineId } = await cardBookingWithAGuest(stripe)
    const gate = await holdingTheBooking(bookingId)
    const a = outcome(removeGuest(first, guestId, { confirmedRefundAmount: 20, refundMethod: 'card' }, options(stripe)))
    const b = outcome(removeAddon(second, addonLineId, { refund: 'card', confirmed: { refund: 5 } }, options(stripe)))
    await allBlockedBy(gate.pid, 2)
    await gate.finish()
    const answers = await Promise.all([a, b])
    const refused = answers.filter((answer): answer is { refused: string } => 'refused' in answer)
    expect(refused.every((answer) => answer.refused === 'refund_open')).toBe(true)
    expect(answers.filter((answer) => 'answered' in answer).length).toBeGreaterThanOrEqual(1)
    const amounts = stripe.calls.filter((call) => call.method === 'refunds.create').map((call) => (call.params as { amount: number }).amount)
    expect(amounts.filter((amount) => amount === 2000).length).toBeLessThanOrEqual(1)
    expect(amounts.filter((amount) => amount === 500).length).toBeLessThanOrEqual(1)
    expect(amounts).toHaveLength(answers.length - refused.length)
    // Whatever order they ran in, the guest's removal left the booking at two with £40.
    if ('answered' in (answers[0] ?? {})) expect(await state(bookingId, sessionId)).toMatchObject({ price_paid: '40.00', party_size: 2 })
  })
})
