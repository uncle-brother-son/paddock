import { partRefundRouteInputSchema, refundBookingOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { bookingPathOff } from '@/server/rules/bookings/booking-switch'
import { partRefund } from '@/server/rules/bookings/refunds'
import { createStripeClient, ORDER_STRIPE_LIMITS } from '@/server/stripe/client'

/**
 * W21 (D-plan 1.6, 4.3): refundBooking's Part refund. Gives back some of what is left on the booking and keeps it: to
 * the original card (newest order first, the rest to store credit), to store credit, or (Q26) in cash handed over by
 * the staff member, capped at the cash recorded on the booking's orders. R1 in one transaction, then each card part
 * once under `<claimId>:refund:<orderId>`, then R2 (server/rules/bookings/refunds.ts). A refusal before anything moved
 * is an error whose details carry the old reason and words (and the new figures); a card refund with no clear answer
 * is held for reconcile (Q35) and answered as data. Issue refunds. Gated by the switch first (`booking_changes`).
 * Idempotent: the same key gets the same answer, and never sends a refund twice.
 */
export const POST = defineRoute(
  { auth: 'staff', permission: 'issueRefunds', input: partRefundRouteInputSchema, output: refundBookingOutputSchema, idempotent: true },
  async ({ db, input, staff, requestId, startedAt }) => {
    const off = bookingPathOff(input.refundMethod === 'card' ? 'card' : 'cash', process.env.ORDER_SWITCH, 'out')
    if (off) throw off
    const { bookingId, ...body } = input
    return partRefund(db, bookingId, body, {
      actor: { type: 'staff', id: staff.id },
      requestId,
      startedAt,
      stripe: () => createStripeClient(undefined, ORDER_STRIPE_LIMITS),
    })
  }
)
