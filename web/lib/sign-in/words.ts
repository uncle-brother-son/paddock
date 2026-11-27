// W85: the sign-in popup's and the email link page's words. Figma's where it draws them (05 Modules > Sign-in >
// SignInModal, 1174:12669; "Sign in link — Link expired or used", 1180:24831). Those Figma doesn't draw are marked
// "not drawn" and listed in the W85 report. The Worker's refusals keep their own words (W85a: sign-in-words.ts),
// shown as they come.

import { NEWSLETTER_INVALID_EMAIL } from '@/lib/frame/newsletter'

export const SIGN_IN_COPY = {
  emailTitle: 'Log in or create an account',
  email: 'Email',
  emailSubmit: 'Send code',
  agreeStart: 'By continuing, you agree to our ',
  terms: 'Terms & Conditions',
  agreeAnd: ' and ',
  privacy: 'Privacy Policy',

  codeTitle: 'Enter Code',
  code: 'Sign-in code',
  keepSignedIn: 'Keep me signed in',
  sentTo: (email: string): string => `Sent to ${email}`,
  change: 'Change',
  resend: 'Resend code',
  /** Shown in Resend code's place for 6 seconds after a new code is sent (Step=code resent). */
  resent: 'Code sent',
  wrongCode: "That code isn't right or has expired. Check the latest email, or resend a new code.",

  createTitle: 'Create your account',
  createIntro: 'You don’t have an account with us yet. Tell us a little about you to finish setting up your account.',
  firstName: 'First Name',
  lastName: 'Last Name',
  mobile: 'Mobile (Optional)',
  news: 'Email me with news and offers',
  create: 'Create account',

  close: 'Close',

  /** Not drawn: something that isn't an email address (the newsletter's words). */
  invalidEmail: NEWSLETTER_INVALID_EMAIL,
  /** Not drawn: Supabase refused to send another code so soon. */
  tooSoon: 'Please wait a minute before asking for another code.',
  /** Not drawn: Supabase or the Worker could not be reached, or answered with a fault. */
  fault: "We couldn't sign you in just now. Please try again.",
} as const

/** The email link page (/auth/confirm). */
export const LINK_COPY = {
  eyebrow: 'Sign in',
  /** Not drawn: the page before the button is pressed is the expired page's layout (Wayne, 30 Nov). */
  readyTitle: 'Sign in to The Paddock',
  readyText: 'Press the button to finish signing in.',
  signIn: 'Sign in',
  /** While the link is used up (Figma's generic loading screen, the Fence): for a screen reader. */
  signingIn: 'Signing in',
  expiredTitle: 'This sign-in link has expired',
  expiredText: 'Sign-in links can only be used once and stop working after a while. Request a new one to sign in.',
  sendNewLink: 'Send a new link',
} as const
