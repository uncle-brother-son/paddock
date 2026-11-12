import { bookingStatusOutputSchema, bookingStatusRouteInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { setStatus } from '@/server/rules/bookings/edits'

/**
 * W18 (D-plan 1.9, section 3 N3): setBookingStatus. Only the four statuses the select offers (pending, confirmed,
 * completed, no-show), and never from payment needed or cancelled; each refusal names its reason and words in
 * `details`. One transaction with its `booking.status` audit row. Any active staff member, as before. Moves no
 * money, so the switch doesn't gate it. Idempotent: the same key gets the same answer.
 */
export const POST = defineRoute(
  { auth: 'staff', input: bookingStatusRouteInputSchema, output: bookingStatusOutputSchema, idempotent: true },
  async ({ db, input, staff, requestId }) => setStatus(db, input.bookingId, input.status, { actor: { type: 'staff', id: staff.id }, requestId })
)
