import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { ApiError } from './errors'
import { hashRequest, stableStringify, stripeIdempotencyKey } from './idempotency'
import { fakeDb, staffRequest, testRouteFactory } from './test-helpers'

const KEY = '11111111-2222-4333-8444-555555555555'
const input = z.object({ amount: z.number() })
const output = z.object({ runs: z.number() })

function chargeRoute(db: ReturnType<typeof fakeDb>['db']) {
  const handler = vi.fn(async () => ({ runs: handler.mock.calls.length }))
  const { defineRoute, logs } = testRouteFactory(db)
  const route = defineRoute({ auth: 'staff', input, output, idempotent: true }, handler)
  return { route, handler, logs }
}

const post = (body: unknown, key: string | null = KEY) =>
  staffRequest('/api/v1/staff/charge', {
    method: 'POST',
    body,
    headers: key ? { 'idempotency-key': key } : {},
  })

describe('idempotent routes', () => {
  it('first call: claims the key, runs the handler, stores the response', async () => {
    const fake = fakeDb()
    const { route, handler } = chargeRoute(fake.db)

    const response = await route(post({ amount: 10 }))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toMatchObject({ ok: true, data: { runs: 1 } })
    expect(handler).toHaveBeenCalledTimes(1)
    const [row] = [...fake.idempotency.values()]
    expect(row).toMatchObject({ status: 'done', http_status: 200, response: body })
    expect(fake.query.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO api_idempotency'))?.[1]?.slice(0, 4)).toEqual([
      'staff',
      'staff-1',
      'POST /api/v1/staff/charge',
      KEY,
    ])
  })

  it('same key, same body: returns the stored response without running again', async () => {
    const fake = fakeDb()
    const { route, handler } = chargeRoute(fake.db)

    const first = await (await route(post({ amount: 10 }))).json()
    const second = await route(post({ amount: 10 }))

    expect(handler).toHaveBeenCalledTimes(1)
    expect(await second.json()).toEqual(first)
    expect(second.headers.get('idempotency-replayed')).toBe('true')
  })

  it('same key, same body in a different key order: still the same request', async () => {
    const fake = fakeDb()
    const { defineRoute } = testRouteFactory(fake.db)
    const handler = vi.fn(async () => ({ runs: 1 }))
    const route = defineRoute(
      { auth: 'staff', input: z.object({ a: z.number(), b: z.number() }), output, idempotent: true },
      handler
    )

    await route(post({ a: 1, b: 2 }))
    await route(post({ b: 2, a: 1 }))

    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('same key while still in progress: CONFLICT, and the handler runs only once', async () => {
    const fake = fakeDb()
    let finish: () => void = () => {}
    const handler = vi.fn(
      () =>
        new Promise<{ runs: number }>((resolve) => {
          finish = () => resolve({ runs: 1 })
        })
    )
    const { defineRoute } = testRouteFactory(fake.db)
    const route = defineRoute({ auth: 'staff', input, output, idempotent: true }, handler)

    const first = route(post({ amount: 10 }))
    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1))

    const second = await route(post({ amount: 10 }))

    expect(second.status).toBe(409)
    expect(await second.json()).toMatchObject({
      error: { code: 'CONFLICT', message: 'This request is already being processed' },
    })
    finish()
    expect((await first).status).toBe(200)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('same key, different body: IDEMPOTENCY_MISMATCH, done or in progress', async () => {
    const fake = fakeDb()
    const { route, handler } = chargeRoute(fake.db)

    await route(post({ amount: 10 }))
    const response = await route(post({ amount: 20 }))

    expect(response.status).toBe(422)
    expect(await response.json()).toMatchObject({ error: { code: 'IDEMPOTENCY_MISMATCH' } })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('the key is required, and must look like one', async () => {
    const fake = fakeDb()
    const { route, handler } = chargeRoute(fake.db)

    for (const key of [null, 'short', 'has spaces in the key!']) {
      const response = await route(post({ amount: 10 }, key))
      expect(response.status).toBe(400)
      expect(await response.json()).toMatchObject({ error: { code: 'VALIDATION', field: 'Idempotency-Key' } })
    }
    expect(handler).not.toHaveBeenCalled()
    expect(fake.idempotency.size).toBe(0)
  })

  it('invalid input claims no key, so the corrected request can use it', async () => {
    const fake = fakeDb()
    const { route, handler } = chargeRoute(fake.db)

    expect((await route(post({ amount: 'ten' }))).status).toBe(400)
    expect(fake.idempotency.size).toBe(0)

    expect((await route(post({ amount: 10 }))).status).toBe(200)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('a failed handler stores its error: a retry gets the same failure and does not run again', async () => {
    const fake = fakeDb()
    const handler = vi.fn(async (): Promise<{ runs: number }> => {
      throw new ApiError('PAYMENT_FAILED', 'Your card was declined.')
    })
    const { defineRoute } = testRouteFactory(fake.db)
    const route = defineRoute({ auth: 'staff', input, output, idempotent: true }, handler)

    const first = await route(post({ amount: 10 }))
    const firstBody = await first.json()
    const retry = await route(post({ amount: 10 }))

    expect(first.status).toBe(402)
    expect(retry.status).toBe(402)
    expect(await retry.json()).toEqual(firstBody)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('a key is scoped to the endpoint and the actor', async () => {
    const fake = fakeDb()
    const { route, handler } = chargeRoute(fake.db)

    await route(post({ amount: 10 }))
    await route(
      staffRequest('/api/v1/staff/other', { method: 'POST', body: { amount: 10 }, headers: { 'idempotency-key': KEY } })
    )

    expect(handler).toHaveBeenCalledTimes(2)
    expect(fake.idempotency.size).toBe(2)
  })

  it('reports success when storing the response fails, and a retry gets CONFLICT rather than a second run', async () => {
    const fake = fakeDb({ failIdempotencyUpdate: true })
    const { route, handler, logs } = chargeRoute(fake.db)

    const first = await route(post({ amount: 10 }))
    const retry = await route(post({ amount: 10 }))

    expect(first.status).toBe(200)
    expect(logs[0]?.errorDetail).toContain('Could not store the idempotent response')
    expect(retry.status).toBe(409)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it("keeps the handler's own error in the log when storing its failure also fails", async () => {
    const fake = fakeDb({ failIdempotencyUpdate: true })
    const { defineRoute, logs } = testRouteFactory(fake.db)
    const route = defineRoute({ auth: 'staff', input, output, idempotent: true }, async () => {
      throw new Error('the real cause')
    })

    await route(post({ amount: 10 }))

    expect(logs[0]?.errorDetail).toContain('the real cause')
    expect(logs[0]?.errorDetail).toContain('Could not store the idempotent response')
  })

  it('passes the key to the handler for Stripe calls', async () => {
    const fake = fakeDb()
    const { defineRoute } = testRouteFactory(fake.db)
    const seen = vi.fn()
    const route = defineRoute({ auth: 'staff', input, output, idempotent: true }, async ({ idempotencyKey }) => {
      seen(idempotencyKey)
      return { runs: 1 }
    })

    await route(post({ amount: 10 }))

    expect(seen).toHaveBeenCalledWith(KEY)
  })
})

describe('stableStringify and hashRequest', () => {
  it('ignores key order at every level, and not array order', async () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: [{ f: 3, e: 4 }] } })).toBe('{"a":{"c":[{"e":4,"f":3}],"d":2},"b":1}')
    expect(await hashRequest({ a: 1, b: 2 })).toBe(await hashRequest({ b: 2, a: 1 }))
    expect(await hashRequest([1, 2])).not.toBe(await hashRequest([2, 1]))
  })

  it('gives a sha-256 hex digest that changes with the content', async () => {
    expect(await hashRequest({ a: 1 })).toMatch(/^[0-9a-f]{64}$/)
    expect(await hashRequest({ a: 1 })).not.toBe(await hashRequest({ a: 2 }))
  })
})

describe('stripeIdempotencyKey', () => {
  it('is stable for a record and step, and unique per step', () => {
    expect(stripeIdempotencyKey(KEY, 'charge')).toBe(stripeIdempotencyKey(KEY, 'charge'))
    expect(stripeIdempotencyKey(KEY, 'charge')).not.toBe(stripeIdempotencyKey(KEY, 'refund'))
    expect(stripeIdempotencyKey(KEY, 'charge')).not.toBe(stripeIdempotencyKey('another-record-id', 'charge'))
  })

  it("stays within Stripe's 255 characters for the longest key", () => {
    expect(stripeIdempotencyKey('k'.repeat(128), 's'.repeat(64)).length).toBeLessThanOrEqual(255)
  })

  it('refuses a step that could collide with another', () => {
    expect(() => stripeIdempotencyKey(KEY, '')).toThrow()
    expect(() => stripeIdempotencyKey(KEY, 'a:b')).toThrow()
  })
})
