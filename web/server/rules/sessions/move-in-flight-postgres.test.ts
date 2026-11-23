import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Db } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import { cancelAndRefund, type CancelOptions } from '@/server/rules/bookings/cancel'
import { moveBooking, type MoveOptions } from '@/server/rules/bookings/move'
import { cancelReaderFlow } from '@/server/rules/orders/reader-flow'
import { holdingAfter, pressBy, sessionBlockedBy } from '@/server/rules/testing/admin-race'
import { fixtures, insert } from '@/server/rules/testing/database'
import { waitingOn } from '@/server/rules/testing/race'
import { startRealPostgres, type RealPostgres } from '@/server/rules/testing/real-postgres'
import { FakeStripe, fakeStripeErrors } from '@/server/stripe/fake'
import { blockDay, blockSession, setSessionStartTime } from './admin'

// Brief W51a item 1 (W51 review S1; GB5, GB6) on real Postgres 17.6, each press on its own connection, with the
// rules themselves: a real dearer Move on the reader (bookings/move.ts), its real cancel (orders/reader-flow.ts), a
// real cheaper Move and a real Cancel & Refund whose first card part the fake Stripe declines (bookings/refunds.ts).
//  - While a reader Move waits for its tap, the booking is on its NEW slot. A block, a Block Day and a start-time
//    change on the OLD slot are each refused; the payment is then cancelled and the booking is back on the old slot,
//    open and at its own time.
//  - Control: the block and the time change as W51 left them (they looked only at bookings on the slot) go ahead, and
//    the cancelled payment then puts the booking back onto a blocked slot, or with times that aren't the slot's.
//  - A block pressed while the Move's first transaction is still open waits for the old slot's lock, which the Move
//    holds while it writes its flow row, and is refused once it can read it.
//  - A refund's undo (the first card part refused) puts the booking back only on a slot still open and still at the
//    booking's time. Blocked or moved meanwhile, the change stands and the refund ends as money still to refund.

let pg: RealPostgres
let first: Db
let second: Db
let sauna = ''
let core = ''
let peak = ''
let jo = ''

beforeAll(async () => {
  pg = await startRealPostgres()
  first = pg.connect()
  second = pg.connect()
  sauna = await fixtures.serviceType(first, { duration: 60, capacity: 10 })
  core = await fixtures.band(first, { price: '20.00' })
  peak = await fixtures.band(first, { price: '25.50' })
  jo = await insert(first, 'staff', { role: 'staff', first_name: 'Jo', last_name: 'Staff', email: 'w51a-s1@example.com', can_issue_refunds: true })
}, 120_000)
afterAll(() => pg.stop())

// Every test has its own pair of days, so no customer has two bookings on one day and no slot is used twice.
let pair = 0
function nextDays(): { day: string; nextDay: string } {
  pair += 1
  const at = (offset: number) => new Date(Date.UTC(2034, 0, pair * 3 + offset)).toISOString().slice(0, 10)
  return { day: at(0), nextDay: at(1) }
}
const slot = (day: string, hour: number) => ({ start_time: `${day}T${String(hour).padStart(2, '0')}:00:00.000Z`, end_time: `${day}T${String(hour + 1).padStart(2, '0')}:00:00.000Z` })
const sessionAt = (day: string, hour: number, band: string) => fixtures.session(first, { service_type_id: sauna, band_id: band, capacity: 10, ...slot(day, hour) })

