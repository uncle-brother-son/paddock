// New in W27 (E-plan 4.2): the row locks an order refund or an event booking's cancel takes, in LOCK_ORDER
// (server/rules/orders/locks.ts). Not called by any route until W28 (orders) and W30 (events).
import 'server-only'
import type { Tx } from '@/server/db'

/**
 * What a step E refund's checks depend on. The order comes first (LOCK_ORDER's first row: T2, the undo, reconcile and
 * the close by hand all take it first too, so they queue), then its customer (store credit), then what the lines
 * being refunded need: the session passes and memberships they sold, the product variants they restock, the event,
 * the event booking, the gift cards they sold.
 *
 * The caller reads the ids first, with no lock (which pass a line sold, which event a booking is for), then calls
 * this, then reads everything again under the locks: a line refunded, a pass used or a place cancelled in between
 * shows then (E-plan 4.2: "read the ids, then lock, then re-check under the lock").
 */
export interface RefundLockTargets {
  orderId: string
  /** Session passes sold by the lines being refunded (their sessions go to 0), locked in id order. */
  sessionPassIds?: readonly string[]
  /** Memberships sold by the lines being refunded (marked cancelled), locked in id order. */
  membershipIds?: readonly string[]
  /** Product variants the lines put back in stock, locked in id order. */
  productVariantIds?: readonly string[]
  /** The event whose places a cancel gives back. */
  eventId?: string | null
  /** The event booking whose places are cancelled: locked after its event (E-plan 4.2). */
  eventBookingId?: string | null
  /** Gift cards sold by the lines being refunded (voided), locked in id order. */
  giftCardIds?: readonly string[]
}

export interface HeldRefundLocks {
  orderId: string
  customerId: string
  sessionPassIds: string[]
  membershipIds: string[]
  variantIds: string[]
  eventId: string | null
  eventBookingId: string | null
  giftCardIds: string[]
}

/**
 * One statement that locks, in LOCK_ORDER, the order, its customer, the session passes, the memberships, the product
 * variants, the event, the event booking and the gift cards. As lockForOrder and lockForBooking: each lateral
 * subquery names the one before it, so Postgres runs it only once the one before has taken its lock, and a locking
 * SELECT sorts before it locks, so each set is taken in id order.
 *
 * The order is locked FOR UPDATE, as T2, the undo and the close by hand lock it. Everything after it is FOR NO KEY
 * UPDATE, the lock an UPDATE of the row takes: two refunds of the same row queue, while an insert that only points at
 * the row (an order's foreign key on the customer, an attendee's on the event booking) doesn't wait.
 * Null when the order doesn't exist: nothing else is locked then.
 *
 * Exported for its test only: Postgres usually runs the laterals in the order written even without the reference to
 * the one before, so a missing reference changes nothing a race test can see until the day the planner reorders
 * them. claims-postgres.test.ts reads the statement itself and fails if any lateral stops naming the one before it.
 */
export const REFUND_LOCK_SQL = `
SELECT o.id AS order_id, o.customer_id, c.id AS customer_locked, sp.ids AS session_pass_ids, m.ids AS membership_ids, v.ids AS variant_ids,
       e.id AS event_id, eb.id AS event_booking_id, g.ids AS gift_card_ids
FROM (SELECT id, customer_id FROM orders WHERE id = $1::uuid FOR UPDATE) o
JOIN LATERAL (SELECT id FROM customers WHERE id = o.customer_id FOR NO KEY UPDATE) c ON true
LEFT JOIN LATERAL (
  SELECT array_agg(locked.id ORDER BY locked.id) AS ids
  FROM (
    SELECT id FROM customer_session_passes WHERE id = ANY($2::uuid[]) AND c.id IS NOT NULL
    ORDER BY id
    FOR NO KEY UPDATE
  ) locked
) sp ON true
LEFT JOIN LATERAL (
  SELECT array_agg(locked.id ORDER BY locked.id) AS ids
  FROM (
    SELECT id FROM customer_memberships WHERE id = ANY($3::uuid[]) AND (sp.ids IS NULL OR sp.ids IS NOT NULL)
    ORDER BY id
    FOR NO KEY UPDATE
  ) locked
) m ON true
LEFT JOIN LATERAL (
  SELECT array_agg(locked.id ORDER BY locked.id) AS ids
  FROM (
    SELECT id FROM product_variants WHERE id = ANY($4::uuid[]) AND (m.ids IS NULL OR m.ids IS NOT NULL)
    ORDER BY id
    FOR NO KEY UPDATE
  ) locked
) v ON true
LEFT JOIN LATERAL (
  SELECT id FROM events WHERE id = $5::uuid AND (v.ids IS NULL OR v.ids IS NOT NULL) FOR NO KEY UPDATE
) e ON true
LEFT JOIN LATERAL (
  SELECT id FROM event_bookings WHERE id = $6::uuid AND (e.id IS NULL OR e.id IS NOT NULL) FOR NO KEY UPDATE
) eb ON true
LEFT JOIN LATERAL (
  SELECT array_agg(locked.id ORDER BY locked.id) AS ids
  FROM (
    SELECT id FROM gift_cards WHERE id = ANY($7::uuid[]) AND (eb.id IS NULL OR eb.id IS NOT NULL)
    ORDER BY id
    FOR NO KEY UPDATE
  ) locked
) g ON true`

const sortedIds = (ids: readonly string[] | undefined): string[] => [...new Set(ids ?? [])].sort()

export async function lockForRefund(tx: Tx, targets: RefundLockTargets): Promise<HeldRefundLocks | null> {
  const row = (
    await tx.query<{
      order_id: string
      customer_id: string
      session_pass_ids: string[] | null
      membership_ids: string[] | null
      variant_ids: string[] | null
      event_id: string | null
      event_booking_id: string | null
      gift_card_ids: string[] | null
    }>(REFUND_LOCK_SQL, [
      targets.orderId,
      sortedIds(targets.sessionPassIds),
      sortedIds(targets.membershipIds),
      sortedIds(targets.productVariantIds),
      targets.eventId ?? null,
      targets.eventBookingId ?? null,
      sortedIds(targets.giftCardIds),
    ])
  )[0]
  if (!row) return null
  return {
    orderId: row.order_id,
    customerId: row.customer_id,
    sessionPassIds: row.session_pass_ids ?? [],
    membershipIds: row.membership_ids ?? [],
    variantIds: row.variant_ids ?? [],
    eventId: row.event_id,
    eventBookingId: row.event_booking_id,
    giftCardIds: row.gift_card_ids ?? [],
  }
}
