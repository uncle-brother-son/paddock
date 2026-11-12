// New in W21 (D-plan 1.6, 4.3, 4.7, 4.8, 4.10): the refund pipeline, and refundBooking's three amount actions on the
// Worker (Part refund, Refund the rest, It already arrived). Cancel & Refund stays on the old body until W23; Remove
// Guest, Remove add-on and a cheaper Move use this pipeline from W22 and W24.
//
// R1 is one transaction with no Stripe call: the booking locked (LOCK_ORDER: booking, then its customer), Issue
// refunds checked by the route, the figures (money-left.ts, the same ones the dialogs show), the confirmed amount (Q18,
// half a penny either way, with the old words and the new figures), the claim (price_paid lowered; a part refund also
// counted in part_refunded_amount, Q27/Q28; Refund the rest lowers what is owed), the plan (the card parts: the
// booking's orders newest first, each capped at its card portion and its booking line's net, as giveBookingMoneyBack
// did; the store credit; Q26's cash) and the claim's row (`booking.refund_claimed`, the plan in its details: the record
// every key comes from, lead call L3). With no card part, R1 also gives the store credit (or records the cash handed
// over) and finishes the claim: one transaction, nothing held.
//
// With card parts, R1 commits, then the press sends each part once, keyed `<claimId>:refund:<orderId>` with
// `metadata.claim_id`, then R2 (one transaction): each part recorded on its booking line, the rest to store credit, the
// orders' status worked out again, the claim finished (`booking.refund_finished`).
// - The first part refused (nothing went): R1 undone in one transaction, with the old words.
// - A later part refused: it, and every part after it, go to store credit in R2 (today's rule), with the old warning.
// - No clear answer: the claim is held (Q35's refund words). No press ever sends it again: reconcile lists the refunds
//   on each planned PaymentIntent, matches `metadata.claim_id`, and runs R2 with what it found; a part Stripe never
//   received ends as money owed on the booking (Refund the rest), never resent (D-plan 4.10).
// - A later part the press had no time left to send (W21a, W21 review L6): it and the parts after it end as owed on the
//   booking (Refund the rest can still send them to the card), not store credit: Stripe never refused them.
// Refund the rest to the card first looks in Stripe for the old screens' card refunds with no clear answer (W21a, W21
// review L1 and L2): before R1, so R1 checks what was found under the booking's lock. Each one that went must be
// exactly one planned part, or nothing is sent (R1 refuses); a part it matched is stored in the claim (the old refund's
// id), so the press, reconcile and a close all count it as gone, never owed and never sent.
// One transaction per step replaces the old figure-built keys and their 24-hour look-up, refusal counts, put-backs and
// best-effort statements (bookingRefund.ts, bookingMoneyClaim.ts, cardRefundAttempts.ts, stripeRefundLookup.ts).
import 'server-only'
import Stripe from 'stripe'
import type { ApiErrorCode, OwedArrivedInput, PartRefundInput, RefundBookingOutput, RefundOwedInput } from '@/contracts'
import { audit, type AuditEntry } from '@/server/audit'
import { isDeadlock, type Db, type Queryable, type Tx } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import { stripeIdempotencyKey } from '@/server/http/idempotency'
import type { StripeClient } from '@/server/stripe/client'
import { sendOptions, stripeTiming, type StripeTiming } from '@/server/stripe/deadline'
import { readStripeFailure } from '@/server/stripe/outcome'
import { pence } from '@/server/rules/orders/collect-saved-card'
import {
  cardRefundFailedMessage,
  CHANGE_REFUND_UNCONFIRMED_MESSAGE,
  laterCardRefundFailedMessage,
  laterCardRefundNotSentMessage,
  NO_CASH_LEFT_MESSAGE,
  oldRefundReachedCustomerMessage,
  onlyCardLeftMessage,
  onlyCashLeftMessage,
  onlyLeftMessage,
  owedChangedMessage,
  PART_REFUND_METHOD_WORDS,
  reasonRequiredMessage,
  reasonTooLongMessage,
  REFUND_CHECK_FAILED_MESSAGE,
  REFUND_METHOD_WORDS,
  REFUND_NOT_SAVED_MESSAGE,
  REFUND_NOT_SENT_DETAIL,
  REFUND_OPEN_MESSAGE,
  REFUND_REFUSED_NOT_PUT_BACK_MESSAGE,
  REFUND_WORDS,
  refundGoneNotRecordedMessage,
  refundRefusedDetail,
} from './failure-messages'
import { lockAndLoadBooking, paymentOpen, type LoadedBooking } from './load-booking'
import { lockForBooking } from './locks'
import { inC1, paymentOpenRefusal } from './money-in'
import { loadBookingLines, loadOrderCardPortion, recordOrderPaymentStatus, withCashAndLine, type RefundFigures } from './money-left'

export const REFUND_CLAIMED = 'booking.refund_claimed'
export const REFUND_FINISHED = 'booking.refund_finished'
/** The reason's limit, as the old function's. */
export const REFUND_REASON_MAX_LENGTH = 200

export type RefundKind = 'part_refund' | 'refund_owed'
export type RefundMethod = 'card' | 'credit' | 'cash'

/** One booking line's share of a card part. */
export interface CardPartLine {
  lineId: string
  amount: number
}

/** One refund to one order's card: the order's lines for this booking (newest first) add up to `amount`. */
export interface CardPart {
  orderId: string
  paymentIntentId: string
  amount: number
  lines: CardPartLine[]
}

/** Where the claimed money goes: the card parts, then store credit for the rest, or (Q26) cash handed over. */
export interface RefundPlan {
  card: CardPart[]
  storeCredit: number
  cash: number
  /** The booking's own order (its oldest booking line's): the store credit's row is linked to it, as before. */
  ownOrderId: string | null
}

