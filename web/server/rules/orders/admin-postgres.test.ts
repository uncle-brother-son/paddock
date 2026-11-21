import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Db } from '@/server/db'
import { holdingAfter, outcomeOf, pressBy, sessionBlockedBy } from '@/server/rules/testing/admin-race'
import { fixtures, insert } from '@/server/rules/testing/database'
import { waitingOn } from '@/server/rules/testing/race'
import { startRealPostgres, type RealPostgres } from '@/server/rules/testing/real-postgres'
import { FakeStripe } from '@/server/stripe/fake'
import { SET_LINE_FULFILLED_SQL, setOrderLineFulfilled } from './admin'
import { refundOrderLines, type OrderRefundOptions } from './refund-lines'

// Brief W53 ("Parity and tests": a fulfilled race against a line refund, real Postgres; W48 review L2): the fulfilled
// tick against a refund of the same line, on real Postgres 17.6, each on its own connection (PGlite is one session
// and can't show one press waiting for another).
//
// The tick's guard reads the line's ORDER, another table's row, so the tick holds the order first (FOR SHARE). The
// refund here is the Worker's own (refundOrderLines, to store credit: one transaction, no Stripe call), which locks
// the order first and stamps the line later in the same transaction. Each race is held until Postgres itself reports
// the second press as blocked by the first, so none can pass by timing, and there is a control showing what the tick's
// own statement does without the order held first.

let pg: RealPostgres
let first: Db
let second: Db
let jo = ''
let tia = ''
let variant = ''

beforeAll(async () => {
  pg = await startRealPostgres()
  first = pg.connect()
  second = pg.connect()
  jo = await insert(first, 'staff', { role: 'admin', first_name: 'Jo', last_name: 'Staff', email: 'w53-race-jo@example.com', can_issue_refunds: true, can_manage_pricing: true })
  tia = await insert(first, 'staff', { role: 'staff', first_name: 'Tia', last_name: 'Team', email: 'w53-race-tia@example.com' })
  const soap = await insert(first, 'products', { name: 'Soap', base_price: '12.00', fulfillment_method: 'pickup' })
  variant = await insert(first, 'product_variants', { product_id: soap, sku: `SOAP-${crypto.randomUUID()}`, stock_quantity: 10_000 })
})
afterAll(() => pg.stop())

/** A cash order of one soap line (£24), still to hand over. */
async function soapOrder(): Promise<{ orderId: string; lineId: string }> {
  const customerId = await fixtures.customer(first)
  const orderId = await insert(first, 'orders', { customer_id: customerId, order_total: '24.00', payment_status: 'paid', payment_method: 'cash', order_source: 'staff_created' })
  const lineId = await insert(first, 'order_line_items', { order_id: orderId, product_variant_id: variant, item_type: 'product', quantity: 2, unit_price: '12.00', line_total: '24.00', fulfillment_status: 'pending' })
  return { orderId, lineId }
}

const refundOptions = (): OrderRefundOptions => ({ actor: { type: 'staff', id: jo }, requestId: crypto.randomUUID(), stripe: () => new FakeStripe() })
/** The Worker's own refund of the line, to store credit, with no restock: R1 does it all in one transaction. */
const refund = (db: Db, order: { orderId: string; lineId: string }) =>
  refundOrderLines(db, order.orderId, { lineItemIds: [order.lineId], refundMethod: 'credit', restock: { [order.lineId]: false }, confirmed: { amount: 24 } }, refundOptions())
/** The refund stopped, still open, straight after it has locked the order (before it has stamped the line). */
const refundHoldingTheOrder = () => holdingAfter(first, (sql) => sql.includes('FROM (SELECT id, customer_id FROM orders WHERE id = $1::uuid FOR UPDATE) o'))

const lineNow = async (lineId: string) => (await first.query<{ fulfillment_status: string | null; refunded: boolean }>('SELECT fulfillment_status, (refunded_at IS NOT NULL) AS refunded FROM order_line_items WHERE id = $1', [lineId]))[0]
const tickRowsOf = async (lineId: string) => (await first.query<{ actor_id: string; fulfilled: boolean }>("SELECT actor_id, (details->>'fulfilled')::boolean AS fulfilled FROM audit_log WHERE entity_id = $1 AND action = 'order_line.fulfilled_set' ORDER BY at", [lineId])).map((row) => [row.actor_id, row.fulfilled])

