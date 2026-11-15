import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Db, Tx } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import { openClaimHoldingOrder } from '@/server/rules/refunds/claims'
import { fixtures, insert } from '@/server/rules/testing/database'
import { deferred } from '@/server/rules/testing/race'
import { startRealPostgres, type RealPostgres } from '@/server/rules/testing/real-postgres'
import { FakeStripe } from '@/server/stripe/fake'
import { refundOrderLines } from '@/server/rules/orders/refund-lines'
import { cancelEventPlaces, type EventCancelOptions } from './cancel-places'

// Brief W30 item 8 (E-plan 4.13 item 7) on real Postgres 17.6, each Worker client on its own connection: two cancels of
// one place at once, two places at once, a check-in at the same moment (the staff app's check-in takes none of the
// Worker's locks, so it is held on the place's own row), and a cancel racing a sale of the event's places. Each race
// holds a lock open until Postgres reports the others waiting on it, so none can pass by timing.
// W30a (W30 review S3): a place cancel racing an order refund of another line of the same order, both to the card.

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

let staffId: string
beforeAll(async () => {
  staffId = await insert(first, 'staff', { role: 'staff', first_name: 'Jo', last_name: 'Staff', email: 'w30-race@example.com', can_issue_refunds: true })
})

const options = (stripe: FakeStripe): EventCancelOptions => ({ actor: { type: 'staff', id: staffId }, requestId: crypto.randomUUID(), canIssueRefunds: true, stripe: () => stripe })

interface Booked {
  eventId: string
  orderId: string
  eventBookingId: string
  places: string[]
}

/** An event with room for `capacity`, and one booking of two £40 places on it paid on the card (£80). */
async function cardBooking(stripe: FakeStripe, capacity = 10): Promise<Booked> {
  const customerId = await fixtures.customer(first)
  const stripeCustomer = `cus_${crypto.randomUUID().slice(0, 8)}`
  stripe.addCustomer(stripeCustomer)
  const eventId = await fixtures.event(first, { capacity, places_booked: 2 })
  const intent = await stripe.paymentIntents.create({ amount: 8000, currency: 'gbp', customer: stripeCustomer, payment_method: 'pm_w30', off_session: true, confirm: true })
  const orderId = await insert(first, 'orders', { customer_id: customerId, order_total: '80.00', payment_status: 'paid', stripe_payment_intent_id: intent.id, payment_method: 'card', order_source: 'staff_created' })
  const eventBookingId = await insert(first, 'event_bookings', { event_id: eventId, customer_id: customerId, places: 2, status: 'confirmed', price_paid: '80.00' })
  const places: string[] = []
  places.push(await insert(first, 'event_attendees', { event_booking_id: eventBookingId, attendee_type: 'account_holder', name: 'Sam Test', unit_price: '40.00', price_level: 'public', created_at: '2026-11-01 10:00:00+00' }))
  places.push(await insert(first, 'event_attendees', { event_booking_id: eventBookingId, attendee_type: 'guest', name: 'Alex Guest', unit_price: '40.00', price_level: 'public', created_at: '2026-11-01 10:00:01+00' }))
  await insert(first, 'order_line_items', { order_id: orderId, item_type: 'event', quantity: 2, unit_price: '40.00', line_total: '80.00', event_booking_id: eventBookingId })
  return { eventId, orderId, eventBookingId, places }
}

/** A row lock held open on `third` until finished: `sql` takes it (its `$1` is `id`). */
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
const holdingTheOrder = (orderId: string) => holding('SELECT id FROM orders WHERE id = $1 FOR UPDATE', orderId)

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

const press = (db: Db, stripe: FakeStripe, booked: Booked, attendeeIds: string[], refund: string) =>
  outcome(cancelEventPlaces(db, booked.eventBookingId, { attendeeIds, refund, confirmed: { refund: refund === 'none' ? 0 : 40 * attendeeIds.length } }, options(stripe)))

