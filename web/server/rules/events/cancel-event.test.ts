import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { cancelEventOutputSchema, cancelEventPlacesOutputSchema, eventAttendeeBookingSchema, eventAttendeeRowSchema, eventCancelOverviewBookingSchema, eventCancelOverviewOutputSchema } from '@/contracts'
import { POST as placeCancelRoute } from '@/app/api/v1/staff/event-bookings/[eventBookingId]/cancel/route'
import { GET as overviewRoute } from '@/app/api/v1/staff/events/[eventId]/cancel/overview/route'
import { POST as eventCancelRoute } from '@/app/api/v1/staff/events/[eventId]/cancel/route'
import { POST as orderOwedRoute } from '@/app/api/v1/staff/orders/[orderId]/refunds/owed/route'
import type { Db } from '@/server/db'
import { EVENT_BOOKING_REFUND_OPEN_MESSAGE, REFUND_PATH_OFF_MESSAGE } from '@/server/rules/refunds/failure-messages'
import { insert } from '@/server/rules/testing/database'
import { BOOKING_KINDS_ON, withSwitch } from '@/server/rules/testing/replay/booking-side'
import { oldSide, replay, REPLAY_USER, startReplay, type ReplayEnvironment, type ScenarioContext } from '@/server/rules/testing/replay/harness'
import { ID, later, seed } from '@/server/rules/testing/replay/scenarios'
import { replayStripe } from '@/server/rules/testing/replay/stripe-binding'
import { fakeStripeErrors, type FakeStripe } from '@/server/stripe/fake'
import { EVENT_CANCELLED } from './cancel-event'
import { cancelEventPlaces, type EventCancelOptions } from './cancel-places'
import {
  EVENT_CANCEL_NEW_WORDS as PLACE_NEW_WORDS,
  EVENT_CANCEL_WORDS as PLACE_WORDS,
  EVENT_OVERVIEW_WORDS,
  EVENT_QUOTE_REFUSALS,
  EVENT_WHOLE_CANCEL_NEW_WORDS as NEW_WORDS,
  EVENT_WHOLE_CANCEL_WORDS as WORDS,
} from './failure-messages'

// Brief W31 (E-plan 4.4 "Whole event", 5.1): the whole event on the Worker, on the replay's live schema (the
// database's own event_cancellation_quote, release_event_places and store credit function included), through the
// routes as the staff app calls them. The event orders are placed by the old createOrder (the frozen copy), as the
// golden scenarios place them. Stripe is only ever the fake.

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
const GIA = '10000000-0000-4000-8000-0000000000a1'
const UNKNOWN = '10000000-0000-4000-8000-0000000000e7'

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
const moAttending = { name: 'Mo Member', email: 'mo@example.com', dateOfBirth: '1985-05-05', isAccountHolder: true }
const giaAttending = { name: 'Gia Gift', email: 'gia@example.com', dateOfBirth: '1992-02-02', isAccountHolder: true }
const eventFor = (attendees: Array<Record<string, unknown>>) => ({
  eventId: ID.event,
  accountHolderAttending: true,
  ...(attendees.length > 1 ? { guestsOver18Confirmed: true } : {}),
  attendees,
})
const cash = (amount: number) => ({ method: 'cash', confirmedCashAmount: amount })

interface Booked {
  orderId: string
  eventBookingId: string
}
type Context = ScenarioContext & {
  /** Sam's two places at £40 on the card (£80). */
  samOnCard(): Promise<Booked>
  /** Mo's own place at the Herd price in cash (£20). */
  moInCash(): Promise<Booked>
  /** Gia's own place (£40): £20 of gift card and £20 in cash. */
  giaOnGiftCard(): Promise<Booked>
}

/** The seeded event, with `work` run against it. Bookings are placed by the old createOrder. */
async function onTheEvent(work: (context: Context) => Promise<void>): Promise<void> {
  await replay(
    environment,
    {
      name: 'w31 whole event',
      seed,
      async run(context) {
        replayStripe.current = context.stripe
        const place = async (order: Record<string, unknown>): Promise<Booked> => {
          const placed = (await context.call('createOrder', order)) as Record<string, unknown>
          if (placed['success'] !== true) throw new Error(`The order failed: ${JSON.stringify(placed)}`)
          return { orderId: String(placed['orderId']), eventBookingId: String(placed['eventBookingId']) }
        }
        try {
          await work({
            ...context,
            samOnCard: () => place({ customerId: ID.customer, event: eventFor([samAttending, alexGuest]), payment: { method: 'card' } }),
            moInCash: () => place({ customerId: ID.member, event: eventFor([moAttending]), payment: cash(20) }),
            async giaOnGiftCard() {
              await insert(context.db, 'customers', { id: GIA, first_name: 'Gia', last_name: 'Gift', email: 'gia@example.com', date_of_birth: '1992-02-02' })
              return place({ customerId: GIA, event: eventFor([giaAttending]), payment: { ...cash(20), giftCard: { giftCardId: ID.giftCard, amount: 20 } } })
            },
          })
        } finally {
          replayStripe.current = null
        }
      },
    },
    oldSide
  )
}

type OverviewBooking = { eventBookingId: string; customerName: string; places: number; value: number; problem: string | null; refundOwed?: number }
type Overview = { eventName: string; ended: boolean; cancelledAt: string | null; cancelReason: string | null; pendingCustomers: string[]; bookings: OverviewBooking[]; totalPlaces: number; totalValue: number }
type Answer<T = Record<string, unknown>> = {
  status: number
  body: { ok: boolean; data?: T; error?: { code: string; message: string; details?: { reason?: string; message?: string; action?: string; kinds?: string[]; quote?: { value: number } } } }
}
type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>

const headers = (email: string, key?: string) => ({ authorization: `Bearer ${KEY}`, 'x-staff-email': email, 'content-type': 'application/json', ...(key ? { 'idempotency-key': key } : {}) })

