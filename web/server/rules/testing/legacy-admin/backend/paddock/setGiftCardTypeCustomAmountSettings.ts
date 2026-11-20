import { requireCanManagePricing } from './shared/pricingStaff'

export interface SetGiftCardTypeCustomAmountSettingsParams {
  giftCardTypeId: string
  customAmountEnabled: boolean
  /** Required (and validated min <= max) when customAmountEnabled is true. */
  customAmountMin?: number
  customAmountMax?: number
}

// Direct Postgres write — these fields are purely a checkout-side validation rule, with no
// Stripe counterpart (unlike price, which always goes through the deployed backend's Stripe
// integration). Mirrors setServiceTypeCapacityInfo.ts's pattern for the same reason.
export default async function setGiftCardTypeCustomAmountSettings(
  req: { params: SetGiftCardTypeCustomAmountSettingsParams; user: User }
) {
  // Custom-amount bounds are checkout pricing rules — restricted to staff with can_manage_pricing.
  await requireCanManagePricing(req.user.email)
  const { giftCardTypeId, customAmountEnabled, customAmountMin, customAmountMax } = req.params

  if (!giftCardTypeId) {
    throw new Error('giftCardTypeId is required')
  }
  if (customAmountEnabled) {
    if (!Number.isFinite(customAmountMin) || (customAmountMin as number) < 0) {
      throw new Error('customAmountMin must be a non-negative number when custom amounts are enabled')
    }
    if (!Number.isFinite(customAmountMax) || (customAmountMax as number) <= 0) {
      throw new Error('customAmountMax must be a positive number when custom amounts are enabled')
    }
    if ((customAmountMin as number) > (customAmountMax as number)) {
      throw new Error('customAmountMin cannot be greater than customAmountMax')
    }
  }

  const result = await paddockData.query(
    `UPDATE gift_card_types
     SET custom_amount_enabled = $1, custom_amount_min = $2, custom_amount_max = $3, updated_at = now()
     WHERE id = $4
     RETURNING id, custom_amount_enabled, custom_amount_min, custom_amount_max`,
    [
      customAmountEnabled,
      customAmountEnabled ? customAmountMin : null,
      customAmountEnabled ? customAmountMax : null,
      giftCardTypeId,
    ]
  )
  return result.data[0] ?? null
}
