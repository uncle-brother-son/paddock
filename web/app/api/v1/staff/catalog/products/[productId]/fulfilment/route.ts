import { catalogFulfilmentRouteInputSchema, catalogFulfilmentRouteOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { setProductFulfilment } from '@/server/rules/catalog/items'

/**
 * Brief W55 (G-plan 4.3): setProductFulfillmentMethod. Manage pricing; one transaction under the product's lock, with
 * a `catalog.details_set` audit row. Idempotent: each press has its own key.
 */
export const POST = defineRoute({ auth: 'staff', input: catalogFulfilmentRouteInputSchema, output: catalogFulfilmentRouteOutputSchema, idempotent: true }, async ({ db, input, staff, requestId, idempotencyKey }) =>
  setProductFulfilment(db, input.productId, input.fulfillmentMethod, { actor: adminActor(staff), requestId, pressKey: idempotencyKey })
)
