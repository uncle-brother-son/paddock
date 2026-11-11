import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Stripe from 'stripe'
import type { CancelReaderOrderOutput, FinaliseReaderOrderOutput, PlaceOrderOutput } from '@/contracts'
import { POST as savedCardRoute } from '@/app/api/v1/staff/customers/[customerId]/saved-card/route'
import { POST as connectionTokenRoute } from '@/app/api/v1/staff/terminal/connection-token/route'
import { POST as setupIntentsRoute } from '@/app/api/v1/staff/terminal/setup-intents/route'
import { createDb, type Db, type DbDriver, type DriverSession } from '@/server/db'
import { createPostgresDriver } from '@/server/db/postgres-driver'
import { fakeStripeErrors, type FakeStripe } from '@/server/stripe/fake'
import { MIN_SEND_MS, STRIPE_DEADLINE_MS } from '@/server/stripe/deadline'
import { ORDER_STRIPE_LIMITS, READ_STRIPE_LIMITS } from '@/server/stripe/client'
import type { Recording } from '@/server/rules/testing/replay/compare'
import { oldSide, replay, REPLAY_USER, startReplay, type ReplayEnvironment } from '@/server/rules/testing/replay/harness'
import { orderInput, postOrder, postReaderStep, withQuotedCardFigure, type OrderAnswer } from '@/server/rules/testing/replay/order-side'
import { ID, paidSeat, sam, seed, whileFailing } from '@/server/rules/testing/replay/scenarios'
import { chargesTakeASecond, replayStripe, stripeClientsMade } from '@/server/rules/testing/replay/stripe-binding'
import {
  OLD_READER_ORDER_MESSAGE,
  OLD_ROLLBACK_STARTED_MESSAGE,
  ORDER_STILL_PROCESSING_MESSAGE,
  READER_CHARGED_WITHOUT_ORDER_MESSAGE,
  READER_INTENT_UNCONFIRMED_MESSAGE,
  READER_PAID_NOT_FINISHED_MESSAGE,
} from './failure-messages'
import type { ReaderSnapshot } from './pending-order'
import { placeOrder } from './place-order'
import { READER_INTENT_NOT_SENT_MESSAGE } from './reader-intent'
import { CARD_NOT_SAVED_WARNING, otherModeMessage, ROLLBACK_INCOMPLETE_MESSAGE } from './reader-order'
import { finaliseOrder } from './finalise-order'
import { undoOrder } from './undo-order'

// W11: the reader through the real routes, on PGlite with the live schema and the replay seed, with
// FakeStripe standing in for Stripe: T1 commits the order pending with its pending record, the reader's
// intent is made under `<orderId>:reader-intent`, the screen collects it (the fake's tap), and the
// finalise route runs T2 or the cancel route the one undo. No real Stripe call: the unit set-up refuses
// any (server/rules/testing/no-real-stripe.ts).

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

// --- Baskets, as createOrder's params

const alex = { name: 'Alex Guest', email: 'alex@example.com' }
const towel = { addonId: ID.addon, quantity: 1, unitPrice: 5 }
const soap = { productVariantId: ID.variant, quantity: 2, unitPrice: 12 }
const reader = { method: 'reader' }
/** A booking for two with a towel (£45) and two soaps (£24): £69 on the reader. */
const readerBasket = { customerId: ID.customer, booking: { ...paidSeat([sam, alex]), addons: [{ ...towel, redemptionSource: 'paid' }] }, products: [soap], payment: reader }
const GIFT = { giftCardId: ID.giftCard, amount: 10 }
/** The same, with £10 on the seed's gift card and £15 of Sam's £30 store credit: £44 on the reader. */
const splitBasket = { ...readerBasket, payment: { ...reader, giftCard: GIFT, storeCredit: { amount: 15 } } }
const saving = (basket: Record<string, unknown>) => ({ ...basket, payment: { ...(basket['payment'] as Record<string, unknown>), readerSaveCard: true } })

const actor = { type: 'staff' as const, id: ID.staff }

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

/** Runs `work` on a fresh seed with the run's own FakeStripe bound to the routes. */
async function onASeed(work: (stripe: FakeStripe) => Promise<void>, prepare?: (db: Db, stripe: FakeStripe) => Promise<void> | void): Promise<Recording> {
  return replay(
    environment,
    {
      name: 'reader test',
      async seed(seedDb, stripe) {
        await seed(seedDb, stripe)
        await prepare?.(seedDb, stripe)
      },
      async run({ stripe }) {
        replayStripe.current = stripe
        chargesTakeASecond(stripe)
        await work(stripe)
      },
    },
    (_db, stripe) => ({ name: 'test', call: async () => stripe })
  )
}

/** The order through the route, with the quote's reader figure confirmed, as W14's screen will send it. */
const placeThrough = async (params: Record<string, unknown>, key?: string) => postOrder(await withQuotedCardFigure(orderInput(params)), key ? { key } : {})

type Placed = PlaceOrderOutput & { pendingReaderPayment: NonNullable<PlaceOrderOutput['pendingReaderPayment']> }
function placedOf(answer: OrderAnswer): Placed {
  if (!answer.body.ok) throw new Error(`refused: ${answer.body.error.code} ${answer.body.error.message}`)
  const data = answer.body.data
  if (!data.pendingReaderPayment) throw new Error('no pending reader payment')
  return data as Placed
}
const finalise = async (orderId: string, key?: string) => (await postReaderStep('finalise', orderId, key ? { key } : {})).body as unknown as { ok: true; data: FinaliseReaderOrderOutput }
const cancel = async (orderId: string, key?: string) => (await postReaderStep('cancel', orderId, key ? { key } : {})).body as unknown as { ok: true; data: CancelReaderOrderOutput }
const errorOf = (answer: OrderAnswer) => (answer.body.ok ? null : { status: answer.status, code: answer.body.error.code, message: answer.body.error.message, details: answer.body.error.details })

async function orderNow(id: string) {
  return (
    await db.query<{ payment_status: string; payment_method: string | null; stripe_payment_intent_id: string | null; reader_payment: ReaderSnapshot | null }>(
      'SELECT payment_status, payment_method, stripe_payment_intent_id, reader_payment FROM orders WHERE id = $1',
      [id]
    )
  )[0]
}
const auditActions = async (orderId: string) =>
  (await db.query<{ action: string }>("SELECT action FROM audit_log WHERE entity_id = $1 AND entity_type = 'order' ORDER BY at, id", [orderId])).map((row) => row.action)
const customerCard = async () =>
  (await db.query<{ stripe_customer_id: string | null; saved_payment_method_id: string | null; saved_card_last4: string | null; saved_card_brand: string | null }>(
    'SELECT stripe_customer_id, saved_payment_method_id, saved_card_last4, saved_card_brand FROM customers WHERE id = $1',
    [ID.customer]
  ))[0]
const heldClaims = async () => ({
  places: (await db.query<{ n: number }>('SELECT total_booked AS n FROM sessions WHERE id = $1', [ID.session]))[0]?.n,
  stock: (await db.query<{ n: number }>('SELECT stock_quantity AS n FROM product_variants WHERE id = $1', [ID.variant]))[0]?.n,
})

describe('T1 and the intent (createOrder stage 29)', () => {
  it('T1 commits the order pending with its record, then the intent is made under the order\'s key, for the server\'s figure, and the screen is given what it collects', async () => {
    await onASeed(async (stripe) => {
      const placed = placedOf(await placeThrough(readerBasket))
      expect(placed).toMatchObject({ status: 'pending_reader', payment: { method: 'reader', collected: 69, cardCharged: false, giftCardApplied: 0, storeCreditApplied: 0 } })
      expect(placed.pendingReaderPayment).toEqual({ orderId: placed.orderId, paymentIntentId: 'pi_fake_0001', clientSecret: 'pi_fake_0001_secret', amount: 69 })
      expect(stripe.calls).toEqual([
        {
          method: 'paymentIntents.create',
          params: {
            amount: 6900,
            currency: 'gbp',
            customer: 'cus_seed',
            payment_method_types: ['card_present'],
            metadata: { supabase_customer_id: ID.customer, order_id: placed.orderId, flow: 'checkout' },
            description: `Paddock order ${placed.orderId}`,
          },
          idempotencyKey: `${placed.orderId}:reader-intent`,
        },
      ])
      const order = await orderNow(placed.orderId)
      // createOrder's reader branch left the method unrecorded until finalise (Q9 then names it).
      expect(order).toMatchObject({ payment_status: 'pending', payment_method: null, stripe_payment_intent_id: null })
      expect(order?.reader_payment).toEqual({
        flow: 'checkout',
        method: 'reader',
        channel: 'staff',
        expected_amount: 69,
        save_card: false,
        save_address_to_customer: false,
        stripe_customer_id: 'cus_seed',
        request_id: expect.any(String),
        created_at: expect.any(String),
        payment_intent_id: 'pi_fake_0001',
        // W11a (review L1): the Stripe mode the intent was made in, written with it (W12: T1 writes the key's first).
        livemode: false,
        // W12 (W10 review L1): the booking as T1 wrote it, for the undo's changed_since check.
        held_booking: { session_id: ID.session, party_size: 2 },
      })
      expect(await heldClaims()).toEqual({ places: 2, stock: 3 })
      expect(await auditActions(placed.orderId)).toEqual(['order.create'])
      expect(stripe.netPence).toBe(0)
    })
  })

  it('the card saved: the intent asks Stripe for a reusable card (setup_future_usage), and the record says so', async () => {
    await onASeed(async (stripe) => {
      const placed = placedOf(await placeThrough(saving(splitBasket)))
      expect(stripe.calls[0]?.params).toMatchObject({ amount: 4400, setup_future_usage: 'off_session' })
      expect((await orderNow(placed.orderId))?.reader_payment).toMatchObject({ save_card: true, expected_amount: 44, gift_card_redemption: { gift_card_id: ID.giftCard, amount: 10 } })
    })
  })

  it('no Stripe customer yet: one is found or made first, under the customer\'s key, saved to the row, and named on the record', async () => {
    await onASeed(
      async (stripe) => {
        const placed = placedOf(await placeThrough(readerBasket))
        expect(stripe.calls.map((call) => [call.method, call.idempotencyKey])).toEqual([
          ['customers.search', null],
          ['customers.create', `${ID.customer}:stripe-customer`],
          ['paymentIntents.create', `${placed.orderId}:reader-intent`],
        ])
        expect((await customerCard())?.stripe_customer_id).toBe('cus_fake_0001')
        expect((await orderNow(placed.orderId))?.reader_payment).toMatchObject({ stripe_customer_id: 'cus_fake_0001', payment_intent_id: 'pi_fake_0002' })
      },
      (seedDb) => seedDb.query('UPDATE customers SET stripe_customer_id = NULL WHERE id = $1', [ID.customer]).then(() => undefined)
    )
  })

  it('nothing left for the reader: refused inside T1 with createOrder\'s reason and words, nothing written, no Stripe call', async () => {
    await onASeed(async (stripe) => {
      const before = await everything()
      const answer = await placeThrough({ customerId: ID.customer, products: [soap], payment: { ...reader, giftCard: { giftCardId: ID.giftCard, amount: 24 } } })
      expect(errorOf(answer)).toEqual({
        status: 400,
        code: 'VALIDATION',
        message: 'The amount due has changed. Check it with the customer and confirm again.',
        details: { stage: 'payment', reason: 'reader_nothing_to_charge', message: 'The amount due has changed. Check it with the customer and confirm again.', amountDueTotal: 24 },
      })
      expect(stripe.calls).toEqual([])
      expect(await everything()).toEqual(before)
    })
  })

  it('the confirmed figure (W03-plan 2.7): a different or missing figure is refused before anything is written, with the cash wording', async () => {
    await onASeed(async (stripe) => {
      const before = await everything()
      for (const confirmed of [{ toCollect: 68.99 }, {}]) {
        const answer = await postOrder({ ...orderInput(readerBasket), confirmed })
        expect(errorOf(answer)).toMatchObject({
          status: 409,
          code: 'TOTAL_CHANGED',
          message: 'The amount due has changed to £69.00. Check it with the customer and confirm again.',
          details: { reason: 'amount_changed' },
        })
      }
      expect(stripe.calls).toEqual([])
      expect(await everything()).toEqual(before)
    })
  })

  it('the dry run: T1 only, no Stripe, nothing kept; it answers pending_reader with no intent, and reads back T1 pending', async () => {
    const { POST: dryRunRoute } = await import('@/app/api/v1/staff/orders/dry-run/route')
    await onASeed(async (stripe) => {
      const before = await everything()
      const response = await dryRunRoute(
        new Request('https://worker.test/api/v1/staff/orders/dry-run', {
          method: 'POST',
          headers: { authorization: `Bearer ${process.env.STAFF_API_KEY}`, 'x-staff-email': REPLAY_USER.email, 'content-type': 'application/json' },
          // As the shadow sends it: no confirmed reader figure (the old params never had one).
          body: JSON.stringify(orderInput(splitBasket)),
        })
      )
      const body = (await response.json()) as { ok: boolean; data: { order: PlaceOrderOutput; rows: { order: Record<string, unknown> } } }
      expect(body.ok).toBe(true)
      expect(body.data.order).toMatchObject({ status: 'pending_reader', payment: { method: 'reader', collected: 44, cardCharged: false } })
      expect(body.data.order).not.toHaveProperty('pendingReaderPayment')
      expect(body.data.rows.order).toMatchObject({ payment_status: 'pending', payment_method: null, has_reader_payment: true, has_payment_intent: false })
      expect(stripe.calls).toEqual([])
      expect(await everything()).toEqual(before)
    })
  })
})

