import { adminGetOrderLineItemsOutputSchema, orderLinesRouteInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { listOrderLines } from '@/server/rules/orders/admin'

/**
 * W53 (G-plan 4.3; bug GB14): getOrderLineItems, an order's lines as the Orders page lists them: each line with what
 * it sold, its name, and the two summary sentences (an event line's cancelled places; a booking line's removed
 * add-ons). Named fields. Any active staff member (the old read checked nobody).
 */
export const GET = defineRoute({ auth: 'staff', input: orderLinesRouteInputSchema, output: adminGetOrderLineItemsOutputSchema }, async ({ db, input, staff }) =>
  listOrderLines(db, input.orderId, { channel: 'staff', actor: adminActor(staff) })
)
