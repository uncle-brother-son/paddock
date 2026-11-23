// New in W36 (F-plan 4.1, brief W36 item 1): every word staff see from a membership action, moved here word for word
// from the staff app's functions (setMembershipCancellation, changeMembershipPaymentDate, shared/membershipPaymentDate,
// adjustMembershipCredits, setMembershipHerd), the three legacy membership routes and the dialogs, ahead of the slices
// that use them (W37 credits and Herd, W40 cancel and undo, W41 payment date). Nothing uses them yet. The test beside
// this file holds each to its source (the old code's words, pinned in testing/old-words.json, and the dialogs).
//
// What is NOT moved, on purpose: words that only describe a state the Worker's version can't leave. The legacy
// plumbing between Retool and the Worker ("returned an HTML page", "did not report success"); "If unsure, check Stripe
// for a 'Payment date change' charge" (FB1: the charge is held and reconciled); "refund it in Stripe" (FB3: a failed
// refund is listed); the "Fix by hand: add a paid card order…" warning (FB2: one transaction); "The attempt could not
// be marked failed"; and the legacy route's own checks of the membership row, which the quote refuses first in its own
// words. W40 and W41 name each as a difference.
import 'server-only'
import { CARD_FLOW_PAID_NOT_FINISHED_MESSAGE, CHANGE_PAYMENT_UNCONFIRMED_MESSAGE } from '@/server/rules/bookings/failure-messages'
import { ORDER_STILL_PROCESSING_MESSAGE } from '@/server/rules/orders/failure-messages'

export { INACTIVE_STAFF_MESSAGE, ISSUE_REFUNDS_NEEDED_MESSAGE } from '@/server/rules/bookings/failure-messages'

// --- New in W36

/** The switch (F-plan 4.11, lead call L3), worded as step D's BOOKING_PATH_OFF and step E's REFUND_PATH_OFF. */
export const MEMBERSHIP_PATH_OFF_MESSAGE = 'This is switched off in the booking system. Tell a manager.'

/**
 * Lead call L15, as the W36 review's L5 changed it (lead, 17 Nov): a payment date change whose charge got no clear
 * answer is held, in step D's saved-card sentence ("The change is on hold…"), not step C's ("The order is on hold"):
 * a payment date change has no order until it is finished. W41 uses it.
 */
export const PAYMENT_DATE_HELD_MESSAGE = CHANGE_PAYMENT_UNCONFIRMED_MESSAGE

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
/** "2027-01-09" as "9 January", on the digits. Anything else comes back unchanged. */
const dayAndMonth = (isoDate: string): string => {
  const match = /^\d{4}-(\d{2})-(\d{2})$/.exec(isoDate)
  const month = match ? MONTHS[Number(match[1]) - 1] : undefined
  return match && month ? `${Number(match[2])} ${month}` : isoDate
}

/**
 * W57a (W57 review S1): a member's move to their plan's new price, refused for good because the subscription in Stripe
 * renews at another interval than the membership says. Switching the one item across intervals would make Stripe
 * restart the billing period and charge the new price at once, so nothing is sent: a person decides which is right.
 * `stripe` is the interval Stripe shows (null: Stripe didn't say), `membership` the one the step was left for.
 */
const EVERY: Readonly<Record<string, string>> = { month: 'every month', year: 'every year' }
const SAYS: Readonly<Record<string, string>> = { month: 'monthly', year: 'yearly' }
const stripeRenews = (stripe: string | null): string => (stripe && EVERY[stripe] ? `renews ${EVERY[stripe]} in Stripe` : "doesn't say in Stripe how often it renews")
/** `membership` null: a move with no interval recorded, which the Worker never leaves (memberships/left.ts, checkWant). */
const membershipSays = (membership: 'month' | 'year' | null): string => (membership ? `their membership says ${SAYS[membership] ?? membership}` : "the move doesn't say how often their membership renews")
export const PRICE_MOVE_INTERVAL_WORDS = {
  /** The refusal itself (the step's `refused` row, and what reconcile reports). */
  refusal: (stripe: string | null, membership: 'month' | 'year' | null): string =>
    `This member's subscription ${stripeRenews(stripe)} but ${membershipSays(membership)}, so it was not moved. Check which is right, move it in Stripe by hand, then press Mark sorted.`,
  /** The stuck list's line. */
  stuck: (subscriptionId: string, stripe: string | null, membership: 'month' | 'year' | null): string =>
    `A membership plan's price was changed, but a member's subscription (${subscriptionId}) ${stripeRenews(stripe)} while ${membershipSays(membership)}, so it was not moved (moving it across would make Stripe charge the new price at once). Check which is right, move the subscription to the plan's new price in Stripe by hand, with no proration (or tell a manager), then press Mark sorted (needs the Issue refunds permission).`,
} as const

/**
 * A Stripe step left after the database change (memberships/left.ts, F-plan 4.10): the stuck list's line while the
 * automatic check is still sending it, and once Stripe has refused it for good (lead call L7). W40 (W36 review S2):
 * the `left` words say what to do if it stays (set it in Stripe by hand: the step is read first, so the next check
 * closes it). W40 (L2): `missing`, when the refusal is that Stripe has no such subscription.
 */
