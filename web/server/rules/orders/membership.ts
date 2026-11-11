// New in W13: the membership's Stripe steps, after T1 has committed the order pending (W03-plan 2.1, 2.5).
// Ported from app/api/memberships/create-subscription/core.ts (the price check, the default card, the
// first-invoice coupon, the subscription) and backend/paddock/shared/cancelMembershipSubscription.ts (the
// cancel), with createOrder.ts's and finaliseReaderOrder.ts's compensation, now keyed, checked, and held
// for reconcile when it can't finish. Every step here is outside any transaction.
import 'server-only'
import Stripe from 'stripe'
import { audit, type AuditEntry } from '@/server/audit'
import type { Db } from '@/server/db'
import { stripeIdempotencyKey } from '@/server/http/idempotency'
import type { StripeClient } from '@/server/stripe/client'
import { MIN_SEND_MS, NoTimeLeft, sendOptions, type StripeTiming } from '@/server/stripe/deadline'
import { readStripeFailure } from '@/server/stripe/outcome'
import { pence } from './collect-saved-card'
import {
  COUPON_FAILED_MESSAGE,
  DEFAULT_CARD_FAILED_MESSAGE,
  MEMBERSHIP_STRIPE_REFUSED_MESSAGE,
  PRICE_NOT_VERIFIED_MESSAGE,
  membershipPriceInactiveMessage,
  membershipPriceMismatchMessage,
} from './failure-messages'
import type { PendingMembership } from './pending-order'
import { undoOrder, type UndoOutcome } from './undo-order'

/**
 * The membership press's Stripe deadline, from the request's start (server/stripe/deadline.ts's 30 s for other
 * presses): the saved card's order, and (W13a) the reader's finalise and cancel's finalise-instead. Its T2 can take longer than a card order's (the membership's credit period is
 * allocated after the paid statement, and that insert can wait on another transaction's for up to the 5 s
 * lock limit), so the Stripe part ends 5 s sooner to keep the press 10 s inside Retool's 60 s: Retool and the
 * shadow 6.2 + Stripe by 25 + T2 18.1 (lock 5, statement 8, the allocation's lock wait 5) + 0.05 ≈ 49.4 s.
 */
export const MEMBERSHIP_STRIPE_DEADLINE_MS = 25_000

/** The coupon's fixed id: a retry sends identical parameters under the same key (W03-plan 2.5, bug 13). */
export const couponId = (orderId: string): string => `order-${orderId}`

/** The coupon names the old route gave, as the Stripe invoice shows them. */
export const CARD_COUPON_NAME = 'Gift card / store credit'
export const READER_COUPON_NAME = 'Paid on card reader'

const accessRefused = (err: unknown): boolean =>
  err instanceof Stripe.errors.StripeAuthenticationError || err instanceof Stripe.errors.StripePermissionError

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** A step that wasn't sent for lack of time, or got no clear answer. */
const unclearOf = (err: unknown): string => (err instanceof NoTimeLeft ? `not sent: ${err.message}` : readStripeFailure(err).message)

// --- 1. The price (W03-plan 2.7: "compare Stripe's price.unit_amount with the plan's price")

export type PriceCheck = { ok: true } | { ok: false; reason: string; message: string }

/**
 * The plan's Stripe price must exist, be active, be a recurring gbp price of the order's interval, and be
 * exactly the price T1 charged for the membership (to the penny). Anything else is refused before anything
 * is taken. A read that gets no answer is refused too, as the old route refused it ("Failed to verify Stripe
 * price"): nothing has been taken, so there is nothing to hold.
 */
export async function checkMembershipPrice(stripe: StripeClient, membership: PendingMembership, timing: StripeTiming | undefined): Promise<PriceCheck> {
  let price: Stripe.Price
  try {
    price = await stripe.prices.retrieve(membership.stripe_price_id, undefined, sendOptions(timing))
  } catch (err) {
    if (accessRefused(err)) return { ok: false, reason: 'membership_subscription_failed', message: MEMBERSHIP_STRIPE_REFUSED_MESSAGE }
    return { ok: false, reason: 'membership_subscription_failed', message: PRICE_NOT_VERIFIED_MESSAGE }
  }
  const interval = membership.billing_frequency === 'monthly' ? 'month' : 'year'
  if (!price.recurring || price.recurring.interval !== interval || price.currency !== 'gbp') {
    return { ok: false, reason: 'membership_price_not_recurring', message: '' }
  }
  if (price.active === false) return { ok: false, reason: 'membership_price_inactive', message: membershipPriceInactiveMessage(membership.plan_name) }
  if (price.unit_amount !== pence(membership.price)) {
    return { ok: false, reason: 'membership_price_mismatch', message: membershipPriceMismatchMessage(price.unit_amount ?? 0, membership.price) }
  }
  return { ok: true }
}

// --- 2. The subscription

/** A subscription Stripe made for an order, as the order needs it. */
export interface MadeSubscription {
  id: string
  status: string
  customer: string | null
  priceId: string | null
  /** `metadata.order_id`: the order it was made for. */
  orderId: string | null
  /** The first period, in seconds since the epoch. */
  periodStart: number | null
  periodEnd: number | null
  /**
   * The first invoice's PaymentIntent: null when nothing was charged for it (the coupon covered all of it, the
   * customer's Stripe credit did, or Stripe marked it paid as under its minimum charge, W13a S1).
   */
  invoicePaymentIntentId: string | null
  /** What the first invoice took from the card, in pence: what a compensation refunds. */
  amountPaid: number
  /**
   * W13a (S1): what the first invoice was for, in pence: its `total`, after the coupon and before the customer's
   * Stripe balance. What the order's `first_invoice` is checked against. Stripe then applies any balance the
   * customer has (credit or debit), and marks an amount due under its 30p minimum paid with nothing taken (it
   * carries it to the next invoice), so `amountPaid` can differ from it; createOrder allowed both.
   */
  invoiceTotal: number | null
  /** The first invoice. */
  invoiceId: string | null
}

