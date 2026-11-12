// Ported from backend/paddock/getStuckReaderPayments.ts (new in W12): what the Orders page lists as
// stuck. Read-only. Beside the old function's two lists (checkout orders and reader flows held pending
// longer than the window), it lists what only the Worker leaves (W10 report N2, W10-3): a saved-card
// order held pending (PAYMENT_UNCONFIRMED), with no reader PaymentIntent for the old list to see; and
// for each item, what reconcile last found, in plain words. Also the automatic refunds of late payments
// until Stripe confirms them, the warnings reconcile finished an order with (W03a later 6, R6), and an
// alert when Stripe refused the key on a recent run (W10 review L4). W12a (W12 review S1): Worker orders the
// old screens moved out of pending while their payment was unconfirmed, with what reconcile found in Stripe.
// W13a: a membership subscription left live for an order that was gone (B1c), with the warnings, until put back.
import 'server-only'
import type { Db } from '@/server/db'
import { CHANGED_ELSEWHERE, CHANGED_ELSEWHERE_DAYS, CHANGED_ELSEWHERE_WHERE, changedElsewhereWords, FINAL_FINDINGS, type ChangedElsewhereFinding } from './changed-elsewhere'
import { CHANGED_SINCE_MESSAGE } from './failure-messages'
import { isWorkerCardFlow, isWorkerFlow, type FlowSnapshot } from './reader-flow'
import type { StuckCloseTarget } from '@/contracts'
import { PROCESSING_MINUTES as RECONCILE_WINDOW_MINUTES } from './pending-order'

/**
 * Words for each reason an item is listed (W12's, W14b: every reason reconcile can leave an order or flow with has
 * its own, saying what staff should do; W12 review L5). A reason with none falls back to `unexpected`.
 */
const TELL_A_MANAGER = "Nothing was changed: don't take payment again, and tell a manager."
/**
 * W14c (W14b review L2): the old rollback on a Worker order. Since W14b nothing finishes it (the old sweep skips Worker
 * orders and the Worker's undo refuses it), so the words no longer send staff to Resolve now. The close says the same.
 */
export const OLD_ROLLBACK_WORDS =
  "The old screens had started cancelling this order and couldn't finish. Nothing more will be changed automatically: don't take payment again, and tell a manager."
