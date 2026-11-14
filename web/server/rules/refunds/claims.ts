// New in W27 (E-plan 4.2, lead call L2): refund claims on an order and on an event booking, on step D's pipeline
// (pipeline.ts). The same record as a booking's claim with a different subject: `order.refund_claimed` /
// `event_booking.refund_claimed`, each with its finished and refused rows; the same details (kind, amount, method,
// reason, `worker: true`, the plan, `livemode`); the same key, `<claimId>:refund:<orderId>`, with `metadata.claim_id`.
// Not called by any route yet: W28 (order refunds) and W30 (event places) write their R1s, R2s and undos on this.
//
// Two rules of step E are kept here, at the one place a claim is written, so no later slice can forget them:
// - One card part at most. An order refund or an event cancel only ever touches one order (an event booking is always
//   paid by one order), so "a later part refused" can't happen. A plan with two parts, or a part on another order, is
//   a fault in the caller and is never written.
// - An open claim holds its subject. Any other refund on that order or event booking is refused until the claim is
//   finished (`refund_open`). An order and its event booking share one card payment and one "money owed", so an open
//   claim on either holds both; so does an open booking claim with a card part on that order's payment (step D).
//
// What makes the look for an open claim hold (W27a; W27 review S1 and S2):
// - Against an order's and an event booking's claims: the order's row lock. Both writers take it themselves, FOR
//   UPDATE (the event booking's on its `details.orderId`), before they look. Two claims on one order queue there, the
//   second looks once the first has committed, and is refused. A caller that holds the lock already through
//   lockForRefund (locks.ts) loses nothing; one that forgot it is held all the same.
// - Against a booking's claim: one way, and only once that claim is committed (lead's call (a), 14 Nov). Step D's
//   booking refunds lock the booking and never the order row, so the order's lock doesn't make them queue: a booking
//   claim being written at the same moment isn't seen here, and a booking's refund never looks for an order's or an
//   event booking's claim. Step D's lock order is not changed for it.
// - Why money still can't go twice in that gap: the two claims are never for the same line (a booking's claim only
//   gives back its own booking's lines, and an order's refund refuses a booking's line, as the old refundOrder does;
//   W28's R1 keeps that refusal); each side stamps its lines under its own lock; each claim's card part has its own
//   key; and Stripe never refunds more than the payment took. The worst case is a card part Stripe refuses for going
//   over what is left on the payment, which ends as the refusal's words or as money owed, never as money sent twice.
import 'server-only'
import type { Db, Queryable, Tx } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import { EVENT_BOOKING_REFUND_OPEN_MESSAGE, ORDER_PAYMENT_REFUND_OPEN_MESSAGE, ORDER_REFUND_OPEN_MESSAGE } from './failure-messages'
import {
  BOOKING_CLAIMS,
  claimIsFinished,
  claimRefusal,
  claimsDueSql,
  EVENT_BOOKING_CLAIMS,
  markRefused,
  ORDER_CLAIMS,
  readClaimRow,
  writeClaimRow,
  type CardPart,
  type ClaimSubject,
} from './pipeline'

export type StepEClaimMethod = 'card' | 'credit' | 'cash'

/**
 * Where the claimed money goes, as step D's plan: the card part (one at most) with store credit for the rest, or (Q26)
 * cash. W28 (Wayne's Q42, 14 Nov): cash is capped at the cash paid on the order, and the rest of what the lines give
 * back goes to store credit in the same claim (an order paid £10 cash + £5 gift card: £10 in cash, £5 store credit).
 */
export interface StepEPlan {
  /** None, or exactly one, and always on the claim's own order. */
  card: CardPart[]
  storeCredit: number
  cash: number
  /** The order the store credit's row is linked to: the claim's own order. */
  ownOrderId: string | null
}

/** The fields every claim's details carry, as step D's (bookings/refunds.ts `ClaimDetails`), less what only a booking has. */
interface StepEClaimCommon {
  amount: number
  method: StepEClaimMethod
  reason: string | null
  /** A claim the Worker made: reconcile and the stuck list look at these only. */
  worker: true
  plan: StepEPlan
  /** The Stripe key's mode the card part is sent with (true live), for reconcile's "not found". Null with no card part. */
  livemode: boolean | null
  /** Q26: who handed the cash over. */
  handedOverBy?: string
}

