import { adminGetBookingDetailOutputSchema, bookingByIdRouteInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { getBookingDetail } from '@/server/rules/bookings/admin'

/**
 * W50 (G-plan 4.3; bug GB14): getBookingDetail, the booking window's guests, add-on lines, special requests, money
 * still to give back and the words shown while a payment is still being taken on the booking. Named fields. Any
 * active staff member (the old read checked nobody, and showed guests' dates of birth).
 */
export const GET = defineRoute({ auth: 'staff', input: bookingByIdRouteInputSchema, output: adminGetBookingDetailOutputSchema }, async ({ db, input, staff }) =>
  getBookingDetail(db, input.bookingId, { channel: 'staff', actor: adminActor(staff) })
)
