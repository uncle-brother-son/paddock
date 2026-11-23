// New in W67 (H-plan 4.4, lead call L-H14; the W62 audit's L-new): a membership whose Stripe subscription renews at
// another interval than its row's `billing_frequency` says, listed once for a person.
//
// A plan price change moves members by the frequency their row records (catalog/plan-stripe.ts, LIVE_ON_PLAN_SQL:
// `COALESCE(billing_frequency, 'monthly')`). Nothing in the app writes the frequency after the order that made the
// subscription, and no app path changes a subscription's interval, but a change made by hand in Stripe's dashboard
// would leave the two disagreeing: a member whose row says yearly while Stripe renews them monthly is never picked by
// a monthly price change, and keeps paying the old price with nothing listed (Wayne's rule: never).
//
// So once a day each live membership's subscription is read (reconcile's run, a few a run, the ones read longest ago
// first, as the other membership checks):
// - due: status `active` or `past_due`, with a subscription, not read in the last FREQUENCY_READ_HOURS;
// - Stripe's renewing interval (its item's price, `recurring.interval` every `interval_count`) is the row's (`month`
//   for monthly or no frequency, `year` for yearly, every 1): nothing written but the run's note of what it read;
// - another interval (or none Stripe says, or more than one item): one `listed` row, once for a membership,
//   subscription, row frequency and Stripe interval, under the membership's lock and only while it is still live
//   with that subscription and frequency. The run's item is the line, left for a person, in the run that writes it
//   and no other: the row is the record, and the next day's read finds it written already;
// - ended in Stripe, or Stripe can't find it: read, nothing listed (the other checks are about those);
// - no clear read: nothing written, and the next run reads it again.
// Read only: Stripe is never sent anything from here, and the membership's row is never changed.
import 'server-only'
import type Stripe from 'stripe'
import { ENDED_IN_STRIPE } from '@/app/api/stripe/webhook/dispatch'
import { audit } from '@/server/audit'
import type { Db, Queryable } from '@/server/db'
import type { StripeClient } from '@/server/stripe/client'
import { NoTimeLeft, sendOptions, type StripeTiming } from '@/server/stripe/deadline'
import { readStripeFailure } from '@/server/stripe/outcome'

/** One row per run that read any: which memberships (`<membershipId>|<subscriptionId>`) it read (`details.read`). */
export const FREQUENCY_READ_ACTION = 'membership.frequency_read'
/** A mismatch listed: once for a membership, subscription, row frequency and Stripe interval. */
export const FREQUENCY_MISMATCH_ACTION = 'membership.frequency_mismatch'
/** The reason on the run's item for a membership it has just listed. */
export const MEMBERSHIP_FREQUENCY_MISMATCH = 'membership_frequency_mismatch'
/** Each live membership is read once in this many hours. */
export const FREQUENCY_READ_HOURS = 24
/** The most memberships one run reads; the rest wait for the next runs, the ones read longest ago first. */
export const MAX_FREQUENCY_READS_PER_RUN = 5

const LIVE = `cm.subscription_status IN ('active', 'past_due') AND COALESCE(cm.stripe_subscription_id, '') <> ''`
const KEY = `(cm.id::text || '|' || cm.stripe_subscription_id)`
const LAST_READ = `(SELECT max(r.at) FROM audit_log r WHERE r.action = '${FREQUENCY_READ_ACTION}' AND r.entity_type = 'reconcile' AND r.details->'read' ? ${KEY})`

/** The live memberships not read in the last FREQUENCY_READ_HOURS, never read first, then the ones read longest ago, at most `$1`. */
const DUE_SQL = `
SELECT cm.id::text AS membership_id, cm.stripe_subscription_id AS subscription_id, COALESCE(cm.billing_frequency, 'monthly') AS frequency
FROM customer_memberships cm
WHERE ${LIVE}
  AND (${LAST_READ} IS NULL OR ${LAST_READ} <= now() - interval '${FREQUENCY_READ_HOURS} hours')
ORDER BY ${LAST_READ} NULLS FIRST, cm.id
LIMIT $1::int`

const LOCK_SQL = 'SELECT id FROM customer_memberships WHERE id::text = $1 FOR NO KEY UPDATE'
/** Read in its own statement, after the lock: the row's frequency while it is still live with this subscription. */
const STILL_SQL = `SELECT COALESCE(cm.billing_frequency, 'monthly') AS frequency FROM customer_memberships cm WHERE cm.id::text = $1 AND cm.stripe_subscription_id = $2 AND ${LIVE}`
/** Listed already for this subscription, frequency and interval. */
const LISTED_SQL = `
SELECT 1 FROM audit_log
WHERE action = '${FREQUENCY_MISMATCH_ACTION}' AND entity_type = 'membership' AND entity_id = $1
  AND details->>'subscriptionId' = $2 AND details->>'frequency' = $3 AND details->>'stripeInterval' = $4
LIMIT 1`

