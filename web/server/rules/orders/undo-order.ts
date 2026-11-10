// The one undo (W03-plan 2.4, "The one undo"), new in W10: shared/readerOrderRollback.ts's
// rollbackReaderOrder and createOrder's 23 rollback closures, as one transaction. Every failure path
// that leaves a pending order with nothing taken uses it.
import 'server-only'
import { audit } from '@/server/audit'
import { inOpenTransaction, isDeadlock, type Db, type Tx } from '@/server/db'
import { lockForOrder } from './locks'
import type { PendingSnapshot } from './pending-order'

export type UndoOutcome =
  /** Everything the order held is given back and its rows are gone. */
  | { undone: true }
  /** Nothing to do: the order isn't there (undone already, or never written). Safe to run twice. */
  | { undone: false; reason: 'gone' }
  /** Refused, nothing changed: a paid order is a real sale, and anything else isn't this undo's to touch. */
  | { undone: false; reason: 'paid' | 'not_pending' }

export interface UndoOptions {
  actor: { type: 'staff' | 'customer' | 'system'; id: string | null }
  requestId: string
  /** Why, for the audit row: e.g. the card's refusal. */
  why: string
}

interface LockedOrder {
  customer_id: string
  payment_status: string
  reader_payment: PendingSnapshot | null
}

/** What the order holds, read after its lock, so it is current. Each id is one this order wrote. */
interface OrderParts {
  booking: {
    id: string
    session_id: string
    party_size: number
    booking_type: string | null
    redemption_source: string | null
    /** The pass a seat took a session from, when the pass isn't one this order bought (that one goes whole). */
    pass_to_give_back: string | null
  } | null
  addon_credits: Array<{ membership_id: string; quantity: number }>
  stock: Array<{ variant_id: string; quantity: number }>
  event: { booking_id: string; event_id: string; places: number } | null
  gift_card_used: string | null
  store_credit: string
  gift_card_bought: string | null
  passes_bought: string[]
}

const PARTS_SQL = `
WITH l AS (SELECT * FROM order_line_items WHERE order_id = $1::uuid),
bought_passes AS (SELECT p.id FROM customer_session_passes p JOIN l ON p.order_line_item_id = l.id)
SELECT
  (SELECT json_build_object(
     'id', b.id, 'session_id', b.session_id, 'party_size', b.party_size, 'booking_type', st.booking_type,
     'redemption_source', b.redemption_source,
     'pass_to_give_back', CASE WHEN b.redemption_source = 'session_pass_credit' AND b.redeemed_session_pass_id NOT IN (SELECT id FROM bought_passes)
                               THEN b.redeemed_session_pass_id END)
   FROM bookings b JOIN sessions s ON s.id = b.session_id JOIN service_types st ON st.id = s.service_type_id
   WHERE b.id = (SELECT booking_id FROM l WHERE booking_id IS NOT NULL LIMIT 1)) AS booking,
  (SELECT COALESCE(json_agg(json_build_object('membership_id', x.membership_id, 'quantity', x.quantity) ORDER BY x.membership_id), '[]'::json)
   FROM (SELECT redeemed_membership_id AS membership_id, sum(quantity)::int AS quantity FROM addon_order_lines
         WHERE order_id = $1::uuid AND redemption_source = 'membership_credit' AND redeemed_membership_id IS NOT NULL
         GROUP BY redeemed_membership_id) x) AS addon_credits,
  (SELECT COALESCE(json_agg(json_build_object('variant_id', x.variant_id, 'quantity', x.quantity) ORDER BY x.variant_id), '[]'::json)
   FROM (SELECT product_variant_id AS variant_id, sum(quantity)::int AS quantity FROM l
         WHERE item_type = 'product' AND product_variant_id IS NOT NULL GROUP BY product_variant_id) x) AS stock,
  (SELECT json_build_object('booking_id', eb.id, 'event_id', eb.event_id, 'places', eb.places)
   FROM event_bookings eb WHERE eb.id = (SELECT event_booking_id FROM l WHERE event_booking_id IS NOT NULL LIMIT 1)) AS event,
  (SELECT gift_card_id FROM gift_card_redemptions WHERE order_id = $1::uuid LIMIT 1) AS gift_card_used,
  (SELECT COALESCE(-sum(amount), 0)::text FROM store_credit_transactions WHERE order_id = $1::uuid AND reason = 'redemption') AS store_credit,
  (SELECT gift_card_id FROM l WHERE item_type = 'gift_card' AND gift_card_id IS NOT NULL LIMIT 1) AS gift_card_bought,
  (SELECT COALESCE(array_agg(id), '{}') FROM bought_passes) AS passes_bought`

