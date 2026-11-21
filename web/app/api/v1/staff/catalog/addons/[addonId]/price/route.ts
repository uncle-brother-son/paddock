import { catalogPriceRouteInputSchema, catalogPriceRouteOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { setItemPrice } from '@/server/rules/catalog/items'
import { z } from 'zod'

/**
 * Briefs W55 + W56 (G-plan 4.3; bugs GB2 and GB15; lead call L2; W53 review L7): updateCatalogItemPrice for an add-on.
 * Manage pricing; the old checks, and each price pounds and pence; one transaction under the row's lock, with a
 * `catalog.price_set` audit row. No Stripe price is made or archived. Idempotent: each press has its own key.
 */
const input = catalogPriceRouteInputSchema.omit({ itemId: true }).extend({ addonId: z.string() })
export const POST = defineRoute({ auth: 'staff', input, output: catalogPriceRouteOutputSchema, idempotent: true }, async ({ db, input, staff, requestId, idempotencyKey }) => {
  const { addonId, ...prices } = input
  return setItemPrice(db, 'addon', addonId, prices, { actor: adminActor(staff), requestId, pressKey: idempotencyKey })
})
