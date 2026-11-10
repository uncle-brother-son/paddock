import Stripe from 'stripe'
import { beforeEach, describe, expect, it } from 'vitest'
import { createStripeClient, keyLivemode } from './client'
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

  it('lists a PaymentIntent\'s refunds newest first, with their metadata, a page at a time', async () => {
    const paid = await stripe.paymentIntents.create(charge)
    const other = await stripe.paymentIntents.create(charge)
    await stripe.refunds.create({ payment_intent: paid.id, amount: 100, metadata: { refund_key: 'first' } })
    await stripe.refunds.create({ payment_intent: other.id, amount: 100 })
    await stripe.refunds.create({ payment_intent: paid.id, amount: 200, metadata: { refund_key: 'second' } })
    const page = await stripe.refunds.list({ payment_intent: paid.id, limit: 1 })
    expect(page.data.map((r) => r.metadata?.['refund_key'])).toEqual(['second'])
    expect(page.has_more).toBe(true)
    const next = await stripe.refunds.list({ payment_intent: paid.id, limit: 1, starting_after: page.data[0]!.id })
    expect(next.data.map((r) => [r.amount, r.metadata?.['refund_key']])).toEqual([[100, 'first']])
    expect(next.has_more).toBe(false)
  })

  it('a key dropped after 24 hours makes a repeat a new refund', async () => {
    const paid = await stripe.paymentIntents.create(charge)
    await stripe.refunds.create({ payment_intent: paid.id, amount: 100 }, { idempotencyKey: 'r1' })
    await stripe.refunds.create({ payment_intent: paid.id, amount: 100 }, { idempotencyKey: 'r1' })
    expect(stripe.refundedPence).toBe(100)
    stripe.forgetIdempotencyKeys()
    await stripe.refunds.create({ payment_intent: paid.id, amount: 100 }, { idempotencyKey: 'r1' })
    expect(stripe.refundedPence).toBe(200)
  })
})

describe('a key still in use by another request', () => {
  it('answers 409 and saves nothing, so the request that was running decides the key', async () => {
    stripe.failNext('paymentIntents.create', { kind: 'key_in_use' })
    await expect(stripe.paymentIntents.create(charge, { idempotencyKey: 'k' })).rejects.toMatchObject({
      code: 'idempotency_key_in_use',
      statusCode: 409,
    })
    expect(stripe.netPence).toBe(0)
    const paid = await stripe.paymentIntents.create(charge, { idempotencyKey: 'k' })
    expect(paid.status).toBe('succeeded')
  })

  it('a key that has already finished is replayed, not refused', async () => {
    const first = await stripe.paymentIntents.create(charge, { idempotencyKey: 'k' })
    stripe.failNext('paymentIntents.create', { kind: 'key_in_use' })
    expect((await stripe.paymentIntents.create(charge, { idempotencyKey: 'k' })).id).toBe(first.id)
  })

  it('is unknown to outcome.ts: the money may move through the other request', () => {
    expect(readStripeFailure(fakeStripeErrors.keyInUse())).toMatchObject({ outcome: 'unknown', code: 'idempotency_key_in_use' })
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
    await expect(stripe.paymentIntents.retrieve(paid.id, { expand: ['customer'] })).rejects.toThrow('not modelled')
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
    // The legacy routes keep this reading; the order's charge reads a 401 or 403 as definite (W10a, collect-saved-card.ts).
    ['a 401, the key refused', fakeStripeErrors.authentication(), 'unknown', null],
    ['a 403, the key not allowed', fakeStripeErrors.permission(), 'unknown', null],
  ])('%s', (_, error, outcome, code) => {
    expect(readStripeFailure(error)).toMatchObject({ outcome, code })
  })

  it("the fake's 401 and 403 are the classes the SDK makes from Stripe's answers (generateV1Error)", () => {
    const fromSdk = (statusCode: number) => Stripe.errors.StripeError.generate({ type: 'invalid_request_error', statusCode, message: 'x' })
    expect(fakeStripeErrors.authentication()).toBeInstanceOf(fromSdk(401).constructor)
    expect(fakeStripeErrors.permission()).toBeInstanceOf(fromSdk(403).constructor)
    expect(fromSdk(401)).toBeInstanceOf(Stripe.errors.StripeAuthenticationError)
    expect(fromSdk(403)).toBeInstanceOf(Stripe.errors.StripePermissionError)
  })
  describe('set-up for what already exists', () => {
    it('a seeded subscription is live, listed and can be cancelled', async () => {
      stripe.addPrice('price_seeded', 4000, 'month')
      stripe.addSubscription('sub_seeded', 'cus_1', 'price_seeded')
      expect(stripe.liveSubscriptions).toContain('sub_seeded')
      await stripe.subscriptions.cancel('sub_seeded')
      expect(stripe.liveSubscriptions).not.toContain('sub_seeded')
    })

    it('a tap that saves the card shows the generated card on the charge, and only then', async () => {
      const made = await stripe.paymentIntents.create({ amount: 500, currency: 'gbp' })
      stripe.completeReaderPayment(made.id, { generatedCard: 'pm_saved' })
      const read = await stripe.paymentIntents.retrieve(made.id, { expand: ['latest_charge'] })
      expect(read.payment_method).toBeTruthy()
      expect(read.latest_charge).toMatchObject({ payment_method_details: { card_present: { generated_card: 'pm_saved' } } })

      const plain = await stripe.paymentIntents.create({ amount: 500, currency: 'gbp' })
      stripe.completeReaderPayment(plain.id)
      expect((await stripe.paymentIntents.retrieve(plain.id)).payment_method).toBeNull()
    })
  })
})

