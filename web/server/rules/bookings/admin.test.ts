import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST as preparedRoute } from '@/app/api/v1/staff/bookings/addon-lines/[lineId]/prepared/route'
import { GET as addonPrepRoute } from '@/app/api/v1/staff/bookings/addon-prep/route'
import { POST as checkInRoute } from '@/app/api/v1/staff/bookings/[bookingId]/check-in/route'
import { GET as detailRoute } from '@/app/api/v1/staff/bookings/[bookingId]/detail/route'
import { GET as bookingRoute } from '@/app/api/v1/staff/bookings/[bookingId]/route'
import { POST as waiverRoute } from '@/app/api/v1/staff/bookings/guests/[guestId]/waiver/route'
import { GET as listRoute } from '@/app/api/v1/staff/bookings/route'
import { GET as waiverGapsRoute } from '@/app/api/v1/staff/bookings/waiver-gaps/route'
import { GET as attentionRoute } from '@/app/api/v1/staff/overview/payment-attention/route'
import { adminGetBookingDetailOutputSchema, adminGetBookingsOutputSchema, adminGetPaymentAttentionItemsOutputSchema } from '@/contracts'
import type { Db, Queryable, SqlParam, Tx } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import { FLAG_CHANNEL_NOT_ACCEPTED_MESSAGE } from '@/server/rules/admin/flag'
import type { AdminActor } from '@/server/rules/admin/refusal'
import { STAFF_ADMIN_WORDS } from '@/server/rules/staff/failure-messages'
import { ADMIN_TEST_KEY, auditRowsOf, pressRoute, type AdminAnswer, type AdminRouteHandler } from '@/server/rules/testing/admin-routes'
import { fixtures, insert, startTestDatabase, type TestDatabase } from '@/server/rules/testing/database'
import { staffAppDir } from '@/server/rules/testing/staff-app-dir'
import { WAIVER_METHODS } from '@/server/rules/waivers/methods'
import { listPaymentAttention } from '@/server/rules/orders/admin'
import { addonLinesOfBookings, getBookingDetail, getBookingRow, guestsOfBookings, listAddonPrep, listBookings, listWaiverGaps, setGuestWaiver, type BookingReader } from './admin'
import { BOOKING_ADMIN_NEW_WORDS, BOOKING_ADMIN_WORDS, BOOKING_FLAG_REASONS } from './admin-failure-messages'
import { CARD_PAYMENT_OPEN_MESSAGE, READER_PAYMENT_OPEN_MESSAGE } from './failure-messages'

vi.setConfig({ testTimeout: 60_000 })

// Brief W50 ("Parity and tests"; G-plan 5, W50's tests): the six reads and the three flags on the live schema, through
// the real routes. Each read's fields, its range by London day, its staff check (GB14) and its channel; every refusal
// of each flag with its words (GB17, Q49), a cancelled and a Payment needed booking on each flag, on and off, a
// removed add-on line, the audit rows, and the customer channel's waiver rule. The races with a cancel, on two
// connections, are in admin-postgres.test.ts; the old functions' recordings replay in
// testing/replay/booking-admin-replay.test.ts.

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))

const JO = 'jo@example.com'
const TIA = 'tia@example.com'
const INA = 'ina@example.com'
const NOBODY = 'nobody@example.com'
const WORDS = BOOKING_ADMIN_NEW_WORDS
const INACTIVE = STAFF_ADMIN_WORDS.staffAccess.staffAccountInactiveAskAdminReactivate
const NO_STAFF_ROW = STAFF_ADMIN_WORDS.staffAccess.noStaffRecordMatchesLoggedIn(NOBODY)
const UNKNOWN_ID = '10000000-0000-4000-8000-000000000f50'

let database: TestDatabase
let db: Db
let jo = ''
let tia = ''
let sam = ''
let mo = ''
let ali = ''
let sauna = ''
let band = ''
let towel = ''

beforeAll(async () => {
  process.env.STAFF_API_KEY = ADMIN_TEST_KEY
  database = await startTestDatabase({ schema: 'live' })
  db = database.db
  holder.db = db
})
afterAll(() => database.stop())

/** Jo (admin), Tia (staff) and Ina (inactive); Sam, Mo and Ali; a public Sauna, its band, and a towel to add on. */
beforeEach(async () => {
  await database.pg.exec(
    'RESET ROLE; TRUNCATE audit_log, api_idempotency, pending_reader_payments, addon_order_lines, booking_guests, order_line_items, orders, bookings, sessions, addons, service_types, session_bands, customer_memberships, membership_plans, customers, staff CASCADE; SET ROLE paddock_worker;'
  )
  jo = await insert(db, 'staff', { role: 'admin', first_name: 'Jo', last_name: 'Staff', email: JO, can_issue_refunds: true, can_manage_pricing: true })
  tia = await insert(db, 'staff', { role: 'staff', first_name: 'Tia', last_name: 'Team', email: TIA })
  await insert(db, 'staff', { role: 'staff', first_name: 'Ina', last_name: 'Gone', email: INA, active: false })
  sam = await fixtures.customer(db, { first_name: 'Sam', last_name: 'Test', email: 'sam@example.com' })
  mo = await fixtures.customer(db, { first_name: 'Mo', last_name: 'Member', email: 'mo@example.com' })
  ali = await fixtures.customer(db, { first_name: 'Ali', last_name: 'Early', email: 'ali@example.com' })
  sauna = await fixtures.serviceType(db, { name: 'Sauna' })
  band = await fixtures.band(db)
  towel = await insert(db, 'addons', { name: 'Towel', base_price: '5.00', sku: 'TOWEL' })
})

/** A session on a day, at a London wall-clock time (stored as those digits labelled UTC). */
const sessionAt = (day: string, from = '10:00', to = '11:00', endDay = day) => fixtures.session(db, { service_type_id: sauna, band_id: band, start_time: `${day} ${from}:00+00`, end_time: `${endDay} ${to}:00+00` })
/** A booking with its seat 1 guest (and more guests by name). */
async function bookingOn(session: string, customer: string, row: Record<string, unknown> = {}, guestNames: string[] = ['Sam Test']): Promise<{ id: string; guests: string[] }> {
  const [times] = await db.query<{ start_time: Date; end_time: Date }>('SELECT start_time, end_time FROM sessions WHERE id = $1', [session])
  const id = await fixtures.booking(db, { session_id: session, customer_id: customer, party_size: guestNames.length, price_paid: '20.00', redemption_source: 'paid', start_time: times?.start_time, end_time: times?.end_time, ...row })
  const guests: string[] = []
  for (const [i, name] of guestNames.entries()) {
    guests.push(
      await insert(db, 'booking_guests', {
        booking_id: id,
        guest_type: i === 0 ? 'account_holder' : 'additional_guest',
        guest_name: name,
        guest_email: `${name.split(' ')[0]?.toLowerCase()}@example.com`,
        date_of_birth: i === 0 ? '1990-01-01' : null,
        unit_price: '20.00',
        pay_by: 'paid',
        created_at: `2027-06-01 09:00:0${i}+00`,
      })
    )
  }
  return { id, guests }
}
const towelOn = (bookingId: string, row: Record<string, unknown> = {}) => insert(db, 'addon_order_lines', { booking_id: bookingId, addon_id: towel, quantity: 1, price_at_purchase: '5.00', sku_at_purchase: 'TOWEL', redemption_source: 'paid', ...row })

const JULY_1 = '2027-07-01'
const JULY_2 = '2027-07-02'
const range = (startDate: string, endDate = startDate) => ({ startDate, endDate })

type Rows = Array<Record<string, unknown>>
const get = <T = unknown>(route: AdminRouteHandler, query: Record<string, string> = {}, params: Record<string, string> = {}, email: string | null = JO) => pressRouteWithQuery<T>(route, query, params, email)
/** A GET with a query string, as the staff app's callWorker sends one. */
async function pressRouteWithQuery<T>(route: AdminRouteHandler, query: Record<string, string>, params: Record<string, string>, email: string | null): Promise<AdminAnswer<T>> {
  const withQuery: AdminRouteHandler = (request, context) => {
    const url = new URL(request.url)
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value)
    return route(new Request(url, { method: request.method, headers: request.headers }), context)
  }
  return pressRoute<T>(withQuery, 'GET', { email, params })
}
const post = <T = Record<string, unknown>>(route: AdminRouteHandler, params: Record<string, string>, body: unknown, email: string | null = JO, key?: string) => pressRoute<T>(route, 'POST', { email, params, body, ...(key !== undefined ? { key } : {}) })
const refusedWith = (answer: AdminAnswer) => ({ status: answer.status, reason: answer.reason, words: answer.error?.message })
const staffReader = (): BookingReader => ({ channel: 'staff', actor: { type: 'staff', id: jo, role: 'admin', canManagePricing: true, canIssueRefunds: true } })
const customerReader = (customerId: string): BookingReader => ({ channel: 'customer', customerId })
const refusalOf = (press: Promise<unknown>) =>
  press.then(
    () => 'answered',
    (err: unknown) => (err instanceof ApiError ? { status: err.status, reason: (err.details as { reason?: string } | undefined)?.reason, words: err.message } : String(err))
  )

/** The statements one call of a rule sends, in order. */
async function statementsOf(work: (watched: Db) => Promise<unknown>): Promise<string[]> {
  const seen: string[] = []
  const watching = <T extends { query: Db['query'] }>(target: T): T =>
    new Proxy(target, {
      get(inner, property, receiver) {
        if (property === 'query') {
          return (sql: string, params?: readonly SqlParam[]) => {
            seen.push(sql.trim().replace(/\s+/g, ' '))
            return inner.query(sql, params)
          }
        }
        if (property === 'transaction') return <R>(fn: (tx: Tx) => Promise<R>) => (inner as unknown as Db).transaction((tx) => fn(watching(tx)))
        return Reflect.get(inner, property, receiver) as unknown
      },
    })
  await work(watching(db))
  return seen
}

const BOOKING_FIELDS = Object.keys(adminGetBookingsOutputSchema.element.shape).sort()

