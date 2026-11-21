import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { GET as linesRoute } from '@/app/api/v1/staff/orders/[orderId]/lines/route'
import { POST as fulfilledRoute } from '@/app/api/v1/staff/orders/lines/[lineItemId]/fulfilled/route'
import { GET as listRoute } from '@/app/api/v1/staff/orders/route'
import { adminGetOrderLineItemsOutputSchema, orderLineFulfilledRouteOutputSchema, orderListRouteOutputSchema } from '@/contracts'
import type { Db } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import { ownOrderMethod } from '@/server/rules/bookings/add-guest'
import { STAFF_ADMIN_WORDS } from '@/server/rules/staff/failure-messages'
import { ADMIN_TEST_KEY, auditRowsOf, pressRoute, type AdminAnswer, type AdminRouteHandler } from '@/server/rules/testing/admin-routes'
import { fixtures, insert, startTestDatabase, type TestDatabase } from '@/server/rules/testing/database'
import {
  addonRefundSummary,
  eventCancellationSummary,
  HOLD_ORDER_OF_LINE_SQL,
  listOrderLines,
  listOrders,
  ORDER_NEEDS_ACTION_SQL,
  ORDER_PAID_BY_SQL,
  orderLineName,
  paymentMethodLabel,
  SET_LINE_FULFILLED_SQL,
  setOrderLineFulfilled,
  type OrderReader,
} from './admin'
import { ORDER_ADMIN_NEW_WORDS, ORDER_ADMIN_REASONS, ORDER_FLAG_REASONS, ORDER_PAYMENT_METHOD_LABELS } from './admin-failure-messages'

vi.setConfig({ testTimeout: 60_000 })

// Brief W53 ("Parity and tests"; G-plan 5, W53's tests): the two order reads and the fulfilled tick on the live
// schema, through the real routes. Each view (Needs action, Upcoming, Complete, All) with money owed and with a
// Payment needed booking (GB22); the filters; how each order was paid, in words (L9); every kind of line's name and
// the two summary sentences; the staff check on the reads (GB14) and their channel; every refusal of the tick with its
// words, on and off, and its audit rows. The tick's race with a line refund, on two connections, is in
// admin-postgres.test.ts; the old functions' recordings replay in testing/replay/order-admin-replay.test.ts.

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))

const JO = 'jo@example.com'
const TIA = 'tia@example.com'
const INA = 'ina@example.com'
const NOBODY = 'nobody@example.com'
const WORDS = ORDER_ADMIN_NEW_WORDS
const INACTIVE = STAFF_ADMIN_WORDS.staffAccess.staffAccountInactiveAskAdminReactivate
const NO_STAFF_ROW = STAFF_ADMIN_WORDS.staffAccess.noStaffRecordMatchesLoggedIn(NOBODY)
const UNKNOWN_ID = '10000000-0000-4000-8000-000000000f53'

let database: TestDatabase
let db: Db
let jo = ''
let tia = ''
let sam = ''
let mo = ''
let sauna = ''
let band = ''
let soap = ''
let soapVariant = ''

beforeAll(async () => {
  process.env.STAFF_API_KEY = ADMIN_TEST_KEY
  database = await startTestDatabase({ schema: 'live' })
  db = database.db
  holder.db = db
})
afterAll(() => database.stop())

/** Jo (admin), Tia (staff, no switches) and Ina (inactive); Sam and Mo; a public Sauna and its band; soap in one size. */
beforeEach(async () => {
  await database.pg.exec(
    'RESET ROLE; TRUNCATE audit_log, api_idempotency, store_credit_transactions, gift_cards, event_attendees, event_bookings, events, membership_payment_date_changes, addon_order_lines, booking_guests, order_line_items, orders, bookings, sessions, addons, product_variants, products, session_pass_types, service_types, session_bands, customer_memberships, membership_plans, customers, staff CASCADE; SET ROLE paddock_worker;'
  )
  jo = await insert(db, 'staff', { role: 'admin', first_name: 'Jo', last_name: 'Staff', email: JO, can_issue_refunds: true, can_manage_pricing: true })
  tia = await insert(db, 'staff', { role: 'staff', first_name: 'Tia', last_name: 'Team', email: TIA })
  await insert(db, 'staff', { role: 'staff', first_name: 'Ina', last_name: 'Gone', email: INA, active: false })
  sam = await fixtures.customer(db, { first_name: 'Sam', last_name: 'Test', email: 'sam@example.com' })
  mo = await fixtures.customer(db, { first_name: 'Mo', last_name: 'Member', email: 'mo@example.com' })
  sauna = await fixtures.serviceType(db, { name: 'Sauna' })
  band = await fixtures.band(db)
  soap = await insert(db, 'products', { name: 'Soap' })
  soapVariant = await insert(db, 'product_variants', { product_id: soap, size: 'Large', sku: 'SOAP-L', stock_quantity: 10 })
})

/** An order, made at a moment (each a second apart unless given), paid in cash. */
let made = 0
const order = (customer: string, row: Record<string, unknown> = {}) =>
  insert(db, 'orders', { customer_id: customer, order_total: '20.00', payment_status: 'paid', order_source: 'staff_created', payment_method: 'cash', created_at: `2027-07-01 10:00:${String(made++ % 60).padStart(2, '0')}+00`, ...row })
