import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type Stripe from 'stripe'
import type { Db, SqlParam, Tx } from '@/server/db'
import { fakeStripeErrors, type FakeStripe } from '@/server/stripe/fake'
import { oldSide, replay, startReplay, type ReplayEnvironment } from '@/server/rules/testing/replay/harness'
import { orderInput, postOrder, postReaderStep, withQuotedCardFigure, type OrderAnswer } from '@/server/rules/testing/replay/order-side'
import { ID, paidSeat, sam, seed, seedAllAccess, seedExhaustedMembership, whileFailing } from '@/server/rules/testing/replay/scenarios'
import { replayStripe, stripeCallsTakeASecond } from '@/server/rules/testing/replay/stripe-binding'
import type { FinaliseReaderOrderOutput } from '@/contracts'
import {
  SUBSCRIPTION_STARTING_MESSAGE,
  COMPENSATION_HELD_MESSAGE,
  MEMBERSHIP_UNCONFIRMED_MESSAGE,
  OLD_MEMBERSHIP_CANCELLED_NOTE,
  ORDER_STILL_PROCESSING_MESSAGE,
  PAID_NOT_FINISHED_MESSAGE,
  PAYMENT_UNCONFIRMED_MESSAGE,
  REPLACED_UNCONFIRMED_MESSAGE,
} from './failure-messages'
import { cancelSubscriptionChecked, COMPENSATED_NOTE, compensateOrder, couponId, findOrderSubscriptions, LEFT_AT_T2, markCompensating, type SubscriptionPutBackReason } from './membership'
import { finaliseOrder } from './finalise-order'
import type { PendingSnapshot } from './pending-order'
import { placeOrder } from './place-order'
import { finaliseReaderOrder } from './reader-order'
import { MANUAL_LIMITS, reconcile, SCHEDULED_LIMITS, type ReconcileOptions, type ReconcileResult } from './reconcile'
import { MEMBERSHIP_STUCK_NOTE, REFUND_FAILED_WORDS, stuckList, SUBSCRIPTION_LEFT_WORDS } from './stuck-list'
import { undoOrder } from './undo-order'

// W13: memberships through the real order, finalise, cancel and reconcile routes, on PGlite with the live
// schema and the replay seed, FakeStripe for Stripe (no real Stripe call: the test guard fails any). The
// saved card: T1, the price check, the coupon, the subscription, the charge, the old subscription cancelled
// last (Q8), T2. The reader: T1, the price check, the intent; at finalise the card, the price, the coupon
// covering the tap, the subscription, Q8, T2. Every failure kind after the subscription or a payment exists
// (W11 review L3): definite compensates and undoes; a database fault holds for reconcile; unclear holds.
// Races on real Postgres are in membership-postgres.test.ts.

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))
vi.mock('@/server/stripe/client', async (importOriginal) => {
  const { stripeClientMock } = await import('@/server/rules/testing/replay/stripe-binding')
  return stripeClientMock(await importOriginal<typeof import('@/server/stripe/client')>())
})

let environment: ReplayEnvironment
let db: Db
beforeAll(async () => {
  process.env.STAFF_API_KEY = 'test-staff-api-key'
  environment = await startReplay()
  db = environment.database.db
  holder.db = db
})
afterAll(() => environment.stop())

// --- Baskets, on the seed's saved card (cus_seed, pm_seed) and its Core plan (£40 a month, Stripe's price_seed_monthly)

const soap = { productVariantId: ID.variant, quantity: 2, unitPrice: 12 }
const alex = { name: 'Alex Guest', email: 'alex@example.com' }
const monthly = { membershipPlanId: ID.plan, membershipBillingFrequency: 'monthly' }
const core = (payment: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ customerId: ID.customer, ...monthly, ...extra, payment })
/** The Core membership (£40 first invoice) and two soaps (£24 on the card): Q21's two charges. */
const withSoap = core({ method: 'card' }, { products: [soap] })
/** A buy-new booking for two: Sam's seat on the new membership's credit, Alex's £20 on the card. */
const buyNew = core({ method: 'card' }, { booking: { ...paidSeat([sam, alex]), redemptionSource: 'buy_new_membership' } })
/** Replacing Sam's exhausted membership (Q8), with Alex's £20 seat on the card. */
const replacing = core({ method: 'card' }, { booking: { ...paidSeat([sam, alex]), redemptionSource: 'buy_new_membership', cancelExhaustedMembershipId: ID.exhausted } })
const onTheReader = (extra: Record<string, unknown> = {}) => core({ method: 'reader', readerSaveCard: true }, extra)

const asSystem: ReconcileOptions = { actor: { type: 'system', id: null }, requestId: 'membership-test', ...SCHEDULED_LIMITS }
const runReconcile = (stripe: FakeStripe): Promise<ReconcileResult> => reconcile(db, stripe, asSystem)
const later = (minutes: number) => vi.setSystemTime(Date.now() + minutes * 60_000)
const place = async (params: Record<string, unknown>, key?: string): Promise<OrderAnswer> => postOrder(await withQuotedCardFigure(orderInput(params)), key ? { key } : {})
const errorOf = (answer: OrderAnswer) => (answer.body.ok ? null : answer.body.error)
const dataOf = (answer: OrderAnswer) => {
  if (!answer.body.ok) throw new Error(`refused: ${answer.body.error.code} ${answer.body.error.message}`)
  return answer.body.data
}

async function onASeed(work: (stripe: FakeStripe) => Promise<void>, prepare?: (seedDb: Db, stripe: FakeStripe) => Promise<void>): Promise<void> {
  await replay(
    environment,
    {
      name: 'membership test',
      async seed(seedDb, stripe) {
        await seed(seedDb, stripe)
        await prepare?.(seedDb, stripe)
      },
      async run({ stripe }) {
        replayStripe.current = stripe
        stripeCallsTakeASecond(stripe)
        await work(stripe)
      },
    },
    (_db, stripe) => ({ name: 'test', call: async () => stripe })
  )
}

const orders = async () =>
  db.query<{ id: string; payment_status: string; stripe_payment_intent_id: string | null; payment_method: string | null; reader_payment: PendingSnapshot | null }>(
    'SELECT id, payment_status, stripe_payment_intent_id, payment_method, reader_payment FROM orders ORDER BY created_at'
  )
const memberships = async () =>
  db.query<{ id: string; stripe_subscription_id: string | null; subscription_status: string; order_line_item_id: string | null; start_date: string; next_renewal_date: string; is_herd: boolean; addon_credits_remaining: number }>(
    `SELECT id, stripe_subscription_id, subscription_status, order_line_item_id, start_date::text, next_renewal_date::text, is_herd, addon_credits_remaining
     FROM customer_memberships WHERE customer_id = $1 ORDER BY created_at, id`,
    [ID.customer]
  )
const auditOf = async (orderId: string) =>
  (await db.query<{ action: string }>('SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY at, id', [orderId])).map((row) => row.action)

/** The places, stock, store credit and gift card an order can hold. Back to these = given back. */
async function held() {
  const places = (await db.query<{ n: number }>('SELECT total_booked AS n FROM sessions WHERE id = $1', [ID.session]))[0]?.n
  const stock = (await db.query<{ n: number }>('SELECT stock_quantity AS n FROM product_variants WHERE id = $1', [ID.variant]))[0]?.n
  const credit = (await db.query<{ n: string }>('SELECT store_credit_balance::text AS n FROM customers WHERE id = $1', [ID.customer]))[0]?.n
  const giftCard = (await db.query<{ n: string }>('SELECT remaining_balance::text AS n FROM gift_cards WHERE id = $1', [ID.giftCard]))[0]?.n
  return { places, stock, credit, giftCard }
}
const NOTHING_HELD = { places: 0, stock: 5, credit: '30.00', giftCard: '40.00' }

/**
 * The invariant every crash test ends on (brief W13): no money without an order, no order without money,
 * no live subscription without a membership row (and no membership without its subscription), nothing held.
 */
async function invariant(stripe: FakeStripe): Promise<void> {
  const all = await orders()
  expect(all.filter((order) => order.payment_status === 'pending'), 'nothing held pending').toEqual([])
  const paid = all.filter((order) => order.payment_status === 'paid')
  const net = new Map([...stripe.chargedByIntent].map(([id, pence]) => [id, pence - (stripe.refundedByIntent.get(id) ?? 0)]))
  // Every PaymentIntent that kept money belongs to a paid order: as its own (the charge, the tap, or the first
  // invoice when there is no charge), or as the first invoice of the subscription a paid order's membership has.
  const rows = await memberships()
  const subscriptionOf = new Map(rows.filter((row) => row.stripe_subscription_id).map((row) => [row.stripe_subscription_id as string, row]))
  for (const [id, pence] of net) {
    if (pence <= 0) continue
    const own = paid.filter((order) => order.stripe_payment_intent_id === id)
    const asInvoice = paid.filter((order) => order.reader_payment?.membership?.subscription_payment_intent_id === id)
    expect(own.length + asInvoice.length, `money kept on ${id} has no paid order`).toBeGreaterThanOrEqual(1)
  }
  for (const order of paid) {
    if (order.stripe_payment_intent_id) expect(net.get(order.stripe_payment_intent_id) ?? 0, `paid order ${order.id} has no money`).toBeGreaterThan(0)
  }
  // Every live subscription has its membership row, and every membership a paid order bought has its subscription, live.
  for (const id of stripe.liveSubscriptions) expect(subscriptionOf.get(id), `live subscription ${id} has no membership row`).toBeDefined()
  for (const row of rows) {
    if (row.order_line_item_id) expect(stripe.subscription(row.stripe_subscription_id ?? '')?.status, `membership ${row.id} has no live subscription`).toBe('active')
  }
  if (all.length === 0) expect(await held()).toEqual(NOTHING_HELD)
}

/** A Stripe whose `resource.method` call takes effect (or not) and then never answers: the Worker died there. */
function dyingOn(stripe: FakeStripe, resource: 'paymentIntents' | 'subscriptions' | 'coupons' | 'prices', method: string, when: 'before' | 'after'): { client: FakeStripe; died: Promise<void> } {
  let dead: () => void = () => undefined
  const died = new Promise<void>((resolve) => {
    dead = resolve
  })
  const client = Object.create(stripe) as FakeStripe
  const original = stripe[resource] as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
  Object.defineProperty(client, resource, {
    value: {
      ...original,
      [method]: async (...args: unknown[]) => {
        if (when === 'after') await (original[method] as (...a: unknown[]) => Promise<unknown>)(...args)
        dead()
        return new Promise<never>(() => undefined)
      },
    },
  })
  return { client, died }
}

const calls = (stripe: FakeStripe) => stripe.calls.map((call) => [call.method, call.idempotencyKey])

describe('the saved card: a membership goes through', () => {
  it("the price, the default card, the subscription under the order's key, then the rest of the basket charged; T2 writes the membership (Q21: two charges)", async () => {
    await onASeed(async (stripe) => {
      const answer = await place(withSoap)
      const data = dataOf(answer)
      const orderId = data.orderId
      expect(calls(stripe)).toEqual([
        ['prices.retrieve', null],
        ['customers.update', null],
        ['subscriptions.create', `${orderId}:subscription`],
        ['paymentIntents.create', `${orderId}:charge`],
      ])
      const subscriptionCall = stripe.calls[2]?.params as Stripe.SubscriptionCreateParams
      expect(subscriptionCall.metadata).toEqual({ supabase_customer_id: ID.customer, membership_plan_id: ID.plan, billing_frequency: 'monthly', order_id: orderId })
      expect(subscriptionCall.discounts).toBeUndefined()
      const subscriptionId = stripe.subscriptionsMade.at(-1) as string
      expect(data).toMatchObject({ status: 'paid', membershipId: expect.any(String), membershipSubscription: { subscriptionId, amountPaid: 40 }, payment: { method: 'card', collected: 64, cardCharged: true } })
      expect(stripe.netPence).toBe(6400)
      const [order] = await orders()
      expect(order).toMatchObject({ payment_status: 'paid', payment_method: 'card' })
      expect(order?.reader_payment?.membership).toMatchObject({ subscription_id: subscriptionId, first_invoice: 40, coupon_amount: 0 })
      // The order records the charge (what refunds go against), as createOrder did.
      expect(order?.stripe_payment_intent_id).toBe(order?.reader_payment && 'charge_payment_intent_id' in order.reader_payment ? order.reader_payment.charge_payment_intent_id : 'none')
      expect(await memberships()).toEqual([
        expect.objectContaining({ id: data.membershipId, stripe_subscription_id: subscriptionId, subscription_status: 'active', start_date: '2026-11-10', next_renewal_date: '2026-12-10', is_herd: false }),
      ])
      expect(await auditOf(orderId)).toEqual(['order.create', 'order.paid'])
      await invariant(stripe)
    })
  })

  it('a gift card and store credit pay the soap first, then part of the first payment: the fixed coupon covers that part, under its key', async () => {
    await onASeed(async (stripe) => {
      const data = dataOf(await place(core({ method: 'card', giftCard: { giftCardId: ID.giftCard, amount: 20 }, storeCredit: { amount: 10 } }, { products: [soap] })))
      const coupon = stripe.coupon(couponId(data.orderId))
      // £24 of soap, then £6 of the £40 first payment: the coupon is £6, the first invoice £34, nothing else on the card.
      expect(coupon).toMatchObject({ id: `order-${data.orderId}`, amount_off: 600, currency: 'gbp', duration: 'once', name: 'Gift card / store credit', metadata: { order_id: data.orderId } })
      expect(stripe.calls.find((call) => call.method === 'coupons.create')?.idempotencyKey).toBe(`${data.orderId}:coupon`)
      expect(calls(stripe).map(([method]) => method)).toEqual(['prices.retrieve', 'customers.update', 'coupons.create', 'subscriptions.create'])
      expect(data).toMatchObject({ payment: { method: 'split', collected: 34 }, membershipSubscription: { amountPaid: 34 } })
      // No charge of its own: the order records the first invoice's PaymentIntent, as createOrder did.
      const [order] = await orders()
      expect(order?.stripe_payment_intent_id).toBe(order?.reader_payment?.membership?.subscription_payment_intent_id)
      await invariant(stripe)
    })
  })

  it('everything covered by a gift card and store credit: a £0 first invoice, no PaymentIntent at all, the order paid', async () => {
    await onASeed(async (stripe) => {
      const data = dataOf(await place(core({ method: 'card', giftCard: { giftCardId: ID.giftCard, amount: 20 }, storeCredit: { amount: 20 } })))
      expect(stripe.coupon(couponId(data.orderId))?.amount_off).toBe(4000)
      expect(stripe.chargedByIntent.size).toBe(0)
      expect((await orders())[0]).toMatchObject({ payment_status: 'paid', stripe_payment_intent_id: null, payment_method: 'split' })
      await invariant(stripe)
    })
  })

  it('buy-new (Q3, bug 5): T1 writes the membership row and its credit period so the booking can draw it; T2 patches the subscription onto that row', async () => {
    await onASeed(async (stripe) => {
      const data = dataOf(await place(buyNew))
      const [row] = await memberships()
      expect(row).toMatchObject({ id: data.membershipId, stripe_subscription_id: stripe.subscriptionsMade.at(-1), subscription_status: 'active' })
      const booking = (await db.query<{ redeemed_membership_id: string; credit_period_id: string; redemption_source: string }>('SELECT redeemed_membership_id, credit_period_id, redemption_source FROM bookings'))[0]
      expect(booking).toMatchObject({ redeemed_membership_id: row?.id, redemption_source: 'membership_credit' })
      const period = (await db.query<{ membership_id: string }>('SELECT membership_id FROM membership_credit_periods WHERE id = $1', [booking?.credit_period_id]))[0]
      expect(period?.membership_id).toBe(row?.id)
      // Brief W13 item 6: the record carries the key's mode and the booking as T1 wrote it, as a card order's does.
      expect((await orders())[0]?.reader_payment).toMatchObject({ livemode: false, held_booking: { session_id: ID.session, party_size: 2 }, membership: { membership_row_id: row?.id } })
      expect(stripe.netPence).toBe(6000)
      await invariant(stripe)
    })
  })

  it('a pending buy-new order: the row is active with no subscription until T2, and the undo removes it with its period', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('subscriptions.create', { kind: 'unreachable' })
      stripe.failNext('subscriptions.create', { kind: 'unreachable' })
      const answer = await place(buyNew)
      expect(errorOf(answer)).toMatchObject({ code: 'PAYMENT_UNCONFIRMED', message: MEMBERSHIP_UNCONFIRMED_MESSAGE })
      expect(await memberships()).toEqual([expect.objectContaining({ stripe_subscription_id: null, subscription_status: 'active' })])
      const [order] = await orders()
      expect(await undoOrder(db, order?.id as string, { actor: { type: 'system', id: null }, requestId: 'test', why: 'test' })).toEqual({ undone: true })
      expect(await memberships()).toEqual([])
      expect((await db.query<{ n: number }>('SELECT count(*)::int AS n FROM membership_credit_periods')).at(0)?.n).toBe(1)
    })
  })

  it('Q3: a buy-new membership booking with a pass chosen too writes both (createOrder wrote no pass); a buy-new pass booking with a membership too sells the membership', async () => {
    await onASeed(async (stripe) => {
      const data = dataOf(await place(core({ method: 'card' }, { booking: { ...paidSeat([sam]), redemptionSource: 'buy_new_membership' }, sessionPassTypeId: ID.passType })))
      expect(data.sessionPassId).toEqual(expect.any(String))
      expect(data.membershipId).toEqual(expect.any(String))
      expect(stripe.netPence).toBe(9000)
      await invariant(stripe)
    })
    await onASeed(async (stripe) => {
      const data = dataOf(await place(core({ method: 'card' }, { booking: { ...paidSeat([sam]), redemptionSource: 'buy_new_session_pass' }, sessionPassTypeId: ID.passType })))
      expect(data.membershipId).toEqual(expect.any(String))
      expect(data.sessionPassId).toEqual(expect.any(String))
      expect(stripe.netPence).toBe(9000)
      await invariant(stripe)
    })
  })

  it('All-Access yearly: the yearly price, Herd from the start, its add-on credits', async () => {
    await onASeed(
      async (stripe) => {
        const data = dataOf(await place(core({ method: 'card' }, { membershipPlanId: '10000000-0000-4000-8000-000000000a13', membershipBillingFrequency: 'yearly' })))
        expect((stripe.calls[2]?.params as Stripe.SubscriptionCreateParams).items).toEqual([{ price: 'price_seed_all_access_yearly' }])
        expect(await memberships()).toEqual([expect.objectContaining({ id: data.membershipId, is_herd: true, addon_credits_remaining: 4, next_renewal_date: '2027-11-10' })])
        await invariant(stripe)
      },
      seedAllAccess
    )
  })
})