export const STUCK_WORDS: Readonly<Record<string, string>> = {
  waiting: 'Waiting for the automatic check, which runs every 5 minutes and settles it if it can. Nothing to do yet.',
  old_code: 'Started on the old screens: press Resolve now to settle it.',
  unclear: "Stripe didn't give a clear answer about this payment. The automatic check tries again every 5 minutes: don't take payment again.",
  other_mode: `Stripe can't find this payment with the payment account the system is using now (it may be in the other Stripe mode, live or test). ${TELL_A_MANAGER}`,
  amount_mismatch: `The amount Stripe took isn't the amount expected. ${TELL_A_MANAGER}`,
  customer_mismatch: `The payment in Stripe was made for a different customer. ${TELL_A_MANAGER}`,
  metadata_mismatch: `The payment in Stripe doesn't name this order. ${TELL_A_MANAGER}`,
  currency_mismatch: `The payment in Stripe isn't in pounds. ${TELL_A_MANAGER}`,
  several_payments: `Stripe has more than one payment for this. ${TELL_A_MANAGER}`,
  changed_since: CHANGED_SINCE_MESSAGE,
  finalise_failed: "The payment went through but the order couldn't be finished yet. The automatic check tries again every 5 minutes: don't take payment again.",
  undo_failed: "This couldn't be cancelled yet (nothing was given back). The automatic check tries again every 5 minutes: don't take payment again. If this stays, tell a manager.",
  old_rollback: OLD_ROLLBACK_WORDS,
  charged_without_order: 'A payment went through for an order that had already been cancelled. It is being refunded automatically: nothing to do.',
  charged_without_record: 'A payment went through for a change that had already been undone. It is being refunded automatically: nothing to do.',
  payment_not_succeeded: "The payment hasn't gone through. The automatic check tries again every 5 minutes: don't take payment again.",
  unexpected: "Something unexpected stopped the automatic check. It tries again every 5 minutes: don't take payment again. If this stays, tell a manager.",
  // W13 (W14b: the words say what to do). W14c (W14b review S1): Close order is offered only once Stripe has refused
  // every step left for good (COMPENSATION_REFUSED_WORDS); until then reconcile finishes it, also after a person has
  // done the steps in Stripe by hand (a cancelled subscription reads as cancelled, a refunded payment as refunded).
  compensation_unfinished:
    "This membership order couldn't be set up, and putting back what it took (cancelling its new subscription, refunding its payments) hasn't been confirmed yet. The automatic check tries again every 5 minutes: don't take payment again. If this stays, tell a manager.",
  several_subscriptions: `Stripe has more than one subscription for this order. ${TELL_A_MANAGER}`,
  replaced_unconfirmed:
    "The new membership is paid for, but the customer's old membership couldn't be confirmed cancelled in Stripe. The automatic check tries again every 5 minutes: if this stays, tell a manager.",
  // W13a.
  subscription_starting:
    "A finalise of this order was setting up its membership in Stripe when the automatic check looked, so it was left alone. The check looks again in 5 minutes: don't take payment again.",
  // W14b (W12 review L5): the reasons that used to fall back to "something unexpected".
  unexpected_state: `This isn't in a state the automatic check expected (it may have been changed on the old screens). ${TELL_A_MANAGER}`,
  paid_by_another_payment: `This order was already paid with a different payment, and Stripe has another payment for it too. ${TELL_A_MANAGER}`,
  not_pending: 'This order is no longer waiting for payment: it was settled or changed elsewhere, so the automatic check leaves it alone. Nothing to do.',
  order_not_found: 'This order no longer exists (it was cancelled or removed in the meantime). Nothing to do.',
  not_a_reader_order: `This order isn't a card-reader order, so the automatic check couldn't settle its payment. ${TELL_A_MANAGER}`,
  intent_unconfirmed: "Its card-reader payment was never confirmed as set up. The automatic check looks for it in Stripe every 5 minutes: don't take payment again.",
  old_reader_order: 'Started on the old screens: press Resolve now to settle it.',
  old_reader_flow: 'Started on the old screens: press Resolve now to settle it.',
  rollback_started: OLD_ROLLBACK_WORDS,
  compensating:
    "This membership order is being reversed (its subscription cancelled, its payments refunded). The automatic check finishes it every 5 minutes: don't take payment again.",
  membership_not_started: "The membership's subscription couldn't be found in Stripe. The automatic check tries again every 5 minutes: don't take payment again. If this stays, tell a manager.",
  payment_missing: "The membership's payment couldn't be found in Stripe. The automatic check tries again every 5 minutes: don't take payment again. If this stays, tell a manager.",
  subscription_mismatch: "The membership in Stripe doesn't match this order, so it is being reversed automatically: don't take payment again. If this stays, tell a manager.",
  membership_line_missing: "This membership order is missing its membership, so it is being reversed automatically: don't take payment again. If this stays, tell a manager.",
  membership_row_missing: "This membership order is missing its membership, so it is being reversed automatically: don't take payment again. If this stays, tell a manager.",
  subscription_unconfirmed: "Stripe didn't confirm the membership's subscription. The automatic check looks again every 5 minutes: don't take payment again or start the membership again.",
  // W19: a saved-card change's payment Stripe is still working on (reconcileCardFlow).
  payment_processing: "The card payment for this change is still being processed by the bank. The automatic check looks again every 5 minutes: don't take payment again.",
  // W21: a booking refund's claim (reconcile.ts, reconcileClaim).
  several_refunds: `Stripe has more than one refund for this. ${TELL_A_MANAGER}`,
  refund_mismatch: `A refund in Stripe for this isn't the amount planned. ${TELL_A_MANAGER}`,
  finish_failed: "The refund was found in Stripe but couldn't be recorded on the booking yet. The automatic check tries again every 5 minutes: don't refund it again.",
}

/**
 * W21: a booking refund held for the automatic check (its card refund got no clear answer, or went and couldn't be
 * recorded). Nothing to do by hand while it waits: the check never sends a refund again.
 */
