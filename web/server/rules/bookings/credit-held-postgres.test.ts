import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PlaceOrderInput } from '@/contracts'
import type { Db, Tx } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import { adjustMembershipCredits } from '@/server/rules/memberships/credits'
import { refusalDetails } from '@/server/rules/orders/order-refusal'
import { placeOrder } from '@/server/rules/orders/place-order'
import { cancelReaderFlow, finaliseReaderFlow } from '@/server/rules/orders/reader-flow'
import { fixtures, insert } from '@/server/rules/testing/database'
import { deferred, waitingOn } from '@/server/rules/testing/race'
import { startRealPostgres, type RealPostgres } from '@/server/rules/testing/real-postgres'
import { FakeStripe, fakeStripeErrors } from '@/server/stripe/fake'
import { moveBooking, type MoveOptions } from './move'
import { settleBooking } from './settle'

// Brief W37a item 1 (W37 review S1) on real Postgres 17.6, each Worker client on its own connection. A membership
// session credit a Move or a Settle releases, with card money still to come, stays on the booking until the payment
// lands (C2), so nobody can spend it while the payment is pending and the undo has nothing to take back. A cheaper
// Move's put back (the first card part refused) takes the credit back only while its period still has one free, under
// the period's lock; otherwise the move stands and the money is owed. In every case: used never above allocated.
// Stripe is only ever the fake.

let pg: RealPostgres
let first: Db
let second: Db
let third: Db
let staffId: string
let serviceType: string
/** £20, and a Core member's credit covers it. */
let core: string
/** £25.50, no credit: a credit seat moved here is released and charged in full. */
let peak: string
/** £10, no credit: two paid £20 guests moved here get £20 back between them, the released credit seat pays £10. */
let offPeak: string
let plan: string
let day = 0

beforeAll(async () => {
  pg = await startRealPostgres()
  first = pg.connect()
  second = pg.connect()
  third = pg.connect()
  staffId = await insert(first, 'staff', { role: 'staff', first_name: 'Jo', last_name: 'Staff', email: 'w37a-credit@example.com', can_issue_refunds: true })
  serviceType = await fixtures.serviceType(first)
  core = await fixtures.band(first, { price: '20.00' })
  peak = await fixtures.band(first, { price: '25.50' })
  offPeak = await fixtures.band(first, { price: '10.00' })
  plan = await fixtures.plan(first, { level: 'core', sessions_included: 4 })
  await insert(first, 'membership_band_terms', { membership_level: 'core', band_id: core, credit_eligible: true })
})
afterAll(() => pg.stop())

const slot = (onDay: number, hour: number) => {
  const start = new Date(Date.UTC(2031, 0, onDay, hour))
  return { start_time: start.toISOString(), end_time: new Date(start.getTime() + 3_600_000).toISOString() }
}
/** A day of its own, so the one-booking-a-day rule never joins two tests (or two of a member's bookings). */
const nextDay = (): number => (day += 1)
const sessionOn = (onDay: number, hour: number, band: string) => fixtures.session(first, { service_type_id: serviceType, band_id: band, capacity: 10, ...slot(onDay, hour) })

interface Member {
  customer: string
  membership: string
  period: string
  stripeCustomer: string
}

/** A Core member with a saved card and `credits` session credits in a period covering today. */
async function member(stripe: FakeStripe, credits: number): Promise<Member> {
  const stripeCustomer = `cus_w37a_${crypto.randomUUID().slice(0, 8)}`
  stripe.addCustomer(stripeCustomer)
  const customer = await fixtures.customer(first, { stripe_customer_id: stripeCustomer, saved_payment_method_id: 'pm_w37a' })
  const membership = await fixtures.membership(first, { customer_id: customer, plan_id: plan, is_herd: true, billing_frequency: 'monthly', addon_credits_remaining: 0 })
  const rows = await first.query<{ id: string }>(
    `INSERT INTO membership_credit_periods (membership_id, period_start, period_end, credits_allocated)
     VALUES ($1, (now() AT TIME ZONE 'Europe/London')::date - 5, (now() AT TIME ZONE 'Europe/London')::date + 25, $2) RETURNING id`,
    [membership, credits]
  )
  return { customer, membership, period: rows[0]?.id as string, stripeCustomer }
}

