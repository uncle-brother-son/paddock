import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type Stripe from 'stripe'
import { createDb, type Db, type DbDriver, type DriverSession } from '@/server/db'
import { createPostgresDriver } from '@/server/db/postgres-driver'
import { fakeStripeErrors, type FakeStripe } from '@/server/stripe/fake'
import type { Recording } from '@/server/rules/testing/replay/compare'
import { oldSide, replay, startReplay, type ReplayEnvironment, type ScenarioContext } from '@/server/rules/testing/replay/harness'
import { newOrderSide, orderInput, postOrder, withQuotedCardFigure, type OrderAnswer } from '@/server/rules/testing/replay/order-side'
import { ID, PROMO, paidSeat, sam, seed, whileFailing, type WriteFailure } from '@/server/rules/testing/replay/scenarios'
import { replayStripe, stripeClientsMade } from '@/server/rules/testing/replay/stripe-binding'
import { ORDER_STRIPE_LIMITS } from '@/server/stripe/client'
import { ensureStripeCustomer } from '@/server/stripe/customer'
import {
  AUTHENTICATION_NEEDED_MESSAGE,
  COLLECT_DEADLINE_MS,
  collectSavedCard,
  MIN_SEND_MS,
  STRIPE_ACCESS_REFUSED_MESSAGE,
  type PendingCharge,
} from './collect-saved-card'
import { NO_SAVED_CARD_MESSAGE, ORDER_STILL_PROCESSING_MESSAGE, PAID_NOT_FINISHED_MESSAGE, PAYMENT_UNCONFIRMED_MESSAGE } from './failure-messages'
import { finaliseOrder } from './finalise-order'
import type { PendingSnapshot } from './pending-order'
import { placeOrder } from './place-order'
import { undoOrder } from './undo-order'

// W10: the saved card through the real order route, on PGlite with the live schema and the replay
// seed, with FakeStripe standing in for Stripe. T1 commits the order pending, collect charges the card
// under `<orderId>:charge`, then T2 marks it paid or the one undo removes it. No real Stripe call.

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

// --- Baskets, as createOrder's params, on the seed's saved card (cus_seed, pm_seed)

const towel = { addonId: ID.addon, quantity: 1, unitPrice: 5 }
const alex = { name: 'Alex Guest', email: 'alex@example.com' }
const soap = { productVariantId: ID.variant, quantity: 2, unitPrice: 12 }
const card = { method: 'card' }
/** A booking for two with a towel (£45) and two soaps (£24): £69 on the card. */
const cardBasket = { customerId: ID.customer, booking: { ...paidSeat([sam, alex]), addons: [{ ...towel, redemptionSource: 'paid' }] }, products: [soap], payment: card }
const GIFT = { giftCardId: ID.giftCard, amount: 10 }
/** The same, with £10 on the seed's gift card and £15 of Sam's £30 store credit: £44 on the card. */
const splitBasket = { ...cardBasket, payment: { ...card, giftCard: GIFT, storeCredit: { amount: 15 } } }

interface Placed {
  recording: Recording
  answers: OrderAnswer[]
  answer: OrderAnswer
  stripe: FakeStripe
}

interface PlaceOptions {
  /** After the seed: more rows, or the fake's faults. */
  prepare?(db: Db, stripe: FakeStripe): Promise<void> | void
  /** Wraps the order: a failing write, say. */
  during?(steps: () => Promise<unknown>): Promise<unknown>
  /** After the order, inside the run: a second press, the undo run again. */
  after?(context: ScenarioContext): Promise<void>
}

/** One card order through the route on a fresh seed, sending the quote's card figure as W14's screen will. */
async function place(params: Record<string, unknown>, options: PlaceOptions = {}): Promise<Placed> {
  const answers: OrderAnswer[] = []
  let fake: FakeStripe | null = null
  const recording = await replay(
    environment,
    {
      name: 'saved-card test',
      async seed(seedDb, stripe) {
        await seed(seedDb, stripe)
        await options.prepare?.(seedDb, stripe)
      },
      async run(context) {
        fake = context.stripe
        const steps = () => context.call('createOrder', params)
        await (options.during ? options.during(steps) : steps())
        await options.after?.(context)
      },
    },
    newOrderSide(answers)
  )
  return { recording, answers, answer: answers[0] as OrderAnswer, stripe: fake as unknown as FakeStripe }
}

const tablesTouched = (recording: Recording) => Object.keys(recording.tables).sort()
const errorOf = (answer: OrderAnswer) => (answer.body.ok ? null : { status: answer.status, code: answer.body.error.code, message: answer.body.error.message, details: answer.body.error.details })
const orderRow = (recording: Recording) => recording.tables['orders']?.added[0] as Record<string, unknown> | undefined
const auditActions = (recording: Recording) => (recording.tables['audit_log']?.added ?? []).map((row) => row['action'])

async function orderNow(id: string) {
  return (await db.query<{ payment_status: string; stripe_payment_intent_id: string | null; reader_payment: PendingSnapshot | null }>(
    'SELECT payment_status, stripe_payment_intent_id, reader_payment FROM orders WHERE id = $1',
    [id]
  ))[0]
}

describe('a card order that goes through', () => {
  it('is charged once, under the order\'s key and with its id, then marked paid by T2', async () => {
    const { answer, recording, stripe } = await place(cardBasket)
    expect(answer.status).toBe(200)
    if (!answer.body.ok) throw new Error('refused')
    const { orderId } = answer.body.data
    expect(answer.body.data).toMatchObject({ status: 'paid', payment: { method: 'card', collected: 69, cardCharged: true, giftCardApplied: 0, storeCreditApplied: 0 } })
    expect(stripe.calls).toEqual([
      {
        method: 'paymentIntents.create',
        params: {
          amount: 6900,
          currency: 'gbp',
          customer: 'cus_seed',
          payment_method: 'pm_seed',
          off_session: true,
          confirm: true,
          description: 'Staff-created order for booking, add-ons, merchandise',
          metadata: { order_id: orderId },
        },
        idempotencyKey: `${orderId}:charge`,
      },
    ])
    expect(stripe.netPence).toBe(6900)
    const order = await orderNow(orderId)
    expect(order?.payment_status).toBe('paid')
    expect(order?.stripe_payment_intent_id).toMatch(/^pi_fake_/)
    expect(orderRow(recording)).toMatchObject({ payment_status: 'paid', payment_method: 'card', order_total: '69.00' })
    expect(auditActions(recording)).toEqual(['order.create', 'order.paid'])
  })

  it('keeps its pending record, the old snapshot\'s superset, with the charge named once T2 has seen it', async () => {
    const { answer } = await place(splitBasket)
    if (!answer.body.ok) throw new Error('refused')
    const order = await orderNow(answer.body.data.orderId)
    expect(order?.reader_payment).toEqual({
      flow: 'checkout',
      method: 'card',
      channel: 'staff',
      expected_amount: 44,
      save_card: false,
      save_address_to_customer: false,
      stripe_customer_id: 'cus_seed',
      payment_method_id: 'pm_seed',
      charge_description: 'Staff-created order for booking, add-ons, merchandise',
      charge_payment_intent_id: order?.stripe_payment_intent_id,
      request_id: expect.any(String),
      gift_card_redemption: { gift_card_id: ID.giftCard, amount: 10 },
      created_at: expect.any(String),
    })
    // Never the old reader's field: the old sweep would take it for an open reader payment.
    expect(order?.reader_payment).not.toHaveProperty('payment_intent_id')
    expect(answer.body.data.payment).toEqual({ method: 'split', collected: 44, cardCharged: true, giftCardApplied: 10, storeCreditApplied: 15 })
  })

  it('nothing left for the card: no Stripe call, finished in T1, as createOrder did', async () => {
    const { answer, stripe, recording } = await place({ customerId: ID.customer, products: [soap], payment: { ...card, giftCard: { giftCardId: ID.giftCard, amount: 24 } } })
    expect(answer.body).toMatchObject({ ok: true, data: { payment: { method: 'gift_card', collected: 0, cardCharged: false } } })
    expect(stripe.calls).toEqual([])
    expect(orderRow(recording)).toMatchObject({ payment_status: 'paid', reader_payment: null })
  })
})