describe('the confirmed first invoice (W03-plan 2.7)', () => {
  it('missing or different: refused before anything is written, with the changed figure, and Stripe never called', async () => {
    await onASeed(async (stripe) => {
      const quoted = await withQuotedCardFigure(orderInput(withSoap))
      const missing = await postOrder({ ...quoted, confirmed: { toCollect: quoted.confirmed?.toCollect ?? 0 } })
      expect(errorOf(missing)).toMatchObject({ code: 'TOTAL_CHANGED', message: 'The amount due has changed to £40.00. Check it with the customer and confirm again.', details: { reason: 'amount_changed' } })
      const wrong = await postOrder({ ...quoted, confirmed: { ...quoted.confirmed, firstInvoice: 30 } })
      expect(errorOf(wrong)).toMatchObject({ code: 'TOTAL_CHANGED', details: { reason: 'amount_changed' } })
      expect(stripe.calls).toEqual([])
      expect(await orders()).toEqual([])
    })
  })
})

describe("Q10: a membership counts as something to charge", () => {
  it('a second card order while a membership order is held is refused first, with nothing written', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('subscriptions.create', { kind: 'unreachable' })
      stripe.failNext('subscriptions.create', { kind: 'unreachable' })
      expect(errorOf(await place(withSoap))).toMatchObject({ code: 'PAYMENT_UNCONFIRMED' })
      const second = await place(core({ method: 'card', giftCard: { giftCardId: ID.giftCard, amount: 40 } }))
      expect(errorOf(second)).toMatchObject({ code: 'VALIDATION', message: ORDER_STILL_PROCESSING_MESSAGE })
      expect(await orders()).toHaveLength(1)
    })
  })
})

describe("Stripe's price (W03-plan 2.7): refused before anything is taken", () => {
  const refused = async (prepare: (stripe: FakeStripe) => void, reason: string, message: RegExp) => {
    await onASeed(async (stripe) => {
      prepare(stripe)
      const answer = await place(withSoap)
      expect(errorOf(answer)).toMatchObject({ details: { reason } })
      expect(errorOf(answer)?.message).toMatch(message)
      expect(calls(stripe).map(([method]) => method)).toEqual(['prices.retrieve'])
      expect(await orders()).toEqual([])
      expect(await held()).toEqual(NOTHING_HELD)
      expect(stripe.subscriptionsMade).toEqual([])
    })
  }
  it("Stripe's amount isn't the plan's", () => refused((stripe) => stripe.addPrice('price_seed_monthly', 4500, 'month'), 'membership_price_mismatch', /£45\.00, but the plan charges £40\.00/))
  it('archived', () => refused((stripe) => stripe.addPrice('price_seed_monthly', 4000, 'month', 'gbp', false), 'membership_price_inactive', /archived/))
  it('not a recurring monthly gbp price', () => refused((stripe) => stripe.addPrice('price_seed_monthly', 4000, 'year'), 'membership_price_not_recurring', /isn't a recurring price of the right interval/))
  it('in euros', () => refused((stripe) => stripe.addPrice('price_seed_monthly', 4000, 'month', 'eur'), 'membership_price_not_recurring', /recurring price/))
  it('missing in Stripe (the old words)', () => refused((stripe) => stripe.failNext('prices.retrieve', { kind: 'error', error: fakeStripeErrors.missing("price: 'price_seed_monthly'") }), 'membership_subscription_failed', /^Failed to verify Stripe price$/))
  it('no answer (nothing taken, so refused rather than held)', () => refused((stripe) => stripe.failNext('prices.retrieve', { kind: 'unreachable' }), 'membership_subscription_failed', /^Failed to verify Stripe price$/))

  it('no Stripe price for the frequency: refused inside T1 (plan_not_synced), Stripe never called', async () => {
    await onASeed(async (stripe) => {
      await db.query('UPDATE membership_plans SET stripe_price_id = NULL WHERE id = $1', [ID.plan])
      const answer = await place(withSoap)
      expect(errorOf(answer)).toMatchObject({ details: { reason: 'membership_plan_not_synced' } })
      expect(stripe.calls).toEqual([])
      expect(await orders()).toEqual([])
    })
  })
})

describe('the subscription refused, or no clear answer', () => {
  it('declined: nothing was made or taken, the coupon removed, the order undone, the old words', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('subscriptions.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
      // £30 of store credit: the soap's £24, then £6 off the first payment, so there is a coupon to remove.
      const answer = await place(core({ method: 'card', storeCredit: { amount: 30 } }, { products: [soap] }))
      expect(errorOf(answer)).toMatchObject({
        code: 'PAYMENT_FAILED',
        message: "The customer's card was declined when Stripe tried to take the first membership payment. No money was taken and nothing was recorded — use a different card or retry.",
        details: { reason: 'membership_payment_failed' },
      })
      expect(stripe.calls.map((call) => call.method)).toEqual(['prices.retrieve', 'customers.update', 'coupons.create', 'subscriptions.create', 'coupons.del'])
      expect(await orders()).toEqual([])
      expect(await held()).toEqual(NOTHING_HELD)
    })
  })

  it('an invalid request: Stripe\'s own words (the old route\'s `unexpected`)', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('subscriptions.create', { kind: 'error', error: fakeStripeErrors.invalid('resource_missing', "No such customer: 'cus_seed'") })
      expect(errorOf(await place(withSoap))).toMatchObject({ message: "No such customer: 'cus_seed'", details: { reason: 'membership_subscription_failed' } })
      expect(await orders()).toEqual([])
    })
  })

  it('no clear answer twice: held pending with its claims, never undone, never charged; PAYMENT_UNCONFIRMED', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('subscriptions.create', { kind: 'error', error: fakeStripeErrors.server() })
      const answer = await place(withSoap)
      expect(errorOf(answer)).toMatchObject({ code: 'PAYMENT_UNCONFIRMED', message: MEMBERSHIP_UNCONFIRMED_MESSAGE })
      // The same key twice (Stripe kept the 500 against it); no charge sent.
      const orderId = (errorOf(answer)?.details as { orderId: string }).orderId
      expect(calls(stripe).slice(2)).toEqual([
        ['subscriptions.create', `${orderId}:subscription`],
        ['subscriptions.create', `${orderId}:subscription`],
      ])
      expect((await orders())[0]).toMatchObject({ payment_status: 'pending' })
      expect(await held()).toMatchObject({ stock: 3 })
    })
  })

  it('made, but the answer lost: the second send with the same key gets the same subscription (one made, one first invoice)', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('subscriptions.create', { kind: 'lost_response' })
      const data = dataOf(await place(withSoap))
      expect(stripe.subscriptionsMade).toHaveLength(1)
      expect(stripe.netPence).toBe(6400)
      expect(data.membershipSubscription?.subscriptionId).toBe(stripe.subscriptionsMade[0])
      await invariant(stripe)
    })
  })
})

describe('bug 13: a decline, then pressing again in the same dialog', () => {
  it('the declined order is undone, so the second press is a new order: new keys, a new coupon id, and it goes through', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('subscriptions.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
      // £30 of store credit: the soap's £24, then £6 off the first payment (a coupon each time).
      const basket = core({ method: 'card', storeCredit: { amount: 30 } }, { products: [soap] })
      const first = await place(basket)
      expect(errorOf(first)).toMatchObject({ details: { reason: 'membership_payment_failed' } })
      expect(await held()).toEqual(NOTHING_HELD)
      const second = dataOf(await place(basket))
      const keys = stripe.calls.map((call) => call.idempotencyKey).filter(Boolean)
      const firstOrder = keys[0]?.split(':')[0] as string
      expect(firstOrder).not.toBe(second.orderId)
      expect(keys).toEqual([`${firstOrder}:coupon`, `${firstOrder}:subscription`, `${second.orderId}:coupon`, `${second.orderId}:subscription`])
      // The first coupon was removed with its refused order; the second has the new order's own id.
      expect(stripe.coupon(couponId(firstOrder))).toBeNull()
      expect(stripe.coupon(couponId(second.orderId))?.amount_off).toBe(600)
      expect(stripe.liveSubscriptions).toEqual([second.membershipSubscription?.subscriptionId])
      await invariant(stripe)
    })
  })
})

describe('definite after the subscription exists (W11 review L3): compensate, then undo', () => {
  it('the rest of the basket declined: the subscription cancelled and its first invoice refunded under <orderId>:refund-subscription, then the undo; the old words with the old note', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('paymentIntents.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
      const answer = await place(withSoap)
      expect(errorOf(answer)).toMatchObject({ code: 'PAYMENT_FAILED', message: `Failed to charge saved card: Your card was declined. ${COMPENSATED_NOTE}`, details: { reason: 'charge_failed' } })
      const subscriptionId = stripe.subscriptionsMade[0] as string
      expect(stripe.subscription(subscriptionId)?.status).toBe('canceled')
      const refund = stripe.calls.find((call) => call.method === 'refunds.create')
      expect(refund?.idempotencyKey).toMatch(/:refund-subscription$/)
      expect(stripe.netPence).toBe(0)
      expect(await orders()).toEqual([])
      const audit = await db.query<{ action: string }>("SELECT action FROM audit_log WHERE action IN ('order.create', 'order.compensate', 'order.undo') ORDER BY at, id")
      expect(audit.map((row) => row.action)).toEqual(['order.create', 'order.compensate', 'order.undo'])
      await invariant(stripe)
    })
  })

  it("Stripe made a subscription that isn't what was asked (its price changed after the check): cancelled, refunded, undone", async () => {
    await onASeed(async (stripe) => {
      const retrieve = stripe.prices.retrieve
      stripe.prices.retrieve = async (...args) => {
        const answer = await retrieve(...args)
        stripe.addPrice('price_seed_monthly', 4500, 'month')
        return answer
      }
      const answer = await place(withSoap)
      // W14c (W13 review L4, W14b N3): a refusal after Stripe, after the compensation: PAYMENT_FAILED, not VALIDATION.
      expect(errorOf(answer)).toMatchObject({ code: 'PAYMENT_FAILED', details: { reason: 'membership_subscription_failed' } })
      expect(errorOf(answer)?.message).toContain('its first invoice was for 4500p, not 4000p')
      expect(stripe.netPence).toBe(0)
      expect(stripe.liveSubscriptions).toEqual([])
      expect(await orders()).toEqual([])
      await invariant(stripe)
    })
  })

  it('a refund that Stripe refuses: held, marked, listed; the next reconcile sends the same key again and finishes', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('paymentIntents.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
      stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.invalid('charge_disputed', 'This charge has been disputed.') })
      const answer = await place(withSoap)
      expect(errorOf(answer)).toMatchObject({ code: 'PAYMENT_UNCONFIRMED', message: COMPENSATION_HELD_MESSAGE, details: { reason: 'compensation_unfinished' } })
      const [order] = await orders()
      expect(order?.payment_status).toBe('pending')
      expect(order?.reader_payment?.compensation).toMatchObject({ why: expect.stringContaining('The card was refused after the subscription') })
      // T2 can never pay it now.
      expect(await auditOf(order?.id as string)).toEqual(['order.create', 'order.compensate'])
      later(16)
      expect((await stuckList(db)).checkout[0]?.words).toContain(MEMBERSHIP_STUCK_NOTE)
      // Stripe refused the key's first send for good (a refusal is saved against it), so the next run is
      // refused the same way: left for a person, never assumed refunded.
      expect(await runReconcile(stripe)).toMatchObject({ undone: 0, items: [{ outcome: 'left', reason: 'compensation_unfinished' }] })
      expect(stripe.refundedPence).toBe(0)
      // A person refunds it in Stripe: the key's saved refusal is gone after 24 hours; the next run finds it refunded.
      stripe.forgetIdempotencyKeys()
      expect(await runReconcile(stripe)).toMatchObject({ undone: 1 })
      await invariant(stripe)
    })
  })

  it('a cancel that Stripe refuses: held (never assumed cancelled), listed; reconcile cancels it next time and finishes', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('paymentIntents.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
      stripe.failNext('subscriptions.cancel', { kind: 'error', error: fakeStripeErrors.invalid('parameter_unknown', 'Received unknown parameter') })
      const answer = await place(withSoap)
      expect(errorOf(answer)).toMatchObject({ details: { reason: 'compensation_unfinished' } })
      expect(stripe.liveSubscriptions).toHaveLength(1)
      later(16)
      expect(await runReconcile(stripe)).toMatchObject({ undone: 1 })
      expect(stripe.liveSubscriptions).toEqual([])
      await invariant(stripe)
    })
  })

  it('a cancel with no clear answer, and the read back too: never assumed cancelled; held', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('paymentIntents.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
      stripe.failNext('subscriptions.cancel', { kind: 'unreachable' })
      stripe.failNext('subscriptions.retrieve', { kind: 'unreachable' })
      const answer = await place(withSoap)
      expect(errorOf(answer)).toMatchObject({ details: { reason: 'compensation_unfinished' } })
      expect((await orders())[0]?.payment_status).toBe('pending')
      later(16)
      expect(await runReconcile(stripe)).toMatchObject({ undone: 1 })
      await invariant(stripe)
    })
  })

  it('cancelSubscriptionChecked: a cancel that failed but the subscription reads cancelled counts as cancelled; one that reads active does not', async () => {
    await onASeed(async (stripe) => {
      stripe.addSubscription('sub_a', 'cus_seed', 'price_seed_monthly')
      stripe.failNext('subscriptions.cancel', { kind: 'lost_response' })
      expect(await cancelSubscriptionChecked(stripe, 'sub_a', undefined)).toEqual({ kind: 'cancelled' })
      stripe.addSubscription('sub_b', 'cus_seed', 'price_seed_monthly')
      stripe.failNext('subscriptions.cancel', { kind: 'unreachable' })
      expect(await cancelSubscriptionChecked(stripe, 'sub_b', undefined)).toMatchObject({ kind: 'unclear' })
      expect(stripe.subscription('sub_b')?.status).toBe('active')
    })
  })
})

