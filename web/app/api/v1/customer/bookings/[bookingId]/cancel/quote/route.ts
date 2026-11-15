import { customerBookingCancelQuoteRouteInputSchema, customerBookingCancelQuoteSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { customerCancelPathOff } from '@/server/rules/customer/cancel-switch'
import { quoteCustomerBookingCancel } from '@/server/rules/customer/cancels'

/**
 * W33 (E-plan 4.11; Wayne's Q44): what cancelling the signed-in customer's own session booking would give: everything
 * paid to store credit (paid guests and paid add-ons included), a credit or pass returned, and in `blocked` why it
 * can't be cancelled now (inside 24 hours, already cancelled or finished, a payment or refund still open). A
 * read. Someone else's booking is not found. Off unless ORDER_SWITCH names `customer_cancels` (built dark).
 */
export const POST = defineRoute(
  { auth: 'customer', input: customerBookingCancelQuoteRouteInputSchema, output: customerBookingCancelQuoteSchema },
  async ({ db, input, customer }) => {
    const off = customerCancelPathOff(process.env.ORDER_SWITCH)
    if (off) throw off
    return quoteCustomerBookingCancel(db, input.bookingId, customer)
  }
)