describe('a definite refusal: nothing was taken, so the one undo gives everything back', () => {
  it('declined: the old route\'s words, PAYMENT_FAILED, one call, and only the key and the audit rows left', async () => {
    const { answer, recording, stripe } = await place(splitBasket, { prepare: (_, fake) => fake.failNext('paymentIntents.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() }) })
    expect(errorOf(answer)).toEqual({
      status: 402,
      code: 'PAYMENT_FAILED',
      message: 'Failed to charge saved card: Your card was declined.',
      details: { stage: 'payment', reason: 'charge_failed', message: 'Failed to charge saved card: Your card was declined.' },
    })
    expect(stripe.calls).toHaveLength(1)
    expect(stripe.netPence).toBe(0)
    expect(tablesTouched(recording)).toEqual(['api_idempotency', 'audit_log'])
    expect(auditActions(recording)).toEqual(['order.create', 'order.undo'])
  })

  it('authentication needed: the old words, PAYMENT_NEEDS_AUTHENTICATION', async () => {
    const { answer, recording } = await place(cardBasket, { prepare: (_, fake) => fake.failNext('paymentIntents.create', { kind: 'error', error: fakeStripeErrors.authenticationRequired() }) })
    expect(errorOf(answer)).toMatchObject({ status: 402, code: 'PAYMENT_NEEDS_AUTHENTICATION', message: AUTHENTICATION_NEEDED_MESSAGE, details: { reason: 'charge_failed' } })
    expect(tablesTouched(recording)).toEqual(['api_idempotency', 'audit_log'])
  })

  it('an invalid request is definite too', async () => {
    const { answer, recording } = await place(cardBasket, { prepare: (_, fake) => fake.failNext('paymentIntents.create', { kind: 'error', error: fakeStripeErrors.missing("customer: 'cus_seed'") }) })
    expect(errorOf(answer)).toMatchObject({ code: 'PAYMENT_FAILED', message: "Failed to charge saved card: No such customer: 'cus_seed'" })
    expect(tablesTouched(recording)).toEqual(['api_idempotency', 'audit_log'])
  })

  it('a saved card but no Stripe customer: the same, as the old route checked both', async () => {
    const { answer, recording, stripe } = await place(cardBasket, { prepare: (seedDb) => seedDb.query(`UPDATE customers SET stripe_customer_id = NULL WHERE id = $1`, [ID.customer]).then(() => undefined) })
    expect(errorOf(answer)).toMatchObject({ status: 402, code: 'PAYMENT_FAILED', message: NO_SAVED_CARD_MESSAGE, details: { stage: 'payment', reason: 'charge_failed' } })
    expect(stripe.calls).toEqual([])
    expect(tablesTouched(recording)).toEqual(['api_idempotency'])
  })

  it('no saved card: the old route\'s words, refused inside T1, so nothing is written and Stripe is never called', async () => {
    const { answer, recording, stripe } = await place(cardBasket, { prepare: (seedDb) => seedDb.query(`UPDATE customers SET saved_payment_method_id = NULL WHERE id = $1`, [ID.customer]).then(() => undefined) })
    expect(errorOf(answer)).toMatchObject({ status: 402, code: 'PAYMENT_FAILED', message: NO_SAVED_CARD_MESSAGE, details: { stage: 'payment', reason: 'charge_failed' } })
    expect(stripe.calls).toEqual([])
    expect(tablesTouched(recording)).toEqual(['api_idempotency'])
  })

  it.each([
    ['a 401 (the key refused)', fakeStripeErrors.authentication],
    ['a 403 (the key not allowed to charge)', fakeStripeErrors.permission],
  ])('%s on the first send: Stripe did nothing, so undone at once, with words that say who can fix it (W10a)', async (_, error) => {
    const { answer, recording, stripe } = await place(splitBasket, { prepare: (_db, fake) => fake.failNext('paymentIntents.create', { kind: 'error', error: error() }) })
    expect(errorOf(answer)).toEqual({
      status: 402,
      code: 'PAYMENT_FAILED',
      message: STRIPE_ACCESS_REFUSED_MESSAGE,
      details: { stage: 'payment', reason: 'charge_failed', message: STRIPE_ACCESS_REFUSED_MESSAGE },
    })
    expect(stripe.calls).toHaveLength(1)
    expect(stripe.netPence).toBe(0)
    // Undone: the places, the stock, the gift card and the store credit all given back.
    expect(tablesTouched(recording)).toEqual(['api_idempotency', 'audit_log'])
    expect(auditActions(recording)).toEqual(['order.create', 'order.undo'])
  })

  it('a 401 on the retry, after a first send whose answer was lost, says nothing about that send: held, never undone', async () => {
    const { answer, recording, stripe } = await place(cardBasket, {
      prepare: (_db, fake) => {
        const create = fake.paymentIntents.create
        let sends = 0
        fake.paymentIntents.create = async (params, options) => {
          sends += 1
          // Stripe refuses a bad key before it looks at the idempotency key, so the fake's saved answer can't stand in.
          if (sends === 2) throw fakeStripeErrors.authentication()
          await create(params, options)
          throw fakeStripeErrors.connection()
        }
      },
    })
    expect(errorOf(answer)).toMatchObject({ status: 502, code: 'PAYMENT_UNCONFIRMED', message: PAYMENT_UNCONFIRMED_MESSAGE, details: { reason: 'payment_unconfirmed' } })
    expect(stripe.netPence).toBe(6900)
    expect(stripe.refundedPence).toBe(0)
    expect(orderRow(recording)).toMatchObject({ payment_status: 'pending' })
    expect(auditActions(recording)).toEqual(['order.create'])
  })
})

describe('an unknown outcome is never undone', () => {
  it('no connection once: retried with the same key and request, charged once', async () => {
    const { answer, stripe } = await place(cardBasket, { prepare: (_, fake) => fake.failNext('paymentIntents.create', { kind: 'unreachable' }) })
    expect(answer.body.ok).toBe(true)
    expect(stripe.calls).toHaveLength(2)
    expect(stripe.calls[1]).toEqual(stripe.calls[0])
    expect(stripe.netPence).toBe(6900)
  })

  it('charged but the answer lost: the retry gets Stripe\'s saved answer, so one charge', async () => {
    const { answer, stripe } = await place(cardBasket, { prepare: (_, fake) => fake.failNext('paymentIntents.create', { kind: 'lost_response' }) })
    expect(answer.body.ok).toBe(true)
    expect(stripe.calls).toHaveLength(2)
    expect([...stripe.chargedByIntent.values()]).toEqual([6900])
  })

  it('a 500 Stripe keeps against the key: replayed, so PAYMENT_UNCONFIRMED; held pending with its claims', async () => {
    const { answer, stripe, recording } = await place(splitBasket, { prepare: (_, fake) => fake.failNext('paymentIntents.create', { kind: 'error', error: fakeStripeErrors.server() }) })
    expect(errorOf(answer)).toMatchObject({ status: 502, code: 'PAYMENT_UNCONFIRMED', message: PAYMENT_UNCONFIRMED_MESSAGE, details: { stage: 'payment', reason: 'payment_unconfirmed' } })
    expect(stripe.calls).toHaveLength(2)
    expect(stripe.calls[1]?.idempotencyKey).toBe(stripe.calls[0]?.idempotencyKey)
    expect(orderRow(recording)).toMatchObject({ payment_status: 'pending' })
    // Held: the places, the stock, the gift card and the store credit stay claimed for reconcile.
    expect(recording.tables['sessions']?.changed).toEqual([{ id: ID.session, total_booked: [0, 2] }])
    expect(recording.tables['product_variants']?.changed).toEqual([{ id: ID.variant, stock_quantity: [5, 3] }])
    expect(recording.tables['gift_cards']?.changed).toEqual([{ id: ID.giftCard, remaining_balance: ['40.00', '30.00'] }])
    expect(recording.tables['customers']?.changed).toEqual([{ id: ID.customer, store_credit_balance: ['30.00', '15.00'] }])
    expect(auditActions(recording)).toEqual(['order.create'])
  })

  it('no clear answer twice, the money taken the first time: held pending; nothing undone, nothing refunded', async () => {
    const { answer, stripe, recording } = await place(cardBasket, {
      prepare: (_, fake) => {
        fake.failNext('paymentIntents.create', { kind: 'lost_response' })
        fake.failNext('paymentIntents.create', { kind: 'lost_response' })
      },
    })
    expect(errorOf(answer)).toMatchObject({ code: 'PAYMENT_UNCONFIRMED' })
    expect(stripe.netPence).toBe(6900)
    expect(stripe.calls.map((call) => call.method)).toEqual(['paymentIntents.create', 'paymentIntents.create'])
    expect(orderRow(recording)).toMatchObject({ payment_status: 'pending' })
  })

  it('no clear answer, then a definite refusal on the retry: that is Stripe\'s answer, so the order is undone', async () => {
    const { answer, recording } = await place(cardBasket, {
      prepare: (_, fake) => {
        fake.failNext('paymentIntents.create', { kind: 'unreachable' })
        fake.failNext('paymentIntents.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
      },
    })
    expect(errorOf(answer)).toMatchObject({ code: 'PAYMENT_FAILED' })
    expect(tablesTouched(recording)).toEqual(['api_idempotency', 'audit_log'])
  })

  it('the key still in use at Stripe (409) is unclear, then the retry goes through', async () => {
    const { answer, stripe } = await place(cardBasket, { prepare: (_, fake) => fake.failNext('paymentIntents.create', { kind: 'key_in_use' }) })
    expect(answer.body.ok).toBe(true)
    expect(stripe.netPence).toBe(6900)
  })
})

describe('the Stripe client\'s limits (W5-26)', () => {
  it('the order route asks for 10 seconds a call and no retries of the SDK\'s own', async () => {
    stripeClientsMade.length = 0
    await place(cardBasket)
    expect(stripeClientsMade).toEqual([{ limits: ORDER_STRIPE_LIMITS }])
    expect(ORDER_STRIPE_LIMITS).toEqual({ timeoutMs: 10_000, networkRetries: 0 })
  })
})

describe("the charge's deadline from the request's start (W10a, W10 review S2)", () => {
  interface Send {
    /** Time that passes before this send (T1's, for the first). */
    before?: number
    /** How long Stripe takes to answer. Over the send's timeout, it is cut off there: an unclear answer. */
    takes: number
    /** Cut off, whether Stripe took the money all the same. */
    charged?: boolean
  }

  /** Each send as planned, on the test clock; returns the timeout each send asked for (none: the client's 10 s). */
  function sendsTaking(fake: FakeStripe, plan: Send[]): Array<number | undefined> {
    const timeouts: Array<number | undefined> = []
    const create = fake.paymentIntents.create
    fake.paymentIntents.create = async (params, options) => {
      const send = plan[timeouts.length] ?? { takes: 0 }
      timeouts.push(options?.timeout)
      const limit = options?.timeout ?? ORDER_STRIPE_LIMITS.timeoutMs
      vi.setSystemTime(Date.now() + (send.before ?? 0) + Math.min(send.takes, limit))
      if (send.takes <= limit) return create(params, options)
      if (send.charged) {
        await create(params, options)
        throw fakeStripeErrors.connection()
      }
      fake.failNext('paymentIntents.create', { kind: 'unreachable' })
      return create(params, options)
    }
    return timeouts
  }

  async function timed(plan: Send[]) {
    let result: { answer: OrderAnswer; timeouts: Array<number | undefined>; took: number; stripe: FakeStripe } | null = null
    const recording = await replay(
      environment,
      {
        name: 'timed',
        seed,
        async run({ stripe }) {
          replayStripe.current = stripe
          const input = await withQuotedCardFigure(orderInput(cardBasket))
          const timeouts = sendsTaking(stripe, plan)
          const start = Date.now()
          const answer = await postOrder(input)
          result = { answer, timeouts, took: Date.now() - start, stripe }
        },
      },
      (_db, stripe) => ({ name: 'test', call: async () => stripe })
    )
    if (!result) throw new Error('not run')
    return { ...(result as { answer: OrderAnswer; timeouts: Array<number | undefined>; took: number; stripe: FakeStripe }), recording }
  }

  it('the deadline is 30 seconds from the start, and a second send needs at least 2 seconds', () => {
    expect(COLLECT_DEADLINE_MS).toBe(30_000)
    expect(MIN_SEND_MS).toBe(2_000)
  })

  it("with 10 seconds or more left, the second send gets the client's 10 seconds", async () => {
    const { answer, timeouts, stripe } = await timed([{ before: 8_000, takes: 11_000 }, { takes: 500 }])
    expect(answer.body.ok).toBe(true)
    expect(timeouts).toEqual([undefined, 10_000])
    expect(stripe.calls).toHaveLength(2)
    expect(stripe.calls[1]).toEqual(stripe.calls[0])
    expect(stripe.netPence).toBe(6900)
  })

  it('with less left, the second send gets only what is left; cut off there, the order is held and the press ends at the deadline', async () => {
    const { answer, timeouts, took, recording } = await timed([{ before: 15_000, takes: 11_000 }, { takes: 6_000 }])
    expect(timeouts).toEqual([undefined, 5_000])
    expect(took).toBe(30_000)
    expect(errorOf(answer)).toMatchObject({ status: 502, code: 'PAYMENT_UNCONFIRMED', details: { reason: 'payment_unconfirmed' } })
    expect(orderRow(recording)).toMatchObject({ payment_status: 'pending' })
    expect(auditActions(recording)).toEqual(['order.create'])
  })

  it('with exactly 2 seconds left, it is still sent, with 2 seconds', async () => {
    const { answer, timeouts } = await timed([{ before: 18_000, takes: 11_000 }, { takes: 100 }])
    expect(timeouts).toEqual([undefined, 2_000])
    expect(answer.body.ok).toBe(true)
  })

  it('with under 2 seconds left, not sent at all: held with its claims, never undone, though the first send took the money', async () => {
    const { answer, timeouts, took, stripe, recording } = await timed([{ before: 18_500, takes: 11_000, charged: true }])
    expect(timeouts).toEqual([undefined])
    expect(stripe.calls).toHaveLength(1)
    expect(took).toBe(28_500)
    expect(errorOf(answer)).toMatchObject({ status: 502, code: 'PAYMENT_UNCONFIRMED', message: PAYMENT_UNCONFIRMED_MESSAGE, details: { reason: 'payment_unconfirmed' } })
    expect(stripe.netPence).toBe(6900)
    expect(stripe.refundedPence).toBe(0)
    expect(orderRow(recording)).toMatchObject({ payment_status: 'pending' })
    expect(recording.tables['sessions']?.changed).toEqual([{ id: ID.session, total_booked: [0, 2] }])
    expect(recording.tables['product_variants']?.changed).toEqual([{ id: ID.variant, stock_quantity: [5, 3] }])
    expect(auditActions(recording)).toEqual(['order.create'])
  })

  it('placeOrder counts from the start it is given (the route passes its own): 29 seconds gone, so no second send', async () => {
    await replay(
      environment,
      {
        name: 'given start',
        seed,
        async run({ stripe }) {
          replayStripe.current = stripe
          const input = await withQuotedCardFigure(orderInput(cardBasket))
          stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
          const placing = placeOrder(db, input, { actor, requestId: 'w10a-start', startedAt: Date.now() - 29_000, stripe: () => stripe })
          await expect(placing).rejects.toMatchObject({ code: 'PAYMENT_UNCONFIRMED' })
          expect(stripe.calls).toHaveLength(1)
        },
      },
      (_db, stripe) => ({ name: 'test', call: async () => stripe })
    )
  })

  it('the first send is never cut short by the deadline: answered at 34 seconds, T2 marks it paid', async () => {
    const { answer, timeouts, took } = await timed([{ before: 25_000, takes: 9_000 }])
    expect(timeouts).toEqual([undefined])
    expect(took).toBe(34_000)
    expect(answer.body.ok).toBe(true)
  })
})

// --- The pieces on their own: T2, the undo, and what a dead Worker leaves

const actor = { type: 'staff' as const, id: ID.staff }
const asReconcile = { actor, requestId: 'test-reconcile' }

/** Every row of every table, with each row's updated_at left out: what "exactly as before" means here. */
async function everything(): Promise<Record<string, unknown[]>> {
  const tables = await db.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       AND table_name NOT IN ('audit_log', 'api_idempotency', 'request_log', 'parity_log') ORDER BY 1`
  )
  const dump: Record<string, unknown[]> = {}
  for (const { table_name: table } of tables) {
    // Test data only: the names come from the catalog, as in harness.ts's dumpTables.
    const sql = `SELECT * FROM public.${table}`
    const rows = await db.query<Record<string, unknown>>(sql)
    dump[table] = rows
      .map((row) => {
        const rest = { ...row }
        delete rest['updated_at']
        return JSON.stringify(rest)
      })
      .sort()
  }
  return dump
}

async function pendingOrders() {
  return db.query<{ id: string; customer_id: string; reader_payment: PendingSnapshot }>(`SELECT id, customer_id, reader_payment FROM orders WHERE payment_status = 'pending' ORDER BY created_at`)
}

const pendingCharge = (row: { id: string; customer_id: string; reader_payment: PendingSnapshot }): PendingCharge => ({ orderId: row.id, customerId: row.customer_id, snapshot: row.reader_payment })

/**
 * A Stripe that the Worker dies on: the call never comes back. `before`: the request never left, so
 * nothing was charged. `after`: Stripe charged the card, and the Worker died before it heard.
 */
function dyingOn(fake: FakeStripe, when: 'before' | 'after'): { client: FakeStripe; died: Promise<void> } {
  let dead: () => void = () => undefined
  const died = new Promise<void>((resolve) => {
    dead = resolve
  })
  const client = Object.create(fake) as FakeStripe
  Object.defineProperty(client, 'paymentIntents', {
    value: {
      ...fake.paymentIntents,
      create: async (params: Stripe.PaymentIntentCreateParams, options?: Stripe.RequestOptions) => {
        if (when === 'after') await fake.paymentIntents.create(params, options)
        dead()
        return new Promise<never>(() => undefined)
      },
    },
  })
  return { client, died }
}

/** A card order through the route that dies at the charge; returns once it has. The seed is fresh. */
async function dyingOrder(params: Record<string, unknown>, when: 'before' | 'after', key = crypto.randomUUID()): Promise<{ stripe: FakeStripe; before: Record<string, unknown[]> }> {
  let fake: FakeStripe | null = null
  let before: Record<string, unknown[]> = {}
  await replay(
    environment,
    {
      name: 'dies at the charge',
      seed,
      async run({ stripe }) {
        fake = stripe
        before = await everything()
        const dying = dyingOn(stripe, when)
        replayStripe.current = dying.client
        void postOrder(await withQuotedCardFigure(orderInput(params)), { key })
        await dying.died
      },
    },
    (_db, stripe) => ({ name: 'test', call: async () => stripe })
  )
  return { stripe: fake as unknown as FakeStripe, before }
}

describe('T2 (finalise-order.ts)', () => {
  it('safe twice: the second call finds the order paid with that PaymentIntent and writes nothing', async () => {
    const { stripe, before } = await dyingOrder(cardBasket, 'after')
    const [order] = await pendingOrders()
    if (!order) throw new Error('no pending order')
    const charged = await collectSavedCard(db, stripe, pendingCharge(order))
    if (charged.outcome !== 'answered') throw new Error('not answered')
    expect(await finaliseOrder(db, order.id, charged.paymentIntent, asReconcile)).toEqual({ finalised: true, alreadyPaid: false })
    const audit = await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE entity_id = $1`, [order.id])
    const afterFirst = await everything()
    expect(await finaliseOrder(db, order.id, charged.paymentIntent, asReconcile)).toEqual({ finalised: true, alreadyPaid: true })
    expect(await everything()).toEqual(afterFirst)
    expect(await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE entity_id = $1`, [order.id])).toEqual(audit)
    expect(afterFirst).not.toEqual(before)
    expect(stripe.netPence).toBe(6900)
  })

  it.each([
    ['not succeeded', { status: 'processing' }, 'payment_not_succeeded'],
    ['another order', { metadata: { order_id: 'someone-else' } }, 'metadata_mismatch'],
    ['another currency', { currency: 'eur' }, 'currency_mismatch'],
    ['a penny different', { amount: 6901 }, 'amount_mismatch'],
    ['another Stripe customer', { customer: 'cus_member' }, 'customer_mismatch'],
  ])('a PaymentIntent that is %s leaves the order pending, untouched', async (_, change, reason) => {
    const { stripe } = await dyingOrder(cardBasket, 'after')
    const [order] = await pendingOrders()
    if (!order) throw new Error('no pending order')
    const charged = await collectSavedCard(db, stripe, pendingCharge(order))
    if (charged.outcome !== 'answered') throw new Error('not answered')
    const state = await everything()
    const wrong = { ...charged.paymentIntent, ...change } as Stripe.PaymentIntent
    expect(await finaliseOrder(db, order.id, wrong, asReconcile)).toEqual({ finalised: false, reason })
    expect(await everything()).toEqual(state)
  })

  it('a database failure after the charge: PAYMENT_UNCONFIRMED, held pending with the money taken, never refunded; T2 again finishes it', async () => {
    const markPaidFails: WriteFailure = { table: 'orders', event: 'UPDATE', when: `NEW.payment_status = 'paid'` }
    const { answer, stripe, recording } = await place(cardBasket, {
      during: (steps) => whileFailing(db, markPaidFails, steps),
      after: async ({ stripe: fake }) => {
        const [order] = await pendingOrders()
        if (!order) throw new Error('no pending order')
        // As reconcile will (W12): the same key, so Stripe answers with the charge it already made.
        const again = await collectSavedCard(db, fake, pendingCharge(order))
        if (again.outcome !== 'answered') throw new Error('not answered')
        expect(await finaliseOrder(db, order.id, again.paymentIntent, asReconcile)).toEqual({ finalised: true, alreadyPaid: false })
      },
    })
    expect(errorOf(answer)).toMatchObject({ status: 502, code: 'PAYMENT_UNCONFIRMED', message: PAID_NOT_FINISHED_MESSAGE, details: { reason: 'paid_not_finished' } })
    expect(stripe.calls.map((call) => call.method)).toEqual(['paymentIntents.create', 'paymentIntents.create'])
    expect(stripe.refundedPence).toBe(0)
    expect(stripe.netPence).toBe(6900)
    expect(orderRow(recording)).toMatchObject({ payment_status: 'paid' })
    expect(auditActions(recording)).toEqual(['order.create', 'order.paid'])
  })

  it('an order the undo already removed: nothing is written but a record that the card was charged with no order', async () => {
    const { stripe } = await dyingOrder(cardBasket, 'after')
    const [order] = await pendingOrders()
    if (!order) throw new Error('no pending order')
    // The clock stands still in the replay: each later step a second on, as it would be.
    vi.setSystemTime(Date.now() + 1_000)
    expect(await undoOrder(db, order.id, { ...asReconcile, why: 'test' })).toEqual({ undone: true })
    const charged = await collectSavedCard(db, stripe, pendingCharge(order))
    if (charged.outcome !== 'answered') throw new Error('not answered')
    vi.setSystemTime(Date.now() + 1_000)
    expect(await finaliseOrder(db, order.id, charged.paymentIntent, asReconcile)).toEqual({ finalised: false, reason: 'order_gone' })
    const kept = await db.query<{ action: string; details: Record<string, unknown> }>(`SELECT action, details FROM audit_log WHERE entity_id = $1 ORDER BY at`, [order.id])
    expect(kept.map((row) => row.action)).toEqual(['order.create', 'order.undo', 'order.charge_without_order'])
    expect(kept[2]?.details).toEqual({ paymentIntentId: charged.paymentIntent.id, amount: 6900, status: 'succeeded' })
  })
})

describe('the one undo (undo-order.ts)', () => {
  /** Places `params` on the card, dying before the charge, then undoes it: the database must be as before. */
  async function undoneExactly(params: Record<string, unknown>, prepare?: (db: Db) => Promise<void>) {
    let before: Record<string, unknown[]> = {}
    await replay(
      environment,
      {
        name: 'undone',
        async seed(seedDb, stripe) {
          await seed(seedDb, stripe)
          await prepare?.(seedDb)
        },
        async run({ stripe }) {
          before = await everything()
          const dying = dyingOn(stripe, 'before')
          replayStripe.current = dying.client
          void postOrder(await withQuotedCardFigure(orderInput(params)))
          await dying.died
        },
      },
      (_db, stripe) => ({ name: 'test', call: async () => stripe })
    )
    const [order] = await pendingOrders()
    if (!order) throw new Error('no pending order')
    const held = await everything()
    expect(held).not.toEqual(before)
    expect(await undoOrder(db, order.id, { ...asReconcile, why: 'test' })).toEqual({ undone: true })
    expect(await everything()).toEqual(before)
    // Twice: the second finds nothing, and changes nothing.
    expect(await undoOrder(db, order.id, { ...asReconcile, why: 'test' })).toEqual({ undone: false, reason: 'gone' })
    expect(await everything()).toEqual(before)
    return { orderId: order.id }
  }

  const robe = { addonId: ID.robe, quantity: 1, unitPrice: 8 }
  const candle = { productVariantId: ID.candleVariant, quantity: 2, unitPrice: 20 }
  const shippedTo = { shippingAddress: { name: 'Sam Test', line1: '1 Mill Lane', city: 'Hebden Bridge', postcode: 'HX7 1AA', country: 'United Kingdom' }, postageMethod: 'standard', saveShippingAddressToCustomer: true }
  const event = (attendees: Array<Record<string, unknown>>) => ({ eventId: ID.event, accountHolderAttending: true, guestsOver18Confirmed: true, attendees })
  const samAttending = { ...sam, isAccountHolder: true }
  const alexGuest = { ...alex, isAccountHolder: false }

  it.each<[string, Record<string, unknown>]>([
    ['a public booking with an add-on', { customerId: ID.customer, booking: { ...paidSeat([sam, alex]), addons: [{ ...towel, redemptionSource: 'paid' }] }, payment: card }],
    ['a private booking (the session back to empty)', { customerId: ID.customer, booking: { ...paidSeat([sam, alex]), sessionId: ID.privateSession }, payment: card }],
    [
      'a member credit seat, a paid guest and two add-on credits',
      {
        customerId: ID.member,
        booking: {
          ...paidSeat([{ name: 'Mo Member', email: 'mo@example.com', dateOfBirth: '1985-05-05' }, alex]),
          redemptionSource: 'membership_credit',
          membershipId: ID.membership,
          addons: [
            { ...towel, redemptionSource: 'membership_credit', membershipId: ID.membership },
            { ...robe, redemptionSource: 'membership_credit', membershipId: ID.membership },
          ],
        },
        payment: card,
      },
    ],
    ['a pass seat and a paid guest', { customerId: ID.customer, booking: { ...paidSeat([sam, alex]), redemptionSource: 'session_pass_credit', sessionPassId: ID.ownedPass }, payment: card }],
    ['a pass bought to pay for the booking', { customerId: ID.customer, booking: { ...paidSeat([sam, alex]), redemptionSource: 'buy_new_session_pass' }, sessionPassTypeId: ID.passType, payment: card }],
    ['two lines of one variant and a shipped product, the address to be saved', { customerId: ID.customer, products: [soap, { ...soap, quantity: 1 }, candle], ...shippedTo, payment: card }],
    ['an event for two', { customerId: ID.customer, event: event([samAttending, alexGuest]), payment: card }],
    ['a gift card bought', { customerId: ID.customer, giftCard: { giftCardTypeId: ID.giftCardType, amount: 25, fulfillmentMethod: 'digital', recipientName: 'Ali Friend' }, payment: card }],
    ['a promo code, its use given back', { customerId: ID.customer, booking: paidSeat([sam, alex]), promoCode: PROMO.fixed, payment: card }],
    ['store credit', { customerId: ID.customer, products: [soap], payment: { ...card, storeCredit: { amount: 15 } } }],
    ['a gift card part-used', { customerId: ID.customer, products: [soap], payment: { ...card, giftCard: { giftCardId: ID.giftCard, amount: 10 } } }],
    ['a gift card used up (redeemed, then not)', { customerId: ID.customer, products: [{ ...soap, quantity: 4 }], payment: { ...card, giftCard: { giftCardId: ID.giftCard, amount: 40 } } }],
    [
      'everything at once',
      {
        customerId: ID.customer,
        booking: { ...paidSeat([sam, alex]), addons: [{ ...towel, redemptionSource: 'paid' }] },
        standaloneAddons: [towel],
        products: [soap, candle],
        ...shippedTo,
        sessionPassTypeId: ID.passType,
        giftCard: { giftCardTypeId: ID.giftCardType, amount: 25, fulfillmentMethod: 'digital' },
        event: event([samAttending, alexGuest]),
        promoCode: PROMO.fixed,
        payment: { ...card, giftCard: GIFT, storeCredit: { amount: 15 } },
      },
    ],
  ])('%s: every claim given back once, every row gone, the database exactly as before; twice changes nothing', async (_, params) => {
    await undoneExactly(params)
  })

  it('a gift card marked redeemed before this order, used up by it: keeps its date after the undo', async () => {
    await undoneExactly({ customerId: ID.customer, products: [{ ...soap, quantity: 4 }], payment: { ...card, giftCard: { giftCardId: ID.giftCard, amount: 40 } } }, async (seedDb) => {
      await seedDb.query(`UPDATE gift_cards SET redeemed_at = '2026-10-01T12:00:00Z' WHERE id = $1`, [ID.giftCard])
    })
  })

  it('refuses a paid order, changing nothing', async () => {
    const { answer } = await place(cardBasket)
    if (!answer.body.ok) throw new Error('refused')
    const state = await everything()
    expect(await undoOrder(db, answer.body.data.orderId, { ...asReconcile, why: 'test' })).toEqual({ undone: false, reason: 'paid' })
    expect(await everything()).toEqual(state)
  })

  it('an undo that fails half way leaves the order pending with every claim held; run again, it finishes', async () => {
    const { before } = await dyingOrder(splitBasket, 'before')
    const [order] = await pendingOrders()
    if (!order) throw new Error('no pending order')
    const held = await everything()
    const deleteFails: WriteFailure = { table: 'orders', event: 'DELETE', when: 'true' }
    await expect(whileFailing(db, deleteFails, () => undoOrder(db, order.id, { ...asReconcile, why: 'test' }))).rejects.toThrow()
    expect(await everything()).toEqual(held)
    expect(await undoOrder(db, order.id, { ...asReconcile, why: 'test' })).toEqual({ undone: true })
    expect(await everything()).toEqual(before)
  })
})

describe('crash tests: the Worker dies at each step (W03-plan 3.1 layer 3)', () => {
  it('after T1, before the charge left: pending, every claim held, nothing taken; the undo puts it all back', async () => {
    const { stripe, before } = await dyingOrder(splitBasket, 'before')
    expect(stripe.calls).toEqual([])
    const [order] = await pendingOrders()
    if (!order) throw new Error('no pending order')
    expect(order.reader_payment).toMatchObject({ method: 'card', expected_amount: 44, charge_payment_intent_id: null })
    expect(await undoOrder(db, order.id, { ...asReconcile, why: 'nothing found in Stripe' })).toEqual({ undone: true })
    expect(await everything()).toEqual(before)
    expect(stripe.netPence).toBe(0)
  })

  it('after the charge, before T2: pending with the money taken; the same key again gets the same charge, and T2 finishes it', async () => {
    const { stripe } = await dyingOrder(splitBasket, 'after')
    expect(stripe.netPence).toBe(4400)
    const [order] = await pendingOrders()
    if (!order) throw new Error('no pending order')
    const again = await collectSavedCard(db, stripe, pendingCharge(order))
    if (again.outcome !== 'answered') throw new Error('not answered')
    expect(await finaliseOrder(db, order.id, again.paymentIntent, asReconcile)).toEqual({ finalised: true, alreadyPaid: false })
    expect([...stripe.chargedByIntent.values()]).toEqual([4400])
    expect((await orderNow(order.id))?.payment_status).toBe('paid')
  })

  it('during T2: its transaction rolls back, the order stays pending with the money; T2 again finishes it', async () => {
    const { stripe } = await dyingOrder(cardBasket, 'after')
    const [order] = await pendingOrders()
    if (!order) throw new Error('no pending order')
    const charged = await collectSavedCard(db, stripe, pendingCharge(order))
    if (charged.outcome !== 'answered') throw new Error('not answered')
    const held = await everything()
    const auditFails: WriteFailure = { table: 'audit_log', event: 'INSERT', when: `NEW.action = 'order.paid'` }
    await expect(whileFailing(db, auditFails, () => finaliseOrder(db, order.id, charged.paymentIntent, asReconcile))).rejects.toThrow()
    expect(await everything()).toEqual(held)
    expect(await finaliseOrder(db, order.id, charged.paymentIntent, asReconcile)).toEqual({ finalised: true, alreadyPaid: false })
    expect(stripe.netPence).toBe(6900)
  })

  it('a second press with the same key while the first is dead: CONFLICT, and nothing is charged again', async () => {
    const key = crypto.randomUUID()
    const { stripe } = await dyingOrder(cardBasket, 'after', key)
    const again = await postOrder(await withQuotedCardFigure(orderInput(cardBasket)), { key })
    expect(errorOf(again)).toMatchObject({ code: 'CONFLICT' })
    expect(stripe.calls).toHaveLength(1)
  })

  it('a fresh basket for the same customer after the crash, with a new key: refused by Q10, nothing written, no charge', async () => {
    const { stripe } = await dyingOrder(cardBasket, 'after')
    replayStripe.current = stripe
    const state = await everything()
    const fresh = await postOrder(await withQuotedCardFigure(orderInput(cardBasket)))
    expect(errorOf(fresh)).toMatchObject({ status: 400, code: 'VALIDATION', message: ORDER_STILL_PROCESSING_MESSAGE, details: { stage: 'payment', reason: 'order_still_processing' } })
    expect(stripe.calls).toHaveLength(1)
    expect(await everything()).toEqual(state)
  })
})

describe("a PaymentIntent T2 won't accept: held, never undone (W10 review S1)", () => {
  it.each<[string, Partial<Stripe.PaymentIntent>]>([
    ['comes back processing', { status: 'processing' }],
    ['comes back a penny off', { amount: 6901 }],
  ])('a charge that %s: PAYMENT_UNCONFIRMED, pending with every claim as T1 left it, only order.create; a fresh basket is refused by Q10', async (_, change) => {
    let afterT1: Record<string, unknown[]> = {}
    let afterAnswer: Record<string, unknown[]> = {}
    let fresh: OrderAnswer | null = null
    const { answer, recording, stripe } = await place(cardBasket, {
      prepare: (_db, fake) => {
        const create = fake.paymentIntents.create
        fake.paymentIntents.create = async (params, options) => {
          afterT1 = await everything()
          return { ...(await create(params, options)), ...change } as Stripe.PaymentIntent
        }
      },
      after: async () => {
        afterAnswer = await everything()
        fresh = await postOrder(await withQuotedCardFigure(orderInput(cardBasket)))
      },
    })
    expect(errorOf(answer)).toEqual({
      status: 502,
      code: 'PAYMENT_UNCONFIRMED',
      message: PAYMENT_UNCONFIRMED_MESSAGE,
      details: { stage: 'payment', reason: 'payment_unconfirmed', message: PAYMENT_UNCONFIRMED_MESSAGE, orderId: expect.any(String) },
    })
    expect(afterAnswer).toEqual(afterT1)
    expect(orderRow(recording)).toMatchObject({ payment_status: 'pending', stripe_payment_intent_id: null })
    expect(recording.tables['sessions']?.changed).toEqual([{ id: ID.session, total_booked: [0, 2] }])
    expect(recording.tables['product_variants']?.changed).toEqual([{ id: ID.variant, stock_quantity: [5, 3] }])
    expect(auditActions(recording)).toEqual(['order.create'])
    expect(errorOf(fresh as unknown as OrderAnswer)).toMatchObject({ status: 400, code: 'VALIDATION', details: { reason: 'order_still_processing' } })
    expect(stripe.calls).toHaveLength(1)
    expect(stripe.refundedPence).toBe(0)
  })
})

describe('a second press', () => {
  it('with the same key after it went through: the same answer, one charge', async () => {
    const key = crypto.randomUUID()
    const products = { customerId: ID.customer, products: [soap], payment: card }
    const presses: OrderAnswer[] = []
    const { stripe } = await place(products, {
      after: async () => {
        presses.push(await postOrder(await withQuotedCardFigure(orderInput(products)), { key }))
        presses.push(await postOrder(await withQuotedCardFigure(orderInput(products)), { key }))
      },
    })
    expect(presses[0]?.body.ok).toBe(true)
    expect(presses[1]?.body).toEqual(presses[0]?.body)
    // The first order's charge, then this key's one charge: never a third.
    expect(stripe.calls).toHaveLength(2)
    expect(stripe.calls[0]?.idempotencyKey).not.toBe(stripe.calls[1]?.idempotencyKey)
  })

  it('with the same key after PAYMENT_UNCONFIRMED: the same answer, replayed, and Stripe is not asked again', async () => {
    const key = crypto.randomUUID()
    const products = { customerId: ID.customer, products: [soap], payment: card }
    const presses: OrderAnswer[] = []
    const { stripe } = await place(cardBasket, {
      prepare: (_, fake) => {
        fake.failNext('paymentIntents.create', { kind: 'unreachable' })
        fake.failNext('paymentIntents.create', { kind: 'unreachable' })
      },
      after: async () => {
        const first = await postOrder(await withQuotedCardFigure(orderInput(products)), { key })
        presses.push(first, await postOrder(await withQuotedCardFigure(orderInput(products)), { key }))
      },
    })
    // The basket's own order got PAYMENT_UNCONFIRMED and is still pending, so this key's first press is Q10's refusal.
    expect(errorOf(presses[0] as OrderAnswer)).toMatchObject({ details: { reason: 'order_still_processing' } })
    expect(presses[1]?.body).toEqual(presses[0]?.body)
    // Two tries for the first order, none for the presses.
    expect(stripe.calls).toHaveLength(2)
  })

  it('PAYMENT_UNCONFIRMED itself is kept against its key: pressed again, the same answer, no new call', async () => {
    const key = crypto.randomUUID()
    const presses: OrderAnswer[] = []
    await replay(
      environment,
      {
        name: 'unconfirmed twice',
        seed,
        async run({ stripe }) {
          replayStripe.current = stripe
          stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
          stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
          presses.push(await postOrder(await withQuotedCardFigure(orderInput(cardBasket)), { key }))
          presses.push(await postOrder(await withQuotedCardFigure(orderInput(cardBasket)), { key }))
          expect(stripe.calls).toHaveLength(2)
        },
      },
      (_db, stripe) => ({ name: 'test', call: async () => stripe })
    )
    expect(errorOf(presses[0] as OrderAnswer)).toMatchObject({ code: 'PAYMENT_UNCONFIRMED' })
    expect(presses[1]?.body).toEqual(presses[0]?.body)
  })
})

describe("Q10's guard: a card order while the customer has one still being processed", () => {
  const pendingFor = (customerId: string, minutesAgo: number, status = 'pending', readerPayment: Record<string, unknown> | null = null) => async (seedDb: Db) => {
    await seedDb.query(
      `INSERT INTO orders (customer_id, order_total, payment_status, order_source, created_at, reader_payment)
       VALUES ($1, 10, $2, 'staff_created', now() - make_interval(mins => $3::int), $4::jsonb)`,
      [customerId, status, minutesAgo, readerPayment]
    )
  }
  /** The old reader's record: no `method` (createOrder's ReaderPaymentSnapshot). */
  const oldReader = { flow: 'checkout', expected_amount: 10, save_card: false, save_address_to_customer: false, payment_intent_id: 'pi_old_reader' }

  it('one pending 14 minutes: refused with the decided words, before anything else, nothing written, no Stripe call', async () => {
    const { answer, recording, stripe } = await place(cardBasket, { prepare: pendingFor(ID.customer, 14) })
    expect(errorOf(answer)).toEqual({
      status: 400,
      code: 'VALIDATION',
      message: 'This customer has an order still being processed. Check the Orders page before trying again.',
      details: { stage: 'payment', reason: 'order_still_processing', message: ORDER_STILL_PROCESSING_MESSAGE },
    })
    expect(stripe.calls).toEqual([])
    expect(tablesTouched(recording)).toEqual(['api_idempotency'])
  })

  it('before any other refusal: a full session behind it still says the order is being processed', async () => {
    const { answer } = await place(cardBasket, {
      prepare: async (seedDb) => {
        await pendingFor(ID.customer, 1)(seedDb)
        await seedDb.query('UPDATE sessions SET total_booked = capacity WHERE id = $1', [ID.session])
      },
    })
    expect(errorOf(answer)).toMatchObject({ details: { reason: 'order_still_processing' } })
  })

  it.each<[string, number]>([
    ['16 minutes on (review R2: it went through before W10a)', 16],
    ['three hours on', 180],
  ])("a held Worker card order of theirs %s: still refused, the card charged once", async (_, minutes) => {
    const { stripe } = await dyingOrder(cardBasket, 'after')
    await db.query(`UPDATE orders SET created_at = created_at - make_interval(mins => $1::int) WHERE payment_status = 'pending'`, [minutes])
    replayStripe.current = stripe
    const state = await everything()
    const fresh = await postOrder(await withQuotedCardFigure(orderInput(cardBasket)))
    expect(errorOf(fresh)).toMatchObject({ status: 400, code: 'VALIDATION', message: ORDER_STILL_PROCESSING_MESSAGE, details: { reason: 'order_still_processing' } })
    expect([...stripe.chargedByIntent.values()]).toEqual([6900])
    expect(await everything()).toEqual(state)
  })

  it('an old reader order (no method in its record) pending 14 minutes: refused', async () => {
    const { answer } = await place(cardBasket, { prepare: pendingFor(ID.customer, 14, 'pending', oldReader) })
    expect(errorOf(answer)).toMatchObject({ details: { reason: 'order_still_processing' } })
  })

  it('nothing on the card while one is pending: no second charge to stop, so it goes through, with no Stripe call', async () => {
    const giftCardPays = { customerId: ID.customer, products: [soap], payment: { ...card, giftCard: { giftCardId: ID.giftCard, amount: 24 } } }
    const { answer, stripe } = await place(giftCardPays, { prepare: pendingFor(ID.customer, 1, 'pending', { ...oldReader, method: 'card' }) })
    expect(answer.body).toMatchObject({ ok: true, data: { payment: { collected: 0, cardCharged: false } } })
    expect(stripe.calls).toEqual([])
  })

  it.each<[string, (seedDb: Db) => Promise<void>]>([
    ['one pending 16 minutes (past the window), not a Worker card order', pendingFor(ID.customer, 16)],
    ['an old reader order pending 16 minutes', pendingFor(ID.customer, 16, 'pending', oldReader)],
    ["another customer's, pending", pendingFor(ID.member, 1)],
    ['one paid a minute ago', pendingFor(ID.customer, 1, 'paid')],
  ])('%s: goes through', async (_, prepare) => {
    const { answer } = await place(cardBasket, { prepare })
    expect(answer.body.ok).toBe(true)
  })

  it.each<[string, Record<string, unknown>]>([
    ['cash', { ...cardBasket, payment: { method: 'cash', confirmedCashAmount: 69 } }],
    ['store credit alone', { customerId: ID.customer, products: [soap], payment: { storeCredit: { amount: 24 } } }],
  ])('a %s order is not affected', async (_, params) => {
    const { answer } = await place(params, { prepare: pendingFor(ID.customer, 1) })
    expect(answer.body.ok).toBe(true)
  })
})

describe('the confirmed card figure (W03-plan 2.7, W03-decisions Q11)', () => {
  it('a different figure is refused before anything is written, with the cash wording; Stripe is never called', async () => {
    const products = { customerId: ID.customer, products: [soap], payment: card }
    const presses: OrderAnswer[] = []
    const { recording, stripe } = await place(products, {
      during: async () => {
        presses.push(await postOrder({ ...orderInput(products), confirmed: { toCollect: 23 } }))
        presses.push(await postOrder(orderInput(products)))
      },
    })
    expect(errorOf(presses[0] as OrderAnswer)).toMatchObject({
      status: 409,
      code: 'TOTAL_CHANGED',
      message: 'The amount due has changed to £24.00. Check it with the customer and confirm again.',
      details: { stage: 'payment', reason: 'amount_changed', amountDueTotal: 24 },
    })
    // The real route keeps the rule: no figure counts as nothing confirmed.
    expect(errorOf(presses[1] as OrderAnswer)).toMatchObject({ code: 'TOTAL_CHANGED', details: { reason: 'amount_changed' } })
    expect(stripe.calls).toEqual([])
    expect(tablesTouched(recording)).toEqual(['api_idempotency'])
  })
})

describe('the dry run of a card order (T1 only, no Stripe)', () => {
  async function dryRunOf(params: Record<string, unknown>) {
    const { POST: dryRunRoute } = await import('@/app/api/v1/staff/orders/dry-run/route')
    let body: unknown = null
    let stripe: FakeStripe | null = null
    const recording = await replay(
      environment,
      {
        name: 'dry run',
        seed,
        async run(context) {
          stripe = context.stripe
          replayStripe.current = context.stripe
          const response = await dryRunRoute(
            new Request('https://worker.test/api/v1/staff/orders/dry-run', {
              method: 'POST',
              headers: { authorization: `Bearer ${process.env.STAFF_API_KEY}`, 'x-staff-email': 'jo@example.com', 'content-type': 'application/json' },
              body: JSON.stringify(orderInput(params)),
            })
          )
          body = await response.json()
        },
      },
      (_db, fake) => ({ name: 'test', call: async () => fake })
    )
    return { body: body as { ok: boolean; data: { order: Record<string, unknown>; rows: Record<string, Record<string, unknown> | null> }; error?: Record<string, unknown> }, recording, stripe: stripe as unknown as FakeStripe }
  }

  it('answers as the order would once charged, reads back T1 pending, calls no Stripe and keeps nothing', async () => {
    const { body, recording, stripe } = await dryRunOf({
      customerId: ID.customer,
      products: [{ productVariantId: ID.candleVariant, quantity: 1, unitPrice: 20 }],
      shippingAddress: { name: 'Sam Test', line1: '1 Mill Lane', city: 'Hebden Bridge', postcode: 'HX7 1AA', country: 'United Kingdom' },
      postageMethod: 'standard',
      saveShippingAddressToCustomer: true,
      event: { eventId: ID.event, accountHolderAttending: true, attendees: [{ ...sam, isAccountHolder: true }] },
      payment: card,
    })
    expect(body.ok).toBe(true)
    expect(body.data.order).toMatchObject({ status: 'paid', payment: { method: 'card', collected: 64.95, cardCharged: true } })
    expect(body.data.rows['order']).toMatchObject({ payment_status: 'pending', payment_method: 'card', has_payment_intent: false, has_reader_payment: true })
    expect(body.data.rows['event_booking']).toMatchObject({ status: 'pending' })
    // The address is saved by T2, so not yet.
    expect(body.data.rows['customer_address']).toEqual({ line1: null, line2: null, city: null, postcode: null, country: 'GB' })
    expect(stripe.calls).toEqual([])
    expect(tablesTouched(recording)).toEqual([])
  })

  it('with no card figure it is compared, not refused; a wrong figure sent is still refused', async () => {
    expect((await dryRunOf(cardBasket)).body.ok).toBe(true)
    const { POST: dryRunRoute } = await import('@/app/api/v1/staff/orders/dry-run/route')
    const response = await dryRunRoute(
      new Request('https://worker.test/api/v1/staff/orders/dry-run', {
        method: 'POST',
        headers: { authorization: `Bearer ${process.env.STAFF_API_KEY}`, 'x-staff-email': 'jo@example.com', 'content-type': 'application/json' },
        body: JSON.stringify({ ...orderInput(cardBasket), confirmed: { toCollect: 68 } }),
      })
    )
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'TOTAL_CHANGED', details: { reason: 'amount_changed' } } })
  })
})

describe('ensureStripeCustomer (the legacy routes\' find-or-create)', () => {
  async function withCustomer(stripeCustomerId: string | null, work: (fake: FakeStripe) => Promise<void>) {
    await replay(
      environment,
      {
        name: 'stripe customer',
        async seed(seedDb, stripe) {
          await seed(seedDb, stripe)
          await seedDb.query('UPDATE customers SET stripe_customer_id = $1 WHERE id = $2', [stripeCustomerId, ID.customer])
        },
        async run({ stripe }) {
          await work(stripe)
        },
      },
      (_db, stripe) => ({ name: 'test', call: async () => stripe })
    )
  }
  const stored = async () => (await db.query<{ stripe_customer_id: string | null }>('SELECT stripe_customer_id FROM customers WHERE id = $1', [ID.customer]))[0]?.stripe_customer_id

  it('the id on the row: no Stripe call and nothing written (the only step a saved card ever needs)', async () => {
    await withCustomer('cus_seed', async (fake) => {
      expect(await ensureStripeCustomer(db, fake, { id: ID.customer, stripeCustomerId: 'cus_seed' })).toBe('cus_seed')
      expect(fake.calls).toEqual([])
    })
  })

  it('none on the row, one tagged with the customer in Stripe: that one, saved to the row, none made', async () => {
    await withCustomer(null, async (fake) => {
      fake.addCustomer('cus_found', { metadata: { supabase_customer_id: ID.customer } })
      expect(await ensureStripeCustomer(db, fake, { id: ID.customer, stripeCustomerId: null })).toBe('cus_found')
      expect(fake.calls.map((call) => call.method)).toEqual(['customers.search'])
      expect(await stored()).toBe('cus_found')
    })
  })

  it("none anywhere: made once, under the customer's key and tagged, and saved; a retry finds it", async () => {
    await withCustomer(null, async (fake) => {
      const made = await ensureStripeCustomer(db, fake, { id: ID.customer, stripeCustomerId: null })
      expect(fake.calls[1]).toEqual({
        method: 'customers.create',
        params: { email: 'sam@example.com', name: 'Sam Test', metadata: { supabase_customer_id: ID.customer } },
        idempotencyKey: `${ID.customer}:stripe-customer`,
      })
      expect(await stored()).toBe(made)
      await db.query('UPDATE customers SET stripe_customer_id = NULL WHERE id = $1', [ID.customer])
      expect(await ensureStripeCustomer(db, fake, { id: ID.customer, stripeCustomerId: null })).toBe(made)
    })
  })

  it('a failed search falls through to making one, as the legacy block did', async () => {
    await withCustomer(null, async (fake) => {
      fake.failNext('customers.search', { kind: 'error', error: fakeStripeErrors.server() })
      const made = await ensureStripeCustomer(db, fake, { id: ID.customer, stripeCustomerId: null })
      expect(fake.calls.map((call) => call.method)).toEqual(['customers.search', 'customers.create'])
      expect(await stored()).toBe(made)
    })
  })

  it('the row filled meanwhile by someone else: theirs is kept and returned', async () => {
    await withCustomer(null, async (fake) => {
      fake.addCustomer('cus_found', { metadata: { supabase_customer_id: ID.customer } })
      await db.query("UPDATE customers SET stripe_customer_id = 'cus_first' WHERE id = $1", [ID.customer])
      expect(await ensureStripeCustomer(db, fake, { id: ID.customer, stripeCustomerId: null })).toBe('cus_first')
      expect(await stored()).toBe('cus_first')
    })
  })
})

describe('round trips (about 20 ms each through Hyperdrive)', () => {
  /** A client that counts what it sends, BEGIN and COMMIT included (as place-order.test.ts). */
  function countingDb(): { db: Db; statements: string[] } {
    const statements: string[] = []
    const real = createPostgresDriver(environment.database.url)
    const counted = (session: DriverSession): DriverSession => ({
      run(sql, params) {
        statements.push(sql.trim().split(/\s+/).slice(0, 2).join(' '))
        return session.run(sql, params)
      },
    })
    const driver: DbDriver = {
      ...counted(real),
      async reserve() {
        const reserved = await real.reserve()
        return {
          ...counted(reserved),
          runScript(sql) {
            statements.push(sql.trim().split(/\s+/).slice(0, 2).join(' '))
            return reserved.runScript(sql)
          },
          release: () => reserved.release(),
        }
      },
      close: () => real.close(),
    }
    return { db: createDb(driver), statements }
  }

  async function counted(params: Record<string, unknown>, prepare?: (fake: FakeStripe) => void): Promise<{ answer: OrderAnswer; statements: string[]; stripe: FakeStripe }> {
    let result: { answer: OrderAnswer; statements: string[]; stripe: FakeStripe } | null = null
    await replay(
      environment,
      {
        name: 'round trips',
        seed,
        async run({ stripe }) {
          prepare?.(stripe)
          replayStripe.current = stripe
          const input = await withQuotedCardFigure(orderInput(params))
          const { db: countedDb, statements } = countingDb()
          holder.db = countedDb
          try {
            result = { answer: await postOrder(input), statements, stripe }
          } finally {
            holder.db = db
            await countedDb.close()
          }
        },
      },
      (_db, stripe) => ({ name: 'test', call: async () => stripe })
    )
    if (!result) throw new Error('not run')
    return result
  }

  // The route, T1 as W09 counted it, the one Stripe call (no database), then T2: BEGIN with the time
  // limits, the order's lock, the statement that marks it paid, its audit row, COMMIT.
  const ROUTE_START = ['SELECT id,', 'INSERT INTO']
  const T1 = ['BEGIN; SELECT', 'SELECT s.id', 'WITH london', 'WITH clock', 'WITH clock', 'WITH clock', 'COMMIT']
  const T2 = ['BEGIN; SELECT', 'SELECT customer_id,', 'WITH paid', 'WITH clock', 'COMMIT']
  const UNDO = ['BEGIN; SELECT', 'SELECT customer_id,', 'WITH l', 'SELECT s.id', 'WITH capacity', 'WITH clock', 'COMMIT']
  const ROUTE_END = ['UPDATE api_idempotency']

  it('a card booking with an add-on and products: 15, of which T2 is 5', async () => {
    const { answer, statements, stripe } = await counted(cardBasket)
    expect(answer.body.ok).toBe(true)
    expect(statements).toEqual([...ROUTE_START, ...T1, ...T2, ...ROUTE_END])
    expect(statements).toHaveLength(15)
    expect(stripe.calls).toHaveLength(1)
  })

  it('declined: T1, the call, then the undo (7)', async () => {
    const { answer, statements } = await counted(cardBasket, (fake) => fake.failNext('paymentIntents.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() }))
    expect(errorOf(answer)).toMatchObject({ code: 'PAYMENT_FAILED' })
    expect(statements).toEqual([...ROUTE_START, ...T1, ...UNDO, ...ROUTE_END])
  })

  it('an unclear answer: T1, the two calls, nothing more', async () => {
    const { answer, statements, stripe } = await counted(cardBasket, (fake) => {
      fake.failNext('paymentIntents.create', { kind: 'unreachable' })
      fake.failNext('paymentIntents.create', { kind: 'unreachable' })
    })
    expect(errorOf(answer)).toMatchObject({ code: 'PAYMENT_UNCONFIRMED' })
    expect(statements).toEqual([...ROUTE_START, ...T1, ...ROUTE_END])
    expect(stripe.calls).toHaveLength(2)
  })

})

describe('for the Worker step (F1): the old createOrder when the charge\'s answer is lost', () => {
  it('rolls the order back though Stripe took the money, and staff pressing again are charged again: £69 twice, one order', async () => {
    const answers: unknown[] = []
    let fake: FakeStripe | null = null
    const recording = await replay(
      environment,
      {
        name: 'old createOrder, answer lost',
        async seed(seedDb, stripe) {
          await seed(seedDb, stripe)
          stripe.failNext('paymentIntents.create', { kind: 'lost_response' })
        },
        async run({ call, stripe }) {
          fake = stripe
          answers.push(await call('createOrder', cardBasket))
          answers.push(await call('createOrder', cardBasket))
        },
      },
      oldSide
    )
    expect(answers[0]).toMatchObject({ success: false, stage: 'payment', reason: 'charge_failed', message: 'Failed to charge saved card: An error occurred with our connection to Stripe.' })
    expect(answers[1]).toMatchObject({ success: true, cardCharged: true, cardAmount: 69 })
    const charged = (fake as unknown as FakeStripe).chargedByIntent
    expect([...charged.values()]).toEqual([6900, 6900])
    expect(recording.tables['orders']?.added).toHaveLength(1)
    // The first charge carried no key, so nothing tied the second to it.
    expect(recording.stripeCalls.map((call) => call.idempotencyKey)).toEqual([null, null])
  })
})
