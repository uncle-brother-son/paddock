import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST as slotRemoveRoute } from '@/app/api/v1/staff/catalog/schedule-slots/[slotId]/remove/route'
import { POST as slotAddRoute } from '@/app/api/v1/staff/catalog/service-types/[serviceTypeId]/schedule-slots/route'
import { GET as bandQuoteRoute } from '@/app/api/v1/staff/sessions/[sessionId]/band/quote/route'
import { POST as bandResetRoute } from '@/app/api/v1/staff/sessions/[sessionId]/band/reset/route'
import { POST as bandRoute } from '@/app/api/v1/staff/sessions/[sessionId]/band/route'
import { POST as blockRoute } from '@/app/api/v1/staff/sessions/[sessionId]/block/route'
import { POST as startTimeRoute } from '@/app/api/v1/staff/sessions/[sessionId]/start-time/route'
import { POST as unblockRoute } from '@/app/api/v1/staff/sessions/[sessionId]/unblock/route'
import { GET as dayBandQuoteRoute } from '@/app/api/v1/staff/sessions/days/[date]/band/quote/route'
import { POST as dayBandRoute } from '@/app/api/v1/staff/sessions/days/[date]/band/route'
import { GET as blockDayQuoteRoute } from '@/app/api/v1/staff/sessions/days/[date]/block/quote/route'
import { POST as blockDayRoute } from '@/app/api/v1/staff/sessions/days/[date]/block/route'
import { GET as unblockDayQuoteRoute } from '@/app/api/v1/staff/sessions/days/[date]/unblock/quote/route'
import { POST as unblockDayRoute } from '@/app/api/v1/staff/sessions/days/[date]/unblock/route'
import { GET as forSlotRoute } from '@/app/api/v1/staff/sessions/for-slot/route'
import { GET as oneOffQuoteRoute } from '@/app/api/v1/staff/sessions/one-off/quote/route'
import { GET as sessionsRoute, POST as oneOffRoute } from '@/app/api/v1/staff/sessions/route'
import type { OneOffSessionQuoteRouteOutput } from '@/contracts'
import type { Db, SqlParam, Tx } from '@/server/db'
import { BAND_GUARD_SHARED_SQL, SESSION_DAY_LOCK_SQL } from '@/server/rules/admin/locks'
import { CHANGED_SINCE_WORDS } from '@/server/rules/admin/stamp'
import { STAFF_ADMIN_WORDS } from '@/server/rules/staff/failure-messages'
import { ADMIN_TEST_KEY, auditRowsOf, pressRoute, type AdminAnswer, type AdminRouteHandler } from '@/server/rules/testing/admin-routes'
import { fixtures, insert, startTestDatabase, type TestDatabase } from '@/server/rules/testing/database'
import { blockDay, createOneOffSession, isValidIsoDateTime, resetSessionBand, setSessionBand, setSessionStartTime, unblockDay } from './admin'
import { COUNTS_CHANGED_REASON, MOVE_IN_FLIGHT_REASON, SESSION_ADMIN_DIALOG_WORDS, SESSION_ADMIN_NEW_WORDS, SESSION_ADMIN_WORDS } from './admin-failure-messages'

vi.setConfig({ testTimeout: 60_000 })

// Brief W51 items 2 and 4 to 10 ("Parity and tests"; G-plan 5, W51's tests): the session and timetable routes on the
// live schema. The two reads, field for field, by the London day; every write's old refusals in the old words and
// the new ones; GB5 (a pending and a Payment needed booking stop a block), GB6 (a Payment needed booking stops a
// start-time change), GB7 (unblock on an open session, a day block over an earlier block, Unblock Day); Q18's rule
// for counts; Q50 part 2 (weekly slots need Manage pricing) and part 1 (a slot reaches no date already made); the
// order of the locks; the audit rows. The races, with two connections, are in admin-postgres.test.ts; the nightly job
// in testing/migration-032.test.ts; London's wall clock in re-banding in pricing/reband-london-now.test.ts.

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))

const JO = 'jo@example.com'
const TIA = 'tia@example.com'
const INA = 'ina@example.com'
const NO_PRICING = STAFF_ADMIN_WORDS.pricingStaff.youDoNotHavePermissionManage
const INACTIVE = STAFF_ADMIN_WORDS.staffAccess.staffAccountInactiveAskAdminReactivate
const NO_STAFF = STAFF_ADMIN_WORDS.staffAccess.noStaffRecordMatchesLoggedIn('nobody@example.com')
const NEW = SESSION_ADMIN_NEW_WORDS
const UNKNOWN_ID = '10000000-0000-4000-8000-000000000f4f'
// 1 March 2031 is a Saturday, 2 March a Sunday.
const SAT = '2031-03-01'
const SUN = '2031-03-02'

let database: TestDatabase
let db: Db
let jo = ''
let tia = ''
let sam = ''
let mo = ''
let core = ''
let peak = ''
let sauna = ''
let hire = ''
let morning = ''
let afternoon = ''
let evening = ''

beforeAll(async () => {
  process.env.STAFF_API_KEY = ADMIN_TEST_KEY
  database = await startTestDatabase({ schema: 'live' })
  db = database.db
  holder.db = db
})
afterAll(() => database.stop())

/**
 * Jo (admin, Manage pricing), Tia (staff, no Manage pricing) and Ina (inactive); Sam and Mo; Core GBP 20 until 17:00
 * and Peak GBP 25.50 after, every day; a public Sauna (60 minutes, 10 places) with sessions on Saturday 1 March 2031
 * at 10:00 and 14:00 (Core) and 18:00 (Peak); a Private Hire with no duration set.
 */
beforeEach(async () => {
  await database.pg.exec(
    'RESET ROLE; TRUNCATE audit_log, api_idempotency, pending_reader_payments, booking_guests, order_line_items, orders, bookings, sessions, sessions_made_up_to, closed_dates, service_type_schedule_slots, service_types, band_rules, session_bands, customers, staff CASCADE; SET ROLE paddock_worker;'
  )
  jo = await insert(db, 'staff', { role: 'admin', first_name: 'Jo', last_name: 'Staff', email: JO, can_issue_refunds: true, can_manage_pricing: true })
  tia = await insert(db, 'staff', { role: 'staff', first_name: 'Tia', last_name: 'Team', email: TIA })
  await insert(db, 'staff', { role: 'staff', first_name: 'Ina', last_name: 'Gone', email: INA, active: false })
  sam = await fixtures.customer(db, { first_name: 'Sam', last_name: 'Test', email: 'sam@example.com' })
  mo = await fixtures.customer(db, { first_name: 'Mo', last_name: 'Member', email: 'mo@example.com' })
  core = await insert(db, 'session_bands', { code: 'core', name: 'Core', price: '20.00' })
  peak = await insert(db, 'session_bands', { code: 'peak', name: 'Peak', price: '25.50' })
  for (let day = 0; day <= 6; day++) {
    await insert(db, 'band_rules', { band_id: core, day_of_week: day, from_time: '00:00', to_time: '17:00' })
    await insert(db, 'band_rules', { band_id: peak, day_of_week: day, from_time: '17:00', to_time: '24:00' })
  }
  sauna = await insert(db, 'service_types', { name: 'Sauna', booking_type: 'public', duration: 60, capacity: 10 })
  hire = await insert(db, 'service_types', { name: 'Private Hire', booking_type: 'private', capacity: 10 })
  morning = await sessionAt(`${SAT} 10:00`)
  afternoon = await sessionAt(`${SAT} 14:00`)
  evening = await sessionAt(`${SAT} 18:00`)
})

/** A Sauna session at a London wall-clock time (stored as those digits labelled UTC); its band comes from the day's windows. */
async function sessionAt(start: string, more: Record<string, unknown> = {}): Promise<string> {
  const [row] = await db.query<{ id: string }>(
    "INSERT INTO sessions (service_type_id, start_time, end_time, type, capacity) VALUES ($1::uuid, $2::timestamptz, $2::timestamptz + interval '1 hour', $3, 10) RETURNING id",
    [(more['service_type_id'] as string | undefined) ?? sauna, `${start}:00+00`, (more['type'] as string | undefined) ?? 'public']
  )
  return row?.id as string
}
/** A booking on a session, with its places counted on the session as an order would. */
async function bookingOn(session: string, customer: string, status = 'confirmed', row: Record<string, unknown> = {}): Promise<string> {
  const [times] = await db.query<{ start_time: Date; end_time: Date }>('SELECT start_time, end_time FROM sessions WHERE id = $1', [session])
  return fixtures.booking(db, { session_id: session, customer_id: customer, party_size: 1, price_paid: '20.00', redemption_source: 'paid', status, start_time: times?.start_time, end_time: times?.end_time, ...row })
}
interface SessionState {
  status: string
  blocked_reason: string | null
  blocked_by: string | null
  band_id: string | null
  band_overridden: boolean
  start_time: string
  end_time: string
}
const stateOf = async (session: string): Promise<SessionState | undefined> =>
  (
    await db.query<SessionState>(
      `SELECT status, blocked_reason, blocked_by, band_id, band_overridden,
              to_char(start_time AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') AS start_time, to_char(end_time AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') AS end_time
         FROM sessions WHERE id = $1`,
      [session]
    )
  )[0]
const blockOf = async (session: string) => {
  const state = await stateOf(session)
  return [state?.status, state?.blocked_reason, state?.blocked_by]
}

type Details = { reason?: string; message?: string; action?: string; conflictingBookings?: Array<Record<string, unknown>>; counts?: Record<string, number> }
const detailsOf = (answer: AdminAnswer): Details | undefined => answer.error?.details as Details | undefined
const refusedWith = (answer: AdminAnswer) => ({ status: answer.status, reason: answer.reason, words: answer.error?.message })
const post = <T = Record<string, unknown>>(route: AdminRouteHandler, params: Record<string, string>, body: unknown = {}, email: string | null = JO, key?: string) =>
  pressRoute<T>(route, 'POST', { email, params, body, ...(key !== undefined ? { key } : {}) })
/** A GET with a query string, as the staff app's callWorker sends one. */
async function get<T = unknown>(route: AdminRouteHandler, query: Record<string, string> = {}, params: Record<string, string> = {}, email: string | null = JO): Promise<AdminAnswer<T>> {
  const withQuery: AdminRouteHandler = (request, context) => {
    const url = new URL(request.url)
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value)
    return route(new Request(url, { method: request.method, headers: request.headers }), context)
  }
  return pressRoute<T>(withQuery, 'GET', { email, params })
}
const by = (id = jo, canManagePricing = true) => ({ actor: { type: 'staff' as const, id, role: 'admin' as const, canManagePricing, canIssueRefunds: true }, requestId: crypto.randomUUID(), pressKey: crypto.randomUUID() })
/** A client that keeps every statement the rule runs inside its transaction, in order. */
function watching(inner: Db): { db: Db; seen: Array<{ sql: string; params: readonly SqlParam[] }> } {
  const seen: Array<{ sql: string; params: readonly SqlParam[] }> = []
  const watched = new Proxy(inner, {
    get(target, property, receiver) {
      if (property !== 'transaction') return Reflect.get(target, property, receiver) as unknown
      return <R>(fn: (tx: Tx) => Promise<R>) =>
        target.transaction((tx) =>
          fn(
            new Proxy(tx, {
              get(innerTx, name, innerReceiver) {
                if (name !== 'query') return Reflect.get(innerTx, name, innerReceiver) as unknown
                return (sql: string, params?: readonly SqlParam[]) => {
                  seen.push({ sql: sql.trim().replace(/\s+/g, ' '), params: params ?? [] })
                  return innerTx.query(sql, params)
                }
              },
            })
          )
        )
    },
  })
  return { db: watched, seen }
}
const SESSION_LOCK = 'SELECT id FROM sessions WHERE id = ANY($1::uuid[]) ORDER BY id FOR NO KEY UPDATE'
/** W51a (W51 review L4): the band a press sets, read and held inside its transaction. */
const BAND_HELD = 'SELECT id FROM session_bands WHERE id = $1::uuid AND active = true FOR SHARE'

interface CalendarRow {
  id: string
  [field: string]: unknown
}
interface Calendar {
  sessions: CalendarRow[]
  madeUpTo: string | null
  closedDates: Array<{ date: string; reason: string | null }>
}

// ---------------------------------------------------------------------------------------------------------------------