const line = (orderId: string, row: Record<string, unknown>) => insert(db, 'order_line_items', { order_id: orderId, quantity: 1, unit_price: '20.00', line_total: '20.00', ...row })
const productLine = (orderId: string, row: Record<string, unknown> = {}) => line(orderId, { item_type: 'product', product_variant_id: soapVariant, fulfillment_status: 'pending', unit_price: '12.00', line_total: '12.00', ...row })
/** A booking on a session of its own on `day` (a customer may hold one booking a day), with its line on `orderId`. */
async function bookingLine(orderId: string, customer: string, day: string, status = 'confirmed'): Promise<{ bookingId: string; lineId: string }> {
  const session = await fixtures.session(db, { service_type_id: sauna, band_id: band, start_time: `${day} 10:00:00+00`, end_time: `${day} 11:00:00+00` })
  const bookingId = await fixtures.booking(db, { session_id: session, customer_id: customer, party_size: 1, price_paid: '20.00', redemption_source: 'paid', status, start_time: `${day} 10:00:00+00`, end_time: `${day} 11:00:00+00` })
  return { bookingId, lineId: await line(orderId, { item_type: 'booking', booking_id: bookingId }) }
}
const FUTURE = '2099-03-10'

type Listed = Array<Record<string, unknown>>
/** A GET with a query string, as the staff app's callWorker sends one. */
async function get<T = unknown>(route: AdminRouteHandler, query: Record<string, string> = {}, params: Record<string, string> = {}, email: string | null = JO): Promise<AdminAnswer<T>> {
  const withQuery: AdminRouteHandler = (request, context) => {
    const url = new URL(request.url)
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value)
    return route(new Request(url, { method: request.method, headers: request.headers }), context)
  }
  return pressRoute<T>(withQuery, 'GET', { email, params })
}
const list = async (query: Record<string, string> = {}, email: string | null = JO) => get<Listed>(listRoute, query, {}, email)
const listed = async (query: Record<string, string> = {}) => (await list(query)).data ?? []
const linesOf = async (orderId: string, email: string | null = JO) => get<Listed>(linesRoute, {}, { orderId }, email)
const tick = (lineItemId: string, fulfilled: boolean, email: string | null = JO, key?: string) =>
  pressRoute<Record<string, unknown>>(fulfilledRoute, 'POST', { email, params: { lineItemId }, body: { fulfilled }, ...(key !== undefined ? { key } : {}) })
const refusedWith = (answer: AdminAnswer) => ({ status: answer.status, reason: answer.reason, words: answer.error?.message })
const staffReader = (): OrderReader => ({ channel: 'staff', actor: { type: 'staff', id: jo, role: 'admin', canManagePricing: true, canIssueRefunds: true } })
const customerReader = (customerId: string): OrderReader => ({ channel: 'customer', customerId })
const fulfilment = async (lineId: string) => (await db.query<{ fulfillment_status: string | null }>('SELECT fulfillment_status FROM order_line_items WHERE id = $1', [lineId]))[0]?.fulfillment_status

