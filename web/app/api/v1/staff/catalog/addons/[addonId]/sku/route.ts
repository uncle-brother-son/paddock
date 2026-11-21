import { catalogAddonSkuRouteInputSchema, catalogAddonSkuRouteOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { setAddonSku } from '@/server/rules/catalog/items'

/**
 * Brief W55 (G-plan 4.3; bug GB23): setAddonSku. Manage pricing; a SKU another add-on has, in any letter case, refused
 * in words; one transaction under the add-on's lock, with a `catalog.details_set` audit row. Idempotent: each press
 * has its own key.
 */
export const POST = defineRoute({ auth: 'staff', input: catalogAddonSkuRouteInputSchema, output: catalogAddonSkuRouteOutputSchema, idempotent: true }, async ({ db, input, staff, requestId, idempotencyKey }) =>
  setAddonSku(db, input.addonId, input.sku, { actor: adminActor(staff), requestId, pressKey: idempotencyKey })
)
