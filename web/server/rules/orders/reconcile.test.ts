import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type Stripe from 'stripe'
import { GET as stuckRoute } from '@/app/api/v1/staff/orders/stuck/route'
import { POST as reconcileRoute } from '@/app/api/v1/staff/orders/reconcile/route'
import type { Db } from '@/server/db'
import { fakeStripeErrors, type FakeStripe } from '@/server/stripe/fake'
import { asWorkerFlow, postFlowStep } from '@/server/rules/testing/replay/flow-side'
import { oldSide, replay, REPLAY_USER, startReplay, type ReplayEnvironment } from '@/server/rules/testing/replay/harness'
import { orderInput, postOrder, postReaderStep, withQuotedCardFigure, type OrderAnswer } from '@/server/rules/testing/replay/order-side'
import { ID, lapsedSeat, paidSeat, sam, seed, whileFailing } from '@/server/rules/testing/replay/scenarios'
import { replayStripe } from '@/server/rules/testing/replay/stripe-binding'
import { finaliseOrder } from './finalise-order'
import { CARD_NOT_SAVED_WARNING } from './reader-order'
import { MANUAL_LIMITS, reconcile, SCHEDULED_LIMITS, type ReconcileOptions, type ReconcileResult } from './reconcile'
import { STRIPE_REFUSED_WORDS, STUCK_WORDS, stuckList } from './stuck-list'
import { undoOrder } from './undo-order'

// W12 item 3: reconcile, row by row (W03-plan 2.5 and the brief's extra rows), on PGlite with the live schema
// and the replay seed, FakeStripe for Stripe. Orders are placed through the real order route, held the way
// the pipeline holds them (Stripe unreachable, an answer lost, the Worker dying at a step, a database fault),
// then the clock moves past the 15-minute window and reconcile runs. Races are in reconcile-postgres.test.ts.

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

const soap = { productVariantId: ID.variant, quantity: 2, unitPrice: 12 }
const towel = { addonId: ID.addon, quantity: 1, unitPrice: 5 }
const alex = { name: 'Alex Guest', email: 'alex@example.com' }
/** A booking for two with a towel (£45) and two soaps (£24): £69. */
const basket = (method: 'card' | 'reader', extra: Record<string, unknown> = {}) => ({
  customerId: ID.customer,
  booking: { ...paidSeat([sam, alex]), addons: [{ ...towel, redemptionSource: 'paid' }] },
  products: [soap],
  payment: { method, ...extra },
})
const asSystem: ReconcileOptions = { actor: { type: 'system', id: null }, requestId: 'reconcile-test', ...SCHEDULED_LIMITS }
const run = (stripe: FakeStripe, options: Partial<ReconcileOptions> = {}): Promise<ReconcileResult> => reconcile(db, stripe, { ...asSystem, ...options })
const later = (minutes: number) => vi.setSystemTime(Date.now() + minutes * 60_000)
const place = async (params: Record<string, unknown>): Promise<OrderAnswer> => postOrder(await withQuotedCardFigure(orderInput(params)))

/** The seed's figures an order holds: places, stock, store credit, gift card. Back to these = given back. */
async function held() {
  const places = (await db.query<{ n: number }>('SELECT total_booked AS n FROM sessions WHERE id = $1', [ID.session]))[0]?.n
  const stock = (await db.query<{ n: number }>('SELECT stock_quantity AS n FROM product_variants WHERE id = $1', [ID.variant]))[0]?.n
  const credit = (await db.query<{ n: string }>('SELECT store_credit_balance::text AS n FROM customers WHERE id = $1', [ID.customer]))[0]?.n
  const giftCard = (await db.query<{ n: string }>('SELECT remaining_balance::text AS n FROM gift_cards WHERE id = $1', [ID.giftCard]))[0]?.n
  return { places, stock, credit, giftCard }
}
const NOTHING_HELD = { places: 0, stock: 5, credit: '30.00', giftCard: '40.00' }
const orders = async () => db.query<{ id: string; payment_status: string; stripe_payment_intent_id: string | null }>('SELECT id, payment_status, stripe_payment_intent_id FROM orders ORDER BY created_at')
const reconcileRows = async (entityId: string) =>
  (await db.query<{ details: Record<string, unknown>; actor_type: string }>("SELECT details, actor_type FROM audit_log WHERE action = 'order.reconcile' AND entity_id = $1 ORDER BY at, id", [entityId])).map((row) => ({
    actor: row.actor_type,
    ...row.details,
  }))

/**
 * The invariant every crash test ends on (brief: "no money without an order, no order without money, nothing
 * held"): each PaymentIntent that took money (less what was refunded) is on exactly one paid order; every paid
 * order with a PaymentIntent took that money; nothing is pending; and nothing is held for an order that's gone.
 */
async function invariant(stripe: FakeStripe): Promise<void> {
  const all = await orders()
  expect(all.filter((order) => order.payment_status === 'pending')).toEqual([])
  const net = new Map([...stripe.chargedByIntent].map(([id, pence]) => [id, pence - (stripe.refundedByIntent.get(id) ?? 0)]))
  for (const [id, pence] of net) {
    if (pence > 0) expect(all.filter((order) => order.stripe_payment_intent_id === id && order.payment_status === 'paid'), `money taken on ${id} has no paid order`).toHaveLength(1)
  }
  for (const order of all) {
    if (order.stripe_payment_intent_id) expect(net.get(order.stripe_payment_intent_id) ?? 0, `paid order ${order.id} has no money`).toBeGreaterThan(0)
  }
  if (all.length === 0) expect(await held()).toEqual(NOTHING_HELD)
}

interface Run {
  stripe: FakeStripe
}

async function onASeed(work: (context: Run) => Promise<void>, prepare?: (seedDb: Db, stripe: FakeStripe) => Promise<void>): Promise<void> {
  await replay(
    environment,
    {
      name: 'reconcile test',
      async seed(seedDb, stripe) {
        await seed(seedDb, stripe)
        await prepare?.(seedDb, stripe)
      },
      async run({ stripe }) {
        replayStripe.current = stripe
        await work({ stripe })
      },
    },
    (_db, stripe) => ({ name: 'test', call: async () => stripe })
  )
}

/** A Stripe whose `method` call takes effect (or not) and then never answers: the Worker died there. */
function dyingOn(stripe: FakeStripe, method: 'create' | 'retrieve', when: 'before' | 'after'): { client: FakeStripe; died: Promise<void> } {
  let dead: () => void = () => undefined
  const died = new Promise<void>((resolve) => {
    dead = resolve
  })
  const client = Object.create(stripe) as FakeStripe
  Object.defineProperty(client, 'paymentIntents', {
    value: {
      ...stripe.paymentIntents,
      [method]: async (...args: unknown[]) => {
        if (when === 'after') await (stripe.paymentIntents[method] as (...a: unknown[]) => Promise<unknown>)(...args)
        dead()
        return new Promise<never>(() => undefined)
      },
    },
  })
  return { client, died }
}

/** A third customer with a saved card, so several card orders can be held at once (Q10 refuses a second for one customer). */
const OTHERS = [
  { id: ID.member, stripe: 'cus_member' },
  { id: '10000000-0000-4000-8000-0000000000f1', stripe: 'cus_third' },
]
async function addThirdCustomer(seedDb: Db, stripe: FakeStripe): Promise<void> {
  await seedDb.query(
    `INSERT INTO customers (id, first_name, last_name, email, date_of_birth, stripe_customer_id, saved_payment_method_id, saved_card_last4, saved_card_brand)
     VALUES ($1, 'Tia', 'Third', 'tia@example.com', '1992-02-02', 'cus_third', 'pm_third', '1111', 'visa')`,
    [OTHERS[1]?.id]
  )
  stripe.addCustomer('cus_third')
}
/** A soap on the card for `customerId`, held: Stripe unreachable twice. */
async function heldSoap(stripe: FakeStripe, customerId: string): Promise<void> {
  stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
  stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
  const answer = await place({ customerId, products: [{ ...soap, quantity: 1 }], payment: { method: 'card' } })
  expect(answer.body).toMatchObject({ ok: false, error: { code: 'PAYMENT_UNCONFIRMED' } })
}
const everyone = [ID.customer, ...OTHERS.map((other) => other.id)]

const pendingOrder = async () => (await db.query<{ id: string }>("SELECT id FROM orders WHERE payment_status = 'pending'"))[0]?.id as string

// --- 2.5's table, for a saved-card order

