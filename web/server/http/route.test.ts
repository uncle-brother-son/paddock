import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { ApiError, INTERNAL_MESSAGE } from './errors'
import { fakeDb, staffRequest, staffRow, testRouteFactory } from './test-helpers'

const output = z.object({ value: z.string() })
const noInput = z.object({})

describe('defineRoute: success', () => {
  it('answers in the standard envelope with the request id, and hands the handler the staff member', async () => {
    const { db } = fakeDb()
    const { defineRoute } = testRouteFactory(db)
    const route = defineRoute({ auth: 'staff', input: noInput, output }, async ({ staff }) => ({ value: staff.email }))

    const response = await route(staffRequest('/api/v1/staff/x', { headers: { 'x-request-id': 'req-12345678' } }))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, data: { value: 'jo@example.com' }, requestId: 'req-12345678' })
    expect(response.headers.get('x-request-id')).toBe('req-12345678')
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('makes a request id when the caller sends none, or a bad one', async () => {
    const { db } = fakeDb()
    const { defineRoute } = testRouteFactory(db)
    const route = defineRoute({ auth: 'staff', input: noInput, output }, async () => ({ value: 'x' }))

    const none = (await (await route(staffRequest('/x'))).json()) as { requestId: string }
    expect(none.requestId).toMatch(/^[0-9a-f-]{36}$/)

    const bad = await route(staffRequest('/x', { headers: { 'x-request-id': 'has spaces and "quotes"' } }))
    expect(((await bad.json()) as { requestId: string }).requestId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('reads input from the query string, the body and the path, with the path winning', async () => {
    const { db } = fakeDb()
    const { defineRoute } = testRouteFactory(db)
    const input = z.object({ id: z.string(), tag: z.array(z.string()), note: z.string() })
    const route = defineRoute(
      { auth: 'staff', input, output: z.object({ seen: input }) },
      async ({ input: seen }) => ({ seen })
    )

    const response = await route(
      staffRequest('/x?tag=a&tag=b', { method: 'POST', body: { id: 'from-body', note: 'hello' } }),
      { params: Promise.resolve({ id: 'from-path' }) }
    )

    expect(await response.json()).toMatchObject({ data: { seen: { id: 'from-path', tag: ['a', 'b'], note: 'hello' } } })
  })

  it('closes the database and writes one log line', async () => {
    const { db } = fakeDb()
    const { defineRoute, logs, closeDb } = testRouteFactory(db)
    const route = defineRoute({ auth: 'staff', input: noInput, output }, async () => ({ value: 'x' }))

    await route(staffRequest('/api/v1/staff/x?secret=1', { headers: { 'x-request-id': 'req-12345678' } }))

    expect(closeDb).toHaveBeenCalledWith(db)
    expect(logs).toEqual([
      {
        event: 'api_request',
        requestId: 'req-12345678',
        route: '/api/v1/staff/x',
        method: 'GET',
        actor: 'staff:staff-1',
        status: 200,
        durationMs: 0,
        errorCode: null,
      },
    ])
  })

  it('runs public routes with no credentials', async () => {
    const { db } = fakeDb()
    const { defineRoute, logs } = testRouteFactory(db)
    const route = defineRoute({ auth: 'public', input: noInput, output }, async () => ({ value: 'open' }))

    const response = await route(new Request('https://worker.test/api/v1/public/x'))

    expect(response.status).toBe(200)
    expect(logs[0]?.actor).toBe('public')
  })

  it('hands customer routes the customer', async () => {
    const { db, query } = fakeDb()
    query.mockResolvedValueOnce([{ id: 'customer-1', email: 'sam@example.com', auth_user_id: 'auth-1' }])
    const { defineRoute, logs } = testRouteFactory(db)
    const route = defineRoute({ auth: 'customer', input: noInput, output }, async ({ customer }) => ({
      value: customer.customerId,
    }))

    const response = await route(
      new Request('https://worker.test/api/v1/customer/x', { headers: { authorization: 'Bearer a-token' } })
    )

    expect(await response.json()).toMatchObject({ data: { value: 'customer-1' } })
    expect(logs[0]?.actor).toBe('customer:customer-1')
  })
})

describe('defineRoute: refusals', () => {
  it('stops at authentication, before the handler runs', async () => {
    const { db } = fakeDb()
    const { defineRoute, logs } = testRouteFactory(db)
    const handler = vi.fn()
    const route = defineRoute({ auth: 'staff', input: noInput, output }, handler)

    const response = await route(staffRequest('/x', { headers: { authorization: 'Bearer wrong' } }))

    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'UNAUTHORISED' } })
    expect(handler).not.toHaveBeenCalled()
    expect(logs[0]).toMatchObject({ actor: null, status: 401, errorCode: 'UNAUTHORISED' })
  })

  it('checks each permission before the input is looked at', async () => {
    const { db } = fakeDb({ staff: [{ ...staffRow, can_issue_refunds: false }] })
    const { defineRoute } = testRouteFactory(db)
    const handler = vi.fn()
    const input = z.object({ required: z.string() })

    for (const [permission, message] of [
      ['admin', 'Admins only — this action requires the admin role.'],
      ['issueRefunds', 'Needs Issue refunds permission — this action moves money back to the customer.'],
      ['managePricing', 'You do not have permission to manage pricing (staff.can_manage_pricing is off for your account).'],
    ] as const) {
      const route = defineRoute({ auth: 'staff', permission, input, output }, handler)
      const response = await route(staffRequest('/x', { method: 'POST', body: {} }))
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ error: { code: 'FORBIDDEN', message } })
    }
    expect(handler).not.toHaveBeenCalled()
  })

  it('lets staff with the permission through', async () => {
    const { db } = fakeDb()
    const { defineRoute } = testRouteFactory(db)
    const route = defineRoute({ auth: 'staff', permission: 'issueRefunds', input: noInput, output }, async () => ({ value: 'x' }))

    expect((await route(staffRequest('/x'))).status).toBe(200)
  })

  it('turns a zod failure into VALIDATION with the field path', async () => {
    const { db } = fakeDb()
    const { defineRoute } = testRouteFactory(db)
    const input = z.object({ guests: z.array(z.object({ email: z.email() })) })
    const route = defineRoute({ auth: 'staff', input, output }, vi.fn())

    const response = await route(staffRequest('/x', { method: 'POST', body: { guests: [{ email: 'nope' }] } }))

    expect(response.status).toBe(400)
    const body = (await response.json()) as { error: { code: string; field: string; message: string } }
    expect(body.error.code).toBe('VALIDATION')
    expect(body.error.field).toBe('guests.0.email')
    expect(body.error.message).toContain('guests.0.email')
  })

  it('rejects a body that is not JSON, or not an object', async () => {
    const { db } = fakeDb()
    const { defineRoute } = testRouteFactory(db)
    const route = defineRoute({ auth: 'staff', input: noInput, output }, vi.fn())

    const notJson = new Request('https://worker.test/x', {
      method: 'POST',
      headers: staffRequest('/x').headers,
      body: '{oops',
    })
    expect(await (await route(notJson)).json()).toMatchObject({ error: { code: 'VALIDATION' } })

    const list = await route(staffRequest('/x', { method: 'POST', body: [1, 2] }))
    expect(await list.json()).toMatchObject({ error: { code: 'VALIDATION', message: 'The request body must be a JSON object.' } })
  })
})

