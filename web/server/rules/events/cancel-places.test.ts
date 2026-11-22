import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { cancelEventPlacesOutputSchema, eventAttendeeBookingSchema, eventAttendeeRowSchema, eventCancelQuoteOutputSchema } from '@/contracts'
import { POST as quoteRoute } from '@/app/api/v1/staff/event-bookings/[eventBookingId]/cancel/quote/route'
import { POST as cancelRoute } from '@/app/api/v1/staff/event-bookings/[eventBookingId]/cancel/route'
import { GET as orderFiguresRoute } from '@/app/api/v1/staff/orders/[orderId]/refund-figures/route'
import { POST as orderOwedRoute } from '@/app/api/v1/staff/orders/[orderId]/refunds/owed/route'
import { POST as orderArrivedRoute } from '@/app/api/v1/staff/orders/[orderId]/refunds/owed-arrived/route'
import { POST as orderRefundRoute } from '@/app/api/v1/staff/orders/[orderId]/refunds/route'
import { POST as closeRoute } from '@/app/api/v1/staff/orders/stuck/close/route'
import type { Db, Tx } from '@/server/db'
import { reconcile } from '@/server/rules/orders/reconcile'
import { EVENT_CLAIM_WAITING_WORDS, stuckList, WATCH_WORDS } from '@/server/rules/orders/stuck-list'
import { MONEY_OWED_WORDS } from '@/server/rules/refunds/failure-messages'
import { moneyOwedList } from '@/server/rules/refunds/money-owed-list'
import { EVENT_BOOKING_REFUND_OPEN_MESSAGE, REFUND_PATH_OFF_MESSAGE } from '@/server/rules/refunds/failure-messages'
import { claimRefundKey } from '@/server/rules/refunds/pipeline'
import { BOOKING_KINDS_ON, withSwitch } from '@/server/rules/testing/sweep/booking-presses'
import { replay, REPLAY_USER, startReplay, type ReplayEnvironment, type ScenarioContext } from '@/server/rules/testing/sweep/run'
import { workerSide } from '@/server/rules/testing/sweep/worker'
import { ID, PROMO, seed } from '@/server/rules/testing/replay/scenarios'
import { replayStripe } from '@/server/rules/testing/replay/stripe-binding'
import { fakeStripeErrors, type FakeStripe } from '@/server/stripe/fake'
import { cancelEventPlaces, splitByUnitPrice, type EventCancelOptions } from './cancel-places'
import { EVENT_CANCEL_NEW_WORDS as NEW_WORDS, EVENT_CANCEL_WORDS as WORDS, EVENT_QUOTE_REFUSALS } from './failure-messages'
import { WATCH_DAYS } from '@/server/rules/refunds/refund-watch'

// Brief W30 (E-plan 5.1): event places on the Worker, on the replay's live schema (the database's own
// event_cancellation_quote, release_event_places and store credit function included), through the routes as the staff
// app calls them. The event orders are placed by the old createOrder (the frozen copy), as the golden scenarios place
// them. Stripe is only ever the fake.

vi.setConfig({ testTimeout: 120_000 })

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))
vi.mock('@/server/stripe/client', async (importOriginal) => {
  const { stripeClientMock } = await import('@/server/rules/testing/replay/stripe-binding')
  return stripeClientMock(await importOriginal<typeof import('@/server/stripe/client')>())
})

const KEY = 'test-staff-api-key'
/** ORDER_SWITCH as it will be live once Wayne adds `event_cancels`. */
const EVENT_KINDS_ON = `${BOOKING_KINDS_ON},order_refunds,event_cancels`

let environment: ReplayEnvironment
let db: Db
beforeAll(async () => {
  process.env.STAFF_API_KEY = KEY
  environment = await startReplay()
  db = environment.database.db
  holder.db = db
})
afterAll(() => environment.stop())

const samAttending = { name: 'Sam Test', email: 'sam@example.com', dateOfBirth: '1990-01-01', isAccountHolder: true }
const alexGuest = { name: 'Alex Guest', email: 'alex@example.com', isAccountHolder: false }
const beaGuest = { name: 'Bea Guest', email: 'bea@example.com', isAccountHolder: false }
const places = (attendees: Array<Record<string, unknown>>) => ({ eventId: ID.event, accountHolderAttending: true, guestsOver18Confirmed: true, attendees })
/** Sam and a guest at the public price: £80. */
const two = places([samAttending, alexGuest])
/** Sam and two guests: £120. */
const three = places([samAttending, alexGuest, beaGuest])
const soap = { productVariantId: ID.variant, quantity: 2, unitPrice: 12, systemUnitPrice: 12 }
const monthly = { membershipPlanId: ID.plan, membershipBillingFrequency: 'monthly', membershipIdempotencyKey: 'w30-membership-key' }
const card = { method: 'card' }
const cash = (amount: number) => ({ method: 'cash', confirmedCashAmount: amount })

type Context = ScenarioContext & { orderId: string; eventBookingId: string; placed: Record<string, unknown>; places(): Promise<string[]> }

/** An event order placed by the old createOrder, then `work` with it. */
async function onAnEventOrder(order: Record<string, unknown>, work: (context: Context) => Promise<void>, prepare?: (context: ScenarioContext) => Promise<void>): Promise<void> {
  await replay(
    environment,
    {
      name: 'w30 event places',
      seed,
      async run(context) {
        replayStripe.current = context.stripe
        await prepare?.(context)
        const placed = (await context.call('createOrder', { customerId: ID.customer, ...order })) as Record<string, unknown>
        if (placed['success'] !== true) throw new Error(`The order failed: ${JSON.stringify(placed)}`)
        const orderId = String(placed['orderId'])
        const eventBookingId = String(placed['eventBookingId'])
        const attendees = async () => (await context.db.query<{ id: string }>('SELECT id FROM event_attendees WHERE event_booking_id = $1::uuid ORDER BY created_at, id', [eventBookingId])).map((row) => row.id)
        try {
          await work({ ...context, orderId, eventBookingId, placed, places: attendees })
        } finally {
          replayStripe.current = null
        }
      },
    },
    workerSide()
  )
}

type Quote = { places: number; wholeBooking: boolean; value: number; refundCutoffAt: string | null; beforeCutoff: boolean; eventStarted: boolean; cardAmount: number; storeCreditAmount: number; cashAmount?: number; refundOwed?: number }
type Answer = {
  status: number
  body: {
    ok: boolean
    data?: Record<string, unknown> & { held?: { claimId: string; reason: string; message: string }; booking?: { status: string; places: number; refund_owed_amount?: string; order_id?: string | null; attendees: Array<Record<string, unknown>> } | null }
    error?: { code: string; message: string; details?: { reason?: string; message?: string; quote?: Quote; kinds?: string[] } }
  }
}
type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>

const headers = (email: string, key?: string) => ({ authorization: `Bearer ${KEY}`, 'x-staff-email': email, 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) })

async function quote(eventBookingId: string, attendeeIds?: string[]): Promise<Answer> {
  const response = await (quoteRoute as Handler)(
    new Request(`https://worker.test/api/v1/staff/event-bookings/${eventBookingId}/cancel/quote`, { method: 'POST', headers: headers(REPLAY_USER.email), body: JSON.stringify(attendeeIds ? { attendeeIds } : {}) }),
    { params: Promise.resolve({ eventBookingId }) }
  )
  return { status: response.status, body: (await response.json()) as Answer['body'] }
}

async function post(eventBookingId: string, body: unknown, { key = crypto.randomUUID(), orderSwitch = EVENT_KINDS_ON, email = REPLAY_USER.email } = {}): Promise<Answer> {
  return withSwitch(orderSwitch, async () => {
    const response = await (cancelRoute as Handler)(
      new Request(`https://worker.test/api/v1/staff/event-bookings/${eventBookingId}/cancel`, { method: 'POST', headers: headers(email, key), body: JSON.stringify(body) }),
      { params: Promise.resolve({ eventBookingId }) }
    )
    return { status: response.status, body: (await response.json()) as Answer['body'] }
  })
}

/** A cancel as the dialog presses it: the quote's value sent back as the confirmed refund (£0 for No refund). */
async function cancel(eventBookingId: string, refund: string, attendeeIds?: string[], { reason = undefined as string | undefined, confirmed = undefined as number | undefined, key = undefined as string | undefined, orderSwitch = undefined as string | undefined, email = undefined as string | undefined } = {}): Promise<Answer> {
  const shown = confirmed ?? (refund === 'none' ? 0 : (((await quote(eventBookingId, attendeeIds)).body.data as Quote | undefined)?.value ?? 0))
  return post(
    eventBookingId,
    { ...(attendeeIds ? { attendeeIds } : {}), refund, ...(reason !== undefined ? { reason } : {}), confirmed: { refund: shown } },
    { ...(key ? { key } : {}), ...(orderSwitch !== undefined ? { orderSwitch } : {}), ...(email ? { email } : {}) }
  )
}

async function orderPost(route: Handler, path: string, orderId: string, body: unknown): Promise<Answer> {
  return withSwitch(EVENT_KINDS_ON, async () => {
    const response = await route(new Request(`https://worker.test/api/v1/staff/orders/${orderId}/${path}`, { method: 'POST', headers: headers(REPLAY_USER.email, crypto.randomUUID()), body: JSON.stringify(body) }), {
      params: Promise.resolve({ orderId }),
    })
    return { status: response.status, body: (await response.json()) as Answer['body'] }
  })
}

async function close(claimId: string): Promise<Answer> {
  const response = await closeRoute(
    new Request('https://worker.test/api/v1/staff/orders/stuck/close', { method: 'POST', headers: headers(REPLAY_USER.email, crypto.randomUUID()), body: JSON.stringify({ kind: 'held_claim', orderId: claimId, reason: 'Checked in Stripe by hand' }) })
  )
  return { status: response.status, body: (await response.json()) as Answer['body'] }
}

const runReconcile = () => reconcile(db, replayStripe.current as FakeStripe, { actor: { type: 'system', id: null }, requestId: crypto.randomUUID(), maxItems: 50, budgetMs: 60_000 })
/** Past the window, so reconcile and the stuck list look at what is held. */
const pastTheWindow = () => vi.setSystemTime(Date.now() + 16 * 60_000)

const order = async (orderId: string) => (await db.query<{ payment_status: string; owed: string }>('SELECT payment_status, refund_owed_amount::text AS owed FROM orders WHERE id = $1', [orderId]))[0]
const lineRows = async (orderId: string) =>
  db.query<{ id: string; item_type: string; refunded: boolean; refund_method: string | null; card: string }>(
    'SELECT id, item_type, refunded_at IS NOT NULL AS refunded, refund_method, card_refunded_amount::numeric(10,2)::text AS card FROM order_line_items WHERE order_id = $1 ORDER BY created_at, id',
    [orderId]
  )
const eventLine = async (orderId: string) => (await lineRows(orderId)).find((line) => line.item_type === 'event')
const booking = async (eventBookingId: string) => (await db.query<{ status: string; places: number; cancelled: boolean; cancel_reason: string | null }>('SELECT status, places, cancelled_at IS NOT NULL AS cancelled, cancel_reason FROM event_bookings WHERE id = $1', [eventBookingId]))[0]
const placeRows = async (eventBookingId: string) =>
  db.query<{ id: string; cancelled: boolean; value: string; refunded: string; card: string; method: string | null; after: boolean; by: string | null; reason: string | null }>(
    `SELECT id, cancelled_at IS NOT NULL AS cancelled, cancelled_value::numeric(10,2)::text AS value, refunded_amount::numeric(10,2)::text AS refunded,
            card_refunded_amount::numeric(10,2)::text AS card, refund_method AS method, refund_after_cutoff AS after, cancelled_by AS by, cancel_reason AS reason
     FROM event_attendees WHERE event_booking_id = $1 ORDER BY created_at, id`,
    [eventBookingId]
  )
const placesBooked = async () => Number((await db.query<{ places_booked: number }>('SELECT places_booked FROM events WHERE id = $1', [ID.event]))[0]?.places_booked)
const creditRefunds = async () => db.query<{ amount: string; order_id: string | null; note: string }>("SELECT amount::text AS amount, order_id, note FROM store_credit_transactions WHERE reason = 'refund' ORDER BY created_at, id")
const auditRows = async (action: string) => db.query<{ id: string; entity_id: string; details: Record<string, unknown> }>('SELECT id, entity_id, details FROM audit_log WHERE action = $1 ORDER BY at, id', [action])
const refundsSent = (stripe: FakeStripe) => stripe.calls.filter((call) => call.method === 'refunds.create')
const moneyBack = (stripe: FakeStripe) => stripe.refundsSent.filter((sent) => sent.status !== 'failed' && sent.status !== 'canceled').reduce((total, sent) => total + sent.amount, 0)
const refusal = () => fakeStripeErrors.invalid('charge_disputed', 'This charge is disputed.')
const noIssueRefunds = () => db.query('UPDATE staff SET can_issue_refunds = false WHERE id = $1', [ID.staff])

