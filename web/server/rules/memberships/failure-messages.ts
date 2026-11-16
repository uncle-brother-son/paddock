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
import { PAYMENT_UNCONFIRMED_MESSAGE } from '@/server/rules/orders/failure-messages'

export { INACTIVE_STAFF_MESSAGE, ISSUE_REFUNDS_NEEDED_MESSAGE } from '@/server/rules/bookings/failure-messages'

// --- New in W36

/** The switch (F-plan 4.11, lead call L3), worded as step D's BOOKING_PATH_OFF and step E's REFUND_PATH_OFF. */
export const MEMBERSHIP_PATH_OFF_MESSAGE = 'This is switched off in the booking system. Tell a manager.'

/**
 * Lead call L15: a payment date change whose charge got no clear answer is held, in step C's saved-card sentence
 * (Wayne's Q35 pattern). W41 uses it.
 */
export const PAYMENT_DATE_HELD_MESSAGE = PAYMENT_UNCONFIRMED_MESSAGE

/**
 * A Stripe step left after the database change (memberships/left.ts, F-plan 4.10): the stuck list's line while the
 * automatic check is still sending it, and once Stripe has refused it for good (lead call L7).
 */
export const LEFT_STEP_WORDS = {
  cancel_at: {
    left: (subscriptionId: string): string =>
      `A membership's cancellation was recorded, but its subscription (${subscriptionId}) couldn't be confirmed changed in Stripe yet, so it could still renew past its last day. The automatic check tries again every 5 minutes: nothing to do yet.`,
    refused: (subscriptionId: string): string =>
      `A membership's cancellation was recorded, but Stripe refused to change its subscription (${subscriptionId}), so the automatic check has stopped trying and it could still renew past its last day. Set or clear its cancel date in Stripe by hand to match the membership (or tell a manager), then press Mark sorted (needs the Issue refunds permission).`,
  },
  payment_method: {
    left: (subscriptionId: string): string =>
      `A customer's card was replaced, but a membership's subscription (${subscriptionId}) couldn't be confirmed moved to the new card in Stripe yet, so its next payment could still go to the old card. The automatic check tries again every 5 minutes: nothing to do yet.`,
    refused: (subscriptionId: string): string =>
      `A customer's card was replaced, but Stripe refused to move a membership's subscription (${subscriptionId}) to the new card, so the automatic check has stopped trying and its next payment could still go to the old card. Set the subscription's payment method in Stripe by hand (or tell a manager), then press Mark sorted (needs the Issue refunds permission).`,
  },
  /** The manual close's answer. */
  sorted: 'Marked as sorted. It is no longer listed.',
  notListed: 'This is no longer on the list (it was sorted in the meantime). Nothing was changed.',
  stillTrying: "Stripe hasn't refused this: the automatic check is still sending it. Nothing was changed. Wait for the next check (every 5 minutes) and look again.",
} as const

// --- Cancel and undo (setMembershipCancellation.ts, /api/memberships/cancel and /undo-cancel, CancelMembershipDialog)

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
} as const

/** ChangePaymentDateDialog's own words. */
export const PAYMENT_DATE_DIALOG_WORDS = {
  noResponse: 'No response from the server.',
  failed: 'Failed to change the payment date.',
  notChanged: 'The payment date was not changed.',
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

/** setMembershipHerd has one reason (`not_found`) and no words of its own; the Customers page shows this. */
export const HERD_REASONS = ['not_found'] as const
export const HERD_FALLBACK = 'Failed to update Herd.'
