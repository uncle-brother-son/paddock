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
// - due: status `active` or `past_due`, with a subscription, not read in the last FREQUENCY_READ_HOURS. W66a (W66
//   review S2): the notes are looked back over for FREQUENCY_LOOK_BACK_HOURS and no further, once for the whole list, so
//   the list costs the same however many notes there are;
// - Stripe's renewing interval (its item's price, `recurring.interval` every `interval_count`) is the row's (`month`
//   for monthly or no frequency, `year` for yearly, every 1): nothing written but the run's note of what it read;
// - another interval (or none Stripe says, or more than one item): one `listed` row, once for a membership,
//   subscription, row frequency and Stripe interval, under the membership's lock and only while it is still live
//   with that subscription and frequency. The run's item is the line, left for a person, in the run that writes it
//   and no other: the row is the record, and the next day's read finds it written already;
// - ended in Stripe, or Stripe can't find it: read, nothing listed (the other checks are about those);
// - no clear read: noted as tried (W66a, the W66 review's F3), so it goes to the back of the queue and a later run reads
//   it again. Before, five that Stripe never answers about would have taken every run's reads.
// Read only: Stripe is never sent anything from here, and the membership's row is never changed.
//
// W66a (Wayne's Q62, 23 Nov 2026): a listed mismatch is a line on the Orders page's list of things that need attention
// (frequencyMismatchesListed, read by stuck-list.ts) until a person presses Mark sorted (sortFrequencyMismatch, the
// manual close's `frequency_mismatch`: one `sorted` row, with the close's own row). It also goes when the membership is
// no longer live with that subscription and frequency. Marked sorted and still wrong at a later day's read, it is
// listed again: a price change must never pass a member by with nothing listed.
import 'server-only'
import type Stripe from 'stripe'
import { ENDED_IN_STRIPE } from '@/app/api/stripe/webhook/dispatch'
import { audit, type AuditEntry } from '@/server/audit'
import type { Db, Queryable } from '@/server/db'
import type { StripeClient } from '@/server/stripe/client'
import { NoTimeLeft, sendOptions, type StripeTiming } from '@/server/stripe/deadline'
import { readStripeFailure } from '@/server/stripe/outcome'
import { LEFT_STEP_WORDS } from './failure-messages'

/**
 * One row per run that read any: which memberships (`<membershipId>|<subscriptionId>`) it read (`details.read`), and
 * which it tried with no clear answer (`details.tried`, W66a).
 */
export const FREQUENCY_READ_ACTION = 'membership.frequency_read'
/** A mismatch listed: once for a membership, subscription, row frequency and Stripe interval. */
export const FREQUENCY_MISMATCH_ACTION = 'membership.frequency_mismatch'
/** The reason on the run's item for a membership it has just listed. */
export const MEMBERSHIP_FREQUENCY_MISMATCH = 'membership_frequency_mismatch'
/** Each live membership is read once in this many hours. */
export const FREQUENCY_READ_HOURS = 24
/** How far back the notes are looked at: a membership not named in them counts as never read (and goes first). */
export const FREQUENCY_LOOK_BACK_HOURS = 48
/** The most memberships one run reads; the rest wait for the next runs, the ones read longest ago first. */
export const MAX_FREQUENCY_READS_PER_RUN = 5

const LIVE = `cm.subscription_status IN ('active', 'past_due') AND COALESCE(cm.stripe_subscription_id, '') <> ''`
const KEY = `(cm.id::text || '|' || cm.stripe_subscription_id)`
/** A note's list of keys, by its field: nothing when it has none. */
const KEYS_OF = (field: 'read' | 'tried'): string => `jsonb_array_elements_text(CASE WHEN jsonb_typeof(n.details->'${field}') = 'array' THEN n.details->'${field}' ELSE '[]'::jsonb END)`

/**
 * The live memberships not read in the last FREQUENCY_READ_HOURS, at most `$1`: never looked at first, then the ones
 * looked at longest ago. Looked at: read, or tried with no clear answer (which leaves it due, at the back). The notes
 * of the last FREQUENCY_LOOK_BACK_HOURS are gone through once for the whole list (576 at most, a run every 5 minutes).
 */
const DUE_SQL = `
WITH looked AS MATERIALIZED (
  SELECT k.key, max(n.at) FILTER (WHERE k.clear) AS read_at, max(n.at) AS looked_at
  FROM audit_log n
  CROSS JOIN LATERAL (
    SELECT r.key, true AS clear FROM ${KEYS_OF('read')} AS r(key)
    UNION ALL
    SELECT t.key, false FROM ${KEYS_OF('tried')} AS t(key)
  ) k
  WHERE n.action = '${FREQUENCY_READ_ACTION}' AND n.entity_type = 'reconcile' AND n.at > now() - interval '${FREQUENCY_LOOK_BACK_HOURS} hours'
  GROUP BY k.key
)
SELECT cm.id::text AS membership_id, cm.stripe_subscription_id AS subscription_id, COALESCE(cm.billing_frequency, 'monthly') AS frequency
FROM customer_memberships cm
LEFT JOIN looked l ON l.key = ${KEY}
WHERE ${LIVE}
  AND (l.read_at IS NULL OR l.read_at <= now() - interval '${FREQUENCY_READ_HOURS} hours')
ORDER BY l.looked_at NULLS FIRST, cm.id
LIMIT $1::int`

