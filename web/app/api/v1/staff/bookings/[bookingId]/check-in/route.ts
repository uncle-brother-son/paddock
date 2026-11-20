import { bookingCheckInRouteInputSchema, bookingCheckInRouteOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { setBookingCheckedIn } from '@/server/rules/bookings/admin'

/**
 * W50 (G-plan 4.3, level C; bug GB17; Wayne's Q49): setBookingCheckedIn, Check In and its undo. Any active staff
 * member. One guarded statement and an audit row (`booking.checked_in` or `booking.check_in_undone`, with who) in one
 * transaction: refused on a cancelled booking either way, and Check In refused on a booking at Payment needed ("This
 * booking needs payment first. Use Take Payment.") and, W50a, while a payment is still being taken on the booking
 * (`payment_open`). The time is the database's clock. Idempotent: each call has its own key.
 */
export const POST = defineRoute({ auth: 'staff', input: bookingCheckInRouteInputSchema, output: bookingCheckInRouteOutputSchema, idempotent: true }, async ({ db, input, staff, requestId, idempotencyKey }) =>
  setBookingCheckedIn(db, input.bookingId, input.checkedIn, { actor: adminActor(staff), requestId, pressKey: idempotencyKey })
)