describe('defineRoute: errors', () => {
  it('passes an ApiError through with its status and extra fields', async () => {
    const { db } = fakeDb()
    const { defineRoute, logs } = testRouteFactory(db)
    const route = defineRoute({ auth: 'staff', input: noInput, output }, async () => {
      throw new ApiError('SESSION_FULL', 'That session is now full.', { item: 'line-1', details: { spacesLeft: 0 } })
    })

    const response = await route(staffRequest('/x'))

    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: 'SESSION_FULL', message: 'That session is now full.', item: 'line-1', details: { spacesLeft: 0 } },
    })
    expect(logs[0]?.errorCode).toBe('SESSION_FULL')
  })

  it('hides an unknown throw from the caller and keeps the redacted detail for the log', async () => {
    const { db } = fakeDb()
    const { defineRoute, logs } = testRouteFactory(db)
    const route = defineRoute({ auth: 'staff', input: noInput, output }, async () => {
      throw new Error('relation "secret_table" failed for sam@example.com')
    })

    const response = await route(staffRequest('/x'))
    const text = await response.text()

    expect(response.status).toBe(500)
    expect(JSON.parse(text)).toMatchObject({ error: { code: 'INTERNAL', message: INTERNAL_MESSAGE } })
    expect(text).not.toContain('secret_table')
    expect(logs[0]?.errorDetail).toContain('secret_table')
    expect(logs[0]?.errorDetail).not.toContain('sam@example.com')
  })

  it('fails as INTERNAL when the handler output breaks its contract outside production', async () => {
    const { db } = fakeDb()
    const { defineRoute } = testRouteFactory(db)
    const route = defineRoute({ auth: 'staff', input: noInput, output }, async () => ({ value: 1 }) as unknown as { value: string })

    expect((await route(staffRequest('/x'))).status).toBe(500)
  })

  it('skips the output check in production', async () => {
    const { db } = fakeDb()
    const { defineRoute } = testRouteFactory(db, { validateOutput: false })
    const route = defineRoute({ auth: 'staff', input: noInput, output }, async () => ({ value: 1 }) as unknown as { value: string })

    expect((await route(staffRequest('/x'))).status).toBe(200)
  })

  it('answers INTERNAL when the database cannot even be opened', async () => {
    const { db } = fakeDb()
    const { defineRoute, closeDb } = testRouteFactory(db, {
      openDb: () => {
        throw new Error('no binding')
      },
    })
    const route = defineRoute({ auth: 'public', input: noInput, output }, vi.fn())

    expect((await route(new Request('https://worker.test/x'))).status).toBe(500)
    expect(closeDb).not.toHaveBeenCalled()
  })

  it('still answers when closing the database fails', async () => {
    const { db } = fakeDb()
    const { defineRoute } = testRouteFactory(db, {
      closeDb: () => {
        throw new Error('close failed')
      },
    })
    const route = defineRoute({ auth: 'staff', input: noInput, output }, async () => ({ value: 'x' }))

    expect((await route(staffRequest('/x'))).status).toBe(200)
  })
})