export const CLAIM_WAITING_WORDS =
  "A refund on this booking didn't finish cleanly. The automatic check, every 5 minutes, looks for it in Stripe and finishes it: anything Stripe never received becomes money still to refund on the booking (Refund the rest). Don't refund it again."

/**
 * W21 (W19 review later 1): the reasons a Worker flow reconcile left for a person can be closed by hand with
 * (close-stuck.ts imports these): more than one payment, a payment that doesn't match, the other Stripe mode. A payment
 * still processing only once it has been for a day (PROCESSING_CLOSE_HOURS): before that the bank may still finish it.
 */
export const HELD_FLOW_CLOSE_REASONS: ReadonlySet<string> = new Set([
  'several_payments',
  'payment_mismatch',
  'amount_mismatch',
  'metadata_mismatch',
  'currency_mismatch',
  'customer_mismatch',
  'other_mode',
])
export const PROCESSING_CLOSE_HOURS = 24
/** W21: the reasons a held refund claim can be closed by hand with. */
export const HELD_CLAIM_CLOSE_REASONS: ReadonlySet<string> = new Set(['several_refunds', 'refund_mismatch', 'other_mode'])

/** W21: whether a flow's last reconcile reason, at its age, is one a person may close (close-stuck.ts checks it too). */
export function flowClosable(reason: string | undefined, ageMinutes: number): boolean {
  if (!reason) return false
  if (reason === 'payment_processing') return ageMinutes >= PROCESSING_CLOSE_HOURS * 60
  return HELD_FLOW_CLOSE_REASONS.has(reason)
}

/**
 * W19: a saved-card change (Settle) waiting for the automatic check. Nothing to finish or cancel by hand: the check
 * finds the payment in Stripe and finishes the change, or undoes it if nothing was taken.
 */
export const CARD_FLOW_WAITING_WORDS =
  "A saved-card payment for this booking change didn't finish cleanly. The automatic check, every 5 minutes, finds it in Stripe and finishes the change, or undoes it if nothing was taken: don't take payment again."

/**
 * W13a (B1c): a subscription the reader's finalise made for an order that was gone (or being put back), which
 * couldn't be confirmed cancelled and refunded. Listed with the warnings until it is put back. W14b: a person who has
 * put it back by hand marks it sorted; `refused`: Stripe refused a step for good, so the automatic check stopped.
 */
export const SUBSCRIPTION_LEFT_WORDS = (subscriptionId: string): string =>
  `A membership subscription (${subscriptionId}) was started in Stripe for an order that had already been cancelled, and it couldn't be confirmed cancelled yet. The automatic check tries again every 5 minutes. If this stays, cancel it in Stripe by hand and refund its first payment if it took one, then press Mark sorted (needs the Issue refunds permission).`
export const SUBSCRIPTION_REFUSED_WORDS = (subscriptionId: string): string =>
  `A membership subscription (${subscriptionId}) was started in Stripe for an order that had already been cancelled, and Stripe refused to cancel it or refund its first payment, so the automatic check has stopped trying. Cancel it in Stripe by hand and refund its first payment if it took one (or tell a manager), then press Mark sorted (needs the Issue refunds permission).`

/**
 * W14c (W14b review S1): a held compensation whose every step left is a definite refusal by Stripe (a disputed
 * payment's refund, say): reconcile can't finish it, so a person sorts it and closes the order.
 */
export const COMPENSATION_REFUSED_WORDS =
  "This membership order couldn't be set up, and Stripe refused to finish putting back what it took (cancelling its new subscription or refunding a payment), so the automatic check can't finish it. Don't take payment again. Cancel the subscription and refund the payments in Stripe by hand (or tell a manager if Stripe won't), then press Close order (needs the Issue refunds permission)."

/** W13: added to a membership order's words while it is listed: its subscription may be live until it is settled. */
export const MEMBERSHIP_STUCK_NOTE = "This order has a membership: its subscription may be live in Stripe until this is settled, so don't start it again."

export const REFUND_PENDING_WORDS = (amount: number, paymentIntentId: string): string =>
  `A payment of £${amount.toFixed(2)} (${paymentIntentId}) went through after its order or change had been cancelled. It is being refunded automatically: waiting for Stripe to confirm the refund. Nothing to do. Don't refund it by hand.`
