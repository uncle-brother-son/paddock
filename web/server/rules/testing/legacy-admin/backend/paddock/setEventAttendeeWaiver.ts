import { ATTENDEE_STATE_COLUMNS_SQL, STANDARD_WAIVER_VERSION, type EventAttendeeState } from './shared/eventAttendance'
import { resolveStaffId } from './shared/resolveStaffId'

export interface SetEventAttendeeWaiverParams {
  attendeeId: string
  /** 'both' signs the standard and the extra waiver together (signing only; revoke is per waiver). */
  which: 'standard' | 'extra' | 'both'
  accepted: boolean
  /** How it was signed; required when accepting (recorded on both waivers for 'both'). */
  method?: 'email_link' | 'in_person'
}

type WaiverRefusalReason =
  | 'invalid_params'
  | 'attendee_not_found'
  | 'attendee_cancelled'
  | 'booking_not_confirmed'
  | 'no_extra_waiver'
  | 'extra_waiver_version_missing'

export type SetEventAttendeeWaiverResult =
  /** `attendee` is the row's state after the change, so the screen can update it straight away. */
  | { updated: true; attendee: EventAttendeeState }
  | { updated: false; reason: WaiverRefusalReason; message: string }

const REFUSAL_MESSAGES: Record<Exclude<WaiverRefusalReason, 'invalid_params'>, string> = {
  attendee_not_found: 'This attendee no longer exists.',
  attendee_cancelled: 'This place has been cancelled.',
  booking_not_confirmed: "This event booking isn't confirmed.",
  no_extra_waiver: "This event doesn't have an extra waiver.",
  // Without a synced version a signature could never be matched to the text, so it's refused.
  extra_waiver_version_missing: "The extra waiver text hasn't synced from Sanity yet, so it can't be marked signed.",
}

/**
 * Marks one event attendee's standard or extra waiver signed (In Person / Email Link), both at
 * once, or revokes one. Open to all staff, like session guest waivers. The standard waiver records
 * the same version sessions use; the extra waiver records the event's current extra_waiver_version
 * at the moment it's marked signed. One guarded UPDATE … FROM … RETURNING does the checks, the
 * change and the returned row state; only when it matches no row does a second read work out which
 * refusal applies (and if the row passes every check by then, someone changed it in between, so
 * the update runs once more).
 */
export default async function setEventAttendeeWaiver(req: { params: SetEventAttendeeWaiverParams; user: User }): Promise<SetEventAttendeeWaiverResult> {
  // Refuses an inactive account before anything happens.
  await resolveStaffId(req.user.email)
  const { attendeeId, which, accepted, method } = req.params
  if (which !== 'standard' && which !== 'extra' && which !== 'both') {
    return { updated: false, reason: 'invalid_params', message: 'Choose the standard or the extra waiver.' }
  }
  if (which === 'both' && !accepted) {
    return { updated: false, reason: 'invalid_params', message: 'Revoke the standard or the extra waiver on its own.' }
  }
  if (accepted && method !== 'email_link' && method !== 'in_person') {
    return { updated: false, reason: 'invalid_params', message: 'Choose how the waiver was signed.' }
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const attendee = await guardedUpdate(attendeeId, which, accepted, method)
    if (attendee) return { updated: true, attendee }
    const reason = await refusalReason(attendeeId, which, accepted)
    if (reason) return { updated: false, reason, message: REFUSAL_MESSAGES[reason] }
    // Passes every check now: the row changed between the update and the read — run it again.
  }
  // Changed again during the re-run; ask staff to look at the row afresh.
  return { updated: false, reason: 'attendee_not_found', message: REFUSAL_MESSAGES.attendee_not_found }
}

/** The change itself, guarded: the attendee exists (the join) and its booking is confirmed; the
 *  extra waiver also needs the event to have one, and a synced version to sign against. Returns
 *  the new row state, or null when the guards matched no row. */