describe('one place, several places, the whole booking', () => {
  it('one place to the card: cancelled and released in R1, one refund under the claim\'s key, then the place, the line and the order recorded', async () => {
    await onAnEventOrder({ event: two, payment: card }, async ({ orderId, eventBookingId, places: ids, stripe }) => {
      const [first] = await ids()
      expect((await quote(eventBookingId, [first as string])).body.data).toEqual({ places: 1, wholeBooking: false, value: 40, refundCutoffAt: expect.any(String), beforeCutoff: true, eventStarted: false, cardAmount: 40, storeCreditAmount: 0, cashAmount: 0, refundOwed: 0 })
      const answer = await cancel(eventBookingId, 'card', [first as string])
      expect(answer.status).toBe(200)
      expect(answer.body.data).toMatchObject({ places: 1, refundedAmount: 40, cardRefundedAmount: 40, storeCreditRefundedAmount: 0, eventPlacesBooked: 1 })
      expect(answer.body.data?.booking).toMatchObject({ status: 'confirmed', places: 1, order_id: orderId, refund_owed_amount: '0.00' })
      const claim = (await auditRows('event_booking.refund_claimed'))[0]
      expect(claim?.entity_id).toBe(eventBookingId)
      expect(claim?.details).toMatchObject({ kind: 'cancel_places', orderId, amount: 40, method: 'card', worker: true, livemode: false, plan: { storeCredit: 0, cash: 0, ownOrderId: orderId } })
      expect(refundsSent(stripe).map((call) => [call.idempotencyKey, (call.params as { amount: number; metadata: Record<string, string> }).amount, (call.params as { metadata: Record<string, string> }).metadata['claim_id']])).toEqual([[claimRefundKey(claim?.id as string, orderId), 4000, claim?.id]])
      expect(await placeRows(eventBookingId)).toEqual([
        { id: first, cancelled: true, value: '40.00', refunded: '40.00', card: '40.00', method: 'card', after: false, by: ID.staff, reason: null },
        expect.objectContaining({ cancelled: false, value: '0.00', method: null }),
      ])
      expect(await booking(eventBookingId)).toMatchObject({ status: 'confirmed', places: 1 })
      expect(await placesBooked()).toBe(1)
      expect(await eventLine(orderId)).toMatchObject({ refunded: false, card: '40.00' })
      expect(await order(orderId)).toEqual({ payment_status: 'partially_refunded', owed: '0.00' })
      // W32: the finished row keeps the card refund's id and status (it succeeded, so nothing is watched).
      expect((await auditRows('event_booking.refund_finished'))[0]?.details).toEqual({
        claimId: claim?.id,
        outcome: 'given',
        cardRefunded: 40,
        storeCreditRefunded: 0,
        owed: 0,
        refunds: [{ orderId, paymentIntentId: stripe.refundsSent[0]?.payment_intent, refundId: stripe.refundsSent[0]?.id, status: 'succeeded', amount: 40 }],
      })
      // W32a (lead call 1): the refund is watched, though it succeeded at once.
      expect((await auditRows('refund.watch')).map((row) => row.details)).toMatchObject([{ state: 'watching', refundId: stripe.refundsSent[0]?.id, status: 'succeeded', on: 'event_booking', orderId, amount: 40 }])
      expect((await auditRows('event_booking.cancel_places'))[0]?.details).toMatchObject({ attendeeIds: [first], places: 1, value: 40, bookingCancelled: false, refund: 'card', amount: 40, cardRefunded: 40, storeCreditRefunded: 0, owed: 0 })
    })
  })

  it('a promo\'d line: £115 over three places, the last place takes exactly what is left (£38.34, £38.34, £38.32), and the last one cancels the booking and stamps the line', async () => {
    await onAnEventOrder({ event: three, promoCode: PROMO.fixed, payment: card }, async ({ orderId, eventBookingId, places: ids, stripe }) => {
      const [first, second, third] = await ids()
      expect((await cancel(eventBookingId, 'card', [first as string])).body.data).toMatchObject({ refundedAmount: 38.34, cardRefundedAmount: 38.34 })
      expect((await cancel(eventBookingId, 'card', [second as string])).body.data).toMatchObject({ refundedAmount: 38.34 })
      expect(await eventLine(orderId)).toMatchObject({ refunded: false })
      const last = await cancel(eventBookingId, 'card', [third as string])
      expect(last.body.data).toMatchObject({ refundedAmount: 38.32, eventPlacesBooked: 0 })
      // Every penny of the £115 the line cost after its promo, and no more.
      expect(moneyBack(stripe)).toBe(11500)
      expect((await placeRows(eventBookingId)).map((place) => place.refunded)).toEqual(['38.34', '38.34', '38.32'])
      expect(await booking(eventBookingId)).toMatchObject({ status: 'cancelled', places: 0, cancelled: true })
      expect(await eventLine(orderId)).toMatchObject({ refunded: true, refund_method: 'card', card: '115.00' })
      expect(await order(orderId)).toEqual({ payment_status: 'refunded', owed: '0.00' })
    })
  })

  it('two places of three at once share by unit price with the remainder on the last, and the whole booking to store credit is one transaction with no claim left open', async () => {
    await onAnEventOrder({ event: three, promoCode: PROMO.fixed, payment: card }, async ({ orderId, eventBookingId, places: ids, stripe }) => {
      const [first, second] = await ids()
      // The customer starts with £30 of store credit.
      expect((await cancel(eventBookingId, 'credit', [first as string, second as string])).body.data).toMatchObject({ places: 2, refundedAmount: 76.68, cardRefundedAmount: 0, storeCreditRefundedAmount: 76.68, storeCreditBalance: 106.68 })
      expect((await placeRows(eventBookingId)).slice(0, 2).map((place) => [place.value, place.refunded, place.card, place.method])).toEqual([
        ['38.34', '38.34', '0.00', 'credit'],
        ['38.34', '38.34', '0.00', 'credit'],
      ])
      expect((await cancel(eventBookingId, 'credit')).body.data).toMatchObject({ places: 1, refundedAmount: 38.32, storeCreditBalance: 145 })
      expect(refundsSent(stripe)).toHaveLength(0)
      // Compared in amount order: two rows written back to back can share a millisecond on the tests' database.
      const given = (await creditRefunds()).map((row) => [row.amount, row.order_id, row.note.replace(/ \[ref .*\]$/, '')]).sort((a, b) => Number(a[0]) - Number(b[0]))
      expect(given).toEqual([
        ['38.32', orderId, 'Event refund: Full Moon Sauna.'],
        ['76.68', orderId, 'Event refund: Full Moon Sauna.'],
      ])
      expect((await auditRows('event_booking.refund_claimed')).length).toBe(2)
      expect((await auditRows('event_booking.refund_finished')).length).toBe(2)
      expect(await eventLine(orderId)).toMatchObject({ refunded: true, refund_method: 'credit', card: '0.00' })
    })
  })

  it('a split: £80 of places with £50 on the card gives £50 to the card and £30 to store credit, and the quote says so first', async () => {
    await onAnEventOrder({ event: two, payment: { method: 'card', storeCredit: { amount: 30 } } }, async ({ orderId, eventBookingId, stripe }) => {
      expect((await quote(eventBookingId)).body.data).toMatchObject({ value: 80, cardAmount: 50, storeCreditAmount: 30 })
      expect((await cancel(eventBookingId, 'card')).body.data).toMatchObject({ refundedAmount: 80, cardRefundedAmount: 50, storeCreditRefundedAmount: 30, storeCreditBalance: 30 })
      expect(moneyBack(stripe)).toBe(5000)
      expect((await creditRefunds())[0]?.note.startsWith('Event refund: Full Moon Sauna (the rest went back to the card). [ref ')).toBe(true)
      expect((await placeRows(eventBookingId)).map((place) => [place.refunded, place.card, place.method])).toEqual([
        ['40.00', '25.00', 'card'],
        ['40.00', '25.00', 'card'],
      ])
      expect(await eventLine(orderId)).toMatchObject({ refunded: true, refund_method: 'card', card: '50.00' })
    })
  })

  it('No refund: no claim, no money, the place stamped with what it was worth and `none`; a later No refund of the last place stamps the line when an earlier place was refunded', async () => {
    await onAnEventOrder({ event: two, payment: card }, async ({ orderId, eventBookingId, places: ids, stripe }) => {
      const [first, second] = await ids()
      expect((await cancel(eventBookingId, 'credit', [first as string])).body.data).toMatchObject({ refundedAmount: 40 })
      const none = await cancel(eventBookingId, 'none', [second as string], { reason: 'Could not make it' })
      expect(none.body.data).toMatchObject({ places: 1, refundedAmount: 0, cardRefundedAmount: 0, storeCreditRefundedAmount: 0, eventPlacesBooked: 0 })
      expect((await placeRows(eventBookingId))[1]).toMatchObject({ cancelled: true, value: '40.00', refunded: '0.00', method: 'none', reason: 'Could not make it' })
      expect((await auditRows('event_booking.refund_claimed')).length).toBe(1)
      expect(refundsSent(stripe)).toHaveLength(0)
      expect(await booking(eventBookingId)).toMatchObject({ status: 'cancelled', places: 0, cancel_reason: 'Could not make it' })
      // The booking is fully cancelled and money went back on it for the first place: the line is stamped, as before.
      expect(await eventLine(orderId)).toMatchObject({ refunded: true, refund_method: 'credit' })
      // Found by what it says: two rows written back to back can share a millisecond on the tests' database.
      expect((await auditRows('event_booking.cancel_places')).map((row) => row.details).find((details) => details['refund'] === 'none')).toMatchObject({ amount: 0, value: 40, bookingCancelled: true })
    })
  })

  it('splitByUnitPrice is the old split: in proportion, the remainder on the last, equal shares when every price is £0', () => {
    expect(splitByUnitPrice(115, [40, 40, 40])).toEqual([38.33, 38.33, 38.34])
    expect(splitByUnitPrice(60, [20, 40])).toEqual([20, 40])
    expect(splitByUnitPrice(10, [0, 0, 0])).toEqual([3.33, 3.33, 3.34])
    expect(splitByUnitPrice(0, [40, 40])).toEqual([0, 0])
    expect(splitByUnitPrice(40, [])).toEqual([])
  })
})

describe('the contract', () => {
  // The staff app's types are generated from the contract, and the route sends its answer as the rule gave it. So the
  // contract must declare every field the routes answer: an answer is held to it with no undeclared field allowed, at
  // the top, on the booking and on each place.
  const strictAnswer = cancelEventPlacesOutputSchema.extend({ booking: eventAttendeeBookingSchema.extend({ attendees: z.array(eventAttendeeRowSchema.strict()) }).strict().nullable() }).strict()
  const strictQuote = eventCancelQuoteOutputSchema.strict()

  it('declares every field the quote and the cancel answer: to the card, in cash with store credit, with no refund, and held', async () => {
    await onAnEventOrder({ event: two, payment: card }, async ({ eventBookingId, places: ids, stripe }) => {
      const [first, second] = await ids()
      expect(strictQuote.safeParse((await quote(eventBookingId)).body.data).error).toBeUndefined()
      const toCard = await cancel(eventBookingId, 'card', [first as string])
      expect(strictAnswer.safeParse(toCard.body.data).error).toBeUndefined()
      // The booking's order and the money owed on it are fields of the contract (the attendee list reads them).
      expect(Object.keys(eventAttendeeBookingSchema.shape)).toEqual(expect.arrayContaining(['order_id', 'refund_owed_amount']))
      stripe.failNext('refunds.create', { kind: 'lost_response' })
      stripe.failNext('refunds.create', { kind: 'lost_response' })
      const held = await cancel(eventBookingId, 'card', [second as string])
      expect(held.body.data?.held).toBeDefined()
      expect(strictAnswer.safeParse(held.body.data).error).toBeUndefined()
    })
    await onAnEventOrder({ event: two, payment: { ...cash(40), giftCard: { giftCardId: ID.giftCard, amount: 40 } } }, async ({ eventBookingId, places: ids }) => {
      const [first, second] = await ids()
      expect(strictQuote.safeParse((await quote(eventBookingId, [first as string])).body.data).error).toBeUndefined()
      expect(strictAnswer.safeParse((await cancel(eventBookingId, 'none', [first as string])).body.data).error).toBeUndefined()
      const inCash = await cancel(eventBookingId, 'cash', [second as string])
      expect(inCash.body.data).toMatchObject({ cashRefundedAmount: 40 })
      expect(strictAnswer.safeParse(inCash.body.data).error).toBeUndefined()
    })
  })
})

