import { beforeAll, describe, it, expect, vi } from 'vitest'
import type { Queryable } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import { authenticateCustomer, createTokenVerifier, type TokenVerifier } from './customer'

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
