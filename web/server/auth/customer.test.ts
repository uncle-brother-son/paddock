import { beforeAll, describe, it, expect, vi } from 'vitest'
import type { Queryable } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import { authenticateCustomer, authenticateSignIn, createSignInVerifier, createTokenVerifier, type TokenVerifier } from './customer'

const SUPABASE_URL = 'https://test-project.supabase.co'
const KID = 'test-key-1'
const AUTH_USER = '11111111-1111-4111-8111-111111111111'

const base64url = (bytes: Uint8Array | string) =>
  Buffer.from(bytes as Uint8Array).toString('base64url')

let signingKey: CryptoKeyPair
let otherKey: CryptoKeyPair
let publicJwk: JsonWebKey

async function signToken(key: CryptoKey, claims: Record<string, unknown>, kid = KID): Promise<string> {
  const header = base64url(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid }))
  const payload = base64url(JSON.stringify(claims))
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(`${header}.${payload}`)
  )
  return `${header}.${payload}.${base64url(new Uint8Array(signature))}`
}

const inAnHour = () => Math.floor(Date.now() / 1000) + 3600

const validClaims = () => ({ sub: AUTH_USER, aud: 'authenticated', role: 'authenticated', exp: inAnHour() })

/** The real getClaims check, against a JWKS served by this fake fetch. */
function verifier(): TokenVerifier {
  const fakeFetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/.well-known/jwks.json')) {
      return Response.json({ keys: [{ ...publicJwk, kid: KID, alg: 'ES256', use: 'sig' }] })
    }
    return Response.json({ msg: 'invalid JWT', error_code: 'bad_jwt' }, { status: 403 })
  }) as typeof fetch
  return createTokenVerifier(SUPABASE_URL, 'anon-key', fakeFetch)
}

function fakeDb(rows: unknown[] = [{ id: 'customer-1', email: 'sam@example.com', auth_user_id: AUTH_USER }]) {
  return { query: vi.fn().mockResolvedValue(rows) } as unknown as Queryable & { query: ReturnType<typeof vi.fn> }
}

const bearer = (token: string) => new Headers({ authorization: `Bearer ${token}` })

async function failure(attempt: Promise<unknown>): Promise<ApiError> {
  const err = await attempt.catch((e: unknown) => e)
  expect(err).toBeInstanceOf(ApiError)
  return err as ApiError
}

beforeAll(async () => {
  const params = { name: 'ECDSA', namedCurve: 'P-256' }
  signingKey = (await crypto.subtle.generateKey(params, true, ['sign', 'verify'])) as CryptoKeyPair
  otherKey = (await crypto.subtle.generateKey(params, true, ['sign', 'verify'])) as CryptoKeyPair
  publicJwk = await crypto.subtle.exportKey('jwk', signingKey.publicKey)
})