describe('every refusal: nothing is cancelled and nothing is sent', () => {
  it('the old refusals, in the old words: no place, an unknown refund choice, an unknown booking, a cancelled booking, a place of another booking, a place already cancelled, a place checked in', async () => {
    await onAnEventOrder({ event: two, payment: card }, async ({ eventBookingId, places: ids, call, stripe }) => {
      const [first, second] = await ids()
      const reasons = async (answer: Promise<Answer>) => {
        const got = await answer
        return [got.status, got.body.error?.details?.reason, got.body.error?.details?.message]
      }
      expect(await reasons(post(eventBookingId, { attendeeIds: [], refund: 'card', confirmed: { refund: 0 } }))).toEqual([400, 'invalid_params', WORDS.choosePlace])
      expect(await reasons(post(eventBookingId, { attendeeIds: [first], refund: 'voucher', confirmed: { refund: 0 } }))).toEqual([400, 'invalid_params', WORDS.chooseRefund])
      expect(await reasons(post('10000000-0000-4000-8000-0000000000e7', { refund: 'none', confirmed: { refund: 0 } }))).toEqual([404, 'booking_not_found', EVENT_QUOTE_REFUSALS['booking_not_found']?.message])
      const other = (await call('createOrder', { customerId: ID.member, event: places([{ name: 'Mo Member', email: 'mo@example.com', dateOfBirth: '1985-05-05', isAccountHolder: true }]), payment: cash(20) })) as { eventBookingId: string }
      const theirs = (await db.query<{ id: string }>('SELECT id FROM event_attendees WHERE event_booking_id = $1', [other.eventBookingId]))[0]?.id as string
      expect(await reasons(post(eventBookingId, { attendeeIds: [theirs], refund: 'none', confirmed: { refund: 0 } }))).toEqual([404, 'attendee_not_found', EVENT_QUOTE_REFUSALS['attendee_not_found']?.message])
      expect(await reasons(post(eventBookingId, { attendeeIds: ['not-an-id'], refund: 'none', confirmed: { refund: 0 } }))).toEqual([404, 'attendee_not_found', EVENT_QUOTE_REFUSALS['attendee_not_found']?.message])
      await db.query('UPDATE event_attendees SET checked_in_at = now() WHERE id = $1', [first])
      expect(await reasons(post(eventBookingId, { attendeeIds: [first], refund: 'card', confirmed: { refund: 40 } }))).toEqual([409, 'attendee_checked_in', EVENT_QUOTE_REFUSALS['attendee_checked_in']?.message])
      expect(await reasons(post(eventBookingId, { refund: 'card', confirmed: { refund: 80 } }))).toEqual([409, 'attendee_checked_in', EVENT_QUOTE_REFUSALS['attendee_checked_in']?.message])
      await db.query('UPDATE event_attendees SET checked_in_at = NULL WHERE id = $1', [first])
      expect((await cancel(eventBookingId, 'none', [second as string])).status).toBe(200)
      expect(await reasons(post(eventBookingId, { attendeeIds: [second], refund: 'none', confirmed: { refund: 0 } }))).toEqual([409, 'already_cancelled', EVENT_QUOTE_REFUSALS['already_cancelled']?.message])
      expect((await cancel(eventBookingId, 'none')).status).toBe(200)
      expect(await reasons(post(eventBookingId, { refund: 'none', confirmed: { refund: 0 } }))).toEqual([409, 'booking_not_confirmed', EVENT_QUOTE_REFUSALS['booking_not_confirmed']?.message])
      expect(await reasons(quote(eventBookingId))).toEqual([409, 'booking_not_confirmed', EVENT_QUOTE_REFUSALS['booking_not_confirmed']?.message])
      expect(refundsSent(stripe)).toHaveLength(0)
      expect(await auditRows('event_booking.refund_claimed')).toHaveLength(0)
    })
  })

  it('a booking whose reader payment is still open is refused (`booking_pending`), and so is every place stamped cancelled on a confirmed booking (`nothing_to_cancel`)', async () => {
    await replay(
      environment,
      {
        name: 'w30 pending event booking',
        seed,
        async run(context) {
          replayStripe.current = context.stripe
          try {
            await context.call('createOrder', { customerId: ID.customer, event: two, payment: { method: 'reader' } })
            const pending = (await context.db.query<{ id: string }>("SELECT id FROM event_bookings WHERE status = 'pending'"))[0]?.id as string
            expect((await quote(pending)).body.error?.details).toMatchObject({ reason: 'booking_pending', message: WORDS.bookingPending })
            expect((await post(pending, { refund: 'none', confirmed: { refund: 0 } })).body.error?.details).toMatchObject({ reason: 'booking_pending', message: WORDS.bookingPending })
          } finally {
            replayStripe.current = null
          }
        },
      },
      workerSide()
    )
    await onAnEventOrder({ event: two, payment: card }, async ({ eventBookingId }) => {
      await db.query('UPDATE event_attendees SET cancelled_at = now() WHERE event_booking_id = $1', [eventBookingId])
      expect((await post(eventBookingId, { refund: 'none', confirmed: { refund: 0 } })).body.error?.details).toMatchObject({ reason: 'nothing_to_cancel', message: EVENT_QUOTE_REFUSALS['nothing_to_cancel']?.message })
    })
  })

  it('Q18 and bug E9: with no confirmed refund nothing is cancelled; a figure that changed since the quote is refused with the quote as it now stands; the new figure then goes', async () => {
    await onAnEventOrder({ event: three, promoCode: PROMO.fixed, payment: card }, async ({ eventBookingId, places: ids, stripe }) => {
      const [first] = await ids()
      const bare = await post(eventBookingId, { refund: 'card' })
      expect(bare.status).toBe(400)
      expect(bare.body.error?.details).toMatchObject({ reason: 'amount_not_confirmed', message: NEW_WORDS.amountNotConfirmed, quote: { value: 115, places: 3 } })
      // The dialog shows the whole booking's £115; another tab cancels a place; the press is refused, not £76.67 given.
      expect((await cancel(eventBookingId, 'card', [first as string])).body.data).toMatchObject({ refundedAmount: 38.34 })
      const stale = await cancel(eventBookingId, 'card', undefined, { confirmed: 115 })
      expect(stale.status).toBe(409)
      expect(stale.body.error?.details).toMatchObject({ reason: 'figures_changed', message: NEW_WORDS.figuresChanged, quote: { value: 76.66, places: 2, wholeBooking: true, cardAmount: 76.66 } })
      // No refund confirms £0: a figure sent with it is refused too.
      expect((await cancel(eventBookingId, 'none', undefined, { confirmed: 76.66 })).body.error?.details?.reason).toBe('figures_changed')
      // A penny out is refused; half a penny either way passes.
      expect((await cancel(eventBookingId, 'card', undefined, { confirmed: 76.67 })).body.error?.details?.reason).toBe('figures_changed')
      expect((await placeRows(eventBookingId)).filter((place) => place.cancelled)).toHaveLength(1)
      expect(moneyBack(stripe)).toBe(3834)
      expect((await cancel(eventBookingId, 'card', undefined, { confirmed: 76.664 })).body.data).toMatchObject({ places: 2, refundedAmount: 76.66 })
      expect(moneyBack(stripe)).toBe(11500)
    })
  })

  it('who may: any money back needs Issue refunds; No refund is open to active staff; someone with no staff record (bug E12) or an inactive account is refused whatever they choose', async () => {
    await onAnEventOrder({ event: two, payment: cash(80) }, async ({ eventBookingId, places: ids }) => {
      const [first, second] = await ids()
      await noIssueRefunds()
      for (const refund of ['card', 'credit', 'cash']) {
        const refused = await cancel(eventBookingId, refund, [first as string], { confirmed: 40 })
        expect([refused.status, refused.body.error?.code, refused.body.error?.message], refund).toEqual([403, 'FORBIDDEN', 'Needs Issue refunds permission — this action moves money back to the customer.'])
      }
      expect((await placeRows(eventBookingId)).every((place) => !place.cancelled)).toBe(true)
      expect((await cancel(eventBookingId, 'none', [first as string])).body.data).toMatchObject({ places: 1, refundedAmount: 0 })
      // E12: the signed-in user's email matches no staff row. The old function cancelled the place with nobody's name on it.
      const nobody = await cancel(eventBookingId, 'none', [second as string], { email: 'someone-else@example.com' })
      expect([nobody.status, nobody.body.error?.code]).toEqual([401, 'UNAUTHORISED'])
      expect(nobody.body.error?.message).toBe("No staff record matches the logged-in user's email (someone-else@example.com). Ask an admin to add you as staff before performing this action.")
      await db.query('UPDATE staff SET active = false WHERE id = $1', [ID.staff])
      const inactive = await cancel(eventBookingId, 'none', [second as string])
      expect([inactive.status, inactive.body.error?.message]).toEqual([403, 'This staff account is inactive. Ask an admin to reactivate it.'])
      expect((await placeRows(eventBookingId))[1]).toMatchObject({ cancelled: false })
      expect((await placeRows(eventBookingId))[0]).toMatchObject({ cancelled: true, by: ID.staff })
    })
  })

  it('the switch: with `event_cancels` off a cancel with money back answers the switched-off words before anything is read; No refund needs no kind; the quote is never gated', async () => {
    await onAnEventOrder({ event: two, payment: card }, async ({ eventBookingId, places: ids, stripe }) => {
      const [first, second] = await ids()
      for (const refund of ['card', 'credit', 'cash']) {
        const off = await cancel(eventBookingId, refund, [first as string], { confirmed: 40, orderSwitch: `${BOOKING_KINDS_ON},order_refunds` })
        expect([off.status, off.body.error?.code, off.body.error?.message, off.body.error?.details?.kinds], refund).toEqual([501, 'REFUND_PATH_OFF', REFUND_PATH_OFF_MESSAGE, ['event_cancels']])
      }
      expect((await placeRows(eventBookingId)).every((place) => !place.cancelled)).toBe(true)
      expect(refundsSent(stripe)).toHaveLength(0)
      expect((await withSwitch('', () => quote(eventBookingId))).status).toBe(200)
      expect((await cancel(eventBookingId, 'none', [second as string], { orderSwitch: '' })).body.data).toMatchObject({ places: 1 })
    })
  })

  it('the same press twice (one key) cancels and refunds once and answers the same; a changed press under that key is refused', async () => {
    await onAnEventOrder({ event: two, payment: card }, async ({ eventBookingId, places: ids, stripe }) => {
      const [first, second] = await ids()
      const key = crypto.randomUUID()
      const once = await cancel(eventBookingId, 'card', [first as string], { key, confirmed: 40 })
      const again = await cancel(eventBookingId, 'card', [first as string], { key, confirmed: 40 })
      expect(again.body).toEqual(once.body)
      expect(refundsSent(stripe)).toHaveLength(1)
      const changed = await cancel(eventBookingId, 'card', [second as string], { key, confirmed: 40 })
      expect(changed.body.error?.code).toBe('IDEMPOTENCY_MISMATCH')
      expect((await placeRows(eventBookingId)).filter((place) => place.cancelled)).toHaveLength(1)
    })
  })

  it('two cancels of one place, one after the other: the second is refused `already_cancelled` and nothing more goes back', async () => {
    await onAnEventOrder({ event: two, payment: card }, async ({ eventBookingId, places: ids, stripe }) => {
      const [first] = await ids()
      expect((await cancel(eventBookingId, 'card', [first as string])).status).toBe(200)
      const second = await cancel(eventBookingId, 'card', [first as string], { confirmed: 40 })
      expect(second.body.error?.details?.reason).toBe('already_cancelled')
      expect(moneyBack(stripe)).toBe(4000)
      expect(await placesBooked()).toBe(1)
    })
  })
})

describe("the reason rule and Wayne's Q43 (an event with no cut-off uses its start)", () => {
  it('after the cut-off a refund needs a reason and is recorded as after the cut-off; No refund needs none', async () => {
    await onAnEventOrder(
      { event: two, payment: card },
      async ({ eventBookingId, places: ids }) => {
        const [first, second] = await ids()
        expect((await quote(eventBookingId, [first as string])).body.data).toMatchObject({ beforeCutoff: false, eventStarted: false })
        for (const reason of [undefined, '   ']) {
          const refused = await cancel(eventBookingId, 'card', [first as string], { ...(reason !== undefined ? { reason } : {}) })
          expect([refused.status, refused.body.error?.details?.reason, refused.body.error?.details?.message]).toEqual([400, 'reason_required_after_cutoff', WORDS.reasonRequiredAfterCutoff])
        }
        expect((await cancel(eventBookingId, 'card', [first as string], { reason: ' Train strike ' })).body.data).toMatchObject({ refundedAmount: 40 })
        expect((await cancel(eventBookingId, 'none', [second as string])).status).toBe(200)
        expect((await placeRows(eventBookingId)).map((place) => [place.after, place.reason, place.method])).toEqual([
          [true, 'Train strike', 'card'],
          [false, null, 'none'],
        ])
      },
      async ({ db: seeded }) => {
        await seeded.query("UPDATE events SET refund_cutoff_at = '2026-11-09 09:00:00+00' WHERE id = $1", [ID.event])
      }
    )
  })

  it('Q43 / bug E8: no cut-off, three weeks before the event: a refund needs no reason and is not an exception; once the event has started it needs one', async () => {
    await onAnEventOrder({ event: two, payment: card }, async ({ eventBookingId, places: ids }) => {
      const [first, second] = await ids()
      // An event on sale must have a cut-off (events_on_sale_complete), so it is taken off sale and its cut-off cleared.
      await db.query('UPDATE events SET active = false, refund_cutoff_at = NULL WHERE id = $1', [ID.event])
      expect((await quote(eventBookingId, [first as string])).body.data).toMatchObject({ refundCutoffAt: null, beforeCutoff: true, eventStarted: false })
      expect((await cancel(eventBookingId, 'card', [first as string])).body.data).toMatchObject({ refundedAmount: 40 })
      expect((await placeRows(eventBookingId))[0]).toMatchObject({ after: false, reason: null })
      // The clock moves three weeks on: the event has started.
      vi.setSystemTime(Date.now() + 22 * 24 * 60 * 60 * 1000)
      expect((await quote(eventBookingId, [second as string])).body.data).toMatchObject({ refundCutoffAt: null, beforeCutoff: false, eventStarted: true })
      expect((await cancel(eventBookingId, 'credit', [second as string])).body.error?.details?.reason).toBe('reason_required_after_cutoff')
      expect((await cancel(eventBookingId, 'credit', [second as string], { reason: 'No-show, goodwill' })).body.data).toMatchObject({ refundedAmount: 40 })
      expect((await placeRows(eventBookingId))[1]).toMatchObject({ after: true, reason: 'No-show, goodwill' })
    })
  })
})