/** The claim's row details: the old fields (kind, amount, pricePaidBefore, method, reason), then the Worker's. */
export interface ClaimDetails {
  kind: RefundKind
  amount: number
  pricePaidBefore: number
  method: RefundMethod
  reason: string | null
  /** A claim the Worker made: reconcile and the stuck list look at these only. */
  worker: true
  plan: RefundPlan
  /** The Stripe key's mode the card parts are sent with (true live), for reconcile's "not found" (W11 review L1). */
  livemode: boolean | null
  /** Q26: who handed the cash over. */
  handedOverBy?: string
  /**
   * W21a (W21 review L2): Refund the rest's planned parts that are an old card refund with no clear answer that went
   * (found before R1): each is gone already, so it is never sent, and reconcile and a close count it as gone.
   */
  matched?: MatchedPart[]
}

/** A planned card part that is an old refund already gone: the order it refunds and the old refund's id. */
export interface MatchedPart {
  orderId: string
  refundId: string
}

export interface Claim {
  id: string
  bookingId: string
  /** The staff member who made the claim: its store credit row and its audit rows name them. */
  staffId: string | null
  at: string
  details: ClaimDetails
}

export interface RefundOptions {
  actor: { type: 'staff'; id: string }
  requestId: string
  /** The request's start: the press's Stripe calls end by a deadline from it. */
  startedAt?: number
  now?: () => number
  /** The Stripe client, made before R1 for a card refund, so a missing key fails with nothing written. */
  stripe?: () => StripeClient
}

/** Who finishes a claim: the press, reconcile, or a person closing it by hand (their reason). */
export interface FinishedBy {
  actor: { type: 'staff' | 'system'; id: string | null }
  requestId: string
  how: 'press' | 'reconcile' | 'close'
  why?: string
}

const round2 = (n: number): number => Math.round(n * 100) / 100
/** Rounded first, as the old cash rule: taking pounds from pounds leaves noise. Half a penny either way passes (Q18). */
const overHalfPenny = (amount: number, limit: number): boolean => Math.round((amount - limit) * 1e6) / 1e6 > 0.005
const explain = (err: unknown): string => (err instanceof Error ? `${err.name}: ${err.message}` : String(err))
const sum = (amounts: readonly number[]): number => round2(amounts.reduce((total, n) => total + n, 0))

/** The key of one card part: `<claimId>:refund:<orderId>` (the claim's record id, then the order it refunds). */
export const claimRefundKey = (claimId: string, orderId: string): string => `${stripeIdempotencyKey(claimId, 'refund')}:${orderId}`

// --- Refusals

type RefundRefusalExtras = { figures?: RefundFigures; field?: string; logDetail?: string }

/** A refusal before anything moved: the old reason and words, and the new figures when the amount no longer fits. */
export function refundRefusal(code: ApiErrorCode, reason: string, message: string | undefined, extras: RefundRefusalExtras = {}): ApiError {
  const words = message ?? REFUND_WORDS.couldNotRefund
  return new ApiError(code, words, {
    ...(extras.field ? { field: extras.field } : {}),
    ...(extras.logDetail ? { logDetail: extras.logDetail } : {}),
    details: { reason, message: words, action: 'refund', ...(extras.figures ? { figures: extras.figures } : {}) },
  })
}

function requiredReason(value: unknown, what: string): string {
  const reason = typeof value === 'string' ? value.trim() : ''
  if (!reason) throw refundRefusal('VALIDATION', 'reason_required', reasonRequiredMessage(what), { field: 'reason' })
  if (reason.length > REFUND_REASON_MAX_LENGTH) throw refundRefusal('VALIDATION', 'reason_too_long', reasonTooLongMessage(REFUND_REASON_MAX_LENGTH), { field: 'reason' })
  return reason
}

// --- Claims on audit_log (lead call L3)

/** A Worker claim with no finished row: `$1` the booking (as text). */
const OPEN_CLAIM_ON_BOOKING_SQL = `
SELECT c.id FROM audit_log c
WHERE c.action = '${REFUND_CLAIMED}' AND c.entity_type = 'booking' AND c.entity_id = $1::text AND c.details->>'worker' = 'true'
  AND NOT EXISTS (
    SELECT 1 FROM audit_log f
    WHERE f.action = '${REFUND_FINISHED}' AND f.entity_type = 'booking' AND f.entity_id = c.entity_id AND f.details->>'claimId' = c.id::text
  )
LIMIT 1`

/**
 * Every Worker claim with no finished row, older than `$1` minutes, oldest first: what reconcile settles (D-plan
 * 4.10). A claim and its finished row are written by different transactions only when card parts were sent.
 */
export const CLAIMS_DUE_SQL = `
SELECT c.id FROM audit_log c
WHERE c.action = '${REFUND_CLAIMED}' AND c.entity_type = 'booking' AND c.details->>'worker' = 'true'
  AND c.at < now() - make_interval(mins => $1::int)
  AND NOT EXISTS (
    SELECT 1 FROM audit_log f
    WHERE f.action = '${REFUND_FINISHED}' AND f.entity_type = 'booking' AND f.entity_id = c.entity_id AND f.details->>'claimId' = c.id::text
  )
ORDER BY c.at, c.id`

/** True when the booking has a Worker refund claim with no finished row: it holds the booking for every refund. */
export async function refundClaimOpen(db: Queryable, bookingId: string): Promise<boolean> {
  return (await openRefundClaimOn(db, bookingId)) !== null
}

/** The id of the booking's open Worker refund claim, if it has one. */
export async function openRefundClaimOn(db: Queryable, bookingId: string): Promise<string | null> {
  return (await db.query<{ id: string }>(OPEN_CLAIM_ON_BOOKING_SQL, [bookingId]))[0]?.id ?? null
}

