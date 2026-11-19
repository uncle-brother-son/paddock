import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { moneyOwedOutputSchema } from '@/contracts'
import type { Db } from '@/server/db'
import { fixtures, insert, startTestDatabase, type TestDatabase } from '@/server/rules/testing/database'
import { MONEY_OWED_WORDS } from './failure-messages'
import { LAPSED_KEPT_DAYS, moneyOwedList } from './money-owed-list'

// Brief W47 item 1 (G-plan 4.7): the "Money still to refund" list, against the live schema. Rows are written as the
// Worker's own actions leave them (the figure on the order or booking, and the record that raised it); the same list
// is read after the real actions in orders/refund-lines.test.ts, bookings/refunds.test.ts, events/cancel-places.test.ts
// and bookings/lapse-sweep.test.ts.

let database: TestDatabase
let db: Db
beforeAll(async () => {
  database = await startTestDatabase({ schema: 'live' })
  db = database.db
})
afterAll(() => database.stop())
beforeEach(async () => {
  await db.query('UPDATE orders SET refund_owed_amount = 0')
  await db.query('UPDATE bookings SET refund_owed_amount = 0')
  await db.query("DELETE FROM audit_log WHERE action = 'booking.lapsed'")
})

const NOW = new Date('2026-11-18T12:00:00Z').getTime()
const list = () => moneyOwedList(db, { now: () => NOW })
const daysAgo = (days: number, hours = 0): string => new Date(NOW - days * 86_400_000 - hours * 3_600_000).toISOString()

let day = 0
/**
 * A session on a day of its own, with its times: live bookings on different sessions may not overlap in time, and a
 * booking inserted here carries its session's times as the real actions write them.
 */
async function aSession(): Promise<{ sessionId: string; start: string; end: string }> {
  day += 1
  const serviceTypeId = await fixtures.serviceType(db)
  const date = `2031-${String(1 + Math.floor(day / 28)).padStart(2, '0')}-${String(1 + (day % 28)).padStart(2, '0')}`
  const start = `${date} 10:00:00+00`
  const end = `${date} 11:00:00+00`
  return { sessionId: await fixtures.session(db, { service_type_id: serviceTypeId, start_time: start, end_time: end }), start, end }
}

async function anOrder(owed: string, customer: Record<string, unknown> = {}): Promise<{ orderId: string; customerId: string }> {
  const customerId = await fixtures.customer(db, customer)
  const orderId = await insert(db, 'orders', { customer_id: customerId, order_total: '50.00', payment_status: 'partially_refunded', payment_method: 'card', order_source: 'staff_created', refund_owed_amount: owed })
  return { orderId, customerId }
}

async function aBooking(owed: string, row: Record<string, unknown> = {}, customer: Record<string, unknown> = {}): Promise<{ bookingId: string; customerId: string }> {
  const customerId = await fixtures.customer(db, customer)
  const session = await aSession()
  const bookingId = await fixtures.booking(db, { session_id: session.sessionId, start_time: session.start, end_time: session.end, customer_id: customerId, price_paid: '20.00', refund_owed_amount: owed, ...row })
  return { bookingId, customerId }
}

/** An audit row with its own time, as the action that wrote it would have left it. */
const row = (action: string, entityType: string, entityId: string, at: string, details: Record<string, unknown>) =>
  db.query('INSERT INTO audit_log (at, actor_type, action, entity_type, entity_id, details) VALUES ($1::timestamptz, $2, $3, $4, $5, $6::jsonb)', [at, 'staff', action, entityType, entityId, JSON.stringify(details)])