describe("cash back (Wayne's Q42): only up to the cash paid on the booking's order", () => {
  it('a cash event booking: one place back in cash with who handed it over; the cap falls by it; a card order has no cash to hand back', async () => {
    await onAnEventOrder({ event: two, payment: cash(80) }, async ({ orderId, eventBookingId, places: ids, stripe }) => {
      const [first, second] = await ids()
      expect((await quote(eventBookingId, [first as string])).body.data).toMatchObject({ value: 40, cardAmount: 0, storeCreditAmount: 40, cashAmount: 40 })
      const handed = await cancel(eventBookingId, 'cash', [first as string])
      expect(handed.body.data).toMatchObject({ places: 1, refundedAmount: 40, cardRefundedAmount: 0, storeCreditRefundedAmount: 0, cashRefundedAmount: 40 })
      expect((await auditRows('event_booking.refund_claimed'))[0]?.details).toMatchObject({ method: 'cash', handedOverBy: ID.staff, plan: { card: [], storeCredit: 0, cash: 40 } })
      expect((await auditRows('event_booking.cancel_places'))[0]?.details).toMatchObject({ cashRefunded: 40, handedOverBy: ID.staff })
      expect((await placeRows(eventBookingId))[0]).toMatchObject({ refunded: '40.00', card: '0.00', method: 'cash' })
      expect(await creditRefunds()).toHaveLength(0)
      // The order's own cash figure sees the event booking's cash (W28 "For the Worker step" 2).
      const figures = await (orderFiguresRoute as Handler)(new Request(`https://worker.test/api/v1/staff/orders/${orderId}/refund-figures`, { headers: headers(REPLAY_USER.email) }), { params: Promise.resolve({ orderId }) })
      expect(((await figures.json()) as { data: { cashLeft: number } }).data.cashLeft).toBe(40)
      expect((await cancel(eventBookingId, 'cash', [second as string])).body.data).toMatchObject({ cashRefundedAmount: 40 })
      expect(await eventLine(orderId)).toMatchObject({ refunded: true, refund_method: 'cash' })
      expect(refundsSent(stripe)).toHaveLength(0)
    })
    await onAnEventOrder({ event: two, payment: card }, async ({ eventBookingId, places: ids }) => {
      const [first] = await ids()
      expect((await quote(eventBookingId, [first as string])).body.data).toMatchObject({ cashAmount: 0 })
      const none = await cancel(eventBookingId, 'cash', [first as string])
      expect([none.status, none.body.error?.details?.reason, none.body.error?.details?.message]).toEqual([409, 'no_cash_left', NEW_WORDS.noCashLeft])
      expect(none.body.error?.details?.quote).toMatchObject({ value: 40, cashAmount: 0 })
      expect((await placeRows(eventBookingId))[0]?.cancelled).toBe(false)
    })
  })

  it("Q42's example on an event: £80 of places paid £40 by gift card and £40 in cash gives £40 in cash and £40 to store credit in one cancel", async () => {
    await onAnEventOrder({ event: two, payment: { ...cash(40), giftCard: { giftCardId: ID.giftCard, amount: 40 } } }, async ({ orderId, eventBookingId }) => {
      expect((await quote(eventBookingId)).body.data).toMatchObject({ value: 80, cashAmount: 40 })
      // The customer starts with £30 of store credit.
      expect((await cancel(eventBookingId, 'cash')).body.data).toMatchObject({ refundedAmount: 80, cashRefundedAmount: 40, storeCreditRefundedAmount: 40, storeCreditBalance: 70 })
      expect((await creditRefunds()).map((row) => [row.amount, row.order_id, row.note.replace(/ \[ref .*\]$/, '')])).toEqual([['40.00', orderId, 'Event refund: Full Moon Sauna (the rest was handed back in cash).']])
      expect((await auditRows('event_booking.refund_finished'))[0]?.details).toMatchObject({ outcome: 'given', cardRefunded: 0, storeCreditRefunded: 40, owed: 0, cash: 40 })
      expect((await placeRows(eventBookingId)).map((place) => [place.refunded, place.method])).toEqual([
        ['40.00', 'cash'],
        ['40.00', 'cash'],
      ])
    })
  })
})

describe('an event bought on a saved card with a membership (W29 "For the Worker step" 1)', () => {
  it("the places go back to the order's own payment (the remainder charge), never the membership's first invoice", async () => {
    await onAnEventOrder({ event: two, ...monthly, payment: card }, async ({ orderId, eventBookingId, places: ids, stripe }) => {
      const paid = (await db.query<{ intent: string | null; own: string | null }>("SELECT stripe_payment_intent_id AS intent, reader_payment->'membership'->>'subscription_payment_intent_id' AS own FROM orders WHERE id = $1", [orderId]))[0]
      // Two card payments: the subscription's first invoice (the membership) and the order's own charge (the places).
      expect(stripe.calls.filter((call) => call.method === 'subscriptions.create')).toHaveLength(1)
      expect(stripe.calls.filter((call) => call.method === 'paymentIntents.create')).toHaveLength(1)
      expect(paid?.intent).toMatch(/^pi_/)
      const value = ((await quote(eventBookingId)).body.data as Quote).value
      expect(value).toBeGreaterThan(0)
      // The places can go back to the card in full: the membership's money is not on this payment.
      expect((await quote(eventBookingId)).body.data).toMatchObject({ cardAmount: value, storeCreditAmount: 0 })
      const [first] = await ids()
      const answer = await cancel(eventBookingId, 'card', [first as string])
      expect(answer.status).toBe(200)
      const sent = refundsSent(stripe)
      expect(sent).toHaveLength(1)
      // The order's PaymentIntent took the event places; the subscription's first invoice took only the membership.
      expect((sent[0]?.params as { payment_intent: string }).payment_intent).toBe(paid?.intent)
      if (paid?.own) expect((sent[0]?.params as { payment_intent: string }).payment_intent).not.toBe(paid.own)
      expect(answer.body.data?.['cardRefundedAmount']).toBe(answer.body.data?.['refundedAmount'])
      expect((await lineRows(orderId)).find((line) => line.item_type === 'membership')).toMatchObject({ refunded: false, card: '0.00' })
      expect(Number((await eventLine(orderId))?.card)).toBe(answer.body.data?.['cardRefundedAmount'])
    })
  })
})

