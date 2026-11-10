// Ported from backend/paddock/finaliseReaderOrder.ts and cancelReaderOrder.ts, with the legacy
// app/api/terminal/payment-intent route's retrieve and cancel (core.ts), new in W11. The money is checked
// to the penny, the order is finished by T2 or removed by the one undo (each one transaction), and an
// unclear answer from Stripe never undoes anything. Memberships on the reader are W13's.
import 'server-only'
import type Stripe from 'stripe'
import type { CancelReaderOrderOutput, FinaliseReaderOrderOutput } from '@/contracts'
import type { Db } from '@/server/db'
import type { StripeClient } from '@/server/stripe/client'
import { NoTimeLeft, sendOptions, stripeTiming, type StripeTiming } from '@/server/stripe/deadline'
import { resolveSavedCard, type ResolvedCard } from '@/server/stripe/saved-card'
import {
  OLD_READER_ORDER_MESSAGE,
  OLD_ROLLBACK_STARTED_MESSAGE,
  READER_CHARGED_WITHOUT_ORDER_MESSAGE,
  READER_INTENT_UNCONFIRMED_MESSAGE,
  READER_PAID_NOT_FINISHED_MESSAGE,
  readerCustomerMismatchMessage,
} from './failure-messages'
import { finaliseOrder, oldRollbackStarted, paymentMismatch, type FinaliseMismatch } from './finalise-order'
import type { ReaderSnapshot } from './pending-order'
import { undoOrder } from './undo-order'

export interface ReaderRouteOptions {
  actor: { type: 'staff' | 'customer' | 'system'; id: string | null }
  requestId: string
  /**
   * When the request started (ms since the epoch): its Stripe calls must be answered by
   * STRIPE_DEADLINE_MS after it (server/stripe/deadline.ts). Without one (reconcile, W12), no deadline.
   */
  startedAt?: number
  /** The clock for that deadline. Date.now unless a test passes another. */
  now?: () => number
}

// --- The old words (finaliseReaderOrder.ts, cancelReaderOrder.ts, and the legacy route's errors)

export const ORDER_NOT_FOUND_MESSAGE = 'That order no longer exists.'
export const NOT_A_READER_ORDER_MESSAGE = 'This order is not a pending card-reader order.'
export const ALREADY_FINALISED_MESSAGE = 'This order was already finalised — nothing further was done.'
export const PAID_BY_ANOTHER_MESSAGE = 'This order is already paid by a different payment.'
export const FINALISE_ROLLBACK_STARTED_MESSAGE = "This order is already being rolled back, so it can't be finalised."
export const LOOK_UP_FAILED_MESSAGE = 'Failed to look up the PaymentIntent in Stripe.'
export const CARD_NOT_SAVED_WARNING = "The card couldn't be saved for future charges."
export const ALREADY_GONE_MESSAGE = 'The order was already rolled back — nothing to do.'
export const ALREADY_PAID_MESSAGE = 'This order is already paid — it cannot be cancelled. Refund it through the order refund flow instead.'
export const CANCELLED_MESSAGE = 'The pending order was cancelled and everything it held was released.'
export const PAID_MEANWHILE_MESSAGE = 'The order could not be rolled back — it appears to have been paid meanwhile.'
export const CANCEL_FAILED_MESSAGE =
  'Failed to cancel the PaymentIntent in Stripe — the order is still pending; retry after checking the payment in Stripe.'
export const ROLLBACK_INCOMPLETE_MESSAGE =
  "The order couldn't be fully cancelled yet. It's still on the Orders page, and Resolve now will finish it once it's 15 minutes old."
export const FINALISED_INSTEAD_MESSAGE = 'The reader payment actually succeeded — the order was finalised instead of cancelled.'
export const notSucceededMessage = (status: string): string =>
  `The reader payment has not succeeded yet (status: ${status}). Cancel the order or retry the card on the reader.`
export const notFinalisedMessage = (status: string): string => `This order is in state "${status}" and cannot be finalised.`
export const notCancelledMessage = (status: string): string => `This order is in state "${status}" and cannot be cancelled.`
export const changedWhileFinalisingMessage = (paymentIntentId: string): string =>
  `The order changed while it was being finalised, so it wasn't marked paid. Check the order and the payment (${paymentIntentId}) in Stripe before doing anything.`