/** The claim, or null when there is no Worker claim with that id. */
export async function readClaim(db: Queryable, claimId: string): Promise<Claim | null> {
  const row = (
    await db.query<{ id: string; entity_id: string; actor_id: string | null; at: unknown; details: ClaimDetails }>(
      `SELECT id, entity_id, actor_id, at, details FROM audit_log
       WHERE id = $1::uuid AND action = 'booking.refund_claimed' AND entity_type = 'booking' AND details->>'worker' = 'true'`,
      [claimId]
    )
  )[0]
  if (!row) return null
  return { id: row.id, bookingId: row.entity_id, staffId: row.actor_id, at: row.at instanceof Date ? row.at.toISOString() : String(row.at), details: row.details }
}

async function claimFinished(db: Queryable, claim: Pick<Claim, 'id' | 'bookingId'>): Promise<boolean> {
  const rows = await db.query(
    "SELECT 1 FROM audit_log WHERE action = 'booking.refund_finished' AND entity_type = 'booking' AND entity_id = $1::text AND details->>'claimId' = $2::text LIMIT 1",
    [claim.bookingId, claim.id]
  )
  return rows.length > 0
}

async function writeClaim(tx: Tx, bookingId: string, details: ClaimDetails, options: Pick<RefundOptions, 'actor' | 'requestId'>): Promise<Claim> {
  const row = (
    await tx.query<{ id: string; at: unknown }>(
      `INSERT INTO audit_log (at, actor_type, actor_id, action, entity_type, entity_id, request_id, details)
       VALUES (clock_timestamp(), 'staff', $1::text, 'booking.refund_claimed', 'booking', $2::text, $3::text, $4::jsonb)
       RETURNING id, at`,
      [options.actor.id, bookingId, options.requestId, JSON.stringify(details)]
    )
  )[0]
  if (!row) throw new Error('The refund claim was not written.')
  return { id: row.id, bookingId, staffId: options.actor.id, at: row.at instanceof Date ? row.at.toISOString() : String(row.at), details }
}

// --- The plan

/**
 * Where `amount` goes, as giveBookingMoneyBack sent it: with the card, against the booking's lines newest first, each
 * order giving back at most what its card can still take (its card portion, each order's used once) and what that
 * line still holds in seat money; whatever the cards can't take, to store credit. A line whose order has no
 * PaymentIntent is passed over. Two lines of one order make one part (one refund, one key).
 */
export async function planRefund(db: Queryable, bookingId: string, amount: number, method: RefundMethod): Promise<RefundPlan> {
  const lines = await loadBookingLines(db, bookingId)
  const ownOrderId = lines.length > 0 ? (lines[lines.length - 1]?.orderId ?? null) : null
  const give = round2(amount)
  if (method === 'cash') return { card: [], storeCredit: 0, cash: give, ownOrderId }
  if (method === 'credit') return { card: [], storeCredit: give, cash: 0, ownOrderId }
  const portions = new Map<string, { paymentIntentId: string | null; left: number }>()
  const parts = new Map<string, CardPart>()
  let left = give
  for (const line of lines) {
    if (left <= 0.005) break
    let portion = portions.get(line.orderId)
    if (!portion) {
      const loaded = await loadOrderCardPortion(db, line.orderId)
      portion = { paymentIntentId: loaded?.paymentIntentId ?? null, left: loaded?.paymentIntentId ? loaded.cardPortionRemaining : 0 }
      portions.set(line.orderId, portion)
    }
    if (!portion.paymentIntentId) continue
    const take = round2(Math.min(left, portion.left, line.netRemaining))
    if (take <= 0) continue
    portion.left = round2(portion.left - take)
    const part = parts.get(line.orderId) ?? { orderId: line.orderId, paymentIntentId: portion.paymentIntentId, amount: 0, lines: [] }
    part.amount = round2(part.amount + take)
    part.lines.push({ lineId: line.id, amount: take })
    parts.set(line.orderId, part)
    left = round2(left - take)
  }
  return { card: [...parts.values()], storeCredit: left > 0.005 ? left : 0, cash: 0, ownOrderId }
}

// --- R1

/** What R1 finished on its own, or the claim whose card parts the press now sends. */
type Started = { kind: 'done'; output: RefundBookingOutput } | { kind: 'card'; claim: Claim }

/**
 * The checks every amount action starts with, under the booking's lock, in the old function's order (a payment still
 * being taken on the booking first, as refundBooking checked it before anything else).
 */
async function lockAndCheck(tx: Tx, bookingId: string, amount: unknown): Promise<{ booking: LoadedBooking; amount: number }> {
  const loaded = await lockAndLoadBooking(tx, { bookingId, ownSession: false })
  if (!loaded) throw refundRefusal('NOT_FOUND', 'booking_not_found', REFUND_WORDS.bookingNotFound)
  const { booking } = loaded
  if (paymentOpen(booking)) throw paymentOpenRefusal(booking, refundRefusal)
  // A held refund on the booking (no clear answer yet) holds every refund until reconcile settles it.
  if (await refundClaimOpen(tx, bookingId)) throw refundRefusal('CONFLICT', 'refund_open', REFUND_OPEN_MESSAGE)
  // price_paid stays on a cancelled booking after its refund, so it would pay out a second time.
  if (booking.status === 'cancelled') throw refundRefusal('CONFLICT', 'already_cancelled', REFUND_WORDS.alreadyCancelled)
  if (typeof amount !== 'number' || !Number.isFinite(amount) || !(round2(amount) > 0)) {
    throw refundRefusal('VALIDATION', 'amount_not_positive', REFUND_WORDS.amountNotPositive, { field: 'amount' })
  }
  return { booking, amount }
}

