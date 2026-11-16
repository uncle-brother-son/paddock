import { requireStaffId, resolveStaffId } from './shared/resolveStaffId'

export interface SetGiftCardPickedUpParams {
  giftCardId: string
  pickedUp: boolean
}

export interface SetGiftCardPickedUpResult {
  updated: boolean
  reason?: 'not_found' | 'not_pickup_fulfillment'
  giftCard?: Record<string, unknown>
}

export default async function setGiftCardPickedUp(
  req: { params: SetGiftCardPickedUpParams; user: User }
): Promise<SetGiftCardPickedUpResult> {
  // Refuses an inactive account before anything happens.
  await resolveStaffId(req.user.email)
  const { giftCardId, pickedUp } = req.params

  const lookup = await paddockData.query<{ fulfillment_method: string }>(
    'SELECT fulfillment_method FROM gift_cards WHERE id = $1',
    [giftCardId]
  )
  const card = lookup.data[0]
  if (!card) {
    return { updated: false, reason: 'not_found' }
  }
  if (card.fulfillment_method !== 'pickup') {
    return { updated: false, reason: 'not_pickup_fulfillment' }
  }

  if (pickedUp) {
    const staffId = await requireStaffId(req.user.email)
    const result = await paddockData.query(
      `UPDATE gift_cards
       SET picked_up = true, picked_up_at = now(), picked_up_by = $1, updated_at = now()
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
     SET picked_up = false, picked_up_at = NULL, picked_up_by = NULL, updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [giftCardId]
  )
  const row = result.data[0]
  if (!row) throw new Error('The gift card was updated but could not be read back.')
  return { updated: true, giftCard: row }
}
