// W53 (G-plan 1.11, 1.12, 4.1, 4.3, 4.8; bugs GB14 and GB22; lead calls L6, L9, L11, L12): the Orders page, an order's
// lines, the fulfilled tick and Overview's "Needs attention: payments" on the Worker. Ported from the staff app's
// getOrders.ts, getOrderLineItems.ts and setOrderLineItemFulfilled.ts (frozen at W48 in testing/legacy-admin), with
// their words (./admin-failure-messages.ts). getPaymentAttentionItems moved here from bookings/admin.ts, unchanged
// (W50 report, "Where I was unsure" 8: G-plan 4.1 places it with orders).
//
// The reads
//  - GB14: an active staff member, through the admin read helper (the old reads checked nobody). Named columns: every
//    column the old `o.*` gave is named, so nothing a screen reads is gone and a new column is a decision. The four
//    working columns getOrderLineItems spread into its answer beside the two sentences it built from them
//    (`addon_removed_count` and the three sums) are not answered: no screen's type has them (W48's contracts).
//  - Each read takes the channel (G-plan 4.8). On the customer channel every statement is limited to the signed-in
//    customer's own orders; no customer route exists yet (lead call L13).
//  - GB22: an order whose booking is at Payment needed counts as Needs action (the old read called it Complete), as
//    does an order with money owed (W47; the W35 audit's F1). Needs action still wins over Upcoming.
//  - The date range is the old one exactly: the order's `created_at` against the day's two ends read as UTC, whatever
//    the connection's time zone is set to (the old read cast the date in the connection's zone, which is UTC).
//  - L9: the list also answers how the order was paid, in words (`payment_method_label`). An order with no method
//    recorded that store credit paid for reads "Store credit": every store-credit-only order Add Guest wrote before
//    W53 recorded no method (bookings/add-guest.ts writes `store_credit` from W53 on).
//  - The item names and the two summary sentences are built here, word for word as the staff app built them.
//
// The fulfilled tick (G-plan 4.2, level C): one guarded statement and an audit row (`order_line.fulfilled_set`, with
// who and when) in one transaction, under the call's own key. Any active staff member.
//  - Refused, either way, on a line that isn't a product, on a product line with nothing to fulfil (no fulfilment
//    state), on a refunded line, and on a line of an order whose payment failed. The old function checked only that
//    the line was a product, and recorded nothing of who or when.
//  - The guard reads the line's order, which is another table's row (W48 review L2), so the order is held FOR SHARE
//    first (LOCK_ORDER's 'order', and nothing before it): a refund in progress on the order (which holds the order's
//    row until it commits) is waited for, and the press is then decided on what it committed. Two ticks on one order
//    don't wait for each other.
//  - W54a's stale-page rule doesn't apply: a flag writes only what was pressed, never a row as a page read it.
import 'server-only'
import type { AdminAction, AdminGetOrderLineItemsOutput, AdminGetPaymentAttentionItemsOutput, OrderLineFulfilledRouteOutput, OrderListRouteInput, OrderListRouteOutput } from '@/contracts'
import type { Db, Queryable, SqlParam } from '@/server/db'
import { flagWrite } from '@/server/rules/admin/flag'
import { isUuid } from '@/server/rules/admin/locks'
import { adminRead, namedRead } from '@/server/rules/admin/read'
import { adminRefusal, type AdminActor } from '@/server/rules/admin/refusal'
import { BOOKING_ROW_SQL, BOOKING_ROW_TIMES, type BookingReader, type StaffFlagPress } from '@/server/rules/bookings/admin'
import { LONDON_WALL_CLOCK_NOW_SQL, onOrAfterLondonDaySql, onOrBeforeLondonDaySql } from '@/server/rules/time/london-day-sql'
import { likeContaining } from '@/server/rules/admin/like'
import { ORDER_ADMIN_NEW_WORDS, ORDER_PAYMENT_METHOD_LABELS } from './admin-failure-messages'

// ---------------------------------------------------------------------------------------------------------------------
// Who is reading, and the channel

/**
 * Who an order read is for (G-plan 4.8), as a booking read's: `staff`, the signed-in staff member as the route's own
 * staff check read them; `customer`, the website's signed-in customer, who is only ever shown their own orders.
 */
export type OrderReader = BookingReader

