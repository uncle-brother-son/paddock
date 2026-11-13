import { moveQuoteRouteInputSchema, moveQuoteSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { quoteMove } from '@/server/rules/bookings/move'

/**
 * W24 (D-plan 1.2, 4.6, 4.7): the Move dialog's first call. The old priceImpact (the seats' differences, what is due or
 * goes back), what a press would be refused with now (`blocked`: a payment still being taken, a refund still being
 * checked), and for a cheaper move where the refund can go (Q37). Refused, with the old reason and words, for what the
 * old first call refused (the booking, the session, a promo, the band, an overlap) and, new, for a second booking on
 * the day (N1). A read: any active staff member, never gated by the switch.
 */
export const POST = defineRoute(
  { auth: 'staff', input: moveQuoteRouteInputSchema, output: moveQuoteSchema },
  async ({ db, input }) => quoteMove(db, input.bookingId, input.newSessionId)
)