describe('the order list: the four views (GB22; the W35 audit\'s F1)', () => {
  /** One order of each kind the views tell apart. */
  async function sevenOrders() {
    const toHandOver = await order(sam)
    await productLine(toHandOver)
    const upcoming = await order(sam)
    await bookingLine(upcoming, sam, '2099-03-10')
    const past = await order(sam)
    await bookingLine(past, sam, '2020-03-10')
    const needsPayment = await order(mo)
    await bookingLine(needsPayment, mo, '2099-03-11', 'payment_needed')
    const owed = await order(mo, { refund_owed_amount: '24.00', payment_status: 'partially_refunded' })
    await productLine(owed, { fulfillment_status: 'fulfilled', refunded_at: '2027-07-01 12:00:00+00', refund_method: 'card' })
    const upcomingAndOwed = await order(sam, { refund_owed_amount: '5.00' })
    await bookingLine(upcomingAndOwed, sam, '2099-03-12')
    const needsPaymentLongAgo = await order(mo)
    await bookingLine(needsPaymentLongAgo, mo, '2020-03-12', 'payment_needed')
    return { toHandOver, upcoming, past, needsPayment, owed, upcomingAndOwed, needsPaymentLongAgo }
  }
  const statuses = (rows: Listed) => Object.fromEntries(rows.map((row) => [row['id'], row['computed_status']]))

  it('All: every order with its worked-out status. A Payment needed booking and money owed are Needs action, and each wins over Upcoming', async () => {
    const made = await sevenOrders()
    expect(statuses(await listed({ view: 'all' }))).toEqual({
      [made.toHandOver]: 'needs_action',
      [made.upcoming]: 'upcoming',
      [made.past]: 'complete',
      // GB22: the old read called this one Complete (its booking is neither confirmed nor pending).
      [made.needsPayment]: 'needs_action',
      [made.owed]: 'needs_action',
      [made.upcomingAndOwed]: 'needs_action',
      // GB22 whatever the session's date: the booking still has to be paid for or cancelled.
      [made.needsPaymentLongAgo]: 'needs_action',
    })
  })

  it('Needs action is the first view (no view asked for, or any word that is not one), and lists exactly those five', async () => {
    const made = await sevenOrders()
    const five = [made.toHandOver, made.needsPayment, made.owed, made.upcomingAndOwed, made.needsPaymentLongAgo].sort()
    const asked: Array<Record<string, string>> = [{}, { view: 'needs_action' }, { view: 'anything else' }]
    for (const query of asked) {
      const rows = await listed(query)
      expect(rows.map((row) => String(row['id'])).sort(), JSON.stringify(query)).toEqual(five)
      expect(rows.every((row) => row['computed_status'] === 'needs_action')).toBe(true)
    }
  })

  it('Upcoming lists only the order with a booking still to come and nothing to do; Complete only the one whose session has passed', async () => {
    const made = await sevenOrders()
    expect(statuses(await listed({ view: 'upcoming' }))).toEqual({ [made.upcoming]: 'upcoming' })
    expect(statuses(await listed({ view: 'complete' }))).toEqual({ [made.past]: 'complete' })
  })

  it('an order leaves Needs action when its booking is paid for (confirmed again) or cancelled, and when the money owed is cleared', async () => {
    const made = await sevenOrders()
    await db.query("UPDATE bookings SET status = 'confirmed' WHERE id = (SELECT booking_id FROM order_line_items WHERE order_id = $1)", [made.needsPayment])
    await db.query("UPDATE bookings SET status = 'cancelled' WHERE id = (SELECT booking_id FROM order_line_items WHERE order_id = $1)", [made.needsPaymentLongAgo])
    await db.query("UPDATE orders SET refund_owed_amount = 0 WHERE id = ANY($1::uuid[])", [[made.owed, made.upcomingAndOwed]])
    const all = statuses(await listed({ view: 'all' }))
    expect(all[made.needsPayment]).toBe('upcoming')
    expect(all[made.needsPaymentLongAgo]).toBe('complete')
    expect(all[made.owed]).toBe('complete')
    expect(all[made.upcomingAndOwed]).toBe('upcoming')
  })

  it('GB22 is the booking line\'s own booking: a Payment needed booking on another order doesn\'t move this one', async () => {
    const mine = await order(sam)
    await bookingLine(mine, sam, FUTURE)
    const theirs = await order(mo)
    await bookingLine(theirs, mo, '2099-03-11', 'payment_needed')
    expect(statuses(await listed({ view: 'all' }))).toEqual({ [mine]: 'upcoming', [theirs]: 'needs_action' })
  })

  it('the three parts of Needs action are each in the one condition both the status and the views use', () => {
    expect(ORDER_NEEDS_ACTION_SQL).toContain('o.refund_owed_amount > 0')
    expect(ORDER_NEEDS_ACTION_SQL).toContain("bk.status = 'payment_needed'")
    expect(ORDER_NEEDS_ACTION_SQL).toContain("oli.item_type = 'product' AND oli.fulfillment_status = 'pending'")
    expect(ORDER_NEEDS_ACTION_SQL).toContain("gc.fulfillment_method = 'pickup' AND gc.picked_up IS NOT TRUE")
    expect(ORDER_NEEDS_ACTION_SQL).toContain("gc.fulfillment_method = 'shipping' AND gc.shipped_at IS NULL")
  })

  it('a gift card still to collect or post is Needs action; a refunded product or gift card line is not', async () => {
    const card = async (row: Record<string, unknown>) => insert(db, 'gift_cards', { code: `GC-${crypto.randomUUID().slice(0, 8)}`, type: 'monetary', original_value: '25.00', remaining_balance: '25.00', origin: 'customer_purchase', expiry_date: '2099-01-01', ...row })
    const pickup = await order(sam)
    await line(pickup, { item_type: 'gift_card', gift_card_id: await card({ fulfillment_method: 'pickup' }) })
    const posted = await order(sam)
    await line(posted, { item_type: 'gift_card', gift_card_id: await card({ fulfillment_method: 'shipping', shipped_at: '2027-07-02 09:00:00+00' }) })
    const digital = await order(sam)
    await line(digital, { item_type: 'gift_card', gift_card_id: await card({ fulfillment_method: 'digital' }) })
    const refunded = await order(sam)
    await productLine(refunded, { refunded_at: '2027-07-02 09:00:00+00', refund_method: 'credit' })
    expect(statuses(await listed({ view: 'all' }))).toEqual({ [pickup]: 'needs_action', [posted]: 'complete', [digital]: 'complete', [refunded]: 'complete' })
  })
})

