import { catalogGiftCardTypeDetailsRouteInputSchema, catalogGiftCardTypeDetailsRouteOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { ApiError } from '@/server/http/errors'
import { adminActor } from '@/server/rules/admin/refusal'
import { setCustomAmounts, setGiftCardTypeExpiry } from '@/server/rules/catalog/passes-gift-cards'

/**
 * Brief W56 (G-plan 4.3; bug GB10; lead call L11; W53 review L7; W54a's stale-page rule):
 * setGiftCardTypeCustomAmountSettings (`field: 'custom_amounts'`, with the type's stamp) and setGiftCardTypeExpiry
 * (`field: 'expiry_months'`). Manage pricing; one transaction under the type's lock, with a `catalog.details_set`
 * audit row. Idempotent: each press has its own key.
 */
export const POST = defineRoute({ auth: 'staff', input: catalogGiftCardTypeDetailsRouteInputSchema, output: catalogGiftCardTypeDetailsRouteOutputSchema, idempotent: true }, async ({ db, input, staff, requestId, idempotencyKey }) => {
  const options = { actor: adminActor(staff), requestId, pressKey: idempotencyKey }
  if (input.field === 'expiry_months') return setGiftCardTypeExpiry(db, input.giftCardTypeId, input.value, options)
  if (input.field === 'custom_amounts') return setCustomAmounts(db, { giftCardTypeId: input.giftCardTypeId, customAmountEnabled: input.customAmountEnabled, customAmountMin: input.customAmountMin, customAmountMax: input.customAmountMax, stamp: input.stamp }, options)
  throw new ApiError('VALIDATION', `Invalid field: ${String(input.field)}`, { field: 'field' })
})
