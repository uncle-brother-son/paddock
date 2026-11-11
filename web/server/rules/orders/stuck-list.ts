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
import { CHANGED_ELSEWHERE, CHANGED_ELSEWHERE_DAYS, CHANGED_ELSEWHERE_WHERE, changedElsewhereWords, type ChangedElsewhereFinding } from './changed-elsewhere'
import { CHANGED_SINCE_MESSAGE } from './failure-messages'
import { isWorkerFlow, type FlowSnapshot } from './reader-flow'
import { PROCESSING_MINUTES as RECONCILE_WINDOW_MINUTES } from './pending-order'

/** Words for each reason an item is listed (W12's; adjustable at W14). */
export const STUCK_WORDS: Readonly<Record<string, string>> = {
  waiting: 'Waiting for the automatic check, which runs every 5 minutes and settles it if it can. Nothing to do yet.',
  old_code: 'Started on the old screens: press Resolve now to settle it.',
  unclear: "Stripe didn't give a clear answer about this payment. The automatic check tries again every 5 minutes: don't take payment again.",
  other_mode:
    "Stripe can't find this payment with the payment account the system is using now (it may be in the other Stripe mode, live or test). Nothing was changed: check the payment in Stripe before doing anything.",
  amount_mismatch: "The amount Stripe took isn't the amount the order expected. Nothing was changed: check the payment in Stripe and sort it out by hand. Don't take payment again.",
  customer_mismatch: "The payment in Stripe was made for a different customer. Nothing was changed: check it in Stripe before doing anything.",
  metadata_mismatch: "The payment in Stripe doesn't name this order. Nothing was changed: check it in Stripe before doing anything.",
  currency_mismatch: "The payment in Stripe isn't in pounds. Nothing was changed: check it in Stripe before doing anything.",
  several_payments: 'Stripe has more than one payment for this. Nothing was changed: check them in Stripe and sort it out by hand.',
  changed_since: CHANGED_SINCE_MESSAGE,
  finalise_failed: "The payment went through but the order couldn't be finished yet. The automatic check tries again every 5 minutes: don't take payment again.",
  undo_failed: "The order couldn't be cancelled yet (nothing was given back). The automatic check tries again every 5 minutes.",
  old_rollback: 'The old screens had started cancelling this order: press Resolve now to finish it.',
  charged_without_order: 'A payment went through for an order that had already been cancelled. It is being refunded automatically.',
  charged_without_record: 'A payment went through for a change that had already been undone. It is being refunded automatically.',
  payment_not_succeeded: "The payment hasn't gone through. The automatic check tries again every 5 minutes.",
  unexpected: 'Something unexpected stopped the automatic check. It tries again every 5 minutes; if this stays, tell a manager.',
  // W13 (new; adjustable at W14).
  compensation_unfinished:
    "This membership order couldn't be set up, and putting back what it took (cancelling its new subscription, refunding its payments) hasn't been confirmed yet. The automatic check tries again every 5 minutes: don't take payment again. If this stays, check the subscription and the payments in Stripe and tell a manager.",
  several_subscriptions: 'Stripe has more than one subscription for this order. Nothing was changed: cancel the extra one in Stripe and sort it out by hand.',
  replaced_unconfirmed:
    "The new membership is paid for, but the customer's old membership couldn't be confirmed cancelled in Stripe. The automatic check tries again every 5 minutes: if this stays, cancel the old subscription in Stripe by hand.",
  // W13a (new; adjustable at W14).
  subscription_starting:
    "A finalise of this order was setting up its membership in Stripe when the automatic check looked, so it was left alone. The check looks again in 5 minutes: don't take payment again.",
}

/**
 * W13a (B1c): a subscription the reader's finalise made for an order that was gone (or being put back), which
 * couldn't be confirmed cancelled and refunded. Listed with the warnings until it is put back.
 */
export const SUBSCRIPTION_LEFT_WORDS = (subscriptionId: string): string =>
  `A membership subscription (${subscriptionId}) was started in Stripe for an order that had already been cancelled, and it couldn't be confirmed cancelled. Cancel it in Stripe by hand and refund its first payment if it took one, then tell a manager.`

/** W13: added to a membership order's words while it is listed: its subscription may be live until it is settled. */
export const MEMBERSHIP_STUCK_NOTE = "This order has a membership: its subscription may be live in Stripe until this is settled, so don't start it again."