/** What Refund the rest and It already arrived both refuse: the amount must be what is owed, to half a penny. */
function owedRefusal(amount: number, figures: RefundFigures): ApiError | null {
  if (figures.refundOwed <= 0) return refundRefusal('CONFLICT', 'nothing_owed', REFUND_WORDS.nothingOwed, { figures })
  if (overHalfPenny(amount, figures.refundOwed) || overHalfPenny(figures.refundOwed, amount)) {
    return refundRefusal('CONFLICT', 'owed_changed', owedChangedMessage(figures.refundOwed), { figures })
  }
  return null
}

async function partR1(tx: Tx, bookingId: string, input: PartRefundInput, options: RefundOptions, livemode: boolean | null): Promise<Started> {
  const method = input.refundMethod
  if (method !== 'card' && method !== 'credit' && method !== 'cash') {
    throw refundRefusal('VALIDATION', 'refund_method_invalid', PART_REFUND_METHOD_WORDS, { field: 'refundMethod' })
  }
  const { booking, amount } = await lockAndCheck(tx, bookingId, input.amount)
  const reason = requiredReason(input.reason, 'a part refund')
  const figures = await withCashAndLine(tx, bookingId, booking.figures)
  if (figures.left <= 0) throw refundRefusal('CONFLICT', 'nothing_left', REFUND_WORDS.nothingLeft, { figures })
  if (overHalfPenny(amount, figures.left)) throw refundRefusal('CONFLICT', 'more_than_left', onlyLeftMessage(figures.left), { figures })
  const limit = method === 'card' ? figures.parts.card : method === 'cash' ? figures.cashLeft : figures.left
  if (overHalfPenny(amount, limit)) {
    if (method === 'card') throw refundRefusal('CONFLICT', 'more_than_card_left', limit > 0 ? onlyCardLeftMessage(limit) : REFUND_WORDS.noCardLeft, { figures })
    throw refundRefusal('CONFLICT', 'more_than_cash_left', limit > 0 ? onlyCashLeftMessage(limit) : NO_CASH_LEFT_MESSAGE, { figures })
  }
  const give = round2(Math.min(amount, limit))
  const plan = await planRefund(tx, bookingId, give, method)
  // part_refunded_amount is what Add Guest and Move read so a part refund stays with the customer (Q27, Q28), so it
  // takes the whole amount agreed: money that fails partway is still owed to them (Refund the rest never raises it).
  await tx.query(
    'UPDATE bookings SET price_paid = price_paid - $1::numeric, part_refunded_amount = part_refunded_amount + $1::numeric, updated_at = now() WHERE id = $2::uuid',
    [give, bookingId]
  )
  const claim = await writeClaim(
    tx,
    bookingId,
    {
      kind: 'part_refund',
      amount: give,
      pricePaidBefore: figures.pricePaid,
      method,
      reason,
      worker: true,
      plan,
      livemode: plan.card.length > 0 ? livemode : null,
      ...(method === 'cash' ? { handedOverBy: options.actor.id } : {}),
    },
    options
  )
  if (plan.card.length > 0) return { kind: 'card', claim }
  const output = await finishClaimInTransaction(tx, claim, { went: [], extraToStoreCredit: 0, owed: 0 }, { actor: options.actor, requestId: options.requestId, how: 'press' })
  if (!output) throw new Error(`Refund claim ${claim.id} was finished in its own transaction.`)
  return { kind: 'done', output }
}

async function owedR1(
  tx: Tx,
  bookingId: string,
  input: RefundOwedInput,
  options: RefundOptions,
  livemode: boolean | null,
  looked: OldRefundsLooked | null
): Promise<Started> {
  const method = input.refundMethod
  if (method !== 'card' && method !== 'credit') throw refundRefusal('VALIDATION', 'refund_method_invalid', REFUND_METHOD_WORDS, { field: 'refundMethod' })
  const { booking, amount } = await lockAndCheck(tx, bookingId, input.amount)
  const figures = await withCashAndLine(tx, bookingId, booking.figures)
  const refused = owedRefusal(amount, figures)
  if (refused) throw refused
  // Exactly what is owed: staff confirmed it. Never a part refund: this money was never paid toward the booking.
  const owed = figures.refundOwed
  const plan = await planRefund(tx, bookingId, owed, method)
  const matched = looked ? await matchOldRefunds(tx, bookingId, plan, looked) : []
  await tx.query(
    'UPDATE bookings SET price_paid = price_paid - $1::numeric, refund_owed_amount = refund_owed_amount - $1::numeric, updated_at = now() WHERE id = $2::uuid',
    [owed, bookingId]
  )
  const claim = await writeClaim(
    tx,
    bookingId,
    {
      kind: 'refund_owed',
      amount: owed,
      pricePaidBefore: figures.pricePaid,
      method,
      reason: null,
      worker: true,
      plan,
      livemode: plan.card.length > 0 ? livemode : null,
      ...(matched.length > 0 ? { matched } : {}),
    },
    options
  )
  if (plan.card.length > 0) return { kind: 'card', claim }
  const output = await finishClaimInTransaction(tx, claim, { went: [], extraToStoreCredit: 0, owed: 0 }, { actor: options.actor, requestId: options.requestId, how: 'press' })
  if (!output) throw new Error(`Refund claim ${claim.id} was finished in its own transaction.`)
  return { kind: 'done', output }
}

// --- R2: what went is recorded, the rest to store credit (or owed), the claim finished

/** What a claim ended with. `owed`: card money Stripe never received (reconcile, a close), back on the booking as owed. */
export interface ClaimOutcome {
  went: CardPart[]
  /** Card parts after a later refusal (today's rule): to store credit, with the plan's own store credit. */
  extraToStoreCredit: number
  owed: number
  warning?: string
}

