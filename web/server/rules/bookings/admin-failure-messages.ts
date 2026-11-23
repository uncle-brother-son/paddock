// Brief W48 item 1 (G-plan 4.1): the words of the booking screens' flags and the open-payment words (W50), moved word
// for word from the staff app's old
// functions as they were at W48. Unused yet: each slice that moves an action answers its refusals
// with these, so the screens' handling still works. Generated once by briefs/W48-logs/generate-words-files.py in the
// staff app repo and kept by hand from here on; server/rules/admin/words.test.ts holds this file to the old
// sentences (read from the old code with the TypeScript parser, pinned in testing/old-words.json), both ways. A sentence that takes a value is a
// function of it. Not here, on purpose (the same test holds that they stay out): the plumbing between Retool and
// the legacy routes ("returned an HTML page", "Unauthorized", "Missing required fields", "Internal server
// error", the fallbacks for an error with no words) and "saved but could not be read back", which one transaction
// can't leave.

export const BOOKING_ADMIN_WORDS = {
  /** setGuestWaiverStatus */
  setGuestWaiverStatus: {
    waivermethodMustEmailLinkOrIn: 'waiverMethod must be "email_link" or "in_person" when accepting a waiver',
  },
  /** bookingPaymentOpenWords */
  bookingPaymentOpenWords: {
    cardPaymentOnBookingStillBeing: "A card payment on this booking is still being checked. Don't take payment again: use Resolve now on the Orders page after 15 minutes.",
  },
  /** readerPaymentOpen */
  readerPaymentOpen: {
    cardReaderPaymentStillOpenOn: 'A card reader payment is still open on this booking. Finish or cancel it first, or use Resolve now on the Orders page after 15 minutes.',
  },
} as const

/**
 * W50 (brief items 4, 5 and 7; bug GB17; Wayne's Q49, 20 Nov): the words for refusals that had none. The three old
 * flag functions checked nothing about the booking, so none of these is an old sentence: they are kept apart from
 * BOOKING_ADMIN_WORDS (server/rules/admin/words.test.ts holds that to the old code, both ways), and
 * server/rules/bookings/admin.test.ts holds these.
 *  - `paymentNeededCheckIn` is Wayne's Q49 answer, word for word. W50a: he changed "Use Settle." to "Use Take
 *    Payment.", the name of the button on the booking window.
 *  - `paymentOpenCheckIn` (W50a; W50 review L2; Wayne, 20 Nov): Check In while a card-reader or saved-card payment
 *    is still being taken on the booking.
 *  - The three "no longer" sentences are never shown by the staff app: its functions answer null for them, as the
 *    old ones did for a row that isn't there. They are what the route itself says.
 *  - The last four are the customer channel's (the website; no route yet, lead call L13).
 */
export const BOOKING_ADMIN_NEW_WORDS = {
  paymentNeededCheckIn: 'This booking needs payment first. Use Take Payment.',
  paymentOpenCheckIn: 'A payment on this booking is still going through. Check in once it has completed.',
  cancelledCheckIn: "This booking is cancelled, so it can't be checked in and its check-in can't be undone.",
  cancelledWaiver: "This booking is cancelled, so its guests' waivers can no longer be changed.",
  cancelledPrepared: "This booking is cancelled, so its add-ons can no longer be marked prepared or not prepared.",
  removedAddonPrepared: "This add-on has been removed from the booking, so it can't be marked prepared or not prepared.",
  bookingNotFound: 'That booking no longer exists. Reload the page and try again.',
  guestNotFound: 'That guest is no longer on the booking. Reload the page and try again.',
  addonLineNotFound: 'That add-on is no longer on the booking. Reload the page and try again.',
  bookingChanged: 'The booking changed while this was being saved, so nothing was changed. Reload the page and try again.',
  customerNotTheirBooking: "This guest isn't on one of your bookings, so you can't sign their waiver here.",
  customerSessionPassed: 'This session has already taken place, so the waiver can no longer be signed online. Please speak to the team at the club.',
  customerCannotRevoke: 'A signed waiver can only be withdrawn by the team at the club.',
  customerWaiverMethod: "That isn't a way a waiver can be signed online.",
} as const

/** The reasons the three flags refuse with (`details.reason`), by what the staff app's functions make of them. */
export const BOOKING_FLAG_REASONS = {
  /** Answered as null by the staff app's functions, as the old ones answered a row that isn't there. */
  notFound: ['booking_not_found', 'guest_not_found', 'addon_line_not_found'],
  /** Thrown in the Worker's words. */
  refused: ['booking_cancelled', 'payment_needed', 'payment_open', 'addon_removed', 'invalid_waiver_method', 'booking_changed'],
  /** The customer channel's own. */
  customer: ['not_their_booking', 'session_passed', 'customer_cannot_revoke', 'waiver_method_not_allowed'],
} as const
