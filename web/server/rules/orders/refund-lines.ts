// New in W28 (E-plan 4.3, 4.5 to 4.8): order refunds on the Worker, on step D's refund pipeline. Replaces the staff
// app's refundOrder, and adds what an order needs to hold money owed (Wayne's Q39): Refund the rest and It already
// arrived on an order.
//
// W29 adds the line that sells a membership, and the payment date change charge:
// - R1 marks the membership cancelled with no add-on credits, as the old function did, and (Wayne's Q41) flags its
//   future credit bookings as payment needed in the same transaction, where the old code left that to Stripe's webhook
//   a moment later (and never did it for a membership with no subscription). The undo puts all of it back.
// - Wayne's Q40: each line goes back to the card payment that took it. On a saved-card membership order with a
//   remainder charge there are two card payments: the subscription's first invoice took the membership, the order's
//   PaymentIntent the rest of the basket. A Card refund of the membership line is a refund of the first, and is made on
//   its own (a claim has one card part); the other lines' card money is the order's own payment's, as before.
// - The Stripe subscription is cancelled last, after the money is settled (refund-subscription.ts): never before, so
//   a card refund Stripe refuses never leaves a cancelled subscription, and a cancel that fails is recorded, listed
//   and retried by reconcile (bug E10).
// - A payment date change charge is a membership line that sold no membership: it refunds as a plain line (no
//   cancel, the new date stays), as the old function refunded it.
//
// R1 is one transaction with no Stripe call: the order locked (LOCK_ORDER: the order, its customer, then the passes,
// product variants and gift cards the lines need), every old check in the old order, E2 (only a paid or part refunded
// order, with no refund open), E5 (a pass is used when a seat was taken with it and not returned), the figures and the
// amount staff confirmed (Q18, half a penny; review L3: no `confirmed`, nothing moves), the plan (the card capped at
// the order's card money left, the rest to store credit; or Q42's cash, capped at the cash paid, the rest to store
// credit), the claim (`order.refund_claimed`), the lines' own reversals (a gift card voided, a pass emptied, stock back
// with its stock_adjustments row) and the lines stamped. With no card part R1 also gives the store credit (or records
// the cash), works out the order's status and finishes the claim: one transaction, nothing held.
//
// With a card part, R1 commits, then the press sends it once, keyed `<claimId>:refund:<orderId>` with
// `metadata.claim_id`, then R2 (one transaction): the card money on the lines, the store credit for the rest, the
// order's status, the claim finished.
// - Refused (nothing went): marked on the claim, then R1 undone in one transaction, with the old words. A refused card
//   refund is never given as store credit by the system (Wayne, 14 Nov). If the undo can't run (a restocked item has
//   been sold since) or fails, the refund stands and the card money is owed on the order with Stripe's reason.
// - No clear answer: the claim is held. No press ever sends it again: reconcile lists the refunds on the payment,
//   matches `metadata.claim_id`, and runs R2 (found) or leaves the money owed on the order (not found). Never resent.
//
// What the old code needed and this doesn't (E-plan, "six things" item 4): the settle-on-the-next-press machinery
// (shared/heldCardRefund), refusal counts in the key (cardRefundAttempts), finding a store credit movement by its
// note (storeCreditRefund), and every take-back. One transaction and a key from the claim replace them.
import 'server-only'
import type { OrderOwedArrivedInput, OrderOwedOutput, OrderRefundFigures, OrderRefundLineFigures, OrderRefundOwedInput, RefundOrderInput, RefundOrderOutput } from '@/contracts'
import type { ApiErrorCode } from '@/contracts'
import { audit, type AuditEntry } from '@/server/audit'
import { isDeadlock, type Db, type Queryable, type Tx } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import type { StripeClient } from '@/server/stripe/client'
import { stripeTiming, type StripeTiming } from '@/server/stripe/deadline'
import { inC1 } from '@/server/rules/bookings/money-in'
import { loadOrderCardPortion, recordOrderPaymentStatus } from '@/server/rules/bookings/money-left'
import {
  markStepEClaimRefused,
  openClaimHolding,
  readOrderClaim,
  refundOpenRefusal,
  stepEClaimFinished,
  writeOrderClaim,
  type OrderClaim,
  type OrderClaimDetails,
  type OrderRefundLineClaim,
  type StepEClaimMethod,
  type StepEPlan,
} from '@/server/rules/refunds/claims'
import {
  arrivedCardShortWords,
  MEMBERSHIP_REFUND_WORDS,
  ORDER_OWED_NOTES,
  ORDER_REFUND_DIALOG_WORDS,
  ORDER_REFUND_NEW_WORDS as NEW_WORDS,
  ORDER_REFUND_NOTES,
  ORDER_REFUND_WORDS as WORDS,
} from '@/server/rules/refunds/failure-messages'
import { lockForRefund } from '@/server/rules/refunds/locks'
import { heldAnswer, ORDER_CLAIMS, sendCardPart, type CardPart, type CardPartLine } from '@/server/rules/refunds/pipeline'
import { claimWatchEntries, refundSeen, refundsForRow, type RefundSeen } from '@/server/rules/refunds/refund-watch'
import { lowerMoneyOwed, raiseMoneyOwed } from './money-owed'
import { cancelLeftWarning, cancelSubscriptionsAfterRefund, refundedSubscriptions, subscriptionsLeftByRefund } from './refund-subscription'

/** The action's own audit rows (same transaction as what they record, E-plan 4.10). */
export const ORDER_REFUNDED = 'order.refund'
export const ORDER_OWED_REFUNDED = 'order.refund_owed'
export const ORDER_OWED_ARRIVED = 'order.owed_arrived'
/** The reason's limit on It already arrived, as a booking's. */
export const ORDER_REASON_MAX_LENGTH = 200

export interface OrderRefundOptions {
  actor: { type: 'staff'; id: string }
  requestId: string
  /** The request's start: the press's Stripe call ends by a deadline from it. */
  startedAt?: number
  now?: () => number
  /** The Stripe client, made before R1 for a card refund, so a missing key fails with nothing written. */
  stripe?: () => StripeClient
}

/** Who finishes a claim: the press, reconcile, or a person closing it by hand (as a booking claim's `FinishedBy`). */
export interface OrderFinishedBy {
  actor: { type: 'staff' | 'system'; id: string | null }
  requestId: string
  how: 'press' | 'reconcile' | 'close' | 'undo_blocked' | 'undo_failed'
  why?: string
}

/** What a claim ended with. `owed`: card money that never went, left on the order as still to refund (Q39). */
export interface OrderClaimOutcome {
  /** The card part, when it went. */
  went: CardPart[]
  /** W32: its refund as Stripe answered or lists it: kept on the finished row, and watched while it hasn't succeeded. */
  refunds?: RefundSeen[]
  owed: number
  /** Stripe's reason when it refused the card part, kept on the finished row. */
  refused?: string
  warning?: string
}

/** What R2 did, for each action's own answer. */
export interface OrderClaimFinished {
  kind: OrderClaimDetails['kind']
  amount: number
  method: StepEClaimMethod
  cardRefunded: number
  storeCreditRefunded: number
  cashRefunded: number
  storeCreditBalance?: number
  /** The order's payment status worked out again, when it changed to refunded or partially refunded. */
  orderPaymentStatus?: string
  /** What is still to refund on the order after this. */
  refundOwed: number
  warning?: string
}

const round2 = (n: number): number => Math.round(n * 100) / 100
const amountOf = (value: string | null | undefined): number => Number.parseFloat(value ?? '0')
const sum = (amounts: readonly number[]): number => round2(amounts.reduce((total, n) => total + n, 0))
/** Half a penny either way passes (Q18), rounded first: taking pounds from pounds leaves noise. */
const overHalfPenny = (amount: number, limit: number): boolean => Math.round((amount - limit) * 1e6) / 1e6 > 0.005
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// --- Refusals

type Action = 'refund' | 'refund_owed' | 'owed_arrived'
type RefusalExtras = { figures?: OrderRefundFigures; field?: string; logDetail?: string }

/**
 * A refusal before anything moved: the old function's reason and its words, in `details`, so the staff app's thin
 * wrapper puts the old result shape back. `order_not_found` had no words of its own: the dialog's bracketed reason.
 */
export function orderRefundRefusal(code: ApiErrorCode, reason: string, message: string | undefined, action: Action = 'refund', extras: RefusalExtras = {}): ApiError {
  const words = message ?? ORDER_REFUND_DIALOG_WORDS.refusedWithNoWords(reason)
  return new ApiError(code, words, {
    ...(extras.field ? { field: extras.field } : {}),
    ...(extras.logDetail ? { logDetail: extras.logDetail } : {}),
    details: { reason, message: words, action, ...(extras.figures ? { figures: extras.figures } : {}) },
  })
}

const notSaved =
  (action: Action) =>
  (logDetail: string): ApiError =>
    orderRefundRefusal('INTERNAL', 'refund_not_saved', NEW_WORDS.notSaved, action, { logDetail })

// --- The order, its lines, and what each line can give back

interface OrderRow {
  id: string
  customer_id: string
  payment_status: string
  stripe_payment_intent_id: string | null
  refund_owed_amount: string
  date_change: boolean
}

interface LineRow {
  id: string
  item_type: string
  quantity: number
  line_total: string
  discount_amount: string | null
  card_refunded_amount: string | null
  product_variant_id: string | null
  gift_card_id: string | null
  refunded_at: unknown
}

const ORDER_SQL = `
SELECT o.id, o.customer_id, o.payment_status, o.stripe_payment_intent_id, o.refund_owed_amount::text AS refund_owed_amount,
       EXISTS (SELECT 1 FROM membership_payment_date_changes d WHERE d.order_id = o.id) AS date_change
FROM orders o WHERE o.id = $1::uuid`

const LINE_COLUMNS = `id, item_type, quantity, line_total::text AS line_total, discount_amount::text AS discount_amount,
       card_refunded_amount::text AS card_refunded_amount, product_variant_id, gift_card_id, refunded_at`

/** Every line of the order, oldest first: the order the card part is shared out in, and the dialog's list. */
const ORDER_LINES_SQL = `SELECT ${LINE_COLUMNS} FROM order_line_items WHERE order_id = $1::uuid ORDER BY created_at, id`
/** The chosen lines of the order (`$1` their ids, `$2` the order), oldest first. A line of another order isn't found. */
const CHOSEN_LINES_SQL = `SELECT ${LINE_COLUMNS} FROM order_line_items WHERE id = ANY($1::uuid[]) AND order_id = $2::uuid ORDER BY created_at, id`

