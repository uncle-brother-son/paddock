import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { POST as cancelRoute } from '@/app/api/v1/staff/bookings/[bookingId]/cancel-and-refund/route'
import { POST as cancelQuoteRoute } from '@/app/api/v1/staff/bookings/[bookingId]/cancel-and-refund/quote/route'
import { POST as creditRoute } from '@/app/api/v1/staff/bookings/[bookingId]/cancel-credit/route'
import { POST as creditQuoteRoute } from '@/app/api/v1/staff/bookings/[bookingId]/cancel-credit/quote/route'
import { POST as partRoute } from '@/app/api/v1/staff/bookings/[bookingId]/refunds/route'
import { POST as owedRoute } from '@/app/api/v1/staff/bookings/[bookingId]/refunds/owed/route'
import { POST as owedArrivedRoute } from '@/app/api/v1/staff/bookings/[bookingId]/refunds/owed-arrived/route'
import { POST as closeRoute } from '@/app/api/v1/staff/orders/stuck/close/route'
import type { Db } from '@/server/db'
import { reconcile } from '@/server/rules/orders/reconcile'
import { oldSide, replay, REPLAY_USER, startReplay, type ReplayEnvironment, type ScenarioContext } from '@/server/rules/testing/replay/harness'
import { bea, ID, memberCredit, mo, paidSeat, sam, seed, whileFailing } from '@/server/rules/testing/replay/scenarios'
import { replayStripe } from '@/server/rules/testing/replay/stripe-binding'
import { BOOKING_KINDS_ON } from '@/server/rules/testing/replay/booking-side'
import { fakeStripeErrors, type FakeStripe } from '@/server/stripe/fake'
import {
  ADDON_INSIDE_24_HOURS_NOTE,
  BOOKING_PATH_OFF_MESSAGE,
  CANCEL_CREDIT_WORDS,
  CANCEL_NOT_SAVED_MESSAGE,
  CHANGE_REFUND_UNCONFIRMED_MESSAGE,
  CLOSED_ON_A_CANCELLED_BOOKING_WORDS,
  ISSUE_REFUNDS_NEEDED_MESSAGE,
  OWED_ON_CANCELLED_STORE_CREDIT_ONLY_MESSAGE,
  PAID_GUESTS_REFUND_METHOD_MESSAGE,
  putBackBlockedMessage,
  cancelCreditGuestRefundFailedMessage,
  READER_PAYMENT_OPEN_MESSAGE,
  REFUND_OPEN_MESSAGE,
  REFUND_WORDS,
  WITHIN_24_HOURS_MESSAGE,
  CLUB_CANCEL_SESSION_STARTED_MESSAGE,
  cancelCreditAddonRefundFailedMessage,
  cardRefundFailedMessage,
  laterCardRefundFailedMessage,
  refundRefusedDetail,
} from './failure-messages'
import { claimRefundKey } from './refunds'

// Brief W23 items 1 to 4: Cancel & Refund, Cancel & return credit and Cancel (payment needed) on the Worker, through the
// routes as the staff app calls them, on the replay's live schema. The bookings are made by the old functions (the
// frozen copy). Stripe is only ever the fake. The replay's clock is 10 Nov 2026 09:00; the booking's session is
// 12 Nov 10:00.

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
const towel = { addonId: ID.addon, quantity: 1, unitPrice: 5, systemUnitPrice: 5 }

let environment: ReplayEnvironment
let db: Db
beforeAll(async () => {
  process.env.STAFF_API_KEY = KEY
  environment = await startReplay()
  db = environment.database.db
  holder.db = db
})
afterAll(() => environment.stop())

type Context = ScenarioContext & { bookingId: string }

/** A booking made by the old createOrder (and Add Guest), then `work` on it. `prepare` changes the seed first (W23a). */
async function withBooking(
  order: Record<string, unknown>,
  work: (context: Context) => Promise<void>,
  before?: (context: ScenarioContext & { bookingId: string }) => Promise<void>,
  prepare?: (db: Db) => Promise<void>
): Promise<void> {
  await replay(
    environment,
    {
      name: 'w23 cancel',
      async seed(seedDb, stripe) {
        await seed(seedDb, stripe)
        await prepare?.(seedDb)
      },
      async run(context) {
        replayStripe.current = context.stripe
        const placed = (await context.call('createOrder', { customerId: ID.customer, ...order })) as { bookingId: string }
        await before?.({ ...context, bookingId: placed.bookingId })
        vi.setSystemTime(Date.now() + 1000)
        try {
          await work({ ...context, bookingId: placed.bookingId })
        } finally {
          replayStripe.current = null
        }
      },
    },
    oldSide
  )
}

type Answer = {
  status: number
  body: {
    ok: boolean
    data?: Record<string, unknown> & { held?: { claimId: string; reason: string; message: string } }
    error?: { code: string; message: string; details?: Record<string, unknown> & { reason?: string; message?: string; cancelQuote?: Quote } }
  }
}
type Quote = { refund: number; owed: number; addonsRefund: number; parts: { card: number; storeCredit: number }; cardRefundAvailable: boolean; insideTwentyFourHours: boolean; blocked: { reason: string; message: string } | null; addonLineIds: string[]; paidLine: string }

async function post(route: typeof cancelRoute, url: string, bookingId: string, body: unknown, { key = crypto.randomUUID(), orderSwitch = BOOKING_KINDS_ON, email = REPLAY_USER.email } = {}): Promise<Answer> {
  const before = process.env.ORDER_SWITCH
  process.env.ORDER_SWITCH = orderSwitch
  try {
    const response = await route(
      new Request(`https://worker.test${url}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${KEY}`, 'x-staff-email': email, 'idempotency-key': key, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ bookingId }) }
    )
    return { status: response.status, body: (await response.json()) as Answer['body'] }
  } finally {
    if (before === undefined) delete process.env.ORDER_SWITCH
    else process.env.ORDER_SWITCH = before
  }
}

const base = (bookingId: string) => `/api/v1/staff/bookings/${bookingId}`
/** W23a: `club` asks as Block Session and Block Day do (`clubCancelled: true`). */
const club = (clubCancelled: boolean) => (clubCancelled ? { clubCancelled: true } : {})
const quote = async (bookingId: string, addonLineIds: string[] = [], clubCancelled = false): Promise<Quote> => {
  const answer = await post(cancelQuoteRoute, `${base(bookingId)}/cancel-and-refund/quote`, bookingId, { addonLineIds, ...club(clubCancelled) })
  if (!answer.body.data) throw new Error(JSON.stringify(answer.body))
  return answer.body.data as unknown as Quote
}
const creditQuote = async (bookingId: string, addonLineIds: string[] = [], clubCancelled = false): Promise<Quote> => {
  const answer = await post(creditQuoteRoute, `${base(bookingId)}/cancel-credit/quote`, bookingId, { addonLineIds, ...club(clubCancelled) })
  if (!answer.body.data) throw new Error(JSON.stringify(answer.body))
  return answer.body.data as unknown as Quote
}
/** Cancel & Refund as the dialog presses it: the quote's figures as confirmed. */
async function cancel(
  bookingId: string,
  refundMethod: string,
  addonLineIds: string[] = [],
  options: Parameters<typeof post>[4] & { confirmed?: { refund: number; addonsRefund: number }; clubCancelled?: boolean } = {}
): Promise<Answer> {
  const clubCancelled = options.clubCancelled === true
  const confirmed = options.confirmed ?? (async () => {
    const q = await quote(bookingId, addonLineIds, clubCancelled)
    return { refund: q.refund, addonsRefund: q.addonsRefund }
  })()
  return post(cancelRoute, `${base(bookingId)}/cancel-and-refund`, bookingId, { refundMethod, addonLineIds, confirmed: await confirmed, ...club(clubCancelled) }, options)
}
async function cancelCredit(
  bookingId: string,
  body: { addonLineIds?: string[]; addonRefund?: string; confirmed?: { addonsRefund: number; refund?: number }; clubCancelled?: boolean } = {},
  options: Parameters<typeof post>[4] = {}
): Promise<Answer> {
  return post(creditRoute, `${base(bookingId)}/cancel-credit`, bookingId, { confirmed: { addonsRefund: 0 }, ...body }, options)
}

const runReconcile = () => reconcile(db, replayStripe.current as FakeStripe, { actor: { type: 'system', id: null }, requestId: crypto.randomUUID(), maxItems: 50, budgetMs: 60_000 })
const pastTheWindow = () => vi.setSystemTime(Date.now() + 16 * 60_000)
/** 22 hours before the session (12 Nov 10:00): inside the 24-hour rule. */
const insideTwentyFourHours = () => vi.setSystemTime(new Date('2026-11-11T12:00:00.000Z'))

const bookingRow = async (bookingId: string) =>
  (
    await db.query<{ status: string; price_paid: string; refund_owed_amount: string; part_refunded_amount: string; cancelled_at: unknown; party_size: number }>(
      'SELECT status, price_paid::text, refund_owed_amount::text, part_refunded_amount::text, cancelled_at, party_size FROM bookings WHERE id = $1',
      [bookingId]
    )
  )[0]
const totalBooked = async (sessionId = ID.session) => (await db.query<{ total_booked: number }>('SELECT total_booked FROM sessions WHERE id = $1', [sessionId]))[0]?.total_booked
const addonLines = (bookingId: string) =>
  db.query<{ id: string; order_id: string; removed_at: unknown; refunded_amount: string; card_refunded_amount: string; refund_method: string | null; redemption_source: string | null }>(
    'SELECT id, order_id, removed_at, refunded_amount::text, card_refunded_amount::text, refund_method, redemption_source FROM addon_order_lines WHERE booking_id = $1 ORDER BY created_at',
    [bookingId]
  )
const bookingLines = (bookingId: string) =>
  db.query<{ id: string; order_id: string; card_refunded_amount: string; refunded_at: unknown; refund_method: string | null }>(
    "SELECT id, order_id, card_refunded_amount::text, refunded_at, refund_method FROM order_line_items WHERE booking_id = $1 AND item_type = 'booking' ORDER BY created_at",
    [bookingId]
  )
const refunds = (stripe: FakeStripe) => stripe.calls.filter((call) => call.method === 'refunds.create')
const auditRows = (bookingId: string, action: string) =>
  db.query<{ id: string; details: Record<string, unknown> }>("SELECT id, details FROM audit_log WHERE entity_type = 'booking' AND entity_id = $1 AND action = $2 ORDER BY at, id", [bookingId, action])
