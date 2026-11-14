import { orderOwedArrivedRouteInputSchema, orderOwedOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { orderOwedArrived } from '@/server/rules/orders/refund-lines'

/**
 * W28 (E-plan 4.5; Wayne's Q39): It already arrived on an order. What is still to refund reached the customer after
 * all, so it comes off the order with no money moving: any amount up to what is owed (the W26 audit's row 31), with a
 * reason, in one transaction with its `order.owed_arrived` row. Issue refunds. Moves no money, so the switch doesn't
 * gate it. Idempotent.
 */
export const POST = defineRoute(
  { auth: 'staff', permission: 'issueRefunds', input: orderOwedArrivedRouteInputSchema, output: orderOwedOutputSchema, idempotent: true },
  async ({ db, input, staff, requestId }) => {
    const { orderId, ...body } = input
    return orderOwedArrived(db, orderId, body, { actor: { type: 'staff', id: staff.id }, requestId })
  }
)