describe('a card refund Stripe refuses', () => {
  it('refused then undone: marked on the claim, the places booked again exactly as they were, the old words, no store credit; the same cancel then goes through', async () => {
    await onAnEventOrder({ event: two, payment: card }, async ({ orderId, eventBookingId, stripe }) => {
      const before = await placeRows(eventBookingId)
      stripe.failNext('refunds.create', { kind: 'error', error: refusal() })
      const refused = await cancel(eventBookingId, 'card')
      expect(refused.status).toBe(402)
      expect(refused.body.error?.details).toMatchObject({ reason: 'refund_failed', message: 'The card refund failed, so nothing was cancelled: Failed to refund payment: This charge is disputed.' })
      expect(await placeRows(eventBookingId)).toEqual(before)
      expect(await booking(eventBookingId)).toEqual({ status: 'confirmed', places: 2, cancelled: false, cancel_reason: null })
      expect(await placesBooked()).toBe(2)
      expect(await eventLine(orderId)).toMatchObject({ refunded: false, card: '0.00' })
      expect(await order(orderId)).toEqual({ payment_status: 'paid', owed: '0.00' })
      expect(await creditRefunds()).toHaveLength(0)
      expect((await auditRows('event_booking.refund_refused'))[0]?.details).toMatchObject({ orderId, amount: 80, detail: 'Failed to refund payment: This charge is disputed.' })
      expect((await auditRows('event_booking.refund_finished'))[0]?.details).toMatchObject({ outcome: 'put_back', cardRefunded: 0, storeCreditRefunded: 0, owed: 0 })
      expect(await auditRows('event_booking.cancel_places')).toHaveLength(0)
      // Nothing holds the booking afterwards: the same cancel, pressed again, is a new claim and goes.
      expect((await cancel(eventBookingId, 'card')).body.data).toMatchObject({ refundedAmount: 80, cardRefundedAmount: 80 })
      expect(moneyBack(stripe)).toBe(8000)
    })
  })

  it('refused with the places resold: the cancel stands, the £40 is owed on the order (Q39) with Stripe\'s reason, never store credit; the attendee list shows it; Refund the rest then records the card money on the event line, not the order\'s oldest line (W28 review L2)', async () => {
    await onAnEventOrder({ products: [soap], event: two, payment: card }, async ({ orderId, eventBookingId, places: ids, stripe }) => {
      const [first] = await ids()
      // The event has room for exactly the booking's two places: the one released is sold again before Stripe answers.
      await db.query('UPDATE events SET capacity = 2 WHERE id = $1', [ID.event])
      stripe.failNext('refunds.create', { kind: 'error', error: refusal() })
      let count = 0
      const resold = new Proxy(db, {
        get(target, property, receiver) {
          if (property !== 'transaction') return Reflect.get(target, property, receiver) as unknown
          return async <T>(work: (tx: Tx) => Promise<T>): Promise<T> => {
            count += 1
            const result = await target.transaction(work)
            // Straight after R1 commits: someone else books the place it released.
            if (count === 1) await target.query('UPDATE events SET places_booked = places_booked + 1 WHERE id = $1', [ID.event])
            return result
          }
        },
      })
      const options: EventCancelOptions = { actor: { type: 'staff', id: ID.staff }, requestId: crypto.randomUUID(), canIssueRefunds: true, stripe: () => stripe }
      const stands = await cancelEventPlaces(resold, eventBookingId, { attendeeIds: [first as string], refund: 'card', confirmed: { refund: 40 } }, options)
      expect(stands).toMatchObject({ places: 1, refundedAmount: 0, cardRefundedAmount: 0, storeCreditRefundedAmount: 0, refundOwed: 40 })
      expect(stands.held).toMatchObject({ reason: 'refund_refused_not_put_back', message: NEW_WORDS.putBackBlocked('Failed to refund payment: This charge is disputed.', 40) })
      expect(stands.held?.message).toContain('Use Refund the rest to give it another way.')
      expect(stands.booking).toMatchObject({ places: 1, order_id: orderId, refund_owed_amount: '40.00' })
      expect((await placeRows(eventBookingId))[0]).toMatchObject({ cancelled: true, value: '40.00', refunded: '0.00', card: '0.00', method: 'card' })
      expect(await order(orderId)).toMatchObject({ owed: '40.00' })
      expect(await creditRefunds()).toHaveLength(0)
      expect(moneyBack(stripe)).toBe(0)
      expect((await auditRows('event_booking.refund_finished'))[0]?.details).toMatchObject({ outcome: 'owed', owed: 40, cardRefunded: 0, refused: 'Failed to refund payment: This charge is disputed.', by: { how: 'undo_blocked' } })
      expect((await quote(eventBookingId)).body.data).toMatchObject({ refundOwed: 40 })
      // Refund the rest, to the card. The soap line is made the order's oldest: before W30 the money went on it,
      // refunded or not. It goes on the event line.
      await db.query("UPDATE order_line_items SET created_at = created_at - interval '1 minute' WHERE order_id = $1 AND item_type = 'product'", [orderId])
      expect((await lineRows(orderId))[0]?.item_type).toBe('product')
      const rest = await orderPost(orderOwedRoute as Handler, 'refunds/owed', orderId, { amount: 40, refundMethod: 'card' })
      expect(rest.body.data).toMatchObject({ cardRefundedAmount: 40, storeCreditRefundedAmount: 0, refundOwed: 0 })
      expect((await lineRows(orderId)).map((line) => [line.item_type, line.card])).toEqual([
        ['product', '0.00'],
        ['event', '40.00'],
      ])
      expect(moneyBack(stripe)).toBe(4000)
      // The soap's own figure is whole, and it refunds in full to the card.
      const soapLine = (await lineRows(orderId)).find((line) => line.item_type === 'product')?.id as string
      const soapBack = await orderPost(orderRefundRoute as Handler, 'refunds', orderId, { lineItemIds: [soapLine], refundMethod: 'card', restock: { [soapLine]: false }, confirmed: { amount: 24 } })
      expect(soapBack.body.data).toMatchObject({ cardRefundedAmount: 24 })
    })
  })

  /** `db`, with `sold` places of the event booked by someone else straight after the first transaction (R1) commits. */
  const resoldAfterR1 = (sold: number): Db => {
    let count = 0
    return new Proxy(db, {
      get(target, property, receiver) {
        if (property !== 'transaction') return Reflect.get(target, property, receiver) as unknown
        return async <T>(work: (tx: Tx) => Promise<T>): Promise<T> => {
          count += 1
          const result = await target.transaction(work)
          if (count === 1) await target.query('UPDATE events SET places_booked = places_booked + $1::int WHERE id = $2', [sold, ID.event])
          return result
        }
      },
    })
  }

  it("W30a (review S1), the split case: refused with the places resold on a plan with store credit: the £30 of store credit is given once and named in the warning, the £50 is owed, and the words never say nothing went back", async () => {
    await onAnEventOrder({ event: two, payment: { method: 'card', storeCredit: { amount: 30 } } }, async ({ orderId, eventBookingId, stripe }) => {
      // Room for exactly the booking's two places: one is sold again before Stripe answers, so the two can't go back.
      await db.query('UPDATE events SET capacity = 2 WHERE id = $1', [ID.event])
      stripe.failNext('refunds.create', { kind: 'error', error: refusal() })
      const options: EventCancelOptions = { actor: { type: 'staff', id: ID.staff }, requestId: crypto.randomUUID(), canIssueRefunds: true, stripe: () => stripe }
      const stands = await cancelEventPlaces(resoldAfterR1(1), eventBookingId, { refund: 'card', confirmed: { refund: 80 } }, options)
      // The answer: both places cancelled, the store credit part given, the card part owed.
      expect(stands).toMatchObject({ places: 2, refundedAmount: 30, cardRefundedAmount: 0, storeCreditRefundedAmount: 30, refundOwed: 50 })
      // The warning, word for word.
      expect(stands.held?.reason).toBe('refund_refused_not_put_back')
      expect(stands.held?.message).toBe(
        "The card refund was refused (Failed to refund payment: This charge is disputed.), so it didn't go back to the card (£30.00 went to store credit as planned), and the places can't be put back: they have been booked by someone else since. The cancellation stands, and £50.00 shows on this booking as still to refund. Use Refund the rest to give it another way."
      )
      expect(stands.held?.message).toBe(NEW_WORDS.putBackBlocked('Failed to refund payment: This charge is disputed.', 50, 30))
      expect(stands.held?.message).not.toContain('nothing went back')
      // The store credit row: one, £30, on the order, and it doesn't say the rest went back to the card.
      expect((await creditRefunds()).map((row) => [row.amount, row.order_id, row.note.replace(/ \[ref .*\]$/, '')])).toEqual([['30.00', orderId, 'Event refund: Full Moon Sauna.']])
      expect(await order(orderId)).toMatchObject({ owed: '50.00' })
      expect(moneyBack(stripe)).toBe(0)
      expect(await booking(eventBookingId)).toMatchObject({ status: 'cancelled', places: 0 })
      expect((await auditRows('event_booking.refund_finished'))[0]?.details).toMatchObject({ outcome: 'owed', cardRefunded: 0, storeCreditRefunded: 30, owed: 50, by: { how: 'undo_blocked' } })
    })
  })

  it("W30a (review S2): the soap refunded to the card first, then a refused place cancel with the place resold, then Refund the rest to the card: the £40 goes on the event line, and the soap line still reads £24", async () => {
    await onAnEventOrder({ products: [soap], event: two, payment: card }, async ({ orderId, eventBookingId, places: ids, stripe }) => {
      const [first] = await ids()
      // The soap is the order's oldest line and is refunded to the card in full: stamped `card`, £24 back, short £0.
      await db.query("UPDATE order_line_items SET created_at = created_at - interval '1 minute' WHERE order_id = $1 AND item_type = 'product'", [orderId])
      const soapLine = (await lineRows(orderId)).find((line) => line.item_type === 'product')?.id as string
      const soapBack = await orderPost(orderRefundRoute as Handler, 'refunds', orderId, { lineItemIds: [soapLine], refundMethod: 'card', restock: { [soapLine]: false }, confirmed: { amount: 24 } })
      expect(soapBack.body.data).toMatchObject({ cardRefundedAmount: 24 })
      expect((await lineRows(orderId)).map((line) => [line.item_type, line.refunded, line.refund_method, line.card])).toEqual([
        ['product', true, 'card', '24.00'],
        ['event', false, null, '0.00'],
      ])
      // Place 1 to the card: refused, and the place sold again, so the cancel stands with £40 owed. The booking keeps
      // a place, so the event line isn't stamped.
      await db.query('UPDATE events SET capacity = 2 WHERE id = $1', [ID.event])
      stripe.failNext('refunds.create', { kind: 'error', error: refusal() })
      const options: EventCancelOptions = { actor: { type: 'staff', id: ID.staff }, requestId: crypto.randomUUID(), canIssueRefunds: true, stripe: () => stripe }
      const stands = await cancelEventPlaces(resoldAfterR1(1), eventBookingId, { attendeeIds: [first as string], refund: 'card', confirmed: { refund: 40 } }, options)
      expect(stands).toMatchObject({ places: 1, cardRefundedAmount: 0, refundOwed: 40 })
      expect(await eventLine(orderId)).toMatchObject({ refunded: false, card: '0.00' })
      // Refund the rest, to the card: only the event booking's money was owed, so it is the event line's.
      const rest = await orderPost(orderOwedRoute as Handler, 'refunds/owed', orderId, { amount: 40, refundMethod: 'card' })
      expect(rest.body.data).toMatchObject({ cardRefundedAmount: 40, storeCreditRefundedAmount: 0, refundOwed: 0 })
      expect((await lineRows(orderId)).map((line) => [line.item_type, line.card])).toEqual([
        ['product', '24.00'],
        ['event', '40.00'],
      ])
      expect(moneyBack(stripe)).toBe(6400)
      // No line has more back to the card than it cost, and the other place still refunds in full to the card.
      expect((await cancel(eventBookingId, 'card')).body.data).toMatchObject({ cardRefundedAmount: 40, refundedAmount: 40 })
      expect(await eventLine(orderId)).toMatchObject({ card: '80.00' })
      expect(moneyBack(stripe)).toBe(10400)
    })
  })

  it("W30a (review S2): a stamped line's own shortfall still comes first: with £14 of the soap's card refund and a place's £40 both owed, Refund the rest puts £14 on the soap and £40 on the event line", async () => {
    await onAnEventOrder({ products: [soap], event: two, payment: card }, async ({ orderId, eventBookingId, places: ids, stripe }) => {
      const [first] = await ids()
      const soapLine = (await lineRows(orderId)).find((line) => line.item_type === 'product')?.id as string
      expect((await orderPost(orderRefundRoute as Handler, 'refunds', orderId, { lineItemIds: [soapLine], refundMethod: 'card', restock: { [soapLine]: false }, confirmed: { amount: 24 } })).body.data).toMatchObject({ cardRefundedAmount: 24 })
      await db.query('UPDATE events SET capacity = 2 WHERE id = $1', [ID.event])
      stripe.failNext('refunds.create', { kind: 'error', error: refusal() })
      const options: EventCancelOptions = { actor: { type: 'staff', id: ID.staff }, requestId: crypto.randomUUID(), canIssueRefunds: true, stripe: () => stripe }
      expect(await cancelEventPlaces(resoldAfterR1(1), eventBookingId, { attendeeIds: [first as string], refund: 'card', confirmed: { refund: 40 } }, options)).toMatchObject({ refundOwed: 40 })
      // Test data standing in for a soap refund of which £14 never reached the card: the line short by £14, and owed.
      await db.query('UPDATE order_line_items SET card_refunded_amount = 10 WHERE id = $1', [soapLine])
      await db.query('UPDATE orders SET refund_owed_amount = 54 WHERE id = $1', [orderId])
      const rest = await orderPost(orderOwedRoute as Handler, 'refunds/owed', orderId, { amount: 54, refundMethod: 'card' })
      expect(rest.body.data).toMatchObject({ cardRefundedAmount: 54, refundOwed: 0 })
      const cardOf = async (type: string) => (await lineRows(orderId)).find((line) => line.item_type === type)?.card
      expect([await cardOf('product'), await cardOf('event')]).toEqual(['24.00', '40.00'])
    })
  })

  // Brief W47a item 1 (W47 review S1): an event line counts as owed only while its booking's money is still owed.
  // These hold the other side of that rule: the money is still the event line's after a Refund the rest that didn't
  // stand, and after an It already arrived for part of it. Otherwise the next press would record the card money on
  // the soap (W30a's fault again).
  /** The soap (the order's oldest line) refunded to the card in full, then place 1's £40 owed after a refused cancel with the place resold. */
  async function soapBackThenPlaceOwed({ orderId, eventBookingId, places: ids, stripe }: Context): Promise<void> {
    const [first] = await ids()
    await db.query("UPDATE order_line_items SET created_at = created_at - interval '1 minute' WHERE order_id = $1 AND item_type = 'product'", [orderId])
    const soapLine = (await lineRows(orderId)).find((line) => line.item_type === 'product')?.id as string
    expect((await orderPost(orderRefundRoute as Handler, 'refunds', orderId, { lineItemIds: [soapLine], refundMethod: 'card', restock: { [soapLine]: false }, confirmed: { amount: 24 } })).body.data).toMatchObject({ cardRefundedAmount: 24 })
    await db.query('UPDATE events SET capacity = 2 WHERE id = $1', [ID.event])
    stripe.failNext('refunds.create', { kind: 'error', error: refusal() })
    const options: EventCancelOptions = { actor: { type: 'staff', id: ID.staff }, requestId: crypto.randomUUID(), canIssueRefunds: true, stripe: () => stripe }
    expect(await cancelEventPlaces(resoldAfterR1(1), eventBookingId, { attendeeIds: [first as string], refund: 'card', confirmed: { refund: 40 } }, options)).toMatchObject({ places: 1, cardRefundedAmount: 0, refundOwed: 40 })
    vi.setSystemTime(Date.now() + 5 * 60_000)
  }
  const cardOnLines = async (orderId: string) => (await lineRows(orderId)).map((line) => [line.item_type, line.card])

  it("W47a (W47 review S1): Refund the rest to the card refused by Stripe, so the £40 is owed again, then pressed again: the £40 is still the event line's (recorded there, the soap still £24)", async () => {
    await onAnEventOrder({ products: [soap], event: two, payment: card }, async (context) => {
      const { orderId, stripe } = context
      await soapBackThenPlaceOwed(context)
      stripe.failNext('refunds.create', { kind: 'error', error: refusal() })
      const refused = await orderPost(orderOwedRoute as Handler, 'refunds/owed', orderId, { amount: 40, refundMethod: 'card' })
      expect([refused.body.ok, refused.body.error?.details?.reason]).toEqual([false, 'refund_failed'])
      expect(await order(orderId)).toMatchObject({ owed: '40.00' })
      // Owed again by the order's own row now (the Refund the rest claim, put back), not by the event booking's.
      expect((await auditRows('order.refund_finished')).at(-1)?.details).toMatchObject({ outcome: 'owed', owed: 40 })
      expect(await cardOnLines(orderId)).toEqual([['product', '24.00'], ['event', '0.00']])
      vi.setSystemTime(Date.now() + 5 * 60_000)
      const rest = await orderPost(orderOwedRoute as Handler, 'refunds/owed', orderId, { amount: 40, refundMethod: 'card' })
      expect(rest.body.data).toMatchObject({ cardRefundedAmount: 40, storeCreditRefundedAmount: 0, refundOwed: 0 })
      expect(await cardOnLines(orderId)).toEqual([['product', '24.00'], ['event', '40.00']])
      expect(moneyBack(stripe)).toBe(6400)
    })
  })

  it("W47a (W47 review S1): only money coming off what is owed clears the event line, never an ordinary refund of another line. A place's £40 owed first, then the soap refunded to the card, then Refund the rest: the £40 is recorded on the event line", async () => {
    await onAnEventOrder({ products: [soap], event: two, payment: card }, async ({ orderId, eventBookingId, places: ids, stripe }) => {
      const [first] = await ids()
      await db.query("UPDATE order_line_items SET created_at = created_at - interval '1 minute' WHERE order_id = $1 AND item_type = 'product'", [orderId])
      await db.query('UPDATE events SET capacity = 2 WHERE id = $1', [ID.event])
      stripe.failNext('refunds.create', { kind: 'error', error: refusal() })
      const options: EventCancelOptions = { actor: { type: 'staff', id: ID.staff }, requestId: crypto.randomUUID(), canIssueRefunds: true, stripe: () => stripe }
      expect(await cancelEventPlaces(resoldAfterR1(1), eventBookingId, { attendeeIds: [first as string], refund: 'card', confirmed: { refund: 40 } }, options)).toMatchObject({ refundOwed: 40 })
      vi.setSystemTime(Date.now() + 5 * 60_000)
      // The soap comes back a few minutes later: an order refund's claim, newer than the place's owed row.
      const soapLine = (await lineRows(orderId)).find((line) => line.item_type === 'product')?.id as string
      expect((await orderPost(orderRefundRoute as Handler, 'refunds', orderId, { lineItemIds: [soapLine], refundMethod: 'card', restock: { [soapLine]: false }, confirmed: { amount: 24 } })).body.data).toMatchObject({ cardRefundedAmount: 24 })
      expect(await order(orderId)).toMatchObject({ owed: '40.00' })
      vi.setSystemTime(Date.now() + 5 * 60_000)
      const rest = await orderPost(orderOwedRoute as Handler, 'refunds/owed', orderId, { amount: 40, refundMethod: 'card' })
      expect(rest.body.data).toMatchObject({ cardRefundedAmount: 40, storeCreditRefundedAmount: 0, refundOwed: 0 })
      expect(await cardOnLines(orderId)).toEqual([['product', '24.00'], ['event', '40.00']])
    })
  })

  it("W47a (W47 review S1): Refund the rest to the card accepted by Stripe and failed later, so the £40 is owed again, then pressed again: still the event line's", async () => {
    await onAnEventOrder({ products: [soap], event: two, payment: card }, async (context) => {
      const { orderId, stripe } = context
      await soapBackThenPlaceOwed(context)
      stripe.refundsStayPending = true
      expect((await orderPost(orderOwedRoute as Handler, 'refunds/owed', orderId, { amount: 40, refundMethod: 'card' })).body.data).toMatchObject({ cardRefundedAmount: 40, refundOwed: 0 })
      stripe.refundsStayPending = false
      expect(await cardOnLines(orderId)).toEqual([['product', '24.00'], ['event', '40.00']])
      vi.setSystemTime(Date.now() + 5 * 60_000)
      stripe.settleRefund(stripe.refundsSent.at(-1)?.id as string, 'failed')
      expect((await runReconcile()).items.filter((item) => item.kind === 'refund')).toMatchObject([{ outcome: 'refund_failed', reason: 'refund_failed_later' }])
      expect(await order(orderId)).toMatchObject({ owed: '40.00' })
      expect((await auditRows('order.refund_failed_later')).map((row) => [row.entity_id, row.details['owed']])).toEqual([[orderId, 40]])
      expect(await cardOnLines(orderId)).toEqual([['product', '24.00'], ['event', '0.00']])
      vi.setSystemTime(Date.now() + 5 * 60_000)
      const rest = await orderPost(orderOwedRoute as Handler, 'refunds/owed', orderId, { amount: 40, refundMethod: 'card' })
      expect(rest.body.data).toMatchObject({ cardRefundedAmount: 40, storeCreditRefundedAmount: 0, refundOwed: 0 })
      expect(await cardOnLines(orderId)).toEqual([['product', '24.00'], ['event', '40.00']])
    })
  })

  it("W47a (W47 review S1): It already arrived for part of the £40 leaves the rest still the event line's: £10 another way, £5 on the card (on the event line), then Refund the rest puts the last £25 on the event line too", async () => {
    await onAnEventOrder({ products: [soap], event: two, payment: card }, async (context) => {
      const { orderId } = context
      await soapBackThenPlaceOwed(context)
      expect((await orderPost(orderArrivedRoute as Handler, 'refunds/owed-arrived', orderId, { amount: 10, reason: 'Found on their balance' })).body.data).toMatchObject({ refundOwed: 30 })
      vi.setSystemTime(Date.now() + 5 * 60_000)
      expect((await orderPost(orderArrivedRoute as Handler, 'refunds/owed-arrived', orderId, { amount: 5, reason: 'Seen in Stripe', arrivedOn: 'card' })).body.data).toMatchObject({ refundOwed: 25 })
      expect(await cardOnLines(orderId)).toEqual([['product', '24.00'], ['event', '5.00']])
      vi.setSystemTime(Date.now() + 5 * 60_000)
      const rest = await orderPost(orderOwedRoute as Handler, 'refunds/owed', orderId, { amount: 25, refundMethod: 'card' })
      expect(rest.body.data).toMatchObject({ cardRefundedAmount: 25, storeCreditRefundedAmount: 0, refundOwed: 0 })
      expect(await cardOnLines(orderId)).toEqual([['product', '24.00'], ['event', '30.00']])
    })
  })

  it("W47a (W47 review S1), the lines' order: once the place's £40 has been given, the event line no longer draws owed money no line accounts for. Test data standing in for £10 an old screen left owed: it goes on the first stamped line, as it did before W30", async () => {
    await onAnEventOrder({ products: [soap], event: two, payment: card }, async (context) => {
      const { orderId } = context
      await soapBackThenPlaceOwed(context)
      expect((await orderPost(orderOwedRoute as Handler, 'refunds/owed', orderId, { amount: 40, refundMethod: 'card' })).body.data).toMatchObject({ cardRefundedAmount: 40, refundOwed: 0 })
      vi.setSystemTime(Date.now() + 5 * 60_000)
      await db.query('UPDATE orders SET refund_owed_amount = 10 WHERE id = $1', [orderId])
      expect((await orderPost(orderOwedRoute as Handler, 'refunds/owed', orderId, { amount: 10, refundMethod: 'card' })).body.data).toMatchObject({ cardRefundedAmount: 10, refundOwed: 0 })
      expect(await cardOnLines(orderId)).toEqual([['product', '34.00'], ['event', '40.00']])
    })
  })

  it('money owed on an event booking is cleared by It already arrived on its order, and an open order refund holds the booking (`refund_open`) for every cancel and for the quote', async () => {
    await onAnEventOrder({ products: [soap], event: two, payment: card }, async ({ orderId, eventBookingId, places: ids, stripe }) => {
      const [first, second] = await ids()
      await db.query('UPDATE orders SET refund_owed_amount = 40 WHERE id = $1', [orderId])
      expect((await orderPost(orderArrivedRoute as Handler, 'refunds/owed-arrived', orderId, { amount: 40, reason: 'Seen in Stripe' })).body.data).toMatchObject({ refundOwed: 0 })
      // The soap's card refund gets no clear answer: its claim holds the order, and so the event booking it paid for.
      stripe.failNext('refunds.create', { kind: 'lost_response' })
      stripe.failNext('refunds.create', { kind: 'lost_response' })
      const soapLine = (await lineRows(orderId)).find((line) => line.item_type === 'product')?.id as string
      const held = await orderPost(orderRefundRoute as Handler, 'refunds', orderId, { lineItemIds: [soapLine], refundMethod: 'card', restock: { [soapLine]: false }, confirmed: { amount: 24 } })
      expect(held.body.data?.held?.reason).toBe('refund_unconfirmed')
      for (const answer of [await cancel(eventBookingId, 'card', [first as string], { confirmed: 40 }), await cancel(eventBookingId, 'none', [second as string]), await quote(eventBookingId)]) {
        expect([answer.status, answer.body.error?.details?.reason, answer.body.error?.details?.message]).toEqual([409, 'refund_open', EVENT_BOOKING_REFUND_OPEN_MESSAGE])
      }
      expect((await placeRows(eventBookingId)).every((place) => !place.cancelled)).toBe(true)
    })
  })
})

