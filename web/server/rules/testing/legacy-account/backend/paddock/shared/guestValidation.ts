import { londonToday } from './londonTime'

export const MIN_GUESTS_PER_BOOKING = 1
/** Attendee cap for private bookings (the higher of the two limits). */
export const MAX_GUESTS_PER_PRIVATE_BOOKING = 10
/** Attendee cap for public sessions — the real attendee limit for a public session slot. */
export const MAX_GUESTS_PER_PUBLIC_BOOKING = 6
/** @deprecated kept only so any stray import doesn't hard-fail — use the booking-type-specific constants above. */
export const MAX_GUESTS_PER_BOOKING = MAX_GUESTS_PER_PRIVATE_BOOKING
export const MINIMUM_GUEST_AGE = 18

export interface GuestInput {
  name: string
  email?: string
  /** Required for the account holder (row 1) only. Guests give no date of birth — the person
   *  booking ticks "Everyone else in this booking is 18 or over" instead (28 Oct). */
  dateOfBirth?: string
}

export type GuestValidationReason =
  | 'no_guests'
  | 'too_many_guests'
  | 'guest_name_required'
  | 'guest_dob_required'
  | 'guest_dob_invalid'
  | 'guest_under_18'
  | 'guests_over_18_not_confirmed'

export interface GuestValidationResult {
  valid: boolean
  reason?: GuestValidationReason
  /** Index into the guests array of the offending guest, when applicable. */
  guestIndex?: number
}

/**
 * True if `dateOfBirth` (an ISO date string, e.g. '2000-01-01') represents someone at least
 * `MINIMUM_GUEST_AGE` years old on `asOfIsoDate` ("YYYY-MM-DD", defaults to London's today).
 * Calendar-accurate (whether the birthday has occurred yet that year), worked out on the date
 * digits so the server's UTC clock never shifts the day.
 */
export function isAtLeastMinimumAge(dateOfBirth: string, asOfIsoDate: string = londonToday()): boolean {
  const dob = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateOfBirth)
  const asOf = /^(\d{4})-(\d{2})-(\d{2})/.exec(asOfIsoDate)
  if (!dob || !asOf || Number.isNaN(new Date(dateOfBirth).getTime())) return false
  const [dy, dm, dd] = [Number(dob[1]), Number(dob[2]), Number(dob[3])]
  const [ay, am, ad] = [Number(asOf[1]), Number(asOf[2]), Number(asOf[3])]
  let age = ay - dy
  if (am < dm || (am === dm && ad < dd)) age--
  return age >= MINIMUM_GUEST_AGE
}

/** Staff-facing text for 'guests_over_18_not_confirmed'. */
export const GUESTS_OVER_18_NOT_CONFIRMED_MESSAGE = 'Confirm that everyone else in the booking is 18 or over.'

/**
 * Validates a full guest list for a session booking: 1-`maxGuests` guests — 6 for a public
 * session (the real attendee limit), 10 for a private one — every guest needs a name. Row 1 is
 * the account holder: they also need a valid date of birth and must be at least 18. Everyone
 * else gives no date of birth; instead the booking must carry the "everyone else is 18 or over"
 * confirmation (`guestsOver18Confirmed`) whenever there is anyone besides the account holder.
 */
export function validateGuests(
  guests: GuestInput[],
  maxGuests: number = MAX_GUESTS_PER_PRIVATE_BOOKING,
  guestsOver18Confirmed: boolean = false
): GuestValidationResult {
  if (guests.length < MIN_GUESTS_PER_BOOKING) {
    return { valid: false, reason: 'no_guests' }
  }
  if (guests.length > maxGuests) {
    return { valid: false, reason: 'too_many_guests' }
  }
  for (let i = 0; i < guests.length; i++) {
    if (!guests[i]!.name.trim()) {
      return { valid: false, reason: 'guest_name_required', guestIndex: i }
    }
  }
  const accountHolder = guests[0]!
  if (!accountHolder.dateOfBirth) {
    return { valid: false, reason: 'guest_dob_required', guestIndex: 0 }
  }
  if (Number.isNaN(new Date(accountHolder.dateOfBirth).getTime())) {
    return { valid: false, reason: 'guest_dob_invalid', guestIndex: 0 }
  }
  if (!isAtLeastMinimumAge(accountHolder.dateOfBirth)) {
    return { valid: false, reason: 'guest_under_18', guestIndex: 0 }
  }
  if (guests.length > 1 && guestsOver18Confirmed !== true) {
    return { valid: false, reason: 'guests_over_18_not_confirmed' }
  }
  return { valid: true }
}

export interface AccountHolderProfile {
  firstName: string
  lastName: string
  email: string
}

function normalize(value: string): string {
  return value.trim().toLowerCase()
}

/**
 * Finds which guest row (if any) represents the account holder themselves, by matching identity
 * (email, or full name) rather than assuming position — staff may remove/replace the pre-filled
 * first guest when booking entirely on someone else's behalf, and that's a valid, expected state,
 * not an error. Only the first matching row is tagged, in the unlikely case more than one guest
 * happens to share the same name/email.
 */
export function findAccountHolderIndex(guests: GuestInput[], account: AccountHolderProfile): number {
  const accountEmail = normalize(account.email)
  const accountName = normalize(`${account.firstName} ${account.lastName}`)
  for (let i = 0; i < guests.length; i++) {
    const guest = guests[i]!
    const guestEmail = guest.email ? normalize(guest.email) : ''
    const guestName = normalize(guest.name)
    if ((guestEmail && guestEmail === accountEmail) || guestName === accountName) {
      return i
    }
  }
  return -1
}
