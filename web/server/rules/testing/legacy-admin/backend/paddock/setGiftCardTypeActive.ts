import { requireCanManagePricing } from './shared/pricingStaff'
import { toggleItemActive } from './shared/toggleItemActive'

export interface SetGiftCardTypeActiveParams {
  giftCardTypeId: string
  active: boolean
}

export default async function setGiftCardTypeActive(req: { params: SetGiftCardTypeActiveParams; user: User }) {
  // Changing the catalogue needs Manage pricing (Wayne, 27 Oct) — anyone can sell, not edit.
  await requireCanManagePricing(req.user.email)
  const { giftCardTypeId, active } = req.params
  const item = await toggleItemActive('gift_card_type', giftCardTypeId, active)
  return { id: item.id, active: item.active }
}
