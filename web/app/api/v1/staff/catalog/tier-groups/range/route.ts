import { catalogTierRangeRouteInputSchema, catalogTierRangeRouteOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { setTierGroupRange } from '@/server/rules/catalog/service-types'

/**
 * Brief W56 (G-plan 4.3; bug GB21; W54a's stale-page rule): setServiceTypePriceTierRange. One press changes the
 * pressed tier's size group in every band, in one transaction under the service type's lock, and refuses a range that
 * overlaps another group; a `catalog.tier_range_set` audit row. The press sends the group's stamp as the list read it.
 */
export const POST = defineRoute({ auth: 'staff', input: catalogTierRangeRouteInputSchema, output: catalogTierRangeRouteOutputSchema, idempotent: true }, async ({ db, input, staff, requestId, idempotencyKey }) =>
  setTierGroupRange(db, input, { actor: adminActor(staff), requestId, pressKey: idempotencyKey })
)