/** A statement's parameters, numbered as they are added. */
class Params {
  readonly values: SqlParam[] = []
  add(value: SqlParam): string {
    this.values.push(value)
    return `$${this.values.length}`
  }
}

/** The customer channel's limit: only the signed-in customer's own orders (`o` is the order). Nothing on the staff channel. */
const ownOrdersOnly = (reader: OrderReader, params: Params): string => (reader.channel === 'customer' ? ` AND o.customer_id = ${params.add(reader.customerId)}::uuid` : '')

interface OrderRead {
  name: string
  sql: string
  params: readonly SqlParam[]
  times?: readonly string[]
}

/** One read on its channel: the staff permission first for staff; the customer's is the limit in the statement. */
function channelRead<Row extends Record<string, unknown>>(db: Queryable, reader: OrderReader, read: OrderRead): Promise<Row[]> {
  return reader.channel === 'staff' ? adminRead<Row>(db, { ...read, needs: 'staff' }, { actor: reader.actor }) : namedRead<Row>(db, read)
}

// ---------------------------------------------------------------------------------------------------------------------
// The order list

/**
 * GB22 (G-plan section 3; the W35 audit's F1): what makes an order (`o`) need action, as one condition:
 *  - money still to refund on it (W47: since then the old read counted this too);
 *  - W53: a booking line whose booking is at Payment needed (the old read called such an order Complete: a member
 *    whose payment failed, with a booking to pay for, was under no view staff look at);
 *  - a product line not refunded and still to hand over, or a gift card line not refunded and still to be collected
 *    or posted (as before).
 * Exported for the test that holds the three parts apart.
 */
export const ORDER_NEEDS_ACTION_SQL = `
    (o.refund_owed_amount > 0 OR EXISTS (
      SELECT 1 FROM order_line_items oli
      JOIN bookings bk ON bk.id = oli.booking_id
      WHERE oli.order_id = o.id
        AND oli.item_type = 'booking'
        AND bk.status = 'payment_needed'
    ) OR EXISTS (
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
    ))`

/**
 * Upcoming, as before: a booking line whose booking is still confirmed or pending and whose session hasn't started,
 * or an event line whose event booking is still confirmed and whose event hasn't been cancelled or started. Start
 * times are London wall-clock digits labelled UTC, so each is compared with London's wall clock now in the same form.
 */
const ORDER_UPCOMING_SQL = `
    (EXISTS (
      SELECT 1 FROM order_line_items oli
      JOIN bookings bk ON bk.id = oli.booking_id
      JOIN sessions se ON se.id = bk.session_id
      WHERE oli.order_id = o.id
        AND oli.item_type = 'booking'
        AND bk.status IN ('confirmed', 'pending')
        AND se.start_time > ${LONDON_WALL_CLOCK_NOW_SQL}
    ) OR EXISTS (
      SELECT 1 FROM order_line_items oli
      JOIN event_bookings eb ON eb.id = oli.event_booking_id
      JOIN events ev ON ev.id = eb.event_id
      WHERE oli.order_id = o.id
        AND oli.item_type = 'event'
        AND eb.status = 'confirmed'
        AND ev.cancelled_at IS NULL
        AND ev.starts_at > ${LONDON_WALL_CLOCK_NOW_SQL}
    ))`

/**
 * L9: how the order (`o`) was paid, as one word: the method recorded; with none recorded, `store_credit` when store
 * credit paid for it (what its redemptions took, less what was reversed, is above £0) and `nothing_to_pay` when it
 * cost nothing; else null. Exported for the test.
 */
export const ORDER_PAID_BY_SQL = `
       CASE
         WHEN o.payment_method IS NOT NULL THEN o.payment_method
         WHEN COALESCE((SELECT -SUM(sct.amount) FROM store_credit_transactions sct
                        WHERE sct.order_id = o.id AND sct.reason IN ('redemption', 'redemption_reversal')), 0) > 0 THEN 'store_credit'
         WHEN o.order_total - COALESCE(o.discount_amount, 0) <= 0 THEN 'nothing_to_pay'
         ELSE NULL
       END`

