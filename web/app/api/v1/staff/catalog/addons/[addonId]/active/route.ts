import { catalogActiveRouteInputSchema, catalogActiveRouteOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { setItemActive } from '@/server/rules/catalog/items'
import { z } from 'zod'

/**
 * Briefs W55 + W56 (G-plan 4.3; bug GB15; lead call L2): setAddonActive, on and off sale. Manage pricing (the rule, in the
 * old words). One transaction under the row's lock, with a `catalog.active_set` audit row. No Stripe product or price
 * is switched. Idempotent: each call has its own key.
 */
const input = catalogActiveRouteInputSchema.omit({ itemId: true }).extend({ addonId: z.string() })
export const POST = defineRoute({ auth: 'staff', input, output: catalogActiveRouteOutputSchema, idempotent: true }, async ({ db, input, staff, requestId, idempotencyKey }) =>
  setItemActive(db, 'addon', input.addonId, input.active, { actor: adminActor(staff), requestId, pressKey: idempotencyKey })
)
