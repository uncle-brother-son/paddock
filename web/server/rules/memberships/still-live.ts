// New in W47r-e (brief item 3; W47r-d report "Noticed" 3): a membership past its last day whose Stripe subscription
// is still live, listed for a person.
//
// A membership with a subscription ends here when Stripe ends the subscription: Stripe's own notice marks the row
// cancelled. When a cancel pressed here never reached Stripe, Stripe never ends it. The row keeps its status with
// its last day behind it, Stripe renews it month after month, and (with migration 031) each renewal is listed for a
// refund, one line a month, with nothing saying that the subscription itself is the thing to put right.
//
// Reconcile's run (every five minutes, and staff's Resolve now) reads Stripe for each such membership, a few a run,
// the ones read longest ago first:
// - due: status `active` or `past_due`, a subscription, and a last day before today in London, once that day has
//   been over for 20 minutes (Stripe ends a subscription a little after its `cancel_at`, and its notice follows: an
//   ordinary ending is never read at all);
// - Stripe shows the subscription live: one `listed` row, once for a membership and subscription, under the
//   membership's lock and only while it is still due. The stuck list shows it under membership changes with the
//   customer's name and the last day. Not listed while Stripe's own end for it is already due (Stripe is ending it);
// - Stripe shows it ended: one `ended` row. It takes the line off the list, if there was one, and the membership is
//   not read again. Nothing else is written: the membership's row is left alone (Stripe's own notice ends it);
// - no clear read, or Stripe can't find the subscription: nothing is written, and a later run reads again.
// The line also goes as soon as the row is no longer due: Stripe's notice marked it cancelled, or its last day moved.
// Read only: Stripe is never sent anything from here, and the membership's row is never changed.
import 'server-only'
import type Stripe from 'stripe'
import { ENDED_IN_STRIPE } from '@/app/api/stripe/webhook/dispatch'
import { audit } from '@/server/audit'
import type { Db, Queryable } from '@/server/db'
import type { StripeClient } from '@/server/stripe/client'
import { NoTimeLeft, sendOptions, type StripeTiming } from '@/server/stripe/deadline'
import { readStripeFailure } from '@/server/stripe/outcome'
import { CHECK_AFTER_MINUTES, stripeEnds } from './left'

export const STILL_LIVE_ACTION = 'membership.still_live_in_stripe'
/** The most memberships one run reads Stripe for; the rest wait for the next runs, the ones read longest ago first. */
export const MAX_STILL_LIVE_READS_PER_RUN = 5
/** How long after the last day ends (London midnight) before a membership is read: the step check's own wait. */
export const STILL_LIVE_AFTER_MINUTES = CHECK_AFTER_MINUTES
/** The reason on the run's row for a membership it has just listed. */
export const MEMBERSHIP_STILL_LIVE = 'membership_still_live'

/** A membership that has not ended here, has a subscription, and whose last day is before today in London. */
const PAST_LAST_DAY = `
cm.subscription_status IN ('active', 'past_due') AND COALESCE(cm.stripe_subscription_id, '') <> ''
  AND cm.cancel_effective_date < (now() AT TIME ZONE 'Europe/London')::date`

/** Stripe was seen to have ended this membership's subscription: it never comes back, so there is nothing more to read or list. */
const NOT_SEEN_ENDED = `
NOT EXISTS (
    SELECT 1 FROM audit_log e
    WHERE e.action = '${STILL_LIVE_ACTION}' AND e.entity_type = 'membership' AND e.entity_id = cm.id::text
      AND e.details->>'subscriptionId' = cm.stripe_subscription_id AND e.details->>'state' = 'ended'
  )`