const storeCredit = (customerId = ID.customer) =>
  db.query<{ amount: string; reason: string; order_id: string | null; note: string }>(
    "SELECT amount::text, reason, order_id, note FROM store_credit_transactions WHERE customer_id = $1 AND reason = 'refund' ORDER BY created_at, id",
    [customerId]
  )
/** The state a refused or undone cancel must leave exactly as it was (updated_at aside). */
async function snapshot(bookingId: string, membershipId?: string) {
  const booking = await bookingRow(bookingId)
  return {
    booking: { ...booking, cancelled_at: booking?.cancelled_at ? 'set' : null },
    places: await totalBooked(),
    lines: await addonLines(bookingId),
    bookingLines: await bookingLines(bookingId),
    passSessions: (await db.query<{ n: number }>('SELECT sessions_remaining AS n FROM customer_session_passes WHERE id = $1', [ID.ownedPass]))[0]?.n,
    credits: membershipId ? (await db.query<{ n: number }>('SELECT addon_credits_remaining AS n FROM customer_memberships WHERE id = $1', [membershipId]))[0]?.n : null,
    storeCredit: (await storeCredit()).length,
  }
}

const cardSeatAndTowel = { booking: { ...paidSeat([sam]), addons: [{ ...towel, redemptionSource: 'paid' }] }, payment: { method: 'card' } }
const onCard = { booking: paidSeat([sam]), payment: { method: 'card' } }