const pounds = (pence: number): string => (pence / 100).toFixed(2)

/** finaliseReaderOrder's words for a PaymentIntent that isn't what the order expects, and W11's for the customer. */
function mismatchAnswer(reason: FinaliseMismatch, orderId: string, paymentIntent: Stripe.PaymentIntent, snapshot: ReaderSnapshot): FinaliseReaderOrderOutput {
  switch (reason) {
    case 'payment_not_succeeded':
      return { finalised: false, orderId, reason, paymentNotSucceeded: true, piStatus: paymentIntent.status, message: notSucceededMessage(paymentIntent.status) }
    case 'metadata_mismatch':
      return { finalised: false, orderId, reason, message: 'This PaymentIntent does not belong to this order (metadata mismatch) — check it in Stripe before doing anything.' }
    case 'currency_mismatch':
      return { finalised: false, orderId, reason, message: `The reader payment is in ${paymentIntent.currency.toUpperCase()}, not GBP — check it in Stripe before doing anything.` }
    case 'amount_mismatch':
      // The old words, now for any difference at all: the check is to the exact penny (W03-plan 2.7).
      return {
        finalised: false,
        orderId,
        reason,
        message: `The reader charged £${pounds(paymentIntent.amount_received)} but the order expected £${snapshot.expected_amount.toFixed(2)} — do NOT finalise automatically. Check the PaymentIntent (${paymentIntent.id}) in Stripe and refund/adjust manually.`,
      }
    case 'customer_mismatch':
      return { finalised: false, orderId, reason, message: readerCustomerMismatchMessage(paymentIntent.id) }
    case 'rollback_started':
      return { finalised: false, orderId, reason, message: FINALISE_ROLLBACK_STARTED_MESSAGE }
    case 'order_gone':
      return { finalised: false, orderId, reason: 'charged_without_order', message: READER_CHARGED_WITHOUT_ORDER_MESSAGE }
    case 'paid_by_another_payment':
    case 'not_pending':
      return { finalised: false, orderId, reason: 'unexpected_state', message: changedWhileFinalisingMessage(paymentIntent.id) }
  }
}

// --- The order, as the route finds it

interface OrderRead {
  payment_status: string
  stripe_payment_intent_id: string | null
  reader_payment: Record<string, unknown> | null
}

type Found =
  | { kind: 'gone' }
  /** Not an order the reader is collecting for: no intent on its record (a cash or saved-card order, say). */
  | { kind: 'not_reader' }
  /** The old checkout's reader order (an intent, but no Worker method): the old checkout's to finish. */
  | { kind: 'old' }
  /** A Worker reader order whose intent was never written onto it (held, PAYMENT_UNCONFIRMED). */
  | { kind: 'no_intent' }
  | { kind: 'reader'; order: OrderRead; snapshot: ReaderSnapshot & { payment_intent_id: string } }

async function findOrder(db: Db, orderId: string): Promise<Found> {
  const order = (
    await db.query<OrderRead>('SELECT payment_status, stripe_payment_intent_id, reader_payment FROM orders WHERE id = $1::uuid', [orderId])
  )[0]
  if (!order) return { kind: 'gone' }
  const record = order.reader_payment
  if (record?.['method'] === 'reader') {
    if (typeof record['payment_intent_id'] !== 'string') return { kind: 'no_intent' }
    return { kind: 'reader', order, snapshot: record as ReaderSnapshot & { payment_intent_id: string } }
  }
  // What finaliseReaderOrder took for a reader order: an intent and the amount it expects.
  if (record && typeof record['payment_intent_id'] === 'string' && typeof record['expected_amount'] === 'number') return { kind: 'old' }
  return { kind: 'not_reader' }
}

const stripeMessage = (err: unknown): string | null => (err instanceof Error && !(err instanceof NoTimeLeft) && err.message ? err.message : null)
const isMissing = (err: unknown): boolean => {
  const failure = err as { statusCode?: number; code?: string } | null
  return failure?.statusCode === 404 || failure?.code === 'resource_missing'
}

// --- Finalise

