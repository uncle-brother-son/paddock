export type OrderLineItemType = 'booking' | 'product' | 'membership' | 'session_pass' | 'gift_card' | 'addon' | 'postage' | 'event'

export interface OrderLineItemRow {
  id: string
  order_id: string
  item_type: OrderLineItemType
  quantity: number
  unit_price: string
  line_total: string
  booking_id: string | null
  product_variant_id: string | null
  membership_plan_id: string | null
  session_pass_type_id: string | null
  gift_card_id: string | null
  addon_id: string | null
  refunded_at: string | null
  refund_method: string | null
  restocked: boolean | null
  /** Only meaningful when item_type = 'product'. */
  fulfillment_status: 'pending' | 'fulfilled' | null
  /** Server-computed system price at purchase (member, else sale, else base; variant override
   *  first for products) — set on add-on/product lines so price overrides are auditable. */
  system_unit_price: string | null
  /** Staff-entered reason, present only when the line's price differs from system_unit_price. */
  price_override_reason: string | null
  /** Promo discount applied to this line (0/none when the order had no promo or the line is
   *  not eligible — gift cards and postage are never discounted). Refundable amount for the
   *  line is line_total minus this. */
  discount_amount: string | null
  service_type_name: string | null
  product_name: string | null
  product_variant_size: string | null
  membership_plan_name: string | null
  session_pass_type_name: string | null
  gift_card_code: string | null
  /** Only meaningful when item_type = 'gift_card'. */
  gift_card_fulfillment_method: 'digital' | 'pickup' | 'shipping' | null
  gift_card_picked_up: boolean | null
  gift_card_shipped_at: string | null
  addon_name: string | null
  /** Event lines only. */
  event_booking_id: string | null
  event_name: string | null
  /** Wall-clock digits labelled UTC, like session times. */
  event_starts_at: string | null
  /** Per-place breakdown, place order (account holder first when attending). Cancelled places
   *  stay in it with their cancellation and refund. */
  event_attendees: Array<{
    attendee_type: 'account_holder' | 'guest'
    name: string
    price_level: 'public' | 'pre_herd' | 'herd'
    unit_price: string
    cancelled_at: string | null
    refunded_amount: string
    card_refunded_amount: string
    refund_method: 'card' | 'credit' | 'none' | null
  }> | null
  /** Set when the event itself was cancelled. */
  event_cancelled_at: string | null
  /** Event lines with any cancelled place: "2 of 3 places cancelled · £40.00 refunded (£25.00 card,
   *  £15.00 store credit)", or "Event cancelled · …" when the event was cancelled. */
  event_cancellation_summary: string | null
  /** Booking lines: that booking's add-ons paid on this order that were removed, and what came
   *  back, e.g. "2 add-ons removed · £9.00 refunded (£5.00 card, £4.00 store credit)". */
  addon_refund_summary: string | null
  /** Membership lines that are a payment date change charge (membership_payment_date_changes
   *  .order_id): the extra days charged, else null. */
  payment_date_change_extra_days: number | null
  created_at: string
  item_name: string
}

interface RawOrderLineItemRow extends Omit<OrderLineItemRow, 'item_name' | 'event_cancellation_summary' | 'addon_refund_summary'> {
  addon_removed_count: number | null
  addon_refunded: string | null
  addon_card_refunded: string | null
  addon_credits_returned: number | null
}

