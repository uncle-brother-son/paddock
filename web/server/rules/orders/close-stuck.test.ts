import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { POST as closeRoute } from '@/app/api/v1/staff/orders/stuck/close/route'
import type { CloseStuckOutput } from '@/contracts'
import type { Db } from '@/server/db'
import { fakeStripeErrors, type FakeStripe } from '@/server/stripe/fake'
import { insert } from '@/server/rules/testing/database'
import { oldSide, replay, REPLAY_USER, startReplay, type ReplayEnvironment } from '@/server/rules/testing/replay/harness'
import { orderInput, postOrder, withQuotedCardFigure, type OrderAnswer } from '@/server/rules/testing/replay/order-side'
import { ID, paidSeat, sam, seed } from '@/server/rules/testing/replay/scenarios'
import { replayStripe, stripeCallsTakeASecond } from '@/server/rules/testing/replay/stripe-binding'
import type Stripe from 'stripe'
import { audit } from '@/server/audit'
import { CLOSE_WORDS } from './close-stuck'
import { finaliseOrder } from './finalise-order'
import { undoOrder } from './undo-order'
import { reconcile, SCHEDULED_LIMITS, type ReconcileOptions, type ReconcileResult } from './reconcile'
import {
  COMPENSATION_REFUSED_WORDS,
  MEMBERSHIP_STUCK_NOTE,
  OLD_ROLLBACK_WORDS,
  REFUND_FAILED_WORDS,
  REFUND_PENDING_WORDS,
  STRIPE_REFUSED_WORDS,
  STUCK_WORDS,
  stuckList,
  SUBSCRIPTION_LEFT_WORDS,
  SUBSCRIPTION_REFUSED_WORDS,
} from './stuck-list'
import { changedElsewhereWords } from './changed-elsewhere'
import { asWorkerFlow, postFlowStep } from '@/server/rules/testing/replay/flow-side'
import { lapsedSeat } from '@/server/rules/testing/replay/scenarios'

// Brief W14b item 4: the manual close, per item type, through the real route (Issue refunds, a reason), on PGlite
// with the live schema and the replay seed, FakeStripe for Stripe. What each gives back, what it never gives back,
// and its refusals. The close racing reconcile is on real Postgres (close-stuck-postgres.test.ts).

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

const KIM = 'kim@example.com'
const soap = { productVariantId: ID.variant, quantity: 1, unitPrice: 12 }
const towel = { addonId: ID.addon, quantity: 1, unitPrice: 5, redemptionSource: 'paid' }
const eventPlace = { eventId: ID.event, accountHolderAttending: true, guestsOver18Confirmed: true, attendees: [{ ...sam, isAccountHolder: true }] }
const parts = { storeCredit: { amount: 5 }, giftCard: { giftCardId: ID.giftCard, amount: 5 } }
const asSystem: ReconcileOptions = { actor: { type: 'system', id: null }, requestId: 'close-test', ...SCHEDULED_LIMITS }
const run = (stripe: FakeStripe): Promise<ReconcileResult> => reconcile(db, stripe, asSystem)
const later = (minutes: number) => vi.setSystemTime(Date.now() + minutes * 60_000)
const place = async (params: Record<string, unknown>): Promise<OrderAnswer> => postOrder(await withQuotedCardFigure(orderInput(params)))
const pendingOrder = async () => (await db.query<{ id: string }>("SELECT id FROM orders WHERE payment_status = 'pending' ORDER BY created_at DESC"))[0]?.id as string