/** W28: one line an order refund's R1 stamped, with what R1 reversed for it, so the undo puts it back exactly. */
export interface OrderRefundLineClaim {
  id: string
  itemType: string
  /** What the line gives back: its total, less its promo discount, less card money it has already had back. */
  amount: number
  /** The line's stamp: `card` while the card part lasts (line order), `cash` while the cash lasts, else `credit`. */
  method: StepEClaimMethod
  /** A product line's restock decision (null for every other kind of line). */
  restocked: boolean | null
  /** A gift card line: the card R1 voided. */
  giftCardId?: string
  /** A pass line: the pass R1 emptied, and the sessions it held. */
  pass?: { id: string; sessionsRemaining: number }
  /** A restocked product line: the variant and quantity R1 put back, and its stock adjustment's row. */
  restock?: { variantId: string; quantity: number; adjustmentId: string }
  /**
   * W29, a line that sells a membership: the membership R1 marked cancelled, as it was before (for the undo), the
   * future credit bookings R1 flagged as payment needed (Q41; the undo confirms them again), and its Stripe
   * subscription, cancelled last, once the money is settled (null when it never had one).
   */
  membership?: {
    id: string
    subscriptionId: string | null
    status: string | null
    addonCredits: number
    cancelEffectiveDate: string | null
    flaggedBookingIds: string[]
  }
}

/**
 * An order's claim: `refund` (lines refunded, W28) or `refund_owed` (Refund the rest on an order, W28). `lines`
 * (W28, a `refund` only): what R1 stamped and reversed, for the undo and for the action's own row.
 */
export interface OrderClaimDetails extends StepEClaimCommon {
  kind: 'refund' | 'refund_owed'
  lines?: OrderRefundLineClaim[]
}

/**
 * An event booking's claim: `cancel_places` (places cancelled with money back, W30). `orderId` is the one order that
 * paid for the booking: its card part and the money owed sit there, and an open claim holds that order too.
 */
export interface EventBookingClaimDetails extends StepEClaimCommon {
  kind: 'cancel_places'
  orderId: string
}

export interface OrderClaim {
  id: string
  orderId: string
  staffId: string | null
  at: string
  details: OrderClaimDetails
}

export interface EventBookingClaim {
  id: string
  eventBookingId: string
  /** The order that paid for the booking (the details' `orderId`). */
  orderId: string
  staffId: string | null
  at: string
  details: EventBookingClaimDetails
}

export type ClaimBy = { actor: { type: 'staff'; id: string }; requestId: string }

// --- An open claim holds its subject

/**
 * Any Worker claim with no finished row that holds this order: one on the order itself, one on an event booking the
 * order paid for, or (step D) one on a booking with a card part on this order's payment. `$1` the order (as text).
 * Fixed text: the action names are constants.
 */
const OPEN_CLAIM_HOLDING_ORDER_SQL = `
SELECT c.id, c.entity_type FROM audit_log c
WHERE c.details->>'worker' = 'true'
  AND (
    (c.action = '${ORDER_CLAIMS.claimed}' AND c.entity_type = '${ORDER_CLAIMS.entityType}' AND c.entity_id = $1::text)
    OR (c.action = '${EVENT_BOOKING_CLAIMS.claimed}' AND c.entity_type = '${EVENT_BOOKING_CLAIMS.entityType}' AND c.details->>'orderId' = $1::text)
    OR (c.action = '${BOOKING_CLAIMS.claimed}' AND c.entity_type = '${BOOKING_CLAIMS.entityType}'
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(c.details->'plan'->'card', '[]'::jsonb)) part WHERE part->>'orderId' = $1::text))
  )
  AND NOT EXISTS (
    SELECT 1 FROM audit_log f
    WHERE f.action = replace(c.action, '.refund_claimed', '.refund_finished') AND f.entity_type = c.entity_type AND f.entity_id = c.entity_id
      AND f.details->>'claimId' = c.id::text
  )
ORDER BY c.at, c.id
LIMIT 1`

/** The open claim that holds this order, and what it is on (W28, for the words). */
export interface HoldingClaim {
  id: string
  on: 'order' | 'event_booking' | 'booking'
}

/** The open claim that holds this order (its own, its event booking's, or a booking's card part on it), if any. */
export async function openClaimHolding(db: Queryable, orderId: string): Promise<HoldingClaim | null> {
  const row = (await db.query<{ id: string; entity_type: HoldingClaim['on'] }>(OPEN_CLAIM_HOLDING_ORDER_SQL, [orderId]))[0]
  return row ? { id: row.id, on: row.entity_type } : null
}

/** The id of the open claim that holds this order (its own, its event booking's, or a booking's card part on it), if any. */
export async function openClaimHoldingOrder(db: Queryable, orderId: string): Promise<string | null> {
  return (await openClaimHolding(db, orderId))?.id ?? null
}