describe('a Worker card order held pending (W10)', () => {
  it('Stripe took the money but the answer was lost twice: reconcile finds it by metadata.order_id and runs T2; paid once', async () => {
    await onASeed(async ({ stripe }) => {
      stripe.failNext('paymentIntents.create', { kind: 'lost_response' })
      stripe.failNext('paymentIntents.create', { kind: 'lost_response' })
      expect((await place(basket('card'))).body).toMatchObject({ ok: false, error: { code: 'PAYMENT_UNCONFIRMED' } })
      const orderId = await pendingOrder()
      later(14)
      expect((await run(stripe)).checked).toBe(0) // under the window: not touched
      later(2)
      const result = await run(stripe)
      expect(result).toMatchObject({ checked: 1, finalised: 1, undone: 0, left: 0 })
      expect(stripe.calls.filter((call) => call.method === 'paymentIntents.list')[0]?.params).toMatchObject({ customer: 'cus_seed', limit: 100 })
      expect(await orders()).toEqual([{ id: orderId, payment_status: 'paid', stripe_payment_intent_id: expect.any(String) }])
      expect(await reconcileRows(orderId)).toEqual([{ actor: 'system', outcome: 'finalised', detail: expect.stringMatching(/^pi_/) }])
      expect((await run(stripe)).checked).toBe(0)
      expect(stripe.calls.filter((call) => call.method === 'paymentIntents.create')).toHaveLength(2) // never a new charge
      await invariant(stripe)
    })
  })

  it('Stripe never got the charge (unreachable twice): nothing found, undone, everything given back', async () => {
    await onASeed(async ({ stripe }) => {
      stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
      stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
      await place(basket('card', { giftCard: { giftCardId: ID.giftCard, amount: 10 }, storeCredit: { amount: 15 } }))
      const orderId = await pendingOrder()
      expect(await held()).toEqual({ places: 2, stock: 3, credit: '15.00', giftCard: '30.00' })
      later(16)
      expect(await run(stripe)).toMatchObject({ checked: 1, undone: 1 })
      expect(await held()).toEqual(NOTHING_HELD)
      expect(await reconcileRows(orderId)).toEqual([{ actor: 'system', outcome: 'undone', detail: 'Stripe has no payment for this card order' }])
      expect(stripe.calls.filter((call) => call.method === 'paymentIntents.create')).toHaveLength(2)
      await invariant(stripe)
    })
  })

  it('a payment that failed or was cancelled at Stripe: cancelled where it can be, then undone', async () => {
    await onASeed(async ({ stripe }) => {
      stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
      stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
      await place(basket('card'))
      const orderId = await pendingOrder()
      // A declined charge leaves its intent at requires_payment_method.
      await stripe.paymentIntents.create({ amount: 6900, currency: 'gbp', customer: 'cus_seed', metadata: { order_id: orderId } })
      later(16)
      expect(await run(stripe)).toMatchObject({ undone: 1 })
      expect(stripe.calls.map((call) => call.method)).toContain('paymentIntents.cancel')
      await invariant(stripe)
    })
  })

  it('still processing at Stripe: left (the money may yet move); listed with plain words', async () => {
    await onASeed(async ({ stripe }) => {
      stripe.failNext('paymentIntents.create', { kind: 'lost_response' })
      stripe.failNext('paymentIntents.create', { kind: 'lost_response' })
      await place(basket('card'))
      const orderId = await pendingOrder()
      const intent = [...stripe.chargedByIntent.keys()][0] as string
      stripe.markProcessing(intent)
      later(16)
      expect(await run(stripe)).toMatchObject({ finalised: 0, undone: 0, left: 1 })
      expect(await held()).toMatchObject({ places: 2, stock: 3 })
      const stuck = await stuckList(db)
      expect(stuck.checkout).toEqual([expect.objectContaining({ orderId, method: 'card', reason: 'unclear', words: STUCK_WORDS['unclear'] })])
      // Recorded once per reason, not every run.
      await run(stripe)
      expect((await reconcileRows(orderId)).filter((row) => (row as { outcome?: string }).outcome === 'left')).toHaveLength(1)
    })
  })

  it('amounts that don\'t match: left for a person (amount_mismatch), never paid or undone', async () => {
    await onASeed(async ({ stripe }) => {
      stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
      stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
      await place(basket('card'))
      const orderId = await pendingOrder()
      await stripe.paymentIntents.create({ amount: 6800, currency: 'gbp', customer: 'cus_seed', payment_method: 'pm_seed', confirm: true, metadata: { order_id: orderId } })
      later(16)
      expect(await run(stripe)).toMatchObject({ left: 1 })
      expect(await reconcileRows(orderId)).toEqual([{ actor: 'system', outcome: 'left', reason: 'amount_mismatch', detail: expect.stringMatching(/^pi_/) }])
      expect((await stuckList(db)).checkout[0]).toMatchObject({ reason: 'amount_mismatch', words: STUCK_WORDS['amount_mismatch'] })
      expect((await orders())[0]?.payment_status).toBe('pending')
    })
  })

  it('changed_since (W10 review L1, R1): old code cancelled the held booking; the undo refuses, reconcile lists it for a person', async () => {
    await onASeed(async ({ stripe }) => {
      stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
      stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
      await place({ ...basket('card'), booking: { ...paidSeat([sam]), redemptionSource: 'session_pass_credit', sessionPassId: ID.ownedPass }, products: [{ ...soap, quantity: 1 }] })
      const orderId = await pendingOrder()
      later(16)
      const bookingId = (await db.query<{ id: string }>('SELECT id FROM bookings WHERE customer_id = $1', [ID.customer]))[0]?.id
      await oldSide(db, stripe).call('cancelCreditBooking', { bookingId })
      expect(await run(stripe)).toMatchObject({ undone: 0, left: 1 })
      expect(await reconcileRows(orderId)).toEqual([{ actor: 'system', outcome: 'left', reason: 'changed_since', detail: 'the booking is cancelled' }])
      expect((await stuckList(db)).checkout[0]).toMatchObject({ reason: 'changed_since' })
      // R1's counts: the place and the pass session given back once (by old Cancel), the soap still held.
      const session = (await db.query<{ n: number }>('SELECT total_booked AS n FROM sessions WHERE id = $1', [ID.session]))[0]?.n
      const pass = (await db.query<{ n: number }>('SELECT sessions_remaining AS n FROM customer_session_passes WHERE id = $1', [ID.ownedPass]))[0]?.n
      expect({ session, pass, stock: (await held()).stock }).toEqual({ session: 0, pass: 3, stock: 4 })
    })
  })

  it("a key of the other mode (W11 review L1): Stripe's list shows nothing, which isn't 'nothing was taken': left, not undone", async () => {
    await onASeed(async ({ stripe }) => {
      stripe.failNext('paymentIntents.create', { kind: 'lost_response' })
      stripe.failNext('paymentIntents.create', { kind: 'lost_response' })
      await place(basket('card'))
      const orderId = await pendingOrder()
      later(16)
      stripe.keyLivemode = true
      expect(await run(stripe)).toMatchObject({ undone: 0, finalised: 0, left: 1 })
      expect((await reconcileRows(orderId))[0]).toMatchObject({ outcome: 'left', reason: 'other_mode' })
      expect(await held()).toMatchObject({ places: 2, stock: 3 })
      stripe.keyLivemode = false
      expect(await run(stripe)).toMatchObject({ finalised: 1 })
      await invariant(stripe)
    })
  })

  it('a record with no mode (written before W12) and nothing found: left, not undone', async () => {
    await onASeed(async ({ stripe }) => {
      stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
      stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
      await place(basket('card'))
      const orderId = await pendingOrder()
      await db.query("UPDATE orders SET reader_payment = reader_payment - 'livemode' WHERE id = $1", [orderId])
      later(16)
      expect(await run(stripe)).toMatchObject({ undone: 0, left: 1 })
    })
  })

  it('a 401 or a 403 on its reads: Stripe refused the key; one alert row for the run, nothing changed, nothing else tried', async () => {
    for (const refusal of [fakeStripeErrors.authentication(), fakeStripeErrors.permission()]) {
      expect([401, 403]).toContain(refusal.statusCode)
      await onASeed(async ({ stripe }) => {
        for (const customerId of everyone.slice(0, 2)) {
          await heldSoap(stripe, customerId)
          later(1)
        }
        later(16)
        stripe.failNext('paymentIntents.list', { kind: 'error', error: refusal })
        const result = await run(stripe)
        expect(result).toMatchObject({ stripeRefused: true, checked: 0, undone: 0, finalised: 0, deferred: 2 })
        expect(stripe.calls.filter((call) => call.method === 'paymentIntents.list')).toHaveLength(1)
        const alerts = await db.query<{ details: Record<string, unknown> }>("SELECT details FROM audit_log WHERE action = 'reconcile.stripe_refused'")
        expect(alerts).toEqual([{ details: { status: refusal.statusCode, message: refusal.message, waiting: 2 } }])
        expect((await orders()).every((order) => order.payment_status === 'pending')).toBe(true)
        expect((await stuckList(db)).alert).toEqual({ at: expect.any(String), words: STRIPE_REFUSED_WORDS })
        // Not "Stripe unavailable" item by item: no left rows were written.
        expect(await db.query("SELECT 1 FROM audit_log WHERE action = 'order.reconcile'")).toEqual([])
      }, addThirdCustomer)
    }
  })
})

