// Brief W48 item 1 (G-plan 4.1): the words of the booking screens' flags and the open-payment words (W50), moved word
// for word from the staff app's old
// functions as frozen at W48 (testing/legacy-admin). Unused yet: each slice that moves an action answers its refusals
// with these, so the screens' handling still works. Generated once by briefs/W48-logs/generate-words-files.py in the
// staff app repo and kept by hand from here on; server/rules/admin/words.test.ts reads the old sentences from the
// frozen copy with the TypeScript parser and holds this file to them, both ways. A sentence that takes a value is a
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