/** The notes the old function gave its store credit (shared/storeCreditRefund's `[ref …]` included, as it was written). */
function storeCreditNote(claim: Claim, cardRefunded: number): string {
  const base = claim.details.kind === 'part_refund' ? `Booking partial refund: ${claim.details.reason ?? ''}` : 'Refund the rest of a failed booking refund'
  return `${base}${cardRefunded > 0 ? ' (the rest went back to the card).' : '.'} [ref ${crypto.randomUUID()}]`
}

/**
 * R2, inside a transaction the caller opened: the booking locked (and its customer), then, unless the claim is
 * finished already (null): each card part that went added to its booking lines' card_refunded_amount; the plan's store
 * credit and any later-refused parts given as one store credit refund; money Stripe never received put back on the
 * booking as owed (on a cancelled booking, which has no button left to give it, as store credit instead); the orders'
 * status worked out again; the action's row (`booking.part_refund` / `booking.refund_owed`, as the old function wrote
 * them) and the claim's finished row. Throws on any failure, so the caller's transaction keeps nothing.
 */
export async function finishClaimInTransaction(tx: Tx, claim: Claim, outcome: ClaimOutcome, by: FinishedBy): Promise<RefundBookingOutput | null> {
  const locks = await lockForBooking(tx, { bookingId: claim.bookingId })
  if (!locks) throw new Error(`The booking of refund claim ${claim.id} no longer exists.`)
  if (await claimFinished(tx, claim)) return null
  const { details } = claim
  const { plan } = details

  for (const part of outcome.went) {
    for (const line of part.lines) {
      await tx.query('UPDATE order_line_items SET card_refunded_amount = card_refunded_amount + $1::numeric WHERE id = $2::uuid', [line.amount, line.lineId])
    }
  }
  const cardRefunded = sum(outcome.went.map((part) => part.amount))
  const status = (await tx.query<{ status: string }>('SELECT status FROM bookings WHERE id = $1::uuid', [claim.bookingId]))[0]?.status
  let owed = round2(outcome.owed)
  let storeCredit = round2(plan.storeCredit + outcome.extraToStoreCredit)
  if (owed > 0 && status === 'cancelled') {
    storeCredit = round2(storeCredit + owed)
    owed = 0
  }

  let balance: number | undefined
  if (storeCredit > 0) {
    const applied = (
      await tx.query<{ result: { ok?: boolean; reason?: string; balance?: number | string } | null }>(
        'SELECT public.store_credit_apply($1::uuid, $2::numeric, $3::text, $4::uuid, $5::uuid, $6::uuid, $7::text, NULL::uuid) AS result',
        [locks.customerId, storeCredit, 'refund', plan.ownOrderId, claim.bookingId, claim.staffId, storeCreditNote(claim, cardRefunded)]
      )
    )[0]?.result
    if (applied?.ok !== true) throw new Error(`The store credit refund was refused: ${applied?.reason ?? 'no answer'}.`)
    if (applied.balance !== undefined && applied.balance !== null) balance = Number(applied.balance)
  }
  if (owed > 0) {
    await tx.query(
      'UPDATE bookings SET price_paid = price_paid + $1::numeric, refund_owed_amount = refund_owed_amount + $1::numeric, updated_at = now() WHERE id = $2::uuid',
      [owed, claim.bookingId]
    )
  }
  if (cardRefunded + storeCredit > 0) {
    for (const orderId of new Set([...outcome.went.map((part) => part.orderId), ...(plan.ownOrderId ? [plan.ownOrderId] : [])])) {
      await recordOrderPaymentStatus(tx, orderId)
    }
  }

  const cash = plan.cash
  const actor = { actorType: 'staff' as const, actorId: claim.staffId, entityType: 'booking', entityId: claim.bookingId, requestId: by.requestId }
  const finishedBy = by.how === 'press' ? {} : { by: { how: by.how, type: by.actor.type, id: by.actor.id, ...(by.why ? { why: by.why } : {}) } }
  const entries: AuditEntry[] = [
    {
      ...actor,
      action: details.kind === 'part_refund' ? 'booking.part_refund' : 'booking.refund_owed',
      details:
        details.kind === 'part_refund'
          ? { amount: details.amount, reason: details.reason, method: details.method, cardRefunded, storeCreditRefunded: storeCredit, owed, ...(cash > 0 ? { cashRefunded: cash, handedOverBy: details.handedOverBy ?? null } : {}) }
          : { amount: details.amount, method: details.method, cardRefunded, storeCreditRefunded: storeCredit, owed },
    },
    {
      ...actor,
      action: REFUND_FINISHED,
      details: { claimId: claim.id, outcome: owed > 0 ? 'owed' : 'given', cardRefunded, storeCreditRefunded: storeCredit, owed, ...(cash > 0 ? { cash } : {}), ...finishedBy },
    },
  ]
  await audit.recordAll(tx, entries)
  const pricePaid = (await tx.query<{ price_paid: string }>('SELECT price_paid::text AS price_paid FROM bookings WHERE id = $1::uuid', [claim.bookingId]))[0]?.price_paid
  return {
    cardRefundedAmount: cardRefunded,
    storeCreditRefundedAmount: storeCredit,
    ...(cash > 0 ? { cashRefundedAmount: cash } : {}),
    ...(balance !== undefined ? { storeCreditBalance: balance } : {}),
    ...(pricePaid !== undefined ? { pricePaid: Number.parseFloat(pricePaid) } : {}),
    ...(outcome.warning ? { warning: outcome.warning } : {}),
  }
}

