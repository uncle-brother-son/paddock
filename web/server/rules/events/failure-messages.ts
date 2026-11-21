// New in W27 (E-plan 4.1, brief W27 item 5): every word staff see from an event cancellation, moved here word for word
// ahead of the slices that use them (W30 event places, W31 the whole event): the staff app's cancelEventPlaces,
// cancelEvent, getEventCancellationQuote, getEventCancellationOverview and the modules behind them
// (shared/eventCancellation.ts, shared/eventCancellationQuote.ts, shared/staffAccess.ts), and the two dialogs' own
// words (CancelEventPlacesDialog.tsx, CancelEventDialog.tsx). The test beside this file holds each to its source.
//
// What is NOT moved, on purpose (E-plan 4.4, and "six things" item 4): the warnings that only described half-finished
// states the old code could leave (store credit taken back or not, card money "recorded on the order, so retrying
// won't refund it again", "needs a manual check"), and the words of the old "settle on the next press" machinery.
// The held words both step E actions share (`heldRefundMessage`) are in server/rules/refunds/failure-messages.ts.
import 'server-only'

/** The reasons a place cancel answers with, as the old `CancelPlacesFailureReason`. The test holds this list to it. */
export const EVENT_CANCEL_REASONS = [
  'invalid_params',
  'booking_not_found',
  'booking_pending',
  'booking_not_confirmed',
  'attendee_not_found',
  'already_cancelled',
  'nothing_to_cancel',
  'attendee_checked_in',
  'reason_required_after_cutoff',
  'order_not_found',
  'refund_failed',
  'refund_unsure',
  'store_credit_failed',
  'changed_by_someone_else',
  'unexpected_error',
] as const
export type EventCancelReason = (typeof EVENT_CANCEL_REASONS)[number]

/**
 * What event_cancellation_quote refuses with, and the words for each (shared/eventCancellationQuote.ts's
 * QUOTE_REFUSALS). A reason the database function gives that isn't here reads as `booking_not_found`, as before.
 */
export const EVENT_QUOTE_REFUSALS: Readonly<Record<string, { reason: EventCancelReason; message: string }>> = {
  booking_not_found: { reason: 'booking_not_found', message: 'This event booking no longer exists.' },
  booking_not_confirmed: { reason: 'booking_not_confirmed', message: 'This event booking has already been cancelled.' },
  attendee_not_found: { reason: 'attendee_not_found', message: "One of the places isn't on this booking any more." },
  already_cancelled: { reason: 'already_cancelled', message: 'One of the places has already been cancelled.' },
  nothing_to_cancel: { reason: 'nothing_to_cancel', message: 'There are no places left to cancel on this booking.' },
  attendee_checked_in: { reason: 'attendee_checked_in', message: 'A place you chose is checked in. Undo check-in first.' },
}

/** Cancel place, places or booking: the fixed words of each reason that has them. */
export const EVENT_CANCEL_WORDS = {
  // invalid_params (three texts)
  chooseBooking: 'Choose a booking.',
  choosePlace: 'Choose at least one place.',
  chooseRefund: 'Choose Card, Store credit or No refund.',
  // booking_pending
  bookingPending: 'A card reader payment is still in progress for this booking. Finish or cancel it first.',
  // reason_required_after_cutoff
  reasonRequiredAfterCutoff: 'A reason is needed to refund after the refund cut-off.',
  // order_not_found (two texts)
  orderLineNotFound: "This booking's order line couldn't be found, so nothing can be refunded.",
  orderNotFound: "This booking's order couldn't be found.",
  // refund_failed (two texts: the check before the refund, Stripe's refusal)
  cardCheckFailed: (detail: string): string => `Checking the card payment failed, so nothing was cancelled: ${detail}`,
  cardRefundFailed: (detail: string | undefined): string => `The card refund failed, so nothing was cancelled: ${detail ?? 'unknown error'}`,
  // store_credit_failed
  storeCreditFailed: 'Adding the store credit failed, so nothing was cancelled.',
  // changed_by_someone_else (two texts)
  changedBySomeoneElse: 'Someone else changed this booking at the same moment (a place was cancelled or checked in). Nothing was cancelled; reload and try again.',
  sameRefundBySomeoneElse: (cardAmount: number): string =>
    `Someone else cancelled these places at the same moment, with the same card refund of £${cardAmount.toFixed(2)}: it went back to the card once, on their cancellation. Reload to see it.`,
  // unexpected_error
  notRecorded: (detail: string): string => `Recording the cancellation failed, so nothing was cancelled: ${detail}`,
} as const

/** The permission words cancelEventPlaces and cancelEvent throw (shared/staffAccess.ts, requireCanIssueRefunds). */
export const EVENT_PERMISSION_WORDS = {
  noStaffRecord: (email: string): string => `No staff record matches the logged-in user's email (${email}). Ask an admin to add you as staff before performing this action.`,
  needsIssueRefunds: 'Needs Issue refunds permission — this action moves money back to the customer.',
} as const