describe('GET sessions (getSessionsForRange): the calendar, and the date sessions are made up to', () => {
  it('answers each session field for field, by start time, with its band, its confirmed bookings counted, blocked or not', async () => {
    await bookingOn(morning, sam)
    await bookingOn(morning, mo, 'payment_needed')
    await db.query("UPDATE sessions SET status = 'blocked', blocked_reason = 'Boiler repair', blocked_by = $1 WHERE id = $2", [tia, evening])
    const answer = await get<Calendar>(sessionsRoute, { startDate: SAT, endDate: SAT })
    expect(answer.status).toBe(200)
    expect(answer.data?.sessions.map((row) => row.id)).toEqual([morning, afternoon, evening])
    expect(answer.data?.sessions[0]).toEqual({
      id: morning,
      service_type_id: sauna,
      service_type_name: 'Sauna',
      booking_type: 'public',
      start_time: `${SAT}T10:00:00.000Z`,
      end_time: `${SAT}T11:00:00.000Z`,
      capacity: 10,
      total_booked: 0,
      status: 'open',
      blocked_reason: null,
      blocked_by: null,
      started: false,
      band_id: core,
      band_code: 'core',
      band_name: 'Core',
      band_price: '20.00',
      band_overridden: false,
      // Confirmed only, as before: the Payment needed booking isn't counted here (the screens gate on total_booked).
      confirmed_booking_count: 1,
    })
    expect(answer.data?.sessions[2]).toMatchObject({ status: 'blocked', blocked_reason: 'Boiler repair', blocked_by: tia, band_code: 'peak', band_price: '25.50' })
    // A day with none.
    expect((await get<Calendar>(sessionsRoute, { startDate: SUN, endDate: SUN })).data?.sessions).toEqual([])
  })

  it('answers the date the nightly job has made sessions up to: null with no row, the date once it has one', async () => {
    expect((await get<Calendar>(sessionsRoute, { startDate: SAT, endDate: SAT })).data?.madeUpTo).toBeNull()
    await database.pg.exec("RESET ROLE; INSERT INTO public.sessions_made_up_to (made_up_to) VALUES ('2027-02-26'); SET ROLE paddock_worker;")
    expect((await get<Calendar>(sessionsRoute, { startDate: SAT, endDate: SAT })).data?.madeUpTo).toBe('2027-02-26')
    // Whatever range is asked for, and with no session in it.
    expect((await get<Calendar>(sessionsRoute, { startDate: '2020-01-01', endDate: '2020-01-01' })).data).toEqual({ sessions: [], madeUpTo: '2027-02-26', closedDates: [] })
  })

  it('a range is by the London day, both ends included: 00:30 is on its own day and 23:30 on the day before it, whatever the connection\'s time zone', async () => {
    const lateNight = await sessionAt('2027-07-01 23:30')
    const afterMidnight = await sessionAt('2027-07-02 00:30')
    const days = async (query: Db | Tx) => {
      const { listSessions } = await import('./admin')
      const actor = by().actor
      return [
        (await listSessions(query, { startDate: '2027-07-01', endDate: '2027-07-01' }, { actor })).sessions.map((row) => row.id),
        (await listSessions(query, { startDate: '2027-07-02', endDate: '2027-07-02' }, { actor })).sessions.map((row) => row.id),
        (await listSessions(query, { startDate: '2027-07-01', endDate: '2027-07-02' }, { actor })).sessions.map((row) => row.id),
      ]
    }
    const expected = [[lateNight], [afterMidnight], [lateNight, afterMidnight]]
    expect(await days(db)).toEqual(expected)
    for (const zone of ['America/New_York', 'Europe/London', 'Asia/Tokyo']) {
      const seen = await db.transaction(async (tx) => {
        await tx.query("SELECT set_config('TimeZone', $1, true)", [zone])
        return days(tx)
      })
      expect(seen, zone).toEqual(expected)
    }
  })

  it('GB14: an inactive account, a sign-in with no staff row, and a wrong key are refused; a date that isn\'t one is refused before anything is read', async () => {
    expect(refusedWith(await get(sessionsRoute, { startDate: SAT, endDate: SAT }, {}, INA))).toEqual({ status: 403, reason: undefined, words: INACTIVE })
    expect(refusedWith(await get(sessionsRoute, { startDate: SAT, endDate: SAT }, {}, 'nobody@example.com'))).toEqual({ status: 401, reason: undefined, words: NO_STAFF })
    expect((await pressRoute(sessionsRoute, 'GET', { email: JO, bearer: 'wrong-key' })).status).toBe(401)
    expect((await get(sessionsRoute, { startDate: 'tomorrow', endDate: SAT })).status).toBe(400)
    expect((await get(sessionsRoute, { startDate: SAT })).status).toBe(400)
    // Any active staff member may read it.
    expect((await get(sessionsRoute, { startDate: SAT, endDate: SAT }, {}, TIA)).status).toBe(200)
  })
})

