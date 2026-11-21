import { catalogVariantDetailsRouteInputSchema, catalogVariantDetailsRouteOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { setVariantDetails } from '@/server/rules/catalog/items'

/**
 * Brief W55 (G-plan 4.3; bug GB23; W54a's stale-page rule): setProductVariantDetails, a variant's size and SKU. Manage
 * pricing; GB23's checks in words; one transaction under the product's and the variant's locks, with a
 * `catalog.details_set` audit row. The press sends the variant's stamp as the list read it: refused `changed_since`
 * when the size or SKU has changed since. Idempotent: each press has its own key.
 */
export const POST = defineRoute({ auth: 'staff', input: catalogVariantDetailsRouteInputSchema, output: catalogVariantDetailsRouteOutputSchema, idempotent: true }, async ({ db, input, staff, requestId, idempotencyKey }) =>
  setVariantDetails(db, input, { actor: adminActor(staff), requestId, pressKey: idempotencyKey })
)
