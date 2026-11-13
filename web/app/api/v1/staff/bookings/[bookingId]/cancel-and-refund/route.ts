import { cancelAndRefundOutputSchema, cancelAndRefundRouteInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { bookingPathOff } from '@/server/rules/bookings/booking-switch'
import { cancelAndRefund } from '@/server/rules/bookings/cancel'
import { createStripeClient, ORDER_STRIPE_LIMITS } from '@/server/stripe/client'

/**
 * W23 (D-plan 1.6, 4.3, 4.7): refundBooking's Cancel & Refund, with the figures staff confirmed (`confirmed.refund`,
 * `confirmed.addonsRefund`, half a penny each, Q18). R1 in one transaction (the booking cancelled, its places released,
 * the ticked add-ons claimed with their credits back, the refund planned and claimed), then each card part once under
 * `<claimId>:refund:<orderId>` (one per order, seat and add-ons together), then R2 (server/rules/bookings/cancel.ts,
 * refunds.ts). Issue refunds, as before. Gated by the switch when money goes back (`booking_changes`). Idempotent: the
 * same key gets the same answer, and never cancels or refunds twice. W23a: `clubCancelled` (Block Session, Block Day):
 * no 24-hour rule, everything back until the session starts (cancel.ts).
 */
export const POST = defineRoute(
  { auth: 'staff', permission: 'issueRefunds', input: cancelAndRefundRouteInputSchema, output: cancelAndRefundOutputSchema, idempotent: true },
  async ({ db, input, staff, requestId, startedAt }) => {
    const back = (input.confirmed?.refund ?? 0) + (input.confirmed?.addonsRefund ?? 0)
    const off = bookingPathOff(back > 0 ? (input.refundMethod === 'card' ? 'card' : 'cash') : 'none', process.env.ORDER_SWITCH, 'out')
    if (off) throw off
    const { bookingId, ...body } = input
    return cancelAndRefund(db, bookingId, body, {
      actor: { type: 'staff', id: staff.id },
      requestId,
      startedAt,
      canIssueRefunds: staff.canIssueRefunds,
      stripe: () => createStripeClient(undefined, ORDER_STRIPE_LIMITS),
    })
  }
)
