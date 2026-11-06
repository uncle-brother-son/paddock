import Stripe from 'stripe'
import { beforeEach, describe, expect, it } from 'vitest'
import { FakeStripe, fakeStripeErrors } from './fake'
import { readStripeFailure } from './outcome'

const charge = { amount: 1500, currency: 'gbp', customer: 'cus_1', payment_method: 'pm_1', off_session: true, confirm: true }
const KEY = { idempotencyKey: 'order-1:charge' }

let stripe: FakeStripe

beforeEach(() => {
  stripe = new FakeStripe()
  stripe.addCustomer('cus_1')
})

describe('idempotency keys', () => {
  it('replays a success without charging twice', async () => {
    const first = await stripe.paymentIntents.create(charge, KEY)
    const second = await stripe.paymentIntents.create(charge, KEY)
    expect(second.id).toBe(first.id)
    expect(stripe.netPence).toBe(1500)
  })

  it('replays a decline, so a retry on the same key can never work (bug 13)', async () => {
    stripe.failNext('paymentIntents.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
    await expect(stripe.paymentIntents.create(charge, KEY)).rejects.toThrow('declined')
    await expect(stripe.paymentIntents.create(charge, KEY)).rejects.toThrow('declined')
    expect(stripe.netPence).toBe(0)
  })

  it('replays a saved 500', async () => {
    stripe.failNext('paymentIntents.create', { kind: 'error', error: fakeStripeErrors.server() })
    await expect(stripe.paymentIntents.create(charge, KEY)).rejects.toBeInstanceOf(Stripe.errors.StripeAPIError)
    await expect(stripe.paymentIntents.create(charge, KEY)).rejects.toBeInstanceOf(Stripe.errors.StripeAPIError)
  })

  it('refuses the same key with different parameters', async () => {
    await stripe.paymentIntents.create(charge, KEY)
    await expect(stripe.paymentIntents.create({ ...charge, amount: 1600 }, KEY)).rejects.toBeInstanceOf(
      Stripe.errors.StripeIdempotencyError
    )
    expect(stripe.netPence).toBe(1500)
  })

  it('treats no key as a new charge every time', async () => {
    await stripe.paymentIntents.create(charge)
    await stripe.paymentIntents.create(charge)
    expect(stripe.netPence).toBe(3000)
  })
})

describe('the two kinds of timeout', () => {
  it('unreachable: nothing happened and the key still works', async () => {
    stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
    await expect(stripe.paymentIntents.create(charge, KEY)).rejects.toBeInstanceOf(Stripe.errors.StripeConnectionError)
    expect(stripe.netPence).toBe(0)
    await stripe.paymentIntents.create(charge, KEY)
    expect(stripe.netPence).toBe(1500)
  })

  it('lost response: the money moved, and a retry on the key finds it', async () => {
    stripe.failNext('paymentIntents.create', { kind: 'lost_response' })
    await expect(stripe.paymentIntents.create(charge, KEY)).rejects.toBeInstanceOf(Stripe.errors.StripeConnectionError)
    expect(stripe.netPence).toBe(1500)
    const retry = await stripe.paymentIntents.create(charge, KEY)
    expect(retry.status).toBe('succeeded')
    expect(stripe.netPence).toBe(1500)
  })
})

describe('reader PaymentIntents', () => {
  const reader = { amount: 2000, currency: 'gbp', customer: 'cus_1', payment_method_types: ['card_present'] }

  it('waits for the tap, then succeeds', async () => {
    const intent = await stripe.paymentIntents.create(reader)
    expect(intent.status).toBe('requires_payment_method')
    expect(stripe.netPence).toBe(0)
    stripe.completeReaderPayment(intent.id)
    expect((await stripe.paymentIntents.retrieve(intent.id)).status).toBe('succeeded')
    expect(stripe.netPence).toBe(2000)
  })

  it('cancels before the tap, and refuses after it', async () => {
    const open = await stripe.paymentIntents.create(reader)
    expect((await stripe.paymentIntents.cancel(open.id)).status).toBe('canceled')
    const paid = await stripe.paymentIntents.create(reader)
    stripe.completeReaderPayment(paid.id)
    await expect(stripe.paymentIntents.cancel(paid.id)).rejects.toThrow('could not be canceled')
  })

  it('finds an order by metadata through list, as reconcile will', async () => {
    await stripe.paymentIntents.create({ ...reader, metadata: { order_id: 'order-1' } })
    const found = await stripe.paymentIntents.list({ customer: 'cus_1' })
    expect(found.data.map((i) => i.metadata['order_id'])).toEqual(['order-1'])
  })
})

describe('refunds', () => {
  it('leaves the PaymentIntent reading succeeded (W03a)', async () => {
    const paid = await stripe.paymentIntents.create(charge)
    await stripe.refunds.create({ payment_intent: paid.id })
    expect((await stripe.paymentIntents.retrieve(paid.id)).status).toBe('succeeded')
    expect(stripe.netPence).toBe(0)
  })

  it('refuses a second full refund with charge_already_refunded', async () => {
    const paid = await stripe.paymentIntents.create(charge)
    await stripe.refunds.create({ payment_intent: paid.id })
    await expect(stripe.refunds.create({ payment_intent: paid.id })).rejects.toMatchObject({ code: 'charge_already_refunded' })
  })

  it('refuses more than is left', async () => {
    const paid = await stripe.paymentIntents.create(charge)
    await stripe.refunds.create({ payment_intent: paid.id, amount: 1000 })
    await expect(stripe.refunds.create({ payment_intent: paid.id, amount: 501 })).rejects.toThrow('greater than')
    expect(stripe.netPence).toBe(500)
  })
})

describe('subscriptions', () => {
  beforeEach(() => stripe.addPrice('price_1', 4000, 'month'))
  const subscription = { customer: 'cus_1', items: [{ price: 'price_1' }], expand: ['latest_invoice.payments'] }

  it('charges the first invoice, less a coupon', async () => {
    await stripe.coupons.create({ id: 'order-order-1', amount_off: 1000, currency: 'gbp', duration: 'once' }, { idempotencyKey: 'o:coupon' })
    const sub = await stripe.subscriptions.create({ ...subscription, discounts: [{ coupon: 'order-order-1' }] })
    expect((sub.latest_invoice as Stripe.Invoice).amount_paid).toBe(3000)
    expect(stripe.netPence).toBe(3000)
  })

  it('a fixed coupon id and key replay cleanly, which is what fixes bug 13', async () => {
    const params = { id: 'order-order-1', amount_off: 1000, currency: 'gbp', duration: 'once' as const }
    const first = await stripe.coupons.create(params, { idempotencyKey: 'o:coupon' })
    const second = await stripe.coupons.create(params, { idempotencyKey: 'o:coupon' })
    expect(second.id).toBe(first.id)
    await expect(stripe.coupons.create(params, { idempotencyKey: 'other' })).rejects.toMatchObject({ code: 'resource_already_exists' })
  })

  it('cancels, and lists by customer', async () => {
    const sub = await stripe.subscriptions.create({ ...subscription, metadata: { order_id: 'order-1' } })
    expect(stripe.liveSubscriptions).toEqual([sub.id])
    const found = await stripe.subscriptions.list({ customer: 'cus_1', status: 'all' })
    expect(found.data[0]?.metadata['order_id']).toBe('order-1')
    await stripe.subscriptions.cancel(sub.id)
    expect(stripe.liveSubscriptions).toEqual([])
  })
})

describe('calls', () => {
  it('records each call in order, failures included', async () => {
    stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
    await expect(stripe.paymentIntents.create(charge, KEY)).rejects.toThrow()
    await expect(stripe.prices.retrieve('nope')).rejects.toMatchObject({ code: 'resource_missing' })
    expect(stripe.calls.map((c) => [c.method, c.idempotencyKey])).toEqual([
      ['paymentIntents.create', 'order-1:charge'],
      ['prices.retrieve', null],
    ])
  })

  it('refuses behaviour nobody modelled', async () => {
    const paid = await stripe.paymentIntents.create(charge)
    await expect(stripe.paymentIntents.retrieve(paid.id, { expand: ['latest_charge'] })).rejects.toThrow('not modelled')
  })
})

describe('readStripeFailure', () => {
  it.each([
    ['a decline', fakeStripeErrors.cardDeclined(), 'definite', 'card_declined'],
    ['authentication needed', fakeStripeErrors.authenticationRequired(), 'definite', 'authentication_required'],
    ['an invalid request', fakeStripeErrors.missing('thing'), 'definite', 'resource_missing'],
    ['a connection error', fakeStripeErrors.connection(), 'unknown', null],
    ['a Stripe 500', fakeStripeErrors.server(), 'unknown', null],
    ['an idempotency refusal', fakeStripeErrors.idempotency(), 'unknown', null],
    ['something that is not Stripe', new Error('boom'), 'unknown', null],
  ])('%s', (_, error, outcome, code) => {
    expect(readStripeFailure(error)).toMatchObject({ outcome, code })
  })
})
