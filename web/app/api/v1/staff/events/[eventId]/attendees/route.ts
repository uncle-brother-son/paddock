import { eventAttendeesRouteInputSchema, eventAttendeesRouteOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { getEventAttendees } from '@/server/rules/events/attendance'

/**
 * W52 (G-plan 4.3; bug GB14; W35 audit F1 and row 18): getEventAttendees, the attendee list: the event, whether
 * check-in is open, and every booking with its places, confirmed and cancelled, each with the money still to refund
 * on its order and whether a refund on that order is still being checked. Named fields. Any active staff member (the
 * old read checked nobody).
 */
export const GET = defineRoute({ auth: 'staff', input: eventAttendeesRouteInputSchema, output: eventAttendeesRouteOutputSchema }, async ({ db, input, staff }) =>
  getEventAttendees(db, input.eventId, adminActor(staff))
)