async function onASeed(work: (stripe: FakeStripe) => Promise<void>): Promise<void> {
  await replay(
    environment,
    {
      name: 'close test',
      async seed(seedDb, stripe) {
        await seed(seedDb, stripe)
        // A staff member without the Issue refunds switch.
        await insert(seedDb, 'staff', { role: 'staff', first_name: 'Kim', last_name: 'Staff', email: KIM, can_issue_refunds: false, can_manage_pricing: false })
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

interface CloseAnswer {
  status: number
  body: { ok: true; data: CloseStuckOutput } | { ok: false; error: { code: string; message: string } }
}
async function postClose(body: Record<string, unknown>, { key = crypto.randomUUID(), email = REPLAY_USER.email } = {}): Promise<CloseAnswer> {
  const response = await closeRoute(
    new Request('https://worker.test/api/v1/staff/orders/stuck/close', {
      method: 'POST',
      headers: { authorization: `Bearer ${process.env.STAFF_API_KEY}`, 'x-staff-email': email, 'idempotency-key': key, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  )
  return { status: response.status, body: (await response.json()) as CloseAnswer['body'] }
}
const dataOf = (answer: CloseAnswer): CloseStuckOutput => {
  if (!answer.body.ok) throw new Error(`refused: ${answer.body.error.code} ${answer.body.error.message}`)
  return answer.body.data
}
const WHY = 'Booking cancelled on the old screens; the customer never paid.'

/** Everything an order can hold, from the seed: back to these = given back. */
async function figures() {
  const one = async (sql: string, id: string) => (await db.query<{ n: unknown }>(sql, [id]))[0]?.n
  return {
    places: await one('SELECT total_booked AS n FROM sessions WHERE id = $1', ID.session),
    pass: await one('SELECT sessions_remaining AS n FROM customer_session_passes WHERE id = $1', ID.ownedPass),
    stock: await one('SELECT stock_quantity AS n FROM product_variants WHERE id = $1', ID.variant),
    credit: await one('SELECT store_credit_balance::text AS n FROM customers WHERE id = $1', ID.customer),
    giftCard: await one('SELECT remaining_balance::text AS n FROM gift_cards WHERE id = $1', ID.giftCard),
    eventPlaces: await one('SELECT places_booked AS n FROM events WHERE id = $1', ID.event),
  }
}
const SEED = { places: 0, pass: 3, stock: 5, credit: '30.00', giftCard: '40.00', eventPlaces: 0 }
const actions = async (orderId: string) => (await db.query<{ action: string }>('SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY at, id', [orderId])).map((row) => row.action)
const latestCompensation = async (orderId: string) =>
  (await db.query<{ details: Record<string, unknown> }>("SELECT details FROM audit_log WHERE action = 'order.compensate' AND entity_id = $1 ORDER BY at DESC, id DESC LIMIT 1", [orderId]))[0]?.details
const bookingOf = async () => (await db.query<{ id: string; status: string; session_id: string; party_size: number }>('SELECT id, status, session_id, party_size FROM bookings WHERE customer_id = $1', [ID.customer]))[0]

/**
 * R1's shape with everything an order can hold: Sam's seat on his pass, an event place, a soap, £5 store credit and
 * £5 on the gift card, the rest on the saved card; both charge attempts unanswered (held, PAYMENT_UNCONFIRMED).
 */
async function heldEverything(stripe: FakeStripe): Promise<string> {
  stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
  stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
  const answer = await place({
    customerId: ID.customer,
    booking: { ...paidSeat([sam]), redemptionSource: 'session_pass_credit', sessionPassId: ID.ownedPass },
    event: eventPlace,
    products: [soap],
    payment: { method: 'card', ...parts },
  })
  expect(answer.body).toMatchObject({ ok: false, error: { code: 'PAYMENT_UNCONFIRMED' } })
  return pendingOrder()
}

/** 16 minutes on, old Cancel (the credit booking's) gives the place and the pass session back; reconcile leaves it changed_since. */
async function changedSince(stripe: FakeStripe, orderId: string): Promise<void> {
  later(16)
  const booking = await bookingOf()
  await oldSide(db, stripe).call('cancelCreditBooking', { bookingId: booking?.id })
  replayStripe.current = stripe
  expect(await run(stripe)).toMatchObject({ left: 1, items: [{ id: orderId, outcome: 'left', reason: 'changed_since' }] })
}

describe('held_order: changed_since (W12 review L2)', () => {
  it("gives back what old code didn't (stock, store credit, gift card, the event place), never the booking's place or pass session; the order goes; Q10 no longer counts it", async () => {
    await onASeed(async (stripe) => {
      const orderId = await heldEverything(stripe)
      expect(await figures()).toEqual({ places: 1, pass: 2, stock: 4, credit: '25.00', giftCard: '35.00', eventPlaces: 1 })
      await changedSince(stripe, orderId)
      // Old Cancel gave the place and the pass session back once; the rest is still held (R1's counts).
      expect(await figures()).toEqual({ places: 0, pass: 3, stock: 4, credit: '25.00', giftCard: '35.00', eventPlaces: 1 })
      expect((await stuckList(db)).checkout).toEqual([expect.objectContaining({ orderId, reason: 'changed_since', close: { kind: 'held_order', orderId } })])
      // While it is held, Q10 refuses Sam another card order.
      expect((await place({ customerId: ID.customer, products: [soap], payment: { method: 'card' } })).body).toMatchObject({ ok: false, error: { details: { reason: 'order_still_processing' } } })

      const callsBefore = stripe.calls.length
      const key = crypto.randomUUID()
      const closed = dataOf(await postClose({ kind: 'held_order', orderId, reason: WHY }, { key }))
      expect(closed).toEqual({
        kind: 'held_order',
        orderId,
        closed: true,
        message: CLOSE_WORDS.held_order,
        givenBack: ['1 item back in stock', '£5.00 store credit back to the customer', '£5.00 back on the gift card it used', '1 event place given back'],
        leftAsFound: ['the booking (now cancelled): its places, pass session and add-ons stay as the old screens left them'],
      })
      // Everything back to the seed: the place and the pass session exactly once (by old Cancel), the rest by the close.
      expect(await figures()).toEqual(SEED)
      expect(stripe.calls.length).toBe(callsBefore)
      expect(await db.query('SELECT id FROM orders')).toEqual([])
      expect((await bookingOf())?.status).toBe('cancelled')
      expect(await db.query('SELECT id FROM event_bookings')).toEqual([])
      // The replay's clock stands still on the Worker's side, so rows written in one test step are compared as a set.
      expect((await actions(orderId)).sort()).toEqual(['order.close', 'order.create', 'order.reconcile'])
      const row = (await db.query<{ actor_type: string; details: Record<string, unknown> }>("SELECT actor_type, details FROM audit_log WHERE action = 'order.close' AND entity_id = $1", [orderId]))[0]
      expect(row).toMatchObject({ actor_type: 'staff', details: { kind: 'held_order', why: WHY, reason: 'changed_since', changed: ['the booking is cancelled'] } })
      expect((await stuckList(db)).checkout).toEqual([])

      // The same key: the same answer (nothing done twice). A new key: closed already.
      expect(dataOf(await postClose({ kind: 'held_order', orderId, reason: WHY }, { key }))).toEqual(closed)
      expect(dataOf(await postClose({ kind: 'held_order', orderId, reason: WHY }))).toEqual({ kind: 'held_order', orderId, closed: true, alreadyClosed: true, message: CLOSE_WORDS.already })
      expect(await figures()).toEqual(SEED)
      // Reconcile finds nothing; Q10 lets Sam's next card order through.
      expect(await run(stripe)).toMatchObject({ checked: 0 })
      expect((await place({ customerId: ID.customer, products: [soap], payment: { method: 'card' } })).body).toMatchObject({ ok: true, data: { status: 'paid' } })
    })
  })

  it("the booking moved and still live (old Move): its places, pass session and add-ons stay with it; the soap and the event place come back", async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
      stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
      await place({
        customerId: ID.customer,
        booking: { ...paidSeat([sam]), redemptionSource: 'session_pass_credit', sessionPassId: ID.ownedPass, addons: [towel] },
        event: eventPlace,
        products: [soap],
        payment: { method: 'card' },
      })
      const orderId = await pendingOrder()
      later(16)
      // Test data standing in for old Move (which needs its own reader payment for the band difference): the booking
      // moved to the peak session, its places moved with it.
      const booking = await bookingOf()
      await db.query('UPDATE bookings SET session_id = $1 WHERE id = $2', [ID.peakSession, booking?.id])
      await db.query('UPDATE sessions SET total_booked = total_booked - 1 WHERE id = $1', [ID.session])
      await db.query('UPDATE sessions SET total_booked = total_booked + 1 WHERE id = $1', [ID.peakSession])
      expect(await run(stripe)).toMatchObject({ items: [{ outcome: 'left', reason: 'changed_since', detail: 'the booking was moved to another session' }] })
      const peakBefore = (await db.query<{ n: number }>('SELECT total_booked AS n FROM sessions WHERE id = $1', [ID.peakSession]))[0]?.n

      const closed = dataOf(await postClose({ kind: 'held_order', orderId, reason: WHY }))
      expect(closed).toMatchObject({ closed: true, givenBack: ['1 item back in stock', '1 event place given back'] })
      expect(closed.leftAsFound).toEqual(['the booking (now confirmed): its places, pass session and add-ons stay as the old screens left them'])
      // The booking keeps its session, its pass session (2 left) and its towel; the order is gone.
      expect(await figures()).toEqual({ ...SEED, pass: 2 })
      expect((await db.query<{ n: number }>('SELECT total_booked AS n FROM sessions WHERE id = $1', [ID.peakSession]))[0]?.n).toBe(peakBefore)
      expect(await bookingOf()).toMatchObject({ status: 'confirmed', session_id: ID.peakSession })
      expect(await db.query<{ order_id: string | null }>('SELECT order_id FROM addon_order_lines WHERE booking_id = $1', [booking?.id])).toEqual([{ order_id: null }])
      expect(await db.query('SELECT id FROM orders')).toEqual([])
    })
  })

  it('the event booking changed by old code (no longer pending): its places stay as old code left them; the rest comes back', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
      stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
      await place({ customerId: ID.customer, event: eventPlace, products: [soap], payment: { method: 'card', storeCredit: { amount: 5 } } })
      const orderId = await pendingOrder()
      later(16)
      // Test data standing in for old event cancellation: the event booking cancelled, its place given back.
      await db.query("UPDATE event_bookings SET status = 'cancelled'")
      await db.query('UPDATE events SET places_booked = places_booked - 1 WHERE id = $1', [ID.event])
      expect(await run(stripe)).toMatchObject({ items: [{ outcome: 'left', reason: 'changed_since', detail: 'the event booking is cancelled' }] })
      const closed = dataOf(await postClose({ kind: 'held_order', orderId, reason: WHY }))
      expect(closed).toMatchObject({ closed: true, givenBack: ['1 item back in stock', '£5.00 store credit back to the customer'], leftAsFound: ['the event booking (now cancelled): its places stay as the old screens left them'] })
      expect(await figures()).toEqual(SEED)
      expect(await db.query<{ status: string }>('SELECT status FROM event_bookings')).toEqual([{ status: 'cancelled' }])
    })
  })

  it('refused, nothing changed: not yet left for a person, settled meanwhile, the old screens\' order, no Issue refunds, no reason', async () => {
    await onASeed(async (stripe) => {
      const orderId = await heldEverything(stripe)
      later(16)
      await oldSide(db, stripe).call('cancelCreditBooking', { bookingId: (await bookingOf())?.id })
      replayStripe.current = stripe
      const before = await figures()
      // Reconcile hasn't looked yet (Stripe may still be dealing with its payment).
      expect(dataOf(await postClose({ kind: 'held_order', orderId, reason: WHY }))).toEqual({ kind: 'held_order', orderId, closed: false, reason: 'not_left_for_a_person', message: CLOSE_WORDS.not_left_for_a_person })
      await run(stripe)
      // Without Issue refunds, or without a reason: refused by the route.
      expect(await postClose({ kind: 'held_order', orderId, reason: WHY }, { email: KIM })).toMatchObject({ status: 403, body: { ok: false, error: { code: 'FORBIDDEN' } } })
      expect(await postClose({ kind: 'held_order', orderId, reason: 'no' })).toMatchObject({ status: 400, body: { ok: false, error: { code: 'VALIDATION' } } })
      expect(await figures()).toEqual(before)
      expect(await actions(orderId)).not.toContain('order.close')
      // Settled meanwhile (test data: as T2 would mark it).
      await db.query("UPDATE orders SET payment_status = 'paid' WHERE id = $1", [orderId])
      expect(dataOf(await postClose({ kind: 'held_order', orderId, reason: WHY }))).toMatchObject({ closed: false, reason: 'settled' })
      expect(await figures()).toEqual(before)
    })
  })

  it('left for a person for another reason (amounts that don\'t match): refused, nothing changed', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
      stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
      await place({ customerId: ID.customer, products: [soap], payment: { method: 'card' } })
      const orderId = await pendingOrder()
      await stripe.paymentIntents.create({ amount: 1100, currency: 'gbp', customer: 'cus_seed', payment_method: 'pm_seed', confirm: true, metadata: { order_id: orderId } })
      later(16)
      expect(await run(stripe)).toMatchObject({ items: [{ outcome: 'left', reason: 'amount_mismatch' }] })
      expect((await stuckList(db)).checkout[0]?.close).toBeUndefined()
      const before = await figures()
      expect(dataOf(await postClose({ kind: 'held_order', orderId, reason: WHY }))).toMatchObject({ closed: false, reason: 'not_left_for_a_person' })
      expect(await figures()).toEqual(before)
      expect(await db.query<{ payment_status: string }>('SELECT payment_status FROM orders')).toEqual([{ payment_status: 'pending' }])
    })
  })

  it("an order the old checkout started: refused (the old sweep's), nothing changed", async () => {
    await onASeed(async (stripe) => {
      const old = oldSide(db, stripe)
      const placed = (await old.call('createOrder', { customerId: ID.customer, products: [soap], payment: { method: 'reader' } })) as { orderId: string }
      replayStripe.current = stripe
      later(16)
      expect(dataOf(await postClose({ kind: 'held_order', orderId: placed.orderId, reason: WHY }))).toMatchObject({ closed: false, reason: 'old_order', message: CLOSE_WORDS.old_order })
      expect(await db.query<{ payment_status: string }>('SELECT payment_status FROM orders')).toEqual([{ payment_status: 'pending' }])
    })
  })
})

