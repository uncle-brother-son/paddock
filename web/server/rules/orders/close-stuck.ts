// The manual close (brief W14b item 4; W12 review L2, W12a N2, W13 to W13d, W13c review L4): what a person does
// with an item reconcile has left for them on the Orders page's stuck list. Issue refunds, with a reason (the
// route checks both). It never calls Stripe and never moves money. Per item, only what that item needs:
//
// - `held_order`: a Worker order still pending that reconcile left for a person: `changed_since` (old code
//   changed its booking or event booking after T1), or a membership's `compensation_unfinished` that a person has
//   finished in Stripe by hand. In one transaction, the order locked first: what old code hasn't changed goes back
//   exactly as the undo gives it (stock, a gift card used, store credit, the event places while the event booking
//   is still pending, and anything the order was buying), then the order and its rows go, with an `order.close`
//   row. The booking's places, its pass session and its add-ons are never given back here: old code owns the
//   booking now, and its own cancel gives them back. With nothing changed (a compensation finished by hand), it
//   is the one undo, as the compensation would have ended. Q10 stops counting the order once it is gone.
// - `changed_elsewhere`: a Worker order the old screens moved out of pending (W12a S1): recorded as sorted (an
//   `order.close` row, which the stuck list and reconcile then leave out). Nothing moved.
// - `subscription_left`: a subscription left live for an order (W13a to W13d), once a person has cancelled it and
//   refunded its first payment in Stripe: recorded as sorted (an `order.subscription_left` row, `cancelled`, which
//   closes the warning and stops reconcile's retry). Nothing moved.
// - `late_refund` (W14c, W14b N1): a late payment's automatic refund that Stripe refused (reconcile stops at
//   `failed`), once a person has refunded it in Stripe by hand: its `order.reconcile` refund row written again as
//   `confirmed`, `byHand`, which takes it off the list. Nothing moved.
//
// - `held_flow` (W21, W19 review later 1): a Worker booking-change flow (card or reader) reconcile left for a person:
//   more than one payment, a payment that doesn't match the change, the other Stripe mode, or a payment still
//   processing after a day. W12's undo, in this transaction (the flow's row first, then its booking): everything the
//   change held goes back. A payment Stripe has for it stays where it is and is named on the close row and in the
//   answer, for a person to refund in Stripe (the close never sends money).
// - `held_claim` (W21): a booking refund's claim reconcile left for a person (the other Stripe mode, more than one
//   refund for a part, a refund of another amount): the claim's R2 with no card part counted as gone, so its card money
//   goes back on the booking as owed (the plan's store credit is given as R2 gives it). A person then uses It already
//   arrived if Stripe shows the refund reached the customer, or Refund the rest if not. Nothing is sent to Stripe.
//
// W14c (W14b review S1): a compensation is closed only when its latest held row says every step left is Stripe's
// definite refusal. Anything else reconcile finishes on its own (each step is safe to repeat, and reads a step a
// person did in Stripe as done), so closing it by hand could hide a subscription Stripe is still billing.
//
// Refused, with nothing changed: anything reconcile hasn't left for a person (still waiting for its check, or
// Stripe still dealing with its payment), anything settled in the meantime (paid, undone, gone, no longer
// listed), and an item the old code started. Racing reconcile: the close and reconcile's T2 and undo all lock the
// order first, so whichever is second finds the other's result (reconcile: gone, so nothing to do; the close:
// gone or paid, so refused).
import 'server-only'
import { audit, type AuditEntry } from '@/server/audit'
import type { CloseStuckInput, CloseStuckOutput, StuckCloseKind } from '@/contracts'
import type { Db, Tx } from '@/server/db'
import { CHANGED_ELSEWHERE, CHANGED_ELSEWHERE_DAYS, CHANGED_ELSEWHERE_WHERE, FINAL_FINDINGS, type ChangedElsewhereFinding } from './changed-elsewhere'
import { oldRollbackStarted } from './finalise-order'
import { lockForOrder } from './locks'
import { SUBSCRIPTION_LEFT_ACTION } from './membership'
import { PROCESSING_MINUTES } from './pending-order'
import { compensationDefiniteSql, HELD_ORDER_CLOSE_REASONS, OLD_ROLLBACK_WORDS, SUBSCRIPTIONS_LEFT_SQL } from './stuck-list'
import { changedSince, PARTS_SQL, undoInTransaction, type LockedOrder, type OrderParts } from './undo-order'
import { isWorkerCardFlow, isWorkerFlow, readFlow, undoFlowInTransaction } from './reader-flow'
import { finishClaimInTransaction, readClaim } from '@/server/rules/bookings/refunds'
import { lockForBooking } from '@/server/rules/bookings/locks'
import { CLOSED_ON_A_CANCELLED_BOOKING_WORDS } from '@/server/rules/bookings/failure-messages'
import { flowClosable, HELD_CLAIM_CLOSE_REASONS } from './stuck-list'