describe('Q8: the exhausted subscription cancelled last, once all the money is taken', () => {
  it('the order of the steps: subscription, charge, then the old cancel; T2 marks the old membership cancelled', async () => {
    await onASeed(
      async (stripe) => {
        const data = dataOf(await place(replacing))
        expect(calls(stripe).map(([method]) => method)).toEqual(['prices.retrieve', 'customers.update', 'subscriptions.create', 'paymentIntents.create', 'subscriptions.cancel'])
        // A DELETE: no key (Stripe ignores keys on DELETE).
        expect(stripe.calls.at(-1)).toEqual({ method: 'subscriptions.cancel', params: { id: 'sub_exhausted' }, idempotencyKey: null })
        expect(stripe.subscription('sub_exhausted')?.status).toBe('canceled')
        const rows = await memberships()
        expect(rows.find((row) => row.id === ID.exhausted)).toMatchObject({ subscription_status: 'cancelled', addon_credits_remaining: 0 })
        expect(rows.find((row) => row.id === data.membershipId)).toMatchObject({ subscription_status: 'active' })
        await invariant(stripe)
      },
      seedExhaustedMembership
    )
  })

  it('the old cancel refused: everything reversed (the new subscription cancelled, the charge and the first invoice refunded), undone; the old membership untouched', async () => {
    await onASeed(
      async (stripe) => {
        stripe.failNext('subscriptions.cancel', { kind: 'error', error: fakeStripeErrors.invalid('resource_missing', "No such subscription: 'sub_exhausted'") })
        const answer = await place(replacing)
        expect(errorOf(answer)).toMatchObject({ code: 'PAYMENT_FAILED', message: `Failed to cancel subscription: No such subscription: 'sub_exhausted' ${COMPENSATED_NOTE}`, details: { reason: 'membership_cancellation_failed' } })
        const refunds = stripe.calls.filter((call) => call.method === 'refunds.create').map((call) => call.idempotencyKey?.split(':')[1])
        expect(refunds.sort()).toEqual(['refund-charge', 'refund-subscription'])
        expect(stripe.netPence).toBe(0)
        expect((await memberships()).find((row) => row.id === ID.exhausted)).toMatchObject({ subscription_status: 'active' })
        expect(stripe.subscription('sub_exhausted')?.status).toBe('active')
        await invariant(stripe)
      },
      seedExhaustedMembership
    )
  })

  it('the old cancel with no clear answer: held (everything taken, not reversed, never assumed cancelled); reconcile cancels it and runs T2', async () => {
    await onASeed(
      async (stripe) => {
        stripe.failNext('subscriptions.cancel', { kind: 'unreachable' })
        stripe.failNext('subscriptions.retrieve', { kind: 'unreachable' })
        const answer = await place(replacing)
        expect(errorOf(answer)).toMatchObject({ code: 'PAYMENT_UNCONFIRMED', message: REPLACED_UNCONFIRMED_MESSAGE, details: { reason: 'replaced_unconfirmed' } })
        expect((await orders())[0]?.payment_status).toBe('pending')
        later(16)
        expect(await runReconcile(stripe)).toMatchObject({ finalised: 1 })
        expect(stripe.subscription('sub_exhausted')?.status).toBe('canceled')
        await invariant(stripe)
      },
      seedExhaustedMembership
    )
  })
})

describe('a database fault in T2 after everything was taken: held for reconcile, never refunded (W6-3)', () => {
  it('PAYMENT_UNCONFIRMED paid_not_finished; nothing refunded or cancelled; reconcile runs T2 again and the membership is written once', async () => {
    await onASeed(async (stripe) => {
      const answer = await whileFailing(db, { table: 'orders', event: 'UPDATE', when: "NEW.payment_status = 'paid'" }, () => place(withSoap))
      expect(errorOf(answer)).toMatchObject({ code: 'PAYMENT_UNCONFIRMED', message: PAID_NOT_FINISHED_MESSAGE })
      expect(stripe.refundedPence).toBe(0)
      expect(stripe.liveSubscriptions).toHaveLength(1)
      expect(await memberships()).toEqual([])
      later(16)
      expect(await runReconcile(stripe)).toMatchObject({ finalised: 1 })
      expect(await memberships()).toHaveLength(1)
      await invariant(stripe)
    })
  })

  it('a rule the data breaks in T2 (no membership line to hang the membership on): definite, compensated and undone', async () => {
    await onASeed(async (stripe) => {
      const answer = await whileFailing(db, { table: 'orders', event: 'UPDATE', when: "NEW.payment_status = 'paid'" }, () => place(withSoap))
      expect(errorOf(answer)).toMatchObject({ code: 'PAYMENT_UNCONFIRMED', message: PAID_NOT_FINISHED_MESSAGE })
      // While it is held, the line goes (test data only): T2 now has nothing to write the membership against.
      await db.query("DELETE FROM order_line_items WHERE item_type = 'membership'")
      later(16)
      expect(await runReconcile(stripe)).toMatchObject({ undone: 1 })
      expect(stripe.netPence).toBe(0)
      expect(stripe.liveSubscriptions).toEqual([])
      await invariant(stripe)
    })
  })
})

describe('W03a later 5 (R5): the buy-new row T1 wrote not as T2 expects it', () => {
  it("T2 refuses (membership_row_missing) and writes nothing: no order completes with a subscription its membership row doesn't carry", async () => {
    await onASeed(async (stripe) => {
      const answer = await whileFailing(db, { table: 'orders', event: 'UPDATE', when: "NEW.payment_status = 'paid'" }, () => place(buyNew))
      const orderId = (errorOf(answer)?.details as { orderId: string }).orderId
      await db.query("UPDATE customer_memberships SET stripe_subscription_id = 'sub_someone_else' WHERE stripe_subscription_id IS NULL AND order_line_item_id IS NOT NULL")
      const found = await findOrderSubscriptions(stripe, undefined, 'cus_seed', orderId)
      if (found.kind !== 'found') throw new Error('unclear')
      const charge = (await stripe.paymentIntents.list({ customer: 'cus_seed' })).data.find((intent) => intent.metadata?.['order_id'] === orderId) ?? null
      expect(await finaliseOrder(db, orderId, charge, { actor: { type: 'system', id: null }, requestId: 'r5', subscription: found.subscriptions[0] ?? null })).toEqual({ finalised: false, reason: 'membership_row_missing' })
      expect((await orders())[0]).toMatchObject({ payment_status: 'pending' })
    })
  })
})

describe('the compensation mark: T2 and the undo refuse a marked order for good', () => {
  it('T2 with a good subscription and charge answers compensating and writes nothing; the plain undo answers compensating too', async () => {
    await onASeed(async (stripe) => {
      const answer = await whileFailing(db, { table: 'orders', event: 'UPDATE', when: "NEW.payment_status = 'paid'" }, () => place(withSoap))
      const orderId = (errorOf(answer)?.details as { orderId: string }).orderId
      expect(await markCompensating(db, orderId, 'test')).toMatchObject({ marked: true })
      const found = await findOrderSubscriptions(stripe, undefined, 'cus_seed', orderId)
      if (found.kind !== 'found') throw new Error('unclear')
      const charge = (await stripe.paymentIntents.list({ customer: 'cus_seed' })).data.find((intent) => intent.metadata?.['order_id'] === orderId) ?? null
      expect(await finaliseOrder(db, orderId, charge, { actor: { type: 'system', id: null }, requestId: 'mark', subscription: found.subscriptions[0] ?? null })).toEqual({ finalised: false, reason: 'compensating' })
      expect(await undoOrder(db, orderId, { actor: { type: 'system', id: null }, requestId: 'mark', why: 'test' })).toEqual({ undone: false, reason: 'compensating' })
      expect((await orders())[0]).toMatchObject({ payment_status: 'pending' })
      expect(await memberships()).toEqual([])
    })
  })
})

describe('the reader', () => {
  const tapAndFinalise = async (stripe: FakeStripe, extra: Record<string, unknown> = {}, tap: { generatedCard?: string; simulatedReader?: boolean } = { generatedCard: 'pm_reader_saved' }) => {
    const placed = dataOf(await place(onTheReader(extra)))
    const intent = placed.pendingReaderPayment?.paymentIntentId as string
    stripe.completeReaderPayment(intent, tap)
    const finalised = await postReaderStep('finalise', placed.orderId)
    return { placed, intent, finalised: finalised.body.ok ? (finalised.body.data as unknown as FinaliseReaderOrderOutput) : null }
  }

  it("the price checked before the tap; at finalise the card saved, the price again, a coupon covering the tap's first payment, the subscription (£0 first invoice), then T2", async () => {
    await onASeed(async (stripe) => {
      const { placed, intent, finalised } = await tapAndFinalise(stripe)
      const orderId = placed.orderId
      expect(calls(stripe)).toEqual([
        ['prices.retrieve', null],
        ['paymentIntents.create', `${orderId}:reader-intent`],
        ['paymentIntents.retrieve', null],
        ['paymentIntents.retrieve', null],
        ['prices.retrieve', null],
        ['customers.update', null],
        ['coupons.create', `${orderId}:coupon`],
        ['subscriptions.create', `${orderId}:subscription`],
      ])
      expect(stripe.coupon(couponId(orderId))).toMatchObject({ amount_off: 4000, name: 'Paid on card reader' })
      expect((stripe.calls[7]?.params as Stripe.SubscriptionCreateParams).default_payment_method).toBe('pm_reader_saved')
      expect(finalised).toMatchObject({ finalised: true, paymentIntentId: intent, membershipSubscriptionId: stripe.subscriptionsMade[0], membershipId: expect.any(String) })
      expect(stripe.netPence).toBe(4000)
      const customer = (await db.query<{ saved_payment_method_id: string }>('SELECT saved_payment_method_id FROM customers WHERE id = $1', [ID.customer]))[0]
      expect(customer?.saved_payment_method_id).toBe('pm_reader_saved')
      await invariant(stripe)
    })
  })

  it("the card can't be saved (the simulated reader): the tap refunded under <orderId>:refund-reader, the mark written first, then the undo", async () => {
    await onASeed(async (stripe) => {
      const { placed, finalised } = await tapAndFinalise(stripe, {}, { simulatedReader: true })
      expect(finalised).toMatchObject({ finalised: false, reason: 'card_not_reusable' })
      expect(finalised?.message).toMatch(/^Saving the card for the membership failed: This card cannot be saved .* The customer's card has been refunded in full \(payment pi_fake_\d+\) and the order was rolled back\.$/)
      expect(stripe.calls.find((call) => call.method === 'refunds.create')?.idempotencyKey).toBe(`${placed.orderId}:refund-reader`)
      expect(stripe.subscriptionsMade).toEqual([])
      expect(stripe.netPence).toBe(0)
      expect(await orders()).toEqual([])
      await invariant(stripe)
    })
  })

  it("the tap's refund refused: held and marked; a later reconcile (the refusal no longer saved against the key) finishes the refund and the undo", async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.invalid('charge_disputed', 'This charge has been disputed.') })
      const { finalised } = await tapAndFinalise(stripe, {}, { simulatedReader: true })
      expect(finalised).toMatchObject({ finalised: false, reason: 'compensation_unfinished' })
      expect((await orders())[0]?.reader_payment?.compensation).toBeDefined()
      later(16)
      stripe.forgetIdempotencyKeys()
      expect(await runReconcile(stripe)).toMatchObject({ undone: 1 })
      await invariant(stripe)
    })
  })

  it('the mark is written and committed before the refund is sent', async () => {
    await onASeed(async (stripe) => {
      const placed = dataOf(await place(onTheReader()))
      stripe.completeReaderPayment(placed.pendingReaderPayment?.paymentIntentId as string, { simulatedReader: true })
      let markedAtRefund: unknown = null
      const create = stripe.refunds.create
      stripe.refunds.create = async (...args) => {
        markedAtRefund = (await orders())[0]?.reader_payment?.compensation ?? null
        return create(...args)
      }
      await postReaderStep('finalise', placed.orderId)
      expect(markedAtRefund).toMatchObject({ why: expect.stringContaining("The card couldn't be saved") })
    })
  })

  it('a buy-new booking on the reader: T1 writes the row (no subscription), finalise patches it', async () => {
    await onASeed(async (stripe) => {
      const { placed, finalised } = await tapAndFinalise(stripe, { booking: { ...paidSeat([sam, alex]), redemptionSource: 'buy_new_membership' } })
      expect(placed.membershipId).toEqual(expect.any(String))
      expect(finalised).toMatchObject({ finalised: true, membershipId: placed.membershipId })
      expect(await memberships()).toEqual([expect.objectContaining({ id: placed.membershipId, stripe_subscription_id: stripe.subscriptionsMade[0] })])
      await invariant(stripe)
    })
  })

  it("Q8 on the reader: the subscription first, then the old cancel refused: the tap refunded, the new subscription cancelled, undone", async () => {
    await onASeed(
      async (stripe) => {
        stripe.failNext('subscriptions.cancel', { kind: 'error', error: fakeStripeErrors.invalid('resource_missing', "No such subscription: 'sub_exhausted'") })
        const { finalised } = await tapAndFinalise(stripe, { booking: { ...paidSeat([sam]), redemptionSource: 'buy_new_membership', cancelExhaustedMembershipId: ID.exhausted } })
        expect(finalised).toMatchObject({ finalised: false, reason: 'exhausted_membership_cancellation_failed' })
        expect(stripe.liveSubscriptions).toEqual(['sub_exhausted'])
        expect(stripe.netPence).toBe(0)
        await invariant(stripe)
      },
      seedExhaustedMembership
    )
  })

  it('the subscription with no clear answer: held (the tap kept, never refunded); reconcile finds the subscription and finishes', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('subscriptions.create', { kind: 'lost_response' })
      stripe.failNext('subscriptions.create', { kind: 'unreachable' })
      const { finalised } = await tapAndFinalise(stripe)
      expect(finalised).toMatchObject({ finalised: false, reason: 'subscription_unconfirmed', message: MEMBERSHIP_UNCONFIRMED_MESSAGE })
      expect(stripe.netPence).toBe(4000)
      later(16)
      expect(await runReconcile(stripe)).toMatchObject({ finalised: 1 })
      expect(stripe.subscriptionsMade).toHaveLength(1)
      await invariant(stripe)
    })
  })

  it('cancelled before the tap: the undo removes the buy-new row; no subscription was ever made', async () => {
    await onASeed(async (stripe) => {
      const placed = dataOf(await place(onTheReader({ booking: { ...paidSeat([sam]), redemptionSource: 'buy_new_membership' } })))
      const cancelled = await postReaderStep('cancel', placed.orderId)
      expect(cancelled.body).toMatchObject({ ok: true, data: { cancelled: true } })
      expect(await memberships()).toEqual([])
      expect(stripe.subscriptionsMade).toEqual([])
      await invariant(stripe)
    })
  })

  it("Stripe's price wrong: refused before the tap is asked for (undone, no intent)", async () => {
    await onASeed(async (stripe) => {
      stripe.addPrice('price_seed_monthly', 4500, 'month')
      const answer = await place(onTheReader())
      expect(errorOf(answer)).toMatchObject({ details: { reason: 'membership_price_mismatch' } })
      expect(calls(stripe).map(([method]) => method)).toEqual(['prices.retrieve'])
      expect(await orders()).toEqual([])
    })
  })
})

describe('reconcile for membership orders (W12-8): list by customer, match metadata.order_id, never start a charge or a subscription', () => {
  it('nothing found (the Worker died before the subscription was sent): the undo', async () => {
    await onASeed(async (stripe) => {
      const dying = dyingOn(stripe, 'subscriptions', 'create', 'before')
      replayStripe.current = dying.client
      void place(withSoap)
      await dying.died
      replayStripe.current = stripe
      later(16)
      expect(await runReconcile(stripe)).toMatchObject({ undone: 1 })
      const list = stripe.calls.find((call) => call.method === 'subscriptions.list')
      expect(list?.params).toMatchObject({ customer: 'cus_seed', status: 'all' })
      await invariant(stripe)
    })
  })

  it('part done (subscription yes, charge no): compensated and undone; reconcile never sends the charge', async () => {
    await onASeed(async (stripe) => {
      const dying = dyingOn(stripe, 'paymentIntents', 'create', 'before')
      replayStripe.current = dying.client
      void place(withSoap)
      await dying.died
      replayStripe.current = stripe
      later(16)
      expect(await runReconcile(stripe)).toMatchObject({ undone: 1 })
      expect(stripe.calls.filter((call) => call.method === 'paymentIntents.create')).toHaveLength(0)
      expect(stripe.calls.find((call) => call.method === 'refunds.create')?.idempotencyKey).toMatch(/:refund-subscription$/)
      await invariant(stripe)
    })
  })

  it('everything succeeded (the Worker died after the charge): T2', async () => {
    await onASeed(async (stripe) => {
      const dying = dyingOn(stripe, 'paymentIntents', 'create', 'after')
      replayStripe.current = dying.client
      void place(withSoap)
      await dying.died
      replayStripe.current = stripe
      later(16)
      expect(await runReconcile(stripe)).toMatchObject({ finalised: 1 })
      expect(stripe.netPence).toBe(6400)
      await invariant(stripe)
    })
  })

  it('a reader membership tapped but never finalised, no subscription: the tap refunded and the order undone (no subscription started)', async () => {
    await onASeed(async (stripe) => {
      const placed = dataOf(await place(onTheReader()))
      stripe.completeReaderPayment(placed.pendingReaderPayment?.paymentIntentId as string, { generatedCard: 'pm_reader_saved' })
      later(16)
      expect(await runReconcile(stripe)).toMatchObject({ undone: 1 })
      expect(stripe.subscriptionsMade).toEqual([])
      expect(stripe.netPence).toBe(0)
      await invariant(stripe)
    })
  })

  it('a reader membership whose finalise died after the subscription: reconcile finds it, cancels nothing, runs T2', async () => {
    await onASeed(async (stripe) => {
      const placed = dataOf(await place(onTheReader()))
      stripe.completeReaderPayment(placed.pendingReaderPayment?.paymentIntentId as string, { generatedCard: 'pm_reader_saved' })
      const dying = dyingOn(stripe, 'subscriptions', 'create', 'after')
      replayStripe.current = dying.client
      void postReaderStep('finalise', placed.orderId)
      await dying.died
      replayStripe.current = stripe
      later(16)
      expect(await runReconcile(stripe)).toMatchObject({ finalised: 1 })
      expect(stripe.subscriptionsMade).toHaveLength(1)
      await invariant(stripe)
    })
  })
})

