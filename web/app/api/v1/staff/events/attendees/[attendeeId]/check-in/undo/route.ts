import { eventAttendeeRouteInputSchema, eventAttendeeStateSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { undoEventAttendeeCheckIn } from '@/server/rules/events/attendance'

/**
 * W52 (G-plan 4.3, level C; W48 report "For the Worker step" 5): setEventAttendeeCheckIn with `checkedIn: false`,
 * Undo check-in on the attendee list. Any active staff member. The attendee's event is held first, then one guarded
 * statement and an audit row (`event_attendee.check_in_undone`, with who) in one transaction: refused for a place
 * that is cancelled or whose booking isn't confirmed. Allowed on a cancelled event (its bookings can't be cancelled
 * while a place is checked in). Idempotent: each call has its own key.
 */
export const POST = defineRoute({ auth: 'staff', input: eventAttendeeRouteInputSchema, output: eventAttendeeStateSchema, idempotent: true }, async ({ db, input, staff, requestId, idempotencyKey }) =>
  undoEventAttendeeCheckIn(db, input.attendeeId, { actor: adminActor(staff), requestId, pressKey: idempotencyKey })
)