describe('no clear answer: held, then reconcile (never a second send)', () => {
  it('the refund is in Stripe: the places stay cancelled, every other cancel on the booking is refused, the stuck list shows it with the words the refusal points to (W27 review L5), and reconcile records it', async () => {
    await onAnEventOrder({ event: two, payment: card }, async ({ orderId, eventBookingId, places: ids, stripe }) => {
      const [first, second] = await ids()
      stripe.failNext('refunds.create', { kind: 'lost_response' })
      stripe.failNext('refunds.create', { kind: 'lost_response' })
      const held = await cancel(eventBookingId, 'card', [first as string])
      expect(held.status).toBe(200)
      expect(held.body.data).toMatchObject({ places: 1, refundedAmount: 0, cardRefundedAmount: 0, storeCreditRefundedAmount: 0, eventPlacesBooked: 1 })
      expect(held.body.data?.held).toMatchObject({ reason: 'refund_unconfirmed', message: NEW_WORDS.unconfirmed })
      const claimId = held.body.data?.held?.claimId as string
      // Sent once, and once more under the same key and request: one refund in Stripe.
      expect(refundsSent(stripe).map((call) => call.idempotencyKey)).toEqual([claimRefundKey(claimId, orderId), claimRefundKey(claimId, orderId)])
      expect(moneyBack(stripe)).toBe(4000)
      expect((await placeRows(eventBookingId))[0]).toMatchObject({ cancelled: true, value: '40.00', refunded: '0.00', method: 'card' })
      expect(await placesBooked()).toBe(1)
      // The claim holds the booking: the other place, with a refund or without, and the quote.
      const refusals = [await cancel(eventBookingId, 'card', [second as string], { confirmed: 40 }), await cancel(eventBookingId, 'none', [second as string]), await quote(eventBookingId, [second as string])]
      for (const answer of refusals) expect([answer.status, answer.body.error?.details?.reason, answer.body.error?.details?.message]).toEqual([409, 'refund_open', EVENT_BOOKING_REFUND_OPEN_MESSAGE])
      // L5: the refusal sends staff to the Orders page. Inside the window nothing is listed there yet; past it, it is.
      expect(EVENT_BOOKING_REFUND_OPEN_MESSAGE).toContain('check the Orders page')
      expect((await stuckList(db)).claims).toHaveLength(0)
      pastTheWindow()
      expect((await stuckList(db)).claims).toEqual([expect.objectContaining({ claimId, bookingId: null, orderId, eventBookingId, eventId: ID.event, amount: 40, reason: 'waiting', words: EVENT_CLAIM_WAITING_WORDS })])
      const run = await runReconcile()
      expect(run.items).toEqual([expect.objectContaining({ kind: 'claim', id: claimId, outcome: 'finalised' })])
      expect(refundsSent(stripe)).toHaveLength(2)
      expect(moneyBack(stripe)).toBe(4000)
      expect((await placeRows(eventBookingId))[0]).toMatchObject({ refunded: '40.00', card: '40.00', method: 'card' })
      expect(await eventLine(orderId)).toMatchObject({ card: '40.00' })
      expect(await order(orderId)).toEqual({ payment_status: 'partially_refunded', owed: '0.00' })
      expect((await auditRows('event_booking.refund_finished'))[0]?.details).toMatchObject({ outcome: 'given', cardRefunded: 40, by: { how: 'reconcile' } })
      expect((await stuckList(db)).claims).toHaveLength(0)
      // Settled: the other place can be cancelled now.
      expect((await cancel(eventBookingId, 'card', [second as string])).body.data).toMatchObject({ refundedAmount: 40 })
      expect(moneyBack(stripe)).toBe(8000)
    })
  })

  it('Stripe never got it: reconcile leaves the places cancelled and the card money on the order as still to refund, gives only the plan\'s own store credit, and never sends it again', async () => {
    await onAnEventOrder({ event: two, payment: { method: 'card', storeCredit: { amount: 30 } } }, async ({ orderId, eventBookingId, stripe }) => {
      stripe.failNext('refunds.create', { kind: 'unreachable' })
      stripe.failNext('refunds.create', { kind: 'unreachable' })
      // £80 of places, £50 on the card: the £30 planned for store credit waits for R2 with the card part.
      const held = await cancel(eventBookingId, 'card')
      expect(held.body.data?.held?.reason).toBe('refund_unconfirmed')
      expect(await creditRefunds()).toHaveLength(0)
      pastTheWindow()
      expect((await runReconcile()).items).toEqual([expect.objectContaining({ kind: 'claim', outcome: 'finalised' })])
      expect(await order(orderId)).toMatchObject({ owed: '50.00' })
      expect((await creditRefunds()).map((row) => [row.amount, row.note.replace(/ \[ref .*\]$/, '')])).toEqual([['30.00', 'Event refund: Full Moon Sauna.']])
      expect((await auditRows('event_booking.refund_finished'))[0]?.details).toMatchObject({ outcome: 'owed', cardRefunded: 0, storeCreditRefunded: 30, owed: 50, by: { how: 'reconcile' } })
      expect((await placeRows(eventBookingId)).map((place) => [place.cancelled, place.refunded, place.card, place.method])).toEqual([
        [true, '15.00', '0.00', 'card'],
        [true, '15.00', '0.00', 'card'],
      ])
      expect(await booking(eventBookingId)).toMatchObject({ status: 'cancelled', places: 0 })
      // The booking is fully cancelled with a refund claimed on it: its line is stamped, with the card money still owed.
      expect(await eventLine(orderId)).toMatchObject({ refunded: true, refund_method: 'card', card: '0.00' })
      expect(moneyBack(stripe)).toBe(0)
      expect((await runReconcile()).items).toEqual([])
      expect(refundsSent(stripe)).toHaveLength(2)
    })
  })

  it('reconcile leaves a claim for a person (two refunds in Stripe name it): listed with a close; the manual close keeps the places cancelled and puts the money on the order as owed', async () => {
    await onAnEventOrder({ event: two, payment: card }, async ({ orderId, eventBookingId, places: ids, stripe }) => {
      const [first] = await ids()
      stripe.failNext('refunds.create', { kind: 'lost_response' })
      stripe.failNext('refunds.create', { kind: 'lost_response' })
      const held = await cancel(eventBookingId, 'card', [first as string])
      const claimId = held.body.data?.held?.claimId as string
      const intent = (refundsSent(stripe)[0]?.params as { payment_intent: string }).payment_intent
      // A second refund naming the claim, made by hand in Stripe.
      await stripe.refunds.create({ payment_intent: intent, amount: 100, metadata: { claim_id: claimId } }, { idempotencyKey: 'by-hand' })
      pastTheWindow()
      expect((await runReconcile()).items).toEqual([expect.objectContaining({ kind: 'claim', id: claimId, outcome: 'left', reason: 'several_refunds' })])
      expect((await stuckList(db)).claims).toEqual([expect.objectContaining({ claimId, eventBookingId, reason: 'several_refunds', close: { kind: 'held_claim', orderId: claimId } })])
      const closed = await close(claimId)
      expect(closed.body.data).toMatchObject({ closed: true })
      expect(String(closed.body.data?.['message'])).toContain('the places stay cancelled')
      expect(await order(orderId)).toMatchObject({ owed: '40.00' })
      expect((await placeRows(eventBookingId))[0]).toMatchObject({ cancelled: true, refunded: '0.00' })
      expect((await auditRows('event_booking.refund_finished'))[0]?.details).toMatchObject({ outcome: 'owed', owed: 40, by: { how: 'close' } })
      expect((await stuckList(db)).claims).toHaveLength(0)
      // A second close does nothing.
      expect((await close(claimId)).body.data).toMatchObject({ closed: true, alreadyClosed: true })
      expect(await order(orderId)).toMatchObject({ owed: '40.00' })
    })
  })
})

