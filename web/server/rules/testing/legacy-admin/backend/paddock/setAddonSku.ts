import { requireCanManagePricing } from './shared/pricingStaff'

export interface SetAddonSkuParams {
  addonId: string
  sku: string
}

export default async function setAddonSku(req: { params: SetAddonSkuParams; user: User }) {
  // The add-on edit dialog is Manage-pricing only (its Save is gated), so the server matches.
  await requireCanManagePricing(req.user.email)
  const { addonId, sku } = req.params

  const result = await paddockData.query(
    'UPDATE addons SET sku = $1, updated_at = now() WHERE id = $2 RETURNING id, sku',
    [sku.trim() || null, addonId]
  )
  return result.data[0] ?? null
}
