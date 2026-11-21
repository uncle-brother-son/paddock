import { catalogVariantCreateRouteInputSchema, catalogVariantCreateRouteOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { createVariant } from '@/server/rules/catalog/items'

/**
 * Brief W55 (G-plan 4.3; bugs GB12 and GB23; lead call L2; W48 review L3): createProductVariant. Manage pricing; the
 * variant and its "Initial stock" ledger row in one transaction under the product's lock, with no Stripe price, and a
 * `catalog.variant_created` audit row. Idempotent: the dialog keeps its key after no answer, so a press made again
 * never makes the variant twice.
 */
export const POST = defineRoute({ auth: 'staff', input: catalogVariantCreateRouteInputSchema, output: catalogVariantCreateRouteOutputSchema, idempotent: true }, async ({ db, input, staff, requestId, idempotencyKey }) =>
  createVariant(db, input, { actor: adminActor(staff), requestId, pressKey: idempotencyKey })
)