describe('GET sessions/for-slot (getServiceTypesForSlot)', () => {
  it('answers the service types with a weekly slot at that weekday and time and a session made for it, field for field; none at another time', async () => {
    await insert(db, 'service_type_schedule_slots', { service_type_id: sauna, day_of_week: 6, start_time: '10:00' })
    const answer = await get<Array<Record<string, unknown>>>(forSlotRoute, { startTime: `${SAT}T10:00:00.000Z` })
    expect(answer.data).toEqual([
      {
        service_type_id: sauna,
        service_type_name: 'Sauna',
        booking_type: 'public',
        duration: 60,
        session_id: morning,
        start_time: `${SAT}T10:00:00.000Z`,
        end_time: `${SAT}T11:00:00.000Z`,
        capacity: 10,
        total_booked: 0,
        status: 'open',
        blocked_reason: null,
        started: false,
        band_id: core,
        band_code: 'core',
        band_name: 'Core',
        band_price: '20.00',
        band_overridden: false,
      },
    ])
    // 14:00 has a session and no weekly slot; a time that isn't one answers none.
    expect((await get(forSlotRoute, { startTime: `${SAT}T14:00:00.000Z` })).data).toEqual([])
    expect((await get(forSlotRoute, { startTime: 'next Saturday' })).data).toEqual([])
    expect(refusedWith(await get(forSlotRoute, { startTime: `${SAT}T10:00:00.000Z` }, {}, INA))).toEqual({ status: 403, reason: undefined, words: INACTIVE })
  })

  it("the weekday and the time are read from the stored digits, whatever the connection's time zone (00:30 on a summer Friday is Friday's slot)", async () => {
    // 2 July 2027 is a Friday. In New York that moment is still Thursday evening; in Tokyo it is 09:30.
    const afterMidnight = await sessionAt('2027-07-02 00:30')
    await insert(db, 'service_type_schedule_slots', { service_type_id: sauna, day_of_week: 5, start_time: '00:30' })
    const { serviceTypesForSlot } = await import('./admin')
    for (const zone of ['UTC', 'America/New_York', 'Europe/London', 'Asia/Tokyo']) {
      const rows = await db.transaction(async (tx) => {
        await tx.query("SELECT set_config('TimeZone', $1, true)", [zone])
        return serviceTypesForSlot(tx, '2027-07-02T00:30:00.000Z', { actor: by().actor })
      })
      expect(rows.map((row) => row.session_id), zone).toEqual([afterMidnight])
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------------

describe('POST sessions/:sessionId/block (blockSession, GB5 and GB7)', () => {
  const block = (session: string, reason: unknown = 'Staff training', email: string | null = JO, key?: string) => post(blockRoute, { sessionId: session }, { reason }, email, key)

  it('blocks an open session with the reason and who, answers the old shape with the session by named columns, and writes one audit row', async () => {
    const answer = await block(morning, 'Staff training', TIA)
    expect(answer.status).toBe(200)
    expect(answer.data).toMatchObject({ blocked: true, conflict: false, conflictingBookings: [], session: { id: morning, status: 'blocked', blocked_reason: 'Staff training', blocked_by: tia, start_time: `${SAT}T10:00:00.000Z` } })
    expect(Object.keys((answer.data as { session: Record<string, unknown> }).session).sort()).toEqual(
      ['band_id', 'band_overridden', 'blocked_by', 'blocked_reason', 'capacity', 'created_at', 'end_time', 'id', 'resource_id', 'service_type_id', 'start_time', 'status', 'total_booked', 'type', 'updated_at']
    )
    expect(await blockOf(morning)).toEqual(['blocked', 'Staff training', tia])
    const rows = await auditRowsOf(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      action: 'session.blocked',
      actor_type: 'staff',
      actor_id: tia,
      entity_type: 'session',
      entity_id: morning,
      details: { before: { id: morning, status: 'open', blocked_reason: null, blocked_by: null }, after: { id: morning, status: 'blocked', blocked_reason: 'Staff training', blocked_by: tia } },
    })
    expect(typeof rows[0]?.details.key).toBe('string')
  })

  it.each(['pending', 'confirmed', 'payment_needed', 'completed', 'no-show'])('GB5: a %s booking stops the block and is listed; nothing is written', async (status) => {
    const booking = await bookingOn(morning, sam, status)
    const answer = await block(morning)
    expect(refusedWith(answer)).toEqual({ status: 409, reason: 'bookings_in_the_way', words: 'This slot has 1 booking. Move each one to a different session or cancel it before this slot can be blocked.' })
    expect(detailsOf(answer)?.conflictingBookings).toEqual([{ id: booking, customer_first_name: 'Sam', customer_last_name: 'Test', party_size: 1, price_paid: '20.00', redemption_source: 'paid', status }])
    expect(await blockOf(morning)).toEqual(['open', null, null])
    expect(await auditRowsOf(db)).toEqual([])
  })

  it('a cancelled booking stops nothing; two bookings are listed oldest first, with the count in the words', async () => {
    await bookingOn(afternoon, sam, 'cancelled')
    expect((await block(afternoon)).status).toBe(200)
    const first = await bookingOn(morning, sam, 'payment_needed', { created_at: '2031-01-01 09:00:00+00' })
    const second = await bookingOn(morning, mo, 'pending', { created_at: '2031-01-02 09:00:00+00' })
    const answer = await block(morning)
    expect(answer.error?.message).toBe('This slot has 2 bookings. Move each one to a different session or cancel it before this slot can be blocked.')
    expect(detailsOf(answer)?.conflictingBookings?.map((row) => row['id'])).toEqual([first, second])
  })

  it('GB7: a session already blocked is refused and keeps its reason and who; a session that isn\'t there is refused (the old function answered "blocked")', async () => {
    await block(morning, 'Boiler repair', TIA)
    expect(refusedWith(await block(morning, 'Staff day'))).toEqual({ status: 409, reason: 'already_blocked', words: NEW.alreadyBlocked })
    expect(await blockOf(morning)).toEqual(['blocked', 'Boiler repair', tia])
    expect(refusedWith(await block(UNKNOWN_ID))).toEqual({ status: 404, reason: 'session_not_found', words: NEW.sessionGone })
    expect(refusedWith(await block('not-an-id'))).toEqual({ status: 404, reason: 'session_not_found', words: NEW.sessionGone })
    expect((await auditRowsOf(db)).map((row) => row.action)).toEqual(['session.blocked'])
  })

  it('who may: any active staff member; an inactive account and a sign-in with no staff row are refused before anything is read; the same key answers the first press', async () => {
    expect(refusedWith(await block(morning, 'x', INA))).toEqual({ status: 403, reason: undefined, words: INACTIVE })
    expect(refusedWith(await block(morning, 'x', 'nobody@example.com'))).toEqual({ status: 401, reason: undefined, words: NO_STAFF })
    expect(await blockOf(morning)).toEqual(['open', null, null])
    const key = crypto.randomUUID()
    const first = await block(morning, 'Staff training', TIA, key)
    const again = await block(morning, 'Staff training', TIA, key)
    expect(first.status).toBe(200)
    expect(again.replayed).toBe(true)
    expect(again.data).toEqual(first.data)
    expect(await auditRowsOf(db)).toHaveLength(1)
    // No key at all is refused by the route.
    expect((await pressRoute(blockRoute, 'POST', { email: JO, params: { sessionId: afternoon }, body: { reason: 'x' }, key: null })).ok).toBe(false)
  })

  it('the bookings are read under the session\'s lock: the lock is the first statement, then the row, then the bookings, then the block', async () => {
    const { blockSession } = await import('./admin')
    const { db: watched, seen } = watching(db)
    await blockSession(watched, morning, 'Staff training', by())
    const at = (starts: string) => seen.findIndex((one) => one.sql.startsWith(starts))
    expect(seen[0]?.sql).toBe(SESSION_LOCK)
    expect(seen[0]?.params[0]).toEqual([morning])
    const conflicts = seen.findIndex((one) => one.sql.includes("b.status <> 'cancelled'"))
    expect(conflicts).toBeGreaterThan(0)
    // W51a (S1): the Moves in flight off the session are read under the same lock, after the bookings and before the block.
    const movesOff = seen.findIndex((one) => one.sql.includes('FROM pending_reader_payments p') && one.sql.includes("p.snapshot->>'old_session_id' = $1::text"))
    expect(movesOff).toBeGreaterThan(conflicts)
    // W51a (L1): the clock is read after the lock and before the block is written.
    const clock = seen.findIndex((one) => one.sql.includes('clock_timestamp()'))
    expect(clock).toBeGreaterThan(movesOff)
    expect(at('UPDATE sessions')).toBeGreaterThan(clock)
  })
})

describe('POST sessions/:sessionId/unblock (unblockSession, GB7)', () => {
  const unblock = (session: string, email: string | null = JO) => post(unblockRoute, { sessionId: session }, {}, email)

  it('reopens a blocked session, clears its reason and who, answers its row, and writes one audit row', async () => {
    await db.query("UPDATE sessions SET status = 'blocked', blocked_reason = 'Boiler repair', blocked_by = $1 WHERE id = $2", [jo, morning])
    const answer = await unblock(morning, TIA)
    expect(answer.status).toBe(200)
    expect(answer.data).toMatchObject({ id: morning, status: 'open', blocked_reason: null, blocked_by: null })
    expect(await blockOf(morning)).toEqual(['open', null, null])
    const rows = await auditRowsOf(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ action: 'session.unblocked', actor_id: tia, entity_type: 'session', entity_id: morning, details: { before: { status: 'blocked', blocked_reason: 'Boiler repair', blocked_by: jo }, after: { status: 'open', blocked_reason: null, blocked_by: null } } })
  })

  it('GB7: unblock on an open session is refused and changes nothing, not even its updated_at; a session that isn\'t there is refused', async () => {
    const before = (await db.query<{ updated_at: Date }>('SELECT updated_at FROM sessions WHERE id = $1', [morning]))[0]?.updated_at
    expect(refusedWith(await unblock(morning))).toEqual({ status: 409, reason: 'not_blocked', words: NEW.notBlocked })
    expect((await db.query<{ updated_at: Date }>('SELECT updated_at FROM sessions WHERE id = $1', [morning]))[0]?.updated_at).toEqual(before)
    expect(refusedWith(await unblock(UNKNOWN_ID))).toEqual({ status: 404, reason: 'session_not_found', words: NEW.sessionGone })
    expect(refusedWith(await unblock(morning, INA))).toEqual({ status: 403, reason: undefined, words: INACTIVE })
    expect(await auditRowsOf(db)).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------------------------------

describe('Block Day and Unblock Day (blockDay, unblockDay; GB5, GB7, Q18\'s rule, W48 review L1)', () => {
  interface BlockQuote {
    sessions: number
    toBlock: number
    alreadyBlocked: number
    conflictingBookings: Array<Record<string, unknown>>
    closed: boolean
    afterMadeUpTo: boolean
  }
  interface UnblockQuote {
    blockedSessions: number
    blockedBefore: number
    closedDates: number
    closedReason: string | null
  }
  const blockQuote = async (date = SAT, email: string | null = JO) => get<BlockQuote>(blockDayQuoteRoute, {}, { date }, email)
  const blockTheDay = (date: string, seen: unknown, reason: unknown = 'Staff day', email: string | null = JO) => post(blockDayRoute, { date }, { reason, seen }, email)
  const unblockQuote = async (date = SAT, email: string | null = JO) => get<UnblockQuote>(unblockDayQuoteRoute, {}, { date }, email)
  const unblockTheDay = (date: string, seen: unknown, email: string | null = JO) => post(unblockDayRoute, { date }, { seen }, email)
  /** Block Day as the dialog presses it: the quote, then the press with the figures it showed. */
  const pressBlockDay = async (date = SAT, reason = 'Staff day', email: string | null = JO) => {
    const quote = (await blockQuote(date, email)).data
    return blockTheDay(date, { toBlock: quote?.toBlock, alreadyBlocked: quote?.alreadyBlocked }, reason, email)
  }
  const pressUnblockDay = async (date = SAT) => unblockTheDay(date, (await unblockQuote(date)).data)

  it('the quote says how many it would block and how many are blocked already; the press blocks the open ones with the reason and who, and one audit row for the day names them', async () => {
    expect((await blockQuote()).data).toEqual({ sessions: 3, toBlock: 3, alreadyBlocked: 0, conflictingBookings: [], closed: false, afterMadeUpTo: false })
    const answer = await pressBlockDay(SAT, 'Staff day', TIA)
    expect(answer.status).toBe(200)
    expect(answer.data).toEqual({ blocked: true, conflict: false, conflictingBookings: [], blockedCount: 3, alreadyBlocked: 0, closedDate: true })
    for (const session of [morning, afternoon, evening]) expect(await blockOf(session)).toEqual(['blocked', 'Staff day', tia])
    const rows = await auditRowsOf(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ action: 'session.blocked', actor_id: tia, entity_type: 'session_day', entity_id: SAT, details: { date: SAT, blockedCount: 3, alreadyBlocked: 0 } })
    expect((rows[0]?.details['sessionIds'] as string[]).sort()).toEqual([morning, afternoon, evening].sort())
    expect((rows[0]?.details.before as Array<{ status: string }>).map((row) => row.status)).toEqual(['open', 'open', 'open'])
    expect((rows[0]?.details.after as Array<{ status: string }>).map((row) => row.status)).toEqual(['blocked', 'blocked', 'blocked'])
    // A day with no sessions: nothing to block, answered as before.
    expect((await pressBlockDay(SUN)).data).toEqual({ blocked: true, conflict: false, conflictingBookings: [], blockedCount: 0, alreadyBlocked: 0, closedDate: true })
  })

  it.each(['pending', 'payment_needed'])('GB5: a %s booking anywhere on the day stops Block Day and is listed with its session; nothing is blocked', async (status) => {
    const booking = await bookingOn(afternoon, sam, status)
    const quote = (await blockQuote()).data
    expect(quote?.conflictingBookings).toEqual([
      {
        id: booking,
        session_id: afternoon,
        service_type_name: 'Sauna',
        booking_type: 'public',
        session_start_time: `${SAT}T14:00:00.000Z`,
        session_end_time: `${SAT}T15:00:00.000Z`,
        customer_first_name: 'Sam',
        customer_last_name: 'Test',
        party_size: 1,
        price_paid: '20.00',
        redemption_source: 'paid',
        status,
      },
    ])
    const answer = await blockTheDay(SAT, { toBlock: 3, alreadyBlocked: 0 })
    expect(refusedWith(answer)).toEqual({ status: 409, reason: 'bookings_in_the_way', words: '1 booking exists on this day. Move each one to a different session or cancel it before the day can be blocked.' })
    expect(detailsOf(answer)?.conflictingBookings).toEqual(quote?.conflictingBookings)
    for (const session of [morning, afternoon, evening]) expect(await blockOf(session)).toEqual(['open', null, null])
    expect(await auditRowsOf(db)).toEqual([])
    // Cancelled, the day can be blocked.
    await db.query("UPDATE bookings SET status = 'cancelled' WHERE id = $1", [booking])
    expect((await pressBlockDay()).status).toBe(200)
  })

  it('GB7: a day block over an earlier block leaves that block\'s reason and who, and says so; Unblock Day then reopens what the day blocked and leaves the earlier block', async () => {
    // The 14:00 was blocked on its own, for a repair, by Tia, through the route (so its block is on record).
    expect((await post(blockRoute, { sessionId: afternoon }, { reason: 'Boiler repair' }, TIA)).status).toBe(200)
    expect((await blockQuote()).data).toMatchObject({ sessions: 3, toBlock: 2, alreadyBlocked: 1 })
    expect((await pressBlockDay()).data).toMatchObject({ blocked: true, blockedCount: 2, alreadyBlocked: 1 })
    expect(await blockOf(morning)).toEqual(['blocked', 'Staff day', jo])
    expect(await blockOf(afternoon)).toEqual(['blocked', 'Boiler repair', tia])
    expect(await blockOf(evening)).toEqual(['blocked', 'Staff day', jo])

    // Unblock Day: the two the day blocked will reopen; the repair block was there before the day was.
    expect((await unblockQuote()).data).toEqual({ blockedSessions: 2, blockedBefore: 1, closedDates: 1, closedReason: 'Staff day' })
    const answer = await pressUnblockDay()
    expect(answer.data).toEqual({ confirmed: true, blockedSessions: 2, blockedBefore: 1, unblocked: 2, closedDateRemoved: true })
    expect(await blockOf(morning)).toEqual(['open', null, null])
    expect(await blockOf(afternoon)).toEqual(['blocked', 'Boiler repair', tia])
    expect(await blockOf(evening)).toEqual(['open', null, null])
    const rows = await auditRowsOf(db)
    expect(rows.map((row) => [row.action, row.entity_type])).toEqual([['session.blocked', 'session'], ['session.blocked', 'session_day'], ['session.unblocked', 'session_day']])
    expect(rows[2]?.details).toMatchObject({ date: SAT, unblocked: 2, leftBlocked: 1 })
    expect((rows[2]?.details['sessionIds'] as string[]).sort()).toEqual([morning, evening].sort())
    // Pressed again: nothing left that the day blocked.
    expect((await unblockQuote()).data).toEqual({ blockedSessions: 0, blockedBefore: 1, closedDates: 0, closedReason: null })
    expect((await pressUnblockDay()).data).toMatchObject({ unblocked: 0, blockedBefore: 1, closedDateRemoved: false })
  })

  it('GB7: a session blocked before these records were kept (no audit row) counts as blocked on its own and stays blocked; one unblocked and blocked again on its own after a day block stays blocked too', async () => {
    await db.query("UPDATE sessions SET status = 'blocked', blocked_reason = 'From before', blocked_by = $1 WHERE id = $2", [tia, afternoon])
    expect((await unblockQuote()).data).toEqual({ blockedSessions: 0, blockedBefore: 1, closedDates: 0, closedReason: null })
    await pressBlockDay()
    // The morning is reopened on its own, then blocked again on its own: its latest block is its own, not the day's.
    expect((await post(unblockRoute, { sessionId: morning })).status).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect((await post(blockRoute, { sessionId: morning }, { reason: 'Deep clean' })).status).toBe(200)
    expect((await unblockQuote()).data).toEqual({ blockedSessions: 1, blockedBefore: 2, closedDates: 1, closedReason: 'Staff day' })
    await pressUnblockDay()
    expect(await blockOf(morning)).toEqual(['blocked', 'Deep clean', jo])
    expect(await blockOf(afternoon)).toEqual(['blocked', 'From before', tia])
    expect(await blockOf(evening)).toEqual(['open', null, null])
  })

  it("Q18's rule: a press whose figures are no longer right is refused with the new ones, and nothing is written; a press with no figures is refused the same way", async () => {
    // Block Day: the dialog showed 3 to block; someone blocks one before the press.
    await post(blockRoute, { sessionId: afternoon }, { reason: 'Boiler repair' }, TIA)
    const stale = await blockTheDay(SAT, { toBlock: 3, alreadyBlocked: 0 })
    expect(refusedWith(stale)).toEqual({ status: 409, reason: COUNTS_CHANGED_REASON, words: NEW.countsChanged })
    expect(detailsOf(stale)?.counts).toEqual({ toBlock: 2, alreadyBlocked: 1 })
    expect(await blockOf(morning)).toEqual(['open', null, null])
    expect(refusedWith(await blockTheDay(SAT, undefined))).toMatchObject({ status: 409, reason: 'changed_since' })
    expect(refusedWith(await blockTheDay(SAT, { toBlock: '2', alreadyBlocked: 1 }))).toMatchObject({ status: 409, reason: 'changed_since' })
    // With the new figures it goes through.
    expect((await blockTheDay(SAT, { toBlock: 2, alreadyBlocked: 1 })).status).toBe(200)

    // Unblock Day: the dialog showed 2 to reopen; one is reopened on its own before the press.
    await post(unblockRoute, { sessionId: morning })
    const staleUnblock = await unblockTheDay(SAT, { blockedSessions: 2, blockedBefore: 1 })
    expect(refusedWith(staleUnblock)).toEqual({ status: 409, reason: 'changed_since', words: NEW.countsChanged })
    expect(detailsOf(staleUnblock)?.counts).toEqual({ blockedSessions: 1, blockedBefore: 1, closedDates: 1 })
    expect(await blockOf(evening)).toEqual(['blocked', 'Staff day', jo])
    expect(refusedWith(await unblockTheDay(SAT, {}))).toMatchObject({ reason: 'changed_since' })
    // W51a: the closed date is one of the figures: a press that didn't see it would remove it unseen, so it is refused.
    expect(refusedWith(await unblockTheDay(SAT, { blockedSessions: 1, blockedBefore: 1 }))).toMatchObject({ reason: 'changed_since' })
    expect(refusedWith(await unblockTheDay(SAT, { blockedSessions: 1, blockedBefore: 1, closedDates: 0 }))).toMatchObject({ reason: 'changed_since' })
    expect((await db.query('SELECT 1 FROM closed_dates')).length).toBe(1)
    expect((await unblockTheDay(SAT, { blockedSessions: 1, blockedBefore: 1, closedDates: 1 })).data).toMatchObject({ unblocked: 1, closedDateRemoved: true })
    // Only the answered presses left rows.
    expect((await auditRowsOf(db)).map((row) => `${row.action}:${row.entity_type}`)).toEqual(['session.blocked:session', 'session.blocked:session_day', 'session.unblocked:session', 'session.unblocked:session_day'])
  })

  it('W48 review L1 and W51a: both day presses take the date\'s lock first, then lock the day\'s sessions in id order, in one statement, before anything else is read or written', async () => {
    for (const press of [(watched: Db) => blockDay(watched, SAT, 'Staff day', { toBlock: 3, alreadyBlocked: 0 }, by()), (watched: Db) => unblockDay(watched, SAT, { blockedSessions: 3, blockedBefore: 0, closedDates: 1 }, by())]) {
      const { db: watched, seen } = watching(db)
      await press(watched)
      const lock = seen.findIndex((one) => one.sql === SESSION_LOCK)
      // W51a: the date's lock (the one the nightly job takes for each day it makes) is the first statement of all.
      expect(seen[0]?.sql).toBe(SESSION_DAY_LOCK_SQL)
      expect(seen[0]?.params).toEqual([SAT])
      expect(lock).toBe(2)
      expect(seen[1]?.sql.startsWith('SELECT s.id FROM sessions s WHERE')).toBe(true)
      expect(seen[lock]?.params[0]).toEqual([morning, afternoon, evening].sort())
      expect(seen.findIndex((one) => one.sql.startsWith('UPDATE sessions'))).toBeGreaterThan(lock)
      // No other statement before the lock writes or locks.
      expect(seen.slice(0, lock).some((one) => /UPDATE|FOR (NO KEY )?UPDATE|FOR SHARE/.test(one.sql))).toBe(false)
    }
  })

  it('a day is the London day: a 23:30 session is blocked with its own day and a 00:30 one with the next', async () => {
    const lateNight = await sessionAt('2027-07-01 23:30')
    const afterMidnight = await sessionAt('2027-07-02 00:30')
    expect((await pressBlockDay('2027-07-01')).data).toMatchObject({ blockedCount: 1 })
    expect(await blockOf(lateNight)).toEqual(['blocked', 'Staff day', jo])
    expect(await blockOf(afterMidnight)).toEqual(['open', null, null])
  })

  it('who may: any active staff member for both quotes and both presses; an inactive account is refused, the count too (GB14); a date that isn\'t one is refused by the route', async () => {
    expect((await blockQuote(SAT, TIA)).status).toBe(200)
    expect((await unblockQuote(SAT, TIA)).status).toBe(200)
    for (const refused of [await blockQuote(SAT, INA), await unblockQuote(SAT, INA), await blockTheDay(SAT, { toBlock: 3, alreadyBlocked: 0 }, 'x', INA), await unblockTheDay(SAT, { blockedSessions: 0, blockedBefore: 0 }, INA)]) {
      expect(refusedWith(refused)).toEqual({ status: 403, reason: undefined, words: INACTIVE })
    }
    expect((await blockQuote('1 March')).status).toBe(400)
    expect((await blockTheDay('2031-3-1', {})).status).toBe(400)
  })
})

// ---------------------------------------------------------------------------------------------------------------------

describe('a band set by hand, and back to automatic (setSessionBand, resetSessionBand)', () => {
  type Counts = { confirmed: boolean; sessionsAffected: number; bookingsAffected: number }
  const quoteOne = (session: string, bandId: string, email: string | null = JO) => get<Counts>(bandQuoteRoute, { bandId }, { sessionId: session }, email)
  const quoteDay = (date: string, bandId: string, email: string | null = JO) => get<Counts>(dayBandQuoteRoute, { bandId }, { date }, email)
  const setOne = (session: string, bandId: unknown, seen: unknown, email: string | null = JO) => post<Counts>(bandRoute, { sessionId: session }, { bandId, seen }, email)
  const setDay = (date: string, bandId: unknown, seen: unknown, email: string | null = JO) => post<Counts>(dayBandRoute, { date }, { bandId, seen }, email)
  const reset = (session: string, email: string | null = JO) => post(bandResetRoute, { sessionId: session }, {}, email)

  it('one session: the count first (the session and its bookings that aren\'t cancelled), then the press sets the band by hand and writes one audit row', async () => {
    await bookingOn(morning, sam)
    await bookingOn(morning, mo, 'cancelled')
    expect((await quoteOne(morning, peak)).data).toEqual({ confirmed: false, sessionsAffected: 1, bookingsAffected: 1 })
    expect((await stateOf(morning))?.band_id).toBe(core)
    const answer = await setOne(morning, peak, { sessionsAffected: 1, bookingsAffected: 1 })
    expect(answer.data).toEqual({ confirmed: true, sessionsAffected: 1, bookingsAffected: 1 })
    expect(await stateOf(morning)).toMatchObject({ band_id: peak, band_overridden: true })
    const rows = await auditRowsOf(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      action: 'session.band_set',
      actor_id: jo,
      entity_type: 'session',
      entity_id: morning,
      details: { bandId: peak, sessionsAffected: 1, bookingsAffected: 1, before: [{ id: morning, band_id: core, band_overridden: false }], after: [{ id: morning, band_id: peak, band_overridden: true }] },
    })
  })

  it('a day: every session on it, public and private, locked in id order first; one audit row for the day', async () => {
    const privateSession = await sessionAt(`${SAT} 12:00`, { service_type_id: hire, type: 'private' })
    await bookingOn(afternoon, sam, 'payment_needed')
    expect((await quoteDay(SAT, peak)).data).toEqual({ confirmed: false, sessionsAffected: 4, bookingsAffected: 1 })
    const { db: watched, seen } = watching(db)
    const answer = await setSessionBand(watched, { date: SAT }, peak, { sessionsAffected: 4, bookingsAffected: 1 }, by())
    expect(answer).toEqual({ confirmed: true, sessionsAffected: 4, bookingsAffected: 1 })
    const lock = seen.findIndex((one) => one.sql === SESSION_LOCK)
    // W51a (L4): the band is read and held first, inside the transaction; then the day's ids, then their locks.
    expect(seen[0]?.sql).toBe(BAND_HELD)
    expect(seen[0]?.params).toEqual([peak])
    expect(lock).toBe(2)
    expect(seen[lock]?.params[0]).toEqual([morning, afternoon, evening, privateSession].sort())
    expect(seen.findIndex((one) => one.sql.startsWith('UPDATE sessions'))).toBeGreaterThan(lock)
    for (const session of [morning, afternoon, evening, privateSession]) expect(await stateOf(session)).toMatchObject({ band_id: peak, band_overridden: true })
    const rows = await auditRowsOf(db)
    expect(rows.map((row) => [row.action, row.entity_type, row.entity_id])).toEqual([['session.band_set', 'session_day', SAT]])
    // A day with no sessions: nothing to change, answered as before.
    expect((await setDay(SUN, peak, { sessionsAffected: 0, bookingsAffected: 0 })).data).toEqual({ confirmed: true, sessionsAffected: 0, bookingsAffected: 0 })
  })

  it("Q18's rule: a booking made since the count was shown refuses the press with the new counts; nothing is changed", async () => {
    const shown = (await quoteOne(morning, peak)).data
    expect(shown).toMatchObject({ sessionsAffected: 1, bookingsAffected: 0 })
    await bookingOn(morning, sam)
    const stale = await setOne(morning, peak, { sessionsAffected: 1, bookingsAffected: 0 })
    expect(refusedWith(stale)).toEqual({ status: 409, reason: 'changed_since', words: NEW.countsChanged })
    expect(detailsOf(stale)?.counts).toEqual({ sessionsAffected: 1, bookingsAffected: 1 })
    expect(await stateOf(morning)).toMatchObject({ band_id: core, band_overridden: false })
    expect(refusedWith(await setOne(morning, peak, undefined))).toMatchObject({ reason: 'changed_since' })
    expect(await auditRowsOf(db)).toEqual([])
  })

  it('refusals: Manage pricing for the count and the press alike, in the old words; a band that isn\'t there or is off, in the old words; a session that isn\'t there (the old press answered "0 sessions")', async () => {
    const NO_BAND = SESSION_ADMIN_WORDS.setSessionBand.thatBandNoLongerExists
    expect(refusedWith(await quoteOne(morning, peak, TIA))).toEqual({ status: 403, reason: 'no_pricing_permission', words: NO_PRICING })
    expect(refusedWith(await setOne(morning, peak, { sessionsAffected: 1, bookingsAffected: 0 }, TIA))).toEqual({ status: 403, reason: 'no_pricing_permission', words: NO_PRICING })
    expect(refusedWith(await setDay(SAT, peak, { sessionsAffected: 3, bookingsAffected: 0 }, TIA))).toEqual({ status: 403, reason: 'no_pricing_permission', words: NO_PRICING })
    expect(refusedWith(await quoteOne(morning, UNKNOWN_ID))).toEqual({ status: 404, reason: 'band_not_found', words: NO_BAND })
    expect(refusedWith(await setOne(morning, 'peak', { sessionsAffected: 1, bookingsAffected: 0 }))).toEqual({ status: 404, reason: 'band_not_found', words: NO_BAND })
    await db.query('UPDATE session_bands SET active = false WHERE id = $1', [peak])
    expect(refusedWith(await quoteDay(SAT, peak))).toEqual({ status: 404, reason: 'band_not_found', words: NO_BAND })
    expect(refusedWith(await setOne(morning, peak, { sessionsAffected: 1, bookingsAffected: 0 }))).toEqual({ status: 404, reason: 'band_not_found', words: NO_BAND })
    await db.query('UPDATE session_bands SET active = true WHERE id = $1', [peak])
    // A session that isn't there counts as none, and its press is refused.
    expect((await quoteOne(UNKNOWN_ID, peak)).data).toEqual({ confirmed: false, sessionsAffected: 0, bookingsAffected: 0 })
    expect(refusedWith(await setOne(UNKNOWN_ID, peak, { sessionsAffected: 0, bookingsAffected: 0 }))).toEqual({ status: 404, reason: 'session_not_found', words: NEW.sessionGone })
    expect(refusedWith(await quoteOne(morning, peak, INA))).toEqual({ status: 403, reason: undefined, words: INACTIVE })
    expect(await auditRowsOf(db)).toEqual([])
  })

  it('reset: back to the band the day\'s windows give its time, with one audit row; refused when the band wasn\'t set by hand, when the session isn\'t there, and without Manage pricing', async () => {
    await setOne(morning, peak, { sessionsAffected: 1, bookingsAffected: 0 })
    const answer = await reset(morning)
    expect(answer.data).toEqual({ reset: true, band: { code: 'core', name: 'Core' } })
    expect(await stateOf(morning)).toMatchObject({ band_id: core, band_overridden: false })
    const rows = await auditRowsOf(db)
    expect(rows[1]).toMatchObject({ action: 'session.band_reset', entity_type: 'session', entity_id: morning, details: { before: { id: morning, band_id: peak, band_overridden: true }, after: { id: morning, band_id: core, band_overridden: false } } })
    expect(refusedWith(await reset(morning))).toEqual({ status: 409, reason: 'not_overridden', words: NEW.notOverridden })
    expect(refusedWith(await reset(UNKNOWN_ID))).toEqual({ status: 404, reason: 'session_not_found', words: NEW.sessionGone })
    expect(refusedWith(await reset(morning, TIA))).toEqual({ status: 403, reason: 'no_pricing_permission', words: NO_PRICING })
    // No window covers the time: the reset leaves the session with no band, as before.
    await setOne(evening, core, { sessionsAffected: 1, bookingsAffected: 0 })
    await db.query('DELETE FROM band_rules')
    expect((await reset(evening)).data).toEqual({ reset: true, band: null })
    expect(await stateOf(evening)).toMatchObject({ band_id: null, band_overridden: false })
  })

  it('W51-1: a reset takes the band guard shared FIRST, then the session (the order a band-window save takes them in); W51a (L4): a band set by hand takes no guard, and holds its own band\'s row FOR SHARE first, inside the transaction, then the session', async () => {
    await setOne(morning, peak, { sessionsAffected: 1, bookingsAffected: 0 })
    const { db: watched, seen } = watching(db)
    await resetSessionBand(watched, morning, by())
    expect(seen[0]?.sql).toBe(BAND_GUARD_SHARED_SQL)
    expect(seen[1]?.sql).toBe(SESSION_LOCK)
    expect(BAND_GUARD_SHARED_SQL).toBe('SELECT 1 FROM session_bands ORDER BY id FOR SHARE')
    const byHand = watching(db)
    await setSessionBand(byHand.db, { sessionId: afternoon }, peak, { sessionsAffected: 1, bookingsAffected: 0 }, by())
    expect(byHand.seen.some((one) => one.sql === BAND_GUARD_SHARED_SQL)).toBe(false)
    expect(byHand.seen[0]?.sql).toBe(BAND_HELD)
    expect(byHand.seen[0]?.params).toEqual([peak])
    expect(byHand.seen[1]?.sql).toBe(SESSION_LOCK)
    expect(byHand.seen.findIndex((one) => one.sql.startsWith('UPDATE sessions'))).toBeGreaterThan(1)
    // No read of the band's being on is made outside the transaction any more (W51 checked it before it began).
    expect(byHand.seen.filter((one) => one.sql.includes('FROM session_bands') && one.sql.includes('active = true')).map((one) => one.sql)).toEqual([BAND_HELD])
  })

  it('W51a (L4): a band switched off is refused by the press itself, inside its transaction: nothing is locked after it, nothing written', async () => {
    await db.query('UPDATE session_bands SET active = false WHERE id = $1', [peak])
    const { db: watched, seen } = watching(db)
    await expect(setSessionBand(watched, { sessionId: morning }, peak, { sessionsAffected: 1, bookingsAffected: 0 }, by())).rejects.toMatchObject({ details: { reason: 'band_not_found' } })
    expect(seen.map((one) => one.sql)).toEqual([BAND_HELD])
    expect(await stateOf(morning)).toMatchObject({ band_id: core, band_overridden: false })
    expect(await auditRowsOf(db)).toEqual([])
  })
})

// ---------------------------------------------------------------------------------------------------------------------

describe('POST sessions/:sessionId/start-time (setSessionStartTime, GB6, W51-1)', () => {
  const move = (session: string, startTime: unknown, email: string | null = JO) => post(startTimeRoute, { sessionId: session }, { startTime }, email)
  const WORDS = SESSION_ADMIN_DIALOG_WORDS.EditSessionStartTimeDialog

  it('moves the start, the end follows the service type\'s length, the band follows the time; the old answer, and one audit row with the times before and after', async () => {
    const answer = await move(morning, `${SAT}T19:30:00.000Z`, TIA)
    expect(answer.status).toBe(200)
    expect(answer.data).toEqual({ updated: true, session: { id: morning, start_time: `${SAT}T19:30:00.000Z`, end_time: `${SAT}T20:30:00.000Z` }, band: { code: 'peak', name: 'Peak', overridden: false } })
    expect(await stateOf(morning)).toMatchObject({ start_time: `${SAT} 19:30`, end_time: `${SAT} 20:30`, band_id: peak })
    const rows = await auditRowsOf(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      action: 'session.start_time_set',
      actor_id: tia,
      entity_type: 'session',
      entity_id: morning,
      details: {
        before: { id: morning, start_time: `${SAT}T10:00:00.000Z`, end_time: `${SAT}T11:00:00.000Z`, band_id: core, band_overridden: false },
        after: { id: morning, start_time: `${SAT}T19:30:00.000Z`, end_time: `${SAT}T20:30:00.000Z`, band_id: peak, band_overridden: false },
      },
    })
  })

  it('a band set by hand stays when the time moves', async () => {
    await db.query('UPDATE sessions SET band_id = $1, band_overridden = true WHERE id = $2', [core, morning])
    expect((await move(morning, `${SAT}T19:00:00.000Z`)).data).toMatchObject({ updated: true, band: { code: 'core', name: 'Core', overridden: true } })
    expect(await stateOf(morning)).toMatchObject({ band_id: core, band_overridden: true })
  })

  it.each(['pending', 'confirmed', 'payment_needed'])('GB6: a %s booking on the session refuses the change, in the old words; the session and its band are untouched', async (status) => {
    await bookingOn(morning, sam, status)
    expect(refusedWith(await move(morning, `${SAT}T18:30:00.000Z`))).toEqual({ status: 409, reason: 'session_has_bookings', words: WORDS.session_has_bookings })
    expect(await stateOf(morning)).toMatchObject({ start_time: `${SAT} 10:00`, band_id: core })
    expect(await auditRowsOf(db)).toEqual([])
  })

  it('a cancelled booking refuses nothing', async () => {
    await bookingOn(morning, sam, 'cancelled')
    expect((await move(morning, `${SAT}T18:30:00.000Z`)).status).toBe(200)
  })

  it.each([
    ['a 5 digit year, which Postgres would store', '12026-11-05T14:30:00.000Z'],
    ['a day that does not exist', '2026-02-30T10:00:00.000Z'],
    ['year 0000', '0000-01-01T10:00:00.000Z'],
    ['an empty value', ''],
    ['no time zone', '2026-11-05T14:30'],
    ['a date and time with a space', '2026-11-12 18:00'],
    ['words', 'tomorrow'],
    ['not a string', 20261105],
    ['nothing', undefined],
  ])('refuses %s in the old words, before anything is read', async (_label, startTime) => {
    expect(refusedWith(await move(morning, startTime))).toEqual({ status: 400, reason: 'invalid_start_time', words: 'Enter a valid date and time.' })
    expect(await stateOf(morning)).toMatchObject({ start_time: `${SAT} 10:00` })
  })

  it('the other refusals: a session that isn\'t there; another session of the service type already at that time; a service type with no duration; an inactive account', async () => {
    expect(refusedWith(await move(UNKNOWN_ID, `${SAT}T19:00:00.000Z`))).toEqual({ status: 404, reason: 'session_not_found', words: WORDS.session_not_found })
    expect(refusedWith(await move(morning, `${SAT}T14:00:00.000Z`))).toEqual({ status: 409, reason: 'slot_already_exists', words: WORDS.slot_already_exists })
    const hireSession = await sessionAt(`${SAT} 12:00`, { service_type_id: hire, type: 'private' })
    expect(refusedWith(await move(hireSession, `${SAT}T13:00:00.000Z`))).toEqual({ status: 409, reason: 'service_type_incomplete', words: NEW.noLength })
    expect(refusedWith(await move(morning, `${SAT}T19:00:00.000Z`, INA))).toEqual({ status: 403, reason: undefined, words: INACTIVE })
    // Its own time again is no clash with itself.
    expect((await move(morning, `${SAT}T10:00:00.000Z`)).status).toBe(200)
    expect((await auditRowsOf(db)).map((row) => row.action)).toEqual(['session.start_time_set'])
  })

  it('W51-1, GB6 and W51a: the band guard shared first, then the new date\'s lock, then the session\'s lock, then the bookings are counted and the Moves in flight read, then the write', async () => {
    const { db: watched, seen } = watching(db)
    await setSessionStartTime(watched, morning, `${SUN}T19:00:00.000Z`, by())
    expect(seen[0]?.sql).toBe(BAND_GUARD_SHARED_SQL)
    // W51a: the lock of the date the session is going TO, before any session's row (the order Block Day takes them in).
    expect(seen[1]?.sql).toBe(SESSION_DAY_LOCK_SQL)
    expect(seen[1]?.params).toEqual([SUN])
    expect(seen[2]?.sql).toBe(SESSION_LOCK)
    const counted = seen.findIndex((one) => one.sql.includes("FROM bookings WHERE session_id = $1::uuid AND status <> 'cancelled'"))
    expect(counted).toBeGreaterThan(2)
    const movesOff = seen.findIndex((one) => one.sql.includes('FROM pending_reader_payments p'))
    expect(movesOff).toBeGreaterThan(counted)
    expect(seen.findIndex((one) => one.sql.startsWith('UPDATE sessions'))).toBeGreaterThan(movesOff)
  })

  it('the time check is the screens\' own', () => {
    for (const [value, valid] of [['2026-11-05T14:30:00.000Z', true], ['2028-02-29T00:00:00.000Z', true], ['0001-01-01T00:00:00.000Z', true], ['12026-11-05T14:30:00.000Z', false], ['2026-02-30T10:00:00.000Z', false], ['2026-11-05T25:00:00.000Z', false], ['0000-01-01T00:00:00.000Z', false], ['', false]] as const) {
      expect(isValidIsoDateTime(value), value).toBe(valid)
    }
  })
})

/** The one-off dialog's quote (W68, Q58), for a type and time, as the dialog asks. */
const quote = (serviceTypeId: unknown, startTime: unknown, email: string | null = JO) => get<OneOffSessionQuoteRouteOutput>(oneOffQuoteRoute, { ...(serviceTypeId === undefined ? {} : { serviceTypeId: String(serviceTypeId) }), startTime: String(startTime) }, {}, email)

describe('POST sessions (createOneOffSession, W51-1)', () => {
  /** As the dialog: the quote first (W68, Q58), then the press with the stamp it gave (none when the quote was refused). */
  const create = async (serviceTypeId: unknown, startTime: unknown, email: string | null = JO, key?: string) => {
    const shown = await quote(serviceTypeId, startTime, email)
    return post(oneOffRoute, {}, { serviceTypeId, startTime, stamp: shown.data?.stamp }, email, key)
  }
  const WORDS = SESSION_ADMIN_DIALOG_WORDS.CreateOneOffSessionDialog

  it('makes one session with the service type\'s length, capacity and kind, its band by the day\'s windows; the old answer, and one audit row', async () => {
    const answer = await create(sauna, `${SUN}T18:00:00.000Z`, TIA)
    expect(answer.status).toBe(200)
    const made = (answer.data as { session: { id: string } }).session
    expect(answer.data).toEqual({ created: true, session: { id: made.id, service_type_id: sauna, start_time: `${SUN}T18:00:00.000Z`, end_time: `${SUN}T19:00:00.000Z`, capacity: 10, type: 'public' } })
    expect(await stateOf(made.id)).toMatchObject({ status: 'open', band_id: peak, band_overridden: false })
    const rows = await auditRowsOf(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ action: 'session.created', actor_id: tia, entity_type: 'session', entity_id: made.id, details: { before: null, after: { id: made.id, service_type_id: sauna, band_id: peak, type: 'public', capacity: 10 } } })
    // One in the past, and one a year out: nothing checks the date, as before.
    expect((await create(sauna, '2020-01-01T10:00:00.000Z')).status).toBe(200)
    expect((await create(sauna, '2032-06-01T10:00:00.000Z')).status).toBe(200)
  })

  it('the old refusals with the old reasons, in the old order; then the time (the old function showed the database\'s own error)', async () => {
    expect(refusedWith(await create(UNKNOWN_ID, `${SUN}T07:00:00.000Z`))).toEqual({ status: 404, reason: 'service_type_not_found', words: WORDS.service_type_not_found })
    expect(refusedWith(await create(undefined, `${SUN}T07:00:00.000Z`))).toEqual({ status: 404, reason: 'service_type_not_found', words: WORDS.service_type_not_found })
    expect(refusedWith(await create(hire, `${SUN}T07:00:00.000Z`))).toEqual({ status: 409, reason: 'service_type_incomplete', words: WORDS.service_type_incomplete })
    expect(refusedWith(await create(sauna, `${SAT}T10:00:00.000Z`))).toEqual({ status: 409, reason: 'slot_already_exists', words: WORDS.slot_already_exists })
    expect(refusedWith(await create(sauna, 'next Friday'))).toEqual({ status: 400, reason: 'invalid_start_time', words: 'Enter a valid date and time.' })
    // A service type that isn't there is said before a time that isn't one.
    expect(refusedWith(await create(UNKNOWN_ID, 'next Friday'))).toMatchObject({ reason: 'service_type_not_found' })
    await db.query('UPDATE service_types SET active = false WHERE id = $1', [sauna])
    expect(refusedWith(await create(sauna, `${SUN}T07:00:00.000Z`))).toEqual({ status: 404, reason: 'service_type_not_found', words: WORDS.service_type_not_found })
    expect(refusedWith(await create(sauna, `${SUN}T07:00:00.000Z`, INA))).toEqual({ status: 403, reason: undefined, words: INACTIVE })
    expect(await auditRowsOf(db)).toEqual([])
    expect(await db.query('SELECT id FROM sessions')).toHaveLength(3)
  })

  it('a press made twice makes one session: the same key answers the first press', async () => {
    const key = crypto.randomUUID()
    const stamp = (await quote(sauna, `${SUN}T07:00:00.000Z`)).data?.stamp
    const press = () => post(oneOffRoute, {}, { serviceTypeId: sauna, startTime: `${SUN}T07:00:00.000Z`, stamp }, JO, key)
    const first = await press()
    const again = await press()
    expect(again.replayed).toBe(true)
    expect(again.data).toEqual(first.data)
    expect(await db.query('SELECT id FROM sessions')).toHaveLength(4)
    expect(await auditRowsOf(db)).toHaveLength(1)
  })

  it('W51-1: the band guard shared is the first statement, before the session is written', async () => {
    const { db: watched, seen } = watching(db)
    const shown = (await quote(sauna, `${SUN}T07:00:00.000Z`)).data
    await createOneOffSession(watched, sauna, `${SUN}T07:00:00.000Z`, shown?.stamp, by())
    expect(seen[0]?.sql).toBe(BAND_GUARD_SHARED_SQL)
    // W51a: then the date's lock, then the closed date is read, then the session is written.
    expect(seen[1]?.sql).toBe(SESSION_DAY_LOCK_SQL)
    expect(seen[1]?.params).toEqual([SUN])
    const closedRead = seen.findIndex((one) => one.sql.includes('FROM closed_dates WHERE closed_on = $1::date'))
    expect(closedRead).toBeGreaterThan(1)
    expect(seen.findIndex((one) => one.sql.startsWith('INSERT INTO sessions'))).toBeGreaterThan(closedRead)
  })
})

// ---------------------------------------------------------------------------------------------------------------------

// Brief W68 item 4 (Wayne's Q58; H12): the one-off dialog names the session's band and price before Create Session, and the
// press makes the session shown or nothing.
describe("the one-off session's band and price, shown before the press (Wayne's Q58)", () => {
  const at = (time: string, day = SUN) => `${day}T${time}:00.000Z`
  const pressWith = (serviceTypeId: string, startTime: string, stamp: unknown, email = JO) => post(oneOffRoute, {}, { serviceTypeId, startTime, ...(stamp === undefined ? {} : { stamp }) }, email)
  const CHANGED = { status: 409, reason: 'changed_since', words: CHANGED_SINCE_WORDS }
  const madeNothing = async () => {
    expect(await db.query('SELECT id FROM sessions')).toHaveLength(3)
    expect(await auditRowsOf(db)).toEqual([])
  }
  let pool = ''
  beforeEach(async () => {
    // A private type with a length: 1 to 4 people priced in both bands, 5 to 8 priced at Core only.
    pool = await insert(db, 'service_types', { name: 'Pool Hire', booking_type: 'private', duration: 90, capacity: 8 })
    for (const [band, min, max, price] of [[core, 1, 4, '80.00'], [core, 5, 8, '120.50'], [peak, 1, 4, '95.00'], [peak, 5, 8, null]] as const) await insert(db, 'service_type_price_tiers', { service_type_id: pool, band_id: band, min_people: min, max_people: max, price })
  })

  it('a public type: its band and that band\'s price a person; the same time on the other side of the window is the other band; nothing is written', async () => {
    const day = await quote(sauna, at('16:59'), TIA)
    expect(day.status).toBe(200)
    expect(day.data).toEqual({ type: 'public', band: { code: 'core', name: 'Core' }, pricePerPerson: 20, sizeGroups: [], othersSetByHand: false, stamp: expect.any(String) })
    const night = await quote(sauna, at('17:00'))
    expect(night.data).toMatchObject({ band: { code: 'peak', name: 'Peak' }, pricePerPerson: 25.5 })
    expect(night.data?.stamp).not.toBe(day.data?.stamp)
    await madeNothing()
  })

  it('a private type: its band and that band\'s size-group prices, in order, one not priced yet as none', async () => {
    expect((await quote(pool, at('10:00'))).data).toMatchObject({ type: 'private', band: { code: 'core', name: 'Core' }, pricePerPerson: null, sizeGroups: [{ minPeople: 1, maxPeople: 4, price: 80 }, { minPeople: 5, maxPeople: 8, price: 120.5 }] })
    expect((await quote(pool, at('18:00'))).data).toMatchObject({ band: { code: 'peak', name: 'Peak' }, sizeGroups: [{ minPeople: 1, maxPeople: 4, price: 95 }, { minPeople: 5, maxPeople: 8, price: null }] })
  })

  it('no window covers the time: no band and no price, and the session is made as it says', async () => {
    await db.query("DELETE FROM band_rules WHERE day_of_week = 0 AND from_time = '17:00'")
    const shown = await quote(sauna, at('18:00'))
    expect(shown.data).toMatchObject({ type: 'public', band: null, pricePerPerson: null, sizeGroups: [] })
    const made = await pressWith(sauna, at('18:00'), shown.data?.stamp)
    expect(made.status).toBe(200)
    expect((await stateOf((made.data as { session: { id: string } }).session.id))?.band_id).toBeNull()
  })

  it('Q58: on a day whose sessions staff set by hand, the one-off is made in the band the dialog showed (the windows\')', async () => {
    await db.query('UPDATE sessions SET band_id = $1, band_overridden = true', [peak])
    const shown = await quote(sauna, at('11:00', SAT))
    expect(shown.data).toMatchObject({ band: { code: 'core' }, pricePerPerson: 20 })
    // W68a: and the quote says so, on that day only.
    expect(shown.data?.othersSetByHand).toBe(true)
    expect((await quote(sauna, at('11:00'))).data?.othersSetByHand).toBe(false)
    const made = await pressWith(sauna, at('11:00', SAT), shown.data?.stamp)
    expect(await stateOf((made.data as { session: { id: string } }).session.id)).toMatchObject({ band_id: core, band_overridden: false })
  })

  it('W68a (W68 noticed 2): the quote says when another session that day, of any service type, had its band set by hand; a reset clears it; the day is the one staff see; the stamp is the same either way, so it refuses no press', async () => {
    const shown = await quote(pool, at('23:30', SAT))
    expect(shown.data?.othersSetByHand).toBe(false)
    const [one] = await db.query<{ id: string }>('SELECT id FROM sessions WHERE service_type_id = $1 ORDER BY start_time LIMIT 1', [sauna])
    await db.query('UPDATE sessions SET band_overridden = true WHERE id = $1', [one?.id ?? ''])
    const now = await quote(pool, at('23:30', SAT))
    expect(now.data).toEqual({ ...shown.data, othersSetByHand: true })
    // Either side of midnight is another day.
    for (const start of [at('00:00'), `2000-01-01T00:00:00.000Z`]) expect((await quote(pool, start)).data?.othersSetByHand, start).toBe(false)
    expect((await quote(pool, at('00:00', SAT))).data?.othersSetByHand).toBe(true)
    await db.query('UPDATE sessions SET band_overridden = false')
    expect((await quote(pool, at('23:30', SAT))).data?.othersSetByHand).toBe(false)
    await db.query('UPDATE sessions SET band_overridden = true WHERE id = $1', [one?.id ?? ''])
    expect((await pressWith(pool, at('23:30', SAT), shown.data?.stamp)).status).toBe(200)
  })

  it('W68a (W68 review L3): a one-off session ends when its own service type does: 90 minutes for a 90-minute type', async () => {
    const made = await pressWith(pool, at('10:00'), (await quote(pool, at('10:00'))).data?.stamp)
    expect((made.data as { session: { start_time: string; end_time: string } }).session).toMatchObject({ start_time: at('10:00'), end_time: at('11:30') })
    const [row] = await db.query<{ minutes: number }>('SELECT (extract(epoch FROM end_time - start_time) / 60)::int AS minutes FROM sessions WHERE service_type_id = $1', [pool])
    expect(row?.minutes).toBe(90)
  })

  it.each([
    ["the day's windows were cut again, so the time is another band", () => db.query("UPDATE band_rules SET to_time = '09:00' WHERE day_of_week = 0 AND from_time = '00:00'").then(() => db.query("UPDATE band_rules SET from_time = '09:00' WHERE day_of_week = 0 AND from_time = '17:00'")), 'sauna'],
    ["the band's price changed", () => db.query("UPDATE session_bands SET price = '22.00' WHERE code = 'core'"), 'sauna'],
    ['a size group\'s price changed', () => db.query("UPDATE service_type_price_tiers SET price = '130.00' WHERE price = '120.50'"), 'pool'],
    ['a size group was added', () => insert(db, 'service_type_price_tiers', { service_type_id: pool, band_id: core, min_people: 9, max_people: 10, price: '150.00' }), 'pool'],
  ] as const)('%s after the dialog showed it: refused in the rule\'s words, no session and no audit row; the new one shown and pressed is made', async (_what, change, which) => {
    const type = which === 'sauna' ? sauna : pool
    const shown = await quote(type, at('10:00'))
    await change()
    expect(refusedWith(await pressWith(type, at('10:00'), shown.data?.stamp))).toEqual(CHANGED)
    await madeNothing()
    const now = await quote(type, at('10:00'))
    expect(now.data?.stamp).not.toBe(shown.data?.stamp)
    const made = await pressWith(type, at('10:00'), now.data?.stamp)
    expect(made.status).toBe(200)
    expect((await auditRowsOf(db)).map((row) => row.action)).toEqual(['session.created'])
  })

  it('a press with no stamp, an empty one, or the stamp of another time, type or band is refused, and nothing is made', async () => {
    const otherTime = (await quote(sauna, at('11:00'))).data?.stamp
    const otherBand = (await quote(sauna, at('18:00'))).data?.stamp
    const otherType = (await quote(pool, at('10:00'))).data?.stamp
    // W68a (W68 review L1): a second public type at the same time, so the same band and the same price.
    const steam = await insert(db, 'service_types', { name: 'Steam', booking_type: 'public', duration: 60, capacity: 10 })
    const steamShown = (await quote(steam, at('10:00'))).data
    expect(steamShown).toEqual({ ...(await quote(sauna, at('10:00'))).data, stamp: steamShown?.stamp })
    const otherPublicType = steamShown?.stamp
    for (const stamp of [undefined, '', null, 7, otherTime, otherBand, otherType, otherPublicType]) expect(refusedWith(await pressWith(sauna, at('10:00'), stamp)), String(stamp)).toEqual(CHANGED)
    await madeNothing()
  })

  it('the quote is refused as the press would be, in the same words: the service type, the time, a closed date, a session already there, an inactive account', async () => {
    const WORDS = SESSION_ADMIN_DIALOG_WORDS.CreateOneOffSessionDialog
    expect(refusedWith(await quote(UNKNOWN_ID, at('10:00')))).toEqual({ status: 404, reason: 'service_type_not_found', words: WORDS.service_type_not_found })
    expect(refusedWith(await quote(undefined, at('10:00')))).toMatchObject({ reason: 'service_type_not_found' })
    expect(refusedWith(await quote(hire, at('10:00')))).toEqual({ status: 409, reason: 'service_type_incomplete', words: WORDS.service_type_incomplete })
    expect(refusedWith(await quote(sauna, 'next Friday'))).toMatchObject({ status: 400, reason: 'invalid_start_time' })
    expect(refusedWith(await quote(sauna, at('10:00', SAT)))).toEqual({ status: 409, reason: 'slot_already_exists', words: WORDS.slot_already_exists })
    await db.query('INSERT INTO closed_dates (closed_on, reason) VALUES ($1::date, $2)', [SUN, 'Closed'])
    expect(refusedWith(await quote(sauna, at('10:00')))).toEqual({ status: 409, reason: 'date_closed', words: NEW.dateClosed })
    expect(refusedWith(await quote(sauna, at('10:00'), INA))).toEqual({ status: 403, reason: undefined, words: INACTIVE })
    await madeNothing()
  })
})

describe('the weekly timetable (addServiceTypeScheduleSlot, deleteServiceTypeScheduleSlot; Wayne\'s Q50)', () => {
  const add = (serviceTypeId: string, dayOfWeek: unknown, startTime: unknown, email: string | null = JO, key?: string) => post(slotAddRoute, { serviceTypeId }, { dayOfWeek, startTime }, email, key)
  const remove = (slotId: string, email: string | null = JO) => post(slotRemoveRoute, { slotId }, {}, email)
  const WORDS = SESSION_ADMIN_WORDS.addServiceTypeScheduleSlot
  const sessionCount = async () => (await db.query('SELECT id FROM sessions')).length

  it('adds a slot and answers its row by named columns, with one audit row; removing it answers `deleted: true` and keeps the slot as it was in its audit row', async () => {
    const added = await add(sauna, 2, '07:00')
    expect(added.status).toBe(200)
    const slot = added.data as { id: string; created_at: string; updated_at: string }
    expect(added.data).toEqual({ id: slot.id, service_type_id: sauna, day_of_week: 2, start_time: '07:00:00', created_at: slot.created_at, updated_at: slot.updated_at })
    expect((await add(sauna, 6, '18:30:00')).data).toMatchObject({ day_of_week: 6, start_time: '18:30:00' })
    const removed = await remove(slot.id)
    expect(removed.data).toEqual({ deleted: true })
    expect(await db.query('SELECT day_of_week FROM service_type_schedule_slots ORDER BY day_of_week')).toEqual([{ day_of_week: 6 }])
    const rows = await auditRowsOf(db)
    expect(rows.map((row) => [row.action, row.entity_type])).toEqual([['timetable.slot_added', 'schedule_slot'], ['timetable.slot_added', 'schedule_slot'], ['timetable.slot_removed', 'schedule_slot']])
    expect(rows[0]).toMatchObject({ actor_id: jo, entity_id: slot.id, details: { before: null, after: { id: slot.id, service_type_id: sauna, day_of_week: 2, start_time: '07:00:00' } } })
    expect(rows[2]).toMatchObject({ actor_id: jo, entity_id: slot.id, details: { before: { id: slot.id, service_type_id: sauna, day_of_week: 2, start_time: '07:00:00' }, after: null } })
  })

  it('Q50 part 2: adding and removing a slot need Manage pricing, in the old words; an active staff member without it is refused, and nothing is written', async () => {
    expect(refusedWith(await add(sauna, 2, '07:00', TIA))).toEqual({ status: 403, reason: 'no_pricing_permission', words: NO_PRICING })
    const slot = await insert(db, 'service_type_schedule_slots', { service_type_id: sauna, day_of_week: 2, start_time: '07:00' })
    expect(refusedWith(await remove(slot, TIA))).toEqual({ status: 403, reason: 'no_pricing_permission', words: NO_PRICING })
    expect(await db.query('SELECT id FROM service_type_schedule_slots')).toEqual([{ id: slot }])
    // An inactive account and a sign-in with no staff row are refused by the route (the old add let the second through).
    expect(refusedWith(await add(sauna, 3, '07:00', INA))).toEqual({ status: 403, reason: undefined, words: INACTIVE })
    expect(refusedWith(await add(sauna, 3, '07:00', 'nobody@example.com'))).toEqual({ status: 401, reason: undefined, words: NO_STAFF })
    expect(await auditRowsOf(db)).toEqual([])
    // Block, unblock, a start time and a one-off session stay open to a staff member without it.
    expect((await post(blockRoute, { sessionId: morning }, { reason: 'x' }, TIA)).status).toBe(200)
    expect((await post(unblockRoute, { sessionId: morning }, {}, TIA)).status).toBe(200)
    expect((await post(startTimeRoute, { sessionId: morning }, { startTime: `${SAT}T09:00:00.000Z` }, TIA)).status).toBe(200)
    const oneOff = { serviceTypeId: sauna, startTime: `${SUN}T09:00:00.000Z` }
    expect((await post(oneOffRoute, {}, { ...oneOff, stamp: (await quote(oneOff.serviceTypeId, oneOff.startTime, TIA)).data?.stamp }, TIA)).status).toBe(200)
  })

  it('the old checks in the old words: the day, the time, a slot already there; a service type that isn\'t there in plain words; a slot that isn\'t there', async () => {
    expect(refusedWith(await add(sauna, 7, '07:00'))).toEqual({ status: 400, reason: 'invalid_day', words: 'dayOfWeek must be an integer 0-6 (0 = Sunday); received 7' })
    expect(refusedWith(await add(sauna, 1.5, '07:00'))).toEqual({ status: 400, reason: 'invalid_day', words: 'dayOfWeek must be an integer 0-6 (0 = Sunday); received 1.5' })
    expect(refusedWith(await add(sauna, '2', '07:00'))).toMatchObject({ status: 400, reason: 'invalid_day' })
    expect(refusedWith(await add(sauna, 2, '7am'))).toEqual({ status: 400, reason: 'invalid_time', words: WORDS.starttimeMustInHhMmOr })
    await add(sauna, 2, '07:00')
    expect(refusedWith(await add(sauna, 2, '07:00'))).toEqual({ status: 409, reason: 'slot_already_exists', words: 'This service type already has a slot on Tuesday at 07:00.' })
    expect(refusedWith(await add(UNKNOWN_ID, 3, '07:00'))).toEqual({ status: 404, reason: 'service_type_not_found', words: NEW.serviceTypeGone })
    expect(refusedWith(await remove(UNKNOWN_ID))).toEqual({ status: 404, reason: 'slot_not_found', words: NEW.slotGone })
    expect((await auditRowsOf(db)).map((row) => row.action)).toEqual(['timetable.slot_added'])
  })

  it('Q50 part 1: a slot added makes no session and changes none already made, with and without bookings; a slot removed leaves its sessions bookable, with and without bookings', async () => {
    const booking = await bookingOn(morning, sam)
    const before = await db.query('SELECT id, status, start_time, capacity, total_booked FROM sessions ORDER BY id')
    // Saturday 10:00 (a session with a booking is already there), Saturday 12:00 (no session there), Sunday 10:00.
    const tenOnSaturday = (await add(sauna, 6, '10:00')).data as { id: string }
    const noonOnSaturday = (await add(sauna, 6, '12:00')).data as { id: string }
    await add(sauna, 0, '10:00')
    expect(await db.query('SELECT id, status, start_time, capacity, total_booked FROM sessions ORDER BY id')).toEqual(before)
    expect(await sessionCount()).toBe(3)
    // Removed: every session stays, open, and the booking with it.
    expect((await remove(tenOnSaturday.id)).data).toEqual({ deleted: true })
    expect((await remove(noonOnSaturday.id)).data).toEqual({ deleted: true })
    expect(await db.query('SELECT id, status, start_time, capacity, total_booked FROM sessions ORDER BY id')).toEqual(before)
    expect((await db.query<{ status: string }>('SELECT status FROM bookings WHERE id = $1', [booking]))[0]?.status).toBe('confirmed')
  })

  it('a slot pressed twice under one key is added once', async () => {
    const key = crypto.randomUUID()
    const first = await add(sauna, 4, '07:00', JO, key)
    const again = await add(sauna, 4, '07:00', JO, key)
    expect(again.replayed).toBe(true)
    expect(again.data).toEqual(first.data)
    expect(await db.query('SELECT id FROM service_type_schedule_slots')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Brief W51a

describe('W51a (W51 review S1): a booking being moved off a slot, its payment unfinished, stops a block, a Block Day and a start-time change', () => {
  /**
   * What a dearer Move on a saved card or the reader leaves while its payment is awaited (bookings/move.ts, C1): the
   * booking on its NEW session, the old session's place still held, and the flow's row naming the old session. If
   * the payment is cancelled the flow's undo puts the booking back on the old session.
   */
  async function moveInFlight(from: string, to: string, customer = sam): Promise<{ booking: string; flow: string }> {
    const booking = await bookingOn(to, customer)
    await db.query('UPDATE sessions SET total_booked = total_booked + 1 WHERE id = $1', [from])
    const flow = await insert(db, 'pending_reader_payments', {
      flow: 'move',
      record_id: booking,
      expected_amount: '5.50',
      status: 'pending',
      snapshot: JSON.stringify({ customer_id: customer, booking_id: booking, old_session_id: from, new_session_id: to, party_size: 1 }),
    })
    return { booking, flow }
  }
  const block = (session: string) => post(blockRoute, { sessionId: session }, { reason: 'Sauna repair' })
  const samMoving = (booking: string) => ({ id: booking, customer_first_name: 'Sam', customer_last_name: 'Test', party_size: 1, price_paid: '20.00', redemption_source: 'paid', status: 'confirmed' })

  it("Block Slot is refused in the lead's words while the Move is unfinished, with the booking listed as being moved; nothing is written; the slot it moved to lists it as a booking; another slot isn't held up", async () => {
    const { booking } = await moveInFlight(morning, evening)
    const answer = await block(morning)
    expect(refusedWith(answer)).toEqual({ status: 409, reason: 'move_in_flight', words: "A booking is being moved off this slot and its payment isn't finished. Try again when it is." })
    expect(detailsOf(answer)?.conflictingBookings).toEqual([{ ...samMoving(booking), movingOff: true }])
    expect(await blockOf(morning)).toEqual(['open', null, null])
    expect(await auditRowsOf(db)).toEqual([])
    // On the slot it was moved to, it is a booking in the way like any other (GB5), with no mark.
    const onNew = await block(evening)
    expect(onNew.reason).toBe('bookings_in_the_way')
    expect(detailsOf(onNew)?.conflictingBookings).toEqual([samMoving(booking)])
    // A slot the Move doesn't touch is blocked as ever.
    expect((await block(afternoon)).status).toBe(200)
  })

  it.each([
    ['its payment taken (finalised)', "UPDATE pending_reader_payments SET status = 'finalised' WHERE id = $1"],
    ['its payment cancelled and the Move undone (cancelled)', "UPDATE pending_reader_payments SET status = 'cancelled' WHERE id = $1"],
    ['a Settle flow, not a Move', "UPDATE pending_reader_payments SET flow = 'settle' WHERE id = $1"],
    ['an Add Guest flow, not a Move', "UPDATE pending_reader_payments SET flow = 'add_guest' WHERE id = $1"],
    ['a Move off another slot', `UPDATE pending_reader_payments SET snapshot = snapshot || jsonb_build_object('old_session_id', '${UNKNOWN_ID}') WHERE id = $1`],
  ])('only an unfinished Move off THIS slot stops it: %s stops nothing (a block, a Block Day and a start-time change all go through)', async (_label, change) => {
    // The booking is on Sunday, so nothing of it is on Saturday but the Move's hold on the 10:00.
    const sunday = await sessionAt(`${SUN} 10:00`)
    const { flow } = await moveInFlight(morning, sunday)
    expect((await block(morning)).reason).toBe('move_in_flight')
    await db.query(change, [flow])
    expect((await block(morning)).status).toBe(200)
    expect((await post(unblockRoute, { sessionId: morning })).status).toBe(200)
    expect((await post(startTimeRoute, { sessionId: morning }, { startTime: `${SAT}T09:00:00.000Z` })).status).toBe(200)
    expect((await post(blockDayRoute, { date: SAT }, { reason: 'Staff day', seen: { toBlock: 3, alreadyBlocked: 0 } })).status).toBe(200)
  })

  it('a booking on the slot AND one being moved off it: refused as bookings in the way, counting the one on it, with both listed and the second marked', async () => {
    const onIt = await bookingOn(morning, mo, 'payment_needed')
    const { booking: moving } = await moveInFlight(morning, evening)
    const answer = await block(morning)
    expect(refusedWith(answer)).toEqual({ status: 409, reason: 'bookings_in_the_way', words: 'This slot has 1 booking. Move each one to a different session or cancel it before this slot can be blocked.' })
    expect(detailsOf(answer)?.conflictingBookings).toEqual([
      { id: onIt, customer_first_name: 'Mo', customer_last_name: 'Member', party_size: 1, price_paid: '20.00', redemption_source: 'paid', status: 'payment_needed' },
      { ...samMoving(moving), movingOff: true },
    ])
  })

  it('Block Day: its quote lists the booking with the slot it is being moved off, marked; the press is refused in words for a day, and nothing is blocked or closed; a Move within the day is one row, a booking on the day, marked', async () => {
    const sunday = await sessionAt(`${SUN} 10:00`)
    const { booking } = await moveInFlight(morning, sunday)
    const movingOffTheMorning = {
      id: booking,
      session_id: morning,
      service_type_name: 'Sauna',
      booking_type: 'public',
      session_start_time: `${SAT}T10:00:00.000Z`,
      session_end_time: `${SAT}T11:00:00.000Z`,
      customer_first_name: 'Sam',
      customer_last_name: 'Test',
      party_size: 1,
      price_paid: '20.00',
      redemption_source: 'paid',
      status: 'confirmed',
      movingOff: true,
    }
    const quote = (await get<{ toBlock: number; alreadyBlocked: number; conflictingBookings: unknown[] }>(blockDayQuoteRoute, {}, { date: SAT })).data
    expect(quote?.conflictingBookings).toEqual([movingOffTheMorning])
    const answer = await post(blockDayRoute, { date: SAT }, { reason: 'Staff day', seen: { toBlock: 3, alreadyBlocked: 0 } })
    expect(refusedWith(answer)).toEqual({ status: 409, reason: 'move_in_flight', words: "A booking is being moved off a slot on this day and its payment isn't finished. Try again when it is." })
    expect(detailsOf(answer)?.conflictingBookings).toEqual([movingOffTheMorning])
    for (const session of [morning, afternoon, evening]) expect(await blockOf(session)).toEqual(['open', null, null])
    expect(await db.query('SELECT 1 FROM closed_dates')).toEqual([])
    expect(await auditRowsOf(db)).toEqual([])

    // Mo's booking moved from the 14:00 to the 18:00, both on Saturday: it is on the day (so it is counted as a
    // booking in the way) and it is moving (so it can't be moved or cancelled from the list): one row, not two.
    const { booking: within } = await moveInFlight(afternoon, evening, mo)
    const again = await post(blockDayRoute, { date: SAT }, { reason: 'Staff day', seen: { toBlock: 3, alreadyBlocked: 0 } })
    expect(refusedWith(again)).toEqual({ status: 409, reason: 'bookings_in_the_way', words: '1 booking exists on this day. Move each one to a different session or cancel it before the day can be blocked.' })
    expect(detailsOf(again)?.conflictingBookings?.map((row) => [row['id'], row['session_id'], row['movingOff']])).toEqual([
      [within, evening, true],
      [booking, morning, true],
    ])
  })

  it("the start-time change is refused in the lead's words while the Move is unfinished (its undo would put the booking back with its old times); the session keeps its time; once the payment is taken it goes through", async () => {
    const { flow } = await moveInFlight(morning, evening)
    const answer = await post(startTimeRoute, { sessionId: morning }, { startTime: `${SAT}T11:00:00.000Z` })
    expect(refusedWith(answer)).toEqual({ status: 409, reason: 'move_in_flight', words: NEW.moveInFlight })
    expect(await stateOf(morning)).toMatchObject({ start_time: `${SAT} 10:00` })
    expect(await auditRowsOf(db)).toEqual([])
    await db.query("UPDATE pending_reader_payments SET status = 'finalised' WHERE id = $1", [flow])
    expect((await post(startTimeRoute, { sessionId: morning }, { startTime: `${SAT}T11:00:00.000Z` })).status).toBe(200)
  })
})

describe('W51a (W51 review L3; Wayne, 20 Nov 2026): closed dates', () => {
  // Christmas Day 2031, after the date the nightly job has made sessions up to (1 June 2031 here).
  const FAR = '2031-12-25'
  const madeUpTo = (date: string) => database.pg.exec(`RESET ROLE; INSERT INTO public.sessions_made_up_to (made_up_to) VALUES ('${date}'); SET ROLE paddock_worker;`)
  const closedRows = () => db.query<{ date: string; reason: string | null; closed_by: string | null }>('SELECT closed_on::text AS date, reason, closed_by FROM closed_dates ORDER BY closed_on')
  const blockQuote = (date: string) => get<{ sessions: number; toBlock: number; alreadyBlocked: number; conflictingBookings: unknown[]; closed: boolean; afterMadeUpTo: boolean }>(blockDayQuoteRoute, {}, { date })
  const blockTheDay = (date: string, seen: unknown, reason = 'Closed for Christmas', email: string | null = JO) => post(blockDayRoute, { date }, { reason, seen }, email)
  const unblockQuote = (date: string) => get<{ blockedSessions: number; blockedBefore: number; closedDates: number; closedReason: string | null }>(unblockDayQuoteRoute, {}, { date })
  const unblockTheDay = (date: string, seen: unknown, email: string | null = JO) => post(unblockDayRoute, { date }, { seen }, email)
  /** As the dialog: the quote, then the press with its stamp (none when the quote is refused). */
  const create = async (startTime: string) => post(oneOffRoute, {}, { serviceTypeId: sauna, startTime, stamp: (await quote(sauna, startTime)).data?.stamp })

  it('Block Day on a date after "made up to": the quote says so, and the press records the closed date with the reason and who (it has no session to block), with one audit row; pressed again it changes nothing and the first reason and who stay', async () => {
    await madeUpTo('2031-06-01')
    expect((await blockQuote(FAR)).data).toEqual({ sessions: 0, toBlock: 0, alreadyBlocked: 0, conflictingBookings: [], closed: false, afterMadeUpTo: true })
    // The date itself is made; the day after is the first that isn't. A date with sessions, long made, isn't either.
    expect((await blockQuote('2031-06-01')).data).toMatchObject({ afterMadeUpTo: false })
    expect((await blockQuote('2031-06-02')).data).toMatchObject({ afterMadeUpTo: true })
    expect((await blockQuote(SAT)).data).toMatchObject({ sessions: 3, afterMadeUpTo: false, closed: false })

    const answer = await blockTheDay(FAR, { toBlock: 0, alreadyBlocked: 0 }, 'Closed for Christmas', TIA)
    expect(answer.status).toBe(200)
    expect(answer.data).toEqual({ blocked: true, conflict: false, conflictingBookings: [], blockedCount: 0, alreadyBlocked: 0, closedDate: true })
    expect(await closedRows()).toEqual([{ date: FAR, reason: 'Closed for Christmas', closed_by: tia }])
    const rows = await auditRowsOf(db)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ action: 'session.blocked', actor_id: tia, entity_type: 'session_day', entity_id: FAR, details: { date: FAR, sessionIds: [], blockedCount: 0, alreadyBlocked: 0, closedDate: true, before: [], after: [] } })

    // Again, by someone else, for another reason: the date is closed already, and keeps its first reason and who.
    expect((await blockQuote(FAR)).data).toMatchObject({ closed: true, afterMadeUpTo: true })
    expect((await blockTheDay(FAR, { toBlock: 0, alreadyBlocked: 0 }, 'Boxing Day sale')).data).toMatchObject({ blocked: true, blockedCount: 0, closedDate: false })
    expect(await closedRows()).toEqual([{ date: FAR, reason: 'Closed for Christmas', closed_by: tia }])
    expect((await auditRowsOf(db))[1]?.details).toMatchObject({ closedDate: false })
  })

  it('Block Day on a date with sessions blocks them as before AND records the date, so the two never disagree; Unblock Day reopens what it blocked and removes the closed date, with one audit row', async () => {
    expect((await blockTheDay(SAT, { toBlock: 3, alreadyBlocked: 0 }, 'Staff day')).data).toMatchObject({ blockedCount: 3, closedDate: true })
    expect(await closedRows()).toEqual([{ date: SAT, reason: 'Staff day', closed_by: jo }])
    expect((await unblockQuote(SAT)).data).toEqual({ blockedSessions: 3, blockedBefore: 0, closedDates: 1, closedReason: 'Staff day' })
    const answer = await unblockTheDay(SAT, { blockedSessions: 3, blockedBefore: 0, closedDates: 1 }, TIA)
    expect(answer.data).toEqual({ confirmed: true, blockedSessions: 3, blockedBefore: 0, unblocked: 3, closedDateRemoved: true })
    expect(await closedRows()).toEqual([])
    for (const session of [morning, afternoon, evening]) expect(await blockOf(session)).toEqual(['open', null, null])
    const rows = await auditRowsOf(db)
    expect(rows[1]).toMatchObject({ action: 'session.unblocked', actor_id: tia, entity_type: 'session_day', entity_id: SAT, details: { date: SAT, unblocked: 3, leftBlocked: 0, closedDateRemoved: true, closedReason: 'Staff day' } })
    expect((await unblockQuote(SAT)).data).toEqual({ blockedSessions: 0, blockedBefore: 0, closedDates: 0, closedReason: null })
  })

  it('Unblock Day on a closed date with no sessions: the quote says a closed date goes; a press that sent no such figure is refused with the figures; the press removes it', async () => {
    await madeUpTo('2031-06-01')
    await blockTheDay(FAR, { toBlock: 0, alreadyBlocked: 0 })
    expect((await unblockQuote(FAR)).data).toEqual({ blockedSessions: 0, blockedBefore: 0, closedDates: 1, closedReason: 'Closed for Christmas' })
    const stale = await unblockTheDay(FAR, { blockedSessions: 0, blockedBefore: 0 })
    expect(refusedWith(stale)).toEqual({ status: 409, reason: 'changed_since', words: NEW.countsChanged })
    expect(detailsOf(stale)?.counts).toEqual({ blockedSessions: 0, blockedBefore: 0, closedDates: 1 })
    expect(await closedRows()).toHaveLength(1)
    expect((await unblockTheDay(FAR, { blockedSessions: 0, blockedBefore: 0, closedDates: 1 })).data).toEqual({ confirmed: true, blockedSessions: 0, blockedBefore: 0, unblocked: 0, closedDateRemoved: true })
    expect(await closedRows()).toEqual([])
    // Nothing left: a press that says a closed date is there is refused, and one with the figures as they are changes nothing.
    expect(refusedWith(await unblockTheDay(FAR, { blockedSessions: 0, blockedBefore: 0, closedDates: 1 }))).toMatchObject({ reason: 'changed_since' })
    expect((await unblockTheDay(FAR, { blockedSessions: 0, blockedBefore: 0, closedDates: 0 })).data).toMatchObject({ unblocked: 0, closedDateRemoved: false })
  })

  it("a one-off session on a closed date is refused in the lead's words, and none is made; any other date is as before; once the day is unblocked it is made", async () => {
    await blockTheDay(FAR, { toBlock: 0, alreadyBlocked: 0 })
    const answer = await create(`${FAR}T10:00:00.000Z`)
    expect(refusedWith(answer)).toEqual({ status: 409, reason: 'date_closed', words: 'This date is closed. Unblock the day first if you want to add a session.' })
    expect(await db.query("SELECT 1 FROM sessions WHERE (start_time AT TIME ZONE 'UTC')::date = $1::date", [FAR])).toEqual([])
    // 23:30 on the closed date is on it; 00:30 the next morning and 23:30 the night before are not.
    expect((await create(`${FAR}T23:30:00.000Z`)).reason).toBe('date_closed')
    expect((await create('2031-12-26T00:30:00.000Z')).status).toBe(200)
    expect((await create('2031-12-24T23:30:00.000Z')).status).toBe(200)
    // The other refusals still come first, in the old order: a time that isn't one names no date.
    expect((await create('Christmas')).reason).toBe('invalid_start_time')
    expect((await auditRowsOf(db)).map((row) => row.action)).toEqual(['session.blocked', 'session.created', 'session.created'])
    await unblockTheDay(FAR, { blockedSessions: 0, blockedBefore: 0, closedDates: 1 })
    expect((await create(`${FAR}T10:00:00.000Z`)).status).toBe(200)
  })

  it('a start-time change that would move a session onto a closed date from another date is refused; a session already on the closed date may change its time, and may leave it', async () => {
    const sunday = await sessionAt(`${SUN} 10:00`)
    await blockTheDay(SAT, { toBlock: 3, alreadyBlocked: 0 }, 'Staff day')
    const moved = await post(startTimeRoute, { sessionId: sunday }, { startTime: `${SAT}T12:00:00.000Z` })
    expect(refusedWith(moved)).toEqual({ status: 409, reason: 'date_closed', words: 'That date is closed. Unblock the day first if you want to move a session onto it.' })
    expect(await stateOf(sunday)).toMatchObject({ start_time: `${SUN} 10:00`, status: 'open' })
    // The 10:00 is on the closed Saturday already (blocked by the day): its time may change within the day, still blocked.
    expect((await post(startTimeRoute, { sessionId: morning }, { startTime: `${SAT}T09:00:00.000Z` })).status).toBe(200)
    expect(await stateOf(morning)).toMatchObject({ start_time: `${SAT} 09:00`, status: 'blocked' })
    // And it may be moved off the closed date.
    expect((await post(startTimeRoute, { sessionId: morning }, { startTime: `${SUN}T09:00:00.000Z` })).status).toBe(200)
  })

  it('the calendar read answers the closed dates in its range, both ends included, each with its reason, in date order, whether or not the date has sessions', async () => {
    await blockTheDay(SAT, { toBlock: 3, alreadyBlocked: 0 }, 'Staff day')
    await blockTheDay(FAR, { toBlock: 0, alreadyBlocked: 0 })
    const closedIn = async (startDate: string, endDate: string) => (await get<Calendar>(sessionsRoute, { startDate, endDate })).data?.closedDates
    expect(await closedIn(SAT, SAT)).toEqual([{ date: SAT, reason: 'Staff day' }])
    expect(await closedIn(SUN, SUN)).toEqual([])
    expect(await closedIn('2031-02-01', SAT)).toEqual([{ date: SAT, reason: 'Staff day' }])
    expect(await closedIn(SAT, '2031-03-31')).toEqual([{ date: SAT, reason: 'Staff day' }])
    expect(await closedIn(SAT, FAR)).toEqual([{ date: SAT, reason: 'Staff day' }, { date: FAR, reason: 'Closed for Christmas' }])
    // A closed date with no session is still answered, with no session beside it.
    expect((await get<Calendar>(sessionsRoute, { startDate: FAR, endDate: FAR })).data).toEqual({ sessions: [], madeUpTo: null, closedDates: [{ date: FAR, reason: 'Closed for Christmas' }] })
    // A reason left out is answered as none.
    await db.query("INSERT INTO closed_dates (closed_on, closed_by) VALUES ('2031-12-26', $1)", [jo])
    expect(await closedIn('2031-12-26', '2031-12-26')).toEqual([{ date: '2031-12-26', reason: null }])
  })

  it('a session unblocked on its own card on a closed date opens, and the date stays closed (the calendar shows both): the choice this brief made', async () => {
    await blockTheDay(SAT, { toBlock: 3, alreadyBlocked: 0 }, 'Staff day')
    expect((await post(unblockRoute, { sessionId: morning })).status).toBe(200)
    expect(await blockOf(morning)).toEqual(['open', null, null])
    expect(await closedRows()).toEqual([{ date: SAT, reason: 'Staff day', closed_by: jo }])
    // Unblock Day then reopens the other two and removes the closed date.
    expect((await unblockQuote(SAT)).data).toEqual({ blockedSessions: 2, blockedBefore: 0, closedDates: 1, closedReason: 'Staff day' })
  })
})

describe("W51a (W51 review L1): a block's audit row keeps the clock read under the session's lock, and Unblock Day's \"latest block\" is by it", () => {
  const unblockQuote = () => get<{ blockedSessions: number; blockedBefore: number }>(unblockDayQuoteRoute, {}, { date: SAT })
  const MICROSECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/

  it('a block on its own and a Block Day both write `lockedAt` (UTC, to the microsecond), in the order they were made; an unblock writes none', async () => {
    await post(blockRoute, { sessionId: afternoon }, { reason: 'Boiler repair' })
    await post(blockDayRoute, { date: SAT }, { reason: 'Staff day', seen: { toBlock: 2, alreadyBlocked: 1 } })
    await post(unblockRoute, { sessionId: afternoon })
    const rows = await auditRowsOf(db)
    expect(rows.map((row) => `${row.action}:${row.entity_type}`)).toEqual(['session.blocked:session', 'session.blocked:session_day', 'session.unblocked:session'])
    const [own, day] = [rows[0]?.details['lockedAt'] as string, rows[1]?.details['lockedAt'] as string]
    expect(own).toMatch(MICROSECONDS)
    expect(day).toMatch(MICROSECONDS)
    expect(day > own).toBe(true)
    expect(rows[2]?.details['lockedAt']).toBeUndefined()
    // It is the real clock, read during the press: within a minute of now.
    expect(Math.abs(Date.parse(own) - Date.now())).toBeLessThan(60_000)
  })

  it("the block that took the session's lock last is the latest, whatever its row's own time: a block on its own that STARTED before a Block Day and took the lock after it (and after an unblock) stays blocked on Unblock Day", async () => {
    // In order of the locks: Block Day; the 10:00 unblocked on its own; the 10:00 blocked on its own, for a deep clean.
    await post(blockDayRoute, { date: SAT }, { reason: 'Staff day', seen: { toBlock: 3, alreadyBlocked: 0 } })
    await post(unblockRoute, { sessionId: morning })
    await post(blockRoute, { sessionId: morning }, { reason: 'Deep clean' })
    expect((await unblockQuote()).data).toMatchObject({ blockedSessions: 2, blockedBefore: 1 })
    // The race of the review's L1: the deep-clean block's transaction began BEFORE the Block Day's (it waited for the
    // session's lock), so its row's own time, the transaction's start, is the earlier of the two.
    await database.pg.exec(
      "RESET ROLE; UPDATE audit_log SET at = (SELECT min(at) FROM audit_log) - interval '1 minute' WHERE action = 'session.blocked' AND entity_type = 'session'; SET ROLE paddock_worker;"
    )
    const rows = await db.query<{ entity_type: string }>("SELECT entity_type FROM audit_log WHERE action = 'session.blocked' ORDER BY at")
    expect(rows.map((row) => row.entity_type)).toEqual(['session', 'session_day'])
    // By the lock's clock the deep clean is still the 10:00's latest block: blocked on its own, and left by Unblock Day.
    expect((await unblockQuote()).data).toMatchObject({ blockedSessions: 2, blockedBefore: 1 })
    expect((await post(unblockDayRoute, { date: SAT }, { seen: { blockedSessions: 2, blockedBefore: 1, closedDates: 1 } })).data).toMatchObject({ unblocked: 2 })
    expect(await blockOf(morning)).toEqual(['blocked', 'Deep clean', jo])
    expect(await blockOf(afternoon)).toEqual(['open', null, null])
  })

  it('control: by the rows\' own times (what W51 ordered by: a row with no `lockedAt` falls back to its own time) the same history reads the deep clean as a Block Day\'s, and Unblock Day would reopen it', async () => {
    await post(blockDayRoute, { date: SAT }, { reason: 'Staff day', seen: { toBlock: 3, alreadyBlocked: 0 } })
    await post(unblockRoute, { sessionId: morning })
    await post(blockRoute, { sessionId: morning }, { reason: 'Deep clean' })
    await database.pg.exec(
      "RESET ROLE; UPDATE audit_log SET at = (SELECT min(at) FROM audit_log) - interval '1 minute' WHERE action = 'session.blocked' AND entity_type = 'session'; UPDATE audit_log SET details = details - 'lockedAt' WHERE action = 'session.blocked'; SET ROLE paddock_worker;"
    )
    expect((await unblockQuote()).data).toMatchObject({ blockedSessions: 3, blockedBefore: 0 })
  })
})

describe('the words W51 and W51a add', () => {
  it('are exactly these, and none is one of the old sentences', () => {
    expect(NEW.sessionGone).toBe('This session no longer exists. Reload the page and try again.')
    expect(NEW.bookingsInTheWay(1)).toBe('This slot has 1 booking. Move each one to a different session or cancel it before this slot can be blocked.')
    expect(NEW.bookingsInTheWay(3)).toBe('This slot has 3 bookings. Move each one to a different session or cancel it before this slot can be blocked.')
    expect(NEW.dayBookingsInTheWay(1)).toBe('1 booking exists on this day. Move each one to a different session or cancel it before the day can be blocked.')
    expect(NEW.dayBookingsInTheWay(2)).toBe('2 bookings exist on this day. Move each one to a different session or cancel it before the day can be blocked.')
    expect(NEW.alreadyBlocked).toBe('This session is already blocked. Its reason has been left as it was.')
    expect(NEW.notBlocked).toBe("This session isn't blocked, so there is nothing to unblock.")
    expect(NEW.countsChanged).toBe('This has changed since the figures were shown. Check the new figures, then confirm again.')
    expect(NEW.notOverridden).toBe("This session's band is already set automatically.")
    expect(NEW.serviceTypeGone).toBe('That service type no longer exists. Reload the page and try again.')
    expect(NEW.noLength).toBe("This session's service type has no duration set, so its end time can't be worked out. Set the duration on the Service Types page first.")
    expect(NEW.slotGone).toBe('That weekly slot no longer exists. Reload the page and try again.')
    expect(COUNTS_CHANGED_REASON).toBe('changed_since')
    // W51a: the lead's two sentences word for word, and their two neighbours.
    expect(NEW.moveInFlight).toBe("A booking is being moved off this slot and its payment isn't finished. Try again when it is.")
    expect(NEW.dayMoveInFlight).toBe("A booking is being moved off a slot on this day and its payment isn't finished. Try again when it is.")
    expect(NEW.dateClosed).toBe('This date is closed. Unblock the day first if you want to add a session.')
    expect(NEW.dateClosedForMove).toBe('That date is closed. Unblock the day first if you want to move a session onto it.')
    expect(MOVE_IN_FLIGHT_REASON).toBe('move_in_flight')
    // W51a (W51 report "Noticed" 2): the start-time refusal no longer says the booking was "just made".
    expect(SESSION_ADMIN_DIALOG_WORDS.EditSessionStartTimeDialog.session_has_bookings).toBe("This slot has a booking, so its start time can't be changed.")
    const old = JSON.stringify([SESSION_ADMIN_WORDS, SESSION_ADMIN_DIALOG_WORDS])
    for (const words of Object.values(NEW)) expect(old).not.toContain(typeof words === 'function' ? words(2) : words)
  })
})