/** The words for how an order was paid (ORDER_PAID_BY_SQL's one word), or null when nothing says. */
export function paymentMethodLabel(paidBy: string | null): string | null {
  if (paidBy === null) return null
  if (paidBy === 'nothing_to_pay') return ORDER_PAYMENT_METHOD_LABELS.nothingToPay
  const labels: Readonly<Record<string, string>> = ORDER_PAYMENT_METHOD_LABELS
  // A method the table doesn't know (the database's own check allows only the six): shown as it is stored.
  return labels[paidBy] ?? paidBy
}

type OrderRow = OrderListRouteOutput[number]

/**
 * getOrders (`GET orders`): the orders made on a day from `startDate` to `endDate` (each optional, both included),
 * with the payment status and source asked for, whose customer's name or email holds `search`, under the view asked
 * for (`upcoming`, `complete`, `all`; anything else, or nothing, is Needs action, the page's first view), newest
 * first. Each with its customer, its worked-out status and how it was paid, in words.
 */
export async function listOrders(db: Queryable, input: OrderListRouteInput, reader: OrderReader): Promise<OrderListRouteOutput> {
  const params = new Params()
  const where: string[] = []
  if (input.startDate) where.push(onOrAfterLondonDaySql('o.created_at', params.add(input.startDate)))
  if (input.endDate) where.push(onOrBeforeLondonDaySql('o.created_at', params.add(input.endDate)))
  if (input.paymentStatus) where.push(`o.payment_status = ${params.add(input.paymentStatus)}`)
  if (input.orderSource) where.push(`o.order_source = ${params.add(input.orderSource)}`)
  if (input.search) {
    // One value each, as the staff app's driver bound them (a placeholder used twice bound the wrong value there).
    // W58 (W53 "For later" 4): `%` and `_` typed in a search match themselves.
    const like = likeContaining(input.search)
    where.push(`(c.first_name ILIKE ${params.add(like)} ESCAPE '\\' OR c.last_name ILIKE ${params.add(like)} ESCAPE '\\' OR c.email ILIKE ${params.add(like)} ESCAPE '\\')`)
  }
  if (input.view === 'upcoming') where.push(`NOT (${ORDER_NEEDS_ACTION_SQL}) AND (${ORDER_UPCOMING_SQL})`)
  else if (input.view === 'complete') where.push(`NOT (${ORDER_NEEDS_ACTION_SQL}) AND NOT (${ORDER_UPCOMING_SQL})`)
  // The first view, and anything else asked for: exactly the orders that read Needs action (it wins over Upcoming).
  else if (input.view !== 'all') where.push(ORDER_NEEDS_ACTION_SQL)

  const sql = `
SELECT o.id, o.customer_id, o.order_total::text AS order_total, o.payment_status, o.stripe_payment_intent_id, o.promo_code,
       o.discount_amount::text AS discount_amount, o.shipping_address, o.shipping_status, o.tracking_number, o.order_source,
       o.created_at, o.updated_at, o.payment_method, o.reader_payment, o.refund_owed_amount::text AS refund_owed_amount,
       c.first_name AS customer_first_name, c.last_name AS customer_last_name, c.email AS customer_email,
       CASE
         WHEN ${ORDER_NEEDS_ACTION_SQL} THEN 'needs_action'
         WHEN ${ORDER_UPCOMING_SQL} THEN 'upcoming'
         ELSE 'complete'
       END AS computed_status,${ORDER_PAID_BY_SQL} AS paid_by
  FROM orders o
  JOIN customers c ON c.id = o.customer_id
 WHERE true${where.map((condition) => ` AND ${condition}`).join('')}${ownOrdersOnly(reader, params)}
 ORDER BY o.created_at DESC, o.id`
  const rows = await channelRead<OrderRow & { paid_by: string | null }>(db, reader, { name: 'orders.list', sql, params: params.values, times: ['created_at', 'updated_at'] })
  return rows.map(({ paid_by, ...row }) => ({ ...row, payment_method_label: paymentMethodLabel(paid_by) }))
}

// ---------------------------------------------------------------------------------------------------------------------
// An order's lines

type OrderLine = AdminGetOrderLineItemsOutput[number]

/** A line as the statement gives it: the answer's columns, and the four sums its add-on sentence is built from. */
type RawOrderLine = Omit<OrderLine, 'item_name' | 'event_cancellation_summary' | 'addon_refund_summary'> & {
  addon_removed_count: number | null
  addon_refunded: string | null
  addon_card_refunded: string | null
  addon_credits_returned: number | null
}