const holderGuest = { name: 'Mo Member', email: 'mo@example.com', dateOfBirth: '1990-01-01' }
const creditOrder = (who: Member, sessionId: string): PlaceOrderInput => ({
  customerId: who.customer,
  booking: { sessionId, guests: [holderGuest], redemptionSource: 'membership_credit', membershipId: who.membership },
  payment: {},
})
const orderBy = () => ({ actor: { type: 'staff' as const, id: staffId }, requestId: crypto.randomUUID() })
const moveBy = (stripe: FakeStripe): MoveOptions => ({ actor: { type: 'staff', id: staffId }, requestId: crypto.randomUUID(), stripe: () => stripe, canIssueRefunds: true })
const flowBy = () => ({ actor: { type: 'staff' as const, id: staffId }, requestId: crypto.randomUUID() })
const adjustBy = () => ({ actor: { type: 'staff' as const, id: staffId, canIssueRefunds: true }, requestId: crypto.randomUUID() })
const minusOne = { creditType: 'session' as const, amount: -1, reason: 'W37a proof' }

type Outcome<T> = { answered: T } | { refused: string; message: string }
async function outcome<T>(work: Promise<T>): Promise<Outcome<T>> {
  try {
    return { answered: await work }
  } catch (err) {
    const order = refusalDetails(err)
    if (order) return { refused: order.reason, message: err instanceof Error ? err.message : '' }
    if (err instanceof ApiError) return { refused: String((err.details as { reason?: unknown } | undefined)?.reason ?? err.code), message: err.message }
    throw err
  }
}

/** A credit booking on a Core session of its own day, placed by the Worker's own placeOrder. */
async function creditBooking(who: Member, onDay = nextDay()): Promise<{ bookingId: string; sessionId: string; onDay: number }> {
  const sessionId = await sessionOn(onDay, 10, core)
  const placed = await placeOrder(first, creditOrder(who, sessionId), orderBy())
  const bookingId = (placed as { bookingId?: string }).bookingId
  if (!bookingId) throw new Error(`No credit booking was placed: ${JSON.stringify(placed)}`)
  return { bookingId, sessionId, onDay }
}

/**
 * A booking for three on a Core session: the member on a credit, two guests paid £20 each on the card (one £40 order
 * with the fake's PaymentIntent). Moved to an off-peak session the credit is released (+£10) and the guests are £10
 * cheaper each: £10 back, to the card.
 */
async function creditSeatWithTwoPaidGuests(stripe: FakeStripe, who: Member): Promise<{ bookingId: string; sessionId: string; onDay: number }> {
  const onDay = nextDay()
  const times = slot(onDay, 10)
  const sessionId = await sessionOn(onDay, 10, core)
  const bookingId = await fixtures.booking(first, {
    session_id: sessionId,
    customer_id: who.customer,
    price_paid: '40',
    party_size: 3,
    band_id: core,
    redemption_source: 'membership_credit',
    redeemed_membership_id: who.membership,
    credit_period_id: who.period,
    ...times,
  })
  await first.query('UPDATE sessions SET total_booked = total_booked + 3 WHERE id = $1', [sessionId])
  await insert(first, 'booking_guests', { booking_id: bookingId, guest_type: 'account_holder', guest_name: 'Mo Member', unit_price: '20.00', pay_by: 'membership_credit' })
  await insert(first, 'booking_guests', { booking_id: bookingId, guest_type: 'additional_guest', guest_name: 'Alex Guest', unit_price: '20.00', pay_by: 'paid' })
  await insert(first, 'booking_guests', { booking_id: bookingId, guest_type: 'additional_guest', guest_name: 'Bea Guest', unit_price: '20.00', pay_by: 'paid' })
  const intent = await stripe.paymentIntents.create({ amount: 4000, currency: 'gbp', customer: who.stripeCustomer, payment_method: 'pm_w37a', off_session: true, confirm: true })
  const orderId = await insert(first, 'orders', { customer_id: who.customer, order_total: '40.00', payment_status: 'paid', stripe_payment_intent_id: intent.id, payment_method: 'card', order_source: 'staff_created' })
  await insert(first, 'order_line_items', { order_id: orderId, booking_id: bookingId, item_type: 'booking', quantity: 1, unit_price: '40.00', line_total: '40.00' })
  return { bookingId, sessionId, onDay }
}

