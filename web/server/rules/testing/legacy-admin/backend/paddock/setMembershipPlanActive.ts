import { requireCanManagePricing } from './shared/pricingStaff'
import { toggleItemActive } from './shared/toggleItemActive'

export interface SetMembershipPlanActiveParams {
  planId: string
  active: boolean
}

export default async function setMembershipPlanActive(req: { params: SetMembershipPlanActiveParams; user: User }) {
  // Changing the catalogue needs Manage pricing (Wayne, 27 Oct) — anyone can sell, not edit.
  await requireCanManagePricing(req.user.email)
  const { planId, active } = req.params
  const item = await toggleItemActive('membership_plan', planId, active)
  return { id: item.id, active: item.active }
}
