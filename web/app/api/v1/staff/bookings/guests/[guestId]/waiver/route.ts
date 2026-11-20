import { guestWaiverRouteInputSchema, guestWaiverRouteOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { setGuestWaiver } from '@/server/rules/bookings/admin'

/**
 * W50 (G-plan 4.3, level C; bug GB17; W48 review L2): setGuestWaiverStatus, Mark Signed and Revoke on a booking's
 * guest. Any active staff member. The guest's booking is held first, then one guarded statement and an audit row
 * (`booking.guest_waiver_set`, with who) in one transaction: refused on a cancelled booking either way; the method
 * must be `in_person` or `email_link` (the old words). Idempotent: each call has its own key.
 */
export const POST = defineRoute({ auth: 'staff', input: guestWaiverRouteInputSchema, output: guestWaiverRouteOutputSchema, idempotent: true }, async ({ db, input, staff, requestId, idempotencyKey }) =>
  setGuestWaiver(db, input.guestId, { accepted: input.accepted, waiverMethod: input.waiverMethod, waiverVersion: input.waiverVersion }, { channel: 'staff', actor: adminActor(staff), requestId, pressKey: idempotencyKey })
)
