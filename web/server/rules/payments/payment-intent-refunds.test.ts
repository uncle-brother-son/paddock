import { beforeEach, describe, expect, it } from 'vitest'
import { FakeStripe } from '@/server/stripe/fake'
import { listPaymentIntentRefunds, REFUND_KEY_METADATA } from './payment-intent-refunds'

// W05k: a card refund with no clear answer older than 23 hours is settled by finding its key on the
// PaymentIntent's refunds, because Stripe may have forgotten the key and a resend could pay twice.
// W34: the route that served this (GET /api/v1/staff/payments/refunds) left app/; its tests went with it to
// server/rules/testing/legacy-order/routes/v1/staff/payments/refunds/route.test.ts.

const charge = { amount: 4000, currency: 'gbp', customer: 'cus_1', payment_method: 'pm_1', confirm: true }

let stripe: FakeStripe

beforeEach(() => {
  stripe = new FakeStripe()
  stripe.addCustomer('cus_1')
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
