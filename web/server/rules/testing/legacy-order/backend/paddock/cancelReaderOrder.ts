import { getStaffAccessRow } from '@retool-app/backend/paddock/shared/staffAccess'
import { terminalPaymentIntentAction } from '@retool-app/backend/paddock/shared/terminalPaymentIntent'
import { loadReaderOrderRows, rollbackReaderOrder } from './shared/readerOrderRollback'
import finaliseReaderOrder, { type FinaliseReaderOrderResult } from './finaliseReaderOrder'

export interface CancelReaderOrderParams {
  orderId: string
  /** Brief W14a: the Worker route's Idempotency-Key, made here when the caller sends none (safe twice). */
  idempotencyKey?: string
}

export interface CancelReaderOrderResult {
  cancelled: boolean
  orderId?: string
  /** True when the order was already gone — nothing to cancel (idempotent success). */
  alreadyGone?: boolean
  /** True when the reader payment had in fact SUCCEEDED: the order was finalised instead of
   *  cancelled (money moved, so the sale is real). Check `finalised`. */
  finalisedInstead?: boolean
  finaliseResult?: FinaliseReaderOrderResult
  reason?:
    | 'order_not_found'
    | 'not_a_reader_order'
    | 'already_paid'
    | 'already_cancelled'
    | 'stripe_error'
    | 'rollback_incomplete'
    | 'refund_failed'
    /** The refund owed gave no clear answer: running it again sends it with the same key. */
    | 'refund_unsure'
  message?: string
  warning?: string
}

/**
 * Cancels a pending reader order when the reader payment is cancelled, declined or times out.
 * Asks the Worker to cancel the PaymentIntent — the Worker NEVER cancels a succeeded intent and
 * reports `alreadySucceeded` instead, in which case this function FINALISES the order (the money
 * moved, so the sale is real). Otherwise it rolls back exactly what the saved-card failure path
 * rolls back (bookings/seats, stock, promo redemption, gift card, store credit, membership/pass
 * rows, the order itself) via the shared rows-based helper.
 *
 * Idempotent: an order that no longer exists (already rolled back) returns success. An order
 * whose rollback has already started goes straight back to it: its PaymentIntent is settled (and if
 * finalise refunded it, it still reads 'succeeded', which must not turn into a finalise).
 */
export default async function cancelReaderOrder(req: { params: CancelReaderOrderParams; user: User }): Promise<CancelReaderOrderResult> {
  const staff = await getStaffAccessRow(req.user.email)
  if (!staff) {
    return { cancelled: false, reason: 'stripe_error', message: 'No staff record matches the logged-in user.' }
  }
  const { orderId } = req.params
  if (!orderId) {
    return { cancelled: false, reason: 'order_not_found', message: 'orderId is required.' }
  }

  const rows = await loadReaderOrderRows(orderId)
  if (!rows) {
    // Already rolled back (or never existed) — idempotent success.
    return { cancelled: true, orderId, alreadyGone: true, message: 'The order was already rolled back — nothing to do.' }
  }
  const snapshot = rows.order.reader_payment
  if (!snapshot?.payment_intent_id) {
    return { cancelled: false, orderId, reason: 'not_a_reader_order', message: 'This order is not a pending card-reader order.' }
  }
  if (rows.order.payment_status === 'paid') {
    return {
      cancelled: false,
      orderId,
      reason: 'already_paid',
      message: 'This order is already paid — it cannot be cancelled. Refund it through the order refund flow instead.',
    }
  }
  if (rows.order.payment_status !== 'pending') {
    return { cancelled: false, orderId, reason: 'already_cancelled', message: `This order is in state "${rows.order.payment_status}" and cannot be cancelled.` }
  }

  if (!snapshot.rollback) {
    const pi = await terminalPaymentIntentAction(snapshot.payment_intent_id, 'cancel')
    if (!pi.ok && pi.code !== 'not_found') {
      // Anything but a clear answer means we cannot know the intent's true state (a Stripe failure,
      // an error page, or an intent too far along to cancel) — do NOT roll back blind; the money may
      // already have moved. An intent that doesn't exist never took any.
      return {
        cancelled: false,
        orderId,
        reason: 'stripe_error',
        message: pi.message ?? 'Failed to cancel the PaymentIntent in Stripe — the order is still pending; retry after checking the payment in Stripe.',
      }
    }
    if (pi.alreadySucceeded) {
      // Money moved — finalise the order instead of cancelling it.
      const finaliseResult = await finaliseReaderOrder({ params: { orderId }, user: req.user })
      return {
        cancelled: false,
        orderId,
        finalisedInstead: true,
        finaliseResult,
        message: finaliseResult.finalised
          ? 'The reader payment actually succeeded — the order was finalised instead of cancelled.'
          : `The reader payment actually succeeded, but finalising it failed: ${finaliseResult.message ?? finaliseResult.reason}`,
      }
    }
  }

  // Cancelled (or the intent was already dead — cancelled/expired/abandoned): roll back.
  const rollback = await rollbackReaderOrder(orderId)
  if (rollback.reason === 'already_paid') {
    return {
      cancelled: false,
      orderId,
      reason: 'already_paid',
      message: 'The order could not be rolled back — it appears to have been paid meanwhile.',
    }
  }
  if (rollback.reason === 'refund_unsure') {
    const owed = rollback.refund
    return {
      cancelled: false,
      orderId,
      reason: 'refund_unsure',
      message:
        `The automatic refund of £${(owed?.amount ?? 0).toFixed(2)} gave no clear answer again, so it may have gone through. Check payment ${owed?.paymentIntentId ?? snapshot.payment_intent_id} in Stripe, ` +
        "but don't refund it there by hand: the next Resolve now sends the same refund again and can't pay it twice, then finishes cancelling.",
    }
  }
  if (rollback.reason === 'refund_failed') {
    const owed = rollback.refund
    return {
      cancelled: false,
      orderId,
      reason: 'refund_failed',
      message:
        `The automatic refund failed again (${owed?.message ?? 'no reason given'}). REFUND £${(owed?.amount ?? 0).toFixed(2)} in Stripe (payment ${owed?.paymentIntentId ?? snapshot.payment_intent_id}) NOW. ` +
        'The order finishes cancelling the next time Resolve now runs after that.',
    }
  }
  if (!rollback.rolledBack) {
    return {
      cancelled: false,
      orderId,
      reason: 'rollback_incomplete',
      message:
        "The order couldn't be fully cancelled yet. It's still on the Orders page, and Resolve now will finish it once it's 15 minutes old" +
        `${rollback.problems?.length ? ` (${rollback.problems.join('; ')})` : ''}.`,
    }
  }
  return {
    cancelled: true,
    orderId,
    ...(rollback.problems && rollback.problems.length > 0
      ? { warning: `The order was rolled back with warnings that need a manual check: ${rollback.problems.join('; ')}` }
      : {}),
    message: 'The pending order was cancelled and everything it held was released.',
  }
}