/** The memberships to read Stripe for: past their last day by STILL_LIVE_AFTER_MINUTES, and not seen ended. Oldest last day first. */
const DUE_SQL = `
SELECT cm.id::text AS membership_id, cm.stripe_subscription_id AS subscription_id, cm.cancel_effective_date::text AS last_day
FROM customer_memberships cm
WHERE ${PAST_LAST_DAY}
  AND (now() AT TIME ZONE 'Europe/London') >= (cm.cancel_effective_date + 1)::timestamp + interval '${STILL_LIVE_AFTER_MINUTES} minutes'
  AND ${NOT_SEEN_ENDED}
ORDER BY cm.cancel_effective_date, cm.id`

/** One membership (`$1`) and subscription (`$2`), under its lock: its last day while it is still past it, no row when it isn't. */
const LOCK_SQL = 'SELECT id FROM customer_memberships WHERE id::text = $1 FOR NO KEY UPDATE'
const STILL_PAST_SQL = `
SELECT cm.cancel_effective_date::text AS last_day FROM customer_memberships cm
WHERE cm.id::text = $1 AND cm.stripe_subscription_id = $2 AND ${PAST_LAST_DAY}`

/** The rows already written for a membership (`$1`) and subscription (`$2`): at most one `listed` and one `ended`. */
const ROWS_SQL = `
SELECT details->>'state' AS state, details->>'listingId' AS listing_id FROM audit_log
WHERE action = '${STILL_LIVE_ACTION}' AND entity_type = 'membership' AND entity_id = $1 AND details->>'subscriptionId' = $2`

/**
 * The lines for the stuck list: each `listed` row whose membership is still past its last day with the same
 * subscription and has not been seen ended. The last day is the row's own, as it stands now. Oldest first.
 */
const LISTED_SQL = `
SELECT l.details->>'listingId' AS listing_id, l.at, cm.id::text AS membership_id, cm.stripe_subscription_id AS subscription_id,
       cm.cancel_effective_date::text AS last_day, c.id AS customer_id,
       NULLIF(trim(concat_ws(' ', c.first_name, c.last_name)), '') AS customer_name
FROM audit_log l
JOIN customer_memberships cm ON cm.id::text = l.entity_id AND cm.stripe_subscription_id = l.details->>'subscriptionId'
LEFT JOIN customers c ON c.id = cm.customer_id
WHERE l.action = '${STILL_LIVE_ACTION}' AND l.entity_type = 'membership' AND l.details->>'state' = 'listed'
  AND ${PAST_LAST_DAY}
  AND ${NOT_SEEN_ENDED}
ORDER BY l.at, 1`

export interface StillLiveDue {
  membershipId: string
  subscriptionId: string
  /** The membership's last day (YYYY-MM-DD). */
  lastDay: string
}

/** A check has no id of its own until it lists: its membership and subscription. */
export const stillLiveKey = (due: Pick<StillLiveDue, 'membershipId' | 'subscriptionId'>): string => `${due.membershipId}|${due.subscriptionId}`

/** The memberships due a read, oldest last day first. */
export async function stillLiveDue(db: Queryable): Promise<StillLiveDue[]> {
  return (await db.query<{ membership_id: string; subscription_id: string; last_day: string }>(DUE_SQL)).map((row) => ({ membershipId: row.membership_id, subscriptionId: row.subscription_id, lastDay: row.last_day }))
}

/** One line as the stuck list reads it. */
export interface StillLiveListed {
  listingId: string
  membershipId: string
  subscriptionId: string
  lastDay: string
  /** When it was listed. */
  at: string
  customerId: string | null
  customerName: string | null
}

/** Every membership listed as still live in Stripe, oldest first: the stuck list's. */
export async function stillLiveListed(db: Queryable): Promise<StillLiveListed[]> {
  const rows = await db.query<{ listing_id: string; at: string | Date; membership_id: string; subscription_id: string; last_day: string; customer_id: string | null; customer_name: string | null }>(LISTED_SQL)
  return rows.map((row) => ({
    listingId: row.listing_id,
    membershipId: row.membership_id,
    subscriptionId: row.subscription_id,
    lastDay: row.last_day,
    at: (row.at instanceof Date ? row.at : new Date(row.at)).toISOString(),
    customerId: row.customer_id,
    customerName: row.customer_name,
  }))
}