describe('Cancel & Refund (brief W23 items 1 and 2)', () => {
  it('a card booking with a towel on the same order: ONE card refund, one key, split over both lines; the booking cancelled, its place released', async () => {
    await withBooking(cardSeatAndTowel, async ({ bookingId, stripe }) => {
      const [line] = await addonLines(bookingId)
      const q = await quote(bookingId, [line?.id ?? ''])
      expect(q).toMatchObject({ refund: 20, owed: 0, addonsRefund: 5, parts: { card: 25, storeCredit: 0 }, cardRefundAvailable: true, insideTwentyFourHours: false, blocked: null })
      const placesBefore = await totalBooked()
      const answer = await cancel(bookingId, 'card', [line?.id ?? ''])
      expect(answer.status).toBe(200)
      expect(answer.body.data).toMatchObject({ cancelled: true, cardRefundedAmount: 20, storeCreditRefundedAmount: 0, addons: { cancelledLineIds: [line?.id], cardRefundedAmount: 5, storeCreditRefundedAmount: 0, refundedAmount: 5, summary: '1 add-on cancelled: £5.00 to the card' } })
      const [claim] = await auditRows(bookingId, 'booking.refund_claimed')
      const sent = refunds(stripe)
      expect(sent).toHaveLength(1)
      const orderId = (await bookingLines(bookingId))[0]?.order_id ?? ''
      expect(sent[0]).toMatchObject({ params: { amount: 2500, metadata: { claim_id: claim?.id } }, idempotencyKey: claimRefundKey(claim?.id ?? '', orderId) })
      expect((claim?.details['plan'] as { card: Array<{ lines: unknown[] }> }).card).toEqual([
        { orderId, paymentIntentId: expect.any(String), amount: 25, lines: [{ lineId: expect.any(String), amount: 20 }, { lineId: line?.id, amount: 5, addon: true }] },
      ])
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'cancelled', price_paid: '20.00', refund_owed_amount: '0.00' })
      expect((await bookingLines(bookingId))[0]).toMatchObject({ card_refunded_amount: '20', refunded_at: expect.anything(), refund_method: 'card' })
      expect((await addonLines(bookingId))[0]).toMatchObject({ removed_at: expect.anything(), refunded_amount: '5', card_refunded_amount: '5', refund_method: 'card' })
      expect(await totalBooked()).toBe((placesBefore ?? 0) - 1)
      expect((await db.query<{ payment_status: string }>('SELECT payment_status FROM orders WHERE id = $1', [orderId]))[0]?.payment_status).toBe('refunded')
      expect((await auditRows(bookingId, 'booking.cancel'))[0]?.details).toMatchObject({ refundMethod: 'card', seatRefund: 20, addonsRefund: 5, cardRefunded: 25, storeCreditRefunded: 0, owed: 0, placesReleased: 1 })
    })
  })

  it("item 1: the order's card portion is used once across the seat and the towel (its store credit part can't go back to the card)", async () => {
    // £25 (seat £20, towel £5), £10 of it store credit: £15 card. The seat takes the £15; the towel's £5 and the seat's
    // other £5 go to store credit, each to its own row as before.
    const partCredit = { booking: { ...paidSeat([sam]), addons: [{ ...towel, redemptionSource: 'paid' }] }, payment: { method: 'card', storeCredit: { amount: 10 } } }
    await withBooking(partCredit, async ({ bookingId, stripe }) => {
      const [line] = await addonLines(bookingId)
      expect(await quote(bookingId, [line?.id ?? ''])).toMatchObject({ refund: 20, addonsRefund: 5, parts: { card: 15, storeCredit: 10 } })
      const answer = await cancel(bookingId, 'card', [line?.id ?? ''])
      expect(answer.body.data).toMatchObject({ cardRefundedAmount: 15, storeCreditRefundedAmount: 5, addons: { cardRefundedAmount: 0, storeCreditRefundedAmount: 5 } })
      expect(refunds(stripe).map((call) => (call.params as { amount: number }).amount)).toEqual([1500])
      expect((await addonLines(bookingId))[0]).toMatchObject({ refunded_amount: '5', card_refunded_amount: '0', refund_method: 'credit' })
      expect((await storeCredit()).map((row) => [row.amount, row.note.replace(/ \[ref .*\]$/, '')])).toEqual([
        ['5.00', 'Booking refund (the rest went back to the card).'],
        ['5.00', 'Add-on refund: 1× Towel.'],
      ])
    })
  })

  it('a booking across two orders: newest first, one part each', async () => {
    await withBooking(onCard, async ({ bookingId, stripe, call }) => {
      await call('addBookingGuest', { bookingId, ...bea })
      await call('addBookingGuest', { bookingId, ...bea, payment: { method: 'card' } })
      const lines = await bookingLines(bookingId)
      const answer = await cancel(bookingId, 'card')
      expect(answer.body.data).toMatchObject({ cancelled: true, cardRefundedAmount: 40, storeCreditRefundedAmount: 0 })
      const [claim] = await auditRows(bookingId, 'booking.refund_claimed')
      expect(refunds(stripe).map((call) => [(call.params as { amount: number }).amount, call.idempotencyKey])).toEqual([
        [2000, claimRefundKey(claim?.id ?? '', lines[1]?.order_id ?? '')],
        [2000, claimRefundKey(claim?.id ?? '', lines[0]?.order_id ?? '')],
      ])
    })
  })

  it('money owed from an earlier unclear refund is included once: the cancel gives what is left and what is owed, never the gone part twice', async () => {
    await withBooking(onCard, async ({ bookingId, stripe }) => {
      // A £5 Part refund with no clear answer that Stripe never got: reconcile puts it on the booking as owed.
      stripe.failNext('refunds.create', { kind: 'unreachable' })
      stripe.failNext('refunds.create', { kind: 'unreachable' })
      const part = await post(partRoute, `${base(bookingId)}/refunds`, bookingId, { amount: 5, refundMethod: 'card', reason: 'Goodwill' })
      expect(part.body.data?.held).toBeTruthy()
      pastTheWindow()
      await runReconcile()
      expect(await bookingRow(bookingId)).toMatchObject({ price_paid: '20.00', refund_owed_amount: '5.00' })
      const q = await quote(bookingId)
      expect(q).toMatchObject({ refund: 20, owed: 5 })
      const answer = await cancel(bookingId, 'card')
      expect(answer.body.data).toMatchObject({ cancelled: true, cardRefundedAmount: 20 })
      // Every refund that went: the cancel's £20 only (the unclear £5 never reached Stripe), once.
      expect(stripe.refundsSent.map((refund) => refund.amount)).toEqual([2000])
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'cancelled', refund_owed_amount: '0.00' })
      const totalBack = (await bookingLines(bookingId)).reduce((total, line) => total + Number(line.card_refunded_amount), 0)
      expect(totalBack).toBe(20)
    })
  })

  it('the first card refund refused puts everything back exactly: status, places, add-on lines and credits; the old words; the next press is a new claim', async () => {
    await withBooking(cardSeatAndTowel, async ({ bookingId, stripe }) => {
      const [line] = await addonLines(bookingId)
      const before = await snapshot(bookingId)
      stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
      const refused = await cancel(bookingId, 'card', [line?.id ?? ''])
      expect(refused.status).toBe(402)
      expect(refused.body.error?.details).toMatchObject({ reason: 'refund_failed', message: cardRefundFailedMessage(refundRefusedDetail('Your card was declined.')) })
      expect(await snapshot(bookingId)).toEqual(before)
      expect((await auditRows(bookingId, 'booking.refund_finished'))[0]?.details).toMatchObject({ outcome: 'put_back', cardRefunded: 0, storeCreditRefunded: 0, owed: 0 })
      const again = await cancel(bookingId, 'card', [line?.id ?? ''])
      expect(again.body.data).toMatchObject({ cancelled: true, cardRefundedAmount: 20 })
      const keys = refunds(stripe).map((call) => call.idempotencyKey)
      expect(new Set(keys).size).toBe(2)
    })
  })

  it('a later card part refused goes to store credit with the old warning', async () => {
    await withBooking(onCard, async ({ bookingId, stripe, call }) => {
      await call('addBookingGuest', { bookingId, ...bea })
      await call('addBookingGuest', { bookingId, ...bea, payment: { method: 'card' } })
      // The newest order's part goes; the first order's is declined.
      stripe.failNext('refunds.create', { kind: 'none' })
      stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
      const answer = await cancel(bookingId, 'card')
      expect(answer.body.data).toMatchObject({ cancelled: true, cardRefundedAmount: 20, storeCreditRefundedAmount: 20, warning: laterCardRefundFailedMessage(20, refundRefusedDetail('Your card was declined.')) })
      expect((await storeCredit()).map((row) => [row.amount, row.note.replace(/ \[ref .*\]$/, '')])).toEqual([['20.00', 'Booking refund (the rest went back to the card).']])
    })
  })

  it('no clear answer: held, the booking cancelled; reconcile finds it (recorded) or not (store credit), never sending it again', async () => {
    for (const stripeHasIt of [true, false]) {
      await withBooking(onCard, async ({ bookingId, stripe }) => {
        stripe.failNext('refunds.create', { kind: stripeHasIt ? 'lost_response' : 'unreachable' })
        stripe.failNext('refunds.create', { kind: stripeHasIt ? 'lost_response' : 'unreachable' })
        const answer = await cancel(bookingId, 'card')
        expect(answer.body.data).toMatchObject({ cancelled: true, held: { reason: 'refund_unconfirmed', message: CHANGE_REFUND_UNCONFIRMED_MESSAGE } })
        expect(await bookingRow(bookingId)).toMatchObject({ status: 'cancelled' })
        // Another press is refused while it is held; the quote isn't, it shows the words.
        const quoteNow = await quote(bookingId)
        expect(quoteNow.blocked).toEqual({ reason: 'refund_open', message: REFUND_OPEN_MESSAGE })
        const sentBefore = refunds(stripe).length
        pastTheWindow()
        await runReconcile()
        expect(refunds(stripe)).toHaveLength(sentBefore)
        const [finished] = await auditRows(bookingId, 'booking.refund_finished')
        if (stripeHasIt) {
          expect(finished?.details).toMatchObject({ outcome: 'given', cardRefunded: 20, storeCreditRefunded: 0, owed: 0 })
          expect((await bookingLines(bookingId))[0]).toMatchObject({ card_refunded_amount: '20', refund_method: 'card' })
        } else {
          // A cancelled booking has no Refund the rest: what Stripe never got goes to store credit.
          expect(finished?.details).toMatchObject({ outcome: 'given', cardRefunded: 0, storeCreditRefunded: 20, owed: 0 })
          expect((await storeCredit()).map((row) => row.amount)).toEqual(['20.00'])
        }
      })
    }
  })

  it('a held cancel claim reconcile leaves for a person, closed by hand: the money stays owed on the cancelled booking (never store credit on top of a card refund that may have gone), with words to check Stripe', async () => {
    await withBooking(onCard, async ({ bookingId, stripe }) => {
      stripe.failNext('refunds.create', { kind: 'unreachable' })
      stripe.failNext('refunds.create', { kind: 'unreachable' })
      const claimId = (await cancel(bookingId, 'card')).body.data?.held?.claimId ?? ''
      // Left for a person (the claim's mode isn't the key's), then closed.
      await db.query("UPDATE audit_log SET details = jsonb_set(details, '{livemode}', 'true') WHERE id = $1", [claimId])
      pastTheWindow()
      expect((await runReconcile()).items.filter((item) => item.kind === 'claim')).toMatchObject([{ outcome: 'left', reason: 'other_mode' }])
      const closed = await closeRoute(
        new Request('https://worker.test/api/v1/staff/orders/stuck/close', {
          method: 'POST',
          headers: { authorization: `Bearer ${KEY}`, 'x-staff-email': REPLAY_USER.email, 'idempotency-key': crypto.randomUUID(), 'content-type': 'application/json' },
          body: JSON.stringify({ kind: 'held_claim', orderId: claimId, reason: 'Checked in Stripe by hand' }),
        })
      )
      const body = (await closed.json()) as { data?: { closed?: boolean; givenBack?: string[]; leftAsFound?: string[] } }
      // W25 (W21 review L4): the part is named; in the other Stripe mode nothing could be checked, so all of it is owed.
      expect(body.data).toMatchObject({ closed: true, givenBack: ['£20.00 back on the booking as money still to refund'] })
      expect(body.data?.leftAsFound).toHaveLength(2)
      expect(body.data?.leftAsFound?.[0]).toMatch(/^£20\.00 to the card on order [0-9a-f]{8}: it couldn't be checked in Stripe with the account in use/)
      expect(body.data?.leftAsFound?.[1]).toBe(CLOSED_ON_A_CANCELLED_BOOKING_WORDS)
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'cancelled', price_paid: '20.00', refund_owed_amount: '20.00' })
      expect(await storeCredit()).toEqual([])
      expect((await auditRows(bookingId, 'booking.refund_finished'))[0]?.details).toMatchObject({ outcome: 'owed', cardRefunded: 0, storeCreditRefunded: 0, owed: 20, by: { how: 'close' } })
    })
  })

  it('two tabs: the second press finds the booking cancelled (one refund, one cancel); the same key twice answers once', async () => {
    await withBooking(onCard, async ({ bookingId, stripe }) => {
      const q = await quote(bookingId)
      const confirmed = { refund: q.refund, addonsRefund: q.addonsRefund }
      const key = crypto.randomUUID()
      const first = await cancel(bookingId, 'card', [], { confirmed, key })
      const same = await cancel(bookingId, 'card', [], { confirmed, key })
      expect(same.body).toEqual(first.body)
      const second = await cancel(bookingId, 'card', [], { confirmed })
      expect(second.body.error?.details).toMatchObject({ reason: 'already_cancelled', message: REFUND_WORDS.alreadyCancelled })
      expect(refunds(stripe)).toHaveLength(1)
      expect(await auditRows(bookingId, 'booking.cancel')).toHaveLength(1)
    })
  })

  it('Q18: a penny off is refused with the new quote and nothing changes; half a penny passes', async () => {
    await withBooking(onCard, async ({ bookingId }) => {
      const before = await snapshot(bookingId)
      for (const off of [19.99, 20.01]) {
        const refused = await cancel(bookingId, 'card', [], { confirmed: { refund: off, addonsRefund: 0 } })
        expect(refused.body.error?.details).toMatchObject({ reason: 'refund_changed', message: REFUND_WORDS.figuresChanged, cancelQuote: { refund: 20 } })
        expect(await snapshot(bookingId)).toEqual(before)
      }
      const passed = await cancel(bookingId, 'card', [], { confirmed: { refund: 20.005, addonsRefund: 0 } })
      expect(passed.body.data).toMatchObject({ cancelled: true, cardRefundedAmount: 20 })
    })
  })

  it('inside 24 hours: refused with the old words and nothing changed; the quote says so', async () => {
    await withBooking(onCard, async ({ bookingId, stripe }) => {
      insideTwentyFourHours()
      const before = await snapshot(bookingId)
      const q = await quote(bookingId)
      expect(q).toMatchObject({ insideTwentyFourHours: true, blocked: { reason: 'within_24_hours', message: WITHIN_24_HOURS_MESSAGE } })
      const refused = await cancel(bookingId, 'card')
      expect(refused.body.error?.details).toMatchObject({ reason: 'within_24_hours', message: WITHIN_24_HOURS_MESSAGE })
      expect(await snapshot(bookingId)).toEqual(before)
      expect(refunds(stripe)).toHaveLength(0)
    })
  })

  it('gift card and store credit money goes back as store credit (no card money left: the card is not offered)', async () => {
    const paidOtherWays = { booking: paidSeat([sam]), payment: { giftCard: { giftCardId: ID.giftCard, amount: 10 }, storeCredit: { amount: 10 } } }
    await withBooking(paidOtherWays, async ({ bookingId, stripe }) => {
      const q = await quote(bookingId)
      expect(q).toMatchObject({ refund: 20, parts: { card: 0, storeCredit: 20 }, cardRefundAvailable: false })
      const answer = await cancel(bookingId, 'card')
      expect(answer.body.data).toMatchObject({ cancelled: true, cardRefundedAmount: 0, storeCreditRefundedAmount: 20 })
      expect(refunds(stripe)).toHaveLength(0)
      expect((await storeCredit()).map((row) => [row.amount, row.note.replace(/ \[ref .*\]$/, '')])).toEqual([['20.00', 'Booking refund.']])
    })
  })

  it('a database fault inside R1 changes nothing and sends nothing (the old words for not saved)', async () => {
    await withBooking(onCard, async ({ bookingId, stripe }) => {
      const before = await snapshot(bookingId)
      const failed = await whileFailing(db, { table: 'sessions', event: 'UPDATE', when: 'true' }, () => cancel(bookingId, 'card'))
      expect(failed.body.error?.details).toMatchObject({ reason: 'cancel_not_saved', message: CANCEL_NOT_SAVED_MESSAGE })
      expect(await snapshot(bookingId)).toEqual(before)
      expect(refunds(stripe)).toHaveLength(0)
    })
  })

  it('Issue refunds is needed, as before; the switch gates money going back, never a £0 cancel', async () => {
    await withBooking(onCard, async ({ bookingId }) => {
      await db.query('UPDATE staff SET can_issue_refunds = false')
      const refused = await cancel(bookingId, 'card')
      expect(refused.status).toBe(403)
      await db.query('UPDATE staff SET can_issue_refunds = true')
      const off = await cancel(bookingId, 'card', [], { orderSwitch: 'no_stripe' })
      expect(off.body.error).toMatchObject({ code: 'BOOKING_PATH_OFF', message: BOOKING_PATH_OFF_MESSAGE })
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'confirmed' })
    })
    await withBooking(onCard, async ({ bookingId, stripe }) => {
      // Nothing left to give (its money all gone back another way): nothing moves, so the switch doesn't gate it.
      await db.query('UPDATE bookings SET price_paid = 0 WHERE id = $1', [bookingId])
      const answer = await cancel(bookingId, 'card', [], { orderSwitch: 'no_stripe' })
      expect(answer.body.data).toMatchObject({ cancelled: true, cardRefundedAmount: 0, storeCreditRefundedAmount: 0 })
      expect(refunds(stripe)).toHaveLength(0)
      expect(await auditRows(bookingId, 'booking.refund_claimed')).toEqual([])
      expect((await auditRows(bookingId, 'booking.cancel'))[0]?.details).toMatchObject({ seatRefund: 0, cardRefunded: 0, storeCreditRefunded: 0 })
    })
  })
})