describe('crash tests with a subscription taken: the Worker died at each step, then reconcile', () => {
  const settle = async (stripe: FakeStripe, expected: Partial<ReconcileResult>) => {
    later(16)
    expect(await runReconcile(stripe)).toMatchObject(expected)
    await invariant(stripe)
  }
  const diedAt = async (stripe: FakeStripe, resource: 'paymentIntents' | 'subscriptions' | 'coupons', method: string, when: 'before' | 'after', basket: Record<string, unknown>) => {
    const dying = dyingOn(stripe, resource, method, when)
    replayStripe.current = dying.client
    void place(basket)
    await dying.died
    replayStripe.current = stripe
  }
  // A promo code: a coupon (its share of the first payment) and a charge (the soap, less its share), both.
  const withCoupon = core({ method: 'card' }, { products: [soap], promoCode: 'ALLTEN' })

  it('after the coupon, before the subscription was sent: undone (a coupon holds no money)', async () => {
    await onASeed(async (stripe) => {
      await diedAt(stripe, 'subscriptions', 'create', 'before', withCoupon)
      await settle(stripe, { undone: 1 })
    })
  })
  it('after the subscription, before the charge: compensated and undone', async () => {
    await onASeed(async (stripe) => {
      await diedAt(stripe, 'paymentIntents', 'create', 'before', withCoupon)
      await settle(stripe, { undone: 1 })
    })
  })
  it('after the charge, before the old cancel: the old cancel sent, then T2', async () => {
    await onASeed(
      async (stripe) => {
        await diedAt(stripe, 'subscriptions', 'cancel', 'before', replacing)
        await settle(stripe, { finalised: 1 })
        expect(stripe.subscription('sub_exhausted')?.status).toBe('canceled')
      },
      seedExhaustedMembership
    )
  })
  it('after the old cancel, before T2: T2 (the old subscription read as cancelled)', async () => {
    await onASeed(
      async (stripe) => {
        await diedAt(stripe, 'subscriptions', 'cancel', 'after', replacing)
        await settle(stripe, { finalised: 1 })
      },
      seedExhaustedMembership
    )
  })
  it('in T2 (a database fault): finalised again', async () => {
    await onASeed(async (stripe) => {
      const answer = await whileFailing(db, { table: 'orders', event: 'UPDATE', when: "NEW.payment_status = 'paid'" }, () => place(replacing))
      expect(errorOf(answer)).toMatchObject({ code: 'PAYMENT_UNCONFIRMED' })
      await settle(stripe, { finalised: 1 })
    }, seedExhaustedMembership)
  })
  it('during the compensation (after the subscription was cancelled, before the refund): marked, so T2 can never pay it; reconcile finishes the refund and the undo', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('paymentIntents.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
      // The decline comes from the fake; the Worker then dies on the refund.
      const refunds = stripe.refunds.create
      let died: () => void = () => undefined
      const gone = new Promise<void>((resolve) => {
        died = resolve
      })
      stripe.refunds.create = async () => {
        died()
        return new Promise<never>(() => undefined)
      }
      void place(withSoap)
      await gone
      stripe.refunds.create = refunds
      const [order] = await orders()
      expect(order?.reader_payment?.compensation).toBeDefined()
      expect(stripe.liveSubscriptions).toEqual([])
      await settle(stripe, { undone: 1 })
    })
  })
})

describe("the press's deadline (Retool's 60 s): every Stripe call of a saved-card membership answered by 25 s from the request's start", () => {
  const staff = { actor: { type: 'staff' as const, id: ID.staff }, requestId: 'deadline-test' }
  const quoted = async () => withQuotedCardFigure(orderInput(withSoap))

  it('no time left for the price check: not sent, refused with nothing taken', async () => {
    await onASeed(async (stripe) => {
      const input = await quoted()
      await expect(placeOrder(db, input, { ...staff, stripe: () => stripe, startedAt: Date.now() - 24_000 })).rejects.toMatchObject({ details: { reason: 'membership_subscription_failed' } })
      expect(stripe.calls).toEqual([])
      expect(await orders()).toEqual([])
    })
  })

  it("the subscription made with little time left: the charge isn't sent (its first send is bounded too), and the compensation isn't started either: held for reconcile, which puts it back", async () => {
    await onASeed(async (stripe) => {
      const input = await quoted()
      // 22.5 s gone of the membership's 25; the subscription takes a second (stripeCallsTakeASecond): 1.5 s left, under the 2 s a send needs.
      await expect(placeOrder(db, input, { ...staff, stripe: () => stripe, startedAt: Date.now() - 22_500 })).rejects.toMatchObject({ code: 'PAYMENT_UNCONFIRMED', details: { reason: 'compensation_unfinished' } })
      expect(stripe.calls.map((call) => call.method)).toEqual(['prices.retrieve', 'customers.update', 'subscriptions.create'])
      // Not started: no mark (its statement could run past the deadline), no held row; reconcile starts it.
      const [order] = await orders()
      expect(order?.reader_payment?.compensation).toBeUndefined()
      expect(await auditOf(order?.id as string)).toEqual(['order.create'])
      later(16)
      expect(await runReconcile(stripe)).toMatchObject({ undone: 1 })
      await invariant(stripe)
    })
  })
})