describe('authenticateCustomer', () => {
  it('accepts a valid token and loads the linked customer', async () => {
    const token = await signToken(signingKey.privateKey, validClaims())
    const db = fakeDb()

    const customer = await authenticateCustomer(bearer(token), db, verifier())

    expect(customer).toEqual({ customerId: 'customer-1', authUserId: AUTH_USER, email: 'sam@example.com' })
    expect(db.query.mock.calls[0]?.[1]).toEqual([AUTH_USER])
  })

  it('rejects an expired token', async () => {
    const token = await signToken(signingKey.privateKey, { ...validClaims(), exp: Math.floor(Date.now() / 1000) - 60 })
    const db = fakeDb()

    const err = await failure(authenticateCustomer(bearer(token), db, verifier()))

    expect(err.code).toBe('UNAUTHORISED')
    expect(err.message).toBe('Your session has expired. Please sign in again.')
    expect(db.query).not.toHaveBeenCalled()
  })

  it('rejects a token signed with the wrong key', async () => {
    const token = await signToken(otherKey.privateKey, validClaims())
    const db = fakeDb()

    const err = await failure(authenticateCustomer(bearer(token), db, verifier()))

    expect(err.code).toBe('UNAUTHORISED')
    expect(db.query).not.toHaveBeenCalled()
  })

  it('rejects a token whose claims were changed after signing', async () => {
    const token = await signToken(signingKey.privateKey, validClaims())
    const [header, , signature] = token.split('.')
    const forged = `${header}.${base64url(JSON.stringify({ ...validClaims(), sub: 'someone-else' }))}.${signature}`

    const err = await failure(authenticateCustomer(bearer(forged), fakeDb(), verifier()))

    expect(err.code).toBe('UNAUTHORISED')
  })

  it('rejects a validly signed token that is not a signed-in user', async () => {
    const token = await signToken(signingKey.privateKey, { ...validClaims(), aud: 'anon' })

    const err = await failure(authenticateCustomer(bearer(token), fakeDb(), verifier()))

    expect(err.code).toBe('UNAUTHORISED')
  })

  it('rejects a missing token and rubbish', async () => {
    expect((await failure(authenticateCustomer(new Headers(), fakeDb(), verifier()))).code).toBe('UNAUTHORISED')
    expect((await failure(authenticateCustomer(bearer('not.a.token'), fakeDb(), verifier()))).code).toBe('UNAUTHORISED')
  })

  it('answers CUSTOMER_NOT_LINKED for a valid token with no customer row', async () => {
    const token = await signToken(signingKey.privateKey, validClaims())

    const err = await failure(authenticateCustomer(bearer(token), fakeDb([]), verifier()))

    expect(err.code).toBe('CUSTOMER_NOT_LINKED')
    expect(err.status).toBe(403)
  })

  it('refuses to pick one when two customers share a login', async () => {
    const token = await signToken(signingKey.privateKey, validClaims())
    const rows = [
      { id: 'a', email: 'a@example.com', auth_user_id: AUTH_USER },
      { id: 'b', email: 'b@example.com', auth_user_id: AUTH_USER },
    ]

    await expect(authenticateCustomer(bearer(token), fakeDb(rows), verifier())).rejects.toThrow('More than one customer')
  })
})