/** invoice.payments.data[0].payment.payment_intent, as the legacy route read it (getInvoicePaymentIntentId). */
function invoicePaymentIntent(invoice: Stripe.Invoice | null): string | null {
  const paymentIntent = invoice?.payments?.data?.[0]?.payment?.payment_intent
  if (!paymentIntent) return null
  return typeof paymentIntent === 'string' ? paymentIntent : paymentIntent.id
}

export function madeSubscription(subscription: Stripe.Subscription): MadeSubscription {
  const item = subscription.items?.data?.[0]
  const invoice = typeof subscription.latest_invoice === 'object' ? subscription.latest_invoice : null
  const customer = typeof subscription.customer === 'string' ? subscription.customer : (subscription.customer?.id ?? null)
  return {
    id: subscription.id,
    status: subscription.status,
    customer,
    priceId: item ? (typeof item.price === 'string' ? item.price : item.price.id) : null,
    orderId: subscription.metadata?.['order_id'] ?? null,
    periodStart: item?.current_period_start ?? null,
    periodEnd: item?.current_period_end ?? null,
    invoicePaymentIntentId: invoicePaymentIntent(invoice),
    amountPaid: invoice?.amount_paid ?? 0,
    invoiceTotal: typeof invoice?.total === 'number' ? invoice.total : null,
    invoiceId: invoice?.id ?? (typeof subscription.latest_invoice === 'string' ? subscription.latest_invoice : null),
  }
}

/**
 * Whether Stripe made exactly what the order asked for: active, for this order, this Stripe customer and
 * this price, its first invoice for exactly `first_invoice` (its total, W13a S1: what it took can differ by
 * the customer's Stripe balance or Stripe's minimum charge). Null when it did; else what differs. A
 * subscription that differs is a rule the data breaks, so it is compensated (cancelled, its money refunded).
 */
export function subscriptionMismatch(made: MadeSubscription, orderId: string, stripeCustomerId: string, membership: PendingMembership): string | null {
  if (made.status !== 'active') return `its status is ${made.status}`
  if (made.orderId !== orderId) return 'it names another order'
  if (made.customer !== stripeCustomerId) return 'it is for another Stripe customer'
  if (made.priceId !== membership.stripe_price_id) return 'it is on another price'
  if (made.invoiceTotal !== pence(membership.first_invoice)) {
    return made.invoiceTotal === null ? 'its first invoice has no total' : `its first invoice was for ${made.invoiceTotal}p, not ${pence(membership.first_invoice)}p`
  }
  if (made.periodStart === null || made.periodEnd === null) return 'it has no billing period'
  return null
}

export interface SubscriptionRequest {
  orderId: string
  customerId: string
  stripeCustomerId: string
  /** The card its renewals are charged to: the saved card, or the reusable card the reader's tap left. */
  paymentMethodId: string
  membership: PendingMembership
}

export type SubscriptionAnswer =
  | { outcome: 'made'; subscription: MadeSubscription }
  /** Stripe made one, but not what was asked: it must be cancelled and its money refunded. */
  | { outcome: 'wrong'; subscription: MadeSubscription; detail: string }
  /** Nothing was made and nothing taken. `reason` and `message` are the old route's, where it had them. */
  | { outcome: 'definite'; reason: string; message: string; detail: string }
  /** No clear answer: a subscription may exist (and may have charged its first invoice). Never undone here. */
  | { outcome: 'unknown'; detail: string }

/** The subscription's request, built only from the order and its pending record, so every send is identical. */
export function subscriptionRequest(request: SubscriptionRequest): Stripe.SubscriptionCreateParams {
  const { membership } = request
  return {
    customer: request.stripeCustomerId,
    items: [{ price: membership.stripe_price_id }],
    default_payment_method: request.paymentMethodId,
    ...(membership.coupon_amount > 0 ? { discounts: [{ coupon: couponId(request.orderId) }] } : {}),
    off_session: true,
    payment_behavior: 'error_if_incomplete',
    metadata: {
      supabase_customer_id: request.customerId,
      membership_plan_id: membership.plan_id,
      billing_frequency: membership.billing_frequency,
      order_id: request.orderId,
    },
    expand: ['latest_invoice.payments'],
  }
}

/** The coupon's request: the fixed id, so a retry is the same request (bug 13). */
export function couponRequest(request: SubscriptionRequest): Stripe.CouponCreateParams {
  return {
    id: couponId(request.orderId),
    amount_off: pence(request.membership.coupon_amount),
    currency: 'gbp',
    duration: 'once',
    name: request.membership.coupon_name.slice(0, 40),
    metadata: { supabase_customer_id: request.customerId, membership_plan_id: request.membership.plan_id, order_id: request.orderId },
  }
}

/**
 * The legacy route's steps, in its order: the card as the Stripe customer's invoice default, the
 * first-invoice coupon (when the gift card, store credit, the promo or the reader's tap pay part or all of
 * the first payment), then the subscription, charging the first invoice off-session at once
 * (`error_if_incomplete`).
 *
 * - The default card and the coupon move no money, so any failure there refuses the order (nothing
 *   taken), with the old route's words. The coupon is sent twice at most, with the same key.
 * - The subscription is sent at most twice, with the same key and the same request: a card error is
 *   definite (the old route's `payment_failed`: nothing was made), an invalid request too (`unexpected`,
 *   Stripe's own words), and a refused key on the first send (W10a). Anything else may have made it: unknown.
 * - Every call gets what is left before the press's deadline, and none is sent with too little left: not
 *   sending is always safe (before the subscription, nothing is taken; the subscription unsent is definite).
 */