const one = async <T>(sql: string, params: unknown[]): Promise<T | undefined> => (await third.query<T>(sql, params as never[]))[0]
const allocated = async (period: string) => (await one<{ n: number }>('SELECT credits_allocated AS n FROM membership_credit_periods WHERE id = $1', [period]))?.n
/** Used, as New Order counts it before it gives a credit (write-booking.ts). */
const used = async (period: string) =>
  (await one<{ n: number }>(`SELECT count(*)::int AS n FROM bookings WHERE credit_period_id = $1 AND redemption_source = 'membership_credit' AND status <> 'cancelled'`, [period]))?.n
/** Used and allocated, as the staff app's credit panel reads them (the database's own view). */
const viewOf = async (membership: string) => one<{ credits_used: number; credits_allocated: number }>('SELECT credits_used, credits_allocated FROM membership_current_credits WHERE membership_id = $1', [membership])
type BookingRow = { session_id: string; status: string; redemption_source: string; credit_period_id: string | null; redeemed_membership_id: string | null; price_paid: string; refund_owed_amount: string }
const bookingRow = (bookingId: string) =>
  one<BookingRow>(
    `SELECT session_id, status, redemption_source, credit_period_id, redeemed_membership_id, price_paid::text AS price_paid, refund_owed_amount::text AS refund_owed_amount
     FROM bookings WHERE id = $1`,
    [bookingId]
  )
const seatOne = async (bookingId: string) => (await one<{ pay_by: string }>("SELECT pay_by FROM booking_guests WHERE booking_id = $1 AND guest_type = 'account_holder'", [bookingId]))?.pay_by
const flowOf = (bookingId: string) => one<{ id: string; status: string; snapshot: Record<string, unknown> }>('SELECT id, status, snapshot FROM pending_reader_payments WHERE record_id = $1', [bookingId])
const auditOf = async (entityId: string, action: string) => (await third.query<{ details: Record<string, unknown> }>('SELECT details FROM audit_log WHERE entity_id = $1 AND action = $2 ORDER BY at, ctid', [entityId, action])).map((row) => row.details)

/** Used is never above allocated, by both counts. */
async function neverAbove(who: Member): Promise<void> {
  expect(await used(who.period)).toBeLessThanOrEqual((await allocated(who.period)) ?? -1)
  const view = await viewOf(who.membership)
  expect(view?.credits_used).toBeLessThanOrEqual(view?.credits_allocated ?? -1)
}

type Pending = { pendingId: string; paymentIntentId: string }
const pendingOf = (answer: unknown): Pending => {
  const pending = (answer as { pendingReaderPayment?: Pending }).pendingReaderPayment
  if (!pending) throw new Error(`No reader payment was started: ${JSON.stringify(answer)}`)
  return pending
}

/** The review's example: 4 allocated, 4 used (three other credit bookings and A), A moved to a £25.50 session on the reader. */
async function fourOfFourThenAOnTheReader(stripe: FakeStripe) {
  const who = await member(stripe, 4)
  for (let i = 0; i < 3; i += 1) await creditBooking(who)
  const a = await creditBooking(who)
  expect([await used(who.period), await allocated(who.period)]).toEqual([4, 4])
  const peakSession = await sessionOn(a.onDay, 18, peak)
  const answer = await moveBooking(first, a.bookingId, { newSessionId: peakSession, confirmed: true, figures: { amountDue: 25.5, toCollect: 25.5 }, payment: { method: 'reader' } }, moveBy(stripe))
  return { who, a, peakSession, pending: pendingOf(answer) }
}

