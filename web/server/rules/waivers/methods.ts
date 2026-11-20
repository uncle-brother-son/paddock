// New in W50 (G-plan 4.8; brief item 7; backend log 12 and 18): the ways a waiver can be recorded as signed, in one
// place, by who is recording it. A session guest's waiver (server/rules/bookings/admin.ts) reads it today; an event
// attendee's (W52) reads the same list, so the website adds a method once.

/** Who is recording the waiver: a staff member in the staff app, or the website's customer (lead call L13: no customer route yet). */
export type WaiverChannel = 'staff' | 'customer'

/**
 * The methods each channel may record.
 *  - `in_person`: staff saw it signed. Never the customer's to claim.
 *  - `email_link`: signed from the link emailed to the guest. Staff may record it too (the old function let them).
 *  - `checkout` is the website's third (backend log 12: signed while checking out). It is NOT here yet: add it to
 *    `customer` when the website's checkout is built. A session guest's row can't hold it until then either:
 *    `booking_guests_waiver_method_check` allows only the two below (`event_attendees` already allows all three), so
 *    it needs the lead's migration first.
 */
export const WAIVER_METHODS = {
  staff: ['in_person', 'email_link'],
  customer: ['email_link'],
} as const satisfies Record<WaiverChannel, readonly string[]>

export type WaiverMethod = (typeof WAIVER_METHODS)[WaiverChannel][number]

/** Whether `method` is one this channel may record. */
export const isWaiverMethodFor = (channel: WaiverChannel, method: unknown): method is WaiverMethod => typeof method === 'string' && (WAIVER_METHODS[channel] as readonly string[]).includes(method)

/** The version recorded when none is given, as the old function recorded it. */
export const DEFAULT_WAIVER_VERSION = 'v1'