const LOCK_SQL = 'SELECT id FROM customer_memberships WHERE id::text = $1 FOR NO KEY UPDATE'
/** Read in its own statement, after the lock: the row's frequency while it is still live with this subscription. */
const STILL_SQL = `SELECT COALESCE(cm.billing_frequency, 'monthly') AS frequency FROM customer_memberships cm WHERE cm.id::text = $1 AND cm.stripe_subscription_id = $2 AND ${LIVE}`

/** W66a (Q62): a person has marked the listing in row `l` as sorted. */
const SORTED = `EXISTS (
    SELECT 1 FROM audit_log s
    WHERE s.action = '${FREQUENCY_MISMATCH_ACTION}' AND s.entity_type = 'membership' AND s.entity_id = l.entity_id
      AND s.details->>'state' = 'sorted' AND s.details->>'listingId' = l.details->>'listingId'
  )`
/** A newer listing for the same membership, subscription and row frequency (Stripe's interval changed again): row `l` is no longer the line. */
const LISTED_SINCE = `EXISTS (
    SELECT 1 FROM audit_log n
    WHERE n.action = '${FREQUENCY_MISMATCH_ACTION}' AND n.entity_type = 'membership' AND n.entity_id = l.entity_id AND n.details->>'state' = 'listed'
      AND n.details->>'subscriptionId' = l.details->>'subscriptionId' AND n.details->>'frequency' = l.details->>'frequency'
      AND (n.at, n.id) > (l.at, l.id)
  )`
/** Listed already for this subscription, frequency and interval, and not marked sorted since. */
const LISTED_SQL = `
SELECT 1 FROM audit_log l
WHERE l.action = '${FREQUENCY_MISMATCH_ACTION}' AND l.entity_type = 'membership' AND l.entity_id = $1 AND l.details->>'state' = 'listed'
  AND l.details->>'subscriptionId' = $2 AND l.details->>'frequency' = $3 AND l.details->>'stripeInterval' = $4
  AND NOT ${SORTED} AND NOT ${LISTED_SINCE}
LIMIT 1`

/** The lines for the Orders page's list: each listing not sorted, while its membership is live with that subscription and frequency. Oldest first. */
const LINES_SQL = `
SELECT l.details->>'listingId' AS listing_id, l.at, l.details->>'frequency' AS frequency, l.details->>'stripeInterval' AS stripe_interval,
       cm.id::text AS membership_id, cm.stripe_subscription_id AS subscription_id, mp.name AS plan_name, c.id AS customer_id,
       NULLIF(trim(concat_ws(' ', c.first_name, c.last_name)), '') AS customer_name
FROM audit_log l
JOIN customer_memberships cm ON cm.id::text = l.entity_id AND cm.stripe_subscription_id = l.details->>'subscriptionId'
  AND COALESCE(cm.billing_frequency, 'monthly') = l.details->>'frequency'
LEFT JOIN membership_plans mp ON mp.id = cm.plan_id
LEFT JOIN customers c ON c.id = cm.customer_id
WHERE l.action = '${FREQUENCY_MISMATCH_ACTION}' AND l.entity_type = 'membership' AND l.details->>'state' = 'listed'
  AND ${LIVE} AND NOT ${SORTED} AND NOT ${LISTED_SINCE}
ORDER BY l.at, 1`

/** One listing (`$1`, its listing id): its membership, and whether a person has marked it sorted. */
const LISTING_SQL = `
SELECT l.entity_id AS membership_id, l.details->>'subscriptionId' AS subscription_id, l.details->>'frequency' AS frequency,
       l.details->>'stripeInterval' AS stripe_interval, ${SORTED} AS sorted
FROM audit_log l
WHERE l.action = '${FREQUENCY_MISMATCH_ACTION}' AND l.entity_type = 'membership' AND l.details->>'state' = 'listed' AND l.details->>'listingId' = $1`

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
  /** No clear read: not counted as read, so a later run reads it again. `tried`: Stripe was asked (not when the run had no time left to ask). */
  | { kind: 'wait'; tried: boolean; detail: string }

type By = { actor: { type: 'staff' | 'system'; id: string | null }; requestId: string }