describe('held_order: a compensation finished by hand (W13)', () => {
  it("Stripe refuses the refund for good (disputed); a person sorts it in Stripe; the close ends the compensation: everything back, the order gone, no Stripe call", async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('paymentIntents.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
      stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.invalid('charge_disputed', 'This charge has been disputed.') })
      await place({ customerId: ID.customer, membershipPlanId: ID.plan, membershipBillingFrequency: 'monthly', products: [soap], payment: { method: 'card' } })
      const orderId = await pendingOrder()
      later(16)
      expect(await run(stripe)).toMatchObject({ items: [{ outcome: 'left', reason: 'compensation_unfinished' }] })
      // W14c (S1): the held row says every step left is Stripe's definite refusal, so the list offers the close.
      expect(await latestCompensation(orderId)).toMatchObject({ state: 'held', definite: true })
      expect((await stuckList(db)).checkout).toEqual([
        expect.objectContaining({ orderId, close: { kind: 'held_order', orderId }, words: `${COMPENSATION_REFUSED_WORDS} ${MEMBERSHIP_STUCK_NOTE}` }),
      ])
      const callsBefore = stripe.calls.length
      const closed = dataOf(await postClose({ kind: 'held_order', orderId, reason: 'Dispute settled with the bank; subscription already cancelled.' }))
      expect(closed).toMatchObject({ closed: true, message: CLOSE_WORDS.held_order_undone })
      expect(stripe.calls.length).toBe(callsBefore)
      expect(await figures()).toEqual(SEED)
      expect(await db.query('SELECT id FROM orders')).toEqual([])
      const compensate = await db.query<{ details: Record<string, unknown> }>("SELECT details FROM audit_log WHERE action = 'order.compensate' AND entity_id = $1 ORDER BY at, id", [orderId])
      expect(compensate.map((row) => row.details)).toContainEqual(expect.objectContaining({ state: 'done', byHand: true }))
      // One transaction's rows share the replay's fixed clock, so they are compared as a set.
      const all = await actions(orderId)
      expect(all.filter((action) => action === 'order.close' || action === 'order.undo').sort()).toEqual(['order.close', 'order.undo'])
    })
  })
})