describe('a Move on the reader that releases a membership credit (the review\'s example: 4 allocated, 4 used)', () => {
  it('while the reader waits the credit is still used: a second credit booking and a -1 adjustment are both refused; the payment cancelled, A is back on its credit with 4 used of 4, never 5', async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const { who, a, peakSession, pending } = await fourOfFourThenAOnTheReader(stripe)

    // C1: A is on the new session and its seat is a paid one, but the credit hasn't been released.
    expect(await bookingRow(a.bookingId)).toMatchObject({ session_id: peakSession, redemption_source: 'membership_credit', credit_period_id: who.period, price_paid: '25.50' })
    expect(await seatOne(a.bookingId)).toBe('paid')
    expect((await flowOf(a.bookingId))?.snapshot).toMatchObject({ release_credit_on_finalise: true, old_credit_period_id: who.period, old_redemption_source: 'membership_credit' })
    expect(await used(who.period)).toBe(4)

    // A second staff member tries the credit for booking B: there is none.
    const sessionB = await sessionOn(nextDay(), 10, core)
    expect(await outcome(placeOrder(second, creditOrder(who, sessionB), orderBy()))).toMatchObject({ refused: 'insufficient_membership_credit' })
    // And a W37 adjustment can't take it away: 3 allocated would be below the 4 used.
    expect(await outcome(adjustMembershipCredits(second, who.membership, minusOne, adjustBy()))).toMatchObject({ refused: 'below_used' })
    expect([await used(who.period), await allocated(who.period)]).toEqual([4, 4])

    // The reader payment is cancelled: the flow's undo. Nothing to take back: A never gave its credit up.
    const cancelled = await cancelReaderFlow(first, stripe, pending.pendingId, flowBy())
    expect(cancelled).toMatchObject({ cancelled: true })
    expect(cancelled.warning).toBeUndefined()
    expect(await bookingRow(a.bookingId)).toMatchObject({ session_id: a.sessionId, redemption_source: 'membership_credit', credit_period_id: who.period, redeemed_membership_id: who.membership, price_paid: '0.00' })
    expect(await seatOne(a.bookingId)).toBe('membership_credit')
    expect([await used(who.period), await allocated(who.period)]).toEqual([4, 4])
    await neverAbove(who)
  })

  it('the payment taken: C2 releases the credit (A a paid booking, 3 used), and only then does booking B get it: 4 used of 4', async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const { who, a, peakSession, pending } = await fourOfFourThenAOnTheReader(stripe)
    stripe.completeReaderPayment(pending.paymentIntentId)
    expect(await finaliseReaderFlow(first, stripe, pending.pendingId, flowBy())).toMatchObject({ finalised: true })
    expect(await bookingRow(a.bookingId)).toMatchObject({ session_id: peakSession, redemption_source: 'paid', credit_period_id: null, redeemed_membership_id: null, price_paid: '25.50' })
    expect(await used(who.period)).toBe(3)
    const sessionB = await sessionOn(nextDay(), 10, core)
    expect(await outcome(placeOrder(second, creditOrder(who, sessionB), orderBy()))).toHaveProperty('answered')
    expect([await used(who.period), await allocated(who.period)]).toEqual([4, 4])
    await neverAbove(who)
    // Finalised twice: nothing more.
    expect(await finaliseReaderFlow(first, stripe, pending.pendingId, flowBy())).toMatchObject({ finalised: true, alreadyFinalised: true })
    expect(await used(who.period)).toBe(4)
  })
})

