import { orderListRouteInputSchema, orderListRouteOutputSchema, placeOrderInputSchema, placeOrderOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { listOrders } from '@/server/rules/orders/admin'
import { placeOrder } from '@/server/rules/orders/place-order'
import { orderPathOff } from '@/server/rules/orders/order-switch'
import { createStripeClient, ORDER_STRIPE_LIMITS } from '@/server/stripe/client'

/**
 * W53 (G-plan 4.3; bugs GB14 and GB22; lead call L9): getOrders, the Orders page's list and Overview's orders card:
 * the orders in the date range, with the payment status, source and search asked for, under the view asked for
 * (Needs action when none is), each with its customer, its worked-out status and how it was paid, in words. An order
 * whose booking is at Payment needed, and one with money owed, count as Needs action. Named fields. Any active staff
 * member (the old read checked nobody).
 */
export const GET = defineRoute({ auth: 'staff', input: orderListRouteInputSchema, output: orderListRouteOutputSchema }, async ({ db, input, staff }) =>
  listOrders(db, input, { channel: 'staff', actor: adminActor(staff) })
)

/**
 * Places an order (W06: cash, or nothing owed; W10: the saved card). Idempotent: a retry with the
 * same key gets the same answer, refusals and PAYMENT_UNCONFIRMED included, and never runs it twice,
 * so never charges twice. Selling needs only an active staff member, as in createOrder; a sent price
 * counts only with Manage pricing. Anything not built yet answers NOT_BUILT before the order is
 * touched. Stripe is reached only for a card order, with the order's time limits and a deadline from
 * the request's start (collect-saved-card.ts, COLLECT_DEADLINE_MS). W14: the staff app's
 * createOrder calls this first; a basket whose kind ORDER_SWITCH leaves off answers ORDER_PATH_OFF.
 */
export const POST = defineRoute(
  { auth: 'staff', input: placeOrderInputSchema, output: placeOrderOutputSchema, idempotent: true },
  async ({ db, input, staff, requestId, startedAt }) => {
    // W14 (W03-plan 3.2): a kind that is off answers ORDER_PATH_OFF before the order is touched. The answer
    // is stored against the key like any other, so a retry with the same key stays on the old code even if
    // the kind is switched on meanwhile (the old code may have placed the order).
    const off = orderPathOff(input, process.env.ORDER_SWITCH)
    if (off) throw off
    return placeOrder(db, input, {
      actor: { type: 'staff', id: staff.id },
      requestId,
      startedAt,
      allowPriceOverrides: staff.canManagePricing,
      stripe: () => createStripeClient(undefined, ORDER_STRIPE_LIMITS),
    })
  }
)
