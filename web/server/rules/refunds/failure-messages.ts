// New in W27 (E-plan 4.1, brief W27 item 5): the words of the refund pipeline's shared core, and every word staff see
// from an order refund (the staff app's refundOrder and RefundOrderDialog), moved here word for word ahead of the
// slices that use them (W28, W29). The event cancellations' words are in server/rules/events/failure-messages.ts.
// The test beside this file holds each to its source until the old function and the screen's own copy go.
import 'server-only'

// --- The pipeline's own (moved from server/rules/bookings/failure-messages.ts, which still exports it)

/** The legacy refund route's words for a refusal, which the old messages carried (`Failed to refund payment: …`). */
export const refundRefusedDetail = (stripeMessage: string): string => `Failed to refund payment: ${stripeMessage}`

// --- New in W27

/** The switch (E-plan 4.10, lead call L3), worded as step D's BOOKING_PATH_OFF. */
export const REFUND_PATH_OFF_MESSAGE = 'This is switched off in the booking system. Tell a manager.'

/**
 * An open claim holds its subject: no other refund on that order or event booking until reconcile settles it
 * (E-plan 4.2, `refund_open`). Step D's words for a booking, with the subject's own name.
 */
export const ORDER_REFUND_OPEN_MESSAGE = "A refund on this order is still being checked. Don't refund it again: check the Orders page in a few minutes."
export const EVENT_BOOKING_REFUND_OPEN_MESSAGE = "A refund on this event booking is still being checked. Don't refund it again: check the Orders page in a few minutes."

// --- Order refunds: every reason refundOrder answers with, and its words, word for word (E-plan 1.2)
//
// Moved ahead of W28 and W29, which use them. What is NOT moved, on purpose (E-plan 4.3, and "six things" item 4): the
// warnings that only described half-finished states the old code could leave ("needs a manual check", "recording it
// locally failed partway through", the store credit that "gave no clear answer"), and the words of the old "settle on
// the next press" machinery (shared/heldCardRefund's three "An earlier card refund..." sentences). One transaction and
// a key from the claim leave no such state to describe; W28 names each as a difference.

/** refundOrder's reasons, as its `RefundOrderFailureReason`. The test holds this list to the old function's own. */
export const ORDER_REFUND_REASONS = [
  'permission_denied',
  'invalid_params',
  'order_not_found',
  'line_item_not_found',
  'booking_not_supported',
  'use_event_cancellation',
  'already_refunded',
  'restock_decision_required',
  'no_payment_intent_for_card_refund',
  'gift_card_already_redeemed',
  'session_pass_already_used',
  'membership_instance_not_found',
  'session_pass_instance_not_found',
  'refund_failed',
  'refund_unsure',
  'store_credit_failed',
  'unexpected_error',
] as const
export type OrderRefundReason = (typeof ORDER_REFUND_REASONS)[number]

/** `order_not_found` and `unexpected_error` have no fixed words of their own: the first has none at all, the second carries the error's. */
export const ORDER_REFUND_WORDS = {
  // permission_denied (two texts)
  noStaffRecord: (email: string): string => `No staff record matches the logged-in user's email (${email}).`,
  notPermitted: 'This staff member is not permitted to issue refunds (can_issue_refunds is not enabled).',
  // invalid_params (two texts)
  orderAndLinesRequired: 'orderId and at least one lineItemId are required.',
  methodInvalid: 'refundMethod must be "card" or "credit".',
  // line_item_not_found
  lineNotOnOrder: 'One or more selected line items do not exist on this order.',
  // use_event_cancellation
  useEventCancellation: "Event places are cancelled and refunded from the event's attendee list.",
  // booking_not_supported
  bookingNotSupported: 'Booking line items are not refundable here — use the booking cancellation/refund flow instead.',
  // already_refunded
  alreadyRefunded: (lineIds: readonly string[]): string => `Already refunded: ${lineIds.join(', ')}`,
  // restock_decision_required
  restockDecisionRequired: (lineId: string): string => `A restock decision (true or false) is required for product line item ${lineId}.`,
  // gift_card_already_redeemed (two texts: not found; voided or any of it spent)
  giftCardNotFound: (lineId: string): string => `Gift card for line item ${lineId} not found.`,
  giftCardRedeemed: (lineId: string): string => `Gift card for line item ${lineId} has already been redeemed (or voided) in part or in full — it can no longer be refunded.`,
  // session_pass_instance_not_found
  passNotFound: (lineId: string): string => `No customer_session_passes row references line item ${lineId}.`,
  // session_pass_already_used
  passUsed: (lineId: string, remaining: number, granted: number): string =>
    `Session pass for line item ${lineId} has already had sessions used from it (${remaining} of ${granted} remaining) — it can no longer be refunded.`,
  // membership_instance_not_found
  membershipNotFound: (lineId: string): string => `No customer_memberships row references line item ${lineId}.`,
  // no_payment_intent_for_card_refund
  noPaymentIntent: 'This order has no stripe_payment_intent_id — nothing was ever charged to a card, so there is no card to refund. Use store credit instead.',
  // refund_failed (three texts: the check before the refund, Stripe's refusal with no words, the subscription cancel with no words)
  cardCheckFailed: (detail: string): string => `Checking the card payment failed, so nothing was refunded: ${detail}`,
  refundFailedFallback: 'Failed to refund payment',
  subscriptionCancelFailedFallback: 'Failed to cancel subscription',
  // store_credit_failed (three texts)
  storeCreditNoCustomer: 'The order has no matching customer record — the store credit could not be applied and no refund was processed.',
  storeCreditAmountInvalid: 'The refund amount was invalid — no store credit was applied.',
  storeCreditFailed: 'Applying the store credit failed — no refund was processed.',
} as const

/**
 * `refund_unsure`: the old words for a card refund with no clear answer (shared/heldCardRefund.ts, used by refundOrder
 * and the event cancellations alike). Its second sentence ("pressing again first finds out whether it went") is only
 * true of the old code; W28 and W30 hold a claim for reconcile instead and name the change of words as a difference.
 */
export const heldRefundMessage = (amount: number): string =>
  `The card refund of £${amount.toFixed(2)} gave no clear answer, so it may have gone through, and nothing else was done. ` +
  "Check Stripe, but don't refund it there by hand: pressing again first finds out whether it went, and can't pay it twice."

/** The notes refundOrder gives its store credit rows, and the reason on a restock's stock adjustment (rows the replay compares). */
export const ORDER_REFUND_NOTES = {
  storeCreditAfterCard: 'Refund to store credit — the lines refunded exceeded the card portion of the payment; the card part went back to the card.',
  storeCredit: 'Refund to store credit — order line items refunded by staff.',
  restock: (orderId: string): string => `Refund Restock (Order #${orderId})`,
} as const

/** The Refund Line Items dialog's own words (RefundOrderDialog.tsx): what it says before, or instead of, the function's. */
export const ORDER_REFUND_DIALOG_WORDS = {
  restockChoiceMissing: 'Choose whether to restock every product line item selected.',
  noResponse: 'No response from the refund endpoint.',
  /** When a refusal carries no message (`order_not_found`): the reason in brackets. */
  refusedWithNoWords: (reason: string | undefined): string => `Refund failed (${reason ?? 'unknown reason'}).`,
  fallback: 'Failed to refund order.',
} as const