describe("Stripe's answers to the intent (W03-plan 2.5)", () => {
  it('refused (an invalid request): no intent, so nothing can be taken; the one undo gives everything back, with the old words', async () => {
    await onASeed(
      async (stripe) => {
        const before = await everything()
        const answer = await placeThrough(splitBasket)
        expect(errorOf(answer)).toEqual({
          status: 402,
          code: 'PAYMENT_FAILED',
          message: 'Failed to create PaymentIntent: Invalid integer: 0',
          details: { stage: 'payment', reason: 'reader_intent_failed', message: 'Failed to create PaymentIntent: Invalid integer: 0' },
        })
        expect(stripe.calls).toHaveLength(1)
        expect(await everything()).toEqual(before)
      },
      (_db, stripe) => stripe.failNext('paymentIntents.create', { kind: 'error', error: fakeStripeErrors.invalid('parameter_invalid_integer', 'Invalid integer: 0') })
    )
  })

  it('no Stripe customer could be made: no intent asked for; undone, with the legacy route\'s words', async () => {
    await onASeed(
      async (stripe) => {
        const before = await everything()
        const answer = await placeThrough(readerBasket)
        expect(errorOf(answer)).toMatchObject({ code: 'PAYMENT_FAILED', message: 'Failed to create Stripe customer: Invalid email address: sam@example', details: { reason: 'reader_intent_failed' } })
        expect(stripe.calls.map((call) => call.method)).toEqual(['customers.search', 'customers.create'])
        expect(await everything()).toEqual(before)
      },
      async (seedDb, stripe) => {
        await seedDb.query('UPDATE customers SET stripe_customer_id = NULL WHERE id = $1', [ID.customer])
        stripe.failNext('customers.create', { kind: 'error', error: fakeStripeErrors.invalid('email_invalid', 'Invalid email address: sam@example') })
      }
    )
  })

  it('a 401 on the first send is definite (Stripe did nothing): undone; a 401 on the retry after an unclear first send is not: held', async () => {
    await onASeed(
      async () => {
        const before = await everything()
        expect(errorOf(await placeThrough(readerBasket))).toMatchObject({ code: 'PAYMENT_FAILED', details: { reason: 'reader_intent_failed' } })
        expect(await everything()).toEqual(before)
      },
      (_db, stripe) => stripe.failNext('paymentIntents.create', { kind: 'error', error: fakeStripeErrors.authentication() })
    )
    await onASeed(
      async () => {
        const answer = await placeThrough(readerBasket)
        expect(errorOf(answer)).toMatchObject({ status: 502, code: 'PAYMENT_UNCONFIRMED', message: READER_INTENT_UNCONFIRMED_MESSAGE })
        expect(await heldClaims()).toEqual({ places: 2, stock: 3 })
      },
      (_db, stripe) => {
        stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
        stripe.failNext('paymentIntents.create', { kind: 'error', error: fakeStripeErrors.authentication() })
      }
    )
  })

  it('no connection once: sent again with the same key and request, one intent', async () => {
    await onASeed(
      async (stripe) => {
        const placed = placedOf(await placeThrough(readerBasket))
        expect(stripe.calls).toHaveLength(2)
        expect(stripe.calls[1]).toEqual(stripe.calls[0])
        expect(placed.pendingReaderPayment.paymentIntentId).toBe('pi_fake_0001')
      },
      (_db, stripe) => stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
    )
  })

  it("made but the answer lost: the retry gets Stripe's saved answer, so one intent", async () => {
    await onASeed(
      async (stripe) => {
        const placed = placedOf(await placeThrough(readerBasket))
        expect(stripe.calls).toHaveLength(2)
        expect(placed.pendingReaderPayment.paymentIntentId).toBe('pi_fake_0001')
        expect([...stripe.chargedByIntent]).toEqual([])
      },
      (_db, stripe) => stripe.failNext('paymentIntents.create', { kind: 'lost_response' })
    )
  })

  it('no clear answer twice (a 500 Stripe keeps against the key): held pending with every claim, never undone; no secret reaches the screen', async () => {
    await onASeed(
      async (stripe) => {
        const answer = await placeThrough(splitBasket)
        expect(errorOf(answer)).toMatchObject({
          status: 502,
          code: 'PAYMENT_UNCONFIRMED',
          message: READER_INTENT_UNCONFIRMED_MESSAGE,
          details: { stage: 'payment', reason: 'payment_unconfirmed', orderId: expect.any(String) },
        })
        expect(JSON.stringify(answer.body)).not.toContain('secret')
        const orderId = (answer.body as { error: { details: { orderId: string } } }).error.details.orderId
        const order = await orderNow(orderId)
        expect(order).toMatchObject({ payment_status: 'pending' })
        expect(order?.reader_payment).not.toHaveProperty('payment_intent_id')
        expect(await heldClaims()).toEqual({ places: 2, stock: 3 })
        expect(await auditActions(orderId)).toEqual(['order.create'])
        expect(stripe.calls.map((call) => call.idempotencyKey)).toEqual([`${orderId}:reader-intent`, `${orderId}:reader-intent`])
        // A fresh basket with a new key meets Q10: the held order may still be collected for.
        const before = await everything()
        expect(errorOf(await placeThrough(readerBasket))).toMatchObject({ code: 'VALIDATION', message: ORDER_STILL_PROCESSING_MESSAGE })
        expect(await everything()).toEqual(before)
        // Finalise and cancel have no intent to work with: the order is reconcile's (W12).
        expect((await finalise(orderId)).data).toMatchObject({ finalised: false, reason: 'intent_unconfirmed', message: READER_INTENT_UNCONFIRMED_MESSAGE })
        expect((await cancel(orderId)).data).toMatchObject({ cancelled: false, reason: 'intent_unconfirmed' })
        expect(await everything()).toEqual(before)
      },
      (_db, stripe) => stripe.failNext('paymentIntents.create', { kind: 'error', error: fakeStripeErrors.server() })
    )
  })

  it('the order gone before the intent could be written onto it (the write finds no row): held, and the secret is never given out', async () => {
    await onASeed(async (stripe) => {
      const create = stripe.paymentIntents.create
      stripe.paymentIntents.create = async (params, options) => {
        const intent = await create(params, options)
        // Another process undoes the order between T1 and the write.
        const orderId = (params.metadata as Record<string, string>)['order_id'] as string
        await undoOrder(db, orderId, { actor, requestId: 'meanwhile', why: 'test' })
        return intent
      }
      const answer = await placeThrough(readerBasket)
      expect(errorOf(answer)).toMatchObject({ status: 502, code: 'PAYMENT_UNCONFIRMED', message: READER_INTENT_UNCONFIRMED_MESSAGE })
      expect(JSON.stringify(answer.body)).not.toContain('secret')
    })
  })

  it('the intent made but not written onto the order (a database fault): held, and the secret is never given out', async () => {
    await onASeed(async (stripe) => {
      const answer = await whileFailing(db, { table: 'orders', event: 'UPDATE', when: "NEW.reader_payment ? 'payment_intent_id'" }, () => placeThrough(readerBasket))
      expect(errorOf(answer)).toMatchObject({ status: 502, code: 'PAYMENT_UNCONFIRMED', message: READER_INTENT_UNCONFIRMED_MESSAGE })
      expect(JSON.stringify(answer.body)).not.toContain('pi_fake_0001')
      expect(stripe.calls).toHaveLength(1)
      expect(await heldClaims()).toEqual({ places: 2, stock: 3 })
    })
  })
})

