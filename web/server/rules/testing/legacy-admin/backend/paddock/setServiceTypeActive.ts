import { requireCanManagePricing } from './shared/pricingStaff'
import { toggleItemActive } from './shared/toggleItemActive'

export interface SetServiceTypeActiveParams {
  serviceTypeId: string
  active: boolean
}

export default async function setServiceTypeActive(req: { params: SetServiceTypeActiveParams; user: User }) {
  // Changing the catalogue needs Manage pricing (Wayne, 27 Oct) — anyone can sell, not edit.
  await requireCanManagePricing(req.user.email)
  const { serviceTypeId, active } = req.params
  const item = await toggleItemActive('service_type', serviceTypeId, active)
  return { id: item.id, active: item.active }
}
