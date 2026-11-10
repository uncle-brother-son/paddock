// Ported from backend/paddock/createOrder.ts (stage 29, the reader branch) and
// app/api/terminal/create-payment-intent/route.ts: the PaymentIntent the reader collects, now made
// after T1 has committed the order with its pending record (bug 14), under the order's key, with
// Stripe's answers read as W03-plan 2.5 says (new in W11).
import 'server-only'
import Stripe from 'stripe'
import type { Db } from '@/server/db'
import { stripeIdempotencyKey } from '@/server/http/idempotency'
import type { StripeClient } from '@/server/stripe/client'
import { ensureStripeCustomer } from '@/server/stripe/customer'
import { NoTimeLeft, sendOptions, type StripeTiming } from '@/server/stripe/deadline'
import { readStripeFailure } from '@/server/stripe/outcome'
import { pence } from './collect-saved-card'
import type { ReaderSnapshot } from './pending-order'

/** An order T1 has committed pending, waiting for its reader intent. */
export interface PendingReader {
  orderId: string
  customerId: string
  snapshot: ReaderSnapshot
}

export type ReaderIntentAnswer =
  /** Stripe made the intent: the screen collects it on the reader. Nothing has been taken. */
  | { outcome: 'created'; paymentIntent: Stripe.PaymentIntent; stripeCustomerId: string; attempts: number }
  /** Stripe said no, or nothing was sent: no intent exists, so nothing can be taken and the order is undone. */
  | { outcome: 'definite'; message: string; detail: string; attempts: number }
  /** No clear answer: an intent may exist. Held, never undone here (W03-plan 2.5); reconcile decides (W12). */
  | { outcome: 'unknown'; detail: string; attempts: number }

/** createOrder's fallback words when the intent failed in a way it had no words for. */
export const READER_INTENT_FALLBACK_MESSAGE = 'Failed to create the card reader payment'

/** The words for an intent that wasn't asked for because the deadline came first (new: the old code had no deadline). */
export const READER_INTENT_NOT_SENT_MESSAGE =
  "Stripe was too slow to start the card reader payment, so it wasn't started: nothing was taken and the order wasn't placed. Try again."

/**
 * The intent's request, built only from the order's id, the customer and the pending record, so the
 * retry sends exactly the same request under the same key: the legacy route's parameters (pence, gbp,
 * the Stripe customer, `card_present`, `setup_future_usage` only when the customer agreed to save the
 * card, the customer and the order in the metadata) and createOrder's description.
 */
export function readerIntentRequest(pending: PendingReader, stripeCustomerId: string): Stripe.PaymentIntentCreateParams {
  return {
    amount: pence(pending.snapshot.expected_amount),
    currency: 'gbp',
    customer: stripeCustomerId,
    payment_method_types: ['card_present'],
    ...(pending.snapshot.save_card ? { setup_future_usage: 'off_session' as const } : {}),
    metadata: { supabase_customer_id: pending.customerId, order_id: pending.orderId, flow: 'checkout' },
    description: `Paddock order ${pending.orderId}`,
  }
}

const accessRefused = (err: unknown): boolean =>
  err instanceof Stripe.errors.StripeAuthenticationError || err instanceof Stripe.errors.StripePermissionError

const explain = (err: unknown): string => (err instanceof Error ? `${err.name}: ${err.message}` : String(err))

/**
 * Makes the reader's PaymentIntent, after T1 has committed the order pending. Called outside any
 * transaction.
 *
 * - The Stripe customer first (ensureStripeCustomer, its first real user): the one on the row, else one
 *   tagged with this customer in Stripe, else a new one, under the customer's key. Any failure here
 *   means no intent was asked for, so nothing can be taken: definite, with the legacy route's words.
 * - Then the intent, under `<orderId>:reader-intent`. A PaymentIntent back is the answer. A definite
 *   failure (a card error, an invalid request, or Stripe refusing the Worker's key on the first send,
 *   as W10a decided for the charge) means no intent: definite, with the legacy route's words. Anything
 *   else may have made one: sent once more with the same key and request, then unknown.
 * - Every call is under the press's deadline (sendOptions): a call with too little time left isn't
 *   sent. The intent's first send not sent is definite (nothing was asked for); its retry not sent is
 *   unknown, as W10a's charge.
 *
 * Creating an intent takes no money: only the reader's tap, against the secret the screen is given, can.
 */