describe('W11: the reader and card saving', () => {
  const tap = { amount: 2400, currency: 'gbp', customer: 'cus_1', payment_method_types: ['card_present'], setup_future_usage: 'off_session' as const }

  it('a reader intent waits for the tap with no money taken; a tap can take another figure', async () => {
    const intent = await stripe.paymentIntents.create(tap, { idempotencyKey: 'order-1:reader-intent' })
    expect(intent).toMatchObject({ status: 'requires_payment_method', amount: 2400, amount_received: 0, client_secret: `${intent.id}_secret` })
    stripe.completeReaderPayment(intent.id, { amount: 2401 })
    expect(await stripe.paymentIntents.retrieve(intent.id)).toMatchObject({ status: 'succeeded', amount: 2401, amount_received: 2401 })
  })

  it("the simulated reader leaves a card_present card but never a reusable one; a physical reader's tap names one", async () => {
    const simulated = await stripe.paymentIntents.create(tap)
    stripe.completeReaderPayment(simulated.id, { simulatedReader: true })
    const read = await stripe.paymentIntents.retrieve(simulated.id, { expand: ['latest_charge'] })
    expect(read.payment_method).toBe(`${simulated.id}_card_present`)
    expect((read.latest_charge as unknown as { payment_method_details: { card_present: unknown } }).payment_method_details.card_present).toEqual({ last4: '4242', brand: 'visa', generated_card: null })
    const physical = await stripe.paymentIntents.create(tap)
    stripe.completeReaderPayment(physical.id, { generatedCard: 'pm_generated' })
    expect(await stripe.paymentMethods.retrieve('pm_generated')).toMatchObject({ id: 'pm_generated', card: { last4: '4242', brand: 'visa' } })
  })

  it("a card-save SetupIntent: off-session card_present, a SetupAttempt whose card_present carries only the generated card, as Stripe's", async () => {
    const setup = await stripe.setupIntents.create({ customer: 'cus_1', payment_method_types: ['card_present'], usage: 'off_session' }, { idempotencyKey: 'cus:setup' })
    expect(setup).toMatchObject({ status: 'requires_payment_method', usage: 'off_session', payment_method_types: ['card_present'], client_secret: `${setup.id}_secret` })
    expect(await stripe.setupIntents.create({ customer: 'cus_1', payment_method_types: ['card_present'], usage: 'off_session' }, { idempotencyKey: 'cus:setup' })).toMatchObject({ id: setup.id })
    stripe.completeReaderSetup(setup.id, { generatedCard: 'pm_saved' })
    const read = await stripe.setupIntents.retrieve(setup.id, { expand: ['latest_attempt'] })
    expect(read.payment_method).toBe(`${setup.id}_card_present`)
    expect((read.latest_attempt as unknown as { payment_method_details: { card_present: unknown } }).payment_method_details.card_present).toEqual({ generated_card: 'pm_saved' })
    await expect(stripe.setupIntents.retrieve('seti_none')).rejects.toBeInstanceOf(Stripe.errors.StripeInvalidRequestError)
    await expect(stripe.paymentMethods.retrieve('pm_none')).rejects.toMatchObject({ code: 'resource_missing' })
  })

  it('a connection token for a location', async () => {
    expect(await stripe.terminal.connectionTokens.create({ location: 'tml_1' })).toMatchObject({ object: 'terminal.connection_token', secret: expect.stringMatching(/^pst_test_/), location: 'tml_1' })
  })

  it('the client interface the routes use is what the SDK offers: the same method names, so the real client fits', () => {
    const sdk = new Stripe('sk_test_shape_only', { httpClient: Stripe.createFetchHttpClient() })
    for (const [group, method] of [
      ['setupIntents', 'create'],
      ['setupIntents', 'retrieve'],
      ['paymentMethods', 'retrieve'],
      ['paymentIntents', 'cancel'],
    ] as const) {
      expect(typeof (sdk[group] as unknown as Record<string, unknown>)[method], `${group}.${method}`).toBe('function')
    }
    expect(typeof sdk.terminal.connectionTokens.create).toBe('function')
  })
})

// W11a (review L1): the mode of the key in use, and an intent made in the other mode answered as missing.
describe("W11a: the key's mode", () => {
  it('is read from the key: live or test, secret or restricted; null when the key does not say', () => {
    expect(keyLivemode('sk_live_abc')).toBe(true)
    expect(keyLivemode('rk_live_abc')).toBe(true)
    expect(keyLivemode('sk_test_abc')).toBe(false)
    expect(keyLivemode('rk_test_abc')).toBe(false)
    expect(keyLivemode('pk_live_abc')).toBe(null)
    expect(keyLivemode('sk_abc')).toBe(null)
    expect(keyLivemode('live')).toBe(null)
  })

  it("the Worker's client carries its key's mode (making a client sends nothing)", () => {
    expect(createStripeClient('sk_test_mode_never_sent').keyLivemode).toBe(false)
    expect(createStripeClient('rk_live_mode_never_sent').keyLivemode).toBe(true)
  })

  it('the fake stamps each intent with the mode of its key, and answers an intent of the other mode as missing, as Stripe does', async () => {
    const fake = new FakeStripe()
    const intent = await fake.paymentIntents.create({ amount: 100, currency: 'gbp' })
    expect(intent.livemode).toBe(false)
    fake.keyLivemode = true
    await expect(fake.paymentIntents.retrieve(intent.id)).rejects.toMatchObject({ code: 'resource_missing' })
    await expect(fake.paymentIntents.cancel(intent.id)).rejects.toMatchObject({ code: 'resource_missing' })
    expect((await fake.paymentIntents.create({ amount: 100, currency: 'gbp' })).livemode).toBe(true)
    fake.keyLivemode = false
    expect((await fake.paymentIntents.retrieve(intent.id)).status).toBe('requires_payment_method')
  })
})
