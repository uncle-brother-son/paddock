import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import * as bookingRefunds from '@/server/rules/bookings/refunds'
import { REFUND_OPEN_MESSAGE } from '@/server/rules/bookings/failure-messages'
import { startTestDatabase, type TestDatabase } from '@/server/rules/testing/database'
import { stripeTiming } from '@/server/stripe/deadline'
import { FakeStripe } from '@/server/stripe/fake'
import {
  EVENT_BOOKING_CLAIMS_DUE_SQL,
  markStepEClaimRefused,
  openClaimHoldingOrder,
  ORDER_CLAIMS_DUE_SQL,
  readEventBookingClaim,
  readOrderClaim,
  refundOpenRefusal,
  refuseWhileRefundOpen,
  stepEClaimFinished,
  stepEClaimRefusal,
  writeEventBookingClaim,
  writeOrderClaim,
  type EventBookingClaimDetails,
  type OrderClaimDetails,
  type StepEPlan,
} from './claims'
import { EVENT_BOOKING_REFUND_OPEN_MESSAGE, ORDER_REFUND_OPEN_MESSAGE } from './failure-messages'
import { cardPartRequest, claimRefundKey, EVENT_BOOKING_CLAIMS, findCardPart, ORDER_CLAIMS, sendCardPart, type CardPart } from './pipeline'

// Brief W27 item 2 (E-plan 4.2, lead call L2): claims on orders and event bookings. Same details and keys as step D's;
// one card part at most; an open claim refuses any other refund on its subject (`refund_open`). No route calls them
// yet, so these tests are their only caller. The lock order and the races are in claims-postgres.test.ts.

let database: TestDatabase
let db: Db
beforeAll(async () => {
  database = await startTestDatabase({ schema: 'live' })
  db = database.db
})
afterAll(() => database.stop())
beforeEach(async () => {
  await db.query('DELETE FROM audit_log')
})

const STAFF = '30000000-0000-4000-8000-000000000002'
const by = (requestId = 'w27-claims') => ({ actor: { type: 'staff' as const, id: STAFF }, requestId })
const id = () => crypto.randomUUID()

const cardPart = (orderId: string, amount: number, paymentIntentId = 'pi_w27'): CardPart => ({ orderId, paymentIntentId, amount, lines: [{ lineId: id(), amount }] })
const plan = (orderId: string, parts: { card?: number; storeCredit?: number; cash?: number }): StepEPlan => ({
  card: parts.card ? [cardPart(orderId, parts.card)] : [],
  storeCredit: parts.storeCredit ?? 0,
  cash: parts.cash ?? 0,
  ownOrderId: orderId,
})
const orderDetails = (orderId: string, parts: { card?: number; storeCredit?: number; cash?: number }, extra: Partial<OrderClaimDetails> = {}): OrderClaimDetails => ({
  kind: 'refund',
  amount: (parts.card ?? 0) + (parts.storeCredit ?? 0) + (parts.cash ?? 0),
  method: parts.cash ? 'cash' : parts.card ? 'card' : 'credit',
  reason: null,
  worker: true,
  plan: plan(orderId, parts),
  livemode: parts.card ? false : null,
  ...extra,
})
const eventDetails = (orderId: string, parts: { card?: number; storeCredit?: number; cash?: number }, extra: Partial<EventBookingClaimDetails> = {}): EventBookingClaimDetails => ({
  ...orderDetails(orderId, parts),
  kind: 'cancel_places',
  orderId,
  ...extra,
})
const onOrder = (orderId: string, details: OrderClaimDetails) => db.transaction((tx) => writeOrderClaim(tx, orderId, details, by()))
const onEventBooking = (eventBookingId: string, details: EventBookingClaimDetails) => db.transaction((tx) => writeEventBookingClaim(tx, eventBookingId, details, by()))
const finish = (on: { finished: string; entityType: string }, subjectId: string, claimId: string) =>
  db.query("INSERT INTO audit_log (actor_type, action, entity_type, entity_id, details) VALUES ('staff', $1, $2, $3, $4::jsonb)", [on.finished, on.entityType, subjectId, JSON.stringify({ claimId, outcome: 'given' })])
