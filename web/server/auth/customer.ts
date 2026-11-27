import 'server-only'
import { createClient } from '@supabase/supabase-js'
import type { CustomerContext } from '@/contracts'
import type { Queryable } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import { SIGN_IN_WORDS, type SignInReason } from '@/server/rules/customer/sign-in-words'
import { bearerToken } from './bearer'

/**
 * Authentication for /api/v1/customer/*: the Supabase access token, sent as a Bearer token.
 *
 * The project signs tokens with an asymmetric key (ES256, published at
 * /auth/v1/.well-known/jwks.json), so supabase.auth.getClaims() checks the signature here against
 * the cached public key, with no call to Supabase on each request. It falls back to asking the
 * Auth server (getUser) only for a token it can't check locally, such as one signed with the old
 * shared secret. A token stays valid until it expires even if the customer signs out.
 */

export interface VerifiedToken {
  authUserId: string
}

export type TokenVerifier = (token: string) => Promise<VerifiedToken>

const SESSION_ENDED = 'Your session has expired. Please sign in again.'
const NOT_SIGNED_IN = 'Please sign in to continue.'

type SupabaseClient = ReturnType<typeof createClient>

function supabaseClient(supabaseUrl: string, supabaseAnonKey: string, fetchImpl?: typeof fetch): SupabaseClient {
  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    ...(fetchImpl ? { global: { fetch: fetchImpl } } : {}),
  })
}

/**
 * Supabase's answer to a token it refused, as ours. A fault (500), never a sign-out, when Supabase couldn't answer:
 * unreachable or a 5xx (`AuthRetryableFetchError`), too many requests (429), or an answer that wasn't its own (a
 * proxy's HTML page: `AuthUnknownError`, no status). W85a review (a)1: the sign-in routes ask Supabase for the user on
 * every link and create, so a 429 there must not send the customer back to sign in. Anything else (a bad, expired or
 * revoked token, a deleted user: 400, 401, 403, 404) is signed out.
 */
function refusedToken(error: { name: string; status?: number | undefined; message: string }, what: string): Error {
  const status = error.status
  if (error.name === 'AuthRetryableFetchError' || error.name === 'AuthUnknownError' || status === undefined || status === 429 || status >= 500) {
    // Supabase being unreachable isn't the customer's fault: don't sign them out for it.
    return new Error(`Could not ${what}: ${error.message}`)
  }
  const expired = /expired/i.test(error.message)
  return new ApiError('UNAUTHORISED', expired ? SESSION_ENDED : NOT_SIGNED_IN, { logDetail: error.message })
}

/** The token's claims, checked; a signed-in user's token only. */
async function checkedClaims(supabase: SupabaseClient, token: string) {
  const { data, error } = await supabase.auth.getClaims(token)
  if (error) throw refusedToken(error, 'verify the access token')
  const claims = data?.claims
  // The anon and service keys are validly signed too; only a signed-in user's token will do.
  if (!claims?.sub || claims.aud !== 'authenticated') {
    throw new ApiError('UNAUTHORISED', NOT_SIGNED_IN)
  }
  return claims
}

/** Checks a token with the given client options (tests pass their own fetch and keys). */
export function createTokenVerifier(
  supabaseUrl: string,
  supabaseAnonKey: string,
  fetchImpl?: typeof fetch
): TokenVerifier {
  return async (token) => {
    const claims = await checkedClaims(supabaseClient(supabaseUrl, supabaseAnonKey, fetchImpl), token)
    return { authUserId: claims.sub }
  }
}

/**
 * W85a (backend log 9): a signed-in login that may have no customer yet, for the sign-in routes (link, create). The
 * email is the token's own `email` claim, never anything the request sends, and it must be confirmed: the token is
 * checked as above, then Supabase's Auth server is asked for the login itself (`getUser`, one call, on sign-in only),
 * and its `email_confirmed_at` must be set and its email the token's. `user_metadata.email_verified` in the token is
 * NOT trusted: a signed-in user can write their own user_metadata (`updateUser({ data })`), so it proves nothing.
 * An anonymous login, or one with no email, is refused, and so is any login that isn't an email-code login (WQ101:
 * Supabase's `app_metadata.provider` must be `email`). The email is lower-cased, as every customer's is stored.
 */