/** A public booking for two paid on the card, on a session: its order, its seats and the fake's PaymentIntent. */
async function twoSeatsOnTheCard(stripe: FakeStripe, sessionId: string, times: { start_time: string; end_time: string }, band: string, seat: string): Promise<string> {
  const total = (Number(seat) * 2).toFixed(2)
  const stripeCustomer = `cus_w51a_${crypto.randomUUID().slice(0, 6)}`
  stripe.addCustomer(stripeCustomer)
  const customerId = await fixtures.customer(first, { stripe_customer_id: stripeCustomer, saved_payment_method_id: 'pm_w51a' })
  const bookingId = await fixtures.booking(first, { session_id: sessionId, customer_id: customerId, price_paid: total, party_size: 2, band_id: band, redemption_source: 'paid', ...times })
  await first.query('UPDATE sessions SET total_booked = total_booked + 2 WHERE id = $1', [sessionId])
  await insert(first, 'booking_guests', { booking_id: bookingId, guest_type: 'account_holder', guest_name: 'Sam Test', unit_price: seat, pay_by: 'paid' })
  await insert(first, 'booking_guests', { booking_id: bookingId, guest_type: 'additional_guest', guest_name: 'Alex Guest', unit_price: seat, pay_by: 'paid' })
  const intent = await stripe.paymentIntents.create({ amount: Math.round(Number(total) * 100), currency: 'gbp', customer: stripeCustomer, payment_method: 'pm_w51a', off_session: true, confirm: true })
  const orderId = await insert(first, 'orders', { customer_id: customerId, order_total: total, payment_status: 'paid', stripe_payment_intent_id: intent.id, payment_method: 'card', order_source: 'staff_created' })
  await insert(first, 'order_line_items', { order_id: orderId, booking_id: bookingId, item_type: 'booking', quantity: 1, unit_price: total, line_total: total })
  return bookingId
}

const options = (stripe: FakeStripe): MoveOptions & CancelOptions => ({ actor: { type: 'staff', id: jo }, requestId: crypto.randomUUID(), stripe: () => stripe, canIssueRefunds: true })

type Refusal = { reason?: string; message?: string; conflictingBookings?: Array<{ id: string; movingOff?: boolean }> }
/** A press's answer, or the details it was refused with. Anything else is a test failure. */
const outcome = <T>(press: Promise<T>): Promise<{ answered: T } | { refused: Refusal }> =>
  press.then(
    (answered) => ({ answered }),
    (err: unknown) => {
      if (err instanceof ApiError) return { refused: (err.details ?? {}) as Refusal }
      throw err
    }
  )

interface BookingNow {
  session_id: string
  status: string
  start: string
  price_paid: string
  owed: string
}
const bookingNow = async (bookingId: string) =>
  (
    await first.query<BookingNow>(
      `SELECT session_id, status, to_char(start_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI') AS start, price_paid::text AS price_paid, refund_owed_amount::text AS owed
         FROM bookings WHERE id = $1`,
      [bookingId]
    )
  )[0]
const sessionNow = async (sessionId: string) =>
  (await first.query<{ status: string; start: string; booked: number }>(`SELECT status, to_char(start_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI') AS start, total_booked AS booked FROM sessions WHERE id = $1`, [sessionId]))[0]
/** The lead's standing check 6 (W51 review): bookings that aren't cancelled on a blocked session. */
const onBlockedSessions = async (sessionId: string) =>
  (await first.query<{ n: number }>("SELECT count(*)::int AS n FROM bookings b JOIN sessions s ON s.id = b.session_id WHERE s.status = 'blocked' AND b.status <> 'cancelled' AND s.id = $1", [sessionId]))[0]?.n
/** The lead's standing check 7: bookings that aren't cancelled whose times differ from their session's. */
const timesDiffer = async (sessionId: string) =>
  (
    await first.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM bookings b JOIN sessions s ON s.id = b.session_id WHERE b.status <> 'cancelled' AND s.id = $1 AND (b.start_time <> s.start_time OR b.end_time <> s.end_time)",
      [sessionId]
    )
  )[0]?.n
const finished = async (bookingId: string) =>
  (await first.query<{ details: { outcome?: string; owed?: number; by?: { how?: string } } }>("SELECT details FROM audit_log WHERE action = 'booking.refund_finished' AND entity_id = $1 ORDER BY at, ctid", [bookingId])).map((row) => row.details)

/** A dearer Move on the reader, as the Move dialog presses it: Core (two at GBP 20) to Peak (two at GBP 25.50), GBP 11 to take. */
const toPeakOnTheReader = (db: Db, stripe: FakeStripe, bookingId: string, peakSession: string) =>
  moveBooking(db, bookingId, { newSessionId: peakSession, confirmed: true, figures: { amountDue: 11, toCollect: 11 }, payment: { method: 'reader' } }, options(stripe))

