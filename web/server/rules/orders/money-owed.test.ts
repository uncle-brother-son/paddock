import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Db } from '@/server/db'
import { fixtures, insert, startTestDatabase, type TestDatabase } from '@/server/rules/testing/database'
import { lowerMoneyOwed, moneyOwedOnEventBooking, moneyOwedOnOrder, raiseMoneyOwed } from './money-owed'

// Brief W27 item 3 (E-plan 4.5; Wayne's Q39): money owed on an order, against orders.refund_owed_amount (migration
// 023). Raise, lower, read. Not called by any route yet. The races under the order's lock are in
// server/rules/refunds/claims-postgres.test.ts.

let database: TestDatabase
let db: Db
beforeAll(async () => {
  database = await startTestDatabase({ schema: 'live' })
  db = database.db
})
afterAll(() => database.stop())

async function anOrder(total = '50.00'): Promise<{ orderId: string; customerId: string }> {
  const customerId = await fixtures.customer(db)
  const orderId = await insert(db, 'orders', { customer_id: customerId, order_total: total, payment_status: 'paid', payment_method: 'card', order_source: 'staff_created' })
  return { orderId, customerId }
}
const raise = (orderId: string, amount: number) => db.transaction((tx) => raiseMoneyOwed(tx, orderId, amount))
const lower = (orderId: string, amount: number) => db.transaction((tx) => lowerMoneyOwed(tx, orderId, amount))
const stored = async (orderId: string) => (await db.query<{ owed: string }>('SELECT refund_owed_amount::text AS owed FROM orders WHERE id = $1', [orderId]))[0]?.owed
const balance = async (customerId: string) => (await db.query<{ balance: string }>('SELECT store_credit_balance::text AS balance FROM customers WHERE id = $1', [customerId]))[0]?.balance