export const CLOSE_ACTION = 'order.close'


export interface CloseOptions {
  actor: { type: 'staff' | 'system'; id: string | null }
  requestId: string
}

// --- Words

export const CLOSE_WORDS = {
  held_order: 'Order closed. What it still held has been given back, and the order has been removed.',
  held_order_undone: 'Order closed. Everything it held has been given back, and the order has been removed.',
  changed_elsewhere: 'Marked as sorted. It is no longer listed.',
  subscription_left: 'Marked as sorted. The subscription is no longer listed.',
  late_refund: 'Marked as refunded by hand. It is no longer listed.',
  // W21.
  held_flow: 'Change undone: everything it held has been given back, and it is no longer listed.',
  held_claim: 'Refund closed: its card money is back on the booking as money still to refund, and it is no longer listed.',
  flow_settled: 'This change has been settled in the meantime (finished or undone). Nothing was changed.',
  flow_gone: 'This change no longer exists. Nothing was changed.',
  old_flow: "This change was started on the old screens, so the close can't act on it. Press Resolve now to settle it.",
  flow_not_left_for_a_person:
    "The automatic check hasn't left this change for a person: it may still be settling it, or the bank may still be dealing with its payment. Nothing was changed. Wait for the next check (every 5 minutes) and look again.",
  claim_not_left_for_a_person:
    "The automatic check hasn't left this refund for a person: it may still be looking for it in Stripe. Nothing was changed. Wait for the next check (every 5 minutes) and look again.",
  already: 'This was already closed (an earlier press went through). Nothing more was done.',
  gone: 'This order no longer exists: it was settled in the meantime. Nothing was changed.',
  settled: 'This order has been settled in the meantime (it is no longer waiting for payment). Nothing was changed.',
  old_order: 'This order was started on the old screens, so the close can\'t act on it. Press Resolve now to settle it.',
  old_rollback: OLD_ROLLBACK_WORDS,
  not_left_for_a_person:
    "The automatic check hasn't left this order for a person: it may still be settling it, or Stripe may still be dealing with its payment. Nothing was changed. Wait for the next check (every 5 minutes) and look again.",
  bought_in_use:
    'Something this order was buying (a pass, membership or gift card) has been used since, so the close can\'t remove it. Nothing was changed. Tell a manager.',
  not_listed: 'This is no longer on the list (it was sorted in the meantime). Nothing was changed.',
  still_checking:
    "The automatic check hasn't finished looking in Stripe for this order's payment, or the payment is still open in Stripe. Nothing was changed. Wait for its answer on the list before marking it sorted.",
  order_pending:
    'This membership order is still being settled, and the automatic check puts its subscription back with it. Nothing was changed. Wait for the next check.',
  // W14c (W14b review S1): answered as `still_checking`.
  compensation_still_checking: 'The automatic check is still finishing this in Stripe. Check again in a few minutes.',
  // W14c (W14b N1).
  refund_not_failed:
    "This refund hasn't failed: the automatic check is still sending it or waiting for Stripe to confirm it. Nothing was changed. Don't refund it by hand.",
} as const

const money = (amount: number): string => `£${amount.toFixed(2)}`
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

function answer(kind: StuckCloseKind, orderId: string, fields: Omit<CloseStuckOutput, 'kind' | 'orderId'>): CloseStuckOutput {
  return { kind, orderId, ...fields }
}
/** `words`: when the reason's own words aren't the ones to show (W14c: a compensation's `still_checking`). */
const refused = (kind: StuckCloseKind, orderId: string, reason: keyof typeof CLOSE_WORDS, words: keyof typeof CLOSE_WORDS = reason): CloseStuckOutput =>
  answer(kind, orderId, { closed: false, reason, message: CLOSE_WORDS[words] })
const alreadyClosed = (kind: StuckCloseKind, orderId: string): CloseStuckOutput =>
  answer(kind, orderId, { closed: true, alreadyClosed: true, message: CLOSE_WORDS.already })

function closeEntry(options: CloseOptions, orderId: string, details: Record<string, unknown>): AuditEntry {
  return { actorType: options.actor.type, actorId: options.actor.id, action: CLOSE_ACTION, entityType: 'order', entityId: orderId, requestId: options.requestId, details }
}

/**
 * An earlier close of this kind for this order (and subscription): an answer lost, then a new press. W21: a flow's
 * close is written against its `reader_payment`, a claim's against its `refund_claim`.
 */