const money = (n: number): string => `£${n.toFixed(2)}`

/** "2 add-ons removed · £9.00 refunded (£5.00 card, £4.00 store credit) · 1 add-on credit returned": a booking line's removed add-ons paid on this order. */
export function addonRefundSummary(row: Pick<RawOrderLine, 'addon_removed_count' | 'addon_refunded' | 'addon_card_refunded' | 'addon_credits_returned'>): string | null {
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

/** "2 of 3 places cancelled · £40.00 refunded (£25.00 card, £15.00 store credit)" for an event line with cancelled places; null when none are. */
export function eventCancellationSummary(row: Pick<RawOrderLine, 'event_attendees' | 'event_cancelled_at'>): string | null {
  const places = row.event_attendees ?? []
  const cancelled = places.filter((place) => place.cancelled_at)
  if (cancelled.length === 0 && !row.event_cancelled_at) return null
  const refunded = cancelled.reduce((sum, place) => sum + Number(place.refunded_amount), 0)
  const card = cancelled.reduce((sum, place) => sum + Number(place.card_refunded_amount), 0)
  const credit = Math.round((refunded - card) * 100) / 100
  const parts: string[] = []
  if (row.event_cancelled_at) parts.push('Event cancelled')
  parts.push(cancelled.length === places.length ? `${cancelled.length === 1 ? 'Place' : `All ${cancelled.length} places`} cancelled` : `${cancelled.length} of ${places.length} places cancelled`)
  if (refunded > 0.005) {
    const split = [card > 0.005 ? `${money(card)} card` : null, credit > 0.005 ? `${money(credit)} store credit` : null].filter(Boolean)
    parts.push(`${money(refunded)} refunded (${split.join(', ')})`)
  } else if (cancelled.length > 0) {
    parts.push('no refund')
  }
  return parts.join(' · ')
}

/** A line's name as the Orders page shows it, by its kind. An event's time is its stored digits (London's wall clock). */
export function orderLineName(row: Pick<RawOrderLine, 'item_type' | 'service_type_name' | 'product_name' | 'product_variant_size' | 'payment_date_change_extra_days' | 'membership_plan_name' | 'session_pass_type_name' | 'gift_card_code' | 'addon_name' | 'event_starts_at' | 'event_name' | 'quantity'>): string {
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
        ? new Date(row.event_starts_at).toLocaleString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
        : null
      return [row.event_name ?? 'Event', date, `${row.quantity} place${row.quantity === 1 ? '' : 's'}`].filter(Boolean).join(' · ')
    }
    default:
      return 'Item'
  }
}

/**
 * getOrderLineItems (`GET orders/:orderId/lines`): the order's lines, oldest first, each with what it sold (the
 * service type, the product and its size, the plan, the pass type, the gift card and how it is handed over, the
 * add-on, the event with each place), its name, and the two summary sentences: an event line's cancelled places, and
 * a booking line's add-ons paid on this order that were removed. An id that names no order answers none.
 */
export async function listOrderLines(db: Queryable, orderId: string, reader: OrderReader): Promise<AdminGetOrderLineItemsOutput> {
  const params = new Params()
  const sql = `
SELECT oli.id, oli.order_id, oli.item_type, oli.quantity, oli.unit_price::text AS unit_price, oli.line_total::text AS line_total,
       oli.booking_id, oli.product_variant_id, oli.membership_plan_id, oli.session_pass_type_id, oli.gift_card_id, oli.addon_id,
       oli.refunded_at, oli.refund_method, oli.restocked, oli.fulfillment_status, oli.system_unit_price::text AS system_unit_price,
       oli.price_override_reason, oli.discount_amount::text AS discount_amount, oli.created_at,
       st.name AS service_type_name, p.name AS product_name, pv.size AS product_variant_size, mp.name AS membership_plan_name,
       spt.name AS session_pass_type_name, gc.code AS gift_card_code, gc.fulfillment_method AS gift_card_fulfillment_method,
       gc.picked_up AS gift_card_picked_up, gc.shipped_at AS gift_card_shipped_at, a.name AS addon_name,
       oli.event_booking_id, ev.name AS event_name, ev.starts_at AS event_starts_at, ev.cancelled_at AS event_cancelled_at,
       ar.removed_count AS addon_removed_count, ar.refunded::text AS addon_refunded, ar.card_refunded::text AS addon_card_refunded,
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
  JOIN orders o ON o.id = oli.order_id
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
 WHERE oli.order_id = ${params.add(isUuid(orderId) ? orderId : null)}::uuid${ownOrdersOnly(reader, params)}
 ORDER BY oli.created_at, oli.id`
  const rows = await channelRead<RawOrderLine>(db, reader, {
    name: 'orders.lines',
    sql,
    params: params.values,
    times: ['refunded_at', 'created_at', 'gift_card_shipped_at', 'event_starts_at', 'event_cancelled_at'],
  })
  return rows.map(({ addon_removed_count, addon_refunded, addon_card_refunded, addon_credits_returned, ...row }) => ({
    ...row,
    item_name: orderLineName(row),
    event_cancellation_summary: row.item_type === 'event' ? eventCancellationSummary(row) : null,
    addon_refund_summary: row.item_type === 'booking' ? addonRefundSummary({ addon_removed_count, addon_refunded, addon_card_refunded, addon_credits_returned }) : null,
  }))
}