const claimRows = async () => db.query<{ action: string }>("SELECT action FROM audit_log WHERE action LIKE '%.refund_claimed' ORDER BY at, id")

async function refusal(work: () => Promise<unknown>): Promise<ApiError> {
  try {
    await work()
  } catch (err) {
    if (err instanceof ApiError) return err
    throw err
  }
  throw new Error('Not refused.')
}

describe('the same record as step D, on a different subject (L2)', () => {
  it("an order's claim: `order.refund_claimed` on the order, with step D's fields", async () => {
    const orderId = id()
    const details = orderDetails(orderId, { card: 24, storeCredit: 6 }, { reason: 'Damaged in the post' })
    const claim = await onOrder(orderId, details)
    const row = (await db.query<Record<string, unknown>>('SELECT actor_type, actor_id, action, entity_type, entity_id, request_id, details FROM audit_log WHERE id = $1', [claim.id]))[0]
    expect(row).toEqual({ actor_type: 'staff', actor_id: STAFF, action: 'order.refund_claimed', entity_type: 'order', entity_id: orderId, request_id: 'w27-claims', details })
    expect(claim).toMatchObject({ orderId, staffId: STAFF, details })
    // Step D's claim details, less what only a booking has (`pricePaidBefore`, and what each R1 changed).
    expect(Object.keys(details).sort()).toEqual(['amount', 'kind', 'livemode', 'method', 'plan', 'reason', 'worker'])
    expect(Object.keys(details.plan).sort()).toEqual(['card', 'cash', 'ownOrderId', 'storeCredit'])
    expect(await readOrderClaim(db, claim.id)).toEqual(claim)
  })

  it("an event booking's claim: `event_booking.refund_claimed` on the booking, naming the order that paid for it", async () => {
    const orderId = id()
    const eventBookingId = id()
    const details = eventDetails(orderId, { card: 40 })
    const claim = await onEventBooking(eventBookingId, details)
    const row = (await db.query<Record<string, unknown>>('SELECT action, entity_type, entity_id, details FROM audit_log WHERE id = $1', [claim.id]))[0]
    expect(row).toEqual({ action: 'event_booking.refund_claimed', entity_type: 'event_booking', entity_id: eventBookingId, details })
    expect(claim).toMatchObject({ eventBookingId, orderId, staffId: STAFF })
    expect(await readEventBookingClaim(db, claim.id)).toEqual(claim)
  })

  it('cash (Q26) names who handed it over, and has no Stripe mode', async () => {
    const orderId = id()
    const claim = await onOrder(orderId, orderDetails(orderId, { cash: 15 }, { handedOverBy: STAFF }))
    expect(claim.details).toMatchObject({ method: 'cash', handedOverBy: STAFF, livemode: null, plan: { card: [], storeCredit: 0, cash: 15 } })
  })

  it("each is its own subject's: an order's claim isn't a booking's or an event booking's, and step D never reads it", async () => {
    const orderId = id()
    const order = await onOrder(orderId, orderDetails(orderId, { card: 10 }))
    const eventBookingId = id()
    const other = id()
    const event = await onEventBooking(eventBookingId, eventDetails(other, { card: 10 }))
    expect(await readEventBookingClaim(db, order.id)).toBeNull()
    expect(await readOrderClaim(db, event.id)).toBeNull()
    for (const claim of [order, event]) expect(await bookingRefunds.readClaim(db, claim.id)).toBeNull()
    expect(await bookingRefunds.refundClaimOpen(db, orderId)).toBe(false)
    expect(await bookingRefunds.refundClaimOpen(db, eventBookingId)).toBe(false)
  })
})