describe('W14c (W14b review S1, L3): a compensation is closed only once Stripe has refused every step left for good', () => {
  it('no clear answer from Stripe (unclear held row): no close offered, the close refused `still_checking` with nothing changed; reconcile then finishes it itself', async () => {
    await onASeed(async (stripe) => {
      // Stripe can't be reached for any refund until the test says so: each compensation's refund has no clear answer.
      const create = stripe.refunds.create
      let refundsDown = true
      stripe.refunds.create = async (params, options) => {
        if (refundsDown) throw fakeStripeErrors.connection()
        return create(params, options)
      }
      stripe.failNext('paymentIntents.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
      await place({ customerId: ID.customer, membershipPlanId: ID.plan, membershipBillingFrequency: 'monthly', products: [soap], payment: { method: 'card' } })
      const orderId = await pendingOrder()
      later(16)
      expect(await run(stripe)).toMatchObject({ items: [{ id: orderId, outcome: 'left', reason: 'compensation_unfinished' }] })
      expect(await latestCompensation(orderId)).toMatchObject({ state: 'held', definite: false })
      const [listed] = (await stuckList(db)).checkout
      expect(listed).toMatchObject({ orderId, reason: 'compensation_unfinished', words: `${STUCK_WORDS['compensation_unfinished']} ${MEMBERSHIP_STUCK_NOTE}` })
      expect(listed?.close).toBeUndefined()

      const before = { figures: await figures(), actions: await actions(orderId), calls: stripe.calls.length }
      const answer = dataOf(await postClose({ kind: 'held_order', orderId, reason: 'Cancelled and refunded it in Stripe myself.' }))
      expect(answer).toEqual({ kind: 'held_order', orderId, closed: false, reason: 'still_checking', message: 'The automatic check is still finishing this in Stripe. Check again in a few minutes.' })
      expect(await figures()).toEqual(before.figures)
      expect(await actions(orderId)).toEqual(before.actions)
      expect(stripe.calls.length).toBe(before.calls)
      expect(await db.query("SELECT payment_status FROM orders WHERE id = $1", [orderId])).toEqual([{ payment_status: 'pending' }])

      // Stripe answers again: the next run finishes the compensation on its own (nothing for a person to close).
      refundsDown = false
      later(5)
      expect(await run(stripe)).toMatchObject({ items: [{ id: orderId, outcome: 'undone' }] })
      expect(await db.query('SELECT id FROM orders')).toEqual([])
      expect(stripe.netPence).toBe(0)
      expect(stripe.liveSubscriptions).toEqual([])
    })
  })

  it('L3: an order without the compensation mark is never offered the close, even with a definite held row; the close refuses it', async () => {
    await onASeed(async (stripe) => {
      const orderId = await heldEverything(stripe)
      later(16)
      // Test data standing in for reconcile's row when a press was starting the subscription (no mark written).
      await db.transaction((tx) =>
        audit.recordAll(tx, [
          { actorType: 'system', actorId: null, action: 'order.compensate', entityType: 'order', entityId: orderId, requestId: 't', details: { state: 'held', definite: true, left: ['x'] } },
          { actorType: 'system', actorId: null, action: 'order.reconcile', entityType: 'order', entityId: orderId, requestId: 't', details: { outcome: 'left', reason: 'compensation_unfinished' } },
        ])
      )
      const [listed] = (await stuckList(db)).checkout
      expect(listed).toMatchObject({ orderId, reason: 'compensation_unfinished' })
      expect(listed?.close).toBeUndefined()
      const before = await figures()
      expect(dataOf(await postClose({ kind: 'held_order', orderId, reason: WHY }))).toMatchObject({ closed: false, reason: 'not_left_for_a_person' })
      expect(await figures()).toEqual(before)
    })
  })
})

describe('W14c (W14b N1): late_refund, a refund Stripe refused, recorded as refunded once a person has refunded it by hand', () => {
  /** A saved-card order undone, then its charge lands (T2: `order.charge_without_order`). */
  async function chargedWithoutOrder(stripe: FakeStripe): Promise<{ orderId: string; paymentIntentId: string }> {
    stripe.failNext('paymentIntents.create', { kind: 'lost_response' })
    stripe.failNext('paymentIntents.create', { kind: 'lost_response' })
    await place({ customerId: ID.customer, products: [soap], payment: { method: 'card' } })
    const paymentIntentId = [...stripe.chargedByIntent.keys()][0] as string
    const orderId = await pendingOrder()
    await undoOrder(db, orderId, { actor: { type: 'system', id: null }, requestId: 't', why: 'test' })
    later(1)
    const paymentIntent = (await stripe.paymentIntents.retrieve(paymentIntentId)) as Stripe.PaymentIntent
    expect(await finaliseOrder(db, orderId, paymentIntent, { actor: { type: 'system', id: null }, requestId: 't' })).toEqual({ finalised: false, reason: 'order_gone' })
    return { orderId, paymentIntentId }
  }

  it('refused by Stripe: listed with the close; Issue refunds and a reason; marked refunded, it goes and is never sent again; a second press: closed already', async () => {
    await onASeed(async (stripe) => {
      const { orderId, paymentIntentId } = await chargedWithoutOrder(stripe)
      stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.invalid('charge_disputed', 'This charge is disputed.') })
      expect((await run(stripe)).items[0]).toMatchObject({ outcome: 'refund_failed' })
      const target = { kind: 'late_refund', orderId, paymentIntentId }
      expect((await stuckList(db)).refunds).toEqual([expect.objectContaining({ id: orderId, state: 'failed', words: REFUND_FAILED_WORDS(12, paymentIntentId), close: target })])

      expect(await postClose({ ...target, reason: WHY }, { email: KIM })).toMatchObject({ status: 403 })
      expect(await postClose({ kind: 'late_refund', orderId, reason: WHY })).toMatchObject({ status: 400, body: { ok: false, error: { code: 'VALIDATION' } } })
      expect(await postClose({ ...target, reason: 'ok' })).toMatchObject({ status: 400 })
      const calls = stripe.calls.length
      expect(dataOf(await postClose({ ...target, reason: 'Refunded in the Stripe dashboard after the dispute closed.' }))).toEqual({
        kind: 'late_refund',
        orderId,
        closed: true,
        message: CLOSE_WORDS.late_refund,
      })
      expect(stripe.calls.length).toBe(calls)
      expect((await stuckList(db)).refunds).toEqual([])
      const rows = await db.query<{ actor_type: string; details: Record<string, unknown> }>(
        "SELECT actor_type, details FROM audit_log WHERE entity_id = $1 AND action IN ('order.reconcile', 'order.close') AND (details ? 'refund' OR details->>'kind' = 'late_refund') ORDER BY at, id",
        [orderId]
      )
      expect(rows.map((row) => row.details)).toContainEqual({ outcome: 'refund_confirmed', refund: { paymentIntentId, state: 'confirmed', byHand: { why: 'Refunded in the Stripe dashboard after the dispute closed.' } } })
      expect(rows.map((row) => row.details)).toContainEqual({ kind: 'late_refund', why: 'Refunded in the Stripe dashboard after the dispute closed.', paymentIntentId })

      later(5)
      await run(stripe)
      expect(stripe.calls.filter((call) => call.method === 'refunds.create')).toHaveLength(1)
      expect(dataOf(await postClose({ ...target, reason: WHY }))).toMatchObject({ closed: true, alreadyClosed: true })
    })
  })

  it('still on its way (Stripe says pending): no close offered, and the close refuses it with nothing written', async () => {
    await onASeed(async (stripe) => {
      const { orderId, paymentIntentId } = await chargedWithoutOrder(stripe)
      stripe.refundsStayPending = true
      expect((await run(stripe)).items[0]).toMatchObject({ outcome: 'refund_pending' })
      const [listed] = (await stuckList(db)).refunds
      expect(listed).toMatchObject({ id: orderId, state: 'sent' })
      expect(listed?.close).toBeUndefined()
      const before = await actions(orderId)
      expect(dataOf(await postClose({ kind: 'late_refund', orderId, paymentIntentId, reason: WHY }))).toMatchObject({ closed: false, reason: 'refund_not_failed', message: CLOSE_WORDS.refund_not_failed })
      expect(await actions(orderId)).toEqual(before)
      expect(dataOf(await postClose({ kind: 'late_refund', orderId, paymentIntentId: 'pi_not_this_one', reason: WHY }))).toMatchObject({ closed: false, reason: 'not_listed' })
    })
  })
})

