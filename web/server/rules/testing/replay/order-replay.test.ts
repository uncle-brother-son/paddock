import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Db } from '@/server/db'
import { READER_INTENT_UNCONFIRMED_MESSAGE, staffSees } from '@/server/rules/orders/failure-messages'
import { compareRecordings, withCanonicalGoneNumbers, withCanonicalStripeIds, type Recording } from './compare'
import { readGolden, replay, startReplay, type ReplayEnvironment, type Scenario } from './harness'
import { NEW_SIDE_CONFIRMS, NOT_BUILT_SCENARIOS, ORDER_SCENARIOS, orderDifferences, OUTCOME_DIFFERS, W13_SCENARIOS } from './order-differences'
import type { StripeCallRecord } from './compare'
import { newOrderSide, type OrderAnswer } from './order-side'
import { ID, scenarios } from './scenarios'

// The order route's parity proof (W03-plan 3.1 layer 1): each scenario in W06's to W08's scope runs
// from the same seed through the new order route, and its rows (in the order the app reads them), its
// answer and its money must match what the old createOrder wrote, saved in the golden file, except the
// differences named in order-differences.ts. A golden file is the old function's own recording, so
// this still holds the route to it after the old code goes.

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))
// W10: the order route charges each run's own FakeStripe (stripe-binding.ts).
vi.mock('@/server/stripe/client', async (importOriginal) => {
  const { stripeClientMock } = await import('./stripe-binding')
  return stripeClientMock(await importOriginal<typeof import('@/server/stripe/client')>())
})

const byName = (name: string): Scenario => {
  const scenario = scenarios.find((s) => s.name === name)
  if (!scenario) throw new Error(`No scenario ${name}`)
  return scenario
}

