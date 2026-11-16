export interface GiftCardRedemptionRow {
  id: string
  gift_card_id: string
  order_id: string | null
  booking_id: string | null
  amount_used: string
  redeemed_at: string
}

export interface GetGiftCardRedemptionsParams {
  giftCardId: string
}

export default async function getGiftCardRedemptions(
  req: { params: GetGiftCardRedemptionsParams }
): Promise<GiftCardRedemptionRow[]> {
  const { giftCardId } = req.params

  const result = await paddockData.query<GiftCardRedemptionRow>(
    `SELECT * FROM gift_card_redemptions WHERE gift_card_id = $1 ORDER BY redeemed_at DESC`,
    [giftCardId]
  )

  return result.data
}