/**
 * What a line can still give back, as the old function: its total, less its promo discount, less card money it has
 * already had back (an old refund that stopped after its card part), never below £0 (E1: not its bare total).
 */
const lineRefundable = (line: LineRow): number => Math.max(0, round2(amountOf(line.line_total) - amountOf(line.discount_amount) - amountOf(line.card_refunded_amount)))

/** The gift card a line sold, as the old check read it. */
async function giftCardBlock(db: Queryable, line: LineRow): Promise<string | null> {
  const card = line.gift_card_id
    ? (
        await db.query<{ remaining_balance: string; original_value: string; voided: boolean | null }>(
          'SELECT remaining_balance::text AS remaining_balance, original_value::text AS original_value, voided FROM gift_cards WHERE id = $1::uuid',
          [line.gift_card_id]
        )
      )[0]
    : undefined
  if (!card) return WORDS.giftCardNotFound(line.id)
  if (card.voided === true || amountOf(card.remaining_balance) !== amountOf(card.original_value)) return WORDS.giftCardRedeemed(line.id)
  return null
}

interface PassFound {
  id: string
  sessionsRemaining: number
  /** E5: seats taken with this pass and not returned. */
  used: number
}

/**
 * The pass a line sold. E5 (lead call L10): "used" is a seat taken with this pass and not returned, read from the
 * bookings that name it, never from what the pass type's sessions are set to today (a type edited since the sale made
 * a used pass look unused, and an unused one used). A booking that isn't cancelled holds its seat. A cancelled one
 * gave the session back only through Cancel & return credit, which records the pass on its row (`passReturned`); a
 * cancel with nothing back (inside 24 hours, or an expired pass) kept it.
 *
 * W28a (review S1): a dearer Move off a pass seat, on the reader or a saved card, clears the booking's pass at once but
 * gives the session back only when the payment lands (its cancel puts the pass back on the booking). While that
 * payment is open no booking names the pass and its session hasn't come back, so the open Move counts as a seat still
 * taken: its record names the pass and says it will give the session back.
 */
async function passFor(db: Queryable, lineId: string): Promise<PassFound | null> {
  const row = (
    await db.query<{ id: string; sessions_remaining: number; used: number }>(
      `SELECT p.id, p.sessions_remaining,
              (SELECT COUNT(*)::int FROM bookings b
               WHERE b.redeemed_session_pass_id = p.id
                 AND (b.status <> 'cancelled'
                      OR NOT EXISTS (SELECT 1 FROM audit_log a
                                     WHERE a.action = 'booking.cancel_credit' AND a.entity_type = 'booking' AND a.entity_id = b.id::text
                                       AND a.details->>'passReturned' = p.id::text)))
              + (SELECT COUNT(*)::int FROM pending_reader_payments f
                 WHERE f.status = 'pending' AND f.flow = 'move'
                   AND f.snapshot->>'release_session_pass_on_finalise' = 'true'
                   AND f.snapshot->>'old_redeemed_session_pass_id' = p.id::text) AS used
       FROM customer_session_passes p WHERE p.order_line_item_id = $1::uuid
       ORDER BY p.created_at, p.id LIMIT 1`,
      [lineId]
    )
  )[0]
  return row ? { id: row.id, sessionsRemaining: Number(row.sessions_remaining), used: Number(row.used) } : null
}

/**
 * A line that sells a membership (W29). A payment date change charge (changeMembershipPaymentDate) is recorded as its
 * own order with one membership line, but it sold no membership: on such an order the line is a plain one, with no
 * cancel and no membership change, and the new date stays (the old function's rule, word for word).
 */
const sellsMembership = (order: Pick<OrderRow, 'date_change'>, line: Pick<LineRow, 'item_type'>): boolean => line.item_type === 'membership' && !order.date_change

interface MembershipFound {
  id: string
  subscriptionId: string | null
  status: string | null
  addonCredits: number
  cancelEffectiveDate: string | null
  /** Q41: credit sessions already taken with it (a seat held on its credit in a session that has started). */
  creditSessionsTaken: number
  /** Q41: its confirmed credit bookings still to come: what R1 flags as payment needed. */
  futureCreditBookings: number
}

/**
 * "Still to come", as the database's flag_uncovered_credit_bookings reads it (bookings.start_time holds London wall
 * clock time): R1 flags with that function, and this is only the count the dialog shows before the press. A test
 * holds the two to each other.
 */
const STARTED = "(b.start_time AT TIME ZONE 'UTC') <= (now() AT TIME ZONE 'Europe/London')"

/** The membership a line sold (`$1` the line), with Q41's two counts. Fixed text: STARTED is a constant. */
const MEMBERSHIP_SQL = `
SELECT m.id, m.stripe_subscription_id, m.subscription_status, m.addon_credits_remaining, m.cancel_effective_date::text AS cancel_effective_date,
       (SELECT COUNT(*)::int FROM bookings b
        WHERE b.redeemed_membership_id = m.id AND b.redemption_source = 'membership_credit'
          AND b.status IN ('confirmed', 'completed', 'no-show') AND ${STARTED}) AS taken,
       (SELECT COUNT(*)::int FROM bookings b
        WHERE b.redeemed_membership_id = m.id AND b.redemption_source = 'membership_credit'
          AND b.status = 'confirmed' AND NOT (${STARTED})) AS future
FROM customer_memberships m WHERE m.order_line_item_id = $1::uuid
ORDER BY m.created_at, m.id LIMIT 1`

/** The membership a line sold, as the old check read it, with Q41's two counts. */
async function membershipFor(db: Queryable, lineId: string): Promise<MembershipFound | null> {
  const row = (
    await db.query<{ id: string; stripe_subscription_id: string | null; subscription_status: string | null; addon_credits_remaining: number; cancel_effective_date: string | null; taken: number; future: number }>(MEMBERSHIP_SQL, [lineId])
  )[0]
  if (!row) return null
  return {
    id: row.id,
    subscriptionId: row.stripe_subscription_id,
    status: row.subscription_status,
    addonCredits: Number(row.addon_credits_remaining),
    cancelEffectiveDate: row.cancel_effective_date,
    creditSessionsTaken: Number(row.taken),
    futureCreditBookings: Number(row.future),
  }
}

/**
 * Why a line can't be refunded as things stand, with the old reason and words, or null. The checks the old function
 * ran on each kind of line, in its order (an event line, a booking line, already refunded, the gift card, the pass,
 * the membership); R1 runs the same ones under the order's lock.
 */
async function lineBlock(db: Queryable, order: Pick<OrderRow, 'date_change'>, line: LineRow): Promise<{ reason: string; message: string } | null> {
  if (line.item_type === 'event') return { reason: 'use_event_cancellation', message: WORDS.useEventCancellation }
  if (line.item_type === 'booking') return { reason: 'booking_not_supported', message: WORDS.bookingNotSupported }
  if (line.refunded_at !== null) return { reason: 'already_refunded', message: WORDS.alreadyRefunded([line.id]) }
  if (line.item_type === 'gift_card') {
    const blocked = await giftCardBlock(db, line)
    if (blocked) return { reason: 'gift_card_already_redeemed', message: blocked }
  }
  if (line.item_type === 'session_pass') {
    const pass = await passFor(db, line.id)
    if (!pass) return { reason: 'session_pass_instance_not_found', message: WORDS.passNotFound(line.id) }
    if (pass.used > 0) return { reason: 'session_pass_already_used', message: WORDS.passUsed(line.id, pass.sessionsRemaining, pass.sessionsRemaining + pass.used) }
  }
  if (sellsMembership(order, line) && !(await membershipFor(db, line.id))) return { reason: 'membership_instance_not_found', message: WORDS.membershipNotFound(line.id) }
  return null
}

/**
 * Q42 (Wayne, 14 Nov): the cash paid on the order that can still be handed back. Cash was paid only on an order with no
 * card payment whose method is cash, or split (a gift card or store credit with cash): its total less its promo, gift
 * card and store credit. Less the cash already handed back for it: by its own refunds, by an event booking it paid for
 * (W30), and by Part refunds of the bookings it has a line for (step D's Q26, which hand back the same order's cash).
 */
const CASH_LEFT_SQL = `
SELECT CASE WHEN o.stripe_payment_intent_id IS NULL AND o.payment_method IN ('cash', 'split') THEN
         GREATEST(o.order_total - COALESCE(o.discount_amount, 0)
           - COALESCE((SELECT SUM(gcr.amount_used) FROM gift_card_redemptions gcr WHERE gcr.order_id = o.id), 0)
           - COALESCE((SELECT -SUM(sct.amount) FROM store_credit_transactions sct
                       WHERE sct.order_id = o.id AND sct.amount < 0 AND sct.reason IN ('redemption', 'redemption_reversal')), 0), 0)
       ELSE 0 END::text AS paid,
       (COALESCE((SELECT SUM((c.details->'plan'->>'cash')::numeric) FROM audit_log c
                  WHERE c.details->>'worker' = 'true'
                    AND ((c.action = 'order.refund_claimed' AND c.entity_type = 'order' AND c.entity_id = o.id::text)
                      OR (c.action = 'event_booking.refund_claimed' AND c.entity_type = 'event_booking' AND c.details->>'orderId' = o.id::text))), 0)
        + COALESCE((SELECT SUM((c.details->'plan'->>'cash')::numeric) FROM audit_log c
                    WHERE c.action = 'booking.refund_claimed' AND c.entity_type = 'booking' AND c.details->>'worker' = 'true'
                      AND c.entity_id IN (SELECT oli.booking_id::text FROM order_line_items oli
                                          WHERE oli.order_id = o.id AND oli.item_type = 'booking' AND oli.booking_id IS NOT NULL)), 0))::text AS handed_back
FROM orders o WHERE o.id = $1::uuid`

export async function orderCashLeft(db: Queryable, orderId: string): Promise<number> {
  const row = (await db.query<{ paid: string; handed_back: string }>(CASH_LEFT_SQL, [orderId]))[0]
  return Math.max(0, round2(amountOf(row?.paid) - amountOf(row?.handed_back)))
}

/** One card payment a refund can go back to: what it can still take (nothing when it isn't named), and what it would if it were. */
interface CardLeft {
  left: number
  paymentIntentId: string | null
  remaining: number
}

