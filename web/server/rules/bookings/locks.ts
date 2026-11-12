// New in W17 (D-plan 4.5): the row locks a booking change takes, in LOCK_ORDER (server/rules/orders/locks.ts).
import 'server-only'
import type { Tx } from '@/server/db'

/**
 * What a booking change's checks depend on. The booking comes first (LOCK_ORDER's 'booking', straight after 'order'),
 * then its customer, then the sessions whose places change, then the rows its money parts draw on. A flow's C2 and
 * undo, and a refund's R2, lock their own record first (readFlow with `lock`), then call this.
 */
export interface BookingLockTargets {
  bookingId: string
  /**
   * Sessions whose places the change counts or moves: the booking's own and, for a Move, the new one. Locked in id
   * order, so a move A to B and a move B to A queue rather than deadlock. The booking's own session is added here
   * from the booking row when `ownSession` is true.
   */
  sessionIds?: readonly string[]
  ownSession?: boolean
  /** Membership credit periods a credit seat draws on or gives back to, locked in id order. */
  creditPeriodIds?: readonly string[]
  /** The session pass a seat draws on or gives back to. */
  sessionPassId?: string | null
  /** Memberships whose add-on credits the change draws on or gives back, locked in id order. */
  membershipIds?: readonly string[]
  /** The gift card used to pay or given back to. */
  giftCardId?: string | null
}

export interface HeldBookingLocks {
  bookingId: string
  customerId: string
  /** The booking's own session, as the locked row has it. */
  bookingSessionId: string
  /** Every session locked, in the order locked (id order). */
  sessionIds: string[]
  creditPeriodIds: string[]
  sessionPassId: string | null
  membershipIds: string[]
  giftCardId: string | null
}

/**
 * One statement that locks, in LOCK_ORDER, the booking, its customer, the sessions, the credit periods, the pass, the
 * memberships and the gift card. As lockForOrder: each lateral subquery names the one before it, so Postgres runs it
 * only once the one before has taken its lock, and a locking SELECT sorts before it locks, so each set is taken in
 * id order. FOR NO KEY UPDATE is the lock an UPDATE of the row takes: two changes to the same booking queue, while a
 * booking_guests or order line insert that only points at the booking (a foreign key's KEY SHARE) doesn't wait.
 * Null when the booking doesn't exist: nothing else is locked then.
 */
const LOCK_SQL = `
SELECT b.id AS booking_id, b.customer_id, b.session_id AS booking_session_id, c.id AS customer_locked, s.ids AS session_ids,
       p.ids AS credit_period_ids, sp.id AS session_pass_id, m.ids AS membership_ids, g.id AS gift_card_id
FROM (SELECT id, customer_id, session_id FROM bookings WHERE id = $1::uuid FOR NO KEY UPDATE) b
JOIN LATERAL (SELECT id FROM customers WHERE id = b.customer_id FOR NO KEY UPDATE) c ON true
LEFT JOIN LATERAL (
  SELECT array_agg(locked.id ORDER BY locked.id) AS ids
  FROM (
    SELECT id FROM sessions
    WHERE (id = ANY($2::uuid[]) OR ($3::boolean AND id = b.session_id)) AND c.id IS NOT NULL
    ORDER BY id
    FOR NO KEY UPDATE
  ) locked
) s ON true
LEFT JOIN LATERAL (
  SELECT array_agg(locked.id ORDER BY locked.id) AS ids
  FROM (
    SELECT id FROM membership_credit_periods WHERE id = ANY($4::uuid[]) AND (s.ids IS NULL OR s.ids IS NOT NULL)
    ORDER BY id
    FOR NO KEY UPDATE
  ) locked
) p ON true
LEFT JOIN LATERAL (
  SELECT id FROM customer_session_passes WHERE id = $5::uuid AND (p.ids IS NULL OR p.ids IS NOT NULL) FOR NO KEY UPDATE
) sp ON true
LEFT JOIN LATERAL (
  SELECT array_agg(locked.id ORDER BY locked.id) AS ids
  FROM (
    SELECT id FROM customer_memberships WHERE id = ANY($6::uuid[]) AND (sp.id IS NULL OR sp.id IS NOT NULL)
    ORDER BY id
    FOR NO KEY UPDATE
  ) locked
) m ON true
LEFT JOIN LATERAL (
  SELECT id FROM gift_cards WHERE id = $7::uuid AND (m.ids IS NULL OR m.ids IS NOT NULL) FOR NO KEY UPDATE
) g ON true`

const sortedIds = (ids: readonly string[] | undefined): string[] => [...new Set(ids ?? [])].sort()

export async function lockForBooking(tx: Tx, targets: BookingLockTargets): Promise<HeldBookingLocks | null> {
  const row = (
    await tx.query<{
      booking_id: string
      customer_id: string
      booking_session_id: string
      session_ids: string[] | null
      credit_period_ids: string[] | null
      session_pass_id: string | null
      membership_ids: string[] | null
      gift_card_id: string | null
    }>(LOCK_SQL, [
      targets.bookingId,
      sortedIds(targets.sessionIds),
      targets.ownSession ?? false,
      sortedIds(targets.creditPeriodIds),
      targets.sessionPassId ?? null,
      sortedIds(targets.membershipIds),
      targets.giftCardId ?? null,
    ])
  )[0]
  if (!row) return null
  return {
    bookingId: row.booking_id,
    customerId: row.customer_id,
    bookingSessionId: row.booking_session_id,
    sessionIds: row.session_ids ?? [],
    creditPeriodIds: row.credit_period_ids ?? [],
    sessionPassId: row.session_pass_id,
    membershipIds: row.membership_ids ?? [],
    giftCardId: row.gift_card_id,
  }
}