/**
 * `refund_open`, step D's reason, with the subject's own words. Nothing was touched. W28 (W27 review L4): when an
 * order is held by a *booking's* card part (`heldBy: 'booking'`), the words name the order's card payment, because
 * staff looking at the order would see no refund on it.
 */
export function refundOpenRefusal(on: 'order' | 'event_booking', heldBy?: HoldingClaim['on']): ApiError {
  const message = on === 'event_booking' ? EVENT_BOOKING_REFUND_OPEN_MESSAGE : heldBy === 'booking' ? ORDER_PAYMENT_REFUND_OPEN_MESSAGE : ORDER_REFUND_OPEN_MESSAGE
  return new ApiError('CONFLICT', message, { details: { reason: 'refund_open', message, action: 'refund' } })
}

/**
 * Refuses (`refund_open`) while a claim that holds this order is open. Call it under the order's lock, after the
 * locks and before anything is changed: the order's own refund, and its event booking's cancel with money back.
 * On its own it is a plain read: without the order's lock two presses can both pass it. The two claim writers below
 * take that lock themselves before they call it.
 */
export async function refuseWhileRefundOpen(db: Queryable, on: 'order' | 'event_booking', orderId: string): Promise<void> {
  const holding = await openClaimHolding(db, orderId)
  if (holding !== null) throw refundOpenRefusal(on, holding.on)
}

// --- Writing a claim

/**
 * The order's row lock, as lockForRefund takes it first (locks.ts, LOCK_ORDER's first row). W27a (W27 review S1): the
 * writers take it before the look for an open claim, so the look holds even for a caller that never ran
 * lockForRefund. Taking a row lock this transaction already holds does nothing. W28 (W27a's call 2; the lead's "say
 * whether the writer should also throw"): an order that doesn't exist is a fault in the caller and throws, so no claim
 * is ever written on an order id with no row (nothing could settle it: R2, the undo and reconcile all need the order).
 * R1 refuses a missing order with `order_not_found` before it gets here.
 */
const ORDER_LOCK_FOR_CLAIM_SQL = 'SELECT 1 FROM orders WHERE id = $1::uuid FOR UPDATE'

async function lockOrderForClaim(tx: Tx, orderId: string): Promise<void> {
  const locked = await tx.query(ORDER_LOCK_FOR_CLAIM_SQL, [orderId])
  if (locked.length !== 1) throw new Error(`Refund claim: order ${orderId} doesn't exist, so no claim can be written on it.`)
}

const round2 = (n: number): number => Math.round(n * 100) / 100

/** The rules a step E plan must keep, checked where the claim is written. A breach is a fault in the caller. */
function checkPlan(plan: StepEPlan, amount: number, orderId: string, what: string): void {
  if (plan.card.length > 1) throw new Error(`${what}: a claim on one order has one card part at most, not ${plan.card.length}.`)
  const part = plan.card[0]
  if (part) {
    if (part.orderId !== orderId) throw new Error(`${what}: the card part is on order ${part.orderId}, not the claim's own order ${orderId}.`)
    if (!part.paymentIntentId) throw new Error(`${what}: the card part names no PaymentIntent.`)
    if (!(part.amount > 0)) throw new Error(`${what}: the card part gives nothing.`)
    if (round2(part.lines.reduce((total, line) => total + line.amount, 0)) !== round2(part.amount)) throw new Error(`${what}: the card part's lines don't add up to it.`)
  }
  if (plan.storeCredit < 0 || plan.cash < 0) throw new Error(`${what}: a part of the plan is below £0.`)
  // W28 (Q42): cash beside store credit is the cash paid on the order and the rest of the lines; never beside a card part.
  if (plan.cash > 0 && plan.card.length > 0) throw new Error(`${what}: cash is never handed over beside a card part.`)
  if (!(amount > 0)) throw new Error(`${what}: a claim gives something, or there is no claim.`)
  const planned = round2((part?.amount ?? 0) + plan.storeCredit + plan.cash)
  if (planned !== round2(amount)) throw new Error(`${what}: the plan gives £${planned.toFixed(2)}, the claim £${round2(amount).toFixed(2)}.`)
}

/**
 * Writes an order's claim (`order.refund_claimed`), inside R1's transaction: refused (`refund_open`) while another
 * claim holds the order; never with more than one card part, or a part on another order. It takes the order's lock
 * itself before the look (R1 should already hold it through lockForRefund, which locks the rest in LOCK_ORDER).
 */
