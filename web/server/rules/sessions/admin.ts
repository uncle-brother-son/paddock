// W51 (G-plan 1.1's slot rows, 1.9, 4.3, 4.5; bugs GB3 to GB7 and GB14; Wayne's Q50; W49 + W54 review W51-1; W48
// review L1; W50 review L1): sessions and the timetable on the Worker. Ported from the staff app's
// getSessionsForRange.ts, getServiceTypesForSlot.ts, blockSession.ts, blockDay.ts, unblockSession.ts, unblockDay.ts,
// setSessionBand.ts, resetSessionBand.ts, setSessionStartTime.ts, createOneOffSession.ts,
// addServiceTypeScheduleSlot.ts and deleteServiceTypeScheduleSlot.ts (as they were at W48), with
// their words (./admin-failure-messages.ts). generateUpcomingSessions.ts is not ported: it was dead code (GB24), and
// the nightly job is the database's own function (migration 032).
//
// The two reads
//  - GB14: an active staff member, through the admin read helper (the old reads checked nobody). Named columns.
//  - A range picks its days by the session's London day, read from the stored digits whatever the connection's time
//    zone (time/london-day-sql.ts). The slot read takes the weekday and the time of day from the same digits.
//  - The calendar read also answers the date the nightly job has made sessions up to (migration 032's one row), which
//    the Service Types page's words name (Q50: a slot or capacity change reaches only dates after it).
//
// The writes (G-plan 4.2, level B): one transaction under the session's lock, an audit row with the row before and
// after, and the press's key.
//  - GB5 (and W50 review L1): every booking that isn't cancelled stops a block (pending, confirmed, Payment needed,
//    and one already attended), read under the session's lock. A new order, a Move onto the session and Add Guest
//    take the same lock before they write a booking, so no NEW booking can land between the check and the block.
//  - W51a (W51 review S1): a booking can also come BACK onto a session it was moved off. A dearer Move on a saved
//    card or the reader moves the booking at once and waits for its payment; if the payment is cancelled, the flow's
//    undo (orders/reader-flow.ts) puts the booking back on its old session without that session's lock. So a block,
//    a Block Day and a start-time change are also refused while an unfinished Move flow names the session as its old
//    session (`pending_reader_payments`, pending, flow `move`, `snapshot.old_session_id`), read under the session's
//    lock: Move's C1 writes that row while it holds the old session's lock (bookings/move.ts, `ownSession`), so it
//    is committed before the block's read or the block is committed before C1's. The other way back, a refund's
//    undo (a cheaper Move or a cancel whose first card part Stripe refuses: bookings/refunds.ts), has no such row;
//    it holds the session's lock and puts the booking back only on a session that is open and at the booking's time.
//  - GB6: a start-time change is refused while the session has any booking that isn't cancelled.
//  - GB7: a block never overwrites an earlier block (a single block of a blocked session is refused; Block Day
//    leaves it, with its own reason and who); unblock opens only what is blocked; Unblock Day reopens the sessions a
//    Block Day blocked and leaves the ones blocked on their own, and says how many. "Blocked by a Block Day" is read
//    from the block's own audit row (the latest `session.blocked` row that names the session), which the block
//    writes in its own transaction. A session blocked before W51 has no such row and counts as blocked on its own.
//    W51a (W51 review L1): "latest" is by `lockedAt` in the row's details, the clock read after the block took the
//    session's lock, not by the row's own time (the transaction's start, which a block that waited for the lock
//    has earlier than the block it waited for).
//  - W51a (W51 review L3; Wayne, 20 Nov 2026): closed dates (migration 032's `closed_dates`). Block Day records its
//    date as closed, with its reason, whether or not the day has sessions yet, so a date further ahead than the
//    nightly job has reached can be closed and the job makes no session on it; Unblock Day removes the closed date
//    as well as reopening what a Block Day blocked (the job then makes the day on its next run, if it had passed
//    it). A one-off session on a closed date is refused, and so is a start-time change that would move a session
//    onto one from another date. Each of those, and the job, holds the date's lock first (admin/locks.ts,
//    holdSessionDay), so the job can't make a day while it is being closed. An existing session unblocked on its
//    own card on a closed date is left to staff: the calendar shows the date as closed and the session as open.
//  - W51a (W51 review L4): a band set by hand is read inside the transaction, FOR SHARE, before the sessions.
//  - W51-1: every write that can set a band from the day's windows (a one-off session, a start-time change, a reset)
//    takes the band guard shared first, before the session (admin/locks.ts, holdBandGuardShared).
//  - W48 review L1: Block Day, Unblock Day and a day's band change lock the day's sessions in id order before their
//    multi-row write, so none can deadlock with a band-window save re-banding the same day.
//  - Q18's rule for counts: the day actions and a band change show their figures first (a quote), and the press
//    sends the figures staff saw. If they are no longer right nothing is written and the refusal carries the new ones.
//  - W54a's stale-page rule applies to one of these (W68, Wayne's Q58): a one-off session's dialog shows the band and
//    price it would get (`GET sessions/one-off/quote`), and the press sends that quote's stamp: changed since, nothing is
//    made. The rest write only what was pressed, never a row as a page read it: a block or unblock is one switch; a
//    band, a start time and a weekly slot are one value each. The figures a press confirms are held by Q18's rule above.
//  - Q50 part 2 (Wayne, 20 Nov): adding or removing a weekly slot needs Manage pricing. Block, unblock, start time
//    and one-off sessions stay open to every active staff member; a band override and its reset need Manage pricing,
//    as they did.
import 'server-only'
import type {
  AdminAction,
  AdminDeleteServiceTypeScheduleSlotOutput,
  AdminGetServiceTypesForSlotOutput,
  AdminGetSessionsForRangeOutput,
  AdminSetSessionBandOutput,
  BlockDayQuoteRouteOutput,
  BlockDayRouteOutput,
  OneOffSessionQuoteRouteOutput,
  OneOffSessionRouteOutput,
  ScheduleSlotRow,
  SessionBandResetRouteOutput,
  SessionBlockRouteOutput,
  SessionRefusalDetails,
  SessionRow,
  SessionsRouteInput,
  SessionsRouteOutput,
  SessionStartTimeRouteOutput,
  UnblockDayQuoteRouteOutput,
  UnblockDayRouteOutput,
} from '@/contracts'
import type { ApiErrorCode } from '@/contracts'
import { postgresRefusal, type Db, type Queryable, type Tx } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import { holdBandGuardShared, holdSessionDay, isUuid, lockAdminRows } from '@/server/rules/admin/locks'
import { adminRead, namedRead } from '@/server/rules/admin/read'
import { adminRefusal, requireAdminPermission, type AdminActor } from '@/server/rules/admin/refusal'
import { adminWrite, WRITES_ONLY_WHAT_WAS_PRESSED, type AdminWriteOptions } from '@/server/rules/admin/write'
import { withinLondonDaysSql } from '@/server/rules/time/london-day-sql'
import { COUNTS_CHANGED_REASON, MOVE_IN_FLIGHT_REASON, SESSION_ADMIN_DIALOG_WORDS, SESSION_ADMIN_NEW_WORDS, SESSION_ADMIN_WORDS } from './admin-failure-messages'

// ---------------------------------------------------------------------------------------------------------------------
// Shared pieces

const NEW = SESSION_ADMIN_NEW_WORDS

/** A refusal whose details carry more than the reason and words: the bookings in the way, the figures as they now are. */
function sessionRefusal(code: ApiErrorCode, action: string, reason: string, message: string, more: Pick<SessionRefusalDetails, 'conflictingBookings' | 'counts'>): ApiError {
  const details: SessionRefusalDetails = { reason, message, action, ...more }
  return new ApiError(code, message, { details })
}

const sessionGone = (action: string): ApiError => adminRefusal('NOT_FOUND', action, 'session_not_found', NEW.sessionGone)
const countsChanged = (action: string, counts: Record<string, number>): ApiError => sessionRefusal('CONFLICT', action, COUNTS_CHANGED_REASON, NEW.countsChanged, { counts })

/** Whether the figures a press sent are the figures now: each named figure a whole number, and the same. A press that sent none never is. */
function sameCounts(seen: unknown, now: Record<string, number>): boolean {
  if (seen === null || typeof seen !== 'object' || Array.isArray(seen)) return false
  const sent = seen as Record<string, unknown>
  return Object.entries(now).every(([name, value]) => Number.isInteger(sent[name]) && sent[name] === value)
}

/** A moment as ISO text, as the old functions' answers reached the screens. */
const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value))

/**
 * A real date and time in the form the session dialogs send: YYYY-MM-DDTHH:MM:SS.mmmZ. The staff app's
 * shared/isoDateTime.ts, moved: Postgres takes a year of five or more digits without complaint, so it is refused here.
 */
export function isValidIsoDateTime(value: unknown): value is string {
  if (typeof value !== 'string') return false
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || value.startsWith('0000')) return false
  const parsed = new Date(value)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value
}

