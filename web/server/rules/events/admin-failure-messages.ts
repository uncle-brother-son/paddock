// Brief W48 item 1 (G-plan 4.1): the words of events: on and off sale, details, check-in and waivers (W52), moved word
// for word from the staff app's old
// functions as frozen at W48 (testing/legacy-admin). Unused yet: each slice that moves an action answers its refusals
// with these, so the screens' handling still works. Generated once by briefs/W48-logs/generate-words-files.py in the
// staff app repo and kept by hand from here on; server/rules/admin/words.test.ts reads the old sentences from the
// frozen copy with the TypeScript parser and holds this file to them, both ways. A sentence that takes a value is a
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

/** The reasons each old function's own result type names, in its order. */
export const EVENT_ADMIN_REASONS = {
  setEventActive: ['event_not_found', 'event_incomplete'],
  setEventDetails: ['invalid_params', 'event_not_found', 'event_cancelled', 'constraint'],
  eventCheckIn: ['attendee_not_found', 'waivers_outstanding'],
  setEventAttendeeCheckIn: ['attendee_not_found'],
  setEventAttendeeWaiver: ['invalid_params', 'attendee_not_found'],
} as const