// --- The reader

describe('a Worker reader order held pending (W11)', () => {
  const placeReader = async (extra: Record<string, unknown> = {}) => {
    const answer = await place(basket('reader', extra))
    if (!answer.body.ok || !answer.body.data.pendingReaderPayment) throw new Error('not placed')
    return answer.body.data.pendingReaderPayment
  }

  it('(b) with its intent, never tapped: reconcile cancels the intent and undoes the order', async () => {
    await onASeed(async ({ stripe }) => {
      const { orderId } = await placeReader()
      later(16)
      expect(await run(stripe)).toMatchObject({ undone: 1 })
      expect(await reconcileRows(orderId)).toEqual([{ actor: 'system', outcome: 'undone', detail: 'the reader payment was cancelled' }])
      await invariant(stripe)
    })
  })

  it('(b) tapped, but the screen never finalised (browser closed): reconcile finalises it, once', async () => {
    await onASeed(async ({ stripe }) => {
      const { orderId, paymentIntentId } = await placeReader()
      stripe.completeReaderPayment(paymentIntentId)
      later(16)
      expect(await run(stripe)).toMatchObject({ finalised: 1 })
      expect((await orders())[0]).toEqual({ id: orderId, payment_status: 'paid', stripe_payment_intent_id: paymentIntentId })
      await invariant(stripe)
    })
  })

  it('R6 (W03a later 6): finalised with the save-card warning, which reaches the stuck list', async () => {
    await onASeed(async ({ stripe }) => {
      const { orderId, paymentIntentId } = await placeReader({ readerSaveCard: true })
      stripe.completeReaderPayment(paymentIntentId, { simulatedReader: true })
      later(16)
      const result = await run(stripe)
      expect(result.items).toEqual([expect.objectContaining({ id: orderId, outcome: 'finalised', warning: CARD_NOT_SAVED_WARNING })])
      expect((await stuckList(db)).warnings).toEqual([{ kind: 'order', id: orderId, at: expect.any(String), warning: CARD_NOT_SAVED_WARNING }])
    })
  })

  it('finalise_failed (a database fault in T2 after the tap): reconcile finalises it again', async () => {
    await onASeed(async ({ stripe }) => {
      const { orderId, paymentIntentId } = await placeReader()
      stripe.completeReaderPayment(paymentIntentId)
      const answer = await whileFailing(db, { table: 'orders', event: 'UPDATE', when: "NEW.payment_status = 'paid'" }, () => postReaderStep('finalise', orderId))
      expect(answer.body).toMatchObject({ ok: true, data: { finalised: false, reason: 'finalise_failed' } })
      later(16)
      expect(await run(stripe)).toMatchObject({ finalised: 1 })
      expect(stripe.refundedPence).toBe(0)
      await invariant(stripe)
    })
  })

  it('(a) held with no intent written (the Worker died after T1): nothing in Stripe names it, undone', async () => {
    await onASeed(async ({ stripe }) => {
      const dying = dyingOn(stripe, 'create', 'before')
      replayStripe.current = dying.client
      void place(basket('reader'))
      await dying.died
      replayStripe.current = stripe
      const orderId = await pendingOrder()
      later(16)
      expect(await run(stripe)).toMatchObject({ undone: 1 })
      expect(await reconcileRows(orderId)).toEqual([{ actor: 'system', outcome: 'undone', detail: expect.stringContaining('Stripe has no reader payment') }])
      await invariant(stripe)
    })
  })

  it('(a) the intent made but never written onto the order (bug 14): found by metadata.order_id, cancelled, then undone', async () => {
    await onASeed(async ({ stripe }) => {
      const dying = dyingOn(stripe, 'create', 'after')
      replayStripe.current = dying.client
      void place(basket('reader'))
      await dying.died
      replayStripe.current = stripe
      later(16)
      expect(await run(stripe)).toMatchObject({ undone: 1 })
      expect(stripe.calls.map((call) => call.method)).toEqual(['paymentIntents.create', 'paymentIntents.list', 'paymentIntents.retrieve', 'paymentIntents.cancel'])
      await invariant(stripe)
    })
  })

  it('(a) without a Stripe customer on its record: listed by a window around the order, of any customer', async () => {
    await onASeed(async ({ stripe }) => {
      await db.query('UPDATE customers SET stripe_customer_id = NULL WHERE id = $1', [ID.customer])
      const dying = dyingOn(stripe, 'create', 'after')
      replayStripe.current = dying.client
      void place(basket('reader'))
      await dying.died
      replayStripe.current = stripe
      later(16)
      expect(await run(stripe)).toMatchObject({ undone: 1 })
      const listed = stripe.calls.find((call) => call.method === 'paymentIntents.list')?.params as Stripe.PaymentIntentListParams
      expect(listed.customer).toBeUndefined()
      expect(listed.created).toEqual({ gte: expect.any(Number), lte: expect.any(Number) })
      await invariant(stripe)
    })
  })

  it('a 404 for its intent from a key of its own mode: never existed, undone; from the other mode: left', async () => {
    await onASeed(async ({ stripe }) => {
      const { orderId } = await placeReader()
      later(16)
      stripe.keyLivemode = true
      expect(await run(stripe)).toMatchObject({ undone: 0, left: 1 })
      expect((await reconcileRows(orderId))[0]).toMatchObject({ outcome: 'left', reason: 'other_mode' })
      stripe.keyLivemode = false
      stripe.failNext('paymentIntents.retrieve', { kind: 'error', error: fakeStripeErrors.missing(`payment_intent: 'x'`) })
      expect(await run(stripe)).toMatchObject({ undone: 1 })
    })
  })
})

// --- The automatic refund of a late payment ("W12 calls")

