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
