import { adminGetBookingsOutputSchema, bookingListRouteInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { listBookings } from '@/server/rules/bookings/admin'

/**
 * W50 (G-plan 4.3; bug GB14; W48 review L5): getBookings, the Bookings page's and Overview's list: the bookings whose
 * session is on a London day in the range (each end optional, both included), with the status asked for. Named
 * fields. Any active staff member (the old read checked nobody).
 */
export const GET = defineRoute({ auth: 'staff', input: bookingListRouteInputSchema, output: adminGetBookingsOutputSchema }, async ({ db, input, staff }) =>
  listBookings(db, input, { channel: 'staff', actor: adminActor(staff) })
)
