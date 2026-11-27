// New in W85a (backend log 9): what a customer is told when signing in or creating their account goes wrong. Plain
// words, no staff terms, and where they can't fix it themselves the words say to get in touch. The website shows them
// as they are (W85's popup), branching on the reason, never on the words.

export const SIGN_IN_WORDS = {
  /** The login's email is held by a customer already linked to a different login (logged for staff). */
  emailLinkedElsewhere: 'This email is linked to another sign-in. Please contact us.',
  /** The login's email has not been confirmed with Supabase (a code or a link), so it can't be matched to a customer. */
  emailNotConfirmed: 'Please confirm your email address with the code we sent you, then try again.',
  /** The login has no email (an anonymous or phone-only sign-in): the club's accounts are by email. */
  noEmail: 'Please sign in with your email address.',
  /** WQ101: a login by another provider (Google, Apple): only the emailed code is taken for now. */
  emailLoginOnly: 'Please sign in with the code we email you.',
  firstNameRequired: 'Please enter your first name.',
  lastNameRequired: 'Please enter your last name.',
  tooLong: (field: 'firstName' | 'lastName' | 'phone', limit: number): string =>
    `${field === 'firstName' ? 'First name' : field === 'lastName' ? 'Last name' : 'Phone number'} can be at most ${limit} characters.`,
} as const

/** Every reason a sign-in route refuses with, in `error.details.reason`. */
export const SIGN_IN_REASONS = [
  'email_linked_elsewhere',
  'email_not_confirmed',
  'no_email',
  'email_login_only',
  'first_name_required',
  'last_name_required',
  'too_long',
] as const
export type SignInReason = (typeof SIGN_IN_REASONS)[number]
