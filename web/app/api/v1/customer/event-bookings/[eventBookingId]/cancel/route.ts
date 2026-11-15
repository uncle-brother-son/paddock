import { customerEventCancelOutputSchema, customerEventCancelRouteInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { customerCancelPathOff } from '@/server/rules/customer/cancel-switch'
import { cancelCustomerEventPlaces } from '@/server/rules/customer/cancels'

/**
 * W33 (E-plan 4.11; Wayne's Q44): the signed-in customer cancels places on their own event booking (`attendeeIds`, or
 * the whole booking with none named), before the event's refund cut-off (Q43: its start, when it has none). Step E's
 * place cancel on the customer channel (server/rules/events/cancel-places.ts): always to store credit, whatever paid
 * (card, cash, gift card), so no Stripe call is made and nothing can be held. One transaction. The amount the customer
 * confirmed is required (`confirmed.storeCredit`, Q18). Idempotent. Off unless ORDER_SWITCH names `customer_cancels`,
 * and `event_cancels` when money goes back (as staff need for the same money).
 */
export const POST = defineRoute(
  { auth: 'customer', input: customerEventCancelRouteInputSchema, output: customerEventCancelOutputSchema, idempotent: true },
  async ({ db, input, customer, requestId }) => {
    const off = customerCancelPathOff(process.env.ORDER_SWITCH, (input.confirmed?.storeCredit ?? 0) > 0 ? 'event_cancels' : undefined)
    if (off) throw off
    const { eventBookingId, ...body } = input
    return cancelCustomerEventPlaces(db, eventBookingId, body, customer, requestId)
  }
)