describe('the order route against the old createOrder', () => {
  let environment: ReplayEnvironment

  beforeAll(async () => {
    process.env.STAFF_API_KEY = 'test-staff-api-key'
    environment = await startReplay()
    holder.db = environment.database.db
  })
  afterAll(() => environment.stop())

  async function runNew(name: string): Promise<{ recording: Recording; answers: OrderAnswer[] }> {
    const answers: OrderAnswer[] = []
    const confirms = NEW_SIDE_CONFIRMS[name]
    const recording = await replay(
      environment,
      byName(name),
      newOrderSide(answers, (input) => (confirms ? { ...input, confirmed: { ...input.confirmed, toCollect: confirms.toCollect } } : input))
    )
    return { recording, answers }
  }

  describe.each(ORDER_SCENARIOS)('%s', (name) => {
    it('writes what the old function wrote, in the same order, and answers the same', async () => {
      const golden = readGolden(name) as Recording
      expect(golden, `No golden file for ${name}`).not.toBeNull()
      const { recording, answers } = await runNew(name)
      const placed = answers[0]?.body.ok === true
      // W11: a cancelled reader order's id is a gone label on both sides, numbered where it is first met.
      // W13: a membership's Stripe ids too, numbered by kind where first met (compare.ts, withCanonicalStripeIds).
      const canonical = (r: Recording) => (W13_SCENARIOS.includes(name) ? withCanonicalStripeIds(withCanonicalGoneNumbers(r)) : withCanonicalGoneNumbers(r))
      expect(compareRecordings(canonical(golden), canonical(recording), orderDifferences(placed, name, golden))).toEqual([])
    })

    it.skipIf(OUTCOME_DIFFERS.includes(name))('tells staff what the screen told them', async () => {
      const golden = readGolden(name) as Recording
      const old = golden.results[0] as { success: boolean; reason?: string; message?: string; amountDueTotal?: number }
      const { answers } = await runNew(name)
      const body = answers[0]?.body
      if (old.success) {
        expect(body?.ok).toBe(true)
        return
      }
      expect(body?.ok).toBe(false)
      if (body && !body.ok) expect(body.error.message).toBe(staffSees({ reason: old.reason as string, message: old.message, amountDueTotal: old.amountDueTotal }))
    })
  })

  describe('row order', () => {
    it('the seats keep their order, though now() does not move inside the transaction', async () => {
      const { recording } = await runNew('w06-a-full-public-party')
      expect(recording.tables['booking_guests']?.tied).toBe(0)
      expect(recording.tables['booking_guests']?.added.map((seat) => seat['guest_type'])).toEqual([
        'account_holder',
        'additional_guest',
        'additional_guest',
        'additional_guest',
        'additional_guest',
        'additional_guest',
      ])
    })

    it('the order lines and the booking add-ons keep theirs', async () => {
      const lines = (await runNew('w06-booking-and-a-standalone-addon-in-cash')).recording.tables['order_line_items']
      expect(lines?.tied).toBe(0)
      expect(lines?.added.map((line) => line['item_type'])).toEqual(['booking', 'addon'])
      const addons = (await runNew('w06-two-addon-credits-on-one-membership')).recording.tables['addon_order_lines']
      expect(addons?.tied).toBe(0)
      expect(addons?.added.map((line) => line['sku_at_purchase'])).toEqual(['TOWEL', 'ROBE'])
    })

    it('the two audit rows are in order: created, then paid', async () => {
      const audit = (await runNew('cash-booking-two-guests-addon')).recording.tables['audit_log']
      expect(audit?.tied).toBe(0)
      expect(audit?.added.map((row) => row['action'])).toEqual(['order.create', 'order.paid'])
    })
  })

  describe('W07: the outcome the address decision changes', () => {
    it('a failed address save: the old order was kept with a warning; the new one is refused, with nothing kept', async () => {
      const golden = readGolden('w07-address-save-fails') as Recording
      expect(golden.results[0]).toMatchObject({ success: true, warning: expect.stringContaining("saving the delivery address to the customer's profile failed") })
      expect(golden.tables['orders']?.added).toMatchObject([{ payment_status: 'paid', payment_method: 'cash' }])
      const { recording, answers } = await runNew('w07-address-save-fails')
      expect(answers[0]?.status).toBe(500)
      expect(answers[0]?.body).toMatchObject({ ok: false, error: { code: 'INTERNAL', message: 'Something went wrong and the action may not have finished. Check before trying again.' } })
      expect(Object.keys(recording.tables)).toEqual(['api_idempotency'])
    })
  })

  describe('W10: the outcome W03-plan 2.5 changes', () => {
    it('an unclear answer: the old order was rolled back as a decline; the new one is held pending with its claims, never undone', async () => {
      const golden = readGolden('w10-unclear-answer') as Recording
      expect(golden.results[0]).toMatchObject({ success: false, reason: 'charge_failed', message: 'Failed to charge saved card: An error occurred with our API.' })
      expect(golden.stripeCalls).toHaveLength(1)
      expect(golden.tables).toEqual({})
      const { recording, answers } = await runNew('w10-unclear-answer')
      expect(answers[0]?.status).toBe(502)
      expect(answers[0]?.body).toMatchObject({ ok: false, error: { code: 'PAYMENT_UNCONFIRMED', details: { stage: 'payment', reason: 'payment_unconfirmed' } } })
      // The same request twice under the same key: Stripe kept the 500 against it.
      expect(recording.stripeCalls.map((call) => call.idempotencyKey)).toEqual(['orders#1:charge', 'orders#1:charge'])
      expect(recording.tables['orders']?.added).toMatchObject([{ payment_status: 'pending', payment_method: 'card' }])
      expect(recording.tables['customers']?.changed).toEqual([{ id: ID.customer, store_credit_balance: ['30.00', '20.00'] }])
      expect(recording.tables['sessions']?.changed).toEqual([{ id: ID.session, total_booked: [0, 1] }])
      expect(recording.tables['audit_log']?.added.map((row) => row['action'])).toEqual(['order.create'])
    })
  })

  describe('W10: row order', () => {
    it("the card order's rows keep createOrder's order, and its audit rows come create, then paid", async () => {
      const { recording } = await runNew('w10-card-every-kind')
      const lines = recording.tables['order_line_items']
      expect(lines?.tied).toBe(0)
      expect(lines?.added.map((line) => line['item_type'])).toEqual(['booking', 'event', 'addon', 'product', 'session_pass', 'gift_card'])
      expect(recording.tables['booking_guests']?.tied).toBe(0)
      expect(recording.tables['event_attendees']?.tied).toBe(0)
      expect(recording.tables['audit_log']?.added.map((row) => row['action'])).toEqual(['order.create', 'order.paid'])
    })
  })

  describe('W11: the outcomes W03-plan 2.5 and 2.7 change on the reader', () => {
    it('a payment a penny over: the old finalise let it through; the new one leaves the order pending, checked to the penny', async () => {
      const golden = readGolden('w11-reader-amount-a-penny-over') as Recording
      expect(golden.results[1]).toEqual({ finalised: true, orderId: 'orders#1', paymentIntentId: 'pi_fake_0001' })
      expect(golden.tables['orders']?.added).toMatchObject([{ payment_status: 'paid', payment_method: 'reader' }])
      const { recording, answers } = await runNew('w11-reader-amount-a-penny-over')
      expect(answers[1]?.body).toMatchObject({
        ok: true,
        data: {
          finalised: false,
          reason: 'amount_mismatch',
          message: 'The reader charged £45.01 but the order expected £45.00 — do NOT finalise automatically. Check the PaymentIntent (pi_fake_0001) in Stripe and refund/adjust manually.',
        },
      })
      expect(recording.tables['orders']?.added).toMatchObject([{ payment_status: 'pending', payment_method: null, stripe_payment_intent_id: null }])
      // Held as T1 left it: the places taken, nothing confirmed or saved, only the order's creation on record.
      expect(recording.tables['sessions']?.changed).toEqual([{ id: ID.session, total_booked: [0, 2] }])
      expect(recording.tables['audit_log']?.added.map((row) => row['action'])).toEqual(['order.create'])
      expect(recording.stripeCalls.map((call) => call.method)).toEqual(['paymentIntents.create', 'paymentIntents.retrieve'])
    })

    it("an unclear answer to the reader's intent: the old order was rolled back; the new one is held pending with its claims, after one retry with the same key", async () => {
      const golden = readGolden('w11-reader-intent-unclear') as Recording
      expect(golden.results[0]).toMatchObject({ success: false, reason: 'reader_intent_failed', message: 'Failed to create PaymentIntent: An error occurred with our API.' })
      expect(golden.tables).toEqual({})
      const { recording, answers } = await runNew('w11-reader-intent-unclear')
      expect(answers[0]?.status).toBe(502)
      expect(answers[0]?.body).toMatchObject({
        ok: false,
        error: { code: 'PAYMENT_UNCONFIRMED', message: READER_INTENT_UNCONFIRMED_MESSAGE, details: { stage: 'payment', reason: 'payment_unconfirmed', orderId: expect.any(String) } },
      })
      expect(recording.stripeCalls.map((call) => [call.method, call.idempotencyKey])).toEqual([
        ['paymentIntents.create', 'orders#1:reader-intent'],
        ['paymentIntents.create', 'orders#1:reader-intent'],
      ])
      expect(recording.stripeCalls[1]?.params).toEqual(recording.stripeCalls[0]?.params)
      // Pending, its record without an intent, the places and the store credit still held.
      expect(recording.tables['orders']?.added).toMatchObject([{ payment_status: 'pending', payment_method: null }])
      expect((recording.tables['orders']?.added[0] as { reader_payment: Record<string, unknown> }).reader_payment).not.toHaveProperty('payment_intent_id')
      expect(recording.tables['sessions']?.changed).toEqual([{ id: ID.session, total_booked: [0, 2] }])
      expect(recording.tables['customers']?.changed).toEqual([{ id: ID.customer, store_credit_balance: ['30.00', '20.00'] }])
      expect(recording.tables['audit_log']?.added.map((row) => row['action'])).toEqual(['order.create'])
    })
  })

  describe('W11: row order', () => {
    it("the reader order's rows keep createOrder's order, and its audit rows come create, then paid", async () => {
      const { recording } = await runNew('w11-reader-every-kind')
      const lines = recording.tables['order_line_items']
      expect(lines?.tied).toBe(0)
      expect(lines?.added.map((line) => line['item_type'])).toEqual(['booking', 'event', 'addon', 'product', 'session_pass', 'gift_card'])
      expect(recording.tables['booking_guests']?.tied).toBe(0)
      expect(recording.tables['event_attendees']?.tied).toBe(0)
      expect(recording.tables['audit_log']?.added.map((row) => row['action'])).toEqual(['order.create', 'order.paid'])
    })

    it('a card saved at finalise: order.paid, then customer.card_saved', async () => {
      const { recording } = await runNew('w11-reader-save-card-reusable')
      expect(recording.tables['audit_log']?.tied).toBe(0)
      expect(recording.tables['audit_log']?.added.map((row) => row['action'])).toEqual(['order.create', 'order.paid', 'customer.card_saved'])
    })

    it('cancelled: create, then undo', async () => {
      const { recording } = await runNew('w11-reader-cancelled-every-kind-with-all-three')
      expect(recording.tables['audit_log']?.added.map((row) => row['action'])).toEqual(['order.create', 'order.undo'])
    })
  })

  describe('W07: row order', () => {
    it('every kind of line in createOrder\'s order, and the booking line among them', async () => {
      const lines = (await runNew('w07-every-kind-in-cash')).recording.tables['order_line_items']
      expect(lines?.tied).toBe(0)
      expect(lines?.added.map((line) => line['item_type'])).toEqual(['booking', 'addon', 'product', 'session_pass', 'gift_card'])
    })

    it('a buy-new pass comes before the booking it pays for, and postage last', async () => {
      const { recording } = await runNew('w07-worst-basket')
      expect(recording.tables['order_line_items']?.tied).toBe(0)
      expect(recording.tables['order_line_items']?.added.map((line) => line['item_type'])).toEqual(['session_pass', 'booking', 'product', 'product', 'gift_card', 'postage'])
      expect(recording.tables['stock_adjustments']?.tied).toBe(0)
      expect(recording.tables['stock_adjustments']?.added.map((row) => row['variant_id'])).toEqual([ID.candleVariant, ID.mugVariant])
    })

    it('two lines of one variant: two ledger rows in line order, one claim', async () => {
      const { recording } = await runNew('w07-two-lines-of-one-variant-take-the-last-stock')
      expect(recording.tables['stock_adjustments']?.added.map((row) => row['change_amount'])).toEqual([-2, -3])
      expect(recording.tables['product_variants']?.changed).toEqual([{ id: ID.variant, stock_quantity: [5, 0] }])
    })
  })

  describe('W08: row order', () => {
    it('the attendees in place order, the account holder first though listed second, none tied', async () => {
      const { recording } = await runNew('w08-event-account-holder-listed-second')
      expect(recording.tables['event_attendees']?.tied).toBe(0)
      expect(recording.tables['event_attendees']?.added.map((row) => [row['attendee_type'], row['name']])).toEqual([
        ['account_holder', 'Sam Test'],
        ['guest', 'Alex Guest'],
      ])
    })

    it("the event's line after the booking's, before the add-ons, as createOrder wrote them", async () => {
      const lines = (await runNew('w08-every-kind-in-cash')).recording.tables['order_line_items']
      expect(lines?.tied).toBe(0)
      expect(lines?.added.map((line) => line['item_type'])).toEqual(['booking', 'event', 'addon', 'product', 'session_pass', 'gift_card'])
      expect(lines?.added[1]).toMatchObject({ event_booking_id: 'event_bookings#1', quantity: 2, unit_price: '40.00', line_total: '80.00' })
    })

    it('the worst basket: booking, event, product, gift card, postage; three attendees in place order', async () => {
      const { recording } = await runNew('w08-worst-basket')
      expect(recording.tables['order_line_items']?.added.map((line) => line['item_type'])).toEqual(['booking', 'event', 'product', 'gift_card', 'postage'])
      expect(recording.tables['event_attendees']?.tied).toBe(0)
      expect(recording.tables['event_attendees']?.added.map((row) => row['name'])).toEqual(['Sam Test', 'Alex Guest', 'Bea Guest'])
      expect(recording.tables['events']?.changed).toEqual([{ id: ID.event, places_booked: [0, 3] }])
    })
  })

  it('W13: nothing is left that the order route answers NOT_BUILT for', () => {
    expect(NOT_BUILT_SCENARIOS).toEqual({})
  })

  describe('W13: the Stripe calls, call by call', () => {
    /**
     * A call as both sides must make it: the subscription's request without `metadata.order_id` and with the
     * coupon named only as a coupon; the coupon's without its fixed id and `metadata.order_id`; the charge's
     * without `metadata` (the order's id); the reader's intent as it is. Keys are held below, step by step.
     */
    const normalised = (call: StripeCallRecord): unknown => {
      const params = JSON.parse(JSON.stringify(call.params ?? null)) as Record<string, unknown> & { metadata?: Record<string, unknown>; discounts?: Array<{ coupon: string }> }
      if (call.method === 'subscriptions.create') {
        delete params.metadata?.['order_id']
        if (params.discounts) params.discounts = params.discounts.map(() => ({ coupon: '<the coupon>' }))
      }
      if (call.method === 'coupons.create') {
        delete params['id']
        delete params.metadata?.['order_id']
      }
      if (call.method === 'paymentIntents.create' && params['confirm'] === true) delete params.metadata
      return { method: call.method, params }
    }
    const made = (recording: Recording, method: string) => recording.stripeCalls.filter((call) => call.method === method && (method !== 'paymentIntents.create' || (call.params as { confirm?: boolean }).confirm === true || Array.isArray((call.params as { payment_method_types?: unknown }).payment_method_types)))

    // Where both sides made a subscription (Q3 the other way round, and the refused ones, have their own tests).
    const both = W13_SCENARIOS.filter((name) => {
      const golden = readGolden(name) as Recording | null
      // Q8 the old cancel refused: createOrder never reached the charge (its own test below).
      return Boolean(golden?.stripeCalls.some((call) => call.method === 'subscriptions.create')) && !OUTCOME_DIFFERS.includes(name) && !['w13-card-declined-then-retried', 'w13-card-old-cancel-refused'].includes(name)
    })

    it.each(both)("%s: the subscription, the coupon, the charge and the reader's intent are the old requests (Q1/Q2's coupon amount aside)", async (name) => {
      const golden = readGolden(name) as Recording
      const { recording } = await runNew(name)
      for (const method of ['subscriptions.create', 'paymentIntents.create']) {
        expect(made(recording, method).map(normalised), method).toEqual(made(golden, method).map(normalised))
      }
      const coupon = (r: Recording) => made(r, 'coupons.create').map(normalised) as Array<{ params: Record<string, unknown> }>
      const spillFixed = name === 'q1-postage-before-the-spill' || name === 'q2-standalone-addon-before-the-spill'
      expect(coupon(recording).map((c) => ({ ...c.params, ...(spillFixed ? { amount_off: '<Q1/Q2>' } : {}) }))).toEqual(coupon(golden).map((c) => ({ ...c.params, ...(spillFixed ? { amount_off: '<Q1/Q2>' } : {}) })))
    })

    it("the saved card's steps in the Worker's order, each money call under the order's key (Q8: the old subscription cancelled last, with no key: a DELETE)", async () => {
      const { recording, answers } = await runNew('w13-card-replace-exhausted-with-a-paid-guest')
      const orderId = (answers[0]?.body as { ok: true; data: { orderId: string } }).data.orderId
      void orderId
      expect(recording.stripeCalls.map((call) => [call.method, call.idempotencyKey])).toEqual([
        ['prices.retrieve', null],
        ['customers.update', null],
        ['subscriptions.create', 'orders#1:subscription'],
        ['paymentIntents.create', 'orders#1:charge'],
        ['subscriptions.cancel', null],
      ])
      // createOrder cancelled the old subscription before the charge.
      expect((readGolden('w13-card-replace-exhausted-with-a-paid-guest') as Recording).stripeCalls.map((call) => call.method)).toEqual([
        'prices.retrieve',
        'customers.update',
        'subscriptions.create',
        'subscriptions.cancel',
        'paymentIntents.create',
      ])
    })

    it('the compensation: the new subscription cancelled, then each payment refunded in full under <orderId>:refund-subscription and :refund-charge', async () => {
      const declined = { recording: withCanonicalGoneNumbers((await runNew('w13-card-charge-declined-after-the-subscription')).recording) }
      expect(declined.recording.stripeCalls.slice(4).map((call) => [call.method, call.idempotencyKey, call.params])).toEqual([
        ['subscriptions.cancel', null, { id: 'sub_fake_0003' }],
        ['refunds.create', 'orders#1:refund-subscription', { payment_intent: 'pi_fake_0001', metadata: { order_id: 'orders#1', refund_key: 'orders#1:refund-subscription', reason: 'membership_not_set_up' } }],
      ].map(([method, key, params]) => [method, key === null ? null : String(key).replace('orders#1', 'gone#1'), JSON.parse(JSON.stringify(params).replaceAll('orders#1', 'gone#1'))]))
      const refused = { recording: withCanonicalGoneNumbers((await runNew('w13-card-old-cancel-refused')).recording) }
      expect(refused.recording.stripeCalls.map((call) => [call.method, call.idempotencyKey])).toEqual([
        ['prices.retrieve', null],
        ['customers.update', null],
        ['subscriptions.create', 'gone#1:subscription'],
        ['paymentIntents.create', 'gone#1:charge'],
        ['subscriptions.cancel', null],
        ['subscriptions.retrieve', null],
        ['subscriptions.cancel', null],
        ['refunds.create', 'gone#1:refund-subscription'],
        ['refunds.create', 'gone#1:refund-charge'],
      ])
    })

    it("the reader's steps: the price before the tap; at finalise the card, the price again, the coupon covering the tap, the subscription", async () => {
      const { recording } = await runNew('w13-reader-replace-an-exhausted-membership')
      expect(recording.stripeCalls.map((call) => [call.method, call.idempotencyKey])).toEqual([
        ['prices.retrieve', null],
        ['paymentIntents.create', 'orders#1:reader-intent'],
        ['paymentIntents.retrieve', null],
        ['paymentIntents.retrieve', null],
        ['prices.retrieve', null],
        ['customers.update', null],
        ['coupons.create', 'orders#1:coupon'],
        ['subscriptions.create', 'orders#1:subscription'],
        ['subscriptions.cancel', null],
      ])
      // finaliseReaderOrder cancelled the old subscription first, before the subscription.
      expect((readGolden('w13-reader-replace-an-exhausted-membership') as Recording).stripeCalls.map((call) => call.method).slice(3, 5)).toEqual(['subscriptions.cancel', 'prices.retrieve'])
    })
  })

  describe('W13: the outcomes decisions change', () => {
    const answer = (answers: OrderAnswer[], i = 0) => answers[i]?.body as { ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string; details: Record<string, unknown> } }

    it("Stripe's price isn't the plan's: createOrder charged Stripe's £45 silently; the Worker refuses before anything is taken", async () => {
      expect((readGolden('w13-card-stripe-price-differs') as Recording).results[0]).toMatchObject({ success: true, membershipAmountPaid: 45 })
      const { recording, answers } = await runNew('w13-card-stripe-price-differs')
      expect(answer(answers).error).toMatchObject({ details: { reason: 'membership_price_mismatch' } })
      expect(recording.stripeCalls.map((call) => call.method)).toEqual(['prices.retrieve'])
      expect(Object.keys(recording.tables).sort()).toEqual(['api_idempotency', 'audit_log'])
    })

    it('an archived price: createOrder failed at the subscription with Stripe\'s words; the Worker refuses at the price check, before the default card', async () => {
      expect((readGolden('w13-card-stripe-price-archived') as Recording).results[0]).toMatchObject({ success: false, reason: 'membership_subscription_failed' })
      const { recording, answers } = await runNew('w13-card-stripe-price-archived')
      expect(answer(answers).error).toMatchObject({ details: { reason: 'membership_price_inactive' } })
      expect(recording.stripeCalls.map((call) => call.method)).toEqual(['prices.retrieve'])
    })

    it('no clear answer from the subscription: createOrder rolled back; the Worker sends it once more with the same key, then holds the order with its claims', async () => {
      const { recording, answers } = await runNew('w13-card-subscription-unclear')
      expect(answer(answers).error).toMatchObject({ code: 'PAYMENT_UNCONFIRMED', details: { reason: 'payment_unconfirmed' } })
      expect(recording.stripeCalls.filter((call) => call.method === 'subscriptions.create').map((call) => call.idempotencyKey)).toEqual(['orders#1:subscription', 'orders#1:subscription'])
      expect(recording.tables['orders']?.added).toMatchObject([{ payment_status: 'pending' }])
      expect(recording.tables['product_variants']?.changed).toEqual([{ id: ID.variant, stock_quantity: [5, 3] }])
    })

    it('bug 13: createOrder refused the second press too (Stripe replayed the decline under the basket\'s key); the Worker\'s second press is a new order and goes through', async () => {
      const golden = readGolden('w13-card-declined-then-retried') as Recording
      expect(golden.results).toMatchObject([{ success: false, reason: 'membership_payment_failed' }, { success: false, reason: 'membership_payment_failed' }])
      expect(golden.stripeCalls.filter((call) => call.method === 'subscriptions.create').map((call) => call.idempotencyKey)).toEqual(['replay-membership-key', 'replay-membership-key'])
      const run = await runNew('w13-card-declined-then-retried')
      const { answers } = run
      const recording = withCanonicalGoneNumbers(run.recording)
      expect(answer(answers, 0).error).toMatchObject({ details: { reason: 'membership_payment_failed' } })
      expect(answer(answers, 1).ok).toBe(true)
      const keys = recording.stripeCalls.filter((call) => call.method === 'subscriptions.create').map((call) => call.idempotencyKey)
      expect(keys).toEqual(['gone#1:subscription', 'orders#1:subscription'])
      expect(recording.tables['customer_memberships']?.added).toHaveLength(1)
    })

    it.each(['q3-reader-buy-new-pass-with-a-membership', 'w13-reader-buy-new-pass-event-and-membership'])(
      '%s (Q3): finaliseReaderOrder found no membership line, refunded the tap and rolled back; the Worker sells the pass and the membership',
      async (name) => {
        expect((readGolden(name) as Recording).results[1]).toMatchObject({ finalised: false, reason: 'finalise_failed' })
        const { recording, answers } = await runNew(name)
        expect(answer(answers, 1).data).toMatchObject({ finalised: true, membershipId: expect.any(String) })
        expect(recording.tables['customer_memberships']?.added).toHaveLength(1)
        expect(recording.tables['customer_session_passes']?.added).toHaveLength(1)
        expect(recording.tables['order_line_items']?.added.map((line) => line['item_type']).slice(0, 3)).toEqual(['membership', 'session_pass', 'booking'])
      }
    )

    it.each(['q3-buy-new-pass-with-a-membership', 'w13-card-buy-new-pass-event-and-membership'])('%s (Q3): createOrder sold the pass alone; the Worker sells the membership too, its subscription and the pass', async (name) => {
      expect((readGolden(name) as Recording).tables['customer_memberships']).toBeUndefined()
      const { recording, answers } = await runNew(name)
      expect(answer(answers).data).toMatchObject({ membershipId: expect.any(String), sessionPassId: expect.any(String) })
      expect(recording.stripeCalls.map((call) => call.method)).toEqual(['prices.retrieve', 'customers.update', 'subscriptions.create', 'paymentIntents.create'])
    })
  })

  describe('W13: row order', () => {
    it("a buy-new membership's line and row come before the booking that draws on it; the audit rows come create, then paid", async () => {
      const { recording } = await runNew('buy-new-membership-covers-the-seat')
      expect(recording.tables['order_line_items']?.tied).toBe(0)
      expect(recording.tables['order_line_items']?.added.map((line) => line['item_type'])).toEqual(['membership', 'booking'])
      expect(recording.tables['audit_log']?.added.map((row) => row['action'])).toEqual(['order.create', 'order.paid'])
    })
  })
})