describe('Cancel & return credit and Cancel (payment needed) (brief W23 item 3)', () => {
  const passBooking = { booking: { ...paidSeat([sam]), redemptionSource: 'session_pass_credit', sessionPassId: ID.ownedPass }, payment: {} }
  const passSessions = async () => (await db.query<{ n: number }>('SELECT sessions_remaining AS n FROM customer_session_passes WHERE id = $1', [ID.ownedPass]))[0]?.n

  it('a pass booking: cancelled, its place and its pass session back, in one transaction; usable again', async () => {
    await withBooking(passBooking, async ({ bookingId }) => {
      const sessions = await passSessions()
      const places = await totalBooked()
      const answer = await cancelCredit(bookingId)
      expect(answer.body.data).toMatchObject({ cancelled: true, creditUsableAgain: true, booking: { id: bookingId, status: 'cancelled' } })
      expect(await passSessions()).toBe((sessions ?? 0) + 1)
      expect(await totalBooked()).toBe((places ?? 0) - 1)
      expect((await auditRows(bookingId, 'booking.cancel_credit'))[0]?.details).toMatchObject({ creditUsableAgain: true, passReturned: ID.ownedPass, placesReleased: 1 })
    })
  })

  it('an expired pass: the credit is lost (not usable again, the pass untouched), as before', async () => {
    await withBooking(passBooking, async ({ bookingId }) => {
      await db.query(`UPDATE customer_session_passes SET expiry_date = '2026-11-09' WHERE id = $1`, [ID.ownedPass])
      const sessions = await passSessions()
      const answer = await cancelCredit(bookingId)
      expect(answer.body.data).toMatchObject({ cancelled: true, creditUsableAgain: false })
      expect(await passSessions()).toBe(sessions)
    })
  })

  it('a membership credit whose period has ended: cancelled, not usable again', async () => {
    const memberBooking = { customerId: ID.member, booking: { ...paidSeat([mo]), ...memberCredit }, payment: {} }
    await withBooking(memberBooking, async ({ bookingId }) => {
      await db.query(`UPDATE membership_credit_periods SET period_start = '2026-10-10', period_end = '2026-11-09' WHERE id = $1`, [ID.creditPeriod])
      const answer = await cancelCredit(bookingId)
      expect(answer.body.data).toMatchObject({ cancelled: true, creditUsableAgain: false })
    })
  })

  it('inside 24 hours: refused with the old words, nothing changed; a payment-needed booking is exempt and gives nothing back', async () => {
    await withBooking(passBooking, async ({ bookingId }) => {
      insideTwentyFourHours()
      const before = await snapshot(bookingId)
      expect((await creditQuote(bookingId)).blocked).toEqual({ reason: 'within_24_hours', message: WITHIN_24_HOURS_MESSAGE })
      const refused = await cancelCredit(bookingId)
      expect(refused.body.error?.details).toMatchObject({ reason: 'within_24_hours', message: WITHIN_24_HOURS_MESSAGE })
      expect(await snapshot(bookingId)).toEqual(before)
      // The same booking awaiting payment (a lapsed membership's): cancelled any time, nothing back.
      await db.query("UPDATE bookings SET status = 'payment_needed' WHERE id = $1", [bookingId])
      const places = await totalBooked()
      const cancelled = await cancelCredit(bookingId)
      expect(cancelled.body.data).toMatchObject({ cancelled: true })
      expect(await totalBooked()).toBe((places ?? 0) - 1)
      expect(await storeCredit()).toEqual([])
    })
  })

  it('N5: a pass booking with paid guests is refused with "Remove paid guests first, then cancel." (the quote shows it too)', async () => {
    const passAndGuest = { booking: { ...paidSeat([sam]), redemptionSource: 'session_pass_credit', sessionPassId: ID.ownedPass }, payment: {} }
    await withBooking(passAndGuest, async ({ bookingId, call }) => {
      await call('addBookingGuest', { bookingId, ...bea })
      await call('addBookingGuest', { bookingId, ...bea, payment: { method: 'card' } })
      expect((await creditQuote(bookingId)).blocked).toEqual({ reason: 'paid_guests_present', message: CANCEL_CREDIT_WORDS.paidGuestsPresent })
      const refused = await cancelCredit(bookingId)
      expect(refused.body.error?.details).toMatchObject({ reason: 'paid_guests_present', message: 'Remove paid guests first, then cancel.' })
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'confirmed' })
    })
  })

  it('a paid add-on ticked to the card: Issue refunds, the confirmed figure, one refund keyed from the claim, the line stamped', async () => {
    await withBooking(passBooking, async ({ bookingId, call, stripe }) => {
      await call('addBookingGuest', { bookingId, addons: [{ addonId: ID.addon, quantity: 1 }] })
      await call('addBookingGuest', { bookingId, addons: [{ addonId: ID.addon, quantity: 1 }], payment: { method: 'card' } })
      const [line] = await addonLines(bookingId)
      const q = await creditQuote(bookingId, [line?.id ?? ''])
      expect(q).toMatchObject({ refund: 0, addonsRefund: 5, parts: { card: 5, storeCredit: 0 }, cardRefundAvailable: true })
      await db.query('UPDATE staff SET can_issue_refunds = false')
      const forbidden = await cancelCredit(bookingId, { addonLineIds: [line?.id ?? ''], addonRefund: 'card', confirmed: { addonsRefund: 5 } })
      expect(forbidden.body.error?.details).toMatchObject({ reason: 'no_refund_permission', message: ISSUE_REFUNDS_NEEDED_MESSAGE })
      await db.query('UPDATE staff SET can_issue_refunds = true')
      const stale = await cancelCredit(bookingId, { addonLineIds: [line?.id ?? ''], addonRefund: 'card', confirmed: { addonsRefund: 0 } })
      expect(stale.body.error?.details).toMatchObject({ reason: 'refund_changed', cancelQuote: { addonsRefund: 5 } })
      const answer = await cancelCredit(bookingId, { addonLineIds: [line?.id ?? ''], addonRefund: 'card', confirmed: { addonsRefund: 5 } })
      expect(answer.body.data).toMatchObject({ cancelled: true, creditUsableAgain: true, addons: { cancelledLineIds: [line?.id], cardRefundedAmount: 5, storeCreditRefundedAmount: 0 } })
      const [claim] = await auditRows(bookingId, 'booking.refund_claimed')
      expect(claim?.details).toMatchObject({ kind: 'cancel_credit', amount: 5, method: 'card' })
      expect(refunds(stripe).map((call) => [(call.params as { amount: number }).amount, call.idempotencyKey])).toEqual([[500, claimRefundKey(claim?.id ?? '', line?.order_id ?? '')]])
      expect((await addonLines(bookingId))[0]).toMatchObject({ refunded_amount: '5', card_refunded_amount: '5', refund_method: 'card' })
    })
  })

  it('a paid add-on inside 24 hours on a payment-needed booking: removed with nothing back (the old note)', async () => {
    await withBooking(passBooking, async ({ bookingId, call }) => {
      await call('addBookingGuest', { bookingId, addons: [{ addonId: ID.addon, quantity: 1 }] })
      await call('addBookingGuest', { bookingId, addons: [{ addonId: ID.addon, quantity: 1 }], payment: { method: 'card' } })
      await db.query("UPDATE bookings SET status = 'payment_needed' WHERE id = $1", [bookingId])
      insideTwentyFourHours()
      const [line] = await addonLines(bookingId)
      expect((await creditQuote(bookingId, [line?.id ?? ''])).addonsRefund).toBe(0)
      const answer = await cancelCredit(bookingId, { addonLineIds: [line?.id ?? ''], addonRefund: 'card', confirmed: { addonsRefund: 0 } })
      expect(answer.body.data).toMatchObject({ cancelled: true, addons: { cardRefundedAmount: 0, storeCreditRefundedAmount: 0, notes: [ADDON_INSIDE_24_HOURS_NOTE] } })
      expect((await addonLines(bookingId))[0]).toMatchObject({ removed_at: expect.anything(), refund_method: 'none' })
    })
  })

  it('N4: a database fault after the cancel (the places) changes nothing', async () => {
    await withBooking(passBooking, async ({ bookingId }) => {
      const before = await snapshot(bookingId)
      const failed = await whileFailing(db, { table: 'customer_session_passes', event: 'UPDATE', when: 'true' }, () => cancelCredit(bookingId))
      expect(failed.body.error?.details).toMatchObject({ reason: 'cancel_not_saved', message: CANCEL_NOT_SAVED_MESSAGE })
      expect(await snapshot(bookingId)).toEqual(before)
    })
  })
})

describe('an open payment or refund refuses every press here; the quotes show the words (brief W23 item 4)', () => {
  it('a refund still being checked: both presses refused (refund_open); the quotes are not', async () => {
    await withBooking(onCard, async ({ bookingId, stripe }) => {
      stripe.failNext('refunds.create', { kind: 'unreachable' })
      stripe.failNext('refunds.create', { kind: 'unreachable' })
      await post(partRoute, `${base(bookingId)}/refunds`, bookingId, { amount: 5, refundMethod: 'card', reason: 'Goodwill' })
      expect((await quote(bookingId)).blocked).toEqual({ reason: 'refund_open', message: REFUND_OPEN_MESSAGE })
      const refused = await cancel(bookingId, 'card', [], { confirmed: { refund: 15, addonsRefund: 0 } })
      expect(refused.body.error?.details).toMatchObject({ reason: 'refund_open', message: REFUND_OPEN_MESSAGE })
    })
    const passBooking = { booking: { ...paidSeat([sam]), redemptionSource: 'session_pass_credit', sessionPassId: ID.ownedPass }, payment: {} }
    await withBooking(passBooking, async ({ bookingId }) => {
      await db.query(
        `INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, details) VALUES ('staff', $1, 'booking.refund_claimed', 'booking', $2, $3::jsonb)`,
        [ID.staff, bookingId, JSON.stringify({ kind: 'part_refund', worker: true, plan: { card: [], storeCredit: 0, cash: 0, ownOrderId: null } })]
      )
      expect((await creditQuote(bookingId)).blocked).toEqual({ reason: 'refund_open', message: REFUND_OPEN_MESSAGE })
      const refused = await cancelCredit(bookingId)
      expect(refused.body.error?.details).toMatchObject({ reason: 'refund_open', message: REFUND_OPEN_MESSAGE })
    })
  })

  it('a payment still being taken (a reader flow open): both presses refused with the held-payment words; the quotes show them', async () => {
    await withBooking(onCard, async ({ bookingId, call }) => {
      await call('addBookingGuest', { bookingId, ...bea })
      await call('addBookingGuest', { bookingId, ...bea, payment: { method: 'reader' } })
      expect((await quote(bookingId)).blocked).toEqual({ reason: 'reader_payment_open', message: READER_PAYMENT_OPEN_MESSAGE })
      const refused = await cancel(bookingId, 'card', [], { confirmed: { refund: 20, addonsRefund: 0 } })
      expect(refused.body.error?.details).toMatchObject({ reason: 'reader_payment_open', message: READER_PAYMENT_OPEN_MESSAGE })
      await db.query("UPDATE bookings SET redemption_source = 'session_pass_credit', price_paid = 0 WHERE id = $1", [bookingId])
      const credit = await cancelCredit(bookingId)
      expect(credit.body.error?.details).toMatchObject({ reason: 'reader_payment_open', message: READER_PAYMENT_OPEN_MESSAGE })
    })
  })
})

