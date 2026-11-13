import { moveBookingOutputSchema, moveBookingRouteInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { bookingPathOff, type BookingMoney } from '@/server/rules/bookings/booking-switch'
import { moveBooking } from '@/server/rules/bookings/move'
import { createStripeClient, ORDER_STRIPE_LIMITS } from '@/server/stripe/client'

/** How a payment moves money, from what the screen sent (asked before anything is read). */
function paymentMoney(method: string | undefined): BookingMoney {
  if (method === 'reader') return 'reader'
  if (method === 'card') return 'card'
  return 'cash'
}

/**
 * W24 (D-plan 1.2, 4.2, 4.3, 4.7): moveBooking's press, with the figures staff confirmed (`figures.amountDue`, signed;
 * `toCollect`; Q18, half a penny). One transaction moves the booking (both sessions' places, the seats, a released
 * credit or pass session) with its money: a dearer move on the card or reader is a flow (the saved card charged once,
 * then C2 or the undo; the reader's intent for the screen to collect), a cheaper move to the card is a refund claim
 * (each card part once, then R2; the first refused undoes the move) (server/rules/bookings/move.ts). Without
 * `confirmed`, the quote and nothing moved. Any active staff member; Issue refunds for a move that gives money back,
 * checked by the rule before anything changes. Gated by the switch before anything is read: a payment (W17:
 * `booking_changes`; the card also `saved_card`; the reader `reader_flows` and `reader`), money back
 * (`booking_changes`). Idempotent: the same key gets the same answer, and never moves, charges or refunds twice.
 */
export const POST = defineRoute(
  { auth: 'staff', input: moveBookingRouteInputSchema, output: moveBookingOutputSchema, idempotent: true },
  async ({ db, input, staff, requestId, startedAt }) => {
    if (input.confirmed === true) {
      const money: BookingMoney = input.payment ? paymentMoney(input.payment.method) : input.refundMethod === 'card' ? 'card' : input.refundMethod ? 'cash' : 'none'
      const off = bookingPathOff(money, process.env.ORDER_SWITCH, input.payment ? 'in' : 'out')
      if (off) throw off
    }
    const { bookingId, ...body } = input
    return moveBooking(db, bookingId, body, {
      actor: { type: 'staff', id: staff.id },
      requestId,
      startedAt,
      canIssueRefunds: staff.canIssueRefunds,
      stripe: () => createStripeClient(undefined, ORDER_STRIPE_LIMITS),
    })
  }
)