// W49 (lead call L10; W48 "Noticed" 4): the one mode that asks for no staff row, for `GET staff/me`.
describe("defineRoute: the 'customer_sign_in' mode (W85a)", () => {
  it('hands the handler the login (its id and email, from the verifier) and reads nothing itself; the log names the login', async () => {
    const { db, query } = fakeDb()
    const { defineRoute, logs } = testRouteFactory(db, { signInVerifier: () => async (token) => ({ authUserId: `login-${token}`, email: 'sam@example.com' }) })
    const seen: unknown[] = []
    const route = defineRoute({ auth: 'customer_sign_in', input: noInput, output }, async (context) => {
      seen.push(Object.keys(context).sort())
      return { value: `${context.login.authUserId} ${context.login.email}` }
    })
    const response = await route(new Request('https://worker.test/api/v1/customer/sign-in/link', { method: 'POST', headers: { authorization: 'Bearer t1' }, body: JSON.stringify({ email: 'body@example.com' }) }))
    expect(await response.json()).toMatchObject({ ok: true, data: { value: 'login-t1 sam@example.com' } })
    expect(seen).toEqual([['db', 'idempotencyKey', 'input', 'login', 'request', 'requestId', 'startedAt']])
    expect(query).not.toHaveBeenCalled()
    expect(logs[0]).toMatchObject({ actor: 'login:login-t1', status: 200 })
  })

  it('no token is refused before the handler runs; a route of this mode can never be idempotent', async () => {
    const { db } = fakeDb()
    const { defineRoute } = testRouteFactory(db)
    const handler = vi.fn()
    const route = defineRoute({ auth: 'customer_sign_in', input: noInput, output }, handler)
    expect((await route(new Request('https://worker.test/x', { method: 'POST' }))).status).toBe(401)
    expect(handler).not.toHaveBeenCalled()
    const define = defineRoute as unknown as (config: Record<string, unknown>, handler: unknown) => unknown
    expect(() => define({ auth: 'customer_sign_in', idempotent: true, input: noInput, output }, handler)).toThrow("A 'customer_sign_in' route can't be idempotent")
  })
})

