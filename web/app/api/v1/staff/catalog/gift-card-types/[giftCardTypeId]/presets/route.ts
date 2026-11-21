import { catalogPresetCreateRouteInputSchema, catalogPresetRouteOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { createPreset } from '@/server/rules/catalog/passes-gift-cards'

/**
 * Brief W56 (G-plan 4.3; lead call L2; W53 review L7): createGiftCardPreset. Manage pricing; the amount pounds and
 * pence; one transaction under the type's lock: the preset, with no Stripe price, and a `catalog.preset_created` audit
 * row. Idempotent: the manager keeps its key after no answer.
 */
export const POST = defineRoute({ auth: 'staff', input: catalogPresetCreateRouteInputSchema, output: catalogPresetRouteOutputSchema, idempotent: true }, async ({ db, input, staff, requestId, idempotencyKey }) =>
  createPreset(db, input.giftCardTypeId, input.amount, { actor: adminActor(staff), requestId, pressKey: idempotencyKey })
)