describe('for the Worker step: the old createOrder when the subscription\'s answer is lost (F1)', () => {
  it('rolls the order back as a failure though Stripe made the subscription and took its first invoice: a live subscription with no membership, £40 kept', async () => {
    let fake: FakeStripe | null = null
    const answers: unknown[] = []
    const recording = await replay(
      environment,
      {
        name: 'old createOrder, subscription answer lost',
        async seed(seedDb, stripe) {
          await seed(seedDb, stripe)
          stripe.failNext('subscriptions.create', { kind: 'lost_response' })
        },
        async run({ call, stripe }) {
          fake = stripe
          answers.push(await call('createOrder', { ...withSoap, membershipIdempotencyKey: 'basket-1' }))
        },
      },
      oldSide
    )
    expect(answers[0]).toMatchObject({ success: false, reason: 'membership_subscription_failed' })
    const stripe = fake as unknown as FakeStripe
    expect(stripe.liveSubscriptions).toHaveLength(1)
    expect(stripe.netPence).toBe(4000)
    expect(recording.tables['customer_memberships']).toBeUndefined()
    expect(recording.tables['orders']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------------------------------
// W13a: the W13 review's fixes (B1, S1 to S4, L1), each ending on the invariant where money moved.

/** A reader membership placed and tapped with a reusable card. */
async function tapped(stripe: FakeStripe, extra: Record<string, unknown> = {}) {
  const placed = dataOf(await place(onTheReader(extra)))
  const intent = placed.pendingReaderPayment?.paymentIntentId as string
  stripe.completeReaderPayment(intent, { generatedCard: 'pm_reader_saved' })
  return { placed, orderId: placed.orderId, intent }
}

/** Holds the next call of `target[method]` until released: `reached` once it is called. */
function holdNext(target: object, method: string): { reached: Promise<void>; release: () => void } {
  let reach: () => void = () => undefined
  const reached = new Promise<void>((resolve) => {
    reach = resolve
  })
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const methods = target as Record<string, (...args: unknown[]) => Promise<unknown>>
  const original = methods[method] as (...args: unknown[]) => Promise<unknown>
  let waiting = true
  methods[method] = async (...args: unknown[]) => {
    if (waiting) {
      waiting = false
      reach()
      await gate
    }
    return original(...args)
  }
  return { reached, release }
}

/** Runs `then` after every call of `target[method]` that `when` picks (test data changes at a precise point). */
function after(target: object, method: string, then: () => Promise<unknown>, when: (args: unknown[]) => boolean = () => true): void {
  const methods = target as Record<string, (...args: unknown[]) => Promise<unknown>>
  const original = methods[method] as (...args: unknown[]) => Promise<unknown>
  methods[method] = async (...args: unknown[]) => {
    const answer = await original(...args)
    if (when(args)) await then()
    return answer
  }
}

/** Test data only: the pending order's membership no longer what its subscription was made for (T2 would refuse it). */
const tamperMembership = () =>
  db.query(`UPDATE orders SET reader_payment = jsonb_set(reader_payment, '{membership,stripe_price_id}', '"price_tampered"') WHERE payment_status = 'pending'`)

/** A database on which every statement `fails` picks is refused, inside a transaction or not (a database fault). */
function failingStatement(base: Db, fails: (sql: string) => boolean): Db {
  const refuse = <Row,>(sql: string, run: () => Promise<Row[]>): Promise<Row[]> => (fails(sql) ? Promise.reject(new Error('test: the statement failed')) : run())
  return {
    query: <Row,>(sql: string, params?: readonly SqlParam[]) => refuse(sql, () => base.query<Row>(sql, params)),
    close: () => base.close(),
    transaction: <T,>(fn: (tx: Tx) => Promise<T>) =>
      base.transaction((tx) =>
        fn(
          new Proxy(tx, {
            get(target, property) {
              if (property === 'query') return <Row,>(sql: string, params?: readonly SqlParam[]) => refuse(sql, () => target.query<Row>(sql, params))
              const value: unknown = Reflect.get(target, property)
              return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
            },
          })
        )
      ),
  }
}

/** A database whose compensation mark takes `ms` on the test clock (W13a S3). */
function slowMark(base: Db, ms: number): Db {
  return {
    query: <Row,>(sql: string, params?: readonly SqlParam[]) => base.query<Row>(sql, params),
    close: () => base.close(),
    transaction: <T,>(fn: (tx: Tx) => Promise<T>) =>
      base.transaction((tx) =>
        fn(
          new Proxy(tx, {
            get(target, property) {
              if (property === 'query') {
                return async <Row,>(sql: string, params?: readonly SqlParam[]) => {
                  if (sql.includes("jsonb_build_object('compensation'")) vi.setSystemTime(Date.now() + ms)
                  return target.query<Row>(sql, params)
                }
              }
              const value: unknown = Reflect.get(target, property)
              return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
            },
          })
        )
      ),
  }
}

const subscriptionLeftRows = async (orderId: string) =>
  (await db.query<{ details: Record<string, unknown> }>("SELECT details FROM audit_log WHERE action = 'order.subscription_left' AND entity_id = $1 ORDER BY at", [orderId])).map((row) => row.details)

/**
 * W13c (S1b): T2 records the subscription its press made as left, in its own transaction, then (with time to send)
 * the put-back writes what it confirmed. In either order: the test clock stands still, so the two rows can carry the
 * same time (the stuck list closes a warning on a row of the same time or later).
 */
function expectLeftThenPutBack(rows: Array<Record<string, unknown>>, made: string, found: SubscriptionPutBackReason, state: 'cancelled' | 'left'): void {
  expect(rows).toHaveLength(2)
  expect(rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ state: 'left', subscriptionId: made, found, left: [LEFT_AT_T2] }),
      expect.objectContaining({ state, subscriptionId: made, found, ...(state === 'left' ? { left: [expect.stringContaining(`subscription ${made}: unclear`)] } : {}) }),
    ])
  )
}

describe('W13a B1: the screen finalise of a reader membership racing reconcile', () => {
  it("P1: reconcile runs while the screen is making the subscription: reconcile leaves the order (a press is starting it, its start under 2 minutes old), the screen finishes; never a live subscription without its row", async () => {
    await onASeed(async (stripe) => {
      const { orderId } = await tapped(stripe)
      // The customer tapped late in the 15 minutes; the screen's finalise lands as the 5-minute reconcile runs.
      later(15.5)
      const held = holdNext(stripe.subscriptions, 'create')
      const screen = postReaderStep('finalise', orderId)
      await held.reached
      const ran = await runReconcile(stripe)
      expect(ran).toMatchObject({ undone: 0, finalised: 0, refunds: 0, items: [{ id: orderId, outcome: 'left', reason: 'subscription_starting' }] })
      expect(stripe.refundedPence).toBe(0)
      expect((await orders())[0]?.reader_payment?.compensation).toBeUndefined()
      expect((await stuckList(db)).checkout[0]).toMatchObject({ orderId, reason: 'subscription_starting' })
      held.release()
      expect((await screen).body).toMatchObject({ ok: true, data: { finalised: true, membershipSubscriptionId: stripe.subscriptionsMade[0] } })
      // The next runs find nothing to do: paid, its subscription live with its row.
      later(16)
      expect(await runReconcile(stripe)).toMatchObject({ undone: 0, refunds: 0 })
      expect(stripe.netPence).toBe(4000)
      await invariant(stripe)
    })
  })

  it("reconcile marks first (the screen still at its price check): the screen's start is refused, so it makes no subscription; reconcile has refunded the tap and undone the order", async () => {
    await onASeed(async (stripe) => {
      const { orderId } = await tapped(stripe)
      later(15.5)
      const held = holdNext(stripe.prices, 'retrieve')
      const screen = postReaderStep('finalise', orderId)
      await held.reached
      expect(await runReconcile(stripe)).toMatchObject({ undone: 1 })
      held.release()
      expect((await screen).body).toMatchObject({ ok: true, data: { finalised: false, reason: 'compensation_unfinished' } })
      expect(stripe.calls.filter((call) => call.method === 'subscriptions.create')).toEqual([])
      expect(stripe.subscriptionsMade).toEqual([])
      expect(stripe.netPence).toBe(0)
      await invariant(stripe)
    })
  })

  it("the order marked (still pending) while the screen is at its price check: the start's write refuses it, so no subscription is made", async () => {
    await onASeed(async (stripe) => {
      const { orderId } = await tapped(stripe)
      const held = holdNext(stripe.prices, 'retrieve')
      const screen = postReaderStep('finalise', orderId)
      await held.reached
      expect(await markCompensating(db, orderId, 'test: a compensation started meanwhile')).toMatchObject({ marked: true })
      held.release()
      expect((await screen).body).toMatchObject({ ok: true, data: { finalised: false, reason: 'compensation_unfinished' } })
      expect(stripe.calls.filter((call) => call.method === 'subscriptions.create')).toEqual([])
      expect((await orders())[0]?.reader_payment?.membership?.subscription_started_at).toBeUndefined()
      later(16)
      expect(await runReconcile(stripe)).toMatchObject({ undone: 1 })
      await invariant(stripe)
    })
  })

  it('two finalise presses at once, the first finishing before the second writes its start: the second answers already finalised and sends nothing more', async () => {
    await onASeed(async (stripe) => {
      const { orderId, intent } = await tapped(stripe)
      const held = holdNext(stripe.prices, 'retrieve')
      const second = postReaderStep('finalise', orderId)
      await held.reached
      expect((await postReaderStep('finalise', orderId)).body).toMatchObject({ ok: true, data: { finalised: true } })
      const before = stripe.calls.length
      held.release()
      expect((await second).body).toMatchObject({ ok: true, data: { finalised: true, alreadyFinalised: true, paymentIntentId: intent } })
      expect(stripe.calls.slice(before).map((call) => call.method)).toEqual(['prices.retrieve'])
      expect(stripe.subscriptionsMade).toHaveLength(1)
      await invariant(stripe)
    })
  })

  it("the press's start more than 2 minutes old and reconcile's first list missing its subscription: the mark goes on, Stripe is listed again, and the subscription it finds is cancelled with the tap refunded", async () => {
    await onASeed(async (stripe) => {
      const { orderId } = await tapped(stripe)
      // The screen made the subscription, then T2 failed (a database fault): held, the tap and the subscription kept.
      const answer = await whileFailing(db, { table: 'orders', event: 'UPDATE', when: "NEW.payment_status = 'paid'" }, () => postReaderStep('finalise', orderId))
      expect(answer.body).toMatchObject({ ok: true, data: { finalised: false, reason: 'finalise_failed' } })
      const made = stripe.subscriptionsMade[0] as string
      expect((await orders())[0]?.reader_payment?.membership?.subscription_started_at).toEqual(expect.any(String))
      later(16)
      // Reconcile's first list doesn't show it (as if Stripe's list lagged): only the list after the mark does.
      let lists = 0
      const list = stripe.subscriptions.list
      stripe.subscriptions.list = async (params, options) => {
        const page = await list(params, options)
        lists += 1
        return lists === 1 ? { ...page, data: [] } : page
      }
      expect(await runReconcile(stripe)).toMatchObject({ undone: 1 })
      expect(lists).toBe(2)
      expect(stripe.subscription(made)?.status).toBe('canceled')
      expect(stripe.netPence).toBe(0)
      await invariant(stripe)
    })
  })

  it("the reader's subscription declined: this press's own start never holds up its own compensation: the tap refunded, undone", async () => {
    await onASeed(async (stripe) => {
      const { orderId } = await tapped(stripe)
      stripe.failNext('subscriptions.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
      const finalised = await postReaderStep('finalise', orderId)
      expect(finalised.body).toMatchObject({ ok: true, data: { finalised: false, reason: 'subscription_failed', rolledBack: true } })
      expect(stripe.netPence).toBe(0)
      await invariant(stripe)
    })
  })

  it("(c) T2 finds the order gone after the screen made its subscription: cancelled at once and recorded; the tap's late refund counts the compensation's refund under its key as done, never sent again with other parameters", async () => {
    await onASeed(async (stripe) => {
      const { orderId, intent } = await tapped(stripe)
      const held = holdNext(stripe.subscriptions, 'create')
      const screen = postReaderStep('finalise', orderId)
      await held.reached
      // Something puts the order back meanwhile without waiting for the press (no Worker path now does).
      const putBack = await compensateOrder(db, stripe, orderId, { subscriptionId: null, refunds: [{ step: 'refund-reader', paymentIntentId: intent }] }, 'test: unguarded', { actor: { type: 'system', id: null }, requestId: 'b1c' }, undefined)
      expect(putBack).toMatchObject({ settled: true, undo: { undone: true } })
      held.release()
      expect((await screen).body).toMatchObject({ ok: true, data: { finalised: false, reason: 'charged_without_order' } })
      const made = stripe.subscriptionsMade[0] as string
      expect(stripe.subscription(made)?.status).toBe('canceled')
      expectLeftThenPutBack(await subscriptionLeftRows(orderId), made, 'order_gone', 'cancelled')
      later(16)
      expect((await runReconcile(stripe)).items).toEqual([expect.objectContaining({ kind: 'refund', outcome: 'refund_confirmed', detail: 'already refunded under its key' })])
      expect(stripe.calls.filter((call) => call.method === 'refunds.create').map((call) => call.idempotencyKey)).toEqual([`${orderId}:refund-reader`])
      const stuck = await stuckList(db)
      expect(stuck.warnings).toEqual([])
      expect(stuck.refunds).toEqual([])
      await invariant(stripe)
    })
  })

  it("(c) the cancel can't be confirmed: a row names the subscription, and the stuck list shows it", async () => {
    await onASeed(async (stripe) => {
      const { orderId, intent } = await tapped(stripe)
      const held = holdNext(stripe.subscriptions, 'create')
      const screen = postReaderStep('finalise', orderId)
      await held.reached
      await compensateOrder(db, stripe, orderId, { subscriptionId: null, refunds: [{ step: 'refund-reader', paymentIntentId: intent }] }, 'test: unguarded', { actor: { type: 'system', id: null }, requestId: 'b1c' }, undefined)
      stripe.failNext('subscriptions.cancel', { kind: 'unreachable' })
      stripe.failNext('subscriptions.retrieve', { kind: 'unreachable' })
      held.release()
      expect((await screen).body).toMatchObject({ ok: true, data: { finalised: false, reason: 'charged_without_order' } })
      const made = stripe.subscriptionsMade[0] as string
      expect(stripe.subscription(made)?.status).toBe('active')
      expectLeftThenPutBack(await subscriptionLeftRows(orderId), made, 'order_gone', 'left')
      expect((await stuckList(db)).warnings).toEqual([expect.objectContaining({ kind: 'order', id: orderId, warning: SUBSCRIPTION_LEFT_WORDS(made) })])
    })
  })

  it("(c) T2 finds the order marked: the subscription cancelled at once; reconcile finishes the compensation (the tap refunded) and the undo", async () => {
    await onASeed(async (stripe) => {
      const { orderId } = await tapped(stripe)
      const held = holdNext(stripe.subscriptions, 'create')
      const screen = postReaderStep('finalise', orderId)
      await held.reached
      expect(await markCompensating(db, orderId, 'test: marked meanwhile')).toMatchObject({ marked: true })
      held.release()
      expect((await screen).body).toMatchObject({ ok: true, data: { finalised: false, reason: 'compensation_unfinished' } })
      const made = stripe.subscriptionsMade[0] as string
      expect(stripe.subscription(made)?.status).toBe('canceled')
      expectLeftThenPutBack(await subscriptionLeftRows(orderId), made, 'compensating', 'cancelled')
      later(16)
      expect(await runReconcile(stripe)).toMatchObject({ undone: 1 })
      expect(stripe.netPence).toBe(0)
      await invariant(stripe)
    })
  })
})

describe("W13a S1: Stripe's minimum charge and the customer's Stripe balance (Stripe's handling stands, as createOrder allowed)", () => {
  it("P2: a first invoice for 20p (a £39.80 gift card): Stripe marks it paid with nothing taken and carries the 20p to the customer's balance; the order goes through, with no PaymentIntent recorded for the invoice", async () => {
    await onASeed(async (stripe) => {
      const data = dataOf(await place(core({ method: 'card', giftCard: { giftCardId: ID.giftCard, amount: 39.8 } })))
      const made = stripe.subscriptionsMade[0] as string
      expect(stripe.subscription(made)).toMatchObject({ status: 'active', total: 20, amountPaid: 0 })
      expect(stripe.customerBalance('cus_seed')).toBe(20)
      expect(data).toMatchObject({ status: 'paid', membershipSubscription: { subscriptionId: made, amountPaid: 0 } })
      const [order] = await orders()
      expect(order).toMatchObject({ payment_status: 'paid', stripe_payment_intent_id: null })
      expect(order?.reader_payment?.membership?.subscription_payment_intent_id).toBeNull()
      expect(stripe.netPence).toBe(0)
      await invariant(stripe)
    })
  })

  it("a 20p debit already on the customer's Stripe balance: the first invoice is for £40 and takes £40.20; the order goes through", async () => {
    await onASeed(async (stripe) => {
      stripe.setCustomerBalance('cus_seed', 20)
      const data = dataOf(await place(withSoap))
      expect(stripe.subscription(stripe.subscriptionsMade[0] as string)).toMatchObject({ total: 4000, amountPaid: 4020 })
      expect(data).toMatchObject({ status: 'paid', membershipSubscription: { amountPaid: 40.2 } })
      expect(stripe.customerBalance('cus_seed')).toBe(0)
      await invariant(stripe)
    })
  })

  it("a £5 credit on the customer's Stripe balance: the first invoice is for £40 and takes £35; the order goes through", async () => {
    await onASeed(async (stripe) => {
      stripe.setCustomerBalance('cus_seed', -500)
      const data = dataOf(await place(withSoap))
      expect(data).toMatchObject({ status: 'paid', membershipSubscription: { amountPaid: 35 } })
      expect(stripe.customerBalance('cus_seed')).toBe(0)
      await invariant(stripe)
    })
  })

  it('with the 20p debit, the rest of the basket declined: the subscription cancelled and the £40.20 its first invoice took refunded', async () => {
    await onASeed(async (stripe) => {
      stripe.setCustomerBalance('cus_seed', 20)
      stripe.failNext('paymentIntents.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
      const answer = await place(withSoap)
      expect(errorOf(answer)).toMatchObject({ code: 'PAYMENT_FAILED', details: { reason: 'charge_failed' } })
      expect(stripe.refundedPence).toBe(4020)
      expect(stripe.netPence).toBe(0)
      expect(stripe.liveSubscriptions).toEqual([])
      await invariant(stripe)
    })
  })
})

describe('W13a S2: Q8 waits for the money', () => {
  it("P3: the charge answers processing: held before Q8 (PAYMENT_UNCONFIRMED), the old subscription still active; once it has succeeded reconcile sends Q8 and runs T2", async () => {
    await onASeed(
      async (stripe) => {
        const create = stripe.paymentIntents.create
        stripe.paymentIntents.create = (async (params: Stripe.PaymentIntentCreateParams, options?: Stripe.RequestOptions) => ({
          ...((await create(params, options)) as Stripe.PaymentIntent),
          status: 'processing',
        })) as typeof stripe.paymentIntents.create
        const answer = await place(replacing)
        expect(errorOf(answer)).toMatchObject({ code: 'PAYMENT_UNCONFIRMED', message: PAYMENT_UNCONFIRMED_MESSAGE, details: { reason: 'payment_unconfirmed' } })
        expect(stripe.calls.map((call) => call.method)).not.toContain('subscriptions.cancel')
        expect(stripe.subscription('sub_exhausted')?.status).toBe('active')
        expect((await orders())[0]?.payment_status).toBe('pending')
        stripe.paymentIntents.create = create
        later(16)
        expect(await runReconcile(stripe)).toMatchObject({ finalised: 1 })
        expect(stripe.subscription('sub_exhausted')?.status).toBe('canceled')
        await invariant(stripe)
      },
      seedExhaustedMembership
    )
  })
})

describe('W13a S3: every membership path ends at least 10 s inside 60 s', () => {
  const staff = { actor: { type: 'staff' as const, id: ID.staff }, requestId: 'w13a-deadline' }

  it('a mark that takes 9 s on the test clock and returns past the deadline: held, marked, with no order.compensate row; reconcile finishes it', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('paymentIntents.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
      const input = await withQuotedCardFigure(orderInput(withSoap))
      // 20.5 s gone of the membership's 25: the subscription and the declined charge take a second each, so the
      // mark starts with 2.5 s left (it may start) and returns 6.5 s past the deadline.
      await expect(placeOrder(slowMark(db, 9_000), input, { ...staff, stripe: () => stripe, startedAt: Date.now() - 20_500 })).rejects.toMatchObject({
        code: 'PAYMENT_UNCONFIRMED',
        details: { reason: 'compensation_unfinished' },
      })
      const [order] = await orders()
      expect(order?.reader_payment?.compensation).toBeDefined()
      expect(await auditOf(order?.id as string)).toEqual(['order.create'])
      expect(stripe.calls.map((call) => call.method)).not.toContain('refunds.create')
      expect(stripe.liveSubscriptions).toHaveLength(1)
      later(16)
      expect(await runReconcile(stripe)).toMatchObject({ undone: 1 })
      await invariant(stripe)
    })
  })

  it("a declined subscription with little time left: the coupon's delete isn't sent after the deadline (a coupon holds no money); refused, undone", async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('subscriptions.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
      const input = await withQuotedCardFigure(orderInput(core({ method: 'card' }, { products: [soap], promoCode: 'ALLTEN' })))
      await expect(placeOrder(db, input, { ...staff, stripe: () => stripe, startedAt: Date.now() - 22_500 })).rejects.toMatchObject({ details: { reason: 'membership_payment_failed' } })
      expect(stripe.calls.map((call) => call.method)).toEqual(['prices.retrieve', 'customers.update', 'coupons.create', 'subscriptions.create'])
      expect(await orders()).toEqual([])
    })
  })

  it("a reader membership's finalise ends its Stripe calls by 25 s, as the saved card's membership press does: 24 s in, nothing is sent", async () => {
    await onASeed(async (stripe) => {
      const { orderId } = await tapped(stripe)
      const before = stripe.calls.length
      expect(await finaliseReaderOrder(db, stripe, orderId, { ...staff, startedAt: Date.now() - 24_000 })).toMatchObject({ finalised: false })
      expect(stripe.calls.slice(before)).toEqual([])
      expect((await orders())[0]?.payment_status).toBe('pending')
    })
  })

  it("a staff run past its Stripe deadline writes an item's row without reading the last one first", async () => {
    await onASeed(
      async (stripe) => {
        stripe.failNext('subscriptions.cancel', { kind: 'unreachable' })
        stripe.failNext('subscriptions.retrieve', { kind: 'unreachable' })
        const [held] = [errorOf(await place(replacing))]
        expect(held).toMatchObject({ details: { reason: 'replaced_unconfirmed' } })
        const orderId = (await orders())[0]?.id as string
        later(16)
        // Started 21 s ago: past the run's 20 s, so nothing is sent and the item is left (unclear), twice.
        const manual = (): ReconcileOptions => ({ ...asSystem, ...MANUAL_LIMITS, actor: { type: 'staff', id: ID.staff }, startedAt: Date.now() - 21_000 })
        expect(await reconcile(db, stripe, manual())).toMatchObject({ items: [{ outcome: 'left', reason: 'unclear' }] })
        expect(await reconcile(db, stripe, manual())).toMatchObject({ items: [{ outcome: 'left', reason: 'unclear' }] })
        const rows = await db.query("SELECT 1 FROM audit_log WHERE action = 'order.reconcile' AND entity_id = $1 AND details->>'reason' = 'unclear'", [orderId])
        expect(rows).toHaveLength(2)
      },
      seedExhaustedMembership
    )
  })
})

describe('W13a S4: the review plants RP3, RP4 and RP8, caught', () => {
  it("RP3: a reader membership with a promo: the tap takes the promo-reduced first payment, the coupon covers the whole price, the first invoice is £0", async () => {
    await onASeed(async (stripe) => {
      const { placed, orderId } = await tapped(stripe, { promoCode: 'ALLTEN' })
      expect(placed.pendingReaderPayment?.amount).toBe(36)
      const finalised = await postReaderStep('finalise', orderId)
      expect(finalised.body).toMatchObject({ ok: true, data: { finalised: true } })
      expect(stripe.coupon(couponId(orderId))).toMatchObject({ amount_off: 4000, name: 'Paid on card reader' })
      expect(stripe.subscription(stripe.subscriptionsMade[0] as string)).toMatchObject({ total: 0, amountPaid: 0 })
      expect(stripe.netPence).toBe(3600)
      await invariant(stripe)
    })
  })

  it('RP4: a compensation refund Stripe answers failed at once: held and marked (never undone with the money still out), and listed', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('paymentIntents.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
      stripe.refundsFailAtOnce = true
      const answer = await place(withSoap)
      expect(errorOf(answer)).toMatchObject({ code: 'PAYMENT_UNCONFIRMED', message: COMPENSATION_HELD_MESSAGE, details: { reason: 'compensation_unfinished' } })
      const [order] = await orders()
      expect(order).toMatchObject({ payment_status: 'pending' })
      expect(order?.reader_payment?.compensation).toBeDefined()
      expect(stripe.netPence).toBe(4000)
      later(16)
      expect(await runReconcile(stripe)).toMatchObject({ undone: 0, items: [{ outcome: 'left', reason: 'compensation_unfinished' }] })
      expect((await stuckList(db)).checkout[0]).toMatchObject({ orderId: order?.id, reason: 'compensation_unfinished' })
    })
  })

  it('RP8: finalise on a reader order carrying the compensation mark makes no Stripe call', async () => {
    await onASeed(async (stripe) => {
      const { orderId } = await tapped(stripe)
      expect(await markCompensating(db, orderId, 'test')).toMatchObject({ marked: true })
      const before = stripe.calls.length
      const finalised = await postReaderStep('finalise', orderId)
      expect(finalised.body).toMatchObject({ ok: true, data: { finalised: false, reason: 'compensation_unfinished' } })
      expect(stripe.calls.slice(before)).toEqual([])
    })
  })
})