async function closedBefore(tx: Tx, kind: StuckCloseKind, orderId: string, subscriptionId?: string, entityType = 'order'): Promise<boolean> {
  const rows = await tx.query(
    `SELECT 1 FROM audit_log WHERE action = $1 AND entity_type = $5 AND entity_id = $2 AND details->>'kind' = $3
       AND ($4::text IS NULL OR details->>'subscriptionId' = $4::text) LIMIT 1`,
    [CLOSE_ACTION, orderId, kind, subscriptionId ?? null, entityType]
  )
  return rows.length > 0
}

/** Reconcile's latest row for the order (W21: or flow, or claim) that isn't a late refund's: what it last found. */
async function lastReconcile(
  tx: Tx,
  orderId: string,
  entityType = 'order'
): Promise<{ outcome?: string; reason?: string; detail?: string | null; finding?: ChangedElsewhereFinding } | null> {
  const row = (
    await tx.query<{ details: { outcome?: string; reason?: string; detail?: string | null; finding?: ChangedElsewhereFinding } }>(
      `SELECT details FROM audit_log WHERE entity_type = $2 AND entity_id = $1 AND action = 'order.reconcile' AND NOT (details ? 'refund')
       ORDER BY at DESC, id DESC LIMIT 1`,
      [orderId, entityType]
    )
  )[0]
  return row?.details ?? null
}

// --- held_order

/** The latest held compensation's row (what it cancelled, refunded, and had left), for the closing `order.compensate`. */
async function heldCompensation(tx: Tx, orderId: string): Promise<Record<string, unknown> | null> {
  const row = (
    await tx.query<{ details: Record<string, unknown> }>(
      `SELECT details FROM audit_log WHERE entity_type = 'order' AND entity_id = $1 AND action = 'order.compensate' ORDER BY at DESC, id DESC LIMIT 1`,
      [orderId]
    )
  )[0]
  return row?.details ?? null
}

/** W14c (S1): the latest held compensation row says Stripe refused every step left for good (`$1` the order). */
const COMPENSATION_DEFINITE_ONE_SQL = `SELECT ${compensationDefiniteSql('$1::text')} AS definite`

/** Gives back what old code hasn't changed and removes the order, in one statement (see the header). */
const CLOSE_SQL = `
WITH stock AS (
  UPDATE product_variants v SET stock_quantity = v.stock_quantity + x.quantity, updated_at = now()
  FROM jsonb_to_recordset($2::jsonb) AS x(variant_id uuid, quantity int)
  WHERE v.id = x.variant_id
  RETURNING v.id
),
places AS (
  UPDATE events e SET places_booked = e.places_booked - $4::int, updated_at = now()
  WHERE e.id = $3::uuid
  RETURNING e.id
),
credit AS (
  UPDATE customers c SET store_credit_balance = c.store_credit_balance + $6::numeric, updated_at = now()
  WHERE c.id = $5::uuid AND $6::numeric > 0
  RETURNING c.id
),
card AS (
  UPDATE gift_cards g
  SET remaining_balance = g.remaining_balance + r.amount_used,
      redeemed_at = CASE WHEN g.redeemed_at >= r.redeemed_at THEN NULL ELSE g.redeemed_at END,
      updated_at = now()
  FROM gift_card_redemptions r
  WHERE r.order_id = $1::uuid AND g.id = r.gift_card_id
  RETURNING g.id
),
addon_lines AS (UPDATE addon_order_lines SET order_id = NULL WHERE order_id = $1::uuid RETURNING id),
ledger AS (DELETE FROM stock_adjustments WHERE reason = 'Sale (Order #' || $1::text || ')' RETURNING id),
card_use AS (DELETE FROM gift_card_redemptions WHERE order_id = $1::uuid RETURNING id),
credit_rows AS (DELETE FROM store_credit_transactions WHERE order_id = $1::uuid AND reason = 'redemption' RETURNING id),
lines AS (DELETE FROM order_line_items WHERE order_id = $1::uuid RETURNING id),
passes AS (DELETE FROM customer_session_passes WHERE id = ANY($7::uuid[]) RETURNING id),
memberships AS (DELETE FROM customer_memberships WHERE id = ANY($8::uuid[]) AND stripe_subscription_id IS NULL RETURNING id),
event_booking AS (DELETE FROM event_bookings WHERE id = $9::uuid RETURNING id),
bought_card AS (DELETE FROM gift_cards WHERE id = $10::uuid RETURNING id),
removed AS (DELETE FROM orders WHERE id = $1::uuid AND payment_status = 'pending' RETURNING id)
SELECT (SELECT count(*)::int FROM removed) AS orders_removed,
       (SELECT count(*)::int FROM stock) AS variants_given_back,
       (SELECT count(*)::int FROM places) AS events_given_back,
       (SELECT count(*)::int FROM credit) AS customers_given_back,
       (SELECT count(*)::int FROM card) AS gift_cards_given_back,
       (SELECT count(*)::int FROM event_booking) AS event_bookings_removed,
       (SELECT count(*)::int FROM bought_card) AS gift_cards_removed,
       (SELECT count(*)::int FROM passes) AS passes_removed,
       (SELECT count(*)::int FROM memberships) AS memberships_removed,
       (SELECT count(*)::int FROM lines) AS lines_removed,
       (SELECT count(*)::int FROM addon_lines) AS addon_lines_kept,
       (SELECT count(*)::int FROM ledger) AS ledger_rows_removed,
       (SELECT count(*)::int FROM card_use) AS gift_card_uses_removed,
       (SELECT count(*)::int FROM credit_rows) AS store_credit_rows_removed`