describe('W51a (W51 review S1): a dearer Move on the reader, waiting for its tap, against the slot it moved off', () => {
  it('a block, a Block Day and a start-time change on the old slot are each refused while the payment is unfinished, with the booking listed as being moved; the payment is cancelled and the booking is back on the old slot, open and at its own time', async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const { day, nextDay } = nextDays()
    const coreSession = await sessionAt(day, 10, core)
    const peakSession = await sessionAt(nextDay, 18, peak)
    const bookingId = await twoSeatsOnTheCard(stripe, coreSession, slot(day, 10), core, '20.00')
    const moved = await toPeakOnTheReader(first, stripe, bookingId, peakSession)
    expect(moved).toMatchObject({ moved: true, pendingReaderPayment: { flow: 'move', amount: 11 } })
    const pendingId = moved.pendingReaderPayment?.pendingId as string
    // In flight: the booking is on the new slot, and the old one still holds its two places and has no booking on it.
    expect((await bookingNow(bookingId))?.session_id).toBe(peakSession)
    expect((await sessionNow(coreSession))?.booked).toBe(2)
    expect((await first.query("SELECT 1 FROM bookings WHERE session_id = $1 AND status <> 'cancelled'", [coreSession])).length).toBe(0)

    const blocked = await outcome(blockSession(second, coreSession, 'Sauna repair', pressBy(jo)))
    expect(blocked).toMatchObject({ refused: { reason: 'move_in_flight', message: "A booking is being moved off this slot and its payment isn't finished. Try again when it is.", conflictingBookings: [{ id: bookingId, movingOff: true }] } })
    const dayBlocked = await outcome(blockDay(second, day, 'Staff day', { toBlock: 1, alreadyBlocked: 0 }, pressBy(jo)))
    expect(dayBlocked).toMatchObject({ refused: { reason: 'move_in_flight', conflictingBookings: [{ id: bookingId, movingOff: true }] } })
    const retimed = await outcome(setSessionStartTime(second, coreSession, `${day}T11:00:00.000Z`, pressBy(jo)))
    expect(retimed).toMatchObject({ refused: { reason: 'move_in_flight' } })
    expect(await sessionNow(coreSession)).toEqual({ status: 'open', start: `${day}T10:00`, booked: 2 })
    expect(await first.query('SELECT 1 FROM closed_dates WHERE closed_on = $1::date', [day])).toEqual([])
    // The day it moved TO has it as a booking in the way, like any other.
    expect(await outcome(blockDay(second, nextDay, 'Staff day', { toBlock: 1, alreadyBlocked: 0 }, pressBy(jo)))).toMatchObject({ refused: { reason: 'bookings_in_the_way' } })

    // The customer walks away: the reader payment is cancelled, and the Move undone.
    expect(await cancelReaderFlow(first, stripe, pendingId, { actor: { type: 'staff', id: jo }, requestId: crypto.randomUUID() })).toMatchObject({ cancelled: true })
    expect(await bookingNow(bookingId)).toMatchObject({ session_id: coreSession, status: 'confirmed', start: `${day}T10:00`, price_paid: '40.00' })
    expect(await sessionNow(coreSession)).toEqual({ status: 'open', start: `${day}T10:00`, booked: 2 })
    expect([await onBlockedSessions(coreSession), await timesDiffer(coreSession)]).toEqual([0, 0])
    // Back on it, it is a booking in the way; and the slot it left is free to block.
    expect(await outcome(blockSession(second, coreSession, 'Sauna repair', pressBy(jo)))).toMatchObject({ refused: { reason: 'bookings_in_the_way', conflictingBookings: [{ id: bookingId }] } })
    expect(await outcome(blockSession(second, peakSession, 'Sauna repair', pressBy(jo)))).toMatchObject({ answered: { blocked: true } })
  })

  it("control: the block and the time change as W51 left them (they read only the bookings ON the slot) go ahead during the Move, and the cancelled payment puts the booking back onto a blocked slot, and onto one whose times aren't the booking's", async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const cancelling = { actor: { type: 'staff' as const, id: jo }, requestId: crypto.randomUUID() }

    // The block. W51's check: the bookings on the slot that aren't cancelled. None, so it blocked.
    const one = nextDays()
    const blockedSlot = await sessionAt(one.day, 10, core)
    const firstBooking = await twoSeatsOnTheCard(stripe, blockedSlot, slot(one.day, 10), core, '20.00')
    const firstMove = await toPeakOnTheReader(first, stripe, firstBooking, await sessionAt(one.nextDay, 18, peak))
    expect(await second.query("SELECT b.id FROM bookings b WHERE b.session_id = $1::uuid AND b.status <> 'cancelled'", [blockedSlot])).toEqual([])
    await second.query("UPDATE sessions SET status = 'blocked', blocked_reason = $1, blocked_by = $2::uuid, updated_at = now() WHERE id = ANY($3::uuid[]) AND status <> 'blocked'", ['Sauna repair', jo, [blockedSlot]])
    expect(await cancelReaderFlow(first, stripe, firstMove.pendingReaderPayment?.pendingId as string, cancelling)).toMatchObject({ cancelled: true })
    // S1 as it was: a confirmed booking on a blocked session.
    expect(await bookingNow(firstBooking)).toMatchObject({ session_id: blockedSlot, status: 'confirmed' })
    expect((await sessionNow(blockedSlot))?.status).toBe('blocked')
    expect(await onBlockedSessions(blockedSlot)).toBe(1)

    // The time change. W51's check: the same count. None, so the 10:00 became the 11:00.
    const two = nextDays()
    const movedSlot = await sessionAt(two.day, 10, core)
    const secondBooking = await twoSeatsOnTheCard(stripe, movedSlot, slot(two.day, 10), core, '20.00')
    const secondMove = await toPeakOnTheReader(first, stripe, secondBooking, await sessionAt(two.nextDay, 18, peak))
    expect((await second.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM bookings WHERE session_id = $1::uuid AND status <> 'cancelled'", [movedSlot]))[0]?.n).toBe(0)
    await second.query("UPDATE sessions s SET start_time = $1::timestamptz, end_time = $1::timestamptz + interval '60 minutes', updated_at = now() WHERE s.id = $2::uuid", [`${two.day}T11:00:00.000Z`, movedSlot])
    expect(await cancelReaderFlow(first, stripe, secondMove.pendingReaderPayment?.pendingId as string, cancelling)).toMatchObject({ cancelled: true })
    // The booking says 10:00 to 11:00 on a session at 11:00 to 12:00.
    expect(await bookingNow(secondBooking)).toMatchObject({ session_id: movedSlot, status: 'confirmed', start: `${two.day}T10:00` })
    expect((await sessionNow(movedSlot))?.start).toBe(`${two.day}T11:00`)
    expect(await timesDiffer(movedSlot)).toBe(1)
  })

  it("no gap: a block pressed while the Move's first transaction is still open waits on the old slot (the Move holds its lock while it writes its flow row), and is refused once the Move has committed", async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const { day, nextDay } = nextDays()
    const coreSession = await sessionAt(day, 10, core)
    const peakSession = await sessionAt(nextDay, 18, peak)
    const bookingId = await twoSeatsOnTheCard(stripe, coreSession, slot(day, 10), core, '20.00')
    // The Move, stopped inside C1 straight after it has written its flow row: the booking is moved, nothing committed.
    const held = holdingAfter(first, (sql) => sql.startsWith('INSERT INTO pending_reader_payments'))
    const moving = outcome(toPeakOnTheReader(held.db, stripe, bookingId, peakSession))
    const holder = await held.holding
    const blocked = outcome(blockSession(second, coreSession, 'Sauna repair', pressBy(jo)))
    expect(await waitingOn(pg, await sessionBlockedBy(pg, holder))).toEqual(['sessions'])
    held.release()
    expect(await moving).toMatchObject({ answered: { moved: true, pendingReaderPayment: { flow: 'move' } } })
    expect(await blocked).toMatchObject({ refused: { reason: 'move_in_flight', conflictingBookings: [{ id: bookingId, movingOff: true }] } })
    expect((await sessionNow(coreSession))?.status).toBe('open')
  })
})