/** POST /events/:id/cancel, as the dialog's first step. */
async function cancelTheEvent(body: Record<string, unknown> = { refund: 'card', reason: 'Storm' }, { eventId = ID.event, orderSwitch = EVENT_KINDS_ON, email = REPLAY_USER.email } = {}): Promise<Answer<Overview>> {
  return withSwitch(orderSwitch, async () => {
    const response = await (eventCancelRoute as Handler)(new Request(`https://worker.test/api/v1/staff/events/${eventId}/cancel`, { method: 'POST', headers: headers(email), body: JSON.stringify(body) }), {
      params: Promise.resolve({ eventId }),
    })
    return { status: response.status, body: (await response.json()) as Answer<Overview>['body'] }
  })
}

async function overview(eventId: string = ID.event): Promise<Answer<Overview>> {
  const response = await (overviewRoute as Handler)(new Request(`https://worker.test/api/v1/staff/events/${eventId}/cancel/overview`, { method: 'GET', headers: headers(REPLAY_USER.email) }), { params: Promise.resolve({ eventId }) })
  return { status: response.status, body: (await response.json()) as Answer<Overview>['body'] }
}

/** One booking's press in the whole-event run: `wholeEvent`, the choice, and the overview's figure sent back (Q18). */
async function press(eventBookingId: string, body: Record<string, unknown>, { key = crypto.randomUUID(), orderSwitch = EVENT_KINDS_ON } = {}): Promise<Answer> {
  return withSwitch(orderSwitch, async () => {
    const response = await (placeCancelRoute as Handler)(
      new Request(`https://worker.test/api/v1/staff/event-bookings/${eventBookingId}/cancel`, { method: 'POST', headers: headers(REPLAY_USER.email, key), body: JSON.stringify(body) }),
      { params: Promise.resolve({ eventBookingId }) }
    )
    return { status: response.status, body: (await response.json()) as Answer['body'] }
  })
}
const wholePress = (booking: OverviewBooking, refund = 'card', more: Record<string, unknown> = {}, options: { key?: string; orderSwitch?: string } = {}) =>
  press(booking.eventBookingId, { refund, wholeEvent: true, confirmed: { refund: booking.value }, ...more }, options)

const eventRow = async () =>
  (
    await db.query<{ active: boolean; cancelled: boolean; cancel_reason: string | null; cancelled_by: string | null; places_booked: number }>(
      'SELECT active, cancelled_at IS NOT NULL AS cancelled, cancel_reason, cancelled_by, places_booked FROM events WHERE id = $1',
      [ID.event]
    )
  )[0]
const bookingRow = async (eventBookingId: string) => (await db.query<{ status: string; places: number; cancel_reason: string | null }>('SELECT status, places, cancel_reason FROM event_bookings WHERE id = $1', [eventBookingId]))[0]
const placeRows = async (eventBookingId: string) =>
  db.query<{ id: string; cancelled: boolean; value: string; refunded: string; card: string; method: string | null; after: boolean; reason: string | null }>(
    `SELECT id, cancelled_at IS NOT NULL AS cancelled, cancelled_value::numeric(10,2)::text AS value, refunded_amount::numeric(10,2)::text AS refunded,
            card_refunded_amount::numeric(10,2)::text AS card, refund_method AS method, refund_after_cutoff AS after, cancel_reason AS reason
     FROM event_attendees WHERE event_booking_id = $1 ORDER BY created_at, id`,
    [eventBookingId]
  )
const orderRow = async (orderId: string) => (await db.query<{ payment_status: string; owed: string }>('SELECT payment_status, refund_owed_amount::text AS owed FROM orders WHERE id = $1', [orderId]))[0]
// In amount order: two rows written back to back can share a millisecond on the tests' database.
const creditRefunds = async () => db.query<{ amount: string; customer_id: string }>("SELECT amount::text AS amount, customer_id FROM store_credit_transactions WHERE reason = 'refund' ORDER BY amount, id")
const auditRows = async (action: string) => db.query<{ entity_id: string; actor_id: string | null; details: Record<string, unknown> }>('SELECT entity_id, actor_id, details FROM audit_log WHERE action = $1 ORDER BY at, id', [action])
const refundsSent = (stripe: FakeStripe) => stripe.calls.filter((call) => call.method === 'refunds.create')
const moneyBack = (stripe: FakeStripe) => stripe.refundsSent.reduce((total, sent) => total + sent.amount, 0)
const refusal = () => fakeStripeErrors.invalid('charge_disputed', 'This charge is disputed.')

/** `stripe`, with `gap` run once inside its next refund: after R1 has committed and before Stripe answers. */
function whileTheRefundIsOnItsWay(stripe: FakeStripe, gap: () => Promise<void>): FakeStripe {
  let ran = false
  return new Proxy(stripe, {
    get(target, property, receiver) {
      if (property !== 'refunds') return Reflect.get(target, property, receiver) as unknown
      const refunds = target.refunds
      return new Proxy(refunds, {
        get(inner, method, innerReceiver) {
          if (method !== 'create') return Reflect.get(inner, method, innerReceiver) as unknown
          return async (...sent: unknown[]): Promise<unknown> => {
            if (!ran) {
              ran = true
              await gap()
            }
            return Reflect.apply(inner.create as (...all: unknown[]) => Promise<unknown>, inner, sent)
          }
        },
      })
    },
  })
}

