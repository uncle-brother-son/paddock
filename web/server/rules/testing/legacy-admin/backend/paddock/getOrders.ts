export type OrderComputedStatus = 'needs_action' | 'upcoming' | 'complete'

export interface OrderListRow {
  id: string
  customer_id: string
  customer_first_name: string
  customer_last_name: string
  customer_email: string
  order_total: string
  payment_status: 'pending' | 'paid' | 'failed' | 'refunded' | 'partially_refunded'
  order_source: 'online' | 'staff_created' | null
  discount_amount: string | null
  promo_code: string | null
  stripe_payment_intent_id: string | null
  tracking_number: string | null
  shipping_status: string | null
  created_at: string
  updated_at: string
  /**
   * Derived, not stored — recomputed on every read so the list self-manages instead of relying
   * on a manually-maintained status field:
   *  - 'needs_action': a non-refunded product line still pending fulfillment, OR a non-refunded
   *    pickup/shipping gift card line not yet collected/shipped, OR (brief W47; the W35 audit's F1)
   *    card refund money still owed to the customer on the order (refund_owed_amount above 0).
   *    Wins over 'upcoming' when both apply.
   *  - 'upcoming': a booking line whose booking is still confirmed/pending (not
   *    cancelled/completed) and whose session start_time is still in the future, OR an event
   *    line whose event booking is confirmed and whose event hasn't started.
   *  - 'complete': neither of the above — every physical item is fulfilled/refunded and every
   *    booking / event booking has either occurred, been cancelled, or been marked completed.
   * Add-ons, memberships, session passes, and digital gift cards never affect this — they're
   * resolved instantly (or, for add-ons, tracked via the session-grouped Bookings view instead).
   */
  computed_status: OrderComputedStatus
}

export interface GetOrdersParams {
  startDate?: string
  endDate?: string
  paymentStatus?: string
  orderSource?: string
  search?: string
  /** Defaults to 'needs_action' (the default landing view — what staff most need to act on)
   *  when omitted. 'upcoming' and 'complete' match exactly that computed_status (respecting the
   *  same needs_action-wins-over-upcoming priority used to compute it); 'all' applies no status
   *  filter at all. */
  view?: 'needs_action' | 'upcoming' | 'complete' | 'all'
}

export default async function getOrders(req: { params?: GetOrdersParams }): Promise<OrderListRow[]> {
  const { startDate, endDate, paymentStatus, orderSource, search, view } = req.params ?? {}

  const conditions: string[] = []
  const values: unknown[] = []

  if (startDate) {
    values.push(startDate)
    conditions.push(`o.created_at >= $${values.length}::date`)
  }
  if (endDate) {
    values.push(endDate)
    conditions.push(`o.created_at < ($${values.length}::date + interval '1 day')`)
  }
  if (paymentStatus) {
    values.push(paymentStatus)
    conditions.push(`o.payment_status = $${values.length}`)
  }
  if (orderSource) {
    values.push(orderSource)
    conditions.push(`o.order_source = $${values.length}`)
  }
  if (search) {
    values.push(`%${search}%`)
    const idx = values.length
    conditions.push(`(c.first_name ILIKE $${idx} OR c.last_name ILIKE $${idx + 1} OR c.email ILIKE $${idx + 2})`)
    values.push(`%${search}%`, `%${search}%`)
  }

  // needs_action: a non-refunded product line still pending, or a non-refunded pickup/shipping
  // gift card line not yet collected/shipped. Brief W47 (the W35 audit's F1): or money still to
  // refund on the order, so an order that owes a customer money is in the default view, where its
  // "still to refund" badge and its Refund the rest bar are. No parameter: a fixed condition.
  const needsActionExists = `
    (o.refund_owed_amount > 0 OR EXISTS (
      SELECT 1 FROM order_line_items oli
      WHERE oli.order_id = o.id
        AND oli.refunded_at IS NULL
        AND (
          (oli.item_type = 'product' AND oli.fulfillment_status = 'pending')
          OR (
            oli.item_type = 'gift_card' AND EXISTS (
              SELECT 1 FROM gift_cards gc
              WHERE gc.id = oli.gift_card_id
                AND (
                  (gc.fulfillment_method = 'pickup' AND gc.picked_up IS NOT TRUE)
                  OR (gc.fulfillment_method = 'shipping' AND gc.shipped_at IS NULL)
                )
            )
          )
        )
    ))
  `
  // upcoming: a booking line whose booking is still confirmed/pending and its session hasn't
  // started yet, or an event line whose event booking is still confirmed (not fully cancelled) and
  // whose event hasn't been cancelled or started.
  // Start times are London wall-clock digits labelled UTC, so both sides are compared as London
  // wall-clock timestamps (comparing with now() directly is an hour out in British Summer Time).
  const upcomingExists = `
    (EXISTS (
      SELECT 1 FROM order_line_items oli
      JOIN bookings bk ON bk.id = oli.booking_id
      JOIN sessions se ON se.id = bk.session_id
      WHERE oli.order_id = o.id
        AND oli.item_type = 'booking'
        AND bk.status IN ('confirmed', 'pending')
        AND (se.start_time AT TIME ZONE 'UTC') > (now() AT TIME ZONE 'Europe/London')
    ) OR EXISTS (
      SELECT 1 FROM order_line_items oli
      JOIN event_bookings eb ON eb.id = oli.event_booking_id
      JOIN events ev ON ev.id = eb.event_id
      WHERE oli.order_id = o.id
        AND oli.item_type = 'event'
        AND eb.status = 'confirmed'
        AND ev.cancelled_at IS NULL
        AND (ev.starts_at AT TIME ZONE 'UTC') > (now() AT TIME ZONE 'Europe/London')
    ))
  `

  if (view === 'upcoming') {
    conditions.push(`NOT (${needsActionExists}) AND (${upcomingExists})`)
  } else if (view === 'complete') {
    conditions.push(`NOT (${needsActionExists}) AND NOT (${upcomingExists})`)
  } else if (view !== 'all') {
    // Default landing view, and explicit 'needs_action' — needs_action wins over upcoming in the
    // computed_status priority, so this matches only the orders that would actually show as
    // 'needs_action', not every order that happens to also have an upcoming booking.
    conditions.push(needsActionExists)
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

  const sql = `
    SELECT
      o.*,
      c.first_name AS customer_first_name,
      c.last_name AS customer_last_name,
      c.email AS customer_email,
      CASE
        WHEN ${needsActionExists} THEN 'needs_action'
        WHEN ${upcomingExists} THEN 'upcoming'
        ELSE 'complete'
      END AS computed_status
    FROM orders o
    JOIN customers c ON c.id = o.customer_id
    ${whereClause}
    ORDER BY o.created_at DESC
  `

  const result = await paddockData.query<OrderListRow>(sql, values)
  return result.data
}
