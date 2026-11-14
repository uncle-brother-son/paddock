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

// --- New in W28 (order refunds on the Worker; E-plan 4.3, 4.5, 4.6)

/**
 * W27 review L4: the order is held by a refund on a *booking* paid on the same card payment (a claim with a card part
 * on this order), so staff looking at the order see no refund on it. The words name the payment.
 */
export const ORDER_PAYMENT_REFUND_OPEN_MESSAGE =
  "A refund on this order's card payment is still being checked. Don't refund it again: check the Orders page in a few minutes."

const money = (pounds: number): string => `£${pounds.toFixed(2)}`

/** What a person does about card money that never went: the two buttons on the order, after checking Stripe. */
const CHECK_STRIPE_FIRST = 'Check Stripe first: if the money already reached the customer, use It already arrived; if not, use Refund the rest.'

/** W28a (review S2): the same after a refusal Stripe gave. Stripe has just said no, so there is nothing to check there. */
const USE_REFUND_THE_REST = 'Use Refund the rest to give it another way.'

/** What to do about card money left owed: `refusedByStripe` is false only for a refund the press had no time to send. */
const owedAdvice = (refusedByStripe: boolean): string => (refusedByStripe ? USE_REFUND_THE_REST : CHECK_STRIPE_FIRST)

/** The words W28 adds (none is moved from the old function: each is for something the old code didn't do). */
export const ORDER_REFUND_NEW_WORDS = {
  /** E2: the order's payment hasn't finished (pending, failed), so there is nothing to give back yet. */
  orderNotPaid: "This order's payment hasn't finished, so nothing on it can be refunded yet. Finish or cancel the payment first, or use Resolve now on the Orders page after 15 minutes.",
  /** Review L3: no money moves without the figure staff were shown. */
  amountNotConfirmed: 'Check the refund figures and confirm again.',
  /** Q18's words (E-plan 4.7), for an order. */
  figuresChanged: 'The figures on this order have just changed. Check them and confirm again.',
  /** Q42: cash can only be handed back for cash paid on the order. */
  noCashLeft: 'No cash paid on this order is left to hand back, so this can only go to store credit.',
  onlyCashLeft: (limit: number): string => `Only ${money(limit)} of the cash paid on this order can be handed back. Check the amount and confirm again.`,
  owedMethodInvalid: 'refundMethod must be "card", "credit" or "cash".',
  amountNotPositive: 'The amount must be more than £0.',
  nothingOwed: 'Nothing is owed on this order any more.',
  owedChanged: (owed: number): string => `The amount owed has changed to ${money(owed)}. Check it and confirm again.`,
  onlyOwed: (owed: number): string => `Only ${money(owed)} is still to refund on this order. Check the amount and confirm again.`,
  reasonRequired: 'A reason is required for this.',
  reasonTooLong: (max: number): string => `The reason must be ${max} characters or fewer.`,
  /** R1 failed in the database and was rolled back: nothing was claimed and nothing was sent. */
  notSaved: "The refund couldn't be saved (the system was busy, or one of its records couldn't be written), so nothing was refunded. Try again.",
  /** Refund the rest's card refund refused before anything went (the lines' own refusal keeps the old words). */
  owedCardRefundFailed: (detail: string): string => `The card refund failed, so nothing was refunded: ${detail}`,
  /** A part the press had no time left to send: nothing went, as a refusal. */
  notSentDetail: 'it was not sent: there was no time left to send it',
  /** What staff see for it: R1 was undone, so nothing was refunded and the same refund can be pressed again. */
  notSentInTime: "The card refund wasn't sent in time, so nothing was refunded. Try again.",
  /** No clear answer from Stripe: held for the automatic check (Q35's words). */
  unconfirmed: "The refund didn't get a clear answer, so it may or may not have gone. Don't refund it again. Check the Orders page in a few minutes.",
  /** The card part went and R2 couldn't record it yet: held for the automatic check, which records it (never resent). */
  goneNotRecorded: (cardGone: number): string =>
    `${money(cardGone)} went back to the card, but the refund couldn't be finished on the order yet. It's on hold: don't refund it again. Check the Orders page in a few minutes.`,
  /** The card refund was refused and the lines can't go back as they were (a restocked item has been sold since). */
  putBackBlocked: (detail: string, owed: number, refusedByStripe: boolean): string =>
    `The card refund was refused (${detail}), so nothing went back, and the order can't be put back as it was: stock it returned has been sold since. The refund stands, and ${money(owed)} shows on the order as still to refund. ${owedAdvice(refusedByStripe)}`,
  putBackBlockedNotRecorded: (detail: string): string =>
    `The card refund was refused (${detail}), so nothing went back, and the order can't be put back as it was: stock it returned has been sold since. The refund stands, but the money still to refund couldn't be recorded on the order yet. Don't refund it again: check the Orders page in a few minutes.`,
  /** The same when the undo failed for any other reason (a database fault). */
  putBackFailed: (detail: string, owed: number, refusedByStripe: boolean): string =>
    `The card refund was refused (${detail}), so nothing went back, and the order couldn't be put back as it was. The refund stands, and ${money(owed)} shows on the order as still to refund. ${owedAdvice(refusedByStripe)}`,
  putBackFailedNotRecorded: (detail: string): string =>
    `The card refund was refused (${detail}), so nothing went back, and the order couldn't be put back as it was. The refund stands, but the money still to refund couldn't be recorded on the order yet. Don't refund it again: check the Orders page in a few minutes.`,
} as const