const SESSION_COLUMNS_SQL = 'id, resource_id, service_type_id, start_time, end_time, type, capacity, total_booked, status, blocked_reason, blocked_by, created_at, updated_at, band_id, band_overridden'
type SessionRowRaw = Omit<SessionRow, 'start_time' | 'end_time' | 'created_at' | 'updated_at'> & { start_time: unknown; end_time: unknown; created_at: unknown; updated_at: unknown }
const sessionRow = (row: SessionRowRaw): SessionRow => ({ ...row, start_time: iso(row.start_time), end_time: iso(row.end_time), created_at: iso(row.created_at), updated_at: iso(row.updated_at) })

/** What an audit row keeps of a session's block: the switch, its reason and who. */
interface BlockState {
  id: string
  status: string
  blocked_reason: string | null
  blocked_by: string | null
}
const BLOCK_STATE_SQL = 'SELECT id, status, blocked_reason, blocked_by FROM sessions WHERE id = ANY($1::uuid[]) ORDER BY id'
/** What an audit row keeps of a session's band. */
interface BandState {
  id: string
  band_id: string | null
  band_overridden: boolean
}
const BAND_STATE_SQL = 'SELECT id, band_id, band_overridden FROM sessions WHERE id = ANY($1::uuid[]) ORDER BY id'

/** The ids of the sessions on a London day (`$1`), in id order. */
const DAY_SESSION_IDS_SQL = `SELECT s.id FROM sessions s WHERE ${withinLondonDaysSql('s.start_time', '$1', '$1')} ORDER BY s.id`

/**
 * A day's sessions, locked in id order (W48 review L1), before a multi-row write of them. The ids are read, then
 * locked through the admin helper; the ids held are the ones the write then names, so a session made on the day
 * after this (a one-off) is simply not part of the press.
 */
async function lockDaySessions(tx: Tx, date: string): Promise<string[]> {
  const ids = (await tx.query<{ id: string }>(DAY_SESSION_IDS_SQL, [date])).map((row) => row.id)
  const held = await lockAdminRows(tx, [{ table: 'sessions', ids }])
  return held.sessions ?? []
}

/** One session's lock. Empty when the id names no session. */
async function lockSession(tx: Tx, sessionId: string): Promise<boolean> {
  const held = await lockAdminRows(tx, [{ table: 'sessions', ids: [sessionId] }])
  return (held.sessions ?? []).length === 1
}

/**
 * W51a (W51 review L1): the clock, read in a statement of its own after the press has its locks, as text that sorts
 * as time (UTC, to the microsecond). A block writes it into its audit row as `lockedAt`; Unblock Day reads the
 * latest block by it.
 */
const LOCKED_AT_SQL = `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`
async function lockedAt(tx: Tx): Promise<string> {
  const at = (await tx.query<{ at: string }>(LOCKED_AT_SQL))[0]?.at
  if (!at) throw new Error("The clock wasn't read.")
  return at
}

// ---------------------------------------------------------------------------------------------------------------------
// Closed dates (W51a; migration 032)

/** The London calendar date of a start time in the dialogs' form: its own digits (the stored form is London's wall clock). */
const dayOf = (startTime: string): string => startTime.slice(0, 10)

const CLOSED_DATE_SQL = 'SELECT closed_on::text AS date, reason FROM closed_dates WHERE closed_on = $1::date'
const CLOSED_DATES_IN_RANGE_SQL = 'SELECT closed_on::text AS date, reason FROM closed_dates WHERE closed_on BETWEEN $1::date AND $2::date ORDER BY closed_on'
const CLOSE_DATE_SQL = 'INSERT INTO closed_dates (closed_on, reason, closed_by) VALUES ($1::date, $2, $3::uuid) ON CONFLICT (closed_on) DO NOTHING RETURNING closed_on'
const REOPEN_DATE_SQL = 'DELETE FROM closed_dates WHERE closed_on = $1::date RETURNING closed_on'

interface ClosedDate {
  date: string
  reason: string | null
}
/** The closed date's row, or nothing when the date isn't closed. For a write: read after the date's lock is held. */
async function closedDate(db: Queryable, date: string): Promise<ClosedDate | null> {
  return (await db.query<ClosedDate>(CLOSED_DATE_SQL, [date]))[0] ?? null
}
const dateClosed = (action: string, message: string): ApiError => adminRefusal('CONFLICT', action, 'date_closed', message)

// ---------------------------------------------------------------------------------------------------------------------
// The two reads

const SESSIONS_FOR_RANGE_SQL = `
SELECT s.id,
       s.service_type_id,
       st.name AS service_type_name,
       st.booking_type,
       s.start_time,
       s.end_time,
       s.capacity,
       s.total_booked,
       s.status,
       s.blocked_reason,
       s.blocked_by,
       (s.start_time AT TIME ZONE 'UTC') <= (now() AT TIME ZONE 'Europe/London') AS started,
       sb.id AS band_id,
       sb.code AS band_code,
       sb.name AS band_name,
       sb.price::text AS band_price,
       s.band_overridden,
       COUNT(b.id) FILTER (WHERE b.status = 'confirmed')::int AS confirmed_booking_count
  FROM sessions s
  JOIN service_types st ON st.id = s.service_type_id
  LEFT JOIN session_bands sb ON sb.id = s.band_id
  LEFT JOIN bookings b ON b.session_id = s.id
 WHERE ${withinLondonDaysSql('s.start_time', '$1', '$2')}
 GROUP BY s.id, st.name, st.booking_type, sb.id, sb.code, sb.name, sb.price, s.band_overridden
 ORDER BY s.start_time`

/** Migration 032's one row: the last date the nightly job has made sessions for. */
export const MADE_UP_TO_SQL = 'SELECT made_up_to::text AS made_up_to FROM sessions_made_up_to WHERE id'

/** The date the nightly job has made sessions up to, or null on a database whose row was never written. */
export async function sessionsMadeUpTo(db: Queryable): Promise<string | null> {
  return (await db.query<{ made_up_to: string }>(MADE_UP_TO_SQL))[0]?.made_up_to ?? null
}

/**
 * getSessionsForRange (`GET sessions`): every session whose start is on a London day from `startDate` to `endDate`,
 * both included, with its service type, its band and how many confirmed bookings it has; the date the nightly
 * job has made sessions up to; and (W51a) the closed dates in the range, each with its reason, so the calendar can
 * show a date as closed whether or not it has sessions yet. Any active staff member.
 */
export async function listSessions(db: Queryable, input: SessionsRouteInput, options: { actor: AdminActor }): Promise<SessionsRouteOutput> {
  const sessions = await adminRead<AdminGetSessionsForRangeOutput[number]>(
    db,
    { name: 'sessions.list', needs: 'staff', sql: SESSIONS_FOR_RANGE_SQL, params: [input.startDate, input.endDate], times: ['start_time', 'end_time'] },
    options
  )
  return { sessions, madeUpTo: await sessionsMadeUpTo(db), closedDates: await db.query<ClosedDate>(CLOSED_DATES_IN_RANGE_SQL, [input.startDate, input.endDate]) }
}

/**
 * The weekday and the time of day are read from the stored digits (`AT TIME ZONE 'UTC'`), as band_for_session_start
 * reads them, so they don't follow the connection's time zone.
 */
const SERVICE_TYPES_FOR_SLOT_SQL = `
SELECT st.id AS service_type_id,
       st.name AS service_type_name,
       st.booking_type,
       st.duration,
       s.id AS session_id,
       s.start_time,
       s.end_time,
       s.capacity,
       s.total_booked,
       s.status,
       s.blocked_reason,
       (s.start_time AT TIME ZONE 'UTC') <= (now() AT TIME ZONE 'Europe/London') AS started,
       sb.id AS band_id,
       sb.code AS band_code,
       sb.name AS band_name,
       sb.price::text AS band_price,
       s.band_overridden
  FROM service_type_schedule_slots sl
  JOIN service_types st ON st.id = sl.service_type_id AND st.active = true
  JOIN sessions s ON s.service_type_id = st.id AND s.start_time = $1::timestamptz
  LEFT JOIN session_bands sb ON sb.id = s.band_id
 WHERE sl.day_of_week = EXTRACT(DOW FROM ($1::timestamptz AT TIME ZONE 'UTC'))::smallint
   AND sl.start_time = ($1::timestamptz AT TIME ZONE 'UTC')::time
 ORDER BY st.booking_type, st.name`

/**
 * getServiceTypesForSlot (`GET sessions/for-slot`): the service types with a weekly slot at this exact weekday and
 * time and a session already made for it, for New Order's "Add Booking" on a calendar card. Any active staff member.
 * A start that isn't a date and time in the dialogs' form matches no session: it answers none.
 */