/** The note on an event refund's store credit row (a row the replay compares). */
export const eventStoreCreditNote = (eventName: string, cardRefunded: number): string =>
  cardRefunded > 0 ? `Event refund: ${eventName} (the rest went back to the card).` : `Event refund: ${eventName}.`
/** The event's name when its row can't be read. */
export const EVENT_NAME_FALLBACK = 'the event'

/** The whole event (cancelEvent): its reasons, as the old result's. */
export const EVENT_WHOLE_CANCEL_REASONS = ['invalid_params', 'event_not_found', 'event_ended', 'bookings_pending'] as const
export type EventWholeCancelReason = (typeof EVENT_WHOLE_CANCEL_REASONS)[number]

export const EVENT_WHOLE_CANCEL_WORDS = {
  // invalid_params (three texts)
  chooseEvent: 'Choose an event.',
  chooseRefund: 'Choose Card or Store credit.',
  reasonNeeded: 'A reason is needed to cancel an event.',
  // event_not_found
  eventNotFound: 'This event no longer exists.',
  // event_ended
  eventEnded: "This event has already ended, so it can't be cancelled.",
  // bookings_pending
  bookingsPending: (customerNames: readonly string[]): string => `A card reader payment is still in progress for ${customerNames.join(', ')}. Finish or cancel it first.`,
} as const

/** The overview's words for a booking that can't be cancelled as things stand (getEventCancellationOverview). */
export const EVENT_OVERVIEW_WORDS = {
  placeCheckedIn: 'A place is checked in. Undo check-in first.',
  cannotBeCancelled: (reason: string): string => `Can't be cancelled (${reason}).`,
} as const

/** The two dialogs' own words: what they say before, or instead of, the functions'. */
export const EVENT_DIALOG_WORDS = {
  // CancelEventPlacesDialog
  quoteFailed: 'Could not work out the refund. Close and try again.',
  // W30: `cancelFallback` ('Failed to cancel') is gone. A call that throws got no answer, so the dialog shows the
  // no-answer words and keeps its press key (the staff app's EVENT_CANCEL_NO_ANSWER_MESSAGE).
  // CancelEventDialog
  // W31: `cancelEventFallback` ('Failed to cancel the event') is gone. A call that throws got no answer, so the dialog
  // shows the no-answer words (the staff app's EVENT_WHOLE_CANCEL_NO_ANSWER_MESSAGE, and one line per booking).
  eventEnded: "This event has already ended, so it can't be cancelled.",
} as const

// --- New in W30 (event places on the Worker; E-plan 4.4, 4.6, 4.7; Wayne's Q39, Q42, Q43)

const money = (pounds: number): string => `£${pounds.toFixed(2)}`

/** What a person does about card money left owed after a place cancel that stands. */
const USE_REFUND_THE_REST = 'Use Refund the rest to give it another way.'
/** The detail of a card part the press had no time left to send: nothing reached Stripe. */
const NOT_SENT_DETAIL = 'it was not sent: there was no time left to send it'
/**
 * How the not-put-back words open (W30a, review S1): Stripe's refusal with its reason, or, for a part never sent,
 * that it wasn't sent in time (nothing was refused: Stripe was never asked).
 */
const cardRefundDidNotGo = (detail: string): string => (detail === NOT_SENT_DETAIL ? "The card refund wasn't sent in time" : `The card refund was refused (${detail})`)
/** The plan's store credit, which R2 gives although the card part didn't go (W30a, review S1): named, so nobody gives it again by hand. */
const storeCreditGiven = (storeCredit: number): string => (storeCredit > 0 ? ` (${money(storeCredit)} went to store credit as planned)` : '')

