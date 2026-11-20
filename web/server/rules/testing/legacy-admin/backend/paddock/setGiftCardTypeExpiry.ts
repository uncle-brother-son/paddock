import { requireCanManagePricing } from './shared/pricingStaff'

export interface SetGiftCardTypeExpiryParams {
  giftCardTypeId: string
  expiryMonths: number
}

/** Mirrors setSessionPassExpiry.ts exactly \u2014 same field shape, same update pattern. Only
 *  changes the catalog type's own expiry window; already-issued gift cards keep whatever
 *  expiry_date was set for them at issuance time (see createOrder.ts). */
export default async function setGiftCardTypeExpiry(req: { params: SetGiftCardTypeExpiryParams; user: User }) {
  // Changing the catalogue needs Manage pricing (Wayne, 27 Oct) — anyone can sell, not edit.
  await requireCanManagePricing(req.user.email)
  const { giftCardTypeId, expiryMonths } = req.params
  const result = await paddockData.query(
    'UPDATE gift_card_types SET expiry_months = $1, updated_at = now() WHERE id = $2 RETURNING id, expiry_months',
    [expiryMonths, giftCardTypeId]
  )
  return result.data[0] ?? null
}
