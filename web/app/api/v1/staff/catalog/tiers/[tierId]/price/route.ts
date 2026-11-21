import { catalogTierPriceRouteInputSchema, catalogTierPriceRouteOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { setTierPrice } from '@/server/rules/catalog/service-types'

/**
 * Brief W56 (G-plan 4.3; bugs GB2 and GB15; lead call L2; W53 review L7): updateTierPrice. Manage pricing; the price
 * pounds and pence; one transaction under the tier's lock, with a `catalog.price_set` audit row. No Stripe price.
 */
export const POST = defineRoute({ auth: 'staff', input: catalogTierPriceRouteInputSchema, output: catalogTierPriceRouteOutputSchema, idempotent: true }, async ({ db, input, staff, requestId, idempotencyKey }) =>
  setTierPrice(db, input.tierId, input.price, { actor: adminActor(staff), requestId, pressKey: idempotencyKey })
)