async function finaliseFound(
  db: Db,
  stripe: StripeClient,
  orderId: string,
  found: Found,
  options: ReaderRouteOptions,
  timing: StripeTiming | undefined,
  known?: Stripe.PaymentIntent
): Promise<FinaliseReaderOrderOutput> {
  if (found.kind === 'gone') return { finalised: false, orderId, reason: 'order_not_found', message: ORDER_NOT_FOUND_MESSAGE }
  if (found.kind === 'not_reader') return { finalised: false, orderId, reason: 'not_a_reader_order', message: NOT_A_READER_ORDER_MESSAGE }
  if (found.kind === 'old') return { finalised: false, orderId, reason: 'old_reader_order', message: OLD_READER_ORDER_MESSAGE }
  if (found.kind === 'no_intent') return { finalised: false, orderId, reason: 'intent_unconfirmed', message: READER_INTENT_UNCONFIRMED_MESSAGE }

  const { order, snapshot } = found
  if (order.payment_status === 'paid') {
    if (order.stripe_payment_intent_id === snapshot.payment_intent_id) {
      return { finalised: true, orderId, paymentIntentId: snapshot.payment_intent_id, alreadyFinalised: true, message: ALREADY_FINALISED_MESSAGE }
    }
    return { finalised: false, orderId, reason: 'unexpected_state', message: PAID_BY_ANOTHER_MESSAGE }
  }
  if (order.payment_status !== 'pending') return { finalised: false, orderId, reason: 'unexpected_state', message: notFinalisedMessage(order.payment_status) }
  if (oldRollbackStarted(snapshot)) return { finalised: false, orderId, reason: 'rollback_started', message: FINALISE_ROLLBACK_STARTED_MESSAGE }

  // The payment, from Stripe (or as cancel has just read it). Any failure leaves the order as it is.
  let paymentIntent: Stripe.PaymentIntent
  try {
    paymentIntent = known ?? (await stripe.paymentIntents.retrieve(snapshot.payment_intent_id, undefined, sendOptions(timing)))
  } catch (err) {
    const message = isMissing(err) ? 'PaymentIntent not found' : (stripeMessage(err) ?? LOOK_UP_FAILED_MESSAGE)
    return { finalised: false, orderId, reason: 'unexpected_state', message }
  }
  // Checked before the card is read, as finaliseReaderOrder did; T2 checks it again under the lock.
  const wrong = paymentMismatch(snapshot, orderId, paymentIntent)
  if (wrong) return mismatchAnswer(wrong, orderId, paymentIntent, snapshot)

  // The card, when the customer agreed to save it. Bug 7: a card that can't be saved never stops the
  // order (nothing here is a membership, W13): it is marked paid with the warning.
  const warnings: string[] = []
  let card: ResolvedCard | null = null
  if (snapshot.save_card) {
    try {
      const resolved = await resolveSavedCard(stripe, { paymentIntentId: paymentIntent.id }, () => sendOptions(timing))
      if (resolved.reusable) card = resolved
      else warnings.push(CARD_NOT_SAVED_WARNING)
    } catch {
      warnings.push(CARD_NOT_SAVED_WARNING)
    }
  }

  // T2: one transaction. A database fault leaves the order pending with the money taken, for
  // reconcile (W12): never refunded for it (W6-3), where finaliseReaderOrder refunded.
  let outcome: Awaited<ReturnType<typeof finaliseOrder>>
  try {
    outcome = await finaliseOrder(db, orderId, paymentIntent, { actor: options.actor, requestId: options.requestId, saveCard: card })
  } catch {
    return { finalised: false, orderId, reason: 'finalise_failed', message: READER_PAID_NOT_FINISHED_MESSAGE }
  }
  if (!outcome.finalised) return mismatchAnswer(outcome.reason, orderId, paymentIntent, snapshot)
  if (outcome.alreadyPaid) return { finalised: true, orderId, paymentIntentId: paymentIntent.id, alreadyFinalised: true, message: ALREADY_FINALISED_MESSAGE }
  return { finalised: true, orderId, paymentIntentId: paymentIntent.id, ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {}) }
}

/**
 * finaliseReaderOrder: the reader has taken (or should have taken) the payment. Checks the order, reads
 * the PaymentIntent, checks it (succeeded, this order's, gbp, the exact pence, this Stripe customer),
 * reads the card when the customer agreed to save it, then T2 marks the order paid in one transaction,
 * with the card, the address and the event booking. Safe twice, and racing cancel: T2 locks the order
 * and re-checks it. Answers as data, with the old reasons and words where the old function had them.
 * Never refunds and never undoes: a payment that doesn't check out leaves the order pending for a
 * person or reconcile (W03-plan 2.5).
 */