describe('the booking list and one booking (GET bookings, GET bookings/:bookingId)', () => {
  it('lists the bookings of a range with every field the old `b.*` read gave, by name: money as text, moments as ISO text, how its own order was paid', async () => {
    const session = await sessionAt(JULY_1)
    const { id } = await bookingOn(session, sam, { price_paid: '40.00', special_requests: 'Step-free access please' }, ['Sam Test', 'Alex Guest'])
    const order = await insert(db, 'orders', { customer_id: sam, order_total: '40.00', payment_status: 'paid', payment_method: 'cash', order_source: 'staff_created' })
    await insert(db, 'order_line_items', { order_id: order, item_type: 'booking', booking_id: id, quantity: 2, unit_price: '20.00', line_total: '40.00' })

    const answer = await get<Rows>(listRoute, range(JULY_1), {}, TIA)
    expect(answer.status).toBe(200)
    expect(answer.data).toHaveLength(1)
    const row = answer.data?.[0] ?? {}
    expect(Object.keys(row).sort()).toEqual(BOOKING_FIELDS)
    expect(BOOKING_FIELDS).toHaveLength(31)
    expect(row).toMatchObject({
      id,
      session_id: session,
      customer_id: sam,
      party_size: 2,
      status: 'confirmed',
      price_paid: '40.00',
      part_refunded_amount: '0.00',
      refund_owed_amount: '0.00',
      redemption_source: 'paid',
      special_requests: 'Step-free access please',
      payment_method: 'cash',
      checked_in_at: null,
      start_time: '2027-07-01T10:00:00.000Z',
      end_time: '2027-07-01T11:00:00.000Z',
      service_type_id: sauna,
      service_type_name: 'Sauna',
      booking_type: 'public',
      customer_first_name: 'Sam',
      customer_last_name: 'Test',
      customer_email: 'sam@example.com',
    })
    expect(String(row['created_at'])).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })

  it('a later guest or add-on paid another way never decides how the booking was paid: its own (earliest, with a method) order does', async () => {
    const { id } = await bookingOn(await sessionAt(JULY_1), sam)
    const own = await insert(db, 'orders', { customer_id: sam, order_total: '20.00', payment_status: 'paid', payment_method: 'card', order_source: 'staff_created' })
    await insert(db, 'order_line_items', { order_id: own, item_type: 'booking', booking_id: id, quantity: 1, unit_price: '20.00', line_total: '20.00', created_at: '2027-06-01 09:00:00+00' })
    const later = await insert(db, 'orders', { customer_id: sam, order_total: '20.00', payment_status: 'paid', payment_method: 'cash', order_source: 'staff_created' })
    await insert(db, 'order_line_items', { order_id: later, item_type: 'booking', booking_id: id, quantity: 1, unit_price: '20.00', line_total: '20.00', created_at: '2027-06-02 09:00:00+00' })
    expect((await get<Record<string, unknown>>(bookingRoute, {}, { bookingId: id })).data?.['payment_method']).toBe('card')
  })

  it('filters by range, by status, by both, and by neither (every booking, as before); newest session first', async () => {
    const first = await bookingOn(await sessionAt(JULY_1), sam)
    const second = await bookingOn(await sessionAt(JULY_2), mo, { status: 'cancelled', cancelled_at: '2027-06-20 09:00:00+00' })
    const ids = async (query: Record<string, string>) => (await get<Rows>(listRoute, query)).data?.map((row) => row['id'])
    expect(await ids({})).toEqual([second.id, first.id])
    expect(await ids(range(JULY_1, JULY_2))).toEqual([second.id, first.id])
    expect(await ids(range(JULY_1))).toEqual([first.id])
    expect(await ids({ startDate: JULY_2 })).toEqual([second.id])
    expect(await ids({ endDate: JULY_1 })).toEqual([first.id])
    expect(await ids({ status: 'cancelled' })).toEqual([second.id])
    expect(await ids({ ...range(JULY_1, JULY_2), status: 'confirmed' })).toEqual([first.id])
    expect(await ids({ ...range(JULY_1), status: 'cancelled' })).toEqual([])
    expect(await ids(range('2027-12-01', '2027-12-02'))).toEqual([])
  })

  it('a date that is not a date is refused before anything is read', async () => {
    expect((await get(listRoute, { startDate: 'next Friday' })).status).toBe(400)
    expect((await get(addonPrepRoute, { startDate: JULY_1 })).status).toBe(400)
    expect((await get(waiverGapsRoute, { startDate: '1 July', endDate: JULY_1 })).status).toBe(400)
  })

  it('one booking by id is the same row the list gives; null for an id with no booking, and for text that is not an id', async () => {
    const { id } = await bookingOn(await sessionAt(JULY_1), sam)
    const listed = (await get<Rows>(listRoute, range(JULY_1))).data?.[0]
    const one = await get<Record<string, unknown>>(bookingRoute, {}, { bookingId: id })
    expect(one.status).toBe(200)
    expect(one.data).toEqual(listed)
    expect((await get(bookingRoute, {}, { bookingId: UNKNOWN_ID })).data).toBeNull()
    expect((await get(bookingRoute, {}, { bookingId: 'not-an-id' })).data).toBeNull()
  })
})

describe("the booking detail (GET bookings/:bookingId/detail), with the open-payment words", () => {
  it('answers the guests seat 1 first, the add-on lines with removed ones kept, the special requests and the money still to give back, by named fields', async () => {
    const { id, guests } = await bookingOn(await sessionAt(JULY_1), sam, { special_requests: 'No milk', refund_owed_amount: '12.50' }, ['Sam Test', 'Alex Guest'])
    const order = await insert(db, 'orders', { customer_id: sam, order_total: '5.00', payment_status: 'paid', payment_method: 'card', stripe_payment_intent_id: 'pi_test_w50', order_source: 'staff_created' })
    const kept = await towelOn(id, { order_id: order, created_at: '2027-06-01 09:00:00+00' })
    const removed = await towelOn(id, { removed_at: '2027-06-02 09:00:00+00', removed_by: tia, refunded_amount: '5', refund_method: 'credit', created_at: '2027-06-01 09:01:00+00' })

    const answer = await get<{ guests: Rows; addonLines: Rows; specialRequests: string | null; refundOwedAmount: string; readerPaymentOpenMessage: string | null }>(detailRoute, {}, { bookingId: id }, TIA)
    expect(answer.status).toBe(200)
    const detail = answer.data
    expect(adminGetBookingDetailOutputSchema.safeParse(detail).success).toBe(true)
    expect(detail?.guests.map((guest) => [guest['id'], guest['guest_name'], guest['guest_type']])).toEqual([[guests[0], 'Sam Test', 'account_holder'], [guests[1], 'Alex Guest', 'additional_guest']])
    expect(Object.keys(detail?.guests[0] ?? {}).sort()).toEqual(Object.keys(adminGetBookingDetailOutputSchema.shape.guests.element.shape).sort())
    expect(detail?.guests[0]).toMatchObject({ booking_id: id, guest_email: 'sam@example.com', date_of_birth: '1990-01-01', waiver_accepted: false, waiver_method: null, unit_price: '20.00', pay_by: 'paid' })
    expect(detail?.addonLines.map((line) => line['id'])).toEqual([kept, removed])
    expect(Object.keys(detail?.addonLines[0] ?? {}).sort()).toEqual(Object.keys(adminGetBookingDetailOutputSchema.shape.addonLines.element.shape).sort())
    expect(detail?.addonLines[0]).toMatchObject({ addon_id: towel, addon_name: 'Towel', quantity: 1, price_at_purchase: '5.00', sku_at_purchase: 'TOWEL', prepared: false, removed_at: null, removed_by_name: null, refunded_amount: '0.00', order_has_card: true })
    expect(detail?.addonLines[1]).toMatchObject({ removed_at: '2027-06-02T09:00:00.000Z', removed_by_name: 'Tia Team', refunded_amount: '5.00', refund_method: 'credit', order_has_card: false })
    expect(detail).toMatchObject({ specialRequests: 'No milk', refundOwedAmount: '12.50', readerPaymentOpenMessage: null })
  })

  it('a booking that is not there answers the empty detail the old function did', async () => {
    const empty = { guests: [], addonLines: [], specialRequests: null, refundOwedAmount: '0', readerPaymentOpenMessage: null }
    expect((await get(detailRoute, {}, { bookingId: UNKNOWN_ID })).data).toEqual(empty)
    expect((await get(detailRoute, {}, { bookingId: 'not-an-id' })).data).toEqual(empty)
  })

  it("the words while a payment is still being taken: the card words when every open flow is the Worker's saved-card one; the reader words otherwise, and for an order still being paid", async () => {
    const message = async (bookingId: string) => (await get<{ readerPaymentOpenMessage: string | null }>(detailRoute, {}, { bookingId })).data?.readerPaymentOpenMessage
    const { id } = await bookingOn(await sessionAt(JULY_1), sam)
    expect(await message(id)).toBeNull()

    // A saved-card flow the Worker started (its record carries a request id).
    await db.query(`INSERT INTO pending_reader_payments (flow, record_id, expected_amount, snapshot, status) VALUES ('add_guest', $1, 20, '{"method": "card", "request_id": "req_w50"}'::jsonb, 'pending')`, [id])
    expect(await message(id)).toBe(CARD_PAYMENT_OPEN_MESSAGE)
    // A reader flow beside it: not every open flow is a card one.
    await db.query(`INSERT INTO pending_reader_payments (flow, record_id, expected_amount, snapshot, status) VALUES ('settle', $1, 20, '{"method": "reader", "request_id": "req_w50b"}'::jsonb, 'pending')`, [id])
    expect(await message(id)).toBe(READER_PAYMENT_OPEN_MESSAGE)
    // Finished flows hold nothing.
    await db.query("UPDATE pending_reader_payments SET status = 'finalised' WHERE record_id = $1 AND flow = 'add_guest'", [id])
    await db.query("UPDATE pending_reader_payments SET status = 'cancelled' WHERE record_id = $1 AND flow = 'settle'", [id])
    expect(await message(id)).toBeNull()
    // A flow of another kind (a checkout's own reader payment, whose record is its order) is not a booking flow.
    await db.query(`INSERT INTO pending_reader_payments (flow, record_id, expected_amount, snapshot, status) VALUES ('checkout', $1, 20, '{}'::jsonb, 'pending')`, [id])
    expect(await message(id)).toBeNull()

    // An order still being paid for the booking, with no flow open: the reader words.
    const paying = await insert(db, 'orders', { customer_id: sam, order_total: '20.00', payment_status: 'pending', order_source: 'staff_created' })
    await insert(db, 'order_line_items', { order_id: paying, item_type: 'booking', booking_id: id, quantity: 1, unit_price: '20.00', line_total: '20.00' })
    expect(await message(id)).toBe(READER_PAYMENT_OPEN_MESSAGE)
    // …but not for ever: a pending order with no reader intent stops counting after 15 minutes.
    await db.query("UPDATE orders SET created_at = now() - interval '16 minutes' WHERE id = $1", [paying])
    expect(await message(id)).toBeNull()
  })

  it("the moved words are the Worker's own two sentences, so the detail and every refusal say the same thing", () => {
    expect(BOOKING_ADMIN_WORDS.readerPaymentOpen.cardReaderPaymentStillOpenOn).toBe(READER_PAYMENT_OPEN_MESSAGE)
    expect(BOOKING_ADMIN_WORDS.bookingPaymentOpenWords.cardPaymentOnBookingStillBeing).toBe(CARD_PAYMENT_OPEN_MESSAGE)
  })
})