describe('a payment that succeeded on an order already undone (charged_without_order)', () => {
  /** A card order charged (answer lost), undone meanwhile, and T2 then finding it gone: what T2 records. */
  async function chargedWithoutOrder(stripe: FakeStripe, method: 'card' | 'reader'): Promise<{ orderId: string; paymentIntentId: string }> {
    let paymentIntentId: string
    if (method === 'card') {
      stripe.failNext('paymentIntents.create', { kind: 'lost_response' })
      stripe.failNext('paymentIntents.create', { kind: 'lost_response' })
      await place(basket('card'))
      paymentIntentId = [...stripe.chargedByIntent.keys()][0] as string
    } else {
      const answer = await place(basket('reader'))
      if (!answer.body.ok || !answer.body.data.pendingReaderPayment) throw new Error('not placed')
      paymentIntentId = answer.body.data.pendingReaderPayment.paymentIntentId
      stripe.completeReaderPayment(paymentIntentId)
    }
    const orderId = await pendingOrder()
    await undoOrder(db, orderId, { actor: { type: 'system', id: null }, requestId: 't', why: 'test' })
    vi.setSystemTime(Date.now() + 1_000)
    const paymentIntent = (await stripe.paymentIntents.retrieve(paymentIntentId)) as Stripe.PaymentIntent
    expect(await finaliseOrder(db, orderId, paymentIntent, { actor: { type: 'system', id: null }, requestId: 't' })).toEqual({ finalised: false, reason: 'order_gone' })
    return { orderId, paymentIntentId }
  }

  it('a saved card: refunded in full under <orderId>:refund-charge, its row written before the send, confirmed, and never twice', async () => {
    await onASeed(async ({ stripe }) => {
      const { orderId, paymentIntentId } = await chargedWithoutOrder(stripe, 'card')
      // The row must be in the database (committed) when Stripe is asked.
      const create = stripe.refunds.create
      let rowAtSend: unknown[] = []
      stripe.refunds.create = async (params, options) => {
        rowAtSend = await reconcileRows(orderId)
        return create(params, options)
      }
      expect((await stuckList(db)).refunds).toEqual([expect.objectContaining({ kind: 'order', id: orderId, paymentIntentId, amount: 69, state: 'waiting' })])
      const result = await run(stripe)
      expect(result.items).toEqual([{ kind: 'refund', id: orderId, outcome: 'refund_confirmed' }])
      expect(rowAtSend).toEqual([{ actor: 'system', outcome: 'refund_started', refund: { paymentIntentId, state: 'started', key: `${orderId}:refund-charge`, amount: 6900 } }])
      expect(stripe.calls.filter((call) => call.method === 'refunds.create')).toEqual([
        { method: 'refunds.create', params: { payment_intent: paymentIntentId, metadata: { refund_key: `${orderId}:refund-charge`, order_id: orderId, reason: 'paid_after_undone' } }, idempotencyKey: `${orderId}:refund-charge` },
      ])
      expect(stripe.refundedByIntent.get(paymentIntentId)).toBe(6900)
      expect((await stuckList(db)).refunds).toEqual([])
      await run(stripe)
      await run(stripe)
      expect(stripe.calls.filter((call) => call.method === 'refunds.create')).toHaveLength(1)
      expect(stripe.refundedPence).toBe(6900)
    })
  })

  it('the reader: <orderId>:refund-reader', async () => {
    await onASeed(async ({ stripe }) => {
      const { orderId } = await chargedWithoutOrder(stripe, 'reader')
      await run(stripe)
      expect(stripe.calls.filter((call) => call.method === 'refunds.create').map((call) => call.idempotencyKey)).toEqual([`${orderId}:refund-reader`])
      expect(stripe.netPence).toBe(0)
    })
  })

  it('Stripe answers pending: listed until a later run sees it succeed', async () => {
    await onASeed(async ({ stripe }) => {
      const { orderId, paymentIntentId } = await chargedWithoutOrder(stripe, 'card')
      stripe.refundsStayPending = true
      expect((await run(stripe)).items).toEqual([{ kind: 'refund', id: orderId, outcome: 'refund_pending', reason: 'refund_pending' }])
      later(5)
      expect((await stuckList(db)).refunds).toEqual([expect.objectContaining({ id: orderId, state: 'sent' })])
      later(5)
      expect((await run(stripe)).items[0]).toMatchObject({ outcome: 'refund_pending' })
      stripe.settleRefund(stripe.refundsSent[0]?.id as string, 'succeeded')
      expect((await run(stripe)).items[0]).toMatchObject({ outcome: 'refund_confirmed' })
      expect((await stuckList(db)).refunds).toEqual([])
      expect(stripe.calls.filter((call) => call.method === 'refunds.create')).toHaveLength(1)
      expect(stripe.refundedByIntent.get(paymentIntentId)).toBe(6900)
    })
  })

  it('no clear answer to the refund: sent again next run with the same key, refunded once', async () => {
    await onASeed(async ({ stripe }) => {
      const { orderId } = await chargedWithoutOrder(stripe, 'card')
      stripe.failNext('refunds.create', { kind: 'lost_response' })
      expect((await run(stripe)).items[0]).toMatchObject({ outcome: 'refund_pending', reason: 'unclear' })
      expect((await stuckList(db)).refunds[0]).toMatchObject({ state: 'started' })
      later(5)
      expect((await run(stripe)).items[0]).toMatchObject({ outcome: 'refund_confirmed' })
      expect(stripe.calls.filter((call) => call.method === 'refunds.create').map((call) => call.idempotencyKey)).toEqual([`${orderId}:refund-charge`, `${orderId}:refund-charge`])
      expect(stripe.refundedPence).toBe(6900)
      expect((await reconcileRows(orderId)).filter((row) => (row as { refund?: { state: string } }).refund?.state === 'started')).toHaveLength(1)
    })
  })

  it('a refund Stripe turns down, or that later fails: listed for a person, not tried again', async () => {
    await onASeed(async ({ stripe }) => {
      const { orderId, paymentIntentId } = await chargedWithoutOrder(stripe, 'card')
      stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.invalid('charge_disputed', 'This charge is disputed.') })
      expect((await run(stripe)).items[0]).toMatchObject({ outcome: 'refund_failed' })
      expect((await stuckList(db)).refunds).toEqual([expect.objectContaining({ id: orderId, state: 'failed', words: expect.stringContaining('Refund it in Stripe by hand') })])
      await run(stripe)
      expect(stripe.calls.filter((call) => call.method === 'refunds.create')).toHaveLength(1)
      expect(stripe.refundedByIntent.get(paymentIntentId) ?? 0).toBe(0)
    })
  })

  it('refunded by hand before reconcile got to it (charge_already_refunded): confirmed, nothing sent twice', async () => {
    await onASeed(async ({ stripe }) => {
      const { paymentIntentId } = await chargedWithoutOrder(stripe, 'card')
      await stripe.refunds.create({ payment_intent: paymentIntentId })
      expect((await run(stripe)).items[0]).toMatchObject({ outcome: 'refund_confirmed', detail: 'already refunded' })
      expect(stripe.refundedPence).toBe(6900)
    })
  })

  it('a flow: <pendingId>:refund-reader, from reader_payment.charge_without_record', async () => {
    await onASeed(
      async ({ stripe }) => {
        const old = oldSide(db, stripe)
        const bookingId = await lapsedSeat((action, params) => old.call(action, params), db)
        const started = (await old.call('settleLapsedBooking', { bookingId, payment: { method: 'reader' } })) as { pendingReaderPayment: { pendingId: string; paymentIntentId: string } }
        const { pendingId, paymentIntentId } = started.pendingReaderPayment
        await asWorkerFlow(db, pendingId)
        replayStripe.current = stripe
        await postFlowStep('cancel', pendingId) // undone: the intent cancelled
        // The tap that "lands" anyway is modelled by T2 meeting a cancelled row with a succeeded payment.
        stripe.completeReaderPayment(paymentIntentId)
        const { finaliseFlowInTransaction } = await import('./reader-flow')
        vi.setSystemTime(Date.now() + 1_000)
        expect(await finaliseFlowInTransaction(db, pendingId, (await stripe.paymentIntents.retrieve(paymentIntentId)) as Stripe.PaymentIntent, { actor: { type: 'system', id: null }, requestId: 't' })).toEqual({
          finalised: false,
          reason: 'charged_without_record',
        })
        expect((await stuckList(db)).refunds).toEqual([expect.objectContaining({ kind: 'flow', id: pendingId, amount: 20 })])
        await run(stripe)
        expect(stripe.calls.filter((call) => call.method === 'refunds.create').map((call) => call.idempotencyKey)).toEqual([`${pendingId}:refund-reader`])
        expect(stripe.netPence).toBe(0)
      }
    )
  })

  // W12a, W12 review S2 (b), plants RPB and RPC: a refused key on the refund's send is the key, not the refund.
  it('a 401 or a 403 on the refund\'s send: the refund stays started, the run stops with one alert row, and the next run sends it again with the same key once the key works', async () => {
    for (const refusal of [fakeStripeErrors.authentication(), fakeStripeErrors.permission()]) {
      await onASeed(async ({ stripe }) => {
        const { orderId, paymentIntentId } = await chargedWithoutOrder(stripe, 'card')
        stripe.failNext('refunds.create', { kind: 'error', error: refusal })
        const first = await run(stripe)
        expect(first).toMatchObject({ stripeRefused: true, checked: 0, refunds: 0, deferred: 1, items: [] })
        const states = async () => (await reconcileRows(orderId)).map((row) => (row as { refund?: { state: string } }).refund?.state)
        expect(await states()).toEqual(['started'])
        const alerts = await db.query<{ details: Record<string, unknown> }>("SELECT details FROM audit_log WHERE action = 'reconcile.stripe_refused'")
        expect(alerts).toEqual([{ details: { status: refusal.statusCode, message: refusal.message, waiting: 1 } }])
        const stuck = await stuckList(db)
        expect(stuck.refunds).toEqual([expect.objectContaining({ id: orderId, state: 'started', words: expect.stringContaining("Don't refund it by hand") })])
        expect(stuck.alert).toEqual({ at: expect.any(String), words: STRIPE_REFUSED_WORDS })
        expect(stripe.refundedPence).toBe(0)

        later(5)
        const second = await run(stripe)
        expect(second).toMatchObject({ stripeRefused: false, items: [{ kind: 'refund', id: orderId, outcome: 'refund_confirmed' }] })
        expect(stripe.calls.filter((call) => call.method === 'refunds.create').map((call) => call.idempotencyKey)).toEqual([`${orderId}:refund-charge`, `${orderId}:refund-charge`])
        expect(stripe.refundedByIntent.get(paymentIntentId)).toBe(6900)
        expect(await states()).toEqual(['started', 'confirmed'])
        expect(await db.query("SELECT 1 FROM audit_log WHERE action = 'reconcile.stripe_refused'")).toHaveLength(1)
        expect((await stuckList(db)).refunds).toEqual([])
      })
    }
  })

  // W12a, W12 review L7: the refund is automatic; a staff member's run only sends it sooner.
  it("a staff member's manual run: the refund's rows are the system's (naming who ran it); the run's other rows stay the staff member's", async () => {
    await onASeed(async ({ stripe }) => {
      const { orderId } = await chargedWithoutOrder(stripe, 'card')
      later(1)
      await heldSoap(stripe, ID.member)
      later(16)
      const staff = { type: 'staff' as const, id: ID.staff }
      expect(await run(stripe, { ...MANUAL_LIMITS, actor: staff })).toMatchObject({ refunds: 1, undone: 1 })
      const rows = await db.query<{ entity_id: string; actor_type: string; actor_id: string | null; details: { outcome: string; runBy?: unknown } }>(
        "SELECT entity_id, actor_type, actor_id, details FROM audit_log WHERE action = 'order.reconcile' ORDER BY at, id"
      )
      // Under the test clock both refund rows can carry the same millisecond: compared in outcome order.
      const refundRows = rows.filter((row) => row.entity_id === orderId).sort((a, b) => a.details.outcome.localeCompare(b.details.outcome))
      expect(refundRows.map((row) => [row.details.outcome, row.actor_type, row.actor_id, row.details.runBy])).toEqual([
        ['refund_confirmed', 'system', null, staff],
        ['refund_started', 'system', null, staff],
      ])
      expect(rows.filter((row) => row.entity_id !== orderId).map((row) => [row.details.outcome, row.actor_type, row.actor_id])).toEqual([['undone', 'staff', ID.staff]])
    }, addThirdCustomer)
  })
})