/** "2 add-ons removed · £9.00 refunded (£5.00 card, £4.00 store credit) · 1 credit returned". */
function addonRefundSummary(row: RawOrderLineItemRow): string | null {
  const count = row.addon_removed_count ?? 0
  if (count === 0) return null
  const refunded = Number.parseFloat(row.addon_refunded ?? '0')
  const card = Number.parseFloat(row.addon_card_refunded ?? '0')
  const credit = Math.round((refunded - card) * 100) / 100
  const parts = [`${count} add-on${count === 1 ? '' : 's'} removed`]
  if (refunded > 0.005) {
    const split = [card > 0.005 ? `${money(card)} card` : null, credit > 0.005 ? `${money(credit)} store credit` : null].filter(Boolean)
    parts.push(`${money(refunded)} refunded (${split.join(', ')})`)
  }
  const credits = row.addon_credits_returned ?? 0
  if (credits > 0) parts.push(`${credits} add-on credit${credits === 1 ? '' : 's'} returned`)
  if (refunded <= 0.005 && credits === 0) parts.push('no refund')
  return parts.join(' · ')
}

const money = (n: number) => `£${n.toFixed(2)}`

/** "2 of 3 places cancelled · £40.00 refunded (£25.00 card, £15.00 store credit)" for an event line
 *  with cancelled places; null when none are cancelled. */
function eventCancellationSummary(row: RawOrderLineItemRow): string | null {
  const places = row.event_attendees ?? []
  const cancelled = places.filter((p) => p.cancelled_at)
  if (cancelled.length === 0 && !row.event_cancelled_at) return null
  const refunded = cancelled.reduce((sum, p) => sum + Number(p.refunded_amount), 0)
  const card = cancelled.reduce((sum, p) => sum + Number(p.card_refunded_amount), 0)
  const credit = Math.round((refunded - card) * 100) / 100
  const parts: string[] = []
  if (row.event_cancelled_at) parts.push('Event cancelled')
  parts.push(
    cancelled.length === places.length
      ? `${cancelled.length === 1 ? 'Place' : `All ${cancelled.length} places`} cancelled`
      : `${cancelled.length} of ${places.length} places cancelled`
  )
  if (refunded > 0.005) {
    const split = [card > 0.005 ? `${money(card)} card` : null, credit > 0.005 ? `${money(credit)} store credit` : null].filter(Boolean)
    parts.push(`${money(refunded)} refunded (${split.join(', ')})`)
  } else if (cancelled.length > 0) {
    parts.push('no refund')
  }
  return parts.join(' · ')
}

export interface GetOrderLineItemsParams {
  orderId: string
}

function resolveItemName(row: RawOrderLineItemRow): string {
  switch (row.item_type) {
    case 'booking':
      return row.service_type_name ? `Session: ${row.service_type_name}` : 'Session Booking'
    case 'product':
      if (!row.product_name) return 'Product'
      return row.product_variant_size ? `${row.product_name} (${row.product_variant_size})` : row.product_name
    case 'membership':
      if (row.payment_date_change_extra_days !== null) {
        const days = row.payment_date_change_extra_days
        return `Payment date change: ${days} extra day${days === 1 ? '' : 's'}`
      }
      return row.membership_plan_name ?? 'Membership Plan'
    case 'session_pass':
      return row.session_pass_type_name ?? 'Session Pass'
    case 'gift_card':
      return row.gift_card_code ? `Gift Card (${row.gift_card_code})` : 'Gift Card'
    case 'addon':
      return row.addon_name ?? 'Add-on'
    case 'postage':
      return 'Postage'
    case 'event': {
      const date = row.event_starts_at
        ? new Date(row.event_starts_at).toLocaleString('en-GB', {
            timeZone: 'UTC',
            day: 'numeric',
            month: 'short',
            year: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            hour12: true,
          })
        : null
      return [row.event_name ?? 'Event', date, `${row.quantity} place${row.quantity === 1 ? '' : 's'}`].filter(Boolean).join(' · ')
    }
    default:
      return 'Item'
  }
}