// --- New in W29 (the membership line and the payment date change charge; E-plan 4.3, Wayne's Q40 and Q41)

/** The words W29 adds (the old `membership_instance_not_found` words are ORDER_REFUND_WORDS.membershipNotFound). */
export const MEMBERSHIP_REFUND_WORDS = {
  /**
   * Q40: the membership was paid by a card payment of its own, so its Card refund is a refund of that payment and
   * can't be sent together with a refund of the order's other payment (a claim has one card part).
   */
  refundAlone:
    'This membership was paid by its own card payment, separate from the rest of the order. To refund it to the card, refund the membership line on its own, then the other lines.',
  /** Q40: an order from before the booking system recorded the membership's own payment (placed before 11 Nov 2026). */
  paymentNotRecorded:
    "This membership was paid by its own card payment, which this order doesn't name, so it can't go back to the card from here. Use store credit instead, or tell a manager.",
  /** E10: the refund is done and the subscription's cancel is left for the automatic check. Added to the answer as a warning. */
  cancelLeft: (subscriptionId: string): string =>
    `The refund is done, but the membership's subscription (${subscriptionId}) couldn't be confirmed cancelled in Stripe yet, so it could still take its next payment. The automatic check tries again every 5 minutes, and it shows on the Orders page until it is cancelled. Don't refund it again.`,
  /** The stuck list's line for it, with what a person does if it stays. */
  cancelLeftListed: (subscriptionId: string): string =>
    `A membership was refunded, but its subscription (${subscriptionId}) couldn't be confirmed cancelled in Stripe yet, so it could still take its next payment. The automatic check tries again every 5 minutes. If this stays, cancel it in Stripe by hand, then press Mark sorted (needs the Issue refunds permission).`,
  /** R2's own note on the row it writes before the cancel is tried (as W13c's LEFT_AT_T2). */
  notCancelledYet: 'not cancelled yet: its membership has just been refunded',
} as const

/** Q41: what the dialog says under a membership line, before the press. Null when it has not been used. */
export function membershipUsedWords(creditSessionsTaken: number, futureCreditBookings: number): string | null {
  const parts: string[] = []
  if (creditSessionsTaken > 0) parts.push(`${creditSessionsTaken} credit ${creditSessionsTaken === 1 ? 'session' : 'sessions'} already taken`)
  if (futureCreditBookings > 0) parts.push(`${futureCreditBookings} future credit ${futureCreditBookings === 1 ? 'booking' : 'bookings'} will need payment`)
  return parts.length > 0 ? `${parts.join('; ')}.` : null
}

/** The reasons W28 adds to the old function's (ORDER_REFUND_REASONS), each with words above or a `refund_open` sentence. */
export const ORDER_REFUND_NEW_REASONS = [
  'refund_open',
  'order_not_paid',
  // W29 (Q40), in place of W28's `membership_not_built`.
  'membership_refund_alone',
  'membership_payment_not_recorded',
  'amount_not_confirmed',
  'figures_changed',
  'no_cash_left',
  'more_than_cash_left',
  'refund_not_saved',
  'amount_not_positive',
  'nothing_owed',
  'owed_changed',
  'more_than_owed',
  'reason_required',
  'reason_too_long',
] as const

/** The notes on Refund the rest's store credit on an order (W28). */
export const ORDER_OWED_NOTES = {
  storeCredit: 'Refund the rest of a failed order refund.',
  storeCreditAfterCard: 'Refund the rest of a failed order refund (the rest went back to the card).',
} as const