describe('finalise (finaliseReaderOrder, T2)', () => {
  it('after the tap: checked against Stripe and marked paid in one transaction; the method Q9 names; the event booking confirmed and the address saved', async () => {
    const shipped = {
      customerId: ID.customer,
      products: [{ productVariantId: ID.candleVariant, quantity: 1, unitPrice: 20 }],
      shippingAddress: { name: 'Sam Test', line1: '1 Mill Lane', city: 'Hebden Bridge', postcode: 'HX7 1AA', country: 'United Kingdom' },
      postageMethod: 'standard',
      saveShippingAddressToCustomer: true,
      event: { eventId: ID.event, accountHolderAttending: true, attendees: [{ ...sam, isAccountHolder: true }] },
      payment: { ...reader, giftCard: GIFT },
    }
    await onASeed(async (stripe) => {
      const placed = placedOf(await placeThrough(shipped))
      const eventStatus = async () => (await db.query<{ status: string }>('SELECT status FROM event_bookings WHERE id = $1', [placed.eventBookingId]))[0]?.status
      const city = async () => (await db.query<{ city: string | null }>('SELECT city FROM customers WHERE id = $1', [ID.customer]))[0]?.city
      expect(await eventStatus()).toBe('pending')
      expect(await city()).toBeNull()
      stripe.completeReaderPayment(placed.pendingReaderPayment.paymentIntentId)
      const done = await finalise(placed.orderId)
      expect(done).toEqual({ ok: true, data: { finalised: true, orderId: placed.orderId, paymentIntentId: 'pi_fake_0001' }, requestId: expect.any(String) })
      expect(await orderNow(placed.orderId)).toMatchObject({ payment_status: 'paid', payment_method: 'split', stripe_payment_intent_id: 'pi_fake_0001' })
      expect(await eventStatus()).toBe('confirmed')
      expect(await city()).toBe('Hebden Bridge')
      expect(await auditActions(placed.orderId)).toEqual(['order.create', 'order.paid'])
      expect(stripe.calls.map((call) => call.method)).toEqual(['paymentIntents.create', 'paymentIntents.retrieve'])
    })
  })

  it('safe twice: the second finds it paid with that payment and writes nothing, as finaliseReaderOrder', async () => {
    await onASeed(async (stripe) => {
      const placed = placedOf(await placeThrough(readerBasket))
      stripe.completeReaderPayment(placed.pendingReaderPayment.paymentIntentId)
      await finalise(placed.orderId)
      const state = await everything()
      expect((await finalise(placed.orderId)).data).toEqual({
        finalised: true,
        orderId: placed.orderId,
        paymentIntentId: 'pi_fake_0001',
        alreadyFinalised: true,
        message: 'This order was already finalised — nothing further was done.',
      })
      expect(await everything()).toEqual(state)
      expect(await auditActions(placed.orderId)).toEqual(['order.create', 'order.paid'])
    })
  })

  it('before the tap: not succeeded, the old words, nothing changed; tapped, finalise then finishes it', async () => {
    await onASeed(async (stripe) => {
      const placed = placedOf(await placeThrough(readerBasket))
      const state = await everything()
      expect((await finalise(placed.orderId)).data).toEqual({
        finalised: false,
        orderId: placed.orderId,
        reason: 'payment_not_succeeded',
        paymentNotSucceeded: true,
        piStatus: 'requires_payment_method',
        message: 'The reader payment has not succeeded yet (status: requires_payment_method). Cancel the order or retry the card on the reader.',
      })
      expect(await everything()).toEqual(state)
      stripe.completeReaderPayment(placed.pendingReaderPayment.paymentIntentId)
      expect((await finalise(placed.orderId)).data).toMatchObject({ finalised: true })
    })
  })

  it('a save-card order before the tap: the card is not read until the payment checks out', async () => {
    await onASeed(async (stripe) => {
      const placed = placedOf(await placeThrough(saving(readerBasket)))
      expect((await finalise(placed.orderId)).data).toMatchObject({ finalised: false, reason: 'payment_not_succeeded' })
      expect(stripe.calls.map((call) => call.method)).toEqual(['paymentIntents.create', 'paymentIntents.retrieve'])
    })
  })

  it("T2 itself never saves a card the customer didn't agree to, whatever it is given", async () => {
    await onASeed(async (stripe) => {
      const placed = placedOf(await placeThrough(readerBasket))
      stripe.completeReaderPayment(placed.pendingReaderPayment.paymentIntentId, { generatedCard: 'pm_reader_saved' })
      const intent = await stripe.paymentIntents.retrieve(placed.pendingReaderPayment.paymentIntentId)
      const card = { paymentMethodId: 'pm_reader_saved', reusable: true, last4: '4242', brand: 'visa' }
      expect(await finaliseOrder(db, placed.orderId, intent, { actor, requestId: 'direct', saveCard: card })).toEqual({ finalised: true, alreadyPaid: false, cardSaved: false })
      expect((await customerCard())?.saved_payment_method_id).toBe('pm_seed')
    })
  })

  describe('a payment that doesn\'t check out leaves the order pending, untouched (W03-plan 2.5): never refunded, never undone', () => {
    async function tappedThen(change: (stripe: FakeStripe, placed: Placed) => Promise<void> | void): Promise<{ answer: FinaliseReaderOrderOutput; stripe: FakeStripe; placed: Placed; same: boolean }> {
      let result: { answer: FinaliseReaderOrderOutput; stripe: FakeStripe; placed: Placed; same: boolean } | null = null
      await onASeed(async (stripe) => {
        const placed = placedOf(await placeThrough(readerBasket))
        await change(stripe, placed)
        const state = await everything()
        const answer = (await finalise(placed.orderId)).data
        result = { answer, stripe, placed, same: JSON.stringify(await everything()) === JSON.stringify(state) }
      })
      if (!result) throw new Error('not run')
      return result
    }
    const reading = (stripe: FakeStripe, change: (intent: Stripe.PaymentIntent) => Stripe.PaymentIntent) => {
      const retrieve = stripe.paymentIntents.retrieve
      stripe.paymentIntents.retrieve = async (id, params, options) => change(await retrieve(id, params, options))
    }

    it('a penny over (the old check let it through): amount_mismatch, the old words', async () => {
      const { answer, stripe, same } = await tappedThen((fake, placed) => fake.completeReaderPayment(placed.pendingReaderPayment.paymentIntentId, { amount: 6901 }))
      expect(answer).toMatchObject({
        finalised: false,
        reason: 'amount_mismatch',
        message: 'The reader charged £69.01 but the order expected £69.00 — do NOT finalise automatically. Check the PaymentIntent (pi_fake_0001) in Stripe and refund/adjust manually.',
      })
      expect(same).toBe(true)
      expect(stripe.refundedPence).toBe(0)
    })

    it('a penny under', async () => {
      const { answer, same } = await tappedThen((fake, placed) => fake.completeReaderPayment(placed.pendingReaderPayment.paymentIntentId, { amount: 6899 }))
      expect(answer).toMatchObject({ finalised: false, reason: 'amount_mismatch' })
      expect(same).toBe(true)
    })

    it('another order\'s, another currency, another Stripe customer', async () => {
      const cases: Array<[string, (intent: Stripe.PaymentIntent) => Stripe.PaymentIntent, string, string]> = [
        ['metadata', (intent) => ({ ...intent, metadata: { order_id: 'someone-else' } }), 'metadata_mismatch', 'This PaymentIntent does not belong to this order (metadata mismatch) — check it in Stripe before doing anything.'],
        ['currency', (intent) => ({ ...intent, currency: 'eur' }), 'currency_mismatch', 'The reader payment is in EUR, not GBP — check it in Stripe before doing anything.'],
        [
          'what the reader actually took',
          (intent) => ({ ...intent, amount_received: 6899 }),
          'amount_mismatch',
          'The reader charged £68.99 but the order expected £69.00 — do NOT finalise automatically. Check the PaymentIntent (pi_fake_0001) in Stripe and refund/adjust manually.',
        ],
        [
          'customer',
          (intent) => ({ ...intent, customer: 'cus_someone_else' }),
          'customer_mismatch',
          'This PaymentIntent was made for a different Stripe customer — do NOT finalise automatically. Check the PaymentIntent (pi_fake_0001) in Stripe before doing anything.',
        ],
      ]
      for (const [what, change, reason, message] of cases) {
        const { answer, same } = await tappedThen((fake, placed) => {
          fake.completeReaderPayment(placed.pendingReaderPayment.paymentIntentId)
          reading(fake, change)
        })
        expect(answer, what).toMatchObject({ finalised: false, reason, message })
        expect(same, what).toBe(true)
      }
    })

    it("Stripe gives no clear answer, or has no such payment: the old words, nothing changed", async () => {
      const unclear = await tappedThen((fake, placed) => {
        fake.completeReaderPayment(placed.pendingReaderPayment.paymentIntentId)
        fake.failNext('paymentIntents.retrieve', { kind: 'unreachable' })
      })
      expect(unclear.answer).toMatchObject({ finalised: false, reason: 'unexpected_state', message: 'An error occurred with our connection to Stripe.' })
      expect(unclear.same).toBe(true)
      const missing = await tappedThen((fake) => fake.failNext('paymentIntents.retrieve', { kind: 'error', error: fakeStripeErrors.missing("payment_intent: 'pi_fake_0001'") }))
      expect(missing.answer).toMatchObject({ finalised: false, reason: 'unexpected_state', message: 'PaymentIntent not found' })
      expect(missing.same).toBe(true)
    })
  })

  describe('saving the card (finaliseReaderOrder through saveCustomerCardOnFile)', () => {
    it('a reusable card: saved to the customer with T2, its last four and brand, and recorded', async () => {
      await onASeed(async (stripe) => {
        const placed = placedOf(await placeThrough(saving(readerBasket)))
        stripe.completeReaderPayment(placed.pendingReaderPayment.paymentIntentId, { generatedCard: 'pm_reader_saved' })
        expect((await finalise(placed.orderId)).data).toEqual({ finalised: true, orderId: placed.orderId, paymentIntentId: 'pi_fake_0001' })
        expect(await customerCard()).toEqual({ stripe_customer_id: 'cus_seed', saved_payment_method_id: 'pm_reader_saved', saved_card_last4: '4242', saved_card_brand: 'visa' })
        expect(stripe.calls.map((call) => [call.method, call.params])).toEqual([
          ['paymentIntents.create', expect.objectContaining({ setup_future_usage: 'off_session' })],
          ['paymentIntents.retrieve', { id: 'pi_fake_0001' }],
          ['paymentIntents.retrieve', { id: 'pi_fake_0001', expand: ['latest_charge'] }],
        ])
        const audit = await db.query<{ action: string; entity_type: string }>("SELECT action, entity_type FROM audit_log WHERE action IN ('order.paid', 'customer.card_saved') ORDER BY at")
        expect(audit).toEqual([
          { action: 'order.paid', entity_type: 'order' },
          { action: 'customer.card_saved', entity_type: 'customer' },
        ])
      })
    })

    it('bug 7: the simulated reader leaves no reusable card: the order is still marked paid, with the warning, and the old card kept', async () => {
      await onASeed(async (stripe) => {
        const placed = placedOf(await placeThrough(saving(readerBasket)))
        stripe.completeReaderPayment(placed.pendingReaderPayment.paymentIntentId, { simulatedReader: true })
        expect((await finalise(placed.orderId)).data).toEqual({ finalised: true, orderId: placed.orderId, paymentIntentId: 'pi_fake_0001', warning: CARD_NOT_SAVED_WARNING })
        expect(await orderNow(placed.orderId)).toMatchObject({ payment_status: 'paid' })
        expect(await customerCard()).toEqual({ stripe_customer_id: 'cus_seed', saved_payment_method_id: 'pm_seed', saved_card_last4: '4242', saved_card_brand: 'visa' })
      })
    })

    it('bug 7: reading the card fails at Stripe: paid all the same, with the warning', async () => {
      await onASeed(async (stripe) => {
        const placed = placedOf(await placeThrough(saving(readerBasket)))
        stripe.completeReaderPayment(placed.pendingReaderPayment.paymentIntentId, { generatedCard: 'pm_reader_saved' })
        stripe.failNext('paymentIntents.retrieve', { kind: 'none' })
        stripe.failNext('paymentIntents.retrieve', { kind: 'unreachable' })
        expect((await finalise(placed.orderId)).data).toMatchObject({ finalised: true, warning: CARD_NOT_SAVED_WARNING })
        expect((await customerCard())?.saved_payment_method_id).toBe('pm_seed')
      })
    })

    it('no card is saved when the customer didn\'t agree, whatever the tap left', async () => {
      await onASeed(async (stripe) => {
        const placed = placedOf(await placeThrough(readerBasket))
        stripe.completeReaderPayment(placed.pendingReaderPayment.paymentIntentId, { generatedCard: 'pm_reader_saved' })
        await finalise(placed.orderId)
        expect((await customerCard())?.saved_payment_method_id).toBe('pm_seed')
        expect(stripe.calls).toHaveLength(2)
      })
    })
  })

  it('a database fault in T2 after the tap: held pending with the money taken, never refunded; finalise again finishes it', async () => {
    await onASeed(async (stripe) => {
      const placed = placedOf(await placeThrough(readerBasket))
      stripe.completeReaderPayment(placed.pendingReaderPayment.paymentIntentId)
      const held = await everything()
      const answer = await whileFailing(db, { table: 'orders', event: 'UPDATE', when: "NEW.payment_status = 'paid'" }, () => finalise(placed.orderId))
      expect(answer.data).toEqual({ finalised: false, orderId: placed.orderId, reason: 'finalise_failed', message: READER_PAID_NOT_FINISHED_MESSAGE })
      expect(await everything()).toEqual(held)
      expect(stripe.refundedPence).toBe(0)
      expect((await finalise(placed.orderId)).data).toMatchObject({ finalised: true })
      expect(stripe.netPence).toBe(6900)
    })
  })

  it('the order undone while Stripe was read (another process): nothing marked, the payment recorded as needing a refund', async () => {
    await onASeed(async (stripe) => {
      const placed = placedOf(await placeThrough(readerBasket))
      stripe.completeReaderPayment(placed.pendingReaderPayment.paymentIntentId)
      const retrieve = stripe.paymentIntents.retrieve
      stripe.paymentIntents.retrieve = async (id, params, options) => {
        const intent = await retrieve(id, params, options)
        await undoOrder(db, placed.orderId, { actor, requestId: 'meanwhile', why: 'test' })
        // The replay's clock stands still on this side; the undo came first, so its row does too.
        vi.setSystemTime(Date.now() + 1_000)
        return intent
      }
      expect((await finalise(placed.orderId)).data).toEqual({ finalised: false, orderId: placed.orderId, reason: 'charged_without_order', message: READER_CHARGED_WITHOUT_ORDER_MESSAGE })
      expect(await auditActions(placed.orderId)).toEqual(['order.create', 'order.undo', 'order.charge_without_order'])
      expect(stripe.refundedPence).toBe(0)
    })
  })

  it('the old rollback starts on the order while Stripe is read: T2 itself refuses it, and nothing is marked', async () => {
    await onASeed(async (stripe) => {
      const placed = placedOf(await placeThrough(readerBasket))
      stripe.completeReaderPayment(placed.pendingReaderPayment.paymentIntentId)
      const retrieve = stripe.paymentIntents.retrieve
      stripe.paymentIntents.retrieve = async (id, params, options) => {
        const intent = await retrieve(id, params, options)
        await db.query(`UPDATE orders SET reader_payment = reader_payment || jsonb_build_object('rollback', jsonb_build_object('started_at', now(), 'done', '{}'::jsonb)) WHERE id = $1`, [placed.orderId])
        return intent
      }
      expect((await finalise(placed.orderId)).data).toMatchObject({ finalised: false, reason: 'rollback_started' })
      expect(await orderNow(placed.orderId)).toMatchObject({ payment_status: 'pending', stripe_payment_intent_id: null })
    })
  })

  it('orders it isn\'t for: not a reader order, the old checkout\'s, or one the old rollback has started on', async () => {
    await onASeed(async (stripe) => {
      const cash = await postOrder(orderInput({ customerId: ID.customer, products: [soap], payment: { method: 'cash', confirmedCashAmount: 24 } }))
      const cashId = (cash.body as { data: { orderId: string } }).data.orderId
      expect((await finalise(cashId)).data).toEqual({ finalised: false, orderId: cashId, reason: 'not_a_reader_order', message: 'This order is not a pending card-reader order.' })
      expect((await cancel(cashId)).data).toEqual({ cancelled: false, orderId: cashId, reason: 'not_a_reader_order', message: 'This order is not a pending card-reader order.' })

      const placed = placedOf(await placeThrough(readerBasket))
      stripe.completeReaderPayment(placed.pendingReaderPayment.paymentIntentId)
      await db.query(`UPDATE orders SET reader_payment = reader_payment - 'method' WHERE id = $1`, [placed.orderId])
      expect((await finalise(placed.orderId)).data).toMatchObject({ finalised: false, reason: 'old_reader_order', message: OLD_READER_ORDER_MESSAGE })
      expect((await cancel(placed.orderId)).data).toMatchObject({ cancelled: false, reason: 'old_reader_order' })

      await db.query(
        `UPDATE orders SET reader_payment = reader_payment || jsonb_build_object('method', 'reader', 'rollback', jsonb_build_object('started_at', now(), 'done', jsonb_build_object('session_capacity', true))) WHERE id = $1`,
        [placed.orderId]
      )
      const state = await everything()
      expect((await finalise(placed.orderId)).data).toMatchObject({ finalised: false, reason: 'rollback_started', message: "This order is already being rolled back, so it can't be finalised." })
      expect((await cancel(placed.orderId)).data).toMatchObject({ cancelled: false, reason: 'rollback_started', message: OLD_ROLLBACK_STARTED_MESSAGE })
      expect(await undoOrder(db, placed.orderId, { actor, requestId: 'direct', why: 'test' })).toEqual({ undone: false, reason: 'rollback_started' })
      expect(await everything()).toEqual(state)
      expect((await finalise('10000000-0000-4000-8000-0000000000ff')).data).toMatchObject({ finalised: false, reason: 'order_not_found', message: 'That order no longer exists.' })
    })
  })
})

