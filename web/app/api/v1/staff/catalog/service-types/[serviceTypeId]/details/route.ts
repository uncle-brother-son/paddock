import { catalogServiceTypeDetailsRouteInputSchema, catalogServiceTypeDetailsRouteOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { setServiceTypeDetails } from '@/server/rules/catalog/service-types'

/**
 * Brief W56 (G-plan 4.3; W54a's stale-page rule): setServiceTypeCapacityInfo, a type's length, capacity and booking
 * type. Manage pricing; one transaction under the type's lock, with a `catalog.details_set` audit row. The press sends
 * the type's stamp as the list read it: refused `changed_since` when one of the three has changed since.
 */
export const POST = defineRoute({ auth: 'staff', input: catalogServiceTypeDetailsRouteInputSchema, output: catalogServiceTypeDetailsRouteOutputSchema, idempotent: true }, async ({ db, input, staff, requestId, idempotencyKey }) =>
  setServiceTypeDetails(db, input, { actor: adminActor(staff), requestId, pressKey: idempotencyKey })
)
