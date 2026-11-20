import { requireCanManagePricing } from './shared/pricingStaff'
import { toggleItemActive } from './shared/toggleItemActive'

export interface SetGiftCardPresetActiveParams {
  presetId: string
  active: boolean
}

export default async function setGiftCardPresetActive(req: { params: SetGiftCardPresetActiveParams; user: User }) {
  // Changing the catalogue needs Manage pricing (Wayne, 27 Oct) — anyone can sell, not edit.
  await requireCanManagePricing(req.user.email)
  const { presetId, active } = req.params
  const item = await toggleItemActive('gift_card_preset', presetId, active)
  return { id: item.id, active: item.active }
}