// ---------------------------------------------------------------------------------------------------------------------
// Payments needing attention (Overview). Moved from bookings/admin.ts at W53, unchanged.

type AttentionBooking = AdminGetPaymentAttentionItemsOutput['bookings'][number]

/**
 * getPaymentAttentionItems (`GET overview/payment-attention`): Overview's "Needs attention: payments". Bookings at
 * Payment needed, soonest deadline first, each a whole booking row (the booking window opens on it), and memberships
 * whose payment is overdue.
 */
export async function listPaymentAttention(db: Queryable, reader: OrderReader): Promise<AdminGetPaymentAttentionItemsOutput> {
  const bookingParams = new Params()
  const bookings = await channelRead<AttentionBooking>(db, reader, {
    name: 'overview.payment_attention',
    sql: `${BOOKING_ROW_SQL}
 WHERE b.status = 'payment_needed'${reader.channel === 'customer' ? ` AND b.customer_id = ${bookingParams.add(reader.customerId)}::uuid` : ''}
 ORDER BY b.payment_due_by ASC NULLS LAST, b.start_time ASC, b.id`,
    params: bookingParams.values,
    times: BOOKING_ROW_TIMES,
  })
  const membershipParams = new Params()
  const memberships = await channelRead<AdminGetPaymentAttentionItemsOutput['memberships'][number]>(db, reader, {
    name: 'overview.payment_attention',
    sql: `
SELECT cm.id AS membership_id, cm.customer_id, mp.name AS plan_name, c.first_name, c.last_name, c.email
  FROM customer_memberships cm
  JOIN membership_plans mp ON mp.id = cm.plan_id
  JOIN customers c ON c.id = cm.customer_id
 WHERE cm.subscription_status = 'past_due'${reader.channel === 'customer' ? ` AND cm.customer_id = ${membershipParams.add(reader.customerId)}::uuid` : ''}
 ORDER BY c.last_name ASC, c.first_name ASC, cm.id`,
    params: membershipParams.values,
  })
  return { bookings, memberships }
}

// ---------------------------------------------------------------------------------------------------------------------
// The fulfilled tick

const WORDS = ORDER_ADMIN_NEW_WORDS
const iso = (value: unknown): string | null => (value === null || value === undefined ? null : value instanceof Date ? value.toISOString() : String(value))

/**
 * W48 review L2: the order a line belongs to, held FOR SHARE before the tick's own statement, so the payment status
 * the guard reads is a committed one, and a refund in progress on the order (which holds the order's row until it
 * commits, refunds/locks.ts) is waited for: the statement, which starts after the wait, then sees the line as the
 * refund left it. FOR SHARE is enough, and two ticks on one order don't wait for each other. The order is the first
 * lock the press takes, and its only one besides the line it updates.
 */
export const HOLD_ORDER_OF_LINE_SQL = 'SELECT o.id FROM orders o WHERE o.id = (SELECT oli.order_id FROM order_line_items oli WHERE oli.id = $1::uuid) FOR SHARE OF o'

