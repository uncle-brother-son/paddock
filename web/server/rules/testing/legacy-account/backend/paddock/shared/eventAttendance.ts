/**
 * Event day rules shared by the attendee list, the Overview cards, the customer profile and the
 * waiver / check-in setters. SQL fragments expect the aliases `ea` (event_attendees),
 * `eb` (event_bookings) and `e` (events).
 *
 * Every attendee signs the standard waiver; when the event has an extra waiver
 * (events.has_extra_waiver) every attendee signs that too, and a signature only counts when it is
 * for the event's current extra_waiver_version (the text is fingerprinted when synced from Sanity,
 * so a changed text needs signing again). Only confirmed bookings count: pending is a card-reader
 * payment still in progress.
 */

export type ExtraWaiverState = 'not_needed' | 'accepted' | 'older_version' | 'pending'

/** The standard waiver version recorded for events — the same default sessions use
 *  (setGuestWaiverStatus). */
export const STANDARD_WAIVER_VERSION = 'v1'

/** ExtraWaiverState for one attendee. */
export const EXTRA_WAIVER_STATE_SQL = `CASE
    WHEN NOT e.has_extra_waiver THEN 'not_needed'
    WHEN NOT ea.event_waiver_accepted THEN 'pending'
    WHEN ea.event_waiver_version IS DISTINCT FROM e.extra_waiver_version THEN 'older_version'
    ELSE 'accepted'
  END`

/** True when the attendee's extra waiver is outstanding (unsigned, or an older version). */
export const EXTRA_WAIVER_OUTSTANDING_SQL = `(e.has_extra_waiver AND (NOT ea.event_waiver_accepted
    OR ea.event_waiver_version IS DISTINCT FROM e.extra_waiver_version))`

export type CheckInWindow = 'not_open' | 'open' | 'closed'

/**
 * CheckInWindow for the event: open from the start of its London date until the end of that date,
 * or until ends_at when that is later. starts_at / ends_at hold London wall-clock digits labelled
 * UTC, so `AT TIME ZONE 'UTC'` gives the wall-clock timestamp, compared with London's wall-clock
 * now. An undated event is never open.
 */
export const CHECK_IN_WINDOW_SQL = `CASE
    WHEN e.starts_at IS NULL
      OR (now() AT TIME ZONE 'Europe/London') < (e.starts_at AT TIME ZONE 'UTC')::date::timestamp THEN 'not_open'
    WHEN (now() AT TIME ZONE 'Europe/London') >= GREATEST(
           ((e.starts_at AT TIME ZONE 'UTC')::date + 1)::timestamp,
           e.ends_at AT TIME ZONE 'UTC') THEN 'closed'
    ELSE 'open'
  END`

export const CHECK_IN_NOT_OPEN_MESSAGE = 'Check-in opens on the day'
export const CHECK_IN_CLOSED_MESSAGE = 'Check-in has closed'

/** One attendee's waiver and check-in state, returned by the waiver / check-in setters so the
 *  screen can update that row straight away (same fields getEventAttendees returns). */
export interface EventAttendeeState {
  id: string
  waiver_accepted: boolean
  waiver_method: 'email_link' | 'in_person' | 'checkout' | null
  waiver_accepted_at: string | null
  extra_waiver_state: ExtraWaiverState
  event_waiver_method: 'email_link' | 'in_person' | 'checkout' | null
  event_waiver_accepted_at: string | null
  checked_in_at: string | null
}

/** EventAttendeeState columns, for SELECT lists and the setters' RETURNING lists (aliases `ea`, `e`). */
export const ATTENDEE_STATE_COLUMNS_SQL = `ea.id, ea.waiver_accepted, ea.waiver_method, ea.waiver_accepted_at,
    ${EXTRA_WAIVER_STATE_SQL} AS extra_waiver_state, ea.event_waiver_method, ea.event_waiver_accepted_at,
    ea.checked_in_at`

/** Reads one attendee's EventAttendeeState (null when it no longer exists). */
export async function loadEventAttendeeState(attendeeId: string): Promise<EventAttendeeState | null> {
  const result = await paddockData.query<EventAttendeeState>(
    `SELECT ${ATTENDEE_STATE_COLUMNS_SQL}
     FROM event_attendees ea
     JOIN event_bookings eb ON eb.id = ea.event_booking_id
     JOIN events e ON e.id = eb.event_id
     WHERE ea.id = $1`,
    [attendeeId]
  )
  return result.data[0] ?? null
}
