import { eventAttendeeStateSchema, eventWaiverRouteInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { setEventAttendeeWaiver } from '@/server/rules/events/attendance'

/**
 * W52 (G-plan 4.3, level C): setEventAttendeeWaiver, Mark Signed and Revoke on an event attendee: the standard
 * waiver, the extra one, or both to sign; one to revoke. Any active staff member. The attendee's event is held first,
 * then one guarded statement and an audit row (`event_attendee.waiver_set`, with who) in one transaction. The method
 * must be `in_person` or `email_link`; the extra waiver is signed against the event's current version. Refusals are
 * the old ones, in the old words. Idempotent: each call has its own key.
 */
export const POST = defineRoute({ auth: 'staff', input: eventWaiverRouteInputSchema, output: eventAttendeeStateSchema, idempotent: true }, async ({ db, input, staff, requestId, idempotencyKey }) =>
  setEventAttendeeWaiver(db, input.attendeeId, { which: input.which, accepted: input.accepted, method: input.method }, { channel: 'staff', actor: adminActor(staff), requestId, pressKey: idempotencyKey })
)