describe("W13a L1: T2's definite checks before Q8's cancel", () => {
  const cancelled = (stripe: FakeStripe, id: string) => stripe.calls.some((call) => call.method === 'subscriptions.cancel' && (call.params as { id: string }).id === id)

  it('the saved card: T2 would refuse (the membership tampered after the charge): refused before Q8, the old subscription left active, everything put back', async () => {
    await onASeed(
      async (stripe) => {
        after(stripe.paymentIntents, 'create', tamperMembership)
        const answer = await place(replacing)
        expect(errorOf(answer)).toMatchObject({ code: 'PAYMENT_FAILED', details: { reason: 'membership_subscription_failed' } })
        expect(errorOf(answer)?.message).toContain(COMPENSATED_NOTE)
        expect(errorOf(answer)?.message).not.toContain(OLD_MEMBERSHIP_CANCELLED_NOTE)
        expect(cancelled(stripe, 'sub_exhausted')).toBe(false)
        expect(stripe.subscription('sub_exhausted')?.status).toBe('active')
        expect(stripe.netPence).toBe(0)
        await invariant(stripe)
      },
      seedExhaustedMembership
    )
  })

  it('the reader: the same after the subscription: the tap refunded, the new subscription cancelled, the old one left active', async () => {
    await onASeed(
      async (stripe) => {
        const { orderId } = await tapped(stripe, { booking: { ...paidSeat([sam]), redemptionSource: 'buy_new_membership', cancelExhaustedMembershipId: ID.exhausted } })
        after(stripe.subscriptions, 'create', tamperMembership)
        const finalised = await postReaderStep('finalise', orderId)
        expect(finalised.body).toMatchObject({ ok: true, data: { finalised: false, reason: 'finalise_failed', rolledBack: true } })
        expect((finalised.body as unknown as { data: { message: string } }).data.message).not.toContain(OLD_MEMBERSHIP_CANCELLED_NOTE)
        expect(cancelled(stripe, 'sub_exhausted')).toBe(false)
        expect(stripe.subscription('sub_exhausted')?.status).toBe('active')
        expect(stripe.netPence).toBe(0)
        await invariant(stripe)
      },
      seedExhaustedMembership
    )
  })

  it('reconcile, the saved card (the Worker died after the charge): the same before Q8', async () => {
    await onASeed(
      async (stripe) => {
        const dying = dyingOn(stripe, 'paymentIntents', 'create', 'after')
        replayStripe.current = dying.client
        void place(replacing)
        await dying.died
        replayStripe.current = stripe
        later(16)
        // Changed after reconcile read what is due, before its pre-check.
        let first = true
        after(stripe.subscriptions, 'list', tamperMembership, () => {
          const now = first
          first = false
          return now
        })
        expect(await runReconcile(stripe)).toMatchObject({ undone: 1 })
        expect(cancelled(stripe, 'sub_exhausted')).toBe(false)
        expect(stripe.subscription('sub_exhausted')?.status).toBe('active')
        await invariant(stripe)
      },
      seedExhaustedMembership
    )
  })

  it("the saved card: the check's read fails (a database fault): held as paid but not finished (never refunded), the old subscription untouched; reconcile sends Q8 and runs T2", async () => {
    await onASeed(
      async (stripe) => {
        // W13c: the check runs in a transaction now, so the read fails there.
        const failing = failingStatement(db, (sql) => sql.includes('membership_row_ready') && !sql.includes('FOR UPDATE'))
        const input = await withQuotedCardFigure(orderInput(replacing))
        await expect(placeOrder(failing, input, { actor: { type: 'staff', id: ID.staff }, requestId: 'l1-fault', stripe: () => stripe })).rejects.toMatchObject({
          code: 'PAYMENT_UNCONFIRMED',
          message: PAID_NOT_FINISHED_MESSAGE,
          details: { reason: 'paid_not_finished' },
        })
        expect(cancelled(stripe, 'sub_exhausted')).toBe(false)
        expect(stripe.refundedPence).toBe(0)
        later(16)
        expect(await runReconcile(stripe)).toMatchObject({ finalised: 1 })
        expect(stripe.subscription('sub_exhausted')?.status).toBe('canceled')
        await invariant(stripe)
      },
      seedExhaustedMembership
    )
  })

  it('a compensation that still follows a confirmed Q8 cancel says the old membership was cancelled too: the saved card and the reader', async () => {
    await onASeed(
      async (stripe) => {
        after(stripe.subscriptions, 'cancel', tamperMembership, (args) => args[0] === 'sub_exhausted')
        const answer = await place(replacing)
        expect(errorOf(answer)?.message).toContain(COMPENSATED_NOTE)
        expect(errorOf(answer)?.message).toContain(OLD_MEMBERSHIP_CANCELLED_NOTE)
        expect(stripe.subscription('sub_exhausted')?.status).toBe('canceled')
        expect(stripe.netPence).toBe(0)
        await invariant(stripe)
      },
      seedExhaustedMembership
    )
    await onASeed(
      async (stripe) => {
        const { orderId } = await tapped(stripe, { booking: { ...paidSeat([sam]), redemptionSource: 'buy_new_membership', cancelExhaustedMembershipId: ID.exhausted } })
        after(stripe.subscriptions, 'cancel', tamperMembership, (args) => args[0] === 'sub_exhausted')
        const finalised = await postReaderStep('finalise', orderId)
        expect(finalised.body).toMatchObject({ ok: true, data: { finalised: false, rolledBack: true } })
        expect((finalised.body as unknown as { data: { message: string } }).data.message).toContain(OLD_MEMBERSHIP_CANCELLED_NOTE)
        expect(stripe.netPence).toBe(0)
        await invariant(stripe)
      },
      seedExhaustedMembership
    )
  })
})

// ---------------------------------------------------------------------------------------------------
// W13b: the W13a report's N1 and N2, each ending on the invariant.

describe("W13b: the W13a report's N1 and N2", () => {
  it("N1: a charge listed requires_capture that succeeds on reconcile's cancel attempt, then Q8's cancel refused: the charge and the first invoice refunded, the new subscription cancelled, the order undone", async () => {
    await onASeed(
      async (stripe) => {
        // The press: the charge authorised but not captured, so held before Q8 (W13a S2), its subscription live.
        let charge = ''
        const create = stripe.paymentIntents.create
        stripe.paymentIntents.create = (async (params: Stripe.PaymentIntentCreateParams, options?: Stripe.RequestOptions) => {
          const made = (await create(params, options)) as Stripe.PaymentIntent
          charge = made.id
          stripe.markRequiresCapture(made.id)
          return { ...made, status: 'requires_capture', amount_received: 0, latest_charge: null }
        }) as typeof stripe.paymentIntents.create
        expect(errorOf(await place(replacing))).toMatchObject({ code: 'PAYMENT_UNCONFIRMED', details: { reason: 'payment_unconfirmed' } })
        stripe.paymentIntents.create = create
        // The seed's sub_exhausted is listed first.
        const made = stripe.subscriptionsMade.find((id) => id !== 'sub_exhausted') as string
        expect(stripe.subscription(made)?.status).toBe('active')
        expect(stripe.netPence).toBe(4000)
        // Reconcile lists the charge as requires_capture; it is captured just before reconcile's cancel lands, so
        // the cancel fails and the read after it finds it succeeded. Then Q8's cancel is refused.
        const cancel = stripe.paymentIntents.cancel
        stripe.paymentIntents.cancel = (async (...args: Parameters<typeof cancel>) => {
          stripe.completeReaderPayment(charge)
          return cancel(...args)
        }) as typeof cancel
        stripe.failNext('subscriptions.cancel', { kind: 'error', error: fakeStripeErrors.invalid('resource_missing', "No such subscription: 'sub_exhausted'") })
        later(16)
        const result = await runReconcile(stripe)
        expect(result).toMatchObject({ undone: 1 })
        expect(result.items[0]?.detail).toContain(charge)
        expect(stripe.calls.filter((call) => call.method === 'paymentIntents.cancel')).toHaveLength(1)
        const refunds = stripe.calls.filter((call) => call.method === 'refunds.create').map((call) => call.idempotencyKey?.split(':')[1])
        expect(refunds.sort()).toEqual(['refund-charge', 'refund-subscription'])
        expect(stripe.chargedByIntent.get(charge)).toBeGreaterThan(0)
        expect(stripe.refundedByIntent.get(charge)).toBe(stripe.chargedByIntent.get(charge))
        expect(stripe.subscription(made)?.status).toBe('canceled')
        expect(stripe.subscription('sub_exhausted')?.status).toBe('active')
        expect(stripe.netPence).toBe(0)
        await invariant(stripe)
      },
      seedExhaustedMembership
    )
  })

  it("N2: the saved card: T2 finds the order gone after this press made its subscription: cancelled at once and recorded, its first invoice refunded; the charge refunded by reconcile's automatic refund", async () => {
    await onASeed(async (stripe) => {
      const held = holdNext(stripe.paymentIntents, 'create')
      const screen = place(withSoap)
      await held.reached
      const orderId = (await orders())[0]?.id as string
      // Something puts the order back meanwhile without waiting for the press (no Worker path now does).
      const putBack = await compensateOrder(db, stripe, orderId, { subscriptionId: null, refunds: [] }, 'test: unguarded', { actor: { type: 'system', id: null }, requestId: 'n2' }, undefined)
      expect(putBack).toMatchObject({ settled: true, undo: { undone: true } })
      held.release()
      expect(errorOf(await screen)).toMatchObject({ code: 'PAYMENT_UNCONFIRMED', details: { reason: 'charged_without_order' } })
      const made = stripe.subscriptionsMade[0] as string
      expect(stripe.subscription(made)?.status).toBe('canceled')
      expectLeftThenPutBack(await subscriptionLeftRows(orderId), made, 'order_gone', 'cancelled')
      expect(stripe.calls.filter((call) => call.method === 'refunds.create').map((call) => call.idempotencyKey)).toEqual([`${orderId}:refund-subscription`])
      later(16)
      expect((await runReconcile(stripe)).items).toEqual([expect.objectContaining({ kind: 'refund', id: orderId, outcome: 'refund_confirmed' })])
      expect(stripe.calls.filter((call) => call.method === 'refunds.create').map((call) => call.idempotencyKey)).toEqual([`${orderId}:refund-subscription`, `${orderId}:refund-charge`])
      const stuck = await stuckList(db)
      expect(stuck.warnings).toEqual([])
      expect(stuck.refunds).toEqual([])
      expect(stripe.netPence).toBe(0)
      await invariant(stripe)
    })
  })

  it("N2: the saved card: T2 finds the order marked: the subscription cancelled at once; reconcile finishes the compensation (the charge refunded) and the undo", async () => {
    await onASeed(async (stripe) => {
      const held = holdNext(stripe.paymentIntents, 'create')
      const screen = place(withSoap)
      await held.reached
      const orderId = (await orders())[0]?.id as string
      expect(await markCompensating(db, orderId, 'test: marked meanwhile')).toMatchObject({ marked: true })
      held.release()
      expect(errorOf(await screen)).toMatchObject({ code: 'PAYMENT_UNCONFIRMED', details: { reason: 'payment_unconfirmed' } })
      const made = stripe.subscriptionsMade[0] as string
      expect(stripe.subscription(made)?.status).toBe('canceled')
      expectLeftThenPutBack(await subscriptionLeftRows(orderId), made, 'compensating', 'cancelled')
      later(16)
      expect(await runReconcile(stripe)).toMatchObject({ undone: 1 })
      expect(stripe.liveSubscriptions).toEqual([])
      expect(stripe.netPence).toBe(0)
      await invariant(stripe)
    })
  })
})

// ---------------------------------------------------------------------------------------------------
// W13c: the W13a review's fixes (B1, S1, L3 first part, L4), each ending on the invariant where money moved.

/** Lets the next call of `target[method]` take effect at Stripe, then holds its answer until released (a slow answer). */
function holdAnswer(target: object, method: string): { reached: Promise<void>; release: () => void } {
  let reach: () => void = () => undefined
  const reached = new Promise<void>((resolve) => {
    reach = resolve
  })
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const methods = target as Record<string, (...args: unknown[]) => Promise<unknown>>
  const original = methods[method] as (...args: unknown[]) => Promise<unknown>
  let waiting = true
  methods[method] = async (...args: unknown[]) => {
    if (!waiting) return original(...args)
    waiting = false
    try {
      return await original(...args)
    } finally {
      reach()
      await gate
    }
  }
  return { reached, release }
}

/** Every statement a press sends, in order, with the transaction it ran in (null: a bare query). */
interface Statement {
  sql: string
  tx: number | null
}

/**
 * A database that records each statement (W13c S1). The L1 pre-check takes `precheckMs` on the test clock; `seen`
 * gets the clock as it returns.
 */
function watchedDb(base: Db, log: Statement[], precheckMs: number, seen: number[]): Db {
  let transactions = 0
  const slow = (sql: string) => {
    if (sql.includes('SELECT o.payment_status, o.reader_payment,')) {
      vi.setSystemTime(Date.now() + precheckMs)
      seen.push(Date.now())
    }
  }
  return {
    query: async <Row,>(sql: string, params?: readonly SqlParam[]) => {
      log.push({ sql, tx: null })
      slow(sql)
      return base.query<Row>(sql, params)
    },
    close: () => base.close(),
    transaction: <T,>(fn: (tx: Tx) => Promise<T>) => {
      const id = ++transactions
      return base.transaction((tx) =>
        fn(
          new Proxy(tx, {
            get(target, property) {
              if (property === 'query') {
                return async <Row,>(sql: string, params?: readonly SqlParam[]) => {
                  log.push({ sql, tx: id })
                  slow(sql)
                  return target.query<Row>(sql, params)
                }
              }
              const value: unknown = Reflect.get(target, property)
              return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value
            },
          })
        )
      )
    },
  }
}

/** The statements after T2's transaction (the one that locks the order with FOR UPDATE OF o). */
function afterT2(log: Statement[]): Statement[] {
  const t2 = log.find((statement) => statement.sql.includes('FOR UPDATE OF o'))?.tx
  if (t2 === undefined || t2 === null) throw new Error('T2 never ran.')
  const lastOfT2 = log.map((statement) => statement.tx).lastIndexOf(t2)
  return log.slice(lastOfT2 + 1)
}

const sentAfter = (stripe: FakeStripe, from: number) => stripe.calls.slice(from).map((call) => call.method)
const replacingOnTheReader = { booking: { ...paidSeat([sam]), redemptionSource: 'buy_new_membership', cancelExhaustedMembershipId: ID.exhausted } }
const oldCancelSent = (stripe: FakeStripe) => stripe.calls.some((call) => call.method === 'subscriptions.cancel' && (call.params as { id: string }).id === 'sub_exhausted')
const asStaffMember = { actor: { type: 'staff' as const, id: ID.staff }, requestId: 'w13c' }

describe('W13c B1: one press at a time may start the subscription (the W13a review, variant A)', () => {
  it("R1: the screen's finalise is making the subscription (its answer slow) when staff press Cancel, which finalises instead: Cancel's start is refused, so it sends nothing more and compensates nothing; the screen is paid", async () => {
    await onASeed(async (stripe) => {
      const { orderId, intent } = await tapped(stripe)
      later(15.5)
      // Press Y (the screen): Stripe makes its subscription; the answer is slow to come back.
      const y = holdAnswer(stripe.subscriptions, 'create')
      const screen = postReaderStep('finalise', orderId)
      await y.reached
      const made = stripe.subscriptionsMade[0] as string
      // Press X (staff press Cancel): the tap succeeded, so cancel finalises instead. Its default-card update would get
      // no answer (a transient fault), which before W13c ended in a compensation under its own start.
      stripe.failNext('customers.update', { kind: 'unreachable' })
      const before = stripe.calls.length
      const cancel = await postReaderStep('cancel', orderId)
      expect(cancel.body).toMatchObject({
        ok: true,
        data: { cancelled: false, finalisedInstead: true, finaliseResult: { finalised: false, reason: 'subscription_starting', message: SUBSCRIPTION_STARTING_MESSAGE } },
      })
      // Nothing after its refused start: the read of the tap, the card, the price; no default card, coupon,
      // subscription, list or refund.
      expect(sentAfter(stripe, before).filter((method) => !['paymentIntents.retrieve', 'paymentMethods.retrieve', 'prices.retrieve'].includes(method))).toEqual([])
      expect(stripe.refundedPence).toBe(0)
      expect((await orders())[0]?.reader_payment?.compensation).toBeUndefined()
      expect(await auditOf(orderId)).not.toContain('order.compensate')
      y.release()
      expect((await screen).body).toMatchObject({ ok: true, data: { finalised: true, membershipSubscriptionId: made, paymentIntentId: intent } })
      later(16)
      expect(await runReconcile(stripe)).toMatchObject({ undone: 0, refunds: 0 })
      expect(stripe.liveSubscriptions).toEqual([made])
      expect(stripe.netPence).toBe(4000)
      await invariant(stripe)
    })
  })

  it("two finalise presses at once, the second reaching its start while the first's is seconds old: the second answers subscription_starting, sends nothing more; the first is paid", async () => {
    await onASeed(async (stripe) => {
      const { orderId } = await tapped(stripe)
      const first = holdNext(stripe.subscriptions, 'create')
      const screen = postReaderStep('finalise', orderId)
      await first.reached
      const before = stripe.calls.length
      const second = await postReaderStep('finalise', orderId)
      expect(second.body).toMatchObject({ ok: true, data: { finalised: false, reason: 'subscription_starting', message: SUBSCRIPTION_STARTING_MESSAGE } })
      // Only the reads before its start (the tap, the card, the price): nothing after the refused start.
      expect(sentAfter(stripe, before)).toContain('prices.retrieve')
      expect(sentAfter(stripe, before).filter((method) => !['paymentIntents.retrieve', 'paymentMethods.retrieve', 'prices.retrieve'].includes(method))).toEqual([])
      first.release()
      expect((await screen).body).toMatchObject({ ok: true, data: { finalised: true } })
      expect(stripe.subscriptionsMade).toHaveLength(1)
      await invariant(stripe)
    })
  })

  it("a dead press (decision \"W13c call\"): its start over 2 minutes old and its subscription made; a second press replaces the start, then its default-card update fails: its compensation lists Stripe again and cancels that subscription with the tap refunded", async () => {
    await onASeed(async (stripe) => {
      const { orderId } = await tapped(stripe)
      // Press Y: its subscription made at Stripe, then its Worker died (no answer, no T2).
      const dying = dyingOn(stripe, 'subscriptions', 'create', 'after')
      replayStripe.current = dying.client
      void postReaderStep('finalise', orderId)
      await dying.died
      replayStripe.current = stripe
      const made = stripe.subscriptionsMade[0] as string
      expect(stripe.subscription(made)?.status).toBe('active')
      // Press X, 2.1 minutes later: Y's start has expired, so X's start takes its place.
      later(2.1)
      stripe.failNext('customers.update', { kind: 'unreachable' })
      const before = stripe.calls.length
      const x = await postReaderStep('finalise', orderId)
      expect(x.body).toMatchObject({ ok: true, data: { finalised: false, reason: 'subscription_failed', rolledBack: true } })
      expect(sentAfter(stripe, before)).toContain('subscriptions.list')
      expect(stripe.subscription(made)?.status).toBe('canceled')
      expect(stripe.netPence).toBe(0)
      await invariant(stripe)
    })
  })

  it("RV9: the old rollback starts on the order between finalise's entry check and its start: the start's write refuses it, so no subscription is made", async () => {
    await onASeed(async (stripe) => {
      const { orderId } = await tapped(stripe)
      const held = holdNext(stripe.prices, 'retrieve')
      const screen = postReaderStep('finalise', orderId)
      await held.reached
      // Test data: what the old rollback (readerOrderRollback.ts) writes on an order it has started on.
      await db.query(`UPDATE orders SET reader_payment = reader_payment || jsonb_build_object('rollback', jsonb_build_object('started_at', now()::text)) WHERE id = $1::uuid`, [orderId])
      held.release()
      expect((await screen).body).toMatchObject({ ok: true, data: { finalised: false } })
      expect(stripe.calls.filter((call) => call.method === 'subscriptions.create')).toEqual([])
      expect(stripe.subscriptionsMade).toEqual([])
      expect((await orders())[0]?.reader_payment?.membership?.subscription_started_at).toBeUndefined()
    })
  })
})

