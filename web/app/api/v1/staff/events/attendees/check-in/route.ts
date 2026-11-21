import { eventCheckInRouteInputSchema, eventCheckInRouteOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { checkInEventAttendees } from '@/server/rules/events/attendance'

/**
 * W52 (G-plan 4.3, level C; W35 audit row 15): setEventAttendeeCheckIn and setEventAttendeesCheckIn, Check in, Check
 * in all and "Mark signed and check in" on the attendee list. Any active staff member. The attendees' event is held
 * first (the lock a place cancel takes), then one guarded statement that decides each attendee for itself, and one
 * audit row (`event_attendee.checked_in`, with who) for each attendee checked in, in one transaction. Answers one
 * outcome for each attendee asked for: the attendee as they now are, or why they were refused, in the old words. The
 * time is the database's clock. Idempotent: each call has its own key.
 */
export const POST = defineRoute({ auth: 'staff', input: eventCheckInRouteInputSchema, output: eventCheckInRouteOutputSchema, idempotent: true }, async ({ db, input, staff, requestId, idempotencyKey }) =>
  checkInEventAttendees(db, input, { actor: adminActor(staff), requestId, pressKey: idempotencyKey })
)