export const LEFT_STEP_WORDS = {
  cancel_at: {
    left: (subscriptionId: string): string =>
      `A membership's cancellation was recorded, but its subscription (${subscriptionId}) couldn't be confirmed changed in Stripe yet, so it could still renew past its last day. The automatic check tries again every 5 minutes. If this is still here after an hour, set it in Stripe by hand (or tell a manager): the next check then sees it and takes it off the list.`,
    refused: (subscriptionId: string): string =>
      `A membership's cancellation was recorded, but Stripe refused to change its subscription (${subscriptionId}), so the automatic check has stopped trying and it could still renew past its last day. Set or clear its cancel date in Stripe by hand to match the membership (or tell a manager), then press Mark sorted (needs the Issue refunds permission).`,
    /** W40 (W36 review L2): Stripe answered that it has no such subscription (deleted, or the other mode's key). */
    missing: (subscriptionId: string): string =>
      `A membership's cancellation was recorded, but Stripe can't find its subscription (${subscriptionId}) with the club's payment account details, so the automatic check has stopped trying. Tell a manager: the subscription may have been deleted in Stripe, or belong to the other mode. Once the membership and Stripe agree, press Mark sorted (needs the Issue refunds permission).`,
  },
  /**
   * W58b (the W45 audit's row 30; W40c review L1): a cancellation undone (its cancel date cleared). The risk is the
   * membership ending when staff didn't want it, not a renewal; and Stripe can't undo one it has already ended.
   */
  undo: {
    left: (subscriptionId: string): string =>
      `A membership's cancellation was undone, but its subscription (${subscriptionId}) couldn't be confirmed changed in Stripe yet, so it could still end on the cancel date. The automatic check tries again every 5 minutes. If this is still here after an hour, clear its cancel date in Stripe by hand (or tell a manager): the next check then sees it and takes it off the list.`,
    refused: (subscriptionId: string): string =>
      `A membership's cancellation was undone, but Stripe refused to change its subscription (${subscriptionId}), so the automatic check has stopped trying and it could still end on the cancel date. Clear its cancel date in Stripe by hand (or tell a manager), then press Mark sorted (needs the Issue refunds permission).`,
    ended: (subscriptionId: string): string =>
      `A membership's cancellation was undone, but its subscription (${subscriptionId}) has already ended in Stripe, so the undo can't be made there and the membership won't carry on. Tell a manager: if the customer wants to carry on, sell them a new membership. Then press Mark sorted (needs the Issue refunds permission).`,
  },
  payment_method: {
    left: (subscriptionId: string): string =>
      `A customer's card was replaced, but a membership's subscription (${subscriptionId}) couldn't be confirmed moved to the new card in Stripe yet, so its next payment could still go to the old card. The automatic check tries again every 5 minutes. If this is still here after an hour, set it in Stripe by hand (or tell a manager): the next check then sees it and takes it off the list.`,
    refused: (subscriptionId: string): string =>
      `A customer's card was replaced, but Stripe refused to move a membership's subscription (${subscriptionId}) to the new card, so the automatic check has stopped trying and its next payment could still go to the old card. Set the subscription's payment method in Stripe by hand (or tell a manager), then press Mark sorted (needs the Issue refunds permission).`,
    missing: (subscriptionId: string): string =>
      `A customer's card was replaced, but Stripe can't find a membership's subscription (${subscriptionId}) with the club's payment account details, so the automatic check has stopped trying. Tell a manager: the subscription may have been deleted in Stripe, or belong to the other mode. Once the membership and Stripe agree, press Mark sorted (needs the Issue refunds permission).`,
  },
  /** W57 (Q53): a member's move to their plan's new price, from their next renewal (catalog/plans.ts). */
  price: {
    left: (subscriptionId: string): string =>
      `A membership plan's price was changed, but a member's subscription (${subscriptionId}) couldn't be confirmed moved to the new price in Stripe yet, so their next renewal could still be at the old price. The automatic check tries again every 5 minutes. If this is still here after an hour, move the subscription to the plan's new price in Stripe by hand, with no proration (or tell a manager): the next check then sees it and takes it off the list.`,
    refused: (subscriptionId: string): string =>
      `A membership plan's price was changed, but Stripe refused to move a member's subscription (${subscriptionId}) to the new price, so the automatic check has stopped trying and they will keep renewing at the old price. Move the subscription to the plan's new price in Stripe by hand, with no proration (or tell a manager), then press Mark sorted (needs the Issue refunds permission).`,
    /**
     * W58b (item 3): the same, while the plan is off sale. Stripe won't move anyone onto an off-sale plan's price
     * (W58 item 0 refuses such a price change before anything is made; this is the line for a move refused before).
     */
    refusedOffSale: (subscriptionId: string): string =>
      `A membership plan's price was changed, but Stripe refused to move a member's subscription (${subscriptionId}) to the new price, and the plan is off sale: Stripe won't move anyone onto an off-sale plan's price. The automatic check has stopped trying and they will keep renewing at the old price. Put the plan back on sale first, then move the subscription to the plan's new price in Stripe by hand, with no proration (or tell a manager), then press Mark sorted (needs the Issue refunds permission).`,
    missing: (subscriptionId: string): string =>
      `A membership plan's price was changed, but Stripe can't find a member's subscription (${subscriptionId}) with the club's payment account details, so the automatic check has stopped trying. Tell a manager: the subscription may have been deleted in Stripe, or belong to the other mode. Once the membership and Stripe agree, press Mark sorted (needs the Issue refunds permission).`,
  },
  /**
   * W46: the check found the membership's own last day and the one Stripe's subscription gives are not the same
   * (`rowDay`, `stripeDay`: dates as YYYY-MM-DD, null for no end). Stripe refused nothing, and nothing was sent or
   * changed: a person decides which is right.
   */
  rowDiffers: (subscriptionId: string, rowDay: string | null, stripeDay: string | null): string =>
    `A membership and its subscription in Stripe (${subscriptionId}) don't agree about when it ends: the membership ${rowDay ? `says its last day is ${rowDay}` : 'has no last day'}, and Stripe ${stripeDay ? `ends it after ${stripeDay}` : 'has no end date, so it will keep renewing'}. Nothing was changed. Check which is right. If the membership is wrong, use Cancel membership or Undo cancellation on it so the two match (if it offers neither, tell a manager). If Stripe is wrong, set or clear the subscription's cancel date in Stripe by hand (or tell a manager). Then press Mark sorted (needs the Issue refunds permission).`,
  /**
   * W46 (W40b "Noticed" 2): a change that may not have reached Stripe, which the automatic check could not record to
   * send again because the database didn't take it. Every check tries again.
   */
  notLeftAgain: (subscriptionId: string): string =>
    `A membership's change may not have reached its subscription (${subscriptionId}) in Stripe, and the automatic check couldn't record it to try again. It tries again every 5 minutes, and this goes once it has. If this is still here after an hour, tell a manager.`,
  /**
   * W47r-e (W47r-d "Noticed" 3): a membership whose last day here has passed while Stripe's subscription is still
   * live (the automatic check read it, still-live.ts). `name`: the customer's, null when it isn't known. `lastDay`:
   * YYYY-MM-DD. No button: the line goes once Stripe has ended the subscription.
   */
  stillLive: (name: string | null, lastDay: string): string =>
    `${name ? `${name}'s membership` : 'A membership'} ended here on ${dayAndMonth(lastDay)}, but Stripe's subscription is still live and will keep charging. Tell a manager: cancel it in Stripe.`,
  /** The manual close's answer. */
  sorted: 'Marked as sorted. It is no longer listed.',
  notListed: 'This is no longer on the list (it was sorted in the meantime). Nothing was changed.',
  stillTrying: "Stripe hasn't refused this: the automatic check is still sending it. Nothing was changed. Wait for the next check (every 5 minutes) and look again.",
} as const

// --- Cancel and undo (setMembershipCancellation.ts, CancelMembershipDialog; the legacy routes /api/memberships/cancel and /undo-cancel left at W44)

/** setMembershipCancellation's reasons, as its result's `reason`. The test holds this list to the old function's own. */
export const MEMBERSHIP_CANCEL_REASONS = ['membership_not_found', 'not_active', 'already_cancelling', 'not_cancelling', 'permission_denied'] as const
export type MembershipCancelReason = (typeof MEMBERSHIP_CANCEL_REASONS)[number]

export const MEMBERSHIP_CANCEL_WORDS = {
  membershipIdRequired: 'membershipId is required',
  permissionDenied: 'Needs the Issue refunds permission to cancel or re-activate a membership.',
  /** The legacy routes' words (the function shows them as they are). */
  notFound: 'Membership not found',
  recordFailed: 'Failed to update membership record',
  /** When Stripe's refusal carries no words of its own. */
  stripeFailed: 'Failed to update Stripe subscription',
} as const

/**
 * CancelMembershipDialog's own words for each reason, which it shows in place of the function's. Three of the four
 * reasons were never produced by the old code (FB5); W40 produces them, with these words (F-plan 4.3).
 */
export const MEMBERSHIP_CANCEL_DIALOG_WORDS: Readonly<Record<Exclude<MembershipCancelReason, 'permission_denied'>, string>> = {
  membership_not_found: 'This membership could not be found.',
  not_active: 'This membership is not currently active.',
  already_cancelling: 'This membership is already scheduled to cancel.',
  not_cancelling: 'This membership has no pending cancellation to undo.',
}
/** The dialog's words when a refusal carries none. */
export const MEMBERSHIP_CANCEL_FALLBACK = 'Failed to update cancellation.'

/**
 * New in W40 (brief W40 items 1 and 4; F-plan 4.3): what the old code never said.
 * - `stillSending` (W36 review S1): the last cancel or undo on this membership is still inside its window, so its
 *   Stripe step may still be on its way; a new one waits its turn. W40a (W40 review L4): the window is 15 minutes,
 *   and the words say so.
 * - `renewalDueToday` (W40a; Wayne, 16 Nov): a cancel on the day the renewal is due (or after, while it is overdue),
 *   before the payment has moved the next payment date on.
 * - `noRenewalDate` (FB22): the old date sum threw on a membership with no next payment date.
 * - `paymentDateChanging`: a cancel while a payment date change is in progress (the press's own sentence for it).
 * - `left`: the change is saved and Stripe gave no clear answer, so its Stripe step is left for the automatic check.
 */
export const MEMBERSHIP_CANCEL_NEW_WORDS = {
  stillSending: 'The last change to this membership is still being sent to Stripe. Try again in 15 minutes.',
  renewalDueToday:
    "Today's payment for this membership hasn't gone through yet, so it can't be cancelled until it has. Try again after the payment (the membership will then end at its next renewal).",
  noRenewalDate: "This membership has no next payment date, so the day it would end can't be worked out. Nothing was changed. Tell a manager.",
  paymentDateChanging: 'A payment date change is already in progress for this membership.',
  left: "Saved here, but Stripe hasn't confirmed it yet. The automatic check keeps sending it (every 5 minutes), and it is listed on the Orders page until Stripe shows it. Don't press again.",
} as const

// --- Payment date change (changeMembershipPaymentDate.ts, shared/membershipPaymentDate.ts, the legacy route, the dialog)

/**
 * The quote's refusals, in the old order (paymentDateChangeRefusal, then the plan's price). Dates in these are worded
 * "28 Nov 2026" (shared/formatIsoDate), by the caller.
 */
export const PAYMENT_DATE_REFUSALS = {
  yearly: "Yearly memberships renew once a year, so the payment date can't be changed",
  paymentFailing: 'A payment is failing on this membership',
  notActive: "This membership isn't active",
  cancelScheduled: 'A cancellation is scheduled on this membership',
  renewalOverdue: 'The renewal payment is overdue',
  paymentNeeded: 'Bookings on this membership are waiting for payment (Payment needed)',
  noSubscription: 'This membership has no Stripe subscription',
  noSavedCard: 'The customer has no saved card for the charge',
  /** After a change, until its new date arrives. `changedOn` is null when the day it was changed isn't known. */
  changedRecently: (changedOn: string | null, from: string): string => `${changedOn ? `Changed on ${changedOn}. ` : ''}It can be changed again from ${from}.`,
  inProgress: 'A payment date change is already in progress for this membership',
  noMonthlyPrice: 'The plan has no monthly price',
} as const

export const PAYMENT_DATE_WORDS = {
  paramsRequired: 'membershipId and newRenewalDate are required',
  permissionDenied: 'Needs the Issue refunds permission to change a payment date.',
  notFound: 'Membership not found.',
  /** The window (the quote's `dateError`). */
  chooseDate: (earliest: string, latest: string): string => `Choose a date from ${earliest} to ${latest}`,
  noRenewalDate: 'This membership has no next renewal date',
  cannotWorkOut: 'Could not work out the part-month charge.',
  nothingToCharge: 'The part-month charge works out at £0.00, so there is nothing to charge.',
  overrideNeeded: 'The payment date was changed in the last 6 months. Tick Override and give a reason to change it again.',
  /** The press's own check for another press's pending record (with a full stop; the quote's refusal has none). */
  inProgress: 'A payment date change is already in progress for this membership.',
  /** A declined card. `stripeMessage` is Stripe's own, with its last full stop taken off. */
  declined: (stripeMessage: string): string => `The card was declined: ${stripeMessage}. Nothing was charged and the payment date has not changed.`,
  /** The legacy route's checks against Stripe's subscription. */
  customerMismatch: "The subscription doesn't belong to this customer's Stripe account",
  stripeNotActive: (status: string): string => `The Stripe subscription is ${status}, not active`,
  stripeCancelScheduled: 'The Stripe subscription has a cancellation scheduled',
  stripeNotMonthly: 'The Stripe subscription is not a single monthly price',
  /** The stale-date guard. Both dates as Stripe and the row give them; the function then words them "28 Nov 2026". */
  staleRenewalDate: (stripeDate: string, rowDate: string): string => `Stripe's next payment is on ${stripeDate}, but the membership shows ${rowDate}. Refresh and try again.`,
  amountTooHigh: 'partMonthAmount is more than a full month at the subscription price',
  authenticationRequired: 'Card requires additional authentication and cannot be charged off-session. Ask the customer to complete a new payment.',
  paymentNotCompleted: (status: string): string => `The card payment did not complete (status: ${status})`,
  /** The date move was refused and the charge given back. `stripeMessage` is Stripe's own. */
  refundedInFull: (stripeMessage: string): string => `${stripeMessage}. The part-month charge was refunded in full.`,
  /** What the charge is called in Stripe. */
  chargeDescription: (extraDays: number): string => `Payment date change: ${extraDays} extra days`,
  /** The two warnings on a change that went through (W41 keeps them): the legacy route's, and the old function's. */
  stripeReports: (trialEnd: number | null, anchor: number | null, expected: number): string =>
    `Stripe accepted the change but reports trial_end ${trialEnd} and billing_cycle_anchor ${anchor}, expected ${expected}: check the subscription in Stripe.`,
  nextPaymentNowOn: (stripeDate: string, askedDate: string): string => `Stripe's next payment is now on ${stripeDate}, not ${askedDate}: check the subscription in Stripe.`,
} as const

