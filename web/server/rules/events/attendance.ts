// W52 (G-plan 1.5, 1.12, 4.1, 4.3, 4.8; bug GB14; W35 audit rows 15 and 18 and F1; W48 review L2 and L5; W48 report
// "For the Worker step" 5): the event attendee list, Overview's today's events, and the event day's three flags on
// the Worker. Ported from the staff app's getEventAttendees.ts, getTodaysEvents.ts, setEventAttendeeCheckIn.ts,
// setEventAttendeesCheckIn.ts and setEventAttendeeWaiver.ts with shared/eventAttendance.ts, shared/eventCheckIn.ts
// and shared/eventAttendeeList.ts (frozen at W48 in testing/legacy-admin), with their words
// (./admin-failure-messages.ts).
//
// The two reads
//  - GB14: an active staff member, through the admin read helper (the old reads checked nobody). Named columns.
//  - The attendee list keeps every booking, confirmed and cancelled, with the money still to refund on its order (F1:
//    the screen now shows a cancelled booking that still has money owed) and whether a refund of the booking's own
//    money is still being checked (`refund_open`, row 18: a cancelled place's shortfall is then worded as it stands
//    now; W52a: the booking's own claim, or a Refund the rest on its order, not any claim that holds the order).
//  - "Today's events" picks its events by the London day their stored digits show (time/london-day-sql.ts; W48 review
//    L5): `starts_at` holds London wall-clock digits labelled UTC, as a session's times do. London's today comes from
//    the database's clock read in London's zone, as the old read took it. Neither depends on the connection's zone.
//
// The three flags (G-plan 4.2, level C): one guarded statement and an audit row in one transaction, under the call's
// own key. Any active staff member. Nothing said who before.
//  - W35 audit row 15: each flag first holds its attendee's EVENT, LOCK_ORDER's 'event', FOR SHARE, in a statement of
//    its own (W48 review L2: the guards read the event and the event booking, which are other tables' rows). A place
//    cancel, the whole event's cancel, a sale of places and an edit of the event's details all hold the same row FOR
//    NO KEY UPDATE, so each takes turns with a flag: a check-in pressed while a cancel is in progress waits for it and
//    is decided on what it committed; a cancel that starts during a check-in waits and reads the place as checked in.
//    Shared, so two flags on one event never wait for each other. The event is the flag's first lock, and its only
//    one besides the attendee rows it updates, which every other holder of the event takes after the event too.
//  - Check-in, one attendee or many: the old statement, which decides each attendee for itself. Those that pass are
//    checked in even when others in the same press are refused; each refusal is answered as data, in the old words.
//    The attendees' rows are locked in id order first (W48 review L1), so two presses naming the same attendees
//    queue. An attendee already checked in keeps their first time, as a booking does (W50).
//  - Undo (W48 report "For the Worker step" 5): the same guards as check-in, less the window and the waivers: the
//    place isn't cancelled and its booking is confirmed. The old undo checked only the place. It is allowed on a
//    cancelled event: the whole-event cancel refuses a booking with a checked-in place until its check-in is undone.
//  - Waivers: the standard, the extra, or both to sign; one to revoke. The methods come from waivers/methods.ts. The
//    extra waiver is signed against the event's current version, and a signature on an older version is not
//    "signed": it reads `older_version`, counts as outstanding and refuses a check-in. A waiver already signed (the
//    extra one at the current version) keeps how and when it was signed.
//  - The customer channel (G-plan 4.8; lead call L13: the rule only, no route): the website's signed-in customer may
//    sign, by `email_link`, the waivers of an attendee on one of their OWN event bookings, until the event has ended;
//    never revoke. On that channel the hold names the customer, so someone else's event is never locked, and (W52a)
//    someone else's attendee is answered exactly as one that isn't there (`attendee_not_found`). Each flag says
//    which channels it accepts (W50a): only a waiver accepts a customer.
//  - W54a's stale-page rule doesn't apply: a flag writes only what was pressed.
import 'server-only'
import type { AdminAction, AdminGetTodaysEventsOutput, EventAttendeeState, EventAttendeesRouteOutput, EventCheckInRouteOutput } from '@/contracts'
import type { Db, Queryable, SqlParam } from '@/server/db'
import type { ApiError } from '@/server/http/errors'
import { flagWrite, flagWriteMany } from '@/server/rules/admin/flag'
import { isUuid } from '@/server/rules/admin/locks'
import { adminRead } from '@/server/rules/admin/read'
import { adminRefusal, type AdminActor } from '@/server/rules/admin/refusal'
import { LONDON_NOW_SQL, withinLondonDaysSql } from '@/server/rules/time/london-day-sql'
import { DEFAULT_WAIVER_VERSION, isWaiverMethodFor } from '@/server/rules/waivers/methods'
import { EVENT_ADMIN_NEW_WORDS, EVENT_ADMIN_WORDS } from './admin-failure-messages'
import { EXTRA_WAIVER_STATE_SQL, loadEventAttendeeBookings } from './attendee-list'
import { ENDED_SQL } from './cancel-event'

