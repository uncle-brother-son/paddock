import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { paymentIntentRefundsOutputSchema } from '@/contracts'
import type { Db } from '@/server/db'
import { insert, startTestDatabase, type TestDatabase } from '@/server/rules/testing/database'
import { FakeStripe } from '@/server/stripe/fake'
import { listPaymentIntentRefunds, REFUND_KEY_METADATA } from './payment-intent-refunds'

// W05k: a card refund with no clear answer older than 23 hours is settled by finding its key on the
// PaymentIntent's refunds, because Stripe may have forgotten the key and a resend could pay twice.

const KEY = 'test-staff-api-key'
const holder = vi.hoisted(() => ({ db: null as unknown, stripe: null as unknown, limits: [] as unknown[] }))

vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))
vi.mock('@/server/stripe/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/stripe/client')>()),
  createStripeClient: (_key: string | undefined, limits?: unknown) => {
    holder.limits.push(limits)
    return holder.stripe
  },
}))

const { GET } = await import('@/app/api/v1/staff/payments/refunds/route')
const { READ_STRIPE_LIMITS } = await import('@/server/stripe/client')

const charge = { amount: 4000, currency: 'gbp', customer: 'cus_1', payment_method: 'pm_1', confirm: true }

let t: TestDatabase
let stripe: FakeStripe

beforeAll(async () => {
  process.env.STAFF_API_KEY = KEY
  t = await startTestDatabase({ schema: 'live' })
  holder.db = t.db
  const staff = (email: string, row: Record<string, unknown>) =>
    insert(t.db, 'staff', { first_name: 'A', last_name: 'B', email, role: 'staff', can_issue_refunds: false, can_manage_pricing: false, active: true, ...row })
  await staff('jo@example.com', {})
  await staff('gone@example.com', { active: false })
})
afterAll(() => t.stop())

beforeEach(() => {
  stripe = new FakeStripe()
  stripe.addCustomer('cus_1')
  holder.stripe = stripe
})

describe('listPaymentIntentRefunds', () => {
  it('gives each refund with the key it was sent with, newest first, in pounds', async () => {
    const paid = await stripe.paymentIntents.create(charge)
    await stripe.refunds.create({ payment_intent: paid.id, amount: 1000, metadata: { [REFUND_KEY_METADATA]: 'event-refund:a' } })
    await stripe.refunds.create({ payment_intent: paid.id, amount: 550 })
    const { refunds } = await listPaymentIntentRefunds(stripe, paid.id)
    expect(refunds.map((r) => [r.amount, r.key, r.status])).toEqual([
      [5.5, null, 'succeeded'],
      [10, 'event-refund:a', 'succeeded'],
    ])
  })

  it('reads every page', async () => {
    const paid = await stripe.paymentIntents.create(charge)
    for (let i = 0; i < 105; i++) await stripe.refunds.create({ payment_intent: paid.id, amount: 10, metadata: { [REFUND_KEY_METADATA]: `k${i}` } })
    const { refunds } = await listPaymentIntentRefunds(stripe, paid.id)
    expect(refunds).toHaveLength(105)
    expect(refunds.at(-1)?.key).toBe('k0')
    expect(stripe.calls.filter((c) => c.method === 'refunds.list')).toHaveLength(2)
  })

  it('an unrefunded payment has none', async () => {
    const paid = await stripe.paymentIntents.create(charge)
    expect(await listPaymentIntentRefunds(stripe, paid.id)).toEqual({ refunds: [] })
  })

  it('a Stripe failure is thrown, never read as "no refunds"', async () => {
    const paid = await stripe.paymentIntents.create(charge)
    stripe.failNext('refunds.list', { kind: 'unreachable' })
    await expect(listPaymentIntentRefunds(stripe, paid.id)).rejects.toThrow()
  })
})

function call(paymentIntentId: string, { email = 'jo@example.com', key = KEY as string | null } = {}) {
  const url = new URL('https://worker.test/api/v1/staff/payments/refunds')
  url.searchParams.set('paymentIntentId', paymentIntentId)
  return GET(new Request(url, { method: 'GET', headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), 'x-staff-email': email } }))
}

describe('GET /api/v1/staff/payments/refunds', () => {
  it('answers any active staff member, and the output matches its contract', async () => {
    const paid = await stripe.paymentIntents.create(charge)
    await stripe.refunds.create({ payment_intent: paid.id, amount: 1000, metadata: { [REFUND_KEY_METADATA]: 'k' } })
    const response = await call(paid.id)
    const body = (await response.json()) as { ok: boolean; data: unknown }
    expect(response.status).toBe(200)
    expect(paymentIntentRefundsOutputSchema.safeParse(body.data).success).toBe(true)
    expect(body).toMatchObject({ ok: true, data: { refunds: [{ amount: 10, key: 'k' }] } })
  })

  it('refuses a missing or wrong key, an unknown email and an inactive account', async () => {
    const paid = await stripe.paymentIntents.create(charge)
    expect((await call(paid.id, { key: null })).status).toBe(401)
    expect((await call(paid.id, { key: 'wrong' })).status).toBe(401)
    expect((await call(paid.id, { email: 'nobody@example.com' })).status).toBe(401)
    expect((await call(paid.id, { email: 'gone@example.com' })).status).toBe(403)
  })

  it('refuses anything that is not a PaymentIntent id', async () => {
    const response = await call('ch_123')
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'VALIDATION', field: 'paymentIntentId' } })
  })

  it('a payment Stripe has never heard of is NOT_FOUND', async () => {
    const response = await call('pi_nothing')
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } })
  })

  it("asks Stripe with read limits of its own, not the SDK's 80 seconds and 2 retries (W10a, W10 N1)", async () => {
    const paid = await stripe.paymentIntents.create(charge)
    holder.limits.length = 0
    expect((await call(paid.id)).status).toBe(200)
    expect(holder.limits).toEqual([READ_STRIPE_LIMITS])
    expect(READ_STRIPE_LIMITS).toEqual({ timeoutMs: 10_000, networkRetries: 1 })
  })

  it('Stripe failing is an error, never an empty list', async () => {
    const paid = await stripe.paymentIntents.create(charge)
    stripe.failNext('refunds.list', { kind: 'unreachable' })
    const response = await call(paid.id)
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ ok: false })
  })
})