describe('changed_elsewhere: recorded as sorted (W12a N2)', () => {
  /** W12 review P1: held on the card, then old Cancel & Refund to store credit 16 minutes on. */
  async function p1(stripe: FakeStripe): Promise<string> {
    stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
    stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
    await place({ customerId: ID.customer, booking: paidSeat([sam]), products: [soap], payment: { method: 'card' } })
    const orderId = await pendingOrder()
    later(16)
    await oldSide(db, stripe).call('refundBooking', { bookingId: (await bookingOf())?.id, refundMethod: 'credit' })
    replayStripe.current = stripe
    return orderId
  }

  it("refused until reconcile has looked in Stripe; then marked sorted: nothing moved, no longer listed or read", async () => {
    await onASeed(async (stripe) => {
      const orderId = await p1(stripe)
      expect((await stuckList(db)).checkout).toEqual([expect.not.objectContaining({ close: expect.anything() })])
      expect(dataOf(await postClose({ kind: 'changed_elsewhere', orderId, reason: WHY }))).toMatchObject({ closed: false, reason: 'still_checking' })
      // A payment naming it still open in Stripe (it could still be paid): refused too.
      const open = await stripe.paymentIntents.create({ amount: 3200, currency: 'gbp', customer: 'cus_seed', metadata: { order_id: orderId } })
      await run(stripe)
      expect((await stuckList(db)).checkout[0]).toMatchObject({ finding: { state: 'open' } })
      expect(dataOf(await postClose({ kind: 'changed_elsewhere', orderId, reason: WHY }))).toMatchObject({ closed: false, reason: 'still_checking' })
      // Cancelled in Stripe, as the words say: the next check finds nothing taken, and the close is offered.
      await stripe.paymentIntents.cancel(open.id)
      later(6)
      await run(stripe)
      expect((await stuckList(db)).checkout).toEqual([expect.objectContaining({ orderId, reason: 'changed_elsewhere', close: { kind: 'changed_elsewhere', orderId } })])
      const before = await figures()
      const callsBefore = stripe.calls.length
      expect(dataOf(await postClose({ kind: 'changed_elsewhere', orderId, reason: WHY }))).toEqual({ kind: 'changed_elsewhere', orderId, closed: true, message: CLOSE_WORDS.changed_elsewhere })
      expect(await figures()).toEqual(before)
      expect(await db.query<{ payment_status: string }>('SELECT payment_status FROM orders')).toEqual([{ payment_status: 'partially_refunded' }])
      expect((await stuckList(db)).checkout).toEqual([])
      expect(dataOf(await postClose({ kind: 'changed_elsewhere', orderId, reason: WHY }))).toMatchObject({ closed: true, alreadyClosed: true })
      later(6)
      expect(await run(stripe)).toMatchObject({ checked: 0 })
      expect(stripe.calls.length).toBe(callsBefore)
    })
  })

  it('an order that was never listed (an ordinary paid order): refused, nothing written', async () => {
    await onASeed(async () => {
      const paid = await place({ customerId: ID.customer, products: [soap], payment: { method: 'card' } })
      if (!paid.body.ok) throw new Error('not placed')
      const orderId = paid.body.data.orderId
      expect(dataOf(await postClose({ kind: 'changed_elsewhere', orderId, reason: WHY }))).toMatchObject({ closed: false, reason: 'not_listed' })
      expect(await actions(orderId)).not.toContain('order.close')
    })
  })
})

