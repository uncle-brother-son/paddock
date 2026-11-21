import { catalogPresetPriceRouteInputSchema, catalogPresetRouteOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { setPresetPrice } from '@/server/rules/catalog/passes-gift-cards'

/**
 * Brief W56 (G-plan 4.3; bug GB2; lead call L2; W53 review L7): updateGiftCardPresetPrice. Manage pricing; one
 * transaction under the preset's lock, with a `catalog.price_set` audit row. Gift cards already sold keep their amount.
 */
export const POST = defineRoute({ auth: 'staff', input: catalogPresetPriceRouteInputSchema, output: catalogPresetRouteOutputSchema, idempotent: true }, async ({ db, input, staff, requestId, idempotencyKey }) =>
  setPresetPrice(db, input.presetId, input.amount, { actor: adminActor(staff), requestId, pressKey: idempotencyKey })
)
