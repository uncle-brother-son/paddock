import { giftCardListInputSchema, giftCardListOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { listGiftCards } from '@/server/rules/gift-cards/admin'

/**
 * W38 (F-plan 4.6): getGiftCards, the Gift Cards page's list and New Order's gift card search: every card with its
 * purchaser, newest first; `search` matches the code, the recipient or the purchaser. Named fields. Any active staff
 * member (FB16: the old read checked nobody).
 */
export const GET = defineRoute({ auth: 'staff', input: giftCardListInputSchema, output: giftCardListOutputSchema }, async ({ db, input }) => listGiftCards(db, input.search))
