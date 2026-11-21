import { catalogTierCreateRouteInputSchema, catalogTierCreateRouteOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { createTierGroup } from '@/server/rules/catalog/service-types'

/**
 * Brief W56 (G-plan 4.3): createServiceTypePriceTier, a new size group (one tier for each active band, no price yet).
 * Manage pricing; one transaction under the service type's lock, with a `catalog.tier_created` audit row. Idempotent:
 * the dialog keeps its key after no answer.
 */
export const POST = defineRoute({ auth: 'staff', input: catalogTierCreateRouteInputSchema, output: catalogTierCreateRouteOutputSchema, idempotent: true }, async ({ db, input, staff, requestId, idempotencyKey }) =>
  createTierGroup(db, input, { actor: adminActor(staff), requestId, pressKey: idempotencyKey })
)
