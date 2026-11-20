import { requireCanManagePricing } from './shared/pricingStaff'
import { toggleItemActive } from './shared/toggleItemActive'

export interface SetSessionPassActiveParams {
  passTypeId: string
  active: boolean
}

export default async function setSessionPassActive(req: { params: SetSessionPassActiveParams; user: User }) {
  // Changing the catalogue needs Manage pricing (Wayne, 27 Oct) — anyone can sell, not edit.
  await requireCanManagePricing(req.user.email)
  const { passTypeId, active } = req.params
  const item = await toggleItemActive('session_pass_type', passTypeId, active)
  return { id: item.id, active: item.active }
}