const money = (pounds: number): string => `£${pounds.toFixed(2)}`

/**
 * New in W41 (F-plan 4.4; brief W41 items 3 to 6): what the old code never said.
 * - `orderStillProcessing` (Q10, lead call L8): the customer has a card order on hold, in the order's own words.
 * - `figureChanged`, `figureMissing` (Q18, FB4): the charge worked out at the press isn't the one the dialog showed.
 * - `stepOpen`: a cancel or undo on this membership still has its Stripe step open.
 * - `notSent`: the charge wasn't sent for lack of time. Nothing reached Stripe.
 * - `paidNotFinished`: the card was charged and the change couldn't be finished here (the date move got no clear
 *   answer, or the record couldn't be written): held for the automatic check, in step D's sentence.
 * - `refundHeld`: Stripe refused the date move and the refund of the charge got no clear answer: held.
 * - `refundRefused`: Stripe refused the date move and then the refund too (FB3): listed for a person.
 * - `renewalDueToday` (W41a; Wayne, 17 Nov 2026): the quote and the press on the day the renewal is due, or after it
 *   while it is overdue (London), as W40a's cancel. Stripe takes that payment at the time of day the subscription
 *   began; a date moved before it lands would be moved over a month about to be paid for. The lists and the profile
 *   keep `renewalOverdue` for an overdue one and say nothing on the day itself.
 */