/** R2 in a transaction of its own, run once more after a deadlock (it is safe twice: the finished row is checked). */
export async function finishClaim(db: Db, claim: Claim, outcome: ClaimOutcome, by: FinishedBy): Promise<RefundBookingOutput | null> {
  try {
    return await db.transaction((tx) => finishClaimInTransaction(tx, claim, outcome, by))
  } catch (err) {
    if (!isDeadlock(err)) throw err
    return db.transaction((tx) => finishClaimInTransaction(tx, claim, outcome, by))
  }
}

/**
 * The first card part was refused, so nothing went: R1 undone in one transaction, as the old put-backs did. A part
 * refund was never one (price_paid and part_refunded_amount back); Refund the rest's money is owed again. False when
 * the claim was finished already.
 */
async function undoClaim(db: Db, claim: Claim, by: FinishedBy): Promise<boolean> {
  return db.transaction(async (tx) => {
    const locks = await lockForBooking(tx, { bookingId: claim.bookingId })
    if (!locks) throw new Error(`The booking of refund claim ${claim.id} no longer exists.`)
    if (await claimFinished(tx, claim)) return false
    const { amount, kind } = claim.details
    if (kind === 'part_refund') {
      await tx.query(
        'UPDATE bookings SET price_paid = price_paid + $1::numeric, part_refunded_amount = GREATEST(part_refunded_amount - $1::numeric, 0), updated_at = now() WHERE id = $2::uuid',
        [amount, claim.bookingId]
      )
    } else {
      await tx.query(
        'UPDATE bookings SET price_paid = price_paid + $1::numeric, refund_owed_amount = refund_owed_amount + $1::numeric, updated_at = now() WHERE id = $2::uuid',
        [amount, claim.bookingId]
      )
    }
    await audit.recordAll(tx, [
      {
        actorType: 'staff',
        actorId: claim.staffId,
        action: REFUND_FINISHED,
        entityType: 'booking',
        entityId: claim.bookingId,
        requestId: by.requestId,
        details: { claimId: claim.id, outcome: kind === 'part_refund' ? 'put_back' : 'owed', cardRefunded: 0, storeCreditRefunded: 0, owed: kind === 'part_refund' ? 0 : amount },
      },
    ])
    return true
  })
}

// --- The press: each card part once, then R2

type PartAnswer = { outcome: 'went'; refund: Stripe.Refund } | { outcome: 'refused'; detail: string } | { outcome: 'not_sent' } | { outcome: 'unclear'; detail: string }

const accessRefused = (err: unknown): boolean =>
  err instanceof Stripe.errors.StripeAuthenticationError || err instanceof Stripe.errors.StripePermissionError

/** One part's refund request, from the claim alone, so a resend under its key is the same request. */
export function cardPartRequest(claimId: string, part: CardPart): Stripe.RefundCreateParams {
  return { payment_intent: part.paymentIntentId, amount: pence(part.amount), metadata: { refund_key: claimRefundKey(claimId, part.orderId), claim_id: claimId } }
}

/**
 * Sends one card part, outside any transaction, under its key: Stripe's refund back (succeeded or pending) is a yes;
 * failed or cancelled, or a definite error, is a no; nothing sent (no time left before the first send) is not_sent
 * (W21a: not a refusal, Stripe never saw it); any other answer is sent once more with the same key and request, then is
 * unclear. Only the press calls this, once per part, straight after R1: reconcile never sends a refund.
 */
