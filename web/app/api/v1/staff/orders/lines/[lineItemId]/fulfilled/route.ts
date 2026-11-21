import { orderLineFulfilledRouteInputSchema, orderLineFulfilledRouteOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { setOrderLineFulfilled } from '@/server/rules/orders/admin'

/**
 * W53 (G-plan 4.3, level C; W48 review L2): setOrderLineItemFulfilled, the fulfilled tick on a product line of an
 * order, on and off. Any active staff member. The line's order is held first, then one guarded statement and an audit
 * row (`order_line.fulfilled_set`, with who and when) in one transaction: refused on a line that isn't a product or
 * has nothing to fulfil, on a refunded line, and on a line of an order whose payment failed. Idempotent: each call has
 * its own key.
 */
export const POST = defineRoute({ auth: 'staff', input: orderLineFulfilledRouteInputSchema, output: orderLineFulfilledRouteOutputSchema, idempotent: true }, async ({ db, input, staff, requestId, idempotencyKey }) =>
  setOrderLineFulfilled(db, input.lineItemId, input.fulfilled, { actor: adminActor(staff), requestId, pressKey: idempotencyKey })
)