const placeRows = async (booked: Booked) =>
  first.query<{ id: string; cancelled: boolean; checked_in: boolean; refunded: string; card: string }>(
    `SELECT id, cancelled_at IS NOT NULL AS cancelled, checked_in_at IS NOT NULL AS checked_in, refunded_amount::numeric(10,2)::text AS refunded,
            card_refunded_amount::numeric(10,2)::text AS card
     FROM event_attendees WHERE event_booking_id = $1 ORDER BY created_at, id`,
    [booked.eventBookingId]
  )
const bookingRow = async (booked: Booked) => (await first.query<{ status: string; places: number }>('SELECT status, places FROM event_bookings WHERE id = $1', [booked.eventBookingId]))[0]
const placesBooked = async (booked: Booked) => Number((await first.query<{ places_booked: number }>('SELECT places_booked FROM events WHERE id = $1', [booked.eventId]))[0]?.places_booked)
const lineCard = async (booked: Booked) => (await first.query<{ card: string }>('SELECT card_refunded_amount::numeric(10,2)::text AS card FROM order_line_items WHERE order_id = $1', [booked.orderId]))[0]?.card
const claims = async (booked: Booked) => (await first.query<{ n: number }>("SELECT count(*)::int AS n FROM audit_log WHERE action = 'event_booking.refund_claimed' AND entity_id = $1", [booked.eventBookingId]))[0]?.n
const moneyBack = (stripe: FakeStripe) => stripe.refundsSent.reduce((total, sent) => total + sent.amount, 0)

describe('two cancels of one place at once', () => {
  it("to the card: both wait on the order; one cancels the place and sends one £40 refund under its claim's key; the other is refused (the place cancelled, or a refund still being checked); the place is released once", async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const booked = await cardBooking(stripe)
    const [place] = booked.places
    const gate = await holdingTheOrder(booked.orderId)
    const a = press(first, stripe, booked, [place as string], 'card')
    const b = press(second, stripe, booked, [place as string], 'card')
    await allBlockedBy(gate.pid, 2)
    await gate.finish()
    const outcomes = await Promise.all([a, b])
    expect(answers(outcomes)).toHaveLength(1)
    expect(answers(outcomes)[0]).toMatchObject({ places: 1, refundedAmount: 40, cardRefundedAmount: 40 })
    expect(refusals(outcomes)).toHaveLength(1)
    expect(['already_cancelled', 'refund_open']).toContain(refusals(outcomes)[0])
    expect(moneyBack(stripe)).toBe(4000)
    expect(stripe.refundsSent).toHaveLength(1)
    expect(await claims(booked)).toBe(1)
    expect(await placesBooked(booked)).toBe(1)
    expect(await bookingRow(booked)).toEqual({ status: 'confirmed', places: 1 })
    expect((await placeRows(booked)).map((row) => [row.cancelled, row.card])).toEqual([
      [true, '40.00'],
      [false, '0.00'],
    ])
    expect(await lineCard(booked)).toBe('40.00')
  })

  it('with no refund: one cancels the place, the other finds it cancelled; the event gets one place back, not two', async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const booked = await cardBooking(stripe)
    const [place] = booked.places
    const gate = await holdingTheOrder(booked.orderId)
    const a = press(first, stripe, booked, [place as string], 'none')
    const b = press(second, stripe, booked, [place as string], 'none')
    await allBlockedBy(gate.pid, 2)
    await gate.finish()
    const outcomes = await Promise.all([a, b])
    expect(answers(outcomes)).toHaveLength(1)
    expect(refusals(outcomes)).toEqual(['already_cancelled'])
    expect(await placesBooked(booked)).toBe(1)
    expect(await bookingRow(booked)).toEqual({ status: 'confirmed', places: 1 })
    expect(stripe.refundsSent).toHaveLength(0)
  })
})

