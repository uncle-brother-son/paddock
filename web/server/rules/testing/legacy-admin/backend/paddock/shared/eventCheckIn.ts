/**
 * Event check-in writes (single and batch), kept apart from shared/eventAttendance so the read-only
 * getters that use those SQL fragments don't import any write.
 */
import {
  ATTENDEE_STATE_COLUMNS_SQL,
  CHECK_IN_CLOSED_MESSAGE,
  CHECK_IN_NOT_OPEN_MESSAGE,
  CHECK_IN_WINDOW_SQL,
  EXTRA_WAIVER_OUTSTANDING_SQL,
  STANDARD_WAIVER_VERSION,
  type EventAttendeeState,
} from './eventAttendance'

export type CheckInRefusalReason =
  | 'attendee_not_found'
  | 'attendee_cancelled'
  | 'booking_not_confirmed'
  | 'event_cancelled'
  | 'check_in_not_open'
  | 'check_in_closed'
  | 'waivers_outstanding'
  | 'extra_waiver_version_missing'

export const CHECK_IN_REFUSAL_MESSAGES: Record<CheckInRefusalReason, string> = {
  attendee_not_found: 'This attendee no longer exists.',
  attendee_cancelled: 'This place has been cancelled.',
  booking_not_confirmed: "This event booking isn't confirmed.",
  event_cancelled: 'This event has been cancelled.',
  check_in_not_open: CHECK_IN_NOT_OPEN_MESSAGE,
  check_in_closed: CHECK_IN_CLOSED_MESSAGE,
  waivers_outstanding: 'Mark the waiver(s) signed before checking in.',
  extra_waiver_version_missing: "The extra waiver text hasn't synced from Sanity yet, so it can't be marked signed.",
}

export type AttendeeCheckInOutcome =
  | { attendeeId: string; updated: true; attendee: EventAttendeeState }
  | { attendeeId: string; updated: false; reason: CheckInRefusalReason; message: string }

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Checks attendees in, in ONE statement: a CTE works out each attendee's refusal reason (the same
 * rules and order as before: exists, place not cancelled, booking confirmed, event not cancelled, check-in window open,
 * waivers accepted — the extra one at the event's current version — unless
 * `markWaiversSignedInPerson`, and a synced extra waiver version when it has to be marked), and
 * the guarded UPDATE … FROM checks in every attendee that passes, stamping only the outstanding
 * waivers as signed in person (an existing signature and its method are kept), and returns each
 * row's new state. Attendees that pass are checked in even when others in the same call are
 * refused. Outcomes come back in the order asked.
 */
export async function checkInEventAttendees(
  attendeeIds: string[],
  markWaiversSignedInPerson: boolean,
  /** Internal: true on the one re-run after a concurrent change (never re-runs again). */
  isRetry = false
): Promise<AttendeeCheckInOutcome[]> {
  const unique = [...new Set(attendeeIds)]
  const valid = unique.filter((id) => UUID_PATTERN.test(id))
  const outcomes = new Map<string, AttendeeCheckInOutcome>()
  for (const id of unique) {
    if (!UUID_PATTERN.test(id)) {
      outcomes.set(id, { attendeeId: id, updated: false, reason: 'attendee_not_found', message: CHECK_IN_REFUSAL_MESSAGES.attendee_not_found })
    }
  }

  if (valid.length > 0) {
    const rows = await paddockData.query<
      { requested_id: string; reason: CheckInRefusalReason | null } & { [K in keyof EventAttendeeState]: EventAttendeeState[K] | null }
    >(
      `WITH target AS (
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
         SET checked_in_at = now(),
             waiver_accepted = true,
             waiver_method = CASE WHEN ea.waiver_accepted THEN ea.waiver_method ELSE 'in_person' END,
             waiver_version = CASE WHEN ea.waiver_accepted THEN ea.waiver_version ELSE $3 END,
             waiver_accepted_at = CASE WHEN ea.waiver_accepted THEN ea.waiver_accepted_at ELSE now() END,
             event_waiver_accepted = ea.event_waiver_accepted OR ${EXTRA_WAIVER_OUTSTANDING_SQL},
             event_waiver_method = CASE WHEN ${EXTRA_WAIVER_OUTSTANDING_SQL} THEN 'in_person' ELSE ea.event_waiver_method END,
             event_waiver_version = CASE WHEN ${EXTRA_WAIVER_OUTSTANDING_SQL} THEN e.extra_waiver_version ELSE ea.event_waiver_version END,
             event_waiver_accepted_at = CASE WHEN ${EXTRA_WAIVER_OUTSTANDING_SQL} THEN now() ELSE ea.event_waiver_accepted_at END
         FROM event_bookings eb
         JOIN events e ON e.id = eb.event_id
         WHERE eb.id = ea.event_booking_id
           AND ea.id IN (SELECT requested_id FROM target WHERE reason IS NULL)
           -- The same guards again, so a change committed by someone else mid-statement can't
           -- slip a check-in past them.
           AND ea.cancelled_at IS NULL
           AND eb.status = 'confirmed'
           AND e.cancelled_at IS NULL
           AND ${CHECK_IN_WINDOW_SQL} = 'open'
           AND ($4::boolean OR (ea.waiver_accepted AND NOT ${EXTRA_WAIVER_OUTSTANDING_SQL}))
           AND (NOT ${EXTRA_WAIVER_OUTSTANDING_SQL} OR e.extra_waiver_version IS NOT NULL)
         RETURNING ${ATTENDEE_STATE_COLUMNS_SQL}
       )
       SELECT target.requested_id, target.reason, upd.*
       FROM target
       LEFT JOIN upd ON upd.id = target.requested_id
       ORDER BY target.ord`,
      [markWaiversSignedInPerson, valid, STANDARD_WAIVER_VERSION, markWaiversSignedInPerson]
    )
    const retry: string[] = []
    for (const row of rows.data) {
      if (row.reason) {
        outcomes.set(row.requested_id, {
          attendeeId: row.requested_id,
          updated: false,
          reason: row.reason,
          message: CHECK_IN_REFUSAL_MESSAGES[row.reason],
        })
      } else if (row.id) {
        const { requested_id, reason: _reason, ...state } = row
        outcomes.set(requested_id, { attendeeId: requested_id, updated: true, attendee: state as EventAttendeeState })
      } else if (!isRetry) {
        // Passed the checks but someone else changed the row before the update took it — work
        // the reason out again from the latest data (a follow-up only in this race).
        retry.push(row.requested_id)
      } else {
        // Changed again during the re-run: the waivers are the only thing staff change that fast.
        outcomes.set(row.requested_id, {
          attendeeId: row.requested_id,
          updated: false,
          reason: 'waivers_outstanding',
          message: CHECK_IN_REFUSAL_MESSAGES.waivers_outstanding,
        })
      }
    }
    if (retry.length > 0) {
      for (const outcome of await checkInEventAttendees(retry, markWaiversSignedInPerson, true)) {
        outcomes.set(outcome.attendeeId, outcome)
      }
    }
  }

  return attendeeIds
    .filter((id, i) => attendeeIds.indexOf(id) === i)
    .map((id) => outcomes.get(id)!)
}