export const PAYMENT_DATE_NEW_WORDS = {
  orderStillProcessing: ORDER_STILL_PROCESSING_MESSAGE,
  /**
   * W58b (the W45 audit's row 42; W41a "Noticed" 2): the automatic check's own sentence when it looked again (W41a B1)
   * and the subscription no longer allowed the move, so the move was not sent. `checkMessage` is the press's check's
   * words, less their "Refresh and try again.", which is for a person at the dialog, not for this record.
   */
  recheckFailed: (checkMessage: string): string =>
    `The payment date wasn't moved: when the automatic check looked again, the subscription no longer allowed it (${checkMessage.replace(/\s*Refresh and try again\.\s*$/, '').replace(/\.+\s*$/, '')})`,
  figureChanged: (shown: number, now: number): string =>
    `The part-month charge is now ${money(now)}, not the ${money(shown)} shown. Nothing was charged and the payment date has not changed. Check the new figure with the customer and press again.`,
  figureMissing: 'The part-month charge shown on screen was not sent, so nothing was charged and the payment date has not changed. Refresh the page and try again.',
  stepOpen: "The last change to this membership hasn't been confirmed by Stripe yet (it is listed on the Orders page), so its payment date can't be changed. Nothing was charged. Try again once it is off the list.",
  notSent: 'The card was not charged: there was no time left to ask Stripe. Nothing was charged and the payment date has not changed. Try again.',
  paidNotFinished: CARD_FLOW_PAID_NOT_FINISHED_MESSAGE,
  refundHeld: (stripeMessage: string): string =>
    `Stripe refused to move the payment date (${stripeMessage}), and the refund of the part-month charge hasn't been confirmed yet. The change is on hold and the automatic check will finish the refund: don't take payment again. Check the Orders page in a few minutes.`,
  refundRefused: (stripeMessage: string, amount: number, paymentIntentId: string, refundMessage: string): string =>
    `${stripeMessage}. The ${money(amount)} charge (${paymentIntentId}) could not be refunded automatically (${refundMessage}). It is listed on the Orders page: refund it in Stripe by hand, then close the line there.`,
  renewalDueToday: "Today's payment for this membership hasn't gone through yet, so its payment date can't be changed until it has. Try again after the payment.",
} as const

const DONT_CHARGE_AGAIN = "Don't change the payment date or take the part-month charge again."
const CLOSE_DATE_CHANGE = 'Then press Close (needs the Issue refunds permission).'

/**
 * New in W41 (brief W41 item 5; F-plan 4.10): the stuck list's line for a payment date change that is held, by what
 * it is waiting on. A reason with no entry here uses the list's own words for it (step D's: `unclear`, `other_mode`,
 * `several_payments`, `amount_mismatch`, `payment_processing`, `not_started_here`, `unexpected`).
 */
export const PAYMENT_DATE_STUCK_WORDS: Readonly<Record<string, string>> = {
  waiting: `A payment date change didn't finish cleanly: its part-month charge may or may not have been taken. The automatic check, every 5 minutes, looks for the payment in Stripe and finishes the change or ends it; it never charges again. ${DONT_CHARGE_AGAIN}`,
  move_unconfirmed: `A payment date change's part-month charge was taken, but Stripe hasn't confirmed the new payment date yet. The automatic check tries again every 5 minutes. ${DONT_CHARGE_AGAIN}`,
  finalise_failed: `A payment date change's part-month charge was taken and Stripe shows the new payment date, but it couldn't be recorded yet. The automatic check tries again every 5 minutes. ${DONT_CHARGE_AGAIN}`,
  refund_unconfirmed: `Stripe refused to move a membership's payment date, and the refund of the part-month charge hasn't been confirmed yet. The automatic check tries again every 5 minutes. ${DONT_CHARGE_AGAIN}`,
  refund_refused: `Stripe refused to move a membership's payment date, and then refused the refund of the part-month charge, so the customer has paid for a change that didn't happen. Refund that payment in Stripe by hand (or tell a manager if Stripe won't). ${CLOSE_DATE_CHANGE}`,
  refunded_elsewhere: `A payment date change's part-month charge was taken and has since been refunded outside the booking system, so the automatic check has stopped: it won't move the payment date for a charge that was given back. Check the subscription's next payment date in Stripe (or tell a manager). ${CLOSE_DATE_CHANGE}`,
  subscription_missing: `A payment date change's part-month charge was taken, but Stripe can't find the membership's subscription with the club's payment account details, so the date can't be moved. Tell a manager: refund the payment in Stripe by hand if the date wasn't moved. ${CLOSE_DATE_CHANGE}`,
  fail_failed: "A payment date change took no money, but it couldn't be ended yet. The automatic check tries again every 5 minutes.",
  // W47 (W41 call 7, review L2; the W45 audit's row 37): what each is waiting for, and why there is no Close yet. A
  // close while the bank may still finish the payment could hide one that lands later, so Close is offered only once
  // Stripe says how the payment ended and the automatic check has left the change for a person.
  payment_processing: `A payment date change's part-month charge is still being processed by the customer's bank. Wait for the bank: the automatic check looks every 5 minutes and, once Stripe says whether the payment went through, finishes the change or ends it. It can't be closed by hand until then. ${DONT_CHARGE_AGAIN}`,
  // W47a (W47 review L7): the reason also covers a payment Stripe holds at `requires_confirmation` or
  // `requires_capture`, where nothing is waiting on the customer, so the words name the step as Stripe's.
  payment_needs_action: `A payment date change's part-month charge is waiting for a step Stripe needs (usually the customer's bank approval), which can't be done from here, so it won't finish on its own. Tell a manager: cancel that payment in Stripe. Once Stripe shows it cancelled, the automatic check ends the change within 5 minutes (nothing was taken) and the date can be changed again. It can't be closed by hand until then. ${DONT_CHARGE_AGAIN}`,
  // W58b (the W45 audit's row 38; W41 review L3): a payment date row the Worker didn't start (the old screens'), with
  // what to look for, in place of step D's general words.
  not_started_here: `The booking system has no record of starting this payment date change (it was made on the old screens), so the automatic check can't settle it. Look in Stripe for a "Payment date change" charge on this customer and at the subscription's next payment date: if the charge was taken and the date didn't move, refund the charge in Stripe by hand (or tell a manager). ${CLOSE_DATE_CHANGE}`,
}

/**
 * W58b (the W45 audit's row 42; W41a "Noticed" 1): the same two lines when the automatic check, looking again (W41a
 * B1), found the subscription no longer allowed the move and never sent it. Stripe refused nothing.
 */
export const PAYMENT_DATE_NOT_SENT_STUCK_WORDS: Readonly<Record<string, string>> = {
  refund_unconfirmed: `A payment date change wasn't made: when the automatic check looked again, the subscription no longer allowed it, so the date was never sent to Stripe. The refund of the part-month charge hasn't been confirmed yet. The automatic check tries again every 5 minutes. ${DONT_CHARGE_AGAIN}`,
  refund_refused: `A payment date change wasn't made: when the automatic check looked again, the subscription no longer allowed it, so the date was never sent to Stripe. Stripe then refused the refund of the part-month charge, so the customer has paid for a change that didn't happen. Refund that payment in Stripe by hand (or tell a manager if Stripe won't). ${CLOSE_DATE_CHANGE}`,
}

/** W58b: a payment date line's words: the not-sent words when the check never sent the move, else the reason's own. */
export const paymentDateStuckWords = (reason: string, notSent: boolean): string | undefined =>
  (notSent ? PAYMENT_DATE_NOT_SENT_STUCK_WORDS[reason] : undefined) ?? PAYMENT_DATE_STUCK_WORDS[reason]

// --- W47 (W46 review L2; W46b "Noticed" 2): Stripe's notices the Worker couldn't take in, on the Orders page's banner