async function sendCardPart(stripe: StripeClient, claimId: string, part: CardPart, timing: StripeTiming): Promise<PartAnswer> {
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

// --- Refund the rest after an old card refund with no clear answer (the old 24-hour look-up's job, for old money)

/**
 * The old code's card refunds that got no clear answer (`booking.card_refund_unsure`: the key, PaymentIntent and
 * amount) since the booking's money owed was last dealt with (Refund the rest or It already arrived). Old Move, Remove
 * Guest and Cancel & Refund still write these until W22 to W24: the money is put on the booking as owed. The old
 * Refund the rest sent it again under the same key, so Stripe gave the first refund back (and after 24 hours looked
 * for it); a Worker refund has a key of its own, so it looks: `$1` the booking.
 */
const OLD_UNSURE_SQL = `
SELECT n.id::text AS id, n.details->>'key' AS key, n.details->>'paymentIntentId' AS payment_intent_id
FROM audit_log n
WHERE n.action = 'booking.card_refund_unsure' AND n.entity_type = 'booking' AND n.entity_id = $1::text
  AND n.at > COALESCE(
    (SELECT max(d.at) FROM audit_log d
     WHERE d.entity_type = 'booking' AND d.entity_id = $1::text AND d.action IN ('booking.refund_owed', 'booking.refund_owed_arrived')),
    '-infinity'::timestamptz)
ORDER BY n.at, n.id`

/** An old refund with no clear answer that went (succeeded or pending): its PaymentIntent, id and pence. */
interface OldRefundFound {
  paymentIntentId: string
  refundId: string
  amount: number
}

/** What Refund the rest's look-up saw: the notes it looked for (their ids) and the old refunds that went. */
export interface OldRefundsLooked {
  noteIds: string[]
  found: OldRefundFound[]
}

/**
 * Each old unsure refund found in Stripe (by its `refund_key`, which the legacy route put on every refund) that went
 * (succeeded or pending), each refund once (an old screen pressed again sent the same key); 'unclear' when Stripe
 * couldn't be asked, or a PaymentIntent has more refunds than reconcile pages through. Reads only, before R1.
 */
async function oldUnsureRefundsThatWent(db: Queryable, stripe: StripeClient, bookingId: string, timing: StripeTiming): Promise<OldRefundsLooked | 'unclear'> {
  const notes = await db.query<{ id: string; key: string; payment_intent_id: string }>(OLD_UNSURE_SQL, [bookingId])
  const found = new Map<string, OldRefundFound>()
  const listed = new Map<string, Stripe.Refund[]>()
  for (const note of notes) {
    let refunds = listed.get(note.payment_intent_id)
    if (!refunds) {
      const answer = await listRefunds(stripe, note.payment_intent_id, timing)
      if (answer.kind === 'unclear') return 'unclear'
      refunds = answer.refunds
      listed.set(note.payment_intent_id, refunds)
    }
    const refund = refunds.find((one) => one.metadata?.['refund_key'] === note.key && one.status !== 'failed' && one.status !== 'canceled')
    if (refund) found.set(refund.id, { paymentIntentId: note.payment_intent_id, refundId: refund.id, amount: refund.amount })
  }
  return { noteIds: notes.map((note) => note.id), found: [...found.values()] }
}

/**
 * Under R1's lock: the notes are still the ones the look-up saw (or nothing is sent: try again), and each old refund
 * that went is exactly one planned part on its PaymentIntent (or nothing is sent: W21 review L1, where a £60 part on a
 * PaymentIntent that already gave back £40 and £20 would pay £60 over). Answers the parts matched, for the claim.
 */
async function matchOldRefunds(tx: Tx, bookingId: string, plan: RefundPlan, looked: OldRefundsLooked): Promise<MatchedPart[]> {
  const notes = await tx.query<{ id: string }>(OLD_UNSURE_SQL, [bookingId])
  if (JSON.stringify(notes.map((note) => note.id)) !== JSON.stringify(looked.noteIds)) {
    throw refundRefusal('CONFLICT', 'refund_check_failed', REFUND_CHECK_FAILED_MESSAGE)
  }
  const free = [...plan.card]
  const matched: MatchedPart[] = []
  let allMatched = true
  for (const refund of looked.found) {
    const at = free.findIndex((part) => part.paymentIntentId === refund.paymentIntentId && pence(part.amount) === refund.amount)
    const part = at >= 0 ? free.splice(at, 1)[0] : undefined
    if (part) matched.push({ orderId: part.orderId, refundId: refund.refundId })
    else allMatched = false
  }
  if (!allMatched) {
    throw refundRefusal('CONFLICT', 'refund_check_failed', oldRefundReachedCustomerMessage(looked.found.map((refund) => refund.amount / 100)))
  }
  return matched
}

const held = (claim: Claim, reason: string, message: string, cardGone = 0): RefundBookingOutput => ({
  cardRefundedAmount: cardGone,
  storeCreditRefundedAmount: 0,
  held: { claimId: claim.id, reason, message },
})

/**
 * After R1 has committed a claim with card parts: each part once, in the plan's order (newest order first), then R2.
 * A part matched to an old refund that went (Refund the rest) is gone already: recorded, never sent. The first part
 * sent that is refused undoes R1 and is thrown with the old words; a later one sends it and the rest to store credit
 * (the old warning); a later one with no time left to send ends with the rest as owed (W21 review L6); no clear answer
 * holds the claim for reconcile (Q35), as does R2 failing after money went (W6-3's rule for refunds: what went is never
 * sent again, reconcile records it).
 */
async function sendAndFinish(db: Db, stripe: StripeClient, claim: Claim, options: RefundOptions, timing: StripeTiming): Promise<RefundBookingOutput> {
  const by: FinishedBy = { actor: options.actor, requestId: options.requestId, how: 'press' }
  const matched = new Set((claim.details.matched ?? []).map((part) => part.orderId))
  const went: CardPart[] = claim.details.plan.card.filter((part) => matched.has(part.orderId))
  const toSend = claim.details.plan.card.filter((part) => !matched.has(part.orderId))
  let sentOne = false
  let extraToStoreCredit = 0
  let owed = 0
  let warning: string | undefined
  for (const [index, part] of toSend.entries()) {
    const answer = await sendCardPart(stripe, claim.id, part, timing)
    if (answer.outcome === 'went') {
      went.push(part)
      sentOne = true
      continue
    }
    if (answer.outcome === 'unclear') return held(claim, 'refund_unconfirmed', CHANGE_REFUND_UNCONFIRMED_MESSAGE)
    if (!sentOne) {
      try {
        await undoClaim(db, claim, by)
      } catch {
        return held(claim, 'refund_refused_not_put_back', REFUND_REFUSED_NOT_PUT_BACK_MESSAGE)
      }
      throw refundRefusal('PAYMENT_FAILED', 'refund_failed', cardRefundFailedMessage(answer.outcome === 'not_sent' ? REFUND_NOT_SENT_DETAIL : answer.detail))
    }
    const rest = sum(toSend.slice(index).map((later) => later.amount))
    if (answer.outcome === 'not_sent') {
      // Never sent, so never refused: still owed, for Refund the rest to send to the card.
      owed = rest
      warning = laterCardRefundNotSentMessage(rest)
    } else {
      // Today's rule: a later refusal sends the rest to store credit, so money is never left half returned.
      extraToStoreCredit = rest
      warning = laterCardRefundFailedMessage(part.amount, answer.detail)
    }
    break
  }
  try {
    const output = await finishClaim(db, claim, { went, extraToStoreCredit, owed, ...(warning ? { warning } : {}) }, by)
    // Finished by someone else (a close): what went is theirs to report.
    return output ?? held(claim, 'refund_finished_elsewhere', refundGoneNotRecordedMessage(sum(went.map((part) => part.amount))), sum(went.map((part) => part.amount)))
  } catch {
    const gone = sum(went.map((part) => part.amount))
    return held(claim, 'refund_not_recorded', refundGoneNotRecordedMessage(gone), gone)
  }
}

// --- The three actions

const notSaved = (logDetail: string): ApiError => refundRefusal('INTERNAL', 'refund_not_saved', REFUND_NOT_SAVED_MESSAGE, { logDetail })

type R1 = (tx: Tx, livemode: boolean | null) => Promise<Started>

/**
 * R1 in its transaction (with C1's once-only deadlock retry and plain words for a fault), then the card parts.
 * `prepare` runs first, outside any transaction, with the Stripe client of a card refund: Refund the rest's look-up.
 */
async function run(db: Db, card: boolean, options: RefundOptions, prepare: (stripe: StripeClient | null, timing: StripeTiming) => Promise<R1>): Promise<RefundBookingOutput> {
  // A card refund needs Stripe: the client is made before R1, so a missing key fails with nothing written.
  const stripe = card && options.stripe ? options.stripe() : null
  const timing = stripeTiming(options.startedAt ?? Date.now(), options.now ?? Date.now)
  const r1 = await prepare(stripe, timing)
  // A COMMIT with no answer (INTERNAL) may have saved a claim whose card parts were never sent: reconcile finds it,
  // finds nothing in Stripe, and the money ends as owed (Refund the rest).
  const started = await inC1(db, (tx) => r1(tx, stripe?.keyLivemode ?? null), notSaved)
  if (started.kind === 'done') return started.output
  if (!stripe) throw new Error('A card refund was planned with no Stripe client.')
  return sendAndFinish(db, stripe, started.claim, options, timing)
}

/** Part refund: gives `amount` of what is left, to the card (the rest to store credit), to store credit, or in cash. */
export function partRefund(db: Db, bookingId: string, input: PartRefundInput, options: RefundOptions): Promise<RefundBookingOutput> {
  return run(db, input.refundMethod === 'card', options, () => Promise.resolve((tx, livemode) => partR1(tx, bookingId, input, options, livemode)))
}

/**
 * Refund the rest: gives exactly what is owed; with the card, what the cards can't take goes to store credit. To the
 * card, the old screens' refunds with no clear answer are looked for first (money they put on the booking as owed may
 * have reached the customer): Stripe not answering sends nothing, and R1 checks what was found.
 */
export function refundOwed(db: Db, bookingId: string, input: RefundOwedInput, options: RefundOptions): Promise<RefundBookingOutput> {
  return run(db, input.refundMethod === 'card', options, async (stripe, timing) => {
    const looked = stripe ? await oldUnsureRefundsThatWent(db, stripe, bookingId, timing) : null
    if (looked === 'unclear') throw refundRefusal('CONFLICT', 'refund_check_failed', REFUND_CHECK_FAILED_MESSAGE)
    return (tx, livemode) => owedR1(tx, bookingId, input, options, livemode, looked)
  })
}

/**
 * It already arrived: what is owed reached the customer after all, so it comes off the booking with no money moving.
 * One transaction with its `booking.refund_owed_arrived` row (the old one statement's), as nothing else records it.
 */
export async function owedArrived(db: Db, bookingId: string, input: OwedArrivedInput, options: Pick<RefundOptions, 'actor' | 'requestId'>): Promise<RefundBookingOutput> {
  return inC1(
    db,
    async (tx) => {
      const { booking, amount } = await lockAndCheck(tx, bookingId, input.amount)
      const reason = requiredReason(input.reason, 'this')
      const figures = await withCashAndLine(tx, bookingId, booking.figures)
      const refused = owedRefusal(amount, figures)
      if (refused) throw refused
      const owed = figures.refundOwed
      await tx.query(
        'UPDATE bookings SET price_paid = price_paid - $1::numeric, refund_owed_amount = refund_owed_amount - $1::numeric, updated_at = now() WHERE id = $2::uuid',
        [owed, bookingId]
      )
      await audit.recordAll(tx, [
        {
          actorType: 'staff',
          actorId: options.actor.id,
          action: 'booking.refund_owed_arrived',
          entityType: 'booking',
          entityId: bookingId,
          requestId: options.requestId,
          details: { amount: owed, reason },
        },
      ])
      return { cardRefundedAmount: 0, storeCreditRefundedAmount: 0, pricePaid: round2(figures.pricePaid - owed) }
    },
    notSaved
  )
}

// --- Reconcile (D-plan 4.10) and the close by hand

/** A claim's card part as Stripe shows it: a refund naming the claim, none, or more than one (left for a person). */
type PartFound = { kind: 'went' } | { kind: 'none' } | { kind: 'several'; ids: string[] } | { kind: 'mismatch'; detail: string } | { kind: 'unclear'; detail: string }

const LIST_PAGE = 100
const LIST_MOST_PAGES = 10

/** Every refund on a PaymentIntent, every page (at most LIST_MOST_PAGES); 'unclear' when Stripe didn't answer. */
async function listRefunds(
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
 * is money gone; failed or cancelled, or none, is money that never went. Never sends anything.
 */
export async function findCardPart(stripe: StripeClient, claimId: string, part: CardPart, timing: StripeTiming | undefined): Promise<PartFound> {
  const listed = await listRefunds(stripe, part.paymentIntentId, timing)
  if (listed.kind === 'unclear') return listed
  const matched = listed.refunds.filter((refund) => refund.metadata?.['claim_id'] === claimId)
  const live = matched.filter((refund) => refund.status !== 'failed' && refund.status !== 'canceled')
  if (live.length > 1) return { kind: 'several', ids: live.map((refund) => refund.id) }
  const refund = live[0]
  if (!refund) return { kind: 'none' }
  if (refund.amount !== pence(part.amount)) return { kind: 'mismatch', detail: `${refund.id} is ${refund.amount}p, the part ${pence(part.amount)}p` }
  return { kind: 'went' }
}
