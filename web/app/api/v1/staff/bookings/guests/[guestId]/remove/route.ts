import { removeGuestOutputSchema, removeGuestRouteInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { bookingPathOff } from '@/server/rules/bookings/booking-switch'
import { removeGuest } from '@/server/rules/bookings/remove-guest'
import { createStripeClient, ORDER_STRIPE_LIMITS } from '@/server/stripe/client'

/**
 * W22 (D-plan 1.5, 4.3, 4.7): removeBookingGuest's second call, with the refund staff confirmed (half a penny, Q18).
 * R1 in one transaction (the guest deleted, the place released, the refund planned and claimed), then each card part
 * once under `<claimId>:refund:<orderId>`, then R2 (server/rules/bookings/remove-guest.ts, refunds.ts). Any active
 * staff member; Issue refunds when money goes back (checked in R1, with the old reason). Gated by the switch when money
 * goes back (`booking_changes`); a removal with nothing back moves no money. Idempotent: the same key gets the same
 * answer, and never refunds twice.
 */
export const POST = defineRoute(
  { auth: 'staff', input: removeGuestRouteInputSchema, output: removeGuestOutputSchema, idempotent: true },
  async ({ db, input, staff, requestId, startedAt }) => {
    const money = (input.confirmedRefundAmount ?? 0) > 0 ? (input.refundMethod === 'card' ? 'card' : 'cash') : 'none'
    const off = bookingPathOff(money, process.env.ORDER_SWITCH, 'out')
    if (off) throw off
    const { guestId, ...body } = input
    return removeGuest(db, guestId, body, {
      actor: { type: 'staff', id: staff.id },
      requestId,
      startedAt,
      canIssueRefunds: staff.canIssueRefunds,
      stripe: () => createStripeClient(undefined, ORDER_STRIPE_LIMITS),
    })
  }
)