export interface FrequencyDue {
  membershipId: string
  subscriptionId: string
  /** The row's frequency (`monthly` when it records none). */
  frequency: string
}

/** The run's note of a membership read. */
export const frequencyKey = (due: Pick<FrequencyDue, 'membershipId' | 'subscriptionId'>): string => `${due.membershipId}|${due.subscriptionId}`

export async function frequencyReadsDue(db: Queryable, most: number = MAX_FREQUENCY_READS_PER_RUN): Promise<FrequencyDue[]> {
  const rows = await db.query<{ membership_id: string; subscription_id: string; frequency: string }>(DUE_SQL, [most])
  return rows.map((row) => ({ membershipId: row.membership_id, subscriptionId: row.subscription_id, frequency: row.frequency }))
}

/** The interval a row's frequency renews at in Stripe. */
const intervalOf = (frequency: string): string => (frequency === 'yearly' ? 'year' : 'month')

/** What Stripe renews the subscription at, as `<interval>` (every 1) or `<interval>x<count>`; null when it doesn't say, or has other than one item. */
function stripeIntervalOf(subscription: Pick<Stripe.Subscription, 'items'>): string | null {
  const items = subscription.items?.data ?? []
  if (items.length !== 1) return null
  const price = items[0]?.price
  const recurring = typeof price === 'object' && price !== null ? price.recurring : null
  if (!recurring?.interval) return null
  const count = recurring.interval_count ?? 1
  return count === 1 ? recurring.interval : `${recurring.interval}x${count}`
}

export type FrequencyChecked =
  /** Read: nothing to list (the same interval, ended or missing in Stripe, listed already, or no longer live here). */
  | { kind: 'read'; detail: string }
  /** Listed by this read. */
  | { kind: 'listed'; listingId: string; frequency: string; stripeInterval: string }
  /** No clear read: not counted as read, so the next run reads it again. */
  | { kind: 'wait'; detail: string }

type By = { actor: { type: 'staff' | 'system'; id: string | null }; requestId: string }

/** One membership's subscription read, and at most one row. Never a send, and never throws for Stripe. */
export async function checkFrequency(db: Db, stripe: StripeClient, due: FrequencyDue, by: By, timing: StripeTiming | undefined): Promise<FrequencyChecked> {
  let subscription: Stripe.Subscription
  try {
    subscription = await stripe.subscriptions.retrieve(due.subscriptionId, undefined, sendOptions(timing))
  } catch (err) {
    if (err instanceof NoTimeLeft) return { kind: 'wait', detail: err.message }
    const failure = readStripeFailure(err)
    if (failure.code === 'resource_missing') return { kind: 'read', detail: `Stripe can't find subscription ${due.subscriptionId} with the key in use` }
    return { kind: 'wait', detail: `not read (${failure.message})` }
  }
  if (ENDED_IN_STRIPE.includes(subscription.status)) return { kind: 'read', detail: `subscription ${due.subscriptionId} is ${subscription.status} in Stripe` }
  const stripeInterval = stripeIntervalOf(subscription)
  if (stripeInterval === intervalOf(due.frequency)) return { kind: 'read', detail: `renews every ${stripeInterval}, as its row` }
  const seen = stripeInterval ?? 'unknown'
  return db.transaction(async (tx): Promise<FrequencyChecked> => {
    await tx.query(LOCK_SQL, [due.membershipId])
    const [still] = await tx.query<{ frequency: string }>(STILL_SQL, [due.membershipId, due.subscriptionId])
    if (!still || still.frequency !== due.frequency) return { kind: 'read', detail: 'no longer live with this subscription and frequency: not listed' }
    if ((await tx.query(LISTED_SQL, [due.membershipId, due.subscriptionId, due.frequency, seen])).length > 0) return { kind: 'read', detail: 'listed already' }
    const listingId = crypto.randomUUID()
    await audit.record(tx, {
      actorType: by.actor.type,
      actorId: by.actor.id,
      action: FREQUENCY_MISMATCH_ACTION,
      entityType: 'membership',
      entityId: due.membershipId,
      requestId: by.requestId,
      details: { state: 'listed', listingId, subscriptionId: due.subscriptionId, frequency: due.frequency, stripeInterval: seen, stripeStatus: subscription.status },
    })
    return { kind: 'listed', listingId, frequency: due.frequency, stripeInterval: seen }
  })
}

/** The run's one note of the memberships it read (none when it read none). */
export async function recordFrequencyReads(db: Db, keys: readonly string[], by: By): Promise<void> {
  if (keys.length === 0) return
  await db.transaction((tx) =>
    audit.record(tx, { actorType: by.actor.type, actorId: by.actor.id, action: FREQUENCY_READ_ACTION, entityType: 'reconcile', entityId: by.requestId, requestId: by.requestId, details: { read: [...keys] } })
  )
}
