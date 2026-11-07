// Ported from backend/paddock/shared/guestValidation.ts.
import 'server-only'

export const MAX_GUESTS_PER_PRIVATE_BOOKING = 10
/** The real attendee limit for a public session slot. */
export const MAX_GUESTS_PER_PUBLIC_BOOKING = 6
const MIN_GUESTS_PER_BOOKING = 1
const MINIMUM_GUEST_AGE = 18

export const GUESTS_OVER_18_NOT_CONFIRMED_MESSAGE = 'Confirm that everyone else in the booking is 18 or over.'

export interface GuestDetails {
  name?: string | null | undefined
  dateOfBirth?: string | null | undefined
}

export type GuestValidationReason =
  | 'no_guests'
  | 'too_many_guests'
  | 'guest_name_required'
  | 'guest_dob_required'
  | 'guest_dob_invalid'
  | 'guest_under_18'
  | 'guests_over_18_not_confirmed'

export interface GuestProblem {
  reason: GuestValidationReason
  /** The offending row, when there is one. */
  guestIndex?: number
}

/**
 * Whether `dateOfBirth` is at least 18 years before `asOfIsoDate` ("YYYY-MM-DD"). Worked out on the
 * date digits, so the server's UTC clock never shifts the day.
 */
export function isAtLeastMinimumAge(dateOfBirth: string, asOfIsoDate: string): boolean {
  const dob = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateOfBirth)
  const asOf = /^(\d{4})-(\d{2})-(\d{2})/.exec(asOfIsoDate)
  if (!dob || !asOf || Number.isNaN(new Date(dateOfBirth).getTime())) return false
  const [dy, dm, dd] = [Number(dob[1]), Number(dob[2]), Number(dob[3])]
  const [ay, am, ad] = [Number(asOf[1]), Number(asOf[2]), Number(asOf[3])]
  let age = ay - dy
  if (am < dm || (am === dm && ad < dd)) age--
  return age >= MINIMUM_GUEST_AGE
}

/**
 * 1 to `maxGuests` guests, and every guest needs a name. Row 1 is the account holder, who also needs
 * a valid date of birth and must be 18 on `today`. Everyone else gives no date of birth: the booking
 * carries the "everyone else is 18 or over" tick instead. Null when the list is fine.
 */
export function validateGuests(guests: readonly GuestDetails[], maxGuests: number, guestsOver18Confirmed: boolean, today: string): GuestProblem | null {
  if (guests.length < MIN_GUESTS_PER_BOOKING) return { reason: 'no_guests' }
  if (guests.length > maxGuests) return { reason: 'too_many_guests' }
  const missingName = guests.findIndex((guest) => !(guest.name ?? '').trim())
  if (missingName >= 0) return { reason: 'guest_name_required', guestIndex: missingName }
  const dateOfBirth = guests[0]?.dateOfBirth
  if (!dateOfBirth) return { reason: 'guest_dob_required', guestIndex: 0 }
  if (Number.isNaN(new Date(dateOfBirth).getTime())) return { reason: 'guest_dob_invalid', guestIndex: 0 }
  if (!isAtLeastMinimumAge(dateOfBirth, today)) return { reason: 'guest_under_18', guestIndex: 0 }
  if (guests.length > 1 && guestsOver18Confirmed !== true) return { reason: 'guests_over_18_not_confirmed' }
  return null
}