describe('POST /events/:id/cancel and GET /events/:id/cancel/overview (brief W31 items 1 and 2)', () => {
  it('the overview before anything: three bookings (card, cash, gift card) with each one\'s full refund, the totals, nothing pending, not ended, not cancelled; the contract declares every field', async () => {
    await onTheEvent(async ({ samOnCard, moInCash, giaOnGiftCard }) => {
      const sam = await samOnCard()
      const mo = await moInCash()
      const gia = await giaOnGiftCard()
      const answer = await overview()
      expect(answer.status).toBe(200)
      expect(answer.body.data).toEqual({
        eventName: 'Full Moon Sauna',
        ended: false,
        cancelledAt: null,
        cancelReason: null,
        pendingCustomers: [],
        bookings: [
          { eventBookingId: sam.eventBookingId, customerName: 'Sam Test', places: 2, value: 80, problem: null },
          { eventBookingId: mo.eventBookingId, customerName: 'Mo Member', places: 1, value: 20, problem: null },
          { eventBookingId: gia.eventBookingId, customerName: 'Gia Gift', places: 1, value: 40, problem: null },
        ],
        totalPlaces: 4,
        totalValue: 140,
      })
      // No undeclared field: the staff app's types are generated from the contract.
      expect(() => eventCancelOverviewOutputSchema.extend({ bookings: eventCancelOverviewBookingSchema.strict().array() }).strict().parse(answer.body.data)).not.toThrow()
    })
  })

  it('an event that is gone answers NOT_FOUND from both routes, with the old words (W27 "Noticed" 3: the old overview answered null)', async () => {
    await onTheEvent(async () => {
      const read = await overview(UNKNOWN)
      expect([read.status, read.body.error?.code, read.body.error?.details]).toEqual([404, 'NOT_FOUND', { reason: 'event_not_found', message: WORDS.eventNotFound, action: 'overview' }])
      const cancel = await cancelTheEvent(undefined, { eventId: UNKNOWN })
      expect([cancel.status, cancel.body.error?.code, cancel.body.error?.details]).toEqual([404, 'NOT_FOUND', { reason: 'event_not_found', message: WORDS.eventNotFound, action: 'cancel_event' }])
    })
  })

  it("the old refusals, in the old words, before anything is changed: a choice that isn't Card or Store credit (cash too: Q42), and no reason", async () => {
    await onTheEvent(async ({ samOnCard }) => {
      await samOnCard()
      for (const refund of ['none', 'cash', undefined]) {
        const answer = await cancelTheEvent({ ...(refund ? { refund } : {}), reason: 'Storm' })
        expect([answer.status, answer.body.error?.details?.reason, answer.body.error?.details?.message], String(refund)).toEqual([400, 'invalid_params', WORDS.chooseRefund])
      }
      for (const reason of ['   ', null, undefined]) {
        const answer = await cancelTheEvent({ refund: 'card', ...(reason !== undefined ? { reason } : {}) })
        expect([answer.status, answer.body.error?.details?.reason, answer.body.error?.details?.message], String(reason)).toEqual([400, 'invalid_params', WORDS.reasonNeeded])
      }
      expect(await eventRow()).toMatchObject({ active: true, cancelled: false, places_booked: 2 })
      expect(await auditRows(EVENT_CANCELLED)).toHaveLength(0)
    })
  })

  it('who may: Issue refunds (the old words); and with event cancels switched off the event is not cancelled either (the bookings could not be refunded)', async () => {
    await onTheEvent(async ({ samOnCard }) => {
      await samOnCard()
      const off = await cancelTheEvent(undefined, { orderSwitch: BOOKING_KINDS_ON })
      expect([off.status, off.body.error?.code, off.body.error?.message, off.body.error?.details?.kinds]).toEqual([501, 'REFUND_PATH_OFF', REFUND_PATH_OFF_MESSAGE, ['event_cancels']])
      await db.query('UPDATE staff SET can_issue_refunds = false WHERE id = $1', [ID.staff])
      const denied = await cancelTheEvent()
      expect([denied.status, denied.body.error?.code, denied.body.error?.message]).toEqual([403, 'FORBIDDEN', 'Needs Issue refunds permission — this action moves money back to the customer.'])
      // The overview is a read: open to any active staff member.
      expect((await overview()).status).toBe(200)
      expect(await eventRow()).toMatchObject({ active: true, cancelled: false })
      expect(await auditRows(EVENT_CANCELLED)).toHaveLength(0)
    })
  })

  it('ended: an event that has ended is refused (event_ended) and left as it was; the overview says it has ended', async () => {
    await onTheEvent(async ({ samOnCard }) => {
      await samOnCard()
      later(22 * 24 * 60 * 60 * 1000)
      expect((await overview()).body.data).toMatchObject({ ended: true, cancelledAt: null })
      const answer = await cancelTheEvent()
      expect([answer.status, answer.body.error?.details]).toEqual([409, { reason: 'event_ended', message: WORDS.eventEnded, action: 'cancel_event' }])
      expect(await eventRow()).toMatchObject({ active: true, cancelled: false, places_booked: 2 })
    })
  })

  it('ended after it was cancelled: the second run is still allowed, so the bookings left can be finished', async () => {
    await onTheEvent(async ({ samOnCard }) => {
      const sam = await samOnCard()
      expect((await cancelTheEvent()).status).toBe(200)
      later(22 * 24 * 60 * 60 * 1000)
      const again = await cancelTheEvent()
      expect(again.status).toBe(200)
      expect(again.body.data).toMatchObject({ ended: true, cancelReason: 'Storm', bookings: [{ eventBookingId: sam.eventBookingId, value: 80 }] })
    })
  })

  it('a payment in progress: refused (bookings_pending) naming the customer, the event left on sale; once the tap is finished the event can be cancelled', async () => {
    await onTheEvent(async ({ call, stripe, moInCash }) => {
      await moInCash()
      const pending = (await call('createOrder', { customerId: ID.customer, event: eventFor([samAttending, alexGuest]), payment: { method: 'reader' } })) as { orderId: string; pendingReaderPayment: { paymentIntentId: string } }
      expect((await overview()).body.data).toMatchObject({ pendingCustomers: ['Sam Test'], bookings: [{ customerName: 'Mo Member', value: 20 }], totalPlaces: 1 })
      const refused = await cancelTheEvent()
      expect([refused.status, refused.body.error?.details]).toEqual([409, { reason: 'bookings_pending', message: WORDS.bookingsPending(['Sam Test']), action: 'cancel_event' }])
      expect(await eventRow()).toMatchObject({ active: true, cancelled: false, places_booked: 3 })
      expect(await auditRows(EVENT_CANCELLED)).toHaveLength(0)
      stripe.completeReaderPayment(pending.pendingReaderPayment.paymentIntentId)
      await call('finaliseReaderOrder', { orderId: pending.orderId })
      const cancelled = await cancelTheEvent()
      expect(cancelled.status).toBe(200)
      expect(cancelled.body.data).toMatchObject({ pendingCustomers: [], totalPlaces: 3, totalValue: 100 })
    })
  })

  it('the cancel itself: one step, no money moved. Off sale and cancelled, who and why, one audit row; it answers the bookings still to cancel; a second run keeps the first reason and writes no second row', async () => {
    await onTheEvent(async ({ samOnCard, moInCash, stripe }) => {
      const sam = await samOnCard()
      const mo = await moInCash()
      const sent = refundsSent(stripe).length
      const answer = await cancelTheEvent({ refund: 'credit', reason: '  Storm  ' })
      expect(answer.status).toBe(200)
      expect(() => cancelEventOutputSchema.strict().parse(answer.body.data)).not.toThrow()
      expect(answer.body.data).toMatchObject({
        eventName: 'Full Moon Sauna',
        ended: false,
        cancelReason: 'Storm',
        pendingCustomers: [],
        bookings: [
          { eventBookingId: sam.eventBookingId, customerName: 'Sam Test', places: 2, value: 80, problem: null },
          { eventBookingId: mo.eventBookingId, customerName: 'Mo Member', places: 1, value: 20, problem: null },
        ],
        totalPlaces: 3,
        totalValue: 100,
      })
      expect(typeof answer.body.data?.cancelledAt).toBe('string')
      expect(await eventRow()).toEqual({ active: false, cancelled: true, cancel_reason: 'Storm', cancelled_by: ID.staff, places_booked: 3 })
      // Nothing else moved: no refund, no store credit, no booking touched.
      expect(refundsSent(stripe).length).toBe(sent)
      expect(await creditRefunds()).toHaveLength(0)
      expect(await bookingRow(sam.eventBookingId)).toMatchObject({ status: 'confirmed', places: 2 })
      const rows = await auditRows(EVENT_CANCELLED)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ entity_id: ID.event, actor_id: ID.staff, details: { reason: 'Storm', bookings: 2, places: 3, value: 100 } })
      // The second run: an hour later, by another member of staff, with another reason. Who first cancelled the
      // event, when and why all stay as they were.
      const firstAt = (await db.query<{ at: string }>('SELECT cancelled_at::text AS at FROM events WHERE id = $1', [ID.event]))[0]?.at
      expect(firstAt).toBeTruthy()
      await insert(db, 'staff', { role: 'staff', first_name: 'Al', last_name: 'Other', email: 'al@example.com', can_issue_refunds: true })
      later(60 * 60 * 1000)
      const again = await cancelTheEvent({ refund: 'card', reason: 'A different reason on the retry' }, { email: 'al@example.com' })
      expect(again.status).toBe(200)
      expect(again.body.data).toMatchObject({ cancelReason: 'Storm', totalPlaces: 3, cancelledAt: answer.body.data?.cancelledAt })
      expect(await eventRow()).toMatchObject({ cancel_reason: 'Storm', cancelled_by: ID.staff })
      expect((await db.query<{ at: string }>('SELECT cancelled_at::text AS at FROM events WHERE id = $1', [ID.event]))[0]?.at).toBe(firstAt)
      expect(await auditRows(EVENT_CANCELLED)).toHaveLength(1)
    })
  })
})