describe('the order list: its fields and filters', () => {
  it('answers every field by name, the money as the database\'s text, and passes its own contract', async () => {
    const id = await order(sam, { order_total: '24.50', discount_amount: '2.50', promo_code: 'TEN', shipping_address: JSON.stringify({ name: 'Sam Test', line1: '1 Mill Lane', line2: null, city: 'Hebden Bridge', postcode: 'HX7 1AA', country: 'United Kingdom' }), refund_owed_amount: '3.00' })
    const answer = await list({ view: 'all' })
    expect(answer.status).toBe(200)
    expect(orderListRouteOutputSchema.safeParse(answer.data).success).toBe(true)
    expect(answer.data).toEqual([
      {
        id,
        customer_id: sam,
        order_total: '24.50',
        payment_status: 'paid',
        stripe_payment_intent_id: null,
        promo_code: 'TEN',
        discount_amount: '2.50',
        shipping_address: { name: 'Sam Test', line1: '1 Mill Lane', line2: null, city: 'Hebden Bridge', postcode: 'HX7 1AA', country: 'United Kingdom' },
        shipping_status: null,
        tracking_number: null,
        order_source: 'staff_created',
        created_at: expect.stringMatching(/^2027-07-01T10:00:\d\d\.000Z$/),
        updated_at: expect.stringMatching(/Z$/),
        payment_method: 'cash',
        reader_payment: null,
        refund_owed_amount: '3.00',
        customer_first_name: 'Sam',
        customer_last_name: 'Test',
        customer_email: 'sam@example.com',
        computed_status: 'needs_action',
        payment_method_label: 'Cash',
      },
    ])
  })

  it('newest first; a date range by the day the order was made (both ends included, read as UTC whatever the connection\'s zone); a date that is not one is refused', async () => {
    const june30 = await order(sam, { created_at: '2027-06-30 23:59:59+00' })
    const july1Early = await order(sam, { created_at: '2027-07-01 00:00:00+00' })
    const july1Late = await order(mo, { created_at: '2027-07-01 23:59:59+00' })
    const july2 = await order(mo, { created_at: '2027-07-02 00:00:00+00' })
    const ids = async (query: Record<string, string>) => (await listed({ view: 'all', ...query })).map((row) => row['id'])
    expect(await ids({})).toEqual([july2, july1Late, july1Early, june30])
    expect(await ids({ startDate: '2027-07-01', endDate: '2027-07-01' })).toEqual([july1Late, july1Early])
    expect(await ids({ startDate: '2027-07-01' })).toEqual([july2, july1Late, july1Early])
    expect(await ids({ endDate: '2027-06-30' })).toEqual([june30])
    // The day's ends don't move with the connection's time zone (the old read cast the date in that zone).
    await db.transaction(async (tx) => {
      await tx.query("SET LOCAL TIME ZONE 'America/New_York'")
      const rows = await listOrders(tx, { view: 'all', startDate: '2027-07-01', endDate: '2027-07-01' }, staffReader())
      expect(rows.map((row) => row.id)).toEqual([july1Late, july1Early])
    })
    expect((await list({ startDate: 'yesterday' })).status).toBe(400)
  })

  it('by payment status, by source, and by a search of the customer\'s first name, last name or email (any case), each alone and together', async () => {
    const samPaid = await order(sam)
    const samOnline = await order(sam, { order_source: 'online', payment_status: 'refunded' })
    const moPaid = await order(mo)
    const ids = async (query: Record<string, string>) => (await listed({ view: 'all', ...query })).map((row) => row['id']).sort()
    expect(await ids({ paymentStatus: 'refunded' })).toEqual([samOnline])
    expect(await ids({ orderSource: 'online' })).toEqual([samOnline])
    expect(await ids({ search: 'SAM' })).toEqual([samPaid, samOnline].sort())
    expect(await ids({ search: 'member' })).toEqual([moPaid])
    expect(await ids({ search: 'mo@example' })).toEqual([moPaid])
    expect(await ids({ search: 'nobody' })).toEqual([])
    expect(await ids({ search: 'test', paymentStatus: 'paid', orderSource: 'staff_created', startDate: '2027-07-01', endDate: '2027-07-01' })).toEqual([samPaid])
  })

  it('GB14: an inactive account, a sign-in with no staff row and no sign-in at all are refused both reads, in the words every staff route gives; any active staff member may read', async () => {
    const id = await order(sam)
    await productLine(id)
    for (const read of [() => list({ view: 'all' }, INA), () => linesOf(id, INA)]) expect(refusedWith(await read())).toMatchObject({ status: 403, words: INACTIVE })
    for (const read of [() => list({ view: 'all' }, NOBODY), () => linesOf(id, NOBODY)]) expect(refusedWith(await read())).toMatchObject({ status: 401, words: NO_STAFF_ROW })
    for (const read of [() => list({ view: 'all' }, null), () => linesOf(id, null)]) expect((await read()).ok).toBe(false)
    expect((await list({ view: 'all' }, TIA)).data).toHaveLength(1)
    expect((await linesOf(id, TIA)).data).toHaveLength(1)
  })

  it('the customer channel (the website, later) is only ever shown its own orders and their lines', async () => {
    const mine = await order(sam)
    await productLine(mine)
    const theirs = await order(mo)
    await productLine(theirs)
    expect((await listOrders(db, { view: 'all' }, customerReader(sam))).map((row) => row.id)).toEqual([mine])
    expect(await listOrderLines(db, mine, customerReader(sam))).toHaveLength(1)
    expect(await listOrderLines(db, theirs, customerReader(sam))).toEqual([])
    expect(await listOrderLines(db, theirs, staffReader())).toHaveLength(1)
  })
})