export async function serviceTypesForSlot(db: Queryable, startTime: string, options: { actor: AdminActor }): Promise<AdminGetServiceTypesForSlotOutput> {
  requireAdminPermission(options.actor, 'staff', 'sessions.for_slot')
  if (!isValidIsoDateTime(startTime)) return []
  return adminRead<AdminGetServiceTypesForSlotOutput[number]>(db, { name: 'sessions.for_slot', needs: 'staff', sql: SERVICE_TYPES_FOR_SLOT_SQL, params: [startTime], times: ['start_time', 'end_time'] }, options)
}

// ---------------------------------------------------------------------------------------------------------------------
// Block and unblock

/** GB5: the bookings in the way of a block of one session: every booking on it that isn't cancelled, oldest first. */
const SESSION_CONFLICTS_SQL = `
SELECT b.id, c.first_name AS customer_first_name, c.last_name AS customer_last_name, b.party_size,
       b.price_paid::text AS price_paid, b.redemption_source, b.status
  FROM bookings b
  JOIN customers c ON c.id = b.customer_id
 WHERE b.session_id = $1::uuid AND b.status <> 'cancelled'
 ORDER BY b.created_at, b.id`

/** GB5: the same for a day: every booking that isn't cancelled on any of the day's sessions, by session time. */
const DAY_CONFLICTS_SQL = `
SELECT b.id,
       s.id AS session_id,
       st.name AS service_type_name,
       st.booking_type,
       s.start_time AS session_start_time,
       s.end_time AS session_end_time,
       c.first_name AS customer_first_name,
       c.last_name AS customer_last_name,
       b.party_size,
       b.price_paid::text AS price_paid,
       b.redemption_source,
       b.status
  FROM sessions s
  JOIN service_types st ON st.id = s.service_type_id
  JOIN bookings b ON b.session_id = s.id AND b.status <> 'cancelled'
  JOIN customers c ON c.id = b.customer_id
 WHERE ${withinLondonDaysSql('s.start_time', '$1', '$1')}
 ORDER BY s.start_time, b.created_at, b.id`

/**
 * W51a (W51 review S1): the bookings being moved OFF a session (`$1`) whose Move hasn't finished: a pending Move flow
 * that names the session as its old session. The booking's row is on its new session meanwhile, so the statements
 * above don't see it; if the payment is cancelled the flow's undo puts it back here. Read under the session's lock
 * (see the file's header). The flow's row decides: the booking and customer are joined loosely, so a flow is never
 * missed for want of one.
 */
const SESSION_MOVES_OFF_SQL = `
SELECT COALESCE(b.id, p.record_id) AS id, COALESCE(c.first_name, '') AS customer_first_name, COALESCE(c.last_name, '') AS customer_last_name,
       COALESCE(b.party_size, 1) AS party_size, COALESCE(b.price_paid, 0)::text AS price_paid,
       COALESCE(b.redemption_source, 'paid') AS redemption_source, COALESCE(b.status, 'pending') AS status
  FROM pending_reader_payments p
  LEFT JOIN bookings b ON b.id = p.record_id
  LEFT JOIN customers c ON c.id = b.customer_id
 WHERE p.status = 'pending' AND p.flow = 'move' AND p.snapshot->>'old_session_id' = $1::text
 ORDER BY p.created_at, p.id`

/** W51a: the same for a day: every unfinished Move off any of the day's sessions, with the session it is moving off. */
const DAY_MOVES_OFF_SQL = `
SELECT COALESCE(b.id, p.record_id) AS id,
       s.id AS session_id,
       st.name AS service_type_name,
       st.booking_type,
       s.start_time AS session_start_time,
       s.end_time AS session_end_time,
       COALESCE(c.first_name, '') AS customer_first_name,
       COALESCE(c.last_name, '') AS customer_last_name,
       COALESCE(b.party_size, 1) AS party_size,
       COALESCE(b.price_paid, 0)::text AS price_paid,
       COALESCE(b.redemption_source, 'paid') AS redemption_source,
       COALESCE(b.status, 'pending') AS status
  FROM sessions s
  JOIN service_types st ON st.id = s.service_type_id
  JOIN pending_reader_payments p ON p.status = 'pending' AND p.flow = 'move' AND p.snapshot->>'old_session_id' = s.id::text
  LEFT JOIN bookings b ON b.id = p.record_id
  LEFT JOIN customers c ON c.id = b.customer_id
 WHERE ${withinLondonDaysSql('s.start_time', '$1', '$1')}
 ORDER BY s.start_time, p.created_at, p.id`

type SessionConflict = SessionBlockRouteOutput['conflictingBookings'][number]
type DayConflict = BlockDayQuoteRouteOutput['conflictingBookings'][number]
type DayConflictRaw = Omit<DayConflict, 'session_start_time' | 'session_end_time' | 'movingOff'> & { session_start_time: unknown; session_end_time: unknown }

/** What is in the way of a block: the list as the dialogs show it, and how many of each kind. */
interface InTheWay<Row> {
  /** The bookings on the session (or day), then the ones being moved off it, each of those marked `movingOff`. */
  list: Row[]
  /** The bookings that aren't cancelled on the session (or on any of the day's sessions). */
  bookings: number
  /** The unfinished Moves off it that aren't already counted as a booking on the day. */
  movesOff: number
}

/** GB5 and W51a (S1): what is in the way of a block of one session. For a write: read under the session's lock. */
async function sessionInTheWay(db: Queryable, sessionId: string): Promise<InTheWay<SessionConflict>> {
  const bookings = await db.query<SessionConflict>(SESSION_CONFLICTS_SQL, [sessionId])
  const moving = (await db.query<SessionConflict>(SESSION_MOVES_OFF_SQL, [sessionId])).map((row): SessionConflict => ({ ...row, movingOff: true }))
  return { list: [...bookings, ...moving], bookings: bookings.length, movesOff: moving.length }
}

/**
 * GB5 and W51a (S1): what is in the way of a block of a day. A booking moved from one of the day's sessions to
 * another of them, its payment unfinished, is one row: a booking on the day, marked as moving.
 */
async function dayInTheWay(db: Queryable, date: string): Promise<InTheWay<DayConflict>> {
  const shown = (row: DayConflictRaw): DayConflict => ({ ...row, session_start_time: iso(row.session_start_time), session_end_time: iso(row.session_end_time) })
  const bookings = (await db.query<DayConflictRaw>(DAY_CONFLICTS_SQL, [date])).map(shown)
  const moving = (await db.query<DayConflictRaw>(DAY_MOVES_OFF_SQL, [date])).map(shown)
  const movingIds = new Set(moving.map((row) => row.id))
  const onTheDay = new Set(bookings.map((row) => row.id))
  const movesOff = moving.filter((row) => !onTheDay.has(row.id)).map((row): DayConflict => ({ ...row, movingOff: true }))
  return { list: [...bookings.map((row): DayConflict => (movingIds.has(row.id) ? { ...row, movingOff: true } : row)), ...movesOff], bookings: bookings.length, movesOff: movesOff.length }
}

const BLOCK_SESSIONS_SQL = `
UPDATE sessions
   SET status = 'blocked', blocked_reason = $1, blocked_by = $2::uuid, updated_at = now()
 WHERE id = ANY($3::uuid[]) AND status <> 'blocked'
 RETURNING ${SESSION_COLUMNS_SQL}`
const UNBLOCK_SESSIONS_SQL = `
UPDATE sessions
   SET status = 'open', blocked_reason = NULL, blocked_by = NULL, updated_at = now()
 WHERE id = ANY($1::uuid[]) AND status = 'blocked'
 RETURNING ${SESSION_COLUMNS_SQL}`

/** The reason as the old functions stored it: the text sent, or nothing. */
const reasonText = (reason: unknown): string | null => (typeof reason === 'string' ? reason : null)

/**
 * blockSession (`POST sessions/:sessionId/block`). Any active staff member. Under the session's lock: a session
 * that isn't there is refused; any booking on it that isn't cancelled refuses the block and is listed (GB5: the old
 * function looked only at confirmed bookings, in a statement of its own before the block); a session already blocked
 * is refused and keeps its reason (GB7); then the block, with who, and a `session.blocked` audit row.
 */
