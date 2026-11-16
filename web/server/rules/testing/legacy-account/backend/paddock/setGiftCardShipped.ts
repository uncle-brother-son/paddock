import { requireStaffId, resolveStaffId } from './shared/resolveStaffId'

export interface SetGiftCardShippedParams {
  giftCardId: string
  shipped: boolean
}

export interface SetGiftCardShippedResult {
  updated: boolean
  reason?: 'not_found' | 'not_shipping_fulfillment'
  giftCard?: Record<string, unknown>
}

export default async function setGiftCardShipped(
  req: { params: SetGiftCardShippedParams; user: User }
): Promise<SetGiftCardShippedResult> {
  // Refuses an inactive account before anything happens.
  await resolveStaffId(req.user.email)
  const { giftCardId, shipped } = req.params

  const lookup = await paddockData.query<{ fulfillment_method: string }>(
    'SELECT fulfillment_method FROM gift_cards WHERE id = $1',
    [giftCardId]
  )
  const card = lookup.data[0]
  if (!card) {
    return { updated: false, reason: 'not_found' }
  }
  if (card.fulfillment_method !== 'shipping') {
    return { updated: false, reason: 'not_shipping_fulfillment' }
  }

  if (shipped) {
    const staffId = await requireStaffId(req.user.email)
    const result = await paddockData.query(
      `UPDATE gift_cards
       SET shipped_at = now(), shipped_by = $1, updated_at = now()
       WHERE id = $2
       RETURNING *`,
      [staffId, giftCardId]
    )
    const row = result.data[0]
    if (!row) throw new Error('The gift card was updated but could not be read back.')
    return { updated: true, giftCard: row }
  }

  const result = await paddockData.query(
    `UPDATE gift_cards
     SET shipped_at = NULL, shipped_by = NULL, updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [giftCardId]
  )
  const row = result.data[0]
  if (!row) throw new Error('The gift card was updated but could not be read back.')
  return { updated: true, giftCard: row }
}