// W85a (backend log 9): the sign-in routes' check. The token as above, then the login as Supabase's Auth server holds
// it (GET /auth/v1/user, answered here by the fake fetch): its email must be the token's and confirmed.
describe('authenticateSignIn (W85a)', () => {
  const EMAIL = 'Sam@Example.com'
  const signInClaims = (extra: Record<string, unknown> = {}) => ({ ...validClaims(), email: EMAIL, ...extra })
  type User = Record<string, unknown>
  const confirmedUser = (extra: User = {}): User => ({ id: AUTH_USER, aud: 'authenticated', email: EMAIL, email_confirmed_at: '2026-11-27T10:00:00Z', ...extra })

  /** getClaims against the JWKS, and getUser answered with `user` (or a status). */
  function signInVerifier(user: User | { status: number; html?: true }): { verify: ReturnType<typeof createSignInVerifier>; userCalls: () => number } {
    let calls = 0
    const fakeFetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/.well-known/jwks.json')) return Response.json({ keys: [{ ...publicJwk, kid: KID, alg: 'ES256', use: 'sig' }] })
      if (url.endsWith('/auth/v1/user')) {
        calls += 1
        if ('html' in user && user.html) return new Response('<html><body>Blocked by a proxy</body></html>', { status: user.status as number, headers: { 'content-type': 'text/html' } })
        if ('status' in user && typeof user.status === 'number') return Response.json({ msg: 'down', error_code: 'unexpected_failure' }, { status: user.status })
        return Response.json(user)
      }
      return Response.json({ msg: 'not here' }, { status: 404 })
    }) as typeof fetch
    return { verify: createSignInVerifier(SUPABASE_URL, 'anon-key', fakeFetch), userCalls: () => calls }
  }
  const reasonOf = (err: ApiError) => (err.details as { reason?: string } | undefined)?.reason

  it("gives the login's id and the token's email, lower-cased, when Supabase holds that email confirmed", async () => {
    const token = await signToken(signingKey.privateKey, signInClaims())
    const { verify, userCalls } = signInVerifier(confirmedUser())
    expect(await authenticateSignIn(bearer(token), verify)).toEqual({ authUserId: AUTH_USER, email: 'sam@example.com' })
    expect(userCalls()).toBe(1)
  })

  it('an unconfirmed email is refused, even when the token says user_metadata.email_verified (the user can write that)', async () => {
    const token = await signToken(signingKey.privateKey, signInClaims({ user_metadata: { email_verified: true } }))
    const err = await failure(authenticateSignIn(bearer(token), signInVerifier(confirmedUser({ email_confirmed_at: null })).verify))
    expect([err.code, reasonOf(err), err.message]).toEqual(['FORBIDDEN', 'email_not_confirmed', 'Please confirm your email address with the code we sent you, then try again.'])
  })

  it('an anonymous login, or one with no email, is refused before Supabase is asked', async () => {
    for (const claims of [signInClaims({ is_anonymous: true }), signInClaims({ email: '' }), { ...validClaims() }]) {
      const token = await signToken(signingKey.privateKey, claims)
      const { verify, userCalls } = signInVerifier(confirmedUser())
      const err = await failure(authenticateSignIn(bearer(token), verify))
      expect([err.code, reasonOf(err)]).toEqual(['FORBIDDEN', 'no_email'])
      expect(userCalls()).toBe(0)
    }
  })

  it("the login's email changed since the token was issued, or the user is another: signed out", async () => {
    const token = await signToken(signingKey.privateKey, signInClaims())
    for (const user of [confirmedUser({ email: 'new@example.com' }), confirmedUser({ id: '22222222-2222-4222-8222-222222222222' })]) {
      const err = await failure(authenticateSignIn(bearer(token), signInVerifier(user).verify))
      expect([err.code, err.message]).toEqual(['UNAUTHORISED', 'Your session has expired. Please sign in again.'])
    }
  })

  it("a bad token is refused as the customer routes refuse it, and Supabase's user read is not reached", async () => {
    const { verify, userCalls } = signInVerifier(confirmedUser())
    expect((await failure(authenticateSignIn(new Headers(), verify))).code).toBe('UNAUTHORISED')
    expect((await failure(authenticateSignIn(bearer(await signToken(otherKey.privateKey, signInClaims())), verify))).code).toBe('UNAUTHORISED')
    expect((await failure(authenticateSignIn(bearer(await signToken(signingKey.privateKey, signInClaims({ aud: 'anon' }))), verify))).code).toBe('UNAUTHORISED')
    expect(userCalls()).toBe(0)
  })

  it('Supabase refuses the user read (the login deleted, or its session ended): signed out, never taken as a user', async () => {
    const token = await signToken(signingKey.privateKey, signInClaims())
    for (const status of [401, 403, 404]) {
      const err = await failure(authenticateSignIn(bearer(token), signInVerifier({ status }).verify))
      expect([status, err.code]).toEqual([status, 'UNAUTHORISED'])
    }
  })

  it('W85a review (a)1: too many requests (429), or an answer that is not Supabase\'s own (a proxy\'s page), is a fault, not a sign-out', async () => {
    const token = await signToken(signingKey.privateKey, signInClaims())
    for (const answer of [{ status: 429 }, { status: 403, html: true as const }, { status: 400, html: true as const }]) {
      const err = await authenticateSignIn(bearer(token), signInVerifier(answer).verify).catch((e: unknown) => e)
      expect(err, JSON.stringify(answer)).toBeInstanceOf(Error)
      expect(err, JSON.stringify(answer)).not.toBeInstanceOf(ApiError)
    }
  })

  it("W85a review (b)2: the customer routes' own check (createTokenVerifier) never asks Supabase for the user", async () => {
    const token = await signToken(signingKey.privateKey, signInClaims())
    const urls: string[] = []
    const fakeFetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input))
      return Response.json({ keys: [{ ...publicJwk, kid: KID, alg: 'ES256', use: 'sig' }] })
    }) as typeof fetch
    expect(await createTokenVerifier(SUPABASE_URL, 'anon-key', fakeFetch)(token)).toEqual({ authUserId: AUTH_USER })
    expect(urls.filter((url) => url.endsWith('/auth/v1/user'))).toEqual([])
  })

  it("Supabase unreachable for the user read is a fault, not a sign-out", async () => {
    const token = await signToken(signingKey.privateKey, signInClaims())
    const err = await authenticateSignIn(bearer(token), signInVerifier({ status: 503 }).verify).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(ApiError)
  })
})
