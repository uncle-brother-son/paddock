import { getStaffAccessRow } from './shared/staffAccess'

export interface ExtendGiftCardExpiryParams {
  giftCardId: string
  /** Whole number of months to push expiry_date forward by, starting from the card's CURRENT
   *  stored expiry_date \u2014 not from today. Extending an already-expired card resumes from where
   *  it left off rather than resetting the clock, which matters if a card sat expired for a
   *  while before staff got to it. */
  extendByMonths: number
}

export interface ExtendGiftCardExpiryResult {
  updated: boolean
  reason?: 'gift_card_not_found' | 'invalid_months' | 'permission_denied'
  message?: string
  giftCard?: { id: string; expiry_date: string; voided: boolean | null }
}

/**
 * Staff-facing "extend / reactivate" action on an already-issued gift card. Always un-voids the
 * card in the same update, regardless of why it was voided (expired naturally, or voided by
 * refundOrder.ts when its originating order was refunded) \u2014 this is deliberately not just a
 * date push on an already-active card; it restores full usability unconditionally.
 */
export default async function extendGiftCardExpiry(
  req: { params: ExtendGiftCardExpiryParams; user: User }
): Promise<ExtendGiftCardExpiryResult> {
  const { giftCardId, extendByMonths } = req.params

  // Extending/reactivating (un-voiding) a gift card creates spendable value — restricted to
  // staff with can_issue_refunds, like the other money-back-to-customer actions.
  const staffAccess = await getStaffAccessRow(req.user.email)
  if (!staffAccess?.can_issue_refunds) {
    return {
      updated: false,
      reason: 'permission_denied',
      message: 'Needs the Issue refunds permission to extend or re-activate a gift card.',
    }
  }

  if (!Number.isInteger(extendByMonths) || extendByMonths <= 0) {
    return { updated: false, reason: 'invalid_months' }
  }

  const result = await paddockData.query<{ id: string; expiry_date: string; voided: boolean | null }>(
    `UPDATE gift_cards
     SET expiry_date = (expiry_date + ($1 || ' months')::interval)::date,
         voided = false,
         updated_at = now()
     WHERE id = $2
     RETURNING id, expiry_date, voided`,
    [extendByMonths, giftCardId]
  )

  const card = result.data[0]
  if (!card) {
    return { updated: false, reason: 'gift_card_not_found' }
  }
  return { updated: true, giftCard: card }
}
