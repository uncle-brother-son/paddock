import { orderOwedOutputSchema, orderRefundOwedRouteInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { refundOrderOwed } from '@/server/rules/orders/refund-lines'
import { orderRefundPathOff } from '@/server/rules/refunds/refund-switch'
import { createStripeClient, ORDER_STRIPE_LIMITS } from '@/server/stripe/client'

/**
 * W28 (E-plan 4.5; Wayne's Q39): Refund the rest on an order. Gives exactly the money still to refund on it (a card
 * refund Stripe refused or never got): to the card as a new claim (what the card can't take goes to store credit), to
 * store credit, or in cash within Q42's cap. Issue refunds. Gated by the switch (`order_refunds`). Idempotent.
 */
export const POST = defineRoute(
  { auth: 'staff', permission: 'issueRefunds', input: orderRefundOwedRouteInputSchema, output: orderOwedOutputSchema, idempotent: true },
  async ({ db, input, staff, requestId, startedAt }) => {
    const off = orderRefundPathOff(process.env.ORDER_SWITCH)
    if (off) throw off
    const { orderId, ...body } = input
    return refundOrderOwed(db, orderId, body, {
      actor: { type: 'staff', id: staff.id },
      requestId,
      startedAt,
      stripe: () => createStripeClient(undefined, ORDER_STRIPE_LIMITS),
    })
  }
)