// --- Flows

describe('reader flows the Worker started (step D) and the old code started', () => {
  async function startSettle(stripe: FakeStripe, worker: boolean) {
    const old = oldSide(db, stripe)
    const bookingId = await lapsedSeat((action, params) => old.call(action, params), db)
    const started = (await old.call('settleLapsedBooking', { bookingId, payment: { method: 'reader' } })) as { pendingReaderPayment: { pendingId: string; paymentIntentId: string } }
    if (worker) await asWorkerFlow(db, started.pendingReaderPayment.pendingId)
    replayStripe.current = stripe
    return { ...started.pendingReaderPayment, bookingId }
  }
  const flowStatus = async (pendingId: string) => (await db.query<{ status: string }>('SELECT status FROM pending_reader_payments WHERE id = $1', [pendingId]))[0]?.status

  it('with its intent, never tapped: cancelled and undone; tapped: finalised', async () => {
    await onASeed(async ({ stripe }) => {
      const untapped = await startSettle(stripe, true)
      later(16)
      expect(await run(stripe)).toMatchObject({ undone: 1 })
      expect(await flowStatus(untapped.pendingId)).toBe('cancelled')
      expect(await reconcileRows(untapped.pendingId)).toEqual([{ actor: 'system', outcome: 'undone', detail: null }])
    })
    await onASeed(async ({ stripe }) => {
      const tapped = await startSettle(stripe, true)
      stripe.completeReaderPayment(tapped.paymentIntentId)
      later(16)
      expect(await run(stripe)).toMatchObject({ finalised: 1 })
      expect(await flowStatus(tapped.pendingId)).toBe('finalised')
    })
  })

  it('held with no intent on its row: Stripe listed for metadata.pending_id; none, so undone (in its own mode)', async () => {
    await onASeed(async ({ stripe }) => {
      const flow = await startSettle(stripe, true)
      await db.query('UPDATE pending_reader_payments SET payment_intent_id = NULL WHERE id = $1', [flow.pendingId])
      later(16)
      expect(await run(stripe)).toMatchObject({ undone: 1 })
      expect(await flowStatus(flow.pendingId)).toBe('cancelled')
    })
  })

  it("a flow with no mark of the Worker's (W25: none can be made any more): untouched, no Stripe call, listed for a person", async () => {
    await onASeed(async ({ stripe }) => {
      const flow = await startSettle(stripe, false)
      later(16)
      const calls = stripe.calls.length
      const result = await run(stripe)
      expect(result).toMatchObject({ checked: 0 })
      // W25: the run counts nothing as "the old code's" any more: these are all its fields.
      expect(Object.keys(result).sort()).toEqual(['checked', 'deferred', 'finalised', 'items', 'left', 'refunds', 'stripeRefused', 'undone'])
      expect(stripe.calls.length).toBe(calls)
      expect(await flowStatus(flow.pendingId)).toBe('pending')
      expect((await stuckList(db)).flows).toEqual([expect.objectContaining({ pendingId: flow.pendingId, reason: 'not_started_here', words: STUCK_WORDS['not_started_here'] })])
      expect(STUCK_WORDS['not_started_here']).toMatch(/tell a manager/)
      expect(STUCK_WORDS['not_started_here']).not.toMatch(/Resolve now|old screens/)
    })
  })

  it("an order with no mark of the Worker's is left alone too, and listed for a person", async () => {
    await onASeed(async ({ stripe }) => {
      await oldSide(db, stripe).call('createOrder', basket('reader'))
      later(16)
      expect(await run(stripe)).toMatchObject({ checked: 0 })
      expect((await stuckList(db)).checkout).toEqual([expect.objectContaining({ method: null, reason: 'not_started_here', words: STUCK_WORDS['not_started_here'] })])
    })
  })
})

// --- Bounds, the manual run, the stuck list route

describe('a run is bounded', () => {
  it('at most maxItems: the rest wait for the next run, oldest first', async () => {
    await onASeed(async ({ stripe }) => {
      for (const customerId of everyone) {
        await heldSoap(stripe, customerId)
        later(1)
      }
      later(16)
      const first = await run(stripe, { maxItems: 2 })
      expect(first).toMatchObject({ checked: 2, undone: 2, deferred: 1 })
      const orderOf = async (customerId: string) => (await db.query<{ id: string }>('SELECT id FROM orders WHERE customer_id = $1', [customerId]))[0]?.id
      // Oldest first: Sam's and Mo's went; Tia's waits.
      expect(await orderOf(ID.customer)).toBeUndefined()
      expect(await orderOf(ID.member)).toBeUndefined()
      expect(await orderOf(everyone[2] as string)).toBeDefined()
      expect(await run(stripe, { maxItems: 2 })).toMatchObject({ checked: 1, undone: 1, deferred: 0 })
      await invariant(stripe)
    }, addThirdCustomer)
  })

  it('no new item after budgetMs: what is left waits', async () => {
    await onASeed(async ({ stripe }) => {
      for (const customerId of everyone.slice(0, 2)) await heldSoap(stripe, customerId)
      later(16)
      let clock = 0
      const result = await run(stripe, { budgetMs: 1_000, now: () => (clock += 600) })
      expect(result).toMatchObject({ checked: 1, deferred: 1 })
    })
  })

  it('the limits are as stated: the schedule 50 items and 120 s, a manual run 10 and 15 s (W13: its Stripe calls by 20 s)', () => {
    expect(SCHEDULED_LIMITS).toEqual({ maxItems: 50, budgetMs: 120_000 })
    expect(MANUAL_LIMITS).toEqual({ maxItems: 10, budgetMs: 15_000, stripeDeadlineMs: 20_000 })
  })

  it("a manual run's Stripe calls end by 20 s from the request's start: each gets what is left, none with under 2 s", async () => {
    await onASeed(async ({ stripe }) => {
      await heldSoap(stripe, ID.customer)
      await heldSoap(stripe, ID.member)
      later(16)
      const timeouts: Array<number | undefined> = []
      const list = stripe.paymentIntents.list
      stripe.paymentIntents.list = (params, options) => (timeouts.push(options?.timeout), list(params, options))
      // The request started 13 s ago: the first item's list gets 7 s; then the clock reads 18.5 s, so the second item's isn't sent.
      const startedAt = Date.now() - 13_000
      let reads = 0
      const result = await run(stripe, { ...MANUAL_LIMITS, startedAt, now: () => (reads++ < 3 ? Date.now() : Date.now() + 5_500) })
      expect(timeouts[0]).toBe(7_000)
      expect(timeouts).toHaveLength(1)
      expect(result.items.map((item) => item.outcome)).toEqual(['undone', 'left'])
      expect(result.items[1]).toMatchObject({ reason: 'unclear' })
    }, addThirdCustomer)
  })
})

describe("W13 (W12a N1): a reader order in a staff member's run keeps to the run's deadline", () => {
  it("19 s into the run (1 s left of its 20, though a press would have 11): the reader's intent isn't read, the order left for the next run", async () => {
    await onASeed(async ({ stripe }) => {
      const placed = await place(basket('reader'))
      if (!placed.body.ok) throw new Error('not placed')
      later(16)
      const result = await run(stripe, { ...MANUAL_LIMITS, startedAt: Date.now() - 19_000 })
      expect(result.items).toEqual([expect.objectContaining({ id: placed.body.data.orderId, outcome: 'left', reason: 'unclear' })])
      expect(stripe.calls.filter((call) => call.method === 'paymentIntents.retrieve')).toEqual([])
    })
  })
})

describe("W14b (W12-6): a reader flow in a staff member's run keeps to the run's deadline, as its orders do", () => {
  it("19 s into the run (1 s left of its 20, though a press would have 11): the flow's intent isn't read, the flow left for the next run", async () => {
    await onASeed(async ({ stripe }) => {
      const old = oldSide(db, stripe)
      const bookingId = await lapsedSeat((action, params) => old.call(action, params), db)
      const started = (await old.call('settleLapsedBooking', { bookingId, payment: { method: 'reader' } })) as { pendingReaderPayment: { pendingId: string } }
      const { pendingId } = started.pendingReaderPayment
      await asWorkerFlow(db, pendingId)
      replayStripe.current = stripe
      later(16)
      const before = stripe.calls.length
      const result = await run(stripe, { ...MANUAL_LIMITS, startedAt: Date.now() - 19_000 })
      expect(result.items).toEqual([expect.objectContaining({ kind: 'flow', id: pendingId, outcome: 'left', reason: 'unclear' })])
      expect(stripe.calls.slice(before).map((call) => call.method)).toEqual([])
    })
  })
})