describe("W51a (W51 review S1): a refund's undo puts a booking back only on a slot still open and still at the booking's time", () => {
  /** Runs `meanwhile` just before Stripe is asked for the refund (R1 has committed): what another person did in those seconds. */
  function whileTheRefundIsSent(stripe: FakeStripe, meanwhile: () => Promise<unknown>): void {
    const create = stripe.refunds.create
    stripe.refunds.create = (async (...args: Parameters<typeof create>) => {
      await meanwhile()
      return create(...args)
    }) as typeof create
  }
  /** A cheaper Move, Peak (two at GBP 25.50) to Core (two at GBP 20): GBP 11 back to the card, which Stripe declines. */
  async function cheaperMoveDeclined(meanwhile: (peakSession: string, day: string) => Promise<unknown>) {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const { day, nextDay } = nextDays()
    const peakSession = await sessionAt(day, 18, peak)
    const coreSession = await sessionAt(nextDay, 10, core)
    const bookingId = await twoSeatsOnTheCard(stripe, peakSession, slot(day, 18), peak, '25.50')
    let meanwhileAnswer: unknown
    whileTheRefundIsSent(stripe, async () => {
      meanwhileAnswer = await meanwhile(peakSession, day)
    })
    stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
    const pressed = await outcome(moveBooking(first, bookingId, { newSessionId: coreSession, confirmed: true, figures: { amountDue: -11 }, refundMethod: 'card' }, options(stripe)))
    return { pressed, bookingId, peakSession, coreSession, day, meanwhileAnswer }
  }

  it('a cheaper Move whose card refund is declined, the old slot BLOCKED meanwhile (the real block: nothing is on it): the booking is not put back; the Move stands and the GBP 11 is money still to refund', async () => {
    const { pressed, bookingId, peakSession, coreSession, meanwhileAnswer } = await cheaperMoveDeclined((peakSession) => blockSession(second, peakSession, 'Sauna repair', pressBy(jo)))
    expect(meanwhileAnswer).toMatchObject({ blocked: true })
    expect(pressed).toMatchObject({ answered: { moved: true, held: { reason: 'refund_refused_not_put_back' } } })
    // On the new slot, with the GBP 11 it is owed shown on it (W25a: the price paid comes down when it is refunded).
    expect(await bookingNow(bookingId)).toMatchObject({ session_id: coreSession, status: 'confirmed', price_paid: '51.00', owed: '11.00' })
    expect(await sessionNow(peakSession)).toMatchObject({ status: 'blocked', booked: 0 })
    expect(await finished(bookingId)).toMatchObject([{ outcome: 'owed', owed: 11, by: { how: 'undo_blocked' } }])
    expect([await onBlockedSessions(peakSession), await timesDiffer(peakSession)]).toEqual([0, 0])
  })

  it('the same with the old slot\'s START TIME moved meanwhile (the real change): not put back; money still to refund', async () => {
    const { pressed, bookingId, peakSession, coreSession, day, meanwhileAnswer } = await cheaperMoveDeclined((peakSession, day) => setSessionStartTime(second, peakSession, `${day}T19:00:00.000Z`, pressBy(jo)))
    expect(meanwhileAnswer).toMatchObject({ updated: true })
    expect(pressed).toMatchObject({ answered: { moved: true, held: { reason: 'refund_refused_not_put_back' } } })
    expect(await bookingNow(bookingId)).toMatchObject({ session_id: coreSession, owed: '11.00' })
    expect(await sessionNow(peakSession)).toMatchObject({ status: 'open', start: `${day}T19:00`, booked: 0 })
    expect(await finished(bookingId)).toMatchObject([{ outcome: 'owed', owed: 11, by: { how: 'undo_blocked' } }])
    expect(await timesDiffer(peakSession)).toBe(0)
  })

  it('control: with the old slot left alone the same declined refund puts the booking back exactly, with nothing owed', async () => {
    const { pressed, bookingId, peakSession, day } = await cheaperMoveDeclined(async () => 'nothing')
    // The press is refused ("the booking wasn't moved and nothing was refunded"): the undo went through.
    expect(pressed).toMatchObject({ refused: { reason: 'refund_failed' } })
    expect(await bookingNow(bookingId)).toMatchObject({ session_id: peakSession, status: 'confirmed', start: `${day}T18:00`, price_paid: '51.00', owed: '0.00' })
    expect(await sessionNow(peakSession)).toMatchObject({ status: 'open', booked: 2 })
    expect(await finished(bookingId)).toMatchObject([{ outcome: 'put_back' }])
  })

  /** Cancel & Refund of a card booking for two (GBP 40) to the card, which Stripe declines. */
  async function cancelDeclined(meanwhile: (session: string, day: string) => Promise<unknown>) {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const { day } = nextDays()
    const session = await sessionAt(day, 10, core)
    const bookingId = await twoSeatsOnTheCard(stripe, session, slot(day, 10), core, '20.00')
    let meanwhileAnswer: unknown
    whileTheRefundIsSent(stripe, async () => {
      meanwhileAnswer = await meanwhile(session, day)
    })
    stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
    const pressed = await outcome(cancelAndRefund(first, bookingId, { refundMethod: 'card', addonLineIds: [], confirmed: { refund: 40, addonsRefund: 0 } }, options(stripe)))
    return { pressed, bookingId, session, day, meanwhileAnswer }
  }

  it('a Cancel & Refund whose card refund is declined, the slot BLOCKED meanwhile: the booking stays cancelled, on no blocked slot, and the GBP 40 is money still to refund', async () => {
    const { pressed, bookingId, session, meanwhileAnswer } = await cancelDeclined((session) => blockSession(second, session, 'Sauna repair', pressBy(jo)))
    expect(meanwhileAnswer).toMatchObject({ blocked: true })
    expect(pressed).toMatchObject({ answered: { cancelled: true, held: { reason: 'refund_refused_not_put_back' } } })
    expect(await bookingNow(bookingId)).toMatchObject({ status: 'cancelled', owed: '40.00' })
    expect(await sessionNow(session)).toMatchObject({ status: 'blocked', booked: 0 })
    expect(await finished(bookingId)).toMatchObject([{ outcome: 'owed', owed: 40, by: { how: 'undo_blocked' } }])
    expect(await onBlockedSessions(session)).toBe(0)
  })

  it("the same with the slot's START TIME moved meanwhile: the booking stays cancelled (its times aren't the slot's any more); money still to refund", async () => {
    const { pressed, bookingId, session, day, meanwhileAnswer } = await cancelDeclined((session, day) => setSessionStartTime(second, session, `${day}T12:00:00.000Z`, pressBy(jo)))
    expect(meanwhileAnswer).toMatchObject({ updated: true })
    expect(pressed).toMatchObject({ answered: { cancelled: true, held: { reason: 'refund_refused_not_put_back' } } })
    expect(await bookingNow(bookingId)).toMatchObject({ status: 'cancelled', owed: '40.00' })
    expect(await sessionNow(session)).toMatchObject({ status: 'open', start: `${day}T12:00`, booked: 0 })
    expect(await timesDiffer(session)).toBe(0)
  })

  it('control: with the slot left alone the same declined refund puts the cancelled booking back, confirmed, with its places and nothing owed', async () => {
    const { pressed, bookingId, session, day } = await cancelDeclined(async () => 'nothing')
    // The press is refused ("nothing was refunded"): the undo went through.
    expect('refused' in pressed).toBe(true)
    expect(await bookingNow(bookingId)).toMatchObject({ session_id: session, status: 'confirmed', start: `${day}T10:00`, price_paid: '40.00', owed: '0.00' })
    expect(await sessionNow(session)).toMatchObject({ status: 'open', booked: 2 })
  })
})