type Closed = Record<
  | 'orders_removed'
  | 'variants_given_back'
  | 'events_given_back'
  | 'customers_given_back'
  | 'gift_cards_given_back'
  | 'event_bookings_removed'
  | 'gift_cards_removed'
  | 'passes_removed'
  | 'memberships_removed'
  | 'lines_removed'
  | 'addon_lines_kept'
  | 'ledger_rows_removed'
  | 'gift_card_uses_removed'
  | 'store_credit_rows_removed',
  number
>

/** Anything the order was buying that something else uses now: removing it would break that (or fail on a key). */
const IN_USE_SQL = `
SELECT EXISTS (SELECT 1 FROM bookings WHERE redeemed_session_pass_id = ANY($1::uuid[]) OR redeemed_membership_id = ANY($2::uuid[]))
    OR EXISTS (SELECT 1 FROM addon_order_lines WHERE redeemed_membership_id = ANY($2::uuid[]))
    OR EXISTS (SELECT 1 FROM gift_card_redemptions WHERE gift_card_id = $3::uuid AND order_id IS DISTINCT FROM $4::uuid)
    OR EXISTS (SELECT 1 FROM store_credit_transactions WHERE gift_card_id = $3::uuid) AS in_use`

async function closeHeldOrder(db: Db, orderId: string, why: string, options: CloseOptions): Promise<CloseStuckOutput> {
  return db.transaction(async (tx) => {
    // 1. The order first (LOCK_ORDER): T2, the undo and reconcile queue behind it and see what this did.
    const order = (await tx.query<LockedOrder>('SELECT customer_id, payment_status, reader_payment FROM orders WHERE id = $1::uuid FOR UPDATE', [orderId]))[0]
    if (!order) return (await closedBefore(tx, 'held_order', orderId)) ? alreadyClosed('held_order', orderId) : refused('held_order', orderId, 'gone')
    if (order.payment_status !== 'pending') return refused('held_order', orderId, 'settled')
    const snapshot = order.reader_payment
    if (snapshot?.method !== 'card' && snapshot?.method !== 'reader') return refused('held_order', orderId, 'old_order')
    if (oldRollbackStarted(snapshot)) return refused('held_order', orderId, 'old_rollback')

    // 2. Only what reconcile has left for a person: it has read Stripe, and nothing there is still open (it cancelled
    //    the order's intents, or found none) or the compensation's steps are the person's to finish.
    const last = await lastReconcile(tx, orderId)
    if (last?.outcome !== 'left' || !last.reason || !HELD_ORDER_CLOSE_REASONS.has(last.reason)) return refused('held_order', orderId, 'not_left_for_a_person')
    const compensating = 'compensation' in snapshot && snapshot.compensation !== undefined
    // A compensation that never started (a press was starting the subscription when reconcile looked) has no steps
    // for a person to finish: reconcile looks again on its own.
    if (last.reason === 'compensation_unfinished' && !compensating) return refused('held_order', orderId, 'not_left_for_a_person')
    // W14c (S1): only once Stripe has refused every step left for good; reconcile finishes anything else.
    if (last.reason === 'compensation_unfinished') {
      const definite = (await tx.query<{ definite: boolean }>(COMPENSATION_DEFINITE_ONE_SQL, [orderId]))[0]?.definite === true
      if (!definite) return refused('held_order', orderId, 'still_checking', 'compensation_still_checking')
    }
    const held = compensating ? await heldCompensation(tx, orderId) : null
    const byHand = { state: 'done', byHand: true, why, subscriptionId: held?.['subscriptionId'] ?? null, refunded: held?.['refunded'] ?? [], sortedByHand: held?.['left'] ?? [] }

    // 3. What it holds now, and what old code has changed since T1.
    const parts = (await tx.query<OrderParts>(PARTS_SQL, [orderId]))[0] as OrderParts
    const changed = changedSince(snapshot, parts)
    const base = { kind: 'held_order', why, reason: last.reason, changed }

    if (changed.length === 0) {
      // Nothing old code changed: everything goes back, exactly as the undo (the end of a compensation, by hand).
      const undone = await undoInTransaction(tx, orderId, { actor: options.actor, requestId: options.requestId, why: `Closed by hand: ${why}`, ...(compensating ? { compensated: byHand } : {}) })
      if (!undone.undone) return refused('held_order', orderId, undone.reason === 'gone' ? 'gone' : 'settled')
      await audit.recordAll(tx, [closeEntry(options, orderId, { ...base, undone: true })])
      return answer('held_order', orderId, { closed: true, message: CLOSE_WORDS.held_order_undone, givenBack: ['everything the order held (its places, stock, credit and gift card use)'], leftAsFound: [] })
    }

    // 4. Old code changed it: never the booking's places, pass session or add-ons; the rest as the undo gives it.
    const booking = parts.booking
    const event = parts.event
    const eventBack = event !== null && event.status === 'pending'
    const inUse = (await tx.query<{ in_use: boolean }>(IN_USE_SQL, [parts.passes_bought, parts.memberships_bought, parts.gift_card_bought, orderId]))[0]?.in_use
    if (inUse) return refused('held_order', orderId, 'bought_in_use')

    const giftCardAmount = Number(
      (await tx.query<{ n: string }>('SELECT COALESCE(sum(amount_used), 0)::text AS n FROM gift_card_redemptions WHERE order_id = $1::uuid', [orderId]))[0]?.n ?? 0
    )
    await lockForOrder(tx, {
      customerId: order.customer_id,
      promoCode: null,
      sessionId: null,
      creditMembershipId: null,
      sessionPassId: null,
      addonMembershipIds: [],
      productVariantIds: parts.stock.map((line) => line.variant_id),
      eventId: eventBack ? event.event_id : null,
      giftCardId: parts.gift_card_used,
    })
    const done = (
      await tx.query<Closed>(CLOSE_SQL, [
        orderId,
        parts.stock,
        eventBack ? event.event_id : null,
        eventBack ? event.places : 0,
        order.customer_id,
        parts.store_credit,
        parts.passes_bought,
        parts.memberships_bought,
        eventBack ? event.booking_id : null,
        parts.gift_card_bought,
      ])
    )[0] as Closed
    const expect = (what: keyof Closed, count: number) => {
      if (done[what] !== count) throw new Error(`The close did not finish: ${what} ${done[what]} of ${count}.`)
    }
    expect('orders_removed', 1)
    expect('variants_given_back', parts.stock.length)
    expect('events_given_back', eventBack ? 1 : 0)
    expect('event_bookings_removed', eventBack ? 1 : 0)
    expect('customers_given_back', Number(parts.store_credit) > 0 ? 1 : 0)
    expect('gift_cards_given_back', parts.gift_card_used ? 1 : 0)
    expect('gift_cards_removed', parts.gift_card_bought ? 1 : 0)
    expect('passes_removed', parts.passes_bought.length)
    expect('memberships_removed', parts.memberships_bought.length)

    const givenBack: string[] = []
    const items = parts.stock.reduce((sum, line) => sum + line.quantity, 0)
    if (items > 0) givenBack.push(`${plural(items, 'item')} back in stock`)
    if (Number(parts.store_credit) > 0) givenBack.push(`${money(Number(parts.store_credit))} store credit back to the customer`)
    if (parts.gift_card_used && giftCardAmount > 0) givenBack.push(`${money(giftCardAmount)} back on the gift card it used`)
    if (eventBack) givenBack.push(`${plural(event.places, 'event place')} given back`)
    if (parts.gift_card_bought) givenBack.push('the gift card it was buying (never paid for) removed')
    if (parts.passes_bought.length > 0) givenBack.push(`${plural(parts.passes_bought.length, 'pass', 'passes')} it was buying (never paid for) removed`)
    if (parts.memberships_bought.length > 0) givenBack.push('the membership it was buying (never paid for) removed')
    const leftAsFound: string[] = []
    if (booking) leftAsFound.push(`the booking (now ${booking.status}): its places, pass session and add-ons stay as the old screens left them`)
    else if (snapshot.held_booking) leftAsFound.push('the booking: the old screens had already removed it')
    if (event && !eventBack) leftAsFound.push(`the event booking (now ${event.status}): its places stay as the old screens left them`)

    await audit.recordAll(tx, [
      ...(compensating ? [{ ...closeEntry(options, orderId, byHand), action: 'order.compensate' }] : []),
      closeEntry(options, orderId, { ...base, snapshot, parts, removed: done, givenBack, leftAsFound }),
    ])
    return answer('held_order', orderId, { closed: true, message: CLOSE_WORDS.held_order, givenBack, leftAsFound })
  })
}

