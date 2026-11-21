import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST as activeRoute } from '@/app/api/v1/staff/catalog/events/[eventId]/active/route'
import { POST as detailsRoute } from '@/app/api/v1/staff/catalog/events/[eventId]/details/route'
import { GET as eventsRoute } from '@/app/api/v1/staff/catalog/events/route'
import { GET as attendeesRoute } from '@/app/api/v1/staff/events/[eventId]/attendees/route'
import { POST as undoRoute } from '@/app/api/v1/staff/events/attendees/[attendeeId]/check-in/undo/route'
import { POST as waiverRoute } from '@/app/api/v1/staff/events/attendees/[attendeeId]/waiver/route'
import { POST as checkInRoute } from '@/app/api/v1/staff/events/attendees/check-in/route'
import { GET as todayRoute } from '@/app/api/v1/staff/events/today/route'
import { adminGetEventsOutputSchema, type AdminGetTodaysEventsOutput, type EventAttendeeState, type EventAttendeesRouteOutput, type EventCheckInRouteOutput, type EventDetailsRouteOutput, type EventListRouteOutput } from '@/contracts'
import type { Db } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import { FLAG_CHANNEL_NOT_ACCEPTED_MESSAGE } from '@/server/rules/admin/flag'
import type { AdminActor } from '@/server/rules/admin/refusal'
import { CHANGED_SINCE_WORDS } from '@/server/rules/admin/stamp'
import { cutoffInForce, cutoffToKeep, EVENT_DETAILS_COLUMNS, eventTimeWords, upToTheMinute } from '@/server/rules/catalog/events'
import { BOOKING_CLAIMS, EVENT_BOOKING_CLAIMS, ORDER_CLAIMS } from '@/server/rules/refunds/pipeline'
import { STAFF_ADMIN_WORDS } from '@/server/rules/staff/failure-messages'
import { ADMIN_TEST_KEY, auditRowsOf, pressRoute, type AdminAnswer, type AdminRouteHandler } from '@/server/rules/testing/admin-routes'
import { fixtures, freezeNow, insert, startTestDatabase, unfreezeNow, type TestDatabase } from '@/server/rules/testing/database'
import { WAIVER_METHODS } from '@/server/rules/waivers/methods'
import { EVENT_ADMIN_NEW_REASONS, EVENT_ADMIN_NEW_WORDS, EVENT_ADMIN_WORDS } from './admin-failure-messages'
import { checkInEventAttendees, getTodaysEvents, MAX_ATTENDEES_PER_CHECK_IN, setEventAttendeeWaiver, undoEventAttendeeCheckIn, type EventWaiverPress } from './attendance'
import { EVENT_WHOLE_CANCEL_NEW_WORDS } from './failure-messages'

vi.setConfig({ testTimeout: 60_000 })

// Brief W52 ("Parity and tests"; G-plan 5, W52's tests): Catalog → Events, the attendee list, today's events and the
// event day's three flags on the live schema, through the real routes. Every refusal and constraint with its words;
// an edit with places sold (Q51: the cut-off earlier refused, later allowed, price and date changes) and the stale
// page; the check-in window's three states; an older extra waiver version; London dates; the customer channel's
// waiver rule; money owed on a cancelled booking (F1) and a refund still being checked (row 18). The races with a
// place cancel, on two connections, are in attendance-postgres.test.ts; the old functions' recordings replay in
// testing/replay/event-admin-replay.test.ts.

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))

const JO = 'jo@example.com'
const TIA = 'tia@example.com'
const INA = 'ina@example.com'
const NOBODY = 'nobody@example.com'
const OLD = EVENT_ADMIN_WORDS
const NEW = EVENT_ADMIN_NEW_WORDS
const INACTIVE = STAFF_ADMIN_WORDS.staffAccess.staffAccountInactiveAskAdminReactivate
const NO_STAFF_ROW = STAFF_ADMIN_WORDS.staffAccess.noStaffRecordMatchesLoggedIn(NOBODY)
const NO_PRICING = STAFF_ADMIN_WORDS.pricingStaff.youDoNotHavePermissionManage
const UNKNOWN_ID = '10000000-0000-4000-8000-000000000f52'

let database: TestDatabase
let db: Db
let jo = ''
let tia = ''
let sam = ''
let mo = ''
let frozen = false

beforeAll(async () => {
  process.env.STAFF_API_KEY = ADMIN_TEST_KEY
  database = await startTestDatabase({ schema: 'live' })
  db = database.db
  holder.db = db
})
afterAll(() => database.stop())

/** Jo (admin, with Manage pricing and Issue refunds), Tia (staff, neither) and Ina (inactive); Sam and Mo. */
beforeEach(async () => {
  await database.pg.exec('RESET ROLE; TRUNCATE audit_log, api_idempotency, event_attendees, event_bookings, order_line_items, orders, events, customers, staff CASCADE; SET ROLE paddock_worker;')
  jo = await insert(db, 'staff', { role: 'admin', first_name: 'Jo', last_name: 'Staff', email: JO, can_issue_refunds: true, can_manage_pricing: true })
  tia = await insert(db, 'staff', { role: 'staff', first_name: 'Tia', last_name: 'Team', email: TIA })
  await insert(db, 'staff', { role: 'staff', first_name: 'Ina', last_name: 'Gone', email: INA, active: false })
  sam = await fixtures.customer(db, { first_name: 'Sam', last_name: 'Test', email: 'sam@example.com' })
  mo = await fixtures.customer(db, { first_name: 'Mo', last_name: 'Member', email: 'mo@example.com' })
})
afterEach(async () => {
  if (frozen) await unfreezeNow(database.pg)
  frozen = false
})

/** The database's clock set to an instant (UTC), until the test ends. */
async function nowIs(instant: string): Promise<void> {
  await freezeNow(database.pg, instant)
  frozen = true
}

// The fixture event: Friday 15 June 2099, 18:00 to 20:00 (London wall-clock digits labelled UTC), cut-off the day
// before at 18:00, room for 10, on sale at £40 / £30 / £20. June is summer time: London's wall clock is UTC + 1.
const START = '2099-06-15T18:00:00.000Z'
const END = '2099-06-15T20:00:00.000Z'
const CUTOFF = '2099-06-14T18:00:00.000Z'
/** London's wall clock reads these on the event's day, as UTC instants. */
const LONDON = {
  eveBefore2330: '2099-06-14 22:30:00+00',
  onTheDay0030: '2099-06-14 23:30:00+00',
  onTheDayNoon: '2099-06-15 11:00:00+00',
  onTheDay2330: '2099-06-15 22:30:00+00',
  dayAfter0030: '2099-06-15 23:30:00+00',
}

const details = { startsAt: START, endsAt: END, capacity: 10, access: 'public', publicReleaseAt: null, pricePublic: 40, pricePreHerd: 30, priceHerd: 20, refundCutoffAt: CUTOFF }

interface Booked {
  bookingId: string
  attendees: string[]
  orderId: string | null
}

/**
 * A confirmed booking on the event for a customer, one £40 place a name (the first the account holder), with the
 * event's places counted. `order`: an order and its event line too (paid on the card), for money owed and claims.
 */
async function booked(eventId: string, customerId: string, names: string[], options: { status?: string; order?: boolean } = {}): Promise<Booked> {
  const status = options.status ?? 'confirmed'
  const bookingId = await insert(db, 'event_bookings', { event_id: eventId, customer_id: customerId, places: names.length, status, price_paid: (40 * names.length).toFixed(2) })
  const attendees: string[] = []
  for (const [i, name] of names.entries()) {
    attendees.push(
      await insert(db, 'event_attendees', {
        event_booking_id: bookingId,
        attendee_type: i === 0 ? 'account_holder' : 'guest',
        name,
        email: `${name.split(' ')[0]?.toLowerCase()}@example.com`,
        date_of_birth: '1990-01-01',
        unit_price: '40.00',
        price_level: 'public',
        created_at: `2099-06-01 09:00:0${i}+00`,
      })
    )
  }
  await db.query('UPDATE events SET places_booked = places_booked + $1 WHERE id = $2', [names.length, eventId])
  let orderId: string | null = null
  if (options.order) {
    orderId = await insert(db, 'orders', { customer_id: customerId, order_total: (40 * names.length).toFixed(2), payment_status: 'paid', stripe_payment_intent_id: `pi_${crypto.randomUUID().slice(0, 8)}`, payment_method: 'card', order_source: 'staff_created' })
    await insert(db, 'order_line_items', { order_id: orderId, item_type: 'event', quantity: names.length, unit_price: '40.00', line_total: (40 * names.length).toFixed(2), event_booking_id: bookingId })
  }
  return { bookingId, attendees, orderId }
}

const get = <T = unknown>(route: AdminRouteHandler, params: Record<string, string> = {}, email: string | null = JO) => pressRoute<T>(route, 'GET', { email, params })
const post = <T = Record<string, unknown>>(route: AdminRouteHandler, params: Record<string, string>, body: unknown, email: string | null = JO, key?: string) => pressRoute<T>(route, 'POST', { email, params, body, ...(key !== undefined ? { key } : {}) })
const refusedWith = (answer: AdminAnswer) => ({ status: answer.status, reason: answer.reason, words: answer.error?.message })
const refusalOf = (press: Promise<unknown>) =>
  press.then(
    () => 'answered',
    (err: unknown) => (err instanceof ApiError ? { status: err.status, reason: (err.details as { reason?: string } | undefined)?.reason, words: err.message } : String(err))
  )

const listEvents = async () => (await get<EventListRouteOutput>(eventsRoute)).data ?? []
const stampOf = async (eventId: string) => (await listEvents()).find((event) => event.id === eventId)?.stamp
/** The edit as the dialog presses it: the stamp the list gave just before, unless the test brings its own. */
const edit = async (eventId: string, change: Record<string, unknown> = {}, email = JO) => post<EventDetailsRouteOutput>(detailsRoute, { eventId }, { ...details, stamp: await stampOf(eventId), ...change }, email)
const eventRow = async (eventId: string) =>
  (
    await db.query<Record<string, unknown>>(
      `SELECT to_char(starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI') AS starts, to_char(refund_cutoff_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI') AS cutoff,
              capacity, price_public::text AS price_public, active, places_booked FROM events WHERE id = $1`,
      [eventId]
    )
  )[0]
const attendeeRow = async (attendeeId: string) =>
  (
    await db.query<Record<string, unknown>>(
      `SELECT checked_in_at IS NOT NULL AS checked_in, waiver_accepted, waiver_method, waiver_version, event_waiver_accepted, event_waiver_method, event_waiver_version,
              unit_price::text AS unit_price FROM event_attendees WHERE id = $1`,
      [attendeeId]
    )
  )[0]
const listOf = async (eventId: string, email: string | null = JO) => get<EventAttendeesRouteOutput>(attendeesRoute, { eventId }, email)
const checkIn = (attendeeIds: unknown, more: Record<string, unknown> = {}, email: string | null = JO, key?: string) => post<EventCheckInRouteOutput>(checkInRoute, {}, { attendeeIds, ...more }, email, key)
const undo = (attendeeId: string, email: string | null = JO) => post<EventAttendeeState>(undoRoute, { attendeeId }, {}, email)
const waiver = (attendeeId: string, body: Record<string, unknown>, email: string | null = JO) => post<EventAttendeeState>(waiverRoute, { attendeeId }, body, email)
const outcomes = (answer: AdminAnswer<EventCheckInRouteOutput>) => (answer.data?.results ?? []).map((one) => (one.updated ? 'checked in' : one.reason))
const signed = { which: 'standard', accepted: true, method: 'in_person' }
const waiverSigned = (attendeeId: string) => db.query("UPDATE event_attendees SET waiver_accepted = true, waiver_method = 'email_link', waiver_version = 'v1', waiver_accepted_at = '2099-06-01 10:00:00+00' WHERE id = $1", [attendeeId])
const staffActor = (id: string): AdminActor => ({ type: 'staff', id, role: 'admin', canManagePricing: true, canIssueRefunds: true })
const eventAuditRows = async () => (await auditRowsOf(db)).filter((row) => row.action.startsWith('event'))

