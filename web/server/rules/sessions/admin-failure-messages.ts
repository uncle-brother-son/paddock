// Brief W48 item 1 (G-plan 4.1): the words of sessions and the timetable: weekly slots, blocking, bands, start times
// and one-off sessions (W51), moved word for word from the staff app's old
// functions as frozen at W48 (testing/legacy-admin). Unused yet: each slice that moves an action answers its refusals
// with these, so the screens' handling still works. Generated once by briefs/W48-logs/generate-words-files.py in the
// staff app repo and kept by hand from here on; server/rules/admin/words.test.ts reads the old sentences from the
// frozen copy with the TypeScript parser and holds this file to them, both ways. A sentence that takes a value is a
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
 */
export const SESSION_ADMIN_DIALOG_WORDS = {
  EditSessionStartTimeDialog: {
    session_not_found: 'This session no longer exists.',
    session_has_bookings: 'A booking was just made for this slot, so its start time can no longer be changed.',
    slot_already_exists: 'This service type already has a session at that time.',
    invalid_start_time: 'Enter a valid date and time.',
  },
  CreateOneOffSessionDialog: {
    service_type_not_found: 'That service type is no longer active.',
    service_type_incomplete: 'That service type is missing a duration, capacity, or booking type — finish setting it up first.',
    slot_already_exists: 'A session already exists for that service type at that exact time.',
  },
} as const