describe('how an order was paid, in words (lead call L9)', () => {
  it.each(Object.entries({ card: 'Card', reader: 'Card reader', cash: 'Cash', gift_card: 'Gift card', store_credit: 'Store credit', split: 'Split payment' }))('an order that recorded %s reads "%s"', async (method, label) => {
    const id = await order(sam, { payment_method: method })
    expect((await listed({ view: 'all' })).find((row) => row['id'] === id)).toMatchObject({ payment_method: method, payment_method_label: label })
  })

  it('an order with no method recorded reads "Store credit" when store credit paid for it (an Add Guest order from before W53), "Nothing to pay" when it cost nothing, and nothing otherwise', async () => {
    const storeCredit = await order(sam, { payment_method: null })
    await insert(db, 'store_credit_transactions', { customer_id: sam, amount: '-20.00', balance_after: '0.00', reason: 'redemption', order_id: storeCredit })
    const free = await order(sam, { payment_method: null, order_total: '0.00' })
    const allDiscount = await order(sam, { payment_method: null, order_total: '10.00', discount_amount: '10.00' })
    const unknown = await order(sam, { payment_method: null })
    // Store credit taken and then put back (an undone press): nothing says store credit paid for it.
    const reversed = await order(sam, { payment_method: null })
    await insert(db, 'store_credit_transactions', { customer_id: sam, amount: '-20.00', balance_after: '0.00', reason: 'redemption', order_id: reversed })
    await insert(db, 'store_credit_transactions', { customer_id: sam, amount: '20.00', balance_after: '20.00', reason: 'redemption_reversal', order_id: reversed })
    // A refund to store credit on an order isn't what paid for it.
    const refundedTo = await order(sam, { payment_method: null })
    await insert(db, 'store_credit_transactions', { customer_id: sam, amount: '20.00', balance_after: '40.00', reason: 'refund', order_id: refundedTo })
    const labels = Object.fromEntries((await listed({ view: 'all' })).map((row) => [row['id'], row['payment_method_label']]))
    expect(labels).toEqual({ [storeCredit]: 'Store credit', [free]: 'Nothing to pay', [allDiscount]: 'Nothing to pay', [unknown]: null, [reversed]: null, [refundedTo]: null })
  })

  it('the words are one for each method the database allows, and the list works the method out in one place', () => {
    expect(ORDER_PAYMENT_METHOD_LABELS).toEqual({ card: 'Card', reader: 'Card reader', cash: 'Cash', gift_card: 'Gift card', store_credit: 'Store credit', split: 'Split payment', nothingToPay: 'Nothing to pay' })
    expect(paymentMethodLabel(null)).toBeNull()
    expect(paymentMethodLabel('nothing_to_pay')).toBe('Nothing to pay')
    expect(paymentMethodLabel('store_credit')).toBe('Store credit')
    expect(ORDER_PAID_BY_SQL).toContain("sct.reason IN ('redemption', 'redemption_reversal')")
    expect(ORDER_PAID_BY_SQL).toContain("THEN 'store_credit'")
  })

  it("L9 at the source: Add Guest's own order records store_credit for store credit alone, and its other methods as before", () => {
    // (gift card, the rest to collect, the method, store credit)
    expect(ownOrderMethod(0, 0, undefined, 20)).toBe('store_credit')
    expect(ownOrderMethod(0, 0, 'cash', 20)).toBe('store_credit')
    expect(ownOrderMethod(0, 20, 'cash', 0)).toBe('cash')
    expect(ownOrderMethod(0, 15, 'cash', 5)).toBe('cash')
    expect(ownOrderMethod(20, 0, undefined, 0)).toBe('gift_card')
    expect(ownOrderMethod(10, 10, 'cash', 0)).toBe('split')
    // Nothing took anything: no method, as before.
    expect(ownOrderMethod(0, 0, undefined, 0)).toBeNull()
  })
})

