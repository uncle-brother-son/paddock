// Brief W48 item 1 (G-plan 4.1): the words of events: on and off sale, details, check-in and waivers (W52), moved word
// for word from the staff app's old
// functions as they were at W48. Unused yet: each slice that moves an action answers its refusals
// with these, so the screens' handling still works. Generated once by briefs/W48-logs/generate-words-files.py in the
// staff app repo and kept by hand from here on; server/rules/admin/words.test.ts holds this file to the old
// sentences (read from the old code with the TypeScript parser, pinned in testing/old-words.json), both ways. A sentence that takes a value is a
// function of it. Not here, on purpose (the same test holds that they stay out): the plumbing between Retool and
// the legacy routes ("returned an HTML page", "Unauthorized", "Missing required fields", "Internal server
// error", the fallbacks for an error with no words) and "saved but could not be read back", which one transaction
// can't leave.

export const EVENT_ADMIN_WORDS = {
  /** setEventActive */
  setEventActive: {
    thatEventNoLongerExists: 'That event no longer exists.',
    setDateCapacityPricesAndRefund: 'Set the date, capacity, prices and refund cut-off before putting this event on sale (and the public release time for Members first). A cancelled event cannot go on sale.',
  },
  /** setEventDetails */
  setEventDetails: {
    chooseWhoCanBookPublicMembers: 'Choose who can book: Public, Members only or Members first.',
    capacityMustWholeNumberAtLeast: 'Capacity must be a whole number of at least 1.',
    pricesCantNegative: "Prices can't be negative.",
    oneDatesNotValid: 'One of the dates is not valid.',
    thatEventNoLongerExists: 'That event no longer exists.',
    eventHasBeenCancelledSoIt: "This event has been cancelled, so it can't be edited.",
    capacityCantLowerThanPlacesAlready: (first: unknown): string => `Capacity can't be lower than the places already booked (${String(first)}).`,
    endTimeMustAfterStartTime: 'The end time must be after the start time.',
    refundCutOffCantAfterEvent: "The refund cut-off can't be after the event starts.",
    publicReleaseMustBeforeEventStarts: 'The public release must be before the event starts.',
    capacityMustAtLeast1: 'Capacity must be at least 1.',
    eventOnSaleSoItNeeds: 'This event is on sale, so it needs a date, capacity, all three prices and a refund cut-off (and a public release time for Members first). Take it off sale first to clear any of them.',
  },
  /** eventAttendance */
  eventAttendance: {
    checkInOpensOnDay: 'Check-in opens on the day',
    checkInHasClosed: 'Check-in has closed',
  },
  /** eventCheckIn */
  eventCheckIn: {
    attendee_not_found: 'This attendee no longer exists.',
    attendee_cancelled: 'This place has been cancelled.',
    booking_not_confirmed: "This event booking isn't confirmed.",
    event_cancelled: 'This event has been cancelled.',
    waivers_outstanding: 'Mark the waiver(s) signed before checking in.',
    extra_waiver_version_missing: "The extra waiver text hasn't synced from Sanity yet, so it can't be marked signed.",
  },
  /** setEventAttendeeWaiver */
  setEventAttendeeWaiver: {
    attendee_not_found: 'This attendee no longer exists.',
    attendee_cancelled: 'This place has been cancelled.',
    booking_not_confirmed: "This event booking isn't confirmed.",
    no_extra_waiver: "This event doesn't have an extra waiver.",
    extra_waiver_version_missing: "The extra waiver text hasn't synced from Sanity yet, so it can't be marked signed.",
    chooseStandardOrExtraWaiver: 'Choose the standard or the extra waiver.',
    revokeStandardOrExtraWaiverOn: 'Revoke the standard or the extra waiver on its own.',
    chooseHowWaiverWasSigned: 'Choose how the waiver was signed.',
  },
} as const

/**
 * W52: the words the Worker adds for events (none is moved from an old function: each is for something the old code
 * didn't check, or for the website's customer, who has no route yet).
 */
export const EVENT_ADMIN_NEW_WORDS = {
  /**
   * Q51 (Wayne, 20 Nov; bug GB11): once a place is booked, the refund cut-off can move later but not earlier. Said
   * when the cut-off box was set earlier than it may be (W52a, review S2). `earliest` is the earliest the box can
   * hold, as staff read a time ("Tue 1 Dec 2026, 6:00 pm"): the cut-off customers booked under, rounded up to a whole
   * minute (review S1), or the event's new start when the event is being brought forward to before it (Q-a).
   */
  cutoffEarlier: (earliest: string): string =>
    `Places are already booked on this event, so the refund cut-off can't be made earlier: customers keep at least the cut-off they booked under. The earliest it can be is ${earliest}.`,
  /**
   * The same when the edit would leave the event with no cut-off at all: no cut-off set and no date either (with no
   * cut-off the event's start is the cut-off: Q43). W52a: a cut-off cleared while the date stays, or a date brought
   * forward, is no longer answered with these (the first was always allowed while the start was no earlier; the
   * second is Q-a's, and the cut-off follows).
   */
  cutoffCleared: (earliest: string): string =>
    `Places are already booked on this event, so its refund cut-off can't be cleared or brought forward: customers keep at least the cut-off they booked under. Set a refund cut-off of ${earliest} or later.`,
  /** W58b (W52 "For later" 3): a capacity past what the column holds (the table's own error was shown before). */
  capacityTooLarge: 'Capacity is too large: enter a number of places of 2,147,483,647 or fewer.',
  /** W58b (W52 "For later" 3): a price past what the price columns hold. */
  priceTooLarge: 'Prices can be at most £99,999,999.99.',
  /** An attendee whose row changed between the press's statements (someone else's press landed first). */
  attendeeChanged: 'This attendee changed while this was being saved, so nothing was changed. Reload the page and try again.',
  // W52a (W52 review "For later" 1): the website's customer is told nothing about an attendee who isn't on one of
  // their own event bookings: it is answered exactly as one that isn't there (`attendee_not_found`, the old words),
  // as W33 answers someone else's booking. So there are no words and no reason of its own for it.
  /** The website's customer: the event has ended. */
  customerEventPassed: 'This event has already taken place, so the waiver can no longer be signed online. Please speak to the team at the club.',
  /** The website's customer: a waiver is never withdrawn online. */
  customerCannotRevoke: 'A signed waiver can only be withdrawn by the team at the club.',
  /** The website's customer: a method the website may not record (waivers/methods.ts). */
  customerWaiverMethod: "That isn't a way a waiver can be signed online.",
} as const

/** The reasons W52 adds to the old functions'. */
export const EVENT_ADMIN_NEW_REASONS = ['cutoff_earlier', 'changed_since', 'attendee_changed', 'event_passed', 'customer_cannot_revoke', 'waiver_method_not_allowed'] as const

/** The reasons each old function's own result type names, in its order. */
export const EVENT_ADMIN_REASONS = {
  setEventActive: ['event_not_found', 'event_incomplete'],
  setEventDetails: ['invalid_params', 'event_not_found', 'event_cancelled', 'constraint'],
  eventCheckIn: ['attendee_not_found', 'waivers_outstanding'],
  setEventAttendeeCheckIn: ['attendee_not_found'],
  setEventAttendeeWaiver: ['invalid_params', 'attendee_not_found'],
} as const