// --- changed_elsewhere

/** The order, if the stuck list lists it as changed elsewhere (`$1` the window, `$2` the days, `$3` the order). */
const CHANGED_ELSEWHERE_ONE_SQL = `SELECT 1 FROM orders o WHERE ${CHANGED_ELSEWHERE_WHERE} AND o.id = $3::uuid`

async function closeChangedElsewhere(db: Db, orderId: string, why: string, options: CloseOptions): Promise<CloseStuckOutput> {
  return db.transaction(async (tx) => {
    const order = (await tx.query<{ payment_status: string }>('SELECT payment_status FROM orders WHERE id = $1::uuid FOR UPDATE', [orderId]))[0]
    if (!order) return refused('changed_elsewhere', orderId, 'gone')
    if (await closedBefore(tx, 'changed_elsewhere', orderId)) return alreadyClosed('changed_elsewhere', orderId)
    const listed = await tx.query(CHANGED_ELSEWHERE_ONE_SQL, [PROCESSING_MINUTES, CHANGED_ELSEWHERE_DAYS, orderId])
    if (listed.length === 0) return refused('changed_elsewhere', orderId, 'not_listed')
    // What reconcile last found in Stripe: only once nothing there can still be paid (or it is the other mode's,
    // which only a person can check).
    const last = await lastReconcile(tx, orderId)
    const state = last?.reason === CHANGED_ELSEWHERE ? last.finding?.state : undefined
    if (state === undefined || !([...FINAL_FINDINGS, 'other_mode'] as string[]).includes(state)) return refused('changed_elsewhere', orderId, 'still_checking')
    await audit.recordAll(tx, [closeEntry(options, orderId, { kind: 'changed_elsewhere', why, paymentStatus: order.payment_status, finding: last?.finding ?? null })])
    return answer('changed_elsewhere', orderId, { closed: true, message: CLOSE_WORDS.changed_elsewhere })
  })
}