describe("an order's lines", () => {
  it("every kind of line has its name: a seat, a product with and without a size, a membership, a payment date change, a pass, a gift card, an add-on, postage, an event with its time and places, and each kind's fallback", () => {
    const base = { service_type_name: null, product_name: null, product_variant_size: null, payment_date_change_extra_days: null, membership_plan_name: null, session_pass_type_name: null, gift_card_code: null, addon_name: null, event_starts_at: null, event_name: null, quantity: 1 }
    const name = (row: Record<string, unknown>) => orderLineName({ ...base, ...row } as Parameters<typeof orderLineName>[0])
    expect(name({ item_type: 'booking', service_type_name: 'Sauna' })).toBe('Session: Sauna')
    expect(name({ item_type: 'booking' })).toBe('Session Booking')
    expect(name({ item_type: 'product', product_name: 'Soap', product_variant_size: 'Large' })).toBe('Soap (Large)')
    expect(name({ item_type: 'product', product_name: 'Soap' })).toBe('Soap')
    expect(name({ item_type: 'product' })).toBe('Product')
    expect(name({ item_type: 'membership', membership_plan_name: 'Core' })).toBe('Core')
    expect(name({ item_type: 'membership' })).toBe('Membership Plan')
    expect(name({ item_type: 'membership', membership_plan_name: 'Core', payment_date_change_extra_days: 1 })).toBe('Payment date change: 1 extra day')
    expect(name({ item_type: 'membership', payment_date_change_extra_days: 4 })).toBe('Payment date change: 4 extra days')
    expect(name({ item_type: 'session_pass', session_pass_type_name: '10 sessions' })).toBe('10 sessions')
    expect(name({ item_type: 'session_pass' })).toBe('Session Pass')
    expect(name({ item_type: 'gift_card', gift_card_code: 'ABCD-1234' })).toBe('Gift Card (ABCD-1234)')
    expect(name({ item_type: 'gift_card' })).toBe('Gift Card')
    expect(name({ item_type: 'addon', addon_name: 'Towel' })).toBe('Towel')
    expect(name({ item_type: 'addon' })).toBe('Add-on')
    expect(name({ item_type: 'postage' })).toBe('Postage')
    // An event's time is its stored digits (London's wall clock), never moved by a time zone.
    expect(name({ item_type: 'event', event_name: 'Solstice', event_starts_at: '2027-06-21T18:30:00.000Z', quantity: 2 })).toMatch(/^Solstice · 21 Jun 2027, 6:30\spm · 2 places$/)
    expect(name({ item_type: 'event', event_name: 'Solstice', quantity: 1 })).toBe('Solstice · 1 place')
    expect(name({ item_type: 'event', quantity: 3 })).toBe('Event · 3 places')
    expect(name({ item_type: 'something new' })).toBe('Item')
  })

  it("a booking line's removed add-ons, as one sentence", () => {
    const say = (removed: number | null, refunded: string | null, card: string | null, credits: number | null) =>
      addonRefundSummary({ addon_removed_count: removed, addon_refunded: refunded, addon_card_refunded: card, addon_credits_returned: credits })
    expect(say(0, '0', '0', 0)).toBeNull()
    expect(say(null, null, null, null)).toBeNull()
    expect(say(1, '5.00', '5.00', 0)).toBe('1 add-on removed · £5.00 refunded (£5.00 card)')
    expect(say(2, '9.00', '5.00', 0)).toBe('2 add-ons removed · £9.00 refunded (£5.00 card, £4.00 store credit)')
    expect(say(1, '5.00', '0', 0)).toBe('1 add-on removed · £5.00 refunded (£5.00 store credit)')
    expect(say(1, '0', '0', 1)).toBe('1 add-on removed · 1 add-on credit returned')
    expect(say(3, '5.00', '5.00', 2)).toBe('3 add-ons removed · £5.00 refunded (£5.00 card) · 2 add-on credits returned')
    expect(say(1, '0', '0', 0)).toBe('1 add-on removed · no refund')
  })

  it("an event line's cancelled places, as one sentence", () => {
    const place = (cancelled: boolean, refunded = '0', card = '0') => ({ attendee_type: 'guest' as const, name: 'G', price_level: 'public' as const, unit_price: '40.00', cancelled_at: cancelled ? '2027-06-01T10:00:00Z' : null, refunded_amount: refunded, card_refunded_amount: card, refund_method: null })
    const say = (places: ReturnType<typeof place>[] | null, eventCancelledAt: string | null = null) => eventCancellationSummary({ event_attendees: places, event_cancelled_at: eventCancelledAt })
    expect(say([place(false), place(false)])).toBeNull()
    expect(say(null)).toBeNull()
    expect(say([place(true, '40.00', '25.00'), place(true, '0', '0'), place(false)])).toBe('2 of 3 places cancelled · £40.00 refunded (£25.00 card, £15.00 store credit)')
    expect(say([place(true, '40.00', '40.00')])).toBe('Place cancelled · £40.00 refunded (£40.00 card)')
    expect(say([place(true), place(true)])).toBe('All 2 places cancelled · no refund')
    expect(say([place(true, '40.00', '0'), place(true, '40.00', '0')], '2027-06-01T10:00:00Z')).toBe('Event cancelled · All 2 places cancelled · £80.00 refunded (£80.00 store credit)')
    expect(say([place(false)], '2027-06-01T10:00:00Z')).toBe('Event cancelled · 0 of 1 places cancelled')
  })

  it('through the route: a seat with a removed towel, soap, a plan, a payment date change, a pass, a gift card, an add-on, postage and an event, each with what it sold, oldest first; the answer passes its contract', async () => {
    const id = await order(sam, { order_total: '300.00' })
    const at = (n: number) => `2027-07-01 10:01:${String(n).padStart(2, '0')}+00`
    const seat = await bookingLine(id, sam, FUTURE)
    await db.query('UPDATE order_line_items SET created_at = $1::timestamptz WHERE id = $2', [at(0), seat.lineId])
    const towel = await insert(db, 'addons', { name: 'Towel', base_price: '5.00', sku: 'TOWEL' })
    await insert(db, 'addon_order_lines', { booking_id: seat.bookingId, addon_id: towel, quantity: 1, price_at_purchase: '5.00', sku_at_purchase: 'TOWEL', redemption_source: 'paid', order_id: id, removed_at: at(30), refunded_amount: '5.00', card_refunded_amount: '5.00', refund_method: 'card' })
    await productLine(id, { created_at: at(1), system_unit_price: '12.00', discount_amount: '1.20' })
    const plan = await fixtures.plan(db, { name: 'Core' })
    await line(id, { item_type: 'membership', membership_plan_id: plan, created_at: at(2) })
    const passType = await fixtures.passType(db, { name: '10 sessions' })
    await line(id, { item_type: 'session_pass', session_pass_type_id: passType, created_at: at(3) })
    const giftCard = await insert(db, 'gift_cards', { code: 'ABCD-1234', type: 'monetary', original_value: '25.00', remaining_balance: '25.00', origin: 'customer_purchase', expiry_date: '2099-01-01', fulfillment_method: 'pickup' })
    await line(id, { item_type: 'gift_card', gift_card_id: giftCard, created_at: at(4) })
    await line(id, { item_type: 'addon', addon_id: towel, created_at: at(5) })
    await line(id, { item_type: 'postage', created_at: at(6), unit_price: '4.95', line_total: '4.95' })
    const event = await fixtures.event(db, { name: 'Solstice', starts_at: '2099-06-21 18:30:00+00', ends_at: '2099-06-21 20:00:00+00', refund_cutoff_at: '2099-06-20 18:30:00+00' })
    const eventBooking = await insert(db, 'event_bookings', { event_id: event, customer_id: sam, places: 1, price_paid: '40.00' })
    await insert(db, 'event_attendees', { event_booking_id: eventBooking, attendee_type: 'account_holder', name: 'Sam Test', unit_price: '40.00', price_level: 'public', created_at: at(7) })
    await insert(db, 'event_attendees', { event_booking_id: eventBooking, attendee_type: 'guest', name: 'Alex Guest', unit_price: '40.00', price_level: 'public', created_at: at(8), cancelled_at: at(40), cancelled_value: '40.00', refunded_amount: '40.00', card_refunded_amount: '25.00', refund_method: 'card' })
    await line(id, { item_type: 'event', event_booking_id: eventBooking, quantity: 2, unit_price: '40.00', line_total: '80.00', created_at: at(9) })

    const answer = await linesOf(id)
    expect(answer.status).toBe(200)
    expect(adminGetOrderLineItemsOutputSchema.safeParse(answer.data).success).toBe(true)
    const rows = answer.data ?? []
    expect(rows.map((row) => [row['item_type'], row['item_name']])).toEqual([
      ['booking', 'Session: Sauna'],
      ['product', 'Soap (Large)'],
      ['membership', 'Core'],
      ['session_pass', '10 sessions'],
      ['gift_card', 'Gift Card (ABCD-1234)'],
      ['addon', 'Towel'],
      ['postage', 'Postage'],
      ['event', expect.stringMatching(/^Solstice · 21 Jun 2099, 6:30\spm · 2 places$/)],
    ])
    expect(rows[0]).toMatchObject({ addon_refund_summary: '1 add-on removed · £5.00 refunded (£5.00 card)', event_cancellation_summary: null, booking_id: seat.bookingId })
    expect(rows[1]).toMatchObject({ product_name: 'Soap', product_variant_size: 'Large', fulfillment_status: 'pending', system_unit_price: '12.00', discount_amount: '1.20', unit_price: '12.00', line_total: '12.00', addon_refund_summary: null })
    expect(rows[4]).toMatchObject({ gift_card_code: 'ABCD-1234', gift_card_fulfillment_method: 'pickup', gift_card_picked_up: false, gift_card_shipped_at: null })
    expect(rows[7]).toMatchObject({ event_name: 'Solstice', event_cancelled_at: null, event_cancellation_summary: '1 of 2 places cancelled · £40.00 refunded (£25.00 card, £15.00 store credit)' })
    expect((rows[7]?.['event_attendees'] as Array<{ name: string }>).map((place) => place.name)).toEqual(['Sam Test', 'Alex Guest'])
    // The four working columns the old function spread into its answer are not answered (no screen's type has them).
    for (const row of rows) for (const column of ['addon_removed_count', 'addon_refunded', 'addon_card_refunded', 'addon_credits_returned']) expect(column in row, column).toBe(false)
  })

  it('a membership line on a payment date change\'s own order is named by its extra days; an id that names no order, or is not an id, answers no lines', async () => {
    const plan = await fixtures.plan(db, { name: 'Core' })
    const membership = await fixtures.membership(db, { customer_id: sam, plan_id: plan })
    const id = await order(sam, { order_total: '5.20', payment_method: 'card' })
    await line(id, { item_type: 'membership', membership_plan_id: plan, unit_price: '5.20', line_total: '5.20' })
    await insert(db, 'membership_payment_date_changes', { membership_id: membership, old_renewal_date: '2027-07-01', new_renewal_date: '2027-07-05', extra_days: 4, amount_charged: '5.20', order_id: id, status: 'done' })
    expect((await linesOf(id)).data).toMatchObject([{ item_name: 'Payment date change: 4 extra days', payment_date_change_extra_days: 4, membership_plan_name: 'Core' }])
    expect((await linesOf(UNKNOWN_ID)).data).toEqual([])
    expect((await linesOf('not-an-id')).data).toEqual([])
  })
})

