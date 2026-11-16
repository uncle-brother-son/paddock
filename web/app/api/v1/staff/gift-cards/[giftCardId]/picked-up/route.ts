import { giftCardFlagOutputSchema, setGiftCardPickedUpRouteInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { setGiftCardPickedUp } from '@/server/rules/gift-cards/admin'

/**
 * W38 (F-plan 4.6; lead call L2; bug FB24): setGiftCardPickedUp, Mark Collected and its Undo on the Gift Cards page
 * and the order's line items. The card must be one to pick up. The flag, who and when (or cleared), and a
 * `gift_card.picked_up` audit row, in one transaction under the card's lock. Any active staff member, setting or
 * clearing: someone with no staff record is refused before anything is read. Idempotent on the press's key.
 */
export const POST = defineRoute(
  { auth: 'staff', input: setGiftCardPickedUpRouteInputSchema, output: giftCardFlagOutputSchema, idempotent: true },
  async ({ db, input, staff, requestId }) => setGiftCardPickedUp(db, input.giftCardId, input.pickedUp, { actor: { type: 'staff', id: staff.id, canIssueRefunds: staff.canIssueRefunds }, requestId })
)
