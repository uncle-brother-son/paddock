import { refundOrderOutputSchema, refundOrderRouteInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { refundOrderLines } from '@/server/rules/orders/refund-lines'
import { orderRefundPathOff } from '@/server/rules/refunds/refund-switch'
import { createStripeClient, ORDER_STRIPE_LIMITS } from '@/server/stripe/client'

/**
 * W28 (E-plan 4.3): refundOrder. The chosen lines of an order refunded as one refund: to the original card (capped at
 * the order's card money left, the rest to store credit), to store credit, or (Q42) in cash up to the cash paid on the
 * order. Every kind of line except an event's places (their attendee list) and a booking (its own
 * refund). R1 in one transaction, then the card part once under `<claimId>:refund:<orderId>`, then R2
 * (server/rules/orders/refund-lines.ts). A refusal before anything moved is an error whose details carry the old
 * reason and words; a card refund with no clear answer is held for reconcile and answered as data. Issue refunds.
 * Gated by the switch first (`order_refunds`). Idempotent: the same key gets the same answer, never a second refund.
 */
export const POST = defineRoute(
  { auth: 'staff', permission: 'issueRefunds', input: refundOrderRouteInputSchema, output: refundOrderOutputSchema, idempotent: true },
  async ({ db, input, staff, requestId, startedAt }) => {
    const off = orderRefundPathOff(process.env.ORDER_SWITCH)
    if (off) throw off
    const { orderId, ...body } = input
    return refundOrderLines(db, orderId, body, {
      actor: { type: 'staff', id: staff.id },
      requestId,
      startedAt,
      stripe: () => createStripeClient(undefined, ORDER_STRIPE_LIMITS),
    })
  }
)