/**
 * Gives back everything T1 claimed, exactly once, and removes every row it wrote, in one statement
 * (foreign keys are checked when the statement ends, so the order of the deletes doesn't matter):
 * - the session's places (a private session goes back to empty), and the pass session a seat took;
 *   a membership credit is the booking itself, so it comes back with the booking;
 * - add-on credits; stock, with the sale's ledger rows; the event's places, with its booking and
 *   attendees;
 * - the store credit, with its ledger row: the balance goes back up by what was taken;
 * - a gift card used to pay: its balance, with its redemption row. `redeemed_at` is cleared only if it
 *   was set when this order used the card or later (T1 sets it to the redemption's own time), so a card
 *   marked redeemed before this order keeps its date;
 * - the promo code's use (it goes with the order), the gift card and pass bought, the lines, the
 *   booking's add-ons, the booking with its seats, and the order.
 */
const UNDO_SQL = `
WITH capacity AS (
  UPDATE sessions s
  SET total_booked = CASE WHEN $3::text = 'private' THEN 0 ELSE s.total_booked - $4::int END, updated_at = now()
  WHERE s.id = $2::uuid
  RETURNING s.id
),
pass AS (
  UPDATE customer_session_passes SET sessions_remaining = sessions_remaining + 1, updated_at = now()
  WHERE id = $5::uuid
  RETURNING id
),
credits AS (
  UPDATE customer_memberships m SET addon_credits_remaining = m.addon_credits_remaining + x.quantity, updated_at = now()
  FROM jsonb_to_recordset($6::jsonb) AS x(membership_id uuid, quantity int)
  WHERE m.id = x.membership_id
  RETURNING m.id
),
stock AS (
  UPDATE product_variants v SET stock_quantity = v.stock_quantity + x.quantity, updated_at = now()
  FROM jsonb_to_recordset($7::jsonb) AS x(variant_id uuid, quantity int)
  WHERE v.id = x.variant_id
  RETURNING v.id
),
places AS (
  UPDATE events e SET places_booked = e.places_booked - $9::int, updated_at = now()
  WHERE e.id = $8::uuid
  RETURNING e.id
),
credit AS (
  UPDATE customers c SET store_credit_balance = c.store_credit_balance + $11::numeric, updated_at = now()
  WHERE c.id = $10::uuid AND $11::numeric > 0
  RETURNING c.id
),
card AS (
  UPDATE gift_cards g
  SET remaining_balance = g.remaining_balance + r.amount_used,
      redeemed_at = CASE WHEN g.redeemed_at >= r.redeemed_at THEN NULL ELSE g.redeemed_at END,
      updated_at = now()
  FROM gift_card_redemptions r
  WHERE r.order_id = $1::uuid AND g.id = r.gift_card_id
  RETURNING g.id
),
addon_lines AS (DELETE FROM addon_order_lines WHERE order_id = $1::uuid RETURNING id),
ledger AS (DELETE FROM stock_adjustments WHERE reason = 'Sale (Order #' || $1::text || ')' RETURNING id),
card_use AS (DELETE FROM gift_card_redemptions WHERE order_id = $1::uuid RETURNING id),
credit_rows AS (DELETE FROM store_credit_transactions WHERE order_id = $1::uuid RETURNING id),
lines AS (DELETE FROM order_line_items WHERE order_id = $1::uuid RETURNING id),
booking AS (DELETE FROM bookings WHERE id = $12::uuid RETURNING id),
passes AS (DELETE FROM customer_session_passes WHERE id = ANY($13::uuid[]) RETURNING id),
event_booking AS (DELETE FROM event_bookings WHERE id = $14::uuid RETURNING id),
bought_card AS (DELETE FROM gift_cards WHERE id = $15::uuid RETURNING id),
removed AS (DELETE FROM orders WHERE id = $1::uuid AND payment_status = 'pending' RETURNING id)
SELECT (SELECT count(*)::int FROM removed) AS orders_removed,
       (SELECT count(*)::int FROM capacity) AS sessions_given_back,
       (SELECT count(*)::int FROM pass) AS passes_given_back,
       (SELECT count(*)::int FROM credits) AS memberships_given_back,
       (SELECT count(*)::int FROM stock) AS variants_given_back,
       (SELECT count(*)::int FROM places) AS events_given_back,
       (SELECT count(*)::int FROM credit) AS customers_given_back,
       (SELECT count(*)::int FROM card) AS gift_cards_given_back,
       (SELECT count(*)::int FROM booking) AS bookings_removed,
       (SELECT count(*)::int FROM event_booking) AS event_bookings_removed,
       (SELECT count(*)::int FROM bought_card) AS gift_cards_removed,
       (SELECT count(*)::int FROM passes) AS passes_removed,
       (SELECT count(*)::int FROM lines) AS lines_removed,
       (SELECT count(*)::int FROM addon_lines) AS addon_lines_removed,
       (SELECT count(*)::int FROM ledger) AS ledger_rows_removed,
       (SELECT count(*)::int FROM card_use) AS gift_card_uses_removed,
       (SELECT count(*)::int FROM credit_rows) AS store_credit_rows_removed`

