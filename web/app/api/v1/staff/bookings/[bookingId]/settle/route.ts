import { settleBookingOutputSchema, settleBookingRouteInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { bookingPathOff, type BookingMoney } from '@/server/rules/bookings/booking-switch'
import { settleBooking } from '@/server/rules/bookings/settle'
import { createStripeClient, ORDER_STRIPE_LIMITS } from '@/server/stripe/client'

/** How the settle moves money, from what the screen sent (the switch is asked before anything is read). */
function settleMoney(method: string | undefined): BookingMoney {
  if (method === 'reader') return 'reader'
  if (method === 'card') return 'card'
  return 'cash'
}

/**
 * W19 (D-plan 1.4, 4.2, 4.7): settleLapsedBooking. A payment-needed booking is paid at seat 1's stored price and goes
 * back to confirmed: C1 in one transaction, then the saved card (charged once, then C2 or the undo) or the reader's
 * intent (pending-first; the screen collects, then the flow routes finish or cancel it). Refusals, a decline and a held
 * payment (Q35) are errors whose details carry the old reason and words. Any active staff member, as before. Gated by
 * the switch first (W17: `booking_changes`; the card also `saved_card`; the reader `reader_flows` and `reader`).
 * Idempotent: the same key gets the same answer, and never charges twice.
 */
export const POST = defineRoute(
  { auth: 'staff', input: settleBookingRouteInputSchema, output: settleBookingOutputSchema, idempotent: true },
  async ({ db, input, staff, requestId, startedAt }) => {
    const off = bookingPathOff(settleMoney(input.payment?.method), process.env.ORDER_SWITCH)
    if (off) throw off
    const { bookingId, ...body } = input
    return settleBooking(db, bookingId, body, {
      actor: { type: 'staff', id: staff.id },
      requestId,
      startedAt,
      stripe: () => createStripeClient(undefined, ORDER_STRIPE_LIMITS),
    })
  }
)
