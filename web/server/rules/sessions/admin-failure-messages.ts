// Brief W48 item 1 (G-plan 4.1): the words of sessions and the timetable: weekly slots, blocking, bands, start times
// and one-off sessions (W51), moved word for word from the staff app's old
// functions as they were at W48. Unused yet: each slice that moves an action answers its refusals
// with these, so the screens' handling still works. Generated once by briefs/W48-logs/generate-words-files.py in the
// staff app repo and kept by hand from here on; server/rules/admin/words.test.ts holds this file to the old
// sentences (read from the old code with the TypeScript parser, pinned in testing/old-words.json), both ways. A sentence that takes a value is a
// function of it. Not here, on purpose (the same test holds that they stay out): the plumbing between Retool and
// the legacy routes ("returned an HTML page", "Unauthorized", "Missing required fields", "Internal server
// error", the fallbacks for an error with no words) and "saved but could not be read back", which one transaction
// can't leave.

export const SESSION_ADMIN_WORDS = {
  /** addServiceTypeScheduleSlot */
  addServiceTypeScheduleSlot: {
    servicetypeidRequired: 'serviceTypeId is required',
    dayofweekMustInteger060: (first: unknown): string => `dayOfWeek must be an integer 0-6 (0 = Sunday); received ${String(first)}`,
    starttimeMustInHhMmOr: 'startTime must be in HH:MM or HH:MM:SS format',
    serviceTypeAlreadyHasSlotOn: (first: unknown, second: unknown): string => `This service type already has a slot on ${String(first)} at ${String(second)}.`,
  },
  /** deleteServiceTypeScheduleSlot */
  deleteServiceTypeScheduleSlot: {
    slotidRequired: 'slotId is required',
  },
  /** setSessionBand */
  setSessionBand: {
    provideEitherSessionidOrDate: 'Provide either a sessionId or a date.',
    provideEitherSessionidOrDateNot: 'Provide either a sessionId or a date, not both.',
    thatBandNoLongerExists: 'That band no longer exists.',
  },
  /** setSessionStartTime */
  setSessionStartTime: {
    enterValidDateAndTime: 'Enter a valid date and time.',
  },
} as const

/** The reasons each old function's own result type names, in its order. */
export const SESSION_ADMIN_REASONS = {
  resetSessionBand: ['session_not_found', 'not_overridden'],
  setSessionStartTime: ['invalid_start_time', 'session_not_found', 'session_has_bookings', 'slot_already_exists'],
  createOneOffSession: ['service_type_not_found', 'service_type_incomplete', 'slot_already_exists'],
} as const

/**
 * The dialogs' own sentences for the refusals above that the old function answers with a reason and no words: what
 * staff read today, so what the Worker's refusal carries.
 *
 * W51a (W51 report "Noticed" 2): `session_has_bookings` was "A booking was just made for this slot, so its start
 * time can no longer be changed." Since GB6 a Payment needed booking gives it too, which wasn't "just made". The
 * dialog and this file changed together (server/rules/admin/words.test.ts holds the two to each other).
 */
export const SESSION_ADMIN_DIALOG_WORDS = {
  EditSessionStartTimeDialog: {
    session_not_found: 'This session no longer exists.',
    session_has_bookings: "This slot has a booking, so its start time can't be changed.",
    slot_already_exists: 'This service type already has a session at that time.',
    invalid_start_time: 'Enter a valid date and time.',
  },
  CreateOneOffSessionDialog: {
    service_type_not_found: 'That service type is no longer active.',
    service_type_incomplete: 'That service type is missing a duration, capacity, or booking type — finish setting it up first.',
    slot_already_exists: 'A session already exists for that service type at that exact time.',
  },
} as const

/**
 * W51 (G-plan 4.5; bugs GB5 to GB7; Q18's rule for counts; W48 "For the Worker step": plain words where there were
 * none or the database's own showed): the words for refusals the old functions never made, or made without words.
 * Not old sentences, so they are kept apart from SESSION_ADMIN_WORDS and SESSION_ADMIN_DIALOG_WORDS
 * (server/rules/admin/words.test.ts holds those to the old code and the dialogs, both ways);
 * server/rules/sessions/admin.test.ts holds these.
 *  - `sessionGone`: a block, unblock, band change or reset of a session that isn't there. The old block answered
 *    "blocked" with no session, the old band change "0 sessions", the old unblock and reset a bare null or reason.
 *  - `bookingsInTheWay`, `dayBookingsInTheWay`: the Block dialogs' own sentences with "confirmed" taken out (GB5:
 *    every booking that isn't cancelled stops a block), so the refusal reads as the dialog does.
 *  - `alreadyBlocked`, `notBlocked`: GB7. A block never overwrites an earlier block's reason; an unblock opens only
 *    what is blocked.
 *  - `countsChanged`: Q18's rule for counts. The press sends the figures staff saw; if they are no longer right,
 *    nothing is changed and the dialog shows the new ones.
 *  - `notOverridden`: the old reset answered the reason with no words.
 *  - `serviceTypeGone`: a weekly slot for a service type that isn't there (the old function showed the database's
 *    foreign key error).
 *  - `noLength`: a start time moved on a session whose service type has no duration (the old function showed the
 *    database's not-null error).
 *  - `slotGone`: never shown by the staff app (its function answers `deleted: false`, as before); what the route says.
 *  - W51a (W51 review S1): `moveInFlight`, `dayMoveInFlight`: a block, a Block Day or a start-time change while a
 *    booking is being moved off the slot and its card or reader payment isn't finished (the Move's undo would put
 *    the booking back on it). The first is the lead's sentence; the second is the same for a day.
 *  - W51a (closed dates): `dateClosed`: a one-off session on a closed date (the lead's sentence).
 *    `dateClosedForMove`: a start-time change that would move a session onto a closed date from another date.
 */
export const SESSION_ADMIN_NEW_WORDS = {
  sessionGone: 'This session no longer exists. Reload the page and try again.',
  bookingsInTheWay: (count: number): string => `This slot has ${count} booking${count === 1 ? '' : 's'}. Move each one to a different session or cancel it before this slot can be blocked.`,
  dayBookingsInTheWay: (count: number): string => `${count} booking${count === 1 ? ' exists' : 's exist'} on this day. Move each one to a different session or cancel it before the day can be blocked.`,
  alreadyBlocked: 'This session is already blocked. Its reason has been left as it was.',
  notBlocked: "This session isn't blocked, so there is nothing to unblock.",
  countsChanged: 'This has changed since the figures were shown. Check the new figures, then confirm again.',
  notOverridden: "This session's band is already set automatically.",
  serviceTypeGone: 'That service type no longer exists. Reload the page and try again.',
  noLength: "This session's service type has no duration set, so its end time can't be worked out. Set the duration on the Service Types page first.",
  slotGone: 'That weekly slot no longer exists. Reload the page and try again.',
  moveInFlight: "A booking is being moved off this slot and its payment isn't finished. Try again when it is.",
  dayMoveInFlight: "A booking is being moved off a slot on this day and its payment isn't finished. Try again when it is.",
  dateClosed: 'This date is closed. Unblock the day first if you want to add a session.',
  dateClosedForMove: 'That date is closed. Unblock the day first if you want to move a session onto it.',
} as const

/** The reason a press is refused with when the figures it sent are no longer right (admin/stamp.ts's, for counts). */
export const COUNTS_CHANGED_REASON = 'changed_since'
/** W51a (W51 review S1): the reason a block or a start-time change is refused with while a Move off the slot is unfinished. */
export const MOVE_IN_FLIGHT_REASON = 'move_in_flight'