export async function finaliseReaderOrder(db: Db, stripe: StripeClient, orderId: string, options: ReaderRouteOptions): Promise<FinaliseReaderOrderOutput> {
  const timing = options.startedAt === undefined ? undefined : stripeTiming(options.startedAt, options.now ?? Date.now)
  return finaliseFound(db, stripe, orderId, await findOrder(db, orderId), options, timing)
}

// --- Cancel

/** What Stripe says about the reader's intent once asked to cancel it (the legacy route's 'cancel' action). */
type Settled =
  | { kind: 'succeeded'; paymentIntent: Stripe.PaymentIntent }
  /** Cancelled now or before, or Stripe has no such intent: nothing was or can be taken. */
  | { kind: 'cancelled'; status: string }
  /** No clear answer: the money may still move, so nothing is undone. */
  | { kind: 'unclear'; message: string }

/** The legacy route's cancellable statuses: never a succeeded intent. */
const CANCELLABLE: readonly string[] = ['requires_payment_method', 'requires_confirmation', 'requires_action', 'requires_capture', 'processing']

/** The words for a 404 from a key of another mode than the intent's (W11a, review L1): nothing is changed. */
export const otherModeMessage = (paymentIntentId: string): string =>
  `Stripe can't find the reader payment (${paymentIntentId}) with the Stripe key in use, which may be for the other Stripe mode (live or test) than the payment. Nothing was changed: check the payment in Stripe before doing anything.`

/**
 * Ported from the legacy route's handlePaymentIntent ('cancel'): read it; succeeded is answered as such
 * (never cancelled); cancelled is done; a status that can't be cancelled is unclear; otherwise cancel,
 * and if that fails read it again, as it may have succeeded meanwhile. Every call under the deadline.
 *
 * A 404 on the read means the intent never existed only when the key in use is of the mode the intent
 * was made in (W11a, review L1): Stripe also answers 404 to a key of the other mode for an intent that
 * exists and may have taken the money. Otherwise, or when either mode is unknown, it is unclear.
 */
async function settleIntent(
  stripe: StripeClient,
  snapshot: ReaderSnapshot & { payment_intent_id: string },
  timing: StripeTiming | undefined
): Promise<Settled> {
  const paymentIntentId = snapshot.payment_intent_id
  let paymentIntent: Stripe.PaymentIntent
  try {
    paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId, undefined, sendOptions(timing))
  } catch (err) {
    if (isMissing(err)) {
      // An intent that doesn't exist never took any money (cancelReaderOrder went ahead on not_found).
      const sameMode = typeof snapshot.livemode === 'boolean' && snapshot.livemode === stripe.keyLivemode
      return sameMode ? { kind: 'cancelled', status: 'not_found' } : { kind: 'unclear', message: otherModeMessage(paymentIntentId) }
    }
    return { kind: 'unclear', message: stripeMessage(err) ?? CANCEL_FAILED_MESSAGE }
  }
  if (paymentIntent.status === 'succeeded') return { kind: 'succeeded', paymentIntent }
  if (paymentIntent.status === 'canceled') return { kind: 'cancelled', status: 'canceled' }
  if (!CANCELLABLE.includes(paymentIntent.status)) return { kind: 'unclear', message: `PaymentIntent cannot be cancelled in status ${paymentIntent.status}` }
  try {
    await stripe.paymentIntents.cancel(paymentIntentId, undefined, sendOptions(timing))
    return { kind: 'cancelled', status: paymentIntent.status }
  } catch (cancelError) {
    // The tap may have completed between the read and the cancel: read it again.
    try {
      const latest = await stripe.paymentIntents.retrieve(paymentIntentId, undefined, sendOptions(timing))
      if (latest.status === 'succeeded') return { kind: 'succeeded', paymentIntent: latest }
      if (latest.status === 'canceled') return { kind: 'cancelled', status: 'canceled' }
    } catch {
      // Fall through to the cancel's own error.
    }
    return { kind: 'unclear', message: stripeMessage(cancelError) ?? CANCEL_FAILED_MESSAGE }
  }
}

