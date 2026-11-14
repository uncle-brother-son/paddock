// New in W27 (E-plan 4.1), lifted out of server/rules/bookings/refunds.ts with no change in what it does: the parts
// of step D's refund pipeline (W21 to W26b) that don't care what is being refunded. A claim is an audit_log row on a
// subject: a booking (step D), and from step E an order or an event booking (lead call L2: one set of three actions
// per subject, so the booking rows and step D's replay stay exactly as they were).
//
// What is here: the claim's read and write, the open-claim look (an open claim holds its subject for every other
// refund), the due list reconcile works through, one card part's key, request and send, the refusal mark and its
// read, the Stripe look-up reconcile and the close by hand use (never a send), and the held answer.
// What is not: anything that knows a booking, an order line or an event place (the R1s, R2, the undo, money owed).
// Those stay with their subject: bookings/refunds.ts today, orders/ and events/ from W28 and W30.
//
// Every statement a booking claim runs is, character for character, the statement bookings/refunds.ts ran before the
// lift (pipeline.test.ts holds them to it), and each one is run at the same point, so step D's recordings don't move.
import 'server-only'
import Stripe from 'stripe'
import { audit } from '@/server/audit'
import type { Db, Queryable, Tx } from '@/server/db'
import { stripeIdempotencyKey } from '@/server/http/idempotency'
import type { StripeClient } from '@/server/stripe/client'
import { sendOptions, type StripeTiming } from '@/server/stripe/deadline'
import { readStripeFailure } from '@/server/stripe/outcome'
import { pence } from '@/server/rules/orders/collect-saved-card'
import { refundRefusedDetail } from './failure-messages'

// --- The subjects a claim can be on (lead call L2)

export type ClaimSubjectType = 'booking' | 'order' | 'event_booking'

/** One subject's three audit_log actions: the claim, its finish, and Stripe refusing one of its card parts. */
export interface ClaimSubject {
  /** audit_log.entity_type, and the first word of each action. */
  entityType: ClaimSubjectType
  claimed: string
  finished: string
  refused: string
}

const subject = <T extends ClaimSubjectType>(entityType: T): ClaimSubject & { entityType: T } => ({
  entityType,
  claimed: `${entityType}.refund_claimed`,
  finished: `${entityType}.refund_finished`,
  refused: `${entityType}.refund_refused`,
})

/** Step D's: `booking.refund_claimed`, `booking.refund_finished`, `booking.refund_refused`. */
export const BOOKING_CLAIMS = subject('booking')
/** Step E's (W27, not used by any route until W28): `order.refund_claimed` and its finished and refused rows. */
export const ORDER_CLAIMS = subject('order')
/** Step E's (W27, not used by any route until W30): `event_booking.refund_claimed` and its finished and refused rows. */
export const EVENT_BOOKING_CLAIMS = subject('event_booking')

export const CLAIM_SUBJECTS: readonly ClaimSubject[] = [BOOKING_CLAIMS, ORDER_CLAIMS, EVENT_BOOKING_CLAIMS]

// --- The plan's card parts

/** One line's share of a card part. `addon`: a booking cancel's ticked add-on line (W23), planned beside the booking lines of its order. */
export interface CardPartLine {
  lineId: string
  amount: number
  addon?: true
}

/** One refund to one order's card: the lines' shares add up to `amount`. */
export interface CardPart {
  orderId: string
  paymentIntentId: string
  amount: number
  lines: CardPartLine[]
}

/** The key of one card part: `<claimId>:refund:<orderId>` (the claim's record id, then the order it refunds). */
export const claimRefundKey = (claimId: string, orderId: string): string => `${stripeIdempotencyKey(claimId, 'refund')}:${orderId}`

/** One part's refund request, from the claim alone, so a resend under its key is the same request. */
export function cardPartRequest(claimId: string, part: CardPart): Stripe.RefundCreateParams {
  return { payment_intent: part.paymentIntentId, amount: pence(part.amount), metadata: { refund_key: claimRefundKey(claimId, part.orderId), claim_id: claimId } }
}

// --- Claims on audit_log (step D's lead call L3: no table of their own)