/**
 * The card money a refund can still reach. `order`: the order's own payment (nothing when the order names no card
 * payment). `membership` (W29, Wayne's Q40): the membership's own payment, when it had one beside the order's (a
 * saved-card membership order with a remainder charge), else null: a Card refund of the membership line goes there.
 */
async function orderCardLeft(db: Queryable, orderId: string): Promise<{ order: CardLeft; membership: CardLeft | null } | null> {
  const portion = await loadOrderCardPortion(db, orderId)
  if (!portion) return null
  const own = portion.membershipPayment
  return {
    order: { left: portion.paymentIntentId ? portion.cardPortionRemaining : 0, paymentIntentId: portion.paymentIntentId, remaining: portion.cardPortionRemaining },
    membership: own ? { left: own.paymentIntentId ? own.remaining : 0, paymentIntentId: own.paymentIntentId, remaining: own.remaining } : null,
  }
}

/** E2: a refund starts only on an order that is paid, or part refunded. A payment still open is `pending`. */
const REFUNDABLE_STATUSES: ReadonlySet<string> = new Set(['paid', 'partially_refunded'])

async function figuresFrom(db: Queryable, order: OrderRow, lines: readonly LineRow[]): Promise<OrderRefundFigures> {
  const card = await orderCardLeft(db, order.id)
  const lineFigures: OrderRefundLineFigures[] = []
  for (const line of lines) {
    const open = line.refunded_at === null
    // W29: a membership line still to refund says how much of it was used (Q41) and, when it was paid by its own card
    // payment, what that payment can still give back (Q40).
    const membership = open && sellsMembership(order, line) ? await membershipFor(db, line.id) : null
    lineFigures.push({
      lineItemId: line.id,
      itemType: line.item_type,
      lineTotal: amountOf(line.line_total),
      discount: amountOf(line.discount_amount),
      cardRefunded: amountOf(line.card_refunded_amount),
      refundable: open ? lineRefundable(line) : 0,
      refunded: !open,
      blocked: open ? await lineBlock(db, order, line) : null,
      ...(membership ? { membership: { creditSessionsTaken: membership.creditSessionsTaken, futureCreditBookings: membership.futureCreditBookings } } : {}),
      ...(membership && card?.membership ? { ownCardLeft: card.membership.left } : {}),
    })
  }
  const holding = await openClaimHolding(db, order.id)
  const open = holding ? refundOpenRefusal('order', holding.on) : null
  const blocked = open
    ? { reason: 'refund_open', message: open.message }
    : REFUNDABLE_STATUSES.has(order.payment_status)
      ? null
      : order.payment_status === 'refunded'
        ? null
        : { reason: 'order_not_paid', message: NEW_WORDS.orderNotPaid }
  const refundOwed = round2(amountOf(order.refund_owed_amount))
  // W47 (F3): the payment Refund the rest would use for the money owed, and what it can take: the press's own choice.
  const owedOn = refundOwed > 0 ? await owedPayment(db, order.id) : null
  return {
    orderId: order.id,
    paymentStatus: order.payment_status,
    lines: lineFigures,
    cardLeft: card?.order.left ?? 0,
    cashLeft: await orderCashLeft(db, order.id),
    refundOwed,
    ...(owedOn ? { owedCard: { payment: owedOn.membershipLines === true ? 'membership' : 'order', left: owedOn.card.left } } : {}),
    blocked,
  }
}

/**
 * GET /orders/:id/refund-figures: what the Refund Line Items dialog shows and sends back (E1, Q18): each line's
 * figure, the card and cash that can still go back, any money owed, and why nothing can start (E2, `refund_open`).
 * The refund route checks the same ones. Null when the order doesn't exist.
 */
export async function loadOrderRefundFigures(db: Queryable, orderId: string): Promise<OrderRefundFigures | null> {
  const order = (await db.query<OrderRow>(ORDER_SQL, [orderId]))[0]
  if (!order) return null
  return figuresFrom(db, order, await db.query<LineRow>(ORDER_LINES_SQL, [orderId]))
}

// --- R1

/** `done`: R1 finished the claim itself (no card part); its claim is there when a subscription is still to cancel (W29). */
type Started<Output> = { kind: 'done'; output: Output; claim?: OrderClaim } | { kind: 'card'; claim: OrderClaim }

/** The order under its lock, or the old refusal for one that doesn't exist. Every refund is refused while a claim holds it. */
async function lockOrder(tx: Tx, orderId: string, action: Action, targets: { sessionPassIds?: string[]; membershipIds?: string[]; productVariantIds?: string[]; giftCardIds?: string[] } = {}): Promise<OrderRow> {
  const locks = UUID.test(orderId) ? await lockForRefund(tx, { orderId, ...targets }) : null
  const order = locks ? (await tx.query<OrderRow>(ORDER_SQL, [orderId]))[0] : undefined
  if (!order) throw orderRefundRefusal('NOT_FOUND', 'order_not_found', undefined, action)
  // An open claim holds the order for every refund (`refund_open`), with the words for what holds it (review L4).
  const holding = await openClaimHolding(tx, orderId)
  if (holding) throw refundOpenRefusal('order', holding.on)
  return order
}

/**
 * The ids the lines' locks need, read with no lock first (E-plan 4.2: read the ids, lock, then check again under the
 * lock). W29: the memberships the lines sold, and whether any of the lines is a membership's (`membership`), which
 * decides whether the press needs Stripe for the cancel that comes last.
 */
async function lockTargets(db: Queryable, orderId: string, lineIds: readonly string[]): Promise<{ sessionPassIds: string[]; membershipIds: string[]; productVariantIds: string[]; giftCardIds: string[]; membership: boolean }> {
  if (!UUID.test(orderId) || lineIds.length === 0) return { sessionPassIds: [], membershipIds: [], productVariantIds: [], giftCardIds: [], membership: false }
  const rows = await db.query<{ variant: string | null; gift_card: string | null; pass: string | null; membership: string | null; item_type: string }>(
    `SELECT oli.product_variant_id AS variant, oli.gift_card_id AS gift_card, oli.item_type,
            (SELECT p.id FROM customer_session_passes p WHERE p.order_line_item_id = oli.id ORDER BY p.created_at, p.id LIMIT 1) AS pass,
            (SELECT m.id FROM customer_memberships m WHERE m.order_line_item_id = oli.id ORDER BY m.created_at, m.id LIMIT 1) AS membership
     FROM order_line_items oli WHERE oli.order_id = $1::uuid AND oli.id = ANY($2::uuid[])`,
    [orderId, lineIds]
  )
  const present = (values: Array<string | null>): string[] => values.filter((value): value is string => value !== null)
  return {
    sessionPassIds: present(rows.map((row) => row.pass)),
    membershipIds: present(rows.map((row) => row.membership)),
    productVariantIds: present(rows.map((row) => row.variant)),
    giftCardIds: present(rows.map((row) => row.gift_card)),
    membership: rows.some((row) => row.item_type === 'membership'),
  }
}

/** The plan: the card capped at the order's card money left, or Q42's cash capped at the cash paid; the rest to store credit. */
function planFor(orderId: string, method: StepEClaimMethod, lines: ReadonlyArray<{ id: string; amount: number }>, card: { left: number; paymentIntentId: string | null }, cashLeft: number): StepEPlan {
  const total = sum(lines.map((line) => line.amount))
  const cardAmount = method === 'card' && card.paymentIntentId ? round2(Math.min(total, card.left)) : 0
  const cash = method === 'cash' ? round2(Math.min(total, cashLeft)) : 0
  const parts: CardPart[] = []
  if (cardAmount > 0 && card.paymentIntentId) {
    // The card money each line gets, in line order, as the old function recorded it.
    let left = cardAmount
    const shares: CardPartLine[] = []
    for (const line of lines) {
      const take = round2(Math.min(left, line.amount))
      if (take <= 0) continue
      shares.push({ lineId: line.id, amount: take })
      left = round2(left - take)
    }
    parts.push({ orderId, paymentIntentId: card.paymentIntentId, amount: cardAmount, lines: shares })
  }
  const storeCredit = round2(total - cardAmount - cash)
  return { card: parts, storeCredit: storeCredit > 0.005 ? storeCredit : 0, cash, ownOrderId: orderId }
}

/**
 * W29, a membership line's own reversal in R1. The membership is marked cancelled with no add-on credits and no end
 * date, exactly as the old function wrote it. Then (Wayne's Q41) its future credit bookings are flagged as payment
 * needed here, in the same transaction, by the database's own rule (flag_uncovered_credit_bookings, which Stripe's
 * webhook runs for a cancelled subscription): the old code left them to that webhook, a moment later, and a membership
 * with no subscription never had them flagged at all. Covered through yesterday: the membership is refunded in full,
 * so nothing from now on is covered by it; sessions already started stay as they are.
 *
 * Which bookings were flagged is read around the call (the function answers a count): the confirmed credit bookings
 * before it that are payment needed after it. The undo confirms exactly those again.
 */
async function cancelMembershipInR1(tx: Tx, membership: MembershipFound): Promise<NonNullable<OrderRefundLineClaim['membership']>> {
  const confirmed = (
    await tx.query<{ id: string }>("SELECT id FROM bookings WHERE redeemed_membership_id = $1::uuid AND redemption_source = 'membership_credit' AND status = 'confirmed' ORDER BY id", [membership.id])
  ).map((row) => row.id)
  const cancelled = await tx.query(
    `UPDATE customer_memberships
     SET subscription_status = 'cancelled', addon_credits_remaining = 0, cancel_effective_date = NULL, updated_at = now()
     WHERE id = $1::uuid RETURNING id`,
    [membership.id]
  )
  if (cancelled.length !== 1) throw new Error(`Membership ${membership.id} was not marked cancelled.`)
  await tx.query("SELECT public.flag_uncovered_credit_bookings($1::uuid, ((now() AT TIME ZONE 'Europe/London')::date - 1)) AS flagged", [membership.id])
  const flagged =
    confirmed.length > 0
      ? (await tx.query<{ id: string }>("SELECT id FROM bookings WHERE id = ANY($1::uuid[]) AND status = 'payment_needed' ORDER BY id", [confirmed])).map((row) => row.id)
      : []
  return {
    id: membership.id,
    subscriptionId: membership.subscriptionId,
    status: membership.status,
    addonCredits: membership.addonCredits,
    cancelEffectiveDate: membership.cancelEffectiveDate,
    flaggedBookingIds: flagged,
  }
}

