// New in W06, until W16: what an order wrote, for the dry run and the staff app's shadow to compare.
import 'server-only'
import type { OrderRows } from '@/contracts'
import type { Queryable } from '@/server/db'

/**
 * Everything an order in W06's scope writes, read back by its id: the order, its lines in the order
 * the app reads them, the booking with its seats and add-ons, and what the order's claims left (the
 * session's places, the pass's sessions, each add-on credit's membership, the credit period's use).
 * One JSON value, so both drivers read it the same way.
 *
 * The staff app's shadow (backend/paddock/shared/orderQuoteShadow.ts) runs this same text on the
 * old order, and a test holds the two copies word for word: change both, or neither. Retool binds
 * each $N once, in order, so $1 appears once.
 */
export const ORDER_ROWS_SQL = `
WITH o AS (SELECT * FROM orders WHERE id = $1),
l AS (SELECT oli.* FROM order_line_items oli JOIN o ON oli.order_id = o.id),
b AS (SELECT bk.* FROM bookings bk WHERE bk.id = (SELECT l.booking_id FROM l WHERE l.booking_id IS NOT NULL ORDER BY l.created_at, l.id LIMIT 1))
SELECT json_build_object(
  'order', (SELECT json_build_object(
    'order_total', o.order_total, 'discount_amount', o.discount_amount, 'promo_code', o.promo_code,
    'payment_status', o.payment_status, 'payment_method', o.payment_method, 'order_source', o.order_source,
    'has_shipping_address', o.shipping_address IS NOT NULL,
    'has_payment_intent', o.stripe_payment_intent_id IS NOT NULL,
    'has_reader_payment', o.reader_payment IS NOT NULL) FROM o),
  'lines', (SELECT COALESCE(json_agg(json_build_object(
    'item_type', l.item_type, 'quantity', l.quantity, 'unit_price', l.unit_price, 'line_total', l.line_total,
    'discount_amount', l.discount_amount, 'system_unit_price', l.system_unit_price,
    'price_override_reason', l.price_override_reason, 'addon_id', l.addon_id,
    'is_the_booking', l.booking_id IS NOT NULL AND l.booking_id = (SELECT b.id FROM b),
    'fulfillment_status', l.fulfillment_status) ORDER BY l.created_at, l.id), '[]'::json) FROM l),
  'booking', (SELECT json_build_object(
    'session_id', b.session_id, 'status', b.status, 'party_size', b.party_size, 'price_paid', b.price_paid,
    'redemption_source', b.redemption_source, 'redeemed_membership_id', b.redeemed_membership_id,
    'redeemed_session_pass_id', b.redeemed_session_pass_id, 'credit_period_id', b.credit_period_id,
    'band_id', b.band_id, 'special_requests', b.special_requests,
    'guests_over_18_confirmed', b.guests_over_18_confirmed_at IS NOT NULL,
    'for_the_order_customer', b.customer_id = (SELECT o.customer_id FROM o),
    'times_are_the_session', b.start_time = s.start_time AND b.end_time = s.end_time,
    'session_total_booked', s.total_booked,
    'pass_sessions_remaining', (SELECT p.sessions_remaining FROM customer_session_passes p WHERE p.id = b.redeemed_session_pass_id),
    'credit_period_used', (SELECT count(*) FROM bookings x WHERE x.credit_period_id = b.credit_period_id AND x.redemption_source = 'membership_credit' AND x.status <> 'cancelled'),
    'seats', (SELECT COALESCE(json_agg(json_build_object(
      'guest_type', g.guest_type, 'guest_name', g.guest_name, 'guest_email', g.guest_email,
      'date_of_birth', g.date_of_birth, 'unit_price', g.unit_price, 'pay_by', g.pay_by,
      'waiver_accepted', g.waiver_accepted) ORDER BY g.created_at, g.id), '[]'::json)
      FROM booking_guests g WHERE g.booking_id = b.id),
    'addons', (SELECT COALESCE(json_agg(json_build_object(
      'addon_id', a.addon_id, 'quantity', a.quantity, 'price_at_purchase', a.price_at_purchase,
      'sku_at_purchase', a.sku_at_purchase, 'redemption_source', a.redemption_source,
      'redeemed_membership_id', a.redeemed_membership_id,
      'for_the_order', a.order_id = (SELECT o.id FROM o),
      'addon_credits_left', (SELECT m.addon_credits_remaining FROM customer_memberships m WHERE m.id = a.redeemed_membership_id))
      ORDER BY a.created_at, a.id), '[]'::json)
      FROM addon_order_lines a WHERE a.booking_id = b.id))
    FROM b JOIN sessions s ON s.id = b.session_id)
) AS rows
`

export async function readOrderRows(q: Queryable, orderId: string): Promise<OrderRows> {
  const found = await q.query<{ rows: OrderRows }>(ORDER_ROWS_SQL, [orderId])
  const row = found[0]
  if (!row?.rows.order) throw new Error(`Order ${orderId} could not be read back.`)
  return row.rows
}
