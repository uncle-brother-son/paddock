import { getStaffAccessRow } from '../../../legacy-booking/backend/paddock/shared/staffAccess'
import { terminalPaymentIntentAction, type TerminalPaymentIntentInfo } from '../../../legacy-booking/backend/paddock/shared/terminalPaymentIntent'
import { loadReaderOrderRows, rollbackReaderOrder, startReaderRollback, type ReaderPaymentSnapshot } from './shared/readerOrderRollback'
import { saveCustomerCardOnFileUnguarded as saveCustomerCardOnFile } from './saveCustomerCardOnFile'
import createMembershipSubscription from './shared/createMembershipSubscription'
import { cancelMembershipSubscription } from '../../../legacy-refund/backend/paddock/shared/cancelMembershipSubscription'
import { addMonthsToIsoDate, londonToday } from '../../../legacy-booking/backend/paddock/shared/londonTime'

export interface FinaliseReaderOrderParams {
  orderId: string
  /** Brief W14a: the Worker route's Idempotency-Key. Made here when the caller sends none (a new key is safe:
   *  T2 locks the order and re-checks it). */
  idempotencyKey?: string
}

export interface FinaliseReaderOrderResult {
  finalised: boolean
  orderId?: string
  paymentIntentId?: string
  /** True when the order was already 'paid' with this same PaymentIntent — nothing was done. */
  alreadyFinalised?: boolean
  /** True when the PaymentIntent had NOT succeeded (callers should cancel instead). */
  paymentNotSucceeded?: boolean
  piStatus?: string
  reason?:
    | 'order_not_found'
    | 'not_a_reader_order'
    | 'unexpected_state'
    | 'payment_not_succeeded'
    | 'metadata_mismatch'
    | 'currency_mismatch'
    | 'amount_mismatch'
    | 'card_not_reusable'
    | 'exhausted_membership_cancellation_failed'
    | 'subscription_failed'
    | 'finalise_failed'
    | 'refund_failed'
    /** The refund gave no clear answer, so it may have gone. Resolve now (or cancelling) sends it
     *  again with the same key, so it can't be paid twice. */
    | 'refund_unsure'
    | 'rollback_started'
  message?: string
  membershipSubscriptionId?: string
  membershipId?: string
  warning?: string
}

const MEMBERSHIP_READER_DISCOUNT_LABEL = 'Paid on card reader'
const CARD_NOT_SAVED_WARNING = "The card couldn't be saved for future charges."

/** Normalizes a timestamp from the Stripe subscription response to the date-only form the
 *  customer_memberships columns store, falling back to `fallback` when absent/invalid. */
function toDateOnly(value: string | null | undefined, fallback: string): string {
  if (!value) return fallback
  const parsed = new Date(value)
  // The London calendar date of the instant (a UTC date is a day early just after midnight in BST).
  return Number.isNaN(parsed.getTime()) ? fallback : londonToday(parsed)
}


/**
 * Finalises a pending reader order (the new flow: createOrder left the order 'pending' and
 * created the PaymentIntent; the frontend collected it on the reader). Verifies the PaymentIntent
 * server-side (succeeded, GBP, amount, metadata.order_id), saves the card when the order asked
 * for it, then replays everything createOrder does after a successful charge — for a membership:
 * cancel the deferred exhausted-membership subscription, create the Stripe subscription with
 * discountAmount covering the WHOLE first payment (the reader already took it, so the first
 * invoice is £0 and renewals run on the saved card), and write the customer_memberships row.
 *
 * Any failure after the money was taken refunds the PaymentIntent IN FULL and rolls the order
 * back, so staff never have money taken without an order. The exception is a card that can't be
 * saved on a basket with no membership: the order still completes, with a warning. Idempotent: an
 * already-paid order with the same PaymentIntent returns success without doing anything. An order
 * whose rollback has started is refused with 'rollback_started': its PaymentIntent can still read
 * 'succeeded' after the refund, so only cancelReaderOrder may touch it.
 */