export async function writeOrderClaim(tx: Tx, orderId: string, details: OrderClaimDetails, by: ClaimBy): Promise<OrderClaim> {
  checkPlan(details.plan, details.amount, orderId, 'Order refund claim')
  await lockOrderForClaim(tx, orderId)
  await refuseWhileRefundOpen(tx, 'order', orderId)
  const row = await writeClaimRow(tx, ORDER_CLAIMS, orderId, details, by)
  return { id: row.id, orderId, staffId: row.staffId, at: row.at, details }
}

/**
 * Writes an event booking's claim (`event_booking.refund_claimed`), inside R1's transaction: refused (`refund_open`)
 * while another claim holds its order; never with more than one card part, or a part on any order but the one that
 * paid for the booking. It takes that order's lock (`details.orderId`) itself before the look, as writeOrderClaim.
 */
export async function writeEventBookingClaim(tx: Tx, eventBookingId: string, details: EventBookingClaimDetails, by: ClaimBy): Promise<EventBookingClaim> {
  if (!details.orderId) throw new Error("Event booking refund claim: the claim must name the booking's order.")
  checkPlan(details.plan, details.amount, details.orderId, 'Event booking refund claim')
  await lockOrderForClaim(tx, details.orderId)
  await refuseWhileRefundOpen(tx, 'event_booking', details.orderId)
  const row = await writeClaimRow(tx, EVENT_BOOKING_CLAIMS, eventBookingId, details, by)
  return { id: row.id, eventBookingId, orderId: details.orderId, staffId: row.staffId, at: row.at, details }
}

// --- Reading, the finish, the refusal mark, the due list (the shared core, on these two subjects)

/** The order's claim, or null when there is no Worker claim with that id on an order. */
export async function readOrderClaim(db: Queryable, claimId: string): Promise<OrderClaim | null> {
  const row = await readClaimRow<OrderClaimDetails>(db, ORDER_CLAIMS, claimId)
  return row ? { id: row.id, orderId: row.subjectId, staffId: row.staffId, at: row.at, details: row.details } : null
}

/** The event booking's claim, or null when there is no Worker claim with that id on an event booking. */
export async function readEventBookingClaim(db: Queryable, claimId: string): Promise<EventBookingClaim | null> {
  const row = await readClaimRow<EventBookingClaimDetails>(db, EVENT_BOOKING_CLAIMS, claimId)
  return row ? { id: row.id, eventBookingId: row.subjectId, orderId: row.details.orderId, staffId: row.staffId, at: row.at, details: row.details } : null
}

type AnyStepEClaim = OrderClaim | EventBookingClaim

const subjectOf = (claim: AnyStepEClaim): { on: ClaimSubject; subjectId: string } =>
  'eventBookingId' in claim ? { on: EVENT_BOOKING_CLAIMS, subjectId: claim.eventBookingId } : { on: ORDER_CLAIMS, subjectId: claim.orderId }

/** True once the claim has its finished row. */
export async function stepEClaimFinished(db: Queryable, claim: AnyStepEClaim): Promise<boolean> {
  const { on, subjectId } = subjectOf(claim)
  return claimIsFinished(db, on, { id: claim.id, subjectId })
}

/** The mark that Stripe refused the claim's card part (W26a's rule), in its own transaction, before anything else is tried. */
export async function markStepEClaimRefused(db: Db, claim: AnyStepEClaim, detail: string, requestId: string): Promise<void> {
  const part = claim.details.plan.card[0]
  if (!part) throw new Error(`Refund claim ${claim.id} has no card part to mark refused.`)
  const { on, subjectId } = subjectOf(claim)
  return markRefused(db, on, { id: claim.id, subjectId, staffId: claim.staffId }, part, detail, requestId)
}

/** Stripe's reason when it refused the claim's card part (the mark), or null when it never did. */
export async function stepEClaimRefusal(db: Queryable, claim: AnyStepEClaim): Promise<string | null> {
  const { on, subjectId } = subjectOf(claim)
  return claimRefusal(db, on, { id: claim.id, subjectId })
}

/** Reconcile's due lists for step E (`$1` the window in minutes), as CLAIMS_DUE_SQL is for bookings. Read from W28 and W30. */
export const ORDER_CLAIMS_DUE_SQL = claimsDueSql(ORDER_CLAIMS)
export const EVENT_BOOKING_CLAIMS_DUE_SQL = claimsDueSql(EVENT_BOOKING_CLAIMS)
