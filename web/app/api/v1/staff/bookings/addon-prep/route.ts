import { adminGetAddonPrepChecklistForRangeOutputSchema, bookingDayRangeRouteInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { listAddonPrep } from '@/server/rules/bookings/admin'

/**
 * W50 (G-plan 4.3; bug GB14; W48 review L5): getAddonPrepChecklistForRange, the add-ons to prepare for the sessions
 * on the London days in the range (both included): the Bookings page's session windows and Overview's prep card.
 * Named fields. Any active staff member (the old read checked nobody).
 */
export const GET = defineRoute({ auth: 'staff', input: bookingDayRangeRouteInputSchema, output: adminGetAddonPrepChecklistForRangeOutputSchema }, async ({ db, input, staff }) =>
  listAddonPrep(db, input, { channel: 'staff', actor: adminActor(staff) })
)