/** W14c (W14b N1): a failed refund is closed by hand once a person has refunded it in Stripe (`late_refund`). */
export const REFUND_FAILED_WORDS = (amount: number, paymentIntentId: string): string =>
  `A payment of £${amount.toFixed(2)} (${paymentIntentId}) went through after its order or change had been cancelled, and Stripe refused the automatic refund, so the automatic check has stopped trying. Refund it in Stripe by hand (or tell a manager if Stripe won't), then press Mark refunded (needs the Issue refunds permission).`
export const STRIPE_REFUSED_WORDS =
  "Stripe turned down the club's payment account details, so the automatic check couldn't look at any payments. Nothing has been changed. Tell a manager straight away so the Stripe connection can be fixed."

/** W14b: the changed-elsewhere findings the close accepts (close-stuck.ts says why). */
const CLOSABLE_FINDINGS: ReadonlySet<string> = new Set([...FINAL_FINDINGS, 'other_mode'])

/** W14b: the reasons a held Worker order can be closed by hand with (close-stuck.ts imports these). */
export const HELD_ORDER_CLOSE_REASONS: ReadonlySet<string> = new Set(['changed_since', 'compensation_unfinished'])

/**
 * W14c (W14b review S1, L3): true when the order's latest `order.compensate` row is held with every step left a
 * definite refusal by Stripe (membership.ts, compensateOrder). `orderIdText` is SQL for the order's id as text. The
 * close (close-stuck.ts) and the list accept `compensation_unfinished` only on that, and only on an order carrying
 * the compensation mark.
 */
export const compensationDefiniteSql = (orderIdText: string): string => `
  COALESCE((SELECT c.details->>'state' = 'held' AND c.details->>'definite' = 'true' FROM audit_log c
            WHERE c.entity_type = 'order' AND c.entity_id = ${orderIdText} AND c.action = 'order.compensate'
            ORDER BY c.at DESC, c.id DESC LIMIT 1), false)`

const wordsFor = (reason: string): string => STUCK_WORDS[reason] ?? STUCK_WORDS['unexpected'] ?? ''

export interface StuckOrder {
  orderId: string
  customerName: string
  amount: number
  paymentIntentId: string | null
  createdAt: string
  ageMinutes: number
  /** 'reader' or 'card' for an order the Worker made; null for the old checkout's. */
  method: 'reader' | 'card' | null
  reason: string
  words: string
  /** W12a (S1), a changed-elsewhere order only: its payment status now, and what reconcile last found (null: not looked yet). */
  paymentStatus?: string
  finding?: ChangedElsewhereFinding | null
  /** W14b: what the manual close does for it (close-stuck.ts); absent when nothing can be closed by hand. */
  close?: StuckCloseTarget
}

export interface StuckFlow {
  pendingId: string
  flow: 'move' | 'settle' | 'add_guest'
  recordId: string
  customerName: string
  amount: number
  createdAt: string
  ageMinutes: number
  madeBy: 'worker' | 'old'
  reason: string
  words: string
  /** W21: a Worker flow reconcile left for a person (`held_flow`). */
  close?: StuckCloseTarget
}

export interface StuckClaim {
  claimId: string
  bookingId: string
  customerName: string
  /** The card money the claim planned to send. */
  amount: number
  createdAt: string
  ageMinutes: number
  reason: string
  words: string
  close?: StuckCloseTarget
}

export interface StuckRefund {
  kind: 'order' | 'flow'
  id: string
  paymentIntentId: string
  amount: number
  state: 'started' | 'sent' | 'failed' | 'waiting'
  words: string
  /** W14c (W14b N1): a refund Stripe refused can be recorded as refunded by hand. */
  close?: StuckCloseTarget
}

export interface StuckWarning {
  kind: 'order' | 'flow'
  id: string
  at: string
  warning: string
  /** W14b: a subscription left live can be marked sorted once a person has put it back in Stripe. */
  close?: StuckCloseTarget
}

export interface StuckListOutput {
  checkout: StuckOrder[]
  flows: StuckFlow[]
  claims: StuckClaim[]
  refunds: StuckRefund[]
  warnings: StuckWarning[]
  alert: { at: string; words: string } | null
}

