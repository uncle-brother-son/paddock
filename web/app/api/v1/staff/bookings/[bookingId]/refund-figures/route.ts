import { bookingRefundFiguresRouteInputSchema, bookingRefundFiguresRouteOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { ApiError } from '@/server/http/errors'
import { REFUND_WORDS } from '@/server/rules/bookings/failure-messages'
import { loadRefundFigures } from '@/server/rules/bookings/money-left'

/**
 * W21 (D-plan 1.11): getBookingRefundFigures. What the Part refund and Refund the rest dialogs show, from the same code
 * the refund routes check (money-left.ts), with Q26's `cashLeft` and `paidLine` (what is left to refund, W21a). A
 * read: any active staff member, as before, and never gated by the switch.
 */
export const GET = defineRoute(
  { auth: 'staff', input: bookingRefundFiguresRouteInputSchema, output: bookingRefundFiguresRouteOutputSchema },
  async ({ db, input }) => {
    const figures = await loadRefundFigures(db, input.bookingId)
    if (!figures) throw new ApiError('NOT_FOUND', REFUND_WORDS.bookingNotFound, { details: { reason: 'booking_not_found', message: REFUND_WORDS.bookingNotFound, action: 'refund' } })
    return figures
  }
)
