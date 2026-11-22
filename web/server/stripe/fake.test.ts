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

  it('W65a (W35 audit row 3): a cancelled PaymentIntent is never completed: the tap is refused and nothing is taken; one held for capture still completes', async () => {
    const cancelled = await stripe.paymentIntents.create(reader)
    await stripe.paymentIntents.cancel(cancelled.id)
    let refused: unknown
    try {
      stripe.completeReaderPayment(cancelled.id)
    } catch (err) {
      refused = err
    }
    expect(refused).toMatchObject({ code: 'payment_intent_unexpected_state' })
    expect(() => stripe.completeReaderPayment(cancelled.id, { generatedCard: 'pm_saved' })).toThrow("can't be confirmed or captured")
    const after = await stripe.paymentIntents.retrieve(cancelled.id)
    expect([after.status, after.amount_received, after.latest_charge]).toEqual(['canceled', 0, null])
    expect(stripe.netPence).toBe(0)
    // Control: an intent authorised and waiting for capture is still completed by the tap's capture.
    const held = await stripe.paymentIntents.create(reader)
    stripe.markRequiresCapture(held.id)
    stripe.completeReaderPayment(held.id)
    expect((await stripe.paymentIntents.retrieve(held.id)).status).toBe('succeeded')
    expect(stripe.netPence).toBe(2000)
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

  // W49 + W54 (W48 review S2): the fake's price switch took an archived price, where its own subscriptions.create
  // refuses one. A plan price move onto an archived price would then have passed every test here and failed only in
  // Stripe (W57's invariant: a plan never points at an archived price).
  it('a price switch refuses an archived price, as starting a subscription does, and moves to a live one', async () => {
    const sub = await stripe.subscriptions.create(subscription)
    const item = `si_${sub.id}`
    stripe.addPrice('price_new', 4500, 'month')
    stripe.addPrice('price_archived', 4500, 'month', 'gbp', false)
    const switchTo = (price: string) => stripe.subscriptions.update(sub.id, { items: [{ id: item, price }], proration_behavior: 'none' })

    await expect(switchTo('price_archived')).rejects.toMatchObject({ code: 'price_inactive' })
    await expect(stripe.subscriptions.create({ ...subscription, items: [{ price: 'price_archived' }] })).rejects.toMatchObject({ code: 'price_inactive' })
    // The subscription is still on its first price.
    expect((await stripe.subscriptions.retrieve(sub.id)).items.data[0]?.price.id).toBe('price_1')

    // A price archived after it was made is refused the same way; a live one is taken.
    await stripe.prices.update('price_new', { active: false })
    await expect(switchTo('price_new')).rejects.toMatchObject({ code: 'price_inactive' })
    await stripe.prices.update('price_new', { active: true })
    expect((await switchTo('price_new')).items.data[0]?.price.id).toBe('price_new')
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

    // W46b (W46 review B1): the webhook holds an invoice event against the subscription's newest invoice.
    it("a subscription's newest invoice is the one it was made with, answered as an id, until a test gives it a later one", async () => {
      stripe.addPrice('price_seeded', 4000, 'month')
      stripe.addSubscription('sub_seeded', 'cus_1', 'price_seeded')
      const first = stripe.latestInvoice('sub_seeded')
      expect(first).toMatch(/^in_/)
      expect((await stripe.subscriptions.retrieve('sub_seeded')).latest_invoice).toBe(first)
      expect((await stripe.subscriptions.retrieve('sub_seeded', { expand: ['latest_invoice.payments'] })).latest_invoice).toMatchObject({ id: first, object: 'invoice' })
      stripe.setSubscription('sub_seeded', { latestInvoice: 'in_later' })
      expect(stripe.latestInvoice('sub_seeded')).toBe('in_later')
      expect((await stripe.subscriptions.retrieve('sub_seeded')).latest_invoice).toBe('in_later')
      // Nothing else moved.
      expect(stripe.subscriptionSettings('sub_seeded')).toMatchObject({ status: 'active', cancelAt: null, trialEnd: null })
      // Only the invoice it was made with is modelled expanded.
      await expect(stripe.subscriptions.retrieve('sub_seeded', { expand: ['latest_invoice.payments'] })).rejects.toThrow('The fake has only modelled expanding the invoice a subscription was made with')
      expect(() => stripe.latestInvoice('sub_none')).toThrow('The fake has no subscription sub_none.')
    })

    it.each([
      ['month', (start: Date) => start.setUTCMonth(start.getUTCMonth() + 1)],
      ['year', (start: Date) => start.setUTCFullYear(start.getUTCFullYear() + 1)],
    ] as const)('startRenewal, a %sly price: the hour before the charge: active, the period moved on one period from the old end, and a new draft its newest invoice', async (interval, on) => {
      stripe.addPrice('price_seeded', 4000, interval)
      stripe.addSubscription('sub_seeded', 'cus_1', 'price_seeded')
      const first = stripe.latestInvoice('sub_seeded')
      const oldEnd = stripe.subscriptionSettings('sub_seeded')?.periodEnd ?? 0
      // Left trialing by a payment date change: the renewal ends the no-charge days.
      stripe.setSubscription('sub_seeded', { status: 'trialing' })
      const draft = stripe.startRenewal('sub_seeded')
      expect(draft).toMatch(/^in_/)
      expect(draft).not.toBe(first)
      const read = await stripe.subscriptions.retrieve('sub_seeded')
      expect(read.status).toBe('active')
      expect(read.latest_invoice).toBe(draft)
      expect(read.items.data[0]?.current_period_start).toBe(oldEnd)
      expect(read.items.data[0]?.current_period_end).toBe(on(new Date(oldEnd * 1000)) / 1000)
      expect(stripe.subscriptionSettings('sub_seeded')).toMatchObject({ status: 'active', trialEnd: null })
      // The charge failing or going through is the test's to set; the invoice stays the newest.
      stripe.setSubscription('sub_seeded', { status: 'past_due' })
      expect((await stripe.subscriptions.retrieve('sub_seeded')).latest_invoice).toBe(draft)
      // A second renewal gives another draft, and a period end can be given.
      const next = stripe.startRenewal('sub_seeded', 1900000000)
      expect(next).not.toBe(draft)
      expect(stripe.subscriptionSettings('sub_seeded')).toMatchObject({ status: 'active', periodEnd: 1900000000 })
      expect(() => stripe.startRenewal('sub_none')).toThrow('The fake has no subscription sub_none.')
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

describe('W12: what reconcile reads', () => {
  it('lists intents as Stripe does: newest first, a page at a time, by customer and created, in the key\'s own mode', async () => {
    stripe.addCustomer('cus_2')
    const made: string[] = []
    for (let i = 0; i < 3; i++) made.push((await stripe.paymentIntents.create({ amount: 100, currency: 'gbp', customer: 'cus_1' })).id)
    await stripe.paymentIntents.create({ amount: 100, currency: 'gbp', customer: 'cus_2' })
    const page1 = await stripe.paymentIntents.list({ customer: 'cus_1', limit: 2 })
    expect(page1.data.map((i) => i.id)).toEqual([made[2], made[1]])
    expect(page1.has_more).toBe(true)
    const page2 = await stripe.paymentIntents.list({ customer: 'cus_1', limit: 2, starting_after: made[1] as string })
    expect(page2.data.map((i) => i.id)).toEqual([made[0]])
    expect(page2.has_more).toBe(false)
    const now = Math.floor(Date.now() / 1000)
    expect((await stripe.paymentIntents.list({ created: { gte: now + 60 } })).data).toEqual([])
    expect((await stripe.paymentIntents.list({ created: { gte: now - 60, lte: now + 60 } })).data).toHaveLength(4)
    stripe.keyLivemode = true
    expect((await stripe.paymentIntents.list({})).data).toEqual([])
  })

  it("a processing intent can't be cancelled, as Stripe refuses", async () => {
    const intent = await stripe.paymentIntents.create({ amount: 100, currency: 'gbp', customer: 'cus_1' })
    stripe.markProcessing(intent.id)
    await expect(stripe.paymentIntents.cancel(intent.id)).rejects.toThrow('could not be canceled: it is processing')
  })

  it('a refund can stay pending, then settle; one that fails puts its money back on the payment', async () => {
    const paid = await stripe.paymentIntents.create(charge)
    stripe.refundsStayPending = true
    const refund = await stripe.refunds.create({ payment_intent: paid.id })
    expect(refund.status).toBe('pending')
    stripe.settleRefund(refund.id, 'failed')
    expect(stripe.refundedPence).toBe(0)
    const again = await stripe.refunds.create({ payment_intent: paid.id })
    stripe.settleRefund(again.id, 'succeeded')
    expect(stripe.refundedPence).toBe(1500)
    expect((await stripe.refunds.list({ payment_intent: paid.id })).data.map((r) => r.status)).toEqual(['succeeded', 'failed'])
  })

  it("W32a (W32 review L4): a refund answered succeeded can fail afterwards, as Stripe's 5126 test card does: its amount is back on the payment; no other ended refund moves", async () => {
    const paid = await stripe.paymentIntents.create(charge)
    const refund = await stripe.refunds.create({ payment_intent: paid.id, amount: 500 })
    expect(refund.status).toBe('succeeded')
    expect(stripe.refundedPence).toBe(500)
    stripe.settleRefund(refund.id, 'failed')
    expect(stripe.refundedPence).toBe(0)
    expect((await stripe.refunds.list({ payment_intent: paid.id })).data.map((r) => r.status)).toEqual(['failed'])
    // The whole payment can be refunded again: Stripe put the money back on it.
    const again = await stripe.refunds.create({ payment_intent: paid.id })
    expect(again.amount).toBe(1500)
    // A failed refund stays failed, and a succeeded one never goes back to pending or to cancelled.
    expect(() => stripe.settleRefund(refund.id, 'succeeded')).toThrow('only a pending refund ends')
    expect(() => stripe.settleRefund(again.id, 'canceled')).toThrow('only a pending refund ends')
    expect(() => stripe.settleRefund(again.id, 'succeeded')).toThrow('only a pending refund ends')
    expect(stripe.refundedPence).toBe(1500)
  })

  it('an idTag goes into every id it makes (W12: one PaymentIntent, one order, across fakes)', async () => {
    const tagged = new FakeStripe({ idTag: 'abc' })
    tagged.addCustomer('cus_1')
    expect((await tagged.paymentIntents.create(charge)).id).toMatch(/^pi_fake_abc_\d{4}$/)
    expect((await stripe.paymentIntents.create(charge)).id).toMatch(/^pi_fake_\d{4}$/)
  })
})

describe('W12a: a refused key saves nothing against the idempotency key', () => {
  it("a 401 or 403 is turned away before any endpoint runs, as Stripe's docs say, so the same key sent again once the key works is a first send", async () => {
    for (const refusal of [fakeStripeErrors.authentication(), fakeStripeErrors.permission()]) {
      const fake = new FakeStripe()
      fake.addCustomer('cus_1')
      const paid = await fake.paymentIntents.create(charge)
      const key = { idempotencyKey: `${paid.id}:refund` }
      fake.failNext('refunds.create', { kind: 'error', error: refusal })
      await expect(fake.refunds.create({ payment_intent: paid.id }, key)).rejects.toBe(refusal)
      expect(fake.refundedPence).toBe(0)
      const refund = await fake.refunds.create({ payment_intent: paid.id }, key)
      expect(refund.status).toBe('succeeded')
      expect(await fake.refunds.create({ payment_intent: paid.id }, key)).toEqual(refund)
      expect(fake.refundedPence).toBe(1500)
    }
  })

  it('any other error is still saved against the key and replayed, as Stripe does once an endpoint has run', async () => {
    const paid = await stripe.paymentIntents.create(charge)
    const key = { idempotencyKey: `${paid.id}:refund` }
    const disputed = fakeStripeErrors.invalid('charge_disputed', 'This charge is disputed.')
    stripe.failNext('refunds.create', { kind: 'error', error: disputed })
    await expect(stripe.refunds.create({ payment_intent: paid.id }, key)).rejects.toBe(disputed)
    await expect(stripe.refunds.create({ payment_intent: paid.id }, key)).rejects.toBe(disputed)
    expect(stripe.refundedPence).toBe(0)
  })
})

// W47r ("Try the payment again now"): a renewal's invoice, read and paid. What the fake holds Stripe to do.
describe("W47r: a renewal's invoice, read and paid", () => {
  const SUB = 'sub_1'
  let invoice: string
  let paymentIntent: string

  beforeEach(async () => {
    stripe.addPrice('price_1', 4000, 'month')
    stripe.addSubscription(SUB, 'cus_1', 'price_1')
    await stripe.subscriptions.update(SUB, { default_payment_method: 'pm_old' })
    stripe.startRenewal(SUB)
    ;({ invoice, paymentIntent } = stripe.renewalFails(SUB))
  })

  it('a failed renewal: the invoice is open with all of it to pay, its one payment took nothing, and the subscription is past due; it is the subscription\'s newest invoice', async () => {
    expect(stripe.subscriptionSettings(SUB)?.status).toBe('past_due')
    expect(stripe.latestInvoice(SUB)).toBe(invoice)
    expect(await stripe.invoices.retrieve(invoice)).toMatchObject({ id: invoice, object: 'invoice', status: 'open', currency: 'gbp', customer: 'cus_1', amount_due: 4000, amount_paid: 0, amount_remaining: 4000, billing_reason: 'subscription_cycle', parent: { subscription_details: { subscription: SUB } } })
    // Its payments only when asked for, as Stripe: an includable property.
    expect('payments' in (await stripe.invoices.retrieve(invoice))).toBe(false)
    expect((await stripe.invoices.retrieve(invoice, { expand: ['payments'] })).payments?.data).toMatchObject([{ status: 'open', payment: { type: 'payment_intent', payment_intent: paymentIntent } }])
    expect((await stripe.paymentIntents.retrieve(paymentIntent)).status).toBe('requires_payment_method')
    expect(stripe.netPence).toBe(0)
    await expect(stripe.invoices.retrieve(invoice, { expand: ['lines'] })).rejects.toThrow('not modelled')
  })

  it('pay names the card it charges, else the subscription\'s default; paid, the subscription is active again; the answer is saved against the key', async () => {
    const key = { idempotencyKey: 'retry-1:pay' }
    const paid = await stripe.invoices.pay(invoice, { payment_method: 'pm_new', off_session: true }, key)
    expect(paid).toMatchObject({ status: 'paid', amount_paid: 4000, amount_remaining: 0 })
    expect(stripe.invoiceState(invoice)).toEqual({ status: 'paid', amountPaid: 4000, paymentIntent, paymentStatus: 'succeeded', paymentMethod: 'pm_new' })
    expect(stripe.subscriptionSettings(SUB)?.status).toBe('active')
    expect(await stripe.invoices.pay(invoice, { payment_method: 'pm_new', off_session: true }, key)).toEqual(paid)
    expect(stripe.netPence).toBe(4000)
    // With no card named, the subscription's own.
    const other = new FakeStripe()
    other.addCustomer('cus_1')
    other.addPrice('price_1', 4000, 'month')
    other.addSubscription(SUB, 'cus_1', 'price_1')
    await other.subscriptions.update(SUB, { default_payment_method: 'pm_old' })
    other.startRenewal(SUB)
    const failed = other.renewalFails(SUB)
    await other.invoices.pay(failed.invoice)
    expect(other.invoiceState(failed.invoice).paymentMethod).toBe('pm_old')
  })

  it('an invoice already paid refuses a pay (so its amount is never taken twice), with a new key or an old one Stripe has dropped', async () => {
    await stripe.invoices.pay(invoice, { payment_method: 'pm_new' }, { idempotencyKey: 'retry-1:pay' })
    await expect(stripe.invoices.pay(invoice, { payment_method: 'pm_new' }, { idempotencyKey: 'retry-2:pay' })).rejects.toMatchObject({ code: 'invoice_already_paid' })
    stripe.forgetIdempotencyKeys()
    const refused = await stripe.invoices.pay(invoice, { payment_method: 'pm_new' }, { idempotencyKey: 'retry-1:pay' }).catch((err: unknown) => err)
    expect(readStripeFailure(refused)).toMatchObject({ outcome: 'definite', code: 'invoice_already_paid' })
    expect(stripe.netPence).toBe(4000)
  })

  it('a declined card: a card error, the invoice still open, nothing taken, the subscription still past due; the decline is saved against the key', async () => {
    stripe.declineCard('pm_old')
    const key = { idempotencyKey: 'retry-1:pay' }
    const declined = await stripe.invoices.pay(invoice, { payment_method: 'pm_old' }, key).catch((err: unknown) => err)
    expect(readStripeFailure(declined)).toMatchObject({ outcome: 'definite', code: 'card_declined' })
    expect(stripe.invoiceState(invoice)).toMatchObject({ status: 'open', paymentStatus: 'requires_payment_method', paymentMethod: 'pm_old' })
    expect(stripe.subscriptionSettings(SUB)?.status).toBe('past_due')
    stripe.declineCard('pm_old', false)
    await expect(stripe.invoices.pay(invoice, { payment_method: 'pm_old' }, key)).rejects.toMatchObject({ code: 'card_declined' })
    expect(stripe.netPence).toBe(0)
  })

  it('a payment left at the bank or waiting on the customer: the invoice stays open until it ends; a pay while it is processing is refused', async () => {
    stripe.nextPayEnds(invoice, 'processing')
    expect((await stripe.invoices.pay(invoice, { payment_method: 'pm_new' })).status).toBe('open')
    expect(stripe.invoiceState(invoice)).toMatchObject({ status: 'open', paymentStatus: 'processing' })
    await expect(stripe.invoices.pay(invoice, { payment_method: 'pm_new' })).rejects.toMatchObject({ code: 'payment_intent_unexpected_state' })
    stripe.settleInvoicePayment(invoice, 'failed')
    expect(stripe.invoiceState(invoice)).toMatchObject({ status: 'open', paymentStatus: 'requires_payment_method' })
    stripe.nextPayEnds(invoice, 'requires_action')
    const waiting = await stripe.invoices.pay(invoice, { payment_method: 'pm_new' }).catch((err: unknown) => err)
    expect(readStripeFailure(waiting)).toMatchObject({ outcome: 'definite', code: 'invoice_payment_intent_requires_action' })
    expect(stripe.invoiceState(invoice)).toMatchObject({ status: 'open', paymentStatus: 'requires_action' })
    stripe.settleInvoicePayment(invoice, 'succeeded')
    expect(stripe.invoiceState(invoice)).toMatchObject({ status: 'paid', amountPaid: 4000 })
    expect(stripe.subscriptionSettings(SUB)?.status).toBe('active')
    expect(() => stripe.settleInvoicePayment(invoice, 'failed')).toThrow('no payment still going')
  })

  it("Stripe's own retry pays an open invoice on the subscription's card, with no call of ours; a subscription that has ended stays ended, and its open invoice can still be paid", async () => {
    const before = stripe.calls.length
    stripe.stripeRetryPays(invoice)
    expect(stripe.calls.length).toBe(before)
    expect(stripe.invoiceState(invoice)).toMatchObject({ status: 'paid', paymentMethod: 'pm_old' })
    expect(stripe.subscriptionSettings(SUB)?.status).toBe('active')
    expect(() => stripe.stripeRetryPays(invoice)).toThrow('only an open one is retried')

    const ended = new FakeStripe()
    ended.addCustomer('cus_1')
    ended.addPrice('price_1', 4000, 'month')
    ended.addSubscription(SUB, 'cus_1', 'price_1')
    ended.startRenewal(SUB)
    const failed = ended.renewalFails(SUB)
    ended.setSubscription(SUB, { status: 'canceled' })
    // Stripe leaves the invoice open and payable: only the caller's own checks stop a cancelled member being charged.
    await ended.invoices.pay(failed.invoice, { payment_method: 'pm_new' })
    expect(ended.netPence).toBe(4000)
    expect(ended.subscriptionSettings(SUB)?.status).toBe('canceled')
  })

  it("an invoice of the other mode's key, or one that never existed, is answered as missing; only a renewal's invoice is modelled; void and written-off invoices are not paid", async () => {
    await expect(stripe.invoices.retrieve('in_nope')).rejects.toMatchObject({ code: 'resource_missing' })
    stripe.keyLivemode = true
    await expect(stripe.invoices.retrieve(invoice)).rejects.toMatchObject({ code: 'resource_missing' })
    await expect(stripe.invoices.pay(invoice, { payment_method: 'pm_new' })).rejects.toMatchObject({ code: 'resource_missing' })
    stripe.keyLivemode = false
    stripe.setInvoiceStatus(invoice, 'void')
    expect((await stripe.invoices.retrieve(invoice)).status).toBe('void')
    await expect(stripe.invoices.pay(invoice, { payment_method: 'pm_new' })).rejects.toThrow('not modelled')
    await expect(stripe.invoices.pay(invoice, { payment_method: 'pm_new', forgive: true })).rejects.toThrow('not modelled')
    expect(stripe.netPence).toBe(0)
  })

  it('the client interface has the two calls the retry makes, as the SDK names them', () => {
    const sdk = new Stripe('sk_test_shape_only', { httpClient: Stripe.createFetchHttpClient() })
    expect(typeof sdk.invoices.retrieve).toBe('function')
    expect(typeof sdk.invoices.pay).toBe('function')
  })
})
