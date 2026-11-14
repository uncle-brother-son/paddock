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
  cancelFallback: 'Failed to cancel',
  // CancelEventDialog
  cancelEventFallback: 'Failed to cancel the event',
  eventEnded: "This event has already ended, so it can't be cancelled.",
} as const