export async function startSubscription(stripe: StripeClient, request: SubscriptionRequest, timing: StripeTiming | undefined): Promise<SubscriptionAnswer> {
  const { orderId, membership } = request
  try {
    await stripe.customers.update(request.stripeCustomerId, { invoice_settings: { default_payment_method: request.paymentMethodId } }, sendOptions(timing))
  } catch (err) {
    return { outcome: 'definite', reason: 'membership_subscription_failed', message: accessRefused(err) ? MEMBERSHIP_STRIPE_REFUSED_MESSAGE : DEFAULT_CARD_FAILED_MESSAGE, detail: unclearOf(err) }
  }

  if (membership.coupon_amount > 0) {
    const key = stripeIdempotencyKey(orderId, 'coupon')
    let made = false
    let last = ''
    for (let attempt = 1; attempt <= 2 && !made; attempt += 1) {
      try {
        await stripe.coupons.create(couponRequest(request), sendOptions(timing, { idempotencyKey: key }))
        made = true
      } catch (err) {
        const failure = readStripeFailure(err)
        // After 24 hours Stripe may forget the key; the fixed id is then what says it was made.
        if (failure.code === 'resource_already_exists') made = true
        else if (failure.outcome === 'definite' || accessRefused(err) || err instanceof NoTimeLeft) {
          return { outcome: 'definite', reason: 'membership_subscription_failed', message: accessRefused(err) ? MEMBERSHIP_STRIPE_REFUSED_MESSAGE : COUPON_FAILED_MESSAGE, detail: unclearOf(err) }
        } else last = failure.message
      }
    }
    // A coupon moves no money: still unclear after two sends, the order is refused with nothing taken.
    if (!made) return { outcome: 'definite', reason: 'membership_subscription_failed', message: COUPON_FAILED_MESSAGE, detail: last }
  }

  const key = stripeIdempotencyKey(orderId, 'subscription')
  const params = subscriptionRequest(request)
  let last = ''
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let options: Stripe.RequestOptions
    try {
      options = sendOptions(timing, { idempotencyKey: key })
    } catch (err) {
      // Not sent: on the first send nothing can exist; on the second the first's answer is still unknown.
      if (attempt === 1) return { outcome: 'definite', reason: 'membership_subscription_failed', message: PRICE_NOT_VERIFIED_MESSAGE.replace('verify Stripe price', 'start the subscription in time'), detail: message(err) }
      return { outcome: 'unknown', detail: `${last} (${message(err)})` }
    }
    try {
      const subscription = madeSubscription(await stripe.subscriptions.create(params, options))
      const wrong = subscriptionMismatch(subscription, orderId, request.stripeCustomerId, membership)
      return wrong ? { outcome: 'wrong', subscription, detail: wrong } : { outcome: 'made', subscription }
    } catch (err) {
      const failure = readStripeFailure(err)
      if (accessRefused(err) && attempt === 1) {
        return { outcome: 'definite', reason: 'membership_subscription_failed', message: MEMBERSHIP_STRIPE_REFUSED_MESSAGE, detail: failure.message }
      }
      if (failure.outcome === 'definite') {
        // The old route: only a card failure is a decline; anything else is `unexpected`, with Stripe's words.
        const card = err instanceof Stripe.errors.StripeCardError || failure.code === 'authentication_required'
        return card
          ? { outcome: 'definite', reason: 'membership_payment_failed', message: '', detail: failure.message }
          : { outcome: 'definite', reason: 'membership_subscription_failed', message: failure.message, detail: failure.message }
      }
      last = failure.message
    }
  }
  return { outcome: 'unknown', detail: last }
}

/**
 * The coupon, when nothing was made with it: best effort, as the old route did (a coupon holds no money).
 * W13a: under the press's deadline like every other call (it was sent with the client's own 10 s, after the
 * deadline, before the undo); with too little time left it isn't sent, which is harmless.
 */
export async function deleteCouponQuietly(stripe: StripeClient, orderId: string, membership: PendingMembership, timing: StripeTiming | undefined): Promise<void> {
  if (membership.coupon_amount <= 0) return
  try {
    await stripe.coupons.del(couponId(orderId), undefined, sendOptions(timing))
  } catch {
    // Harmless: a one-off coupon nobody can use without the order.
  }
}

// --- 3. Cancelling a subscription, checked (bug 10)

export type CancelAnswer =
  | { kind: 'cancelled' }
  /** Stripe said no, and it is still live (or can't be found with this key): a person must look. */
  | { kind: 'refused'; message: string }
  /** No clear answer, and reading it back didn't settle it: never assumed cancelled. */
  | { kind: 'unclear'; message: string }

/**
 * Cancels a subscription and makes sure: a cancel Stripe answered is done; a cancel that failed or got no
 * answer is followed by a read, and only `canceled` counts. No key: a cancel is a DELETE, and Stripe ignores
 * keys on DELETE ("it has no effect", Stripe's API reference), so a repeat is safe and the read decides.
 */
export async function cancelSubscriptionChecked(stripe: StripeClient, subscriptionId: string, timing: StripeTiming | undefined): Promise<CancelAnswer> {
  let cancelError: unknown
  try {
    await stripe.subscriptions.cancel(subscriptionId, undefined, sendOptions(timing))
    return { kind: 'cancelled' }
  } catch (err) {
    cancelError = err
  }
  try {
    const now = await stripe.subscriptions.retrieve(subscriptionId, undefined, sendOptions(timing))
    if (now.status === 'canceled') return { kind: 'cancelled' }
    const failure = readStripeFailure(cancelError)
    return failure.outcome === 'definite' && !(cancelError instanceof NoTimeLeft)
      ? { kind: 'refused', message: failure.message }
      : { kind: 'unclear', message: unclearOf(cancelError) }
  } catch (err) {
    const failure = readStripeFailure(err)
    if (failure.code === 'resource_missing') return { kind: 'refused', message: `Stripe can't find subscription ${subscriptionId} with the key in use.` }
    return { kind: 'unclear', message: unclearOf(cancelError) }
  }
}