describe('cancel (cancelReaderOrder, the one undo)', () => {
  it('no tap: the intent cancelled at Stripe, then everything given back in one transaction, exactly as before the order', async () => {
    let before: Record<string, unknown[]> = {}
    await onASeed(async (stripe) => {
      before = await everything()
      const placed = placedOf(await placeThrough(splitBasket))
      expect(await heldClaims()).toEqual({ places: 2, stock: 3 })
      expect((await cancel(placed.orderId)).data).toEqual({ cancelled: true, orderId: placed.orderId, message: 'The pending order was cancelled and everything it held was released.' })
      expect(await everything()).toEqual(before)
      expect(stripe.calls.map((call) => call.method)).toEqual(['paymentIntents.create', 'paymentIntents.retrieve', 'paymentIntents.cancel'])
      expect(await auditActions(placed.orderId)).toEqual(['order.create', 'order.undo'])
      // Cancel twice: the second finds it gone and gives nothing back again.
      expect((await cancel(placed.orderId)).data).toEqual({ cancelled: true, orderId: placed.orderId, alreadyGone: true, message: 'The order was already rolled back — nothing to do.' })
      expect(await everything()).toEqual(before)
    })
  })

  it('bug 8: a booking with add-ons, on add-on credit too, cancelled: undone (nothing blocks it), and twice gives nothing back twice', async () => {
    await onASeed(async () => {
      const before = await everything()
      const mo = { name: 'Mo Member', email: 'mo@example.com', dateOfBirth: '1985-05-05' }
      const placed = placedOf(
        await placeThrough({
          customerId: ID.member,
          booking: { ...paidSeat([mo, alex]), redemptionSource: 'membership_credit', membershipId: ID.membership, addons: [{ ...towel, redemptionSource: 'membership_credit', membershipId: ID.membership }, { ...towel, redemptionSource: 'paid' }] },
          payment: reader,
        })
      )
      const addonLines = await db.query<{ order_id: string | null }>('SELECT order_id FROM addon_order_lines')
      expect(addonLines.map((line) => line.order_id)).toEqual([placed.orderId, placed.orderId])
      expect((await cancel(placed.orderId)).data).toMatchObject({ cancelled: true })
      expect(await everything()).toEqual(before)
      expect((await cancel(placed.orderId)).data).toMatchObject({ cancelled: true, alreadyGone: true })
      expect(await everything()).toEqual(before)
    })
  })

  it('bug 9: a gift card part used before, its rest used up by this order, cancelled: its balance back and its redeemed date cleared', async () => {
    await onASeed(
      async () => {
        const before = await everything()
        const placed = placedOf(await placeThrough({ customerId: ID.customer, products: [{ ...soap, quantity: 4 }], payment: { ...reader, giftCard: { giftCardId: ID.giftCard, amount: 25 } } }))
        const card = async () => (await db.query<{ remaining_balance: string; redeemed_at: string | null }>('SELECT remaining_balance, redeemed_at FROM gift_cards WHERE id = $1', [ID.giftCard]))[0]
        expect(await card()).toMatchObject({ remaining_balance: '0.00', redeemed_at: expect.anything() })
        await cancel(placed.orderId)
        expect(await card()).toEqual({ remaining_balance: '25.00', redeemed_at: null })
        expect(await everything()).toEqual(before)
      },
      // Part used before: £15 of its £40 gone, not marked redeemed.
      (seedDb) => seedDb.query(`UPDATE gift_cards SET remaining_balance = 25 WHERE id = $1`, [ID.giftCard]).then(() => undefined)
    )
  })

  it('the tap had in fact gone through: finalised instead, with the PaymentIntent just read (one read), and the card saved', async () => {
    await onASeed(async (stripe) => {
      const placed = placedOf(await placeThrough(saving(readerBasket)))
      stripe.completeReaderPayment(placed.pendingReaderPayment.paymentIntentId, { generatedCard: 'pm_reader_saved' })
      expect((await cancel(placed.orderId)).data).toEqual({
        cancelled: false,
        orderId: placed.orderId,
        finalisedInstead: true,
        finaliseResult: { finalised: true, orderId: placed.orderId, paymentIntentId: 'pi_fake_0001' },
        message: 'The reader payment actually succeeded — the order was finalised instead of cancelled.',
      })
      expect(await orderNow(placed.orderId)).toMatchObject({ payment_status: 'paid', payment_method: 'reader' })
      expect((await customerCard())?.saved_payment_method_id).toBe('pm_reader_saved')
      expect(stripe.calls.map((call) => call.method)).toEqual(['paymentIntents.create', 'paymentIntents.retrieve', 'paymentIntents.retrieve'])
    })
  })

  it("the cancel refused because the tap went through between the read and the cancel: read again, finalised instead", async () => {
    await onASeed(async (stripe) => {
      const placed = placedOf(await placeThrough(readerBasket))
      const cancelIntent = stripe.paymentIntents.cancel
      stripe.paymentIntents.cancel = async (id, params, options) => {
        stripe.completeReaderPayment(placed.pendingReaderPayment.paymentIntentId)
        return cancelIntent(id, params, options)
      }
      expect((await cancel(placed.orderId)).data).toMatchObject({ cancelled: false, finalisedInstead: true, finaliseResult: { finalised: true } })
      expect(await orderNow(placed.orderId)).toMatchObject({ payment_status: 'paid' })
    })
  })

  it('anything unclear from Stripe changes nothing: the read, or the cancel and the read after it', async () => {
    await onASeed(async (stripe) => {
      const placed = placedOf(await placeThrough(readerBasket))
      const state = await everything()
      stripe.failNext('paymentIntents.retrieve', { kind: 'unreachable' })
      expect((await cancel(placed.orderId)).data).toEqual({ cancelled: false, orderId: placed.orderId, reason: 'stripe_error', message: 'An error occurred with our connection to Stripe.' })
      stripe.failNext('paymentIntents.cancel', { kind: 'error', error: fakeStripeErrors.server() })
      stripe.failNext('paymentIntents.retrieve', { kind: 'none' })
      stripe.failNext('paymentIntents.retrieve', { kind: 'unreachable' })
      expect((await cancel(placed.orderId)).data).toEqual({ cancelled: false, orderId: placed.orderId, reason: 'stripe_error', message: 'An error occurred with our API.' })
      expect(await everything()).toEqual(state)
    })
  })

  // W11a (review S3): the two cancel rules that keep the money safe, each pinned by a test that fails if
  // it changes (the review's plants RP3 and RP4).
  it("a refused key or a bad request on cancel's first read (a 401, a 403, a plain 400) isn't \"no such intent\": stripe_error, nothing changed", async () => {
    await onASeed(async (stripe) => {
      const placed = placedOf(await placeThrough(readerBasket))
      const state = await everything()
      const badRequest = new Stripe.errors.StripeInvalidRequestError({
        type: 'invalid_request_error',
        statusCode: 400,
        code: 'parameter_invalid_empty',
        message: 'You passed an empty string for an id.',
      })
      const refusals: Array<[Error, string]> = [
        [fakeStripeErrors.authentication(), 'Invalid API Key provided: sk_live_****wxyz'],
        [fakeStripeErrors.permission(), "The provided key 'rk_live_****wxyz' does not have the required permissions for this endpoint."],
        [badRequest, 'You passed an empty string for an id.'],
      ]
      for (const [error, message] of refusals) {
        stripe.failNext('paymentIntents.retrieve', { kind: 'error', error })
        expect((await cancel(placed.orderId)).data).toEqual({ cancelled: false, orderId: placed.orderId, reason: 'stripe_error', message })
        expect(await everything()).toEqual(state)
      }
      // Nothing was asked to cancel; the intent is still open, so the tap can still be taken and finalised.
      expect(stripe.calls.map((call) => call.method)).toEqual(['paymentIntents.create', 'paymentIntents.retrieve', 'paymentIntents.retrieve', 'paymentIntents.retrieve'])
      stripe.completeReaderPayment(placed.pendingReaderPayment.paymentIntentId)
      expect((await finalise(placed.orderId)).data).toMatchObject({ finalised: true })
      expect(stripe.netPence).toBe(6900)
    })
  })

  it("a cancel that fails, then a read that is neither succeeded nor canceled (still open, then processing): stripe_error, nothing changed", async () => {
    await onASeed(async (stripe) => {
      const placed = placedOf(await placeThrough(readerBasket))
      const state = await everything()
      // A 500 on the cancel; the read after finds the intent still waiting for the tap.
      stripe.failNext('paymentIntents.cancel', { kind: 'error', error: fakeStripeErrors.server() })
      expect((await cancel(placed.orderId)).data).toEqual({ cancelled: false, orderId: placed.orderId, reason: 'stripe_error', message: 'An error occurred with our API.' })
      expect(stripe.calls.slice(1).map((call) => call.method)).toEqual(['paymentIntents.retrieve', 'paymentIntents.cancel', 'paymentIntents.retrieve'])
      expect(await everything()).toEqual(state)

      // The tap going through as staff press Cancel: both reads say processing and the cancel fails, with
      // a 500 and then with Stripe's own refusal to cancel a processing intent.
      const retrieve = stripe.paymentIntents.retrieve
      stripe.paymentIntents.retrieve = async (id, params, options) => ({ ...(await retrieve(id, params, options)), status: 'processing' }) as unknown as Stripe.PaymentIntent
      stripe.failNext('paymentIntents.cancel', { kind: 'error', error: fakeStripeErrors.server() })
      expect((await cancel(placed.orderId)).data).toEqual({ cancelled: false, orderId: placed.orderId, reason: 'stripe_error', message: 'An error occurred with our API.' })
      expect(await everything()).toEqual(state)
      const refused = 'You cannot cancel this PaymentIntent because it has a status of processing.'
      stripe.failNext('paymentIntents.cancel', { kind: 'error', error: fakeStripeErrors.invalid('payment_intent_unexpected_state', refused) })
      expect((await cancel(placed.orderId)).data).toEqual({ cancelled: false, orderId: placed.orderId, reason: 'stripe_error', message: refused })
      expect(await everything()).toEqual(state)
      stripe.paymentIntents.retrieve = retrieve

      // The payment lands: the order, still whole, is finalised.
      stripe.completeReaderPayment(placed.pendingReaderPayment.paymentIntentId)
      expect((await finalise(placed.orderId)).data).toMatchObject({ finalised: true })
      expect(stripe.netPence).toBe(6900)
    })
  })

  // W11a (review L1): Stripe answers 404 both for an intent that never existed and for one made in the
  // other mode (live or test) than the key in use. Only the first means nothing can have been taken.
  describe("a 404 on cancel's read means \"never existed\" only from a key of the intent's own mode", () => {
    it('the same mode, test or live: nothing was taken, undone', async () => {
      for (const live of [false, true]) {
        await onASeed(async (stripe) => {
          stripe.keyLivemode = live
          const before = await everything()
          const placed = placedOf(await placeThrough(readerBasket))
          expect((await orderNow(placed.orderId))?.reader_payment?.livemode).toBe(live)
          stripe.failNext('paymentIntents.retrieve', { kind: 'error', error: fakeStripeErrors.missing(`payment_intent: '${placed.pendingReaderPayment.paymentIntentId}'`) })
          expect((await cancel(placed.orderId)).data).toEqual({ cancelled: true, orderId: placed.orderId, message: 'The pending order was cancelled and everything it held was released.' })
          expect(await everything()).toEqual(before)
        })
      }
    })

    it('a key of the other mode (a live intent read with a test key, and the reverse): stripe_error, nothing changed; back on the right key, cancel works', async () => {
      for (const live of [true, false]) {
        await onASeed(async (stripe) => {
          const before = await everything()
          stripe.keyLivemode = live
          const placed = placedOf(await placeThrough(readerBasket))
          const intent = placed.pendingReaderPayment.paymentIntentId
          const state = await everything()
          // The Worker redeployed with the other mode's key: Stripe can't see the intent.
          stripe.keyLivemode = !live
          expect((await cancel(placed.orderId)).data).toEqual({ cancelled: false, orderId: placed.orderId, reason: 'stripe_error', message: otherModeMessage(intent) })
          expect(await everything()).toEqual(state)
          expect(stripe.calls.slice(1).map((call) => call.method)).toEqual(['paymentIntents.retrieve'])
          // Finalise can't see it either, and changes nothing.
          expect((await finalise(placed.orderId)).data).toMatchObject({ finalised: false, reason: 'unexpected_state', message: 'PaymentIntent not found' })
          expect(await everything()).toEqual(state)
          // The right key again: the intent is cancelled and the order undone.
          stripe.keyLivemode = live
          expect((await cancel(placed.orderId)).data).toMatchObject({ cancelled: true })
          expect(await everything()).toEqual(before)
        })
      }
    })

    it("a mode that isn't known (a record without one, or a key that doesn't say): stripe_error, nothing changed", async () => {
      await onASeed(async (stripe) => {
        const placed = placedOf(await placeThrough(readerBasket))
        const intent = placed.pendingReaderPayment.paymentIntentId
        await db.query("UPDATE orders SET reader_payment = reader_payment - 'livemode' WHERE id = $1", [placed.orderId])
        const state = await everything()
        stripe.failNext('paymentIntents.retrieve', { kind: 'error', error: fakeStripeErrors.missing(`payment_intent: '${intent}'`) })
        expect((await cancel(placed.orderId)).data).toEqual({ cancelled: false, orderId: placed.orderId, reason: 'stripe_error', message: otherModeMessage(intent) })
        expect(await everything()).toEqual(state)
      })
      await onASeed(async (stripe) => {
        const placed = placedOf(await placeThrough(readerBasket))
        const intent = placed.pendingReaderPayment.paymentIntentId
        const state = await everything()
        stripe.keyLivemode = null
        stripe.failNext('paymentIntents.retrieve', { kind: 'error', error: fakeStripeErrors.missing(`payment_intent: '${intent}'`) })
        expect((await cancel(placed.orderId)).data).toEqual({ cancelled: false, orderId: placed.orderId, reason: 'stripe_error', message: otherModeMessage(intent) })
        expect(await everything()).toEqual(state)
      })
    })
  })

  it("an intent too far along to cancel: the legacy route's words, nothing changed; Stripe has no such intent: nothing was taken, undone", async () => {
    await onASeed(async (stripe) => {
      const placed = placedOf(await placeThrough(readerBasket))
      const state = await everything()
      const retrieve = stripe.paymentIntents.retrieve
      // A status the legacy route doesn't list as cancellable (its CANCELLABLE) is left alone.
      stripe.paymentIntents.retrieve = async (id, params, options) => ({ ...(await retrieve(id, params, options)), status: 'requires_reauthorization' as never }) as unknown as Stripe.PaymentIntent
      expect((await cancel(placed.orderId)).data).toMatchObject({ cancelled: false, reason: 'stripe_error', message: 'PaymentIntent cannot be cancelled in status requires_reauthorization' })
      expect(await everything()).toEqual(state)
      stripe.paymentIntents.retrieve = retrieve
      stripe.failNext('paymentIntents.retrieve', { kind: 'error', error: fakeStripeErrors.missing("payment_intent: 'pi_fake_0001'") })
      expect((await cancel(placed.orderId)).data).toMatchObject({ cancelled: true })
    })
  })

  it('a paid order is refused with the old words; an undo that fails changes nothing and says so', async () => {
    await onASeed(async (stripe) => {
      const paid = placedOf(await placeThrough(readerBasket))
      stripe.completeReaderPayment(paid.pendingReaderPayment.paymentIntentId)
      await finalise(paid.orderId)
      expect((await cancel(paid.orderId)).data).toEqual({ cancelled: false, orderId: paid.orderId, reason: 'already_paid', message: 'This order is already paid — it cannot be cancelled. Refund it through the order refund flow instead.' })
    })
    await onASeed(async () => {
      const placed = placedOf(await placeThrough(readerBasket))
      const held = await everything()
      const answer = await whileFailing(db, { table: 'orders', event: 'DELETE', when: 'true' }, () => cancel(placed.orderId))
      expect(answer.data).toEqual({ cancelled: false, orderId: placed.orderId, reason: 'rollback_incomplete', message: ROLLBACK_INCOMPLETE_MESSAGE })
      expect(await everything()).toEqual(held)
      expect((await cancel(placed.orderId)).data).toMatchObject({ cancelled: true })
    })
  })

  it('finalise after cancel: the order is gone, the old words', async () => {
    await onASeed(async () => {
      const placed = placedOf(await placeThrough(readerBasket))
      await cancel(placed.orderId)
      expect((await finalise(placed.orderId)).data).toEqual({ finalised: false, orderId: placed.orderId, reason: 'order_not_found', message: 'That order no longer exists.' })
    })
  })
})

