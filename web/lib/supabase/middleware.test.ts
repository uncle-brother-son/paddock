import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { config, middleware } from '@/middleware'

// Next's matcher loads server code that expects this global, as Next's own server sets it before anything else.
await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import('node:async_hooks')
  Object.assign(globalThis, { AsyncLocalStorage })
})

// Brief W69 item 1: what middleware.ts does, pinned as it is (Wayne, 23 Nov 2026: it keeps its name and its matcher; see
// server/rules/README.md, "Next.js and the runtime date"). The paths are matched by Next's own matcher. The session is
// refreshed by the real Supabase client, with only `fetch` replaced: what it would send is what is recorded here.

const WEB = path.resolve(__dirname, '../..')
const SUPABASE_URL = 'https://paddock-test.supabase.co'
const COOKIE = 'sb-paddock-test-auth-token'
const USER = { id: '11111111-1111-4111-8111-111111111111', aud: 'authenticated', role: 'authenticated', email: 'sam@example.com', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' }
const AN_HOUR_AGO = Math.floor(Date.now() / 1000) - 3600
const IN_A_DAY = Math.floor(Date.now() / 1000) + 86_400

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url')
const session = (expiresAt: number, refreshToken: string) => ({
  access_token: `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: USER.id, aud: 'authenticated', exp: expiresAt })}.c2ln`,
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: expiresAt,
  refresh_token: refreshToken,
  user: USER,
})
const cookieFor = (expiresAt: number, refreshToken: string): string => `${COOKIE}=base64-${encode(session(expiresAt, refreshToken))}`

/** Every request the middleware sent, as `METHOD /path`. */
let sent: string[] = []
/** What Supabase answers a refresh. */
let refresh: () => Response = () => Response.json(session(IN_A_DAY, 'refresh-2'))

beforeEach(() => {
  sent = []
  refresh = () => Response.json(session(IN_A_DAY, 'refresh-2'))
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', SUPABASE_URL)
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon-test')
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    sent.push(`${init?.method ?? 'GET'} ${url.origin === SUPABASE_URL ? url.pathname : url.href}`)
    if (url.pathname === '/auth/v1/token') return refresh()
    if (url.pathname === '/auth/v1/user') return Response.json(USER)
    return new Response('not expected', { status: 599 })
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

const run = (pathname: string, headers: Record<string, string> = {}) => middleware(new NextRequest(`https://paddock.test${pathname}`, { headers }))

describe('the paths middleware.ts runs on (W69)', () => {
  it('its matcher is the one it has always had', () => {
    expect(config).toStrictEqual({ matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'] })
  })

  it.each([
    '/',
    '/book',
    '/account/bookings',
    '/api/stripe/webhook',
    '/api/sanity/webhook',
    // Every API route, the staff API's too: see the next describe for what it does there.
    '/api/v1/staff/whoami',
    '/api/v1/staff/orders',
    '/api/v1/customer/bookings/11111111-1111-4111-8111-111111111111/cancel',
  ])('runs on %s', (url) => {
    expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url })).toBe(true)
  })

  it.each(['/_next/static/chunks/main.js', '/_next/image?url=%2Fa.png&w=64&q=75', '/favicon.ico', '/logo.svg', '/a/b.png', '/a.jpg', '/a.jpeg', '/a.gif', '/a.webp'])('does not run on %s', (url) => {
    expect(unstable_doesMiddlewareMatch({ config, nextConfig: {}, url })).toBe(false)
  })

  // Next 16's proxy.ts runs on the Node runtime only, which OpenNext builds for Cloudflare as experimental and not
  // maintained by it (1.20.12). Until it supports it, the file keeps the name and the runtime that it does support.
  it('is middleware.ts on the Edge runtime, and there is no proxy.ts', () => {
    expect(existsSync(path.join(WEB, 'middleware.ts'))).toBe(true)
    for (const name of ['proxy.ts', 'proxy.tsx', 'proxy.js', 'proxy.mjs', 'src/proxy.ts', 'src/proxy.js']) expect(existsSync(path.join(WEB, name)), name).toBe(false)
    expect(config).not.toHaveProperty('runtime')
    expect(readFileSync(path.join(WEB, 'middleware.ts'), 'utf8')).not.toContain('runtime')
  })
})

describe('what it does (W69)', () => {
  it.each(['/api/v1/staff/orders', '/api/v1/staff/whoami', '/api/stripe/webhook', '/'])('with no Supabase cookie, on %s: no call made, no cookie set, the request passed on as it came', async (pathname) => {
    // As the staff app calls: its key and the staff member's email, and a cookie that isn't Supabase's.
    const answer = await run(pathname, { authorization: 'Bearer staff-key', 'x-staff-email': 'jo@example.com', cookie: 'other=1' })
    expect(sent).toEqual([])
    expect(answer.headers.getSetCookie()).toEqual([])
    expect(answer.status).toBe(200)
    expect(answer.headers.get('x-middleware-next')).toBe('1')
    expect(answer.headers.get('x-middleware-request-authorization')).toBe('Bearer staff-key')
    expect(answer.headers.get('x-middleware-request-x-staff-email')).toBe('jo@example.com')
    expect(answer.headers.get('x-middleware-request-cookie')).toBe('other=1')
  })

  it('with a session that has not expired: the user is read, nothing is set', async () => {
    const answer = await run('/account', { cookie: cookieFor(IN_A_DAY, 'refresh-1') })
    expect(sent).toEqual(['GET /auth/v1/user'])
    expect(answer.headers.getSetCookie()).toEqual([])
    expect(answer.headers.get('x-middleware-next')).toBe('1')
  })

  it('with an expired session: refreshed once, and the new one goes both to the browser and to the page', async () => {
    const answer = await run('/account', { cookie: `${cookieFor(AN_HOUR_AGO, 'refresh-1')}; other=1` })
    expect(sent).toEqual(['POST /auth/v1/token', 'GET /auth/v1/user'])
    const renewed = `${COOKIE}=base64-${encode(session(IN_A_DAY, 'refresh-2'))}`
    const set = answer.headers.getSetCookie()
    expect(set).toHaveLength(1)
    expect(set[0]?.startsWith(`${renewed};`)).toBe(true)
    expect(set[0]).toContain('Path=/')
    expect(set[0]).toContain('SameSite=lax')
    const passedOn = answer.headers.get('x-middleware-request-cookie') ?? ''
    expect(passedOn).toContain(renewed)
    expect(passedOn).toContain('other=1')
  })

  it('with an expired session Supabase refuses to renew: the cookie is cleared and the request goes on', async () => {
    refresh = () => Response.json({ code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token: Refresh Token Not Found' }, { status: 400 })
    const answer = await run('/account', { cookie: cookieFor(AN_HOUR_AGO, 'refresh-1') })
    expect(sent).toEqual(['POST /auth/v1/token'])
    const set = answer.headers.getSetCookie()
    expect(set).toHaveLength(1)
    expect(set[0]?.startsWith(`${COOKIE}=;`)).toBe(true)
    expect(set[0]).toContain('Max-Age=0')
    expect(answer.headers.get('x-middleware-next')).toBe('1')
  })
})