// --- 4. Compensation (W11 review L3: a definite failure after the subscription or the payment exists)

export type RefundStep = 'refund-charge' | 'refund-subscription' | 'refund-reader'

/** What the order took that must go back, each by the step that took it. */
export interface Taken {
  /** The order's new subscription, to cancel: null when none was made. */
  subscriptionId: string | null
  refunds: Array<{ step: RefundStep; paymentIntentId: string }>
}

export type CompensationOutcome =
  /** Cancelled, refunded, and the order undone: nothing taken is kept, nothing held. */
  | { settled: true; undo: UndoOutcome; refunded: Array<{ step: RefundStep; paymentIntentId: string; refundId: string | null; amount: number | null }> }
  /**
   * Something couldn't be confirmed: the order stays pending (marked, unless the mark wasn't written), for
   * reconcile to finish. `starting` (W13a B1): not marked, because a press is starting the order's subscription
   * right now; reconcile looks again on its next run.
   */
  | { settled: false; left: string[]; starting?: true }

/** What Stripe's list shows of an order's subscriptions (findOrderSubscriptions). */
export type FoundSubscriptions = { kind: 'found'; subscriptions: MadeSubscription[] } | { kind: 'unclear'; detail: string }

export interface CompensationOptions {
  actor: { type: 'staff' | 'customer' | 'system'; id: string | null }
  requestId: string
  /**
   * W13a (B1): no subscription is known for the order (a reader membership whose tap alone is to be refunded),
   * though a press of the screen's finalise may be making one. The mark then waits while another press's
   * start (`membership.subscription_started_at`) is younger than SUBSCRIPTION_START_GUARD_SECONDS (`press` is
   * this press's own start, which never holds it up), and once the mark is on, Stripe is listed again for the
   * order's subscription (`relist`) whenever a start was ever written, so one made before the mark is cancelled
   * with the rest. Nothing can start one after the mark: the start's write refuses a marked order.
   */
  noSubscriptionFound?: {
    press: string | null
    relist: () => Promise<FoundSubscriptions>
    /**
     * W13c (decision "W13c call"): this press's start replaced another press's expired start (over
     * SUBSCRIPTION_START_GUARD_SECONDS old: a press that died, maybe after Stripe made its subscription). Stripe is
     * then listed again after the mark even though the start on the order is this press's own.
     */
    replacedStart?: boolean
  }
}

/**
 * W13a (B1): how long a press's start of a reader membership's subscription holds off a compensation that found
 * no subscription. Longer than any press can run (Retool waits 60 s; a finalise's Stripe calls end by 25 s and
 * its T2 by about 45 s), with room, so once it has passed the press that wrote it has made its subscription
 * (Stripe lists it) or never will.
 */
export const SUBSCRIPTION_START_GUARD_SECONDS = 120

export type StartAnswer =
  /** Written. `replaced`: it took the place of another press's start that had expired (W13c). */
  | { kind: 'started'; replaced: boolean }
  /** W13c (B1): refused, because another press's start is younger than SUBSCRIPTION_START_GUARD_SECONDS. */
  | { kind: 'starting' }
  /** Refused: the order is gone, paid, carrying the compensation mark, or the old rollback's. */
  | { kind: 'not_pending' }

/**
 * W13a (B1, part a): the screen's finalise of a reader membership writes its start before it asks Stripe for the
 * subscription: `membership.subscription_started_at` (the database's clock) and `subscription_started_by` (this
 * press). Only on a pending order with no compensation mark and no old rollback: the mark and this write lock the
 * same row, so one of them goes first and the other sees it. Refused there, the order is being compensated (or is
 * no longer pending), so no subscription may be made.
 *
 * W13c (W13a review B1, variant A): one press at a time. Also refused while another press's start is younger than
 * SUBSCRIPTION_START_GUARD_SECONDS, so a second press (Cancel finalising instead, say) can't take the first press's
 * place and then compensate under its own start while the first is still making the subscription. One statement:
 * the order's row is locked first, so what decides is the row as it is now. In a transaction, so the server's 5 s
 * lock and 8 s statement limits bound it.
 */
export async function markSubscriptionStarting(db: Db, orderId: string, press: string): Promise<StartAnswer> {
  const rows = await db.transaction((tx) =>
    tx.query<{ started: number; open: boolean; previous_by: string | null }>(
      `WITH locked AS (
         SELECT id, payment_status, reader_payment FROM orders WHERE id = $1::uuid FOR UPDATE
       ),
       open AS (
         SELECT id, reader_payment FROM locked
         WHERE payment_status = 'pending' AND reader_payment ? 'membership'
           AND (reader_payment->'rollback') IS NULL AND NOT reader_payment ? 'compensation'
       ),
       allowed AS (
         SELECT id, reader_payment FROM open
         WHERE (reader_payment->'membership'->>'subscription_started_at') IS NULL
            OR reader_payment->'membership'->>'subscription_started_by' = $2::text
            OR (reader_payment->'membership'->>'subscription_started_at')::timestamptz <= now() - make_interval(secs => $3::int)
       ),
       started AS (
         UPDATE orders o
         SET reader_payment = jsonb_set(a.reader_payment, '{membership}',
               (a.reader_payment->'membership') || jsonb_build_object('subscription_started_at', now(), 'subscription_started_by', $2::text)),
             updated_at = now()
         FROM allowed a
         WHERE o.id = a.id
         RETURNING o.id
       )
       SELECT (SELECT count(*)::int FROM started) AS started,
              EXISTS (SELECT 1 FROM open) AS open,
              (SELECT reader_payment->'membership'->>'subscription_started_by' FROM open) AS previous_by`,
      [orderId, press, SUBSCRIPTION_START_GUARD_SECONDS]
    )
  )
  const row = rows[0]
  if (row?.started === 1) return { kind: 'started', replaced: row.previous_by !== null && row.previous_by !== press }
  return row?.open === true ? { kind: 'starting' } : { kind: 'not_pending' }
}