async function refundR1(tx: Tx, orderId: string, input: RefundOrderInput, options: OrderRefundOptions, livemode: boolean | null, targets: Awaited<ReturnType<typeof lockTargets>>): Promise<Started<RefundOrderOutput>> {
  const lineIds = input.lineItemIds ?? []
  const method = input.refundMethod as StepEClaimMethod
  const order = await lockOrder(tx, orderId, 'refund', targets)

  // The lines, under the lock, in the old function's order of checks.
  const lines = lineIds.every((id) => UUID.test(id)) ? await tx.query<LineRow>(CHOSEN_LINES_SQL, [lineIds, orderId]) : []
  if (lines.length !== lineIds.length) throw orderRefundRefusal('VALIDATION', 'line_item_not_found', WORDS.lineNotOnOrder)
  // An event's places are cancelled from its attendee list (W30); a booking's line through the booking (step D). The
  // one-way hold between a booking's refund and an order's rests on this refusal (claims.ts, W27a).
  if (lines.some((line) => line.item_type === 'event')) throw orderRefundRefusal('VALIDATION', 'use_event_cancellation', WORDS.useEventCancellation)
  if (lines.some((line) => line.item_type === 'booking')) throw orderRefundRefusal('VALIDATION', 'booking_not_supported', WORDS.bookingNotSupported)
  const refunded = lines.filter((line) => line.refunded_at !== null)
  if (refunded.length > 0) throw orderRefundRefusal('CONFLICT', 'already_refunded', WORDS.alreadyRefunded(refunded.map((line) => line.id)))
  // E2: nothing is given back on an order whose payment hasn't finished (the old function gave store credit for a
  // reader order still on hold, and left its payment unable to be cancelled or finalised).
  if (!REFUNDABLE_STATUSES.has(order.payment_status)) throw orderRefundRefusal('CONFLICT', 'order_not_paid', NEW_WORDS.orderNotPaid)
  for (const line of lines) {
    if (line.item_type === 'product' && typeof input.restock?.[line.id] !== 'boolean') throw orderRefundRefusal('VALIDATION', 'restock_decision_required', WORDS.restockDecisionRequired(line.id))
  }
  for (const line of lines.filter((one) => one.item_type === 'gift_card')) {
    const blocked = await giftCardBlock(tx, line)
    if (blocked) throw orderRefundRefusal('CONFLICT', 'gift_card_already_redeemed', blocked)
  }
  const passes = new Map<string, PassFound>()
  for (const line of lines.filter((one) => one.item_type === 'session_pass')) {
    const pass = await passFor(tx, line.id)
    if (!pass) throw orderRefundRefusal('CONFLICT', 'session_pass_instance_not_found', WORDS.passNotFound(line.id))
    if (pass.used > 0) throw orderRefundRefusal('CONFLICT', 'session_pass_already_used', WORDS.passUsed(line.id, pass.sessionsRemaining, pass.sessionsRemaining + pass.used))
    passes.set(line.id, pass)
  }
  // W29: the membership each membership line sold, as the old check (a payment date change charge sold none).
  const memberships = new Map<string, MembershipFound>()
  for (const line of lines.filter((one) => sellsMembership(order, one))) {
    const membership = await membershipFor(tx, line.id)
    if (!membership) throw orderRefundRefusal('CONFLICT', 'membership_instance_not_found', WORDS.membershipNotFound(line.id))
    memberships.set(line.id, membership)
  }

  // The amount, and the figure staff confirmed (Q18; review L3: without it, nothing moves).
  const amounts = lines.map((line) => ({ id: line.id, amount: lineRefundable(line) }))
  const total = sum(amounts.map((line) => line.amount))
  const confirmed = input.confirmed?.amount
  if (typeof confirmed !== 'number' || !Number.isFinite(confirmed)) {
    throw orderRefundRefusal('VALIDATION', 'amount_not_confirmed', NEW_WORDS.amountNotConfirmed, 'refund', { field: 'confirmed', figures: await figuresFrom(tx, order, await tx.query<LineRow>(ORDER_LINES_SQL, [orderId])) })
  }
  if (overHalfPenny(confirmed, total) || overHalfPenny(total, confirmed) || !(total > 0)) {
    throw orderRefundRefusal('CONFLICT', 'figures_changed', NEW_WORDS.figuresChanged, 'refund', { figures: await figuresFrom(tx, order, await tx.query<LineRow>(ORDER_LINES_SQL, [orderId])) })
  }

  // Where it goes. Card money can only go back through the payment that took it (Wayne's Q40).
  const cards = method === 'card' ? await orderCardLeft(tx, orderId) : null
  if (method === 'card' && !cards) throw orderRefundRefusal('NOT_FOUND', 'order_not_found', undefined)
  // W29 (Q40): a membership paid by its own card payment goes back to that payment, so it is refunded to the card on
  // its own (a claim has one card part, and the other lines' card money is on the order's payment). An order placed
  // before that payment was recorded can't name it: store credit, never the other payment (E3).
  const ownPayment = cards?.membership && memberships.size > 0 ? cards.membership : null
  if (ownPayment && lines.length > memberships.size) throw orderRefundRefusal('CONFLICT', 'membership_refund_alone', MEMBERSHIP_REFUND_WORDS.refundAlone)
  if (ownPayment && ownPayment.remaining > 0 && !ownPayment.paymentIntentId) throw orderRefundRefusal('CONFLICT', 'membership_payment_not_recorded', MEMBERSHIP_REFUND_WORDS.paymentNotRecorded)
  const card = ownPayment ?? cards?.order ?? null
  if (card && card.remaining > 0 && !card.paymentIntentId) throw orderRefundRefusal('CONFLICT', 'no_payment_intent_for_card_refund', WORDS.noPaymentIntent)
  const cashLeft = method === 'cash' ? await orderCashLeft(tx, orderId) : 0
  // Q42: cash only for cash paid on the order. With none left there is nothing to hand over: store credit instead.
  if (method === 'cash' && !(cashLeft > 0)) throw orderRefundRefusal('CONFLICT', 'no_cash_left', NEW_WORDS.noCashLeft, 'refund', { figures: await figuresFrom(tx, order, await tx.query<LineRow>(ORDER_LINES_SQL, [orderId])) })
  const plan = planFor(orderId, method, amounts, { left: card?.left ?? 0, paymentIntentId: card?.paymentIntentId ?? null }, cashLeft)

  // Each line's stamp: `card` while the card part lasts (line order), `cash` while the cash lasts, then `credit`. A
  // line that had card money back on an earlier try stays `card`, as before.
  const cardShares = new Map((plan.card[0]?.lines ?? []).map((share) => [share.lineId, share.amount]))
  let cashBudget = plan.cash
  const claimLines: OrderRefundLineClaim[] = []
  for (const line of lines) {
    const amount = lineRefundable(line)
    let stamp: StepEClaimMethod = (cardShares.get(line.id) ?? 0) > 0 || amountOf(line.card_refunded_amount) > 0 ? 'card' : 'credit'
    if (method === 'cash' && cashBudget > 0.001) {
      stamp = 'cash'
      cashBudget = round2(cashBudget - Math.min(cashBudget, amount))
    }
    const restocked = line.item_type === 'product' ? input.restock?.[line.id] === true : null
    const claimed: OrderRefundLineClaim = { id: line.id, itemType: line.item_type, amount, method: stamp, restocked }

    // The line's own reversal, as the old function made it.
    if (line.item_type === 'gift_card' && line.gift_card_id) {
      await tx.query('UPDATE gift_cards SET voided = true, updated_at = now() WHERE id = $1::uuid', [line.gift_card_id])
      claimed.giftCardId = line.gift_card_id
    }
    const pass = passes.get(line.id)
    if (pass) {
      await tx.query('UPDATE customer_session_passes SET sessions_remaining = 0, updated_at = now() WHERE id = $1::uuid', [pass.id])
      claimed.pass = { id: pass.id, sessionsRemaining: pass.sessionsRemaining }
    }
    const membership = memberships.get(line.id)
    if (membership) claimed.membership = await cancelMembershipInR1(tx, membership)
    if (restocked && line.product_variant_id) {
      await tx.query('UPDATE product_variants SET stock_quantity = stock_quantity + $1::int, updated_at = now() WHERE id = $2::uuid', [line.quantity, line.product_variant_id])
      // staff_id NULL marks it as the system's, as the old restock row.
      const adjustment = (
        await tx.query<{ id: string }>('INSERT INTO stock_adjustments (variant_id, change_amount, reason, staff_id) VALUES ($1::uuid, $2::int, $3::text, NULL) RETURNING id', [
          line.product_variant_id,
          line.quantity,
          ORDER_REFUND_NOTES.restock(orderId),
        ])
      )[0]
      if (!adjustment) throw new Error(`The restock of line ${line.id} was not recorded.`)
      claimed.restock = { variantId: line.product_variant_id, quantity: Number(line.quantity), adjustmentId: adjustment.id }
    }
    const stamped = await tx.query('UPDATE order_line_items SET refunded_at = now(), refund_method = $1::text, restocked = $2::boolean WHERE id = $3::uuid AND refunded_at IS NULL RETURNING id', [
      stamp,
      restocked,
      line.id,
    ])
    if (stamped.length !== 1) throw new Error(`Line ${line.id} was refunded under the order's lock.`)
    claimLines.push(claimed)
  }

  const claim = await writeOrderClaim(
    tx,
    orderId,
    {
      kind: 'refund',
      amount: total,
      method,
      reason: null,
      worker: true,
      plan,
      livemode: plan.card.length > 0 ? livemode : null,
      ...(plan.cash > 0 ? { handedOverBy: options.actor.id } : {}),
      lines: claimLines,
    },
    options
  )
  if (plan.card.length > 0) return { kind: 'card', claim }
  const finished = await finishOrderClaimInTransaction(tx, claim, { went: [], owed: 0 }, { actor: options.actor, requestId: options.requestId, how: 'press' })
  if (!finished) throw new Error(`Refund claim ${claim.id} was finished in its own transaction.`)
  return { kind: 'done', output: refundOutput(finished, claim), claim }
}

/** W29 (Q41): how many of the membership's future credit bookings the claim's R1 flagged as payment needed. */
const bookingsFlagged = (claim: OrderClaim): number => (claim.details.lines ?? []).reduce((total, line) => total + (line.membership?.flaggedBookingIds.length ?? 0), 0)