describe('the staff routes', () => {
  const staffRequest = (path: string, init: RequestInit = {}) =>
    new Request(`https://worker.test${path}`, {
      ...init,
      headers: { authorization: `Bearer ${process.env.STAFF_API_KEY}`, 'x-staff-email': REPLAY_USER.email, 'content-type': 'application/json', ...(init.headers ?? {}) },
    })

  it('POST /orders/reconcile runs it as the staff member, idempotent; GET /orders/stuck lists with words', async () => {
    await onASeed(async ({ stripe }) => {
      stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
      stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
      await place(basket('card'))
      const orderId = await pendingOrder()
      later(16)
      const listed = await stuckRoute(staffRequest('/api/v1/staff/orders/stuck'))
      expect(await listed.json()).toMatchObject({ ok: true, data: { checkout: [{ orderId, method: 'card', reason: 'waiting', words: STUCK_WORDS['waiting'] }], flows: [], refunds: [], warnings: [], alert: null } })
      const key = crypto.randomUUID()
      const post = () => reconcileRoute(staffRequest('/api/v1/staff/orders/reconcile', { method: 'POST', body: '{}', headers: { 'idempotency-key': key } }))
      const first = (await (await post()).json()) as { ok: boolean; data: ReconcileResult }
      expect(first).toMatchObject({ ok: true, data: { checked: 1, undone: 1 } })
      expect(await reconcileRows(orderId)).toEqual([{ actor: 'staff', outcome: 'undone', detail: 'Stripe has no payment for this card order' }])
      expect(await (await post()).json()).toEqual(first)
      expect(((await (await stuckRoute(staffRequest('/api/v1/staff/orders/stuck'))).json()) as { data: { checkout: unknown[] } }).data.checkout).toEqual([])
    })
  })
})

// --- Crash tests at every step (W03-plan 3.1 layer 3): stop there, run reconcile, then the invariant: no money
// without an order, no order without money, nothing held.