/** How long a finished order's warning stays on the list, and a refused key's alert. */
const WARNINGS_FOR_HOURS = 24
const ALERT_FOR_MINUTES = 30

const ORDERS_SQL = `
SELECT o.id, o.order_total::text AS order_total,
       COALESCE(o.reader_payment->>'payment_intent_id', o.reader_payment->>'charge_payment_intent_id') AS payment_intent_id,
       COALESCE((o.reader_payment->>'created_at')::timestamptz, o.created_at) AS created_at,
       o.reader_payment->>'method' AS method,
       o.reader_payment ? 'membership' AS has_membership,
       o.reader_payment ? 'compensation' AS compensating,
       ${compensationDefiniteSql('o.id::text')} AS compensation_definite,
       c.first_name, c.last_name,
       (SELECT r.details FROM audit_log r
        WHERE r.entity_type = 'order' AND r.entity_id = o.id::text AND r.action = 'order.reconcile' AND NOT (r.details ? 'refund')
        ORDER BY r.at DESC LIMIT 1) AS last
FROM orders o
JOIN customers c ON c.id = o.customer_id
WHERE o.payment_status = 'pending' AND o.reader_payment IS NOT NULL
  AND (o.reader_payment->>'payment_intent_id' IS NOT NULL OR o.reader_payment->>'method' IN ('card', 'reader'))
  AND COALESCE((o.reader_payment->>'created_at')::timestamptz, o.created_at) < now() - make_interval(mins => $1::int)
ORDER BY 4, o.id`

/** W12a (S1): changed-elsewhere.ts's orders, with reconcile's last finding for each, final or not. */
const CHANGED_SQL = `
SELECT o.id, o.order_total::text AS order_total, o.payment_status,
       COALESCE((o.reader_payment->>'created_at')::timestamptz, o.created_at) AS created_at,
       o.reader_payment->>'method' AS method,
       c.first_name, c.last_name,
       (SELECT r.details->'finding' FROM audit_log r
        WHERE r.entity_type = 'order' AND r.entity_id = o.id::text AND r.action = 'order.reconcile' AND r.details->>'reason' = '${CHANGED_ELSEWHERE}'
        ORDER BY r.at DESC LIMIT 1) AS finding
FROM orders o
JOIN customers c ON c.id = o.customer_id
WHERE ${CHANGED_ELSEWHERE_WHERE}
ORDER BY 4, o.id`

const FLOWS_SQL = `
SELECT p.id, p.flow, p.record_id, p.expected_amount::text AS expected_amount, p.created_at, p.snapshot,
       c.first_name, c.last_name,
       (SELECT r.details FROM audit_log r
        WHERE r.entity_type = 'reader_payment' AND r.entity_id = p.id::text AND r.action = 'order.reconcile' AND NOT (r.details ? 'refund')
        ORDER BY r.at DESC LIMIT 1) AS last
FROM pending_reader_payments p
JOIN customers c ON c.id = (p.snapshot->>'customer_id')::uuid
WHERE p.status = 'pending' AND p.created_at < now() - make_interval(mins => $1::int)
ORDER BY p.created_at, p.id`

/** W21: Worker refund claims with no finished row, older than the window, with reconcile's last row for each. */
const CLAIMS_SQL = `
SELECT c.id, c.entity_id AS booking_id, c.at AS created_at, c.details, cu.first_name, cu.last_name,
       (SELECT r.details FROM audit_log r
        WHERE r.entity_type = 'refund_claim' AND r.entity_id = c.id::text AND r.action = 'order.reconcile'
        ORDER BY r.at DESC LIMIT 1) AS last
FROM audit_log c
JOIN bookings b ON b.id::text = c.entity_id
JOIN customers cu ON cu.id = b.customer_id
WHERE c.action = 'booking.refund_claimed' AND c.entity_type = 'booking' AND c.details->>'worker' = 'true'
  AND c.at < now() - make_interval(mins => $1::int)
  AND NOT EXISTS (
    SELECT 1 FROM audit_log f
    WHERE f.action = 'booking.refund_finished' AND f.entity_type = 'booking' AND f.entity_id = c.entity_id AND f.details->>'claimId' = c.id::text
  )
ORDER BY c.at, c.id`