/** refundOrder's answer, in the old function's fields, from what R2 did. */
function refundOutput(finished: OrderClaimFinished, claim: OrderClaim): RefundOrderOutput {
  const flagged = bookingsFlagged(claim)
  return {
    refundedAmount: finished.amount,
    refundMethod: finished.method,
    ...(finished.cardRefunded > 0 ? { cardRefundedAmount: finished.cardRefunded } : {}),
    ...(finished.storeCreditRefunded > 0 ? { storeCreditRefundedAmount: finished.storeCreditRefunded } : {}),
    ...(finished.cashRefunded > 0 ? { cashRefundedAmount: finished.cashRefunded } : {}),
    ...(finished.storeCreditBalance !== undefined ? { storeCreditBalance: finished.storeCreditBalance } : {}),
    ...(finished.orderPaymentStatus ? { orderPaymentStatus: finished.orderPaymentStatus } : {}),
    ...(finished.refundOwed > 0 ? { refundOwed: finished.refundOwed } : {}),
    ...(finished.warning ? { warning: finished.warning } : {}),
    ...(flagged > 0 ? { bookingsFlagged: flagged } : {}),
  }
}

function owedOutput(finished: Pick<OrderClaimFinished, 'cardRefunded' | 'storeCreditRefunded' | 'cashRefunded' | 'storeCreditBalance' | 'refundOwed' | 'warning'>): OrderOwedOutput {
  return {
    cardRefundedAmount: finished.cardRefunded,
    storeCreditRefundedAmount: finished.storeCreditRefunded,
    ...(finished.cashRefunded > 0 ? { cashRefundedAmount: finished.cashRefunded } : {}),
    ...(finished.storeCreditBalance !== undefined ? { storeCreditBalance: finished.storeCreditBalance } : {}),
    refundOwed: finished.refundOwed,
    ...(finished.warning ? { warning: finished.warning } : {}),
  }
}

// --- R2: what went is recorded, the store credit given, what never went owed, the claim finished

/**
 * The lines a Refund the rest's card money is recorded on (so the order's card money left stays right): the order's
 * refunded lines stamped `card`, oldest first, each up to what it has not had back to the card; anything over goes on
 * the first of them.
 *
 * W30a (W30 review S2): anything over goes on the order's event line with money owed when there is one (see below),
 * and on the first stamped line only otherwise.
 *
 * W30 (W28 review L2): with no line stamped `card`, the money owed is an event booking's (a place cancel whose card
 * refund never went, on a booking that still has places, so its event line isn't stamped). It is recorded on that
 * event line: the order's event line whose booking has a claim that ended owed. Before, it went on the order's oldest
 * line, refunded or not, which lowered an unrefunded product line's figure by the card money. Only with neither is the
 * oldest line used.
 *
 * W35a (W35 audit S1): an event line also has money owed when a place's card refund was accepted by Stripe and failed
 * later (the W32 watch: the claim's finished row still says `given`, and the failure is the booking's
 * `event_booking.refund_failed_later` row). Without it, on an order with another line, Refund the rest recorded the
 * place's card money on that other line (a £24 soap read £40 back to the card).
 */
/**
 * W47a (W47 review S1): when nothing was last owed on the order of line `oli`: its newest Refund the rest (the claim
 * takes all that is owed off the order before anything is sent) or its newest It already arrived that left nothing
 * owed. `-infinity` when there is neither. An It already arrived for part of what is owed is not one: the rest is
 * still owed, and still the same line's.
 */
const ORDER_OWED_CLEARED_SQL = `COALESCE((
              SELECT max(l.at) FROM audit_log l
              WHERE l.entity_type = 'order' AND l.entity_id = oli.order_id::text
                AND ((l.action = '${ORDER_CLAIMS.claimed}' AND l.details->>'kind' = 'refund_owed')
                     OR (l.action = '${ORDER_OWED_ARRIVED}' AND COALESCE((l.details->>'owedAfter')::numeric, 0) <= 0))), '-infinity'::timestamptz)`

/**
 * True for an order line `oli` that is an event line whose booking's money is still owed (W30, W35a: above). Fixed
 * text.
 *
 * W47a (W47 review S1): "still". Until W47a this was true for ever once the booking had a claim that ended owed or a
 * refund that failed later, also after that money was given (Refund the rest) or had arrived (It already arrived).
 * W47 made the flag choose the payment too (owedPayment, below), so on a saved-card membership order a later owed
 * membership refund went to store credit instead of the membership's own payment. Now the line counts only while one
 * of these is later than the last time nothing was owed on the order (ORDER_OWED_CLEARED_SQL):
 * - a claim of its booking that ended owed, or a refund of its booking that failed later (as before); or
 * - a Refund the rest that put card money on this line and didn't stand: refused and put back, never found, or
 *   failed later (`order.refund_finished` with outcome `owed`, or `order.refund_failed_later`, of an order claim
 *   whose card part names the line). The same money is owed again, and it is still this line's: without this the
 *   second press would record it on another line. Such a row is always later than its own claim: the claim is
 *   committed first, Stripe is asked in between, and audit.recordAll stamps its rows after the clock's reading.
 */
const EVENT_LINE_OWED_SQL = `(oli.item_type = 'event' AND EXISTS (
            SELECT 1 FROM audit_log f
            WHERE f.at > ${ORDER_OWED_CLEARED_SQL}
              AND ((f.entity_type = 'event_booking' AND f.entity_id = oli.event_booking_id::text
                    AND ((f.action = 'event_booking.refund_finished' AND f.details->>'outcome' = 'owed')
                         OR f.action = 'event_booking.refund_failed_later'))
                   OR (f.entity_type = 'order' AND f.entity_id = oli.order_id::text
                       AND ((f.action = '${ORDER_CLAIMS.finished}' AND f.details->>'outcome' = 'owed')
                            OR f.action = 'order.refund_failed_later')
                       AND EXISTS (
                         SELECT 1 FROM audit_log c
                         WHERE c.entity_type = 'order' AND c.entity_id = oli.order_id::text AND c.action = '${ORDER_CLAIMS.claimed}'
                           AND c.id::text = f.details->>'claimId'
                           AND c.details->'plan'->'card' @> jsonb_build_array(jsonb_build_object('lines', jsonb_build_array(jsonb_build_object('lineId', oli.id::text)))))))))`

/**
 * The order's lines for owedCardLines: those stamped `card` first, oldest first, as before; then an event line whose
 * booking's money is still owed (W47a: only while it is, EVENT_LINE_OWED_SQL); then the rest.
 */
const OWED_CARD_LINES_SQL = `
SELECT l.id, l.short, l.stamped, l.event_owed
FROM (
  SELECT oli.id, oli.created_at,
         GREATEST(oli.line_total - COALESCE(oli.discount_amount, 0) - oli.card_refunded_amount, 0)::text AS short,
         (oli.refunded_at IS NOT NULL AND oli.refund_method = 'card') AS stamped,
         ${EVENT_LINE_OWED_SQL} AS event_owed
  FROM order_line_items oli
  WHERE oli.order_id = $1::uuid AND ($2::boolean IS NULL OR (oli.item_type = 'membership') = $2::boolean)
) l
ORDER BY l.stamped DESC, (l.event_owed AND NOT l.stamped) DESC, l.created_at, l.id`

async function owedCardLines(tx: Queryable, orderId: string, amount: number, membershipLines: boolean | null = null): Promise<CardPartLine[]> {
  // W29 (Q40): on an order with two card payments, only the lines the chosen payment took (`membershipLines`: the
  // membership's lines, or every other line), so each payment's card money stays on its own lines.
  const rows = await tx.query<{ id: string; short: string; stamped: boolean; event_owed: boolean }>(OWED_CARD_LINES_SQL, [orderId, membershipLines])
  const first = rows[0]
  if (!first) throw new Error(`Order ${orderId} has no line to record a card refund on.`)
  let left = round2(amount)
  const shares: CardPartLine[] = []
  for (const row of rows.filter((one) => one.stamped)) {
    const take = round2(Math.min(left, amountOf(row.short)))
    if (take <= 0) continue
    shares.push({ lineId: row.id, amount: take })
    left = round2(left - take)
  }
  if (left > 0) {
    // W30a (W30 review S2): what is left over is an event booking's owed money when the order has an event line with
    // money owed, so it goes on that line, not on the oldest stamped line (a soap refunded to the card in full would
    // read more back than it cost). Only without one does it go on `first`, as before.
    const over = rows.find((row) => row.event_owed) ?? first
    const onIt = shares.find((share) => share.lineId === over.id)
    if (onIt) onIt.amount = round2(onIt.amount + left)
    else shares.unshift({ lineId: over.id, amount: left })
  }
  return shares
}

/**
 * W29 (Q40): the card payment Refund the rest sends owed money back to. An order has one, except a saved-card
 * membership order with a remainder charge, which has two: there, the membership's own payment when the only refunded
 * card lines still short of their card money are the membership's (its card refund is what never went); in every
 * other case the order's own payment, as before. Money owed is one figure on the order, so when lines of both
 * payments are short the order's payment is used and what it can't take goes to store credit, as it always has.
 *
 * W47 (the W35 audit's row 19; W30 review L5): an event line with money owed is the order's own payment's too. Its
 * line isn't stamped `card` (the booking still has places), so it was not counted, and an event's owed card money on
 * an order whose membership line was short went to the membership's payment. W47 (F3): the figures read answers the
 * same choice (`owedCard`), so the screen shows the payment and the split the press will use.
 *
 * W47a (W47 review S1): only while that event line's money is still owed (EVENT_LINE_OWED_SQL). Once it has been
 * given or has arrived, a membership refund that later ends owed goes back to the membership's own payment again.
 */
const OWED_SHORT_SQL = `
SELECT COALESCE(SUM(s.short) FILTER (WHERE s.item_type = 'membership'), 0)::text AS membership,
       COALESCE(SUM(s.short) FILTER (WHERE s.item_type <> 'membership'), 0)::text AS others,
       COALESCE(bool_or(s.event_owed), false) AS event_owed
FROM (SELECT oli.item_type,
             CASE WHEN oli.refunded_at IS NOT NULL AND oli.refund_method = 'card'
                  THEN GREATEST(oli.line_total - COALESCE(oli.discount_amount, 0) - oli.card_refunded_amount, 0) ELSE 0 END AS short,
             ${EVENT_LINE_OWED_SQL} AS event_owed
      FROM order_line_items oli WHERE oli.order_id = $1::uuid) s`