describe('a crash at each step: nothing is paid twice and nothing is hidden', () => {
  /** A Db whose transactions die from the `from`th on (1 is R1), as a Worker killed part way leaves them. */
  function dyingFrom(from: number): Db {
    let count = 0
    return new Proxy(db, {
      get(target, property, receiver) {
        if (property === 'transaction') {
          return <T>(work: (tx: Tx) => Promise<T>): Promise<T> => {
            count += 1
            if (count >= from) return Promise.reject(new Error('the Worker died'))
            return target.transaction(work)
          }
        }
        return Reflect.get(target, property, receiver) as unknown
      },
    })
  }
  const options = (stripe: FakeStripe): EventCancelOptions => ({ actor: { type: 'staff', id: ID.staff }, requestId: crypto.randomUUID(), canIssueRefunds: true, stripe: () => stripe })
  const press = (through: Db, stripe: FakeStripe, eventBookingId: string, attendeeId: string) => cancelEventPlaces(through, eventBookingId, { attendeeIds: [attendeeId], refund: 'card', confirmed: { refund: 40 } }, options(stripe))

  it('dies in R1: nothing is kept, nothing is sent, and the same cancel then goes through', async () => {
    await onAnEventOrder({ event: two, payment: card }, async ({ eventBookingId, places: ids, stripe }) => {
      const [first] = await ids()
      await expect(press(dyingFrom(1), stripe, eventBookingId, first as string)).rejects.toThrow('the Worker died')
      expect(await auditRows('event_booking.refund_claimed')).toHaveLength(0)
      expect(refundsSent(stripe)).toHaveLength(0)
      expect((await placeRows(eventBookingId))[0]?.cancelled).toBe(false)
      expect((await cancel(eventBookingId, 'card', [first as string])).body.data).toMatchObject({ cardRefundedAmount: 40 })
    })
  })

  it("bug E13 is closed: dies after one place's £40 refund and before R2. The other place's cancel is refused (`refund_open`); reconcile records the £40 once; then the other place cancels: £80 back, two places cancelled, never £80 back with a place still booked", async () => {
    await onAnEventOrder({ event: two, payment: card }, async ({ orderId, eventBookingId, places: ids, stripe }) => {
      const [first, second] = await ids()
      // R1 commits (the place cancelled, the claim saved), the refund goes, then every later transaction dies.
      const held = await press(dyingFrom(2), stripe, eventBookingId, first as string)
      expect(held.held).toMatchObject({ reason: 'refund_not_recorded', message: NEW_WORDS.goneNotRecorded(40) })
      expect(held).toMatchObject({ places: 1, refundedAmount: 40, cardRefundedAmount: 40 })
      expect(moneyBack(stripe)).toBe(4000)
      expect((await placeRows(eventBookingId)).map((place) => place.cancelled)).toEqual([true, false])
      // The old code let the other place go here (a second £40), then refused the first place's own cancel.
      const other = await cancel(eventBookingId, 'card', [second as string], { confirmed: 40 })
      expect(other.body.error?.details?.reason).toBe('refund_open')
      // The first place can't be cancelled again either: it is cancelled already.
      expect(moneyBack(stripe)).toBe(4000)
      pastTheWindow()
      expect((await runReconcile()).items).toEqual([expect.objectContaining({ kind: 'claim', outcome: 'finalised' })])
      expect((await placeRows(eventBookingId))[0]).toMatchObject({ cancelled: true, refunded: '40.00', card: '40.00' })
      expect(await eventLine(orderId)).toMatchObject({ card: '40.00' })
      expect((await cancel(eventBookingId, 'card', [second as string])).body.data).toMatchObject({ cardRefundedAmount: 40, eventPlacesBooked: 0 })
      expect(moneyBack(stripe)).toBe(8000)
      expect(refundsSent(stripe)).toHaveLength(2)
      expect(await eventLine(orderId)).toMatchObject({ refunded: true, card: '80.00' })
      expect((await placeRows(eventBookingId)).every((place) => place.cancelled && place.card === '40.00')).toBe(true)
    })
  })

  it('dies after R1 and before anything is sent: the place is cancelled and its claim saved; reconcile finds nothing in Stripe and leaves the £40 on the order as still to refund; nothing is ever sent', async () => {
    await onAnEventOrder({ event: two, payment: card }, async ({ orderId, eventBookingId, places: ids, stripe }) => {
      const [first] = await ids()
      const noStripe: EventCancelOptions = {
        ...options(stripe),
        stripe: () =>
          new Proxy(stripe, {
            get(target, property, receiver) {
              if (property === 'refunds') return { create: () => Promise.reject(new Error('the Worker died')), list: target.refunds.list.bind(target.refunds) }
              return Reflect.get(target, property, receiver) as unknown
            },
          }),
      }
      const pressed = await cancelEventPlaces(db, eventBookingId, { attendeeIds: [first as string], refund: 'card', confirmed: { refund: 40 } }, noStripe)
      expect(pressed.held?.reason).toBe('refund_unconfirmed')
      expect(refundsSent(stripe)).toHaveLength(0)
      expect((await placeRows(eventBookingId))[0]).toMatchObject({ cancelled: true, refunded: '0.00' })
      pastTheWindow()
      expect((await runReconcile()).items).toEqual([expect.objectContaining({ kind: 'claim', outcome: 'finalised' })])
      expect(await order(orderId)).toMatchObject({ owed: '40.00' })
      expect(refundsSent(stripe)).toHaveLength(0)
      expect(await creditRefunds()).toHaveLength(0)
    })
  })

  it('no time left to send the card refund: never sent, R1 undone, plain words, and the same cancel then goes through', async () => {
    await onAnEventOrder({ event: two, payment: card }, async ({ eventBookingId, places: ids, stripe }) => {
      const [first] = await ids()
      const late: EventCancelOptions = { ...options(stripe), startedAt: Date.now() - 29_000 }
      const pressed = cancelEventPlaces(db, eventBookingId, { attendeeIds: [first as string], refund: 'card', confirmed: { refund: 40 } }, late)
      await expect(pressed).rejects.toMatchObject({ code: 'PAYMENT_FAILED', details: { reason: 'refund_failed', message: NEW_WORDS.notSentInTime } })
      expect(refundsSent(stripe)).toHaveLength(0)
      expect(await auditRows('event_booking.refund_refused')).toHaveLength(0)
      expect((await auditRows('event_booking.refund_finished'))[0]?.details).toMatchObject({ outcome: 'put_back' })
      expect((await placeRows(eventBookingId))[0]?.cancelled).toBe(false)
      expect(await placesBooked()).toBe(2)
      expect((await cancel(eventBookingId, 'card', [first as string])).body.data).toMatchObject({ cardRefundedAmount: 40 })
    })
  })
})

describe('a check-in at the same moment', () => {
  it('a place checked in after the quote and before the statement that cancels it: the whole cancel is refused, nothing is cancelled, claimed or sent', async () => {
    await onAnEventOrder({ event: two, payment: card }, async ({ eventBookingId, places: ids, stripe }) => {
      const [first, second] = await ids()
      // The staff app's check-in takes none of the Worker's locks: it lands between R1's quote and its UPDATE.
      const checkedInMeanwhile = new Proxy(db, {
        get(target, property, receiver) {
          if (property !== 'transaction') return Reflect.get(target, property, receiver) as unknown
          return <T>(work: (tx: Tx) => Promise<T>): Promise<T> =>
            target.transaction((tx) =>
              work(
                new Proxy(tx, {
                  get(inner, name, innerReceiver) {
                    if (name !== 'query') return Reflect.get(inner, name, innerReceiver) as unknown
                    return async (sql: string, params?: readonly unknown[]) => {
                      const rows = await inner.query(sql, params as never)
                      if (sql.includes('event_cancellation_quote')) await inner.query('UPDATE event_attendees SET checked_in_at = now() WHERE id = $1', [second])
                      return rows
                    }
                  },
                })
              )
            )
        },
      })
      const options: EventCancelOptions = { actor: { type: 'staff', id: ID.staff }, requestId: crypto.randomUUID(), canIssueRefunds: true, stripe: () => stripe }
      const pressed = cancelEventPlaces(checkedInMeanwhile, eventBookingId, { attendeeIds: [first as string, second as string], refund: 'card', confirmed: { refund: 80 } }, options)
      await expect(pressed).rejects.toMatchObject({ code: 'CONFLICT', details: { reason: 'changed_by_someone_else', message: WORDS.changedBySomeoneElse } })
      expect(refundsSent(stripe)).toHaveLength(0)
      expect(await auditRows('event_booking.refund_claimed')).toHaveLength(0)
      expect((await placeRows(eventBookingId)).every((place) => !place.cancelled)).toBe(true)
      expect(await booking(eventBookingId)).toMatchObject({ status: 'confirmed', places: 2 })
      expect(await placesBooked()).toBe(2)
    })
  })
})