export const REFUND_PENDING_WORDS = (amount: number, paymentIntentId: string): string =>
  `A payment of £${amount.toFixed(2)} (${paymentIntentId}) went through after its order or change had been cancelled. It is being refunded automatically: waiting for Stripe to confirm the refund. Don't refund it by hand.`
export const REFUND_FAILED_WORDS = (amount: number, paymentIntentId: string): string =>
  `A payment of £${amount.toFixed(2)} (${paymentIntentId}) went through after its order or change had been cancelled, and the automatic refund failed. Refund it in Stripe by hand.`
export const STRIPE_REFUSED_WORDS =
  "Stripe turned down the club's payment account details, so the automatic check couldn't look at any payments. Tell a manager so the Stripe connection can be fixed. Nothing has been changed."

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
}

export interface StuckRefund {
  kind: 'order' | 'flow'
  id: string
  paymentIntentId: string
  amount: number
  state: 'started' | 'sent' | 'failed' | 'waiting'
  words: string
}

export interface StuckWarning {
  kind: 'order' | 'flow'
  id: string
  at: string
  warning: string
}

export interface StuckListOutput {
  checkout: StuckOrder[]
  flows: StuckFlow[]
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
  -- A refund's state only moves forward (started, sent, then confirmed or failed), so two rows stamped in
  -- the same millisecond are told apart by it.
  ORDER BY r.entity_type, r.entity_id, r.details->'refund'->>'paymentIntentId', r.at DESC,
           CASE r.details->'refund'->>'state' WHEN 'confirmed' THEN 3 WHEN 'failed' THEN 3 WHEN 'sent' THEN 2 ELSE 1 END DESC
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
 * Reconcile retries each (L3), from what the row carries.
 */
export const SUBSCRIPTIONS_LEFT_SQL = `
SELECT s.entity_id, s.at, s.details->>'subscriptionId' AS subscription_id,
       s.details->>'invoicePaymentIntentId' AS invoice_payment_intent_id, (s.details->>'amountPaid')::int AS amount_paid
FROM (
  SELECT DISTINCT ON (entity_id, details->>'subscriptionId') entity_id, at, details
  FROM audit_log
  WHERE action = 'order.subscription_left' AND entity_type = 'order' AND details->>'state' = 'left'
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
  const refunds = await db.query<{ entity_type: string; entity_id: string; payment_intent_id: string; pence: number; state: string }>(REFUNDS_SQL)
  const warnings = await db.query<{ entity_type: string; entity_id: string; at: unknown; warning: string }>(WARNINGS_SQL, [WARNINGS_FOR_HOURS])
  const alert = (await db.query<{ at: unknown }>(ALERT_SQL, [ALERT_FOR_MINUTES]))[0]
  const subscriptionsLeft = await db.query<{ entity_id: string; at: unknown; subscription_id: string }>(SUBSCRIPTIONS_LEFT_SQL)

  return {
    checkout: orders.map((row): StuckOrder => {
      const method = row.method === 'reader' || row.method === 'card' ? row.method : null
      const reason = reasonFor(method !== null, row.last)
      const createdAt = iso(row.created_at)
      return {
        orderId: row.id,
        customerName: `${row.first_name} ${row.last_name}`.trim(),
        amount: Number.parseFloat(row.order_total),
        paymentIntentId: row.payment_intent_id,
        createdAt,
        ageMinutes: ageMinutes(createdAt),
        method,
        reason,
        words: row.has_membership ? `${wordsFor(reason)} ${MEMBERSHIP_STUCK_NOTE}` : wordsFor(reason),
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
        }
      })
    ),
    flows: flows.map((row) => {
      const madeByWorker = isWorkerFlow(row.snapshot)
      const reason = reasonFor(madeByWorker, row.last)
      const createdAt = iso(row.created_at)
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
        words: wordsFor(reason),
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
      }
    }),
    warnings: subscriptionsLeft
      .map((row): StuckWarning => ({ kind: 'order', id: row.entity_id, at: iso(row.at), warning: SUBSCRIPTION_LEFT_WORDS(row.subscription_id) }))
      .concat(warnings.map((row) => ({ kind: row.entity_type === 'order' ? 'order' : 'flow', id: row.entity_id, at: iso(row.at), warning: row.warning }))),
    alert: alert ? { at: iso(alert.at), words: STRIPE_REFUSED_WORDS } : null,
  }
}
