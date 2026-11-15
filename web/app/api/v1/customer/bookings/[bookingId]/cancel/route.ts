import { customerBookingCancelOutputSchema, customerBookingCancelRouteInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { customerCancelPathOff } from '@/server/rules/customer/cancel-switch'
import { cancelCustomerBooking } from '@/server/rules/customer/cancels'

/**
 * W33 (E-plan 4.11; Wayne's Q44): the signed-in customer cancels their own session booking, whole, more than 24 real
 * hours before it starts. Step D's cancel on the customer channel (server/rules/bookings/cancel.ts): everything paid
 * goes to store credit, never to a card (so no Stripe call is made and nothing can be held); a credit or pass booking
 * returns its credit; a payment-needed booking is simply cancelled; every add-on goes with it. One transaction. The
 * amount the customer confirmed is required (`confirmed.storeCredit`, Q18). Idempotent: the same key gets the same
 * answer and never cancels twice. Off unless ORDER_SWITCH names `customer_cancels`, and `booking_changes` when money
 * goes back (as staff need for the same money).
 */
export const POST = defineRoute(
  { auth: 'customer', input: customerBookingCancelRouteInputSchema, output: customerBookingCancelOutputSchema, idempotent: true },
  async ({ db, input, customer, requestId }) => {
    const off = customerCancelPathOff(process.env.ORDER_SWITCH, (input.confirmed?.storeCredit ?? 0) > 0 ? 'booking_changes' : undefined)
    if (off) throw off
    const { bookingId, ...body } = input
    return cancelCustomerBooking(db, bookingId, body, customer, requestId)
  }
)