/** A claim's row as it was written: which subject it is on, who made it, when, and its details (the plan among them). */
export interface ClaimRow<Details> {
  id: string
  subjectId: string
  /** The staff member who made the claim: its store credit row and its audit rows name them. */
  staffId: string | null
  at: string
  details: Details
}

/** A Worker claim on the subject with no finished row: `$1` the subject's id (as text). */
export const openClaimSql = (on: ClaimSubject): string => `
SELECT c.id FROM audit_log c
WHERE c.action = '${on.claimed}' AND c.entity_type = '${on.entityType}' AND c.entity_id = $1::text AND c.details->>'worker' = 'true'
  AND NOT EXISTS (
    SELECT 1 FROM audit_log f
    WHERE f.action = '${on.finished}' AND f.entity_type = '${on.entityType}' AND f.entity_id = c.entity_id AND f.details->>'claimId' = c.id::text
  )
LIMIT 1`

/**
 * Every Worker claim on this kind of subject with no finished row, older than `$1` minutes, oldest first: what
 * reconcile settles (D-plan 4.10). A claim and its finished row are written by different transactions only when card
 * parts were sent.
 */
export const claimsDueSql = (on: ClaimSubject): string => `
SELECT c.id FROM audit_log c
WHERE c.action = '${on.claimed}' AND c.entity_type = '${on.entityType}' AND c.details->>'worker' = 'true'
  AND c.at < now() - make_interval(mins => $1::int)
  AND NOT EXISTS (
    SELECT 1 FROM audit_log f
    WHERE f.action = '${on.finished}' AND f.entity_type = '${on.entityType}' AND f.entity_id = c.entity_id AND f.details->>'claimId' = c.id::text
  )
ORDER BY c.at, c.id`

const readClaimSql = (on: ClaimSubject): string =>
  `SELECT id, entity_id, actor_id, at, details FROM audit_log
       WHERE id = $1::uuid AND action = '${on.claimed}' AND entity_type = '${on.entityType}' AND details->>'worker' = 'true'`

const claimFinishedSql = (on: ClaimSubject): string =>
  `SELECT 1 FROM audit_log WHERE action = '${on.finished}' AND entity_type = '${on.entityType}' AND entity_id = $1::text AND details->>'claimId' = $2::text LIMIT 1`

const writeClaimSql = (on: ClaimSubject): string =>
  `INSERT INTO audit_log (at, actor_type, actor_id, action, entity_type, entity_id, request_id, details)
       VALUES (clock_timestamp(), 'staff', $1::text, '${on.claimed}', '${on.entityType}', $2::text, $3::text, $4::jsonb)
       RETURNING id, at`

const claimRefusalSql = (on: ClaimSubject): string =>
  `SELECT details->>'detail' AS detail FROM audit_log WHERE action = '${on.refused}' AND entity_type = '${on.entityType}' AND entity_id = $1::text AND details->>'claimId' = $2::text ORDER BY at, id LIMIT 1`

const asIso = (at: unknown): string => (at instanceof Date ? at.toISOString() : String(at))

/** The id of the subject's open Worker refund claim, if it has one. An open claim holds its subject for every refund. */
export async function openClaimOn(db: Queryable, on: ClaimSubject, subjectId: string): Promise<string | null> {
  return (await db.query<{ id: string }>(openClaimSql(on), [subjectId]))[0]?.id ?? null
}

/** The claim's row, or null when there is no Worker claim with that id on this kind of subject. */
export async function readClaimRow<Details>(db: Queryable, on: ClaimSubject, claimId: string): Promise<ClaimRow<Details> | null> {
  const row = (await db.query<{ id: string; entity_id: string; actor_id: string | null; at: unknown; details: Details }>(readClaimSql(on), [claimId]))[0]
  if (!row) return null
  return { id: row.id, subjectId: row.entity_id, staffId: row.actor_id, at: asIso(row.at), details: row.details }
}

/** True once the claim has its finished row (R2, the undo, reconcile or a close by hand wrote it). */
export async function claimIsFinished(db: Queryable, on: ClaimSubject, claim: { id: string; subjectId: string }): Promise<boolean> {
  return (await db.query(claimFinishedSql(on), [claim.subjectId, claim.id])).length > 0
}

