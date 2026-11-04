import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Db } from '@/server/db'
import { fixtures, insert, startTestDatabase, type TestDatabase } from '@/server/rules/testing/database'
import { stepBRoutes } from '@/server/rules/testing/routes'

const KEY = 'test-staff-api-key'
const holder = vi.hoisted(() => ({ db: null as unknown }))

vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))

let t: TestDatabase
const ID = '11111111-1111-4111-8111-111111111111'

beforeAll(async () => {
  process.env.STAFF_API_KEY = KEY
  t = await startTestDatabase()
  holder.db = t.db
  const staff = (email: string, row: Record<string, unknown>) =>
    insert(t.db, 'staff', { first_name: 'A', last_name: 'B', email, role: 'staff', can_issue_refunds: false, can_manage_pricing: false, active: true, ...row })
  await staff('jo@example.com', {})
  await staff('pricing@example.com', { can_manage_pricing: true })
  await staff('gone@example.com', { active: false })
  await t.db.query('INSERT INTO postage_settings (standard_price, express_price, free_shipping_threshold) VALUES ($1, $2, $3)', ['4.95', '9.95', '75.00'])
})

afterAll(() => t.stop())

interface Call {
  query?: Record<string, string>
  body?: unknown
  email?: string
  key?: string | null
}

function call(path: string, { query, body, email = 'jo@example.com', key = KEY }: Call = {}) {
  const route = stepBRoutes[path]
  if (!route) throw new Error(`No route ${path}`)
  const url = new URL(`https://worker.test${path}`)
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v)
  return route.handler(
    new Request(url, {
      method: route.method,
      headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), 'x-staff-email': email },
      ...(route.method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
    })
  )
}

const cases: Array<{ path: string; good: Call; bad: Call; field: string | null }> = [
  {
    path: '/api/v1/staff/quotes/booking-seats',
    good: { body: { sessionId: ID, customerId: ID, partySize: 1 } },
    bad: { body: { sessionId: 'nope', customerId: ID, partySize: 1 } },
    field: 'sessionId',
  },
  {
    path: '/api/v1/staff/quotes/event',
    good: { body: { eventId: ID, customerId: ID, places: 1, accountHolderAttending: true } },
    bad: { body: { eventId: ID, customerId: ID, places: 'two', accountHolderAttending: true } },
    field: 'places',
  },
  {
    path: '/api/v1/staff/promo-codes/validate',
    good: { body: { code: 'NOPE', customerId: ID, lines: [{ key: 'a', itemType: 'booking', amount: 5, isMemberPriced: false }] } },
    bad: { body: { code: 'NOPE', customerId: ID, lines: [{ key: 'a', itemType: 'booking', amount: 'five' }] } },
    field: 'lines.0.amount',
  },
  {
    path: '/api/v1/staff/customers/credit-options',
    good: { query: { customerId: ID } },
    bad: { query: { customerId: ID, sessionId: 'nope' } },
    field: 'sessionId',
  },
  {
    path: '/api/v1/staff/sessions/available',
    good: { query: { date: '2030-01-01' } },
    bad: { query: { date: 'tomorrow' } },
    field: 'date',
  },
  {
    path: '/api/v1/staff/bookings/day-conflict',
    good: { query: { customerId: ID, sessionId: ID } },
    bad: { query: { customerId: ID } },
    field: 'sessionId',
  },
  {
    path: '/api/v1/staff/sessions/time-conflict',
    good: { query: { sessionId: ID, serviceTypeId: ID, startTime: '2030-01-01T10:00:00.000Z', endTime: '2030-01-01T11:00:00.000Z' } },
    bad: { query: { sessionId: ID, serviceTypeId: ID, startTime: 'ten', endTime: '2030-01-01T11:00:00.000Z' } },
    field: 'startTime',
  },
  { path: '/api/v1/staff/pricing/config', good: {}, bad: {}, field: null },
  { path: '/api/v1/staff/postage/settings', good: {}, bad: {}, field: null },
]

describe.each(cases)('$path', ({ path, good, bad, field }) => {
  it('answers a good request, and the output matches its contract', async () => {
    const response = await call(path, good)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true })
  })

  it.runIf(field !== null)('refuses bad input as VALIDATION, naming the field', async () => {
    const response = await call(path, bad)
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'VALIDATION', field } })
  })

  it('refuses a missing or wrong key', async () => {
    for (const key of [null, 'wrong']) {
      const response = await call(path, { ...good, key })
      expect(response.status).toBe(401)
      expect(await response.json()).toMatchObject({ error: { code: 'UNAUTHORISED' } })
    }
  })

  it('refuses an unknown email and an inactive account', async () => {
    expect((await call(path, { ...good, email: 'nobody@example.com' })).status).toBe(401)

    const inactive = await call(path, { ...good, email: 'gone@example.com' })
    expect(inactive.status).toBe(403)
    expect(await inactive.json()).toMatchObject({
      error: { code: 'FORBIDDEN', message: 'This staff account is inactive. Ask an admin to reactivate it.' },
    })
  })

})

describe('GET /api/v1/staff/pricing/config', () => {
  it('takes canManagePricing from the signed-in staff member', async () => {
    const body = async (email: string) => (await (await call('/api/v1/staff/pricing/config', { email })).json()) as { data: { canManagePricing: boolean } }

    expect((await body('pricing@example.com')).data.canManagePricing).toBe(true)
    expect((await body('jo@example.com')).data.canManagePricing).toBe(false)
  })
})

describe('the shapes through HTTP', () => {
  it('keeps money as strings and numbers exactly as the rule returned them', async () => {
    const band = await fixtures.band(t.db, { price: '20.00' })
    const type = await fixtures.serviceType(t.db)
    const session = await fixtures.session(t.db, { service_type_id: type, band_id: band })
    const customer = await fixtures.customer(t.db)

    const response = await call('/api/v1/staff/quotes/booking-seats', { body: { sessionId: session, customerId: customer, partySize: 2 } })

    expect(await response.json()).toMatchObject({
      data: { seats: [{ unit_price: '20.00', discount_percent: '0' }, { unit_price: '20.00', discount_percent: '0' }], paidTotal: 40, unpriced: false },
    })
  })
})