// ---------------------------------------------------------------------------------------------------------------------
// What the reads and the flags share (aliases `ea` event_attendees, `eb` event_bookings, `e` events)

/**
 * The attendee's extra waiver is outstanding: the event has one and it isn't signed, or it was signed on an older
 * version of the text (a changed text needs signing again). Exported for its test.
 */
export const EXTRA_WAIVER_OUTSTANDING_SQL = `(e.has_extra_waiver AND (NOT ea.event_waiver_accepted
    OR ea.event_waiver_version IS DISTINCT FROM e.extra_waiver_version))`

/**
 * The check-in window: open from the start of the event's London date until the end of that date, or until `ends_at`
 * when that is later; `not_open` before, `closed` after. An undated event is never open. The stored times are London
 * wall-clock digits labelled UTC, so they are read as UTC and compared with London's wall clock now.
 */
export const CHECK_IN_WINDOW_SQL = `CASE
    WHEN e.starts_at IS NULL
      OR ${LONDON_NOW_SQL} < (e.starts_at AT TIME ZONE 'UTC')::date::timestamp THEN 'not_open'
    WHEN ${LONDON_NOW_SQL} >= GREATEST(
           ((e.starts_at AT TIME ZONE 'UTC')::date + 1)::timestamp,
           e.ends_at AT TIME ZONE 'UTC') THEN 'closed'
    ELSE 'open'
  END`

/** One attendee's waivers and check-in as they are (EventAttendeeState), for the flags' RETURNING lists. */
const ATTENDEE_STATE_COLUMNS_SQL = `ea.id, ea.waiver_accepted, ea.waiver_method, ea.waiver_accepted_at,
    ${EXTRA_WAIVER_STATE_SQL} AS extra_waiver_state, ea.event_waiver_method, ea.event_waiver_accepted_at,
    ea.checked_in_at`
/** …and what only the audit row keeps: the versions signed. */
const ATTENDEE_RECORDED_COLUMNS_SQL = `${ATTENDEE_STATE_COLUMNS_SQL}, ea.waiver_version, ea.event_waiver_version`

const iso = (value: unknown): string | null => (value === null || value === undefined ? null : value instanceof Date ? value.toISOString() : String(value))

type StateRow = Record<keyof EventAttendeeState, unknown>
type RecordedRow = StateRow & { waiver_version: unknown; event_waiver_version: unknown }

const stateOf = (row: StateRow): EventAttendeeState => ({
  id: String(row.id),
  waiver_accepted: row.waiver_accepted === true,
  waiver_method: (row.waiver_method ?? null) as EventAttendeeState['waiver_method'],
  waiver_accepted_at: iso(row.waiver_accepted_at),
  extra_waiver_state: row.extra_waiver_state as EventAttendeeState['extra_waiver_state'],
  event_waiver_method: (row.event_waiver_method ?? null) as EventAttendeeState['event_waiver_method'],
  event_waiver_accepted_at: iso(row.event_waiver_accepted_at),
  checked_in_at: iso(row.checked_in_at),
})

