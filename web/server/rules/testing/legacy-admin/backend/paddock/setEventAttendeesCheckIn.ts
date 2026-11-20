import { checkInEventAttendees, type AttendeeCheckInOutcome } from './shared/eventCheckIn'
import { resolveStaffId } from './shared/resolveStaffId'

export interface SetEventAttendeesCheckInParams {
  attendeeIds: string[]
  /** "Mark signed and check in": marks each attendee's outstanding waiver(s) signed In Person in
   *  the same update as their check-in. */
  markWaiversSignedInPerson?: boolean
}

export interface SetEventAttendeesCheckInResult {
  /** One per attendee asked for (duplicates once), in the order asked: the row's new state, or
   *  why that attendee was refused. */
  results: AttendeeCheckInOutcome[]
}

/** Most attendee ids one call accepts (an event booking has at most a handful of places). */
const MAX_ATTENDEES_PER_CALL = 100

/**
 * "Check in all" / "Mark signed and check in" for several attendees in one call (all staff):
 * the same rules as setEventAttendeeCheckIn, applied per attendee in one database statement.
 * Attendees that pass are checked in even when others are refused.
 */
export default async function setEventAttendeesCheckIn(req: { params: SetEventAttendeesCheckInParams; user: User }): Promise<SetEventAttendeesCheckInResult> {
  // Refuses an inactive account before anything happens.
  await resolveStaffId(req.user.email)
  const ids = Array.isArray(req.params.attendeeIds)
    ? req.params.attendeeIds.filter((id): id is string => typeof id === 'string').slice(0, MAX_ATTENDEES_PER_CALL)
    : []
  if (ids.length === 0) return { results: [] }
  return { results: await checkInEventAttendees(ids, req.params.markWaiversSignedInPerson === true) }
}