export async function blockSession(db: Db, sessionId: string, reason: unknown, options: AdminWriteOptions): Promise<SessionBlockRouteOutput> {
  const action = 'session.blocked'
  return adminWrite<BlockState, BlockState, SessionBlockRouteOutput>(
    db,
    {
      action,
      needs: 'staff',
      entity: { type: 'session', id: sessionId },
      locks: [{ table: 'sessions', ids: [sessionId] }],
      unchangedSince: WRITES_ONLY_WHAT_WAS_PRESSED,
      async before(tx, held) {
        const [row] = held.sessions?.length ? await tx.query<BlockState>(BLOCK_STATE_SQL, [held.sessions]) : []
        if (!row) throw sessionGone(action)
        return row
      },
      async change(tx, before) {
        const inTheWay = await sessionInTheWay(tx, sessionId)
        if (inTheWay.bookings > 0) throw sessionRefusal('CONFLICT', action, 'bookings_in_the_way', NEW.bookingsInTheWay(inTheWay.bookings), { conflictingBookings: inTheWay.list })
        // W51a (S1): a booking being moved off this session, its payment unfinished, would come back onto the block.
        if (inTheWay.movesOff > 0) throw sessionRefusal('CONFLICT', action, MOVE_IN_FLIGHT_REASON, NEW.moveInFlight, { conflictingBookings: inTheWay.list })
        if (before.status === 'blocked') throw adminRefusal('CONFLICT', action, 'already_blocked', NEW.alreadyBlocked)
        const at = await lockedAt(tx)
        const [written] = await tx.query<SessionRowRaw>(BLOCK_SESSIONS_SQL, [reasonText(reason), options.actor.id, [sessionId]])
        if (!written) throw new Error('The session was held but not blocked.')
        const session = sessionRow(written)
        return {
          after: { id: session.id, status: session.status, blocked_reason: session.blocked_reason, blocked_by: session.blocked_by },
          answer: { blocked: true, conflict: false, conflictingBookings: [], session },
          details: { lockedAt: at },
        }
      },
    },
    options
  )
}

/**
 * unblockSession (`POST sessions/:sessionId/unblock`). Any active staff member. Under the session's lock: a session
 * that isn't there is refused (the staff app's function answers null, as before); one that isn't blocked is refused
 * and left exactly as it is (GB7: the old function set any session open, whatever it was); then the reopening, and a
 * `session.unblocked` audit row. Answers the session's row.
 */
export async function unblockSession(db: Db, sessionId: string, options: AdminWriteOptions): Promise<SessionRow> {
  const action = 'session.unblocked'
  return adminWrite<BlockState, BlockState, SessionRow>(
    db,
    {
      action,
      needs: 'staff',
      entity: { type: 'session', id: sessionId },
      locks: [{ table: 'sessions', ids: [sessionId] }],
      unchangedSince: WRITES_ONLY_WHAT_WAS_PRESSED,
      async before(tx, held) {
        const [row] = held.sessions?.length ? await tx.query<BlockState>(BLOCK_STATE_SQL, [held.sessions]) : []
        if (!row) throw sessionGone(action)
        return row
      },
      async change(tx, before) {
        if (before.status !== 'blocked') throw adminRefusal('CONFLICT', action, 'not_blocked', NEW.notBlocked)
        const [written] = await tx.query<SessionRowRaw>(UNBLOCK_SESSIONS_SQL, [[sessionId]])
        if (!written) throw new Error('The session was held but not reopened.')
        const session = sessionRow(written)
        return { after: { id: session.id, status: session.status, blocked_reason: session.blocked_reason, blocked_by: session.blocked_by }, answer: session }
      },
    },
    options
  )
}

const DAY_BLOCK_COUNTS_SQL = `
SELECT count(*)::int AS sessions,
       count(*) FILTER (WHERE s.status <> 'blocked')::int AS to_block,
       count(*) FILTER (WHERE s.status = 'blocked')::int AS already_blocked
  FROM sessions s
 WHERE ${withinLondonDaysSql('s.start_time', '$1', '$1')}`

/**
 * What Block Day would do (`GET sessions/days/:date/block/quote`): how many sessions the day has, how many it would
 * block, how many are blocked already and keep their own reason (GB7), and the bookings in the way (GB5), with any
 * being moved off the day's sessions whose payment isn't finished (W51a, S1). W51a: also whether the date is closed
 * already, and whether it is after the date the nightly job has made sessions up to (the press then closes a date
 * that has no sessions yet). Any active staff member.
 */
export async function blockDayQuote(db: Queryable, date: string, options: { actor: AdminActor }): Promise<BlockDayQuoteRouteOutput> {
  requireAdminPermission(options.actor, 'staff', 'session.blocked')
  const [counts] = await namedRead<{ sessions: number; to_block: number; already_blocked: number }>(db, { name: 'sessions.block_day_quote', sql: DAY_BLOCK_COUNTS_SQL, params: [date] })
  const madeUpTo = await sessionsMadeUpTo(db)
  return {
    sessions: counts?.sessions ?? 0,
    toBlock: counts?.to_block ?? 0,
    alreadyBlocked: counts?.already_blocked ?? 0,
    conflictingBookings: (await dayInTheWay(db, date)).list,
    closed: (await closedDate(db, date)) !== null,
    afterMadeUpTo: madeUpTo !== null && date > madeUpTo,
  }
}

/**
 * blockDay (`POST sessions/days/:date/block`). Any active staff member. One transaction: the date's lock (W51a: the
 * nightly job and a one-off session take it too), then the day's sessions locked in id order (W48 review L1); any
 * booking that isn't cancelled on any of them refuses the block and is listed (GB5), and so does a booking being
 * moved off one of them whose payment isn't finished (W51a, S1); the figures the press sent (`seen`: how many it
 * would block, how many are blocked already) must be the figures now (Q18's rule), or nothing is written and the
 * refusal carries the new ones; then every session that isn't blocked is blocked, with the reason and who, and the
 * ones blocked before are left with their own (GB7); the date is recorded as closed, with the reason and who, unless
 * it already is (W51a: a date with no session yet is closed this way, and the nightly job then makes none on it);
 * and one `session.blocked` audit row for the day, which names the sessions it blocked (Unblock Day reads it), when
 * the lock was taken (W51 review L1) and whether this press closed the date.
 */
export async function blockDay(db: Db, date: string, reason: unknown, seen: unknown, options: AdminWriteOptions): Promise<BlockDayRouteOutput> {
  const action = 'session.blocked'
  return adminWrite<BlockState[], BlockState[], BlockDayRouteOutput>(
    db,
    {
      action,
      needs: 'staff',
      entity: { type: 'session_day', id: date },
      locks: [],
      unchangedSince: WRITES_ONLY_WHAT_WAS_PRESSED,
      async before(tx) {
        // W51a: the date's lock first, so the nightly job isn't making this day's sessions while it is closed.
        await holdSessionDay(tx, date)
        const ids = await lockDaySessions(tx, date)
        return ids.length > 0 ? tx.query<BlockState>(BLOCK_STATE_SQL, [ids]) : []
      },
      async change(tx, before) {
        const inTheWay = await dayInTheWay(tx, date)
        if (inTheWay.bookings > 0) throw sessionRefusal('CONFLICT', action, 'bookings_in_the_way', NEW.dayBookingsInTheWay(inTheWay.bookings), { conflictingBookings: inTheWay.list })
        // W51a (S1): a booking being moved off one of the day's sessions, its payment unfinished, would come back onto the block.
        if (inTheWay.movesOff > 0) throw sessionRefusal('CONFLICT', action, MOVE_IN_FLIGHT_REASON, NEW.dayMoveInFlight, { conflictingBookings: inTheWay.list })
        const open = before.filter((row) => row.status !== 'blocked').map((row) => row.id)
        const counts = { toBlock: open.length, alreadyBlocked: before.length - open.length }
        if (!sameCounts(seen, counts)) throw countsChanged(action, counts)
        const at = await lockedAt(tx)
        const written = open.length > 0 ? await tx.query<SessionRowRaw>(BLOCK_SESSIONS_SQL, [reasonText(reason), options.actor.id, open]) : []
        if (written.length !== open.length) throw new Error('The day was held but not every open session was blocked.')
        // W51a: the date is closed from now on (nothing is written when it already was: its first reason and who stay).
        const closedDateNow = (await tx.query(CLOSE_DATE_SQL, [date, reasonText(reason), options.actor.id])).length === 1
        const after = before.length > 0 ? await tx.query<BlockState>(BLOCK_STATE_SQL, [before.map((row) => row.id)]) : []
        return {
          after,
          answer: { blocked: true, conflict: false, conflictingBookings: [], blockedCount: written.length, alreadyBlocked: counts.alreadyBlocked, closedDate: closedDateNow },
          details: { date, sessionIds: open, blockedCount: written.length, alreadyBlocked: counts.alreadyBlocked, lockedAt: at, closedDate: closedDateNow },
        }
      },
    },
    options
  )
}

/**
 * GB7: each blocked session of a London day (`$1`), and how it came to be blocked: the kind of its latest
 * `session.blocked` audit row. `session_day`: a Block Day blocked it (the row is the day's, and names it);
 * `session`: it was blocked on its own; nothing: blocked before W51 wrote these rows, which counts as on its own.
 * A block never overwrites a block, so the latest row that names a blocked session is the one that blocked it.
 * W51a (W51 review L1): "latest" is by `lockedAt`, the clock each block read after it had the session's lock, so the
 * order is the order the blocks happened in. A row's own time (`at`) is its transaction's START: a block on its own
 * that started before a Block Day, waited, and took the lock after the day's block and an unblock has the EARLIER
 * `at`, and by `at` the session would read as day-blocked and Unblock Day would reopen it. A row with no `lockedAt`
 * (none is written without it) falls back to its own time in the same form.
 */
