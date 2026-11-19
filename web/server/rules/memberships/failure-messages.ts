// New in W36 (F-plan 4.1, brief W36 item 1): every word staff see from a membership action, moved here word for word
// from the staff app's functions (setMembershipCancellation, changeMembershipPaymentDate, shared/membershipPaymentDate,
// adjustMembershipCredits, setMembershipHerd), the three legacy membership routes and the dialogs, ahead of the slices
// that use them (W37 credits and Herd, W40 cancel and undo, W41 payment date). Nothing uses them yet. The test beside
// this file holds each to its source (the frozen copy, legacy-account/, and the dialogs) until the old code goes.
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
  payment_method: {
    left: (subscriptionId: string): string =>
      `A customer's card was replaced, but a membership's subscription (${subscriptionId}) couldn't be confirmed moved to the new card in Stripe yet, so its next payment could still go to the old card. The automatic check tries again every 5 minutes. If this is still here after an hour, set it in Stripe by hand (or tell a manager): the next check then sees it and takes it off the list.`,
    refused: (subscriptionId: string): string =>
      `A customer's card was replaced, but Stripe refused to move a membership's subscription (${subscriptionId}) to the new card, so the automatic check has stopped trying and its next payment could still go to the old card. Set the subscription's payment method in Stripe by hand (or tell a manager), then press Mark sorted (needs the Issue refunds permission).`,
    missing: (subscriptionId: string): string =>
      `A customer's card was replaced, but Stripe can't find a membership's subscription (${subscriptionId}) with the club's payment account details, so the automatic check has stopped trying. Tell a manager: the subscription may have been deleted in Stripe, or belong to the other mode. Once the membership and Stripe agree, press Mark sorted (needs the Issue refunds permission).`,
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
}

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
  addonBelowZero: (left: number): string => `Adjustment rejected: the membership would be left with ${left} add-on credit(s), below zero.`,
  creditTypeInvalid: 'Credit type must be "session" or "addon".',
} as const

/** setMembershipHerd has one reason (`not_found`) and no words of its own; the Customers page shows this. */
export const HERD_REASONS = ['not_found'] as const
export const HERD_FALLBACK = 'Failed to update Herd.'
/** New in W37: the Worker's own words for `not_found`, in the refusal's details (the wrapper answers the reason alone, as before). */
export const HERD_NOT_FOUND_MESSAGE = MEMBERSHIP_CREDIT_WORDS.notFound