/** What an audit row keeps of an attendee: the flags as set, how and against which version. Never a name, an email or a date of birth. */
const recordedOf = (row: RecordedRow): Readonly<Record<string, unknown>> => {
  const state = stateOf(row)
  return {
    waiver_accepted: state.waiver_accepted,
    waiver_method: state.waiver_method,
    waiver_accepted_at: state.waiver_accepted_at,
    extra_waiver_state: state.extra_waiver_state,
    event_waiver_method: state.event_waiver_method,
    event_waiver_accepted_at: state.event_waiver_accepted_at,
    checked_in_at: state.checked_in_at,
    waiver_version: row.waiver_version ?? null,
    event_waiver_version: row.event_waiver_version ?? null,
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The attendee list

const EVENT_OF_LIST_SQL = `
SELECT e.id, e.name, e.starts_at, e.ends_at, e.capacity, e.places_booked, e.has_extra_waiver, e.refund_cutoff_at,
       e.cancelled_at, e.cancel_reason, ${CHECK_IN_WINDOW_SQL} AS check_in_window
  FROM events e
 WHERE e.id = $1::uuid`

type ListEvent = NonNullable<EventAttendeesRouteOutput['event']>

/**
 * getEventAttendees (`GET events/:eventId/attendees`): the event, whether check-in is open, and every booking with
 * its places: confirmed and cancelled, in booking order (cancelled places and bookings are there for history, and
 * for money still owed on them). An id that names no event answers `event: null`, as before. Any active staff member.
 */
export async function getEventAttendees(db: Queryable, eventId: string, actor: AdminActor): Promise<EventAttendeesRouteOutput> {
  // An id that isn't one names no event: the same answer, without asking the database to cast it.
  const [row] = await adminRead<ListEvent & { check_in_window: EventAttendeesRouteOutput['checkInWindow'] }>(
    db,
    { name: 'events.attendees', needs: 'staff', sql: EVENT_OF_LIST_SQL, params: [isUuid(eventId) ? eventId : null], times: ['starts_at', 'ends_at', 'refund_cutoff_at', 'cancelled_at'] },
    { actor }
  )
  if (!row) return { event: null, checkInWindow: 'not_open', bookings: [] }
  const { check_in_window, ...event } = row
  return { event, checkInWindow: check_in_window, bookings: await loadEventAttendeeBookings(db, eventId) }
}

// ---------------------------------------------------------------------------------------------------------------------
// Today's events

/** On London's today, by the London day the event's stored digits show, and not cancelled. */
const TODAY_SQL = `${withinLondonDaysSql('e.starts_at', LONDON_NOW_SQL, LONDON_NOW_SQL)} AND e.cancelled_at IS NULL`

const TODAYS_EVENTS_SQL = `
SELECT e.id, e.name, e.starts_at, e.ends_at, e.capacity, e.places_booked, e.has_extra_waiver,
       count(ea.id)::int AS attendee_count,
       count(ea.checked_in_at)::int AS checked_in_count,
       (count(ea.id) FILTER (WHERE NOT ea.waiver_accepted))::int AS standard_waivers_outstanding,
       (count(ea.id) FILTER (WHERE ${EXTRA_WAIVER_OUTSTANDING_SQL}))::int AS extra_waivers_outstanding
  FROM events e
  LEFT JOIN event_bookings eb ON eb.event_id = e.id AND eb.status = 'confirmed'
  LEFT JOIN event_attendees ea ON ea.event_booking_id = eb.id AND ea.cancelled_at IS NULL
 WHERE ${TODAY_SQL}
 GROUP BY e.id
 ORDER BY e.starts_at, e.name, e.id`

const TODAYS_WAIVER_GAPS_SQL = `
SELECT ea.id, ea.name, ea.attendee_type, e.id AS event_id, e.name AS event_name, e.starts_at,
       c.first_name AS customer_first_name, c.last_name AS customer_last_name,
       NOT ea.waiver_accepted AS standard_outstanding, ${EXTRA_WAIVER_OUTSTANDING_SQL} AS extra_outstanding
  FROM event_attendees ea
  JOIN event_bookings eb ON eb.id = ea.event_booking_id AND eb.status = 'confirmed'
  JOIN events e ON e.id = eb.event_id
  JOIN customers c ON c.id = eb.customer_id
 WHERE ${TODAY_SQL}
   AND ea.cancelled_at IS NULL
   AND (NOT ea.waiver_accepted OR ${EXTRA_WAIVER_OUTSTANDING_SQL})
 ORDER BY e.starts_at, e.name, ea.name, ea.id`

/**
 * getTodaysEvents (`GET events/today`): Overview's events card. The events on London's today that aren't cancelled,
 * each with its counts over the places still booked on confirmed bookings, and today's attendees with a standard or
 * extra waiver outstanding. Any active staff member.
 */
export async function getTodaysEvents(db: Queryable, actor: AdminActor): Promise<AdminGetTodaysEventsOutput> {
  const events = await adminRead<AdminGetTodaysEventsOutput['events'][number]>(db, { name: 'events.today', needs: 'staff', sql: TODAYS_EVENTS_SQL, times: ['starts_at', 'ends_at'] }, { actor })
  const waiverGaps = await adminRead<AdminGetTodaysEventsOutput['waiverGaps'][number]>(db, { name: 'events.today', needs: 'staff', sql: TODAYS_WAIVER_GAPS_SQL, times: ['starts_at'] }, { actor })
  return { events, waiverGaps }
}

// ---------------------------------------------------------------------------------------------------------------------
// The flags

/** A press by a staff member: who, the request, and the call's own key (the route's Idempotency-Key). */
export interface StaffFlagPress {
  actor: AdminActor
  requestId: string
  pressKey: string | null
}

/**
 * Who records a waiver (brief item 7). A staff member, on the one route there is; or the website's signed-in
 * customer, for an attendee on one of their own event bookings (the rule only: no customer route yet, lead call L13).
 */
export type EventWaiverPress = { requestId: string; pressKey: string | null } & ({ channel: 'staff'; actor: AdminActor } | { channel: 'customer'; customerId: string })

const OLD = EVENT_ADMIN_WORDS
const NEW = EVENT_ADMIN_NEW_WORDS
const changedMeanwhile = (action: AdminAction): ApiError => adminRefusal('CONFLICT', action, 'attendee_changed', NEW.attendeeChanged)

/**
 * W35 audit row 15 (W48 review L2): the events of the attendees named, in id order, FOR SHARE: LOCK_ORDER's 'event',
 * shared. Every guard below reads the event (cancelled, its date, its extra waiver and version) and the event
 * booking, so the event is held before the flag's own statement starts. Exported for the race test.
 */
export const HOLD_EVENTS_OF_ATTENDEES_SQL = `
SELECT e.id FROM events e
 WHERE e.id IN (SELECT eb.event_id FROM event_attendees ea JOIN event_bookings eb ON eb.id = ea.event_booking_id WHERE ea.id = ANY($1::uuid[]))
 ORDER BY e.id
   FOR SHARE OF e`
/** The customer channel's hold (W50a's rule): limited to the signed-in customer's own event bookings (`$2`), so someone else's event is never locked. */
const HOLD_OWN_EVENT_OF_ATTENDEE_SQL = `
SELECT e.id FROM events e
 WHERE e.id IN (SELECT eb.event_id FROM event_attendees ea JOIN event_bookings eb ON eb.id = ea.event_booking_id WHERE ea.id = ANY($1::uuid[]) AND eb.customer_id = $2::uuid)
 ORDER BY e.id
   FOR SHARE OF e`

// --- Check-in, one attendee or many

type CheckInReason = Extract<EventCheckInRouteOutput['results'][number], { updated: false }>['reason']
type CheckInOutcome = EventCheckInRouteOutput['results'][number]

const CHECK_IN_WORDS: Record<CheckInReason, string> = {
  attendee_not_found: OLD.eventCheckIn.attendee_not_found,
  attendee_cancelled: OLD.eventCheckIn.attendee_cancelled,
  booking_not_confirmed: OLD.eventCheckIn.booking_not_confirmed,
  event_cancelled: OLD.eventCheckIn.event_cancelled,
  check_in_not_open: OLD.eventAttendance.checkInOpensOnDay,
  check_in_closed: OLD.eventAttendance.checkInHasClosed,
  waivers_outstanding: OLD.eventCheckIn.waivers_outstanding,
  extra_waiver_version_missing: OLD.eventCheckIn.extra_waiver_version_missing,
}
const refusedCheckIn = (attendeeId: string, reason: CheckInReason): CheckInOutcome => ({ attendeeId, updated: false, reason, message: CHECK_IN_WORDS[reason] })

/** Most attendee ids one press accepts (an event booking has at most a handful of places), as before. */
export const MAX_ATTENDEES_PER_CHECK_IN = 100

/** W48 review L1: the attendees' own rows, locked in id order before the statement that updates them, so two presses naming the same attendees queue. */
const LOCK_ATTENDEES_SQL = 'SELECT ea.id FROM event_attendees ea WHERE ea.id = ANY($1::uuid[]) ORDER BY ea.id FOR NO KEY UPDATE OF ea'

/**
 * The one statement (the staff app's checkInEventAttendees): `target` works out each attendee's refusal, in the old
 * order (exists, the place not cancelled, the booking confirmed, the event not cancelled, the window open, the waivers
 * signed, the extra one at the event's current version, unless they are marked signed now; and a synced version for
 * an extra waiver that has to be marked), and the UPDATE checks in every attendee that passes, with the same guards
 * again. With `$1` it stamps only the outstanding waivers as signed in person: a signature already there keeps its
 * method and time. An attendee already checked in keeps their first time. `$2` the ids, `$3` the standard version.
 * Exported for the race test's control, which runs it without the event held first.
 */
export const CHECK_IN_ATTENDEES_SQL = `
WITH target AS (
  SELECT t.id AS requested_id, t.ord,
         CASE
           WHEN ea.id IS NULL THEN 'attendee_not_found'
           WHEN ea.cancelled_at IS NOT NULL THEN 'attendee_cancelled'
           WHEN eb.status <> 'confirmed' THEN 'booking_not_confirmed'
           WHEN e.cancelled_at IS NOT NULL THEN 'event_cancelled'
           WHEN ${CHECK_IN_WINDOW_SQL} = 'not_open' THEN 'check_in_not_open'
           WHEN ${CHECK_IN_WINDOW_SQL} = 'closed' THEN 'check_in_closed'
           WHEN (NOT ea.waiver_accepted OR ${EXTRA_WAIVER_OUTSTANDING_SQL}) AND NOT $1::boolean THEN 'waivers_outstanding'
           WHEN ${EXTRA_WAIVER_OUTSTANDING_SQL} AND e.extra_waiver_version IS NULL THEN 'extra_waiver_version_missing'
         END AS reason
    FROM unnest($2::uuid[]) WITH ORDINALITY AS t(id, ord)
    LEFT JOIN event_attendees ea ON ea.id = t.id
    LEFT JOIN event_bookings eb ON eb.id = ea.event_booking_id
    LEFT JOIN events e ON e.id = eb.event_id
),
upd AS (
  UPDATE event_attendees ea
     SET checked_in_at = COALESCE(ea.checked_in_at, now()),
         waiver_accepted = true,
         waiver_method = CASE WHEN ea.waiver_accepted THEN ea.waiver_method ELSE 'in_person' END,
         waiver_version = CASE WHEN ea.waiver_accepted THEN ea.waiver_version ELSE $3::text END,
         waiver_accepted_at = CASE WHEN ea.waiver_accepted THEN ea.waiver_accepted_at ELSE now() END,
         event_waiver_accepted = ea.event_waiver_accepted OR ${EXTRA_WAIVER_OUTSTANDING_SQL},
         event_waiver_method = CASE WHEN ${EXTRA_WAIVER_OUTSTANDING_SQL} THEN 'in_person' ELSE ea.event_waiver_method END,
         event_waiver_version = CASE WHEN ${EXTRA_WAIVER_OUTSTANDING_SQL} THEN e.extra_waiver_version ELSE ea.event_waiver_version END,
         event_waiver_accepted_at = CASE WHEN ${EXTRA_WAIVER_OUTSTANDING_SQL} THEN now() ELSE ea.event_waiver_accepted_at END
    FROM event_bookings eb
    JOIN events e ON e.id = eb.event_id
   WHERE eb.id = ea.event_booking_id
     AND ea.id IN (SELECT requested_id FROM target WHERE reason IS NULL)
     AND ea.cancelled_at IS NULL
     AND eb.status = 'confirmed'
     AND e.cancelled_at IS NULL
     AND ${CHECK_IN_WINDOW_SQL} = 'open'
     AND ($1::boolean OR (ea.waiver_accepted AND NOT ${EXTRA_WAIVER_OUTSTANDING_SQL}))
     AND (NOT ${EXTRA_WAIVER_OUTSTANDING_SQL} OR e.extra_waiver_version IS NOT NULL)
  RETURNING ${ATTENDEE_RECORDED_COLUMNS_SQL}
)
SELECT target.requested_id, target.reason, upd.*
  FROM target
  LEFT JOIN upd ON upd.id = target.requested_id
 ORDER BY target.ord`

type CheckInRow = { requested_id: string; reason: CheckInReason | null } & { [K in keyof RecordedRow]: RecordedRow[K] | null }

/**
 * setEventAttendeeCheckIn (checking in) and setEventAttendeesCheckIn (`POST events/attendees/check-in`). Any active
 * staff member. The attendees' events are held first (row 15), then their own rows in id order, then the one
 * statement. Answers one outcome for each attendee asked for (a repeated id once), in the order asked: the attendee
 * as they now are, or why they were refused, in the old words. Each attendee checked in has their own audit row
 * (`event_attendee.checked_in`), which says who and whether the waivers were marked signed at the desk; a refused
 * attendee has none. The time is the database's clock.
 */
export async function checkInEventAttendees(db: Db, input: { attendeeIds?: unknown; markWaiversSignedInPerson?: unknown }, press: StaffFlagPress): Promise<EventCheckInRouteOutput> {
  const action: AdminAction = 'event_attendee.checked_in'
  const asked = Array.isArray(input.attendeeIds) ? (input.attendeeIds as unknown[]).filter((id): id is string => typeof id === 'string').slice(0, MAX_ATTENDEES_PER_CHECK_IN) : []
  const unique = asked.filter((id, index) => asked.indexOf(id) === index)
  // An id that isn't one names no attendee: refused without asking the database to cast it.
  const named = unique.filter(isUuid)
  const outcomes = new Map<string, CheckInOutcome>(unique.filter((id) => !isUuid(id)).map((id) => [id, refusedCheckIn(id, 'attendee_not_found')]))
  if (named.length === 0) return { results: unique.map((id) => outcomes.get(id) as CheckInOutcome) }
  const mark = input.markWaiversSignedInPerson === true

  const results = await flagWriteMany<CheckInOutcome[]>(
    db,
    {
      action,
      needs: 'staff',
      channels: ['staff'],
      holdFirst: { sql: HOLD_EVENTS_OF_ATTENDEES_SQL, params: [named] },
      details: { markWaiversSignedInPerson: mark },
      async run(tx) {
        await tx.query(LOCK_ATTENDEES_SQL, [named])
        const rows = await tx.query<CheckInRow>(CHECK_IN_ATTENDEES_SQL, [mark, named, DEFAULT_WAIVER_VERSION])
        const changed: Array<{ entity: { type: string; id: string }; recorded: Readonly<Record<string, unknown>> }> = []
        for (const row of rows) {
          if (row.reason) {
            outcomes.set(row.requested_id, refusedCheckIn(row.requested_id, row.reason))
          } else if (row.id) {
            const checkedIn = row as RecordedRow
            outcomes.set(row.requested_id, { attendeeId: row.requested_id, updated: true, attendee: stateOf(checkedIn) })
            changed.push({ entity: { type: 'event_attendee', id: row.requested_id }, recorded: recordedOf(checkedIn) })
          } else {
            // Passed every check and was not updated. The event and the attendee's row are both held, so nothing
            // could have changed between the two: refuse the whole press rather than answer something untrue.
            throw changedMeanwhile(action)
          }
        }
        return { changed, answer: unique.map((id) => outcomes.get(id) ?? refusedCheckIn(id, 'attendee_not_found')) }
      },
    },
    press
  )
  return { results }
}

// --- Undo

/** A place not cancelled on a confirmed booking: check-in's guards, less the window and the waivers. Allowed on a cancelled event. */
const UNDO_CHECK_IN_SQL = `
UPDATE event_attendees ea
   SET checked_in_at = NULL
  FROM event_bookings eb
  JOIN events e ON e.id = eb.event_id
 WHERE ea.id = $1::uuid AND eb.id = ea.event_booking_id AND ea.cancelled_at IS NULL AND eb.status = 'confirmed'
RETURNING ${ATTENDEE_RECORDED_COLUMNS_SQL}`

/** An attendee as a refusal reads them: the place, its booking's status and customer, and the event's extra waiver and end. */
const ATTENDEE_REFUSAL_SQL = `
SELECT eb.status, eb.customer_id, (ea.cancelled_at IS NOT NULL) AS cancelled, e.has_extra_waiver, e.extra_waiver_version, ${ENDED_SQL} AS ended
  FROM event_attendees ea
  JOIN event_bookings eb ON eb.id = ea.event_booking_id
  JOIN events e ON e.id = eb.event_id
 WHERE ea.id = $1::uuid`
interface AttendeeAsRefused {
  status: string
  customer_id: string
  cancelled: boolean
  has_extra_waiver: boolean
  extra_waiver_version: string | null
  ended: boolean
}

/**
 * setEventAttendeeCheckIn with `checkedIn: false` (`POST events/attendees/:attendeeId/check-in/undo`). Any active
 * staff member. The attendee's event is held first, then one guarded statement: refused for a place that is
 * cancelled or whose booking isn't confirmed (the old undo checked only the place). The audit row
 * (`event_attendee.check_in_undone`) says who.
 */
export async function undoEventAttendeeCheckIn(db: Db, attendeeId: string, press: StaffFlagPress): Promise<EventAttendeeState> {
  const action: AdminAction = 'event_attendee.check_in_undone'
  const notFound = () => adminRefusal('NOT_FOUND', action, 'attendee_not_found', OLD.eventCheckIn.attendee_not_found)
  if (!isUuid(attendeeId)) throw notFound()
  const row = await flagWrite<RecordedRow>(
    db,
    {
      action,
      needs: 'staff',
      channels: ['staff'],
      entity: { type: 'event_attendee', id: attendeeId },
      holdFirst: { sql: HOLD_EVENTS_OF_ATTENDEES_SQL, params: [[attendeeId]] },
      statement: { sql: UNDO_CHECK_IN_SQL, params: [attendeeId] },
      async refusal(tx) {
        const [attendee] = await tx.query<AttendeeAsRefused>(ATTENDEE_REFUSAL_SQL, [attendeeId])
        if (!attendee) return notFound()
        if (attendee.cancelled === true) return adminRefusal('CONFLICT', action, 'attendee_cancelled', OLD.eventCheckIn.attendee_cancelled)
        if (attendee.status !== 'confirmed') return adminRefusal('CONFLICT', action, 'booking_not_confirmed', OLD.eventCheckIn.booking_not_confirmed)
        return changedMeanwhile(action)
      },
      recorded: recordedOf,
    },
    press
  )
  return stateOf(row)
}

// --- Waivers

type Which = 'standard' | 'extra' | 'both'

/** A statement's parameters, numbered as they are added. */
class Params {
  readonly values: SqlParam[] = []
  add(value: SqlParam): string {
    this.values.push(value)
    return `$${this.values.length}`
  }
}

/** The attendee's extra waiver is signed at the event's current version: such a signature keeps how and when it was made. */
const EXTRA_SIGNED_NOW_SQL = '(ea.event_waiver_accepted AND ea.event_waiver_version IS NOT DISTINCT FROM e.extra_waiver_version)'

/**
 * The guarded statement for a waiver, and its parameters. The guard: the attendee exists, the place isn't cancelled
 * and its booking is confirmed; the extra waiver also needs the event to have one, and a synced version to sign
 * against. On the customer channel (signing only): the booking is the customer's own and the event hasn't ended.
 * Exported for the race test's control.
 */
export function waiverStatement(attendeeId: string, which: Which, accepted: boolean, method: string | undefined, customerId: string | null): { sql: string; params: readonly SqlParam[] } {
  const params = new Params()
  const sets: string[] = []
  const guards: string[] = []
  if (accepted) {
    const how = params.add(method ?? null)
    if (which !== 'extra') {
      const version = params.add(DEFAULT_WAIVER_VERSION)
      sets.push(
        'waiver_accepted = true',
        'waiver_accepted_at = CASE WHEN ea.waiver_accepted THEN ea.waiver_accepted_at ELSE now() END',
        `waiver_method = CASE WHEN ea.waiver_accepted THEN ea.waiver_method ELSE ${how}::text END`,
        `waiver_version = CASE WHEN ea.waiver_accepted THEN ea.waiver_version ELSE ${version}::text END`
      )
    }
    if (which !== 'standard') {
      sets.push(
        'event_waiver_accepted = true',
        `event_waiver_accepted_at = CASE WHEN ${EXTRA_SIGNED_NOW_SQL} THEN ea.event_waiver_accepted_at ELSE now() END`,
        `event_waiver_method = CASE WHEN ${EXTRA_SIGNED_NOW_SQL} THEN ea.event_waiver_method ELSE ${how}::text END`,
        'event_waiver_version = e.extra_waiver_version'
      )
      guards.push('e.has_extra_waiver', 'e.extra_waiver_version IS NOT NULL')
    }
  } else if (which === 'standard') {
    sets.push('waiver_accepted = false', 'waiver_accepted_at = NULL', 'waiver_method = NULL', 'waiver_version = NULL')
  } else {
    sets.push('event_waiver_accepted = false', 'event_waiver_accepted_at = NULL', 'event_waiver_method = NULL', 'event_waiver_version = NULL')
    guards.push('e.has_extra_waiver')
  }
  const id = params.add(attendeeId)
  if (customerId !== null) guards.push(`eb.customer_id = ${params.add(customerId)}::uuid`, `NOT ${ENDED_SQL}`)
  const sql = `
UPDATE event_attendees ea
   SET ${sets.join(',\n       ')}
  FROM event_bookings eb
  JOIN events e ON e.id = eb.event_id
 WHERE ea.id = ${id}::uuid AND eb.id = ea.event_booking_id AND eb.status = 'confirmed' AND ea.cancelled_at IS NULL${guards.map((guard) => `\n   AND ${guard}`).join('')}
RETURNING ${ATTENDEE_RECORDED_COLUMNS_SQL}`
  return { sql, params: params.values }
}

/**
 * setEventAttendeeWaiver (`POST events/attendees/:attendeeId/waiver`): mark the standard waiver, the extra one or
 * both signed, or revoke one.
 *  - The old checks of what was asked, in the old words (`invalid_params`): which waiver; both can only be signed;
 *    and how it was signed, which must be a method the channel may record (waivers/methods.ts): staff `in_person` or
 *    `email_link`; the customer channel `email_link` only, and never a revoke.
 *  - The attendee's event is held first (row 15), then one guarded statement. The refusals are the old ones, in the
 *    old order and words: the attendee isn't there, the place is cancelled, the booking isn't confirmed, the event
 *    has no extra waiver, the extra waiver's text hasn't synced. On the customer channel also: the event has ended;
 *    and an attendee who isn't on one of the customer's own bookings is answered exactly as one that isn't there
 *    (`attendee_not_found`, the same status and words: W52a), so the customer is told nothing about anyone else's.
 *  - The audit row (`event_attendee.waiver_set`) says who, which waiver and which way, and keeps the waivers as set
 *    with their versions: never a name, an email or a date of birth.
 */
export async function setEventAttendeeWaiver(db: Db, attendeeId: string, input: { which: unknown; accepted: unknown; method?: unknown }, press: EventWaiverPress): Promise<EventAttendeeState> {
  const action: AdminAction = 'event_attendee.waiver_set'
  const customer = press.channel === 'customer'
  const words = OLD.setEventAttendeeWaiver
  const invalid = (message: string, field: string) => adminRefusal('VALIDATION', action, 'invalid_params', message, { field })
  const { which } = input
  const accepted = input.accepted === true
  if (which !== 'standard' && which !== 'extra' && which !== 'both') throw invalid(words.chooseStandardOrExtraWaiver, 'which')
  if (which === 'both' && !accepted) throw invalid(words.revokeStandardOrExtraWaiverOn, 'which')
  if (customer && !accepted) throw adminRefusal('FORBIDDEN', action, 'customer_cannot_revoke', NEW.customerCannotRevoke)
  if (accepted && !isWaiverMethodFor(press.channel, input.method)) {
    throw customer ? adminRefusal('VALIDATION', action, 'waiver_method_not_allowed', NEW.customerWaiverMethod, { field: 'method' }) : invalid(words.chooseHowWaiverWasSigned, 'method')
  }
  const notFound = () => adminRefusal('NOT_FOUND', action, 'attendee_not_found', words.attendee_not_found)
  if (!isUuid(attendeeId)) throw notFound()
  const customerId = press.channel === 'customer' ? press.customerId : null

  const row = await flagWrite<RecordedRow>(
    db,
    {
      action,
      needs: 'staff',
      // The one event flag the website's customer may set (brief W52 item 7); check-in and its undo are staff only.
      channels: ['staff', 'customer'],
      entity: { type: 'event_attendee', id: attendeeId },
      holdFirst: customerId !== null ? { sql: HOLD_OWN_EVENT_OF_ATTENDEE_SQL, params: [[attendeeId], customerId] } : { sql: HOLD_EVENTS_OF_ATTENDEES_SQL, params: [[attendeeId]] },
      statement: waiverStatement(attendeeId, which, accepted, accepted ? (input.method as string) : undefined, customerId),
      async refusal(tx) {
        const [attendee] = await tx.query<AttendeeAsRefused>(ATTENDEE_REFUSAL_SQL, [attendeeId])
        if (!attendee) return notFound()
        // Theirs first: a customer is told nothing about a booking that isn't their own. W52a (W52 review "For later"
        // 1): someone else's attendee is answered exactly as one that isn't there, so the answer never says the id
        // exists (W33's rule for someone else's booking, cancel-places.ts).
        if (customerId !== null && attendee.customer_id !== customerId) return notFound()
        if (attendee.cancelled === true) return adminRefusal('CONFLICT', action, 'attendee_cancelled', words.attendee_cancelled)
        if (attendee.status !== 'confirmed') return adminRefusal('CONFLICT', action, 'booking_not_confirmed', words.booking_not_confirmed)
        if (which !== 'standard' && attendee.has_extra_waiver !== true) return adminRefusal('CONFLICT', action, 'no_extra_waiver', words.no_extra_waiver)
        if (which !== 'standard' && accepted && !attendee.extra_waiver_version) return adminRefusal('CONFLICT', action, 'extra_waiver_version_missing', words.extra_waiver_version_missing)
        if (customerId !== null && attendee.ended === true) return adminRefusal('CONFLICT', action, 'event_passed', NEW.customerEventPassed)
        return changedMeanwhile(action)
      },
      recorded: recordedOf,
      details: { which, accepted, ...(customer ? { channel: 'customer' } : {}) },
    },
    { actor: press.channel === 'customer' ? { type: 'customer', id: press.customerId } : press.actor, requestId: press.requestId, pressKey: press.pressKey }
  )
  return stateOf(row)
}