/**
 * cancelReaderOrder: the reader payment was cancelled, declined or timed out. Asks Stripe to cancel the
 * intent. If it had in fact succeeded, the order is finalised instead (the money moved, so the sale is
 * real). If it is cancelled (or never existed), the one undo gives everything back in one transaction,
 * exactly once (bugs 8 and 9 can't happen: the add-on lines go with the order, and a gift card's
 * `redeemed_at` is cleared when this order set it). Anything unclear from Stripe changes nothing. Safe
 * twice: the second finds the order gone. Racing finalise: the undo and T2 lock the order and re-check
 * it, and Stripe's own state decides which can go (a cancelled intent can't succeed, and the reverse).
 */
export async function cancelReaderOrder(db: Db, stripe: StripeClient, orderId: string, options: ReaderRouteOptions): Promise<CancelReaderOrderOutput> {
  const timing = options.startedAt === undefined ? undefined : stripeTiming(options.startedAt, options.now ?? Date.now)
  const found = await findOrder(db, orderId)
  if (found.kind === 'gone') return { cancelled: true, orderId, alreadyGone: true, message: ALREADY_GONE_MESSAGE }
  if (found.kind === 'not_reader') return { cancelled: false, orderId, reason: 'not_a_reader_order', message: NOT_A_READER_ORDER_MESSAGE }
  if (found.kind === 'old') return { cancelled: false, orderId, reason: 'old_reader_order', message: OLD_READER_ORDER_MESSAGE }
  // Its intent may exist, though nobody has its secret: reconcile (W12) finds it in Stripe by the order's id.
  if (found.kind === 'no_intent') return { cancelled: false, orderId, reason: 'intent_unconfirmed', message: READER_INTENT_UNCONFIRMED_MESSAGE }

  const { order, snapshot } = found
  if (order.payment_status === 'paid') return { cancelled: false, orderId, reason: 'already_paid', message: ALREADY_PAID_MESSAGE }
  if (order.payment_status !== 'pending') return { cancelled: false, orderId, reason: 'already_cancelled', message: notCancelledMessage(order.payment_status) }
  if (oldRollbackStarted(snapshot)) return { cancelled: false, orderId, reason: 'rollback_started', message: OLD_ROLLBACK_STARTED_MESSAGE }

  const settled = await settleIntent(stripe, snapshot, timing)
  if (settled.kind === 'unclear') return { cancelled: false, orderId, reason: 'stripe_error', message: settled.message }
  if (settled.kind === 'succeeded') {
    // Finalised with the PaymentIntent just read: the old function read it once more.
    const finaliseResult = await finaliseFound(db, stripe, orderId, found, options, timing, settled.paymentIntent)
    return {
      cancelled: false,
      orderId,
      finalisedInstead: true,
      finaliseResult,
      message: finaliseResult.finalised
        ? FINALISED_INSTEAD_MESSAGE
        : `The reader payment actually succeeded, but finalising it failed: ${finaliseResult.message ?? finaliseResult.reason}`,
    }
  }

  let undone: Awaited<ReturnType<typeof undoOrder>>
  try {
    undone = await undoOrder(db, orderId, { actor: options.actor, requestId: options.requestId, why: `The card reader payment was cancelled (${settled.status}).` })
  } catch {
    // Nothing was changed (one transaction): the order stays pending with its claims for the next try.
    return { cancelled: false, orderId, reason: 'rollback_incomplete', message: ROLLBACK_INCOMPLETE_MESSAGE }
  }
  if (undone.undone) return { cancelled: true, orderId, message: CANCELLED_MESSAGE }
  switch (undone.reason) {
    case 'gone':
      return { cancelled: true, orderId, alreadyGone: true, message: ALREADY_GONE_MESSAGE }
    case 'paid':
      return { cancelled: false, orderId, reason: 'already_paid', message: PAID_MEANWHILE_MESSAGE }
    case 'rollback_started':
      return { cancelled: false, orderId, reason: 'rollback_started', message: OLD_ROLLBACK_STARTED_MESSAGE }
    case 'not_pending':
      return { cancelled: false, orderId, reason: 'already_cancelled', message: 'This order is no longer pending, so it cannot be cancelled.' }
  }
}