// --- subscription_left

/** The subscription's open warning, if the stuck list shows one (`$1` the order, `$2` the subscription). */
const SUBSCRIPTION_LEFT_ONE_SQL = `SELECT l.invoice_payment_intent_id, l.amount_paid FROM (${SUBSCRIPTIONS_LEFT_SQL}) l WHERE l.entity_id = $1 AND l.subscription_id = $2`

async function closeSubscriptionLeft(db: Db, orderId: string, subscriptionId: string, why: string, options: CloseOptions): Promise<CloseStuckOutput> {
  return db.transaction(async (tx) => {
    // One close of one subscription at a time; reconcile's retry writes its own row and never waits on this.
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1::text))', [`subscription-left:${orderId}:${subscriptionId}`])
    const row = (
      await tx.query<{ invoice_payment_intent_id: string | null; amount_paid: number | null }>(SUBSCRIPTION_LEFT_ONE_SQL, [orderId, subscriptionId])
    )[0]
    if (!row) return (await closedBefore(tx, 'subscription_left', orderId, subscriptionId)) ? alreadyClosed('subscription_left', orderId) : refused('subscription_left', orderId, 'not_listed')
    const pending = await tx.query("SELECT 1 FROM orders WHERE id = $1::uuid AND payment_status = 'pending'", [orderId])
    if (pending.length > 0) return refused('subscription_left', orderId, 'order_pending')
    await audit.recordAll(tx, [
      {
        actorType: options.actor.type,
        actorId: options.actor.id,
        action: SUBSCRIPTION_LEFT_ACTION,
        entityType: 'order',
        entityId: orderId,
        requestId: options.requestId,
        details: { state: 'cancelled', subscriptionId, invoicePaymentIntentId: row.invoice_payment_intent_id, amountPaid: row.amount_paid, found: 'by_hand', refunded: [], byHand: { why } },
      },
      closeEntry(options, orderId, { kind: 'subscription_left', why, subscriptionId }),
    ])
    return answer('subscription_left', orderId, { closed: true, message: CLOSE_WORDS.subscription_left })
  })
}

// --- late_refund (W14c, W14b N1)

/**
 * The late payment (`$2`) on the order or flow (`$1`), as the stuck list's refunds show it: its entity and its
 * refund's latest state (the same order as the list's REFUNDS_SQL), and whether that row was written by hand.
 */