/** A date and time as staff read it, in London: 12 November 2026 at 14:05. Built from two parts, so the join is ours. */
const londonMoment = (iso: string): string => {
  const at = new Date(iso)
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'long', year: 'numeric' }).format(at)
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at)
  return `${day} at ${time}`
}

/**
 * The banner's line for Stripe notices (webhook events) left in error, or never finished, for over an hour, or a live
 * one ignored because Stripe had no such subscription. It says what the notices are for, that it is a fault in the
 * set-up and not a member's doing, and who to call. `unreadable`: the notices couldn't be read at all.
 */
export const WEBHOOK_NOTICE_WORDS = {
  inError: (count: number, oldestAt: string): string =>
    `${count === 1 ? "The booking system couldn't take in 1 notice from Stripe" : `The booking system couldn't take in ${count} notices from Stripe`} (the oldest came in on ${londonMoment(oldestAt)}). Stripe's notices are how it hears that a membership payment was taken or failed, or that a membership ended, so a member's payment date, credits or bookings may be out of date here. This is a fault in the set-up between the booking system and Stripe, not anything a member has done, and nothing on this page can fix it: don't change memberships by hand to work round it. Tell a manager today, so they can call Uncle Brother Son, who look after the booking system.`,
  unreadable:
    "The booking system couldn't check whether Stripe's notices are getting through. This is a fault in its set-up, not anything a member has done. Tell a manager, so they can call Uncle Brother Son, who look after the booking system.",
} as const

/** The manual close's answers for a held payment date change (brief W41 item 5). */
export const PAYMENT_DATE_CLOSE_WORDS = {
  closed: (found: string): string => `Closed. The payment date change is recorded as not finished, and the membership can be changed again. What Stripe last showed: ${found}. Nothing was sent to Stripe.`,
  notListed: 'This payment date change is no longer on hold (it was finished or ended in the meantime). Nothing was changed.',
  stillChecking: "The automatic check is still working on this payment date change, so it can't be closed by hand. Nothing was changed. Wait for the next check (every 5 minutes) and look again.",
} as const

/**
 * ChangePaymentDateDialog's own words. W41: the dialog no longer has "No response from the server." or "Failed to
 * change the payment date." (a press with no answer now keeps its key and says the card may have been charged); it
 * has a fallback for a change on hold that came back with no words.
 */
export const PAYMENT_DATE_DIALOG_WORDS = {
  notChanged: 'The payment date was not changed.',
  onHold: 'The change is on hold. Check the Orders page in a few minutes.',
} as const

// --- W47r: "Try the payment again now" (memberships/retry-payment.ts; Wayne, 18 Nov 2026; the W47 review's point 10)

const bookings = (count: number): string => (count === 1 ? '1 booking' : `${count} bookings`)
/** "the Visa card ending 4444", "the card ending 4444", or "the saved card" when the last four aren't known. */
const cardWords = (brand: string | null, last4: string | null): string =>
  last4 ? `the ${brand ? `${brand.charAt(0).toUpperCase()}${brand.slice(1)} ` : ''}card ending ${last4}` : 'the saved card'
const NOTHING_CHARGED = 'Nothing was charged.'
/** W47r-a's `paid_after_end` sentence up to its last clause (W47r-b: with the check of the subscription for a row cancelled here). */
const paidAfterEndLead = (amount: number, last4: string | null, cancelledHere: boolean): string =>
  cancelledHere
    ? `${money(amount)} was taken on ${cardWords(null, last4)} after this membership had ended here. Refund it in Stripe (tell a manager) and check the subscription is cancelled in Stripe`
    : `${money(amount)} was taken on ${cardWords(null, last4)} after this membership's subscription had ended. Refund it in Stripe (tell a manager)`
const DONT_TAKE_AGAIN = "Don't take the payment again or another way."
/** Stripe's plain decline message, as the press hands it over (its last full stop taken off). */
const GENERIC_DECLINE = 'Your card was declined'

/**
 * Why a past-due membership's payment can't be tried again, before anything is sent to Stripe. Every one of these
 * ends "Nothing was charged." Dates are worded "28 Nov 2026" by the caller.
 * - The membership's own row: `notPastDue`, `lastDayPassed`, `noSubscription`, `noSavedCard`.
 * - Stripe's subscription, read at that moment (review point 2): `subscriptionMissing`, `notRead`, `customerMismatch`,
 *   `stripeCancelled`, `stripeCancelDateReached`, `stripeNotBehind`, `noInvoice`, `invoiceNotOpen`, `nothingToPay`,
 *   `notPounds`.
 * - The card (review point 1): `cardNotMoved` (the subscription's default card in Stripe isn't the customer's saved
 *   card), `cardStepOpen` (a card step of the customer's is open: being sent, held, or left for a person).
 * - Taking turns (W40): `paymentDateChanging`, `stepOpen`, `retryHeld` (review point 3).
 * - What the window showed (Q18's rule): `figureMissing`, `invoiceChanged`, `amountChanged`, `changedSince`, and
 *   (W47r-a, the W47r review's S3) `cardChanged`: the saved card is no longer the card the window named.
 * - `notSent`, `keyRefused`: the record was written and the payment was then not sent.
 */
export const PAYMENT_RETRY_REFUSALS = {
  permissionDenied: 'Needs the Issue refunds permission to try a membership payment again.',
  notFound: 'Membership not found.',
  notPastDue: `This membership's payment isn't overdue, so there is nothing to try again. ${NOTHING_CHARGED}`,
  lastDayPassed: (lastDay: string): string => `This membership's last day was ${lastDay}, so its overdue payment can't be taken. ${NOTHING_CHARGED}`,
  noSubscription: `This membership has no Stripe subscription, so it has no payment to try again. ${NOTHING_CHARGED}`,
  noSavedCard: `The customer has no saved card to charge. ${NOTHING_CHARGED} Save their card on the reader first, then try the payment again.`,
  subscriptionMissing: `Stripe can't find this membership's subscription or its invoice with the club's payment account details. ${NOTHING_CHARGED} Tell a manager.`,
  notRead: `Stripe couldn't be asked about this membership just now, so the payment wasn't tried. ${NOTHING_CHARGED} Try again in a minute.`,
  customerMismatch: `The subscription in Stripe doesn't belong to this customer's Stripe account. ${NOTHING_CHARGED} Tell a manager.`,
  stripeCancelled: `Stripe shows this membership's subscription has been cancelled, so its unpaid invoice won't be charged: that would take money from someone whose membership has ended. ${NOTHING_CHARGED} If they want to carry on, sell them a new membership.`,
  stripeCancelDateReached: (date: string): string =>
    `Stripe shows this membership's subscription was set to end on ${date}, and that has passed, so its unpaid invoice won't be charged. ${NOTHING_CHARGED} If they want to carry on, sell them a new membership.`,
  stripeNotBehind: (status: string): string => `Stripe shows this membership's subscription as ${status}, not behind on a payment, so there is nothing to try again. ${NOTHING_CHARGED}`,
  noInvoice: `Stripe shows no invoice for this membership's subscription, so there is nothing to try again. ${NOTHING_CHARGED} Tell a manager.`,
  invoiceNotOpen: (status: string): string => `Stripe's newest invoice for this membership is ${status}, not waiting to be paid, so there is nothing to try again. ${NOTHING_CHARGED} Tell a manager.`,
  nothingToPay: `Stripe's newest invoice for this membership has nothing left to pay. ${NOTHING_CHARGED}`,
  notPounds: `Stripe's newest invoice for this membership isn't in pounds, so it can't be paid from here. ${NOTHING_CHARGED} Tell a manager.`,
  cardNotMoved: `This membership's subscription in Stripe isn't set to the customer's saved card, so the payment won't be tried: Stripe's own retries would still go to another card. ${NOTHING_CHARGED} Finish the card replace first: save the customer's card on the reader, wait until the membership's card change is off the Orders page list, then try the payment again.`,
  cardStepOpen: `The customer's card replace hasn't finished: a membership's move to the new card is still listed on the Orders page. ${NOTHING_CHARGED} Finish the card replace first: once that line is off the list, try the payment again.`,
  paymentDateChanging: `A payment date change is on hold for this membership (it is listed on the Orders page). ${NOTHING_CHARGED} Try the payment again once that line is off the list.`,
  stepOpen: `The last change to this membership hasn't been confirmed by Stripe yet (it is listed on the Orders page). ${NOTHING_CHARGED} Try the payment again once it is off the list.`,
  retryHeld: `A payment was already tried for this membership and Stripe hasn't said how it ended, so it can't be tried again yet: the card could be charged twice. Nothing was charged by this press. The automatic check finishes the first one once Stripe answers (the Orders page lists it).`,
  figureMissing: `The amount and the card shown on screen were not sent, so the payment wasn't tried. ${NOTHING_CHARGED} Close this, open it again and try again.`,
  cardChanged: `The customer's saved card has changed since this window opened. ${NOTHING_CHARGED} Close this and open it again.`,
  invoiceChanged: `Stripe now shows a different invoice as this membership's newest than the one this window showed. ${NOTHING_CHARGED} Close this and open it again to see what is owed now.`,
  amountChanged: (shown: number, now: number): string => `The amount to pay is now ${money(now)}, not the ${money(shown)} shown. ${NOTHING_CHARGED} Check the new amount with the customer and press again.`,
  changedSince: `This membership changed while the payment was being set up. ${NOTHING_CHARGED} Close this, open it again and try again.`,
  notSent: `The card was not charged: there was no time left to ask Stripe. ${NOTHING_CHARGED} Try again.`,
  keyRefused: `Stripe turned down the club's payment account details, so the card was not charged. ${NOTHING_CHARGED} Tell a manager straight away.`,
} as const

/**
 * W47r-b: what "already paid before the press" says when the write found the subscription ended, by what the write's
 * listing answered (dispatch.ts, recordInvoicePaid; paid-after-end.ts).
 * - Listed for a refund (by this press, by Stripe's notice before it, or held on a retry's own record): the Orders
 *   page has the line and its Mark refunded button.
 * - Paid before the subscription ended: the money was owed, and nothing is listed.
 * - Nothing was taken for the invoice: nothing to give back.
 * - Anything else (no membership to list it against, the invoice gone in test mode, no listing asked): W47r-a's words.
 */
function subscriptionEnded(listing: string | null): string {
  if (listing === 'listed' || listing === 'already_listed' || listing === 'retry_holds') {
    return 'Stripe shows its subscription has ended, so the payment Stripe took for it has nothing to pay for. Refund it in Stripe (tell a manager), then press Mark refunded on the Orders page.'
  }
  if (listing === 'paid_before_end') return 'Stripe shows its subscription has ended since, and the payment was taken before it ended, so it paid for time the member had. Nothing needs refunding.'
  if (listing === 'nothing_taken') return 'Stripe shows its subscription has ended, and nothing was taken for this invoice. Nothing needs refunding.'
  return 'Stripe shows its subscription has ended, so the payment Stripe took for it has nothing to pay for. Refund it in Stripe (tell a manager).'
}

/**
 * W47r-c: what the press says when the write found the membership's row ended here (`ignored_cancelled`: Stripe's
 * subscription is still live), by what the write's listing answered, as `subscriptionEnded` does for an ended
 * subscription. Listed (or held on a retry's own record): where the button is. Paid before the row's last day: the
 * money was owed. Anything else (no listing asked, the invoice gone in test mode): W47r-a's words.
 */
function endedHere(listing: string | null): string {
  if (listing === 'listed' || listing === 'already_listed' || listing === 'retry_holds') {
    return 'it has ended here, so the payment Stripe took for it has nothing to pay for. Refund it in Stripe (tell a manager) and check the subscription is cancelled in Stripe, then press Mark refunded on the Orders page.'
  }
  if (listing === 'paid_before_last_day') {
    return 'it has ended here, and the payment was taken before its last day, so it paid for time the member had. Nothing needs refunding. Tell a manager to check the subscription is cancelled in Stripe.'
  }
  if (listing === 'nothing_taken') return 'it has ended here, and nothing was taken for this invoice. Nothing needs refunding. Tell a manager to check the subscription is cancelled in Stripe.'
  return 'it has ended here. Tell a manager: the payment may need refunding in Stripe.'
}

/**
 * What the window and the press say (brief items 4 and 5).
 * - `ifPaid`, `ifAlreadyPaid`: the quote's line about the membership's bookings waiting for payment.
 * - `paid`: the payment went through and the membership was marked paid here (the webhook's own write).
 * - `alreadyPaid`: Stripe showed the invoice already paid (its own retry got there first, review point 3).
 * - `membershipNotUpdated`: the payment is in, and the write found nothing to do for the reason given.
 * - `declined`: the bank said no. `notTaken`: Stripe refused the payment for another reason, or answered without
 *   taking it. Either way nothing is written to the membership, and the bookings' deadline is unchanged.
 * - `held`: no clear answer. `paidNotRecorded`: paid in Stripe, and the write here failed; reconcile does it.
 * - W47r-a (the W47r review's S1): `paidAfterEnd` is the stuck list's line for a payment taken after the membership's
 *   subscription had ended (held for a person, with Mark refunded); `paidAfterEndAtThePress` is the press's answer,
 *   the same sentence with where the button is.
 */
export const PAYMENT_RETRY_WORDS = {
  ifPaid: (waiting: number): string =>
    waiting === 0
      ? 'If the payment goes through, the membership is active again straight away. None of its bookings is waiting for payment.'
      : `If the payment goes through, the membership is active again and its ${bookings(waiting)} waiting for payment ${waiting === 1 ? 'goes' : 'go'} back to confirmed straight away.`,
  ifAlreadyPaid: (waiting: number): string =>
    waiting === 0
      ? 'Stripe shows this payment has already gone through, so nothing will be charged. Pressing brings the membership up to date here: it will be active again.'
      : `Stripe shows this payment has already gone through, so nothing will be charged. Pressing brings the membership up to date here: it will be active again and its ${bookings(waiting)} waiting for payment ${waiting === 1 ? 'goes' : 'go'} back to confirmed.`,
  /** The membership once it is marked paid. `nextPayment`: worded "10 Jan 2027", or null when the row has none. */
  membershipActive: (restored: number, stillWaiting: number, nextPayment: string | null): string =>
    [
      `The membership is active again${nextPayment ? ` and its next payment is on ${nextPayment}` : ''}.`,
      restored > 0 ? `${bookings(restored)} that ${restored === 1 ? 'was' : 'were'} waiting for payment ${restored === 1 ? 'is' : 'are'} confirmed again.` : null,
      stillWaiting > 0 ? `${bookings(stillWaiting)} on this membership ${stillWaiting === 1 ? 'is' : 'are'} still waiting for payment: open ${stillWaiting === 1 ? 'it' : 'them'} to see why.` : null,
    ]
      .filter((part): part is string => part !== null)
      .join(' '),
  paid: (amount: number, brand: string | null, last4: string | null, membership: string): string => `${money(amount)} was taken on ${cardWords(brand, last4)}. ${membership}`,
  alreadyPaid: (membership: string): string => `Stripe shows this payment had already gone through (one of its own retries got there first), so nothing was charged by this press. ${membership}`,
  /** `why`: one of the `notUpdated` sentences. */
  membershipNotUpdated: (why: string): string => `The membership here was not changed: ${why}`,
  notUpdated: {
    /**
     * W47r-a (review S4.2). Ended in Stripe: the money has nothing to pay for, so it says a refund is needed (only the
     * "already paid before the press" path can say this now: a payment this press took is held as `paidAfterEnd`).
     * `past_due`: Stripe hasn't caught up with its own invoice yet, and its notice makes the write.
     * W47r-b: `unpaid` is said as `past_due` is (W47r-a "Noticed" 5: paying its newest invoice makes an unpaid
     * subscription active too, so the same lag shows there). And an ended subscription's words go by what the write
     * found (`listing`: dispatch.ts, `detail.paid_after_end.why`): see `subscriptionEnded`.
     */
    subscription_not_paid_up: (status: string, listing: string | null = null): string =>
      status === 'canceled' || status === 'incomplete_expired'
        ? subscriptionEnded(listing)
        : status === 'past_due' || status === 'unpaid'
          ? "Stripe hasn't shown the subscription as paid up yet; the membership is brought up to date when Stripe's notice arrives. Look again in a few minutes."
          : `Stripe still shows its subscription as ${status}. Tell a manager.`,
    not_latest_invoice: "Stripe has started a newer invoice for it since, and that invoice's own payment decides whether the membership is paid up. Look at the membership again in an hour.",
    no_period_end: 'Stripe gave no date for its next payment. Tell a manager.',
    subscription_missing: "Stripe can't find its subscription with the club's payment account details. Tell a manager.",
    not_found: 'no membership here has that subscription any more. Tell a manager.',
    /** W47r-c: by what the write's listing answered (`listing`: dispatch.ts, `detail.paid_after_end.why`): see `endedHere`. */
    ignored_cancelled: (listing: string | null = null): string => endedHere(listing),
    other: 'the booking system could not tell why. Tell a manager.',
  },
  /**
   * `stripeMessage` is Stripe's own, with its last full stop taken off. W47r-a (review S4.3): left out when it is
   * Stripe's plain "Your card was declined", which only says the same thing twice.
   */
  declined: (stripeMessage: string): string =>
    `The card was declined${stripeMessage === GENERIC_DECLINE ? '' : `: ${stripeMessage}`}. Nothing was charged and the membership is still overdue. Stripe's own retries carry on, and the bookings waiting for payment keep the deadline they had.`,
  // W47r-a (review S4.1): there is nowhere to pay online (Stripe's customer portal and its failed-payment emails are
  // off, and the website has no page for an overdue invoice), so the words no longer offer it.
  authenticationRequired:
    "The card needs the customer to approve the payment with their bank, which can't be done from here. Nothing was charged and the membership is still overdue. Stripe's own retries carry on, and the bookings waiting for payment keep the deadline they had. Ask the customer for another card and save it on the reader, then try again.",
  /** Stripe refused the payment for a reason that isn't the bank's (its own words), or answered without taking it. */
  notTaken: (stripeSaid: string): string =>
    `The payment was not taken: ${stripeSaid}. Nothing was charged and the membership is still overdue. Stripe's own retries carry on, and the bookings waiting for payment keep the deadline they had. If this happens again, tell a manager.`,
  notCompleted: (status: string): string => `the payment did not complete (Stripe shows the invoice as ${status})`,
  held: `The payment didn't get a clear answer from Stripe, so the card may or may not have been charged. It is on hold and the automatic check will finish it. ${DONT_TAKE_AGAIN} Check the Orders page in a few minutes.`,
  heldProcessing: `The payment is still being processed by the customer's bank, so it isn't known yet whether it went through. It is on hold and the automatic check will finish it once the bank answers. ${DONT_TAKE_AGAIN} Check the Orders page in a few minutes.`,
  heldNeedsAction: `The payment is waiting for a step Stripe needs (usually the customer's approval with their bank), which can't be done from here. Nothing has been taken yet, but it could still go through. It is on hold and listed on the Orders page, which says what to do. ${DONT_TAKE_AGAIN}`,
  paidNotRecorded: `The payment went through, but the membership couldn't be brought up to date here yet. The automatic check does that within a few minutes, and the bookings waiting for payment go back to confirmed then. Don't take the payment again.`,
  /**
   * W47r-a (S1): the stuck list's line. `last4`: the card's last four, or null when they aren't known.
   * W47r-b (W47r-a "Noticed" 2): `cancelledHere`: the membership's row had ended here while Stripe's subscription was
   * still live (the write answered `ignored_cancelled`), so it would bill again next month: the words add checking it.
   */
  paidAfterEnd: (amount: number, last4: string | null, cancelledHere = false): string => `${paidAfterEndLead(amount, last4, cancelledHere)}, then press Mark refunded.`,
  /** W47r-a (S1): the press's answer: the same, with where the button is. */
  paidAfterEndAtThePress: (amount: number, last4: string | null, cancelledHere = false): string => `${paidAfterEndLead(amount, last4, cancelledHere)}, then press Mark refunded on the Orders page.`,
  /**
   * W47r-b: the stuck list's line for an invoice Stripe's notice (or a press that charged nothing) found paid after
   * its subscription had ended: W47r-a's sentence, without a card, since the Worker didn't make the payment.
   * W47r-c (W47r-b "Noticed" 2): `cancelledHere`: a renewal Stripe took on a subscription still live there, for a
   * membership whose row had ended here. It would bill again next month, so the words add checking it.
   */
  invoicePaidAfterEnd: (amount: number, cancelledHere = false): string =>
    cancelledHere
      ? `${money(amount)} was taken by Stripe after this membership had ended here. Refund it in Stripe (tell a manager) and check the subscription is cancelled in Stripe, then press Mark refunded.`
      : `${money(amount)} was taken by Stripe after this membership's subscription had ended. Refund it in Stripe (tell a manager), then press Mark refunded.`,
  /**
   * W47r-d (W47r-c "Noticed" 2): the line for an invoice paid before Stripe ended the subscription and on or after
   * the membership's last day here (`lastDay`, worded): a renewal taken for a membership that had ended here, with the
   * subscription cancelled in Stripe afterwards.
   */
  invoicePaidAfterLastDay: (amount: number, lastDay: string): string =>
    `${money(amount)} was taken by Stripe on or after this membership's last day here (${lastDay}), before its subscription was cancelled in Stripe. Refund it in Stripe (tell a manager), then press Mark refunded.`,
} as const

/**
 * W47r-a (W47r review S1): Mark refunded's answers for a retry held as paid after the subscription ended
 * (retry-payment.ts, markRetryRefunded). It reads the payment's refunds in Stripe first and sends nothing.
 */
export const PAYMENT_RETRY_CLOSE_WORDS = {
  refunded: (amount: number): string => `Marked as refunded: Stripe shows the ${money(amount)} refunded in full. It is no longer listed.`,
  already: 'This was already marked as refunded (an earlier press went through). Nothing more was done.',
  notListed: 'This payment is no longer on the list (it was settled in the meantime). Nothing was changed.',
  notForAPerson:
    "This payment isn't one taken after its membership's subscription had ended, so it can't be marked as refunded: the automatic check finishes it from what Stripe shows. Nothing was changed.",
  notRead: "The booking system couldn't read this payment's refunds in Stripe just now, so it can't tell whether the money has gone back. Nothing was changed. Press Mark refunded again in a minute.",
  noPayment: "Stripe shows no card payment that went through on this invoice, so there is nothing to check a refund against. Nothing was changed. Tell a manager.",
  /** Pounds: what the payment took, what Stripe shows refunded (refunds that have succeeded), and what is still on its way. */
  notRefunded: (taken: number, refunded: number, onTheWay: number): string =>
    `Stripe shows ${refunded > 0 ? `only ${money(refunded)} of the ${money(taken)}` : `none of the ${money(taken)}`} refunded${onTheWay > 0 ? `, with a refund of ${money(onTheWay)} still on its way` : ''}. Nothing was changed. ${
      onTheWay > 0 && refunded + onTheWay >= taken ? 'Press Mark refunded again once Stripe shows the refund as succeeded.' : `Refund ${refunded > 0 || onTheWay > 0 ? 'the rest' : 'it'} in Stripe, then press Mark refunded again.`
    }`,
} as const

/**
 * W47r-d (W47r-c "Noticed" 3; W47r-b "Noticed" 4): Mark as owed's answers, for a retry held as paid after the end
 * (retry-payment.ts, markRetryOwed) and for a listed invoice (paid-after-end.ts, markInvoiceOwed). It never calls
 * Stripe and sends nothing.
 */
export const PAYMENT_RETRY_OWED_WORDS = {
  owed: (amount: number): string => `Marked as owed: the ${money(amount)} is recorded, with your reason, as a payment for a period the member had. Nothing was refunded. It is no longer listed.`,
  already: 'This was already marked as owed (an earlier press went through). Nothing more was done.',
  notListed: 'This payment is no longer on the list (it was settled in the meantime). Nothing was changed.',
  notForAPerson: "This payment isn't one taken after its membership had ended, so it can't be marked as owed: the automatic check finishes it from what Stripe shows. Nothing was changed.",
} as const

/**
 * The stuck list's line for a retry that is held, by what it is waiting on (brief item 4, "Unclear"). None has a
 * Close: a retry is ended only by what Stripe shows (review point 3; W47a S2's lesson), however long that takes.
 * W47r-a: the one exception is `paid_after_end`, whose line is PAYMENT_RETRY_WORDS.paidAfterEnd (it names the amount
 * and the card) and which carries Mark refunded. `payment_needs_action` says the way out when Stripe has ended the
 * subscription (the W47r review's L1).
 */
export const PAYMENT_RETRY_STUCK_WORDS: Readonly<Record<string, string>> = {
  waiting: `A membership payment tried again from the desk didn't get a clear answer: the card may or may not have been charged. The automatic check, every 5 minutes, reads the invoice in Stripe and records the payment or ends this as not taken; it never charges. ${DONT_TAKE_AGAIN}`,
  unclear: `A membership payment tried again from the desk didn't get a clear answer, and Stripe couldn't be read about it at the last check. The automatic check tries again every 5 minutes; it never charges. ${DONT_TAKE_AGAIN}`,
  payment_processing: `A membership payment tried again from the desk is still being processed by the customer's bank. Wait for the bank: the automatic check looks every 5 minutes and, once Stripe says whether it went through, records the payment or ends this as not taken. It can't be closed by hand, and the payment can't be tried again until then. ${DONT_TAKE_AGAIN}`,
  payment_needs_action: `A membership payment tried again from the desk is waiting for a step Stripe needs (usually the customer's approval with their bank), which can't be done from here. Nothing has been taken yet. Tell a manager: the invoice's page in Stripe has a payment link to send the customer, and Stripe's own retries carry on. Once Stripe shows the payment as gone through or failed, the automatic check records it or ends this as not taken within 5 minutes. If Stripe has ended the subscription, the payment stays waiting: a manager voids the invoice in Stripe, and the automatic check then ends this as not taken. It can't be closed by hand, and the payment can't be tried again until then. ${DONT_TAKE_AGAIN}`,
  paid_not_recorded: "A membership payment tried again from the desk went through in Stripe, but the membership couldn't be brought up to date here yet. The automatic check tries again every 5 minutes. Don't take the payment again.",
  close_failed: "A membership payment tried again from the desk has ended in Stripe, but that couldn't be recorded here yet. The automatic check tries again every 5 minutes. Don't take the payment again.",
  other_mode: `A membership payment tried again from the desk can't be found in Stripe with the payment account the system is using now (it may be in the other Stripe mode, live or test), so the automatic check can't finish it. Tell a manager. ${DONT_TAKE_AGAIN}`,
  invoice_missing: `Stripe can no longer find the invoice of a membership payment tried again from the desk, so the automatic check can't finish it. Tell a manager. ${DONT_TAKE_AGAIN}`,
}

// --- Credits and Herd (adjustMembershipCredits.ts, setMembershipHerd.ts, MembershipCreditDialog, the Customers page)

export const MEMBERSHIP_CREDIT_WORDS = {
  permissionDenied: 'Needs the Issue refunds permission to adjust membership credits.',
  amountInvalid: 'Amount must be a non-zero whole number.',
  notFound: 'Membership not found.',
  unlimited: 'This membership is unlimited — its session credits cannot be adjusted.',
  noCurrentPeriod: 'This membership has no current credit period — there is nothing to adjust.',
  belowUsed: (allocated: number, used: number): string => `Adjustment rejected: the period would be left with ${allocated} allocated credit(s), below the ${used} already used.`,
} as const

/** MembershipCreditDialog's own words. The server takes an empty reason today (FB10); W37 refuses one. */
export const MEMBERSHIP_CREDIT_DIALOG_WORDS = {
  amountInvalid: 'Enter a non-zero whole number amount',
  reasonRequired: 'A reason is required for the audit trail',
  failed: 'Failed to adjust credits',
} as const

/**
 * New in W37 (brief W37 item 2; FB10): what the old function never refused. A reason is required on the server (the
 * dialog's own sentence, which staff already see); add-on credits never go below zero (worded as `belowUsed`); and a
 * credit type that is neither kind is refused before anything moves (the old function took any other value as
 * session credits and then failed on the record, with the credits already changed).
 */
export const MEMBERSHIP_CREDIT_NEW_WORDS = {
  reasonRequired: MEMBERSHIP_CREDIT_DIALOG_WORDS.reasonRequired,
  // W58 (W37 QA): "minus 1", not "-1" with a hyphen.
  addonBelowZero: (left: number): string => `Adjustment rejected: the membership would be left with ${left < 0 ? `minus ${-left}` : left} add-on credit(s), below zero.`,
  creditTypeInvalid: 'Credit type must be "session" or "addon".',
} as const

/** setMembershipHerd has one reason (`not_found`) and no words of its own; the Customers page shows this. */
export const HERD_REASONS = ['not_found'] as const
export const HERD_FALLBACK = 'Failed to update Herd.'
/** New in W37: the Worker's own words for `not_found`, in the refusal's details (the wrapper answers the reason alone, as before). */
export const HERD_NOT_FOUND_MESSAGE = MEMBERSHIP_CREDIT_WORDS.notFound