describe('two places of one booking at once', () => {
  it('each to the card: they queue on the order; what went back is £40 for each place cancelled, each under its own claim, and the booking, the event and the line agree', async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const booked = await cardBooking(stripe)
    const [one, two] = booked.places
    const gate = await holdingTheOrder(booked.orderId)
    const a = press(first, stripe, booked, [one as string], 'card')
    const b = press(second, stripe, booked, [two as string], 'card')
    await allBlockedBy(gate.pid, 2)
    await gate.finish()
    const outcomes = await Promise.all([a, b])
    // The second waits for the first's R1; if the first's claim is still open then (its refund on its way), it is
    // refused `refund_open`, else it goes too.
    const went = answers(outcomes).length
    expect(went).toBeGreaterThanOrEqual(1)
    for (const reason of refusals(outcomes)) expect(reason).toBe('refund_open')
    expect(moneyBack(stripe)).toBe(4000 * went)
    expect(await claims(booked)).toBe(went)
    expect((await placeRows(booked)).filter((row) => row.cancelled)).toHaveLength(went)
    expect(await placesBooked(booked)).toBe(2 - went)
    expect((await bookingRow(booked))?.places).toBe(2 - went)
    expect(await lineCard(booked)).toBe((40 * went).toFixed(2))
  })
})

describe('a check-in at the same moment', () => {
  it('the check-in commits while the cancel waits on the place: the cancel is refused whole (`changed_by_someone_else`), nothing is cancelled, claimed or sent, and the place stays checked in', async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const booked = await cardBooking(stripe)
    const [one, two] = booked.places
    // The staff app's check-in: an UPDATE of the place's row, guarded on its not being cancelled. Not yet committed.
    const checkIn = await holding('UPDATE event_attendees SET checked_in_at = now() WHERE id = $1 AND cancelled_at IS NULL', two as string)
    // R1's quote reads the place as not checked in (the check-in isn't committed), then waits on its row.
    const cancel = press(first, stripe, booked, [one as string, two as string], 'card')
    await allBlockedBy(checkIn.pid, 1)
    await checkIn.finish()
    expect(await cancel).toEqual({ refused: 'changed_by_someone_else' })
    expect(stripe.refundsSent).toHaveLength(0)
    expect(await claims(booked)).toBe(0)
    expect((await placeRows(booked)).map((row) => [row.cancelled, row.checked_in])).toEqual([
      [false, false],
      [false, true],
    ])
    expect(await bookingRow(booked)).toEqual({ status: 'confirmed', places: 2 })
    expect(await placesBooked(booked)).toBe(2)
  })

  it('the other way round: the cancel commits while the check-in waits on the place: the place is cancelled and refunded once, and the check-in (guarded on a place not cancelled, as the staff app\'s is) changes nothing', async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const booked = await cardBooking(stripe)
    const [one] = booked.places
    // The place's row is held; the cancel queues on it inside R1; the check-in queues behind the cancel.
    const gate = await holding('SELECT id FROM event_attendees WHERE id = $1 FOR UPDATE', one as string)
    const cancel = press(first, stripe, booked, [one as string], 'card')
    await allBlockedBy(gate.pid, 1)
    const checkedIn = second.query<{ id: string }>('UPDATE event_attendees SET checked_in_at = now() WHERE id = $1 AND cancelled_at IS NULL RETURNING id', [one as string])
    await allBlockedBy(gate.pid, 2)
    await gate.finish()
    const [cancelled, rows] = await Promise.all([cancel, checkedIn])
    // Postgres wakes the two waiters in the order they queued: the cancel first.
    expect(cancelled).toMatchObject({ answered: { places: 1, cardRefundedAmount: 40 } })
    expect(rows).toHaveLength(0)
    expect((await placeRows(booked))[0]).toMatchObject({ cancelled: true, checked_in: false, card: '40.00' })
    expect(moneyBack(stripe)).toBe(4000)
  })
})