const LATE_REFUND_ONE_SQL = `
SELECT a.entity_type,
       l.details->'refund'->>'state' AS state,
       (l.details->'refund') ? 'byHand' AS by_hand
FROM (
  SELECT DISTINCT entity_type, entity_id FROM audit_log
  WHERE action IN ('order.charge_without_order', 'reader_payment.charge_without_record')
    AND entity_id = $1 AND details->>'paymentIntentId' = $2
) a
LEFT JOIN LATERAL (
  SELECT r.details FROM audit_log r
  WHERE r.action = 'order.reconcile' AND r.entity_type = a.entity_type AND r.entity_id = a.entity_id
    AND r.details ? 'refund' AND r.details->'refund'->>'paymentIntentId' = $2
  ORDER BY r.at DESC,
           CASE r.details->'refund'->>'state' WHEN 'confirmed' THEN 4 WHEN 'failed' THEN 3 WHEN 'sent' THEN 2 ELSE 1 END DESC
  LIMIT 1
) l ON true`

async function closeLateRefund(db: Db, id: string, paymentIntentId: string, why: string, options: CloseOptions): Promise<CloseStuckOutput> {
  return db.transaction(async (tx) => {
    // Reconcile's own lock for this payment's refund rows (reconcile.ts, recordStartedOnce).
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1::text))', [`late-refund:${paymentIntentId}`])
    const row = (await tx.query<{ entity_type: 'order' | 'reader_payment'; state: string | null; by_hand: boolean | null }>(LATE_REFUND_ONE_SQL, [id, paymentIntentId]))[0]
    if (!row) return refused('late_refund', id, 'not_listed')
    if (row.state === 'confirmed') return row.by_hand === true ? alreadyClosed('late_refund', id) : refused('late_refund', id, 'not_listed')
    // Only a refund Stripe refused: one still on its way is reconcile's, and a refund by hand beside it would pay twice.
    if (row.state !== 'failed') return refused('late_refund', id, 'refund_not_failed')
    const actor = { actorType: options.actor.type, actorId: options.actor.id, entityType: row.entity_type, entityId: id, requestId: options.requestId }
    await audit.recordAll(tx, [
      { ...actor, action: 'order.reconcile', details: { outcome: 'refund_confirmed', refund: { paymentIntentId, state: 'confirmed', byHand: { why } } } },
      { ...actor, action: CLOSE_ACTION, details: { kind: 'late_refund', why, paymentIntentId } },
    ])
    return answer('late_refund', id, { closed: true, message: CLOSE_WORDS.late_refund })
  })
}

// --- held_flow (W21, W19 review later 1)

/** What a person still has to do in Stripe after a held flow is undone, from what reconcile last found. */
function paymentLeftWords(reason: string, detail: string | null | undefined): string[] {
  const payments = detail ? ` (${detail})` : ''
  if (reason === 'other_mode') return ["Stripe can't see a payment for it with the account in use: check the other Stripe mode (live or test) and refund any payment there by hand."]
  if (reason === 'payment_processing') return [`A payment for it was still processing at the bank${payments}: if it goes through, refund it in Stripe by hand.`]
  return [`A payment for it went through in Stripe${payments}: refund it there by hand (the close doesn't refund it).`]
}

async function closeHeldFlow(db: Db, pendingId: string, why: string, options: CloseOptions): Promise<CloseStuckOutput> {
  return db.transaction(async (tx) => {
    // The flow's row first (W12's lock order), so the press's C2, reconcile and the undo queue behind it.
    const row = await readFlow(tx, pendingId, true)
    const entity = 'reader_payment'
    if (!row) return (await closedBefore(tx, 'held_flow', pendingId, undefined, entity)) ? alreadyClosed('held_flow', pendingId) : refused('held_flow', pendingId, 'flow_gone')
    if (row.status !== 'pending') return (await closedBefore(tx, 'held_flow', pendingId, undefined, entity)) ? alreadyClosed('held_flow', pendingId) : refused('held_flow', pendingId, 'flow_settled')
    if (!isWorkerFlow(row.snapshot) && !isWorkerCardFlow(row.snapshot)) return refused('held_flow', pendingId, 'old_flow')
    const last = await lastReconcile(tx, pendingId, entity)
    const ageMinutes = (Date.now() - new Date(row.created_at).getTime()) / 60000
    if (last?.outcome !== 'left' || !flowClosable(last.reason, ageMinutes)) return refused('held_flow', pendingId, 'flow_not_left_for_a_person')
    const reason = last.reason as string
    // db, not tx: the undo joins this transaction (db.transaction joins the one open on db).
    const undone = await undoFlowInTransaction(db, pendingId, { actor: options.actor, requestId: options.requestId, why: `Closed by hand: ${why}` })
    if (!undone.undone) return refused('held_flow', pendingId, 'flow_settled')
    const leftAsFound = paymentLeftWords(reason, last.detail)
    await audit.recordAll(tx, [
      {
        actorType: options.actor.type,
        actorId: options.actor.id,
        action: CLOSE_ACTION,
        entityType: entity,
        entityId: pendingId,
        requestId: options.requestId,
        details: { kind: 'held_flow', why, reason, payment: last.detail ?? null, flow: row.flow, recordId: row.record_id, problems: undone.problems },
      },
    ])
    return answer('held_flow', pendingId, {
      closed: true,
      message: CLOSE_WORDS.held_flow,
      givenBack: ['everything the change held (its store credit, gift card, places and credits)'],
      leftAsFound,
    })
  })
}