describe('subscription_left: recorded as sorted (W13a, W13c, W13d)', () => {
  async function leftRow(orderId: string, subscriptionId: string): Promise<void> {
    // Test data: the row T2 writes when it finds the order gone after its press made the subscription.
    await db.query(
      `INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, request_id, details)
       VALUES ('system', NULL, 'order.subscription_left', 'order', $1, 'w14b', $2::jsonb)`,
      [orderId, { state: 'left', subscriptionId, invoicePaymentIntentId: null, amountPaid: 0, found: 'order_gone', refunded: [], left: ['test'] }]
    )
  }

  it("the warning carries the close; marked sorted, it goes, and reconcile no longer retries it; again: closed already", async () => {
    await onASeed(async (stripe) => {
      const goneOrder = crypto.randomUUID()
      await leftRow(goneOrder, 'sub_by_hand')
      expect((await stuckList(db)).warnings).toEqual([
        expect.objectContaining({ id: goneOrder, warning: SUBSCRIPTION_LEFT_WORDS('sub_by_hand'), close: { kind: 'subscription_left', orderId: goneOrder, subscriptionId: 'sub_by_hand' } }),
      ])
      // Without the subscription named: refused by the route.
      expect(await postClose({ kind: 'subscription_left', orderId: goneOrder, reason: WHY })).toMatchObject({ status: 400 })
      expect(dataOf(await postClose({ kind: 'subscription_left', orderId: goneOrder, subscriptionId: 'sub_by_hand', reason: 'Cancelled and refunded in Stripe by hand.' }))).toEqual({
        kind: 'subscription_left',
        orderId: goneOrder,
        closed: true,
        message: CLOSE_WORDS.subscription_left,
      })
      expect((await stuckList(db)).warnings).toEqual([])
      const callsBefore = stripe.calls.length
      expect(await run(stripe)).toMatchObject({ checked: 0 })
      expect(stripe.calls.length).toBe(callsBefore)
      expect(dataOf(await postClose({ kind: 'subscription_left', orderId: goneOrder, subscriptionId: 'sub_by_hand', reason: WHY }))).toMatchObject({ closed: true, alreadyClosed: true })
      expect(dataOf(await postClose({ kind: 'subscription_left', orderId: goneOrder, subscriptionId: 'sub_other', reason: WHY }))).toMatchObject({ closed: false, reason: 'not_listed' })
    })
  })

  it('refused while its order is still pending (its compensation puts it back)', async () => {
    await onASeed(async (stripe) => {
      stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
      stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
      await place({ customerId: ID.customer, products: [soap], payment: { method: 'card' } })
      const orderId = await pendingOrder()
      await leftRow(orderId, 'sub_pending')
      expect(dataOf(await postClose({ kind: 'subscription_left', orderId, subscriptionId: 'sub_pending', reason: WHY }))).toMatchObject({ closed: false, reason: 'order_pending' })
      expect((await stuckList(db)).warnings).toHaveLength(1)
    })
  })
})