const REFUNDS_SQL = `
WITH charged AS (
  SELECT a.entity_type, a.entity_id, a.details->>'paymentIntentId' AS payment_intent_id,
         (a.details->>'amount')::numeric AS pence, min(a.at) AS first_at
  FROM audit_log a
  WHERE a.action IN ('order.charge_without_order', 'reader_payment.charge_without_record')
  GROUP BY 1, 2, 3, 4
),
latest AS (
  SELECT DISTINCT ON (r.entity_type, r.entity_id, r.details->'refund'->>'paymentIntentId')
         r.entity_type, r.entity_id, r.details->'refund'->>'paymentIntentId' AS payment_intent_id, r.details->'refund'->>'state' AS state
  FROM audit_log r
  WHERE r.action = 'order.reconcile' AND r.details ? 'refund'
  -- A refund's state only moves forward (started, sent, then confirmed or failed; W14c: failed, then confirmed by
  -- hand), so two rows stamped in the same millisecond are told apart by it.
  ORDER BY r.entity_type, r.entity_id, r.details->'refund'->>'paymentIntentId', r.at DESC,
           CASE r.details->'refund'->>'state' WHEN 'confirmed' THEN 4 WHEN 'failed' THEN 3 WHEN 'sent' THEN 2 ELSE 1 END DESC
)
SELECT c.entity_type, c.entity_id, c.payment_intent_id, c.pence::float8 AS pence, COALESCE(l.state, 'waiting') AS state
FROM charged c
LEFT JOIN latest l ON l.entity_type = c.entity_type AND l.entity_id = c.entity_id AND l.payment_intent_id = c.payment_intent_id
WHERE l.state IS NULL OR l.state <> 'confirmed'
ORDER BY c.first_at`

const WARNINGS_SQL = `
SELECT entity_type, entity_id, at, details->>'warning' AS warning
FROM audit_log
WHERE action = 'order.reconcile' AND details ? 'warning' AND at > now() - make_interval(hours => $1::int)
ORDER BY at DESC`

/**
 * W13a (B1c): each subscription left live for an order that was gone or being compensated (membership.ts,
 * putBackSubscription), until a later row says it is put back: the same row `cancelled`, or the order's
 * compensation done with that subscription cancelled. W13c: one per order and subscription, its latest `left` row
 * (T2 records the subscription as left, then the put-back, or reconcile's retry, may record it left again).
 * Reconcile retries each (L3), from what the row carries. W14b (W13c review L4): a `refused` row (Stripe refused a
 * step for good) is listed the same but never retried; the manual close's `cancelled` row closes either.
 */
export const SUBSCRIPTIONS_LEFT_SQL = `
SELECT s.entity_id, s.at, s.details->>'subscriptionId' AS subscription_id,
       s.details->>'invoicePaymentIntentId' AS invoice_payment_intent_id, (s.details->>'amountPaid')::int AS amount_paid,
       s.details->>'state' AS state
FROM (
  SELECT DISTINCT ON (entity_id, details->>'subscriptionId') entity_id, at, details
  FROM audit_log
  WHERE action = 'order.subscription_left' AND entity_type = 'order' AND details->>'state' IN ('left', 'refused')
  ORDER BY entity_id, details->>'subscriptionId', at DESC
) s
WHERE NOT EXISTS (
    SELECT 1 FROM audit_log d
    WHERE d.entity_type = 'order' AND d.entity_id = s.entity_id AND d.at >= s.at
      AND d.details->>'subscriptionId' = s.details->>'subscriptionId'
      AND ((d.action = 'order.subscription_left' AND d.details->>'state' = 'cancelled')
           OR (d.action = 'order.compensate' AND d.details->>'state' = 'done'))
  )
ORDER BY s.at DESC`

const ALERT_SQL = `
SELECT at FROM audit_log
WHERE action = 'reconcile.stripe_refused' AND entity_type = 'reconcile' AND at > now() - make_interval(mins => $1::int)
ORDER BY at DESC LIMIT 1`

interface Last {
  outcome?: string
  reason?: string
}