describe('money owed on an order (brief W27 item 3)', () => {
  it('a new order owes nothing; an order that does not exist reads as null', async () => {
    const { orderId } = await anOrder()
    expect(await moneyOwedOnOrder(db, orderId)).toBe(0)
    expect(await stored(orderId)).toBe('0.00')
    expect(await moneyOwedOnOrder(db, crypto.randomUUID())).toBeNull()
  })

  it('raised by what never went, and raised again: the figure after each', async () => {
    const { orderId } = await anOrder()
    expect(await raise(orderId, 24)).toBe(24)
    expect(await raise(orderId, 5.5)).toBe(29.5)
    expect(await moneyOwedOnOrder(db, orderId)).toBe(29.5)
    expect(await stored(orderId)).toBe('29.50')
  })

  it('lowered by part of it (audit row 31), then by the rest, to exactly £0', async () => {
    const { orderId } = await anOrder()
    await raise(orderId, 40)
    expect(await lower(orderId, 15)).toEqual({ ok: true, owed: 25 })
    expect(await lower(orderId, 25)).toEqual({ ok: true, owed: 0 })
    expect(await stored(orderId)).toBe('0.00')
  })

  it('never below £0: more than is owed lowers nothing and answers what is owed', async () => {
    const { orderId } = await anOrder()
    await raise(orderId, 10)
    expect(await lower(orderId, 10.01)).toEqual({ ok: false, reason: 'more_than_owed', owed: 10 })
    expect(await lower(orderId, 50)).toEqual({ ok: false, reason: 'more_than_owed', owed: 10 })
    expect(await stored(orderId)).toBe('10.00')
    // Nothing owed at all.
    const none = await anOrder()
    expect(await lower(none.orderId, 1)).toEqual({ ok: false, reason: 'more_than_owed', owed: 0 })
  })

  it('half a penny either way (Q18): a figure a hair over what is owed clears it exactly', async () => {
    const { orderId } = await anOrder()
    await raise(orderId, 10)
    expect(await lower(orderId, 10.004)).toEqual({ ok: true, owed: 0 })
    expect(await stored(orderId)).toBe('0.00')
  })

  it("pounds and pence only: an amount is rounded to the penny before it is stored, so sums of pence don't drift", async () => {
    const { orderId } = await anOrder()
    for (let n = 0; n < 10; n += 1) await raise(orderId, 0.1)
    expect(await moneyOwedOnOrder(db, orderId)).toBe(1)
    for (let n = 0; n < 10; n += 1) await lower(orderId, 0.1)
    expect(await stored(orderId)).toBe('0.00')
  })

  it.each([0, -5, 0.004, Number.NaN, Number.POSITIVE_INFINITY])('an amount of %s is a fault in the caller: thrown, nothing changed', async (amount) => {
    const { orderId } = await anOrder()
    await raise(orderId, 10)
    await expect(raise(orderId, amount)).rejects.toThrow(/amount/)
    await expect(lower(orderId, amount)).rejects.toThrow(/amount/)
    expect(await stored(orderId)).toBe('10.00')
  })

  it('an order that is gone: raising throws (the transaction keeps nothing), lowering answers order_not_found', async () => {
    const gone = crypto.randomUUID()
    await expect(raise(gone, 10)).rejects.toThrow(/no longer exists/)
    expect(await lower(gone, 10)).toEqual({ ok: false, reason: 'order_not_found' })
  })

  it('a raise inside a transaction that then fails is not kept', async () => {
    const { orderId } = await anOrder()
    await expect(
      db.transaction(async (tx) => {
        await raiseMoneyOwed(tx, orderId, 30)
        throw new Error('R2 failed after the raise')
      })
    ).rejects.toThrow('R2 failed after the raise')
    expect(await stored(orderId)).toBe('0.00')
  })

  it('Q39: owing and clearing move no money: never store credit, and nothing else on the order changes', async () => {
    const { orderId, customerId } = await anOrder()
    const before = (await db.query<Record<string, unknown>>('SELECT order_total, payment_status, payment_method, discount_amount FROM orders WHERE id = $1', [orderId]))[0]
    await raise(orderId, 30)
    await lower(orderId, 30)
    expect(await balance(customerId)).toBe('0.00')
    expect(await db.query('SELECT 1 FROM store_credit_transactions WHERE customer_id = $1', [customerId])).toEqual([])
    expect((await db.query<Record<string, unknown>>('SELECT order_total, payment_status, payment_method, discount_amount FROM orders WHERE id = $1', [orderId]))[0]).toEqual(before)
  })

  it("an event booking's money owed is its order's: read through the event line, with the order to act on", async () => {
    const { orderId, customerId } = await anOrder('80.00')
    const eventId = await fixtures.event(db)
    const eventBookingId = await insert(db, 'event_bookings', { event_id: eventId, customer_id: customerId, places: 2, status: 'confirmed', price_paid: '80.00' })
    await insert(db, 'order_line_items', { order_id: orderId, event_booking_id: eventBookingId, item_type: 'event', quantity: 2, unit_price: '40.00', line_total: '80.00' })
    expect(await moneyOwedOnEventBooking(db, eventBookingId)).toEqual({ orderId, owed: 0 })
    await raise(orderId, 40)
    expect(await moneyOwedOnEventBooking(db, eventBookingId)).toEqual({ orderId, owed: 40 })
    // One figure: what is owed on the booking is what is owed on the order, never counted twice.
    expect(await moneyOwedOnOrder(db, orderId)).toBe(40)
    // A booking with no order line (none can be sold without one) reads as null.
    const loose = await insert(db, 'event_bookings', { event_id: eventId, customer_id: customerId, places: 1, status: 'confirmed', price_paid: '0' })
    expect(await moneyOwedOnEventBooking(db, loose)).toBeNull()
  })

  it("the database refuses a figure below £0 itself (migration 023's check), whatever the code does", async () => {
    const { orderId } = await anOrder()
    await expect(db.query('UPDATE orders SET refund_owed_amount = -0.01 WHERE id = $1', [orderId])).rejects.toThrow(/orders_refund_owed_amount_check/)
  })
})
