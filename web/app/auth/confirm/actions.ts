'use server'

import { createClient } from '@/lib/supabase/server'

// W85 (backend log 27): the email's Sign in button, used up on the server, and only when the visitor presses Sign in
// on /auth/confirm (never on load, so a mail scanner that opens the link can't use it up). Supabase checks the
// token hash (`verifyOtp`, type `email`: W85a's template) and the session it gives is written to this browser's
// cookies (lib/supabase/server.ts, which keeps "Keep me signed in"). Linking the customer is the browser's next step
// (W85a's link, with the new session's token), on the page the visitor goes back to.

export type ConfirmResult = 'signed_in' | 'expired' | 'fault'

/** Supabase's token hashes are hex; anything else (or nothing) is not a link it sent. */
const LOOKS_LIKE_A_HASH = /^[A-Za-z0-9_-]{16,256}$/

export async function confirmSignIn(tokenHash: string): Promise<ConfirmResult> {
  if (typeof tokenHash !== 'string' || !LOOKS_LIKE_A_HASH.test(tokenHash)) return 'expired'
  try {
    const supabase = await createClient()
    const { data, error } = await supabase.auth.verifyOtp({ type: 'email', token_hash: tokenHash })
    if (!error && data.session) return 'signed_in'
    // Used, expired or not one of ours: Supabase refuses it (4xx). No answer, or a fault of its own: try again.
    const status = error && typeof error.status === 'number' ? error.status : null
    return status !== null && status >= 400 && status < 500 && status !== 429 ? 'expired' : 'fault'
  } catch {
    return 'fault'
  }
}