/** The words W30 adds (none is moved from the old function: each is for something the old code didn't do). */
export const EVENT_CANCEL_NEW_WORDS = {
  /** Q18, E9: no cancel without the refund staff were shown (£0 for No refund). */
  amountNotConfirmed: 'Check the refund figure and confirm again.',
  /** Q18's words (E-plan 4.7), for an event booking. */
  figuresChanged: 'The figures on this event booking have just changed. Check them and confirm again.',
  /** Q42: cash can only be handed back for cash paid on the booking's order. */
  noCashLeft: "No cash paid on this booking's order is left to hand back, so it can't be handed back in cash.",
  /** R1 failed in the database and was rolled back: nothing was cancelled, claimed or sent. */
  notSaved: "The cancellation couldn't be saved (the system was busy, or one of its records couldn't be written), so nothing was cancelled. Try again.",
  /** A card part the press had no time left to send: nothing went, as a refusal. */
  notSentDetail: NOT_SENT_DETAIL,
  /** What staff see for it: R1 was undone, so nothing was cancelled and the same cancel can be pressed again. */
  notSentInTime: "The card refund wasn't sent in time, so nothing was cancelled. Try again.",
  /** No clear answer from Stripe: the places stay cancelled and the claim is held for the automatic check (Q35's words). */
  unconfirmed: "The places are cancelled, but the card refund didn't get a clear answer, so it may or may not have gone. Don't refund it again. Check the Orders page in a few minutes.",
  /** The card part went and R2 couldn't record it yet: held for the automatic check, which records it (never resent). */
  goneNotRecorded: (cardGone: number): string =>
    `The places are cancelled and ${money(cardGone)} went back to the card, but the refund couldn't be finished on the booking yet. It's on hold: don't refund it again. Check the Orders page in a few minutes.`,
  /**
   * The card refund didn't go and the places can't go back: someone else has booked them since (E-plan 4.4). The
   * cancel stands, the card money is owed, and the plan's store credit (`storeCredit`, what R2 gave) was given.
   * W30a (review S1): the words say the card refund didn't go back, never "nothing went back", and name that store
   * credit; the advice is Refund the rest either way (after a refusal, or a part never sent, there is nothing to
   * check in Stripe).
   */
  putBackBlocked: (detail: string, owed: number, storeCredit = 0): string =>
    `${cardRefundDidNotGo(detail)}, so it didn't go back to the card${storeCreditGiven(storeCredit)}, and the places can't be put back: they have been booked by someone else since. The cancellation stands, and ${money(owed)} shows on this booking as still to refund. ${USE_REFUND_THE_REST}`,
  /** The same when R2 failed too: nothing was given (no store credit either) and the claim waits for the automatic check. */
  putBackBlockedNotRecorded: (detail: string): string =>
    `${cardRefundDidNotGo(detail)}, so nothing went back, and the places can't be put back: they have been booked by someone else since. The cancellation stands, but the money still to refund couldn't be recorded yet. Don't refund it again: check the Orders page in a few minutes.`,
  /** The same when the undo failed for any other reason (a database fault). */
  putBackFailed: (detail: string, owed: number, storeCredit = 0): string =>
    `${cardRefundDidNotGo(detail)}, so it didn't go back to the card${storeCreditGiven(storeCredit)}, and the places couldn't be put back. The cancellation stands, and ${money(owed)} shows on this booking as still to refund. ${USE_REFUND_THE_REST}`,
  putBackFailedNotRecorded: (detail: string): string =>
    `${cardRefundDidNotGo(detail)}, so nothing went back, and the places couldn't be put back. The cancellation stands, but the money still to refund couldn't be recorded yet. Don't refund it again: check the Orders page in a few minutes.`,
  /**
   * W31 (W30 review L1): the card refund didn't go and the places can't go back because the whole event has been
   * cancelled since the places were. The cancel stands and the card money is owed, as when the places were resold.
   */
  putBackEventCancelled: (detail: string, owed: number, storeCredit = 0): string =>
    `${cardRefundDidNotGo(detail)}, so it didn't go back to the card${storeCreditGiven(storeCredit)}, and the places can't be put back: the event has been cancelled since. The cancellation stands, and ${money(owed)} shows on this booking as still to refund. ${USE_REFUND_THE_REST}`,
  putBackEventCancelledNotRecorded: (detail: string): string =>
    `${cardRefundDidNotGo(detail)}, so nothing went back, and the places can't be put back: the event has been cancelled since. The cancellation stands, but the money still to refund couldn't be recorded yet. Don't refund it again: check the Orders page in a few minutes.`,
} as const

/** The reasons W30 adds to the old function's (EVENT_CANCEL_REASONS), each with words above or the `refund_open` sentence. */
export const EVENT_CANCEL_NEW_REASONS = ['refund_open', 'amount_not_confirmed', 'figures_changed', 'no_cash_left', 'cancel_not_saved'] as const

/** The note on an event refund's store credit row when the rest was handed over in cash (Q42). */
export const EVENT_STORE_CREDIT_AFTER_CASH_NOTE = (eventName: string): string => `Event refund: ${eventName} (the rest was handed back in cash).`

// --- New in W31 (the whole event on the Worker; E-plan 4.4; bugs E6, E7; Wayne's Q42 for a whole event)

/** The words W31 adds (none is moved from the old function: each is for something the old code didn't do). */
export const EVENT_WHOLE_CANCEL_NEW_WORDS = {
  /** `wholeEvent` on a booking's cancel is honoured only once the event is cancelled in the database. */
  eventNotCancelled: "This event hasn't been cancelled, so its bookings can't be cancelled as a whole event. Close this, reload and try again.",
  /** The event's cancel failed in the database and was rolled back: the event is as it was. */
  notSaved: "The event's cancellation couldn't be saved (the system was busy, or one of its records couldn't be written), so the event wasn't cancelled. Try again.",
  /**
   * W52 (W35 audit F5; W35a "Where I was unsure" 3): No refund on an event the club has cancelled, pressed without
   * Issue refunds. W35a answered the permission's general words ("…this action moves money back to the customer"),
   * which a No refund doesn't do. The place cancel dialog greys the choice with the same sentence.
   */
  noRefundNeedsIssueRefunds: 'The club has cancelled this event, so cancelling a place on it with no refund needs the Issue refunds permission.',
} as const

/** The reasons W31 adds: `event_not_cancelled` on a booking's cancel, `cancel_not_saved` on the event's. */
export const EVENT_WHOLE_CANCEL_NEW_REASONS = ['event_not_cancelled', 'cancel_not_saved'] as const