describe('the prep list, the waiver gaps and payments needing attention', () => {
  it("the prep list: every add-on still on a booking that isn't cancelled, in session order, by named fields", async () => {
    const early = await bookingOn(await sessionAt(JULY_1, '08:00', '09:00'), mo, { special_requests: 'Oat milk' }, ['Mo Member'])
    const late = await bookingOn(await sessionAt(JULY_1, '12:00', '13:00'), sam)
    const cancelled = await bookingOn(await sessionAt(JULY_1, '15:00', '16:00'), ali, { status: 'cancelled' }, ['Ali Early'])
    const lateLine = await towelOn(late.id)
    const earlyLine = await towelOn(early.id, { prepared: true, prepared_at: '2027-06-30 09:00:00+00', prepared_by: jo })
    await towelOn(early.id, { removed_at: '2027-06-30 10:00:00+00' })
    await towelOn(cancelled.id)

    const answer = await get<Rows>(addonPrepRoute, range(JULY_1), {}, TIA)
    expect(answer.status).toBe(200)
    expect(answer.data?.map((row) => row['id'])).toEqual([earlyLine, lateLine])
    expect(Object.keys(answer.data?.[0] ?? {}).sort()).toEqual(
      ['addon_id', 'addon_name', 'booking_id', 'booking_status', 'customer_first_name', 'customer_last_name', 'end_time', 'id', 'prepared', 'prepared_at', 'prepared_by', 'quantity', 'service_type_name', 'session_id', 'special_requests', 'start_time'].sort()
    )
    expect(answer.data?.[0]).toMatchObject({ booking_id: early.id, addon_name: 'Towel', quantity: 1, prepared: true, prepared_by: jo, prepared_at: '2027-06-30T09:00:00.000Z', start_time: '2027-07-01T08:00:00.000Z', customer_first_name: 'Mo', booking_status: 'confirmed', special_requests: 'Oat milk' })
    expect((await get<Rows>(addonPrepRoute, range(JULY_2))).data).toEqual([])
  })

  it("the waiver gaps: every guest without a signed waiver on a booking that isn't cancelled, in session order, by named fields", async () => {
    const one = await bookingOn(await sessionAt(JULY_1, '08:00', '09:00'), sam, {}, ['Sam Test', 'Alex Guest'])
    const cancelled = await bookingOn(await sessionAt(JULY_1, '15:00', '16:00'), mo, { status: 'cancelled' }, ['Mo Member'])
    await db.query("UPDATE booking_guests SET waiver_accepted = true, waiver_method = 'in_person', waiver_version = 'v1', waiver_accepted_at = now() WHERE id = $1", [one.guests[0]])
    // A waiver never answered (null) counts as not signed, as before.
    await db.query('UPDATE booking_guests SET waiver_accepted = NULL WHERE id = $1', [one.guests[1]])

    const answer = await get<Rows>(waiverGapsRoute, range(JULY_1), {}, TIA)
    expect(answer.status).toBe(200)
    expect(answer.data).toEqual([{ id: one.guests[1], booking_id: one.id, guest_name: 'Alex Guest', guest_type: 'additional_guest', customer_first_name: 'Sam', customer_last_name: 'Test', start_time: '2027-07-01T08:00:00.000Z', service_type_name: 'Sauna' }])
    expect(cancelled.guests).toHaveLength(1)
  })

  it('payments needing attention: bookings at Payment needed, soonest deadline first (none last), each a whole booking row; and memberships whose payment is overdue', async () => {
    expect((await get(attentionRoute)).data).toEqual({ bookings: [], memberships: [] })
    const soon = await bookingOn(await sessionAt(JULY_2), mo, { status: 'payment_needed', payment_due_by: '2027-06-28 09:00:00+00', price_paid: '0' }, ['Mo Member'])
    const later = await bookingOn(await sessionAt(JULY_1), sam, { status: 'payment_needed', payment_due_by: '2027-06-29 09:00:00+00', price_paid: '0' })
    const none = await bookingOn(await sessionAt('2027-07-03'), ali, { status: 'payment_needed', price_paid: '0' }, ['Ali Early'])
    await bookingOn(await sessionAt('2027-07-04'), sam)
    const plan = await fixtures.plan(db, { name: 'Core Monthly' })
    const overdue = await fixtures.membership(db, { customer_id: mo, plan_id: plan, subscription_status: 'past_due' })
    await fixtures.membership(db, { customer_id: sam, plan_id: plan })

    const answer = await get<{ bookings: Rows; memberships: Rows }>(attentionRoute, {}, {}, TIA)
    expect(answer.status).toBe(200)
    expect(adminGetPaymentAttentionItemsOutputSchema.safeParse(answer.data).success).toBe(true)
    expect(answer.data?.bookings.map((row) => row['id'])).toEqual([soon.id, later.id, none.id])
    expect(Object.keys(answer.data?.bookings[0] ?? {}).sort()).toEqual(BOOKING_FIELDS)
    expect(answer.data?.bookings[0]).toMatchObject({ status: 'payment_needed', payment_due_by: '2027-06-28T09:00:00.000Z', customer_first_name: 'Mo', price_paid: '0.00' })
    expect(answer.data?.memberships).toEqual([{ membership_id: overdue, customer_id: mo, plan_name: 'Core Monthly', first_name: 'Mo', last_name: 'Member', email: 'mo@example.com' }])
  })
})