async function guardedUpdate(
  attendeeId: string,
  which: 'standard' | 'extra' | 'both',
  accepted: boolean,
  method: 'email_link' | 'in_person' | undefined
): Promise<EventAttendeeState | null> {
  const from = `FROM event_bookings eb
       JOIN events e ON e.id = eb.event_id
       WHERE eb.id = ea.event_booking_id AND eb.status = 'confirmed' AND ea.cancelled_at IS NULL`
  let updated
  if (which === 'both') {
    updated = await paddockData.query<EventAttendeeState>(
      `UPDATE event_attendees ea
       SET waiver_accepted = true, waiver_accepted_at = now(), waiver_method = $1, waiver_version = $2,
           event_waiver_accepted = true, event_waiver_accepted_at = now(), event_waiver_method = $3,
           event_waiver_version = e.extra_waiver_version
       ${from} AND e.has_extra_waiver AND e.extra_waiver_version IS NOT NULL AND ea.id = $4
       RETURNING ${ATTENDEE_STATE_COLUMNS_SQL}`,
      [method, STANDARD_WAIVER_VERSION, method, attendeeId]
    )
  } else if (which === 'standard' && accepted) {
    updated = await paddockData.query<EventAttendeeState>(
      `UPDATE event_attendees ea
       SET waiver_accepted = true, waiver_accepted_at = now(), waiver_method = $1, waiver_version = $2
       ${from} AND ea.id = $3
       RETURNING ${ATTENDEE_STATE_COLUMNS_SQL}`,
      [method, STANDARD_WAIVER_VERSION, attendeeId]
    )
  } else if (which === 'standard') {
    updated = await paddockData.query<EventAttendeeState>(
      `UPDATE event_attendees ea
       SET waiver_accepted = false, waiver_accepted_at = NULL, waiver_method = NULL, waiver_version = NULL
       ${from} AND ea.id = $1
       RETURNING ${ATTENDEE_STATE_COLUMNS_SQL}`,
      [attendeeId]
    )
  } else if (accepted) {
    updated = await paddockData.query<EventAttendeeState>(
      `UPDATE event_attendees ea
       SET event_waiver_accepted = true, event_waiver_accepted_at = now(), event_waiver_method = $1,
           event_waiver_version = e.extra_waiver_version
       ${from} AND e.has_extra_waiver AND e.extra_waiver_version IS NOT NULL AND ea.id = $2
       RETURNING ${ATTENDEE_STATE_COLUMNS_SQL}`,
      [method, attendeeId]
    )
  } else {
    updated = await paddockData.query<EventAttendeeState>(
      `UPDATE event_attendees ea
       SET event_waiver_accepted = false, event_waiver_accepted_at = NULL, event_waiver_method = NULL,
           event_waiver_version = NULL
       ${from} AND e.has_extra_waiver AND ea.id = $1
       RETURNING ${ATTENDEE_STATE_COLUMNS_SQL}`,
      [attendeeId]
    )
  }
  return updated.data[0] ?? null
}

/** Why the guarded update matched nothing, in the same order as its checks — or null when the row
 *  passes every check now (it changed in between). */
async function refusalReason(
  attendeeId: string,
  which: 'standard' | 'extra' | 'both',
  accepted: boolean
): Promise<Exclude<WaiverRefusalReason, 'invalid_params'> | null> {
  const lookup = await paddockData.query<{
    status: string
    cancelled: boolean
    has_extra_waiver: boolean
    extra_waiver_version: string | null
  }>(
    `SELECT eb.status, ea.cancelled_at IS NOT NULL AS cancelled, e.has_extra_waiver, e.extra_waiver_version
     FROM event_attendees ea
     JOIN event_bookings eb ON eb.id = ea.event_booking_id
     JOIN events e ON e.id = eb.event_id
     WHERE ea.id = $1`,
    [attendeeId]
  )
  const row = lookup.data[0]
  if (!row) return 'attendee_not_found'
  if (row.cancelled) return 'attendee_cancelled'
  if (row.status !== 'confirmed') return 'booking_not_confirmed'
  if (which !== 'standard' && !row.has_extra_waiver) return 'no_extra_waiver'
  if (which !== 'standard' && accepted && !row.extra_waiver_version) return 'extra_waiver_version_missing'
  return null
}
