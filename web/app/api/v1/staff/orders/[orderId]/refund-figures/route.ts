import { orderRefundFiguresRouteInputSchema, orderRefundFiguresSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { loadOrderRefundFigures, orderRefundRefusal } from '@/server/rules/orders/refund-lines'

/**
 * W28 (E-plan 4.8; E1, Q18): what the Refund Line Items dialog shows and sends back. Each line's figure (its total,
 * less its promo discount, less card money it has had back), the order's card money and cash that can still go back
 * (Q42), any money owed on it (Q39), and why nothing can start (E2: a payment not finished; a refund still being
 * checked). The same code the refund route checks. A read: any active staff member, never gated by the switch.
 */
export const GET = defineRoute({ auth: 'staff', input: orderRefundFiguresRouteInputSchema, output: orderRefundFiguresSchema }, async ({ db, input }) => {
  const figures = await loadOrderRefundFigures(db, input.orderId)
  if (!figures) throw orderRefundRefusal('NOT_FOUND', 'order_not_found', undefined)
  return figures
})