/** Why an item is listed: what reconcile last found, or that it hasn't looked yet, or that it's the old code's. */
function reasonFor(madeByWorker: boolean, last: Last | null): string {
  if (!madeByWorker) return 'old_code'
  if (last?.outcome === 'left' && last.reason) return last.reason
  return 'waiting'
}

export async function stuckList(db: Db, { olderThanMinutes = RECONCILE_WINDOW_MINUTES, now = Date.now }: { olderThanMinutes?: number; now?: () => number } = {}): Promise<StuckListOutput> {
  const ageMinutes = (iso: string | null): number => (iso ? Math.max(0, Math.round((now() - new Date(iso).getTime()) / 60000)) : 0)
  const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value ?? ''))

  const orders = await db.query<{
    id: string
    order_total: string
    payment_intent_id: string | null
    created_at: unknown
    method: string | null
    has_membership: boolean | null
    compensating: boolean | null
    compensation_definite: boolean | null
    first_name: string
    last_name: string
    last: Last | null
  }>(ORDERS_SQL, [olderThanMinutes])
  const changed = await db.query<{
    id: string
    order_total: string
    payment_status: string
    created_at: unknown
    method: string
    first_name: string
    last_name: string
    finding: ChangedElsewhereFinding | null
  }>(CHANGED_SQL, [olderThanMinutes, CHANGED_ELSEWHERE_DAYS])
  const flows = await db.query<{
    id: string
    flow: string
    record_id: string
    expected_amount: string
    created_at: unknown
    snapshot: FlowSnapshot
    first_name: string
    last_name: string
    last: Last | null
  }>(FLOWS_SQL, [olderThanMinutes])
  const claims = await db.query<{
    id: string
    booking_id: string
    created_at: unknown
    details: { plan?: { card?: Array<{ amount: number }> } }
    first_name: string
    last_name: string
    last: Last | null
  }>(CLAIMS_SQL, [olderThanMinutes])
  const refunds = await db.query<{ entity_type: string; entity_id: string; payment_intent_id: string; pence: number; state: string }>(REFUNDS_SQL)
  const warnings = await db.query<{ entity_type: string; entity_id: string; at: unknown; warning: string }>(WARNINGS_SQL, [WARNINGS_FOR_HOURS])
  const alert = (await db.query<{ at: unknown }>(ALERT_SQL, [ALERT_FOR_MINUTES]))[0]
  const subscriptionsLeft = await db.query<{ entity_id: string; at: unknown; subscription_id: string; state: string }>(SUBSCRIPTIONS_LEFT_SQL)

  return {
    checkout: orders.map((row): StuckOrder => {
      const method = row.method === 'reader' || row.method === 'card' ? row.method : null
      const reason = reasonFor(method !== null, row.last)
      const createdAt = iso(row.created_at)
      // W14b: a Worker order reconcile left for a person, with the reason the close acts on (close-stuck.ts). W14c
      // (S1, L3): a compensation only with its mark and once Stripe has refused every step left for good.
      const refusedForGood = row.compensating === true && row.compensation_definite === true
      const closable =
        method !== null && row.last?.outcome === 'left' && HELD_ORDER_CLOSE_REASONS.has(reason) && (reason !== 'compensation_unfinished' || refusedForGood)
      const words = reason === 'compensation_unfinished' && refusedForGood ? COMPENSATION_REFUSED_WORDS : wordsFor(reason)
      return {
        orderId: row.id,
        customerName: `${row.first_name} ${row.last_name}`.trim(),
        amount: Number.parseFloat(row.order_total),
        paymentIntentId: row.payment_intent_id,
        createdAt,
        ageMinutes: ageMinutes(createdAt),
        method,
        reason,
        words: row.has_membership ? `${words} ${MEMBERSHIP_STUCK_NOTE}` : words,
        ...(closable ? { close: { kind: 'held_order' as const, orderId: row.id } } : {}),
      }
    }).concat(
      changed.map((row): StuckOrder => {
        const createdAt = iso(row.created_at)
        return {
          orderId: row.id,
          customerName: `${row.first_name} ${row.last_name}`.trim(),
          amount: Number.parseFloat(row.order_total),
          paymentIntentId: null,
          createdAt,
          ageMinutes: ageMinutes(createdAt),
          method: row.method === 'reader' ? 'reader' : 'card',
          reason: CHANGED_ELSEWHERE,
          words: changedElsewhereWords(row.finding),
          paymentStatus: row.payment_status,
          finding: row.finding,
          // W14b: once nothing in Stripe can still be paid for it (or only a person can check: the other mode).
          ...(row.finding && CLOSABLE_FINDINGS.has(row.finding.state) ? { close: { kind: 'changed_elsewhere' as const, orderId: row.id } } : {}),
        }
      })
    ),
    flows: flows.map((row) => {
      // W19: a saved-card flow is the Worker's too (W17 "For W19" 1), with words of its own while it waits.
      const card = isWorkerCardFlow(row.snapshot)
      const madeByWorker = card || isWorkerFlow(row.snapshot)
      const reason = reasonFor(madeByWorker, row.last)
      const createdAt = iso(row.created_at)
      const age = ageMinutes(createdAt)
      // W21: only once reconcile has left it for a person (W19 review later 1).
      const closable = madeByWorker && row.last?.outcome === 'left' && flowClosable(reason, age)
      return {
        pendingId: row.id,
        flow: row.flow as StuckFlow['flow'],
        recordId: row.record_id,
        customerName: `${row.first_name} ${row.last_name}`.trim(),
        amount: Number.parseFloat(row.expected_amount),
        createdAt,
        ageMinutes: ageMinutes(createdAt),
        madeBy: madeByWorker ? 'worker' : 'old',
        reason,
        words: card && reason === 'waiting' ? CARD_FLOW_WAITING_WORDS : wordsFor(reason),
        ...(closable ? { close: { kind: 'held_flow' as const, orderId: row.id } } : {}),
      }
    }),
    claims: claims.map((row): StuckClaim => {
      const reason = reasonFor(true, row.last)
      const createdAt = iso(row.created_at)
      const amount = Math.round((row.details.plan?.card ?? []).reduce((total, part) => total + Number(part.amount), 0) * 100) / 100
      const closable = row.last?.outcome === 'left' && HELD_CLAIM_CLOSE_REASONS.has(reason)
      return {
        claimId: row.id,
        bookingId: row.booking_id,
        customerName: `${row.first_name} ${row.last_name}`.trim(),
        amount,
        createdAt,
        ageMinutes: ageMinutes(createdAt),
        reason,
        words: reason === 'waiting' ? CLAIM_WAITING_WORDS : wordsFor(reason),
        ...(closable ? { close: { kind: 'held_claim' as const, orderId: row.id } } : {}),
      }
    }),
    refunds: refunds.map((row) => {
      const amount = row.pence / 100
      const state = (['started', 'sent', 'failed'].includes(row.state) ? row.state : 'waiting') as StuckRefund['state']
      return {
        kind: row.entity_type === 'order' ? 'order' : 'flow',
        id: row.entity_id,
        paymentIntentId: row.payment_intent_id,
        amount,
        state,
        words: state === 'failed' ? REFUND_FAILED_WORDS(amount, row.payment_intent_id) : REFUND_PENDING_WORDS(amount, row.payment_intent_id),
        // W14c (W14b N1): only a refund Stripe refused; one still on its way is the automatic check's.
        ...(state === 'failed' ? { close: { kind: 'late_refund' as const, orderId: row.entity_id, paymentIntentId: row.payment_intent_id } } : {}),
      }
    }),
    warnings: subscriptionsLeft
      .map(
        (row): StuckWarning => ({
          kind: 'order',
          id: row.entity_id,
          at: iso(row.at),
          warning: row.state === 'refused' ? SUBSCRIPTION_REFUSED_WORDS(row.subscription_id) : SUBSCRIPTION_LEFT_WORDS(row.subscription_id),
          close: { kind: 'subscription_left', orderId: row.entity_id, subscriptionId: row.subscription_id },
        })
      )
      .concat(warnings.map((row) => ({ kind: row.entity_type === 'order' ? 'order' : 'flow', id: row.entity_id, at: iso(row.at), warning: row.warning }))),
    alert: alert ? { at: iso(alert.at), words: STRIPE_REFUSED_WORDS } : null,
  }
}
