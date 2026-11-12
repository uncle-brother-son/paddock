import { bookingSpecialRequestsOutputSchema, bookingSpecialRequestsRouteInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { setSpecialRequests } from '@/server/rules/bookings/edits'

/**
 * W18 (D-plan 1.9, 4.4): setBookingSpecialRequests. Trimmed, cut to 500 characters, null when empty; refused on a
 * cancelled booking (`booking_cancelled`) or a missing one (`booking_not_found`), with what the screen showed for each
 * in `details`. One transaction with its `booking.special_requests` audit row. Any active staff member, as before.
 * Moves no money, so the switch doesn't gate it. Idempotent: the same key gets the same answer.
 */
export const POST = defineRoute(
  { auth: 'staff', input: bookingSpecialRequestsRouteInputSchema, output: bookingSpecialRequestsOutputSchema, idempotent: true },
  async ({ db, input, staff, requestId }) =>
    setSpecialRequests(db, input.bookingId, input.specialRequests, { actor: { type: 'staff', id: staff.id }, requestId })
)