describe('crash tests: the pipeline stopped at each step, then reconcile', () => {
  const settleThenCheck = async (stripe: FakeStripe, expected: Partial<ReconcileResult>) => {
    later(16)
    expect(await run(stripe)).toMatchObject(expected)
    await invariant(stripe)
  }

  it('card: the Worker died after T1, before the charge was sent', async () => {
    await onASeed(async ({ stripe }) => {
      const dying = dyingOn(stripe, 'create', 'before')
      replayStripe.current = dying.client
      void place(basket('card'))
      await dying.died
      replayStripe.current = stripe
      await settleThenCheck(stripe, { undone: 1 })
    })
  })

  it('card: the Worker died after Stripe took the charge, before T2', async () => {
    await onASeed(async ({ stripe }) => {
      const dying = dyingOn(stripe, 'create', 'after')
      replayStripe.current = dying.client
      void place(basket('card'))
      await dying.died
      replayStripe.current = stripe
      await settleThenCheck(stripe, { finalised: 1 })
      expect(stripe.netPence).toBe(6900)
    })
  })

  it('card: a database fault in T2 after the charge (paid_not_finished)', async () => {
    await onASeed(async ({ stripe }) => {
      const answer = await whileFailing(db, { table: 'orders', event: 'UPDATE', when: "NEW.payment_status = 'paid'" }, () => place(basket('card')))
      expect(answer.body).toMatchObject({ ok: false, error: { code: 'PAYMENT_UNCONFIRMED' } })
      await settleThenCheck(stripe, { finalised: 1 })
    })
  })

  it('card: declined, and the undo failed (left pending with its claims)', async () => {
    await onASeed(async ({ stripe }) => {
      stripe.failNext('paymentIntents.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
      const answer = await whileFailing(db, { table: 'orders', event: 'DELETE', when: 'true' }, () => place(basket('card')))
      expect(answer.body).toMatchObject({ ok: false, error: { code: 'PAYMENT_FAILED' } })
      expect(await held()).toMatchObject({ places: 2, stock: 3 })
      await settleThenCheck(stripe, { undone: 1 })
    })
  })

  it('reader: cancelled on the screen, and the undo failed', async () => {
    await onASeed(async ({ stripe }) => {
      const placed = await place(basket('reader'))
      const orderId = placed.body.ok ? placed.body.data.orderId : ''
      const answer = await whileFailing(db, { table: 'orders', event: 'DELETE', when: 'true' }, () => postReaderStep('cancel', orderId))
      expect(answer.body).toMatchObject({ ok: true, data: { cancelled: false, reason: 'rollback_incomplete' } })
      await settleThenCheck(stripe, { undone: 1 })
    })
  })

  it('reader: the Worker died while finalise read the tap', async () => {
    await onASeed(async ({ stripe }) => {
      const placed = await place(basket('reader'))
      if (!placed.body.ok || !placed.body.data.pendingReaderPayment) throw new Error('not placed')
      stripe.completeReaderPayment(placed.body.data.pendingReaderPayment.paymentIntentId)
      const dying = dyingOn(stripe, 'retrieve', 'after')
      replayStripe.current = dying.client
      void postReaderStep('finalise', placed.body.data.orderId)
      await dying.died
      replayStripe.current = stripe
      await settleThenCheck(stripe, { finalised: 1 })
    })
  })

  describe('flows', () => {
    async function startFlow(stripe: FakeStripe) {
      const old = oldSide(db, stripe)
      const bookingId = await lapsedSeat((action, params) => old.call(action, params), db)
      const started = (await old.call('settleLapsedBooking', { bookingId, payment: { method: 'reader' } })) as { pendingReaderPayment: { pendingId: string; paymentIntentId: string } }
      await asWorkerFlow(db, started.pendingReaderPayment.pendingId)
      replayStripe.current = stripe
      return { ...started.pendingReaderPayment, bookingId }
    }
    const flowInvariant = async (stripe: FakeStripe, pendingId: string, bookingId: string) => {
      const row = (await db.query<{ status: string }>('SELECT status FROM pending_reader_payments WHERE id = $1', [pendingId]))[0]
      const booking = (await db.query<{ status: string }>('SELECT status FROM bookings WHERE id = $1', [bookingId]))[0]
      const recorded = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM orders WHERE payment_method = 'reader' AND payment_status = 'paid'")
      if (stripe.netPence > 0) expect({ row: row?.status, booking: booking?.status, orders: recorded[0]?.n }).toEqual({ row: 'finalised', booking: 'confirmed', orders: 1 })
      else expect({ row: row?.status, booking: booking?.status, orders: recorded[0]?.n }).toEqual({ row: 'cancelled', booking: 'payment_needed', orders: 0 })
    }

    it('tapped, and a database fault in the flow T2: reconcile finalises it', async () => {
      await onASeed(async ({ stripe }) => {
        const flow = await startFlow(stripe)
        stripe.completeReaderPayment(flow.paymentIntentId)
        await whileFailing(db, { table: 'order_line_items', event: 'INSERT', when: 'true' }, () => postFlowStep('finalise', flow.pendingId))
        later(16)
        expect(await run(stripe)).toMatchObject({ finalised: 1 })
        await flowInvariant(stripe, flow.pendingId, flow.bookingId)
      })
    })

    it("cancelled, and the flow's undo failed: reconcile undoes it", async () => {
      await onASeed(async ({ stripe }) => {
        const flow = await startFlow(stripe)
        await whileFailing(db, { table: 'pending_reader_payments', event: 'UPDATE', when: "NEW.status = 'cancelled'" }, () => postFlowStep('cancel', flow.pendingId))
        later(16)
        expect(await run(stripe)).toMatchObject({ undone: 1 })
        await flowInvariant(stripe, flow.pendingId, flow.bookingId)
      })
    })

    it('the Worker died while finalise read the tap: reconcile finalises it', async () => {
      await onASeed(async ({ stripe }) => {
        const flow = await startFlow(stripe)
        stripe.completeReaderPayment(flow.paymentIntentId)
        const dying = dyingOn(stripe, 'retrieve', 'after')
        replayStripe.current = dying.client
        void postFlowStep('finalise', flow.pendingId)
        await dying.died
        replayStripe.current = stripe
        later(16)
        expect(await run(stripe)).toMatchObject({ finalised: 1 })
        await flowInvariant(stripe, flow.pendingId, flow.bookingId)
      })
    })
  })
})

// --- W12a: the W12 review's fixes

describe('W12a S1: a Worker order the old screens moved out of pending (W12 review P1)', () => {
  const seat = paidSeat([sam])
  /** P1: Sam's £20 seat and £12 soap on the saved card, both charge attempts unanswered (held); 16 minutes on, old Cancel & Refund to store credit. */
  async function p1(stripe: FakeStripe, taken: boolean): Promise<{ orderId: string; paymentIntentId: string | undefined }> {
    stripe.failNext('paymentIntents.create', { kind: taken ? 'lost_response' : 'unreachable' })
    stripe.failNext('paymentIntents.create', { kind: taken ? 'lost_response' : 'unreachable' })
    expect((await place({ customerId: ID.customer, booking: seat, products: [{ ...soap, quantity: 1 }], payment: { method: 'card' } })).body).toMatchObject({ ok: false, error: { code: 'PAYMENT_UNCONFIRMED' } })
    const orderId = await pendingOrder()
    later(16)
    const bookingId = (await db.query<{ id: string }>('SELECT id FROM bookings WHERE customer_id = $1', [ID.customer]))[0]?.id
    expect(await oldSide(db, stripe).call('refundBooking', { bookingId, refundMethod: 'credit' })).toMatchObject({ storeCreditRefundedAmount: 20 })
    expect(await orders()).toEqual([{ id: orderId, payment_status: 'partially_refunded', stripe_payment_intent_id: null }])
    return { orderId, paymentIntentId: [...stripe.chargedByIntent.keys()][0] }
  }
  const figures = async () => ({ ...(await held()), orders: await orders() })
  const SAID = 'Changed on the old screens while its payment was unconfirmed'

  for (const taken of [true, false]) {
    it(`P1, ${taken ? 'Stripe took £32' : 'Stripe took nothing'}: reconcile reads Stripe, records what it finds once, never acts; the stuck list says it in plain words`, async () => {
      await onASeed(async ({ stripe }) => {
        const { orderId, paymentIntentId } = await p1(stripe, taken)
        expect((await stuckList(db)).checkout).toEqual([
          expect.objectContaining({ orderId, method: 'card', reason: 'changed_elsewhere', paymentStatus: 'partially_refunded', finding: null, words: `${SAID}. The automatic check is looking in Stripe for what was taken. Don't take payment again.` }),
        ])
        const before = await figures()
        const callsBefore = stripe.calls.length

        const result = await run(stripe)
        const finding = taken ? { state: 'taken', amount: 3200, paymentIntentIds: [paymentIntentId] } : { state: 'nothing_taken', amount: 0, paymentIntentIds: [] }
        expect(result).toMatchObject({ checked: 1, finalised: 0, undone: 0, refunds: 0, left: 1 })
        expect(result.items).toEqual([{ kind: 'order', id: orderId, outcome: 'left', reason: 'changed_elsewhere', detail: expect.stringContaining('the order is partially_refunded'), finding }])
        // Read only: one list, nothing cancelled, refunded, charged, finalised or undone.
        expect(stripe.calls.slice(callsBefore).map((call) => call.method)).toEqual(['paymentIntents.list'])
        expect(await figures()).toEqual(before)
        expect(stripe.refundedPence).toBe(0)
        expect(await reconcileRows(orderId)).toEqual([{ actor: 'system', outcome: 'left', reason: 'changed_elsewhere', detail: expect.any(String), finding }])
        expect((await stuckList(db)).checkout).toEqual([
          expect.objectContaining({
            orderId,
            reason: 'changed_elsewhere',
            finding,
            // W14b: the words say what to do, and a final finding carries the close (Mark sorted).
            words: taken
              ? `${SAID}: Stripe shows £32.00 taken. Check that against what the old screens gave back, put any difference right by hand, then press Mark sorted.`
              : `${SAID}: Stripe shows nothing taken. Check what the old screens gave back (it was never paid for), put it right by hand, then press Mark sorted.`,
            close: { kind: 'changed_elsewhere', orderId },
          }),
        ])

        // A final finding: not read again, not recorded again; still listed for a person.
        later(5)
        const callsAfter = stripe.calls.length
        expect(await run(stripe)).toMatchObject({ checked: 0 })
        expect(stripe.calls.length).toBe(callsAfter)
        expect(await reconcileRows(orderId)).toHaveLength(1)
        expect((await stuckList(db)).checkout).toEqual([expect.objectContaining({ orderId, reason: 'changed_elsewhere' })])
      })
    })
  }

  it('recorded once per finding: no clear answer (recorded once, asked again each run), then the answer (recorded), then left alone', async () => {
    await onASeed(async ({ stripe }) => {
      const { orderId } = await p1(stripe, true)
      stripe.failNext('paymentIntents.list', { kind: 'unreachable' })
      expect((await run(stripe)).items[0]).toMatchObject({ reason: 'changed_elsewhere', finding: { state: 'unclear' } })
      expect((await stuckList(db)).checkout[0]?.words).toBe(`${SAID}. Stripe didn't give a clear answer about its payment yet; the automatic check asks again every 5 minutes. Don't take payment again or change anything until it has an answer.`)
      later(5)
      stripe.failNext('paymentIntents.list', { kind: 'unreachable' })
      expect((await run(stripe)).items[0]).toMatchObject({ finding: { state: 'unclear' } })
      later(5)
      expect((await run(stripe)).items[0]).toMatchObject({ finding: { state: 'taken', amount: 3200 } })
      later(5)
      expect(await run(stripe)).toMatchObject({ checked: 0 })
      expect((await reconcileRows(orderId)).map((row) => (row as { finding?: { state: string } }).finding?.state)).toEqual(['unclear', 'taken'])
    })
  })

  it('an intent for it still open in Stripe is never cancelled: recorded as open, looked at again each run, recorded once', async () => {
    await onASeed(async ({ stripe }) => {
      const { orderId } = await p1(stripe, false)
      // A charge declined meanwhile: its intent waits at requires_payment_method.
      const open = await stripe.paymentIntents.create({ amount: 3200, currency: 'gbp', customer: 'cus_seed', metadata: { order_id: orderId } })
      expect((await run(stripe)).items[0]).toMatchObject({ finding: { state: 'open', paymentIntentIds: [open.id] } })
      later(5)
      expect(await run(stripe)).toMatchObject({ checked: 1 })
      expect(stripe.calls.filter((call) => call.method === 'paymentIntents.cancel')).toEqual([])
      expect((await stripe.paymentIntents.retrieve(open.id)).status).toBe('requires_payment_method')
      expect(await reconcileRows(orderId)).toHaveLength(1)
      expect((await stuckList(db)).checkout[0]?.words).toBe(`${SAID}: Stripe shows nothing taken yet, but its payment (${open.id}) is still open in Stripe. Cancel that payment in Stripe; the automatic check then sees it settled, and Mark sorted becomes available.`)
      // W14b: not closable while its payment is still open in Stripe.
      expect((await stuckList(db)).checkout[0]?.close).toBeUndefined()
    })
  })

  it("nothing found with a key of the other mode proves nothing: other_mode, looked at again; with the record's own mode, nothing taken", async () => {
    await onASeed(async ({ stripe }) => {
      const { orderId } = await p1(stripe, false)
      stripe.keyLivemode = true
      expect((await run(stripe)).items[0]).toMatchObject({ finding: { state: 'other_mode' } })
      expect((await stuckList(db)).checkout[0]?.words).toContain("Stripe can't find its payment with the payment account in use now")
      stripe.keyLivemode = false
      later(5)
      expect((await run(stripe)).items[0]).toMatchObject({ finding: { state: 'nothing_taken' } })
      expect((await reconcileRows(orderId)).map((row) => (row as { finding?: { state: string } }).finding?.state)).toEqual(['other_mode', 'nothing_taken'])
    })
  })

  it('not taken: an order T2 paid and the old screens then refunded (an ordinary refund); one over 30 days old; one inside the 15-minute window', async () => {
    await onASeed(async ({ stripe }) => {
      expect((await place({ customerId: ID.customer, booking: seat, payment: { method: 'card' } })).body).toMatchObject({ ok: true })
      later(16)
      const bookingId = (await db.query<{ id: string }>('SELECT id FROM bookings WHERE customer_id = $1', [ID.customer]))[0]?.id
      await oldSide(db, stripe).call('refundBooking', { bookingId, refundMethod: 'credit' })
      expect((await orders())[0]?.payment_status).not.toBe('paid')
      expect(await run(stripe)).toMatchObject({ checked: 0 })
      expect((await stuckList(db)).checkout).toEqual([])
    })
    await onASeed(async ({ stripe }) => {
      await p1(stripe, true)
      later(31 * 24 * 60)
      expect(await run(stripe)).toMatchObject({ checked: 0 })
      expect((await stuckList(db)).checkout).toEqual([])
    })
    await onASeed(async ({ stripe }) => {
      stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
      stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
      await place({ customerId: ID.customer, products: [{ ...soap, quantity: 1 }], payment: { method: 'card' } })
      const orderId = await pendingOrder()
      // Old code can't reach a held order inside 15 minutes; set directly, the window still holds.
      await db.query("UPDATE orders SET payment_status = 'refunded' WHERE id = $1", [orderId])
      later(14)
      expect(await run(stripe)).toMatchObject({ checked: 0 })
      later(2)
      expect(await run(stripe)).toMatchObject({ checked: 1, items: [{ reason: 'changed_elsewhere' }] })
    })
  })
})

describe("W12a S2 (a): another intent of the same customer isn't this order's or flow's: neither cancelled nor used (W12 review RPA)", () => {
  /** An old screen's Settle the customer is paying at the reader now (no `order_id`), and a payment of another order. */
  async function strangers(stripe: FakeStripe, amount: number, field: 'order_id' | 'pending_id') {
    const atTheReader = await stripe.paymentIntents.create({ amount, currency: 'gbp', customer: 'cus_seed', metadata: { flow: 'settle', record_id: '10000000-0000-4000-8000-00000000abcd' } })
    const another = await stripe.paymentIntents.create({ amount, currency: 'gbp', customer: 'cus_seed', payment_method: 'pm_seed', confirm: true, metadata: { [field]: '10000000-0000-4000-8000-00000000dcba' } })
    return async () => {
      expect(stripe.calls.filter((call) => call.method === 'paymentIntents.cancel')).toEqual([])
      expect((await stripe.paymentIntents.retrieve(atTheReader.id)).status).toBe('requires_payment_method')
      expect((await stripe.paymentIntents.retrieve(another.id)).status).toBe('succeeded')
      expect(stripe.refundedPence).toBe(0)
    }
  }

  it('a card order: nothing in Stripe names it, so it is undone; the others are left as they are', async () => {
    await onASeed(async ({ stripe }) => {
      stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
      stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
      await place(basket('card'))
      const orderId = await pendingOrder()
      const untouched = await strangers(stripe, 6900, 'order_id')
      later(16)
      expect(await run(stripe)).toMatchObject({ undone: 1, finalised: 0, left: 0 })
      expect(await reconcileRows(orderId)).toEqual([{ actor: 'system', outcome: 'undone', detail: 'Stripe has no payment for this card order' }])
      await untouched()
    })
  })

  it('a reader order held with no intent written: undone; the others are left as they are', async () => {
    await onASeed(async ({ stripe }) => {
      const dying = dyingOn(stripe, 'create', 'before')
      replayStripe.current = dying.client
      void place(basket('reader'))
      await dying.died
      replayStripe.current = stripe
      const orderId = await pendingOrder()
      const untouched = await strangers(stripe, 6900, 'order_id')
      later(16)
      expect(await run(stripe)).toMatchObject({ undone: 1, finalised: 0, left: 0 })
      expect(await reconcileRows(orderId)).toEqual([{ actor: 'system', outcome: 'undone', detail: expect.stringContaining('Stripe has no reader payment') }])
      await untouched()
    })
  })

  it("a Worker flow held with no intent on its row: undone; its own old-style intent and another flow's are left as they are", async () => {
    await onASeed(async ({ stripe }) => {
      const old = oldSide(db, stripe)
      const bookingId = await lapsedSeat((action, params) => old.call(action, params), db)
      const started = (await old.call('settleLapsedBooking', { bookingId, payment: { method: 'reader' } })) as { pendingReaderPayment: { pendingId: string; paymentIntentId: string } }
      const { pendingId, paymentIntentId } = started.pendingReaderPayment
      await asWorkerFlow(db, pendingId)
      replayStripe.current = stripe
      await db.query('UPDATE pending_reader_payments SET payment_intent_id = NULL WHERE id = $1', [pendingId])
      const untouched = await strangers(stripe, 2000, 'pending_id')
      later(16)
      expect(await run(stripe)).toMatchObject({ undone: 1, finalised: 0, left: 0 })
      expect((await db.query<{ status: string }>('SELECT status FROM pending_reader_payments WHERE id = $1', [pendingId]))[0]?.status).toBe('cancelled')
      // Its own intent carries no pending_id (made by the old screens), so it isn't taken as the flow's either.
      expect((await stripe.paymentIntents.retrieve(paymentIntentId)).status).toBe('requires_payment_method')
      await untouched()
    })
  })
})

describe('W12a L4: a held reader order found paid by listing goes through the reader finalise (W12 review L4)', () => {
  /** A reader order whose intent Stripe made but nobody wrote down (bug 14); the customer taps it anyway. */
  async function tappedUnwritten(stripe: FakeStripe, tap: Parameters<FakeStripe['completeReaderPayment']>[1]): Promise<{ orderId: string; paymentIntentId: string }> {
    const dying = dyingOn(stripe, 'create', 'after')
    replayStripe.current = dying.client
    void place(basket('reader', { readerSaveCard: true }))
    await dying.died
    replayStripe.current = stripe
    const orderId = await pendingOrder()
    const paymentIntentId = (await stripe.paymentIntents.list({ customer: 'cus_seed' })).data.find((intent) => intent.metadata['order_id'] === orderId)?.id as string
    stripe.completeReaderPayment(paymentIntentId, tap)
    later(16)
    return { orderId, paymentIntentId }
  }
  const savedCard = async () => (await db.query<{ pm: string | null }>('SELECT saved_payment_method_id AS pm FROM customers WHERE id = $1', [ID.customer]))[0]?.pm

  it('the customer agreed to save the card: finalised with the card saved, as the screen would have', async () => {
    await onASeed(async ({ stripe }) => {
      const { orderId, paymentIntentId } = await tappedUnwritten(stripe, { generatedCard: 'pm_generated_l4' })
      expect((await run(stripe)).items).toEqual([{ kind: 'order', id: orderId, outcome: 'finalised', detail: paymentIntentId }])
      expect(await orders()).toEqual([{ id: orderId, payment_status: 'paid', stripe_payment_intent_id: paymentIntentId }])
      expect(await savedCard()).toBe('pm_generated_l4')
      expect(await db.query("SELECT details->>'paymentMethodId' AS pm FROM audit_log WHERE action = 'customer.card_saved'")).toEqual([{ pm: 'pm_generated_l4' }])
      await invariant(stripe)
    })
  })

  it("no reusable card (the simulated reader): finalised with R6's warning, which reaches the stuck list", async () => {
    await onASeed(async ({ stripe }) => {
      const { orderId } = await tappedUnwritten(stripe, { simulatedReader: true })
      expect((await run(stripe)).items).toEqual([expect.objectContaining({ id: orderId, outcome: 'finalised', warning: CARD_NOT_SAVED_WARNING })])
      expect((await stuckList(db)).warnings).toEqual([{ kind: 'order', id: orderId, at: expect.any(String), warning: CARD_NOT_SAVED_WARNING }])
      expect(await savedCard()).toBe('pm_seed')
      await invariant(stripe)
    })
  })
})

describe('W12a L6: the refused-key watch covers every Stripe call reconcile makes (W12 review L6)', () => {
  it("a 401 on resolveSavedCard's card read (which it swallows) stops the run like any other: one alert row, the next item not tried", async () => {
    await onASeed(async ({ stripe }) => {
      const answer = await place(basket('reader', { readerSaveCard: true }))
      if (!answer.body.ok || !answer.body.data.pendingReaderPayment) throw new Error('not placed')
      const { orderId, paymentIntentId } = answer.body.data.pendingReaderPayment
      stripe.completeReaderPayment(paymentIntentId, { generatedCard: 'pm_generated_l6' })
      later(1)
      await heldSoap(stripe, ID.member)
      later(16)
      // As a tap whose charge carries no last four or brand: resolveSavedCard then reads the generated card.
      const retrieve = stripe.paymentIntents.retrieve
      stripe.paymentIntents.retrieve = async (id, params, options) => {
        const intent = await retrieve(id, params, options)
        if (!params?.expand) return intent
        const charge = intent.latest_charge as { id: string }
        return { ...intent, latest_charge: { id: charge.id, payment_method_details: { card_present: { generated_card: 'pm_generated_l6' } } } } as unknown as Stripe.PaymentIntent
      }
      const refusal = fakeStripeErrors.authentication()
      stripe.failNext('paymentMethods.retrieve', { kind: 'error', error: refusal })

      const result = await run(stripe)
      expect(stripe.calls.filter((call) => call.method === 'paymentMethods.retrieve')).toHaveLength(1)
      expect(result).toMatchObject({ stripeRefused: true, checked: 1, finalised: 1, deferred: 1 })
      // Sam's payment was found and T2 had run (the card read is for display only): it keeps its row.
      expect(await reconcileRows(orderId)).toEqual([{ actor: 'system', outcome: 'finalised', detail: paymentIntentId }])
      expect(await db.query<{ details: Record<string, unknown> }>("SELECT details FROM audit_log WHERE action = 'reconcile.stripe_refused'")).toEqual([
        { details: { status: 401, message: refusal.message, waiting: 1 } },
      ])
      // Mo's held order wasn't tried: still pending, no list for Mo.
      const mo = (await db.query<{ payment_status: string }>('SELECT payment_status FROM orders WHERE customer_id = $1', [ID.member]))[0]
      expect(mo).toEqual({ payment_status: 'pending' })
      expect(stripe.calls.filter((call) => call.method === 'paymentIntents.list')).toEqual([])
    }, addThirdCustomer)
  })
})
