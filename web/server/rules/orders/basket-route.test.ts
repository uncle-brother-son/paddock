import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { basketQuoteOutputSchema } from '@/contracts'
import { POST } from '@/app/api/v1/staff/quotes/basket/route'
import type { Db } from '@/server/db'
import { insert, startTestDatabase, type TestDatabase } from '@/server/rules/testing/database'

const KEY = 'test-staff-api-key'
const ID = '11111111-1111-4111-8111-111111111111'
const holder = vi.hoisted(() => ({ db: null as unknown }))

vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))

let t: TestDatabase
let towel: string

beforeAll(async () => {
  process.env.STAFF_API_KEY = KEY
  t = await startTestDatabase({ schema: 'live' })
  holder.db = t.db
  const staff = (email: string, row: Record<string, unknown>) =>
    insert(t.db, 'staff', { first_name: 'A', last_name: 'B', email, role: 'staff', can_issue_refunds: false, can_manage_pricing: false, active: true, ...row })
  await staff('jo@example.com', {})
  await staff('pricing@example.com', { can_manage_pricing: true })
  await staff('gone@example.com', { active: false })
  towel = await insert(t.db, 'addons', { name: 'Towel', sku: 'TOWEL', base_price: '5.00' })
})

afterAll(() => t.stop())

function call(body: unknown, { email = 'jo@example.com', key = KEY as string | null } = {}) {
  return POST(
    new Request('https://worker.test/api/v1/staff/quotes/basket', {
      method: 'POST',
      headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), 'x-staff-email': email },
      body: JSON.stringify(body),
    })
  )
}

const basket = () => ({ standaloneAddons: [{ addonId: towel, quantity: 1 }] })

describe('POST /api/v1/staff/quotes/basket', () => {
  it('answers a good request, and the output matches its contract', async () => {
    const response = await call(basket())
    const body = (await response.json()) as { ok: boolean; data: unknown }
    expect(response.status).toBe(200)
    expect(basketQuoteOutputSchema.safeParse(body.data).success).toBe(true)
    expect(body).toMatchObject({ ok: true, data: { totals: { amountDue: 5 }, problems: [] } })
  })

  it('answers a refused basket as data, not an error', async () => {
    const response = await call({ standaloneAddons: [{ addonId: ID, quantity: 1 }] })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ data: { problems: [{ reason: 'addon_not_found' }] } })
  })

  it('leaves a loose field to the rule, so it gets the old reason', async () => {
    const response = await call({ standaloneAddons: [{ addonId: towel, quantity: 1.5 }], payment: { method: 'cheque' } })
    expect(await response.json()).toMatchObject({ data: { problems: [{ reason: 'invalid_addon_quantity' }, { reason: 'invalid_payment_method' }] } })
  })

  it('refuses bad input as VALIDATION, naming the field', async () => {
    const response = await call({ products: [{ productVariantId: 'nope', quantity: 1 }] })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'VALIDATION', field: 'products.0.productVariantId' } })
  })

  it('refuses a missing or wrong key', async () => {
    for (const key of [null, 'wrong']) {
      const response = await call(basket(), { key })
      expect(response.status).toBe(401)
    }
  })

  it('refuses an unknown email and an inactive account', async () => {
    expect((await call(basket(), { email: 'nobody@example.com' })).status).toBe(401)
    expect((await call(basket(), { email: 'gone@example.com' })).status).toBe(403)
  })

  describe('a sent price', () => {
    const sent = () => ({ standaloneAddons: [{ addonId: towel, quantity: 1, unitPrice: 1, priceOverrideReason: 'Regular' }] })
    const due = async (email: string, body: unknown) => {
      const answer = (await (await call(body, { email })).json()) as { data: { totals: { amountDue: number }; problems: unknown[] } }
      return { due: answer.data.totals.amountDue, problems: answer.data.problems }
    }

    it('stands with Manage pricing', async () => {
      expect(await due('pricing@example.com', sent())).toEqual({ due: 1, problems: [] })
    })

    it('is ignored without it, silently', async () => {
      expect(await due('jo@example.com', sent())).toEqual({ due: 5, problems: [] })
    })

    it('needs a reason with Manage pricing', async () => {
      const unexplained = { standaloneAddons: [{ addonId: towel, quantity: 1, unitPrice: 1 }] }
      expect((await due('pricing@example.com', unexplained)).problems).toMatchObject([{ reason: 'price_override_reason_required' }])
    })
  })

  it('takes a quote for no customer, for a guest', async () => {
    const body = (await (await call(basket())).json()) as { data: { problems: unknown[] } }
    expect(body.data.problems).toEqual([])
  })

  it('costs one read for the staff member and one for the whole basket', async () => {
    const counted = vi.spyOn(t.db, 'query')
    await call(basket())
    expect(counted).toHaveBeenCalledTimes(2)
    counted.mockRestore()
  })

  it('writes nothing', async () => {
    const tables = 'SELECT (SELECT count(*) FROM api_idempotency) AS keys, (SELECT count(*) FROM audit_log) AS audit'
    const before = await t.db.query(tables)
    await call(basket())
    expect(await t.db.query(tables)).toEqual(before)
  })
})