// --- Brief W23a

const membershipCredits = async () => (await db.query<{ n: number }>('SELECT addon_credits_remaining AS n FROM customer_memberships WHERE id = $1', [ID.membership]))[0]?.n
const passSessionsLeft = async () => (await db.query<{ n: number }>('SELECT sessions_remaining AS n FROM customer_session_passes WHERE id = $1', [ID.ownedPass]))[0]?.n
const creditTowel = { ...towel, redemptionSource: 'membership_credit', membershipId: ID.membership }
/** The member (2 add-on credits) owns the pass, at 5 sessions before the booking takes one (W23 review S1's example). */
const thePassIsTheMembers = async (seedDb: Db) => {
  await seedDb.query('UPDATE customer_session_passes SET customer_id = $1, sessions_remaining = 5 WHERE id = $2', [ID.member, ID.ownedPass])
}
/** A pass booking with a membership-credit towel, then a £5 towel paid on the member's saved card (Add Guest, add-ons only). */
const passWithTwoTowels = { customerId: ID.member, booking: { ...paidSeat([mo]), redemptionSource: 'session_pass_credit', sessionPassId: ID.ownedPass, addons: [creditTowel] }, payment: {} }
async function addPaidTowel({ bookingId, call }: Context): Promise<string[]> {
  await call('addBookingGuest', { bookingId, addons: [{ addonId: ID.addon, quantity: 1 }] })
  await call('addBookingGuest', { bookingId, addons: [{ addonId: ID.addon, quantity: 1 }], payment: { method: 'card' } })
  const lines = await addonLines(bookingId)
  expect(lines.map((line) => line.redemption_source)).toEqual(['membership_credit', 'paid'])
  return lines.map((line) => line.id)
}
type ClaimCancel = { passReturned: string | null; refundOwed: number; addons: Array<{ creditsReturned: number; membershipId: string | null }>; clubCancelled?: boolean }
/** The cancel's claim's record of what R1 changed (a booking's earlier Part refund has its own claim). */
const claimCancel = async (bookingId: string) =>
  ((await auditRows(bookingId, 'booking.refund_claimed')).find((row) => row.details['kind'] === 'cancel' || row.details['kind'] === 'cancel_credit')?.details['cancel'] ?? null) as ClaimCancel | null

describe('W23 review S1: the first card part refused undoes the cancel exactly, the pass session and add-on credits included', () => {
  it("Cancel & return credit to the card, its paid towel declined: the booking, its place, the pass (4, not 5), the membership's add-on credits (1, not 2), both towels with their old stamps all back; put_back; the new words", async () => {
    await withBooking(
      passWithTwoTowels,
      async (context) => {
        const { bookingId, stripe } = context
        const ids = await addPaidTowel(context)
        expect(await creditQuote(bookingId, ids)).toMatchObject({ addonsRefund: 5, parts: { card: 5, storeCredit: 0 }, cardRefundAvailable: true, blocked: null })
        const before = await snapshot(bookingId, ID.membership)
        expect(before).toMatchObject({ booking: { status: 'confirmed', cancelled_at: null }, passSessions: 4, credits: 1 })
        stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
        const refused = await cancelCredit(bookingId, { addonLineIds: ids, addonRefund: 'card', confirmed: { addonsRefund: 5 } })
        expect(refused.status).toBe(402)
        expect(refused.body.error?.details).toMatchObject({ reason: 'refund_failed', message: cancelCreditAddonRefundFailedMessage('Towel', refundRefusedDetail('Your card was declined.')) })
        // R1 had given the pass session and the credit back (so the undo had them to take back again).
        expect(await claimCancel(bookingId)).toMatchObject({ passReturned: ID.ownedPass, addons: [{ creditsReturned: 1, membershipId: ID.membership }, { creditsReturned: 0 }] })
        expect(await snapshot(bookingId, ID.membership)).toEqual(before)
        expect(await passSessionsLeft()).toBe(4)
        expect(await membershipCredits()).toBe(1)
        expect((await addonLines(bookingId)).map((line) => [line.removed_at, line.refunded_amount, line.card_refunded_amount, line.refund_method])).toEqual([
          [null, '0', '0', null],
          [null, '0', '0', null],
        ])
        expect((await auditRows(bookingId, 'booking.refund_finished'))[0]?.details).toMatchObject({ outcome: 'put_back', cardRefunded: 0, storeCreditRefunded: 0, owed: 0 })
        expect(await auditRows(bookingId, 'booking.cancel_credit')).toEqual([])
      },
      undefined,
      thePassIsTheMembers
    )
  })

  it('Cancel & Refund with £5 owed and a credit towel ticked, declined: refund_owed_amount back to 5, the credit taken back, the towel back as it was', async () => {
    const memberOnCard = { customerId: ID.member, booking: { ...paidSeat([mo]), addons: [creditTowel] }, payment: { method: 'card' } }
    await withBooking(memberOnCard, async ({ bookingId, stripe }) => {
      stripe.failNext('refunds.create', { kind: 'unreachable' })
      stripe.failNext('refunds.create', { kind: 'unreachable' })
      await post(partRoute, `${base(bookingId)}/refunds`, bookingId, { amount: 5, refundMethod: 'card', reason: 'Goodwill' })
      pastTheWindow()
      await runReconcile()
      const [line] = await addonLines(bookingId)
      expect(line?.redemption_source).toBe('membership_credit')
      expect(await quote(bookingId, [line?.id ?? ''])).toMatchObject({ owed: 5, addonsRefund: 0, blocked: null })
      const before = await snapshot(bookingId, ID.membership)
      expect(before).toMatchObject({ booking: { status: 'confirmed', refund_owed_amount: '5.00' }, credits: 1 })
      stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
      const refused = await cancel(bookingId, 'card', [line?.id ?? ''])
      expect(refused.body.error?.details).toMatchObject({ reason: 'refund_failed', message: cardRefundFailedMessage(refundRefusedDetail('Your card was declined.')) })
      expect(await claimCancel(bookingId)).toMatchObject({ refundOwed: 5, addons: [{ creditsReturned: 1, membershipId: ID.membership }] })
      expect(await snapshot(bookingId, ID.membership)).toEqual(before)
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'confirmed', refund_owed_amount: '5.00' })
      expect(await membershipCredits()).toBe(1)
    })
  })
})