/** Writes the claim's row (step D's lead call L3): the record every key and the finish come from. */
export async function writeClaimRow<Details>(
  tx: Tx,
  on: ClaimSubject,
  subjectId: string,
  details: Details,
  by: { actor: { id: string }; requestId: string }
): Promise<ClaimRow<Details>> {
  const row = (await tx.query<{ id: string; at: unknown }>(writeClaimSql(on), [by.actor.id, subjectId, by.requestId, JSON.stringify(details)]))[0]
  if (!row) throw new Error('The refund claim was not written.')
  return { id: row.id, subjectId, staffId: by.actor.id, at: asIso(row.at), details }
}

// --- Sending one card part

export type PartAnswer = { outcome: 'went'; refund: Stripe.Refund } | { outcome: 'refused'; detail: string } | { outcome: 'not_sent' } | { outcome: 'unclear'; detail: string }

const explain = (err: unknown): string => (err instanceof Error ? `${err.name}: ${err.message}` : String(err))

const accessRefused = (err: unknown): boolean =>
  err instanceof Stripe.errors.StripeAuthenticationError || err instanceof Stripe.errors.StripePermissionError

/**
 * Sends one card part, outside any transaction, under its key: Stripe's refund back (succeeded or pending) is a yes;
 * failed or cancelled, or a definite error, is a no; nothing sent (no time left before the first send) is not_sent
 * (W21a: not a refusal, Stripe never saw it); any other answer is sent once more with the same key and request, then is
 * unclear. Only the press calls this, once per part, straight after R1: reconcile never sends a refund.
 */
export async function sendCardPart(stripe: StripeClient, claimId: string, part: CardPart, timing: StripeTiming): Promise<PartAnswer> {
  const request = cardPartRequest(claimId, part)
  const key = claimRefundKey(claimId, part.orderId)
  let last = ''
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let options: Stripe.RequestOptions
    try {
      options = sendOptions(timing, { idempotencyKey: key })
    } catch (err) {
      if (attempt === 1) return { outcome: 'not_sent' }
      return { outcome: 'unclear', detail: `${last} (not sent again: ${explain(err)})` }
    }
    try {
      const refund = await stripe.refunds.create(request, options)
      if (refund.status === 'failed' || refund.status === 'canceled') return { outcome: 'refused', detail: refundRefusedDetail(`the refund ${refund.status}`) }
      return { outcome: 'went', refund }
    } catch (err) {
      const failure = readStripeFailure(err)
      if (failure.outcome === 'definite' || (accessRefused(err) && attempt === 1)) return { outcome: 'refused', detail: refundRefusedDetail(failure.message) }
      last = failure.message
    }
  }
  return { outcome: 'unclear', detail: last }
}

// --- The refusal mark (W26a)

/**
 * The mark that Stripe refused one of the claim's card parts, written before anything else is tried (the undo, R2), in
 * a transaction of its own, twice at most. Reconcile reads it (`claimRefusal`): a claim the press couldn't finish then
 * ends as money owed, never as store credit. A mark that can't be written is passed over: the press carries on, and
 * its own finish records the refusal.
 */
export async function markRefused(db: Db, on: ClaimSubject, claim: { id: string; subjectId: string; staffId: string | null }, part: CardPart, detail: string, requestId: string): Promise<void> {
  const write = (): Promise<void> =>
    db.transaction((tx) =>
      audit.recordAll(tx, [
        {
          actorType: 'staff',
          actorId: claim.staffId,
          action: on.refused,
          entityType: on.entityType,
          entityId: claim.subjectId,
          requestId,
          details: { claimId: claim.id, orderId: part.orderId, amount: part.amount, detail },
        },
      ])
    )
  try {
    await write()
  } catch {
    await write().catch(() => undefined)
  }
}