export type MarkAnswer =
  /** The order carries the mark now (this call's or an earlier one's), with the subscription's start it carried, if any. */
  | { marked: true; startedAt: string | null; startedBy: string | null }
  /** `starting`: held off by another press's start (W13a B1). `not_pending`: gone, paid, or the old rollback's. */
  | { marked: false; why: 'starting' | 'not_pending' }

/**
 * The compensation mark (pending-order.ts, `compensation`), written and committed before anything is
 * reversed, once: T2 refuses an order carrying it, so a refunded payment (which still reads `succeeded`)
 * can never be finalised. Only on a pending order the old rollback hasn't started on.
 *
 * W13a (B1, part b): with `guard`, not while another press's start of the subscription is younger than
 * SUBSCRIPTION_START_GUARD_SECONDS (a start by `guard.press` itself doesn't count). One statement: the order's
 * row is locked first, so what decides is the row as it is now, after any start that was being written.
 * W13a (S3): in a transaction, so the server's 5 s lock and 8 s statement limits bound it (it was a bare query,
 * bound only by the client's 10 s).
 */
export async function markCompensating(db: Db, orderId: string, why: string, guard?: { press: string | null }): Promise<MarkAnswer> {
  const rows = await db.transaction((tx) =>
    tx.query<{ marked: number; pending: boolean; started_at: string | null; started_by: string | null }>(
      `WITH locked AS (
         SELECT id, payment_status, reader_payment FROM orders WHERE id = $1::uuid FOR UPDATE
       ),
       allowed AS (
         SELECT id, reader_payment FROM locked
         WHERE payment_status = 'pending' AND reader_payment IS NOT NULL AND (reader_payment->'rollback') IS NULL
           AND (reader_payment ? 'compensation' OR NOT $3::boolean
                OR (reader_payment->'membership'->>'subscription_started_at') IS NULL
                OR reader_payment->'membership'->>'subscription_started_by' = $4::text
                OR (reader_payment->'membership'->>'subscription_started_at')::timestamptz <= now() - make_interval(secs => $5::int))
       ),
       marked AS (
         UPDATE orders o
         SET reader_payment = CASE WHEN a.reader_payment ? 'compensation' THEN a.reader_payment
                                   ELSE a.reader_payment || jsonb_build_object('compensation', jsonb_build_object('why', $2::text, 'started_at', now())) END,
             updated_at = now()
         FROM allowed a
         WHERE o.id = a.id
         RETURNING o.id
       )
       SELECT (SELECT count(*)::int FROM marked) AS marked,
              (l.payment_status = 'pending' AND l.reader_payment IS NOT NULL AND (l.reader_payment->'rollback') IS NULL) AS pending,
              l.reader_payment->'membership'->>'subscription_started_at' AS started_at,
              l.reader_payment->'membership'->>'subscription_started_by' AS started_by
       FROM locked l`,
      [orderId, why, guard !== undefined, guard?.press ?? null, SUBSCRIPTION_START_GUARD_SECONDS]
    )
  )
  const row = rows[0]
  if (row?.marked === 1) return { marked: true, startedAt: row.started_at, startedBy: row.started_by }
  return { marked: false, why: guard !== undefined && row?.pending === true ? 'starting' : 'not_pending' }
}

/** Refunds one payment in full, once, under its key. Pending at Stripe counts as sent (Stripe has accepted it). */
export async function refundOnce(
  stripe: StripeClient,
  orderId: string,
  refund: { step: RefundStep; paymentIntentId: string },
  timing: StripeTiming | undefined
): Promise<{ ok: true; refundId: string | null; amount: number | null } | { ok: false; left: string; definite: boolean }> {
  const key = stripeIdempotencyKey(orderId, refund.step)
  let last = ''
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const made = await stripe.refunds.create(
        { payment_intent: refund.paymentIntentId, metadata: { order_id: orderId, refund_key: key, reason: 'membership_not_set_up' } },
        sendOptions(timing, { idempotencyKey: key })
      )
      if (made.status === 'failed' || made.status === 'canceled') return { ok: false, left: `${refund.step} ${refund.paymentIntentId}: Stripe's refund ${made.id} ${made.status}`, definite: true }
      return { ok: true, refundId: made.id, amount: made.amount }
    } catch (err) {
      const failure = readStripeFailure(err)
      // Refunded already (an earlier send whose key Stripe has since forgotten, or by hand): nothing is owed.
      if (failure.code === 'charge_already_refunded') return { ok: true, refundId: null, amount: null }
      if (err instanceof NoTimeLeft) return { ok: false, left: `${refund.step} ${refund.paymentIntentId}: not sent (${err.message})`, definite: false }
      // W14b (W13c review L4): Stripe's own refusal is definite (sending it again meets the same); a refused key isn't
      // (it is fixed in the settings, and the run stops at it anyway).
      if (failure.outcome === 'definite' || accessRefused(err)) return { ok: false, left: `${refund.step} ${refund.paymentIntentId}: refused (${failure.message})`, definite: !accessRefused(err) }
      last = failure.message
    }
  }
  return { ok: false, left: `${refund.step} ${refund.paymentIntentId}: no clear answer (${last})`, definite: false }
}

/** A subscription's first invoice, to refund, when it took money. */
const invoiceRefund = (subscription: MadeSubscription): Array<{ step: RefundStep; paymentIntentId: string }> =>
  subscription.invoicePaymentIntentId && subscription.amountPaid > 0 ? [{ step: 'refund-subscription', paymentIntentId: subscription.invoicePaymentIntentId }] : []