export type StillLiveChecked =
  /** Stripe shows the subscription live and the line was written by this read. */
  | { kind: 'listed'; listingId: string; lastDay: string; status: string }
  /** Stripe shows it live and it is listed already: nothing written. */
  | { kind: 'already_listed' }
  /** Stripe shows it ended: recorded, so it is no longer listed (`wasListed`) and not read again. */
  | { kind: 'ended'; wasListed: boolean }
  /** Nothing written: no clear read, Stripe is ending it now, or the membership is no longer past its last day. A later run looks again. */
  | { kind: 'wait'; detail: string }

type By = { actor: { type: 'staff' | 'system'; id: string | null }; requestId: string }

/**
 * One read of a due membership's subscription, and at most one row. Never a send, and never throws for Stripe. The
 * row is written in one transaction under the membership's lock, after looking again: nothing is listed for a
 * membership that is no longer past its last day (Stripe's notice ended it meanwhile, or its last day moved), and
 * nothing twice. `now`: the time in milliseconds (the run's clock).
 */
export async function checkStillLive(db: Db, stripe: StripeClient, due: StillLiveDue, by: By, timing: StripeTiming | undefined, now: () => number = Date.now): Promise<StillLiveChecked> {
  let subscription: Stripe.Subscription
  try {
    subscription = await stripe.subscriptions.retrieve(due.subscriptionId, undefined, sendOptions(timing))
  } catch (err) {
    if (err instanceof NoTimeLeft) return { kind: 'wait', detail: err.message }
    const failure = readStripeFailure(err)
    // Not "ended": the key in use can't see it (deleted test data, or the other mode's). Nothing can be said about it.
    if (failure.code === 'resource_missing') return { kind: 'wait', detail: `Stripe can't find subscription ${due.subscriptionId} with the key in use` }
    return { kind: 'wait', detail: `not read (${failure.message})` }
  }
  const ended = ENDED_IN_STRIPE.includes(subscription.status)
  if (!ended) {
    // Stripe ends a subscription a little after its end falls due, and its notice then ends the membership here.
    const ends = stripeEnds(subscription)
    if (typeof ends === 'number' && ends * 1000 <= now()) return { kind: 'wait', detail: `Stripe shows subscription ${due.subscriptionId} ${subscription.status} with its end already due: it is ending it` }
  }
  return db.transaction(async (tx) => {
    await tx.query(LOCK_SQL, [due.membershipId])
    const rows = await tx.query<{ state: string; listing_id: string | null }>(ROWS_SQL, [due.membershipId, due.subscriptionId])
    const listed = rows.find((row) => row.state === 'listed')
    const entry = (state: 'listed' | 'ended', details: Record<string, unknown>) => ({
      actorType: by.actor.type,
      actorId: by.actor.id,
      action: STILL_LIVE_ACTION,
      entityType: 'membership',
      entityId: due.membershipId,
      requestId: by.requestId,
      details: { state, subscriptionId: due.subscriptionId, stripeStatus: subscription.status, ...details },
    })
    if (ended) {
      if (!rows.some((row) => row.state === 'ended')) await audit.recordAll(tx, [entry('ended', { wasListed: listed !== undefined, ...(listed?.listing_id ? { listingId: listed.listing_id } : {}) })])
      return { kind: 'ended' as const, wasListed: listed !== undefined }
    }
    if (listed) return { kind: 'already_listed' as const }
    const [still] = await tx.query<{ last_day: string }>(STILL_PAST_SQL, [due.membershipId, due.subscriptionId])
    if (!still) return { kind: 'wait' as const, detail: 'no longer past its last day with this subscription: not listed' }
    const listingId = crypto.randomUUID()
    await audit.recordAll(tx, [entry('listed', { listingId, lastDay: still.last_day, stripeEnds: stripeEnds(subscription) ?? null })])
    return { kind: 'listed' as const, listingId, lastDay: still.last_day, status: subscription.status }
  })
}