/** Stripe's reason when it refused one of the claim's card parts (the first mark), or null when it never did. */
export async function claimRefusal(db: Queryable, on: ClaimSubject, claim: { id: string; subjectId: string }): Promise<string | null> {
  const rows = await db.query<{ detail: string | null }>(claimRefusalSql(on), [claim.subjectId, claim.id])
  const row = rows[0]
  return row ? (row.detail ?? 'refused') : null
}

// --- The held answer

/** What a press answers when its claim is held: the card money known to have gone, and the words for staff. */
export interface HeldAnswer {
  cardRefundedAmount: number
  storeCreditRefundedAmount: number
  held: { claimId: string; reason: string; message: string }
}

/**
 * A claim held for reconcile (no clear answer from Stripe, or money that went and couldn't be recorded yet): no press
 * ever sends it again. `cardGone`: card money known to have gone already.
 */
export const heldAnswer = (claimId: string, reason: string, message: string, cardGone = 0): HeldAnswer => ({
  cardRefundedAmount: cardGone,
  storeCreditRefundedAmount: 0,
  held: { claimId, reason, message },
})

// --- The Stripe look-up (reconcile and the close by hand: never a send)

/** A claim's card part as Stripe shows it: a refund naming the claim, none, or more than one (left for a person). */
export type PartFound =
  | { kind: 'went' }
  | { kind: 'none' }
  /** W26a: a refund naming the claim that failed or was cancelled, and none that went: Stripe's refusal, with its words. */
  | { kind: 'refused'; detail: string }
  | { kind: 'several'; ids: string[] }
  | { kind: 'mismatch'; detail: string }
  | { kind: 'unclear'; detail: string }

const LIST_PAGE = 100
const LIST_MOST_PAGES = 10

/** Every refund on a PaymentIntent, every page (at most LIST_MOST_PAGES); 'unclear' when Stripe didn't answer. */
export async function listRefunds(
  stripe: StripeClient,
  paymentIntentId: string,
  timing: StripeTiming | undefined
): Promise<{ kind: 'listed'; refunds: Stripe.Refund[] } | { kind: 'unclear'; detail: string }> {
  const refunds: Stripe.Refund[] = []
  let startingAfter: string | undefined
  try {
    for (let page = 0; ; page += 1) {
      if (page >= LIST_MOST_PAGES) return { kind: 'unclear', detail: `more than ${LIST_PAGE * LIST_MOST_PAGES} refunds to look through` }
      const listed = await stripe.refunds.list({ payment_intent: paymentIntentId, limit: LIST_PAGE, ...(startingAfter ? { starting_after: startingAfter } : {}) }, sendOptions(timing))
      refunds.push(...listed.data)
      const last = listed.data.at(-1)
      if (!listed.has_more || !last) break
      startingAfter = last.id
    }
  } catch (err) {
    return { kind: 'unclear', detail: readStripeFailure(err).message }
  }
  return { kind: 'listed', refunds }
}

/**
 * The refunds on the part's PaymentIntent that name this claim (`metadata.claim_id`), every page. Succeeded or pending
 * is money gone; failed or cancelled, or none, is money that never went. W26a: failed or cancelled is told apart from
 * none (`refused`): Stripe got it and refused it, so reconcile never gives it as store credit. Never sends anything.
 */
export async function findCardPart(stripe: StripeClient, claimId: string, part: CardPart, timing: StripeTiming | undefined): Promise<PartFound> {
  const listed = await listRefunds(stripe, part.paymentIntentId, timing)
  if (listed.kind === 'unclear') return listed
  const matched = listed.refunds.filter((refund) => refund.metadata?.['claim_id'] === claimId)
  const live = matched.filter((refund) => refund.status !== 'failed' && refund.status !== 'canceled')
  if (live.length > 1) return { kind: 'several', ids: live.map((refund) => refund.id) }
  const refund = live[0]
  if (!refund) {
    const dead = matched[0]
    return dead ? { kind: 'refused', detail: refundRefusedDetail(`the refund ${dead.status}`) } : { kind: 'none' }
  }
  if (refund.amount !== pence(part.amount)) return { kind: 'mismatch', detail: `${refund.id} is ${refund.amount}p, the part ${pence(part.amount)}p` }
  return { kind: 'went' }
}