/** One membership's subscription read, and at most one row. Never a send, and never throws for Stripe. */
export async function checkFrequency(db: Db, stripe: StripeClient, due: FrequencyDue, by: By, timing: StripeTiming | undefined): Promise<FrequencyChecked> {
  let subscription: Stripe.Subscription
  try {
    subscription = await stripe.subscriptions.retrieve(due.subscriptionId, undefined, sendOptions(timing))
  } catch (err) {
    if (err instanceof NoTimeLeft) return { kind: 'wait', tried: false, detail: err.message }
    const failure = readStripeFailure(err)
    if (failure.code === 'resource_missing') return { kind: 'read', detail: `Stripe can't find subscription ${due.subscriptionId} with the key in use` }
    return { kind: 'wait', tried: true, detail: `not read (${failure.message})` }
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

/** The run's one note of the memberships it read and (W66a) tried with no clear answer (none when it did neither). */
export async function recordFrequencyReads(db: Db, looked: { read: readonly string[]; tried: readonly string[] }, by: By): Promise<void> {
  if (looked.read.length === 0 && looked.tried.length === 0) return
  await db.transaction((tx) =>
    audit.record(tx, {
      actorType: by.actor.type,
      actorId: by.actor.id,
      action: FREQUENCY_READ_ACTION,
      entityType: 'reconcile',
      entityId: by.requestId,
      requestId: by.requestId,
      details: { read: [...looked.read], ...(looked.tried.length > 0 ? { tried: [...looked.tried] } : {}) },
    })
  )
}

// --- The Orders page's line (W66a, Wayne's Q62)

/** One line as the stuck list reads it. */
export interface FrequencyMismatchListed {
  listingId: string
  membershipId: string
  subscriptionId: string
  /** When it was listed. */
  at: string
  customerId: string | null
  customerName: string | null
  words: string
}

/** Every membership listed for renewing at another interval than its row says, oldest first: the stuck list's. */
export async function frequencyMismatchesListed(db: Queryable): Promise<FrequencyMismatchListed[]> {
  const rows = await db.query<{
    listing_id: string
    at: string | Date
    frequency: string
    stripe_interval: string
    membership_id: string
    subscription_id: string
    plan_name: string | null
    customer_id: string | null
    customer_name: string | null
  }>(LINES_SQL)
  return rows.map((row) => ({
    listingId: row.listing_id,
    membershipId: row.membership_id,
    subscriptionId: row.subscription_id,
    at: (row.at instanceof Date ? row.at : new Date(row.at)).toISOString(),
    customerId: row.customer_id,
    customerName: row.customer_name,
    words: LEFT_STEP_WORDS.frequencyMismatch(row.customer_name, row.plan_name, row.frequency, row.stripe_interval, row.subscription_id),
  }))
}

/** A listing as Mark sorted records it. */
export interface FrequencyListing {
  listingId: string
  membershipId: string
  subscriptionId: string
  frequency: string
  stripeInterval: string
}

export type SortedFrequency = { closed: true; alreadyClosed?: true } | { closed: false; reason: 'not_listed' }

/**
 * Mark sorted on a listed mismatch (the manual close, close-stuck.ts; Issue refunds, checked by its route): one `sorted`
 * row with the reason, and `closeRow`, the close's own `order.close` row, in one transaction under the membership's
 * lock (the listing's). Nothing is sent to Stripe, nothing is read there, and the membership's row is never changed. A
 * listing that has gone from the list in the meantime (the membership ended, or its subscription or frequency changed)
 * is refused `not_listed`; one sorted already is answered so.
 */
export async function sortFrequencyMismatch(db: Db, listingId: string, why: string, by: By, closeRow: (listing: FrequencyListing) => AuditEntry): Promise<SortedFrequency> {
  return db.transaction(async (tx): Promise<SortedFrequency> => {
    const [found] = await tx.query<{ membership_id: string }>(LISTING_SQL, [listingId])
    if (!found) return { closed: false, reason: 'not_listed' }
    await tx.query(LOCK_SQL, [found.membership_id])
    // Read again in its own statement, after the lock: two presses take turns.
    const [row] = await tx.query<{ membership_id: string; subscription_id: string; frequency: string; stripe_interval: string; sorted: boolean }>(LISTING_SQL, [listingId])
    if (!row) return { closed: false, reason: 'not_listed' }
    if (row.sorted) return { closed: true, alreadyClosed: true }
    if (!(await frequencyMismatchesListed(tx)).some((line) => line.listingId === listingId)) return { closed: false, reason: 'not_listed' }
    const listing: FrequencyListing = { listingId, membershipId: row.membership_id, subscriptionId: row.subscription_id, frequency: row.frequency, stripeInterval: row.stripe_interval }
    await audit.recordAll(tx, [
      {
        actorType: by.actor.type,
        actorId: by.actor.id,
        action: FREQUENCY_MISMATCH_ACTION,
        entityType: 'membership',
        entityId: listing.membershipId,
        requestId: by.requestId,
        details: { state: 'sorted', listingId, subscriptionId: listing.subscriptionId, frequency: listing.frequency, stripeInterval: listing.stripeInterval, byHand: { why } },
      },
      closeRow(listing),
    ])
    return { closed: true }
  })
}