async function owedPayment(db: Queryable, orderId: string): Promise<{ card: CardLeft; membershipLines: boolean | null } | null> {
  const cards = await orderCardLeft(db, orderId)
  if (!cards) return null
  if (!cards.membership) return { card: cards.order, membershipLines: null }
  const short = (await db.query<{ membership: string; others: string; event_owed: boolean | null }>(OWED_SHORT_SQL, [orderId]))[0]
  const membership = amountOf(short?.membership) > 0.005 && !(amountOf(short?.others) > 0.005) && short?.event_owed !== true
  return membership ? { card: cards.membership, membershipLines: true } : { card: cards.order, membershipLines: false }
}

/**
 * R2, inside a transaction the caller opened: the order locked (and its customer), then, unless the claim is finished
 * already (null): the card part that went added to its lines' card_refunded_amount; the plan's store credit given as
 * one store credit refund linked to the order; card money that never went, or that Stripe refused, left on the order
 * as owed (Q39: never as store credit instead); the order's status worked out again; the action's own row and the
 * claim's finished row. Throws on any failure, so the caller's transaction keeps nothing.
 */
export async function finishOrderClaimInTransaction(tx: Tx, claim: OrderClaim, outcome: OrderClaimOutcome, by: OrderFinishedBy): Promise<OrderClaimFinished | null> {
  const locks = await lockForRefund(tx, { orderId: claim.orderId })
  if (!locks) throw new Error(`The order of refund claim ${claim.id} no longer exists.`)
  if (await stepEClaimFinished(tx, claim)) return null
  const { details } = claim
  const { plan } = details

  for (const part of outcome.went) {
    for (const line of part.lines) {
      await tx.query('UPDATE order_line_items SET card_refunded_amount = card_refunded_amount + $1::numeric WHERE id = $2::uuid', [line.amount, line.lineId])
    }
  }
  const cardRefunded = sum(outcome.went.map((part) => part.amount))
  const owed = round2(outcome.owed)
  const storeCredit = round2(plan.storeCredit)
  const cash = round2(plan.cash)

  let balance: number | undefined
  if (storeCredit > 0) {
    const notes = details.kind === 'refund' ? ORDER_REFUND_NOTES : ORDER_OWED_NOTES
    // The old function's note said "the card part went back to the card" whenever a card part was planned; it is said
    // here only when it did (a card part left owed hasn't gone back).
    const note = `${cardRefunded > 0 ? notes.storeCreditAfterCard : notes.storeCredit} [ref ${crypto.randomUUID()}]`
    const applied = (
      await tx.query<{ result: { ok?: boolean; reason?: string; balance?: number | string } | null }>(
        'SELECT public.store_credit_apply($1::uuid, $2::numeric, $3::text, $4::uuid, NULL::uuid, $5::uuid, $6::text, NULL::uuid) AS result',
        [locks.customerId, storeCredit, 'refund', claim.orderId, claim.staffId, note]
      )
    )[0]?.result
    if (applied?.ok !== true) throw new Error(`The store credit refund was refused: ${applied?.reason ?? 'no answer'}.`)
    balance = applied.balance !== undefined && applied.balance !== null ? Number(applied.balance) : undefined
  }
  const owedNow = owed > 0 ? await raiseMoneyOwed(tx, claim.orderId, owed) : round2(amountOf((await tx.query<{ owed: string }>('SELECT refund_owed_amount::text AS owed FROM orders WHERE id = $1::uuid', [claim.orderId]))[0]?.owed))
  const status = await recordOrderPaymentStatus(tx, claim.orderId)

  const actor = { actorType: 'staff' as const, actorId: claim.staffId, entityType: 'order', entityId: claim.orderId, requestId: by.requestId }
  const finishedBy = by.how === 'press' ? {} : { by: { how: by.how, type: by.actor.type, id: by.actor.id, ...(by.why ? { why: by.why } : {}) } }
  const money = { cardRefunded, storeCreditRefunded: storeCredit, owed, ...(cash > 0 ? { cashRefunded: cash, handedOverBy: details.handedOverBy ?? null } : {}) }
  const entries: AuditEntry[] = [
    details.kind === 'refund'
      ? {
          ...actor,
          action: ORDER_REFUNDED,
          details: {
            lineItemIds: (details.lines ?? []).map((line) => line.id),
            restocked: (details.lines ?? []).filter((line) => line.restocked === true).map((line) => line.id),
            amount: details.amount,
            method: details.method,
            ...money,
          },
        }
      : { ...actor, action: ORDER_OWED_REFUNDED, details: { amount: details.amount, method: details.method, ...money } },
    {
      ...actor,
      action: ORDER_CLAIMS.finished,
      details: {
        claimId: claim.id,
        outcome: owed > 0 ? 'owed' : 'given',
        cardRefunded,
        storeCreditRefunded: storeCredit,
        owed,
        ...(cash > 0 ? { cash } : {}),
        ...(outcome.refused !== undefined ? { refused: outcome.refused } : {}),
        ...refundsForRow(outcome.went, outcome.refunds),
        ...finishedBy,
      },
    },
    // W32: a refund that hadn't succeeded yet is watched from the same transaction that records it as gone.
    ...claimWatchEntries({ id: claim.id, on: 'order', subjectId: claim.orderId, livemode: details.livemode }, outcome.went, outcome.refunds, { actor: by.actor, requestId: by.requestId }),
  ]
  // W29: each refunded membership's subscription is recorded as still to cancel here, with the money, before Stripe
  // is asked (refund-subscription.ts). Its row first: recordAll stamps rows a millisecond apart in the order given,
  // and the `cancelled` row that closes it (stamped from a later clock reading, plus one) must never sort before it.
  await audit.recordAll(tx, [...subscriptionsLeftByRefund(claim, { actor: by.actor, requestId: by.requestId }), ...entries])
  return {
    kind: details.kind,
    amount: details.amount,
    method: details.method,
    cardRefunded,
    storeCreditRefunded: storeCredit,
    cashRefunded: cash,
    ...(balance !== undefined ? { storeCreditBalance: balance } : {}),
    ...(status ? { orderPaymentStatus: status } : {}),
    refundOwed: owedNow,
    ...(outcome.warning ? { warning: outcome.warning } : {}),
  }
}

/** R2 in a transaction of its own, run once more after a deadlock (it is safe twice: the finished row is checked). */
export async function finishOrderClaim(db: Db, claim: OrderClaim, outcome: OrderClaimOutcome, by: OrderFinishedBy): Promise<OrderClaimFinished | null> {
  try {
    return await db.transaction((tx) => finishOrderClaimInTransaction(tx, claim, outcome, by))
  } catch (err) {
    if (!isDeadlock(err)) throw err
    return db.transaction((tx) => finishOrderClaimInTransaction(tx, claim, outcome, by))
  }
}

// --- The undo (the card part was refused, so nothing went)

/**
 * The undo can't put the order back because what R1 gave back has been taken since: a restocked item has been sold.
 * Thrown inside the undo's transaction, so nothing of the undo is kept: the refund stands, and the press finishes the
 * claim there and then with the card money owed on the order (E-plan 4.3, as step D's PutBackBlocked).
 */
export class OrderPutBackBlocked extends Error {
  constructor(what: string) {
    super(`The undo can't put the order back: ${what}.`)
    this.name = 'OrderPutBackBlocked'
  }
}

/**
 * R1 undone in one transaction: each line unstamped, its gift card made valid again, its pass given its sessions back,
 * its restock taken out of stock again with its stock adjustment's row, its membership (W29) as it was with the
 * bookings R1 flagged confirmed again. Its subscription was never touched: the cancel only follows a refund that
 * stands. Refund the rest's money is owed again. False when the claim was finished already.
 */
async function undoOrderClaimOnce(db: Db, claim: OrderClaim, by: OrderFinishedBy): Promise<boolean> {
  return db.transaction(async (tx) => {
    const lines = claim.details.lines ?? []
    const present = <T>(values: Array<T | undefined>): T[] => values.filter((value): value is T => value !== undefined)
    const locks = await lockForRefund(tx, {
      orderId: claim.orderId,
      sessionPassIds: present(lines.map((line) => line.pass?.id)),
      membershipIds: present(lines.map((line) => line.membership?.id)),
      productVariantIds: present(lines.map((line) => line.restock?.variantId)),
      giftCardIds: present(lines.map((line) => line.giftCardId)),
    })
    if (!locks) throw new Error(`The order of refund claim ${claim.id} no longer exists.`)
    if (await stepEClaimFinished(tx, claim)) return false
    const { kind, amount } = claim.details
    if (kind === 'refund') {
      for (const line of lines) {
        if (line.restock) {
          // Only while the stock is still there: an item sold since can't be taken out of stock again.
          const taken = await tx.query('UPDATE product_variants SET stock_quantity = stock_quantity - $1::int, updated_at = now() WHERE id = $2::uuid AND stock_quantity >= $1::int RETURNING id', [
            line.restock.quantity,
            line.restock.variantId,
          ])
          if (taken.length !== 1) throw new OrderPutBackBlocked(`the ${line.restock.quantity} put back in stock for line ${line.id} have been sold since`)
          await tx.query('DELETE FROM stock_adjustments WHERE id = $1::uuid', [line.restock.adjustmentId])
        }
        if (line.pass) await tx.query('UPDATE customer_session_passes SET sessions_remaining = $1::int, updated_at = now() WHERE id = $2::uuid', [line.pass.sessionsRemaining, line.pass.id])
        if (line.giftCardId) await tx.query('UPDATE gift_cards SET voided = false, updated_at = now() WHERE id = $1::uuid', [line.giftCardId])
        if (line.membership) {
          // W29: the membership as it was, and the bookings R1 flagged confirmed again. Only those still as R1 left
          // them: one paid for, cancelled or lapsed in the seconds since is someone else's change, and stays.
          await tx.query('UPDATE customer_memberships SET subscription_status = $1::text, addon_credits_remaining = $2::int, cancel_effective_date = $3::date, updated_at = now() WHERE id = $4::uuid', [
            line.membership.status,
            line.membership.addonCredits,
            line.membership.cancelEffectiveDate,
            line.membership.id,
          ])
          if (line.membership.flaggedBookingIds.length > 0) {
            await tx.query(
              `UPDATE bookings SET status = 'confirmed', payment_due_by = NULL, updated_at = now()
               WHERE id = ANY($1::uuid[]) AND status = 'payment_needed' AND redeemed_membership_id = $2::uuid AND redemption_source = 'membership_credit'`,
              [line.membership.flaggedBookingIds, line.membership.id]
            )
          }
        }
        // A line that had card money back on an earlier try keeps that money on it; only this claim's stamp goes.
        await tx.query('UPDATE order_line_items SET refunded_at = NULL, refund_method = NULL, restocked = NULL WHERE id = $1::uuid', [line.id])
      }
    } else {
      await raiseMoneyOwed(tx, claim.orderId, amount)
    }
    await audit.recordAll(tx, [
      {
        actorType: 'staff',
        actorId: claim.staffId,
        action: ORDER_CLAIMS.finished,
        entityType: 'order',
        entityId: claim.orderId,
        requestId: by.requestId,
        details: { claimId: claim.id, outcome: kind === 'refund_owed' ? 'owed' : 'put_back', cardRefunded: 0, storeCreditRefunded: 0, owed: kind === 'refund_owed' ? amount : 0 },
      },
    ])
    return true
  })
}

