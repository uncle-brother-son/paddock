import { requireCanManagePricing } from './shared/pricingStaff'
import { toggleItemActive } from './shared/toggleItemActive'

export interface SetProductActiveParams {
  productId: string
  active: boolean
}

export default async function setProductActive(req: { params: SetProductActiveParams; user: User }) {
  // Changing the catalogue needs Manage pricing (Wayne, 27 Oct) — anyone can sell, not edit.
  await requireCanManagePricing(req.user.email)
  const { productId, active } = req.params
  const item = await toggleItemActive('product', productId, active)
  return { id: item.id, active: item.active }
}
