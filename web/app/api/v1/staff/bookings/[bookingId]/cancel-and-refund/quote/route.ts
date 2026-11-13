import { cancelQuoteRouteInputSchema, cancelQuoteSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { quoteCancel } from '@/server/rules/bookings/cancel'

/**
 * W23 (D-plan 1.6, 4.6, 4.7): the Cancel & Refund dialog's first call (and again when its ticks change). What
 * cancelling gives back: the booking's own money (price paid, money still owed included), the ticked paid add-ons,
 * where it can go (the card whenever card money is left, Q37) and what a press would be refused with now (`blocked`).
 * A read: any active staff member, never gated by the switch, never refused for an open payment or refund. W23a:
 * `clubCancelled` (Block Session, Block Day) shows the whole amount inside 24 hours too.
 */
export const POST = defineRoute(
  { auth: 'staff', input: cancelQuoteRouteInputSchema, output: cancelQuoteSchema },
  async ({ db, input }) => quoteCancel(db, 'cancel', input.bookingId, input.addonLineIds, input.clubCancelled === true)
)