type Undone = Record<
  | 'orders_removed'
  | 'sessions_given_back'
  | 'passes_given_back'
  | 'memberships_given_back'
  | 'variants_given_back'
  | 'events_given_back'
  | 'customers_given_back'
  | 'gift_cards_given_back'
  | 'bookings_removed'
  | 'event_bookings_removed'
  | 'gift_cards_removed'
  | 'passes_removed'
  | 'lines_removed'
  | 'addon_lines_removed'
  | 'ledger_rows_removed'
  | 'gift_card_uses_removed'
  | 'store_credit_rows_removed',
  number
>

async function undoInTransaction(tx: Tx, orderId: string, options: UndoOptions): Promise<UndoOutcome> {
  // 1. The order first (LOCK_ORDER), so T2 and another undo queue behind it and see what this did.
  const order = (
    await tx.query<LockedOrder>('SELECT customer_id, payment_status, reader_payment FROM orders WHERE id = $1::uuid FOR UPDATE', [orderId])
  )[0]
  if (!order) return { undone: false, reason: 'gone' }
  if (order.payment_status === 'paid') return { undone: false, reason: 'paid' }
  if (order.payment_status !== 'pending') return { undone: false, reason: 'not_pending' }

  // 2. What it holds, read now the order is locked.
  const parts = (await tx.query<OrderParts>(PARTS_SQL, [orderId]))[0] as OrderParts
  const booking = parts.booking

  // 3. Everything it gives back to, in LOCK_ORDER, so an order placed meanwhile can't deadlock with it.
  await lockForOrder(tx, {
    customerId: order.customer_id,
    promoCode: null,
    sessionId: booking?.session_id ?? null,
    creditMembershipId: null,
    sessionPassId: booking?.pass_to_give_back ?? null,
    addonMembershipIds: parts.addon_credits.map((credit) => credit.membership_id),
    productVariantIds: parts.stock.map((line) => line.variant_id),
    eventId: parts.event?.event_id ?? null,
    giftCardId: parts.gift_card_used,
  })

  // 4. Given back and removed, in one statement.
  const done = (
    await tx.query<Undone>(UNDO_SQL, [
      orderId,
      booking?.session_id ?? null,
      booking?.booking_type ?? null,
      booking?.party_size ?? 0,
      booking?.pass_to_give_back ?? null,
      parts.addon_credits,
      parts.stock,
      parts.event?.event_id ?? null,
      parts.event?.places ?? 0,
      order.customer_id,
      parts.store_credit,
      booking?.id ?? null,
      parts.passes_bought,
      parts.event?.booking_id ?? null,
      parts.gift_card_bought,
    ])
  )[0] as Undone
  const expect = (what: keyof Undone, count: number) => {
    if (done[what] !== count) throw new Error(`The undo did not finish: ${what} ${done[what]} of ${count}.`)
  }
  expect('orders_removed', 1)
  expect('sessions_given_back', booking ? 1 : 0)
  expect('bookings_removed', booking ? 1 : 0)
  expect('passes_given_back', booking?.pass_to_give_back ? 1 : 0)
  expect('memberships_given_back', parts.addon_credits.length)
  expect('variants_given_back', parts.stock.length)
  expect('events_given_back', parts.event ? 1 : 0)
  expect('event_bookings_removed', parts.event ? 1 : 0)
  expect('customers_given_back', Number(parts.store_credit) > 0 ? 1 : 0)
  expect('gift_cards_given_back', parts.gift_card_used ? 1 : 0)
  expect('gift_cards_removed', parts.gift_card_bought ? 1 : 0)
  expect('passes_removed', parts.passes_bought.length)

  // 5. The record, with the full snapshot and what went, as the rows themselves are gone (W03-decisions Q20).
  await audit.recordAll(tx, [{
    actorType: options.actor.type,
    actorId: options.actor.id,
    action: 'order.undo',
    entityType: 'order',
    entityId: orderId,
    requestId: options.requestId,
    details: { why: options.why, snapshot: order.reader_payment, parts, removed: done },
  }])
  return { undone: true }
}

/**
 * Undoes a pending order in one transaction: all of it or none of it. Safe to run twice and alongside
 * T2: each locks the order first, so the second finds it gone (and does nothing) or paid (and refuses).
 * An undo that fails leaves the order pending, holding its claims, for the next try (reconcile, W12),
 * never half undone. It calls nothing outside the database, so a deadlock is run once more, as T1.
 */
export async function undoOrder(db: Db, orderId: string, options: UndoOptions): Promise<UndoOutcome> {
  const opensItsOwn = !inOpenTransaction(db)
  const work = (tx: Tx) => undoInTransaction(tx, orderId, options)
  try {
    return await db.transaction(work)
  } catch (err) {
    if (!opensItsOwn || !isDeadlock(err)) throw err
    return db.transaction(work)
  }
}