describe('`wholeEvent` on the place cancel (brief W31 item 3; W30 "For the Worker step" 1, review L2)', () => {
  it('refused on a live event (event_not_cancelled), whatever the cut-off: nothing is cancelled and nothing is sent; an ordinary cancel after the cut-off still needs its reason', async () => {
    await onTheEvent(async ({ samOnCard, stripe }) => {
      const sam = await samOnCard()
      // After the cut-off: the very rule a screen might try to skip.
      await db.query("UPDATE events SET refund_cutoff_at = '2026-11-09 09:00:00+00' WHERE id = $1", [ID.event])
      const sent = refundsSent(stripe).length
      const refused = await press(sam.eventBookingId, { refund: 'card', wholeEvent: true, confirmed: { refund: 80 } })
      expect([refused.status, refused.body.error?.code, refused.body.error?.details?.reason, refused.body.error?.details?.message]).toEqual([409, 'CONFLICT', 'event_not_cancelled', NEW_WORDS.eventNotCancelled])
      const withReason = await press(sam.eventBookingId, { refund: 'credit', wholeEvent: true, reason: 'Trying it on', confirmed: { refund: 80 } })
      expect(withReason.body.error?.details?.reason).toBe('event_not_cancelled')
      const ordinary = await press(sam.eventBookingId, { refund: 'card', confirmed: { refund: 80 } })
      expect(ordinary.body.error?.details).toMatchObject({ reason: 'reason_required_after_cutoff', message: PLACE_WORDS.reasonRequiredAfterCutoff })
      expect(await bookingRow(sam.eventBookingId)).toMatchObject({ status: 'confirmed', places: 2 })
      expect((await placeRows(sam.eventBookingId)).every((row) => !row.cancelled)).toBe(true)
      expect(await eventRow()).toMatchObject({ places_booked: 2, cancelled: false })
      expect(refundsSent(stripe).length).toBe(sent)
      expect(await auditRows('event_booking.refund_claimed')).toHaveLength(0)
    })
  })

  it('needs Issue refunds and the switch whatever choice is sent; Card or Store credit only (Q42: not cash, not No refund), in the old words', async () => {
    await onTheEvent(async ({ moInCash }) => {
      const mo = await moInCash()
      expect((await cancelTheEvent()).status).toBe(200)
      for (const refund of ['cash', 'none', 'voucher']) {
        const answer = await press(mo.eventBookingId, { refund, wholeEvent: true, confirmed: { refund: refund === 'none' ? 0 : 20 } })
        expect([answer.status, answer.body.error?.details?.reason, answer.body.error?.details?.message], refund).toEqual([400, 'invalid_params', WORDS.chooseRefund])
      }
      const off = await press(mo.eventBookingId, { refund: 'none', wholeEvent: true, confirmed: { refund: 0 } }, { orderSwitch: BOOKING_KINDS_ON })
      expect([off.status, off.body.error?.code]).toEqual([501, 'REFUND_PATH_OFF'])
      await db.query('UPDATE staff SET can_issue_refunds = false WHERE id = $1', [ID.staff])
      // No refund is open to all staff on an ordinary cancel; with `wholeEvent` it is not.
      const denied = await press(mo.eventBookingId, { refund: 'none', wholeEvent: true, confirmed: { refund: 0 } })
      expect([denied.status, denied.body.error?.code]).toEqual([403, 'FORBIDDEN'])
      expect(await bookingRow(mo.eventBookingId)).toMatchObject({ status: 'confirmed', places: 1 })
      expect(await creditRefunds()).toHaveLength(0)
    })
  })

  it('the whole run, one booking per press: card to the card, cash and gift card to store credit (Q42), after the cut-off with no reason asked, each with its own claim; the event ends with no places booked and nothing still to cancel', async () => {
    await onTheEvent(async ({ samOnCard, moInCash, giaOnGiftCard, stripe }) => {
      const sam = await samOnCard()
      const mo = await moInCash()
      const gia = await giaOnGiftCard()
      // After the cut-off: a whole-event cancel has no cut-off rule.
      await db.query("UPDATE events SET refund_cutoff_at = '2026-11-09 09:00:00+00' WHERE id = $1", [ID.event])
      const cancelled = await cancelTheEvent()
      const bookings = cancelled.body.data?.bookings ?? []
      expect(bookings.map((booking) => [booking.customerName, booking.value])).toEqual([
        ['Sam Test', 80],
        ['Mo Member', 20],
        ['Gia Gift', 40],
      ])
      const before = moneyBack(stripe)
      const answers: Answer[] = []
      for (const booking of bookings) answers.push(await wholePress(booking))
      expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200])
      expect(answers.map((answer) => [answer.body.data?.['places'], answer.body.data?.['refundedAmount'], answer.body.data?.['cardRefundedAmount'], answer.body.data?.['storeCreditRefundedAmount']])).toEqual([
        [2, 80, 80, 0],
        [1, 20, 0, 20],
        [1, 40, 0, 40],
      ])
      // The contract holds every field the press answers.
      for (const answer of answers) {
        expect(() => cancelEventPlacesOutputSchema.extend({ booking: eventAttendeeBookingSchema.extend({ attendees: eventAttendeeRowSchema.strict().array() }).strict().nullable() }).strict().parse(answer.body.data)).not.toThrow()
      }
      expect(moneyBack(stripe) - before).toBe(8000)
      expect((await creditRefunds()).map((row) => [row.customer_id, row.amount])).toEqual([
        [ID.member, '20.00'],
        [GIA, '40.00'],
      ])
      // No cash is ever handed back by a whole-event cancel, and nothing is marked as a refund after the cut-off.
      for (const booked of [sam, mo, gia]) {
        expect(await bookingRow(booked.eventBookingId)).toMatchObject({ status: 'cancelled', places: 0, cancel_reason: 'Storm' })
        for (const row of await placeRows(booked.eventBookingId)) expect(row).toMatchObject({ cancelled: true, after: false, reason: 'Storm' })
      }
      expect((await placeRows(sam.eventBookingId)).map((row) => [row.refunded, row.card, row.method])).toEqual([
        ['40.00', '40.00', 'card'],
        ['40.00', '40.00', 'card'],
      ])
      expect((await placeRows(mo.eventBookingId)).map((row) => [row.refunded, row.method])).toEqual([['20.00', 'credit']])
      expect((await placeRows(gia.eventBookingId)).map((row) => [row.refunded, row.method])).toEqual([['40.00', 'credit']])
      expect((await orderRow(sam.orderId))?.payment_status).toBe('refunded')
      // One claim per booking, each on its own event booking; each cancel's row says it was the whole event.
      const claims = await auditRows('event_booking.refund_claimed')
      // (Compared sorted: rows written back to back can share a millisecond on the tests' database.)
      expect(claims.map((row) => row.entity_id).sort()).toEqual([sam.eventBookingId, mo.eventBookingId, gia.eventBookingId].sort())
      expect(claims.map((row) => row.details['cancel'] as { wholeEvent?: boolean; eventCancelled?: boolean; afterCutoff?: boolean }).map((cancel) => [cancel.wholeEvent, cancel.eventCancelled, cancel.afterCutoff])).toEqual([
        [true, true, false],
        [true, true, false],
        [true, true, false],
      ])
      expect((await auditRows('event_booking.cancel_places')).map((row) => [row.details['wholeEvent'], row.details['afterCutoff'], row.details['reason']])).toEqual([
        [true, false, 'Storm'],
        [true, false, 'Storm'],
        [true, false, 'Storm'],
      ])
      expect(await eventRow()).toMatchObject({ active: false, cancelled: true, places_booked: 0 })
      expect((await overview()).body.data).toMatchObject({ bookings: [], totalPlaces: 0, totalValue: 0, cancelReason: 'Storm' })
    })
  })

  it("an ordinary place cancel's row never says wholeEvent, and `attendeeIds` sent with wholeEvent are not a way to pick places: the whole booking goes", async () => {
    await onTheEvent(async ({ samOnCard }) => {
      const sam = await samOnCard()
      const [first] = (await placeRows(sam.eventBookingId)).map((row) => row.id)
      expect((await cancelTheEvent()).status).toBe(200)
      const answer = await press(sam.eventBookingId, { attendeeIds: [first], refund: 'credit', wholeEvent: true, confirmed: { refund: 80 } })
      expect(answer.body.data).toMatchObject({ places: 2, storeCreditRefundedAmount: 80 })
      expect(await bookingRow(sam.eventBookingId)).toMatchObject({ status: 'cancelled', places: 0 })
    })
    await onTheEvent(async ({ samOnCard }) => {
      const sam = await samOnCard()
      const answer = await press(sam.eventBookingId, { refund: 'credit', confirmed: { refund: 80 } })
      expect(answer.status).toBe(200)
      expect('wholeEvent' in ((await auditRows('event_booking.cancel_places'))[0]?.details ?? {})).toBe(false)
    })
  })

  it("the overview's figure is what the screen confirms (Q18): a place cancelled in another tab since the overview refuses the press (figures_changed) with the quote as it now stands, and nothing more goes", async () => {
    await onTheEvent(async ({ samOnCard, stripe }) => {
      const sam = await samOnCard()
      const [first] = (await placeRows(sam.eventBookingId)).map((row) => row.id)
      const cancelled = await cancelTheEvent()
      const shown = cancelled.body.data?.bookings[0] as OverviewBooking
      expect(shown.value).toBe(80)
      // Another tab: one place cancelled from the attendee list with no refund.
      expect((await press(sam.eventBookingId, { attendeeIds: [first], refund: 'none', confirmed: { refund: 0 } })).status).toBe(200)
      const sent = refundsSent(stripe).length
      const stale = await wholePress(shown)
      expect([stale.status, stale.body.error?.details?.reason, stale.body.error?.details?.message, stale.body.error?.details?.quote?.value]).toEqual([409, 'figures_changed', PLACE_NEW_WORDS.figuresChanged, 40])
      expect(refundsSent(stripe).length).toBe(sent)
      expect(await bookingRow(sam.eventBookingId)).toMatchObject({ status: 'confirmed', places: 1 })
      // Retry: the event's cancel answers the figure as it now stands, and that press goes.
      const fresh = (await cancelTheEvent()).body.data?.bookings[0] as OverviewBooking
      expect(fresh).toMatchObject({ places: 1, value: 40 })
      expect((await wholePress(fresh)).body.data).toMatchObject({ places: 1, cardRefundedAmount: 40 })
      // And with no figure at all, nothing is cancelled.
    })
    await onTheEvent(async ({ moInCash }) => {
      const mo = await moInCash()
      await cancelTheEvent()
      const none = await press(mo.eventBookingId, { refund: 'card', wholeEvent: true })
      expect(none.body.error?.details?.reason).toBe('amount_not_confirmed')
      expect(await bookingRow(mo.eventBookingId)).toMatchObject({ status: 'confirmed' })
    })
  })

  it('a booking with a checked-in place is listed with its problem and left; the others go; once the check-in is undone, Retry cancels it, keeping the first reason (bug E6: one press per booking)', async () => {
    await onTheEvent(async ({ samOnCard, moInCash }) => {
      const sam = await samOnCard()
      const mo = await moInCash()
      const [first] = (await placeRows(sam.eventBookingId)).map((row) => row.id)
      await db.query('UPDATE event_attendees SET checked_in_at = now() WHERE id = $1', [first])
      expect((await overview()).body.data?.bookings[0]).toMatchObject({ eventBookingId: sam.eventBookingId, places: 2, value: 0, problem: EVENT_OVERVIEW_WORDS.placeCheckedIn })
      const cancelled = await cancelTheEvent()
      const bookings = cancelled.body.data?.bookings ?? []
      expect(bookings.map((booking) => booking.problem)).toEqual([EVENT_OVERVIEW_WORDS.placeCheckedIn, null])
      // The screen presses every booking listed; the Worker answers for each.
      const samPress = await wholePress(bookings[0] as OverviewBooking)
      expect([samPress.status, samPress.body.error?.details?.reason, samPress.body.error?.details?.message]).toEqual([409, 'attendee_checked_in', EVENT_QUOTE_REFUSALS['attendee_checked_in']?.message])
      expect((await wholePress(bookings[1] as OverviewBooking)).body.data).toMatchObject({ places: 1, storeCreditRefundedAmount: 20 })
      expect(await bookingRow(sam.eventBookingId)).toMatchObject({ status: 'confirmed', places: 2 })
      expect(await bookingRow(mo.eventBookingId)).toMatchObject({ status: 'cancelled' })
      expect(await eventRow()).toMatchObject({ cancelled: true, places_booked: 2 })
      // Still listed and left, with its problem.
      expect((await overview()).body.data?.bookings).toEqual([{ eventBookingId: sam.eventBookingId, customerName: 'Sam Test', places: 2, value: 0, problem: EVENT_OVERVIEW_WORDS.placeCheckedIn }])
      // The check-in is undone; Retry.
      await db.query('UPDATE event_attendees SET checked_in_at = NULL WHERE id = $1', [first])
      const retry = await cancelTheEvent({ refund: 'card', reason: 'A different reason on the retry' })
      expect(retry.body.data).toMatchObject({ cancelReason: 'Storm', bookings: [{ eventBookingId: sam.eventBookingId, places: 2, value: 80, problem: null }] })
      expect((await wholePress(retry.body.data?.bookings[0] as OverviewBooking, 'card', { reason: 'A different reason on the retry' })).body.data).toMatchObject({ places: 2, cardRefundedAmount: 80 })
      expect(await eventRow()).toMatchObject({ places_booked: 0, cancel_reason: 'Storm' })
      expect(await auditRows(EVENT_CANCELLED)).toHaveLength(1)
    })
  })

  it('a retry: one booking\'s card refund is refused by Stripe, so it is put back and listed as failed while the rest go; Retry then refunds it once; the same press sent twice under one key refunds once', async () => {
    await onTheEvent(async ({ samOnCard, moInCash, stripe }) => {
      const sam = await samOnCard()
      const mo = await moInCash()
      const bookings = (await cancelTheEvent()).body.data?.bookings ?? []
      const before = moneyBack(stripe)
      stripe.failNext('refunds.create', { kind: 'error', error: refusal() })
      const failed = await wholePress(bookings[0] as OverviewBooking)
      expect([failed.status, failed.body.error?.details?.reason, failed.body.error?.details?.message]).toEqual([402, 'refund_failed', PLACE_WORDS.cardRefundFailed('Failed to refund payment: This charge is disputed.')])
      expect((await wholePress(bookings[1] as OverviewBooking)).status).toBe(200)
      // Put back: still confirmed, on the cancelled event, and still listed.
      expect(await bookingRow(sam.eventBookingId)).toMatchObject({ status: 'confirmed', places: 2 })
      expect(await bookingRow(mo.eventBookingId)).toMatchObject({ status: 'cancelled' })
      expect(await eventRow()).toMatchObject({ cancelled: true, places_booked: 2 })
      expect(moneyBack(stripe)).toBe(before)
      const left = (await cancelTheEvent()).body.data?.bookings ?? []
      expect(left).toEqual([{ eventBookingId: sam.eventBookingId, customerName: 'Sam Test', places: 2, value: 80, problem: null }])
      const key = crypto.randomUUID()
      const went = await wholePress(left[0] as OverviewBooking, 'card', {}, { key })
      const same = await wholePress(left[0] as OverviewBooking, 'card', {}, { key })
      expect(went.body.data).toMatchObject({ places: 2, cardRefundedAmount: 80 })
      expect(same.body.data).toEqual(went.body.data)
      expect(moneyBack(stripe) - before).toBe(8000)
      expect(await auditRows('event_booking.refund_claimed')).toHaveLength(3)
      expect(await eventRow()).toMatchObject({ places_booked: 0 })
    })
  })

  it('money owed on a booking\'s order shows on the overview: a place whose card refund was refused after its place was resold (Q39), then the event cancelled', async () => {
    await onTheEvent(async ({ samOnCard, stripe }) => {
      const sam = await samOnCard()
      const [first] = (await placeRows(sam.eventBookingId)).map((row) => row.id)
      await db.query('UPDATE events SET capacity = 2 WHERE id = $1', [ID.event])
      stripe.failNext('refunds.create', { kind: 'error', error: refusal() })
      const options: EventCancelOptions = {
        actor: { type: 'staff', id: ID.staff },
        requestId: crypto.randomUUID(),
        // The released place is booked by someone else before Stripe answers.
        stripe: () =>
          whileTheRefundIsOnItsWay(stripe, async () => {
            await db.query('UPDATE events SET places_booked = places_booked + 1 WHERE id = $1', [ID.event])
          }),
      }
      const stands = await cancelEventPlaces(db, sam.eventBookingId, { attendeeIds: [first as string], refund: 'card', confirmed: { refund: 40 } }, options)
      expect(stands).toMatchObject({ places: 1, refundOwed: 40 })
      const answer = await cancelTheEvent()
      expect(answer.body.data?.bookings).toEqual([{ eventBookingId: sam.eventBookingId, customerName: 'Sam Test', places: 1, value: 40, problem: null, refundOwed: 40 }])
      const read = await overview()
      expect(read.body.data?.bookings[0]).toMatchObject({ refundOwed: 40 })
      // The contract declares the money owed too (the staff app's types are generated from it): no undeclared field
      // in either answer, with the field there.
      for (const data of [answer.body.data, read.body.data]) {
        expect(() => eventCancelOverviewOutputSchema.extend({ bookings: eventCancelOverviewBookingSchema.strict().array() }).strict().parse(data)).not.toThrow()
      }
      expect(Object.keys(eventCancelOverviewBookingSchema.shape)).toContain('refundOwed')
    })
  })
})