describe("W23a (Wayne, 13 Nov): the club cancelling from Block Session or Block Day: no 24-hour rule, everything back until the session starts", () => {
  it('Cancel & Refund inside 24 hours: refused from the booking page; from a block, the whole booking back (card with its towel; store credit), recorded on the claim and the audit row', async () => {
    await withBooking(cardSeatAndTowel, async ({ bookingId, stripe }) => {
      const [line] = await addonLines(bookingId)
      const ids = [line?.id ?? '']
      insideTwentyFourHours()
      const before = await snapshot(bookingId)
      expect(await quote(bookingId, ids)).toMatchObject({ insideTwentyFourHours: true, blocked: { reason: 'within_24_hours', message: WITHIN_24_HOURS_MESSAGE } })
      const page = await cancel(bookingId, 'card', ids, { confirmed: { refund: 20, addonsRefund: 5 } })
      expect(page.body.error?.details).toMatchObject({ reason: 'within_24_hours', message: WITHIN_24_HOURS_MESSAGE })
      expect(await snapshot(bookingId)).toEqual(before)
      expect(refunds(stripe)).toHaveLength(0)

      expect(await quote(bookingId, ids, true)).toMatchObject({ refund: 20, addonsRefund: 5, parts: { card: 25, storeCredit: 0 }, cardRefundAvailable: true, insideTwentyFourHours: true, blocked: null })
      const places = await totalBooked()
      const answer = await cancel(bookingId, 'card', ids, { clubCancelled: true })
      expect(answer.body.data).toMatchObject({ cancelled: true, cardRefundedAmount: 20, storeCreditRefundedAmount: 0, addons: { cardRefundedAmount: 5, storeCreditRefundedAmount: 0, notes: [] } })
      expect(refunds(stripe).map((call) => (call.params as { amount: number }).amount)).toEqual([2500])
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'cancelled' })
      expect(await totalBooked()).toBe((places ?? 0) - 1)
      expect(await claimCancel(bookingId)).toMatchObject({ clubCancelled: true })
      expect((await auditRows(bookingId, 'booking.cancel'))[0]?.details).toMatchObject({ clubCancelled: true, seatRefund: 20, addonsRefund: 5, cardRefunded: 25 })
    })
    await withBooking(onCard, async ({ bookingId }) => {
      insideTwentyFourHours()
      const answer = await cancel(bookingId, 'credit', [], { clubCancelled: true })
      expect(answer.body.data).toMatchObject({ cancelled: true, cardRefundedAmount: 0, storeCreditRefundedAmount: 20 })
      expect((await storeCredit()).map((row) => row.amount)).toEqual(['20.00'])
      expect((await auditRows(bookingId, 'booking.cancel'))[0]?.details).toMatchObject({ clubCancelled: true, refundMethod: 'credit', storeCreditRefunded: 20 })
    })
  })

  it('a cancel from the booking page outside 24 hours is as W23 wrote it: no clubCancelled on its claim or row', async () => {
    await withBooking(onCard, async ({ bookingId }) => {
      await cancel(bookingId, 'card')
      expect(await claimCancel(bookingId)).not.toHaveProperty('clubCancelled')
      expect((await auditRows(bookingId, 'booking.cancel'))[0]?.details).not.toHaveProperty('clubCancelled')
    })
  })

  it("Cancel & return credit inside 24 hours: refused from the booking page; from a block, the pass session and the membership's add-on credit back and the paid towel refunded to the card", async () => {
    await withBooking(
      passWithTwoTowels,
      async (context) => {
        const { bookingId, stripe } = context
        const ids = await addPaidTowel(context)
        insideTwentyFourHours()
        const before = await snapshot(bookingId, ID.membership)
        expect(await creditQuote(bookingId, ids)).toMatchObject({ addonsRefund: 0, blocked: { reason: 'within_24_hours', message: WITHIN_24_HOURS_MESSAGE } })
        const page = await cancelCredit(bookingId, { addonLineIds: ids, addonRefund: 'card', confirmed: { addonsRefund: 0 } })
        expect(page.body.error?.details).toMatchObject({ reason: 'within_24_hours', message: WITHIN_24_HOURS_MESSAGE })
        expect(await snapshot(bookingId, ID.membership)).toEqual(before)

        const q = await creditQuote(bookingId, ids, true)
        expect(q).toMatchObject({ addonsRefund: 5, parts: { card: 5 }, insideTwentyFourHours: true, blocked: null })
        const answer = await cancelCredit(bookingId, { addonLineIds: ids, addonRefund: 'card', confirmed: { addonsRefund: q.addonsRefund }, clubCancelled: true })
        expect(answer.body.data).toMatchObject({ cancelled: true, creditUsableAgain: true, addons: { cardRefundedAmount: 5, storeCreditRefundedAmount: 0, creditsReturned: 1, notes: [] } })
        expect(refunds(stripe).map((call) => (call.params as { amount: number }).amount)).toEqual([500])
        expect(await passSessionsLeft()).toBe(5)
        expect(await membershipCredits()).toBe(2)
        expect(await bookingRow(bookingId)).toMatchObject({ status: 'cancelled' })
        expect(await claimCancel(bookingId)).toMatchObject({ clubCancelled: true })
        expect((await auditRows(bookingId, 'booking.cancel_credit'))[0]?.details).toMatchObject({ clubCancelled: true, creditUsableAgain: true, passReturned: ID.ownedPass, creditsReturned: 1, addonsRefund: 5 })
      },
      undefined,
      thePassIsTheMembers
    )
  })

  it('a credit booking with nothing paid: from a block inside 24 hours, cancelled with its credit back and no claim; its own row says so', async () => {
    const passBooking = { booking: { ...paidSeat([sam]), redemptionSource: 'session_pass_credit', sessionPassId: ID.ownedPass }, payment: {} }
    await withBooking(passBooking, async ({ bookingId }) => {
      insideTwentyFourHours()
      const sessions = await passSessionsLeft()
      const answer = await cancelCredit(bookingId, { clubCancelled: true })
      expect(answer.body.data).toMatchObject({ cancelled: true, creditUsableAgain: true })
      expect(await passSessionsLeft()).toBe((sessions ?? 0) + 1)
      expect(await auditRows(bookingId, 'booking.refund_claimed')).toEqual([])
      expect((await auditRows(bookingId, 'booking.cancel_credit'))[0]?.details).toMatchObject({ clubCancelled: true, passReturned: ID.ownedPass })
    })
  })

  it("once the session has started the club's cancel is refused (both routes; the quotes say so) and nothing changes", async () => {
    await withBooking(onCard, async ({ bookingId, stripe }) => {
      vi.setSystemTime(new Date('2026-11-12T10:30:00.000Z'))
      const before = await snapshot(bookingId)
      expect((await quote(bookingId, [], true)).blocked).toEqual({ reason: 'session_already_started', message: CLUB_CANCEL_SESSION_STARTED_MESSAGE })
      const refused = await cancel(bookingId, 'card', [], { clubCancelled: true, confirmed: { refund: 20, addonsRefund: 0 } })
      expect(refused.body.error?.details).toMatchObject({ reason: 'session_already_started', message: CLUB_CANCEL_SESSION_STARTED_MESSAGE })
      expect(await snapshot(bookingId)).toEqual(before)
      expect(refunds(stripe)).toHaveLength(0)
    })
    const passBooking = { booking: { ...paidSeat([sam]), redemptionSource: 'session_pass_credit', sessionPassId: ID.ownedPass }, payment: {} }
    await withBooking(passBooking, async ({ bookingId }) => {
      vi.setSystemTime(new Date('2026-11-12T10:30:00.000Z'))
      expect((await creditQuote(bookingId, [], true)).blocked).toEqual({ reason: 'session_already_started', message: CLUB_CANCEL_SESSION_STARTED_MESSAGE })
      const refused = await cancelCredit(bookingId, { clubCancelled: true })
      expect(refused.body.error?.details).toMatchObject({ reason: 'session_already_started', message: CLUB_CANCEL_SESSION_STARTED_MESSAGE })
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'confirmed' })
    })
  })

  it("money back still needs Issue refunds: the club's Cancel & Refund, and its Cancel & return credit with a paid towel refunded; a credit back alone doesn't", async () => {
    await withBooking(onCard, async ({ bookingId }) => {
      insideTwentyFourHours()
      await db.query('UPDATE staff SET can_issue_refunds = false')
      const refused = await cancel(bookingId, 'card', [], { clubCancelled: true })
      expect(refused.status).toBe(403)
      await db.query('UPDATE staff SET can_issue_refunds = true')
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'confirmed' })
    })
    await withBooking(
      passWithTwoTowels,
      async (context) => {
        const { bookingId } = context
        const ids = await addPaidTowel(context)
        insideTwentyFourHours()
        await db.query('UPDATE staff SET can_issue_refunds = false')
        const refused = await cancelCredit(bookingId, { addonLineIds: ids, addonRefund: 'card', confirmed: { addonsRefund: 5 }, clubCancelled: true })
        expect(refused.body.error?.details).toMatchObject({ reason: 'no_refund_permission', message: ISSUE_REFUNDS_NEEDED_MESSAGE })
        const creditOnly = await cancelCredit(bookingId, { addonLineIds: [ids[0] ?? ''], clubCancelled: true })
        expect(creditOnly.body.data).toMatchObject({ cancelled: true, creditUsableAgain: true, addons: { creditsReturned: 1 } })
        await db.query('UPDATE staff SET can_issue_refunds = true')
      },
      undefined,
      thePassIsTheMembers
    )
  })
})

// --- Brief W25, Part B

/** The manual close of a held refund claim, as the Orders page presses it. */
async function closeClaim(claimId: string) {
  const closed = await closeRoute(
    new Request('https://worker.test/api/v1/staff/orders/stuck/close', {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'x-staff-email': REPLAY_USER.email, 'idempotency-key': crypto.randomUUID(), 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'held_claim', orderId: claimId, reason: 'Checked in Stripe by hand' }),
    })
  )
  return ((await closed.json()) as { data?: { closed?: boolean; message?: string; givenBack?: string[]; leftAsFound?: string[] } }).data
}
/** A cancel to the card held with no clear answer, left for a person by reconcile (the other Stripe mode), then closed by hand. */
async function cancelHeldThenClosed(bookingId: string, stripe: FakeStripe, addonLineIds: string[] = []) {
  stripe.failNext('refunds.create', { kind: 'unreachable' })
  stripe.failNext('refunds.create', { kind: 'unreachable' })
  const claimId = (await cancel(bookingId, 'card', addonLineIds)).body.data?.held?.claimId ?? ''
  await db.query("UPDATE audit_log SET details = jsonb_set(details, '{livemode}', 'true') WHERE id = $1", [claimId])
  pastTheWindow()
  expect((await runReconcile()).items.filter((item) => item.kind === 'claim')).toMatchObject([{ outcome: 'left', reason: 'other_mode' }])
  return closeClaim(claimId)
}
const refundTheRest = (bookingId: string, amount: number, refundMethod: string) => post(owedRoute, `${base(bookingId)}/refunds/owed`, bookingId, { amount, refundMethod })
const itAlreadyArrived = (bookingId: string, amount: number) => post(owedArrivedRoute, `${base(bookingId)}/refunds/owed-arrived`, bookingId, { amount, reason: 'Seen in Stripe' })

