import { bookingRefundFiguresRouteInputSchema, bookingRefundFiguresRouteOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { ApiError } from '@/server/http/errors'
import { REFUND_WORDS } from '@/server/rules/bookings/failure-messages'
import { loadBookingLapse } from '@/server/rules/bookings/lapse-facts'
import { loadRefundFigures } from '@/server/rules/bookings/money-left'

/**
 * W21 (D-plan 1.11): getBookingRefundFigures. What the Part refund and Refund the rest dialogs show, from the same code
 * the refund routes check (money-left.ts), with Q26's `cashLeft` and `paidLine` (what is left to refund, W21a). A
 * read: any active staff member, as before, and never gated by the switch.
 * W46: and `lapse`, for a booking the lapse sweep cancelled: when and why, and what was given back, kept and left
 * owed (lapse-facts.ts). Left out for every other booking. The booking detail already calls this read (W47 shows it).
 */
export const GET = defineRoute(
  { auth: 'staff', input: bookingRefundFiguresRouteInputSchema, output: bookingRefundFiguresRouteOutputSchema },
  async ({ db, input }) => {
    const figures = await loadRefundFigures(db, input.bookingId)
    if (!figures) throw new ApiError('NOT_FOUND', REFUND_WORDS.bookingNotFound, { details: { reason: 'booking_not_found', message: REFUND_WORDS.bookingNotFound, action: 'refund' } })
    // W46: only a lapsed booking's answer has `lapse`; any other is exactly as it was.
    const lapse = await loadBookingLapse(db, input.bookingId)
    return lapse ? { ...figures, lapse } : figures
  }
)
