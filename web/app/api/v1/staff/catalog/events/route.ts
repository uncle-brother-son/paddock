import { emptyInputSchema, eventListRouteOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { listEvents } from '@/server/rules/catalog/events'

/**
 * W52 (G-plan 4.3; bug GB14): getEvents, the list for Catalog → Events and New Order's event picker: every event,
 * upcoming first, undated last. Named fields. Any active staff member (the old read checked nobody). Each row
 * carries its stamp, which the edit dialog sends back with a save (W54a's rule).
 */
export const GET = defineRoute({ auth: 'staff', input: emptyInputSchema, output: eventListRouteOutputSchema }, async ({ db, staff }) => listEvents(db, adminActor(staff)))