export async function createReaderIntent(db: Db, stripe: StripeClient, pending: PendingReader, timing?: StripeTiming): Promise<ReaderIntentAnswer> {
  let stripeCustomerId: string
  try {
    stripeCustomerId = await ensureStripeCustomer(db, stripe, { id: pending.customerId, stripeCustomerId: pending.snapshot.stripe_customer_id }, timing)
  } catch (err) {
    const message =
      err instanceof NoTimeLeft
        ? READER_INTENT_NOT_SENT_MESSAGE
        : err instanceof Stripe.errors.StripeError
          ? `Failed to create Stripe customer: ${err.message}`
          : READER_INTENT_FALLBACK_MESSAGE
    return { outcome: 'definite', message, detail: `Finding the Stripe customer: ${explain(err)}`, attempts: 0 }
  }

  const request = readerIntentRequest(pending, stripeCustomerId)
  const key = stripeIdempotencyKey(pending.orderId, 'reader-intent')
  let last = ''
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let options: Stripe.RequestOptions
    try {
      options = sendOptions(timing, { idempotencyKey: key })
    } catch (err) {
      if (attempt === 1) return { outcome: 'definite', message: READER_INTENT_NOT_SENT_MESSAGE, detail: explain(err), attempts: 0 }
      return { outcome: 'unknown', detail: `${last} (not sent again: ${explain(err)})`, attempts: 1 }
    }
    try {
      const paymentIntent = await stripe.paymentIntents.create(request, options)
      return { outcome: 'created', paymentIntent, stripeCustomerId, attempts: attempt }
    } catch (err) {
      const failure = readStripeFailure(err)
      // Stripe turns a refused key down before it looks at the idempotency key, so on the first send
      // nothing happened; on the retry it says nothing about what the first send did (W10a).
      if (failure.outcome === 'definite' || (accessRefused(err) && attempt === 1)) {
        return { outcome: 'definite', message: `Failed to create PaymentIntent: ${failure.message}`, detail: explain(err), attempts: attempt }
      }
      last = explain(err)
    }
  }
  return { outcome: 'unknown', detail: last, attempts: 2 }
}

/**
 * Writes the intent onto the pending record, with the Stripe customer it is for, so T2 can check the
 * payment and the old finalise, cancel, sweep and stuck list can read the order (W03-plan 3.2), and
 * the Stripe mode it was made in (`livemode`, W11a: cancel and reconcile trust a 404 only from a key of
 * the same mode). Only while the order is still pending with no other intent recorded. False when
 * nothing was written.
 *
 * In its own transaction (W11a, review S1), so the transaction limits apply: a lock on the order is
 * waited for at most 5 s and the statement at most 8 s, enforced by Postgres, which rolls back a
 * statement it stops (as a plain statement, only the client's 10 s applied, and a write the client gave
 * up on could still land). A failure here is held as PAYMENT_UNCONFIRMED by the caller.
 */
export async function recordReaderIntent(
  db: Db,
  orderId: string,
  paymentIntent: Pick<Stripe.PaymentIntent, 'id' | 'livemode'>,
  stripeCustomerId: string
): Promise<boolean> {
  const written = await db.transaction((tx) =>
    tx.query<{ id: string }>(
      `UPDATE orders
       SET reader_payment = reader_payment
             || jsonb_build_object('payment_intent_id', $2::text, 'stripe_customer_id', $3::text, 'livemode', $4::boolean),
           updated_at = now()
       WHERE id = $1::uuid AND payment_status = 'pending' AND reader_payment->>'method' = 'reader'
         AND COALESCE(reader_payment->>'payment_intent_id', $2::text) = $2::text
       RETURNING id`,
      [orderId, paymentIntent.id, stripeCustomerId, paymentIntent.livemode]
    )
  )
  return written.length === 1
}
