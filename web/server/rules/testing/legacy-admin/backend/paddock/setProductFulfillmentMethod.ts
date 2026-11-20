import { requireCanManagePricing } from './shared/pricingStaff'

export type ProductFulfillmentMethod = 'shipping' | 'pickup' | 'both'
// The runtime globals (paddockData) are typed by the generated declarations in
// backend/resources/; globals.ts is now an empty module, kept so this import stays valid.
import './globals'

const VALID_FULFILLMENT_METHODS: ProductFulfillmentMethod[] = ['shipping', 'pickup', 'both']

export interface SetProductFulfillmentMethodParams {
  productId: string
  fulfillmentMethod: ProductFulfillmentMethod
}

// Direct Postgres write — fulfillment method has no Stripe counterpart. Shipping cost and
// parcel details (weight/dimensions) are handled manually by staff with the courier at the
// time of shipment and are not tracked in this system. (Permission: open to all staff.)
export default async function setProductFulfillmentMethod(
  req: { params: SetProductFulfillmentMethodParams; user: User }
) {
  // The product edit dialog is Manage-pricing only (its Save is gated), so the server matches.
  await requireCanManagePricing(req.user.email)
  const { productId, fulfillmentMethod } = req.params

  if (!VALID_FULFILLMENT_METHODS.includes(fulfillmentMethod)) {
    throw new Error(`Invalid fulfillment method: ${fulfillmentMethod}`)
  }

  const result = await paddockData.query(
    'UPDATE products SET fulfillment_method = $1, updated_at = now() WHERE id = $2 RETURNING id, fulfillment_method',
    [fulfillmentMethod, productId]
  )
  return result.data[0] ?? null
}