describe('crash tests: the Worker dies at each step (W03-plan 3.1 layer 3)', () => {
  /** A Stripe method the Worker dies on: `before`, the request never left; `after`, Stripe acted and the Worker died before it heard. */
  function dyingOn(fake: FakeStripe, method: 'create' | 'retrieve', when: 'before' | 'after'): { died: Promise<void>; revive: () => void } {
    let dead: () => void = () => undefined
    const died = new Promise<void>((resolve) => {
      dead = resolve
    })
    const methods = fake.paymentIntents as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
    const real = methods[method] as (...args: unknown[]) => Promise<unknown>
    methods[method] = async (...args: unknown[]) => {
      if (when === 'after') await real(...args)
      dead()
      return new Promise<never>(() => undefined)
    }
    return { died, revive: () => (methods[method] = real) }
  }

  it('bug 14: after T1, before the intent was asked for: pending with its record and every claim, no intent; the undo puts it all back', async () => {
    await onASeed(async (stripe) => {
      const before = await everything()
      const dying = dyingOn(stripe, 'create', 'before')
      void placeThrough(readerBasket)
      await dying.died
      const [row] = await db.query<{ id: string; reader_payment: ReaderSnapshot }>(`SELECT id, reader_payment FROM orders WHERE payment_status = 'pending'`)
      expect(row?.reader_payment).toMatchObject({ method: 'reader', expected_amount: 69 })
      expect(row?.reader_payment).not.toHaveProperty('payment_intent_id')
      expect(await heldClaims()).toEqual({ places: 2, stock: 3 })
      // A fresh basket meets Q10; finalise and cancel leave it to reconcile (it has no intent on it).
      expect(errorOf(await placeThrough(readerBasket))).toMatchObject({ message: ORDER_STILL_PROCESSING_MESSAGE })
      expect((await cancel(row?.id as string)).data).toMatchObject({ reason: 'intent_unconfirmed' })
      expect(await undoOrder(db, row?.id as string, { actor, requestId: 'reconcile', why: 'test' })).toEqual({ undone: true })
      expect(await everything()).toEqual(before)
    })
  })

  it('after the intent was made, before it was written onto the order: held the same way; the intent exists only at Stripe, with the order named on it', async () => {
    await onASeed(async (stripe) => {
      const dying = dyingOn(stripe, 'create', 'after')
      void placeThrough(readerBasket)
      await dying.died
      const [row] = await db.query<{ id: string; reader_payment: ReaderSnapshot }>(`SELECT id, reader_payment FROM orders WHERE payment_status = 'pending'`)
      expect(row?.reader_payment).not.toHaveProperty('payment_intent_id')
      const intents = await stripe.paymentIntents.list({ customer: 'cus_seed' })
      expect(intents.data.map((intent) => [intent.status, intent.metadata['order_id']])).toEqual([['requires_payment_method', row?.id]])
    })
  })

  it('a second press with the same key while the first is dead: CONFLICT, and no second intent', async () => {
    await onASeed(async (stripe) => {
      const key = crypto.randomUUID()
      const dying = dyingOn(stripe, 'create', 'after')
      void placeThrough(readerBasket, key)
      await dying.died
      const again = await placeThrough(readerBasket, key)
      expect(errorOf(again)).toMatchObject({ status: 409, code: 'CONFLICT' })
      expect(stripe.calls.filter((call) => call.method === 'paymentIntents.create')).toHaveLength(1)
    })
  })

  it('during finalise, after Stripe was read: nothing written; finalise again finishes it, once', async () => {
    await onASeed(async (stripe) => {
      const placed = placedOf(await placeThrough(readerBasket))
      stripe.completeReaderPayment(placed.pendingReaderPayment.paymentIntentId)
      const held = await everything()
      const dying = dyingOn(stripe, 'retrieve', 'after')
      void finalise(placed.orderId)
      await dying.died
      expect(await everything()).toEqual(held)
      dying.revive()
      expect((await finalise(placed.orderId)).data).toMatchObject({ finalised: true })
      expect(await auditActions(placed.orderId)).toEqual(['order.create', 'order.paid'])
      expect(stripe.netPence).toBe(6900)
    })
  })

  it('during T2 or the undo: each is one transaction, so a fault leaves the order exactly as it was, and running it again finishes it', async () => {
    await onASeed(async (stripe) => {
      const placed = placedOf(await placeThrough(readerBasket))
      stripe.completeReaderPayment(placed.pendingReaderPayment.paymentIntentId)
      const held = await everything()
      // The event of T2's last statement, its audit row, failing: the whole of T2 rolls back.
      await whileFailing(db, { table: 'audit_log', event: 'INSERT', when: "NEW.action = 'order.paid'" }, () => finalise(placed.orderId))
      expect(await everything()).toEqual(held)
      expect((await finalise(placed.orderId)).data).toMatchObject({ finalised: true })
    })
    await onASeed(async () => {
      const before = await everything()
      const placed = placedOf(await placeThrough(readerBasket))
      const held = await everything()
      await whileFailing(db, { table: 'audit_log', event: 'INSERT', when: "NEW.action = 'order.undo'" }, () => cancel(placed.orderId))
      expect(await everything()).toEqual(held)
      expect((await cancel(placed.orderId)).data).toMatchObject({ cancelled: true })
      expect(await everything()).toEqual(before)
    })
  })
})

