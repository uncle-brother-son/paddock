import { requireCanManagePricing } from './shared/pricingStaff'

export interface SetProductVariantDetailsParams {
  variantId: string
  size: string | null
  sku: string | null
}

export default async function setProductVariantDetails(
  req: { params: SetProductVariantDetailsParams; user: User }
) {
  // Changing the catalogue needs Manage pricing (Wayne, 27 Oct) — anyone can sell, not edit.
  await requireCanManagePricing(req.user.email)
  const { variantId, size, sku } = req.params

  const result = await paddockData.query(
    'UPDATE product_variants SET size = $1, sku = $2, updated_at = now() WHERE id = $3 RETURNING id, size, sku',
    [size, sku, variantId]
  )
  return result.data[0] ?? null
}
