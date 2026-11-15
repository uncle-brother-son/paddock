// New in W33 (E-plan 4.11; Wayne's Q44, 15 Nov): what a customer is told when the website's cancel is refused. Plain
// words, no staff terms (no "Cancel & Refund", "Issue refunds", "reader", "claim" or "Stripe"), and nothing a customer
// can't act on: where they can't fix it themselves, the words say to get in touch.
//
// The rules refuse with the staff reasons (bookings/cancel.ts, events/cancel-places.ts); cancels.ts turns each reason
// into the words here. A reason with no words of its own gets `fallback`, so no staff sentence ever reaches a customer.

export const CUSTOMER_CANCEL_WORDS = {
  // --- A session booking
  /** Not theirs, or not there: the same answer, so it never says someone else's booking exists. */
  bookingNotFound: "We couldn't find that booking.",
  alreadyCancelled: 'This booking has already been cancelled.',
  /** Completed or marked as a no-show. */
  notCancellable: "This booking has already taken place, so it can't be cancelled.",
  /** Inside 24 hours of the session's start, or after it (W33a: a session that has started is told so too). */
  within24Hours: "Bookings can be cancelled online up to 24 hours before they start. This one starts in less than 24 hours, or has already started, so it can't be cancelled online.",
  /**
   * W33a (review S2): a booking the club has to cancel itself (a pass booking with money on it that isn't its paid
   * guests': cancelling it online would lose the pass session).
   */
  cannotCancelOnline: "We can't cancel this booking online. Please get in touch and we'll help.",
  /** A payment for the booking is being taken or checked (a card payment at the club, or one still going through). */
  paymentOpen: "A payment for this booking is still going through, so it can't be cancelled just now. Please try again in a few minutes, or get in touch.",
  /** A refund on the booking is still being checked. */
  refundOpen: "A refund on this booking is still being sorted out, so it can't be cancelled just now. Please try again later, or get in touch.",
  /** An earlier card refund on the booking didn't go through, and the club still has to settle it (Q39). */
  refundOwed: "A refund on this booking still needs sorting out by us, so it can't be cancelled online. Please get in touch and we'll help.",
  /** The booking changed between the quote and the cancel (an add-on or a guest added). */
  bookingChanged: 'This booking has changed since you opened it. Please look at it again before cancelling.',
  /** The amount shown is no longer what would come back (Q18). */
  figuresChanged: 'The amount you would get back has changed. Please check the new amount and confirm again.',
  amountNotConfirmed: 'Please confirm the amount you will get back before cancelling.',
  notSaved: "Something went wrong and your booking wasn't cancelled. Nothing has changed. Please try again.",

  // --- An event booking
  eventBookingNotFound: "We couldn't find that event booking.",
  eventBookingCancelled: 'This event booking has already been cancelled.',
  placeNotFound: "One of those places isn't on this booking.",
  placeAlreadyCancelled: 'One of those places has already been cancelled.',
  nothingToCancel: 'There are no places left to cancel on this booking.',
  /** A place whose guest has arrived and been checked in. */
  placeCheckedIn: "One of those places has already been checked in at the event, so it can't be cancelled.",
  choosePlace: 'Choose at least one place to cancel.',
  /** The club cancelled the event: its own cancel gives the money back. */
  eventCancelled: "This event has been cancelled by the club, so you don't need to cancel your booking. Please get in touch if you have a question about your refund.",
  /** Q43: after the event's refund cut-off (its start, when it has none). */
  afterCutoff: 'The date for cancelling this event online has passed. Please get in touch if you need help.',
  eventPaymentOpen: "A payment for this event booking is still going through, so it can't be cancelled just now. Please try again in a few minutes, or get in touch.",
  eventRefundOpen: "A refund on this order is still being sorted out, so this booking can't be cancelled just now. Please try again later, or get in touch.",
  eventChanged: 'This event booking has changed since you opened it. Please look at it again before cancelling.',
  eventNotSaved: "Something went wrong and nothing was cancelled. Nothing has changed. Please try again.",

  // --- Both
  /** The website's cancels are switched off (ORDER_SWITCH's `customer_cancels`, or the kind the cancel's money needs). */
  switchedOff: "Cancelling online isn't available at the moment. Please get in touch and we'll help.",
  /** Any refusal with no words of its own. */
  fallback: "We couldn't cancel this online. Please get in touch and we'll help.",
} as const

/** A session booking's refusal reasons (bookings/cancel.ts) and the customer's words for each. */
export const CUSTOMER_BOOKING_REFUSAL_WORDS: Readonly<Record<string, string>> = {
  booking_not_found: CUSTOMER_CANCEL_WORDS.bookingNotFound,
  already_cancelled: CUSTOMER_CANCEL_WORDS.alreadyCancelled,
  not_cancellable: CUSTOMER_CANCEL_WORDS.notCancellable,
  within_24_hours: CUSTOMER_CANCEL_WORDS.within24Hours,
  pass_session_not_returned: CUSTOMER_CANCEL_WORDS.cannotCancelOnline,
  // The two reasons a payment still open on the booking answers with (bookings/money-in.ts, paymentOpenRefusal).
  card_payment_open: CUSTOMER_CANCEL_WORDS.paymentOpen,
  reader_payment_open: CUSTOMER_CANCEL_WORDS.paymentOpen,
  // The booking is still waiting for its first payment.
  booking_pending: CUSTOMER_CANCEL_WORDS.paymentOpen,
  refund_open: CUSTOMER_CANCEL_WORDS.refundOpen,
  refund_owed: CUSTOMER_CANCEL_WORDS.refundOwed,
  booking_changed: CUSTOMER_CANCEL_WORDS.bookingChanged,
  refund_changed: CUSTOMER_CANCEL_WORDS.figuresChanged,
  cancel_not_saved: CUSTOMER_CANCEL_WORDS.notSaved,
}

/** An event booking's refusal reasons (events/cancel-places.ts, the database's quote) and the customer's words for each. */
export const CUSTOMER_EVENT_REFUSAL_WORDS: Readonly<Record<string, string>> = {
  booking_not_found: CUSTOMER_CANCEL_WORDS.eventBookingNotFound,
  booking_not_confirmed: CUSTOMER_CANCEL_WORDS.eventBookingCancelled,
  attendee_not_found: CUSTOMER_CANCEL_WORDS.placeNotFound,
  already_cancelled: CUSTOMER_CANCEL_WORDS.placeAlreadyCancelled,
  nothing_to_cancel: CUSTOMER_CANCEL_WORDS.nothingToCancel,
  attendee_checked_in: CUSTOMER_CANCEL_WORDS.placeCheckedIn,
  invalid_params: CUSTOMER_CANCEL_WORDS.choosePlace,
  event_cancelled: CUSTOMER_CANCEL_WORDS.eventCancelled,
  after_cutoff: CUSTOMER_CANCEL_WORDS.afterCutoff,
  booking_pending: CUSTOMER_CANCEL_WORDS.eventPaymentOpen,
  refund_open: CUSTOMER_CANCEL_WORDS.eventRefundOpen,
  changed_by_someone_else: CUSTOMER_CANCEL_WORDS.eventChanged,
  figures_changed: CUSTOMER_CANCEL_WORDS.figuresChanged,
  amount_not_confirmed: CUSTOMER_CANCEL_WORDS.amountNotConfirmed,
  cancel_not_saved: CUSTOMER_CANCEL_WORDS.eventNotSaved,
}