/**
 * The undo, run once more after a deadlock, as finishOrderClaim is (W29a, W29 review L1). It locks the order, the
 * customer and the membership and then writes the membership's credit bookings, while a booking action locks its
 * booking and then the customer, so Postgres can end the undo to break the two apart. Nothing of the ended try is
 * kept and nothing outside the database is called, so it is safe twice (the finished row is checked). Without this, a
 * refusal Stripe gave would end as "refused, not put back": the refund standing, the money owed and the subscription
 * cancelled, though nothing went.
 */
async function undoOrderClaim(db: Db, claim: OrderClaim, by: OrderFinishedBy): Promise<boolean> {
  try {
    return await undoOrderClaimOnce(db, claim, by)
  } catch (err) {
    if (!isDeadlock(err)) throw err
    return undoOrderClaimOnce(db, claim, by)
  }
}

// --- The press: the card part once, then R2

type FirstRefused = (detail: string) => ApiError

/**
 * The card part was refused and the undo didn't put the order back (blocked, or failed for any reason), so the refund
 * stands. The claim is finished now with nothing gone and the card money owed on the order, Stripe's reason kept: a
 * person uses Refund the rest (W28a: after a refusal Stripe gave there is nothing to check in Stripe; W30a: nor after
 * a refund the press had no time to send). R2 gives the plan's store credit all the same, and the words name it
 * (W30a). The answer is `held`, with those words. If the
 * finish fails too, the claim stays open with the refusal's mark, and reconcile finishes it the same way. Null when
 * the claim was finished already (the undo's COMMIT went through and only its answer was lost).
 */
async function finishRefusedNotPutBack(db: Db, claim: OrderClaim, options: OrderRefundOptions, detail: string, blocked: boolean): Promise<{ finished: OrderClaimFinished | null; held: { claimId: string; reason: string; message: string } } | null> {
  const owed = sum(claim.details.plan.card.map((part) => part.amount))
  const reason = 'refund_refused_not_put_back'
  try {
    const finished = await finishOrderClaim(db, claim, { went: [], owed, refused: detail }, { actor: options.actor, requestId: options.requestId, how: blocked ? 'undo_blocked' : 'undo_failed', why: detail })
    if (!finished) return null
    return { finished, held: { claimId: claim.id, reason, message: blocked ? NEW_WORDS.putBackBlocked(detail, owed, finished.storeCreditRefunded) : NEW_WORDS.putBackFailed(detail, owed, finished.storeCreditRefunded) } }
  } catch {
    return { finished: null, held: { claimId: claim.id, reason, message: blocked ? NEW_WORDS.putBackBlockedNotRecorded(detail) : NEW_WORDS.putBackFailedNotRecorded(detail) } }
  }
}

/** What the press ended with: R2's result, or a claim held for reconcile (with whatever is already known). */
type Pressed = { finished: OrderClaimFinished; held?: { claimId: string; reason: string; message: string } } | { finished: null; held: { claimId: string; reason: string; message: string }; cardGone: number }

/**
 * After R1 has committed a claim with its card part: the part once, then R2. A refusal is marked on the claim first
 * (`order.refund_refused`), then R1 is undone and the refusal thrown with the action's words; an undo that doesn't put
 * the order back ends as money owed (finishRefusedNotPutBack). No clear answer holds the claim for reconcile, as does
 * R2 failing after the money went (what went is never sent again: reconcile records it).
 */
async function sendAndFinish(db: Db, stripe: StripeClient, claim: OrderClaim, options: OrderRefundOptions, timing: StripeTiming, firstRefused: FirstRefused): Promise<Pressed> {
  const by: OrderFinishedBy = { actor: options.actor, requestId: options.requestId, how: 'press' }
  const part = claim.details.plan.card[0]
  if (!part) throw new Error(`Refund claim ${claim.id} has no card part to send.`)
  const held = (reason: string, message: string, cardGone = 0): Pressed => ({ finished: null, held: heldAnswer(claim.id, reason, message, cardGone).held, cardGone })
  const answer = await sendCardPart(stripe, claim.id, part, timing)
  if (answer.outcome === 'unclear') return held('refund_unconfirmed', NEW_WORDS.unconfirmed)
  if (answer.outcome !== 'went') {
    // Stripe's refusal is on the claim before the undo is tried, so reconcile never reads it as "not found".
    if (answer.outcome === 'refused') await markStepEClaimRefused(db, claim, answer.detail, options.requestId)
    const detail = answer.outcome === 'not_sent' ? NEW_WORDS.notSentDetail : answer.detail
    try {
      await undoOrderClaim(db, claim, by)
    } catch (err) {
      const ended = await finishRefusedNotPutBack(db, claim, options, detail, err instanceof OrderPutBackBlocked)
      if (ended?.finished) return { finished: ended.finished, held: ended.held }
      if (ended) return { finished: null, held: ended.held, cardGone: 0 }
    }
    throw firstRefused(detail)
  }
  try {
    const finished = await finishOrderClaim(db, claim, { went: [part], refunds: [refundSeen(part, answer.refund)], owed: 0 }, by)
    // Finished by someone else (a close): what went is theirs to report.
    return finished ? { finished } : held('refund_finished_elsewhere', NEW_WORDS.goneNotRecorded(part.amount), part.amount)
  } catch {
    return held('refund_not_recorded', NEW_WORDS.goneNotRecorded(part.amount), part.amount)
  }
}

/**
 * R1 in its transaction (once more after a deadlock, plain words for a database fault), then the card part.
 * `needsStripe`: a card refund, or (W29) a membership line, whose subscription is cancelled last. `settled` (W29) runs
 * once the claim has finished with its refund standing (R1's own finish, R2, or a refusal that couldn't be put back):
 * never after an undo, and never while the claim is held.
 */
async function run<Output>(
  db: Db,
  needsStripe: boolean,
  options: OrderRefundOptions,
  action: Action,
  r1: (tx: Tx, livemode: boolean | null) => Promise<Started<Output>>,
  firstRefused: FirstRefused,
  answer: (pressed: Pressed, claim: OrderClaim) => Output,
  settled?: (output: Output, claim: OrderClaim, stripe: StripeClient, timing: StripeTiming) => Promise<Output>
): Promise<Output> {
  // A card refund needs Stripe, and so does a membership's cancel: the client is made before R1, so a missing key
  // fails with nothing written.
  const stripe = needsStripe && options.stripe ? options.stripe() : null
  const timing = stripeTiming(options.startedAt ?? Date.now(), options.now ?? Date.now)
  // A COMMIT with no answer (INTERNAL) may have saved a claim whose card part was never sent: reconcile finds it,
  // finds nothing in Stripe, and the money ends as owed on the order (Refund the rest).
  const started = await inC1(db, (tx) => r1(tx, stripe?.keyLivemode ?? null), notSaved(action))
  if (started.kind === 'done') {
    // W29: with no Stripe client the subscription's record stays `left`, and reconcile cancels it.
    return settled && started.claim && stripe ? settled(started.output, started.claim, stripe, timing) : started.output
  }
  if (!stripe) throw new Error('A card refund was planned with no Stripe client.')
  const pressed = await sendAndFinish(db, stripe, started.claim, options, timing, firstRefused)
  const output = answer(pressed, started.claim)
  return settled && pressed.finished ? settled(output, started.claim, stripe, timing) : output
}

// --- The three actions

/**
 * POST /orders/:id/refunds (refundOrder): the chosen lines refunded as one refund, to the card (capped at the order's
 * card money left, the rest to store credit), to store credit, or (Q42) in cash up to the cash paid (the rest to store
 * credit). A refusal before anything moved is an ApiError with the old reason and words; a held claim answers as data.
 */
export async function refundOrderLines(db: Db, orderId: string, input: RefundOrderInput, options: OrderRefundOptions): Promise<RefundOrderOutput> {
  // The old function's first two checks, before anything is read.
  const lineIds = input.lineItemIds
  if (!orderId || !Array.isArray(lineIds) || lineIds.length === 0) throw orderRefundRefusal('VALIDATION', 'invalid_params', WORDS.orderAndLinesRequired)
  const method = input.refundMethod
  if (method !== 'card' && method !== 'credit' && method !== 'cash') throw orderRefundRefusal('VALIDATION', 'invalid_params', WORDS.methodInvalid)
  const targets = await lockTargets(db, orderId, lineIds.filter((id) => UUID.test(id)))
  return run<RefundOrderOutput>(
    db,
    method === 'card' || targets.membership,
    options,
    'refund',
    (tx, livemode) => refundR1(tx, orderId, input, options, livemode, targets),
    // The old function answered Stripe's refusal with the legacy route's words alone ("Failed to refund payment: …").
    // A refund the press had no time left to send was never refused by anyone: plain words for that.
    (detail) => orderRefundRefusal('PAYMENT_FAILED', 'refund_failed', detail === NEW_WORDS.notSentDetail ? NEW_WORDS.notSentInTime : detail || WORDS.refundFailedFallback),
    (pressed, claim) => {
      if (pressed.finished) return { ...refundOutput(pressed.finished, claim), ...(pressed.held ? { held: pressed.held } : {}) }
      return { refundedAmount: pressed.cardGone, refundMethod: claim.details.method, ...(pressed.cardGone > 0 ? { cardRefundedAmount: pressed.cardGone } : {}), held: pressed.held }
    },
    // W29 (E-plan 4.3; E10): the money is settled and the refund stands, so each refunded membership's subscription
    // is cancelled now, last. One that can't be confirmed cancelled stays recorded as left (R2 wrote it), is listed,
    // and reconcile tries again: the answer says so, and the refund is still a success.
    async (output, claim, stripe, timing) => {
      if (refundedSubscriptions(claim).length === 0) return output
      const cancels = await cancelSubscriptionsAfterRefund(db, stripe, claim, { actor: options.actor, requestId: options.requestId }, timing)
      const warning = cancelLeftWarning(cancels)
      if (!warning) return output
      return {
        ...output,
        warning: [output.warning, warning].filter((words): words is string => Boolean(words)).join(' '),
        subscriptionCancelLeft: cancels.filter((cancel) => !cancel.cancelled).map((cancel) => cancel.subscriptionId),
      }
    }
  )
}

