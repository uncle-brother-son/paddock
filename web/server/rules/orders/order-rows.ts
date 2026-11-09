// New in W06, until W16: what an order wrote, for the dry run and the staff app's shadow to compare.
// W07 adds what products, postage, passes, gift cards and the delivery address write; W08 what an
// event writes; W09 what a promo code, store credit and a gift card used to pay write.
import 'server-only'
import type { OrderRows } from '@/contracts'
import type { Queryable } from '@/server/db'

/**
 * Everything an order in W06's to W09's scope writes, read back by its id: the order, its lines in
 * the order the app reads them, the booking with its seats and add-ons, and what the order's claims
 * left (the session's places, the pass's sessions, each add-on credit's membership, the credit
 * period's use); from W07 also each variant's stock and the ledger rows naming the order, the passes
 * and gift cards its lines issued, and the customer's own address after it; from W08 the event booking
 * the event line points at, the event's places after the claim and the attendees in place order; from
 * W09 the promo code's use, the store credit taken (its note is free text), the gift card used to pay
 * with that card's balance after (its code is never read), and the customer's store credit balance. Ids
 * the two sides write differently (a gift card's, a pass's, the pass a booking bought in the same
 * order is paid with) are read as what they point at, and a gift card's code only as whether it has
 * the app's format. One JSON value, so both drivers read it the same way.
 *
 * The staff app's shadow (backend/paddock/shared/orderQuoteShadow.ts) runs this same text on the
 * old order, and a test holds the two copies word for word: change both, or neither. Retool binds
 * each $N once, in order, so $1 appears once.
 */
