import { adminGetBookingByIdOutputSchema, bookingByIdRouteInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { getBookingRow } from '@/server/rules/bookings/admin'

/**
 * W50 (G-plan 4.3; bug GB14): getBookingById, one booking's row read fresh (the booking window opened by id from
 * Overview, a customer's Booking History and the Block dialogs). Null when there is no such booking. Named fields.
 * Any active staff member (the old read checked nobody).
 */
export const GET = defineRoute({ auth: 'staff', input: bookingByIdRouteInputSchema, output: adminGetBookingByIdOutputSchema }, async ({ db, input, staff }) =>
  getBookingRow(db, input.bookingId, { channel: 'staff', actor: adminActor(staff) })
)
