import { customerEventCancelQuoteRouteInputSchema, customerEventCancelQuoteSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { customerCancelPathOff } from '@/server/rules/customer/cancel-switch'
import { quoteCustomerEventCancel } from '@/server/rules/customer/cancels'

/**
 * W33 (E-plan 4.11; Wayne's Q44): what cancelling places on the signed-in customer's own event booking would give
 * (`attendeeIds`, or every place left with none named): their worth now, all to store credit, the cut-off, and in
 * `blocked` why it can't be done now (after the cut-off, Q43; a cancelled event; a place checked in; a payment or
 * refund still open). A read. Someone else's booking is not found. Off unless ORDER_SWITCH names `customer_cancels`.
 */
export const POST = defineRoute(
  { auth: 'customer', input: customerEventCancelQuoteRouteInputSchema, output: customerEventCancelQuoteSchema },
  async ({ db, input, customer }) => {
    const off = customerCancelPathOff(process.env.ORDER_SWITCH)
    if (off) throw off
    return quoteCustomerEventCancel(db, input.eventBookingId, input.attendeeIds, customer)
  }
)