describe('W13c S1: the pre-check bounded, and nothing written after T2 once the window has closed', () => {
  it("R8, the saved card (Q8 due): the charge answers at 24 s, the order is marked meanwhile, the pre-check (in a transaction) takes 9.9 s: no Stripe call and no statement after T2; T2's own row names the subscription; reconcile puts everything back", async () => {
    await onASeed(
      async (stripe) => {
        const log: Statement[] = []
        const seen: number[] = []
        const startedAt = Date.now()
        let chargedAt = 0
        after(stripe.paymentIntents, 'create', async () => {
          vi.setSystemTime(startedAt + 24_000)
          chargedAt = stripe.calls.length
          const pending = (await orders()).find((order) => order.payment_status === 'pending')
          await markCompensating(db, pending?.id as string, 'test: a compensation started meanwhile')
        })
        const input = await withQuotedCardFigure(orderInput(replacing))
        await expect(placeOrder(watchedDb(db, log, 9_900, seen), input, { ...asStaffMember, startedAt, stripe: () => stripe })).rejects.toMatchObject({
          code: 'PAYMENT_UNCONFIRMED',
          details: { reason: 'payment_unconfirmed' },
        })
        // The pre-check ran in a transaction (the server's 8 s limit bounds it) and returned after the 25 s window.
        expect(log.filter((statement) => statement.sql.includes('SELECT o.payment_status, o.reader_payment,')).map((statement) => statement.tx !== null)).toEqual([true])
        expect((seen[0] ?? 0) - startedAt).toBeGreaterThan(25_000)
        // Nothing after T2: no statement, no Stripe call after the charge; T2's own row is the record.
        expect(afterT2(log)).toEqual([])
        expect(sentAfter(stripe, chargedAt)).toEqual([])
        const orderId = (await orders())[0]?.id as string
        const made = stripe.subscriptionsMade.find((id) => id !== 'sub_exhausted') as string
        expect(await subscriptionLeftRows(orderId)).toEqual([expect.objectContaining({ state: 'left', subscriptionId: made, found: 'compensating', left: [LEFT_AT_T2] })])
        expect((await stuckList(db)).warnings).toEqual([expect.objectContaining({ id: orderId, warning: SUBSCRIPTION_LEFT_WORDS(made) })])
        expect(oldCancelSent(stripe)).toBe(false)
        // Reconcile finishes the compensation: the subscription cancelled, both payments refunded, the warning closed.
        later(16)
        expect(await runReconcile(stripe)).toMatchObject({ undone: 1 })
        expect(stripe.subscription(made)?.status).toBe('canceled')
        expect(stripe.subscription('sub_exhausted')?.status).toBe('active')
        expect((await stuckList(db)).warnings).toEqual([])
        expect(stripe.netPence).toBe(0)
        await invariant(stripe)
      },
      seedExhaustedMembership
    )
  })

  it("R8, the reader (Q8 due): the subscription answers at 24 s, the order is marked meanwhile, the pre-check takes 9.9 s: no Stripe call and no statement after T2; T2's own row names the subscription", async () => {
    await onASeed(
      async (stripe) => {
        const { orderId } = await tapped(stripe, replacingOnTheReader)
        const log: Statement[] = []
        const seen: number[] = []
        const startedAt = Date.now()
        let madeAt = 0
        after(stripe.subscriptions, 'create', async () => {
          vi.setSystemTime(startedAt + 24_000)
          madeAt = stripe.calls.length
          await markCompensating(db, orderId, 'test: a compensation started meanwhile')
        })
        const answer = await finaliseReaderOrder(watchedDb(db, log, 9_900, seen), stripe, orderId, { ...asStaffMember, startedAt })
        expect(answer).toMatchObject({ finalised: false, reason: 'compensation_unfinished' })
        expect((seen[0] ?? 0) - startedAt).toBeGreaterThan(25_000)
        expect(afterT2(log)).toEqual([])
        expect(sentAfter(stripe, madeAt)).toEqual([])
        const made = stripe.subscriptionsMade.find((id) => id !== 'sub_exhausted') as string
        expect(await subscriptionLeftRows(orderId)).toEqual([expect.objectContaining({ state: 'left', subscriptionId: made, found: 'compensating' })])
        expect(oldCancelSent(stripe)).toBe(false)
        later(16)
        expect(await runReconcile(stripe)).toMatchObject({ undone: 1 })
        expect((await stuckList(db)).warnings).toEqual([])
        expect(stripe.netPence).toBe(0)
        await invariant(stripe)
      },
      seedExhaustedMembership
    )
  })
})

describe('W13c L3: reconcile retries a put-back left live', () => {
  it("the put-back's cancel unclear (the order put back meanwhile): the next run cancels the subscription and writes cancelled; the warning closes, nothing is refunded twice", async () => {
    await onASeed(async (stripe) => {
      const { orderId, intent } = await tapped(stripe)
      const held = holdNext(stripe.subscriptions, 'create')
      const screen = postReaderStep('finalise', orderId)
      await held.reached
      // Something puts the order back meanwhile without waiting for the press (as R1 did before W13c's start).
      await compensateOrder(db, stripe, orderId, { subscriptionId: null, refunds: [{ step: 'refund-reader', paymentIntentId: intent }] }, 'test: unguarded', { actor: { type: 'system', id: null }, requestId: 'l3' }, undefined)
      stripe.failNext('subscriptions.cancel', { kind: 'unreachable' })
      stripe.failNext('subscriptions.retrieve', { kind: 'unreachable' })
      held.release()
      expect((await screen).body).toMatchObject({ ok: true, data: { finalised: false, reason: 'charged_without_order' } })
      const made = stripe.subscriptionsMade[0] as string
      expect(stripe.subscription(made)?.status).toBe('active')
      expect((await stuckList(db)).warnings).toEqual([expect.objectContaining({ id: orderId, warning: SUBSCRIPTION_LEFT_WORDS(made) })])
      // The first retry's cancel is unclear too (its read of the subscription answered, the cancel and the check not):
      // left, the warning stays, nothing written as cancelled.
      stripe.failNext('subscriptions.retrieve', { kind: 'none' })
      stripe.failNext('subscriptions.retrieve', { kind: 'unreachable' })
      stripe.failNext('subscriptions.cancel', { kind: 'unreachable' })
      expect((await runReconcile(stripe)).items).toContainEqual(expect.objectContaining({ kind: 'order', id: orderId, outcome: 'left', reason: 'subscription_left' }))
      expect(stripe.subscription(made)?.status).toBe('active')
      expect(await subscriptionLeftRows(orderId)).not.toContainEqual(expect.objectContaining({ state: 'cancelled' }))
      expect((await stuckList(db)).warnings).toEqual([expect.objectContaining({ id: orderId, warning: SUBSCRIPTION_LEFT_WORDS(made) })])
      // The next run puts it back.
      later(6)
      const ran = await runReconcile(stripe)
      expect(ran.items).toContainEqual(expect.objectContaining({ kind: 'order', id: orderId, outcome: 'undone', detail: `subscription ${made} put back: cancelled` }))
      expect(stripe.subscription(made)?.status).toBe('canceled')
      expect(await subscriptionLeftRows(orderId)).toContainEqual(expect.objectContaining({ state: 'cancelled', subscriptionId: made, found: 'reconcile' }))
      expect((await stuckList(db)).warnings).toEqual([])
      // The tap was refunded once, by the compensation; the late refund counts it.
      later(16)
      await runReconcile(stripe)
      expect(stripe.calls.filter((call) => call.method === 'refunds.create').map((call) => call.idempotencyKey)).toEqual([`${orderId}:refund-reader`])
      expect(stripe.netPence).toBe(0)
      expect(await runReconcile(stripe)).toMatchObject({ checked: 0 })
      await invariant(stripe)
    })
  })

  it("the saved card: the put-back's cancel and its first-invoice refund both unclear: the next run cancels it and refunds the first invoice under its key; the charge's late refund as before", async () => {
    await onASeed(async (stripe) => {
      const held = holdNext(stripe.paymentIntents, 'create')
      const screen = place(withSoap)
      await held.reached
      const orderId = (await orders())[0]?.id as string
      await compensateOrder(db, stripe, orderId, { subscriptionId: null, refunds: [] }, 'test: unguarded', { actor: { type: 'system', id: null }, requestId: 'l3' }, undefined)
      stripe.failNext('subscriptions.cancel', { kind: 'unreachable' })
      stripe.failNext('subscriptions.retrieve', { kind: 'unreachable' })
      stripe.failNext('refunds.create', { kind: 'unreachable' })
      stripe.failNext('refunds.create', { kind: 'unreachable' })
      held.release()
      expect(errorOf(await screen)).toMatchObject({ details: { reason: 'charged_without_order' } })
      const made = stripe.subscriptionsMade[0] as string
      expect(stripe.subscription(made)?.status).toBe('active')
      expect(stripe.refundedPence).toBe(0)
      later(16)
      const ran = await runReconcile(stripe)
      expect(ran.items).toContainEqual(expect.objectContaining({ kind: 'order', id: orderId, outcome: 'undone' }))
      expect(stripe.subscription(made)?.status).toBe('canceled')
      const refunds = stripe.calls.filter((call) => call.method === 'refunds.create').map((call) => call.idempotencyKey)
      expect(new Set(refunds)).toEqual(new Set([`${orderId}:refund-subscription`, `${orderId}:refund-charge`]))
      expect((await stuckList(db)).warnings).toEqual([])
      expect(stripe.netPence).toBe(0)
      await invariant(stripe)
    })
  })

  it("a left row naming a subscription Stripe says is another order's: nothing is cancelled or refunded, left for a person", async () => {
    await onASeed(async (stripe) => {
      const paid = dataOf(await place(withSoap))
      const theirs = stripe.subscriptionsMade[0] as string
      // Test data: a left row on an order that no longer exists, naming the paid order's subscription.
      const goneOrder = crypto.randomUUID()
      await db.query(
        `INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, request_id, details)
         VALUES ('system', NULL, 'order.subscription_left', 'order', $1, 'w13c', $2::jsonb)`,
        [goneOrder, { state: 'left', subscriptionId: theirs, invoicePaymentIntentId: 'pi_not_this_order', amountPaid: 4000, found: 'order_gone', refunded: [], left: ['test'] }]
      )
      const before = stripe.calls.length
      const ran = await runReconcile(stripe)
      expect(ran.items).toEqual([expect.objectContaining({ kind: 'order', id: goneOrder, outcome: 'left', reason: 'subscription_not_this_order' })])
      expect(sentAfter(stripe, before)).toEqual(['subscriptions.retrieve'])
      expect(stripe.subscription(theirs)?.status).toBe('active')
      expect(paid.membershipSubscription?.subscriptionId).toBe(theirs)
      expect(stripe.netPence).toBe(6400)
    })
  })
})