describe('W25 item 6: money still owed on a cancelled booking (W23 review later 1)', () => {
  it('Refund the rest runs on the cancelled booking: store credit only, exactly what is owed, once; the price paid stays', async () => {
    await withBooking(onCard, async ({ bookingId, stripe }) => {
      const closed = await cancelHeldThenClosed(bookingId, stripe)
      // The close's words point to the two buttons on the cancelled booking.
      expect(closed?.leftAsFound?.at(-1)).toBe(CLOSED_ON_A_CANCELLED_BOOKING_WORDS)
      expect(CLOSED_ON_A_CANCELLED_BOOKING_WORDS).toMatch(/It already arrived/)
      expect(CLOSED_ON_A_CANCELLED_BOOKING_WORDS).toMatch(/Refund the rest/)
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'cancelled', price_paid: '20.00', refund_owed_amount: '20.00' })
      const sent = refunds(stripe).length

      // To the card: refused (a second card refund could pay the same money twice), nothing changed.
      const toCard = await refundTheRest(bookingId, 20, 'card')
      expect(toCard.status).toBe(409)
      expect(toCard.body.error?.details).toMatchObject({ reason: 'cancelled_store_credit_only', message: OWED_ON_CANCELLED_STORE_CREDIT_ONLY_MESSAGE })
      // Not exactly what is owed: refused with the figures.
      expect((await refundTheRest(bookingId, 19, 'credit')).body.error?.details).toMatchObject({ reason: 'owed_changed' })
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'cancelled', price_paid: '20.00', refund_owed_amount: '20.00' })
      expect(await storeCredit()).toEqual([])

      const given = await refundTheRest(bookingId, 20, 'credit')
      expect(given.body.data).toMatchObject({ cardRefundedAmount: 0, storeCreditRefundedAmount: 20 })
      // A cancelled booking keeps its price paid; only what was owed comes off.
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'cancelled', price_paid: '20.00', refund_owed_amount: '0.00' })
      expect((await storeCredit()).map((row) => row.amount)).toEqual(['20.00'])
      expect((await auditRows(bookingId, 'booking.refund_owed')).at(-1)?.details).toMatchObject({ amount: 20, method: 'credit', storeCreditRefunded: 20, cardRefunded: 0, owed: 0 })
      // Nothing was sent to Stripe, and it can't be given twice.
      expect(refunds(stripe)).toHaveLength(sent)
      expect((await refundTheRest(bookingId, 20, 'credit')).body.error?.details).toMatchObject({ reason: 'nothing_owed' })
      expect((await storeCredit()).map((row) => row.amount)).toEqual(['20.00'])
      // A part refund is still refused on a cancelled booking (its price paid would pay out twice).
      const part = await post(partRoute, `${base(bookingId)}/refunds`, bookingId, { amount: 5, refundMethod: 'credit', reason: 'Goodwill' })
      expect(part.body.error?.details).toMatchObject({ reason: 'already_cancelled' })
    })
  })

  it('It already arrived runs on the cancelled booking: what is owed comes off, no money moves', async () => {
    await withBooking(onCard, async ({ bookingId, stripe }) => {
      await cancelHeldThenClosed(bookingId, stripe)
      const sent = refunds(stripe).length
      const arrived = await itAlreadyArrived(bookingId, 20)
      expect(arrived.body.data).toMatchObject({ cardRefundedAmount: 0, storeCreditRefundedAmount: 0, pricePaid: 20 })
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'cancelled', price_paid: '20.00', refund_owed_amount: '0.00' })
      expect(await storeCredit()).toEqual([])
      expect(refunds(stripe)).toHaveLength(sent)
      expect((await auditRows(bookingId, 'booking.refund_owed_arrived'))[0]?.details).toEqual({ amount: 20, reason: 'Seen in Stripe' })
      expect((await itAlreadyArrived(bookingId, 20)).body.error?.details).toMatchObject({ reason: 'nothing_owed' })
    })
  })

  it("the add-on line's unsent share is in what is owed, and Refund the rest gives it too (seat £20 + towel £5)", async () => {
    await withBooking(cardSeatAndTowel, async ({ bookingId, stripe }) => {
      const [line] = await addonLines(bookingId)
      const closed = await cancelHeldThenClosed(bookingId, stripe, [line?.id ?? ''])
      expect(closed).toMatchObject({ closed: true })
      // The towel's line reads removed with nothing back; the booking carries its £5 with the seat's £20.
      const [towelLine] = await addonLines(bookingId)
      expect([Number(towelLine?.refunded_amount), Number(towelLine?.card_refunded_amount)]).toEqual([0, 0])
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'cancelled', refund_owed_amount: '25.00' })
      const given = await refundTheRest(bookingId, 25, 'credit')
      expect(given.body.data).toMatchObject({ storeCreditRefundedAmount: 25 })
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'cancelled', refund_owed_amount: '0.00' })
      expect((await storeCredit()).map((row) => row.amount)).toEqual(['25.00'])
    })
  })
})

describe("W25 item 7: the undo after a refused first card part never overfills a session or takes a pass below 0 (W23 review later 2)", () => {
  /** Runs `meanwhile` just before Stripe is asked for the refund: what another person did in those seconds. */
  function whileTheRefundIsSent(stripe: FakeStripe, meanwhile: () => Promise<unknown>) {
    const create = stripe.refunds.create
    stripe.refunds.create = (async (...args: Parameters<typeof create>) => {
      await meanwhile()
      return create(...args)
    }) as typeof create
  }

  it("the session filled meanwhile: the cancel stands (never one over) and ends there and then as £20 still to refund on the cancelled booking, with Stripe's reason; never store credit, at the press or at reconcile (W25a, W25 review S1)", async () => {
    await withBooking(onCard, async ({ bookingId, stripe }) => {
      const capacity = (await db.query<{ capacity: number }>('SELECT capacity FROM sessions WHERE id = $1', [ID.session]))[0]?.capacity ?? 0
      // Another booking takes every free place between R1 and the card's answer.
      whileTheRefundIsSent(stripe, () => db.query('UPDATE sessions SET total_booked = capacity WHERE id = $1', [ID.session]))
      stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
      const answer = await cancel(bookingId, 'card')
      expect(answer.status).toBe(200)
      // The words carry Stripe's refusal and point to the two buttons on the cancelled booking.
      const words = putBackBlockedMessage(refundRefusedDetail('Your card was declined.'), 20, true)
      expect(answer.body.data).toMatchObject({ cancelled: true, cardRefundedAmount: 0, storeCreditRefundedAmount: 0, held: { reason: 'refund_refused_not_put_back', message: words } })
      expect(words).toMatch(/Your card was declined\./)
      expect(words).toMatch(/£20\.00 shows on the booking as still to refund/)
      expect(words).toMatch(/It already arrived/)
      expect(words).toMatch(/Refund the rest \(the booking is cancelled, so it goes to store credit\)/)
      // The session is full, not one over; the booking stays cancelled, with the £20 still to refund on it, and the
      // claim is finished: no store credit row.
      expect(await totalBooked()).toBe(capacity)
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'cancelled', price_paid: '20.00', refund_owed_amount: '20.00' })
      expect(await storeCredit()).toEqual([])
      const finished = await auditRows(bookingId, 'booking.refund_finished')
      expect(finished).toHaveLength(1)
      expect(finished[0]?.details).toMatchObject({ outcome: 'owed', cardRefunded: 0, storeCreditRefunded: 0, owed: 20, by: { how: 'undo_blocked', why: refundRefusedDetail('Your card was declined.') } })
      expect((await bookingLines(bookingId))[0]).toMatchObject({ card_refunded_amount: '0' })
      // Reconcile has nothing to do for it: nothing sent, no store credit, the money still owed.
      const sent = refunds(stripe).length
      pastTheWindow()
      expect((await runReconcile()).items.filter((item) => item.kind === 'claim')).toEqual([])
      expect(await storeCredit()).toEqual([])
      expect(await auditRows(bookingId, 'booking.refund_finished')).toHaveLength(1)
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'cancelled', price_paid: '20.00', refund_owed_amount: '20.00' })
      expect(refunds(stripe)).toHaveLength(sent)
      expect(await totalBooked()).toBe(capacity)
      // No refund is open, and a person decides: It already arrived takes it off with no money moving.
      expect((await quote(bookingId)).blocked).not.toMatchObject({ reason: 'refund_open' })
      const arrived = await itAlreadyArrived(bookingId, 20)
      expect(arrived.body.data).toMatchObject({ cardRefundedAmount: 0, storeCreditRefundedAmount: 0 })
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'cancelled', refund_owed_amount: '0.00' })
      expect(await storeCredit()).toEqual([])
    })
  })

  it("the same with a ticked paid towel on the order (£25): all of it owed on the cancelled booking, the towel's line with nothing back, and Refund the rest gives it as store credit once", async () => {
    await withBooking(cardSeatAndTowel, async ({ bookingId, stripe }) => {
      const [line] = await addonLines(bookingId)
      whileTheRefundIsSent(stripe, () => db.query('UPDATE sessions SET total_booked = capacity WHERE id = $1', [ID.session]))
      stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
      const answer = await cancel(bookingId, 'card', [line?.id ?? ''])
      expect(answer.body.data?.held).toMatchObject({ message: putBackBlockedMessage(refundRefusedDetail('Your card was declined.'), 25, true) })
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'cancelled', refund_owed_amount: '25.00' })
      const [towelLine] = await addonLines(bookingId)
      expect(towelLine?.removed_at).not.toBeNull()
      expect([Number(towelLine?.refunded_amount), Number(towelLine?.card_refunded_amount)]).toEqual([0, 0])
      expect(await storeCredit()).toEqual([])
      const given = await refundTheRest(bookingId, 25, 'credit')
      expect(given.body.data).toMatchObject({ cardRefundedAmount: 0, storeCreditRefundedAmount: 25 })
      expect((await storeCredit()).map((row) => row.amount)).toEqual(['25.00'])
      expect((await refundTheRest(bookingId, 25, 'credit')).body.error?.details).toMatchObject({ reason: 'nothing_owed' })
    })
  })

  it('control: with room left the first refusal still puts everything back exactly', async () => {
    await withBooking(onCard, async ({ bookingId, stripe }) => {
      const before = await snapshot(bookingId)
      whileTheRefundIsSent(stripe, () => Promise.resolve())
      stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
      const refused = await cancel(bookingId, 'card')
      expect(refused.status).toBe(402)
      expect(await snapshot(bookingId)).toEqual(before)
    })
  })

  it("the pass session spent meanwhile: the cancel stands and the pass stays at 0, never -1", async () => {
    const passBooking = { booking: { ...paidSeat([sam]), redemptionSource: 'session_pass_credit', sessionPassId: ID.ownedPass }, payment: {} }
    await withBooking(passBooking, async ({ bookingId, stripe, call }) => {
      await call('addBookingGuest', { bookingId, addons: [{ addonId: ID.addon, quantity: 1 }] })
      await call('addBookingGuest', { bookingId, addons: [{ addonId: ID.addon, quantity: 1 }], payment: { method: 'card' } })
      const [line] = await addonLines(bookingId)
      // The customer spends the session the cancel just gave back, before the card's answer.
      whileTheRefundIsSent(stripe, () => db.query('UPDATE customer_session_passes SET sessions_remaining = 0 WHERE id = $1', [ID.ownedPass]))
      stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
      const answer = await cancelCredit(bookingId, { addonLineIds: [line?.id ?? ''], addonRefund: 'card', confirmed: { addonsRefund: 5 } })
      expect(answer.status).toBe(200)
      // W25a: the towel's £5 is owed on the cancelled booking straight away, with Stripe's reason; no store credit.
      expect(answer.body.data?.held).toMatchObject({ reason: 'refund_refused_not_put_back', message: putBackBlockedMessage(refundRefusedDetail('Your card was declined.'), 5, true) })
      expect((await db.query<{ n: number }>('SELECT sessions_remaining AS n FROM customer_session_passes WHERE id = $1', [ID.ownedPass]))[0]?.n).toBe(0)
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'cancelled', refund_owed_amount: '5.00' })
      expect(await storeCredit()).toEqual([])
      pastTheWindow()
      expect((await runReconcile()).items.filter((item) => item.kind === 'claim')).toEqual([])
      expect(await storeCredit()).toEqual([])
    })
  })
})

