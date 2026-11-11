// Ported from backend/paddock/createOrder.ts (stage 32, the saved-card charge), chargeSavedCard.ts and
// app/api/payments/charge-saved-card/core.ts: the charge itself, now with its key and the order's id on
// it (checklist 3, W5-15), and Stripe's answers read as W03-plan 2.5 says (new in W10).
import 'server-only'
import Stripe from 'stripe'
import type { Db } from '@/server/db'
import { stripeIdempotencyKey } from '@/server/http/idempotency'
import type { StripeClient } from '@/server/stripe/client'
import { ORDER_STRIPE_LIMITS } from '@/server/stripe/limits'
import { ensureStripeCustomer } from '@/server/stripe/customer'
import { readStripeFailure } from '@/server/stripe/outcome'
import type { CardSnapshot } from './pending-order'

/** The old route's words for a card that needs the customer present (charge-saved-card/core.ts). */
export const AUTHENTICATION_NEEDED_MESSAGE =
  'Card requires additional authentication and cannot be charged off-session. Ask the customer to complete a new payment.'

/**
 * W10a: Stripe refused the Worker's own key (401) or what the key may do (403). Stripe did nothing,
 * so it is definite, and the order is undone; staff can't fix it at the till, so the words say who can.
 */
export const STRIPE_ACCESS_REFUSED_MESSAGE =
  "The card wasn't charged: Stripe turned down the club's payment account details, so nothing was taken and the order wasn't placed. Tell a manager so the Stripe connection can be fixed, and take payment another way for now."

/** The old route's words for any other refusal, with Stripe's own after them. */
export const chargeFailedMessage = (stripeMessage: string): string => `Failed to charge saved card: ${stripeMessage}`

export type ChargeAnswer =
  /** Stripe answered with a PaymentIntent. T2 checks it before the order is paid. */
  | { outcome: 'answered'; paymentIntent: Stripe.PaymentIntent; attempts: number }
  /** Stripe said no: nothing was taken, so the order is undone. `message` is what the old route said. */
  | { outcome: 'definite'; needsAuthentication: boolean; message: string; stripeCode: string | null; attempts: number }
  /**
   * No clear answer, twice, or once with no time left for the second send: the money may have moved.
   * Never undone; reconcile decides (W12).
   */
  | { outcome: 'unknown'; detail: string; stripeCode: string | null; attempts: number }

export interface PendingCharge {
  orderId: string
  customerId: string
  snapshot: CardSnapshot
}

/** Pence, as the old route sent them. */
export const pence = (pounds: number): number => Math.round(pounds * 100)

/**
 * The PaymentIntent's request, built only from the order's id and its snapshot, so every attempt (the
 * retry here, or reconcile's later) sends exactly the same request under the same key. Stripe refuses
 * a key reused with different parameters.
 */
export function chargeRequest(charge: PendingCharge, stripeCustomerId: string): Stripe.PaymentIntentCreateParams {
  return {
    amount: pence(charge.snapshot.expected_amount),
    currency: 'gbp',
    customer: stripeCustomerId,
    payment_method: charge.snapshot.payment_method_id,
    off_session: true,
    confirm: true,
    description: charge.snapshot.charge_description,
    metadata: { order_id: charge.orderId },
  }
}

/**
 * The press's time limit (W10a, W10 review S2). Retool gives a function 60 seconds, and the press
 * must end at least 10 seconds inside that, the shadow included, even when T1 meets a deadlock and
 * runs again. So the charge's answer must be in by `COLLECT_DEADLINE_MS` after the request started:
 * the first send always goes, with the client's 10 seconds; the second goes with what is left, at
 * most 10 seconds, and not at all with under `MIN_SEND_MS` left (the order is then held, as any
 * unknown is). Worst case, from the request's start: route and T1 with its deadlock retry ~17.5 s,
 * the first send to ~27.5 s, the second to 30 s at most; then the undo ~13.1 s (or T2 ~5.1 s): ~43.2 s
 * for the Worker, ~49.4 s with Retool's call and the shadow's 6.2 s before it. The shadow's 5 s after
 * the order only runs on a press under 40 s, so it ends by ~45 s.
 */
export const COLLECT_DEADLINE_MS = 30_000
export const MIN_SEND_MS = 2_000

export interface CollectTiming {
  /** When the charge's answer must be in by (ms since the epoch): the request's start + COLLECT_DEADLINE_MS. */
  deadline: number
  /** The clock: Date.now on the route, the test clock in tests. */
  now: () => number
  /**
   * W13: the first send gets only the time left too (and isn't sent with too little), as every other call
   * of a press does. A membership's charge comes after its subscription, so its first send can't always
   * have the client's full 10 seconds and still end inside the deadline. Not sent is definite: nothing taken.
   */
  boundFirstSend?: boolean
}

