import { adminGetWaiverGapsForRangeOutputSchema, bookingDayRangeRouteInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { listWaiverGaps } from '@/server/rules/bookings/admin'

/**
 * W50 (G-plan 4.3; bug GB14; W48 review L5): getWaiverGapsForRange, Overview's waivers card: every guest without a
 * signed waiver on a booking that isn't cancelled, for the sessions on the London days in the range (both included).
 * Named fields. Any active staff member (the old read checked nobody).
 */
export const GET = defineRoute({ auth: 'staff', input: bookingDayRangeRouteInputSchema, output: adminGetWaiverGapsForRangeOutputSchema }, async ({ db, input, staff }) =>
  listWaiverGaps(db, input, { channel: 'staff', actor: adminActor(staff) })
)