/**
 * Puts back everything a membership order took, then undoes it (W11 review L3, bug 10):
 * 1. the mark, before anything is reversed (only with time left to reverse anything: otherwise reconcile
 *    starts it, with no Retool limit to meet); with `noSubscriptionFound`, held off while another press is
 *    starting the subscription, and Stripe listed again once it is on (W13a B1);
 * 2. the order's new subscription cancelled, and checked (an unclear or refused cancel is never assumed);
 * 3. each payment refunded in full, under `<orderId>:refund-charge`, `:refund-subscription` or
 *    `:refund-reader`, each answer checked;
 * 4. only when every step is confirmed, the one undo (which then removes the mark with the order), with
 *    `order.compensate` beside `order.undo`.
 * Anything not confirmed leaves the order pending and marked, with an `order.compensate` row saying what is
 * left (`held`, with `definite`: whether every step left is Stripe's definite refusal, W14c); reconcile sends the
 * same steps again under the same keys. W13a (S3): a mark that returns with too little
 * time left to send anything to Stripe ends there, held, with no row (reconcile records its own when it finishes),
 * so the press ends inside its bound. Never throws for Stripe; a database fault on the mark or the undo is
 * thrown, and the order is still pending for reconcile.
 */
export async function compensateOrder(
  db: Db,
  stripe: StripeClient,
  orderId: string,
  taken: Taken,
  why: string,
  options: CompensationOptions,
  timing: StripeTiming | undefined
): Promise<CompensationOutcome> {
  const noTimeLeft = (): boolean => timing !== undefined && timing.deadline - timing.now() < MIN_SEND_MS
  if (noTimeLeft()) return { settled: false, left: ['not started: no time left before the deadline'] }
  const guard = options.noSubscriptionFound
  const mark = await markCompensating(db, orderId, why, guard ? { press: guard.press } : undefined)
  if (!mark.marked) {
    return mark.why === 'starting'
      ? { settled: false, starting: true, left: ['not started: a press is starting the subscription; reconcile looks again on its next run'] }
      : { settled: false, left: ['the order is no longer pending, so nothing was reversed'] }
  }
  if (noTimeLeft()) return { settled: false, left: ['marked, but the mark took the time left before the deadline: reconcile finishes it'] }

  const left: string[] = []
  // W14c (W14b review S1): whether every step in `left` is Stripe's definite refusal (a cancel `refused`, a refund
  // `definite`). Anything else (no clear answer, not listed, more than one live) the next reconcile can still finish.
  let allDefinite = true
  const work: Taken = { subscriptionId: taken.subscriptionId, refunds: [...taken.refunds] }
  // B1: a press started the subscription (not this one, or W13c: this one in place of an expired start): list
  // Stripe again now the mark stops any more.
  if (guard && taken.subscriptionId === null && mark.startedAt !== null && (mark.startedBy !== guard.press || guard.replacedStart === true)) {
    const listed = await guard.relist()
    if (listed.kind === 'unclear') {
      left.push(`subscriptions: not listed (${listed.detail})`)
      allDefinite = false
    } else {
      const live = listed.subscriptions.filter((subscription) => subscription.status !== 'canceled')
      if (live.length > 1) {
        left.push(`subscriptions: more than one live (${live.map((subscription) => subscription.id).join(', ')})`)
        allDefinite = false
      }
      for (const subscription of listed.subscriptions) {
        for (const refund of invoiceRefund(subscription)) if (!work.refunds.some((r) => r.paymentIntentId === refund.paymentIntentId)) work.refunds.push(refund)
      }
      if (live.length === 1) work.subscriptionId = live[0]?.id ?? null
    }
  }

  if (work.subscriptionId) {
    const cancelled = await cancelSubscriptionChecked(stripe, work.subscriptionId, timing)
    if (cancelled.kind !== 'cancelled') {
      left.push(`subscription ${work.subscriptionId}: ${cancelled.kind} (${cancelled.message})`)
      if (cancelled.kind !== 'refused') allDefinite = false
    }
  }
  const refunded: Array<{ step: RefundStep; paymentIntentId: string; refundId: string | null; amount: number | null }> = []
  for (const refund of work.refunds) {
    const done = await refundOnce(stripe, orderId, refund, timing)
    if (done.ok) refunded.push({ ...refund, refundId: done.refundId, amount: done.amount })
    else {
      left.push(done.left)
      if (!done.definite) allDefinite = false
    }
  }

  const details = { why, subscriptionId: work.subscriptionId, refunded, ...(left.length > 0 ? { left } : {}) }
  if (left.length > 0) {
    // `definite` (W14c, S1): only then may a person close the order by hand (close-stuck.ts); otherwise reconcile
    // finishes it on a later run, whatever a person has done in Stripe meanwhile.
    await db.transaction((tx) =>
      audit.recordAll(tx, [
        { actorType: options.actor.type, actorId: options.actor.id, action: 'order.compensate', entityType: 'order', entityId: orderId, requestId: options.requestId, details: { state: 'held', definite: allDefinite, ...details } },
      ])
    )
    return { settled: false, left }
  }
  const undo = await undoOrder(db, orderId, { actor: options.actor, requestId: options.requestId, why, compensated: { state: 'done', ...details } })
  return { settled: true, undo, refunded }
}

/** W13a (B1, part c): the row naming a subscription made for an order that was gone or being compensated. */
export const SUBSCRIPTION_LEFT_ACTION = 'order.subscription_left'

/**
 * What T2 found that leaves a subscription the caller made with no order to pay (W13a: gone or marked; W13d, W13c
 * review S-1: also the old rollback's, paid with another payment, or otherwise not pending). The order can't be paid
 * with that subscription on any of them, so T2 records it as left and the caller puts it back.
 */
export type SubscriptionPutBackReason = 'order_gone' | 'compensating' | 'rollback_started' | 'paid_by_another_payment' | 'not_pending'

