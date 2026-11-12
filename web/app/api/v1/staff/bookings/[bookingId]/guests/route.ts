import { addBookingGuestOutputSchema, addBookingGuestRouteInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { addGuestToBooking } from '@/server/rules/bookings/add-guest'
import { bookingPathOff, type BookingMoney } from '@/server/rules/bookings/booking-switch'
import { createStripeClient, ORDER_STRIPE_LIMITS } from '@/server/stripe/client'

/** How a payment moves money, from what the screen sent (asked before anything is read). */
function paymentMoney(method: string | undefined): BookingMoney {
  if (method === 'reader') return 'reader'
  if (method === 'card') return 'card'
  return 'cash'
}

/**
 * W20 (D-plan 1.3, 4.2, 4.7): addBookingGuest (a guest, add-ons, or both). With no payment and money due, the answer
 * is the Worker's figures and nothing is added (the dialog's first call); otherwise C1 in one transaction, then the
 * saved card (charged once, then C2 or the undo) or the reader's intent (pending-first; the screen collects, then the
 * flow routes finish or cancel it). Refusals, a decline and a held payment (Q35) are errors whose details carry the old
 * reason, words and figures. Any active staff member, as before; a sent add-on price counts only with Manage pricing.
 * Gated by the switch: a payment before anything is read (W17: `booking_changes`; the card also `saved_card`; the
 * reader `reader_flows` and `reader`); an add with nothing to pay after the quote (`booking_changes`), so a quote is
 * never refused. Idempotent: the same key gets the same answer, and never charges or adds twice.
 */
export const POST = defineRoute(
  { auth: 'staff', input: addBookingGuestRouteInputSchema, output: addBookingGuestOutputSchema, idempotent: true },
  async ({ db, input, staff, requestId, startedAt }) => {
    if (input.payment) {
      const off = bookingPathOff(paymentMoney(input.payment.method), process.env.ORDER_SWITCH)
      if (off) throw off
    }
    const { bookingId, ...body } = input
    return addGuestToBooking(db, bookingId, body, {
      actor: { type: 'staff', id: staff.id },
      requestId,
      startedAt,
      canManagePricing: staff.canManagePricing,
      switchValue: process.env.ORDER_SWITCH,
      stripe: () => createStripeClient(undefined, ORDER_STRIPE_LIMITS),
    })
  }
)