// Brief W32 item 1: the refund watch on an event booking's claim. Its card part is on the order that paid for the
// booking (W30), and a failure is owed on that order (Q39), with the places still cancelled.
describe('W32: the refund watch on an event booking', () => {
  /** W32a: without the `checked` rows (one for each read that ended nothing). */
  const watchStates = async () => (await auditRows('refund.watch')).map((row) => String(row.details['state'])).filter((state) => state !== 'checked').sort()
  const minutes = (n: number) => vi.setSystemTime(Date.now() + n * 60_000)
  const DAY = 24 * 60
  const refundItems = async () => (await runReconcile()).items.filter((item) => item.kind === 'refund')
  async function pendingCancel(eventBookingId: string, stripe: FakeStripe, attendeeIds?: string[]): Promise<Answer> {
    stripe.refundsStayPending = true
    const answer = await cancel(eventBookingId, 'card', attendeeIds)
    stripe.refundsStayPending = false
    return answer
  }

  it('one place to the card, pending then succeeded: the place, the line and the order as the press left them; the watch ends', async () => {
    await onAnEventOrder({ event: two, payment: card }, async ({ orderId, eventBookingId, places: ids, stripe }) => {
      const [first] = await ids()
      expect((await pendingCancel(eventBookingId, stripe, [first as string])).body.data).toMatchObject({ places: 1, cardRefundedAmount: 40 })
      const sent = stripe.refundsSent[0]
      const claim = (await auditRows('event_booking.refund_claimed'))[0]
      expect((await auditRows('refund.watch')).map((row) => row.details)).toEqual([
        { state: 'watching', refundId: sent?.id, paymentIntentId: sent?.payment_intent, amount: 40, status: 'pending', livemode: false, on: 'event_booking', subjectId: eventBookingId, orderId, claimId: claim?.id, lines: [{ lineId: expect.any(String), amount: 40 }] },
      ])
      // W32a (W32 review S2): on its way: read, no item, nothing for a person; counted as waiting on Stripe.
      expect(await runReconcile()).toMatchObject({ refunds: 0, left: 0, refundsWaiting: 1, items: [] })
      stripe.settleRefund(sent?.id as string, 'succeeded')
      minutes(5)
      // W32a (lead call 1): succeeded is not the end of the watch; it ends, quietly, when its 50 days are up.
      expect(await runReconcile()).toMatchObject({ refunds: 0, left: 0, refundsWaiting: 0, items: [] })
      expect(await watchStates()).toEqual(['watching'])
      minutes(WATCH_DAYS * DAY)
      expect(await refundItems()).toEqual([])
      expect(await watchStates()).toEqual(['succeeded', 'watching'])
      expect((await placeRows(eventBookingId))[0]).toMatchObject({ cancelled: true, refunded: '40.00', card: '40.00' })
      expect(await order(orderId)).toEqual({ payment_status: 'partially_refunded', owed: '0.00' })
      minutes(DAY)
      expect(await refundItems()).toEqual([])
      expect(refundsSent(stripe)).toHaveLength(1)
    })
  })

  it("W32a (lead call 1; Stripe's 5126 shape, end to end): one place to the card, the refund answered succeeded and watched; Stripe fails it afterwards: the next day's read leaves the place cancelled with nothing back on it and puts the £40 as owed on the order that paid, listed for the attendee list; the failed refund is never sent again", async () => {
    await onAnEventOrder({ event: two, payment: card }, async ({ orderId, eventBookingId, places: ids, stripe }) => {
      const [first] = await ids()
      expect((await cancel(eventBookingId, 'card', [first as string])).body.data).toMatchObject({ places: 1, cardRefundedAmount: 40 })
      const sent = stripe.refundsSent[0]
      const claim = (await auditRows('event_booking.refund_claimed'))[0]
      expect((await auditRows('refund.watch')).map((row) => row.details)).toEqual([
        { state: 'watching', refundId: sent?.id, paymentIntentId: sent?.payment_intent, amount: 40, status: 'succeeded', livemode: false, on: 'event_booking', subjectId: eventBookingId, orderId, claimId: claim?.id, lines: [{ lineId: expect.any(String), amount: 40 }] },
      ])
      const lists = () => stripe.calls.filter((call) => call.method === 'refunds.list').length
      minutes(5)
      stripe.settleRefund(sent?.id as string, 'failed')
      expect(moneyBack(stripe)).toBe(0)
      // Nothing is read until a day after it was recorded.
      const before = lists()
      expect(await refundItems()).toEqual([])
      expect(lists()).toBe(before)
      expect(await order(orderId)).toMatchObject({ owed: '0.00' })
      minutes(DAY)
      const found = await runReconcile()
      expect(found).toMatchObject({ refunds: 1, left: 1 })
      expect(found.items).toMatchObject([{ kind: 'refund', id: sent?.id, outcome: 'refund_failed', reason: 'refund_failed_later' }])
      expect((await placeRows(eventBookingId))[0]).toMatchObject({ cancelled: true, value: '40.00', refunded: '0.00', card: '0.00', method: 'card' })
      expect(await eventLine(orderId)).toMatchObject({ card: '0.00' })
      expect(await order(orderId)).toMatchObject({ owed: '40.00' })
      expect((await auditRows('event_booking.refund_failed_later')).map((row) => [row.entity_id, row.details['owed']])).toEqual([[eventBookingId, 40]])
      expect((await stuckList(db)).watched).toMatchObject([{ refundId: sent?.id, on: 'event_booking', orderId, eventBookingId, eventId: ID.event, amount: 40, owed: 40, state: 'failed', words: WATCH_WORDS.eventFailed(40, sent?.id as string) }])
      // W47 item 1: an event booking's money owed is its order's, so the "Money still to refund" list has one line:
      // the order, with the event booking beside it, dated from the refund that failed later.
      const owedList = await moneyOwedList(db)
      expect(owedList.owed).toHaveLength(1)
      expect(owedList.owed[0]).toMatchObject({ on: 'order', orderId, bookingId: null, amount: 40, daysOwed: 0, where: MONEY_OWED_WORDS.orderWithEvent })
      expect(owedList.owed[0]?.eventBookings).toMatchObject([{ eventBookingId, eventId: ID.event }])
      expect(owedList.owed[0]?.owedSince).toEqual(expect.any(String))
      expect(JSON.stringify(owedList.owed).split(eventBookingId)).toHaveLength(2)
      // Once, and never a second send, however many runs follow.
      await Promise.all([runReconcile(), runReconcile()])
      minutes(DAY)
      expect(await refundItems()).toEqual([])
      expect(await order(orderId)).toMatchObject({ owed: '40.00' })
      expect(await creditRefunds()).toEqual([])
      expect(refundsSent(stripe)).toHaveLength(1)
    })
  })

  it('one place to the card, pending then failed: the place stays cancelled with nothing back on it, the £40 is off the event line and owed on the order, once; listed for the attendee list; Refund the rest sends it again', async () => {
    await onAnEventOrder({ event: two, payment: card }, async ({ orderId, eventBookingId, places: ids, stripe }) => {
      const [first] = await ids()
      await pendingCancel(eventBookingId, stripe, [first as string])
      const sent = stripe.refundsSent[0]
      stripe.settleRefund(sent?.id as string, 'failed')
      expect(await refundItems()).toMatchObject([{ id: sent?.id, outcome: 'refund_failed', reason: 'refund_failed_later' }])
      // As R2 leaves a place whose card part never went: cancelled, its value kept, nothing given back on it.
      expect((await placeRows(eventBookingId))[0]).toMatchObject({ cancelled: true, value: '40.00', refunded: '0.00', card: '0.00', method: 'card' })
      expect(await booking(eventBookingId)).toMatchObject({ status: 'confirmed', places: 1 })
      expect(await placesBooked()).toBe(1)
      expect(await eventLine(orderId)).toMatchObject({ card: '0.00' })
      expect(await order(orderId)).toMatchObject({ owed: '40.00' })
      await Promise.all([runReconcile(), runReconcile()])
      expect(await refundItems()).toEqual([])
      expect(await order(orderId)).toMatchObject({ owed: '40.00' })
      expect(await watchStates()).toEqual(['failed', 'watching'])
      expect((await auditRows('event_booking.refund_failed_later')).map((row) => [row.entity_id, row.details['owed']])).toEqual([[eventBookingId, 40]])
      expect(await creditRefunds()).toEqual([])
      expect(refundsSent(stripe)).toHaveLength(1)

      const listed = (await stuckList(db)).watched
      expect(listed).toMatchObject([{ refundId: sent?.id, on: 'event_booking', bookingId: null, orderId, eventBookingId, eventId: ID.event, amount: 40, owed: 40, state: 'failed', words: WATCH_WORDS.eventFailed(40, sent?.id as string) }])
      expect(listed[0]?.words).toBe(
        `A card refund of £40.00 for cancelled event places (${sent?.id}) was accepted by Stripe and then failed, so the money never reached the customer. The places stay cancelled, and the money is back on the event booking as money still to refund: open the event's attendee list and use Refund the rest (choose store credit if the card can't take a refund). Then press Mark sorted (needs the Issue refunds permission).`
      )

      const rest = await orderPost(orderOwedRoute as Handler, 'refunds/owed', orderId, { amount: 40, refundMethod: 'card' })
      expect(rest.body.data).toMatchObject({ cardRefundedAmount: 40, refundOwed: 0 })
      expect(moneyBack(stripe)).toBe(4000)
      expect(await eventLine(orderId)).toMatchObject({ card: '40.00' })
    })
  })

  it('a whole booking paid £50 on the card and £30 with store credit, the card part pending then failed: the £30 of store credit stands and is what the places show, the £50 is owed', async () => {
    await onAnEventOrder({ event: two, payment: { method: 'card', storeCredit: { amount: 30 } } }, async ({ orderId, eventBookingId, stripe }) => {
      const answer = await pendingCancel(eventBookingId, stripe)
      expect(answer.body.data).toMatchObject({ places: 2, cardRefundedAmount: 50, storeCreditRefundedAmount: 30 })
      expect((await placeRows(eventBookingId)).map((place) => [place.refunded, place.card])).toEqual([
        ['40.00', '25.00'],
        ['40.00', '25.00'],
      ])
      stripe.settleRefund(stripe.refundsSent[0]?.id as string, 'canceled')
      expect(await refundItems()).toMatchObject([{ outcome: 'refund_failed' }])
      expect((await placeRows(eventBookingId)).map((place) => [place.cancelled, place.refunded, place.card])).toEqual([
        [true, '15.00', '0.00'],
        [true, '15.00', '0.00'],
      ])
      expect(await booking(eventBookingId)).toMatchObject({ status: 'cancelled', places: 0 })
      expect(await eventLine(orderId)).toMatchObject({ refunded: true, refund_method: 'card', card: '0.00' })
      expect(await order(orderId)).toMatchObject({ owed: '50.00' })
      expect((await creditRefunds()).map((row) => row.amount)).toEqual(['30.00'])
    })
  })

  it("a claim reconcile finished (the press's answers were lost) with its refund still pending: watched from then, and its failure is owed on the booking's order", async () => {
    await onAnEventOrder({ event: two, payment: card }, async ({ orderId, eventBookingId, places: ids, stripe }) => {
      const [first] = await ids()
      stripe.refundsStayPending = true
      stripe.failNext('refunds.create', { kind: 'lost_response' })
      stripe.failNext('refunds.create', { kind: 'lost_response' })
      const held = await cancel(eventBookingId, 'card', [first as string])
      stripe.refundsStayPending = false
      expect(held.body.data?.held).toMatchObject({ reason: 'refund_unconfirmed' })
      pastTheWindow()
      await runReconcile()
      const sent = stripe.refundsSent[0]
      expect((await auditRows('event_booking.refund_finished'))[0]?.details).toMatchObject({ outcome: 'given', cardRefunded: 40, refunds: [{ refundId: sent?.id, status: 'pending' }], by: { how: 'reconcile' } })
      expect((await auditRows('refund.watch')).map((row) => row.details)).toMatchObject([{ state: 'watching', refundId: sent?.id, on: 'event_booking', subjectId: eventBookingId, orderId }])
      stripe.settleRefund(sent?.id as string, 'failed')
      await runReconcile()
      expect(await order(orderId)).toMatchObject({ owed: '40.00' })
      expect(stripe.refundsSent).toHaveLength(1)
    })
  })

  it("W35a (W35 audit S1): soap £24 and two places £80 on one card; place 1's card refund succeeds and fails later; Refund the rest £40 to the card is recorded on the event line, not on the soap: the soap reads £0 card back and still refunds £24", async () => {
    await onAnEventOrder({ products: [soap], event: two, payment: card }, async ({ orderId, eventBookingId, places: ids, stripe }) => {
      const [first] = await ids()
      // The soap is made the order's oldest line: an order's lines share one created_at, so which is first falls to the id.
      await db.query("UPDATE order_line_items SET created_at = created_at - interval '1 minute' WHERE order_id = $1 AND item_type = 'product'", [orderId])
      expect((await cancel(eventBookingId, 'card', [first as string])).body.data).toMatchObject({ places: 1, cardRefundedAmount: 40 })
      const sent = stripe.refundsSent[0]
      minutes(5)
      stripe.settleRefund(sent?.id as string, 'failed')
      minutes(DAY)
      expect(await refundItems()).toMatchObject([{ id: sent?.id, outcome: 'refund_failed', reason: 'refund_failed_later' }])
      expect(await order(orderId)).toMatchObject({ owed: '40.00' })
      // The claim's finished row still says given: the failure is the booking's own row, which is what the lines' query reads.
      expect((await auditRows('event_booking.refund_finished')).map((row) => row.details['outcome'])).toEqual(['given'])
      expect((await auditRows('event_booking.refund_failed_later')).map((row) => [row.entity_id, row.details['owed']])).toEqual([[eventBookingId, 40]])
      expect(await booking(eventBookingId)).toMatchObject({ status: 'confirmed', places: 1 })

      const rest = await orderPost(orderOwedRoute as Handler, 'refunds/owed', orderId, { amount: 40, refundMethod: 'card' })
      expect(rest.body.data).toMatchObject({ cardRefundedAmount: 40, storeCreditRefundedAmount: 0, refundOwed: 0 })
      expect(moneyBack(stripe)).toBe(4000)
      expect((await lineRows(orderId)).map((line) => [line.item_type, line.refunded, line.card])).toEqual([
        ['product', false, '0.00'],
        ['event', false, '40.00'],
      ])
      const read = await (orderFiguresRoute as Handler)(new Request(`https://worker.test/api/v1/staff/orders/${orderId}/refund-figures`, { headers: headers(REPLAY_USER.email) }), { params: Promise.resolve({ orderId }) })
      const figures = ((await read.json()) as { data: { cardLeft: number; refundOwed: number; lines: Array<{ itemType: string; cardRefunded: number; refundable: number }> } }).data
      expect(figures).toMatchObject({ cardLeft: 64, refundOwed: 0 })
      expect(figures.lines.map((line) => [line.itemType, line.cardRefunded, line.refundable])).toEqual([
        ['product', 0, 24],
        ['event', 40, 40],
      ])

      // The customer brings the soap back: its own refund gives the whole £24, to the card.
      const soapLine = (await lineRows(orderId)).find((line) => line.item_type === 'product')?.id as string
      const soapBack = await orderPost(orderRefundRoute as Handler, 'refunds', orderId, { lineItemIds: [soapLine], refundMethod: 'card', restock: { [soapLine]: false }, confirmed: { amount: 24 } })
      expect(soapBack.body.data).toMatchObject({ cardRefundedAmount: 24 })
      expect(moneyBack(stripe)).toBe(6400)
      expect((await lineRows(orderId)).map((line) => [line.item_type, line.refunded, line.card])).toEqual([
        ['product', true, '24.00'],
        ['event', false, '40.00'],
      ])
      expect(await order(orderId)).toMatchObject({ owed: '0.00' })
      expect(await creditRefunds()).toEqual([])
      // The failed refund, Refund the rest, the soap: three sends, none a second send of another.
      expect(refundsSent(stripe)).toHaveLength(3)
    })
  })
})