describe("the same keys as step D: `<claimId>:refund:<orderId>`, with the claim in the metadata", () => {
  it('the card part of an order claim is sent once under the claim\'s key, and reconcile\'s look-up finds it by the claim', async () => {
    const stripe = new FakeStripe()
    stripe.addCustomer('cus_w27')
    const intent = await stripe.paymentIntents.create({ amount: 3000, currency: 'gbp', customer: 'cus_w27', payment_method: 'pm_w27', off_session: true, confirm: true })
    const orderId = id()
    const details = orderDetails(orderId, { card: 24 })
    details.plan.card[0]!.paymentIntentId = intent.id
    const claim = await onOrder(orderId, details)
    const part = claim.details.plan.card[0] as CardPart
    const now = Date.now()
    const answer = await sendCardPart(stripe, claim.id, part, stripeTiming(now, () => now))
    expect(answer.outcome).toBe('went')
    const sent = stripe.calls.filter((call) => call.method === 'refunds.create')
    expect(sent).toEqual([{ method: 'refunds.create', params: cardPartRequest(claim.id, part), idempotencyKey: `${claim.id}:refund:${orderId}` }])
    expect(sent[0]?.params).toEqual({ payment_intent: intent.id, amount: 2400, metadata: { refund_key: `${claim.id}:refund:${orderId}`, claim_id: claim.id } })
    expect(claimRefundKey(claim.id, orderId)).toBe(`${claim.id}:refund:${orderId}`)
    expect(await findCardPart(stripe, claim.id, part, undefined)).toEqual({ kind: 'went' })
  })

  it("an event booking's card part is keyed by its claim and the order that paid for it", async () => {
    const orderId = id()
    const claim = await onEventBooking(id(), eventDetails(orderId, { card: 40 }))
    const part = claim.details.plan.card[0] as CardPart
    expect(cardPartRequest(claim.id, part).metadata).toEqual({ refund_key: `${claim.id}:refund:${orderId}`, claim_id: claim.id })
  })
})