export interface SignInIdentity {
  authUserId: string
  email: string
}

export type SignInVerifier = (token: string) => Promise<SignInIdentity>

const signInRefusal = (reason: SignInReason, message: string) => new ApiError('FORBIDDEN', message, { details: { reason, message } })

export function createSignInVerifier(supabaseUrl: string, supabaseAnonKey: string, fetchImpl?: typeof fetch): SignInVerifier {
  return async (token) => {
    const supabase = supabaseClient(supabaseUrl, supabaseAnonKey, fetchImpl)
    const claims = await checkedClaims(supabase, token)
    const claimed = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : ''
    if (claims.is_anonymous === true || !claimed) throw signInRefusal('no_email', SIGN_IN_WORDS.noEmail)

    const { data, error } = await supabase.auth.getUser(token)
    if (error) throw refusedToken(error, 'read the signed-in user')
    const user = data.user
    // The login itself, as Supabase holds it now: the same one, and still this email (an email change since the
    // token was issued means the token is out of date).
    if (user.id !== claims.sub || (user.email ?? '').trim().toLowerCase() !== claimed) {
      throw new ApiError('UNAUTHORISED', SESSION_ENDED, { logDetail: 'The token no longer matches its login.' })
    }
    // WQ101 (Wayne, 27 Nov): an email-code login only, until another provider is reviewed. Another provider (Google,
    // Apple) vouches for its own email, which proves nothing to us. Read from Supabase's user record: app_metadata is
    // written by Supabase only, never by the user. A login with no provider is refused as well.
    if (user.app_metadata?.provider !== 'email') {
      throw signInRefusal('email_login_only', SIGN_IN_WORDS.emailLoginOnly)
    }
    if (!user.email_confirmed_at) throw signInRefusal('email_not_confirmed', SIGN_IN_WORDS.emailNotConfirmed)
    return { authUserId: claims.sub, email: claimed }
  }
}

export function defaultSignInVerifier(): SignInVerifier {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anonKey) throw new Error('NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY is not set')
  return createSignInVerifier(url, anonKey)
}

/** The login on a sign-in route: its Bearer token, verified as above. */
export async function authenticateSignIn(headers: Headers, verify: SignInVerifier): Promise<SignInIdentity> {
  const token = bearerToken(headers)
  if (!token) throw new ApiError('UNAUTHORISED', NOT_SIGNED_IN)
  return verify(token)
}

export function defaultTokenVerifier(): TokenVerifier {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anonKey) throw new Error('NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY is not set')
  return createTokenVerifier(url, anonKey)
}

interface CustomerRow {
  id: string
  email: string
  auth_user_id: string
}

export async function authenticateCustomer(headers: Headers, db: Queryable, verify: TokenVerifier): Promise<CustomerContext> {
  const token = bearerToken(headers)
  if (!token) throw new ApiError('UNAUTHORISED', NOT_SIGNED_IN)

  const { authUserId } = await verify(token)

  // LIMIT 2: customers.auth_user_id is unique (customers_auth_user_id_key, where it is set), so a second row can't
  // exist; the check below stays as a guard: two customers on one login must never silently resolve to whichever
  // row came first. (W58, W35 audit row 41: this used to say the column "isn't unique yet".)
  const rows = await db.query<CustomerRow>('SELECT id, email, auth_user_id FROM customers WHERE auth_user_id = $1 LIMIT 2', [
    authUserId,
  ])
  const customer = rows[0]
  if (!customer) {
    throw new ApiError('CUSTOMER_NOT_LINKED', 'This sign-in is not linked to a customer yet.')
  }
  if (rows.length > 1) {
    throw new Error(`More than one customer is linked to auth user ${authUserId}`)
  }
  return { customerId: customer.id, authUserId: customer.auth_user_id, email: customer.email }
}