/** A line's row, every column by name (the old function answered `RETURNING *`). Money as the database's text. */
const LINE_COLUMNS_SQL = `oli.id, oli.order_id, oli.booking_id, oli.product_variant_id, oli.membership_plan_id, oli.session_pass_type_id, oli.gift_card_id,
       oli.item_type, oli.quantity, oli.unit_price::text AS unit_price, oli.line_total::text AS line_total, oli.created_at, oli.addon_id,
       oli.refunded_at, oli.refund_method, oli.restocked, oli.fulfillment_status, oli.card_refunded_amount::text AS card_refunded_amount,
       oli.system_unit_price::text AS system_unit_price, oli.price_override_reason, oli.discount_amount::text AS discount_amount, oli.event_booking_id`

/**
 * Fulfilled, or not fulfilled (`$2`): only a product line that has a fulfilment state, isn't refunded, and whose
 * order's payment didn't fail. Exported for the race test's control (admin-postgres.test.ts), which runs it without
 * the order held first.
 */
export const SET_LINE_FULFILLED_SQL = `
UPDATE order_line_items oli
   SET fulfillment_status = $2::text
  FROM orders o
 WHERE oli.id = $1::uuid AND o.id = oli.order_id
   AND oli.item_type = 'product' AND oli.fulfillment_status IS NOT NULL
   AND oli.refunded_at IS NULL AND o.payment_status <> 'failed'
RETURNING ${LINE_COLUMNS_SQL}`

/** Why the tick's guard refused: the line and its order as the guard read them. */
const FULFILLED_REFUSAL_SQL = `
SELECT oli.item_type, (oli.fulfillment_status IS NULL) AS no_state, (oli.refunded_at IS NOT NULL) AS refunded, o.payment_status
  FROM order_line_items oli
  JOIN orders o ON o.id = oli.order_id
 WHERE oli.id = $1::uuid`

/**
 * setOrderLineItemFulfilled (`POST orders/lines/:lineItemId/fulfilled`), on and off. Any active staff member. The
 * line's order is held FOR SHARE first (W48 review L2), then one guarded statement: only a product line with
 * something to fulfil, not refunded, on an order whose payment didn't fail. The audit row
 * (`order_line.fulfilled_set`) says who pressed, which way and when.
 */
export async function setOrderLineFulfilled(db: Db, lineItemId: string, fulfilled: boolean, press: StaffFlagPress): Promise<OrderLineFulfilledRouteOutput> {
  const action: AdminAction = 'order_line.fulfilled_set'
  const notFound = () => adminRefusal('NOT_FOUND', action, 'not_found', WORDS.lineNotFound)
  if (!isUuid(lineItemId)) throw notFound()
  const row = await flagWrite<Record<string, unknown>>(
    db,
    {
      action,
      needs: 'staff',
      channels: ['staff'],
      entity: { type: 'order_line_item', id: lineItemId },
      holdFirst: { sql: HOLD_ORDER_OF_LINE_SQL, params: [lineItemId] },
      statement: { sql: SET_LINE_FULFILLED_SQL, params: [lineItemId, fulfilled ? 'fulfilled' : 'pending'] },
      async refusal(tx) {
        const [line] = await tx.query<{ item_type: string; no_state: boolean; refunded: boolean; payment_status: string }>(FULFILLED_REFUSAL_SQL, [lineItemId])
        if (!line) return notFound()
        if (line.item_type !== 'product') return adminRefusal('VALIDATION', action, 'not_a_product_line', WORDS.notAProductLine)
        if (line.payment_status === 'failed') return adminRefusal('CONFLICT', action, 'order_cancelled', WORDS.orderCancelled)
        if (line.refunded === true) return adminRefusal('CONFLICT', action, 'line_refunded', WORDS.lineRefunded)
        if (line.no_state === true) return adminRefusal('CONFLICT', action, 'nothing_to_fulfil', WORDS.nothingToFulfil)
        return adminRefusal('CONFLICT', action, 'line_changed', WORDS.lineChanged)
      },
      recorded: (updated) => ({ order_id: updated['order_id'], fulfillment_status: updated['fulfillment_status'] }),
      details: { fulfilled },
    },
    press
  )
  return { ...row, created_at: iso(row['created_at']), refunded_at: iso(row['refunded_at']) } as OrderLineFulfilledRouteOutput
}

/** The staff reader a route makes from its own staff check. */
export const staffReader = (actor: AdminActor): OrderReader => ({ channel: 'staff', actor })