const SUBSCRIPTION_PUT_BACK_REASONS: ReadonlySet<string> = new Set<SubscriptionPutBackReason>(['order_gone', 'compensating', 'rollback_started', 'paid_by_another_payment', 'not_pending'])

/** T2's answer is one on which a subscription the caller made is put back. */
export const isPutBackReason = (reason: string): reason is SubscriptionPutBackReason => SUBSCRIPTION_PUT_BACK_REASONS.has(reason)

/** Why a subscription was left: what T2 found (W13a, W13d), or reconcile putting back a left one (W13c, L3). */
export type SubscriptionLeftFound = SubscriptionPutBackReason | 'reconcile'

/**
 * One `order.subscription_left` row. `left` (with what isn't confirmed yet) is listed by the stuck list until a
 * later row for the same subscription says `cancelled`, or the order's compensation is done with it. The row carries
 * what a later put-back needs (the subscription, its first invoice's PaymentIntent and what that took), so reconcile
 * can retry it from the row alone (W13c, L3).
 */
export function subscriptionLeftEntry(
  actor: CompensationOptions['actor'],
  requestId: string,
  orderId: string,
  subscription: Pick<MadeSubscription, 'id' | 'invoicePaymentIntentId' | 'amountPaid'>,
  found: SubscriptionLeftFound,
  refunded: Array<{ paymentIntentId: string; refundId: string | null }>,
  left: string[],
  /** W14b (W13c review L4): `refused`: Stripe refused a step for good, so reconcile stops retrying it (listed until closed). */
  refused = false
): AuditEntry {
  return {
    actorType: actor.type,
    actorId: actor.id,
    action: SUBSCRIPTION_LEFT_ACTION,
    entityType: 'order',
    entityId: orderId,
    requestId,
    details: {
      state: left.length === 0 ? 'cancelled' : refused ? 'refused' : 'left',
      subscriptionId: subscription.id,
      invoicePaymentIntentId: subscription.invoicePaymentIntentId,
      amountPaid: subscription.amountPaid,
      found,
      refunded,
      ...(left.length > 0 ? { left } : {}),
    },
  }
}

/**
 * W13c (S1b): what T2 records, in its own transaction, when it finds the order gone or marked and the caller's press
 * made the subscription: the subscription as `left`, not yet put back. W13d: also on the other answers that leave it
 * with no order to pay (SubscriptionPutBackReason). So nothing need be written after T2 when the
 * press's window has closed; with time left, putBackSubscription then cancels it and writes `cancelled`.
 */
export const LEFT_AT_T2 = 'not put back yet: T2 found the order gone, being put back, or not payable with it'

/**
 * W13a (B1, part c): the screen's finalise made the order's subscription, then T2 found the order gone (undone)
 * or carrying the compensation mark. Defence in depth (parts a and b keep reconcile from compensating while a
 * press is starting it): the subscription is cancelled (checked) and its first invoice refunded under
 * `<orderId>:refund-subscription`, at once, under the press's deadline. One `order.subscription_left` row names
 * it: `cancelled`, or `left` with what couldn't be confirmed, which the stuck list shows until the subscription is
 * put back (a later row says so, or the order's compensation cancels it). One statement after Stripe (8 s).
 *
 * W13c (W13a review S1): T2 has already recorded the subscription as `left` in its own transaction, so with too
 * little time left to send anything (under MIN_SEND_MS before the deadline) this does nothing at all: no Stripe call
 * and no row, so nothing is written after T2 once the window has closed. Reconcile retries the left row (L3).
 *
 * W13d (W13c review S-1): also run when T2 found the old rollback's, paid with another payment, or not pending. Only
 * this subscription and its own first invoice are touched (`:refund-subscription`); the order's other money is the
 * old rollback's, the paying payment's, or (gone) the late refund's.
 */
export async function putBackSubscription(
  db: Db,
  stripe: StripeClient,
  orderId: string,
  subscription: MadeSubscription,
  found: SubscriptionPutBackReason,
  options: CompensationOptions,
  timing: StripeTiming | undefined
): Promise<{ cancelled: boolean; left: string[] }> {
  if (timing !== undefined && timing.deadline - timing.now() < MIN_SEND_MS) {
    return { cancelled: false, left: [`not sent: no time left before the deadline (T2's row names ${subscription.id})`] }
  }
  const left: string[] = []
  const cancelled = await cancelSubscriptionChecked(stripe, subscription.id, timing)
  if (cancelled.kind !== 'cancelled') left.push(`subscription ${subscription.id}: ${cancelled.kind} (${cancelled.message})`)
  const refunded: Array<{ paymentIntentId: string; refundId: string | null }> = []
  for (const refund of invoiceRefund(subscription)) {
    const done = await refundOnce(stripe, orderId, refund, timing)
    if (done.ok) refunded.push({ paymentIntentId: refund.paymentIntentId, refundId: done.refundId })
    else left.push(done.left)
  }
  await db.transaction((tx) => audit.recordAll(tx, [subscriptionLeftEntry(options.actor, options.requestId, orderId, subscription, found, refunded, left)]))
  return { cancelled: cancelled.kind === 'cancelled', left }
}

/** A subscription left live, as its last `left` row names it (reconcile's L3 retry). */
export interface LeftSubscription {
  orderId: string
  subscriptionId: string
  invoicePaymentIntentId: string | null
  amountPaid: number | null
}

export type RetriedPutBack =
  | { kind: 'cancelled'; refunded: Array<{ paymentIntentId: string; refundId: string | null }> }
  /** Not confirmed yet: the row stays open, and the next run tries again. */
  | { kind: 'left'; left: string[] }
  /**
   * W14b (W13c review L4): Stripe refused a step for good (the cancel, or the refund: a disputed payment, say). A
   * `refused` row is written: still listed for a person, never retried (the manual close records it as sorted).
   */
  | { kind: 'refused'; left: string[] }
  /** Stripe's subscription doesn't name this order: nothing is sent, for a person to look at. W14b: a `refused` row, not retried. */
  | { kind: 'not_this_order'; detail: string }

