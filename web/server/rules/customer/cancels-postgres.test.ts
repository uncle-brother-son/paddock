import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Db, Tx } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import { cancelAndRefund, cancelForCustomer, type CancelOptions } from '@/server/rules/bookings/cancel'
import { cancelEventPlaces, cancelEventPlacesForCustomer, type EventCancelOptions } from '@/server/rules/events/cancel-places'
import { fixtures, insert } from '@/server/rules/testing/database'
import { deferred } from '@/server/rules/testing/race'
import { startRealPostgres, type RealPostgres } from '@/server/rules/testing/real-postgres'
import { FakeStripe } from '@/server/stripe/fake'

// Brief W33 item 5 ("two cancels at once") on real Postgres 17.6, each Worker client on its own connection: the
// customer pressing Cancel twice (two tabs, a double tap that got past the key), and the customer's cancel racing a
// staff member's on the same booking. Each race holds a lock open until Postgres reports both presses waiting on it,
// so neither can pass by timing. The customer's cancel is given no Stripe client at all: it can't call Stripe.

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
  staffId = await insert(first, 'staff', { role: 'staff', first_name: 'Jo', last_name: 'Staff', email: 'w33-race@example.com', can_issue_refunds: true })
  addonId = await insert(first, 'addons', { name: 'Towel', base_price: '5.00', sku: 'TOWEL-W33' })
})

let day = 0
function nextSlot(): { start_time: string; end_time: string } {
  day += 1
  const start = new Date(Date.UTC(2033, 3, day, 10))
  return { start_time: start.toISOString(), end_time: new Date(start.getTime() + 3_600_000).toISOString() }
}

