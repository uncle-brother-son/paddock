// New in W46 (G-plan 2.1; W45a "Noticed" 8, the W45 audit's S1, way 3): a membership with no Stripe subscription,
// ended in the database once its last day has passed.
//
// A membership with a subscription ends when Stripe ends the subscription: its `customer.subscription.deleted` event
// marks the row cancelled (membership_mark_cancelled_by_stripe). A membership with no subscription has no such event.
// Cancel sets its last day (memberships/cancel.ts: M1 only, no Stripe step) and nothing ever ended it: the row read
// "active" for ever with its last day behind it, though every rule that reads the date gave the member no access.
//
// Reconcile's run (every five minutes, and staff's Resolve now) ends each one, a few a run, oldest last day first:
// one transaction under the row's lock, after looking again, doing what the database does when Stripe ends a
// subscription whose last day was already set: the status `cancelled` (the last day kept), the membership's credit
// bookings after that day flagged as payment needed (flag_uncovered_credit_bookings, as the database's own function
// calls it), and one audit row. No Stripe call: there is no subscription.
//
// Only `active`: the status the audit found left behind. A membership with a subscription is never touched here,
// whatever its date: Stripe ends those, and the 20-minute check lists a row that disagrees with Stripe (left.ts).
import 'server-only'
import { audit } from '@/server/audit'
import type { Db, Queryable } from '@/server/db'

export const MEMBERSHIP_ENDED_ACTION = 'membership.ended_without_subscription'
/** The most memberships one run ends; the rest wait for the next run. */
export const MAX_ENDINGS_PER_RUN = 10

/** Active, no subscription, and its last day before today in London. Oldest last day first. */
const DUE_SQL = `
SELECT id FROM customer_memberships
WHERE COALESCE(stripe_subscription_id, '') = '' AND subscription_status = 'active'
  AND cancel_effective_date < (now() AT TIME ZONE 'Europe/London')::date
ORDER BY cancel_effective_date, id
LIMIT $1::int`

/** The same test for one membership (`$1`), under its lock: its last day when it is still due, no row when it isn't. */
const LOCK_DUE_SQL = `
SELECT cancel_effective_date::text AS last_day FROM customer_memberships
WHERE id = $1::uuid AND COALESCE(stripe_subscription_id, '') = '' AND subscription_status = 'active'
  AND cancel_effective_date < (now() AT TIME ZONE 'Europe/London')::date
FOR UPDATE`

const END_SQL = "UPDATE customer_memberships SET subscription_status = 'cancelled', updated_at = now() WHERE id = $1::uuid"
const FLAG_SQL = 'SELECT public.flag_uncovered_credit_bookings($1::uuid, $2::date) AS flagged'

/** The memberships due, oldest last day first, at most `limit`. */
export async function membershipsToEnd(db: Queryable, limit = MAX_ENDINGS_PER_RUN): Promise<string[]> {
  return (await db.query<{ id: string }>(DUE_SQL, [limit])).map((row) => row.id)
}

export type MembershipEnded =
  /** Marked cancelled. `bookingsFlagged`: its credit bookings after the last day, now payment needed. */
  | { ended: true; lastDay: string; bookingsFlagged: number }
  /** No longer due under its lock (ended meanwhile, given a subscription, or its cancellation undone): nothing written. */
  | { ended: false }

/** Ends one membership, if it is still due under its lock. `by`: the run. */
export async function endMembershipWithoutSubscription(db: Db, membershipId: string, by: { actor: { type: 'staff' | 'system'; id: string | null }; requestId: string }): Promise<MembershipEnded> {
  return db.transaction(async (tx) => {
    const [due] = await tx.query<{ last_day: string }>(LOCK_DUE_SQL, [membershipId])
    if (!due) return { ended: false as const }
    await tx.query(END_SQL, [membershipId])
    const flagged = Number((await tx.query<{ flagged: number | string }>(FLAG_SQL, [membershipId, due.last_day]))[0]?.flagged ?? 0)
    await audit.recordAll(tx, [
      {
        actorType: by.actor.type,
        actorId: by.actor.id,
        action: MEMBERSHIP_ENDED_ACTION,
        entityType: 'membership',
        entityId: membershipId,
        requestId: by.requestId,
        details: { lastDay: due.last_day, was: 'active', bookingsFlagged: flagged },
      },
    ])
    return { ended: true as const, lastDay: due.last_day, bookingsFlagged: flagged }
  })
}