const DAY_BLOCKED_SESSIONS_SQL = `
SELECT s.id,
       (SELECT a.entity_type
          FROM audit_log a
         WHERE a.action = 'session.blocked'
           AND ((a.entity_type = 'session' AND a.entity_id = s.id::text)
             OR (a.entity_type = 'session_day' AND a.entity_id = $1::text AND a.details->'sessionIds' ? s.id::text))
         ORDER BY COALESCE(a.details->>'lockedAt', to_char(a.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')) DESC, a.id DESC
         LIMIT 1) AS blocked_as
  FROM sessions s
 WHERE ${withinLondonDaysSql('s.start_time', '$1', '$1')} AND s.status = 'blocked'
 ORDER BY s.id`

interface DayBlocks {
  /** The sessions a Block Day blocked: what Unblock Day reopens. */
  byDay: string[]
  /** The sessions blocked on their own: left blocked. */
  before: string[]
}
async function dayBlocks(db: Queryable, date: string): Promise<DayBlocks> {
  const rows = await db.query<{ id: string; blocked_as: string | null }>(DAY_BLOCKED_SESSIONS_SQL, [date])
  return { byDay: rows.filter((row) => row.blocked_as === 'session_day').map((row) => row.id), before: rows.filter((row) => row.blocked_as !== 'session_day').map((row) => row.id) }
}

/**
 * What Unblock Day would do (`GET sessions/days/:date/unblock/quote`): how many sessions a Block Day blocked (the
 * press reopens them) and how many were blocked on their own (they stay blocked: GB7). W51a: and whether the date
 * is closed (`closedDates`: 1 or 0), with its reason: the press removes the closed date too. Any active staff member
 * (the old count asked nobody who they were: GB14).
 */
export async function unblockDayQuote(db: Queryable, date: string, options: { actor: AdminActor }): Promise<UnblockDayQuoteRouteOutput> {
  requireAdminPermission(options.actor, 'staff', 'session.unblocked')
  const blocks = await dayBlocks(db, date)
  const closed = await closedDate(db, date)
  return { blockedSessions: blocks.byDay.length, blockedBefore: blocks.before.length, closedDates: closed ? 1 : 0, closedReason: closed?.reason ?? null }
}

/**
 * unblockDay (`POST sessions/days/:date/unblock`). Any active staff member. One transaction: the date's lock (W51a),
 * then the day's sessions locked in id order (W48 review L1); the figures the press sent (`seen`: how many it would
 * reopen, how many stay blocked, and whether a closed date goes) must be the figures now (Q18's rule); then the
 * sessions a Block Day blocked are reopened, and the ones blocked on their own are left blocked, with their reason
 * (GB7: the old function reopened every blocked session on the date); the closed date is removed (W51a: the nightly
 * job then makes the day's sessions on its next run, if it had passed the date while it was closed); and one
 * `session.unblocked` audit row for the day.
 */