describe('W13c review L4: put-back retries come last, and a definite refusal stops them', () => {
  it("a cancel Stripe refuses for good: one `refused` row, never retried, still listed with words to sort it by hand; the run settles the pending order first", async () => {
    await onASeed(async (stripe) => {
      // A live subscription naming an order that is gone, left by a press (test data for T2's row).
      const goneOrder = crypto.randomUUID()
      const made = await stripe.subscriptions.create({ customer: 'cus_seed', items: [{ price: 'price_seed_monthly' }], metadata: { order_id: goneOrder } })
      await db.query(
        `INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, request_id, details)
         VALUES ('system', NULL, 'order.subscription_left', 'order', $1, 'w14b', $2::jsonb)`,
        [goneOrder, { state: 'left', subscriptionId: made.id, invoicePaymentIntentId: null, amountPaid: 0, found: 'order_gone', refunded: [], left: ['test'] }]
      )
      // And a held card order, due at the same time.
      stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
      stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
      await place({ customerId: ID.customer, products: [soap], payment: { method: 'card' } })
      const orderId = await pendingOrder()
      later(16)
      stripe.failNext('subscriptions.cancel', { kind: 'error', error: fakeStripeErrors.invalid('resource_missing', 'No such subscription.') })
      stripe.failNext('subscriptions.retrieve', { kind: 'none' })
      const ran = await run(stripe)
      expect(ran.items.map((item) => item.id)).toEqual([orderId, goneOrder])
      expect(ran.items[1]).toMatchObject({ outcome: 'left', reason: 'subscription_refused' })
      const rows = await db.query<{ details: { state: string } }>("SELECT details FROM audit_log WHERE action = 'order.subscription_left' AND entity_id = $1 ORDER BY at, id", [goneOrder])
      expect(rows.map((row) => row.details.state)).toEqual(['left', 'refused'])
      expect((await stuckList(db)).warnings).toEqual([expect.objectContaining({ id: goneOrder, warning: SUBSCRIPTION_REFUSED_WORDS(made.id), close: expect.objectContaining({ kind: 'subscription_left' }) })])
      // Not retried: no Stripe call on the next run.
      later(6)
      const callsBefore = stripe.calls.length
      expect(await run(stripe)).toMatchObject({ checked: 0 })
      expect(stripe.calls.length).toBe(callsBefore)
      // A person sorts it in Stripe and marks it sorted.
      expect(dataOf(await postClose({ kind: 'subscription_left', orderId: goneOrder, subscriptionId: made.id, reason: WHY }))).toMatchObject({ closed: true })
      expect((await stuckList(db)).warnings).toEqual([])
    })
  })

  it('a row naming another order\'s subscription: one `refused` row, then not read again', async () => {
    await onASeed(async (stripe) => {
      const goneOrder = crypto.randomUUID()
      const theirs = await stripe.subscriptions.create({ customer: 'cus_seed', items: [{ price: 'price_seed_monthly' }], metadata: { order_id: crypto.randomUUID() } })
      await db.query(
        `INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, request_id, details)
         VALUES ('system', NULL, 'order.subscription_left', 'order', $1, 'w14b', $2::jsonb)`,
        [goneOrder, { state: 'left', subscriptionId: theirs.id, invoicePaymentIntentId: null, amountPaid: 0, found: 'order_gone', refunded: [], left: ['test'] }]
      )
      expect((await run(stripe)).items).toEqual([expect.objectContaining({ id: goneOrder, outcome: 'left', reason: 'subscription_not_this_order' })])
      const callsBefore = stripe.calls.length
      expect(await run(stripe)).toMatchObject({ checked: 0 })
      expect(stripe.calls.length).toBe(callsBefore)
      expect(stripe.subscription(theirs.id)?.status).toBe('active')
    })
  })
})