describe("defineRoute: the 'staff_sign_in' mode", () => {
  it('hands the handler the signed-in email and nothing else, whether the email has an active row, an inactive one or none: it never reads the staff table', async () => {
    for (const staff of [[staffRow], [{ ...staffRow, active: false }], []]) {
      const { db, query } = fakeDb({ staff })
      const { defineRoute, logs } = testRouteFactory(db)
      const seen: unknown[] = []
      const route = defineRoute({ auth: 'staff_sign_in', method: 'GET', input: noInput, output }, async (context) => {
        seen.push(Object.keys(context).sort())
        return { value: context.signIn.email }
      })

      const response = await route(staffRequest('/api/v1/staff/staff/me', { headers: { 'x-staff-email': '  Jo@Example.com ' } }))

      expect(response.status).toBe(200)
      // The email as sent, trimmed: the rule matches it to a row.
      expect(await response.json()).toMatchObject({ ok: true, data: { value: 'Jo@Example.com' } })
      expect(seen).toEqual([['db', 'idempotencyKey', 'input', 'request', 'requestId', 'signIn', 'startedAt']])
      expect(query).not.toHaveBeenCalled()
      // The log names no one: there may be no staff row to name.
      expect(logs[0]).toMatchObject({ actor: 'staff_sign_in', status: 200 })
    }
  })

  it('is still behind the shared key and the email: a wrong key, no key and no email are refused before the handler runs', async () => {
    const { db } = fakeDb()
    const { defineRoute } = testRouteFactory(db)
    const handler = vi.fn()
    const route = defineRoute({ auth: 'staff_sign_in', method: 'GET', input: noInput, output }, handler)

    const refusedHeaders: Array<Record<string, string>> = [{ authorization: 'Bearer wrong' }, { authorization: '' }, { 'x-staff-email': '' }, { 'x-staff-email': '   ' }]
    for (const headers of refusedHeaders) {
      const response = await route(staffRequest('/x', { headers }))
      expect(response.status).toBe(401)
      expect(await response.json()).toMatchObject({ ok: false, error: { code: 'UNAUTHORISED' } })
    }
    const { defineRoute: unset } = testRouteFactory(db, { staffApiKey: () => undefined })
    expect((await unset({ auth: 'staff_sign_in', method: 'GET', input: noInput, output }, handler)(staffRequest('/x'))).status).toBe(401)
    expect(handler).not.toHaveBeenCalled()
  })

  // W54a (W49 + W54 review F3): the type stopped such a route being idempotent, but not being a plain POST, which
  // would run for an inactive member. Now it is refused when the route is defined, and again when it is called.
  it('can only be a read: a config that does not say GET, or that is idempotent, is thrown when the route is defined, before any request', () => {
    const { defineRoute } = testRouteFactory(fakeDb().db)
    const handler = vi.fn()
    const words = "A 'staff_sign_in' route answers an inactive or unknown sign-in, so it can only be a read"
    // What the type refuses, sent past it as a later route copied from `staff/me` might be.
    const define = defineRoute as unknown as (config: Record<string, unknown>, handler: unknown) => unknown
    expect(() => define({ auth: 'staff_sign_in', input: noInput, output }, handler)).toThrow(words)
    expect(() => define({ auth: 'staff_sign_in', method: 'POST', input: noInput, output }, handler)).toThrow(words)
    expect(() => define({ auth: 'staff_sign_in', method: 'get', input: noInput, output }, handler)).toThrow(words)
    expect(() => define({ auth: 'staff_sign_in', method: 'GET', idempotent: true, input: noInput, output }, handler)).toThrow(words)
    // The one right config, and every other mode, are defined as before.
    expect(() => define({ auth: 'staff_sign_in', method: 'GET', input: noInput, output }, handler)).not.toThrow()
    for (const auth of ['staff', 'customer', 'public']) expect(() => define({ auth, input: noInput, output, idempotent: true }, handler)).not.toThrow()
    expect(handler).not.toHaveBeenCalled()
  })

  it('refuses a request that is not a GET before the handler runs, whatever verb the route was exported under, and whoever the sign-in is', async () => {
    for (const staff of [[staffRow], [{ ...staffRow, active: false }], []]) {
      const { db, query } = fakeDb({ staff })
      const { defineRoute, logs } = testRouteFactory(db)
      const handler = vi.fn(async () => ({ value: 'ran' }))
      const route = defineRoute({ auth: 'staff_sign_in', method: 'GET', input: noInput, output }, handler)
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const response = await route(staffRequest('/api/v1/staff/staff/me', { method, body: {}, headers: { 'idempotency-key': crypto.randomUUID() } }))
        expect(response.status, method).toBe(403)
        expect(await response.json(), method).toMatchObject({ ok: false, error: { code: 'FORBIDDEN', message: 'This route only reads: it answers a GET and nothing else.' } })
      }
      expect(handler).not.toHaveBeenCalled()
      expect(query).not.toHaveBeenCalled()
      expect(logs.every((entry) => entry.status === 403 && entry.actor === 'staff_sign_in')).toBe(true)
      // The same route still answers a GET.
      expect((await route(staffRequest('/api/v1/staff/staff/me'))).status).toBe(200)
    }
  })

  it("the mode has one user in the whole Worker: `staff/me`'s GET", async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const path = await import('node:path')
    const appDir = path.resolve(__dirname, '../../app')
    const routeFiles = (readdirSync(appDir, { recursive: true }) as string[]).filter((file) => /(^|[\\/])route\.ts$/.test(file))
    expect(routeFiles.length).toBeGreaterThan(50)
    const users = routeFiles.filter((file) => readFileSync(path.join(appDir, file), 'utf8').includes("'staff_sign_in'"))
    expect(users.map((file) => file.split(path.sep).join('/'))).toEqual(['api/v1/staff/staff/me/route.ts'])
    const source = readFileSync(path.join(appDir, users[0] as string), 'utf8')
    // Exported as GET, and as nothing else.
    expect(source.match(/^export const (\w+) = defineRoute\(/gm)).toEqual(['export const GET = defineRoute('])
    expect(source).toContain("auth: 'staff_sign_in', method: 'GET'")
  })

  it("the 'staff' mode is unchanged by it: an inactive account and a sign-in with no staff row are still refused", async () => {
    const handler = vi.fn()
    const inactive = testRouteFactory(fakeDb({ staff: [{ ...staffRow, active: false }] }).db).defineRoute({ auth: 'staff', input: noInput, output }, handler)
    expect((await inactive(staffRequest('/x'))).status).toBe(403)
    const unknown = testRouteFactory(fakeDb({ staff: [] }).db).defineRoute({ auth: 'staff', input: noInput, output }, handler)
    expect((await unknown(staffRequest('/x'))).status).toBe(401)
    expect(handler).not.toHaveBeenCalled()
  })
})
