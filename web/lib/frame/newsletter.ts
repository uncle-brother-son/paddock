// The footer's newsletter sign-up (W73). The real call (Klaviyo, double opt-in, Turnstile; WQ24) is a later Level 1b
// brief: this is the one place it will be made from. Until then nobody is signed up, and the form shows its designed
// error state with the words below.

export type NewsletterResult = { ok: true } | { ok: false; message: string }

/** Shown under the field while the sign-up is not connected. */
export const NEWSLETTER_NOT_SET_UP = "Sign-up isn't open yet. Please try again soon."

/** Shown under the field for something that isn't an email address. */
export const NEWSLETTER_INVALID_EMAIL = 'Enter a valid email address.'

/** One thing before the @, and a dot somewhere after it: enough to catch a slip. The real check is the confirming email. */
export const looksLikeEmail = (value: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())

/** Signs an email address up to the newsletter. Not set up yet: always answers so, and sends nothing anywhere. */
export async function subscribeToNewsletter(email: string): Promise<NewsletterResult> {
  if (!looksLikeEmail(email)) return { ok: false, message: NEWSLETTER_INVALID_EMAIL }
  return { ok: false, message: NEWSLETTER_NOT_SET_UP }
}