/** What Refund the rest and It already arrived both start with, under the order's lock. */
async function lockOwed(tx: Tx, orderId: string, amount: unknown, action: Action): Promise<{ order: OrderRow; owed: number; amount: number; figures: () => Promise<OrderRefundFigures> }> {
  const order = await lockOrder(tx, orderId, action)
  const figures = async (): Promise<OrderRefundFigures> => figuresFrom(tx, order, await tx.query<LineRow>(ORDER_LINES_SQL, [orderId]))
  if (typeof amount !== 'number' || !Number.isFinite(amount) || !(round2(amount) > 0)) throw orderRefundRefusal('VALIDATION', 'amount_not_positive', NEW_WORDS.amountNotPositive, action, { field: 'amount' })
  const owed = round2(amountOf(order.refund_owed_amount))
  if (!(owed > 0)) throw orderRefundRefusal('CONFLICT', 'nothing_owed', NEW_WORDS.nothingOwed, action, { figures: await figures() })
  return { order, owed, amount, figures }
}

async function owedR1(tx: Tx, orderId: string, input: OrderRefundOwedInput, options: OrderRefundOptions, livemode: boolean | null): Promise<Started<OrderOwedOutput>> {
  const method = input.refundMethod as StepEClaimMethod
  const { owed, amount, figures } = await lockOwed(tx, orderId, input.amount, 'refund_owed')
  // My call (brief W28 item 3): exactly what is owed, as on a booking. Staff confirmed that figure, and one claim
  // clears it; part of it reaching the customer some other way is It already arrived's job (any amount).
  if (overHalfPenny(amount, owed) || overHalfPenny(owed, amount)) throw orderRefundRefusal('CONFLICT', 'owed_changed', NEW_WORDS.owedChanged(owed), 'refund_owed', { figures: await figures() })
  const owedOn = method === 'card' ? await owedPayment(tx, orderId) : null
  const card = owedOn?.card ?? null
  const cashLeft = method === 'cash' ? await orderCashLeft(tx, orderId) : 0
  // Q42's cap: cash only for cash paid on the order and not yet handed back. Owed money is never split into cash and
  // store credit: over the cap it is refused, and staff choose store credit.
  if (method === 'cash' && overHalfPenny(owed, cashLeft)) {
    throw orderRefundRefusal('CONFLICT', cashLeft > 0 ? 'more_than_cash_left' : 'no_cash_left', cashLeft > 0 ? NEW_WORDS.onlyCashLeft(cashLeft) : NEW_WORDS.noCashLeft, 'refund_owed', { figures: await figures() })
  }
  const cardAmount = card?.paymentIntentId ? round2(Math.min(owed, card.left)) : 0
  const parts: CardPart[] =
    cardAmount > 0 && card?.paymentIntentId ? [{ orderId, paymentIntentId: card.paymentIntentId, amount: cardAmount, lines: await owedCardLines(tx, orderId, cardAmount, owedOn?.membershipLines ?? null) }] : []
  const cash = method === 'cash' ? owed : 0
  const storeCredit = round2(owed - cardAmount - cash)
  const plan: StepEPlan = { card: parts, storeCredit: storeCredit > 0.005 ? storeCredit : 0, cash, ownOrderId: orderId }
  const lowered = await lowerMoneyOwed(tx, orderId, owed)
  if (!lowered.ok) throw new Error(`The money owed on order ${orderId} changed under its lock.`)
  const claim = await writeOrderClaim(
    tx,
    orderId,
    { kind: 'refund_owed', amount: owed, method, reason: null, worker: true, plan, livemode: parts.length > 0 ? livemode : null, ...(cash > 0 ? { handedOverBy: options.actor.id } : {}) },
    options
  )
  if (parts.length > 0) return { kind: 'card', claim }
  const finished = await finishOrderClaimInTransaction(tx, claim, { went: [], owed: 0 }, { actor: options.actor, requestId: options.requestId, how: 'press' })
  if (!finished) throw new Error(`Refund claim ${claim.id} was finished in its own transaction.`)
  return { kind: 'done', output: owedOutput(finished) }
}

/**
 * POST /orders/:id/refunds/owed (Refund the rest on an order, Q39): gives exactly what is owed, to the card as a new
 * claim (what the card can't take goes to store credit), to store credit, or in cash within Q42's cap.
 */
export async function refundOrderOwed(db: Db, orderId: string, input: OrderRefundOwedInput, options: OrderRefundOptions): Promise<OrderOwedOutput> {
  const method = input.refundMethod
  if (method !== 'card' && method !== 'credit' && method !== 'cash') throw orderRefundRefusal('VALIDATION', 'invalid_params', NEW_WORDS.owedMethodInvalid, 'refund_owed', { field: 'refundMethod' })
  return run<OrderOwedOutput>(
    db,
    method === 'card',
    options,
    'refund_owed',
    (tx, livemode) => owedR1(tx, orderId, input, options, livemode),
    (detail) => orderRefundRefusal('PAYMENT_FAILED', 'refund_failed', detail === NEW_WORDS.notSentDetail ? NEW_WORDS.notSentInTime : NEW_WORDS.owedCardRefundFailed(detail), 'refund_owed'),
    (pressed) => {
      if (pressed.finished) return { ...owedOutput(pressed.finished), ...(pressed.held ? { held: pressed.held } : {}) }
      return { cardRefundedAmount: pressed.cardGone, storeCreditRefundedAmount: 0, refundOwed: 0, held: pressed.held }
    }
  )
}

/**
 * POST /orders/:id/refunds/owed-arrived (It already arrived on an order, Q39): what is owed reached the customer after
 * all, so it comes off the order with no money moving. Any amount up to what is owed (the W26 audit's row 31), with a
 * reason. One transaction with its `order.owed_arrived` row, as nothing else records it.
 */
export async function orderOwedArrived(db: Db, orderId: string, input: OrderOwedArrivedInput, options: Pick<OrderRefundOptions, 'actor' | 'requestId'>): Promise<OrderOwedOutput> {
  return inC1(
    db,
    async (tx) => {
      const { owed, amount, figures } = await lockOwed(tx, orderId, input.amount, 'owed_arrived')
      const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
      if (!reason) throw orderRefundRefusal('VALIDATION', 'reason_required', NEW_WORDS.reasonRequired, 'owed_arrived', { field: 'reason' })
      if (reason.length > ORDER_REASON_MAX_LENGTH) throw orderRefundRefusal('VALIDATION', 'reason_too_long', NEW_WORDS.reasonTooLong(ORDER_REASON_MAX_LENGTH), 'owed_arrived', { field: 'reason' })
      if (overHalfPenny(amount, owed)) throw orderRefundRefusal('CONFLICT', 'more_than_owed', NEW_WORDS.onlyOwed(owed), 'owed_arrived', { figures: await figures() })
      // Within half a penny of all that is owed clears it exactly.
      const take = round2(Math.min(amount, owed))
      // W47 (the W35 audit's row 6; W28 review L4; Wayne, 19 Nov): staff say where they saw the money. On the card
      // (`arrivedOn: 'card'`, the refund is in Stripe): it is recorded on the lines as card money, exactly where
      // Refund the rest to the card would record it (the payment it would use, capped at what that payment can still
      // take; owedCardLines). Until W47 nothing was recorded, so the order's card money left read too high by it, and a
      // later Card refund asked Stripe for money the payment no longer had. What the payment can't account for is on
      // no line (`card` on the row is then less than `amount`). Another way (store credit on their balance, cash), or
      // no choice sent (a staff app from before W47): nothing on the lines and the row as it was. Recording store
      // credit they already have as card money too would count it twice. No money moves here either way.
      const onCard = input.arrivedOn === 'card'
      const owedOn = onCard ? await owedPayment(tx, orderId) : null
      const card = owedOn?.card.paymentIntentId ? round2(Math.min(take, owedOn.card.left)) : 0
      const lines = card > 0 ? await owedCardLines(tx, orderId, card, owedOn?.membershipLines ?? null) : []
      for (const line of lines) {
        await tx.query('UPDATE order_line_items SET card_refunded_amount = card_refunded_amount + $1::numeric WHERE id = $2::uuid', [line.amount, line.lineId])
      }
      const lowered = await lowerMoneyOwed(tx, orderId, take)
      if (!lowered.ok) throw new Error(`The money owed on order ${orderId} changed under its lock.`)
      await audit.recordAll(tx, [
        { actorType: 'staff', actorId: options.actor.id, action: ORDER_OWED_ARRIVED, entityType: 'order', entityId: orderId, requestId: options.requestId, details: { amount: take, reason, owedBefore: owed, owedAfter: lowered.owed, ...(onCard ? { arrivedOn: 'card', card, lines } : {}) } },
      ])
      // W47a (W47 review L2): less than what arrived could be recorded as card money (the payment had less left, or
      // the order has no card payment). The cap stands; the answer now says so, with both figures, so staff who chose
      // the wrong place can see it.
      const other = round2(take - card)
      const short = onCard && other > 0.005 ? { arrivedOnCard: { recorded: card, other }, warning: arrivedCardShortWords('order', card, other) } : {}
      return { cardRefundedAmount: 0, storeCreditRefundedAmount: 0, refundOwed: lowered.owed, ...short }
    },
    notSaved('owed_arrived')
  )
}

// --- For reconcile and the close by hand

export { readOrderClaim }