describe('a Move on the saved card that releases a membership credit', () => {
  it('before the card answers the credit is still used (booking B is refused); the card declined, A is back on its credit: 1 used of 1', async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const who = await member(stripe, 1)
    const a = await creditBooking(who)
    const peakSession = await sessionOn(a.onDay, 18, peak)
    const sessionB = await sessionOn(nextDay(), 10, core)
    // Between C1's commit and the card's answer, a second staff member tries the credit.
    let between: Outcome<unknown> | undefined
    const create = stripe.paymentIntents.create
    stripe.paymentIntents.create = (async (...args: Parameters<typeof create>) => {
      between = await outcome(placeOrder(second, creditOrder(who, sessionB), orderBy()))
      return create(...args)
    }) as typeof create
    stripe.failNext('paymentIntents.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
    const answer = await outcome(moveBooking(first, a.bookingId, { newSessionId: peakSession, confirmed: true, figures: { amountDue: 25.5, toCollect: 25.5 }, payment: { method: 'card' } }, moveBy(stripe)))
    expect(answer).toMatchObject({ refused: 'card_charge_failed' })
    expect(between).toMatchObject({ refused: 'insufficient_membership_credit' })
    expect(await bookingRow(a.bookingId)).toMatchObject({ session_id: a.sessionId, redemption_source: 'membership_credit', credit_period_id: who.period, redeemed_membership_id: who.membership })
    expect([await used(who.period), await allocated(who.period)]).toEqual([1, 1])
    await neverAbove(who)
  })

  it('the card paid: the credit is released with the payment (A paid, 0 used)', async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const who = await member(stripe, 1)
    const a = await creditBooking(who)
    const peakSession = await sessionOn(a.onDay, 18, peak)
    const answer = await moveBooking(first, a.bookingId, { newSessionId: peakSession, confirmed: true, figures: { amountDue: 25.5, toCollect: 25.5 }, payment: { method: 'card' } }, moveBy(stripe))
    expect(answer).toMatchObject({ moved: true })
    expect(await bookingRow(a.bookingId)).toMatchObject({ session_id: peakSession, redemption_source: 'paid', credit_period_id: null, redeemed_membership_id: null })
    expect((await flowOf(a.bookingId))?.status).toBe('finalised')
    expect(await used(who.period)).toBe(0)
  })

  it('a Move with no card money (cash) still releases the credit there and then, as before', async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const who = await member(stripe, 1)
    const a = await creditBooking(who)
    const peakSession = await sessionOn(a.onDay, 18, peak)
    await moveBooking(first, a.bookingId, { newSessionId: peakSession, confirmed: true, figures: { amountDue: 25.5, toCollect: 25.5 }, payment: { method: 'cash', confirmedCashAmount: 25.5 } }, moveBy(stripe))
    expect(await bookingRow(a.bookingId)).toMatchObject({ redemption_source: 'paid', credit_period_id: null })
    expect(await used(who.period)).toBe(0)
    expect(await flowOf(a.bookingId)).toBeUndefined()
  })
})

describe('a Settle on the reader (a payment-needed credit booking)', () => {
  async function lapsedOnTheReader(stripe: FakeStripe) {
    const who = await member(stripe, 1)
    const a = await creditBooking(who)
    // The membership lapsed: the booking awaits payment, its credit still on it.
    await first.query("UPDATE bookings SET status = 'payment_needed', payment_due_by = now() + interval '72 hours' WHERE id = $1", [a.bookingId])
    const answer = await settleBooking(first, a.bookingId, { payment: { method: 'reader' }, figures: { amountDue: 20, toCollect: 20 } }, { actor: { type: 'staff', id: staffId }, requestId: crypto.randomUUID(), stripe: () => stripe })
    return { who, a, pending: pendingOf(answer) }
  }

  it('while the reader waits the credit is still used, so a -1 adjustment is refused; the payment cancelled, the booking awaits payment again on its credit: 1 used of 1, never 1 of 0', async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const { who, a, pending } = await lapsedOnTheReader(stripe)
    expect(await bookingRow(a.bookingId)).toMatchObject({ status: 'confirmed', redemption_source: 'membership_credit', credit_period_id: who.period, price_paid: '20.00' })
    expect(await seatOne(a.bookingId)).toBe('paid')
    expect((await flowOf(a.bookingId))?.snapshot).toMatchObject({ release_credit_on_finalise: true })
    expect(await outcome(adjustMembershipCredits(second, who.membership, minusOne, adjustBy()))).toMatchObject({ refused: 'below_used' })
    const cancelled = await cancelReaderFlow(first, stripe, pending.pendingId, flowBy())
    expect(cancelled).toMatchObject({ cancelled: true })
    expect(cancelled.warning).toBeUndefined()
    expect(await bookingRow(a.bookingId)).toMatchObject({ status: 'payment_needed', redemption_source: 'membership_credit', credit_period_id: who.period, redeemed_membership_id: who.membership, price_paid: '0.00' })
    expect(await seatOne(a.bookingId)).toBe('membership_credit')
    expect([await used(who.period), await allocated(who.period)]).toEqual([1, 1])
    await neverAbove(who)
  })

  it('the payment taken: C2 releases the credit (confirmed, paid, 0 used)', async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const { who, a, pending } = await lapsedOnTheReader(stripe)
    stripe.completeReaderPayment(pending.paymentIntentId)
    expect(await finaliseReaderFlow(first, stripe, pending.pendingId, flowBy())).toMatchObject({ finalised: true })
    expect(await bookingRow(a.bookingId)).toMatchObject({ status: 'confirmed', redemption_source: 'paid', credit_period_id: null, redeemed_membership_id: null, price_paid: '20.00' })
    expect(await used(who.period)).toBe(0)
  })

  it('a Settle with no card money (cash) still releases the credit there and then, as before', async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const who = await member(stripe, 1)
    const a = await creditBooking(who)
    await first.query("UPDATE bookings SET status = 'payment_needed', payment_due_by = now() + interval '72 hours' WHERE id = $1", [a.bookingId])
    await settleBooking(first, a.bookingId, { payment: { method: 'cash', confirmedCashAmount: 20 }, figures: { amountDue: 20, toCollect: 20 } }, { actor: { type: 'staff', id: staffId }, requestId: crypto.randomUUID() })
    expect(await bookingRow(a.bookingId)).toMatchObject({ status: 'confirmed', redemption_source: 'paid', credit_period_id: null })
    expect(await used(who.period)).toBe(0)
  })
})