describe('GET money-owed: the "Money still to refund" list (brief W47 item 1)', () => {
  it('nothing owed anywhere: an empty list, a total of £0, and the note about kept money', async () => {
    await anOrder('0')
    await aBooking('0')
    const answer = await list()
    expect(answer).toEqual({ owed: [], total: 0, lapsedKept: [], keptDays: LAPSED_KEPT_DAYS, keptNote: MONEY_OWED_WORDS.keptNote })
    expect(moneyOwedOutputSchema.parse(answer)).toEqual(answer)
    expect(MONEY_OWED_WORDS.keptNote).toContain('Adjust store credit')
  })

  it('an order, a booking, a cancelled booking, a lapsed booking and an event booking, each with money owed: each appears exactly once', async () => {
    const order = await anOrder('24.00', { first_name: 'Olive', last_name: 'Order' })
    const live = await aBooking('5.00', {}, { first_name: 'Liv', last_name: 'Live' })
    const cancelled = await aBooking('20.00', { status: 'cancelled', cancelled_at: daysAgo(3) }, { first_name: 'Cal', last_name: 'Cancelled' })
    const lapsed = await aBooking('7.50', { status: 'cancelled', cancelled_at: daysAgo(2) }, { first_name: 'Lap', last_name: 'Lapsed' })
    await row('booking.lapsed', 'booking', lapsed.bookingId, daysAgo(2), { back: true, kept: null, pricePaid: 20, refundOwed: 7.5, addonsKept: 0, storeCreditRefunded: 12.5 })
    // An event booking's money owed is its order's: one order, with the event booking beside it.
    const eventOrder = await anOrder('40.00', { first_name: 'Eve', last_name: 'Event' })
    const eventId = await fixtures.event(db, { name: 'Full moon swim' })
    const eventBookingId = await insert(db, 'event_bookings', { event_id: eventId, customer_id: eventOrder.customerId, places: 1, status: 'cancelled', price_paid: '40.00' })
    await insert(db, 'order_line_items', { order_id: eventOrder.orderId, event_booking_id: eventBookingId, item_type: 'event', quantity: 1, unit_price: '40.00', line_total: '40.00' })

    const answer = await list()
    expect(moneyOwedOutputSchema.parse(answer)).toEqual(answer)
    expect(answer.owed).toHaveLength(5)
    expect(answer.total).toBe(96.5)
    const of = (customerName: string) => answer.owed.filter((item) => item.customerName === customerName)

    expect(of('Olive Order')).toEqual([
      { on: 'order', orderId: order.orderId, bookingId: null, customerId: order.customerId, customerName: 'Olive Order', amount: 24, owedSince: null, daysOwed: null, where: MONEY_OWED_WORDS.order },
    ])
    expect(of('Liv Live')).toHaveLength(1)
    expect(of('Liv Live')[0]).toMatchObject({ on: 'booking', bookingId: live.bookingId, orderId: null, amount: 5, bookingStatus: 'confirmed', lapsed: false, where: MONEY_OWED_WORDS.booking })
    expect(of('Liv Live')[0]?.sessionStart).toMatch(/^2031-/)
    expect(of('Cal Cancelled')).toHaveLength(1)
    expect(of('Cal Cancelled')[0]).toMatchObject({ on: 'booking', bookingId: cancelled.bookingId, amount: 20, bookingStatus: 'cancelled', lapsed: false, where: MONEY_OWED_WORDS.cancelledBooking })
    expect(of('Lap Lapsed')).toHaveLength(1)
    expect(of('Lap Lapsed')[0]).toMatchObject({ on: 'booking', bookingId: lapsed.bookingId, amount: 7.5, bookingStatus: 'cancelled', lapsed: true, where: MONEY_OWED_WORDS.lapsedBooking })
    // The event booking is on its order's line and nowhere else.
    expect(of('Eve Event')).toHaveLength(1)
    expect(of('Eve Event')[0]).toMatchObject({ on: 'order', orderId: eventOrder.orderId, bookingId: null, amount: 40, where: MONEY_OWED_WORDS.orderWithEvent })
    expect(of('Eve Event')[0]?.eventBookings).toEqual([{ eventBookingId, eventId, eventName: 'Full moon swim', startsAt: expect.stringMatching(/^2099-06-15/), status: 'cancelled' }])
    expect(answer.owed.filter((item) => JSON.stringify(item).includes(eventBookingId))).toHaveLength(1)
    // A lapse that gave everything back kept nothing, so it isn't under "kept".
    expect(answer.lapsedKept).toEqual([])
  })

  it("a booking the database's old sweep lapsed (its reason, no row) reads as lapsed too", async () => {
    const old = await aBooking('3.00', { status: 'cancelled', cancelled_at: daysAgo(40), cancel_reason: 'membership_lapsed' })
    expect((await list()).owed).toEqual([expect.objectContaining({ bookingId: old.bookingId, lapsed: true, where: MONEY_OWED_WORDS.lapsedBooking })])
  })

  it('how long it has been owed: from the record that raised it, and the one owed longest comes first', async () => {
    const recent = await anOrder('10.00', { first_name: 'Rae', last_name: 'Recent' })
    await row('order.refund_finished', 'order', recent.orderId, daysAgo(1, 2), { claimId: crypto.randomUUID(), outcome: 'owed', owed: 10 })
    const old = await aBooking('20.00', {}, { first_name: 'Ola', last_name: 'Oldest' })
    await row('booking.refund_finished', 'booking', old.bookingId, daysAgo(9), { claimId: crypto.randomUUID(), outcome: 'owed', owed: 20 })
    // A claim that gave everything raised nothing.
    await row('booking.refund_finished', 'booking', old.bookingId, daysAgo(30), { claimId: crypto.randomUUID(), outcome: 'given', owed: 0 })
    const failedLater = await anOrder('6.00', { first_name: 'Fay', last_name: 'Failed' })
    await row('order.refund_failed_later', 'order', failedLater.orderId, daysAgo(4), { refundId: 're_1', amount: 6, owed: 6, status: 'failed' })

    const answer = await list()
    expect(answer.owed.map((item) => [item.customerName, item.daysOwed, item.owedSince])).toEqual([
      ['Ola Oldest', 9, daysAgo(9)],
      ['Fay Failed', 4, daysAgo(4)],
      ['Rae Recent', 1, daysAgo(1, 2)],
    ])
  })

  it('owed again after it was settled: counted from the newer record, not the one already settled', async () => {
    const { orderId } = await anOrder('8.00')
    await row('order.refund_finished', 'order', orderId, daysAgo(20), { outcome: 'owed', owed: 24 })
    // Refund the rest gave the £24 (its claim), then a later refund left £8 owed.
    await row('order.refund_claimed', 'order', orderId, daysAgo(15), { kind: 'refund_owed', amount: 24, worker: true })
    await row('order.refund_finished', 'order', orderId, daysAgo(15), { outcome: 'given', owed: 0 })
    await row('order.refund_finished', 'order', orderId, daysAgo(2), { outcome: 'owed', owed: 8 })
    expect((await list()).owed[0]).toMatchObject({ orderId, daysOwed: 2, owedSince: daysAgo(2) })
  })

  it('part of it already arrived and the rest stayed: still counted from when it became owed', async () => {
    const { bookingId } = await aBooking('5.00')
    await row('booking.refund_finished', 'booking', bookingId, daysAgo(12), { outcome: 'owed', owed: 20 })
    await row('booking.refund_owed_arrived', 'booking', bookingId, daysAgo(3), { amount: 15, reason: 'seen in Stripe' })
    expect((await list()).owed[0]).toMatchObject({ bookingId, amount: 5, daysOwed: 12, owedSince: daysAgo(12) })
  })

  it("an event booking's claim that left money owed dates its order's line", async () => {
    const { orderId, customerId } = await anOrder('40.00')
    const eventBookingId = await insert(db, 'event_bookings', { event_id: await fixtures.event(db), customer_id: customerId, places: 2, status: 'confirmed', price_paid: '80.00' })
    await insert(db, 'order_line_items', { order_id: orderId, event_booking_id: eventBookingId, item_type: 'event', quantity: 2, unit_price: '40.00', line_total: '80.00' })
    await row('event_booking.refund_finished', 'event_booking', eventBookingId, daysAgo(6), { outcome: 'owed', owed: 40, orderId })
    expect((await list()).owed[0]).toMatchObject({ on: 'order', orderId, daysOwed: 6, owedSince: daysAgo(6) })
  })

  it('money kept on lapsed bookings: what each lapse kept and why, newest first, with nothing owed among it', async () => {
    const inside = await aBooking('0', { status: 'cancelled', cancelled_at: daysAgo(5), price_paid: '20.00' }, { first_name: 'Ina', last_name: 'Inside' })
    await row('booking.lapsed', 'booking', inside.bookingId, daysAgo(5), { back: false, kept: 'inside_24_hours', pricePaid: 20, refundOwed: 0, addonsKept: 4, storeCreditRefunded: 0 })
    const started = await aBooking('0', { status: 'cancelled', cancelled_at: daysAgo(1), price_paid: '15.00' }, { first_name: 'Stu', last_name: 'Started' })
    await row('booking.lapsed', 'booking', started.bookingId, daysAgo(1), { back: false, kept: 'session_started', pricePaid: 15, refundOwed: 0, addonsKept: 0, storeCreditRefunded: 0 })
    // Given back in full 24 hours or more before: nothing kept. A credit seat with nothing paid: nothing kept either.
    const given = await aBooking('0', { status: 'cancelled', cancelled_at: daysAgo(2) })
    await row('booking.lapsed', 'booking', given.bookingId, daysAgo(2), { back: true, kept: null, pricePaid: 20, refundOwed: 0, addonsKept: 0, storeCreditRefunded: 20 })
    const free = await aBooking('0', { status: 'cancelled', cancelled_at: daysAgo(2), price_paid: '0' })
    await row('booking.lapsed', 'booking', free.bookingId, daysAgo(2), { back: false, kept: 'inside_24_hours', pricePaid: 0, refundOwed: 0, addonsKept: 0, storeCreditRefunded: 0 })

    const answer = await list()
    expect(answer.owed).toEqual([])
    expect(answer.lapsedKept.map((item) => [item.customerName, item.kept, item.keptBecause, item.bookingId, item.lapsedAt])).toEqual([
      ['Stu Started', 15, 'session_started', started.bookingId, daysAgo(1)],
      ['Ina Inside', 24, 'inside_24_hours', inside.bookingId, daysAgo(5)],
    ])
    expect(answer.lapsedKept[1]?.words).toContain('£24.00 was kept: it lapsed inside 24 hours of the session.')
    expect(answer.lapsedKept[0]?.words).toContain('£15.00 was kept: the session had already started.')
  })

  it('a lapse that kept money and left card refund money owed is on both lists: the kept money less what is owed', async () => {
    const { bookingId } = await aBooking('5.00', { status: 'cancelled', cancelled_at: daysAgo(4), price_paid: '20.00' })
    await row('booking.lapsed', 'booking', bookingId, daysAgo(4), { back: false, kept: 'inside_24_hours', pricePaid: 20, refundOwed: 5, addonsKept: 0, storeCreditRefunded: 0 })
    const answer = await list()
    expect(answer.owed).toEqual([expect.objectContaining({ bookingId, amount: 5, lapsed: true })])
    expect(answer.lapsedKept).toEqual([expect.objectContaining({ bookingId, kept: 15 })])
  })

  it(`money kept more than ${LAPSED_KEPT_DAYS} days ago is no longer listed`, async () => {
    const { bookingId } = await aBooking('0', { status: 'cancelled', cancelled_at: new Date(Date.now() - (LAPSED_KEPT_DAYS + 1) * 86_400_000).toISOString(), price_paid: '20.00' })
    await row('booking.lapsed', 'booking', bookingId, daysAgo(LAPSED_KEPT_DAYS + 1), { back: false, kept: 'inside_24_hours', pricePaid: 20, refundOwed: 0, addonsKept: 0, storeCreditRefunded: 0 })
    expect((await list()).lapsedKept).toEqual([])
  })
})
