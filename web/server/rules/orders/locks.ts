// New in W06: the row locks that make an order's checks hold until it commits (W03-plan 2.4).
import 'server-only'
import type { Tx } from '@/server/db'

/**
 * The one order every money transaction takes its row locks in (W03-plan 2.4 item 8). Two
 * transactions that lock the same rows in opposite orders can deadlock; taking them in one order
 * can't. T2, the undo and every later Worker write must keep to it. A slice that adds a lock adds it
 * in its place here, not at the end.
 */
export const LOCK_ORDER = [
  'customer',
  'promo_code',
  'session',
  'credit_period',
  'session_pass',
  'membership',
  'product_variants',
  'event',
  'gift_card',
] as const

export interface LockTargets {
  customerId: string
  sessionId: string | null
  /** The membership whose session credit pays seat 1: its current credit period is locked. */
  creditMembershipId: string | null
  sessionPassId: string | null
  /** Memberships an add-on credit is drawn from, locked in id order. */
  addonMembershipIds: readonly string[]
  /** Product variants whose stock the order claims, locked in id order (W07). */
  productVariantIds: readonly string[]
  /** The event whose places the order claims (W08). */
  eventId: string | null
}

export interface HeldLocks {
  sessionId: string | null
  /** The membership's credit period covering today's London date, when it has one. */
  creditPeriodId: string | null
  sessionPassId: string | null
  membershipIds: string[]
  /** The variants that exist, in the order they were locked. */
  variantIds: string[]
  /** The event, when it exists (W08). */
  eventId: string | null
}

/**
 * One statement that locks, in LOCK_ORDER, everything an order's checks depend on. Each lateral
 * subquery names the one before it, so Postgres can't run it until the one before has run and taken
 * its lock: the customer, then the session, then the credit period, then the pass, then the
 * memberships, sorted (a locking SELECT sorts before it locks), then the product variants, sorted the
 * same way (W07), so two orders taking the same variants in opposite basket order queue instead of
 * deadlocking, then the event (W08), so the places the facts count are current until commit. The test
 * on real Postgres proves the order by holding each row in turn. Steps not built yet (promo code, gift
 * card) join the chain in their place when their slice builds them.
 *
 * The credit period is locked in its own statement, before anything reads it, because Postgres only
 * re-checks a locked row that its holder changed: a guarded INSERT that waited for the lock would
 * still count the bookings it saw before waiting, and spend a credit that had gone (2.4 item 2).
 *
 * FOR NO KEY UPDATE is the lock an UPDATE of the row takes. It waits for another order, a claim and
 * the old createBooking's FOR UPDATE OF p, as FOR UPDATE would, but not for an insert that only
 * points at the row (a booking's or an order's foreign key on the customer or the session), which
 * FOR UPDATE would hold up for the whole of T1.
 */
const LOCK_SQL = `
SELECT s.id AS session_id, p.id AS credit_period_id, sp.id AS session_pass_id, m.ids AS membership_ids, v.ids AS variant_ids,
       e.id AS event_id
FROM (SELECT id FROM customers WHERE id = $1::uuid FOR NO KEY UPDATE) c
LEFT JOIN LATERAL (
  SELECT id FROM sessions WHERE id = $2::uuid AND c.id IS NOT NULL FOR NO KEY UPDATE
) s ON true
LEFT JOIN LATERAL (
  SELECT id FROM membership_credit_periods
  WHERE membership_id = $3::uuid
    AND (now() AT TIME ZONE 'Europe/London')::date BETWEEN period_start AND period_end
    AND (s.id IS NULL OR s.id IS NOT NULL)
  FOR NO KEY UPDATE
) p ON true
LEFT JOIN LATERAL (
  SELECT id FROM customer_session_passes WHERE id = $4::uuid AND (p.id IS NULL OR p.id IS NOT NULL) FOR NO KEY UPDATE
) sp ON true
LEFT JOIN LATERAL (
  SELECT array_agg(locked.id ORDER BY locked.id) AS ids
  FROM (
    SELECT id FROM customer_memberships
    WHERE id = ANY($5::uuid[]) AND (sp.id IS NULL OR sp.id IS NOT NULL)
    ORDER BY id
    FOR NO KEY UPDATE
  ) locked
) m ON true
LEFT JOIN LATERAL (
  SELECT array_agg(locked.id ORDER BY locked.id) AS ids
  FROM (
    SELECT id FROM product_variants
    WHERE id = ANY($6::uuid[]) AND (m.ids IS NULL OR m.ids IS NOT NULL)
    ORDER BY id
    FOR NO KEY UPDATE
  ) locked
) v ON true
LEFT JOIN LATERAL (
  SELECT id FROM events WHERE id = $7::uuid AND (v.ids IS NULL OR v.ids IS NOT NULL) FOR NO KEY UPDATE
) e ON true`

/** Null when the customer doesn't exist: nothing else is locked then. */
export async function lockForOrder(tx: Tx, targets: LockTargets): Promise<HeldLocks | null> {
  const rows = await tx.query<{
    session_id: string | null
    credit_period_id: string | null
    session_pass_id: string | null
    membership_ids: string[] | null
    variant_ids: string[] | null
    event_id: string | null
  }>(LOCK_SQL, [
    targets.customerId,
    targets.sessionId,
    targets.creditMembershipId,
    targets.sessionPassId,
    [...new Set(targets.addonMembershipIds)].sort(),
    [...new Set(targets.productVariantIds)].sort(),
    targets.eventId,
  ])
  const row = rows[0]
  if (!row) return null
  return {
    sessionId: row.session_id,
    creditPeriodId: row.credit_period_id,
    sessionPassId: row.session_pass_id,
    membershipIds: row.membership_ids ?? [],
    variantIds: row.variant_ids ?? [],
    eventId: row.event_id,
  }
}
