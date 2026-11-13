// Ported from backend/paddock/finaliseReaderOrder.ts and cancelReaderOrder.ts, with the legacy
// app/api/terminal/payment-intent route's retrieve and cancel (core.ts), new in W11. The money is checked
// to the penny, the order is finished by T2 or removed by the one undo (each one transaction), and an
// unclear answer from Stripe never undoes anything. W13 adds the membership on the reader: at finalise the
// card is saved, the subscription made with a coupon covering the first payment the tap took, the old
// subscription cancelled last (Q8), then T2; a definite failure refunds the tap (compensation, membership.ts).
// W13a (W13 review B1, L1): the finalise writes its start of the subscription before asking Stripe, so reconcile
// can't refund the tap under it; T2's checks are read before Q8; a subscription made for an order T2 finds gone or
// being put back is cancelled at once. A membership's finalise ends its Stripe calls by 25 s.
// W13c (W13a review B1, S1): one press at a time: a start refused because another press's start is young answers
// `subscription_starting` and sends nothing more; T2 records a subscription this press made for an order gone or
// marked, and the put-back runs only with time left to send.
import 'server-only'
import type Stripe from 'stripe'
import type { CancelReaderOrderOutput, FinaliseReaderOrderOutput } from '@/contracts'
import type { Db } from '@/server/db'
import type { StripeClient } from '@/server/stripe/client'
import { NoTimeLeft, sendOptions, STRIPE_DEADLINE_MS, type StripeTiming } from '@/server/stripe/deadline'
import { notReusableMessage, resolveSavedCard, type ResolvedCard } from '@/server/stripe/saved-card'
import {
  CHANGED_SINCE_MESSAGE,
  COMPENSATION_HELD_MESSAGE,
  FAILURE_MESSAGES,
  MEMBERSHIP_UNCONFIRMED_MESSAGE,
  OLD_MEMBERSHIP_CANCELLED_NOTE,
  REPLACED_UNCONFIRMED_MESSAGE,
  readerRefundedMessage,
  subscriptionWrongMessage,
  OLD_ROLLBACK_STARTED_MESSAGE,
  READER_CHARGED_WITHOUT_ORDER_MESSAGE,
  READER_INTENT_UNCONFIRMED_MESSAGE,
  READER_PAID_NOT_FINISHED_MESSAGE,
  readerCustomerMismatchMessage,
  SUBSCRIPTION_STARTING_MESSAGE,
} from './failure-messages'
import { finaliseOrder, MEMBERSHIP_DEFINITE, membershipPrecheck, oldRollbackStarted, paymentMismatch, type FinaliseMismatch } from './finalise-order'
import {
  cancelSubscriptionChecked,
  checkMembershipPrice,
  compensateOrder,
  deleteCouponQuietly,
  findOrderSubscriptions,
  isPutBackReason,
  markSubscriptionStarting,
  MEMBERSHIP_STRIPE_DEADLINE_MS,
  putBackSubscription,
  startSubscription,
  type MadeSubscription,
  type Taken,
} from './membership'
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
  /**
   * W13 (W12a N1): a deadline already set by the caller (a staff member's reconcile run, which ends its Stripe
   * calls sooner than a press's 30 s). Takes the place of `startedAt` and `now`.
   */
  timing?: StripeTiming
  /**
   * W13: reconcile has looked in Stripe for the order's subscription (by `metadata.order_id`): the one it
   * found, or null for none. Reconcile never starts a subscription (W03-plan 2.5): with none, a membership
   * order's tap is refunded and the order undone. Absent (the screen's finalise): the subscription is made.
   */
  subscriptionFound?: MadeSubscription | null
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
    // W13: money is being put back for it (or must be): held for reconcile, never paid.
    case 'compensating':
    case 'membership_not_started':
    case 'payment_missing':
    case 'subscription_mismatch':
    case 'membership_line_missing':
    case 'membership_row_missing':
      return { finalised: false, orderId, reason: 'compensation_unfinished', message: COMPENSATION_HELD_MESSAGE }
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
  /** Not an order the reader is collecting for: its record isn't a Worker reader order's (a cash or saved-card order, say). */
  | { kind: 'not_reader' }
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
  // W25: the old checkout's reader orders (an intent but no `method`) are gone with the old checkout (W16; none left,
  // checked live 11 Nov), so anything else is simply not a reader order.
  return { kind: 'not_reader' }
}