describe("Q10's guard on the reader (W03-decisions Q10, \"W10 review calls\")", () => {
  async function held(params: Record<string, unknown>, ageMinutes: number): Promise<string> {
    const placed = await placeThrough(params)
    const orderId = placed.body.ok ? placed.body.data.orderId : ((placed.body.error.details as { orderId: string }).orderId)
    await db.query(`UPDATE orders SET created_at = now() - make_interval(mins => $1::int) WHERE id = $2`, [ageMinutes, orderId])
    return orderId
  }

  it('a held Worker reader order, however old, refuses a new reader or card order for the customer, before anything else; nothing written, no Stripe call', async () => {
    await onASeed(async (stripe) => {
      await held(readerBasket, 180)
      const state = await everything()
      const calls = stripe.calls.length
      for (const basket of [readerBasket, { ...readerBasket, payment: { method: 'card' } }]) {
        expect(errorOf(await placeThrough(basket))).toEqual({
          status: 400,
          code: 'VALIDATION',
          message: ORDER_STILL_PROCESSING_MESSAGE,
          details: { stage: 'payment', reason: 'order_still_processing', message: ORDER_STILL_PROCESSING_MESSAGE },
        })
      }
      expect(stripe.calls).toHaveLength(calls)
      expect(await everything()).toEqual(state)
      // Nothing for the reader to take isn't Q10's (it is refused for that); cash isn't affected.
      expect(errorOf(await placeThrough({ customerId: ID.customer, products: [soap], payment: { ...reader, giftCard: { giftCardId: ID.giftCard, amount: 24 } } }))).toMatchObject({ details: { reason: 'reader_nothing_to_charge' } })
      expect((await postOrder(orderInput({ customerId: ID.customer, products: [soap], payment: { method: 'cash', confirmedCashAmount: 24 } }))).body.ok).toBe(true)
    })
  })

  it('a held Worker card order refuses a reader order too', async () => {
    await onASeed(
      async () => {
        await held({ ...readerBasket, payment: { method: 'card' } }, 180)
        expect(errorOf(await placeThrough(readerBasket))).toMatchObject({ message: ORDER_STILL_PROCESSING_MESSAGE })
      },
      (_db, stripe) => {
        stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
        stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
      }
    )
  })

  it('an old reader order (no method in its record) counts for 15 minutes only, as before', async () => {
    await onASeed(async () => {
      const orderId = await held(readerBasket, 14)
      await db.query(`UPDATE orders SET reader_payment = reader_payment - 'method' WHERE id = $1`, [orderId])
      expect(errorOf(await placeThrough({ ...readerBasket, booking: undefined }))).toMatchObject({ message: ORDER_STILL_PROCESSING_MESSAGE })
      await db.query(`UPDATE orders SET created_at = now() - interval '16 minutes' WHERE id = $1`, [orderId])
      expect((await placeThrough({ ...readerBasket, booking: undefined })).body.ok).toBe(true)
    })
  })

  it('once settled (paid or cancelled) it no longer counts', async () => {
    await onASeed(async (stripe) => {
      const placed = placedOf(await placeThrough({ ...readerBasket, booking: undefined }))
      stripe.completeReaderPayment(placed.pendingReaderPayment.paymentIntentId)
      await finalise(placed.orderId)
      const second = placedOf(await placeThrough({ ...readerBasket, booking: undefined }))
      await cancel(second.orderId)
      expect((await placeThrough({ ...readerBasket, booking: undefined })).body.ok).toBe(true)
    })
  })
})

