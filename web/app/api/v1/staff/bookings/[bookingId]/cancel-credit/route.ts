import { cancelCreditBookingOutputSchema, cancelCreditBookingRouteInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { bookingPathOff } from '@/server/rules/bookings/booking-switch'
import { cancelCredit } from '@/server/rules/bookings/cancel'
import { createStripeClient, ORDER_STRIPE_LIMITS } from '@/server/stripe/client'

/**
 * W23 (D-plan 1.7, 3 N4, 4.4, 4.7): cancelCreditBooking: Cancel & return credit, and Cancel on a payment-needed
 * booking. The cancel, its places, a pass session, the ticked add-ons' credits and stamps in one transaction (N4); paid
 * add-ons ticked for a refund go through the refund pipeline (Issue refunds; `confirmed.addonsRefund`, Q18). Any active
 * staff member otherwise, as before. Gated by the switch only when money goes back. Idempotent. W23a: `clubCancelled`
 * (Block Session, Block Day): no 24-hour rule, the credit and add-ons back until the session starts (cancel.ts).
 */
export const POST = defineRoute(
  { auth: 'staff', input: cancelCreditBookingRouteInputSchema, output: cancelCreditBookingOutputSchema, idempotent: true },
  async ({ db, input, staff, requestId, startedAt }) => {
    const back = input.confirmed?.addonsRefund ?? 0
    const off = bookingPathOff(back > 0 ? (input.addonRefund === 'card' ? 'card' : 'cash') : 'none', process.env.ORDER_SWITCH, 'out')
    if (off) throw off
    const { bookingId, ...body } = input
    return cancelCredit(db, bookingId, body, {
      actor: { type: 'staff', id: staff.id },
      requestId,
      startedAt,
      canIssueRefunds: staff.canIssueRefunds,
      stripe: () => createStripeClient(undefined, ORDER_STRIPE_LIMITS),
    })
  }
)