export const stripeMessage = (err: unknown): string | null => (err instanceof Error && !(err instanceof NoTimeLeft) && err.message ? err.message : null)
export const isMissing = (err: unknown): boolean => {
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
  // W13: its money is being put back: only the compensation (or reconcile) finishes it.
  if (snapshot.compensation) return { finalised: false, orderId, reason: 'compensation_unfinished', message: COMPENSATION_HELD_MESSAGE }

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

  // W13: a membership needs the card for its renewals, a subscription and the old one cancelled first.
  if (snapshot.membership) return finaliseMembership(db, stripe, orderId, snapshot, paymentIntent, options, timing)

  // The card, when the customer agreed to save it. Bug 7: a card that can't be saved never stops the
  // order (nothing here is a membership): it is marked paid with the warning.
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
 * W13: finaliseReaderOrder's membership, after the tap has been checked: in order,
 * 1. the card the tap left must be reusable (the membership's renewals need it), else the tap is refunded
 *    (compensation: the mark first, then `<orderId>:refund-reader`) and the order undone (`card_not_reusable`);
 * 2. the plan's Stripe price again (it may have changed since the order), then (W13a B1) this press's start
 *    written onto the order, then the subscription on that card with a fixed coupon covering the whole first
 *    payment the tap took (its first invoice is £0), under `<orderId>:coupon` and `<orderId>:subscription`;
 * 3. (W13a L1) T2's definite checks, then the customer's exhausted subscription cancelled last (Q8);
 * 4. T2: paid, the card saved, the membership written (or the buy-new row patched), the old one cancelled.
 * One rule per kind of failure (W11 review L3): definite, the tap refunded and the subscription cancelled
 * (each checked), then the undo; unclear, held (never refunded, never undone); a database fault in T2, held
 * for reconcile. Reconcile (`subscriptionFound`) never starts the subscription: none found, the tap is refunded,
 * but not while a press is starting one (W13a B1: the mark waits, then Stripe is listed again).
 * W13a (B1c): a subscription this press made for an order T2 then finds gone or being compensated is cancelled
 * and its first invoice refunded at once, and recorded for the stuck list.
 */
async function finaliseMembership(
  db: Db,
  stripe: StripeClient,
  orderId: string,
  snapshot: ReaderSnapshot & { payment_intent_id: string },
  paymentIntent: Stripe.PaymentIntent,
  options: ReaderRouteOptions,
  timing: StripeTiming | undefined
): Promise<FinaliseReaderOrderOutput> {
  const membership = snapshot.membership as NonNullable<ReaderSnapshot['membership']>
  const tap = { step: 'refund-reader' as const, paymentIntentId: paymentIntent.id }
  const actor = { actor: options.actor, requestId: options.requestId }
  const held = (reason: string, message: string): FinaliseReaderOrderOutput => ({ finalised: false, orderId, reason, message })
  // W13a (B1): this press's start of the subscription, once written; a compensation it makes is never held up by it.
  let press: string | null = null
  // W13c: this press's start took the place of another press's expired one, so its compensation lists Stripe again.
  let replacedStart = false
  const relist = () => findOrderSubscriptions(stripe, timing, snapshot.stripe_customer_id ?? null, orderId)
  const compensate = async (taken: Taken, reason: string, staffMessage: string, why: string, oldCancelled = false): Promise<FinaliseReaderOrderOutput> => {
    try {
      const outcome = await compensateOrder(db, stripe, orderId, taken, why, { ...actor, ...(taken.subscriptionId === null ? { noSubscriptionFound: { press, relist, replacedStart } } : {}) }, timing)
      if (outcome.settled && outcome.undo.undone) {
        return { finalised: false, orderId, reason, message: readerRefundedMessage(oldCancelled ? `${staffMessage} ${OLD_MEMBERSHIP_CANCELLED_NOTE}` : staffMessage, paymentIntent.id), rolledBack: true }
      }
      if (!outcome.settled && outcome.starting) return held('subscription_starting', SUBSCRIPTION_STARTING_MESSAGE)
    } catch {
      // Held: the order is still pending (marked, or not yet), for reconcile to finish.
    }
    return held('compensation_unfinished', oldCancelled ? `${COMPENSATION_HELD_MESSAGE} ${OLD_MEMBERSHIP_CANCELLED_NOTE}` : COMPENSATION_HELD_MESSAGE)
  }

  // 1. The card: a membership can't be set up without one Stripe can charge for the renewals.
  // The old words (saveCustomerCardOnFile's, through finaliseReaderOrder): why the card couldn't be saved.
  let card: ResolvedCard | null = null
  let notSaved = 'Failed to resolve saved card'
  try {
    const resolved = await resolveSavedCard(stripe, { paymentIntentId: paymentIntent.id }, () => sendOptions(timing))
    if (resolved.reusable) card = resolved
    else notSaved = notReusableMessage({ paymentIntentId: paymentIntent.id }, resolved.paymentMethodId)
  } catch (err) {
    notSaved = stripeMessage(err) ? `Failed to resolve saved card: ${stripeMessage(err)}` : notSaved
  }
  if (!card || !snapshot.stripe_customer_id) {
    return compensate({ subscriptionId: null, refunds: [tap] }, 'card_not_reusable', `Saving the card for the membership failed: ${notSaved}`, `The card couldn't be saved for the membership: ${notSaved}`)
  }

  // 2. The subscription: reconcile's found one, or (the screen) a new one after the price check.
  let subscription: MadeSubscription
  const madeHere = options.subscriptionFound === undefined
  if (options.subscriptionFound !== undefined) {
    if (options.subscriptionFound === null) {
      return compensate({ subscriptionId: null, refunds: [tap] }, 'subscription_failed', 'The membership was never started in Stripe.', 'Reconcile found the tap but no subscription, and never starts one')
    }
    subscription = options.subscriptionFound
  } else {
    const price = await checkMembershipPrice(stripe, membership, timing)
    if (!price.ok) {
      const words = price.message || (FAILURE_MESSAGES[price.reason] ?? '')
      return compensate({ subscriptionId: null, refunds: [tap] }, 'subscription_failed', `Creating the Stripe subscription failed: ${words}`, `The membership's Stripe price was refused at finalise: ${price.reason}`)
    }
    // W13a (B1a): the start, on the order, before Stripe is asked: a compensation that found no subscription
    // then waits for this press, and once the order is marked no start (so no subscription) can follow.
    const thisPress = crypto.randomUUID()
    let started: Awaited<ReturnType<typeof markSubscriptionStarting>>
    try {
      started = await markSubscriptionStarting(db, orderId, thisPress)
    } catch {
      // Nothing new was taken: the tap is held for reconcile, as a T2 fault would be.
      return held('finalise_failed', READER_PAID_NOT_FINISHED_MESSAGE)
    }
    // W13c (W13a review B1): another press (the screen's finalise, or Cancel finalising instead) is making the
    // subscription right now: this press sends nothing more and compensates nothing; that press finishes the order.
    if (started.kind === 'starting') return held('subscription_starting', SUBSCRIPTION_STARTING_MESSAGE)
    if (started.kind === 'not_pending') {
      // Refused: the order is marked, gone, or already paid. Paid with this tap is another press of the same
      // finalise that finished first (two at once): answered as finalise answers it, with nothing sent.
      try {
        const now = (await db.query<{ payment_status: string; stripe_payment_intent_id: string | null }>('SELECT payment_status, stripe_payment_intent_id FROM orders WHERE id = $1::uuid', [orderId]))[0]
        if (now?.payment_status === 'paid' && now.stripe_payment_intent_id === paymentIntent.id) {
          return { finalised: true, orderId, paymentIntentId: paymentIntent.id, alreadyFinalised: true, message: ALREADY_FINALISED_MESSAGE }
        }
      } catch {
        // Held, below: nothing was sent.
      }
      return held('compensation_unfinished', COMPENSATION_HELD_MESSAGE)
    }
    press = thisPress
    replacedStart = started.replaced
    const answer = await startSubscription(
      stripe,
      { orderId, customerId: (await customerOf(db, orderId)) ?? '', stripeCustomerId: snapshot.stripe_customer_id, paymentMethodId: card.paymentMethodId, membership },
      timing
    )
    if (answer.outcome === 'definite') {
      await deleteCouponQuietly(stripe, orderId, membership, timing)
      const words = answer.message || (FAILURE_MESSAGES[answer.reason] ?? '')
      return compensate({ subscriptionId: null, refunds: [tap] }, 'subscription_failed', `Creating the Stripe subscription failed: ${words}`, `The membership's subscription was refused: ${answer.detail}`)
    }
    if (answer.outcome === 'unknown') return held('subscription_unconfirmed', MEMBERSHIP_UNCONFIRMED_MESSAGE)
    subscription = answer.subscription
    if (answer.outcome === 'wrong') {
      return compensate(
        { subscriptionId: subscription.id, refunds: [tap, ...(subscription.invoicePaymentIntentId && subscription.amountPaid > 0 ? [{ step: 'refund-subscription' as const, paymentIntentId: subscription.invoicePaymentIntentId }] : [])] },
        'subscription_failed',
        `Creating the Stripe subscription failed: ${subscriptionWrongMessage(answer.detail)}`,
        `Stripe's subscription was not what was asked: ${answer.detail}`
      )
    }
  }
  const taken: Taken = {
    subscriptionId: subscription.id,
    refunds: [tap, ...(subscription.invoicePaymentIntentId && subscription.amountPaid > 0 ? [{ step: 'refund-subscription' as const, paymentIntentId: subscription.invoicePaymentIntentId }] : [])],
  }
  const savingFailed = 'Saving the membership failed: the order has no membership to attach the subscription to.'

  // 3. Q8: the old subscription, last. Refused: everything back. Unclear: held.
  // W13a (L1): T2's definite checks first, so a refusal can't follow a confirmed cancel.
  let oldCancelled = false
  if (snapshot.exhausted_membership_stripe_id) {
    let ready: Awaited<ReturnType<typeof membershipPrecheck>>
    try {
      ready = await membershipPrecheck(db, orderId, subscription)
    } catch {
      return { finalised: false, orderId, reason: 'finalise_failed', message: READER_PAID_NOT_FINISHED_MESSAGE }
    }
    if (ready.kind === 'refused') return compensate(taken, 'finalise_failed', savingFailed, `T2 would refuse the membership (checked before Q8): ${ready.reason}`)
    if (ready.kind === 'ready') {
      const cancelled = await cancelSubscriptionChecked(stripe, snapshot.exhausted_membership_stripe_id, timing)
      if (cancelled.kind === 'refused') {
        return compensate(
          taken,
          'exhausted_membership_cancellation_failed',
          `Cancelling the customer's previous membership subscription failed: Failed to cancel subscription: ${cancelled.message}`,
          `The old subscription's cancel was refused: ${cancelled.message}`
        )
      }
      if (cancelled.kind === 'unclear') return held('replaced_unconfirmed', REPLACED_UNCONFIRMED_MESSAGE)
      oldCancelled = true
    }
    // Not pending any more (gone, paid, marked): no Q8; T2 answers for it below.
  }

  // 4. T2. A database fault holds it (reconcile finalises it: finalise is safe twice); a membership it can't write is definite.
  let outcome: Awaited<ReturnType<typeof finaliseOrder>>
  try {
    outcome = await finaliseOrder(db, orderId, paymentIntent, { actor: options.actor, requestId: options.requestId, saveCard: card, subscription, subscriptionMadeHere: madeHere })
  } catch {
    return { finalised: false, orderId, reason: 'finalise_failed', message: READER_PAID_NOT_FINISHED_MESSAGE }
  }
  if (!outcome.finalised) {
    if (MEMBERSHIP_DEFINITE.has(outcome.reason)) {
      return compensate(taken, 'finalise_failed', savingFailed, `T2 refused the membership: ${outcome.reason}${oldCancelled ? ' (the old subscription was cancelled already)' : ''}`, oldCancelled)
    }
    // W13a (B1c): this press made a subscription for an order that is gone or being put back. W13c: T2 has recorded
    // it as left; the put-back sends and writes only while there is time to send (else nothing after T2). W13d (W13c
    // review S-1): likewise when the old rollback started after this press's start, or the order was paid with
    // another payment or is otherwise not pending: the old rollback refunds the tap, the put-back only the
    // subscription's own first invoice.
    // W14 (W13d defence): only when T2 wrote the row, so a paid order holding this subscription is never put back.
    if (madeHere && isPutBackReason(outcome.reason) && outcome.subscriptionLeft) {
      try {
        await putBackSubscription(db, stripe, orderId, subscription, outcome.reason, actor, timing)
      } catch {
        // Its row couldn't be written (a database fault): the answer below still says what happened to the order.
      }
    }
    return mismatchAnswer(outcome.reason, orderId, paymentIntent, snapshot)
  }
  if (outcome.alreadyPaid) return { finalised: true, orderId, paymentIntentId: paymentIntent.id, alreadyFinalised: true, message: ALREADY_FINALISED_MESSAGE }
  return {
    finalised: true,
    orderId,
    paymentIntentId: paymentIntent.id,
    membershipSubscriptionId: subscription.id,
    ...(outcome.membershipId ? { membershipId: outcome.membershipId } : {}),
  }
}

/** The order's customer (the subscription's metadata names them, as the old route did). */
async function customerOf(db: Db, orderId: string): Promise<string | null> {
  return (await db.query<{ customer_id: string }>('SELECT customer_id FROM orders WHERE id = $1::uuid', [orderId]))[0]?.customer_id ?? null
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
  const found = await findOrder(db, orderId)
  return finaliseFound(db, stripe, orderId, found, options, pressTiming(options, found))
}

/**
 * The press's Stripe deadline: the caller's (a staff reconcile run's), else from the request's start. W13a: a
 * membership's finalise (or cancel's finalise-instead) ends its Stripe calls by MEMBERSHIP_STRIPE_DEADLINE_MS
 * (25 s), as the saved card's membership press does: its T2 can take 18.1 s, and a subscription made for an order
 * T2 finds gone is put back after it (B1c), so the press stays 10 s inside Retool's 60 s.
 */
function pressTiming(options: ReaderRouteOptions, found: Found): StripeTiming | undefined {
  if (options.timing) return options.timing
  if (options.startedAt === undefined) return undefined
  const membership = found.kind === 'reader' && Boolean(found.snapshot.membership)
  return { deadline: options.startedAt + (membership ? MEMBERSHIP_STRIPE_DEADLINE_MS : STRIPE_DEADLINE_MS), now: options.now ?? Date.now }
}

/**
 * W12a (W12 review L4): reconcile found, by listing Stripe for `metadata.order_id`, a succeeded intent for a
 * reader order whose intent was never written onto it (held, `intent_unconfirmed`). It is finalised as the
 * screen's finalise would be, with that PaymentIntent: the same checks, and the card saved when the customer
 * agreed to it (or CARD_NOT_SAVED_WARNING, R6), then T2.
 *
 * The order is as reconcile selected it (pending, no PaymentIntent on it, this record), not read again: a
 * read here would come after the last Stripe call and lengthen a manual run past its stated bound. T2 locks
 * the order and re-checks all of it (still pending, the old rollback not started, the payment). `timing`
 * is reconcile's run's.
 */
export async function finaliseReaderOrderFound(
  db: Db,
  stripe: StripeClient,
  orderId: string,
  record: ReaderSnapshot,
  paymentIntent: Stripe.PaymentIntent,
  options: ReaderRouteOptions,
  timing: StripeTiming | undefined
): Promise<FinaliseReaderOrderOutput> {
  const found: Found = {
    kind: 'reader',
    order: { payment_status: 'pending', stripe_payment_intent_id: null, reader_payment: record as unknown as Record<string, unknown> },
    snapshot: { ...record, payment_intent_id: paymentIntent.id },
  }
  return finaliseFound(db, stripe, orderId, found, options, timing, paymentIntent)
}

// --- Cancel

/** What Stripe says about the reader's intent once asked to cancel it (the legacy route's 'cancel' action). */
export type Settled =
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
export async function settleIntent(
  stripe: StripeClient,
  /** The intent's id and the mode it was made in: an order's pending record, or a reader flow's (W12). */
  snapshot: { payment_intent_id: string; livemode?: boolean | undefined },
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
  const found = await findOrder(db, orderId)
  const timing = pressTiming(options, found)
  if (found.kind === 'gone') return { cancelled: true, orderId, alreadyGone: true, message: ALREADY_GONE_MESSAGE }
  if (found.kind === 'not_reader') return { cancelled: false, orderId, reason: 'not_a_reader_order', message: NOT_A_READER_ORDER_MESSAGE }
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
        : finaliseResult.reason === 'subscription_starting'
          ? // W14 (W13c, review L2): nothing failed; another finalise is setting the membership up.
            `The reader payment went through, so the order wasn't cancelled. ${finaliseResult.message ?? ''}`.trim()
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
    case 'changed_since':
      // W12: the intent is cancelled (nothing more can be taken), but old code changed the booking, so
      // giving back what T1 claimed could give it twice. Left pending for a person (the stuck list).
      return { cancelled: false, orderId, reason: 'changed_since', message: CHANGED_SINCE_MESSAGE }
    case 'compensating':
      // W13: its money is being put back; the compensation (or reconcile) finishes it.
      return { cancelled: false, orderId, reason: 'compensation_unfinished', message: COMPENSATION_HELD_MESSAGE }
  }
}