describe("W25 item 8: the club's Cancel & return credit refunds paid guests in full (W23a for later)", () => {
  const passAndGuest = { booking: { ...paidSeat([sam]), redemptionSource: 'session_pass_credit', sessionPassId: ID.ownedPass }, payment: {} }
  const passSessions = async () => (await db.query<{ n: number }>('SELECT sessions_remaining AS n FROM customer_session_passes WHERE id = $1', [ID.ownedPass]))[0]?.n
  /** A pass booking with one guest paid on the card (£20). */
  async function withAPaidGuest(work: (context: Context) => Promise<void>) {
    await withBooking(passAndGuest, async (context) => {
      await context.call('addBookingGuest', { bookingId: context.bookingId, ...bea })
      await context.call('addBookingGuest', { bookingId: context.bookingId, ...bea, payment: { method: 'card' } })
      await work(context)
    })
  }

  it('from Block Session / Block Day, inside 24 hours too: cancelled, the pass session back, both places back, the guest refunded to the card', async () => {
    await withAPaidGuest(async ({ bookingId, stripe }) => {
      insideTwentyFourHours()
      // The booking page still refuses (Remove paid guests first); the club's quote shows the guests' money.
      expect((await creditQuote(bookingId)).blocked).toEqual({ reason: 'paid_guests_present', message: CANCEL_CREDIT_WORDS.paidGuestsPresent })
      const q = await creditQuote(bookingId, [], true)
      expect(q).toMatchObject({ refund: 20, addonsRefund: 0, parts: { card: 20, storeCredit: 0 }, cardRefundAvailable: true, blocked: null })
      const places = (await totalBooked()) ?? 0
      const sessions = (await passSessions()) ?? 0
      const cancelled = await cancelCredit(bookingId, { addonRefund: 'card', confirmed: { addonsRefund: 0, refund: q.refund }, clubCancelled: true })
      expect(cancelled.status).toBe(200)
      expect(cancelled.body.data).toMatchObject({ cancelled: true, creditUsableAgain: true, cardRefundedAmount: 20, storeCreditRefundedAmount: 0 })
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'cancelled', refund_owed_amount: '0.00' })
      expect(await totalBooked()).toBe(places - 2)
      expect(await passSessions()).toBe(sessions + 1)
      // One refund of the guest's £20, keyed from the claim; the guest's line stamped refunded to the card.
      const sent = refunds(stripe)
      expect(sent).toHaveLength(1)
      expect(sent[0]?.params).toMatchObject({ amount: 2000 })
      const [claim] = await auditRows(bookingId, 'booking.refund_claimed')
      expect(claim?.details).toMatchObject({ kind: 'cancel_credit', amount: 20, method: 'card' })
      const lines = await bookingLines(bookingId)
      expect(lines.filter((line) => Number(line.card_refunded_amount) === 20)).toHaveLength(1)
      expect(lines.find((line) => Number(line.card_refunded_amount) === 20)).toMatchObject({ refund_method: 'card' })
      expect((await auditRows(bookingId, 'booking.cancel_credit'))[0]?.details).toMatchObject({ clubCancelled: true, seatRefund: 20, refundMethod: 'card', cardRefunded: 20, passReturned: ID.ownedPass })
    })
  })

  it('to store credit; and what it needs: the figure staff saw, where the money goes, Issue refunds', async () => {
    await withAPaidGuest(async ({ bookingId, stripe }) => {
      // The guests' money not confirmed: refused with the new figures, nothing changed.
      const stale = await cancelCredit(bookingId, { addonRefund: 'credit', confirmed: { addonsRefund: 0 }, clubCancelled: true })
      expect(stale.body.error?.details).toMatchObject({ reason: 'refund_changed', message: REFUND_WORDS.figuresChanged })
      expect(stale.body.error?.details?.cancelQuote).toMatchObject({ refund: 20 })
      // No method: refused.
      const noMethod = await cancelCredit(bookingId, { confirmed: { addonsRefund: 0, refund: 20 }, clubCancelled: true })
      expect(noMethod.body.error?.details).toMatchObject({ reason: 'refund_method_required', message: PAID_GUESTS_REFUND_METHOD_MESSAGE })
      // No Issue refunds: refused.
      await db.query('UPDATE staff SET can_issue_refunds = false')
      const forbidden = await cancelCredit(bookingId, { addonRefund: 'credit', confirmed: { addonsRefund: 0, refund: 20 }, clubCancelled: true })
      expect(forbidden.body.error?.details).toMatchObject({ reason: 'no_refund_permission', message: ISSUE_REFUNDS_NEEDED_MESSAGE })
      await db.query('UPDATE staff SET can_issue_refunds = true')
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'confirmed', price_paid: '20.00' })

      const cancelled = await cancelCredit(bookingId, { addonRefund: 'credit', confirmed: { addonsRefund: 0, refund: 20 }, clubCancelled: true })
      expect(cancelled.body.data).toMatchObject({ cancelled: true, cardRefundedAmount: 0, storeCreditRefundedAmount: 20 })
      expect((await storeCredit()).map((row) => row.amount)).toEqual(['20.00'])
      expect(refunds(stripe)).toHaveLength(0)
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'cancelled', refund_owed_amount: '0.00' })
    })
  })

  it('the first card refund refused: nothing cancelled, everything back exactly, with words for the guests', async () => {
    await withAPaidGuest(async ({ bookingId, stripe }) => {
      const before = await snapshot(bookingId)
      stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
      const refused = await cancelCredit(bookingId, { addonRefund: 'card', confirmed: { addonsRefund: 0, refund: 20 }, clubCancelled: true })
      expect(refused.status).toBe(402)
      expect(refused.body.error?.details).toMatchObject({ reason: 'refund_failed', message: cancelCreditGuestRefundFailedMessage(refundRefusedDetail('Your card was declined.')) })
      expect(await snapshot(bookingId)).toEqual(before)
    })
  })

  it("W25a (W25 review L5): a paid guest and a ticked paid towel together: one refund choice for both, each back to its own order's card; or both to store credit", async () => {
    /** The pass booking with Bea paid on the card (£20), then a £5 towel paid on the card (Add Guest, add-ons only). */
    const withGuestAndTowel = (work: (context: Context & { lineId: string }) => Promise<void>) =>
      withAPaidGuest(async (context) => {
        const { bookingId, call } = context
        await call('addBookingGuest', { bookingId, addons: [{ addonId: ID.addon, quantity: 1 }] })
        await call('addBookingGuest', { bookingId, addons: [{ addonId: ID.addon, quantity: 1 }], payment: { method: 'card' } })
        const [line] = await addonLines(bookingId)
        await work({ ...context, lineId: line?.id ?? '' })
      })

    await withGuestAndTowel(async ({ bookingId, stripe, lineId }) => {
      insideTwentyFourHours()
      const q = await creditQuote(bookingId, [lineId], true)
      expect(q).toMatchObject({ refund: 20, addonsRefund: 5, parts: { card: 25, storeCredit: 0 }, cardRefundAvailable: true, blocked: null })
      // The towel's figure alone isn't enough: the guests' money must be confirmed with it.
      const stale = await cancelCredit(bookingId, { addonLineIds: [lineId], addonRefund: 'card', confirmed: { addonsRefund: 5 }, clubCancelled: true })
      expect(stale.body.error?.details).toMatchObject({ reason: 'refund_changed' })
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'confirmed' })
      // One choice (`addonRefund`) sends both to the card: one claim, one part per paying order (£20 and £5).
      const cancelled = await cancelCredit(bookingId, { addonLineIds: [lineId], addonRefund: 'card', confirmed: { addonsRefund: 5, refund: 20 }, clubCancelled: true })
      expect(cancelled.status).toBe(200)
      expect(cancelled.body.data).toMatchObject({ cancelled: true, cardRefundedAmount: 20, storeCreditRefundedAmount: 0, addons: { cardRefundedAmount: 5, storeCreditRefundedAmount: 0 } })
      expect(refunds(stripe).map((sent) => (sent.params as { amount: number }).amount).sort((a, b) => a - b)).toEqual([500, 2000])
      const claims = await auditRows(bookingId, 'booking.refund_claimed')
      expect(claims).toHaveLength(1)
      expect(claims[0]?.details).toMatchObject({ kind: 'cancel_credit', amount: 25, method: 'card' })
      expect(await storeCredit()).toEqual([])
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'cancelled', refund_owed_amount: '0.00' })
      expect((await addonLines(bookingId))[0]).toMatchObject({ removed_at: expect.anything(), refunded_amount: '5', card_refunded_amount: '5', refund_method: 'card' })
      expect((await bookingLines(bookingId)).filter((line) => Number(line.card_refunded_amount) === 20)).toHaveLength(1)
      expect((await auditRows(bookingId, 'booking.cancel_credit'))[0]?.details).toMatchObject({ clubCancelled: true, seatRefund: 20, addonsRefund: 5, refundMethod: 'card', cardRefunded: 25, storeCreditRefunded: 0, owed: 0 })
    })

    await withGuestAndTowel(async ({ bookingId, stripe, lineId }) => {
      const cancelled = await cancelCredit(bookingId, { addonLineIds: [lineId], addonRefund: 'credit', confirmed: { addonsRefund: 5, refund: 20 }, clubCancelled: true })
      expect(cancelled.body.data).toMatchObject({ cancelled: true, cardRefundedAmount: 0, storeCreditRefundedAmount: 20, addons: { cardRefundedAmount: 0, storeCreditRefundedAmount: 5 } })
      expect(refunds(stripe)).toHaveLength(0)
      expect((await storeCredit()).map((row) => row.amount).sort()).toEqual(['20.00', '5.00'])
      expect((await addonLines(bookingId))[0]).toMatchObject({ refunded_amount: '5', card_refunded_amount: '0', refund_method: 'credit' })
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'cancelled', refund_owed_amount: '0.00' })
    })
  })

  it('not from the booking page: the same press without the club is still refused, and so is a booking paid with money', async () => {
    await withAPaidGuest(async ({ bookingId }) => {
      const refused = await cancelCredit(bookingId, { addonRefund: 'card', confirmed: { addonsRefund: 0, refund: 20 } })
      expect(refused.body.error?.details).toMatchObject({ reason: 'paid_guests_present' })
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'confirmed' })
    })
    await withBooking(onCard, async ({ bookingId }) => {
      const refused = await cancelCredit(bookingId, { addonRefund: 'card', confirmed: { addonsRefund: 0, refund: 20 }, clubCancelled: true })
      expect(refused.body.error?.details).toMatchObject({ reason: 'not_credit_booking' })
    })
  })
})