describe("a cancel racing a sale of the event's places", () => {
  it("both wait on the event's row, and neither loses the other's change: one place released and two sold leaves three booked, whichever goes first", async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    // Room for four, two booked: a sale of two fits before or after the cancel releases one.
    const booked = await cardBooking(stripe, 4)
    const [one] = booked.places
    const gate = await holding('SELECT id FROM events WHERE id = $1 FOR UPDATE', booked.eventId)
    const cancel = press(first, stripe, booked, [one as string], 'none')
    // New Order's own claim of the places (place-order.ts runs the same database function inside T1).
    const sale = second.query<{ claimed: boolean }>('SELECT public.claim_event_places($1::uuid, 2) AS claimed', [booked.eventId])
    await allBlockedBy(gate.pid, 2)
    await gate.finish()
    const [cancelled, sold] = await Promise.all([cancel, sale])
    expect(cancelled).toMatchObject({ answered: { places: 1 } })
    expect(sold[0]?.claimed).toBe(true)
    // 2 booked, less the 1 released, plus the 2 sold. A lost update would leave 1 or 4.
    expect(await placesBooked(booked)).toBe(3)
    expect(await bookingRow(booked)).toEqual({ status: 'confirmed', places: 1 })
  })
})

describe('a place cancel racing an order refund on the same order (W30a, W30 review S3)', () => {
  /**
   * The card booking's order with a £24 soap line added: £104, of which £60 was paid with store credit and £44 on the
   * card. The soap (£24) and one place (£40) together are more than the card took, so two refunds that each read the
   * card money left before the other recorded its own would send £64 back on a £44 payment.
   */
  async function cardBookingWithSoap(stripe: FakeStripe): Promise<Booked & { soapLine: string; customerId: string; paid: number }> {
    const customerId = await fixtures.customer(first)
    const stripeCustomer = `cus_${crypto.randomUUID().slice(0, 8)}`
    stripe.addCustomer(stripeCustomer)
    const eventId = await fixtures.event(first, { capacity: 10, places_booked: 2 })
    const soap = await insert(first, 'products', { name: 'Soap', base_price: '12.00', fulfillment_method: 'pickup' })
    const variant = await insert(first, 'product_variants', { product_id: soap, sku: `SOAP-${crypto.randomUUID()}`, stock_quantity: 100 })
    const intent = await stripe.paymentIntents.create({ amount: 4400, currency: 'gbp', customer: stripeCustomer, payment_method: 'pm_w30a', off_session: true, confirm: true })
    const orderId = await insert(first, 'orders', { customer_id: customerId, order_total: '104.00', payment_status: 'paid', stripe_payment_intent_id: intent.id, payment_method: 'split', order_source: 'staff_created' })
    await insert(first, 'store_credit_transactions', { customer_id: customerId, amount: '-60.00', balance_after: '0.00', reason: 'redemption', order_id: orderId })
    const eventBookingId = await insert(first, 'event_bookings', { event_id: eventId, customer_id: customerId, places: 2, status: 'confirmed', price_paid: '80.00' })
    const places: string[] = []
    places.push(await insert(first, 'event_attendees', { event_booking_id: eventBookingId, attendee_type: 'account_holder', name: 'Sam Test', unit_price: '40.00', price_level: 'public', created_at: '2026-11-01 10:00:00+00' }))
    places.push(await insert(first, 'event_attendees', { event_booking_id: eventBookingId, attendee_type: 'guest', name: 'Alex Guest', unit_price: '40.00', price_level: 'public', created_at: '2026-11-01 10:00:01+00' }))
    await insert(first, 'order_line_items', { order_id: orderId, item_type: 'event', quantity: 2, unit_price: '40.00', line_total: '80.00', event_booking_id: eventBookingId })
    const soapLine = await insert(first, 'order_line_items', { order_id: orderId, product_variant_id: variant, item_type: 'product', quantity: 2, unit_price: '12.00', line_total: '24.00' })
    return { eventId, orderId, eventBookingId, places, soapLine, customerId, paid: 4400 }
  }

  const refundSoap = (db: Db, stripe: FakeStripe, booked: Booked & { soapLine: string }) =>
    outcome(
      refundOrderLines(db, booked.orderId, { lineItemIds: [booked.soapLine], refundMethod: 'card', restock: { [booked.soapLine]: false }, confirmed: { amount: 24 } }, { actor: { type: 'staff', id: staffId }, requestId: crypto.randomUUID(), stripe: () => stripe })
    )
  const cardOnLines = async (orderId: string) => Number((await first.query<{ card: string }>('SELECT COALESCE(SUM(card_refunded_amount), 0)::text AS card FROM order_line_items WHERE order_id = $1', [orderId]))[0]?.card)
  const creditBack = async (booked: { orderId: string }) =>
    Number((await first.query<{ back: string }>("SELECT COALESCE(SUM(amount), 0)::text AS back FROM store_credit_transactions WHERE order_id = $1 AND reason = 'refund'", [booked.orderId]))[0]?.back)
  const cardOf = (one: Outcome): number => ('answered' in one ? Number(one.answered['cardRefundedAmount']) : 0)

  it.each([
    ['the order refund asked first', true],
    ['the place cancel asked first', false],
  ])("the soap to the card and a place to the card at once (%s): both wait on the order; each goes once or is refused `refund_open`, at least one goes, and the card money back is what the answers say, never more than the payment", async (_name, soapFirst) => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const booked = await cardBookingWithSoap(stripe)
    const [place] = booked.places
    const gate = await holdingTheOrder(booked.orderId)
    let soapPress: Promise<Outcome>
    let placePress: Promise<Outcome>
    if (soapFirst) {
      soapPress = refundSoap(first, stripe, booked)
      await allBlockedBy(gate.pid, 1)
      placePress = press(second, stripe, booked, [place as string], 'card')
    } else {
      placePress = press(first, stripe, booked, [place as string], 'card')
      await allBlockedBy(gate.pid, 1)
      soapPress = refundSoap(second, stripe, booked)
    }
    await allBlockedBy(gate.pid, 2)
    await gate.finish()
    const [soapOutcome, placeOutcome] = await Promise.all([soapPress, placePress])
    // Each side either went or met the other's open claim under the order's lock: nothing else.
    for (const reason of refusals([soapOutcome, placeOutcome])) expect(reason).toBe('refund_open')
    const soapWent = 'answered' in soapOutcome
    const placeWent = 'answered' in placeOutcome
    expect(soapWent || placeWent).toBe(true)
    if (placeWent) expect(placeOutcome.answered).toMatchObject({ places: 1, refundedAmount: 40 })
    // The card money back is exactly what the answers say, one refund each, on the lines too, and inside the payment.
    const answered = Math.round((cardOf(soapOutcome) + cardOf(placeOutcome)) * 100)
    expect(answered).toBeGreaterThan(0)
    expect(moneyBack(stripe)).toBe(answered)
    expect(moneyBack(stripe)).toBeLessThanOrEqual(booked.paid)
    expect(stripe.refundsSent).toHaveLength((soapWent ? 1 : 0) + (placeWent ? 1 : 0))
    expect(Math.round((await cardOnLines(booked.orderId)) * 100)).toBe(answered)
    // A refused side changed nothing: the place still booked, the soap line not refunded.
    expect((await placeRows(booked)).filter((row) => row.cancelled)).toHaveLength(placeWent ? 1 : 0)
    expect(await placesBooked(booked)).toBe(placeWent ? 1 : 2)
    expect((await first.query<{ refunded: boolean }>('SELECT refunded_at IS NOT NULL AS refunded FROM order_line_items WHERE id = $1', [booked.soapLine]))[0]?.refunded).toBe(soapWent)
    // Nothing is left open, so whichever was refused is pressed again and goes. Both done: the card has had back
    // exactly the £44 it took, whichever went first, and the other £20 of the £64 went to store credit.
    expect(await openClaimHoldingOrder(first, booked.orderId)).toBeNull()
    if (!soapWent) expect(await refundSoap(first, stripe, booked)).toHaveProperty('answered')
    if (!placeWent) expect(await press(first, stripe, booked, [place as string], 'card')).toMatchObject({ answered: { places: 1, refundedAmount: 40 } })
    expect(moneyBack(stripe)).toBe(4400)
    expect(await cardOnLines(booked.orderId)).toBe(44)
    expect(await creditBack(booked)).toBe(20)
  })
})