export default async function getOrderLineItems(
  req: { params: GetOrderLineItemsParams }
): Promise<OrderLineItemRow[]> {
  const { orderId } = req.params

  const result = await paddockData.query<RawOrderLineItemRow>(
    `SELECT
       oli.id,
       oli.order_id,
       oli.item_type,
       oli.quantity,
       oli.unit_price,
       oli.line_total,
       oli.booking_id,
       oli.product_variant_id,
       oli.membership_plan_id,
       oli.session_pass_type_id,
       oli.gift_card_id,
       oli.addon_id,
       oli.refunded_at,
       oli.refund_method,
       oli.restocked,
       oli.fulfillment_status,
       oli.system_unit_price,
       oli.price_override_reason,
       oli.discount_amount,
       oli.created_at,
       st.name AS service_type_name,
       p.name AS product_name,
       pv.size AS product_variant_size,
       mp.name AS membership_plan_name,
       spt.name AS session_pass_type_name,
       gc.code AS gift_card_code,
       gc.fulfillment_method AS gift_card_fulfillment_method,
       gc.picked_up AS gift_card_picked_up,
       gc.shipped_at AS gift_card_shipped_at,
       a.name AS addon_name,
       oli.event_booking_id,
       ev.name AS event_name,
       ev.starts_at AS event_starts_at,
       ev.cancelled_at AS event_cancelled_at,
       ar.removed_count AS addon_removed_count, ar.refunded AS addon_refunded, ar.card_refunded AS addon_card_refunded,
       ar.credits_returned AS addon_credits_returned,
       pdc.extra_days AS payment_date_change_extra_days,
       (SELECT json_agg(json_build_object('attendee_type', ea.attendee_type, 'name', ea.name,
                                          'price_level', ea.price_level, 'unit_price', ea.unit_price,
                                          'cancelled_at', ea.cancelled_at, 'refunded_amount', ea.refunded_amount,
                                          'card_refunded_amount', ea.card_refunded_amount,
                                          'refund_method', ea.refund_method)
                        ORDER BY ea.attendee_type = 'guest', ea.created_at, ea.id)
          FROM event_attendees ea WHERE ea.event_booking_id = oli.event_booking_id) AS event_attendees
     FROM order_line_items oli
     LEFT JOIN bookings b ON b.id = oli.booking_id
     LEFT JOIN sessions s ON s.id = b.session_id
     LEFT JOIN service_types st ON st.id = s.service_type_id
     LEFT JOIN product_variants pv ON pv.id = oli.product_variant_id
     LEFT JOIN products p ON p.id = pv.product_id
     LEFT JOIN membership_plans mp ON mp.id = oli.membership_plan_id
     LEFT JOIN session_pass_types spt ON spt.id = oli.session_pass_type_id
     LEFT JOIN gift_cards gc ON gc.id = oli.gift_card_id
     LEFT JOIN addons a ON a.id = oli.addon_id
     LEFT JOIN event_bookings eb ON eb.id = oli.event_booking_id
     LEFT JOIN events ev ON ev.id = eb.event_id
     LEFT JOIN LATERAL (
       SELECT count(*)::int AS removed_count, COALESCE(sum(aol.refunded_amount), 0) AS refunded,
              COALESCE(sum(aol.card_refunded_amount), 0) AS card_refunded,
              COALESCE(sum(aol.quantity) FILTER (WHERE aol.refund_method = 'credit_returned'), 0)::int AS credits_returned
       FROM addon_order_lines aol
       WHERE oli.item_type = 'booking' AND aol.booking_id = oli.booking_id AND aol.order_id = oli.order_id
         AND aol.removed_at IS NOT NULL
     ) ar ON true
     LEFT JOIN LATERAL (
       SELECT mpdc.extra_days FROM membership_payment_date_changes mpdc
       WHERE oli.item_type = 'membership' AND mpdc.order_id = oli.order_id
       LIMIT 1
     ) pdc ON true
     WHERE oli.order_id = $1
     ORDER BY oli.created_at`,
    [orderId]
  )

  return result.data.map((row) => ({
    ...row,
    item_name: resolveItemName(row),
    event_cancellation_summary: row.item_type === 'event' ? eventCancellationSummary(row) : null,
    addon_refund_summary: row.item_type === 'booking' ? addonRefundSummary(row) : null,
  }))
}