describe('the fulfilled tick against a refund of the same line (W48 review L2)', () => {
  it("a tick pressed while the line's order is being refunded waits for the refund on the order's row, and is then refused on what the refund committed: the line is refunded and was never marked fulfilled", async () => {
    const order = await soapOrder()
    const held = refundHoldingTheOrder()
    const refunded = outcomeOf(refund(held.db, order))
    const holder = await held.holding
    const pressed = outcomeOf(setOrderLineFulfilled(second, order.lineId, true, pressBy(tia, 'staff')))
    const waiter = await sessionBlockedBy(pg, holder)
    expect(await waitingOn(pg, waiter)).toEqual(['orders'])
    held.release()
    expect(await refunded).toMatchObject({ answered: { refundedAmount: 24 } })
    expect(await pressed).toEqual({ refused: 'line_refunded' })
    expect(await lineNow(order.lineId)).toEqual({ fulfillment_status: 'pending', refunded: true })
    expect(await tickRowsOf(order.lineId)).toEqual([])
  })

  it('control: the same statement without the order held first does not wait, and marks the line fulfilled in the middle of its refund', async () => {
    const order = await soapOrder()
    const held = refundHoldingTheOrder()
    const refunded = outcomeOf(refund(held.db, order))
    await held.holding
    // The tick's own guarded statement, alone: nothing of the line is locked yet, so it lands at once.
    const marked = await second.query<{ fulfillment_status: string }>(SET_LINE_FULFILLED_SQL, [order.lineId, 'fulfilled'])
    expect(marked.map((row) => row.fulfillment_status)).toEqual(['fulfilled'])
    held.release()
    expect(await refunded).toMatchObject({ answered: { refundedAmount: 24 } })
    // What the hold prevents: a tick that landed while the refund was under way, decided on a line the refund was about to stamp.
    expect(await lineNow(order.lineId)).toEqual({ fulfillment_status: 'fulfilled', refunded: true })
  })

  it("the other way round: a refund that starts while a tick is being saved waits for it on the order's row; the line is marked first, then refunded", async () => {
    const order = await soapOrder()
    const press = holdingAfter(second, (sql) => sql.includes('FOR SHARE OF o'))
    const pressed = outcomeOf(setOrderLineFulfilled(press.db, order.lineId, true, pressBy(tia, 'staff')))
    const holder = await press.holding
    const refunded = outcomeOf(refund(first, order))
    const waiter = await sessionBlockedBy(pg, holder)
    expect(await waitingOn(pg, waiter)).toEqual(['orders'])
    press.release()
    expect(await pressed).toMatchObject({ answered: { id: order.lineId, fulfillment_status: 'fulfilled' } })
    expect(await refunded).toMatchObject({ answered: { refundedAmount: 24 } })
    expect(await lineNow(order.lineId)).toEqual({ fulfillment_status: 'fulfilled', refunded: true })
    expect(await tickRowsOf(order.lineId)).toEqual([[tia, true]])
  })

  it('a tick pressed after the refund has stamped the line (and not yet committed) is refused too: the line row itself is re-read after the wait', async () => {
    const order = await soapOrder()
    const held = holdingAfter(first, (sql) => sql.includes('UPDATE order_line_items SET refunded_at = now()'))
    const refunded = outcomeOf(refund(held.db, order))
    const holder = await held.holding
    const pressed = outcomeOf(setOrderLineFulfilled(second, order.lineId, false, pressBy(jo)))
    await sessionBlockedBy(pg, holder)
    held.release()
    expect(await refunded).toMatchObject({ answered: { refundedAmount: 24 } })
    expect(await pressed).toEqual({ refused: 'line_refunded' })
    expect(await tickRowsOf(order.lineId)).toEqual([])
  })

  it('two ticks on one order do not wait for each other: the hold is shared', async () => {
    const order = await soapOrder()
    const other = await insert(first, 'order_line_items', { order_id: order.orderId, product_variant_id: variant, item_type: 'product', quantity: 1, unit_price: '12.00', line_total: '12.00', fulfillment_status: 'pending' })
    const press = holdingAfter(second, (sql) => sql.includes('FOR SHARE OF o'))
    const held = outcomeOf(setOrderLineFulfilled(press.db, order.lineId, true, pressBy(tia, 'staff')))
    await press.holding
    // While the first press is still open, the order's other line is ticked and its answer comes back.
    expect(await outcomeOf(setOrderLineFulfilled(first, other, true, pressBy(jo)))).toMatchObject({ answered: { id: other, fulfillment_status: 'fulfilled' } })
    press.release()
    expect(await held).toMatchObject({ answered: { fulfillment_status: 'fulfilled' } })
  })
})