describe("W13c L4: the W13a review's plants, caught", () => {
  it("RV2r, the reader: the order marked between the subscription and the pre-check (not_pending): Q8's cancel never sent, sub_exhausted stays active", async () => {
    await onASeed(
      async (stripe) => {
        const { orderId } = await tapped(stripe, replacingOnTheReader)
        after(stripe.subscriptions, 'create', () => markCompensating(db, orderId, 'test: marked meanwhile'))
        const finalised = await postReaderStep('finalise', orderId)
        expect(finalised.body).toMatchObject({ ok: true, data: { finalised: false, reason: 'compensation_unfinished' } })
        expect(oldCancelSent(stripe)).toBe(false)
        expect(stripe.subscription('sub_exhausted')?.status).toBe('active')
        later(16)
        expect(await runReconcile(stripe)).toMatchObject({ undone: 1 })
        expect(stripe.subscription('sub_exhausted')?.status).toBe('active')
        expect(stripe.netPence).toBe(0)
        await invariant(stripe)
      },
      seedExhaustedMembership
    )
  })

  it("RV3r, the saved card: the order marked between the charge and the pre-check: Q8's cancel never sent, sub_exhausted stays active", async () => {
    await onASeed(
      async (stripe) => {
        after(stripe.paymentIntents, 'create', async () => {
          const pending = (await orders()).find((order) => order.payment_status === 'pending')
          await markCompensating(db, pending?.id as string, 'test: marked meanwhile')
        })
        expect(errorOf(await place(replacing))).toMatchObject({ details: { reason: 'payment_unconfirmed' } })
        expect(oldCancelSent(stripe)).toBe(false)
        expect(stripe.subscription('sub_exhausted')?.status).toBe('active')
        later(16)
        expect(await runReconcile(stripe)).toMatchObject({ undone: 1 })
        expect(stripe.subscription('sub_exhausted')?.status).toBe('active')
        expect(stripe.netPence).toBe(0)
        await invariant(stripe)
      },
      seedExhaustedMembership
    )
  })

  it("RV4r, reconcile (the Worker died after the charge): the order marked after reconcile listed it, before its pre-check: Q8's cancel never sent, sub_exhausted stays active; the next run puts it back", async () => {
    await onASeed(
      async (stripe) => {
        const dying = dyingOn(stripe, 'paymentIntents', 'create', 'after')
        replayStripe.current = dying.client
        void place(replacing)
        await dying.died
        replayStripe.current = stripe
        later(16)
        let first = true
        after(
          stripe.subscriptions,
          'list',
          async () => {
            const pending = (await orders()).find((order) => order.payment_status === 'pending')
            await markCompensating(db, pending?.id as string, 'test: marked meanwhile')
          },
          () => {
            const now = first
            first = false
            return now
          }
        )
        expect((await runReconcile(stripe)).items).toEqual([expect.objectContaining({ outcome: 'left', reason: 'compensating' })])
        expect(oldCancelSent(stripe)).toBe(false)
        expect(await runReconcile(stripe)).toMatchObject({ undone: 1 })
        expect(oldCancelSent(stripe)).toBe(false)
        expect(stripe.subscription('sub_exhausted')?.status).toBe('active')
        expect(stripe.netPence).toBe(0)
        await invariant(stripe)
      },
      seedExhaustedMembership
    )
  })

  it("RV1: B1c on a marked order with the put-back's cancel unclear: the order's compensation, finished by reconcile, cancels it and closes the warning in that same run", async () => {
    await onASeed(async (stripe) => {
      const { orderId } = await tapped(stripe)
      const held = holdNext(stripe.subscriptions, 'create')
      const screen = postReaderStep('finalise', orderId)
      await held.reached
      expect(await markCompensating(db, orderId, 'test: marked meanwhile')).toMatchObject({ marked: true })
      stripe.failNext('subscriptions.cancel', { kind: 'unreachable' })
      stripe.failNext('subscriptions.retrieve', { kind: 'unreachable' })
      held.release()
      expect((await screen).body).toMatchObject({ ok: true, data: { finalised: false, reason: 'compensation_unfinished' } })
      const made = stripe.subscriptionsMade[0] as string
      expectLeftThenPutBack(await subscriptionLeftRows(orderId), made, 'compensating', 'left')
      expect((await stuckList(db)).warnings).toHaveLength(1)
      later(16)
      expect(await runReconcile(stripe)).toMatchObject({ undone: 1 })
      expect(stripe.subscription(made)?.status).toBe('canceled')
      expect((await stuckList(db)).warnings).toEqual([])
      expect(stripe.netPence).toBe(0)
      await invariant(stripe)
    })
  })

  it("RV5: the relist after the mark adds the listed subscription's first-invoice refund: a £1 debit on the customer's Stripe balance, taken by the reader's first invoice, is refunded with the tap", async () => {
    await onASeed(async (stripe) => {
      stripe.setCustomerBalance('cus_seed', 100)
      const { orderId } = await tapped(stripe)
      const answer = await whileFailing(db, { table: 'orders', event: 'UPDATE', when: "NEW.payment_status = 'paid'" }, () => postReaderStep('finalise', orderId))
      expect(answer.body).toMatchObject({ ok: true, data: { finalised: false, reason: 'finalise_failed' } })
      const made = stripe.subscriptionsMade[0] as string
      expect(stripe.subscription(made)?.amountPaid).toBe(100)
      later(16)
      let lists = 0
      const list = stripe.subscriptions.list
      stripe.subscriptions.list = async (params, options) => {
        const page = await list(params, options)
        lists += 1
        return lists === 1 ? { ...page, data: [] } : page
      }
      expect(await runReconcile(stripe)).toMatchObject({ undone: 1 })
      expect(lists).toBe(2)
      expect(new Set(stripe.calls.filter((call) => call.method === 'refunds.create').map((call) => call.idempotencyKey))).toEqual(new Set([`${orderId}:refund-subscription`, `${orderId}:refund-reader`]))
      expect(stripe.netPence).toBe(0)
      await invariant(stripe)
    })
  })

  /** B1c with the order gone, its compensation's tap refund answered pending; the late refund then finds it under its key. */
  async function lateRefundAfterPendingCompensation(stripe: FakeStripe) {
    const { orderId, intent } = await tapped(stripe)
    const held = holdNext(stripe.subscriptions, 'create')
    const screen = postReaderStep('finalise', orderId)
    await held.reached
    stripe.refundsStayPending = true
    await compensateOrder(db, stripe, orderId, { subscriptionId: null, refunds: [{ step: 'refund-reader', paymentIntentId: intent }] }, 'test: unguarded', { actor: { type: 'system', id: null }, requestId: 'rv6' }, undefined)
    stripe.refundsStayPending = false
    held.release()
    expect((await screen).body).toMatchObject({ ok: true, data: { finalised: false, reason: 'charged_without_order' } })
    const compensationRefund = stripe.refundsSent.find((refund) => refund.payment_intent === intent)
    return { orderId, intent, refundId: compensationRefund?.id as string }
  }

  it("RV6: the late refund after the compensation's refund under its key failed: listed as failed for a person, never counted as confirmed", async () => {
    await onASeed(async (stripe) => {
      const { orderId, intent, refundId } = await lateRefundAfterPendingCompensation(stripe)
      stripe.settleRefund(refundId, 'failed')
      later(16)
      expect((await runReconcile(stripe)).items).toContainEqual(expect.objectContaining({ kind: 'refund', id: orderId, outcome: 'refund_failed' }))
      expect((await stuckList(db)).refunds).toEqual([expect.objectContaining({ id: orderId, paymentIntentId: intent, state: 'failed', words: REFUND_FAILED_WORDS(40, intent) })])
    })
  })

  it("RV7: the late refund after the compensation's refund under its key is still pending: listed as sent, never confirmed until Stripe says so", async () => {
    await onASeed(async (stripe) => {
      const { orderId, intent, refundId } = await lateRefundAfterPendingCompensation(stripe)
      later(16)
      expect((await runReconcile(stripe)).items).toContainEqual(expect.objectContaining({ kind: 'refund', id: orderId, outcome: 'refund_pending' }))
      expect((await stuckList(db)).refunds).toEqual([expect.objectContaining({ id: orderId, paymentIntentId: intent, state: 'sent' })])
      stripe.settleRefund(refundId, 'succeeded')
      later(6)
      expect((await runReconcile(stripe)).items).toContainEqual(expect.objectContaining({ kind: 'refund', id: orderId, outcome: 'refund_confirmed' }))
      expect((await stuckList(db)).refunds).toEqual([])
      expect(stripe.netPence).toBe(0)
      await invariant(stripe)
    })
  })
})

// ---------------------------------------------------------------------------------------------------
// W13d: the W13c review's S-1, S-2 and L3, each ending on the invariant where money moved.

/** Test data: what the old rollback (readerOrderRollback.ts) writes on an order it has started on. */
const oldRollbackStarts = (orderId: string) =>
  db.query(`UPDATE orders SET reader_payment = reader_payment || jsonb_build_object('rollback', jsonb_build_object('started_at', now()::text)) WHERE id = $1::uuid`, [orderId])

/**
 * Test data standing in for the old code's "Resolve now" after its rollback (old code, not run here): the order's
 * payment refunded and the order removed. The refund goes straight to the fake under the old code's own key; the
 * rollback's mark is lifted and the Worker's undo gives back what the order held and removes it.
 */
async function oldResolveNow(stripe: FakeStripe, orderId: string, paymentIntentId: string): Promise<void> {
  await stripe.refunds.create({ payment_intent: paymentIntentId }, { idempotencyKey: `old-rollback:${orderId}` })
  await db.query(`UPDATE orders SET reader_payment = reader_payment - 'rollback' WHERE id = $1::uuid`, [orderId])
  expect(await undoOrder(db, orderId, { actor: { type: 'system', id: null }, requestId: 'old-resolve', why: 'test: the old rollback' })).toEqual({ undone: true })
}

/** Only the first call `after` sees. */
const firstOnly = (): (() => boolean) => {
  let first = true
  return () => {
    const now = first
    first = false
    return now
  }
}

const refundKeys = (stripe: FakeStripe) => stripe.calls.filter((call) => call.method === 'refunds.create').map((call) => call.idempotencyKey)

describe("W13d S-1: the old rollback after the press's start, and the other answers on which no order can be paid with the press's subscription", () => {
  it("Q3: the old rollback starts on the order after the press's start, before T2: T2 records the press's subscription as left, the press cancels it at once; the old code's Resolve now then refunds the tap and removes the order", async () => {
    await onASeed(async (stripe) => {
      const { orderId, intent } = await tapped(stripe)
      after(stripe.subscriptions, 'create', () => oldRollbackStarts(orderId))
      const answer = await postReaderStep('finalise', orderId)
      expect(answer.body).toMatchObject({ ok: true, data: { finalised: false, reason: 'rollback_started' } })
      const made = stripe.subscriptionsMade[0] as string
      expect(stripe.subscription(made)?.status).toBe('canceled')
      expectLeftThenPutBack(await subscriptionLeftRows(orderId), made, 'rollback_started', 'cancelled')
      expect((await stuckList(db)).warnings).toEqual([])
      // The tap is the old rollback's to refund; the reader's first invoice is £0 (the coupon covers the tap's part).
      expect(refundKeys(stripe)).toEqual([])
      later(16)
      expect((await runReconcile(stripe)).items).toEqual([expect.objectContaining({ id: orderId, outcome: 'left', reason: 'old_rollback' })])
      await oldResolveNow(stripe, orderId, intent)
      expect(await runReconcile(stripe)).toMatchObject({ checked: 0 })
      expect(stripe.liveSubscriptions).toEqual([])
      expect(stripe.netPence).toBe(0)
      await invariant(stripe)
    })
  })

  it("Q3 with the put-back's cancel unclear: T2's left row and the put-back's, and the stuck list's warning; while the order exists reconcile leaves it to the old code; once the old code has removed it, the retry cancels the subscription and closes the warning", async () => {
    await onASeed(async (stripe) => {
      const { orderId, intent } = await tapped(stripe)
      after(stripe.subscriptions, 'create', async () => {
        await oldRollbackStarts(orderId)
        stripe.failNext('subscriptions.cancel', { kind: 'unreachable' })
        stripe.failNext('subscriptions.retrieve', { kind: 'unreachable' })
      })
      const answer = await postReaderStep('finalise', orderId)
      expect(answer.body).toMatchObject({ ok: true, data: { finalised: false, reason: 'rollback_started' } })
      const made = stripe.subscriptionsMade[0] as string
      expect(stripe.subscription(made)?.status).toBe('active')
      expectLeftThenPutBack(await subscriptionLeftRows(orderId), made, 'rollback_started', 'left')
      expect((await stuckList(db)).warnings).toEqual([expect.objectContaining({ kind: 'order', id: orderId, warning: SUBSCRIPTION_LEFT_WORDS(made) })])
      // The order still exists (the old code's to finish): the retry leaves it alone (L3, gone only).
      later(16)
      expect((await runReconcile(stripe)).items).toEqual([expect.objectContaining({ id: orderId, outcome: 'left', reason: 'old_rollback' })])
      expect(stripe.subscription(made)?.status).toBe('active')
      expect(await subscriptionLeftRows(orderId)).not.toContainEqual(expect.objectContaining({ state: 'cancelled' }))
      await oldResolveNow(stripe, orderId, intent)
      later(6)
      expect((await runReconcile(stripe)).items).toEqual([expect.objectContaining({ kind: 'order', id: orderId, outcome: 'undone', detail: `subscription ${made} put back: cancelled` })])
      expect(stripe.subscription(made)?.status).toBe('canceled')
      expect(await subscriptionLeftRows(orderId)).toContainEqual(expect.objectContaining({ state: 'cancelled', subscriptionId: made, found: 'reconcile' }))
      expect((await stuckList(db)).warnings).toEqual([])
      expect(await runReconcile(stripe)).toMatchObject({ checked: 0 })
      expect(refundKeys(stripe)).toEqual([`old-rollback:${orderId}`])
      expect(stripe.netPence).toBe(0)
      await invariant(stripe)
    })
  })

  it("the saved card: the old rollback's mark on the order after the charge (test data): T2 records the subscription as left and the press puts it back, its £40 first invoice refunded under :refund-subscription; the charge is the old code's", async () => {
    await onASeed(async (stripe) => {
      after(stripe.paymentIntents, 'create', async () => {
        const pending = (await orders()).find((order) => order.payment_status === 'pending')
        await oldRollbackStarts(pending?.id as string)
      })
      const answer = await place(withSoap)
      const orderId = (await orders())[0]?.id as string
      expect(errorOf(answer)).toMatchObject({ code: 'PAYMENT_UNCONFIRMED', details: { reason: 'payment_unconfirmed' } })
      const made = stripe.subscriptionsMade[0] as string
      expect(stripe.subscription(made)?.status).toBe('canceled')
      expectLeftThenPutBack(await subscriptionLeftRows(orderId), made, 'rollback_started', 'cancelled')
      expect(refundKeys(stripe)).toEqual([`${orderId}:refund-subscription`])
      expect(stripe.netPence).toBe(2400)
      const charge = [...stripe.chargedByIntent].find(([, pence]) => pence === 2400)?.[0] as string
      await oldResolveNow(stripe, orderId, charge)
      later(16)
      expect(await runReconcile(stripe)).toMatchObject({ checked: 0 })
      expect((await stuckList(db)).warnings).toEqual([])
      expect(stripe.netPence).toBe(0)
      await invariant(stripe)
    })
  })

  it.each([
    ['paid_by_another_payment', `UPDATE orders SET payment_status = 'paid', stripe_payment_intent_id = 'pi_another' WHERE id = $1::uuid`],
    ['not_pending', `UPDATE orders SET payment_status = 'failed' WHERE id = $1::uuid`],
  ] as const)("the reader: T2 answers %s after the press made its subscription (test data): recorded as left, then cancelled at once", async (reason, change) => {
    await onASeed(async (stripe) => {
      const { orderId } = await tapped(stripe)
      after(stripe.subscriptions, 'create', () => db.query(change, [orderId]))
      const answer = await postReaderStep('finalise', orderId)
      expect(answer.body).toMatchObject({ ok: true, data: { finalised: false, reason: 'unexpected_state' } })
      const made = stripe.subscriptionsMade[0] as string
      expect(stripe.subscription(made)?.status).toBe('canceled')
      expectLeftThenPutBack(await subscriptionLeftRows(orderId), made, reason, 'cancelled')
      expect((await stuckList(db)).warnings).toEqual([])
    })
  })
})

describe("W13d S-2: reconcile's saved-card path, the order undone by another actor between its list and T2", () => {
  it("T2 records the subscription reconcile found as left, first, with the charge for the late refund; the next run puts the subscription back (its first invoice refunded) and refunds the charge", async () => {
    await onASeed(async (stripe) => {
      const dying = dyingOn(stripe, 'paymentIntents', 'create', 'after')
      replayStripe.current = dying.client
      void place(withSoap)
      await dying.died
      replayStripe.current = stripe
      const orderId = (await orders())[0]?.id as string
      const made = stripe.subscriptionsMade[0] as string
      later(16)
      // Another actor (a second run, or the old code) undoes the order once this run has listed Stripe.
      after(
        stripe.subscriptions,
        'list',
        async () => expect(await undoOrder(db, orderId, { actor: { type: 'system', id: null }, requestId: 'another', why: 'test: another actor' })).toEqual({ undone: true }),
        firstOnly()
      )
      expect((await runReconcile(stripe)).items).toEqual([expect.objectContaining({ id: orderId, outcome: 'left', reason: 'charged_without_order', detail: made })])
      expect(stripe.subscription(made)?.status).toBe('active')
      expect(await subscriptionLeftRows(orderId)).toEqual([expect.objectContaining({ state: 'left', subscriptionId: made, found: 'order_gone', left: [LEFT_AT_T2] })])
      expect((await stuckList(db)).warnings).toEqual([expect.objectContaining({ id: orderId, warning: SUBSCRIPTION_LEFT_WORDS(made) })])
      later(6)
      const ran = await runReconcile(stripe)
      expect(ran.items).toContainEqual(expect.objectContaining({ kind: 'order', id: orderId, outcome: 'undone', detail: expect.stringContaining(`subscription ${made} put back: cancelled`) }))
      expect(ran.items).toContainEqual(expect.objectContaining({ kind: 'refund', id: orderId, outcome: 'refund_confirmed' }))
      expect(stripe.subscription(made)?.status).toBe('canceled')
      expect(new Set(refundKeys(stripe))).toEqual(new Set([`${orderId}:refund-subscription`, `${orderId}:refund-charge`]))
      expect(refundKeys(stripe)).toHaveLength(2)
      const stuck = await stuckList(db)
      expect(stuck.warnings).toEqual([])
      expect(stuck.refunds).toEqual([])
      expect(stripe.netPence).toBe(0)
      await invariant(stripe)
    })
  })
})

describe('W13d L3: the put-back retry takes only orders that no longer exist', () => {
  it("a left row on a paid order naming its own subscription (test data; no path writes one): never retried: nothing sent, the subscription stays active, nothing refunded; the warning stays for a person", async () => {
    await onASeed(async (stripe) => {
      const paid = dataOf(await place(withSoap))
      const theirs = paid.membershipSubscription?.subscriptionId as string
      const invoice = (await orders())[0]?.reader_payment?.membership?.subscription_payment_intent_id ?? null
      expect(invoice).not.toBeNull()
      await db.query(
        `INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, request_id, details)
         VALUES ('system', NULL, 'order.subscription_left', 'order', $1, 'w13d', $2::jsonb)`,
        [paid.orderId, { state: 'left', subscriptionId: theirs, invoicePaymentIntentId: invoice, amountPaid: 4000, found: 'order_gone', refunded: [], left: ['test'] }]
      )
      later(16)
      const before = stripe.calls.length
      expect((await runReconcile(stripe)).items).toEqual([])
      expect(sentAfter(stripe, before)).toEqual([])
      expect(stripe.subscription(theirs)?.status).toBe('active')
      expect(stripe.refundedPence).toBe(0)
      expect(stripe.netPence).toBe(6400)
      expect((await stuckList(db)).warnings).toEqual([expect.objectContaining({ id: paid.orderId, warning: SUBSCRIPTION_LEFT_WORDS(theirs) })])
      await invariant(stripe)
    })
  })
})