export const ORDER_ROWS_SQL = `
WITH o AS (SELECT * FROM orders WHERE id = $1),
l AS (SELECT oli.* FROM order_line_items oli JOIN o ON oli.order_id = o.id),
b AS (SELECT bk.* FROM bookings bk WHERE bk.id = (SELECT l.booking_id FROM l WHERE l.booking_id IS NOT NULL ORDER BY l.created_at, l.id LIMIT 1)),
eb AS (SELECT x.* FROM event_bookings x WHERE x.id = (SELECT l.event_booking_id FROM l WHERE l.item_type = 'event' ORDER BY l.created_at, l.id LIMIT 1))
SELECT json_build_object(
  'order', (SELECT json_build_object(
    'order_total', o.order_total, 'discount_amount', o.discount_amount, 'promo_code', o.promo_code,
    'payment_status', o.payment_status, 'payment_method', o.payment_method, 'order_source', o.order_source,
    'has_shipping_address', o.shipping_address IS NOT NULL,
    'shipping_address', o.shipping_address,
    'has_payment_intent', o.stripe_payment_intent_id IS NOT NULL,
    'has_reader_payment', o.reader_payment IS NOT NULL) FROM o),
  'lines', (SELECT COALESCE(json_agg(json_build_object(
    'item_type', l.item_type, 'quantity', l.quantity, 'unit_price', l.unit_price, 'line_total', l.line_total,
    'discount_amount', l.discount_amount, 'system_unit_price', l.system_unit_price,
    'price_override_reason', l.price_override_reason, 'addon_id', l.addon_id,
    'is_the_booking', l.booking_id IS NOT NULL AND l.booking_id = (SELECT b.id FROM b),
    'fulfillment_status', l.fulfillment_status, 'product_variant_id', l.product_variant_id,
    'session_pass_type_id', l.session_pass_type_id, 'has_gift_card', l.gift_card_id IS NOT NULL)
    ORDER BY l.created_at, l.id), '[]'::json) FROM l),
  'booking', (SELECT json_build_object(
    'session_id', b.session_id, 'status', b.status, 'party_size', b.party_size, 'price_paid', b.price_paid,
    'redemption_source', b.redemption_source, 'redeemed_membership_id', b.redeemed_membership_id,
    'redeemed_session_pass_id', CASE WHEN b.redeemed_session_pass_id IN (
      SELECT np.id FROM l JOIN customer_session_passes np ON np.order_line_item_id = l.id) THEN 'bought in this order'
      ELSE b.redeemed_session_pass_id::text END,
    'credit_period_id', b.credit_period_id,
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
    FROM b JOIN sessions s ON s.id = b.session_id),
  'stock', (SELECT COALESCE(json_agg(json_build_object('variant_id', v.id, 'stock_quantity', v.stock_quantity) ORDER BY v.id), '[]'::json)
    FROM product_variants v WHERE v.id IN (SELECT l.product_variant_id FROM l)),
  'stock_adjustments', (SELECT COALESCE(json_agg(json_build_object(
    'variant_id', sa.variant_id, 'change_amount', sa.change_amount, 'by_staff', sa.staff_id IS NOT NULL) ORDER BY sa.created_at, sa.id), '[]'::json)
    FROM stock_adjustments sa WHERE sa.variant_id IN (SELECT l.product_variant_id FROM l) AND sa.reason = 'Sale (Order #' || (SELECT o.id FROM o) || ')'),
  'session_passes', (SELECT COALESCE(json_agg(json_build_object(
    'pass_type_id', p.pass_type_id, 'purchase_date', p.purchase_date, 'sessions_remaining', p.sessions_remaining,
    'expiry_date', p.expiry_date, 'for_the_order_customer', p.customer_id = (SELECT o.customer_id FROM o),
    'pays_for_the_booking', p.id IS NOT DISTINCT FROM (SELECT b.redeemed_session_pass_id FROM b)) ORDER BY l.created_at, l.id), '[]'::json)
    FROM l JOIN customer_session_passes p ON p.order_line_item_id = l.id),
  'gift_cards', (SELECT COALESCE(json_agg(json_build_object(
    'type', g.type, 'original_value', g.original_value, 'remaining_balance', g.remaining_balance,
    'bought_by_the_order_customer', g.purchaser_id = (SELECT o.customer_id FROM o),
    'recipient_name', g.recipient_name, 'recipient_email', g.recipient_email, 'gift_message', g.gift_message,
    'origin', g.origin, 'issue_date', g.issue_date, 'expiry_date', g.expiry_date, 'fulfillment_method', g.fulfillment_method,
    'voided', g.voided, 'redeemed', g.redeemed_at IS NOT NULL,
    'code_format_ok', g.code SIMILAR TO 'PWC-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}') ORDER BY l.created_at, l.id), '[]'::json)
    FROM l JOIN gift_cards g ON g.id = l.gift_card_id),
  'customer_address', (SELECT json_build_object(
    'line1', c.address_line1, 'line2', c.address_line2, 'city', c.city, 'postcode', c.postcode, 'country', c.country)
    FROM customers c WHERE c.id = (SELECT o.customer_id FROM o)),
  'event_booking', (SELECT json_build_object(
    'event_id', eb.event_id, 'status', eb.status, 'places', eb.places, 'account_holder_attending', eb.account_holder_attending,
    'price_paid', eb.price_paid, 'created_by_staff_id', eb.created_by_staff_id,
    'guests_over_18_confirmed', eb.guests_over_18_confirmed_at IS NOT NULL,
    'for_the_order_customer', eb.customer_id = (SELECT o.customer_id FROM o),
    'event_places_booked', e.places_booked,
    'attendees', (SELECT COALESCE(json_agg(json_build_object(
      'attendee_type', a.attendee_type, 'name', a.name, 'email', a.email, 'date_of_birth', a.date_of_birth,
      'unit_price', a.unit_price, 'price_level', a.price_level) ORDER BY a.created_at, a.id), '[]'::json)
      FROM event_attendees a WHERE a.event_booking_id = eb.id))
    FROM eb JOIN events e ON e.id = eb.event_id),
  'promo_redemptions', (SELECT COALESCE(json_agg(json_build_object(
    'promo_code_id', r.promo_code_id, 'for_the_order_customer', r.customer_id = (SELECT o.customer_id FROM o),
    'discount_amount', r.discount_amount) ORDER BY r.created_at, r.id), '[]'::json)
    FROM promo_code_redemptions r WHERE r.order_id = (SELECT o.id FROM o)),
  'store_credit_transactions', (SELECT COALESCE(json_agg(json_build_object(
    'amount', t.amount, 'balance_after', t.balance_after, 'reason', t.reason,
    'for_the_order_customer', t.customer_id = (SELECT o.customer_id FROM o),
    'for_a_booking', t.booking_id IS NOT NULL, 'from_a_gift_card', t.gift_card_id IS NOT NULL,
    'staff_id', t.staff_id, 'note', t.note) ORDER BY t.created_at, t.id), '[]'::json)
    FROM store_credit_transactions t WHERE t.order_id = (SELECT o.id FROM o)),
  'gift_card_redemptions', (SELECT COALESCE(json_agg(json_build_object(
    'gift_card_id', r.gift_card_id, 'amount_used', r.amount_used,
    'for_a_booking', r.booking_id IS NOT NULL, 'for_an_event_booking', r.event_booking_id IS NOT NULL,
    'card_remaining_balance', g.remaining_balance, 'card_redeemed', g.redeemed_at IS NOT NULL, 'card_voided', g.voided)
    ORDER BY r.redeemed_at, r.id), '[]'::json)
    FROM gift_card_redemptions r JOIN gift_cards g ON g.id = r.gift_card_id WHERE r.order_id = (SELECT o.id FROM o)),
  'customer_store_credit_balance', (SELECT c.store_credit_balance FROM customers c WHERE c.id = (SELECT o.customer_id FROM o))
) AS rows
`

export async function readOrderRows(q: Queryable, orderId: string): Promise<OrderRows> {
  const found = await q.query<{ rows: OrderRows }>(ORDER_ROWS_SQL, [orderId])
  const row = found[0]
  if (!row?.rows.order) throw new Error(`Order ${orderId} could not be read back.`)
  return row.rows
}