describe('one card part at most, and only on the claim\'s own order', () => {
  const faults: Array<[string, (orderId: string) => OrderClaimDetails, RegExp]> = [
    ['two card parts', (o) => ({ ...orderDetails(o, { card: 10 }), amount: 20, plan: { card: [cardPart(o, 10), cardPart(o, 10)], storeCredit: 0, cash: 0, ownOrderId: o } }), /one card part at most, not 2/],
    ['a part on another order', (o) => ({ ...orderDetails(o, { card: 10 }), plan: { card: [cardPart(id(), 10)], storeCredit: 0, cash: 0, ownOrderId: o } }), /not the claim's own order/],
    ['a part with no PaymentIntent', (o) => ({ ...orderDetails(o, { card: 10 }), plan: { card: [cardPart(o, 10, '')], storeCredit: 0, cash: 0, ownOrderId: o } }), /names no PaymentIntent/],
    ['a part of £0', (o) => ({ ...orderDetails(o, { storeCredit: 10 }), plan: { card: [cardPart(o, 0)], storeCredit: 10, cash: 0, ownOrderId: o } }), /gives nothing/],
    ["a part whose lines don't add up", (o) => ({ ...orderDetails(o, { card: 10 }), plan: { card: [{ ...cardPart(o, 10), lines: [{ lineId: id(), amount: 9.99 }] }], storeCredit: 0, cash: 0, ownOrderId: o } }), /lines don't add up/],
    ['a plan that gives more than the claim', (o) => ({ ...orderDetails(o, { card: 10, storeCredit: 5 }), amount: 10 }), /the plan gives £15.00, the claim £10.00/],
    ['a plan that gives less than the claim', (o) => ({ ...orderDetails(o, { card: 10 }), amount: 12 }), /the plan gives £10.00, the claim £12.00/],
    ['cash beside a card part', (o) => ({ ...orderDetails(o, { card: 10 }), amount: 15, plan: { card: [cardPart(o, 10)], storeCredit: 0, cash: 5, ownOrderId: o } }), /cash is handed over on its own/],
    ['cash beside store credit', (o) => ({ ...orderDetails(o, { storeCredit: 10 }), amount: 15, plan: { card: [], storeCredit: 10, cash: 5, ownOrderId: o } }), /cash is handed over on its own/],
    ['a negative part', (o) => ({ ...orderDetails(o, { storeCredit: 10 }), amount: 10, plan: { card: [], storeCredit: -5, cash: 0, ownOrderId: o } }), /below £0/],
    ['a claim of nothing', (o) => ({ ...orderDetails(o, {}), amount: 0 }), /gives something/],
  ]

  it.each(faults)("an order's claim with %s is never written", async (_, make, words) => {
    const orderId = id()
    await expect(onOrder(orderId, make(orderId))).rejects.toThrow(words)
    expect(await claimRows()).toEqual([])
  })

  it.each(faults)("an event booking's claim with %s is never written", async (_, make, words) => {
    const orderId = id()
    await expect(onEventBooking(id(), { ...make(orderId), kind: 'cancel_places', orderId })).rejects.toThrow(words)
    expect(await claimRows()).toEqual([])
  })

  it("an event booking's claim must name its order", async () => {
    const orderId = id()
    await expect(onEventBooking(id(), eventDetails(orderId, { storeCredit: 10 }, { orderId: '' }))).rejects.toThrow(/must name the booking's order/)
    expect(await claimRows()).toEqual([])
  })

  it('exactly one part, or none, is written', async () => {
    const a = id()
    const b = id()
    expect((await onOrder(a, orderDetails(a, { card: 10, storeCredit: 2.5 }))).details.plan.card).toHaveLength(1)
    expect((await onOrder(b, orderDetails(b, { storeCredit: 12.5 }))).details.plan.card).toHaveLength(0)
  })
})

describe('an open claim holds its subject (`refund_open`)', () => {
  it("an order: a second claim is refused with step D's reason and the order's words, and nothing is written", async () => {
    const orderId = id()
    const first = await onOrder(orderId, orderDetails(orderId, { card: 10 }))
    expect(await openClaimHoldingOrder(db, orderId)).toBe(first.id)
    const refused = await refusal(() => onOrder(orderId, orderDetails(orderId, { storeCredit: 5 })))
    expect(refused).toMatchObject({ code: 'CONFLICT', status: 409, message: ORDER_REFUND_OPEN_MESSAGE, details: { reason: 'refund_open', message: ORDER_REFUND_OPEN_MESSAGE, action: 'refund' } })
    expect(await claimRows()).toHaveLength(1)
  })

  it('the words are step D\'s, with the subject named', () => {
    expect(REFUND_OPEN_MESSAGE).toBe("A refund on this booking is still being checked. Don't refund it again: check the Orders page in a few minutes.")
    expect(ORDER_REFUND_OPEN_MESSAGE).toBe(REFUND_OPEN_MESSAGE.replace('this booking', 'this order'))
    expect(EVENT_BOOKING_REFUND_OPEN_MESSAGE).toBe(REFUND_OPEN_MESSAGE.replace('this booking', 'this event booking'))
    expect(refundOpenRefusal('order').message).toBe(ORDER_REFUND_OPEN_MESSAGE)
    expect(refundOpenRefusal('event_booking').message).toBe(EVENT_BOOKING_REFUND_OPEN_MESSAGE)
  })

  it('every kind of claim holds it: store credit only, cash, a card part, Refund the rest', async () => {
    for (const details of [
      (o: string) => orderDetails(o, { storeCredit: 5 }),
      (o: string) => orderDetails(o, { cash: 5 }, { handedOverBy: STAFF }),
      (o: string) => orderDetails(o, { card: 5 }),
      (o: string) => orderDetails(o, { card: 5 }, { kind: 'refund_owed' }),
    ]) {
      const orderId = id()
      await onOrder(orderId, details(orderId))
      expect((await refusal(() => onOrder(orderId, orderDetails(orderId, { storeCredit: 1 })))).details).toMatchObject({ reason: 'refund_open' })
    }
  })

  it('once the claim is finished the order is free again; another order never was held', async () => {
    const orderId = id()
    const other = id()
    const first = await onOrder(orderId, orderDetails(orderId, { card: 10 }))
    expect(await stepEClaimFinished(db, first)).toBe(false)
    await expect(onOrder(other, orderDetails(other, { card: 10 }))).resolves.toBeDefined()
    await finish(ORDER_CLAIMS, orderId, first.id)
    expect(await stepEClaimFinished(db, first)).toBe(true)
    expect(await openClaimHoldingOrder(db, orderId)).toBeNull()
    await expect(db.transaction((tx) => refuseWhileRefundOpen(tx, 'order', orderId))).resolves.toBeUndefined()
    await expect(onOrder(orderId, orderDetails(orderId, { storeCredit: 5 }))).resolves.toBeDefined()
  })

  it("an event booking: a second claim on it is refused with the event booking's words", async () => {
    const orderId = id()
    const eventBookingId = id()
    await onEventBooking(eventBookingId, eventDetails(orderId, { card: 40 }))
    const refused = await refusal(() => onEventBooking(eventBookingId, eventDetails(orderId, { storeCredit: 40 })))
    expect(refused).toMatchObject({ code: 'CONFLICT', message: EVENT_BOOKING_REFUND_OPEN_MESSAGE, details: { reason: 'refund_open' } })
    expect(await claimRows()).toHaveLength(1)
  })

  it("an order and its event booking share one card payment, so an open claim on either holds both", async () => {
    const orderId = id()
    const eventBookingId = id()
    // The event booking's cancel is open: the order's other lines can't be refunded meanwhile.
    const event = await onEventBooking(eventBookingId, eventDetails(orderId, { card: 40 }))
    expect(await openClaimHoldingOrder(db, orderId)).toBe(event.id)
    expect((await refusal(() => onOrder(orderId, orderDetails(orderId, { card: 12 })))).message).toBe(ORDER_REFUND_OPEN_MESSAGE)
    await finish(EVENT_BOOKING_CLAIMS, eventBookingId, event.id)
    // The order's refund is open: its event booking can't be cancelled with money back meanwhile.
    const order = await onOrder(orderId, orderDetails(orderId, { card: 12 }))
    expect((await refusal(() => onEventBooking(eventBookingId, eventDetails(orderId, { card: 40 })))).message).toBe(EVENT_BOOKING_REFUND_OPEN_MESSAGE)
    await finish(ORDER_CLAIMS, orderId, order.id)
    await expect(onEventBooking(eventBookingId, eventDetails(orderId, { card: 40 }))).resolves.toBeDefined()
  })

  it("a booking's open claim (step D) with a card part on the order's payment holds the order; one with none doesn't; a finished one doesn't", async () => {
    const orderId = id()
    const bookingId = id()
    const bookingClaim = (card: CardPart[], storeCredit: number) =>
      db.transaction((tx) =>
        bookingRefunds.writeClaim(
          tx,
          bookingId,
          { kind: 'part_refund', amount: 10, pricePaidBefore: 40, method: card.length > 0 ? 'card' : 'credit', reason: 'Goodwill', worker: true, plan: { card, storeCredit, cash: 0, ownOrderId: orderId }, livemode: false },
          by()
        )
      )
    // Store credit only: the order's card money isn't in play.
    const creditOnly = await bookingClaim([], 10)
    expect(await openClaimHoldingOrder(db, orderId)).toBeNull()
    await finish({ finished: 'booking.refund_finished', entityType: 'booking' }, bookingId, creditOnly.id)
    // A card part on another order: not this order's payment.
    const elsewhere = await bookingClaim([cardPart(id(), 10)], 0)
    expect(await openClaimHoldingOrder(db, orderId)).toBeNull()
    await finish({ finished: 'booking.refund_finished', entityType: 'booking' }, bookingId, elsewhere.id)
    // A card part on this order: held, until the booking's claim is finished.
    const here = await bookingClaim([cardPart(id(), 5), cardPart(orderId, 5)], 0)
    expect(await openClaimHoldingOrder(db, orderId)).toBe(here.id)
    expect((await refusal(() => onOrder(orderId, orderDetails(orderId, { card: 12 })))).details).toMatchObject({ reason: 'refund_open' })
    await finish({ finished: 'booking.refund_finished', entityType: 'booking' }, bookingId, here.id)
    expect(await openClaimHoldingOrder(db, orderId)).toBeNull()
    await expect(onOrder(orderId, orderDetails(orderId, { card: 12 }))).resolves.toBeDefined()
  })

  it("an old screen's row with a claim's action isn't a claim (no `worker: true`), and holds nothing", async () => {
    const orderId = id()
    await db.query("INSERT INTO audit_log (actor_type, action, entity_type, entity_id, details) VALUES ('staff', 'order.refund_claimed', 'order', $1, $2::jsonb)", [orderId, JSON.stringify({ amount: 5 })])
    expect(await openClaimHoldingOrder(db, orderId)).toBeNull()
  })
})

describe("the refusal mark, the finish and the due lists, on step E's subjects", () => {
  it("a refused card part is marked on the claim's own subject, with the part, and read back", async () => {
    const orderId = id()
    const order = await onOrder(orderId, orderDetails(orderId, { card: 24 }))
    const eventOrder = id()
    const eventBookingId = id()
    const event = await onEventBooking(eventBookingId, eventDetails(eventOrder, { card: 40 }))
    expect(await stepEClaimRefusal(db, order)).toBeNull()
    await markStepEClaimRefused(db, order, 'Failed to refund payment: This charge is disputed.', 'press-1')
    await markStepEClaimRefused(db, event, 'Failed to refund payment: the refund failed', 'press-2')
    expect(await stepEClaimRefusal(db, order)).toBe('Failed to refund payment: This charge is disputed.')
    expect(await stepEClaimRefusal(db, event)).toBe('Failed to refund payment: the refund failed')
    const marks = await db.query<Record<string, unknown>>("SELECT action, entity_type, entity_id, details FROM audit_log WHERE action LIKE '%.refund_refused' ORDER BY at, id")
    expect(marks).toEqual([
      { action: 'order.refund_refused', entity_type: 'order', entity_id: orderId, details: { claimId: order.id, orderId, amount: 24, detail: 'Failed to refund payment: This charge is disputed.' } },
      { action: 'event_booking.refund_refused', entity_type: 'event_booking', entity_id: eventBookingId, details: { claimId: event.id, orderId: eventOrder, amount: 40, detail: 'Failed to refund payment: the refund failed' } },
    ])
  })

  it('a claim with no card part has nothing to mark', async () => {
    const orderId = id()
    const claim = await onOrder(orderId, orderDetails(orderId, { storeCredit: 5 }))
    await expect(markStepEClaimRefused(db, claim, 'why', 'r')).rejects.toThrow(/no card part/)
  })

  it("each due list holds its own subject's open claims past the window, and step D's due list (what reconcile reads today) holds neither", async () => {
    const orderId = id()
    const order = await onOrder(orderId, orderDetails(orderId, { card: 10 }))
    const event = await onEventBooking(id(), eventDetails(id(), { card: 10 }))
    await db.query("UPDATE audit_log SET at = now() - interval '20 minutes'")
    expect((await db.query<{ id: string }>(ORDER_CLAIMS_DUE_SQL, [15])).map((row) => row.id)).toEqual([order.id])
    expect((await db.query<{ id: string }>(EVENT_BOOKING_CLAIMS_DUE_SQL, [15])).map((row) => row.id)).toEqual([event.id])
    // W27 is dark: reconcile reads CLAIMS_DUE_SQL only, so it never picks up a step E claim before W28 teaches it to.
    expect(await db.query(bookingRefunds.CLAIMS_DUE_SQL, [15])).toEqual([])
  })
})
