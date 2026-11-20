import { ATTENDEE_STATE_COLUMNS_SQL, type EventAttendeeState } from './shared/eventAttendance'
import { CHECK_IN_REFUSAL_MESSAGES, checkInEventAttendees, type CheckInRefusalReason } from './shared/eventCheckIn'
import { resolveStaffId } from './shared/resolveStaffId'

export interface SetEventAttendeeCheckInParams {
  attendeeId: string
  checkedIn: boolean
  /** "Mark signed and check in": marks any outstanding waiver(s) signed In Person in the same
   *  update as the check-in. Without it, check-in is refused while a waiver is outstanding. */
  markWaiversSignedInPerson?: boolean
}

export type SetEventAttendeeCheckInResult =
  /** `attendee` is the row's state after the change, so the screen can update it straight away. */
  | { updated: true; attendee: EventAttendeeState }
  | { updated: false; reason: CheckInRefusalReason; message: string }

/**
 * Checks one event attendee in (stamps checked_in_at) or undoes it. All staff. Check-in needs a
 * confirmed booking, the check-in window to be open (the event's London date, or until ends_at
 * when later), and every waiver the event needs accepted (the extra one at the event's current
 * version) — or markWaiversSignedInPerson, which records the outstanding ones as signed in person
 * at the same moment. Undo is always allowed. Either way it is one database statement
 * (checkInEventAttendees / the guarded undo below), returning the row's new state.
 */
export default async function setEventAttendeeCheckIn(req: { params: SetEventAttendeeCheckInParams; user: User }): Promise<SetEventAttendeeCheckInResult> {
  // Refuses an inactive account before anything happens.
  await resolveStaffId(req.user.email)
  const { attendeeId, checkedIn, markWaiversSignedInPerson } = req.params

  if (!checkedIn) {
    const undone = await paddockData.query<EventAttendeeState>(
      `UPDATE event_attendees ea
       SET checked_in_at = NULL
       FROM event_bookings eb
       JOIN events e ON e.id = eb.event_id
       WHERE ea.id = $1 AND eb.id = ea.event_booking_id AND ea.cancelled_at IS NULL
       RETURNING ${ATTENDEE_STATE_COLUMNS_SQL}`,
      [attendeeId]
    )
    const attendee = undone.data[0]
    if (!attendee) return { updated: false, reason: 'attendee_not_found', message: CHECK_IN_REFUSAL_MESSAGES.attendee_not_found }
    return { updated: true, attendee }
  }

  const [outcome] = await checkInEventAttendees([attendeeId], markWaiversSignedInPerson === true)
  if (!outcome) return { updated: false, reason: 'attendee_not_found', message: CHECK_IN_REFUSAL_MESSAGES.attendee_not_found }
  return outcome.updated ? { updated: true, attendee: outcome.attendee } : { updated: false, reason: outcome.reason, message: outcome.message }
}
