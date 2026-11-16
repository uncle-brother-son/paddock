export interface GiftCardRow {
  id: string
  code: string
  type: 'monetary'
  original_value: string
  remaining_balance: string
  purchaser_id: string | null
  purchaser_first_name: string | null
  purchaser_last_name: string | null
  purchaser_email: string | null
  recipient_name: string | null
  recipient_email: string | null
  gift_message: string | null
  origin: 'customer_purchase' | 'issued_as_credit'
  issue_date: string
  expiry_date: string
  redeemed_at: string | null
  fulfillment_method: 'digital' | 'pickup' | 'shipping'
  picked_up: boolean
  picked_up_at: string | null
  picked_up_by: string | null
  voided: boolean | null
  shipped_at: string | null
  shipped_by: string | null
  created_at: string
  updated_at: string
}

export interface GetGiftCardsParams {
  search?: string
}

export default async function getGiftCards(req: { params?: GetGiftCardsParams }): Promise<GiftCardRow[]> {
  const search = req.params?.search?.trim()

  const baseSelect = `
    SELECT
      gc.*,
      p.first_name AS purchaser_first_name,
      p.last_name AS purchaser_last_name,
      p.email AS purchaser_email
    FROM gift_cards gc
    LEFT JOIN customers p ON p.id = gc.purchaser_id
  `

  if (search) {
    const pattern = `%${search}%`
    const result = await paddockData.query<GiftCardRow>(
      `${baseSelect}
       WHERE gc.code ILIKE $1
          OR gc.recipient_name ILIKE $2
          OR gc.recipient_email ILIKE $3
          OR p.first_name ILIKE $4
          OR p.last_name ILIKE $5
          OR p.email ILIKE $6
       ORDER BY gc.created_at DESC`,
      [pattern, pattern, pattern, pattern, pattern, pattern]
    )
    return result.data
  }

  const result = await paddockData.query<GiftCardRow>(`${baseSelect} ORDER BY gc.created_at DESC`)
  return result.data
}