/** W13: the words when the charge wasn't sent for lack of time (nothing was taken by it). */
export const CHARGE_NOT_SENT_MESSAGE = chargeFailedMessage('there was no time left to ask Stripe, so nothing was charged.')

const accessRefused = (err: unknown): boolean =>
  err instanceof Stripe.errors.StripeAuthenticationError || err instanceof Stripe.errors.StripePermissionError

/**
 * Charges the saved card once, under the key `<orderId>:charge`. Called after T1 has committed the
 * order as pending, outside any transaction.
 *
 * - A PaymentIntent back is Stripe's answer, whatever its status: T2 checks it (succeeded, the amount,
 *   the currency, the order) before anything is marked paid, and leaves the order pending if it doesn't.
 * - A definite failure (a card error, an invalid request) means nothing was taken: the caller undoes
 *   the order and tells staff the old route's words. A 401 or 403 (Stripe refused the Worker's key, or
 *   what it may do) is definite too, with STRIPE_ACCESS_REFUSED_MESSAGE (W10a), on the first send only:
 *   on the retry it can't say whether the first send, which got no clear answer, took the money.
 * - Anything else (a timeout, no connection, a 5xx, the key still in use, an error that isn't Stripe's)
 *   may have taken the money. It is retried once, with the same key and the same request: Stripe
 *   answers a key it has seen with what it answered the first time, so this can't charge twice.
 *   Still unclear: the order stays pending, and is never undone here. With `timing` (the order route),
 *   the second send gets only the time left before the deadline, and isn't sent with too little left.
 *   Without it (reconcile, W12), both sends get the client's own limit.
 */
export async function collectSavedCard(db: Db, stripe: StripeClient, charge: PendingCharge, timing?: CollectTiming): Promise<ChargeAnswer> {
  const stripeCustomerId = await ensureStripeCustomer(db, stripe, { id: charge.customerId, stripeCustomerId: charge.snapshot.stripe_customer_id })
  const request = chargeRequest(charge, stripeCustomerId)
  const key = stripeIdempotencyKey(charge.orderId, 'charge')

  let last: { detail: string; stripeCode: string | null } = { detail: '', stripeCode: null }
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let options: Stripe.RequestOptions = { idempotencyKey: key }
    if (attempt === 1 && timing?.boundFirstSend) {
      const left = Math.floor(timing.deadline - timing.now())
      if (left < MIN_SEND_MS) return { outcome: 'definite', needsAuthentication: false, message: CHARGE_NOT_SENT_MESSAGE, stripeCode: 'not_sent', attempts: 0 }
      options = { idempotencyKey: key, timeout: Math.min(ORDER_STRIPE_LIMITS.timeoutMs, left) }
    }
    if (attempt === 2 && timing) {
      const left = Math.floor(timing.deadline - timing.now())
      if (left < MIN_SEND_MS) {
        return { outcome: 'unknown', detail: `${last.detail} (not sent again: ${left} ms left before the deadline)`, stripeCode: last.stripeCode, attempts: 1 }
      }
      options = { idempotencyKey: key, timeout: Math.min(ORDER_STRIPE_LIMITS.timeoutMs, left) }
    }
    try {
      const paymentIntent = await stripe.paymentIntents.create(request, options)
      return { outcome: 'answered', paymentIntent, attempts: attempt }
    } catch (err) {
      const failure = readStripeFailure(err)
      // Stripe turns a refused key down before it looks at the idempotency key, so on the first send
      // nothing happened; on the retry it says nothing about what the first send did: still unclear.
      if (accessRefused(err) && attempt === 1) {
        return { outcome: 'definite', needsAuthentication: false, message: STRIPE_ACCESS_REFUSED_MESSAGE, stripeCode: failure.code ?? (err as Stripe.errors.StripeError).type, attempts: attempt }
      }
      if (failure.outcome === 'definite') {
        const needsAuthentication = failure.code === 'authentication_required'
        return {
          outcome: 'definite',
          needsAuthentication,
          message: needsAuthentication ? AUTHENTICATION_NEEDED_MESSAGE : chargeFailedMessage(failure.message),
          stripeCode: failure.code,
          attempts: attempt,
        }
      }
      last = { detail: failure.message, stripeCode: failure.code }
    }
  }
  return { outcome: 'unknown', ...last, attempts: 2 }
}