describe('the deadline from the request\'s start (W10a), for the reader\'s Stripe calls', () => {
  /** Each call to `method` takes this long on the test clock, cut off at its own timeout. Returns each call's timeout. */
  function taking(fake: FakeStripe, path: 'paymentIntents.create' | 'paymentIntents.retrieve' | 'paymentIntents.cancel', plan: number[]): Array<number | undefined> {
    const timeouts: Array<number | undefined> = []
    const [group, name] = path.split('.') as ['paymentIntents', 'create' | 'retrieve' | 'cancel']
    const methods = fake[group] as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
    const real = methods[name] as (...args: unknown[]) => Promise<unknown>
    methods[name] = async (...args: unknown[]) => {
      const options = (name === 'create' ? args[1] : args[2]) as Stripe.RequestOptions | undefined
      const takes = plan[timeouts.length] ?? 0
      timeouts.push(options?.timeout)
      const limit = options?.timeout ?? ORDER_STRIPE_LIMITS.timeoutMs
      vi.setSystemTime(Date.now() + Math.min(takes, limit))
      if (takes > limit) throw fakeStripeErrors.connection()
      return real(...args)
    }
    return timeouts
  }

  it('the deadline is 30 seconds, and a call needs at least 2 seconds left', () => {
    expect(STRIPE_DEADLINE_MS).toBe(30_000)
    expect(MIN_SEND_MS).toBe(2_000)
  })

  it('the intent: each send gets what is left (at most 10 s); a retry with too little left isn\'t sent, and the order is held', async () => {
    await onASeed(async (stripe) => {
      const input = await withQuotedCardFigure(orderInput(readerBasket))
      const timeouts = taking(stripe, 'paymentIntents.create', [11_000, 11_000])
      const start = Date.now()
      // 19 s already gone in T1 and the route.
      const placing = placeOrder(db, input, { actor, requestId: 'deadline', startedAt: start - 19_000, stripe: () => stripe })
      await expect(placing).rejects.toMatchObject({ code: 'PAYMENT_UNCONFIRMED' })
      expect(timeouts).toEqual([10_000])
      expect(Date.now() - start).toBe(10_000)
    })
  })

  it("the intent's first send with under 2 seconds left isn't sent at all: nothing asked for, so the order is undone", async () => {
    await onASeed(async (stripe) => {
      const before = await everything()
      const input = await withQuotedCardFigure(orderInput(readerBasket))
      const placing = placeOrder(db, input, { actor, requestId: 'deadline', startedAt: Date.now() - 28_500, stripe: () => stripe })
      await expect(placing).rejects.toMatchObject({ code: 'PAYMENT_FAILED', message: READER_INTENT_NOT_SENT_MESSAGE })
      expect(stripe.calls).toEqual([])
      expect(await everything()).toEqual(before)
    })
  })

  it('finalise: a slow read leaves too little for the card; the order is paid with the warning, by 30 s', async () => {
    await onASeed(async (stripe) => {
      const placed = placedOf(await placeThrough(saving(readerBasket)))
      stripe.completeReaderPayment(placed.pendingReaderPayment.paymentIntentId, { generatedCard: 'pm_reader_saved' })
      const { finaliseReaderOrder } = await import('./reader-order')
      const timeouts = taking(stripe, 'paymentIntents.retrieve', [9_000])
      const start = Date.now()
      const answer = await finaliseReaderOrder(db, stripe, placed.orderId, { actor, requestId: 'deadline', startedAt: start - 19_500 })
      expect(answer).toMatchObject({ finalised: true, warning: CARD_NOT_SAVED_WARNING })
      expect(timeouts).toEqual([10_000])
      expect(Date.now() - start).toBe(9_000)
    })
  })

  it('cancel: the read and the cancel share the 30 s; the read after a failed cancel with no time left is unclear, so nothing changes', async () => {
    await onASeed(async (stripe) => {
      const placed = placedOf(await placeThrough(readerBasket))
      const state = await everything()
      const { cancelReaderOrder } = await import('./reader-order')
      const reads = taking(stripe, 'paymentIntents.retrieve', [9_000])
      const cancels = taking(stripe, 'paymentIntents.cancel', [20_000])
      const start = Date.now()
      // 10 s gone before; the read takes 9 s, the cancel is cut off at 10 s: 1 s left, so no read after it.
      const answer = await cancelReaderOrder(db, stripe, placed.orderId, { actor, requestId: 'deadline', startedAt: start - 10_000 })
      expect(answer).toEqual({ cancelled: false, orderId: placed.orderId, reason: 'stripe_error', message: 'An error occurred with our connection to Stripe.' })
      expect(reads).toEqual([10_000])
      expect(cancels).toEqual([10_000])
      expect(Date.now() - start).toBe(19_000)
      expect(await everything()).toEqual(state)
    })
  })

  it('the routes ask for the order\'s limits (10 s a call, no SDK retries) for finalise, cancel and the setup intent and the saved card (under the deadline), and read limits for the token', async () => {
    await onASeed(async (stripe) => {
      const placed = placedOf(await placeThrough(readerBasket))
      stripeClientsMade.length = 0
      await finalise(placed.orderId)
      await cancel(placed.orderId)
      await staffPost(setupIntentsRoute, '/api/v1/staff/terminal/setup-intents', { customerId: ID.customer })
      await staffPost(connectionTokenRoute, '/api/v1/staff/terminal/connection-token', {})
      stripe.completeReaderPayment(placed.pendingReaderPayment.paymentIntentId, { generatedCard: 'pm_x' })
      await staffPost(savedCardRoute, `/api/v1/staff/customers/${ID.customer}/saved-card`, { paymentIntentId: placed.pendingReaderPayment.paymentIntentId }, { customerId: ID.customer })
      expect(stripeClientsMade.map((made) => made.limits)).toEqual([ORDER_STRIPE_LIMITS, ORDER_STRIPE_LIMITS, ORDER_STRIPE_LIMITS, READ_STRIPE_LIMITS, ORDER_STRIPE_LIMITS])
    })
  })
})

// --- Card saving

async function staffPost(route: (request: Request, context?: { params?: Promise<Record<string, string>> }) => Promise<Response>, path: string, body: unknown, params?: Record<string, string>) {
  const response = await route(
    new Request(`https://worker.test${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.STAFF_API_KEY}`,
        'x-staff-email': REPLAY_USER.email,
        'idempotency-key': crypto.randomUUID(),
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
    params ? { params: Promise.resolve(params) } : undefined
  )
  return { status: response.status, body: (await response.json()) as { ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } } }
}

