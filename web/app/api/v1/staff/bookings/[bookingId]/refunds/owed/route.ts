import { refundBookingOutputSchema, refundOwedRouteInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { bookingPathOff } from '@/server/rules/bookings/booking-switch'
import { refundOwed } from '@/server/rules/bookings/refunds'
import { createStripeClient, ORDER_STRIPE_LIMITS } from '@/server/stripe/client'

/**
 * W21 (D-plan 1.6, 4.3): refundBooking's Refund the rest. Gives exactly the money a failed refund left owed on the
 * booking (the amount staff confirmed, to half a penny), to the original card (the rest to store credit) or to store
 * credit, through the same pipeline as Part refund. Issue refunds. Gated by the switch (`booking_changes`). Idempotent.
 */
export const POST = defineRoute(
  { auth: 'staff', permission: 'issueRefunds', input: refundOwedRouteInputSchema, output: refundBookingOutputSchema, idempotent: true },
  async ({ db, input, staff, requestId, startedAt }) => {
    const off = bookingPathOff(input.refundMethod === 'card' ? 'card' : 'cash', process.env.ORDER_SWITCH, 'out')
    if (off) throw off
    const { bookingId, ...body } = input
    return refundOwed(db, bookingId, body, {
      actor: { type: 'staff', id: staff.id },
      requestId,
      startedAt,
      stripe: () => createStripeClient(undefined, ORDER_STRIPE_LIMITS),
    })
  }
)