// --- held_claim (W21)

async function closeHeldClaim(db: Db, claimId: string, why: string, options: CloseOptions): Promise<CloseStuckOutput> {
  const claim = await readClaim(db, claimId)
  if (!claim) return refused('held_claim', claimId, 'not_listed')
  const entity = 'refund_claim'
  return db.transaction(async (tx) => {
    // The booking first, as R2 locks it: the press's R2 and reconcile's queue behind this, and find it finished.
    await lockForBooking(tx, { bookingId: claim.bookingId })
    const last = await lastReconcile(tx, claimId, entity)
    if (last?.outcome !== 'left' || !last.reason || !HELD_CLAIM_CLOSE_REASONS.has(last.reason)) {
      return (await closedBefore(tx, 'held_claim', claimId, undefined, entity)) ? alreadyClosed('held_claim', claimId) : refused('held_claim', claimId, 'claim_not_left_for_a_person')
    }
    // W21a (W21 review L2): a part matched to an old refund that went is gone (never owed, or it would be sent again).
    const matched = new Set((claim.details.matched ?? []).map((part) => part.orderId))
    const gone = claim.details.plan.card.filter((part) => matched.has(part.orderId))
    const owed = Math.round(claim.details.plan.card.filter((part) => !matched.has(part.orderId)).reduce((total, part) => total + part.amount, 0) * 100) / 100
    const finished = await finishClaimInTransaction(tx, claim, { went: gone, extraToStoreCredit: 0, owed }, { actor: options.actor, requestId: options.requestId, how: 'close', why })
    if (!finished) return (await closedBefore(tx, 'held_claim', claimId, undefined, entity)) ? alreadyClosed('held_claim', claimId) : refused('held_claim', claimId, 'not_listed')
    await audit.recordAll(tx, [
      {
        actorType: options.actor.type,
        actorId: options.actor.id,
        action: CLOSE_ACTION,
        entityType: entity,
        entityId: claimId,
        requestId: options.requestId,
        details: { kind: 'held_claim', why, reason: last.reason, found: last.detail ?? null, bookingId: claim.bookingId, owed },
      },
    ])
    // W23: a cancelled booking (Cancel & Refund's claims, an add-on removed from a cancelled booking) has no Refund the
    // rest or It already arrived: R2 kept the money owed on it rather than giving store credit, which could pay twice.
    const cancelled = (await tx.query<{ status: string }>('SELECT status FROM bookings WHERE id = $1::uuid', [claim.bookingId]))[0]?.status === 'cancelled'
    return answer('held_claim', claimId, {
      closed: true,
      message: CLOSE_WORDS.held_claim,
      givenBack: owed > 0 ? [`${money(owed)} back on the booking as money still to refund`] : [],
      leftAsFound: [
        cancelled
          ? CLOSED_ON_A_CANCELLED_BOOKING_WORDS
          : 'Check Stripe: if the refund reached the customer, use It already arrived on the booking; if not, use Refund the rest.',
      ],
    })
  })
}

/** The route's work: one item, by its kind. */
export async function closeStuckItem(db: Db, input: CloseStuckInput, options: CloseOptions): Promise<CloseStuckOutput> {
  const why = input.reason.trim()
  if (input.kind === 'held_order') return closeHeldOrder(db, input.orderId, why, options)
  if (input.kind === 'changed_elsewhere') return closeChangedElsewhere(db, input.orderId, why, options)
  if (input.kind === 'late_refund') return closeLateRefund(db, input.orderId, input.paymentIntentId ?? '', why, options)
  if (input.kind === 'held_flow') return closeHeldFlow(db, input.orderId, why, options)
  if (input.kind === 'held_claim') return closeHeldClaim(db, input.orderId, why, options)
  return closeSubscriptionLeft(db, input.orderId, input.subscriptionId ?? '', why, options)
}
