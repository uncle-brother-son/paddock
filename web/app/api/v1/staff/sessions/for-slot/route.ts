import { adminGetServiceTypesForSlotOutputSchema, sessionsForSlotRouteInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { serviceTypesForSlot } from '@/server/rules/sessions/admin'

/**
 * W51 (G-plan 4.3; bug GB14): getServiceTypesForSlot, New Order's "Add Booking" on a calendar card: the service
 * types with a weekly slot at that exact weekday and time and a session already made for it. Named fields. Any
 * active staff member (the old read checked nobody).
 */
export const GET = defineRoute({ auth: 'staff', input: sessionsForSlotRouteInputSchema, output: adminGetServiceTypesForSlotOutputSchema }, async ({ db, input, staff }) =>
  serviceTypesForSlot(db, input.startTime, { actor: adminActor(staff) })
)
