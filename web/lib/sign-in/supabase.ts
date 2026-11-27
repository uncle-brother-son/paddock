'use client'

import { createClient } from '@/lib/supabase/client'
import { keepSignedInCookie } from '@/lib/supabase/keep-signed-in'

import { emailReturnAddress } from './next'

// W85 (backend log 9): the browser's side of Supabase's passwordless sign-in. An email gets a 6-digit code and a link
// (W85a's template); the code is checked here, the link on /auth/confirm (on the server). Supabase's package is loaded
// only by lib/supabase/ (server/no-service-role-key.test.ts), so its errors are read by their status and code.

type AuthFailure = { status?: unknown; code?: unknown; name?: unknown } | null

/** Supabase refused (it answered: 4xx) rather than could not be reached or failed (none, or 5xx). */
const refusedBy = (error: AuthFailure): number | null => (error && typeof error.status === 'number' && error.status >= 400 && error.status < 500 ? error.status : null)
const codeOf = (error: AuthFailure): string => (error && typeof error.code === 'string' ? error.code : '')

export type SendResult = 'sent' | 'too_soon' | 'invalid_email' | 'fault'

/**
 * Sends the sign-in email: a code, and a link back to `returnTo` (this site's page, no query string). A new email
 * gets a login of its own (the customer comes with Create your account).
 */
export async function sendCode(email: string, returnTo: string): Promise<SendResult> {
  try {
    const { error } = await createClient().auth.signInWithOtp({
      email: email.trim(),
      options: { shouldCreateUser: true, emailRedirectTo: emailReturnAddress(window.location.origin, returnTo) },
    })
    if (!error) return 'sent'
    const status = refusedBy(error)
    if (status === 429 || codeOf(error).includes('rate_limit')) return 'too_soon'
    if (status !== null && /email/.test(codeOf(error))) return 'invalid_email'
    return 'fault'
  } catch {
    return 'fault'
  }
}

export type VerifyResult = 'signed_in' | 'wrong' | 'too_soon' | 'fault'

/** Checks the 6-digit code for that email. Right, and the login's session is in this browser's cookies. */
export async function verifyCode(email: string, code: string): Promise<VerifyResult> {
  try {
    const { data, error } = await createClient().auth.verifyOtp({ email: email.trim(), token: code, type: 'email' })
    if (!error && data.session) return 'signed_in'
    const status = refusedBy(error)
    if (status === 429) return 'too_soon'
    // Wrong, expired or used: Supabase says so with a 4xx (otp_expired, invalid_credentials...).
    return status !== null ? 'wrong' : 'fault'
  } catch {
    return 'fault'
  }
}

/**
 * The signed-in login on this device: its access token (refreshed by Supabase when it has run out), for the Worker,
 * and its email, to show; null when no one is signed in. Who the customer is, the Worker decides from the token.
 */
export async function signedInLogin(): Promise<{ token: string; email: string } | null> {
  try {
    const { data } = await createClient().auth.getSession()
    const session = data.session
    return session ? { token: session.access_token, email: session.user.email ?? '' } : null
  } catch {
    return null
  }
}

/** Log out on this device only (Supabase's `local` scope): other devices stay signed in. */
export async function signOutHere(): Promise<void> {
  try {
    await createClient().auth.signOut({ scope: 'local' })
  } catch {
    // Signed out or not, the site carries on as signed out.
  }
}

/**
 * Calls `changed` once at first (Supabase's INITIAL_SESSION, as soon as it has read this browser's session), then
 * whenever this browser signs in or out (another tab included); gives back the way to stop.
 */
export function watchSignIn(changed: () => void): () => void {
  try {
    const { data } = createClient().auth.onAuthStateChange((event) => {
      // Never awaited inside Supabase's callback (it holds its lock while the callback runs): the next task asks.
      if (event === 'INITIAL_SESSION' || event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'USER_UPDATED') window.setTimeout(changed, 0)
    })
    return () => data.subscription.unsubscribe()
  } catch {
    // No Supabase to ask (Storybook has no project): asked once, it finds no one signed in.
    const first = window.setTimeout(changed, 0)
    return () => window.clearTimeout(first)
  }
}

/** Notes "Keep me signed in" for the sign-in about to be made (lib/supabase/keep-signed-in.ts). */
export function noteKeepSignedIn(keep: boolean): void {
  document.cookie = keepSignedInCookie(keep)
}
