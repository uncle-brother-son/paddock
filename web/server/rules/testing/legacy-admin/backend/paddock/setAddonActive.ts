import { requireCanManagePricing } from './shared/pricingStaff'
import { toggleItemActive } from './shared/toggleItemActive'

export interface SetAddonActiveParams {
  addonId: string
  active: boolean
}

export default async function setAddonActive(req: { params: SetAddonActiveParams; user: User }) {
  // Changing the catalogue needs Manage pricing (Wayne, 27 Oct) — anyone can sell, not edit.
  await requireCanManagePricing(req.user.email)
  const { addonId, active } = req.params
  const item = await toggleItemActive('addon', addonId, active)
  return { id: item.id, active: item.active }
}