/**
 * @retool-slow-reviewed
 * Evidence: the function's data retrieval is loadReaderOrderRows (shared/readerOrderRollback.ts)
 * — a pkey lookup on orders, the order's line items, and (only when present) bookings/
 * customer_memberships/customer_session_passes by order_line_item_id. EXPLAIN (ANALYZE) of these
 * exact queries executes in 2.4ms (orders), 1.4ms (order_line_items, 0 rows, small table) and
 * 0.07ms (customer_memberships ANY-array) — nothing to optimize. The ~10.6s runtime is the
 * strictly sequential external work: the Stripe PaymentIntent retrieve, the Worker's
 * resolve-saved-card (saveCustomerCardOnFile), and createMembershipSubscription (the Worker
 * creates the Stripe subscription and charges the first invoice — comparable Stripe-heavy runs
 * like finaliseReaderPayment take 6-7s on their own), plus the Postgres writes that must happen
 * in that order because the subscription depends on the resolved saved card.
 */
export default async function finaliseReaderOrder(req: { params: FinaliseReaderOrderParams; user: User }): Promise<FinaliseReaderOrderResult> {
  const staff = await getStaffAccessRow(req.user.email)
  if (!staff) {
    return { finalised: false, reason: 'unexpected_state', message: 'No staff record matches the logged-in user.' }
  }
  const { orderId } = req.params
  if (!orderId) {
    return { finalised: false, reason: 'order_not_found', message: 'orderId is required.' }
  }

  const rows = await loadReaderOrderRows(orderId)
  if (!rows) {
    return { finalised: false, orderId, reason: 'order_not_found', message: 'That order no longer exists.' }
  }
  const snapshot: ReaderPaymentSnapshot = rows.order.reader_payment ?? {}
  if (!snapshot.payment_intent_id || snapshot.expected_amount === undefined) {
    return { finalised: false, orderId, reason: 'not_a_reader_order', message: 'This order is not a pending card-reader order.' }
  }
  if (rows.order.payment_status === 'paid') {
    if (rows.order.stripe_payment_intent_id === snapshot.payment_intent_id) {
      return {
        finalised: true,
        orderId,
        paymentIntentId: snapshot.payment_intent_id,
        alreadyFinalised: true,
        message: 'This order was already finalised — nothing further was done.',
      }
    }
    return { finalised: false, orderId, reason: 'unexpected_state', message: 'This order is already paid by a different payment.' }
  }
  if (rows.order.payment_status !== 'pending') {
    return {
      finalised: false,
      orderId,
      reason: 'unexpected_state',
      message: `This order is in state "${rows.order.payment_status}" and cannot be finalised.`,
    }
  }
  if (snapshot.rollback) {
    return {
      finalised: false,
      orderId,
      reason: 'rollback_started',
      message: 'This order is already being rolled back, so it can\'t be finalised.',
    }
  }

  const retrieved = await terminalPaymentIntentAction(snapshot.payment_intent_id, 'retrieve')
  if (!retrieved.ok || !retrieved.paymentIntent) {
    return {
      finalised: false,
      orderId,
      reason: 'unexpected_state',
      message: retrieved.message ?? 'Failed to look up the PaymentIntent in Stripe.',
    }
  }
  const pi: TerminalPaymentIntentInfo = retrieved.paymentIntent
  if (pi.status !== 'succeeded') {
    return {
      finalised: false,
      orderId,
      reason: 'payment_not_succeeded',
      paymentNotSucceeded: true,
      piStatus: pi.status,
      message: `The reader payment has not succeeded yet (status: ${pi.status}). Cancel the order or retry the card on the reader.`,
    }
  }
  if ((pi.metadata['order_id'] ?? '') !== orderId) {
    return {
      finalised: false,
      orderId,
      reason: 'metadata_mismatch',
      message: 'This PaymentIntent does not belong to this order (metadata mismatch) — check it in Stripe before doing anything.',
    }
  }
  if (pi.currency !== 'gbp') {
    return {
      finalised: false,
      orderId,
      reason: 'currency_mismatch',
      message: `The reader payment is in ${pi.currency.toUpperCase()}, not GBP — check it in Stripe before doing anything.`,
    }
  }
  if (Math.abs(pi.amountReceived - snapshot.expected_amount) > 0.01) {
    return {
      finalised: false,
      orderId,
      reason: 'amount_mismatch',
      message: `The reader charged £${pi.amountReceived.toFixed(2)} but the order expected £${snapshot.expected_amount.toFixed(2)} — do NOT finalise automatically. Check the PaymentIntent (${pi.id}) in Stripe and refund/adjust manually.`,
    }
  }

  const customerId = rows.order.customer_id
  const membership = snapshot.membership ?? null

  let membershipSubscriptionId: string | undefined
  let membershipId: string | undefined

  /** Money was taken but the order could not be finalised: cancel any subscription just created,
   *  refund the PaymentIntent IN FULL and roll the whole pending order back, then report why. The
   *  order is marked first, so a sweep can never finalise it once the refund has gone through. */
  async function refundAndRollback(reason: NonNullable<FinaliseReaderOrderResult['reason']>, staffMessage: string): Promise<FinaliseReaderOrderResult> {
    const refundNow = `REFUND £${pi.amountReceived.toFixed(2)} in Stripe (payment ${pi.id}) NOW, then rebuild the order.`
    let started = false
    let startProblem = 'the order is no longer pending'
    try {
      started = await startReaderRollback(orderId, { paymentIntentId: pi.id, amount: pi.amountReceived })
    } catch (err) {
      startProblem = err instanceof Error ? err.message : String(err)
    }
    if (!started) {
      return {
        finalised: false,
        orderId,
        reason: 'refund_failed',
        message:
          `Finalisation failed (${staffMessage}) and the order couldn't be set up for its refund (${startProblem}), so no refund was made — ` +
          `the customer's card was charged £${pi.amountReceived.toFixed(2)}. Check the order first, and if it isn't paid, ${refundNow}`,
      }
    }

    // A subscription must not outlive a failed finalisation: it would keep billing the customer.
    let subscriptionNote = ''
    if (membershipSubscriptionId) {
      const cancelled = await cancelMembershipSubscription(membershipSubscriptionId)
      if (cancelled.attempted && !cancelled.success) {
        subscriptionNote = ` The membership subscription (${membershipSubscriptionId}) could not be cancelled: CANCEL IT in Stripe NOW${cancelled.message ? ` (${cancelled.message})` : ''}.`
      }
    }

    const rollback = await rollbackReaderOrder(orderId)
    if (rollback.reason === 'refund_unsure') {
      return {
        finalised: false,
        orderId,
        reason: 'refund_unsure',
        message:
          `Finalisation failed (${staffMessage}) and the automatic refund of £${pi.amountReceived.toFixed(2)} gave no clear answer, so it may have gone through. ` +
          `Check payment ${pi.id} in Stripe, but don't refund it there by hand: Resolve now on the Orders page, after 15 minutes, sends the same refund again and can't pay it twice, then finishes the rollback.${subscriptionNote}`,
      }
    }
    if (rollback.reason === 'refund_failed') {
      return {
        finalised: false,
        orderId,
        reason: 'refund_failed',
        message:
          `Finalisation failed (${staffMessage}) AND the automatic refund failed — the customer's card was charged £${pi.amountReceived.toFixed(2)} ` +
          `with no order kept. ${refundNow}${subscriptionNote}`,
      }
    }
    if (!rollback.rolledBack) {
      return {
        finalised: false,
        orderId,
        reason,
        message:
          `${staffMessage} The customer's card has been refunded in full (payment ${pi.id}), but the order couldn't be fully rolled back yet. ` +
          `It's still on the Orders page, and Resolve now will finish it once it's 15 minutes old${rollback.problems?.length ? ` (${rollback.problems.join('; ')})` : ''}.${subscriptionNote}`,
      }
    }
    const rollbackNote = rollback.problems && rollback.problems.length > 0 ? ` (rollback finished with warnings: ${rollback.problems.join('; ')})` : ''
    return {
      finalised: false,
      orderId,
      reason,
      message: `${staffMessage} The customer's card has been refunded in full (payment ${pi.id}) and the order was rolled back${rollbackNote}.${subscriptionNote}`,
    }
  }

  const warnings: string[] = []

  // --- Save the card (the reader tap's setup_future_usage makes it reusable) ------------------
  if (snapshot.save_card) {
    try {
      await saveCustomerCardOnFile({ params: { customerId, paymentIntentId: pi.id } })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // A membership NEEDS the reusable card for renewals — without it the subscription must not
      // be created. For non-membership baskets the saved card is a nice-to-have: the money was
      // taken, so the order carries on and is marked paid below.
      if (membership) {
        return refundAndRollback('card_not_reusable', `Saving the card for the membership failed: ${message}`)
      }
      warnings.push(CARD_NOT_SAVED_WARNING)
    }
  }

  // --- Membership: deferred exhausted-membership cancellation, then the subscription -----------
  if (membership) {
    if (snapshot.exhausted_membership_stripe_id) {
      const cancelResult = await cancelMembershipSubscription(snapshot.exhausted_membership_stripe_id)
      if (cancelResult.attempted && !cancelResult.success) {
        return refundAndRollback(
          'exhausted_membership_cancellation_failed',
          `Cancelling the customer's previous membership subscription failed: ${cancelResult.message ?? 'unknown error'}`
        )
      }
    }
    const subscriptionResult = await createMembershipSubscription({
      customerId,
      membershipPlanId: membership.plan_id,
      billingFrequency: membership.billing_frequency,
      ...(membership.idempotency_key ? { idempotencyKey: membership.idempotency_key } : {}),
      // The reader already took the membership's first payment (promo share + credit parts +
      // reader share all went through non-Stripe rails), so the first invoice is £0 in total and
      // renewals run on the saved card.
      discountAmount: membership.price,
      discountLabel: MEMBERSHIP_READER_DISCOUNT_LABEL,
    })
    if (!subscriptionResult.ok) {
      return refundAndRollback('subscription_failed', `Creating the Stripe subscription failed: ${subscriptionResult.message}`)
    }
    membershipSubscriptionId = subscriptionResult.subscription.subscriptionId
    const startDate = toDateOnly(subscriptionResult.subscription.currentPeriodStart, londonToday())
    const nextRenewal = toDateOnly(
      subscriptionResult.subscription.currentPeriodEnd,
      addMonthsToIsoDate(londonToday(), membership.billing_frequency === 'yearly' ? 12 : 1)
    )

    try {
      if (membership.membership_row_id) {
        // Buy-new flow: the row already exists (created while pending, NULL subscription id) — patch it.
        const patched = await paddockData.query<{ id: string }>(
          `UPDATE customer_memberships
           SET stripe_subscription_id = $1, subscription_status = $2, start_date = $3, next_renewal_date = $4, updated_at = now()
           WHERE id = $5
           RETURNING id`,
          [membershipSubscriptionId, subscriptionResult.subscription.status ?? 'active', startDate, nextRenewal, membership.membership_row_id]
        )
        membershipId = patched.data[0]?.id
        await paddockData.query('SELECT public.allocate_membership_credit_periods()', [])
      } else {
        const planDetail = await paddockData.query<{ addons_included: number | null }>(
          'SELECT addons_included FROM membership_plans WHERE id = $1',
          [membership.plan_id]
        )
        const membershipLine = rows.lines.find((l) => l.item_type === 'membership')
        if (!membershipLine) {
          return refundAndRollback('finalise_failed', 'The order has no membership line item to attach the membership to.')
        }
        const inserted = await paddockData.query<{ id: string }>(
          `INSERT INTO customer_memberships
             (customer_id, plan_id, start_date, next_renewal_date, addon_credits_remaining,
              subscription_status, stripe_subscription_id, order_line_item_id, billing_frequency, is_herd)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           RETURNING id`,
          [
            customerId,
            membership.plan_id,
            startDate,
            nextRenewal,
            planDetail.data[0]?.addons_included ?? 0,
            subscriptionResult.subscription.status ?? 'active',
            membershipSubscriptionId,
            membershipLine.id,
            membership.billing_frequency,
            membership.billing_frequency === 'yearly',
          ]
        )
        membershipId = inserted.data[0]!.id
        await paddockData.query('SELECT public.allocate_membership_credit_periods()', [])
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return refundAndRollback('finalise_failed', `Saving the membership failed: ${message}`)
    }
  }

  // --- Confirm the event booking (created 'pending' with the order) ---------------------------
  if (rows.eventBookingId) {
    try {
      await paddockData.query(
        `UPDATE event_bookings SET status = 'confirmed', updated_at = now() WHERE id = $1 AND status = 'pending'`,
        [rows.eventBookingId]
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return refundAndRollback('finalise_failed', `Confirming the event booking failed: ${message}`)
    }
  }

  // --- Mark the order paid ----------------------------------------------------------------------
  // Only while still pending with no rollback started, and only "completed" if a row really changed.
  let markedPaid: boolean
  try {
    const marked = await paddockData.query<{ id: string }>(
      `UPDATE orders SET payment_status = 'paid', stripe_payment_intent_id = $1, payment_method = 'reader', updated_at = now()
       WHERE id = $2 AND payment_status = 'pending' AND reader_payment->'rollback' IS NULL
       RETURNING id`,
      [pi.id, orderId]
    )
    markedPaid = marked.data.length > 0
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return refundAndRollback('finalise_failed', `Marking the order as paid failed: ${message}`)
  }
  if (!markedPaid) {
    // Another run got there first. Report what it did, never "completed" on this run's say-so.
    const current = await loadReaderOrderRows(orderId)
    if (current?.order.payment_status === 'paid' && current.order.stripe_payment_intent_id === pi.id) {
      return {
        finalised: true,
        orderId,
        paymentIntentId: pi.id,
        alreadyFinalised: true,
        message: 'This order was already finalised — nothing further was done.',
      }
    }
    return {
      finalised: false,
      orderId,
      reason: 'unexpected_state',
      message: `The order changed while it was being finalised, so it wasn't marked paid. Check the order and the payment (${pi.id}) in Stripe before doing anything.`,
    }
  }

  // --- Non-critical bookkeeping (best-effort, like createOrder's post-charge steps) -------------
  if (snapshot.save_address_to_customer) {
    try {
      const address = await paddockData.query<{
        shipping_address: { line1: string; line2: string | null; city: string; postcode: string; country: string } | null
      }>('SELECT shipping_address FROM orders WHERE id = $1', [orderId])
      const a = address.data[0]?.shipping_address
      if (a) {
        await paddockData.query(
          `UPDATE customers SET address_line1 = $1, address_line2 = $2, city = $3, postcode = $4, country = $5, updated_at = now() WHERE id = $6`,
          [a.line1, a.line2, a.city, a.postcode, a.country, customerId]
        )
      }
    } catch (err) {
      warnings.push(`The order completed, but saving the delivery address to the customer's profile failed and needs a manual check: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return {
    finalised: true,
    orderId,
    paymentIntentId: pi.id,
    ...(membershipSubscriptionId ? { membershipSubscriptionId } : {}),
    ...(membershipId ? { membershipId } : {}),
    ...(warnings.length > 0 ? { warning: warnings.join(' ') } : {}),
  }
}
