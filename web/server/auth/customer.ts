import 'server-only'
import { createClient } from '@supabase/supabase-js'
import type { CustomerContext } from '@/contracts'
import type { Queryable } from '@/server/db'
import { ApiError } from '@/server/http/errors'
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

/** Checks a token with the given client options (tests pass their own fetch and keys). */
export function createTokenVerifier(
  supabaseUrl: string,
  supabaseAnonKey: string,
  fetchImpl?: typeof fetch
): TokenVerifier {
  return async (token) => {
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      ...(fetchImpl ? { global: { fetch: fetchImpl } } : {}),
    })
    const { data, error } = await supabase.auth.getClaims(token)
    if (error) {
      if (error.name === 'AuthRetryableFetchError' || (error.status ?? 0) >= 500) {
        // Supabase being unreachable isn't the customer's fault: don't sign them out for it.
        throw new Error(`Could not verify the access token: ${error.message}`)
      }
      const expired = /expired/i.test(error.message)
      throw new ApiError('UNAUTHORISED', expired ? SESSION_ENDED : NOT_SIGNED_IN, { logDetail: error.message })
    }
    const claims = data?.claims
    // The anon and service keys are validly signed too; only a signed-in user's token will do.
    if (!claims?.sub || claims.aud !== 'authenticated') {
      throw new ApiError('UNAUTHORISED', NOT_SIGNED_IN)
    }
    return { authUserId: claims.sub }
  }
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

  // LIMIT 2: customers.auth_user_id isn't unique yet, and two customers on one login must never
  // silently resolve to whichever row came first.
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