describe("a cheaper Move's put back after the first card part is refused (undoMoveClaim)", () => {
  /** The £10 back to the card, with `meanwhile` run between R1's commit and Stripe's refusal. */
  async function refusedCheaperMove(stripe: FakeStripe, who: Member, meanwhile: () => Promise<void>) {
    const a = await creditSeatWithTwoPaidGuests(stripe, who)
    const cheaper = await sessionOn(a.onDay, 18, offPeak)
    const create = stripe.refunds.create
    stripe.refunds.create = (async (...args: Parameters<typeof create>) => {
      // R1 has committed: the credit is released (nothing counts A against the period).
      expect(await bookingRow(a.bookingId)).toMatchObject({ session_id: cheaper, redemption_source: 'paid', credit_period_id: null })
      await meanwhile()
      return create(...args)
    }) as typeof create
    stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
    const pressing = outcome(moveBooking(first, a.bookingId, { newSessionId: cheaper, confirmed: true, figures: { amountDue: -10 }, refundMethod: 'card' }, moveBy(stripe)))
    return { a, cheaper, pressing }
  }

  it('the credit spent on booking B meanwhile: the undo is blocked, the move stands with £10 owed, and the period has 1 used of 1, never 2', async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const who = await member(stripe, 1)
    const sessionB = await sessionOn(nextDay(), 10, core)
    const { a, cheaper, pressing } = await refusedCheaperMove(stripe, who, async () => {
      expect(await outcome(placeOrder(second, creditOrder(who, sessionB), orderBy()))).toHaveProperty('answered')
    })
    const answer = await pressing
    expect(answer).toMatchObject({ answered: { moved: true, held: { reason: 'refund_refused_not_put_back' } } })
    expect((answer as { answered: { held: { message: string } } }).answered.held.message).toContain('its places, its pass session or its membership credit have been taken since')
    expect(await bookingRow(a.bookingId)).toMatchObject({ session_id: cheaper, redemption_source: 'paid', credit_period_id: null, redeemed_membership_id: null, refund_owed_amount: '10.00' })
    expect(await seatOne(a.bookingId)).toBe('paid')
    expect((await auditOf(a.bookingId, 'booking.refund_finished'))[0]).toMatchObject({ outcome: 'owed', owed: 10, by: { how: 'undo_blocked' } })
    expect([await used(who.period), await allocated(who.period)]).toEqual([1, 1])
    await neverAbove(who)
  })

  it('the credit taken off the period by a -1 adjustment meanwhile: the undo is blocked, the move stands with £10 owed: 0 used of 0, never 1 of 0', async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const who = await member(stripe, 1)
    const { a, cheaper, pressing } = await refusedCheaperMove(stripe, who, async () => {
      expect(await outcome(adjustMembershipCredits(second, who.membership, minusOne, adjustBy()))).toHaveProperty('answered')
    })
    expect(await pressing).toMatchObject({ answered: { moved: true, held: { reason: 'refund_refused_not_put_back' } } })
    expect(await bookingRow(a.bookingId)).toMatchObject({ session_id: cheaper, redemption_source: 'paid', credit_period_id: null, refund_owed_amount: '10.00' })
    expect([await used(who.period), await allocated(who.period)]).toEqual([0, 0])
    await neverAbove(who)
  })

  it('the credit still free: the booking goes back exactly, on its credit (1 used of 1), and the press is refused with the old words; a cancelled credit booking on the period counts for nothing', async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const who = await member(stripe, 1)
    // An earlier credit booking, since cancelled: its credit is free again, as New Order counts it.
    const earlier = await creditBooking(who)
    await first.query("UPDATE bookings SET status = 'cancelled', cancelled_at = now() WHERE id = $1", [earlier.bookingId])
    expect(await used(who.period)).toBe(0)
    const { a, pressing } = await refusedCheaperMove(stripe, who, async () => {})
    expect(await pressing).toMatchObject({ refused: 'refund_failed' })
    expect(await bookingRow(a.bookingId)).toMatchObject({ session_id: a.sessionId, redemption_source: 'membership_credit', credit_period_id: who.period, redeemed_membership_id: who.membership, price_paid: '40.00', refund_owed_amount: '0.00' })
    expect(await seatOne(a.bookingId)).toBe('membership_credit')
    expect([await used(who.period), await allocated(who.period)]).toEqual([1, 1])
  })

  it('an unlimited period always has a credit to take back, whatever else was booked on it meanwhile', async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const who = await member(stripe, 1)
    await first.query('UPDATE membership_credit_periods SET is_unlimited = true WHERE id = $1', [who.period])
    const sessionB = await sessionOn(nextDay(), 10, core)
    const { a, pressing } = await refusedCheaperMove(stripe, who, async () => {
      expect(await outcome(placeOrder(second, creditOrder(who, sessionB), orderBy()))).toHaveProperty('answered')
    })
    expect(await pressing).toMatchObject({ refused: 'refund_failed' })
    expect(await bookingRow(a.bookingId)).toMatchObject({ session_id: a.sessionId, redemption_source: 'membership_credit', credit_period_id: who.period })
    expect(await used(who.period)).toBe(2)
  })

  it("the undo locks the credit period before it counts: with the period's row held, the undo waits on membership_credit_periods, then puts the booking back", async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const who = await member(stripe, 1)
    const release = deferred()
    let announce: (pid: number) => void = () => {}
    const holder = new Promise<number>((resolve) => {
      announce = resolve
    })
    let holding: Promise<void> = Promise.resolve()
    const { a, pressing } = await refusedCheaperMove(stripe, who, async () => {
      // Someone else's change holds the period (as a credit booking or an adjustment would) while Stripe answers.
      holding = third.transaction(async (tx: Tx) => {
        await tx.query('SELECT id FROM membership_credit_periods WHERE id = $1 FOR NO KEY UPDATE', [who.period])
        announce(Number((await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]?.pid))
        await release.promise
      })
      await holder
    })
    let settled = false
    void pressing.finally(() => {
      settled = true
    })
    const holderPid = await holder
    const giveUpAt = Date.now() + 4_000
    let blocked: number | undefined
    while (blocked === undefined && Date.now() < giveUpAt) {
      blocked = (await pg.admin.unsafe<{ pid: number }[]>('SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))', [holderPid]))[0]?.pid
      if (blocked === undefined) await new Promise((resolve) => setTimeout(resolve, 10))
    }
    if (blocked === undefined) throw new Error("Nothing waited on the credit period's holder.")
    expect(settled).toBe(false)
    expect(await waitingOn(pg, blocked)).toEqual(['membership_credit_periods'])
    release.resolve()
    await holding
    expect(await pressing).toMatchObject({ refused: 'refund_failed' })
    expect(await bookingRow(a.bookingId)).toMatchObject({ session_id: a.sessionId, redemption_source: 'membership_credit', credit_period_id: who.period })
    expect([await used(who.period), await allocated(who.period)]).toEqual([1, 1])
  })
})