describe("review L1 (W30 review, must): an undo after a refused card refund never puts places back, or the booking back to confirmed, on an event cancelled since R1", () => {
  it("the review's race, the whole booking: the card part is on its way, the whole-event cancel commits, the booking's own whole-event press is refused (refund_open), then Stripe refuses. The cancel stands, the booking stays cancelled, and the £80 is owed on the order; Refund the rest then gives it", async () => {
    await onTheEvent(async ({ samOnCard, stripe }) => {
      const sam = await samOnCard()
      const before = moneyBack(stripe)
      stripe.failNext('refunds.create', { kind: 'error', error: refusal() })
      let listed: OverviewBooking[] = []
      let pressedMeanwhile: Answer | null = null
      const options: EventCancelOptions = {
        actor: { type: 'staff', id: ID.staff },
        requestId: crypto.randomUUID(),
        stripe: () =>
          whileTheRefundIsOnItsWay(stripe, async () => {
            // R1 has committed: the booking's places are cancelled and released, its claim open.
            expect(await bookingRow(sam.eventBookingId)).toMatchObject({ status: 'cancelled', places: 0 })
            const cancelled = await cancelTheEvent()
            expect(cancelled.status).toBe(200)
            listed = cancelled.body.data?.bookings ?? []
            // What the screen would do for a booking it had listed before: its press is refused while the claim is open.
            pressedMeanwhile = await press(sam.eventBookingId, { refund: 'card', wholeEvent: true, confirmed: { refund: 80 } })
          }),
      }
      const stands = await cancelEventPlaces(db, sam.eventBookingId, { refund: 'card', confirmed: { refund: 80 } }, options)
      // The booking was already cancelled by R1, so the event's cancel listed nothing for it.
      expect(listed).toEqual([])
      const meanwhile = pressedMeanwhile as Answer | null
      expect([meanwhile?.status, meanwhile?.body.error?.details?.reason, meanwhile?.body.error?.details?.message]).toEqual([409, 'refund_open', EVENT_BOOKING_REFUND_OPEN_MESSAGE])
      // Stripe refused. Before W31 the undo put both places back and set the booking confirmed again, on a cancelled event.
      expect(stands).toMatchObject({ places: 2, refundedAmount: 0, cardRefundedAmount: 0, storeCreditRefundedAmount: 0, refundOwed: 80 })
      expect(stands.held).toMatchObject({ reason: 'refund_refused_not_put_back', message: PLACE_NEW_WORDS.putBackEventCancelled('Failed to refund payment: This charge is disputed.', 80) })
      expect(stands.held?.message).toBe(
        "The card refund was refused (Failed to refund payment: This charge is disputed.), so it didn't go back to the card, and the places can't be put back: the event has been cancelled since. The cancellation stands, and £80.00 shows on this booking as still to refund. Use Refund the rest to give it another way."
      )
      expect(await bookingRow(sam.eventBookingId)).toMatchObject({ status: 'cancelled', places: 0 })
      expect((await placeRows(sam.eventBookingId)).map((row) => [row.cancelled, row.value, row.refunded, row.card])).toEqual([
        [true, '40.00', '0.00', '0.00'],
        [true, '40.00', '0.00', '0.00'],
      ])
      expect(await eventRow()).toMatchObject({ active: false, cancelled: true, places_booked: 0 })
      expect(await orderRow(sam.orderId)).toMatchObject({ owed: '80.00' })
      expect(await creditRefunds()).toHaveLength(0)
      expect(moneyBack(stripe)).toBe(before)
      const finished = await auditRows('event_booking.refund_finished')
      expect(finished).toHaveLength(1)
      expect(finished[0]?.details).toMatchObject({ outcome: 'owed', owed: 80, cardRefunded: 0, refused: 'Failed to refund payment: This charge is disputed.', by: { how: 'undo_blocked' } })
      // Nothing is left to cancel; the money owed is given from the attendee list's bar (Refund the rest), once.
      expect((await overview()).body.data?.bookings).toEqual([])
      const rest = await withSwitch(EVENT_KINDS_ON, async () => {
        const response = await (orderOwedRoute as Handler)(
          new Request(`https://worker.test/api/v1/staff/orders/${sam.orderId}/refunds/owed`, { method: 'POST', headers: headers(REPLAY_USER.email, crypto.randomUUID()), body: JSON.stringify({ amount: 80, refundMethod: 'card' }) }),
          { params: Promise.resolve({ orderId: sam.orderId }) }
        )
        return (await response.json()) as Answer['body']
      })
      expect(rest.data).toMatchObject({ cardRefundedAmount: 80, refundOwed: 0 })
      expect(moneyBack(stripe) - before).toBe(8000)
    })
  })

  it('the same with one place of two, and store credit in the plan: the place stays cancelled and released, its £10 of store credit is given and named, £30 is owed, and the booking keeps its other place, which the whole-event run then cancels', async () => {
    await onTheEvent(async ({ call, stripe }) => {
      // Two places (£80) paid £60 on the card and £20 with store credit.
      const placed = (await call('createOrder', { customerId: ID.customer, event: eventFor([samAttending, alexGuest]), payment: { method: 'card', storeCredit: { amount: 20 } } })) as Record<string, unknown>
      expect(placed['success']).toBe(true)
      const sam = { orderId: String(placed['orderId']), eventBookingId: String(placed['eventBookingId']) }
      const [first] = (await placeRows(sam.eventBookingId)).map((row) => row.id)
      const before = moneyBack(stripe)
      stripe.failNext('refunds.create', { kind: 'error', error: refusal() })
      const options: EventCancelOptions = {
        actor: { type: 'staff', id: ID.staff },
        requestId: crypto.randomUUID(),
        stripe: () =>
          whileTheRefundIsOnItsWay(stripe, async () => {
            expect((await cancelTheEvent()).status).toBe(200)
          }),
      }
      const stands = await cancelEventPlaces(db, sam.eventBookingId, { attendeeIds: [first as string], refund: 'card', confirmed: { refund: 40 } }, options)
      const owed = Number(stands.refundOwed)
      const credit = stands.storeCreditRefundedAmount
      // Whatever the split of this place's £40, the card part is owed and the rest was given as store credit, once.
      expect(owed + credit).toBe(40)
      expect(owed).toBeGreaterThan(0)
      expect(stands.held?.message).toBe(PLACE_NEW_WORDS.putBackEventCancelled('Failed to refund payment: This charge is disputed.', owed, credit))
      expect((await creditRefunds()).map((row) => Number(row.amount))).toEqual(credit > 0 ? [credit] : [])
      expect(await bookingRow(sam.eventBookingId)).toMatchObject({ status: 'confirmed', places: 1 })
      expect((await placeRows(sam.eventBookingId)).map((row) => row.cancelled)).toEqual([true, false])
      // Released once and not taken again.
      expect(await eventRow()).toMatchObject({ cancelled: true, places_booked: 1 })
      expect(Number((await orderRow(sam.orderId))?.owed)).toBe(owed)
      expect(moneyBack(stripe)).toBe(before)
      // The whole-event run finds the place left, with the money owed beside it, and cancels it.
      const left = (await cancelTheEvent()).body.data?.bookings ?? []
      expect(left).toEqual([{ eventBookingId: sam.eventBookingId, customerName: 'Sam Test', places: 1, value: 40, problem: null, refundOwed: owed }])
      expect((await wholePress(left[0] as OverviewBooking)).status).toBe(200)
      expect(await bookingRow(sam.eventBookingId)).toMatchObject({ status: 'cancelled', places: 0 })
      expect(await eventRow()).toMatchObject({ places_booked: 0 })
      // What is owed is still owed: the whole-event press never pays it over again.
      expect(Number((await orderRow(sam.orderId))?.owed)).toBe(owed)
    })
  })

  it('only "since R1": a refusal on a live event still puts the places back (W30); and so does one on an event that was already cancelled when the places were (an ordinary cancel from the attendee list, or the whole-event run\'s own press), so the booking is still to cancel and can be pressed again', async () => {
    await onTheEvent(async ({ samOnCard, stripe }) => {
      const sam = await samOnCard()
      stripe.failNext('refunds.create', { kind: 'error', error: refusal() })
      const refused = await press(sam.eventBookingId, { refund: 'card', confirmed: { refund: 80 } })
      expect(refused.body.error?.details?.reason).toBe('refund_failed')
      expect(await bookingRow(sam.eventBookingId)).toMatchObject({ status: 'confirmed', places: 2 })
      expect(await eventRow()).toMatchObject({ cancelled: false, places_booked: 2 })
      expect(await orderRow(sam.orderId)).toMatchObject({ owed: '0.00' })
      // The live event's claim never says the event was cancelled.
      expect('eventCancelled' in (((await auditRows('event_booking.refund_claimed'))[0]?.details['cancel'] ?? {}) as object)).toBe(false)
    })
    await onTheEvent(async ({ samOnCard, stripe }) => {
      const sam = await samOnCard()
      const [first] = (await placeRows(sam.eventBookingId)).map((row) => row.id)
      expect((await cancelTheEvent()).status).toBe(200)
      // An ordinary cancel of one place, from the attendee list, on the event already cancelled.
      stripe.failNext('refunds.create', { kind: 'error', error: refusal() })
      const refused = await press(sam.eventBookingId, { attendeeIds: [first], refund: 'card', confirmed: { refund: 40 } })
      expect([refused.status, refused.body.error?.details?.reason]).toEqual([402, 'refund_failed'])
      expect(await bookingRow(sam.eventBookingId)).toMatchObject({ status: 'confirmed', places: 2 })
      expect((await placeRows(sam.eventBookingId)).map((row) => row.cancelled)).toEqual([false, false])
      expect(await eventRow()).toMatchObject({ cancelled: true, places_booked: 2 })
      expect(await orderRow(sam.orderId)).toMatchObject({ owed: '0.00' })
      expect((await auditRows('event_booking.refund_finished'))[0]?.details).toMatchObject({ outcome: 'put_back' })
      expect((await overview()).body.data?.bookings).toEqual([{ eventBookingId: sam.eventBookingId, customerName: 'Sam Test', places: 2, value: 80, problem: null }])
    })
  })
})