export async function unblockDay(db: Db, date: string, seen: unknown, options: AdminWriteOptions): Promise<UnblockDayRouteOutput> {
  const action = 'session.unblocked'
  return adminWrite<BlockState[], BlockState[], UnblockDayRouteOutput>(
    db,
    {
      action,
      needs: 'staff',
      entity: { type: 'session_day', id: date },
      locks: [],
      unchangedSince: WRITES_ONLY_WHAT_WAS_PRESSED,
      async before(tx) {
        // W51a: the date's lock first, as Block Day and the nightly job take it.
        await holdSessionDay(tx, date)
        const ids = await lockDaySessions(tx, date)
        return ids.length > 0 ? tx.query<BlockState>(BLOCK_STATE_SQL, [ids]) : []
      },
      async change(tx, before) {
        const blocks = await dayBlocks(tx, date)
        const closed = await closedDate(tx, date)
        const counts = { blockedSessions: blocks.byDay.length, blockedBefore: blocks.before.length, closedDates: closed ? 1 : 0 }
        if (!sameCounts(seen, counts)) throw countsChanged(action, counts)
        const written = blocks.byDay.length > 0 ? await tx.query<SessionRowRaw>(UNBLOCK_SESSIONS_SQL, [blocks.byDay]) : []
        if (written.length !== blocks.byDay.length) throw new Error('The day was held but not every session was reopened.')
        // W51a: the closed date goes with the day's block.
        const reopened = closed ? await tx.query(REOPEN_DATE_SQL, [date]) : []
        if (closed && reopened.length !== 1) throw new Error('The date was held but its closed date was not removed.')
        const after = before.length > 0 ? await tx.query<BlockState>(BLOCK_STATE_SQL, [before.map((row) => row.id)]) : []
        return {
          after,
          answer: { confirmed: true, blockedSessions: counts.blockedSessions, blockedBefore: counts.blockedBefore, unblocked: written.length, closedDateRemoved: closed !== null },
          details: { date, sessionIds: blocks.byDay, unblocked: written.length, leftBlocked: counts.blockedBefore, closedDateRemoved: closed !== null, ...(closed ? { closedReason: closed.reason } : {}) },
        }
      },
    },
    options
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// A band set by hand, and back to automatic

const ACTIVE_BAND_SQL = 'SELECT id, code, name FROM session_bands WHERE id = $1::uuid AND active = true'

/**
 * W51a (W51 review L4): the band a press sets, read inside the press's transaction and held FOR SHARE to its end.
 * The quote's read above holds nothing, and W51's press checked the band before its transaction began: a band
 * switched off between that check and the write left sessions on a band that is off. FOR SHARE, not FOR KEY SHARE
 * (the review's suggestion): switching a band off is an UPDATE of `active`, which takes FOR NO KEY UPDATE, and KEY
 * SHARE lets that through. SHARE makes the two take turns: a switch-off in progress is waited for and then read
 * (the press is refused), and one that starts later waits for the press. It is a band's row ('admin_row',
 * LOCK_ORDER's first place), so it is taken before any session, the order a band-window save takes them in.
 */
const ACTIVE_BAND_HELD_SQL = 'SELECT id FROM session_bands WHERE id = $1::uuid AND active = true FOR SHARE'

/** The band a press names must exist and be on, in the old words. `held`: read FOR SHARE, inside a press's transaction. */
async function requireBand(db: Queryable, action: string, bandId: unknown, held = false): Promise<string> {
  const band = isUuid(bandId) ? (await db.query<{ id: string }>(held ? ACTIVE_BAND_HELD_SQL : ACTIVE_BAND_SQL, [bandId]))[0] : undefined
  if (!band) throw adminRefusal('NOT_FOUND', action, 'band_not_found', SESSION_ADMIN_WORDS.setSessionBand.thatBandNoLongerExists)
  return band.id
}

/** How many of the named sessions there are, and how many bookings on them aren't cancelled (they keep the price they were charged). */
const BAND_COUNTS_SQL = `
SELECT COUNT(DISTINCT s.id)::int AS sessions,
       COUNT(b.id) FILTER (WHERE b.id IS NOT NULL AND b.status != 'cancelled')::int AS bookings
  FROM sessions s
  LEFT JOIN bookings b ON b.session_id = s.id
 WHERE s.id = ANY($1::uuid[])`
async function bandCounts(db: Queryable, ids: readonly string[]): Promise<{ sessionsAffected: number; bookingsAffected: number }> {
  if (ids.length === 0) return { sessionsAffected: 0, bookingsAffected: 0 }
  const [row] = await db.query<{ sessions: number; bookings: number }>(BAND_COUNTS_SQL, [ids])
  return { sessionsAffected: row?.sessions ?? 0, bookingsAffected: row?.bookings ?? 0 }
}

const SET_BAND_SQL = 'UPDATE sessions s SET band_id = $1::uuid, band_overridden = true, updated_at = now() WHERE s.id = ANY($2::uuid[]) RETURNING s.id'

/** Which sessions a band press is for: one session, or every session on a London day. */
export type BandTarget = { sessionId: string } | { date: string }

/**
 * The count setSessionBand shows before its press (`GET sessions/:sessionId/band/quote`, `GET
 * sessions/days/:date/band/quote`): how many sessions would change and how many bookings on them aren't cancelled.
 * Manage pricing, and the band must exist and be on, both in the old words, as the old first call. A session that
 * isn't there counts as none.
 */
export async function sessionBandQuote(db: Queryable, target: BandTarget, bandId: unknown, options: { actor: AdminActor }): Promise<AdminSetSessionBandOutput> {
  const action = 'session.band_set'
  requireAdminPermission(options.actor, 'manage_pricing', action)
  await requireBand(db, action, bandId)
  const ids = 'date' in target ? (await db.query<{ id: string }>(DAY_SESSION_IDS_SQL, [target.date])).map((row) => row.id) : isUuid(target.sessionId) ? [target.sessionId] : []
  return { confirmed: false, ...(await bandCounts(db, ids)) }
}

/**
 * setSessionBand's press (`POST sessions/:sessionId/band`, `POST sessions/days/:date/band`): one session's band, or
 * every session's on a day (public and private), set by hand, so the day's windows no longer move it until it is
 * reset. Manage pricing. One transaction: the band read and held, which must exist and be on (W51a, W51 review L4:
 * it was checked before the transaction, unlocked); the sessions locked (a day's in id order: W48 review L1); one
 * session that isn't there is refused; the figures the press sent (`seen`) must be the figures now (Q18's rule), or
 * nothing is written and the refusal carries the new ones; the band set; and a `session.band_set` audit row.
 * Bookings already made keep the price they were charged.
 */
export async function setSessionBand(db: Db, target: BandTarget, bandId: unknown, seen: unknown, options: AdminWriteOptions): Promise<AdminSetSessionBandOutput> {
  const action = 'session.band_set'
  requireAdminPermission(options.actor, 'manage_pricing', action)
  const day = 'date' in target
  let band = ''
  return adminWrite<BandState[], BandState[], AdminSetSessionBandOutput>(
    db,
    {
      action,
      needs: 'manage_pricing',
      entity: day ? { type: 'session_day', id: target.date } : { type: 'session', id: target.sessionId },
      locks: [],
      unchangedSince: WRITES_ONLY_WHAT_WAS_PRESSED,
      async before(tx) {
        band = await requireBand(tx, action, bandId, true)
        const ids = day ? await lockDaySessions(tx, target.date) : (await lockSession(tx, target.sessionId)) ? [target.sessionId] : []
        if (!day && ids.length === 0) throw sessionGone(action)
        return ids.length > 0 ? tx.query<BandState>(BAND_STATE_SQL, [ids]) : []
      },
      async change(tx, before) {
        const ids = before.map((row) => row.id)
        const counts = await bandCounts(tx, ids)
        if (!sameCounts(seen, counts)) throw countsChanged(action, counts)
        const written = ids.length > 0 ? await tx.query<{ id: string }>(SET_BAND_SQL, [band, ids]) : []
        const after = ids.length > 0 ? await tx.query<BandState>(BAND_STATE_SQL, [ids]) : []
        return { after, answer: { confirmed: true, sessionsAffected: written.length, bookingsAffected: counts.bookingsAffected }, details: { bandId: band, ...counts } }
      },
    },
    options
  )
}

const RESET_BAND_SQL = `
UPDATE sessions s
   SET band_id = band_for_session_start(s.start_time), band_overridden = false, updated_at = now()
 WHERE s.id = $1::uuid
 RETURNING s.id, s.band_id, s.band_overridden`
const BAND_NAME_SQL = 'SELECT code, name FROM session_bands WHERE id = $1::uuid'

/**
 * resetSessionBand (`POST sessions/:sessionId/band/reset`): a band set by hand goes back to the day's windows for
 * the session's time. Manage pricing. One transaction: the band guard shared, before the session (W51-1: a
 * band-window save in progress is waited for, so the band given is the one its windows leave); the session's lock; a
 * session that isn't there, or whose band wasn't set by hand, is refused with the old reason; the band worked out by
 * the database's own rule; and a `session.band_reset` audit row. Answers the band (none when no window covers the time).
 */
export async function resetSessionBand(db: Db, sessionId: string, options: AdminWriteOptions): Promise<SessionBandResetRouteOutput> {
  const action = 'session.band_reset'
  return adminWrite<BandState, BandState, SessionBandResetRouteOutput>(
    db,
    {
      action,
      needs: 'manage_pricing',
      entity: { type: 'session', id: sessionId },
      locks: [],
      unchangedSince: WRITES_ONLY_WHAT_WAS_PRESSED,
      async before(tx) {
        await holdBandGuardShared(tx)
        const [row] = (await lockSession(tx, sessionId)) ? await tx.query<BandState>(BAND_STATE_SQL, [[sessionId]]) : []
        if (!row) throw sessionGone(action)
        return row
      },
      async change(tx, before) {
        if (!before.band_overridden) throw adminRefusal('CONFLICT', action, 'not_overridden', NEW.notOverridden)
        const [written] = await tx.query<BandState>(RESET_BAND_SQL, [sessionId])
        if (!written) throw new Error('The session was held but its band was not reset.')
        const [band] = written.band_id ? await tx.query<{ code: string; name: string }>(BAND_NAME_SQL, [written.band_id]) : []
        return { after: written, answer: { reset: true, band: band ? { code: band.code, name: band.name } : null } }
      },
    },
    options
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// A start time moved, and a one-off session

const SLOT_TAKEN = 'sessions_service_type_start_time_key'
/** Whether a statement was refused because the service type already has a session at that time. */
const slotTaken = (err: unknown): boolean => {
  const refused = postgresRefusal(err)
  return refused?.code === '23505' && refused.constraint === SLOT_TAKEN
}

interface StartTimeState {
  id: string
  service_type_id: string
  start_time: string
  end_time: string
  band_id: string | null
  band_overridden: boolean
  duration: number | null
}
const START_TIME_STATE_SQL = `
SELECT s.id, s.service_type_id, s.start_time, s.end_time, s.band_id, s.band_overridden, st.duration
  FROM sessions s
  JOIN service_types st ON st.id = s.service_type_id
 WHERE s.id = $1::uuid`
/** GB6: every booking on the session that isn't cancelled. */
const LIVE_BOOKINGS_SQL = "SELECT COUNT(*)::int AS n FROM bookings WHERE session_id = $1::uuid AND status <> 'cancelled'"
const OTHER_SESSION_AT_SQL = 'SELECT 1 AS taken FROM sessions WHERE service_type_id = $1::uuid AND start_time = $2::timestamptz AND id <> $3::uuid'
const SET_START_TIME_SQL = `
UPDATE sessions s
   SET start_time = $1::timestamptz, end_time = $1::timestamptz + ($2::int * interval '1 minute'), updated_at = now()
 WHERE s.id = $3::uuid
 RETURNING s.id, s.start_time, s.end_time, s.band_id, s.band_overridden`
const SESSION_BAND_SQL = `
SELECT sb.code, sb.name, s.band_overridden
  FROM sessions s
  LEFT JOIN session_bands sb ON sb.id = s.band_id
 WHERE s.id = $1::uuid`

/**
 * setSessionStartTime (`POST sessions/:sessionId/start-time`): one session's start moved, once (the weekly slot is
 * untouched); its end follows its service type's length, and its band follows the new time unless it was set by
 * hand. Any active staff member. A start that isn't a real date and time in the dialog's form is refused in the old
 * words. One transaction: the band guard shared, before the session (W51-1: the band given is by the windows a save
 * in progress leaves); the session's lock, which a new order, a Move and Add Guest take before they write a booking;
 * a session that isn't there is refused; ANY booking on it that isn't cancelled refuses the change (GB6: the old
 * function counted pending and confirmed only, so a session with a Payment needed booking could be moved into Peak,
 * the booking with it); another session of the same service type already at that time refuses it; then the times,
 * and a `session.start_time_set` audit row. W51a: also refused while a booking is being moved off the session and
 * its payment isn't finished (S1: the Move's undo would put it back with its old times), and when the new time is
 * on a closed date and the session isn't on that date already (the new date's lock is held, after the guard).
 */
export async function setSessionStartTime(db: Db, sessionId: string, startTime: unknown, options: AdminWriteOptions): Promise<SessionStartTimeRouteOutput> {
  const action = 'session.start_time_set'
  const words = SESSION_ADMIN_DIALOG_WORDS.EditSessionStartTimeDialog
  requireAdminPermission(options.actor, 'staff', action)
  if (!isValidIsoDateTime(startTime)) throw adminRefusal('VALIDATION', action, 'invalid_start_time', SESSION_ADMIN_WORDS.setSessionStartTime.enterValidDateAndTime, { field: 'startTime' })
  const taken = (): ApiError => adminRefusal('CONFLICT', action, 'slot_already_exists', words.slot_already_exists)
  const newDay = dayOf(startTime)
  try {
    return await adminWrite<StartTimeState, Omit<StartTimeState, 'duration' | 'service_type_id'>, SessionStartTimeRouteOutput>(
      db,
      {
        action,
        needs: 'staff',
        entity: { type: 'session', id: sessionId },
        locks: [],
        unchangedSince: WRITES_ONLY_WHAT_WAS_PRESSED,
        async before(tx) {
          await holdBandGuardShared(tx)
          // W51a: the new date's lock, after the guard and before the session (admin/locks.ts, holdSessionDay).
          await holdSessionDay(tx, newDay)
          const [row] = (await lockSession(tx, sessionId)) ? await tx.query<Omit<StartTimeState, 'start_time' | 'end_time'> & { start_time: unknown; end_time: unknown }>(START_TIME_STATE_SQL, [sessionId]) : []
          if (!row) throw adminRefusal('NOT_FOUND', action, 'session_not_found', words.session_not_found)
          return { ...row, start_time: iso(row.start_time), end_time: iso(row.end_time) }
        },
        async change(tx, before) {
          const [bookings] = await tx.query<{ n: number }>(LIVE_BOOKINGS_SQL, [sessionId])
          if ((bookings?.n ?? 0) > 0) throw adminRefusal('CONFLICT', action, 'session_has_bookings', words.session_has_bookings)
          // W51a (S1): a booking being moved off this session, its payment unfinished, would come back with its old times.
          if ((await tx.query(SESSION_MOVES_OFF_SQL, [sessionId])).length > 0) throw adminRefusal('CONFLICT', action, MOVE_IN_FLIGHT_REASON, NEW.moveInFlight)
          // W51a: a session isn't moved onto a closed date from another date (one already on it may change its time).
          if (dayOf(before.start_time) !== newDay && (await closedDate(tx, newDay))) throw dateClosed(action, NEW.dateClosedForMove)
          if (before.duration === null || before.duration === undefined) throw adminRefusal('CONFLICT', action, 'service_type_incomplete', NEW.noLength)
          if ((await tx.query(OTHER_SESSION_AT_SQL, [before.service_type_id, startTime, sessionId])).length > 0) throw taken()
          const [written] = await tx.query<{ id: string; start_time: unknown; end_time: unknown; band_id: string | null; band_overridden: boolean }>(SET_START_TIME_SQL, [startTime, before.duration, sessionId])
          if (!written) throw new Error('The session was held but its start time was not changed.')
          const [band] = await tx.query<{ code: string | null; name: string | null; band_overridden: boolean | null }>(SESSION_BAND_SQL, [sessionId])
          const session = { id: written.id, start_time: iso(written.start_time), end_time: iso(written.end_time) }
          return {
            after: { ...session, band_id: written.band_id, band_overridden: written.band_overridden },
            answer: { updated: true, session, band: band?.code ? { code: band.code, name: band.name ?? band.code, overridden: band.band_overridden === true } : null },
          }
        },
      },
      options
    )
  } catch (err) {
    // A session made at that time while this press ran (a one-off, the nightly job): the constraint's own refusal.
    if (slotTaken(err)) throw taken()
    throw err
  }
}

const SERVICE_TYPE_SQL = 'SELECT id, duration, capacity, booking_type, active FROM service_types WHERE id = $1::uuid'
/** The band the database's own trigger gives a session at `$1` (sessions_assign_band), and its price. */
const ONE_OFF_BAND_SQL = 'SELECT b.id, b.code, b.name, b.price::text AS price FROM session_bands b WHERE b.id = band_for_session_start($1::timestamptz)'
/** A private type's size groups at a band: what the checkout prices a private session from (orders/load-basket.ts, `private_tier`). */
const ONE_OFF_SIZE_GROUPS_SQL = `
SELECT t.min_people, t.max_people, t.price::text AS price
  FROM service_type_price_tiers t
 WHERE t.service_type_id = $1::uuid AND t.band_id = $2::uuid
 ORDER BY t.min_people, t.max_people, t.id`
const SESSION_AT_SQL = 'SELECT 1 AS taken FROM sessions WHERE service_type_id = $1::uuid AND start_time = $2::timestamptz'
/** W68a: whether any session on a London day had its band set by hand. */
const DAY_SET_BY_HAND_SQL = `SELECT EXISTS (SELECT 1 FROM sessions s WHERE ${withinLondonDaysSql('s.start_time', '$1', '$1')} AND s.band_overridden) AS there`
const INSERT_SESSION_SQL = `
INSERT INTO sessions (service_type_id, start_time, end_time, type, capacity, status)
VALUES ($1::uuid, $2::timestamptz, $2::timestamptz + ($3::int * interval '1 minute'), $4, $5, 'open')
RETURNING id, service_type_id, start_time, end_time, capacity, type, band_id`

interface OneOffSession {
  serviceType: { id: string; duration: number; capacity: number; bookingType: 'public' | 'private' }
  startTime: string
  /** What the dialog shows, with its stamp (the quote adds its note, `othersSetByHand`). */
  quote: Omit<OneOffSessionQuoteRouteOutput, 'othersSetByHand'>
}

/**
 * W68 (Wayne's Q58): a one-off session as it would be made now: the old refusals in the old order, then the band its time
 * has by the day's windows and what it would sell at. The quote and the press both come through here, so the dialog can't
 * be shown one thing and the session made as another. The stamp is the whole of what is here, as text, with the service
 * type and the time it is for: a band, a price or a size group that differs is a different stamp.
 */
async function oneOffSession(db: Queryable, serviceTypeId: unknown, startTime: unknown): Promise<OneOffSession> {
  const action = 'session.created'
  const words = SESSION_ADMIN_DIALOG_WORDS.CreateOneOffSessionDialog
  const [serviceType] = isUuid(serviceTypeId)
    ? await db.query<{ id: string; duration: number | null; capacity: number | null; booking_type: string | null; active: boolean | null }>(SERVICE_TYPE_SQL, [serviceTypeId])
    : []
  if (!serviceType || !serviceType.active) throw adminRefusal('NOT_FOUND', action, 'service_type_not_found', words.service_type_not_found)
  if (!serviceType.duration || serviceType.duration <= 0 || !serviceType.capacity || !serviceType.booking_type) throw adminRefusal('CONFLICT', action, 'service_type_incomplete', words.service_type_incomplete)
  if (!isValidIsoDateTime(startTime)) throw adminRefusal('VALIDATION', action, 'invalid_start_time', SESSION_ADMIN_WORDS.setSessionStartTime.enterValidDateAndTime, { field: 'startTime' })
  // W51a: no session is added to a closed date (Unblock Day reopens the date first).
  if (await closedDate(db, dayOf(startTime))) throw dateClosed(action, NEW.dateClosed)
  if ((await db.query(SESSION_AT_SQL, [serviceType.id, startTime])).length > 0) throw adminRefusal('CONFLICT', action, 'slot_already_exists', words.slot_already_exists)
  const type = serviceType.booking_type === 'private' ? ('private' as const) : ('public' as const)
  const [band] = await db.query<{ id: string; code: string; name: string; price: string | null }>(ONE_OFF_BAND_SQL, [startTime])
  const groups = band && type === 'private' ? await db.query<{ min_people: number; max_people: number; price: string | null }>(ONE_OFF_SIZE_GROUPS_SQL, [serviceType.id, band.id]) : []
  const price = band && type === 'public' ? band.price : null
  return {
    serviceType: { id: serviceType.id, duration: serviceType.duration, capacity: serviceType.capacity, bookingType: type },
    startTime,
    quote: {
      type,
      band: band ? { code: band.code, name: band.name } : null,
      pricePerPerson: price === null ? null : Number(price),
      sizeGroups: groups.map((group) => ({ minPeople: group.min_people, maxPeople: group.max_people, price: group.price === null ? null : Number(group.price) })),
      stamp: ['one-off', serviceType.id, startTime, type, band?.id ?? 'no band', band?.name ?? '', price ?? 'no price', ...groups.map((group) => `${group.min_people}-${group.max_people}:${group.price ?? 'no price'}`)].join('|'),
    },
  }
}

/**
 * W68 (Wayne's Q58; H12): the band and price a one-off session would get (`GET sessions/one-off/quote`), shown in the dialog
 * before the press. Any active staff member, as the press. Refused as the press would be (the service type, the time, a
 * closed date, a session already there). Changes nothing. W68a (the H-plan's Q58 wording): it also says whether other
 * sessions that day had their band set by hand, so staff know this one won't be in it. A note on the day, not what the
 * session would be, so the press doesn't read it and the stamp leaves it out.
 */
export async function oneOffSessionQuote(db: Queryable, serviceTypeId: unknown, startTime: unknown, options: { actor: AdminActor }): Promise<OneOffSessionQuoteRouteOutput> {
  requireAdminPermission(options.actor, 'staff', 'session.created')
  const shown = await oneOffSession(db, serviceTypeId, startTime)
  const [day] = await db.query<{ there: boolean }>(DAY_SET_BY_HAND_SQL, [dayOf(shown.startTime)])
  return { ...shown.quote, othersSetByHand: day?.there === true }
}

/**
 * createOneOffSession (`POST sessions`): exactly one session for a service type at a time staff choose (a bespoke
 * or far-ahead booking), outside the weekly timetable. Any active staff member. The old refusals, with the old
 * reasons: a service type that isn't there or is off; one with no duration, capacity or booking type; a session of
 * it already at that exact time. A start that isn't a real date and time is refused as a start-time change refuses
 * it (G-plan 4.5: the old function showed the database's own error). One transaction: the band guard shared (W51-1:
 * the new session's band is by the windows a save in progress leaves); the session inserted, its band given by the
 * database's own trigger; and a `session.created` audit row. However far ahead it is, the nightly job is not held up
 * by it any more (GB3: migration 032). W51a: a session on a closed date is refused (`date_closed`), read under the
 * date's lock, which Block Day and the nightly job take too.
 *
 * W68 (Wayne's Q58): `stamp` is the one the quote gave with the band and price the dialog showed. Read again under the band
 * guard, after the old refusals: a press with no stamp, or whose band, price or size groups are no longer what was shown,
 * is refused `changed_since` (W54a's rule) and nothing is made.
 */
export async function createOneOffSession(db: Db, serviceTypeId: unknown, startTime: unknown, stamp: unknown, options: AdminWriteOptions): Promise<OneOffSessionRouteOutput> {
  const action = 'session.created'
  const words = SESSION_ADMIN_DIALOG_WORDS.CreateOneOffSessionDialog
  requireAdminPermission(options.actor, 'staff', action)
  const taken = (): ApiError => adminRefusal('CONFLICT', action, 'slot_already_exists', words.slot_already_exists)
  let made: OneOffSession | null = null
  try {
    return await adminWrite<null, OneOffSessionRouteOutput['session'] & { band_id: string | null }, OneOffSessionRouteOutput>(
      db,
      {
        action,
        needs: 'staff',
        entity: { type: 'session', id: 'new' },
        locks: [],
        unchangedSince: { seen: stamp, now: async () => made?.quote.stamp ?? '' },
        async before(tx) {
          await holdBandGuardShared(tx)
          // W51a: the date's lock, after the guard: Block Day and the nightly job take it too, so the date isn't
          // closed while this session is being made on it. A start that isn't a date and time is refused just below.
          if (isValidIsoDateTime(startTime)) await holdSessionDay(tx, dayOf(startTime))
          made = await oneOffSession(tx, serviceTypeId, startTime)
          return null
        },
        async change(tx) {
          if (!made) throw new Error('The one-off session was not read.')
          const { serviceType } = made
          const [written] = await tx.query<{ id: string; service_type_id: string; start_time: unknown; end_time: unknown; capacity: number; type: string; band_id: string | null }>(INSERT_SESSION_SQL, [
            serviceType.id,
            made.startTime,
            serviceType.duration,
            serviceType.bookingType,
            serviceType.capacity,
          ])
          if (!written) throw new Error('The session was not written.')
          const session = { id: written.id, service_type_id: written.service_type_id, start_time: iso(written.start_time), end_time: iso(written.end_time), capacity: written.capacity, type: written.type }
          return { after: { ...session, band_id: written.band_id }, answer: { created: true, session }, entityId: session.id }
        },
      },
      options
    )
  } catch (err) {
    if (slotTaken(err)) throw taken()
    throw err
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The weekly timetable

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const
const SLOT_COLUMNS_SQL = 'id, service_type_id, day_of_week, start_time::text AS start_time, created_at, updated_at'
const SLOT_AT_SQL = 'SELECT 1 AS there FROM service_type_schedule_slots WHERE service_type_id = $1::uuid AND day_of_week = $2 AND start_time = $3::time'
const INSERT_SLOT_SQL = `INSERT INTO service_type_schedule_slots (service_type_id, day_of_week, start_time) VALUES ($1::uuid, $2, $3::time) RETURNING ${SLOT_COLUMNS_SQL}`
const SLOT_SQL = `SELECT ${SLOT_COLUMNS_SQL} FROM service_type_schedule_slots WHERE id = $1::uuid`
const DELETE_SLOT_SQL = 'DELETE FROM service_type_schedule_slots WHERE id = $1::uuid RETURNING id'
const SLOT_TAKEN_KEY = 'service_type_schedule_slots_service_type_id_day_of_week_sta_key'

type SlotRowRaw = Omit<ScheduleSlotRow, 'created_at' | 'updated_at'> & { created_at: unknown; updated_at: unknown }
const slotRow = (row: SlotRowRaw): ScheduleSlotRow => ({ ...row, created_at: iso(row.created_at), updated_at: iso(row.updated_at) })

/**
 * addServiceTypeScheduleSlot (`POST catalog/service-types/:serviceTypeId/schedule-slots`): one weekly slot (a
 * weekday and a time) for a service type. Manage pricing (Wayne's Q50 part 2: before, any staff member, and a
 * sign-in with no staff row was let through). The old checks, in the old words and order. Under the service type's
 * lock, so two adds of one slot take turns: a service type that isn't there is refused in plain words (the old
 * function showed the database's foreign key error); a slot already there is refused in the old words; the slot;
 * and a `timetable.slot_added` audit row. Wayne's Q50 part 1: it reaches only the dates the nightly job makes from
 * now on. No session is made here, and none already on the calendar is touched.
 */
export async function addScheduleSlot(db: Db, serviceTypeId: string, dayOfWeek: unknown, startTime: unknown, options: AdminWriteOptions): Promise<ScheduleSlotRow> {
  const action = 'timetable.slot_added'
  const words = SESSION_ADMIN_WORDS.addServiceTypeScheduleSlot
  requireAdminPermission(options.actor, 'manage_pricing', action)
  if (!serviceTypeId) throw adminRefusal('VALIDATION', action, 'service_type_required', words.servicetypeidRequired, { field: 'serviceTypeId' })
  if (typeof dayOfWeek !== 'number' || !Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) throw adminRefusal('VALIDATION', action, 'invalid_day', words.dayofweekMustInteger060(dayOfWeek), { field: 'dayOfWeek' })
  if (typeof startTime !== 'string' || !/^\d{2}:\d{2}(:\d{2})?$/.test(startTime)) throw adminRefusal('VALIDATION', action, 'invalid_time', words.starttimeMustInHhMmOr, { field: 'startTime' })
  const day = dayOfWeek
  const time = startTime
  const there = (): ApiError => adminRefusal('CONFLICT', action, 'slot_already_exists', words.serviceTypeAlreadyHasSlotOn(DAY_NAMES[day], time))
  try {
    return await adminWrite<null, ScheduleSlotRow, ScheduleSlotRow>(
      db,
      {
        action,
        needs: 'manage_pricing',
        entity: { type: 'schedule_slot', id: 'new' },
        locks: [{ table: 'service_types', ids: [serviceTypeId] }],
        unchangedSince: WRITES_ONLY_WHAT_WAS_PRESSED,
        async before(_tx, held) {
          if (!held.service_types?.length) throw adminRefusal('NOT_FOUND', action, 'service_type_not_found', NEW.serviceTypeGone)
          return null
        },
        async change(tx) {
          if ((await tx.query(SLOT_AT_SQL, [serviceTypeId, day, time])).length > 0) throw there()
          const [written] = await tx.query<SlotRowRaw>(INSERT_SLOT_SQL, [serviceTypeId, day, time])
          if (!written) throw new Error('The weekly slot was not written.')
          const slot = slotRow(written)
          return { after: slot, answer: slot, entityId: slot.id }
        },
      },
      options
    )
  } catch (err) {
    const refused = postgresRefusal(err)
    if (refused?.code === '23505' && refused.constraint === SLOT_TAKEN_KEY) throw there()
    throw err
  }
}

/**
 * deleteServiceTypeScheduleSlot (`POST catalog/schedule-slots/:slotId/remove`): one weekly slot removed. Manage
 * pricing (Wayne's Q50 part 2). Under the slot's lock: a slot that isn't there is refused (the staff app's function
 * answers `deleted: false`, as before); the slot deleted; and a `timetable.slot_removed` audit row that keeps the
 * slot as it was. Wayne's Q50 part 1: sessions already on the calendar stay, and stay bookable; the nightly job
 * simply makes no more of them.
 */
export async function removeScheduleSlot(db: Db, slotId: string, options: AdminWriteOptions): Promise<AdminDeleteServiceTypeScheduleSlotOutput> {
  const action: AdminAction = 'timetable.slot_removed'
  requireAdminPermission(options.actor, 'manage_pricing', action)
  if (!slotId) throw adminRefusal('VALIDATION', action, 'slot_required', SESSION_ADMIN_WORDS.deleteServiceTypeScheduleSlot.slotidRequired, { field: 'slotId' })
  return adminWrite<ScheduleSlotRow, null, AdminDeleteServiceTypeScheduleSlotOutput>(
    db,
    {
      action,
      needs: 'manage_pricing',
      entity: { type: 'schedule_slot', id: slotId },
      locks: [{ table: 'service_type_schedule_slots', ids: [slotId] }],
      unchangedSince: WRITES_ONLY_WHAT_WAS_PRESSED,
      async before(tx, held) {
        const [row] = held.service_type_schedule_slots?.length ? await tx.query<SlotRowRaw>(SLOT_SQL, [slotId]) : []
        if (!row) throw adminRefusal('NOT_FOUND', action, 'slot_not_found', NEW.slotGone)
        return slotRow(row)
      },
      async change(tx) {
        const deleted = await tx.query<{ id: string }>(DELETE_SLOT_SQL, [slotId])
        if (deleted.length !== 1) throw new Error('The weekly slot was held but not removed.')
        return { after: null, answer: { deleted: true } }
      },
    },
    options
  )
}
