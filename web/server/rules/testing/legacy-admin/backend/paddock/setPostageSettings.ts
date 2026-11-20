import { requireCanManagePricing } from './shared/pricingStaff'

export interface SetPostageSettingsParams {
  standardPrice: number
  expressPrice: number
  freeShippingThreshold: number
}

export interface SetPostageSettingsResult {
  standardPrice: number
  expressPrice: number
  freeShippingThreshold: number
}

/** Staff-facing postage settings editor — restricted to staff with can_manage_pricing. */
export default async function setPostageSettings(
  req: { params: SetPostageSettingsParams; user: User }
): Promise<SetPostageSettingsResult> {
  await requireCanManagePricing(req.user.email)
  const { standardPrice, expressPrice, freeShippingThreshold } = req.params

  if (!Number.isFinite(standardPrice) || standardPrice < 0) {
    throw new Error('Standard price must be a non-negative number.')
  }
  if (!Number.isFinite(expressPrice) || expressPrice < 0) {
    throw new Error('Express price must be a non-negative number.')
  }
  if (!Number.isFinite(freeShippingThreshold) || freeShippingThreshold < 0) {
    throw new Error('Free-shipping threshold must be a non-negative number (0 = no free shipping).')
  }

  const result = await paddockData.query<{ standard_price: string; express_price: string; free_shipping_threshold: string }>(
    `UPDATE postage_settings
     SET standard_price = $1, express_price = $2, free_shipping_threshold = $3, updated_at = now()
     WHERE id = true
     RETURNING standard_price, express_price, free_shipping_threshold`,
    [standardPrice, expressPrice, freeShippingThreshold]
  )
  if (!result.data[0]) {
    throw new Error(
      'Postage settings have not been configured yet. Run the postage_settings migration (CREATE TABLE + seed row) to set them up.'
    )
  }
  return {
    standardPrice: Number.parseFloat(result.data[0].standard_price),
    expressPrice: Number.parseFloat(result.data[0].express_price),
    freeShippingThreshold: Number.parseFloat(result.data[0].free_shipping_threshold),
  }
}