describe('words (brief W14b item 3; W12 review L5, W13 to W13d)', () => {
  // Every reason reconcile records for an order or flow it leaves, and the ones its finalise and cancel can hand it
  // (reconcile.ts left(...), FinaliseMismatch, the reader and flow routes' reasons).
  const REASONS = [
    'waiting', 'old_code', 'unclear', 'other_mode', 'amount_mismatch', 'customer_mismatch', 'metadata_mismatch', 'currency_mismatch',
    'several_payments', 'changed_since', 'finalise_failed', 'undo_failed', 'old_rollback', 'charged_without_order', 'charged_without_record',
    'payment_not_succeeded', 'compensation_unfinished', 'several_subscriptions', 'replaced_unconfirmed', 'subscription_starting',
    // W12 review L5's list, which fell back to "something unexpected" before W14b.
    'unexpected_state', 'paid_by_another_payment', 'not_pending', 'order_not_found', 'not_a_reader_order', 'intent_unconfirmed', 'old_reader_order',
    // The rest the routes can answer.
    'old_reader_flow', 'rollback_started', 'compensating', 'membership_not_started', 'payment_missing', 'subscription_mismatch',
    'membership_line_missing', 'membership_row_missing', 'subscription_unconfirmed',
  ]
  it.each(REASONS)('%s has words of its own, saying what to do', (reason) => {
    const words = STUCK_WORDS[reason]
    expect(words).toBeDefined()
    expect(words).not.toBe(STUCK_WORDS['unexpected'])
    expect(words).toMatch(/nothing to do|don't take payment again|press Resolve now|tell a manager|press Close order/i)
  })

  it('the late refund, the put-back, the changed-elsewhere order and the key alert each say what staff should do', () => {
    expect(REFUND_PENDING_WORDS(12, 'pi_1')).toContain("Nothing to do. Don't refund it by hand.")
    expect(REFUND_FAILED_WORDS(12, 'pi_1')).toContain('Refund it in Stripe by hand (or tell a manager if Stripe won\'t), then press Mark refunded')
    expect(COMPENSATION_REFUSED_WORDS).toContain('then press Close order')
    expect(SUBSCRIPTION_LEFT_WORDS('sub_1')).toContain('then press Mark sorted')
    expect(SUBSCRIPTION_REFUSED_WORDS('sub_1')).toContain('then press Mark sorted')
    // W14c (S1): Close order is offered only once Stripe has refused for good, so these words don't name it.
    expect(STUCK_WORDS['compensation_unfinished']).not.toContain('Close order')
    // W14c (W14b review L2): nothing finishes the old rollback on a Worker order, so no one is sent to Resolve now.
    const oldRollback =
      "The old screens had started cancelling this order and couldn't finish. Nothing more will be changed automatically: don't take payment again, and tell a manager."
    expect([OLD_ROLLBACK_WORDS, STUCK_WORDS['old_rollback'], STUCK_WORDS['rollback_started'], CLOSE_WORDS.old_rollback]).toEqual([oldRollback, oldRollback, oldRollback, oldRollback])
    expect(STUCK_WORDS['changed_since']).toContain('press Close order on the Orders page')
    expect(STRIPE_REFUSED_WORDS).toContain('Tell a manager straight away')
    for (const state of ['taken', 'nothing_taken', 'other_mode'] as const) expect(changedElsewhereWords({ state, amount: 100, paymentIntentIds: [] })).toContain('then press Mark sorted')
    expect(changedElsewhereWords({ state: 'open', amount: 0, paymentIntentIds: ['pi_1'] })).toContain('Cancel that payment in Stripe')
  })

  it("a Worker Settle whose booking was changed meanwhile: the undo's warning says no payment was taken (never \"refunded\")", async () => {
    await onASeed(async (stripe) => {
      const old = oldSide(db, stripe)
      const bookingId = await lapsedSeat((action, params) => old.call(action, params), db)
      const started = (await old.call('settleLapsedBooking', { bookingId, payment: { method: 'reader' } })) as { pendingReaderPayment: { pendingId: string } }
      await asWorkerFlow(db, started.pendingReaderPayment.pendingId)
      replayStripe.current = stripe
      // Test data: someone else changes the booking while the payment is pending.
      await db.query("UPDATE bookings SET status = 'cancelled' WHERE id = $1", [bookingId])
      const answer = await postFlowStep('cancel', started.pendingReaderPayment.pendingId)
      expect(answer.body).toMatchObject({ ok: true, data: { cancelled: true } })
      const warning = (answer.body as { data: { warning?: string } }).data.warning ?? ''
      expect(warning).toContain('it was left as found; no payment was taken')
      expect(warning).not.toContain('refunded')
      expect(stripe.netPence).toBe(0)
    })
  })
})