describe('GB14: every read asks who is calling', () => {
  const reads = (bookingId: string): Array<[string, (email: string) => Promise<AdminAnswer>]> => [
    ['GET bookings', (email) => get(listRoute, range(JULY_1), {}, email)],
    ['GET bookings/:bookingId', (email) => get(bookingRoute, {}, { bookingId }, email)],
    ['GET bookings/:bookingId/detail', (email) => get(detailRoute, {}, { bookingId }, email)],
    ['GET bookings/addon-prep', (email) => get(addonPrepRoute, range(JULY_1), {}, email)],
    ['GET bookings/waiver-gaps', (email) => get(waiverGapsRoute, range(JULY_1), {}, email)],
    ['GET overview/payment-attention', (email) => get(attentionRoute, {}, {}, email)],
  ]

  it('an inactive account and a sign-in with no staff row are refused each of the six, in the words every staff route gives; the shared key alone is not enough', async () => {
    const { id } = await bookingOn(await sessionAt(JULY_1), sam)
    for (const [name, read] of reads(id)) {
      const inactive = await read(INA)
      expect([name, inactive.status, inactive.error?.message]).toEqual([name, 403, INACTIVE])
      const unknown = await read(NOBODY)
      expect([name, unknown.status, unknown.error?.message]).toEqual([name, 401, NO_STAFF_ROW])
      expect(inactive.data).toBeUndefined()
      expect(unknown.data).toBeUndefined()
    }
    expect((await pressRoute(listRoute, 'GET', { email: null })).status).toBe(401)
    expect((await pressRoute(listRoute, 'GET', { email: JO, bearer: 'wrong-key' })).status).toBe(401)
  })

  it('a sign-in spelt with capitals finds its staff row on each of the six (the old reads never looked)', async () => {
    const { id } = await bookingOn(await sessionAt(JULY_1), sam)
    for (const [name, read] of reads(id)) expect([name, (await read('Jo@Example.COM')).status]).toEqual([name, 200])
  })

  it('no read asks for every column: each statement names what it answers', async () => {
    const { id } = await bookingOn(await sessionAt(JULY_1), sam)
    await towelOn(id)
    const reader = staffReader()
    const statements = await statementsOf(async (watched) => {
      await listBookings(watched, range(JULY_1), reader)
      await getBookingRow(watched, id, reader)
      await getBookingDetail(watched, id, reader)
      await listAddonPrep(watched, range(JULY_1), reader)
      await listWaiverGaps(watched, range(JULY_1), reader)
      await listPaymentAttention(watched, reader)
    })
    expect(statements).toHaveLength(9)
    for (const statement of statements) expect(statement).not.toMatch(/(^|[\s,(])(\w+\.)?\*(\s|,|$)/)
  })
})

describe('London days (W48 review L5): a range picks its sessions by the London day their stored digits show', () => {
  // Session times are London wall-clock digits labelled UTC. 00:30 on the wall on 2 July 2027 (British Summer Time)
  // is stored as 2027-07-02 00:30:00+00; 23:30 on 1 July as 2027-07-01 23:30:00+00.
  let morning = ''
  let lateNight = ''
  let afterMidnight = ''
  const seedTheNight = async () => {
    morning = (await bookingOn(await sessionAt(JULY_1, '10:00', '11:00'), sam)).id
    const late = await bookingOn(await sessionAt(JULY_1, '23:30', '00:30', JULY_2), mo, {}, ['Mo Member'])
    const early = await bookingOn(await sessionAt(JULY_2, '00:30', '01:30'), ali, {}, ['Ali Early'])
    lateNight = late.id
    afterMidnight = early.id
    await towelOn(late.id)
    await towelOn(early.id)
    await towelOn(morning)
  }
  /** What each of the three range reads lists for a day: booking ids, in the order answered. */
  const dayOf = async (queryable: Queryable, day: string) => {
    const reader = staffReader()
    return {
      bookings: (await listBookings(queryable, range(day), reader)).map((row) => row.id),
      prep: (await listAddonPrep(queryable, range(day), reader)).map((row) => row.booking_id),
      waivers: (await listWaiverGaps(queryable, range(day), reader)).map((row) => row.booking_id),
    }
  }

  it('a session at 00:30 London in summer is on its own day, and one at 23:30 is on the day before it: in the booking list, the prep list and the waiver gaps', async () => {
    await seedTheNight()
    expect(await dayOf(db, JULY_1)).toEqual({ bookings: [lateNight, morning], prep: [morning, lateNight], waivers: [morning, lateNight] })
    expect(await dayOf(db, JULY_2)).toEqual({ bookings: [afterMidnight], prep: [afterMidnight], waivers: [afterMidnight] })
    // Through the route, as the screens ask.
    expect((await get<Rows>(listRoute, range(JULY_2))).data?.map((row) => row['id'])).toEqual([afterMidnight])
    expect((await get<Rows>(addonPrepRoute, range(JULY_1))).data?.map((row) => row['booking_id'])).toEqual([morning, lateNight])
    expect((await get<Rows>(waiverGapsRoute, range(JULY_2))).data?.map((row) => row['booking_id'])).toEqual([afterMidnight])
  })

  it.each(['America/New_York', 'Europe/London', 'Asia/Tokyo'])("the day never depends on the connection's time zone: the same answers with it set to %s", async (zone) => {
    await seedTheNight()
    const [first, second] = await db.transaction(async (tx) => {
      // The transaction's own time zone (as SET LOCAL), as a connection set to it would have.
      await tx.query("SELECT set_config('TimeZone', $1, true)", [zone])
      return [await dayOf(tx, JULY_1), await dayOf(tx, JULY_2)]
    })
    expect(first).toEqual({ bookings: [lateNight, morning], prep: [morning, lateNight], waivers: [morning, lateNight] })
    expect(second).toEqual({ bookings: [afterMidnight], prep: [afterMidnight], waivers: [afterMidnight] })
  })

  it("what the two other ways of reading the day would get wrong: the connection's own date (the old reads), and the stored moment turned into London time", async () => {
    await seedTheNight()
    /** Each booking's day, read three ways. */
    const DAY_SQL = {
      // The old reads: the date in the connection's own time zone.
      theConnectionsDate: 'SELECT b.id, (s.start_time::date)::text AS day FROM bookings b JOIN sessions s ON s.id = b.session_id',
      // The stored moment turned into London time.
      turnedIntoLondonTime: "SELECT b.id, ((s.start_time AT TIME ZONE 'Europe/London')::date)::text AS day FROM bookings b JOIN sessions s ON s.id = b.session_id",
      // The stored digits read as UTC: the London day.
      theDigitsAsUtc: "SELECT b.id, ((s.start_time AT TIME ZONE 'UTC')::date)::text AS day FROM bookings b JOIN sessions s ON s.id = b.session_id",
    } as const
    const days = async (way: keyof typeof DAY_SQL, zone: string) =>
      db.transaction(async (tx) => {
        await tx.query("SELECT set_config('TimeZone', $1, true)", [zone])
        const rows = await tx.query<{ id: string; day: string }>(DAY_SQL[way])
        return Object.fromEntries(rows.map((row) => [row.id, row.day]))
      })
    // The old reads' `start_time::date` is right only while the connection is on UTC…
    expect(await days('theConnectionsDate', 'UTC')).toEqual({ [morning]: JULY_1, [lateNight]: JULY_1, [afterMidnight]: JULY_2 })
    // …on a connection set to New York the 00:30 session lands on the day before; set to London, the 23:30 one on the day after.
    expect((await days('theConnectionsDate', 'America/New_York'))[afterMidnight]).toBe(JULY_1)
    expect((await days('theConnectionsDate', 'Europe/London'))[lateNight]).toBe(JULY_2)
    // Turning the stored moment into London time adds the summer hour a second time: 23:30 becomes 00:30 the next day.
    expect((await days('turnedIntoLondonTime', 'UTC'))[lateNight]).toBe(JULY_2)
    // The digits read as UTC are the London day, whatever the connection is set to.
    for (const zone of ['UTC', 'America/New_York', 'Europe/London']) expect(await days('theDigitsAsUtc', zone)).toEqual({ [morning]: JULY_1, [lateNight]: JULY_1, [afterMidnight]: JULY_2 })
  })

  it('in winter too: 00:30 and 23:30 on 15 January', async () => {
    const late = await bookingOn(await sessionAt('2028-01-15', '23:30', '00:30', '2028-01-16'), sam)
    const early = await bookingOn(await sessionAt('2028-01-15', '00:30', '01:30'), mo, {}, ['Mo Member'])
    expect((await dayOf(db, '2028-01-15')).bookings).toEqual([late.id, early.id])
    expect((await dayOf(db, '2028-01-14')).bookings).toEqual([])
    expect((await dayOf(db, '2028-01-16')).bookings).toEqual([])
  })
})

describe('the customer channel (G-plan 4.8; no customer route, lead call L13): only the signed-in customer\'s own bookings', () => {
  it("each read shows a customer their own bookings and nothing of anyone else's", async () => {
    const session = await sessionAt(JULY_1)
    const sams = await bookingOn(session, sam, { status: 'payment_needed', payment_due_by: '2027-06-29 09:00:00+00' }, ['Sam Test', 'Alex Guest'])
    const mos = await bookingOn(await sessionAt(JULY_1, '12:00', '13:00'), mo, { status: 'payment_needed', payment_due_by: '2027-06-28 09:00:00+00', special_requests: "Mo's own" }, ['Mo Member'])
    const samsLine = await towelOn(sams.id)
    const mosLine = await towelOn(mos.id)
    const plan = await fixtures.plan(db, { name: 'Core Monthly' })
    const samsMembership = await fixtures.membership(db, { customer_id: sam, plan_id: plan, subscription_status: 'past_due' })
    await fixtures.membership(db, { customer_id: mo, plan_id: plan, subscription_status: 'past_due' })
    const asSam = customerReader(sam)

    expect((await listBookings(db, {}, asSam)).map((row) => row.id)).toEqual([sams.id])
    expect((await listBookings(db, range(JULY_1), asSam)).map((row) => row.id)).toEqual([sams.id])
    expect((await getBookingRow(db, sams.id, asSam))?.id).toBe(sams.id)
    expect(await getBookingRow(db, mos.id, asSam)).toBeNull()
    expect((await listAddonPrep(db, range(JULY_1), asSam)).map((row) => row.id)).toEqual([samsLine])
    expect((await listWaiverGaps(db, range(JULY_1), asSam)).map((row) => row.booking_id)).toEqual([sams.id, sams.id])
    const attention = await listPaymentAttention(db, asSam)
    expect(attention.bookings.map((row) => row.id)).toEqual([sams.id])
    expect(attention.memberships.map((row) => row.membership_id)).toEqual([samsMembership])

    // Someone else's booking, asked for by id: the same empty detail as a booking that isn't there.
    expect(await getBookingDetail(db, mos.id, asSam)).toEqual({ guests: [], addonLines: [], specialRequests: null, refundOwedAmount: '0', readerPaymentOpenMessage: null })
    const own = await getBookingDetail(db, sams.id, asSam)
    expect(own.guests.map((guest) => guest.id)).toEqual(sams.guests)
    expect(own.addonLines.map((line) => line.id)).toEqual([samsLine])
    // The staff channel, for comparison, sees both.
    expect((await listBookings(db, range(JULY_1), staffReader())).map((row) => row.id).sort()).toEqual([sams.id, mos.id].sort())
    expect(mosLine).not.toBe(samsLine)
  })

  it("a page of bookings can be summed up in two statements: each one's guests (waivers, each seat's price and how it is covered) and add-on lines, the customer's own only", async () => {
    const first = await bookingOn(await sessionAt(JULY_1), sam, {}, ['Sam Test', 'Alex Guest'])
    const second = await bookingOn(await sessionAt(JULY_2), sam)
    const mos = await bookingOn(await sessionAt(JULY_1, '12:00', '13:00'), mo, {}, ['Mo Member'])
    await db.query("UPDATE booking_guests SET waiver_accepted = true WHERE id = $1", [first.guests[0]])
    await db.query("UPDATE booking_guests SET pay_by = 'membership_credit' WHERE id = $1", [first.guests[1]])
    const line = await towelOn(second.id)
    await towelOn(mos.id)
    const asSam = customerReader(sam)
    const asked = [first.id, second.id, mos.id]

    const statements = await statementsOf(async (watched) => {
      const guests = await guestsOfBookings(watched, asked, asSam)
      const lines = await addonLinesOfBookings(watched, asked, asSam)
      // "1 of 2 signed" and "£20.00 + 1 credit" for the first booking: all there, without another read.
      const firstGuests = guests.filter((guest) => guest.booking_id === first.id)
      expect([firstGuests.filter((guest) => guest.waiver_accepted).length, firstGuests.length]).toEqual([1, 2])
      expect(firstGuests.map((guest) => [guest.unit_price, guest.pay_by])).toEqual([['20.00', 'paid'], ['20.00', 'membership_credit']])
      expect(new Set(guests.map((guest) => guest.booking_id))).toEqual(new Set([first.id, second.id]))
      expect(lines.map((one) => one.id)).toEqual([line])
    })
    expect(statements).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// The three flags

const checkIn = (bookingId: string, checkedIn: boolean, email: string = JO, key?: string) => post<{ id: string; checked_in_at: string | null }>(checkInRoute, { bookingId }, { checkedIn }, email, key)
const waiver = (guestId: string, body: Record<string, unknown>, email: string = JO, key?: string) => post(waiverRoute, { guestId }, body, email, key)
const prepared = (lineId: string, on: boolean, email: string = JO, key?: string) => post(preparedRoute, { lineId }, { prepared: on }, email, key)
const flagRows = async () => (await auditRowsOf(db)).filter((row) => row.action.startsWith('booking.'))
/** The booking's check-in time as ISO text (or null), and its status. */
const bookingNow = async (id: string) => {
  const [row] = await db.query<{ checked_in_at: unknown; status: string }>('SELECT checked_in_at, status FROM bookings WHERE id = $1', [id])
  return row ? { status: row.status, checked_in_at: row.checked_in_at === null ? null : new Date(String(row.checked_in_at)).toISOString() } : undefined
}
const guestNow = async (id: string) => (await db.query<Record<string, unknown>>('SELECT waiver_accepted, waiver_method, waiver_version, waiver_accepted_at FROM booking_guests WHERE id = $1', [id]))[0]
const lineNow = async (id: string) => (await db.query<Record<string, unknown>>('SELECT prepared, prepared_by, prepared_at FROM addon_order_lines WHERE id = $1', [id]))[0]
const setStatus = (bookingId: string, status: string) => db.query('UPDATE bookings SET status = $1 WHERE id = $2', [status, bookingId])

describe('Check In and its undo (POST bookings/:bookingId/check-in; GB17, Q49)', () => {
  it("checks a booking in at the database's own time and undoes it; each press has its audit row saying who", async () => {
    const { id } = await bookingOn(await sessionAt(JULY_1), sam)
    const clock = async () => new Date(String((await db.query<{ now: unknown }>('SELECT clock_timestamp() AS now'))[0]?.now)).getTime()
    const before = await clock()
    const key = crypto.randomUUID()
    const on = await checkIn(id, true, TIA, key)
    const after = await clock()
    expect(on.status).toBe(200)
    expect(on.data?.id).toBe(id)
    // The database's clock, between two readings of it: never a time the staff app sent (it sends none).
    const at = new Date(String(on.data?.checked_in_at)).getTime()
    expect(at).toBeGreaterThanOrEqual(before - 1)
    expect(at).toBeLessThanOrEqual(after + 1)
    expect((await bookingNow(id))?.checked_in_at).toBe(on.data?.checked_in_at)

    const off = await checkIn(id, false)
    expect(off.data).toEqual({ id, checked_in_at: null })
    expect((await bookingNow(id))?.checked_in_at).toBeNull()

    const rows = await flagRows()
    expect(rows.map((row) => [row.action, row.actor_type, row.actor_id, row.entity_type, row.entity_id])).toEqual([
      ['booking.checked_in', 'staff', tia, 'booking', id],
      ['booking.check_in_undone', 'staff', jo, 'booking', id],
    ])
    expect(rows[0]?.details).toEqual({ after: { checked_in_at: on.data?.checked_in_at }, key })
    expect(rows[1]?.details.after).toEqual({ checked_in_at: null })
    expect(rows.every((row) => typeof row.request_id === 'string' && row.request_id !== '')).toBe(true)
  })

  it('a booking already checked in keeps its first time when Check In is pressed again; a repeat of the same call is answered from the first', async () => {
    const { id } = await bookingOn(await sessionAt(JULY_1), sam)
    const key = crypto.randomUUID()
    const first = await checkIn(id, true, JO, key)
    const repeated = await checkIn(id, true, JO, key)
    expect(repeated.replayed).toBe(true)
    expect(repeated.data).toEqual(first.data)
    expect(await flagRows()).toHaveLength(1)
    await new Promise((resolve) => setTimeout(resolve, 5))
    const again = await checkIn(id, true, TIA)
    expect(again.replayed).toBe(false)
    expect(again.data?.checked_in_at).toBe(first.data?.checked_in_at)
    expect((await flagRows()).map((row) => row.actor_id)).toEqual([jo, tia])
  })

  it('Q49: Check In on a booking at Payment needed is refused in Wayne\'s words; an earlier check-in on it can still be undone', async () => {
    const { id } = await bookingOn(await sessionAt(JULY_1), sam, { status: 'payment_needed', payment_due_by: '2027-06-29 09:00:00+00' })
    // W50a: Wayne's words name the button on the booking window ("Take Payment"), not the dialog ("Settle").
    expect(refusedWith(await checkIn(id, true))).toEqual({ status: 409, reason: 'payment_needed', words: 'This booking needs payment first. Use Take Payment.' })
    expect(WORDS.paymentNeededCheckIn).toBe('This booking needs payment first. Use Take Payment.')
    expect((await bookingNow(id))?.checked_in_at).toBeNull()
    expect(await flagRows()).toEqual([])
    // Checked in before its payment failed: the undo goes through.
    await db.query("UPDATE bookings SET checked_in_at = '2027-06-28 09:00:00+00' WHERE id = $1", [id])
    expect((await checkIn(id, false)).data).toEqual({ id, checked_in_at: null })
    // Once it is paid (Settle makes it confirmed), Check In works.
    await setStatus(id, 'confirmed')
    expect((await checkIn(id, true)).status).toBe(200)
  })

  // Brief W50a item 3 (W50 review L2; Wayne, 20 Nov).
  describe('W50a: Check In while a payment is still being taken on the booking', () => {
    const PAYMENT_OPEN = { status: 409, reason: 'payment_open', words: 'A payment on this booking is still going through. Check in once it has completed.' }
    const openMessage = async (bookingId: string) => (await get<{ readerPaymentOpenMessage: string | null }>(detailRoute, {}, { bookingId })).data?.readerPaymentOpenMessage ?? null
    const flow = (bookingId: string, kind: string, snapshot: string) =>
      db.query(`INSERT INTO pending_reader_payments (flow, record_id, expected_amount, snapshot, status) VALUES ($1, $2, 20, $3::jsonb, 'pending')`, [kind, bookingId, snapshot])
    const endFlows = (bookingId: string, status: string) => db.query('UPDATE pending_reader_payments SET status = $1 WHERE record_id = $2', [status, bookingId])
    /** Check In pressed now: refused "payment open" with nothing written, exactly when the window shows its payment-open line. */
    async function refusedWhileOpen(bookingId: string, words: string) {
      expect(await openMessage(bookingId)).toBe(words)
      expect(refusedWith(await checkIn(bookingId, true))).toEqual(PAYMENT_OPEN)
      expect((await bookingNow(bookingId))?.checked_in_at).toBeNull()
      expect(await flagRows()).toEqual([])
    }

    it("is refused in Wayne's words for each kind of open payment: a saved-card flow, a reader flow, one an old screen started; and goes through once it has finished", async () => {
      expect(WORDS.paymentOpenCheckIn).toBe(PAYMENT_OPEN.words)
      const { id } = await bookingOn(await sessionAt(JULY_1), sam)
      await flow(id, 'add_guest', '{"method": "card", "request_id": "req_w50a"}')
      await refusedWhileOpen(id, CARD_PAYMENT_OPEN_MESSAGE)
      await endFlows(id, 'finalised')
      await flow(id, 'move', '{"method": "reader", "request_id": "req_w50a_b"}')
      await refusedWhileOpen(id, READER_PAYMENT_OPEN_MESSAGE)
      await endFlows(id, 'cancelled')
      // A flow the old screens started (no method on its record) holds the booking just the same.
      await flow(id, 'settle', '{}')
      await refusedWhileOpen(id, READER_PAYMENT_OPEN_MESSAGE)
      await endFlows(id, 'finalised')

      // Nothing open any more: the window shows no line, and Check In goes through.
      expect(await openMessage(id)).toBeNull()
      expect((await checkIn(id, true, TIA)).status).toBe(200)
      expect((await flagRows()).map((row) => [row.action, row.actor_id])).toEqual([['booking.checked_in', tia]])
    })

    it("a flow of another kind on the same id (a checkout's own reader payment) is not the booking's: Check In goes through", async () => {
      const { id } = await bookingOn(await sessionAt(JULY_1), sam)
      await flow(id, 'checkout', '{}')
      expect(await openMessage(id)).toBeNull()
      expect((await checkIn(id, true)).status).toBe(200)
    })

    it('an order still being paid for the booking, with no flow open: refused while it counts as open (a reader intent, or under 15 minutes old), and not after', async () => {
      const { id } = await bookingOn(await sessionAt(JULY_1), sam)
      const paying = await insert(db, 'orders', { customer_id: sam, order_total: '20.00', payment_status: 'pending', order_source: 'staff_created' })
      await insert(db, 'order_line_items', { order_id: paying, item_type: 'booking', booking_id: id, quantity: 1, unit_price: '20.00', line_total: '20.00' })
      await refusedWhileOpen(id, READER_PAYMENT_OPEN_MESSAGE)
      // Sixteen minutes old, with a reader intent on it: still open.
      await db.query(`UPDATE orders SET created_at = now() - interval '16 minutes', reader_payment = '{"payment_intent_id": "pi_w50a"}'::jsonb WHERE id = $1`, [paying])
      await refusedWhileOpen(id, READER_PAYMENT_OPEN_MESSAGE)
      // Sixteen minutes old with no reader intent: it no longer counts, in the window or here.
      await db.query('UPDATE orders SET reader_payment = NULL WHERE id = $1', [paying])
      expect(await openMessage(id)).toBeNull()
      expect((await checkIn(id, true)).status).toBe(200)
    })

    it("another booking's open payment holds nothing here", async () => {
      const mine = await bookingOn(await sessionAt(JULY_1), sam)
      const theirs = await bookingOn(await sessionAt(JULY_2), mo, {}, ['Mo Member'])
      await flow(theirs.id, 'settle', '{"method": "reader", "request_id": "req_w50a_c"}')
      expect((await checkIn(mine.id, true)).status).toBe(200)
      expect(refusedWith(await checkIn(theirs.id, true))).toEqual(PAYMENT_OPEN)
    })

    it('undoing a check-in, waivers and the prepared tick are unchanged: each goes through while the payment is open, both ways', async () => {
      const { id, guests } = await bookingOn(await sessionAt(JULY_1), sam)
      const line = await towelOn(id)
      await db.query("UPDATE bookings SET checked_in_at = '2027-06-28 09:00:00+00' WHERE id = $1", [id])
      await flow(id, 'add_guest', '{"method": "reader", "request_id": "req_w50a_d"}')
      expect((await checkIn(id, false)).data).toEqual({ id, checked_in_at: null })
      expect((await waiver(guests[0] ?? '', { accepted: true, waiverMethod: 'in_person' })).status).toBe(200)
      expect((await waiver(guests[0] ?? '', { accepted: false })).status).toBe(200)
      expect((await prepared(line, true)).status).toBe(200)
      expect((await prepared(line, false)).status).toBe(200)
      // …and Check In itself is still refused.
      expect(refusedWith(await checkIn(id, true))).toEqual(PAYMENT_OPEN)
    })

    it('a Payment needed booking whose payment is being taken (Settle\'s own flow) says "still going through", not "Use Take Payment"; with no flow open it is Q49 again', async () => {
      const { id } = await bookingOn(await sessionAt(JULY_1), sam, { status: 'payment_needed', payment_due_by: '2027-06-29 09:00:00+00' })
      await flow(id, 'settle', '{"method": "card", "request_id": "req_w50a_e"}')
      expect(refusedWith(await checkIn(id, true))).toEqual(PAYMENT_OPEN)
      // The payment failed and the flow was undone: the booking still needs paying.
      await endFlows(id, 'cancelled')
      expect(refusedWith(await checkIn(id, true))).toEqual({ status: 409, reason: 'payment_needed', words: WORDS.paymentNeededCheckIn })
      // A cancelled booking is "cancelled" whatever is open on it.
      await setStatus(id, 'cancelled')
      await flow(id, 'settle', '{"method": "card", "request_id": "req_w50a_f"}')
      expect(refusedWith(await checkIn(id, true))).toEqual({ status: 409, reason: 'booking_cancelled', words: WORDS.cancelledCheckIn })
      expect(await flagRows()).toEqual([])
    })

    it("Check In holds its own booking first, with the lock its UPDATE takes, and its guard asks the window's own question; the undo holds nothing first", async () => {
      const { id } = await bookingOn(await sessionAt(JULY_1), sam)
      const { setBookingCheckedIn } = await import('./admin')
      const actor: AdminActor = { type: 'staff', id: jo, role: 'admin', canManagePricing: true, canIssueRefunds: true }
      const press = () => ({ actor, requestId: crypto.randomUUID(), pressKey: crypto.randomUUID() })

      const on = await statementsOf((watched) => setBookingCheckedIn(watched, id, true, press()))
      expect(on[0]).toBe('SELECT b.id FROM bookings b WHERE b.id = $1::uuid FOR NO KEY UPDATE OF b')
      expect(on[1]).toMatch(/^UPDATE bookings b /)
      expect(on[1]).toContain("b.status <> 'cancelled' AND b.status <> 'payment_needed' AND NOT (EXISTS (SELECT 1 FROM pending_reader_payments p WHERE ")
      expect(on).toHaveLength(3)
      expect(on[2]).toMatch(/^INSERT INTO audit_log /)

      // The same question, word for word, as the detail's `readerPaymentOpenMessage` asks.
      const detail = (await statementsOf((watched) => getBookingDetail(watched, id, staffReader()))).find((sql) => sql.includes(' AS payment_open')) ?? ''
      const asked = detail.slice(detail.indexOf('(EXISTS (SELECT 1 FROM pending_reader_payments p WHERE '), detail.indexOf(' AS payment_open'))
      expect(asked).toMatch(/^\(EXISTS \(SELECT 1 FROM pending_reader_payments p WHERE p\.record_id = b\.id AND p\.flow IN \('move', 'settle', 'add_guest'\) AND p\.status = 'pending'\) OR EXISTS \( SELECT 1 FROM orders paying /)
      expect(on[1]).toContain(`AND NOT ${asked} RETURNING b.id, b.checked_in_at`)

      const off = await statementsOf((watched) => setBookingCheckedIn(watched, id, false, press()))
      expect(off[0]).toMatch(/^UPDATE bookings SET checked_in_at = NULL, updated_at = now\(\) WHERE id = \$1::uuid AND status <> 'cancelled' /)
      expect(off).toHaveLength(2)
    })
  })

  it('a cancelled booking is refused both ways, and nothing is written', async () => {
    const { id } = await bookingOn(await sessionAt(JULY_1), sam, { status: 'cancelled', cancelled_at: '2027-06-20 09:00:00+00', checked_in_at: '2027-06-19 09:00:00+00' })
    const cancelled = { status: 409, reason: 'booking_cancelled', words: WORDS.cancelledCheckIn }
    expect(refusedWith(await checkIn(id, true))).toEqual(cancelled)
    expect(refusedWith(await checkIn(id, false))).toEqual(cancelled)
    expect((await bookingNow(id))?.checked_in_at).toBe('2027-06-19T09:00:00.000Z')
    expect(await flagRows()).toEqual([])
  })

  it.each(['pending', 'confirmed', 'completed', 'no-show'])('a %s booking can be checked in and out', async (status) => {
    const { id } = await bookingOn(await sessionAt(JULY_1), sam, { status })
    expect((await checkIn(id, true)).status).toBe(200)
    expect((await checkIn(id, false)).status).toBe(200)
  })

  it('a booking that is not there, an id that is not one, an inactive account, a sign-in with no staff row, a call with no key', async () => {
    const { id } = await bookingOn(await sessionAt(JULY_1), sam)
    const notFound = { status: 404, reason: 'booking_not_found', words: WORDS.bookingNotFound }
    expect(refusedWith(await checkIn(UNKNOWN_ID, true))).toEqual(notFound)
    expect(refusedWith(await checkIn('not-an-id', false))).toEqual(notFound)
    expect([(await checkIn(id, true, INA)).status, (await checkIn(id, true, INA)).error?.message]).toEqual([403, INACTIVE])
    expect([(await checkIn(id, true, NOBODY)).status, (await checkIn(id, true, NOBODY)).error?.message]).toEqual([401, NO_STAFF_ROW])
    expect((await pressRoute(checkInRoute, 'POST', { email: JO, params: { bookingId: id }, body: { checkedIn: true }, key: null })).ok).toBe(false)
    expect((await bookingNow(id))?.checked_in_at).toBeNull()
    expect(await flagRows()).toEqual([])
    // A sign-in spelt with capitals is the same staff member.
    expect((await checkIn(id, true, 'TIA@example.com')).status).toBe(200)
    expect((await flagRows()).map((row) => row.actor_id)).toEqual([tia])
  })
})

describe("a guest's waiver (POST bookings/guests/:guestId/waiver; GB17, W48 review L2)", () => {
  const GUEST_FIELDS = ['booking_id', 'created_at', 'date_of_birth', 'guest_email', 'guest_name', 'guest_type', 'id', 'pay_by', 'reminder_sent_at', 'unit_price', 'waiver_accepted', 'waiver_accepted_at', 'waiver_method', 'waiver_version']

  it('signs in person (version v1 unless one is given, trimmed), signs by emailed link, and revokes; the answer is the guest\'s row by named fields', async () => {
    const { id, guests } = await bookingOn(await sessionAt(JULY_1), sam, {}, ['Sam Test', 'Alex Guest'])
    const signed = await waiver(guests[0] ?? '', { accepted: true, waiverMethod: 'in_person' }, TIA)
    expect(signed.status).toBe(200)
    expect(Object.keys(signed.data ?? {}).sort()).toEqual(GUEST_FIELDS)
    expect(signed.data).toMatchObject({ id: guests[0], booking_id: id, guest_name: 'Sam Test', waiver_accepted: true, waiver_method: 'in_person', waiver_version: 'v1', date_of_birth: '1990-01-01', unit_price: '20.00' })
    expect(typeof signed.data?.['waiver_accepted_at']).toBe('string')

    const byLink = await waiver(guests[1] ?? '', { accepted: true, waiverMethod: 'email_link', waiverVersion: ' v2 ' })
    expect(byLink.data).toMatchObject({ waiver_accepted: true, waiver_method: 'email_link', waiver_version: 'v2' })
    expect((await waiver(guests[1] ?? '', { accepted: true, waiverMethod: 'in_person', waiverVersion: '   ' })).status).toBe(200)

    const revoked = await waiver(guests[0] ?? '', { accepted: false })
    expect(revoked.data).toMatchObject({ id: guests[0], waiver_accepted: false, waiver_method: null, waiver_version: null, waiver_accepted_at: null })
    expect(await guestNow(guests[0] ?? '')).toEqual({ waiver_accepted: false, waiver_method: null, waiver_version: null, waiver_accepted_at: null })
  })

  it('each press has its audit row: who, which way, and the waiver as set; never a name, an email or a date of birth', async () => {
    const { id, guests } = await bookingOn(await sessionAt(JULY_1), sam)
    const key = crypto.randomUUID()
    await waiver(guests[0] ?? '', { accepted: true, waiverMethod: 'in_person' }, TIA, key)
    await waiver(guests[0] ?? '', { accepted: false })
    const rows = await flagRows()
    expect(rows.map((row) => [row.action, row.actor_id, row.entity_type, row.entity_id, row.details['accepted']])).toEqual([
      ['booking.guest_waiver_set', tia, 'booking_guest', guests[0], true],
      ['booking.guest_waiver_set', jo, 'booking_guest', guests[0], false],
    ])
    expect(rows[0]?.details).toMatchObject({ after: { booking_id: id, waiver_accepted: true, waiver_method: 'in_person', waiver_version: 'v1' }, key })
    expect(rows[1]?.details.after).toEqual({ booking_id: id, waiver_accepted: false, waiver_method: null, waiver_version: null, waiver_accepted_at: null })
    expect(JSON.stringify(rows)).not.toMatch(/Sam Test|sam@example\.com|1990-01-01/)
  })

  it('a waiver already signed keeps how and when it was signed when Mark Signed is pressed again', async () => {
    const { guests } = await bookingOn(await sessionAt(JULY_1), sam)
    const first = await waiver(guests[0] ?? '', { accepted: true, waiverMethod: 'email_link', waiverVersion: 'v2' })
    await new Promise((resolve) => setTimeout(resolve, 5))
    const again = await waiver(guests[0] ?? '', { accepted: true, waiverMethod: 'in_person' })
    expect(again.data).toMatchObject({ waiver_method: 'email_link', waiver_version: 'v2', waiver_accepted_at: first.data?.['waiver_accepted_at'] })
  })

  it('accepting needs a method staff may record: none, and the website\'s `checkout`, are refused in the old words before anything is read', async () => {
    const { guests } = await bookingOn(await sessionAt(JULY_1), sam)
    const OLD_WORDS = 'waiverMethod must be "email_link" or "in_person" when accepting a waiver'
    const invalid = { status: 400, reason: 'invalid_waiver_method', words: OLD_WORDS }
    expect(refusedWith(await waiver(guests[0] ?? '', { accepted: true }))).toEqual(invalid)
    expect(refusedWith(await waiver(guests[0] ?? '', { accepted: true, waiverMethod: 'checkout' }))).toEqual(invalid)
    expect(refusedWith(await waiver(guests[0] ?? '', { accepted: true, waiverMethod: 7 }))).toEqual(invalid)
    expect((await guestNow(guests[0] ?? ''))?.['waiver_accepted']).toBe(false)
    expect(await flagRows()).toEqual([])
  })

  it('a cancelled booking\'s waivers can\'t be changed, either way; a Payment needed booking\'s can, both ways', async () => {
    const cancelled = await bookingOn(await sessionAt(JULY_1), sam, { status: 'cancelled' }, ['Sam Test', 'Alex Guest'])
    await db.query("UPDATE booking_guests SET waiver_accepted = true, waiver_method = 'in_person', waiver_version = 'v1', waiver_accepted_at = now() WHERE id = $1", [cancelled.guests[1]])
    const refusal = { status: 409, reason: 'booking_cancelled', words: WORDS.cancelledWaiver }
    expect(refusedWith(await waiver(cancelled.guests[0] ?? '', { accepted: true, waiverMethod: 'in_person' }))).toEqual(refusal)
    expect(refusedWith(await waiver(cancelled.guests[1] ?? '', { accepted: false }))).toEqual(refusal)
    expect((await guestNow(cancelled.guests[0] ?? ''))?.['waiver_accepted']).toBe(false)
    expect((await guestNow(cancelled.guests[1] ?? ''))?.['waiver_accepted']).toBe(true)
    expect(await flagRows()).toEqual([])

    const unpaid = await bookingOn(await sessionAt(JULY_2), mo, { status: 'payment_needed' }, ['Mo Member'])
    expect((await waiver(unpaid.guests[0] ?? '', { accepted: true, waiverMethod: 'in_person' })).status).toBe(200)
    expect((await waiver(unpaid.guests[0] ?? '', { accepted: false })).status).toBe(200)
  })

  it('a guest who is not there, an id that is not one, an inactive account, a sign-in with no staff row; capitals are fine', async () => {
    const { guests } = await bookingOn(await sessionAt(JULY_1), sam)
    const sign = { accepted: true, waiverMethod: 'in_person' }
    const notFound = { status: 404, reason: 'guest_not_found', words: WORDS.guestNotFound }
    expect(refusedWith(await waiver(UNKNOWN_ID, sign))).toEqual(notFound)
    expect(refusedWith(await waiver('not-an-id', { accepted: false }))).toEqual(notFound)
    expect([(await waiver(guests[0] ?? '', sign, INA)).status, (await waiver(guests[0] ?? '', sign, INA)).error?.message]).toEqual([403, INACTIVE])
    expect([(await waiver(guests[0] ?? '', sign, NOBODY)).status, (await waiver(guests[0] ?? '', sign, NOBODY)).error?.message]).toEqual([401, NO_STAFF_ROW])
    expect((await guestNow(guests[0] ?? ''))?.['waiver_accepted']).toBe(false)
    expect((await waiver(guests[0] ?? '', sign, 'JO@EXAMPLE.COM')).status).toBe(200)
  })

  it('W48 review L2: the press holds the guest\'s booking FOR SHARE before its own statement, and that is the first thing it does', async () => {
    const { guests } = await bookingOn(await sessionAt(JULY_1), sam)
    const actor: AdminActor = { type: 'staff', id: jo, role: 'admin', canManagePricing: true, canIssueRefunds: true }
    const statements = await statementsOf((watched) => setGuestWaiver(watched, guests[0] ?? '', { accepted: true, waiverMethod: 'in_person' }, { channel: 'staff', actor, requestId: crypto.randomUUID(), pressKey: crypto.randomUUID() }))
    expect(statements[0]).toBe('SELECT b.id FROM bookings b WHERE b.id = (SELECT bg.booking_id FROM booking_guests bg WHERE bg.id = $1::uuid) FOR SHARE OF b')
    expect(statements[1]).toMatch(/^UPDATE booking_guests bg /)
    expect(statements[1]).toContain("b.status <> 'cancelled'")
    expect(statements).toHaveLength(3)
    expect(statements[2]).toMatch(/^INSERT INTO audit_log /)
  })
})

describe('an add-on marked prepared (POST bookings/addon-lines/:lineId/prepared; GB17, W48 review L2)', () => {
  const LINE_FIELDS = ['addon_id', 'booking_id', 'card_refunded_amount', 'created_at', 'id', 'order_id', 'prepared', 'prepared_at', 'prepared_by', 'price_at_purchase', 'quantity', 'redeemed_membership_id', 'redemption_source', 'refund_method', 'refunded_amount', 'removed_at', 'removed_by', 'sku_at_purchase', 'stripe_price_id']

  it('marks it prepared with who and when, and un-marks it; the answer is the line by named fields; each press has its audit row', async () => {
    const { id } = await bookingOn(await sessionAt(JULY_1), sam)
    const line = await towelOn(id)
    const key = crypto.randomUUID()
    const on = await prepared(line, true, TIA, key)
    expect(on.status).toBe(200)
    expect(Object.keys(on.data ?? {}).sort()).toEqual(LINE_FIELDS)
    expect(on.data).toMatchObject({ id: line, booking_id: id, addon_id: towel, quantity: 1, price_at_purchase: '5.00', sku_at_purchase: 'TOWEL', prepared: true, prepared_by: tia, refunded_amount: '0.00', card_refunded_amount: '0.00', removed_at: null })
    expect(typeof on.data?.['prepared_at']).toBe('string')

    const off = await prepared(line, false)
    expect(off.data).toMatchObject({ id: line, prepared: false, prepared_at: null, prepared_by: null })
    expect(await lineNow(line)).toEqual({ prepared: false, prepared_by: null, prepared_at: null })

    const rows = await flagRows()
    expect(rows.map((row) => [row.action, row.actor_id, row.entity_type, row.entity_id, row.details['prepared']])).toEqual([
      ['booking.addon_prepared_set', tia, 'addon_order_line', line, true],
      ['booking.addon_prepared_set', jo, 'addon_order_line', line, false],
    ])
    expect(rows[0]?.details).toMatchObject({ after: { booking_id: id, prepared: true, prepared_by: tia }, key })
    expect(rows[1]?.details.after).toEqual({ booking_id: id, prepared: false, prepared_by: null, prepared_at: null })
  })

  it('an add-on already prepared keeps who prepared it and when if it is ticked again by someone else', async () => {
    const line = await towelOn((await bookingOn(await sessionAt(JULY_1), sam)).id)
    const first = await prepared(line, true, TIA)
    await new Promise((resolve) => setTimeout(resolve, 5))
    const again = await prepared(line, true, JO)
    expect(again.data).toMatchObject({ prepared: true, prepared_by: tia, prepared_at: first.data?.['prepared_at'] })
  })

  it('GB17: an add-on already removed from its booking can\'t be marked prepared, or un-marked', async () => {
    const line = await towelOn((await bookingOn(await sessionAt(JULY_1), sam)).id, { removed_at: '2027-06-30 09:00:00+00', removed_by: jo, prepared: true, prepared_by: tia, prepared_at: '2027-06-29 09:00:00+00' })
    const refusal = { status: 409, reason: 'addon_removed', words: WORDS.removedAddonPrepared }
    expect(refusedWith(await prepared(line, true))).toEqual(refusal)
    expect(refusedWith(await prepared(line, false))).toEqual(refusal)
    expect(await lineNow(line)).toMatchObject({ prepared: true, prepared_by: tia })
    expect(await flagRows()).toEqual([])
  })

  it('a cancelled booking\'s add-ons can\'t be ticked or un-ticked; a Payment needed booking\'s can, both ways', async () => {
    const cancelled = await bookingOn(await sessionAt(JULY_1), sam, { status: 'cancelled' })
    const line = await towelOn(cancelled.id)
    const tickedBefore = await towelOn(cancelled.id, { prepared: true, prepared_by: tia, prepared_at: '2027-06-29 09:00:00+00' })
    const refusal = { status: 409, reason: 'booking_cancelled', words: WORDS.cancelledPrepared }
    expect(refusedWith(await prepared(line, true))).toEqual(refusal)
    expect(refusedWith(await prepared(tickedBefore, false))).toEqual(refusal)
    expect((await lineNow(line))?.['prepared']).toBe(false)
    expect((await lineNow(tickedBefore))?.['prepared']).toBe(true)
    expect(await flagRows()).toEqual([])
    // Cancelled comes before removed: the booking is the first thing wrong.
    const both = await towelOn(cancelled.id, { removed_at: '2027-06-30 09:00:00+00' })
    expect(refusedWith(await prepared(both, true))).toEqual(refusal)

    const unpaid = await towelOn((await bookingOn(await sessionAt(JULY_2), mo, { status: 'payment_needed' }, ['Mo Member'])).id)
    expect((await prepared(unpaid, true)).status).toBe(200)
    expect((await prepared(unpaid, false)).status).toBe(200)
  })

  it('a line that is not there, an id that is not one, an inactive account, a sign-in with no staff row (un-ticking too, which the old function let through); capitals are fine', async () => {
    const line = await towelOn((await bookingOn(await sessionAt(JULY_1), sam)).id)
    const notFound = { status: 404, reason: 'addon_line_not_found', words: WORDS.addonLineNotFound }
    expect(refusedWith(await prepared(UNKNOWN_ID, true))).toEqual(notFound)
    expect(refusedWith(await prepared('not-an-id', false))).toEqual(notFound)
    expect([(await prepared(line, true, INA)).status, (await prepared(line, true, INA)).error?.message]).toEqual([403, INACTIVE])
    for (const on of [true, false]) expect([(await prepared(line, on, NOBODY)).status, (await prepared(line, on, NOBODY)).error?.message]).toEqual([401, NO_STAFF_ROW])
    expect((await lineNow(line))?.['prepared']).toBe(false)
    expect((await prepared(line, true, 'Tia@Example.com')).data?.['prepared_by']).toBe(tia)
  })

  it('W48 review L2: the press holds the line\'s booking FOR SHARE before its own statement, and that is the first thing it does', async () => {
    const line = await towelOn((await bookingOn(await sessionAt(JULY_1), sam)).id)
    const { setAddonLinePrepared } = await import('./admin')
    const actor: AdminActor = { type: 'staff', id: jo, role: 'admin', canManagePricing: true, canIssueRefunds: true }
    for (const on of [true, false]) {
      const statements = await statementsOf((watched) => setAddonLinePrepared(watched, line, on, { actor, requestId: crypto.randomUUID(), pressKey: crypto.randomUUID() }))
      expect(statements[0]).toBe('SELECT b.id FROM bookings b WHERE b.id = (SELECT aol.booking_id FROM addon_order_lines aol WHERE aol.id = $1::uuid) FOR SHARE OF b')
      expect(statements[1]).toMatch(/^UPDATE addon_order_lines aol /)
      expect(statements[1]).toContain("b.status <> 'cancelled' AND aol.removed_at IS NULL")
      expect(statements).toHaveLength(3)
    }
  })
})

describe('the waiver rule for the website (brief item 7; G-plan 4.8; backend log 12 and 18): the rule only, no route', () => {
  const byCustomer = (customerId: string) => ({ channel: 'customer' as const, customerId, requestId: crypto.randomUUID(), pressKey: crypto.randomUUID() })
  const byStaff = () => ({ channel: 'staff' as const, actor: { type: 'staff' as const, id: jo, role: 'admin' as const, canManagePricing: true, canIssueRefunds: true }, requestId: crypto.randomUUID(), pressKey: crypto.randomUUID() })
  const link = { accepted: true, waiverMethod: 'email_link' }
  /** A session that ended an hour ago on London's wall clock, and one that ends in an hour. */
  const sessionEnding = async (hoursFromNow: number) => {
    const [row] = await db.query<{ start_time: string; end_time: string }>(
      `SELECT to_char((now() AT TIME ZONE 'Europe/London') + ($1 || ' hours')::interval - interval '1 hour', 'YYYY-MM-DD HH24:MI:SS') || '+00' AS start_time,
              to_char((now() AT TIME ZONE 'Europe/London') + ($1 || ' hours')::interval, 'YYYY-MM-DD HH24:MI:SS') || '+00' AS end_time`,
      [String(hoursFromNow)]
    )
    return fixtures.session(db, { service_type_id: sauna, band_id: band, start_time: row?.start_time, end_time: row?.end_time })
  }

  it('the methods are in one place: staff may record in person or the emailed link; a customer only the emailed link (the website adds `checkout`); the table allows exactly the staff two', () => {
    expect(WAIVER_METHODS).toEqual({ staff: ['in_person', 'email_link'], customer: ['email_link'] })
    const schema = readFileSync(path.join(__dirname, '../testing/live-schema.sql'), 'utf8')
    expect(schema).toContain("booking_guests_waiver_method_check CHECK ((waiver_method = ANY (ARRAY['email_link'::text, 'in_person'::text])))")
    for (const method of WAIVER_METHODS.customer) expect(WAIVER_METHODS.staff as readonly string[]).toContain(method)
  })

  it("a customer signs a guest's waiver on their own booking by the emailed link; the audit row says the customer did", async () => {
    const { id, guests } = await bookingOn(await sessionEnding(48), sam, {}, ['Sam Test', 'Alex Guest'])
    const signed = await setGuestWaiver(db, guests[1] ?? '', link, byCustomer(sam))
    expect(signed).toMatchObject({ id: guests[1], waiver_accepted: true, waiver_method: 'email_link', waiver_version: 'v1' })
    const rows = await flagRows()
    expect(rows.map((row) => [row.action, row.actor_type, row.actor_id, row.entity_id, row.details['channel']])).toEqual([['booking.guest_waiver_set', 'customer', sam, guests[1], 'customer']])
    expect(rows[0]?.details.after).toMatchObject({ booking_id: id, waiver_method: 'email_link' })
  })

  it("another customer's guest: refused, told nothing about the booking, and nothing is written (even when that booking is cancelled or over)", async () => {
    const mos = await bookingOn(await sessionEnding(48), mo, {}, ['Mo Member'])
    const notTheirs = { status: 403, reason: 'not_their_booking', words: WORDS.customerNotTheirBooking }
    expect(await refusalOf(setGuestWaiver(db, mos.guests[0] ?? '', link, byCustomer(sam)))).toEqual(notTheirs)
    await setStatus(mos.id, 'cancelled')
    expect(await refusalOf(setGuestWaiver(db, mos.guests[0] ?? '', link, byCustomer(sam)))).toEqual(notTheirs)
    expect((await guestNow(mos.guests[0] ?? ''))?.['waiver_accepted']).toBe(false)
    expect(await flagRows()).toEqual([])
  })

  it('the emailed link stops working once the booking is cancelled, and once the session has passed; staff can still record a waiver after the session', async () => {
    const cancelled = await bookingOn(await sessionEnding(48), sam, { status: 'cancelled' })
    expect(await refusalOf(setGuestWaiver(db, cancelled.guests[0] ?? '', link, byCustomer(sam)))).toEqual({ status: 409, reason: 'booking_cancelled', words: WORDS.cancelledWaiver })

    const over = await bookingOn(await sessionEnding(-1), mo, {}, ['Mo Member'])
    expect(await refusalOf(setGuestWaiver(db, over.guests[0] ?? '', link, byCustomer(mo)))).toEqual({ status: 409, reason: 'session_passed', words: WORDS.customerSessionPassed })
    expect((await guestNow(over.guests[0] ?? ''))?.['waiver_accepted']).toBe(false)
    // Staff, on the same guest, after the session: recorded.
    expect(await setGuestWaiver(db, over.guests[0] ?? '', { accepted: true, waiverMethod: 'in_person' }, byStaff())).toMatchObject({ waiver_accepted: true, waiver_method: 'in_person' })

    // A session still going on (it ends in half an hour) has not passed.
    const underWay = await bookingOn(await sessionEnding(0.5), ali, {}, ['Ali Early'])
    expect(await setGuestWaiver(db, underWay.guests[0] ?? '', link, byCustomer(ali))).toMatchObject({ waiver_accepted: true })
  })

  // Brief W50a item 4a (W50 review L6a).
  it("W50a: the customer channel's hold names the customer, so a booking that isn't theirs is never locked; staff's hold is as it was", async () => {
    const own = await bookingOn(await sessionEnding(48), sam)
    const mos = await bookingOn(await sessionEnding(72), mo, {}, ['Mo Member'])
    const OWN_HOLD = 'SELECT b.id FROM bookings b WHERE b.id = (SELECT bg.booking_id FROM booking_guests bg WHERE bg.id = $1::uuid) AND b.customer_id = $2::uuid FOR SHARE OF b'

    // Their own guest: the hold is the first statement, limited to their own bookings, and it finds the booking.
    const signing = await statementsOf((watched) => setGuestWaiver(watched, own.guests[0] ?? '', link, byCustomer(sam)))
    expect(signing[0]).toBe(OWN_HOLD)
    expect(signing[1]).toMatch(/^UPDATE booking_guests bg /)
    expect(signing).toHaveLength(3)
    expect(await db.query(OWN_HOLD, [own.guests[0] ?? '', sam])).toEqual([{ id: own.id }])

    // Someone else's guest: the same statement finds no row, so there is nothing for it to lock; then refused.
    let refused: unknown
    const pressing = await statementsOf(async (watched) => {
      refused = await refusalOf(setGuestWaiver(watched, mos.guests[0] ?? '', link, byCustomer(sam)))
    })
    expect(refused).toEqual({ status: 403, reason: 'not_their_booking', words: WORDS.customerNotTheirBooking })
    expect(pressing[0]).toBe(OWN_HOLD)
    expect(await db.query(OWN_HOLD, [mos.guests[0] ?? '', sam])).toEqual([])
    expect(await db.query(OWN_HOLD, [mos.guests[0] ?? '', mo])).toEqual([{ id: mos.id }])
    // No statement of the press names the booking without the customer: the old hold is not sent on this channel.
    expect(pressing.filter((sql) => sql.includes('FOR SHARE')).every((sql) => sql.includes('b.customer_id = $2::uuid'))).toBe(true)

    // Staff: the hold has no customer in it (a staff member may record any guest's waiver).
    const staffSigning = await statementsOf((watched) => setGuestWaiver(watched, mos.guests[0] ?? '', { accepted: true, waiverMethod: 'in_person' }, byStaff()))
    expect(staffSigning[0]).toBe('SELECT b.id FROM bookings b WHERE b.id = (SELECT bg.booking_id FROM booking_guests bg WHERE bg.id = $1::uuid) FOR SHARE OF b')
  })

  // Brief W50a item 4b (W50 review L6b).
  it('W50a: each flag says which channels it accepts: a customer is refused Check In, its undo and the prepared tick before anything is read, key or no key; only a waiver accepts one', async () => {
    const { id, guests } = await bookingOn(await sessionEnding(48), sam)
    const line = await towelOn(id)
    const { setAddonLinePrepared, setBookingCheckedIn } = await import('./admin')
    const notAccepted = { status: 403, reason: 'channel_not_accepted', words: FLAG_CHANNEL_NOT_ACCEPTED_MESSAGE }
    expect(FLAG_CHANNEL_NOT_ACCEPTED_MESSAGE).toBe("This can't be changed from here.")
    // The booking's own customer, passed where only a staff member belongs (no route does: the type forbids it).
    const asCustomer = (pressKey: string | null) => ({ actor: { type: 'customer', id: sam } as unknown as AdminActor, requestId: crypto.randomUUID(), pressKey })

    for (const pressKey of [crypto.randomUUID(), null]) {
      const outcomes: unknown[] = []
      const sent = await statementsOf(async (watched) => {
        outcomes.push(await refusalOf(setBookingCheckedIn(watched, id, true, asCustomer(pressKey))))
        outcomes.push(await refusalOf(setBookingCheckedIn(watched, id, false, asCustomer(pressKey))))
        outcomes.push(await refusalOf(setAddonLinePrepared(watched, line, true, asCustomer(pressKey))))
        outcomes.push(await refusalOf(setAddonLinePrepared(watched, line, false, asCustomer(pressKey))))
      })
      expect(outcomes).toEqual([notAccepted, notAccepted, notAccepted, notAccepted])
      // Refused at the start: not one statement was sent, so nothing was locked, read or written.
      expect(sent).toEqual([])
    }
    expect((await bookingNow(id))?.checked_in_at).toBeNull()
    expect((await lineNow(line))?.['prepared']).toBe(false)
    expect(await flagRows()).toEqual([])

    // A waiver is the one flag that accepts both.
    expect(await setGuestWaiver(db, guests[0] ?? '', link, byCustomer(sam))).toMatchObject({ waiver_accepted: true })
    expect(await setGuestWaiver(db, guests[0] ?? '', { accepted: false }, byStaff())).toMatchObject({ waiver_accepted: false })
    // In the code: `channels` is said once for each flag, and "customer" only for the waiver.
    const source = readFileSync(path.join(__dirname, 'admin.ts'), 'utf8')
    expect(source.match(/^ +channels: \[.*\],$/gm)).toEqual(["      channels: ['staff'],", "      channels: ['staff', 'customer'],", "      channels: ['staff'],"])
  })

  it('a customer can\'t claim it was signed in person, can\'t use a method that isn\'t one, and can\'t withdraw a signed waiver', async () => {
    const { guests } = await bookingOn(await sessionEnding(48), sam)
    const method = { status: 400, reason: 'waiver_method_not_allowed', words: WORDS.customerWaiverMethod }
    expect(await refusalOf(setGuestWaiver(db, guests[0] ?? '', { accepted: true, waiverMethod: 'in_person' }, byCustomer(sam)))).toEqual(method)
    expect(await refusalOf(setGuestWaiver(db, guests[0] ?? '', { accepted: true, waiverMethod: 'checkout' }, byCustomer(sam)))).toEqual(method)
    expect(await refusalOf(setGuestWaiver(db, guests[0] ?? '', { accepted: true }, byCustomer(sam)))).toEqual(method)
    await setGuestWaiver(db, guests[0] ?? '', link, byCustomer(sam))
    expect(await refusalOf(setGuestWaiver(db, guests[0] ?? '', { accepted: false }, byCustomer(sam)))).toEqual({ status: 403, reason: 'customer_cannot_revoke', words: WORDS.customerCannotRevoke })
    expect((await guestNow(guests[0] ?? ''))?.['waiver_accepted']).toBe(true)
  })
})

describe("W50's new words and reasons", () => {
  it('are exactly these (each is new: the old flag functions refused nothing about the booking)', () => {
    expect(BOOKING_ADMIN_NEW_WORDS).toEqual({
      paymentNeededCheckIn: 'This booking needs payment first. Use Take Payment.',
      paymentOpenCheckIn: 'A payment on this booking is still going through. Check in once it has completed.',
      cancelledCheckIn: "This booking is cancelled, so it can't be checked in and its check-in can't be undone.",
      cancelledWaiver: "This booking is cancelled, so its guests' waivers can no longer be changed.",
      cancelledPrepared: 'This booking is cancelled, so its add-ons can no longer be marked prepared or not prepared.',
      removedAddonPrepared: "This add-on has been removed from the booking, so it can't be marked prepared or not prepared.",
      bookingNotFound: 'That booking no longer exists. Reload the page and try again.',
      guestNotFound: 'That guest is no longer on the booking. Reload the page and try again.',
      addonLineNotFound: 'That add-on is no longer on the booking. Reload the page and try again.',
      bookingChanged: 'The booking changed while this was being saved, so nothing was changed. Reload the page and try again.',
      customerNotTheirBooking: "This guest isn't on one of your bookings, so you can't sign their waiver here.",
      customerSessionPassed: 'This session has already taken place, so the waiver can no longer be signed online. Please speak to the team at the club.',
      customerCannotRevoke: 'A signed waiver can only be withdrawn by the team at the club.',
      customerWaiverMethod: "That isn't a way a waiver can be signed online.",
    })
    expect(BOOKING_FLAG_REASONS.notFound).toEqual(['booking_not_found', 'guest_not_found', 'addon_line_not_found'])
    // W50a: `payment_open` is thrown in the Worker's words, like Q49's.
    expect(BOOKING_FLAG_REASONS.refused).toEqual(['booking_cancelled', 'payment_needed', 'payment_open', 'addon_removed', 'invalid_waiver_method', 'booking_changed'])
    // The words on the booking window's button, which Q49's sentence now names.
    expect(readFileSync(path.join(staffAppDir(), 'frontend/components/SettleLapsedPaymentDialog.tsx'), 'utf8')).toContain('Take Payment')
  })

  it("the staff app's three flag functions answer null for exactly the three \"not there\" reasons, and for no other", () => {
    const source = (name: string) => readFileSync(path.join(staffAppDir(), 'backend/paddock', `${name}.ts`), 'utf8')
    expect(source('setBookingCheckedIn')).toContain("press.failure.reason === 'booking_not_found') return null")
    expect(source('setGuestWaiverStatus')).toContain("press.failure.reason === 'guest_not_found') return null")
    expect(source('setAddonLinePrepared')).toContain("press.failure.reason === 'addon_line_not_found') return null")
    for (const name of ['setBookingCheckedIn', 'setGuestWaiverStatus', 'setAddonLinePrepared']) expect(source(name).match(/return null/g)).toHaveLength(1)
  })
})
