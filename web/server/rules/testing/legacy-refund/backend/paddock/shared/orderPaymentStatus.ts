/**
 * Recomputes an order's payment_status after a refund, from its lines. Used by refundOrder, the
 * event cancellations, the booking add-on refunds and the booking refunds so they all count the
 * same way. Writes, so no read-only getter may import it (CLAUDE.md).
 *
 * Lines counted:
 *  - order_line_items other than booking lines: refunded once stamped refunded_at. An event line
 *    counts as partly refunded while only some of its places have been refunded.
 *  - booking lines: refunded once stamped refunded_at (Cancel & Refund stamps the lines that held
 *    seat money, Remove Guest the guest's own); partly refunded while money went back on it but it
 *    isn't stamped: card money on the line, or refund store credit on the order and booking (a part
 *    refund, a cheaper move; an add-on's store credit counts too, but its own line already makes the
 *    order partly refunded); unrefunded while the booking is live. A booking cancelled with nothing
 *    back (and its line never stamped) is left out — nothing was refunded on it.
 *  - booking add-on lines paid on this order (addon_order_lines.order_id): refunded once removed
 *    with a refund_method other than 'none' (card, credit or credit_returned).
 * Every counted line refunded → 'refunded'; any refunded or partly refunded → 'partially_refunded';
 * otherwise the status is left as it is.
 */
// The runtime globals (paddockData) are typed by the generated declarations in backend/resources/.
import '../globals'

export type RecomputedOrderStatus = 'refunded' | 'partially_refunded' | null

export async function recomputeOrderPaymentStatus(orderId: string): Promise<RecomputedOrderStatus> {
  const [lines, addons] = await Promise.all([
    paddockData.query<{ total: string; refunded: string; partly: string }>(
      `SELECT
         COUNT(*) FILTER (
           WHERE oli.item_type <> 'booking' OR oli.refunded_at IS NOT NULL OR b.status IS DISTINCT FROM 'cancelled'
         ) AS total,
         COUNT(*) FILTER (WHERE oli.refunded_at IS NOT NULL) AS refunded,
         COUNT(*) FILTER (
           WHERE oli.refunded_at IS NULL AND (
             (oli.item_type = 'booking' AND oli.card_refunded_amount > 0)
             OR (oli.item_type = 'booking' AND
                 COALESCE((SELECT SUM(sct.amount) FROM store_credit_transactions sct
                           WHERE sct.order_id = oli.order_id AND sct.booking_id = oli.booking_id AND sct.reason = 'refund'), 0) > 0)
             OR (oli.item_type = 'event' AND EXISTS (SELECT 1 FROM event_attendees ea
                                                      WHERE ea.event_booking_id = oli.event_booking_id AND ea.refunded_amount > 0))
           )
         ) AS partly
       FROM order_line_items oli
       LEFT JOIN bookings b ON b.id = oli.booking_id AND oli.item_type = 'booking'
       WHERE oli.order_id = $1`,
      [orderId]
    ),
    paddockData.query<{ total: string; refunded: string }>(
      `SELECT COUNT(*) AS total,
              COUNT(*) FILTER (WHERE removed_at IS NOT NULL AND refund_method IS NOT NULL AND refund_method <> 'none') AS refunded
       FROM addon_order_lines WHERE order_id = $1`,
      [orderId]
    ),
  ])
  const n = (v: string | undefined) => Number.parseInt(v ?? '0', 10)
  const total = n(lines.data[0]?.total) + n(addons.data[0]?.total)
  const refunded = n(lines.data[0]?.refunded) + n(addons.data[0]?.refunded)
  const partly = n(lines.data[0]?.partly)
  const status: RecomputedOrderStatus =
    total > 0 && refunded >= total ? 'refunded' : refunded > 0 || partly > 0 ? 'partially_refunded' : null
  if (status) {
    await paddockData.query('UPDATE orders SET payment_status = $1, updated_at = now() WHERE id = $2', [status, orderId])
  }
  return status
}

/** Recomputes every order given (duplicates once); returns a warning for any that failed. */
export async function recomputeOrdersPaymentStatus(orderIds: Array<string | null | undefined>): Promise<string | undefined> {
  const failures: string[] = []
  for (const orderId of new Set(orderIds.filter((id): id is string => typeof id === 'string'))) {
    try {
      await recomputeOrderPaymentStatus(orderId)
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err))
    }
  }
  return failures.length > 0 ? `Updating an order's payment status failed and needs a manual check: ${failures.join('; ')}` : undefined
}