describe('card saving (getTerminalConnectionToken, createTerminalSetupIntent, saveCustomerCardOnFile)', () => {
  it('the connection token: the club\'s Terminal location, or the one sent; Stripe\'s failure in the legacy route\'s words', async () => {
    await onASeed(async (stripe) => {
      expect((await staffPost(connectionTokenRoute, '/api/v1/staff/terminal/connection-token', {})).body).toMatchObject({ ok: true, data: { secret: expect.stringMatching(/^pst_test_/) } })
      await staffPost(connectionTokenRoute, '/api/v1/staff/terminal/connection-token', { locationId: 'tml_second' })
      expect(stripe.calls.map((call) => call.params)).toEqual([{ location: 'tml_GpvkTAMWAnUGe1' }, { location: 'tml_second' }])
      stripe.failNext('terminal.connectionTokens.create', { kind: 'error', error: fakeStripeErrors.server() })
      expect((await staffPost(connectionTokenRoute, '/api/v1/staff/terminal/connection-token', {})).body).toMatchObject({
        ok: false,
        error: { code: 'INTERNAL', message: 'Failed to create connection token: An error occurred with our API.' },
      })
    })
  })

  it('the setup intent: the Stripe customer found or made (ensureStripeCustomer), then card_present for off-session use, under a key; moves no money and writes nothing else', async () => {
    await onASeed(
      async (stripe) => {
        const before = await everything()
        const answer = await staffPost(setupIntentsRoute, '/api/v1/staff/terminal/setup-intents', { customerId: ID.customer })
        expect(answer.body).toMatchObject({ ok: true, data: { clientSecret: 'seti_fake_0002_secret', setupIntentId: 'seti_fake_0002', stripeCustomerId: 'cus_fake_0001' } })
        expect(stripe.calls.map((call) => [call.method, call.params, call.idempotencyKey])).toEqual([
          ['customers.search', { query: `metadata['supabase_customer_id']:'${ID.customer}'`, limit: 1 }, null],
          ['customers.create', { email: 'sam@example.com', name: 'Sam Test', metadata: { supabase_customer_id: ID.customer } }, `${ID.customer}:stripe-customer`],
          ['setupIntents.create', { customer: 'cus_fake_0001', payment_method_types: ['card_present'], usage: 'off_session' }, expect.stringMatching(new RegExp(`^${ID.customer}:setup-intent\\.`))],
        ])
        const after = await everything()
        expect({ ...after, customers: undefined }).toEqual({ ...before, customers: undefined })
        expect((await customerCard())?.stripe_customer_id).toBe('cus_fake_0001')
        expect(stripe.netPence).toBe(0)
      },
      (seedDb) => seedDb.query('UPDATE customers SET stripe_customer_id = NULL WHERE id = $1', [ID.customer]).then(() => undefined)
    )
  })

  // W11a (review S1): the setup intent route has the request's deadline, as the other reader routes.
  it("the setup intent has the 30 s deadline from the request's start: each call gets what is left (at most 10 s)", async () => {
    await onASeed(
      async (stripe) => {
        const seen: Array<[string, number | undefined]> = []
        const watch = (group: 'customers' | 'setupIntents', name: 'search' | 'create') => {
          const methods = stripe[group] as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>
          const real = methods[name] as (...args: unknown[]) => Promise<unknown>
          methods[name] = (...args: unknown[]) => {
            seen.push([`${group}.${name}`, (args[1] as Stripe.RequestOptions | undefined)?.timeout])
            return real(...args)
          }
        }
        watch('customers', 'search')
        watch('customers', 'create')
        watch('setupIntents', 'create')
        expect((await staffPost(setupIntentsRoute, '/api/v1/staff/terminal/setup-intents', { customerId: ID.customer })).body).toMatchObject({ ok: true })
        expect(seen).toEqual([
          ['customers.search', ORDER_STRIPE_LIMITS.timeoutMs],
          ['customers.create', ORDER_STRIPE_LIMITS.timeoutMs],
          ['setupIntents.create', ORDER_STRIPE_LIMITS.timeoutMs],
        ])
      },
      (seedDb) => seedDb.query('UPDATE customers SET stripe_customer_id = NULL WHERE id = $1', [ID.customer]).then(() => undefined)
    )
  })

  it('the setup intent with under 2 s left: nothing sent to Stripe, nothing written, and staff are told to try again', async () => {
    await onASeed(async (stripe) => {
      const { terminalSetupIntent, SETUP_NOT_SENT_REASON } = await import('@/server/rules/payments/terminal')
      const { stripeTiming } = await import('@/server/stripe/deadline')
      const before = await everything()
      // The customer has a Stripe customer: the intent itself isn't sent.
      await expect(terminalSetupIntent(db, stripe, { customerId: ID.customer }, 'press-1', stripeTiming(Date.now() - 28_500))).rejects.toMatchObject({
        code: 'INTERNAL',
        message: `Failed to create SetupIntent: ${SETUP_NOT_SENT_REASON}`,
      })
      // No Stripe customer yet: neither the search nor the create is sent.
      await db.query('UPDATE customers SET stripe_customer_id = NULL WHERE id = $1', [ID.customer])
      const withoutOne = await everything()
      await expect(terminalSetupIntent(db, stripe, { customerId: ID.customer }, 'press-2', stripeTiming(Date.now() - 28_500))).rejects.toMatchObject({
        code: 'INTERNAL',
        message: `Failed to create Stripe customer: ${SETUP_NOT_SENT_REASON}`,
      })
      expect(stripe.calls).toEqual([])
      expect(await everything()).toEqual(withoutOne)
      expect(before).not.toEqual(withoutOne)
    })
  })

  it('the setup intent: the old words for no customer, an unknown one, and Stripe failing', async () => {
    await onASeed(async (stripe) => {
      expect((await staffPost(setupIntentsRoute, '/api/v1/staff/terminal/setup-intents', {})).body.error).toEqual({ code: 'VALIDATION', message: 'customerId is required' })
      expect((await staffPost(setupIntentsRoute, '/api/v1/staff/terminal/setup-intents', { customerId: '10000000-0000-4000-8000-0000000000ff' })).body.error).toEqual({ code: 'NOT_FOUND', message: 'Customer not found' })
      expect((await staffPost(setupIntentsRoute, '/api/v1/staff/terminal/setup-intents', { customerId: 'not-an-id' })).body.error).toEqual({ code: 'NOT_FOUND', message: 'Customer not found' })
      stripe.failNext('setupIntents.create', { kind: 'error', error: fakeStripeErrors.invalid('parameter_unknown', 'Received unknown parameter') })
      expect((await staffPost(setupIntentsRoute, '/api/v1/staff/terminal/setup-intents', { customerId: ID.customer })).body.error).toEqual({
        code: 'INTERNAL',
        message: 'Failed to create SetupIntent: Received unknown parameter',
      })
    })
  })

  it('saving the card after a card-save tap (a SetupIntent): the reusable card, its last four and brand from the generated card, and recorded; Q19: memberships keep their own card', async () => {
    await onASeed(async (stripe) => {
      const setup = await staffPost(setupIntentsRoute, '/api/v1/staff/terminal/setup-intents', { customerId: ID.customer })
      const setupIntentId = setup.body.data?.['setupIntentId'] as string
      stripe.completeReaderSetup(setupIntentId, { generatedCard: 'pm_generated' })
      const memberships = await db.query('SELECT * FROM customer_memberships ORDER BY id')
      const answer = await staffPost(savedCardRoute, `/api/v1/staff/customers/${ID.customer}/saved-card`, { setupIntentId }, { customerId: ID.customer })
      expect(answer.body).toMatchObject({
        ok: true,
        data: { id: ID.customer, stripe_customer_id: 'cus_seed', saved_payment_method_id: 'pm_generated', saved_card_last4: '1881', saved_card_brand: 'mastercard' },
      })
      expect(stripe.calls.slice(1).map((call) => [call.method, call.params])).toEqual([
        ['setupIntents.retrieve', { id: setupIntentId, expand: ['latest_attempt'] }],
        ['paymentMethods.retrieve', { id: 'pm_generated' }],
      ])
      expect(await db.query('SELECT * FROM customer_memberships ORDER BY id')).toEqual(memberships)
      expect(stripe.calls.some((call) => call.method.startsWith('subscriptions') || call.method === 'customers.update')).toBe(false)
      expect((await db.query<{ action: string }>("SELECT action FROM audit_log WHERE entity_type = 'customer'")).map((row) => row.action)).toEqual(['customer.card_saved'])
    })
  })

  it('saving the card: the old words for a card Stripe won\'t let the club charge later, both or neither id, and no such customer; nothing written', async () => {
    await onASeed(async (stripe) => {
      const placed = placedOf(await placeThrough(readerBasket))
      stripe.completeReaderPayment(placed.pendingReaderPayment.paymentIntentId, { simulatedReader: true })
      const state = await everything()
      const path = `/api/v1/staff/customers/${ID.customer}/saved-card`
      const pi = placed.pendingReaderPayment.paymentIntentId
      expect((await staffPost(savedCardRoute, path, { paymentIntentId: pi }, { customerId: ID.customer })).body.error).toEqual({
        code: 'VALIDATION',
        message: `This card cannot be saved for future off-session charges — Stripe reports the captured payment method is not reusable (intent: ${pi}, resolved payment method: ${pi}_card_present).`,
      })
      expect((await staffPost(savedCardRoute, path, {}, { customerId: ID.customer })).body.error).toEqual({ code: 'VALIDATION', message: 'Either paymentIntentId or setupIntentId is required' })
      expect((await staffPost(savedCardRoute, path, { paymentIntentId: pi, setupIntentId: 'seti_x' }, { customerId: ID.customer })).body.error).toEqual({
        code: 'VALIDATION',
        message: 'Pass either paymentIntentId or setupIntentId, not both',
      })
      stripe.failNext('paymentIntents.retrieve', { kind: 'error', error: fakeStripeErrors.missing("payment_intent: 'pi_nope'") })
      expect((await staffPost(savedCardRoute, path, { paymentIntentId: 'pi_nope' }, { customerId: ID.customer })).body.error).toEqual({
        code: 'INTERNAL',
        message: "Failed to resolve saved card: No such payment_intent: 'pi_nope'",
      })
      stripe.completeReaderPayment(pi, { generatedCard: 'pm_ok' })
      expect((await staffPost(savedCardRoute, '/api/v1/staff/customers/10000000-0000-4000-8000-0000000000ff/saved-card', { paymentIntentId: pi }, { customerId: '10000000-0000-4000-8000-0000000000ff' })).body.error).toEqual({
        code: 'NOT_FOUND',
        message: 'Customer not found',
      })
      expect(await everything()).toEqual(state)
    })
  })
})

describe('switching back (W03-plan 3.2): the old functions can still finish a Worker reader order', () => {
  it("the old finaliseReaderOrder reads the Worker's pending record and marks it paid", async () => {
    await onASeed(async (stripe) => {
      const placed = placedOf(await placeThrough(splitBasket))
      stripe.completeReaderPayment(placed.pendingReaderPayment.paymentIntentId)
      const old = oldSide(db, stripe)
      expect(await old.call('finaliseReaderOrder', { orderId: placed.orderId })).toMatchObject({ finalised: true, paymentIntentId: 'pi_fake_0001' })
      expect(await orderNow(placed.orderId)).toMatchObject({ payment_status: 'paid', stripe_payment_intent_id: 'pi_fake_0001' })
    })
  })

  it('the old cancelReaderOrder cancels it and gives everything back', async () => {
    await onASeed(async (stripe) => {
      const before = await everything()
      const placed = placedOf(await placeThrough(splitBasket))
      const old = oldSide(db, stripe)
      expect(await old.call('cancelReaderOrder', { orderId: placed.orderId })).toMatchObject({ cancelled: true })
      expect(await everything()).toEqual(before)
    })
  })
})

describe('round trips (about 20 ms each through Hyperdrive)', () => {
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

  async function counting<T>(work: () => Promise<T>): Promise<{ result: T; statements: string[] }> {
    const { db: countedDb, statements } = countingDb()
    holder.db = countedDb
    try {
      return { result: await work(), statements }
    } finally {
      holder.db = db
      await countedDb.close()
    }
  }

  // W11a (review S1): the intent is written on in its own transaction (BEGIN, the UPDATE, COMMIT), so
  // Postgres bounds it: two round trips more (about 40 ms) than W11's plain statement.
  it('the order: the route, T1, the intent written on (3), the route; finalise: the route, the read, T2; cancel: the route, the read, the undo', async () => {
    await onASeed(async (stripe) => {
      const input = await withQuotedCardFigure(orderInput(readerBasket))
      const placing = await counting(() => postOrder(input))
      const placed = placedOf(placing.result)
      expect(placing.statements).toEqual(['SELECT id,', 'INSERT INTO', 'BEGIN; SELECT', 'SELECT s.id', 'WITH london', 'WITH clock', 'WITH clock', 'WITH clock', 'COMMIT', 'BEGIN; SELECT', 'UPDATE orders', 'COMMIT', 'BEGIN; SELECT', 'UPDATE api_idempotency', 'COMMIT'])
      stripe.completeReaderPayment(placed.pendingReaderPayment.paymentIntentId)
      const finalising = await counting(() => finalise(placed.orderId))
      expect(finalising.statements).toEqual(['SELECT id,', 'INSERT INTO', 'SELECT payment_status,', 'BEGIN; SELECT', 'SELECT o.customer_id,', 'WITH paid', 'WITH clock', 'COMMIT', 'BEGIN; SELECT', 'UPDATE api_idempotency', 'COMMIT'])
      const second = placedOf(await placeThrough({ ...readerBasket, booking: undefined }))
      const cancelling = await counting(() => cancel(second.orderId))
      expect(cancelling.statements).toEqual(['SELECT id,', 'INSERT INTO', 'SELECT payment_status,', 'BEGIN; SELECT', 'SELECT customer_id,', 'WITH l', 'SELECT s.id', 'WITH capacity', 'WITH clock', 'COMMIT', 'BEGIN; SELECT', 'UPDATE api_idempotency', 'COMMIT'])
    })
  })
})

describe('the new routes need an active staff member, as every /api/v1/staff route', () => {
  it('without the staff key: UNAUTHORISED, and nothing reaches Stripe or the database', async () => {
    const { POST: finaliseRoute } = await import('@/app/api/v1/staff/orders/[orderId]/finalise/route')
    const { POST: cancelRoute } = await import('@/app/api/v1/staff/orders/[orderId]/cancel/route')
    await onASeed(async (stripe) => {
      const before = await everything()
      const routes: Array<[string, (request: Request, context?: { params?: Promise<Record<string, string>> }) => Promise<Response>, Record<string, string> | undefined]> = [
        [`/api/v1/staff/orders/${ID.customer}/finalise`, finaliseRoute, { orderId: ID.customer }],
        [`/api/v1/staff/orders/${ID.customer}/cancel`, cancelRoute, { orderId: ID.customer }],
        ['/api/v1/staff/terminal/connection-token', connectionTokenRoute, undefined],
        ['/api/v1/staff/terminal/setup-intents', setupIntentsRoute, undefined],
        [`/api/v1/staff/customers/${ID.customer}/saved-card`, savedCardRoute, { customerId: ID.customer }],
      ]
      for (const [path, route, params] of routes) {
        const response = await route(
          new Request(`https://worker.test${path}`, {
            method: 'POST',
            headers: { 'x-staff-email': REPLAY_USER.email, 'idempotency-key': crypto.randomUUID(), 'content-type': 'application/json' },
            body: JSON.stringify({ customerId: ID.customer, paymentIntentId: 'pi_x' }),
          }),
          params ? { params: Promise.resolve(params) } : undefined
        )
        expect(response.status, path).toBe(401)
        expect(((await response.json()) as { error: { code: string } }).error.code, path).toBe('UNAUTHORISED')
      }
      expect(stripe.calls).toEqual([])
      expect(await everything()).toEqual(before)
    })
  })
})
