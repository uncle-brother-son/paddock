import { owedArrivedRouteInputSchema, refundBookingOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { owedArrived } from '@/server/rules/bookings/refunds'

/**
 * W21 (D-plan 1.6, 4.4): refundBooking's It already arrived. What is owed reached the customer after all, so it comes
 * off the booking with no money moving, with a reason, in one transaction with its `booking.refund_owed_arrived` row.
 * Issue refunds, as before. Moves no money, so the switch doesn't gate it. Idempotent.
 */
export const POST = defineRoute(
  { auth: 'staff', permission: 'issueRefunds', input: owedArrivedRouteInputSchema, output: refundBookingOutputSchema, idempotent: true },
  async ({ db, input, staff, requestId }) => {
    const { bookingId, ...body } = input
    return owedArrived(db, bookingId, body, { actor: { type: 'staff', id: staff.id }, requestId })
  }
)