/** A lock held open on `third` until finished: `sql` takes it (its `$1` is `id`). */
async function holding(sql: string, id: string) {
  const release = deferred()
  let announce: (pid: number) => void = () => {}
  const ready = new Promise<number>((resolve) => {
    announce = resolve
  })
  const done = third.transaction(async (tx: Tx) => {
    await tx.query(sql, [id])
    announce((await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]?.pid as number)
    await release.promise
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

async function allBlockedBy(holderPid: number, count: number): Promise<void> {
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
    if (rows.length >= count) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Fewer than ${count} waited on the holder.`)
}

type Outcome = { answered: Record<string, unknown> } | { refused: string }
const outcome = (promise: Promise<unknown>): Promise<Outcome> =>
  promise.then(
    (value) => ({ answered: value as Record<string, unknown> }),
    (err: unknown) => ({ refused: err instanceof ApiError ? ((err.details as { reason?: string } | undefined)?.reason ?? err.code) : String(err) })
  )
const refusals = (outcomes: Outcome[]): string[] => outcomes.flatMap((one) => ('refused' in one ? [one.refused] : []))
const answers = (outcomes: Outcome[]): Array<Record<string, unknown>> => outcomes.flatMap((one) => ('answered' in one ? [one.answered] : []))

const balance = async (customerId: string) => Number((await first.query<{ balance: string }>('SELECT store_credit_balance::text AS balance FROM customers WHERE id = $1', [customerId]))[0]?.balance)
const creditGiven = async (customerId: string) =>
  (await first.query<{ amount: string }>("SELECT amount::text FROM store_credit_transactions WHERE customer_id = $1 AND reason = 'refund'", [customerId])).reduce((total, row) => total + Number(row.amount), 0)
const refundsSent = (stripe: FakeStripe) => stripe.calls.filter((call) => call.method === 'refunds.create')

// --- A session booking

/** A public booking for two (£40) paid on the card, with a £5 Towel on the same order (£45). */
async function cardBooking(stripe: FakeStripe): Promise<{ bookingId: string; sessionId: string; customerId: string }> {
  const customerId = await fixtures.customer(first)
  const slot = nextSlot()
  const sessionId = await fixtures.session(first, { service_type_id: publicType, band_id: band, capacity: 10, total_booked: 2, ...slot })
  const bookingId = await fixtures.booking(first, { session_id: sessionId, customer_id: customerId, price_paid: '40', party_size: 2, band_id: band, redemption_source: 'paid', ...slot })
  await insert(first, 'booking_guests', { booking_id: bookingId, guest_type: 'account_holder', guest_name: 'Sam Test', unit_price: '20.00', pay_by: 'paid' })
  await insert(first, 'booking_guests', { booking_id: bookingId, guest_type: 'additional_guest', guest_name: 'Alex Guest', unit_price: '20.00', pay_by: 'paid' })
  const stripeCustomer = `cus_${crypto.randomUUID().slice(0, 8)}`
  stripe.addCustomer(stripeCustomer)
  const intent = await stripe.paymentIntents.create({ amount: 4500, currency: 'gbp', customer: stripeCustomer, payment_method: 'pm_w33', off_session: true, confirm: true })
  const orderId = await insert(first, 'orders', { customer_id: customerId, order_total: '45.00', payment_status: 'paid', stripe_payment_intent_id: intent.id, payment_method: 'card', order_source: 'online' })
  await insert(first, 'order_line_items', { order_id: orderId, booking_id: bookingId, item_type: 'booking', quantity: 1, unit_price: '40.00', line_total: '40.00' })
  await insert(first, 'addon_order_lines', { booking_id: bookingId, addon_id: addonId, quantity: 1, price_at_purchase: '5.00', sku_at_purchase: 'TOWEL-W33', redemption_source: 'paid', order_id: orderId })
  return { bookingId, sessionId, customerId }
}

const holdingTheBooking = (bookingId: string) => holding('SELECT id FROM bookings WHERE id = $1 FOR NO KEY UPDATE', bookingId)
const bookingStatus = async (bookingId: string) => (await first.query<{ status: string }>('SELECT status FROM bookings WHERE id = $1', [bookingId]))[0]?.status
const totalBooked = async (sessionId: string) => (await first.query<{ n: number }>('SELECT total_booked AS n FROM sessions WHERE id = $1', [sessionId]))[0]?.n
const bookingClaims = async (bookingId: string) =>
  first.query<{ actor_type: string; action: string }>("SELECT actor_type, action FROM audit_log WHERE entity_type = 'booking' AND entity_id = $1 AND action LIKE 'booking.refund_%' ORDER BY action", [bookingId])

describe("two cancels of one session booking at once (brief W33 item 5)", () => {
  it("the customer twice: both wait on the booking; one cancels it and gives £45 of store credit once; the other finds it cancelled; the places are released once", async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const { bookingId, sessionId, customerId } = await cardBooking(stripe)
    const before = await balance(customerId)
    const gate = await holdingTheBooking(bookingId)
    const a = outcome(cancelForCustomer(first, bookingId, { id: customerId, total: 45 }, 'w33-race-a'))
    const b = outcome(cancelForCustomer(second, bookingId, { id: customerId, total: 45 }, 'w33-race-b'))
    await allBlockedBy(gate.pid, 2)
    await gate.finish()
    const outcomes = await Promise.all([a, b])
    expect(answers(outcomes)).toHaveLength(1)
    expect(answers(outcomes)[0]).toMatchObject({ kind: 'cancel', storeCreditRefunded: 45, storeCreditBalance: before + 45 })
    expect(refusals(outcomes)).toEqual(['already_cancelled'])
    expect(await bookingStatus(bookingId)).toBe('cancelled')
    expect(await totalBooked(sessionId)).toBe(0)
    expect(await balance(customerId)).toBe(before + 45)
    expect(await creditGiven(customerId)).toBe(45)
    // One claim, the customer's, finished in the transaction that wrote it; nothing sent to Stripe.
    expect(await bookingClaims(bookingId)).toEqual([
      { actor_type: 'customer', action: 'booking.refund_claimed' },
      { actor_type: 'customer', action: 'booking.refund_finished' },
    ])
    expect(refundsSent(stripe)).toEqual([])
  })

  it("the customer's cancel racing a staff Cancel & Refund to the card: one of them cancels the booking, and £45 goes back once, to store credit or to the card, never both", async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const { bookingId, sessionId, customerId } = await cardBooking(stripe)
    const addonLineId = (await first.query<{ id: string }>('SELECT id FROM addon_order_lines WHERE booking_id = $1', [bookingId]))[0]?.id as string
    const before = await balance(customerId)
    const staff: CancelOptions = { actor: { type: 'staff', id: staffId }, requestId: 'w33-race-staff', stripe: () => stripe, canIssueRefunds: true }
    const gate = await holdingTheBooking(bookingId)
    const a = outcome(cancelForCustomer(first, bookingId, { id: customerId, total: 45 }, 'w33-race-customer'))
    const b = outcome(cancelAndRefund(second, bookingId, { refundMethod: 'card', addonLineIds: [addonLineId], confirmed: { refund: 40, addonsRefund: 5 } }, staff))
    await allBlockedBy(gate.pid, 2)
    await gate.finish()
    const outcomes = await Promise.all([a, b])
    expect(answers(outcomes)).toHaveLength(1)
    expect(refusals(outcomes)).toEqual(['already_cancelled'])
    const toCard = refundsSent(stripe).reduce((total, call) => total + (call.params as { amount: number }).amount, 0) / 100
    const toStoreCredit = await creditGiven(customerId)
    expect(toCard + toStoreCredit).toBe(45)
    expect([toCard, toStoreCredit].sort()).toEqual([0, 45])
    expect(await balance(customerId)).toBe(before + toStoreCredit)
    expect(await bookingStatus(bookingId)).toBe('cancelled')
    expect(await totalBooked(sessionId)).toBe(0)
  })
})

// --- Event places

interface Booked {
  eventId: string
  orderId: string
  eventBookingId: string
  customerId: string
  places: string[]
}

/** An event with one booking of two £40 places on it, paid on the card (£80). */
async function eventBooking(stripe: FakeStripe): Promise<Booked> {
  const customerId = await fixtures.customer(first)
  const stripeCustomer = `cus_${crypto.randomUUID().slice(0, 8)}`
  stripe.addCustomer(stripeCustomer)
  const eventId = await fixtures.event(first, { capacity: 10, places_booked: 2 })
  const intent = await stripe.paymentIntents.create({ amount: 8000, currency: 'gbp', customer: stripeCustomer, payment_method: 'pm_w33', off_session: true, confirm: true })
  const orderId = await insert(first, 'orders', { customer_id: customerId, order_total: '80.00', payment_status: 'paid', stripe_payment_intent_id: intent.id, payment_method: 'card', order_source: 'online' })
  const eventBookingId = await insert(first, 'event_bookings', { event_id: eventId, customer_id: customerId, places: 2, status: 'confirmed', price_paid: '80.00' })
  const places: string[] = []
  places.push(await insert(first, 'event_attendees', { event_booking_id: eventBookingId, attendee_type: 'account_holder', name: 'Sam Test', unit_price: '40.00', price_level: 'public', created_at: '2026-11-01 10:00:00+00' }))
  places.push(await insert(first, 'event_attendees', { event_booking_id: eventBookingId, attendee_type: 'guest', name: 'Alex Guest', unit_price: '40.00', price_level: 'public', created_at: '2026-11-01 10:00:01+00' }))
  await insert(first, 'order_line_items', { order_id: orderId, item_type: 'event', quantity: 2, unit_price: '40.00', line_total: '80.00', event_booking_id: eventBookingId })
  return { eventId, orderId, eventBookingId, customerId, places }
}

const holdingTheOrder = (orderId: string) => holding('SELECT id FROM orders WHERE id = $1 FOR UPDATE', orderId)
const customerPress = (db: Db, booked: Booked, attendeeIds: string[] | undefined, refund: number) =>
  outcome(cancelEventPlacesForCustomer(db, booked.eventBookingId, { attendeeIds, confirmed: { refund } }, { id: booked.customerId }, crypto.randomUUID()))
const eventBookingRow = async (booked: Booked) => (await first.query<{ status: string; places: number }>('SELECT status, places FROM event_bookings WHERE id = $1', [booked.eventBookingId]))[0]
const placesBooked = async (booked: Booked) => Number((await first.query<{ places_booked: number }>('SELECT places_booked FROM events WHERE id = $1', [booked.eventId]))[0]?.places_booked)
const cancelledPlaces = async (booked: Booked) => (await first.query<{ n: number }>('SELECT count(*)::int AS n FROM event_attendees WHERE event_booking_id = $1 AND cancelled_at IS NOT NULL', [booked.eventBookingId]))[0]?.n

describe('two cancels of event places at once (brief W33 item 5)', () => {
  it("the customer cancelling one place twice: both wait on the order; one cancels it for £40 of store credit; the other finds it cancelled; the place is released once", async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const booked = await eventBooking(stripe)
    const [place] = booked.places
    const before = await balance(booked.customerId)
    const gate = await holdingTheOrder(booked.orderId)
    const a = customerPress(first, booked, [place as string], 40)
    const b = customerPress(second, booked, [place as string], 40)
    await allBlockedBy(gate.pid, 2)
    await gate.finish()
    const outcomes = await Promise.all([a, b])
    expect(answers(outcomes)).toHaveLength(1)
    expect(answers(outcomes)[0]).toMatchObject({ places: 1, storeCreditRefundedAmount: 40, cardRefundedAmount: 0 })
    expect(refusals(outcomes)).toEqual(['already_cancelled'])
    expect(await balance(booked.customerId)).toBe(before + 40)
    expect(await creditGiven(booked.customerId)).toBe(40)
    expect(await placesBooked(booked)).toBe(1)
    expect(await eventBookingRow(booked)).toEqual({ status: 'confirmed', places: 1 })
    expect(refundsSent(stripe)).toEqual([])
  })

  it("the whole booking in one tab and one place in another: never more than the booking's £80 back, and no place released twice", async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const booked = await eventBooking(stripe)
    const [place] = booked.places
    const before = await balance(booked.customerId)
    const gate = await holdingTheOrder(booked.orderId)
    const a = customerPress(first, booked, undefined, 80)
    const b = customerPress(second, booked, [place as string], 40)
    await allBlockedBy(gate.pid, 2)
    await gate.finish()
    const outcomes = await Promise.all([a, b])
    // The whole booking first: the place's press finds the booking cancelled. The place first: the whole booking's
    // figure has changed (£40 is left), and it is refused with nothing more cancelled.
    expect(answers(outcomes)).toHaveLength(1)
    expect(refusals(outcomes)).toHaveLength(1)
    expect(['booking_not_confirmed', 'already_cancelled', 'figures_changed']).toContain(refusals(outcomes)[0])
    const given = await creditGiven(booked.customerId)
    const cancelled = (await cancelledPlaces(booked)) ?? 0
    expect(given).toBe(40 * cancelled)
    expect(await balance(booked.customerId)).toBe(before + given)
    expect(await placesBooked(booked)).toBe(2 - cancelled)
    expect(refundsSent(stripe)).toEqual([])
  })

  it("the customer's cancel racing a staff cancel of the same place to the card: the place is cancelled once and its £40 goes back once", async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const booked = await eventBooking(stripe)
    const [place] = booked.places
    const staff: EventCancelOptions = { actor: { type: 'staff', id: staffId }, requestId: crypto.randomUUID(), canIssueRefunds: true, stripe: () => stripe }
    const gate = await holdingTheOrder(booked.orderId)
    const a = customerPress(first, booked, [place as string], 40)
    const b = outcome(cancelEventPlaces(second, booked.eventBookingId, { attendeeIds: [place as string], refund: 'card', confirmed: { refund: 40 } }, staff))
    await allBlockedBy(gate.pid, 2)
    await gate.finish()
    const outcomes = await Promise.all([a, b])
    expect(answers(outcomes)).toHaveLength(1)
    expect(refusals(outcomes)).toHaveLength(1)
    expect(['already_cancelled', 'refund_open']).toContain(refusals(outcomes)[0])
    const toCard = stripe.refundsSent.reduce((total, sent) => total + sent.amount, 0) / 100
    const toStoreCredit = await creditGiven(booked.customerId)
    expect([toCard, toStoreCredit].sort()).toEqual([0, 40])
    expect(await cancelledPlaces(booked)).toBe(1)
    expect(await placesBooked(booked)).toBe(1)
  })
})