/**
 * W13c (W13a review L3, first part): reconcile's retry of a subscription a press left live (`left`). Stripe's
 * subscription is read first, and nothing is sent unless it names this order (`metadata.order_id`). Then, as the
 * put-back does: cancelled, checked (skipped when Stripe already shows it cancelled); its first invoice refunded under
 * `<orderId>:refund-subscription`, with the compensation's parameters, so a refund already made under the key is
 * Stripe's same refund, never a second one (and once the key is forgotten, `charge_already_refunded` counts as done);
 * then one `cancelled` row, which closes the stuck list's warning. Only the first invoice the row names is refunded,
 * and only when it took money.
 */
export async function retryLeftSubscription(
  db: Db,
  stripe: StripeClient,
  row: LeftSubscription,
  options: CompensationOptions,
  timing: StripeTiming | undefined
): Promise<RetriedPutBack> {
  let now: Stripe.Subscription
  try {
    now = await stripe.subscriptions.retrieve(row.subscriptionId, undefined, sendOptions(timing))
  } catch (err) {
    return { kind: 'left', left: [`subscription ${row.subscriptionId}: not read (${unclearOf(err)})`] }
  }
  const subscription = { id: row.subscriptionId, invoicePaymentIntentId: row.invoicePaymentIntentId, amountPaid: row.amountPaid ?? 0 }
  const refusedRow = (left: string[], refunded: Array<{ paymentIntentId: string; refundId: string | null }>) =>
    db.transaction((tx) => audit.recordAll(tx, [subscriptionLeftEntry(options.actor, options.requestId, row.orderId, subscription, 'reconcile', refunded, left, true)]))
  if (now.metadata?.['order_id'] !== row.orderId) {
    const detail = `subscription ${row.subscriptionId} names order ${now.metadata?.['order_id'] ?? 'none'}, not ${row.orderId}`
    await refusedRow([detail], [])
    return { kind: 'not_this_order', detail }
  }
  const left: string[] = []
  let definite = false
  if (now.status !== 'canceled') {
    const cancelled = await cancelSubscriptionChecked(stripe, row.subscriptionId, timing)
    if (cancelled.kind !== 'cancelled') left.push(`subscription ${row.subscriptionId}: ${cancelled.kind} (${cancelled.message})`)
    if (cancelled.kind === 'refused') definite = true
  }
  const refunded: Array<{ paymentIntentId: string; refundId: string | null }> = []
  // As the put-back: refunded whether or not the cancel is confirmed (no membership will ever be kept for it). A row
  // with no `amountPaid` (none is written without one from W13c) is refunded if it names a PaymentIntent.
  if (row.invoicePaymentIntentId && (row.amountPaid === null || row.amountPaid > 0)) {
    const done = await refundOnce(stripe, row.orderId, { step: 'refund-subscription', paymentIntentId: row.invoicePaymentIntentId }, timing)
    if (done.ok) refunded.push({ paymentIntentId: row.invoicePaymentIntentId, refundId: done.refundId })
    else {
      left.push(done.left)
      if (done.definite) definite = true
    }
  }
  if (left.length > 0 && definite) {
    await refusedRow(left, refunded)
    return { kind: 'refused', left }
  }
  if (left.length > 0) return { kind: 'left', left }
  await db.transaction((tx) => audit.recordAll(tx, [subscriptionLeftEntry(options.actor, options.requestId, row.orderId, subscription, 'reconcile', refunded, [])]))
  return { kind: 'cancelled', refunded }
}

/**
 * The old words added to a refusal once a subscription had been made and put back (createOrder's
 * membershipAwareFailure, once its compensation had run and said so).
 */
export const COMPENSATED_NOTE = 'The membership subscription was cancelled and its card-charged first payment refunded automatically — no membership or order was kept.'

// --- 5. Finding an order's subscription (reconcile: list, never search, W03-plan 2.5)

const SUBSCRIPTION_PAGE = 100
const SUBSCRIPTION_MOST_PAGES = 10

/**
 * The customer's subscriptions naming the order (`metadata.order_id`), cancelled ones included (`status:
 * 'all'`: Stripe's default list leaves them out), each with its first invoice. Every page is read (up to
 * 1,000; more is answered unclear). Only the key's own mode is listed, so "none" counts as "never made" only
 * when the order's record is of the key's mode (the caller checks).
 */
export async function findOrderSubscriptions(
  stripe: StripeClient,
  timing: StripeTiming | undefined,
  customer: string | null,
  orderId: string
): Promise<FoundSubscriptions> {
  if (!customer) return { kind: 'found', subscriptions: [] }
  const found: MadeSubscription[] = []
  let startingAfter: string | undefined
  try {
    for (let page = 0; page < SUBSCRIPTION_MOST_PAGES; page++) {
      const listed = await stripe.subscriptions.list(
        { customer, status: 'all', limit: SUBSCRIPTION_PAGE, expand: ['data.latest_invoice.payments'], ...(startingAfter ? { starting_after: startingAfter } : {}) },
        sendOptions(timing)
      )
      found.push(...listed.data.filter((subscription) => subscription.metadata?.['order_id'] === orderId).map(madeSubscription))
      const last = listed.data.at(-1)
      if (!listed.has_more || !last) return { kind: 'found', subscriptions: found }
      startingAfter = last.id
    }
  } catch (err) {
    return { kind: 'unclear', detail: unclearOf(err) }
  }
  return { kind: 'unclear', detail: `more than ${SUBSCRIPTION_PAGE * SUBSCRIPTION_MOST_PAGES} subscriptions to look through` }
}