describe('the fulfilled tick', () => {
  it('on and back: the line is marked, the answer is its row by named columns (and passes its contract), and each press has its audit row with who, the order, the state and which way', async () => {
    const id = await order(sam)
    const lineId = await productLine(id)
    const on = await tick(lineId, true)
    expect(on.status).toBe(200)
    expect(orderLineFulfilledRouteOutputSchema.safeParse(on.data).success).toBe(true)
    expect(on.data).toMatchObject({ id: lineId, order_id: id, item_type: 'product', fulfillment_status: 'fulfilled', unit_price: '12.00', line_total: '12.00', refunded_at: null, product_variant_id: soapVariant })
    expect(Object.keys(on.data ?? {}).sort()).toEqual(
      ['addon_id', 'booking_id', 'card_refunded_amount', 'created_at', 'discount_amount', 'event_booking_id', 'fulfillment_status', 'gift_card_id', 'id', 'item_type', 'line_total', 'membership_plan_id', 'order_id', 'price_override_reason', 'product_variant_id', 'quantity', 'refund_method', 'refunded_at', 'restocked', 'session_pass_type_id', 'system_unit_price', 'unit_price']
    )
    expect(await fulfilment(lineId)).toBe('fulfilled')
    const off = await tick(lineId, false, TIA)
    expect(off.data).toMatchObject({ id: lineId, fulfillment_status: 'pending' })
    expect(await fulfilment(lineId)).toBe('pending')
    const rows = await auditRowsOf(db)
    expect(rows.map((row) => [row.action, row.actor_type, row.actor_id, row.entity_type, row.entity_id, row.details['fulfilled'], row.details.after])).toEqual([
      ['order_line.fulfilled_set', 'staff', jo, 'order_line_item', lineId, true, { order_id: id, fulfillment_status: 'fulfilled' }],
      // Any active staff member may press it: Tia has neither switch.
      ['order_line.fulfilled_set', 'staff', tia, 'order_line_item', lineId, false, { order_id: id, fulfillment_status: 'pending' }],
    ])
    expect(rows.every((row) => typeof row.details.key === 'string' && row.details.key !== '' && typeof row.request_id === 'string')).toBe(true)
  })

  it('pressed again it stays as it is, and the press is still recorded; the same key again runs nothing more', async () => {
    const lineId = await productLine(await order(sam))
    expect((await tick(lineId, true)).status).toBe(200)
    expect((await tick(lineId, true)).data).toMatchObject({ fulfillment_status: 'fulfilled' })
    const key = crypto.randomUUID()
    expect((await tick(lineId, false, JO, key)).replayed).toBe(false)
    const again = await tick(lineId, false, JO, key)
    expect(again.replayed).toBe(true)
    expect(again.data).toMatchObject({ fulfillment_status: 'pending' })
    expect((await auditRowsOf(db)).map((row) => row.details['fulfilled'])).toEqual([true, true, false])
  })

  it.each([
    ['fulfilled', true],
    ['not fulfilled', false],
  ] as const)('refused either way (%s): a line that is not there, one that is not a product, one with nothing to hand over, a refunded one, and one whose order\'s payment failed; nothing is changed and no audit row is written', async (_way, fulfilled) => {
    const paid = await order(sam)
    const seat = (await bookingLine(paid, sam, FUTURE)).lineId
    const postage = await line(paid, { item_type: 'postage' })
    const noState = await productLine(paid, { fulfillment_status: null })
    const refunded = await productLine(paid, { fulfillment_status: fulfilled ? 'pending' : 'fulfilled', refunded_at: '2027-07-02 09:00:00+00', refund_method: 'card' })
    const failed = await order(sam, { payment_status: 'failed' })
    const onFailed = await productLine(failed, { fulfillment_status: fulfilled ? 'pending' : 'fulfilled' })
    const before = await db.query('SELECT id, fulfillment_status FROM order_line_items ORDER BY id')

    expect(refusedWith(await tick(UNKNOWN_ID, fulfilled))).toEqual({ status: 404, reason: 'not_found', words: WORDS.lineNotFound })
    expect(refusedWith(await tick('not-an-id', fulfilled))).toEqual({ status: 404, reason: 'not_found', words: WORDS.lineNotFound })
    expect(refusedWith(await tick(seat, fulfilled))).toEqual({ status: 400, reason: 'not_a_product_line', words: WORDS.notAProductLine })
    expect(refusedWith(await tick(postage, fulfilled))).toEqual({ status: 400, reason: 'not_a_product_line', words: WORDS.notAProductLine })
    expect(refusedWith(await tick(noState, fulfilled))).toEqual({ status: 409, reason: 'nothing_to_fulfil', words: WORDS.nothingToFulfil })
    expect(refusedWith(await tick(refunded, fulfilled))).toEqual({ status: 409, reason: 'line_refunded', words: WORDS.lineRefunded })
    expect(refusedWith(await tick(onFailed, fulfilled))).toEqual({ status: 409, reason: 'order_cancelled', words: WORDS.orderCancelled })

    expect(await db.query('SELECT id, fulfillment_status FROM order_line_items ORDER BY id')).toEqual(before)
    expect(await auditRowsOf(db)).toEqual([])
  })

  it('an order still being paid, a part refunded one and a refunded one whose product line is not itself refunded can all be ticked', async () => {
    for (const status of ['pending', 'partially_refunded', 'refunded']) {
      const lineId = await productLine(await order(sam, { payment_status: status }))
      expect((await tick(lineId, true)).data, status).toMatchObject({ fulfillment_status: 'fulfilled' })
    }
  })

  it('an inactive account and a sign-in with no staff row are refused before anything is read; a press with no key is refused', async () => {
    const lineId = await productLine(await order(sam))
    expect(refusedWith(await tick(lineId, true, INA))).toMatchObject({ status: 403, words: INACTIVE })
    expect(refusedWith(await tick(lineId, true, NOBODY))).toMatchObject({ status: 401, words: NO_STAFF_ROW })
    expect((await pressRoute(fulfilledRoute, 'POST', { email: JO, params: { lineItemId: lineId }, body: { fulfilled: true }, key: null })).ok).toBe(false)
    expect(await fulfilment(lineId)).toBe('pending')
    expect(await auditRowsOf(db)).toEqual([])
  })

  it('the customer channel can never set it', async () => {
    const lineId = await productLine(await order(sam))
    const asCustomer = { actor: { type: 'customer', id: sam } as never, requestId: 'r', pressKey: 'k'.repeat(20) }
    await expect(setOrderLineFulfilled(db, lineId, true, asCustomer)).rejects.toBeInstanceOf(ApiError)
    expect(await fulfilment(lineId)).toBe('pending')
  })

  it('the guard is the statement itself, and the order is held first with a lock a refund waits for', () => {
    expect(SET_LINE_FULFILLED_SQL).toContain("oli.item_type = 'product'")
    expect(SET_LINE_FULFILLED_SQL).toContain('oli.fulfillment_status IS NOT NULL')
    expect(SET_LINE_FULFILLED_SQL).toContain('oli.refunded_at IS NULL')
    expect(SET_LINE_FULFILLED_SQL).toContain("o.payment_status <> 'failed'")
    expect(SET_LINE_FULFILLED_SQL).not.toMatch(/RETURNING\s+\*/)
    expect(HOLD_ORDER_OF_LINE_SQL).toMatch(/FOR SHARE OF o$/)
  })
})

describe('the words', () => {
  it("the tick's refusals, each as staff read it", () => {
    expect(WORDS).toEqual({
      lineNotFound: 'That line is no longer on the order. Reload the page and try again.',
      notAProductLine: "Only a product can be marked fulfilled. This line isn't one.",
      nothingToFulfil: "This line has nothing to hand over, so it can't be marked fulfilled or not fulfilled.",
      lineRefunded: "This line has been refunded, so it can't be marked fulfilled or not fulfilled.",
      orderCancelled: "This order's payment failed, so its items can't be marked fulfilled or not fulfilled.",
      lineChanged: 'The order changed while this was being saved, so nothing was changed. Reload the page and try again.',
    })
  })

  it("the old function's two reasons are kept, and the new ones are listed beside them", () => {
    expect(ORDER_ADMIN_REASONS.setOrderLineItemFulfilled).toEqual(['not_found', 'not_a_product_line'])
    expect(ORDER_FLAG_REASONS).toEqual({ old: ['not_found', 'not_a_product_line'], refused: ['nothing_to_fulfil', 'line_refunded', 'order_cancelled', 'line_changed'] })
  })
})