describe('the events list (GET catalog/events)', () => {
  it('lists every event with every field the old read gave, by name, and its stamp: prices as text, moments as ISO text; upcoming first, undated last, then by name', async () => {
    const later = await fixtures.event(db, { name: 'B later', starts_at: '2099-07-01 18:00:00+00', ends_at: null, refund_cutoff_at: '2099-06-30 18:00:00+00' })
    const undated = await fixtures.event(db, { name: 'A undated', starts_at: null, ends_at: null, refund_cutoff_at: null, capacity: null, price_public: null, price_pre_herd: null, price_herd: null, active: false })
    const sooner = await fixtures.event(db, { name: 'C sooner', access: 'members_first', public_release_at: '2099-06-10 09:00:00+00' })
    const rows = await listEvents()
    expect(rows.map((row) => row.id)).toEqual([sooner, later, undated])
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual([...Object.keys(adminGetEventsOutputSchema.element.shape), 'stamp'].sort())
    expect(rows[0]).toMatchObject({
      name: 'C sooner',
      starts_at: START,
      ends_at: END,
      refund_cutoff_at: CUTOFF,
      public_release_at: '2099-06-10T09:00:00.000Z',
      capacity: 10,
      places_booked: 0,
      access: 'members_first',
      price_public: '40.00',
      price_pre_herd: '30.00',
      price_herd: '20.00',
      active: true,
      cancelled_at: null,
    })
    expect(rows[2]).toMatchObject({ starts_at: null, capacity: null, price_public: null, active: false })
    for (const row of rows) expect(row.stamp).toMatch(/^fields#[0-9a-f]{32}$/)
  })

  it('GB14: the list, the attendee list and today\'s events each refuse an inactive account and a sign-in with no staff row (the old reads asked nobody); plain staff may read all three', async () => {
    const eventId = await fixtures.event(db)
    for (const [route, params] of [
      [eventsRoute, {}],
      [attendeesRoute, { eventId }],
      [todayRoute, {}],
    ] as const) {
      expect(refusedWith(await get(route, params, INA))).toMatchObject({ status: 403, words: INACTIVE })
      expect(refusedWith(await get(route, params, NOBODY))).toMatchObject({ status: 401, words: NO_STAFF_ROW })
      expect((await get(route, params, TIA)).status).toBe(200)
    }
  })

  it("the stamp is of the columns the edit writes: a place sold, the on-sale switch and the event's cancel leave it; each of the nine columns changes it", async () => {
    const eventId = await fixtures.event(db)
    const first = await stampOf(eventId)
    expect([...EVENT_DETAILS_COLUMNS]).toEqual(['starts_at', 'ends_at', 'capacity', 'access', 'public_release_at', 'price_public', 'price_pre_herd', 'price_herd', 'refund_cutoff_at'])
    await db.query('UPDATE events SET places_booked = places_booked + 3, updated_at = now() WHERE id = $1', [eventId])
    expect(await stampOf(eventId)).toBe(first)
    await db.query('UPDATE events SET active = false, updated_at = now() WHERE id = $1', [eventId])
    expect(await stampOf(eventId)).toBe(first)
    await db.query("UPDATE events SET cancelled_at = now(), cancel_reason = 'Storm', name = 'Renamed in Sanity' WHERE id = $1", [eventId])
    expect(await stampOf(eventId)).toBe(first)
    // One statement for each of the nine columns, in the stamp's order.
    const changes: Array<[string, string]> = [
      ['starts_at', "UPDATE events SET starts_at = '2099-06-15 17:00:00+00' WHERE id = $1"],
      ['ends_at', "UPDATE events SET ends_at = '2099-06-15 21:00:00+00' WHERE id = $1"],
      ['capacity', 'UPDATE events SET capacity = 12 WHERE id = $1'],
      ['access', "UPDATE events SET access = 'members_only' WHERE id = $1"],
      ['public_release_at', "UPDATE events SET public_release_at = '2099-06-10 09:00:00+00' WHERE id = $1"],
      ['price_public', 'UPDATE events SET price_public = 41 WHERE id = $1'],
      ['price_pre_herd', 'UPDATE events SET price_pre_herd = 31 WHERE id = $1'],
      ['price_herd', 'UPDATE events SET price_herd = 21 WHERE id = $1'],
      ['refund_cutoff_at', "UPDATE events SET refund_cutoff_at = '2099-06-13 18:00:00+00' WHERE id = $1"],
    ]
    expect(changes.map(([column]) => column)).toEqual([...EVENT_DETAILS_COLUMNS])
    let last = first
    for (const [column, statement] of changes) {
      await db.query(statement, [eventId])
      const now = await stampOf(eventId)
      expect(now, column).not.toBe(last)
      last = now
    }
  })
})

describe('on and off sale (POST catalog/events/:eventId/active)', () => {
  it('needs Manage pricing, in the old words; then off and on, each with its audit row (who, the switch before and after)', async () => {
    const eventId = await fixtures.event(db)
    expect(refusedWith(await post(activeRoute, { eventId }, { active: false }, TIA))).toEqual({ status: 403, reason: 'no_pricing_permission', words: NO_PRICING })
    expect(refusedWith(await post(activeRoute, { eventId }, { active: false }, INA))).toMatchObject({ status: 403, words: INACTIVE })
    expect(refusedWith(await post(activeRoute, { eventId }, { active: false }, NOBODY))).toMatchObject({ status: 401, words: NO_STAFF_ROW })
    expect((await eventRow(eventId))?.['active']).toBe(true)

    expect((await post(activeRoute, { eventId }, { active: false })).data).toEqual({ updated: true, event: { id: eventId, active: false } })
    expect((await post(activeRoute, { eventId }, { active: true })).data).toEqual({ updated: true, event: { id: eventId, active: true } })
    const rows = await eventAuditRows()
    expect(rows.map((row) => [row.action, row.actor_type, row.actor_id, row.entity_type, row.entity_id, row.details.before, row.details.after])).toEqual([
      ['event.active_set', 'staff', jo, 'event', eventId, { id: eventId, active: true }, { id: eventId, active: false }],
      ['event.active_set', 'staff', jo, 'event', eventId, { id: eventId, active: false }, { id: eventId, active: true }],
    ])
    expect(rows.every((row) => typeof row.details.key === 'string' && row.details.key !== '')).toBe(true)
  })

  it("every refusal's words: an event that isn't there; one that isn't finished; a cancelled one. Nothing is changed and no row is written", async () => {
    expect(refusedWith(await post(activeRoute, { eventId: UNKNOWN_ID }, { active: true }))).toEqual({ status: 404, reason: 'event_not_found', words: 'That event no longer exists.' })
    expect(refusedWith(await post(activeRoute, { eventId: 'not-an-id' }, { active: true }))).toEqual({ status: 404, reason: 'event_not_found', words: 'That event no longer exists.' })
    const draft = await fixtures.event(db, { active: false, price_herd: null })
    const incomplete = { status: 409, reason: 'event_incomplete', words: OLD.setEventActive.setDateCapacityPricesAndRefund }
    expect(refusedWith(await post(activeRoute, { eventId: draft }, { active: true }))).toEqual(incomplete)
    expect(incomplete.words).toBe('Set the date, capacity, prices and refund cut-off before putting this event on sale (and the public release time for Members first). A cancelled event cannot go on sale.')
    const cancelled = await fixtures.event(db, { active: false, cancelled_at: '2099-06-01 10:00:00+00', cancel_reason: 'Storm' })
    expect(refusedWith(await post(activeRoute, { eventId: cancelled }, { active: true }))).toEqual(incomplete)
    // Off sale always works, on a cancelled event too.
    expect((await post(activeRoute, { eventId: cancelled }, { active: false })).data).toMatchObject({ updated: true, event: { active: false } })
    expect((await eventRow(draft))?.['active']).toBe(false)
    expect((await eventAuditRows()).map((row) => row.entity_id)).toEqual([cancelled])
  })

  it('the same key pressed again gets the first answer back, and the switch is written once', async () => {
    const eventId = await fixtures.event(db)
    const key = crypto.randomUUID()
    const first = await post(activeRoute, { eventId }, { active: false }, JO, key)
    const again = await post(activeRoute, { eventId }, { active: false }, JO, key)
    expect([first.replayed, again.replayed]).toEqual([false, true])
    expect(again.data).toEqual(first.data)
    expect(await eventAuditRows()).toHaveLength(1)
  })
})

describe('the edit (POST catalog/events/:eventId/details)', () => {
  it('needs Manage pricing first, in the old words, before the fields are looked at; an inactive account and a sign-in with no staff row are refused by the route', async () => {
    const eventId = await fixtures.event(db)
    expect(refusedWith(await edit(eventId, { capacity: 0 }, TIA))).toEqual({ status: 403, reason: 'no_pricing_permission', words: NO_PRICING })
    expect(refusedWith(await post(detailsRoute, { eventId }, details, INA))).toMatchObject({ status: 403, words: INACTIVE })
    expect(refusedWith(await post(detailsRoute, { eventId }, details, NOBODY))).toMatchObject({ status: 401, words: NO_STAFF_ROW })
    expect(await eventAuditRows()).toEqual([])
  })

  it("every field refusal's words (`invalid_params`), in the old order, before the event is looked for", async () => {
    const invalid = (words: string) => ({ status: 400, reason: 'invalid_params', words })
    const eventId = await fixtures.event(db)
    for (const [change, words] of [
      [{ access: 'everyone' }, 'Choose who can book: Public, Members only or Members first.'],
      [{ access: undefined }, 'Choose who can book: Public, Members only or Members first.'],
      [{ capacity: 0 }, 'Capacity must be a whole number of at least 1.'],
      [{ capacity: 7.5 }, 'Capacity must be a whole number of at least 1.'],
      [{ capacity: '10' }, 'Capacity must be a whole number of at least 1.'],
      [{ pricePublic: -1 }, "Prices can't be negative."],
      [{ priceHerd: '20' }, "Prices can't be negative."],
      [{ startsAt: 'next Tuesday' }, 'One of the dates is not valid.'],
      [{ refundCutoffAt: 'soon' }, 'One of the dates is not valid.'],
      [{ endsAt: 12 }, 'One of the dates is not valid.'],
      [{ startsAt: '+123456-01-01T00:00:00.000Z' }, 'One of the dates is not valid.'],
      // The first that fails is the one answered: who can book, before the capacity.
      [{ access: 'everyone', capacity: 0 }, 'Choose who can book: Public, Members only or Members first.'],
    ] as const) {
      expect(refusedWith(await edit(eventId, change)), JSON.stringify(change)).toEqual(invalid(words))
    }
    // A field that is wrong is refused even for an event that isn't there: the fields come first, as before.
    expect(refusedWith(await post(detailsRoute, { eventId: UNKNOWN_ID }, { ...details, capacity: 0 }))).toEqual(invalid('Capacity must be a whole number of at least 1.'))
    expect(refusedWith(await post(detailsRoute, { eventId: UNKNOWN_ID }, details))).toEqual({ status: 404, reason: 'event_not_found', words: 'That event no longer exists.' })
    expect(await eventAuditRows()).toEqual([])
  })

  it("the table's own rules, each in its old words (`constraint`), never the database's; and a cancelled event", async () => {
    const constraint = (words: string) => ({ status: 409, reason: 'constraint', words })
    const eventId = await fixtures.event(db)
    await booked(eventId, sam, ['Sam Test', 'Alex Guest'])
    for (const [change, words] of [
      [{ capacity: 1 }, "Capacity can't be lower than the places already booked (2)."],
      [{ endsAt: '2099-06-15T17:00:00.000Z' }, 'The end time must be after the start time.'],
      [{ refundCutoffAt: '2099-06-16T18:00:00.000Z' }, "The refund cut-off can't be after the event starts."],
      [{ access: 'members_first', publicReleaseAt: '2099-06-15T19:00:00.000Z' }, 'The public release must be before the event starts.'],
      // On sale: a price, the cut-off's place (here the public release for Members first) can't be cleared.
      [{ pricePreHerd: null }, OLD.setEventDetails.eventOnSaleSoItNeeds],
      [{ access: 'members_first', publicReleaseAt: null }, OLD.setEventDetails.eventOnSaleSoItNeeds],
    ] as const) {
      const answer = refusedWith(await edit(eventId, change))
      expect(answer, JSON.stringify(change)).toEqual(constraint(words))
      expect(answer.words).not.toMatch(/violates|constraint "/)
    }
    expect(OLD.setEventDetails.eventOnSaleSoItNeeds).toBe('This event is on sale, so it needs a date, capacity, all three prices and a refund cut-off (and a public release time for Members first). Take it off sale first to clear any of them.')
    expect(await eventRow(eventId)).toMatchObject({ capacity: 10, price_public: '40.00', starts: '2099-06-15T18:00', cutoff: '2099-06-14T18:00' })

    const cancelled = await fixtures.event(db, { active: false, cancelled_at: '2099-06-01 10:00:00+00', cancel_reason: 'Storm' })
    expect(refusedWith(await edit(cancelled))).toEqual({ status: 409, reason: 'event_cancelled', words: "This event has been cancelled, so it can't be edited." })
    expect(await eventAuditRows()).toEqual([])
  })

  it('a saved edit answers the event as it now is with its new stamp, keeps the public release for Members first only, and writes one audit row with the event before and after', async () => {
    const eventId = await fixtures.event(db)
    const saved = await edit(eventId, { startsAt: '2099-06-20T18:30:00.000Z', endsAt: '2099-06-20T20:30:00.000Z', capacity: 14, pricePublic: 45, pricePreHerd: 35.5, priceHerd: 0, refundCutoffAt: '2099-06-18T18:30:00.000Z' })
    expect(saved.status).toBe(200)
    expect(saved.data).toMatchObject({
      updated: true,
      event: { id: eventId, starts_at: '2099-06-20T18:30:00.000Z', ends_at: '2099-06-20T20:30:00.000Z', capacity: 14, price_public: '45.00', price_pre_herd: '35.50', price_herd: '0.00', refund_cutoff_at: '2099-06-18T18:30:00.000Z', places_booked: 0, active: true },
    })
    expect(saved.data?.stamp).toBe(await stampOf(eventId))
    expect(Object.keys(saved.data?.event ?? {}).sort()).toEqual(Object.keys(adminGetEventsOutputSchema.element.shape).sort())

    const first = (await edit(eventId, { access: 'members_first', publicReleaseAt: '2099-06-10T09:00:00.000Z' })).data
    expect(first?.event).toMatchObject({ access: 'members_first', public_release_at: '2099-06-10T09:00:00.000Z' })
    const only = (await edit(eventId, { access: 'members_only', publicReleaseAt: '2099-06-10T09:00:00.000Z' })).data
    expect(only?.event).toMatchObject({ access: 'members_only', public_release_at: null })

    const rows = await eventAuditRows()
    expect(rows.map((row) => [row.action, row.actor_id, row.entity_type, row.entity_id])).toEqual([
      ['event.details_set', jo, 'event', eventId],
      ['event.details_set', jo, 'event', eventId],
      ['event.details_set', jo, 'event', eventId],
    ])
    expect(rows[0]?.details.before).toMatchObject({ starts_at: START, capacity: 10, price_public: '40.00', refund_cutoff_at: CUTOFF, places_booked: 0, cancelled: false })
    expect(rows[0]?.details.after).toMatchObject({ starts_at: '2099-06-20T18:30:00.000Z', capacity: 14, price_public: '45.00', refund_cutoff_at: '2099-06-18T18:30:00.000Z', places_booked: 0 })
    expect(typeof rows[0]?.details.key).toBe('string')
  })

  it('off sale, everything can be cleared', async () => {
    const eventId = await fixtures.event(db, { active: false })
    const cleared = await edit(eventId, { startsAt: null, endsAt: null, capacity: null, pricePublic: null, pricePreHerd: null, priceHerd: null, refundCutoffAt: null })
    expect(cleared.data?.event).toMatchObject({ starts_at: null, ends_at: null, capacity: null, price_public: null, price_pre_herd: null, price_herd: null, refund_cutoff_at: null })
  })

  describe("Q51 (Wayne, 20 Nov 2026; bug GB11): an edit with places sold", () => {
    const earliest = eventTimeWords(new Date(CUTOFF))
    const tooEarly = { status: 409, reason: 'cutoff_earlier', words: NEW.cutoffEarlier(earliest) }

    it('the words name the earliest cut-off allowed, as staff read a time', () => {
      expect(eventTimeWords(new Date('2026-11-30T19:00:00.000Z'))).toBe('Mon 30 Nov 2026, 7:00 pm')
      expect(eventTimeWords(new Date('2026-12-01T00:05:00.000Z'))).toBe('Tue 1 Dec 2026, 12:05 am')
      expect(eventTimeWords(new Date('2027-07-04T12:00:00.000Z'))).toBe('Sun 4 Jul 2027, 12:00 pm')
      expect(NEW.cutoffEarlier('Mon 30 Nov 2026, 7:00 pm')).toBe(
        "Places are already booked on this event, so the refund cut-off can't be made earlier: customers keep at least the cut-off they booked under. The earliest it can be is Mon 30 Nov 2026, 7:00 pm."
      )
      expect(NEW.cutoffCleared('Mon 30 Nov 2026, 7:00 pm')).toBe(
        "Places are already booked on this event, so its refund cut-off can't be cleared or brought forward: customers keep at least the cut-off they booked under. Set a refund cut-off of Mon 30 Nov 2026, 7:00 pm or later."
      )
      // The cut-off in force: the cut-off, or the start when none is set (Q43).
      expect(cutoffInForce(CUTOFF, START)).toBe(new Date(CUTOFF).getTime())
      expect(cutoffInForce(null, START)).toBe(new Date(START).getTime())
      expect(cutoffInForce(null, null)).toBeNull()
    })

    it('an earlier cut-off is refused, by a minute or by a day, with the earliest allowed; the event keeps its cut-off and no row is written', async () => {
      const eventId = await fixtures.event(db)
      await booked(eventId, sam, ['Sam Test', 'Alex Guest'])
      expect(refusedWith(await edit(eventId, { refundCutoffAt: '2099-06-13T18:00:00.000Z' }))).toEqual(tooEarly)
      expect(refusedWith(await edit(eventId, { refundCutoffAt: '2099-06-14T17:59:00.000Z' }))).toEqual(tooEarly)
      // …and so is a whole edit that brings an earlier cut-off with a new price and date: an edit is one save.
      expect(refusedWith(await edit(eventId, { refundCutoffAt: '2099-06-13T18:00:00.000Z', pricePublic: 60, startsAt: '2099-06-16T18:00:00.000Z', endsAt: '2099-06-16T20:00:00.000Z' }))).toEqual(tooEarly)
      expect(await eventRow(eventId)).toMatchObject({ cutoff: '2099-06-14T18:00', price_public: '40.00', starts: '2099-06-15T18:00' })
      expect(await eventAuditRows()).toEqual([])
    })

    it('a later cut-off, and the same one, are allowed; and then the later one is the one customers keep', async () => {
      const eventId = await fixtures.event(db)
      await booked(eventId, sam, ['Sam Test'])
      expect((await edit(eventId)).status).toBe(200)
      expect((await edit(eventId, { refundCutoffAt: '2099-06-15T12:00:00.000Z' })).data?.event.refund_cutoff_at).toBe('2099-06-15T12:00:00.000Z')
      // The cut-off in force is now 15 June at noon: the one it was sold under at first is earlier, and refused.
      expect(refusedWith(await edit(eventId, { refundCutoffAt: CUTOFF }))).toEqual({ status: 409, reason: 'cutoff_earlier', words: NEW.cutoffEarlier(eventTimeWords(new Date('2099-06-15T12:00:00.000Z'))) })
    })

    it('a price change is allowed and applies to new bookings only: the places already sold keep the price they were sold at', async () => {
      const eventId = await fixtures.event(db)
      const { attendees, bookingId } = await booked(eventId, sam, ['Sam Test', 'Alex Guest'])
      const saved = await edit(eventId, { pricePublic: 60, pricePreHerd: 50, priceHerd: 45 })
      expect(saved.data?.event).toMatchObject({ price_public: '60.00', price_pre_herd: '50.00', price_herd: '45.00', places_booked: 2 })
      for (const attendee of attendees) expect((await attendeeRow(attendee))?.['unit_price']).toBe('40.00')
      expect((await db.query<{ paid: string }>('SELECT price_paid::text AS paid FROM event_bookings WHERE id = $1', [bookingId]))[0]?.paid).toBe('80.00')
      // The audit row says how many places were booked when the price changed.
      expect((await eventAuditRows())[0]?.details).toMatchObject({ before: { price_public: '40.00', places_booked: 2 }, after: { price_public: '60.00', places_booked: 2 } })
    })

    it('a date change is allowed, later or earlier, and while the event still starts after its cut-off the cut-off stays where it is (Q-b: a postponement never moves it)', async () => {
      const eventId = await fixtures.event(db)
      await booked(eventId, sam, ['Sam Test'])
      // A week later: the cut-off the places were sold under is still 14 June at 18:00.
      expect((await edit(eventId, { startsAt: '2099-06-22T18:00:00.000Z', endsAt: '2099-06-22T20:00:00.000Z' })).data?.event).toMatchObject({ starts_at: '2099-06-22T18:00:00.000Z', refund_cutoff_at: CUTOFF })
      // Brought forward to the morning after the cut-off: still 14 June at 18:00.
      expect((await edit(eventId, { startsAt: '2099-06-15T09:00:00.000Z', endsAt: '2099-06-15T11:00:00.000Z' })).data?.event).toMatchObject({ starts_at: '2099-06-15T09:00:00.000Z', refund_cutoff_at: CUTOFF })
      // Brought forward to the cut-off's own minute: not before it, so nothing follows.
      expect((await edit(eventId, { startsAt: CUTOFF, endsAt: '2099-06-14T20:00:00.000Z' })).data?.event).toMatchObject({ starts_at: CUTOFF, refund_cutoff_at: CUTOFF })
      expect((await eventAuditRows()).map((row) => (row.details.after as { refund_cutoff_at?: string }).refund_cutoff_at)).toEqual([CUTOFF, CUTOFF, CUTOFF])
    })

    describe("W52a, Wayne's Q-a (21 Nov 2026): an event brought forward to before its refund cut-off", () => {
      // 14 June 09:00 to 11:00: nine hours before the cut-off the places were sold under (14 June 18:00).
      const EARLY = '2099-06-14T09:00:00.000Z'
      const forward = { startsAt: EARLY, endsAt: '2099-06-14T11:00:00.000Z' }
      const beforeTheNewStart = { status: 409, reason: 'cutoff_earlier', words: NEW.cutoffEarlier(eventTimeWords(new Date(EARLY))) }

      it('with places sold it saves and the cut-off follows: it becomes the new start; the audit row shows the cut-off before and after; a later date afterwards never moves it', async () => {
        const eventId = await fixtures.event(db)
        await booked(eventId, sam, ['Sam Test', 'Alex Guest'])
        // Staff change only the date: the dialog sends the cut-off box as it was (14 June 18:00), now after the new start.
        const saved = await edit(eventId, forward)
        expect(saved.status).toBe(200)
        expect(saved.data?.event).toMatchObject({ starts_at: EARLY, ends_at: '2099-06-14T11:00:00.000Z', refund_cutoff_at: EARLY, places_booked: 2 })
        expect(saved.data?.stamp).toBe(await stampOf(eventId))
        expect(await eventRow(eventId)).toMatchObject({ starts: '2099-06-14T09:00', cutoff: '2099-06-14T09:00' })
        const rows = await eventAuditRows()
        expect(rows).toHaveLength(1)
        expect(rows[0]?.details).toMatchObject({ before: { starts_at: START, refund_cutoff_at: CUTOFF, places_booked: 2 }, after: { starts_at: EARLY, refund_cutoff_at: EARLY, places_booked: 2 } })
        // The new start is the cut-off in force now: it can't be made earlier, by a minute or by a day.
        expect(refusedWith(await edit(eventId, { ...forward, refundCutoffAt: '2099-06-14T08:59:00.000Z' }))).toEqual(beforeTheNewStart)
        // Put back to 15 June (a later date): the cut-off stays at 14 June 09:00, where the dialog's box now has it.
        expect((await edit(eventId, { refundCutoffAt: EARLY })).data?.event).toMatchObject({ starts_at: START, refund_cutoff_at: EARLY })
      })

      it('the cut-off goes exactly as far as the new start, whatever the cut-off box holds from the new start on: left as it was, set to the new start, or set between the two', async () => {
        for (const [customer, box] of [
          [sam, CUTOFF],
          [mo, EARLY],
          [await fixtures.customer(db, { first_name: 'Pat', last_name: 'Third', email: 'pat@example.com' }), '2099-06-14T12:00:00.000Z'],
        ] as const) {
          const eventId = await fixtures.event(db)
          await booked(eventId, customer, ['One Place'])
          expect((await edit(eventId, { ...forward, refundCutoffAt: box })).data?.event, box).toMatchObject({ starts_at: EARLY, refund_cutoff_at: EARLY })
        }
      })

      it("the same edit with the cut-off box set earlier than the new start is refused, in Q51's words with the new start as the earliest, and nothing changes", async () => {
        const eventId = await fixtures.event(db)
        await booked(eventId, sam, ['Sam Test'])
        expect(refusedWith(await edit(eventId, { ...forward, refundCutoffAt: '2099-06-13T18:00:00.000Z' }))).toEqual(beforeTheNewStart)
        expect(refusedWith(await edit(eventId, { ...forward, refundCutoffAt: '2099-06-14T08:59:00.000Z' }))).toEqual(beforeTheNewStart)
        expect(beforeTheNewStart.words).toContain('The earliest it can be is ')
        expect(beforeTheNewStart.words).toContain(' 14 Jun 2099, 9:00 am.')
        expect(await eventRow(eventId)).toMatchObject({ starts: '2099-06-15T18:00', cutoff: '2099-06-14T18:00' })
        expect(await eventAuditRows()).toEqual([])
      })

      it("with no place sold nothing follows, as before: the table's own rule refuses a cut-off left after the new start, in its old words, and a cut-off moved earlier with the date saves as sent", async () => {
        const eventId = await fixtures.event(db)
        expect(refusedWith(await edit(eventId, forward))).toEqual({ status: 409, reason: 'constraint', words: "The refund cut-off can't be after the event starts." })
        expect(await eventRow(eventId)).toMatchObject({ starts: '2099-06-15T18:00', cutoff: '2099-06-14T18:00' })
        expect((await edit(eventId, { ...forward, refundCutoffAt: '2099-06-13T18:00:00.000Z' })).data?.event).toMatchObject({ starts_at: EARLY, refund_cutoff_at: '2099-06-13T18:00:00.000Z' })
      })

      it('an off-sale event with no cut-off set (its start is the cut-off: Q43) brought forward saves, and still has none: the new start is the cut-off', async () => {
        const eventId = await fixtures.event(db, { active: false, refund_cutoff_at: null })
        await booked(eventId, sam, ['Sam Test'])
        const saved = await edit(eventId, { ...forward, refundCutoffAt: null })
        expect(saved.status).toBe(200)
        expect(saved.data?.event).toMatchObject({ starts_at: EARLY, refund_cutoff_at: null })
        expect((await eventAuditRows())[0]?.details).toMatchObject({ before: { starts_at: START, refund_cutoff_at: null }, after: { starts_at: EARLY, refund_cutoff_at: null } })
        // …and a cut-off before that new start is still refused.
        expect(refusedWith(await edit(eventId, { ...forward, refundCutoffAt: '2099-06-14T08:00:00.000Z' }))).toEqual(beforeTheNewStart)

        // Off sale with a cut-off set, the box emptied and the date brought forward in one edit: the same cut-off in force (the new start).
        const other = await fixtures.event(db, { active: false })
        await booked(other, mo, ['Mo Member'])
        expect((await edit(other, { ...forward, refundCutoffAt: null })).data?.event).toMatchObject({ starts_at: EARLY, refund_cutoff_at: null })
      })

      it('the rule on its own (cutoffToKeep): what the row is to hold, or the words', () => {
        const inForce = new Date(CUTOFF).getTime()
        // The date brought forward: the new start, or nothing when the box is empty; a box earlier than it refused.
        expect(cutoffToKeep(inForce, { refundCutoffAt: CUTOFF, startsAt: EARLY })).toEqual({ refundCutoffAt: EARLY })
        expect(cutoffToKeep(inForce, { refundCutoffAt: null, startsAt: EARLY })).toEqual({ refundCutoffAt: null })
        expect(cutoffToKeep(inForce, { refundCutoffAt: '2099-06-14T08:59:00.000Z', startsAt: EARLY })).toEqual({ refused: beforeTheNewStart.words })
        // The date not before the cut-off in force: the box as sent, unless it is earlier than the cut-off in force.
        expect(cutoffToKeep(inForce, { refundCutoffAt: CUTOFF, startsAt: START })).toEqual({ refundCutoffAt: CUTOFF })
        expect(cutoffToKeep(inForce, { refundCutoffAt: START, startsAt: '2099-06-22T18:00:00.000Z' })).toEqual({ refundCutoffAt: START })
        expect(cutoffToKeep(inForce, { refundCutoffAt: null, startsAt: CUTOFF })).toEqual({ refundCutoffAt: null })
        expect(cutoffToKeep(inForce, { refundCutoffAt: '2099-06-14T17:59:00.000Z', startsAt: START })).toEqual({ refused: NEW.cutoffEarlier(earliest) })
        expect(cutoffToKeep(inForce, { refundCutoffAt: '2099-06-14T17:59:00.000Z', startsAt: null })).toEqual({ refused: NEW.cutoffEarlier(earliest) })
        // No cut-off and no date left: the cleared words.
        expect(cutoffToKeep(inForce, { refundCutoffAt: null, startsAt: null })).toEqual({ refused: NEW.cutoffCleared(earliest) })
      })
    })

    describe('W52a (W52 review S1): a cut-off in force that has seconds', () => {
      it('the words round up to the next whole minute, and only when there are seconds', () => {
        const at = (text: string) => new Date(upToTheMinute(new Date(text).getTime())).toISOString()
        expect(at('2099-06-14T18:00:00.000Z')).toBe('2099-06-14T18:00:00.000Z')
        expect(at('2099-06-14T18:00:30.000Z')).toBe('2099-06-14T18:01:00.000Z')
        expect(at('2099-06-14T18:00:00.001Z')).toBe('2099-06-14T18:01:00.000Z')
        expect(at('2099-06-14T23:59:59.000Z')).toBe('2099-06-15T00:00:00.000Z')
      })

      it('a cut-off at 18:00:30: the dialog\'s own save (18:00) is refused with "6:01 pm" as the earliest; the box at 18:01 is accepted, and the minute before it still isn\'t', async () => {
        const eventId = await fixtures.event(db, { refund_cutoff_at: '2099-06-14 18:00:30+00' })
        await booked(eventId, sam, ['Sam Test'])
        // Staff change only the capacity. The box shows 18:00 and the save sends 18:00:00, 30 seconds before the cut-off in force.
        const refused = refusedWith(await edit(eventId, { capacity: 12 }))
        expect(refused).toEqual({ status: 409, reason: 'cutoff_earlier', words: NEW.cutoffEarlier(eventTimeWords(new Date('2099-06-14T18:01:00.000Z'))) })
        expect(refused.words).toContain(' 14 Jun 2099, 6:01 pm.')
        expect(await eventRow(eventId)).toMatchObject({ capacity: 10 })
        // The time the words name can be typed in, and is accepted: it is later than the cut-off in force.
        expect((await edit(eventId, { capacity: 12, refundCutoffAt: '2099-06-14T18:01:00.000Z' })).data?.event).toMatchObject({ capacity: 12, refund_cutoff_at: '2099-06-14T18:01:00.000Z' })
        // …and the rule is still "never earlier": 18:00 is refused again, now a whole minute early.
        expect(refusedWith(await edit(eventId, { refundCutoffAt: '2099-06-14T18:00:00.000Z' }))).toEqual({ status: 409, reason: 'cutoff_earlier', words: NEW.cutoffEarlier(eventTimeWords(new Date('2099-06-14T18:01:00.000Z'))) })
      })

      it("no cut-off set and a start with seconds (off sale): the dialog's save sends the start at its whole minute, which is Q-a's case, and saves", async () => {
        const eventId = await fixtures.event(db, { active: false, refund_cutoff_at: null, starts_at: '2099-06-15 18:00:30+00' })
        await booked(eventId, sam, ['Sam Test'])
        expect((await edit(eventId, { capacity: 12, refundCutoffAt: null })).data?.event).toMatchObject({ capacity: 12, starts_at: START, refund_cutoff_at: null })
      })
    })

    it('with no cut-off set the start is the cut-off (Q43): it can be given one at the start but not before it', async () => {
      const eventId = await fixtures.event(db, { active: false, refund_cutoff_at: null })
      await booked(eventId, sam, ['Sam Test'])
      const atTheStart = eventTimeWords(new Date(START))
      expect(refusedWith(await edit(eventId, { refundCutoffAt: CUTOFF }))).toEqual({ status: 409, reason: 'cutoff_earlier', words: NEW.cutoffEarlier(atTheStart) })
      expect((await edit(eventId, { refundCutoffAt: START })).data?.event.refund_cutoff_at).toBe(START)
    })

    it('a cut-off can be cleared (off sale) while the start, which then is the cut-off, is no earlier; an event left with no cut-off and no date is refused, in the cleared words', async () => {
      const eventId = await fixtures.event(db, { active: false })
      await booked(eventId, sam, ['Sam Test'])
      // The start (15 June 18:00) is later than the cut-off it was sold under (14 June 18:00): customers gain a day.
      expect((await edit(eventId, { refundCutoffAt: null })).data?.event.refund_cutoff_at).toBeNull()
      // …and with the date cleared too there is no cut-off at all: refused (W52a: the only case left for these words).
      expect(refusedWith(await edit(eventId, { refundCutoffAt: null, startsAt: null, endsAt: null }))).toEqual({ status: 409, reason: 'cutoff_earlier', words: NEW.cutoffCleared(eventTimeWords(new Date(START))) })
    })

    it('with no place booked, or once every place has been cancelled, the cut-off can move earlier', async () => {
      const empty = await fixtures.event(db)
      expect((await edit(empty, { refundCutoffAt: '2099-06-10T18:00:00.000Z' })).status).toBe(200)
      const eventId = await fixtures.event(db)
      await booked(eventId, sam, ['Sam Test'])
      expect(refusedWith(await edit(eventId, { refundCutoffAt: '2099-06-10T18:00:00.000Z' })).reason).toBe('cutoff_earlier')
      await db.query('UPDATE events SET places_booked = 0 WHERE id = $1', [eventId])
      expect((await edit(eventId, { refundCutoffAt: '2099-06-10T18:00:00.000Z' })).status).toBe(200)
    })
  })

  describe("W54a's rule on the edit: a page loaded before someone else's change", () => {
    const stale = { status: 409, reason: 'changed_since', words: CHANGED_SINCE_WORDS }

    it('an edit from a page loaded before someone else changed the price is refused, and nothing is written; with the stamp the refusal sent the page to read, it saves', async () => {
      const eventId = await fixtures.event(db)
      const loadedBefore = await stampOf(eventId)
      // Someone else corrects the price from £40 to £45.
      expect((await edit(eventId, { pricePublic: 45 })).status).toBe(200)
      // The older page changes only the capacity, and sends every other field as it loaded them: £40 again.
      const press = await post(detailsRoute, { eventId }, { ...details, capacity: 12, stamp: loadedBefore })
      expect(refusedWith(press)).toEqual(stale)
      expect(stale.words).toBe('This was changed by someone else since the page loaded. The page has been reloaded: check it and save again.')
      expect(await eventRow(eventId)).toMatchObject({ price_public: '45.00', capacity: 10 })
      expect(await eventAuditRows()).toHaveLength(1)
      // The page reads the list again: the price is £45 in its boxes now, and the save goes through.
      expect((await edit(eventId, { pricePublic: 45, capacity: 12 })).data?.event).toMatchObject({ price_public: '45.00', capacity: 12 })
    })

    it('an edit with no stamp, or one that is not text, is refused the same way', async () => {
      const eventId = await fixtures.event(db)
      expect(refusedWith(await post(detailsRoute, { eventId }, details))).toEqual(stale)
      expect(refusedWith(await post(detailsRoute, { eventId }, { ...details, stamp: 42 }))).toEqual(stale)
      expect(refusedWith(await post(detailsRoute, { eventId }, { ...details, stamp: '' }))).toEqual(stale)
      expect(await eventAuditRows()).toEqual([])
    })

    it('a place sold, a place cancelled or the on-sale switch pressed since the page loaded does NOT refuse the edit: none of them is something the edit writes back', async () => {
      const eventId = await fixtures.event(db)
      const loaded = await stampOf(eventId)
      await booked(eventId, sam, ['Sam Test', 'Alex Guest'])
      await post(activeRoute, { eventId }, { active: false })
      const saved = await post<EventDetailsRouteOutput>(detailsRoute, { eventId }, { ...details, capacity: 12, stamp: loaded })
      expect(saved.status).toBe(200)
      // …and the answer carries the places as they now are, with the switch as it was left.
      expect(saved.data?.event).toMatchObject({ capacity: 12, places_booked: 2, active: false })
    })

    it('the stale page is refused before Q51 is looked at: its boxes hold the old cut-off, and the refusal tells it to read again', async () => {
      const eventId = await fixtures.event(db)
      const loaded = await stampOf(eventId)
      await booked(eventId, sam, ['Sam Test'])
      expect((await edit(eventId, { refundCutoffAt: '2099-06-15T12:00:00.000Z' })).status).toBe(200)
      expect(refusedWith(await post(detailsRoute, { eventId }, { ...details, stamp: loaded }))).toEqual(stale)
    })
  })
})

describe('the attendee list (GET events/:eventId/attendees)', () => {
  it('answers the event, the window and every booking with its places in place order: confirmed and cancelled, each with its order and the money still to refund on it', async () => {
    const eventId = await fixtures.event(db, { has_extra_waiver: true, extra_waiver_version: 'cold-plunge-v2' })
    const first = await booked(eventId, sam, ['Sam Test', 'Alex Guest'], { order: true })
    const second = await booked(eventId, mo, ['Mo Member'])
    await waiverSigned(first.attendees[1] as string)
    const list = (await listOf(eventId)).data
    expect(list?.event).toEqual({ id: eventId, name: expect.any(String), starts_at: START, ends_at: END, capacity: 10, places_booked: 3, has_extra_waiver: true, refund_cutoff_at: CUTOFF, cancelled_at: null, cancel_reason: null })
    expect(list?.checkInWindow).toBe('not_open')
    expect(list?.bookings.map((booking) => [booking.id, booking.status, booking.places, booking.price_paid, booking.order_id, booking.refund_owed_amount, booking.refund_open])).toEqual([
      [first.bookingId, 'confirmed', 2, '80.00', first.orderId, '0.00', false],
      [second.bookingId, 'confirmed', 1, '40.00', null, '0.00', false],
    ])
    expect(list?.bookings[0]?.attendees.map((attendee) => [attendee.name, attendee.attendee_type, attendee.unit_price, attendee.waiver_accepted, attendee.waiver_method, attendee.extra_waiver_state, attendee.checked_in_at])).toEqual([
      ['Sam Test', 'account_holder', '40.00', false, null, 'pending', null],
      ['Alex Guest', 'guest', '40.00', true, 'email_link', 'pending', null],
    ])
    expect(list?.bookings[0]).toMatchObject({ customer_first_name: 'Sam', customer_last_name: 'Test', customer_email: 'sam@example.com' })
  })

  it("an event that isn't there, and an id that isn't one, answer no event and no bookings, as before", async () => {
    const none = { event: null, checkInWindow: 'not_open', bookings: [] }
    expect((await listOf(UNKNOWN_ID)).data).toEqual(none)
    expect((await listOf('not-an-id')).data).toEqual(none)
  })

  it('F1: a fully cancelled booking whose card refund failed later is on the list, with the money owed on its order and the order to refund it from', async () => {
    const eventId = await fixtures.event(db)
    const gone = await booked(eventId, sam, ['Sam Test'], { order: true })
    await db.query("UPDATE event_bookings SET status = 'cancelled', places = 0, cancelled_at = now(), cancel_reason = 'Ill' WHERE id = $1", [gone.bookingId])
    await db.query("UPDATE event_attendees SET cancelled_at = now(), cancelled_value = 40, refunded_amount = 0, card_refunded_amount = 0, refund_method = 'card' WHERE event_booking_id = $1", [gone.bookingId])
    await db.query('UPDATE orders SET refund_owed_amount = 40 WHERE id = $1', [gone.orderId])
    const [booking] = (await listOf(eventId)).data?.bookings ?? []
    expect(booking).toMatchObject({ id: gone.bookingId, status: 'cancelled', places: 0, order_id: gone.orderId, refund_owed_amount: '40.00', refund_open: false })
    expect(booking?.attendees.map((attendee) => [attendee.cancelled_value, attendee.refunded_amount, attendee.refund_method])).toEqual([['40', '0', 'card']])
  })

  it('row 18: `refund_open` is true while a refund on the booking\'s order is still being checked, and false once its claim has finished or when the booking has no order', async () => {
    const eventId = await fixtures.event(db)
    const held = await booked(eventId, sam, ['Sam Test'], { order: true })
    const other = await booked(eventId, mo, ['Mo Member'], { order: true })
    const open = async () => Object.fromEntries(((await listOf(eventId)).data?.bookings ?? []).map((booking) => [booking.id, booking.refund_open]))
    expect(await open()).toEqual({ [held.bookingId]: false, [other.bookingId]: false })
    // The place cancel's own claim on the booking, as writeEventBookingClaim writes it: a Worker claim naming the order.
    const claimId = await insert(db, 'audit_log', {
      actor_type: 'staff',
      actor_id: jo,
      action: EVENT_BOOKING_CLAIMS.claimed,
      entity_type: EVENT_BOOKING_CLAIMS.entityType,
      entity_id: held.bookingId,
      request_id: 'req_w52',
      details: JSON.stringify({ worker: true, orderId: held.orderId }),
    })
    expect(await open()).toEqual({ [held.bookingId]: true, [other.bookingId]: false })
    await insert(db, 'audit_log', {
      actor_type: 'system',
      actor_id: null,
      action: EVENT_BOOKING_CLAIMS.finished,
      entity_type: EVENT_BOOKING_CLAIMS.entityType,
      entity_id: held.bookingId,
      request_id: 'req_w52_done',
      details: JSON.stringify({ worker: true, claimId }),
    })
    expect(await open()).toEqual({ [held.bookingId]: false, [other.bookingId]: false })
  })

  it("W52a (review 'For later' 3): with two event bookings on one order, `refund_open` follows each booking's own claim, not any claim that holds the order; a Refund the rest on the order counts for both", async () => {
    // Sam bought a place on each of two events in one order: both event lines are on the first booking's order.
    const eventA = await fixtures.event(db, { name: 'Event A' })
    const eventB = await fixtures.event(db, { name: 'Event B', starts_at: '2099-07-01 18:00:00+00', ends_at: '2099-07-01 20:00:00+00', refund_cutoff_at: '2099-06-30 18:00:00+00' })
    const a = await booked(eventA, sam, ['Sam Test'], { order: true })
    const b = await booked(eventB, sam, ['Sam Test'])
    const orderId = a.orderId as string
    await insert(db, 'order_line_items', { order_id: orderId, item_type: 'event', quantity: 1, unit_price: '40.00', line_total: '40.00', event_booking_id: b.bookingId })
    const openOn = async (eventId: string) => ((await listOf(eventId)).data?.bookings ?? []).map((booking) => [booking.id, booking.order_id, booking.refund_open])
    const both = async () => [...(await openOn(eventA)), ...(await openOn(eventB))]
    const neither = [
      [a.bookingId, orderId, false],
      [b.bookingId, orderId, false],
    ]
    expect(await both()).toEqual(neither)
    const claim = (on: { claimed: string; entityType: string }, entityId: string, details: Record<string, unknown>) =>
      insert(db, 'audit_log', { actor_type: 'staff', actor_id: jo, action: on.claimed, entity_type: on.entityType, entity_id: entityId, request_id: 'req_w52a', details: JSON.stringify({ worker: true, ...details }) })
    const finish = (on: { finished: string; entityType: string }, entityId: string, claimId: string) =>
      insert(db, 'audit_log', { actor_type: 'system', actor_id: null, action: on.finished, entity_type: on.entityType, entity_id: entityId, request_id: 'req_w52a_done', details: JSON.stringify({ worker: true, claimId }) })

    // Booking A's own place cancel, its card refund still being checked: A's, and only A's.
    const own = await claim(EVENT_BOOKING_CLAIMS, a.bookingId, { kind: 'cancel_places', orderId })
    expect(await both()).toEqual([
      [a.bookingId, orderId, true],
      [b.bookingId, orderId, false],
    ])
    await finish(EVENT_BOOKING_CLAIMS, a.bookingId, own)
    expect(await both()).toEqual(neither)

    // A refund of the order's other lines (the soap), and a session booking's card part on the order's payment: they
    // hold the order for a second refund, but neither is either event booking's money.
    const lines = await claim(ORDER_CLAIMS, orderId, { kind: 'refund' })
    const session = await claim(BOOKING_CLAIMS, crypto.randomUUID(), { kind: 'refund', plan: { card: [{ orderId }] } })
    expect(await both()).toEqual(neither)
    await finish(ORDER_CLAIMS, orderId, lines)
    expect(session).toEqual(expect.any(String))

    // Refund the rest on the order (the money owed is one figure for the order), still being checked: both.
    const rest = await claim(ORDER_CLAIMS, orderId, { kind: 'refund_owed' })
    expect(await both()).toEqual([
      [a.bookingId, orderId, true],
      [b.bookingId, orderId, true],
    ])
    await finish(ORDER_CLAIMS, orderId, rest)
    expect(await both()).toEqual(neither)
  })

  it('a booking whose reader payment is still open (pending) is left out, as before', async () => {
    const eventId = await fixtures.event(db)
    await booked(eventId, sam, ['Sam Test'], { status: 'pending' })
    expect((await listOf(eventId)).data?.bookings).toEqual([])
  })

  it("the check-in window's three states, by London's wall clock: not open before the event's day, open from its first minute to its last (or its end, when later), closed after", async () => {
    const eventId = await fixtures.event(db)
    const windowAt = async (instant: string) => {
      await nowIs(instant)
      return (await listOf(eventId)).data?.checkInWindow
    }
    expect(await windowAt(LONDON.eveBefore2330)).toBe('not_open')
    // 00:30 on the day in London is still the day before by the UTC clock: the window follows London's.
    expect(await windowAt(LONDON.onTheDay0030)).toBe('open')
    expect(await windowAt(LONDON.onTheDayNoon)).toBe('open')
    expect(await windowAt(LONDON.onTheDay2330)).toBe('open')
    expect(await windowAt(LONDON.dayAfter0030)).toBe('closed')
    // An event that runs past midnight stays open until it ends.
    await db.query("UPDATE events SET ends_at = '2099-06-16 01:00:00+00' WHERE id = $1", [eventId])
    expect(await windowAt(LONDON.dayAfter0030)).toBe('open')
    expect(await windowAt('2099-06-16 00:30:00+00')).toBe('closed')
    // An event with no date is never open.
    await db.query('UPDATE events SET active = false, starts_at = NULL, ends_at = NULL, refund_cutoff_at = NULL WHERE id = $1', [eventId])
    expect(await windowAt(LONDON.onTheDayNoon)).toBe('not_open')
  })
})

describe("today's events (GET events/today; W48 review L5)", () => {
  // Two events on Thursday 1 July 2027 by London's wall clock: one at 00:30, one at 23:30 (stored as those digits
  // labelled UTC). In July London's wall clock is an hour ahead of UTC.
  const HALF_PAST_MIDNIGHT = '2027-07-01 00:30:00+00'
  const HALF_PAST_ELEVEN = '2027-07-01 23:30:00+00'
  const LONDON_IS = {
    june30at2350: '2027-06-30 22:50:00+00',
    july1at0010: '2027-06-30 23:10:00+00',
    july1at2350: '2027-07-01 22:50:00+00',
    july2at0010: '2027-07-01 23:10:00+00',
  }
  const todays = async () => ((await get<AdminGetTodaysEventsOutput>(todayRoute)).data?.events ?? []).map((event) => event.name)
  const twoEvents = async () => {
    await fixtures.event(db, { name: 'Early', starts_at: HALF_PAST_MIDNIGHT, ends_at: null, refund_cutoff_at: '2027-06-29 18:00:00+00' })
    await fixtures.event(db, { name: 'Late', starts_at: HALF_PAST_ELEVEN, ends_at: null, refund_cutoff_at: '2027-06-29 18:00:00+00' })
  }

  it("an event is today's when its stored digits show London's today: at 00:30 and at 23:30 in summer, either side of London's midnight", async () => {
    await twoEvents()
    await nowIs(LONDON_IS.june30at2350)
    expect(await todays()).toEqual([])
    // Ten past midnight in London on 1 July: still 30 June by the UTC clock. Both of 1 July's events are today's.
    await nowIs(LONDON_IS.july1at0010)
    expect(await todays()).toEqual(['Early', 'Late'])
    await nowIs(LONDON_IS.july1at2350)
    expect(await todays()).toEqual(['Early', 'Late'])
    // Ten past midnight in London on 2 July: still 1 July by the UTC clock. Neither is today's any more.
    await nowIs(LONDON_IS.july2at0010)
    expect(await todays()).toEqual([])
  })

  it.each(['America/New_York', 'Europe/London', 'Asia/Tokyo'])("the day never depends on the connection's time zone: the same answers with it set to %s", async (zone) => {
    await twoEvents()
    const todaysIn = (instant: string) =>
      nowIs(instant).then(() =>
        db.transaction(async (tx) => {
          // The transaction's own time zone (as SET LOCAL), as a connection set to it would have.
          await tx.query("SELECT set_config('TimeZone', $1, true)", [zone])
          return (await getTodaysEvents(tx, staffActor(jo))).events.map((event) => event.name)
        })
      )
    expect(await todaysIn(LONDON_IS.june30at2350)).toEqual([])
    expect(await todaysIn(LONDON_IS.july1at0010)).toEqual(['Early', 'Late'])
    expect(await todaysIn(LONDON_IS.july1at2350)).toEqual(['Early', 'Late'])
    expect(await todaysIn(LONDON_IS.july2at0010)).toEqual([])
  })

  it('in winter too, when London is on UTC', async () => {
    await fixtures.event(db, { name: 'January', starts_at: '2027-01-15 00:30:00+00', ends_at: null, refund_cutoff_at: '2027-01-14 00:30:00+00' })
    await nowIs('2027-01-15 00:10:00+00')
    expect(await todays()).toEqual(['January'])
    await nowIs('2027-01-14 23:50:00+00')
    expect(await todays()).toEqual([])
  })

  it('answers each event with its counts over the places still booked on confirmed bookings, and the attendees with a waiver outstanding; a cancelled event is not today\'s', async () => {
    const eventId = await fixtures.event(db, { name: 'Full Moon Sauna', has_extra_waiver: true, extra_waiver_version: 'cold-plunge-v2' })
    await fixtures.event(db, { name: 'Called off', active: false, cancelled_at: '2099-06-01 10:00:00+00', cancel_reason: 'Storm' })
    const { attendees } = await booked(eventId, sam, ['Sam Test', 'Alex Guest', 'Cal Gone'])
    const [samId, alexId, calId] = attendees as [string, string, string]
    await booked(eventId, mo, ['Mo Member'], { status: 'pending' })
    await db.query('UPDATE event_attendees SET cancelled_at = now() WHERE id = $1', [calId])
    await db.query("UPDATE event_attendees SET waiver_accepted = true, waiver_method = 'in_person', waiver_version = 'v1', event_waiver_accepted = true, event_waiver_method = 'in_person', event_waiver_version = 'cold-plunge-v2', checked_in_at = now() WHERE id = $1", [samId])
    // Alex signed both, but the extra one on the text as it was before: it counts as outstanding.
    await db.query("UPDATE event_attendees SET waiver_accepted = true, waiver_method = 'email_link', waiver_version = 'v1', event_waiver_accepted = true, event_waiver_method = 'email_link', event_waiver_version = 'cold-plunge-v1' WHERE id = $1", [alexId])
    await nowIs(LONDON.onTheDayNoon)
    const card = (await get<AdminGetTodaysEventsOutput>(todayRoute)).data
    expect(card?.events).toEqual([
      { id: eventId, name: 'Full Moon Sauna', starts_at: START, ends_at: END, capacity: 10, places_booked: 4, has_extra_waiver: true, attendee_count: 2, checked_in_count: 1, standard_waivers_outstanding: 0, extra_waivers_outstanding: 1 },
    ])
    expect(card?.waiverGaps).toEqual([
      { id: alexId, name: 'Alex Guest', attendee_type: 'guest', event_id: eventId, event_name: 'Full Moon Sauna', starts_at: START, customer_first_name: 'Sam', customer_last_name: 'Test', standard_outstanding: false, extra_outstanding: true },
    ])
  })
})

describe('check-in, one attendee or many (POST events/attendees/check-in)', () => {
  it("the window's three states: refused before the day and after it closes, in the old words; open on the day", async () => {
    const eventId = await fixtures.event(db)
    const { attendees } = await booked(eventId, sam, ['Sam Test'])
    const [samId] = attendees as [string]
    await waiverSigned(samId)
    await nowIs(LONDON.eveBefore2330)
    expect((await checkIn([samId])).data?.results).toEqual([{ attendeeId: samId, updated: false, reason: 'check_in_not_open', message: 'Check-in opens on the day' }])
    await nowIs(LONDON.dayAfter0030)
    expect((await checkIn([samId])).data?.results).toEqual([{ attendeeId: samId, updated: false, reason: 'check_in_closed', message: 'Check-in has closed' }])
    expect((await attendeeRow(samId))?.['checked_in']).toBe(false)
    await nowIs(LONDON.onTheDay0030)
    const [outcome] = (await checkIn([samId])).data?.results ?? []
    expect(outcome).toMatchObject({ attendeeId: samId, updated: true, attendee: { id: samId, waiver_accepted: true, waiver_method: 'email_link', extra_waiver_state: 'not_needed' } })
    // The time is the database's clock.
    expect(outcome?.updated === true ? outcome.attendee.checked_in_at : null).toBe('2099-06-14T23:30:00.000Z')
  })

  it("every refusal's words, in the order the one statement checks them", async () => {
    const eventId = await fixtures.event(db)
    const { attendees, bookingId } = await booked(eventId, sam, ['Sam Test', 'Alex Guest'])
    const [samId, alexId] = attendees as [string, string]
    await nowIs(LONDON.onTheDayNoon)
    const reasonOf = async (attendeeId: string, more: Record<string, unknown> = {}) => {
      const [outcome] = (await checkIn([attendeeId], more)).data?.results ?? []
      return outcome && !outcome.updated ? [outcome.reason, outcome.message] : ['checked in']
    }
    expect(await reasonOf('not-an-id')).toEqual(['attendee_not_found', 'This attendee no longer exists.'])
    expect(await reasonOf(UNKNOWN_ID)).toEqual(['attendee_not_found', 'This attendee no longer exists.'])
    expect(await reasonOf(samId)).toEqual(['waivers_outstanding', 'Mark the waiver(s) signed before checking in.'])
    await db.query('UPDATE events SET has_extra_waiver = true, extra_waiver_version = NULL WHERE id = $1', [eventId])
    expect(await reasonOf(samId, { markWaiversSignedInPerson: true })).toEqual(['extra_waiver_version_missing', "The extra waiver text hasn't synced from Sanity yet, so it can't be marked signed."])
    await db.query('UPDATE events SET has_extra_waiver = false WHERE id = $1', [eventId])
    await db.query('UPDATE event_attendees SET cancelled_at = now() WHERE id = $1', [alexId])
    expect(await reasonOf(alexId, { markWaiversSignedInPerson: true })).toEqual(['attendee_cancelled', 'This place has been cancelled.'])
    await db.query("UPDATE event_bookings SET status = 'pending' WHERE id = $1", [bookingId])
    expect(await reasonOf(samId, { markWaiversSignedInPerson: true })).toEqual(['booking_not_confirmed', "This event booking isn't confirmed."])
    await db.query("UPDATE event_bookings SET status = 'confirmed' WHERE id = $1", [bookingId])
    await db.query("UPDATE events SET active = false, cancelled_at = now(), cancel_reason = 'Storm' WHERE id = $1", [eventId])
    expect(await reasonOf(samId, { markWaiversSignedInPerson: true })).toEqual(['event_cancelled', 'This event has been cancelled.'])
    expect((await attendeeRow(samId))?.['checked_in']).toBe(false)
    expect(await eventAuditRows()).toEqual([])
  })

  it('"Mark signed and check in" signs only what is outstanding, in person, and keeps a signature already there; each attendee checked in has an audit row, a refused one has none', async () => {
    const eventId = await fixtures.event(db, { has_extra_waiver: true, extra_waiver_version: 'cold-plunge-v2' })
    const { attendees } = await booked(eventId, sam, ['Sam Test', 'Alex Guest'])
    const [samId, alexId] = attendees as [string, string]
    await waiverSigned(samId)
    await nowIs(LONDON.onTheDayNoon)
    // Sam has the standard waiver by email and the extra one outstanding; Alex has neither. Without the tick: both refused.
    expect(outcomes(await checkIn([samId, alexId]))).toEqual(['waivers_outstanding', 'waivers_outstanding'])
    // One id is nobody's, one isn't an id, and Sam is named twice: one outcome each, in the order asked.
    const answer = await checkIn([samId, UNKNOWN_ID, alexId, 'not-an-id', samId], { markWaiversSignedInPerson: true })
    expect(answer.data?.results.map((one) => one.attendeeId)).toEqual([samId, UNKNOWN_ID, alexId, 'not-an-id'])
    expect(outcomes(answer)).toEqual(['checked in', 'attendee_not_found', 'checked in', 'attendee_not_found'])
    expect(await attendeeRow(samId)).toMatchObject({ checked_in: true, waiver_method: 'email_link', waiver_version: 'v1', event_waiver_accepted: true, event_waiver_method: 'in_person', event_waiver_version: 'cold-plunge-v2' })
    expect(await attendeeRow(alexId)).toMatchObject({ checked_in: true, waiver_accepted: true, waiver_method: 'in_person', waiver_version: 'v1', event_waiver_method: 'in_person', event_waiver_version: 'cold-plunge-v2' })

    // The two rows of one press are written in the same moment: compared as a set.
    const rows = await eventAuditRows()
    const byAttendee = (a: string[], b: string[]) => String(a[4]).localeCompare(String(b[4]))
    expect(rows.map((row) => [row.action, row.actor_type, row.actor_id, row.entity_type, row.entity_id, String(row.details['markWaiversSignedInPerson'])] as string[]).sort(byAttendee)).toEqual(
      [
        ['event_attendee.checked_in', 'staff', jo, 'event_attendee', samId, 'true'],
        ['event_attendee.checked_in', 'staff', jo, 'event_attendee', alexId, 'true'],
      ].sort(byAttendee)
    )
    expect(rows.find((row) => row.entity_id === alexId)?.details.after).toEqual({
      waiver_accepted: true,
      waiver_method: 'in_person',
      waiver_accepted_at: '2099-06-15T11:00:00.000Z',
      extra_waiver_state: 'accepted',
      event_waiver_method: 'in_person',
      event_waiver_accepted_at: '2099-06-15T11:00:00.000Z',
      checked_in_at: '2099-06-15T11:00:00.000Z',
      waiver_version: 'v1',
      event_waiver_version: 'cold-plunge-v2',
    })
    // One key for the press, on every row; and never a name, an email or a date of birth.
    expect(new Set(rows.map((row) => row.details.key)).size).toBe(1)
    expect(JSON.stringify(rows)).not.toMatch(/Sam Test|Alex Guest|example\.com|1990-01-01/)
  })

  it('an older extra waiver version is not "signed": the list reads it as an older version, check-in is refused, and the tick signs it again in person at the current version', async () => {
    const eventId = await fixtures.event(db, { has_extra_waiver: true, extra_waiver_version: 'cold-plunge-v2' })
    const { attendees } = await booked(eventId, sam, ['Sam Test'])
    const [samId] = attendees as [string]
    await nowIs(LONDON.onTheDayNoon)
    expect((await waiver(samId, { which: 'both', accepted: true, method: 'email_link' })).data).toMatchObject({ waiver_accepted: true, extra_waiver_state: 'accepted', event_waiver_method: 'email_link' })
    // The text changes in Sanity after Sam signed it.
    await db.query("UPDATE events SET extra_waiver_version = 'cold-plunge-v3' WHERE id = $1", [eventId])
    expect((await listOf(eventId)).data?.bookings[0]?.attendees[0]?.extra_waiver_state).toBe('older_version')
    expect(outcomes(await checkIn([samId]))).toEqual(['waivers_outstanding'])
    expect((await attendeeRow(samId))?.['checked_in']).toBe(false)
    const [outcome] = (await checkIn([samId], { markWaiversSignedInPerson: true })).data?.results ?? []
    expect(outcome).toMatchObject({ updated: true, attendee: { extra_waiver_state: 'accepted', event_waiver_method: 'in_person', waiver_method: 'email_link' } })
    expect(await attendeeRow(samId)).toMatchObject({ checked_in: true, event_waiver_version: 'cold-plunge-v3', event_waiver_method: 'in_person', waiver_method: 'email_link' })
  })

  it('an attendee already checked in keeps their first time; nothing to check in answers nothing, and at most 100 are taken', async () => {
    const eventId = await fixtures.event(db)
    const { attendees } = await booked(eventId, sam, ['Sam Test'])
    const [samId] = attendees as [string]
    await waiverSigned(samId)
    await nowIs(LONDON.onTheDayNoon)
    await checkIn([samId])
    await nowIs(LONDON.onTheDay2330)
    const [again] = (await checkIn([samId])).data?.results ?? []
    expect(again?.updated === true ? again.attendee.checked_in_at : null).toBe('2099-06-15T11:00:00.000Z')
    expect((await checkIn([])).data).toEqual({ results: [] })
    expect((await checkIn('everyone')).data).toEqual({ results: [] })
    expect((await checkIn(undefined)).data).toEqual({ results: [] })
    const many = Array.from({ length: MAX_ATTENDEES_PER_CHECK_IN + 5 }, () => crypto.randomUUID())
    expect((await checkIn(many)).data?.results).toHaveLength(MAX_ATTENDEES_PER_CHECK_IN)
  })

  it('any active staff member may; an inactive account and a sign-in with no staff row are refused before anything happens; the same key answers again without checking in twice', async () => {
    const eventId = await fixtures.event(db)
    const { attendees } = await booked(eventId, sam, ['Sam Test'])
    const [samId] = attendees as [string]
    await waiverSigned(samId)
    await nowIs(LONDON.onTheDayNoon)
    expect(refusedWith(await checkIn([samId], {}, INA))).toMatchObject({ status: 403, words: INACTIVE })
    expect(refusedWith(await checkIn([samId], {}, NOBODY))).toMatchObject({ status: 401, words: NO_STAFF_ROW })
    expect((await attendeeRow(samId))?.['checked_in']).toBe(false)
    const key = crypto.randomUUID()
    const first = await checkIn([samId], {}, TIA, key)
    const again = await checkIn([samId], {}, TIA, key)
    expect(outcomes(first)).toEqual(['checked in'])
    expect([first.replayed, again.replayed]).toEqual([false, true])
    expect(again.data).toEqual(first.data)
    expect((await eventAuditRows()).map((row) => [row.action, row.actor_id])).toEqual([['event_attendee.checked_in', tia]])
  })

  it('a customer can never check anyone in or undo it: the channel is refused before anything else', async () => {
    const eventId = await fixtures.event(db)
    const { attendees } = await booked(eventId, sam, ['Sam Test'])
    const [samId] = attendees as [string]
    await nowIs(LONDON.onTheDayNoon)
    const asCustomer = { actor: { type: 'customer', id: sam } as unknown as AdminActor, requestId: 'req', pressKey: crypto.randomUUID() }
    const notAccepted = { status: 403, reason: 'channel_not_accepted', words: FLAG_CHANNEL_NOT_ACCEPTED_MESSAGE }
    expect(await refusalOf(checkInEventAttendees(db, { attendeeIds: [samId], markWaiversSignedInPerson: true }, asCustomer))).toEqual(notAccepted)
    expect(await refusalOf(undoEventAttendeeCheckIn(db, samId, asCustomer))).toEqual(notAccepted)
    expect((await attendeeRow(samId))?.['checked_in']).toBe(false)
  })
})

describe('undo check-in (POST events/attendees/:attendeeId/check-in/undo)', () => {
  it("un-checks a place still booked on a confirmed booking, whatever the window, and keeps the waivers signed; with its own audit row", async () => {
    const eventId = await fixtures.event(db)
    const { attendees } = await booked(eventId, sam, ['Sam Test'])
    const [samId] = attendees as [string]
    await nowIs(LONDON.onTheDayNoon)
    await checkIn([samId], { markWaiversSignedInPerson: true })
    // The day after: the window has closed, and a check-in can still be undone.
    await nowIs(LONDON.dayAfter0030)
    expect((await undo(samId, TIA)).data).toMatchObject({ id: samId, checked_in_at: null, waiver_accepted: true, waiver_method: 'in_person' })
    expect((await attendeeRow(samId))?.['checked_in']).toBe(false)
    expect((await eventAuditRows()).map((row) => [row.action, row.actor_id, row.entity_id, row.details.after?.['checked_in_at' as never]])).toEqual([
      ['event_attendee.checked_in', jo, samId, '2099-06-15T11:00:00.000Z'],
      ['event_attendee.check_in_undone', tia, samId, null],
    ])
  })

  it('is allowed on a cancelled event: its bookings can\'t be cancelled while a place is checked in', async () => {
    const eventId = await fixtures.event(db)
    const { attendees } = await booked(eventId, sam, ['Sam Test'])
    const [samId] = attendees as [string]
    await db.query('UPDATE event_attendees SET checked_in_at = now() WHERE id = $1', [samId])
    await db.query("UPDATE events SET active = false, cancelled_at = now(), cancel_reason = 'Storm' WHERE id = $1", [eventId])
    expect((await undo(samId)).data).toMatchObject({ id: samId, checked_in_at: null })
  })

  it("W48 report \"For the Worker step\" 5: refused for a place that is cancelled, a booking that isn't confirmed, and an attendee who isn't there, each in words of its own; the check-in stays", async () => {
    const eventId = await fixtures.event(db)
    const { attendees, bookingId } = await booked(eventId, sam, ['Sam Test', 'Alex Guest'])
    const [samId, alexId] = attendees as [string, string]
    await db.query('UPDATE event_attendees SET checked_in_at = now() WHERE event_booking_id = $1', [bookingId])
    await db.query('UPDATE event_attendees SET cancelled_at = now() WHERE id = $1', [alexId])
    expect(refusedWith(await undo(alexId))).toEqual({ status: 409, reason: 'attendee_cancelled', words: 'This place has been cancelled.' })
    await db.query("UPDATE event_bookings SET status = 'cancelled', places = 0 WHERE id = $1", [bookingId])
    expect(refusedWith(await undo(samId))).toEqual({ status: 409, reason: 'booking_not_confirmed', words: "This event booking isn't confirmed." })
    expect(refusedWith(await undo(UNKNOWN_ID))).toEqual({ status: 404, reason: 'attendee_not_found', words: 'This attendee no longer exists.' })
    expect(refusedWith(await undo('not-an-id'))).toEqual({ status: 404, reason: 'attendee_not_found', words: 'This attendee no longer exists.' })
    expect((await attendeeRow(samId))?.['checked_in']).toBe(true)
    expect((await attendeeRow(alexId))?.['checked_in']).toBe(true)
    expect(await eventAuditRows()).toEqual([])
  })
})

describe("an attendee's waivers (POST events/attendees/:attendeeId/waiver)", () => {
  it("what was asked for is checked first, in the old words (`invalid_params`): which waiver, both only to sign, and how it was signed", async () => {
    const eventId = await fixtures.event(db, { has_extra_waiver: true, extra_waiver_version: 'cold-plunge-v2' })
    const { attendees } = await booked(eventId, sam, ['Sam Test'])
    const [samId] = attendees as [string]
    const invalid = (words: string) => ({ status: 400, reason: 'invalid_params', words })
    expect(refusedWith(await waiver(samId, { which: 'all', accepted: true, method: 'in_person' }))).toEqual(invalid('Choose the standard or the extra waiver.'))
    expect(refusedWith(await waiver(samId, { which: 'both', accepted: false }))).toEqual(invalid('Revoke the standard or the extra waiver on its own.'))
    expect(refusedWith(await waiver(samId, { which: 'standard', accepted: true }))).toEqual(invalid('Choose how the waiver was signed.'))
    // `checkout` is the website's own (waivers/methods.ts): staff may not record it.
    expect(refusedWith(await waiver(samId, { which: 'standard', accepted: true, method: 'checkout' }))).toEqual(invalid('Choose how the waiver was signed.'))
    expect([...WAIVER_METHODS.staff]).toEqual(['in_person', 'email_link'])
    expect(await attendeeRow(samId)).toMatchObject({ waiver_accepted: false, event_waiver_accepted: false })
  })

  it("every refusal's words, in the old order: not there, the place cancelled, the booking not confirmed, no extra waiver, its text not synced", async () => {
    const eventId = await fixtures.event(db)
    const { attendees, bookingId } = await booked(eventId, sam, ['Sam Test', 'Alex Guest'])
    const [samId, alexId] = attendees as [string, string]
    expect(refusedWith(await waiver(UNKNOWN_ID, signed))).toEqual({ status: 404, reason: 'attendee_not_found', words: 'This attendee no longer exists.' })
    expect(refusedWith(await waiver('not-an-id', signed))).toEqual({ status: 404, reason: 'attendee_not_found', words: 'This attendee no longer exists.' })
    const noExtra = { status: 409, reason: 'no_extra_waiver', words: "This event doesn't have an extra waiver." }
    expect(refusedWith(await waiver(samId, { which: 'extra', accepted: true, method: 'in_person' }))).toEqual(noExtra)
    expect(refusedWith(await waiver(samId, { which: 'both', accepted: true, method: 'in_person' }))).toEqual(noExtra)
    expect(refusedWith(await waiver(samId, { which: 'extra', accepted: false }))).toEqual(noExtra)
    await db.query('UPDATE events SET has_extra_waiver = true, extra_waiver_version = NULL WHERE id = $1', [eventId])
    expect(refusedWith(await waiver(samId, { which: 'extra', accepted: true, method: 'email_link' }))).toEqual({ status: 409, reason: 'extra_waiver_version_missing', words: "The extra waiver text hasn't synced from Sanity yet, so it can't be marked signed." })
    await db.query('UPDATE event_attendees SET cancelled_at = now() WHERE id = $1', [alexId])
    expect(refusedWith(await waiver(alexId, signed))).toEqual({ status: 409, reason: 'attendee_cancelled', words: 'This place has been cancelled.' })
    await db.query("UPDATE event_bookings SET status = 'pending' WHERE id = $1", [bookingId])
    expect(refusedWith(await waiver(samId, signed))).toEqual({ status: 409, reason: 'booking_not_confirmed', words: "This event booking isn't confirmed." })
    expect(await attendeeRow(samId)).toMatchObject({ waiver_accepted: false, event_waiver_accepted: false })
    expect(await eventAuditRows()).toEqual([])
  })

  it('signs and revokes the standard waiver, the extra one (against the event\'s current version) and both; each with its audit row: who, which waiver, which way, and the versions', async () => {
    const eventId = await fixtures.event(db, { has_extra_waiver: true, extra_waiver_version: 'cold-plunge-v2' })
    const { attendees } = await booked(eventId, sam, ['Sam Test', 'Alex Guest'])
    const [samId, alexId] = attendees as [string, string]
    expect((await waiver(samId, signed, TIA)).data).toMatchObject({ id: samId, waiver_accepted: true, waiver_method: 'in_person', extra_waiver_state: 'pending', checked_in_at: null })
    expect((await waiver(samId, { which: 'extra', accepted: true, method: 'email_link' })).data).toMatchObject({ extra_waiver_state: 'accepted', event_waiver_method: 'email_link' })
    expect(await attendeeRow(samId)).toMatchObject({ waiver_version: 'v1', event_waiver_version: 'cold-plunge-v2' })
    expect((await waiver(samId, { which: 'standard', accepted: false })).data).toMatchObject({ waiver_accepted: false, waiver_method: null, waiver_accepted_at: null, extra_waiver_state: 'accepted' })
    expect((await waiver(samId, { which: 'extra', accepted: false })).data).toMatchObject({ extra_waiver_state: 'pending', event_waiver_method: null, event_waiver_accepted_at: null })
    expect((await waiver(alexId, { which: 'both', accepted: true, method: 'email_link' })).data).toMatchObject({ waiver_accepted: true, waiver_method: 'email_link', extra_waiver_state: 'accepted', event_waiver_method: 'email_link' })
    const rows = await eventAuditRows()
    expect(rows.map((row) => [row.action, row.actor_id, row.entity_id, row.details['which'], row.details['accepted']])).toEqual([
      ['event_attendee.waiver_set', tia, samId, 'standard', true],
      ['event_attendee.waiver_set', jo, samId, 'extra', true],
      ['event_attendee.waiver_set', jo, samId, 'standard', false],
      ['event_attendee.waiver_set', jo, samId, 'extra', false],
      ['event_attendee.waiver_set', jo, alexId, 'both', true],
    ])
    expect(rows[4]?.details.after).toMatchObject({ waiver_accepted: true, waiver_method: 'email_link', waiver_version: 'v1', extra_waiver_state: 'accepted', event_waiver_method: 'email_link', event_waiver_version: 'cold-plunge-v2' })
    expect(JSON.stringify(rows)).not.toMatch(/Sam Test|Alex Guest|example\.com|1990-01-01/)
  })

  it('a waiver already signed keeps how and when it was signed; an extra waiver signed on an older version is signed afresh', async () => {
    const eventId = await fixtures.event(db, { has_extra_waiver: true, extra_waiver_version: 'cold-plunge-v2' })
    const { attendees } = await booked(eventId, sam, ['Sam Test'])
    const [samId] = attendees as [string]
    await nowIs('2099-06-10 09:00:00+00')
    await waiver(samId, { which: 'both', accepted: true, method: 'email_link' })
    await nowIs('2099-06-11 09:00:00+00')
    const again = (await waiver(samId, { which: 'both', accepted: true, method: 'in_person' })).data
    expect(again).toMatchObject({ waiver_method: 'email_link', waiver_accepted_at: '2099-06-10T09:00:00.000Z', event_waiver_method: 'email_link', event_waiver_accepted_at: '2099-06-10T09:00:00.000Z' })
    await db.query("UPDATE events SET extra_waiver_version = 'cold-plunge-v3' WHERE id = $1", [eventId])
    const afresh = (await waiver(samId, { which: 'extra', accepted: true, method: 'in_person' })).data
    expect(afresh).toMatchObject({ extra_waiver_state: 'accepted', event_waiver_method: 'in_person', event_waiver_accepted_at: '2099-06-11T09:00:00.000Z', waiver_method: 'email_link' })
    expect((await attendeeRow(samId))?.['event_waiver_version']).toBe('cold-plunge-v3')
  })
})

describe('the waiver rule for the website (brief item 7; G-plan 4.8): the rule only, no route', () => {
  const byCustomer = (customerId: string): EventWaiverPress => ({ channel: 'customer', customerId, requestId: 'req_site', pressKey: crypto.randomUUID() })
  const link = { which: 'both', accepted: true, method: 'email_link' }

  it('a customer signs the waivers of an attendee on their own booking, by the emailed link; the audit row says the customer did, on the customer channel', async () => {
    const eventId = await fixtures.event(db, { has_extra_waiver: true, extra_waiver_version: 'cold-plunge-v2' })
    const { attendees } = await booked(eventId, sam, ['Sam Test', 'Alex Guest'])
    const [, alexId] = attendees as [string, string]
    expect(await setEventAttendeeWaiver(db, alexId, link, byCustomer(sam))).toMatchObject({ id: alexId, waiver_accepted: true, waiver_method: 'email_link', extra_waiver_state: 'accepted', event_waiver_method: 'email_link' })
    expect((await eventAuditRows()).map((row) => [row.action, row.actor_type, row.actor_id, row.entity_id, row.details['channel']])).toEqual([['event_attendee.waiver_set', 'customer', sam, alexId, 'customer']])
    expect([...WAIVER_METHODS.customer]).toEqual(['email_link'])
  })

  it("W52a: someone else's attendee is answered exactly as one that isn't there (the same status, code, reason, words and details), whatever state it is in, and nothing is signed; a method that isn't the website's, and a revoke, are refused too", async () => {
    const eventId = await fixtures.event(db, { has_extra_waiver: true, extra_waiver_version: 'cold-plunge-v2' })
    const { attendees, bookingId } = await booked(eventId, sam, ['Sam Test', 'Alex Guest'])
    const [samId, alexId] = attendees as [string, string]
    // Everything the refusal carries, so the two answers can be compared whole.
    const wholeRefusal = (press: Promise<unknown>) =>
      press.then(
        () => 'answered',
        (err: unknown) => (err instanceof ApiError ? { status: err.status, code: err.code, message: err.message, details: err.details } : String(err))
      )
    const sign = { which: 'standard', accepted: true, method: 'email_link' }
    const missing = await wholeRefusal(setEventAttendeeWaiver(db, UNKNOWN_ID, sign, byCustomer(mo)))
    expect(missing).toMatchObject({ status: 404, code: 'NOT_FOUND', message: 'This attendee no longer exists.', details: { reason: 'attendee_not_found' } })
    expect(await wholeRefusal(setEventAttendeeWaiver(db, samId, sign, byCustomer(mo)))).toEqual(missing)
    expect(await wholeRefusal(setEventAttendeeWaiver(db, samId, link, byCustomer(mo)))).toEqual(await wholeRefusal(setEventAttendeeWaiver(db, UNKNOWN_ID, link, byCustomer(mo))))
    // A cancelled place, and a place on a cancelled booking, of someone else's: still "no longer exists", never "has been cancelled".
    await db.query('UPDATE event_attendees SET cancelled_at = now() WHERE id = $1', [alexId])
    expect(await wholeRefusal(setEventAttendeeWaiver(db, alexId, sign, byCustomer(mo)))).toEqual(missing)
    await db.query("UPDATE event_bookings SET status = 'cancelled' WHERE id = $1", [bookingId])
    expect(await wholeRefusal(setEventAttendeeWaiver(db, samId, sign, byCustomer(mo)))).toEqual(missing)
    // …while the customer whose booking it is hears what staff would.
    expect(await refusalOf(setEventAttendeeWaiver(db, alexId, sign, byCustomer(sam)))).toEqual({ status: 409, reason: 'attendee_cancelled', words: 'This place has been cancelled.' })
    await db.query("UPDATE event_bookings SET status = 'confirmed' WHERE id = $1", [bookingId])
    expect((await attendeeRow(samId))?.['waiver_accepted']).toBe(false)
    expect(await refusalOf(setEventAttendeeWaiver(db, samId, { which: 'standard', accepted: true, method: 'in_person' }, byCustomer(sam)))).toEqual({ status: 400, reason: 'waiver_method_not_allowed', words: "That isn't a way a waiver can be signed online." })
    await waiverSigned(samId)
    expect(await refusalOf(setEventAttendeeWaiver(db, samId, { which: 'standard', accepted: false }, byCustomer(sam)))).toEqual({ status: 403, reason: 'customer_cannot_revoke', words: 'A signed waiver can only be withdrawn by the team at the club.' })
    expect((await attendeeRow(samId))?.['waiver_accepted']).toBe(true)
    expect(await eventAuditRows()).toEqual([])
  })

  it('not after the event: refused once it has ended (its end, or the end of its day when it has none); staff can still record one then', async () => {
    const eventId = await fixtures.event(db)
    const { attendees } = await booked(eventId, sam, ['Sam Test'])
    const [samId] = attendees as [string]
    const sign = { which: 'standard', accepted: true, method: 'email_link' }
    // 20:30 London on the day: the event ended at 20:00.
    await nowIs('2099-06-15 19:30:00+00')
    expect(await refusalOf(setEventAttendeeWaiver(db, samId, sign, byCustomer(sam)))).toEqual({
      status: 409,
      reason: 'event_passed',
      words: 'This event has already taken place, so the waiver can no longer be signed online. Please speak to the team at the club.',
    })
    expect((await attendeeRow(samId))?.['waiver_accepted']).toBe(false)
    expect((await waiver(samId, sign)).data).toMatchObject({ waiver_accepted: true })
    // 19:30 London on the day, while it is running: a customer still can.
    await db.query('UPDATE event_attendees SET waiver_accepted = false, waiver_method = NULL, waiver_version = NULL, waiver_accepted_at = NULL WHERE id = $1', [samId])
    await nowIs('2099-06-15 18:30:00+00')
    expect(await setEventAttendeeWaiver(db, samId, sign, byCustomer(sam))).toMatchObject({ waiver_accepted: true, waiver_method: 'email_link' })
  })
})

describe("W52's new words and reasons", () => {
  it('each new sentence, word for word', () => {
    expect(NEW.attendeeChanged).toBe('This attendee changed while this was being saved, so nothing was changed. Reload the page and try again.')
    // W52a: no words of its own for someone else's attendee, which is answered as one that isn't there.
    expect(Object.keys(NEW).sort()).toEqual(['attendeeChanged', 'customerCannotRevoke', 'customerEventPassed', 'customerWaiverMethod', 'cutoffCleared', 'cutoffEarlier'])
    expect(NEW.customerEventPassed).toBe('This event has already taken place, so the waiver can no longer be signed online. Please speak to the team at the club.')
    expect(NEW.customerCannotRevoke).toBe('A signed waiver can only be withdrawn by the team at the club.')
    expect(NEW.customerWaiverMethod).toBe("That isn't a way a waiver can be signed online.")
    expect(EVENT_WHOLE_CANCEL_NEW_WORDS.noRefundNeedsIssueRefunds).toBe('The club has cancelled this event, so cancelling a place on it with no refund needs the Issue refunds permission.')
    expect([...EVENT_ADMIN_NEW_REASONS]).toEqual(['cutoff_earlier', 'changed_since', 'attendee_changed', 'event_passed', 'customer_cannot_revoke', 'waiver_method_not_allowed'])
  })
})
