import { giftCardRedemptionsInputSchema, giftCardRedemptionsOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { listGiftCardRedemptions } from '@/server/rules/gift-cards/admin'

/**
 * W38 (F-plan 4.6): getGiftCardRedemptions, the history under a card on the Gift Cards page: its uses, newest first.
 * Named fields. Any active staff member (FB16: the old read checked nobody).
 */
export const GET = defineRoute(
  { auth: 'staff', input: giftCardRedemptionsInputSchema, output: giftCardRedemptionsOutputSchema },
  async ({ db, input }) => listGiftCardRedemptions(db, input.giftCardId)
)
