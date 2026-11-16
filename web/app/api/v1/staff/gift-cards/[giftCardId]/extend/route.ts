import { extendGiftCardOutputSchema, extendGiftCardRouteInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { extendGiftCard } from '@/server/rules/gift-cards/admin'

/**
 * W38 (F-plan 4.6; bugs FB13 to FB15; Wayne's Q46 and Q47): extendGiftCardExpiry, Extend / Reactivate on the Gift
 * Cards page. One transaction under the card's lock: a card voided by its order's refund, or by a move to store
 * credit, is refused with the reason (Q46); an expired card counts the months from today, one in date from its expiry
 * (Q47); a `gift_card.extended` audit row with the old and new date and who. Issue refunds, refused by the rule in
 * the old words. No Stripe, so no switch kind. Idempotent: the same press key gets the first press's answer, so a
 * lost answer pressed again never adds the months twice.
 */
export const POST = defineRoute(
  { auth: 'staff', input: extendGiftCardRouteInputSchema, output: extendGiftCardOutputSchema, idempotent: true },
  async ({ db, input, staff, requestId }) => {
    const { giftCardId, ...body } = input
    return extendGiftCard(db, giftCardId, body, { actor: { type: 'staff', id: staff.id, canIssueRefunds: staff.canIssueRefunds }, requestId })
  }
)
