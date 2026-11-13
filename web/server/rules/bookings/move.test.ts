import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { POST as moveRoute } from '@/app/api/v1/staff/bookings/[bookingId]/move/route'
import { POST as moveQuoteRoute } from '@/app/api/v1/staff/bookings/[bookingId]/move/quote/route'
import { POST as partRoute } from '@/app/api/v1/staff/bookings/[bookingId]/refunds/route'
import { POST as cancelFlowRoute } from '@/app/api/v1/staff/reader-flows/[pendingId]/cancel/route'
import { POST as finaliseFlowRoute } from '@/app/api/v1/staff/reader-flows/[pendingId]/finalise/route'
import type { Db } from '@/server/db'
import { reconcile } from '@/server/rules/orders/reconcile'
import { FAILURE_MESSAGES as ORDER_WORDS } from '@/server/rules/orders/failure-messages'
import { oldSide, replay, REPLAY_USER, startReplay, type ReplayEnvironment, type ScenarioContext } from '@/server/rules/testing/replay/harness'
import { BOOKING_KINDS_ON } from '@/server/rules/testing/replay/booking-side'
import {
  ID,
  lastDayIs,
  laterPublicSession,
  memberCredit,
  mo,
  paidSeat,
  PROMO,
  publicOnCard,
  sam,
  samsOtherBookingOn,
  seed,
  seedCorePass,
  sessionsToMoveBetween,
  refundCreditFails,
  giftCardRowFails,
  whileFailing,
} from '@/server/rules/testing/replay/scenarios'
import { replayStripe } from '@/server/rules/testing/replay/stripe-binding'
import { insert } from '@/server/rules/testing/database'
import { fakeStripeErrors, type FakeStripe } from '@/server/stripe/fake'
import {
  BOOKING_PATH_OFF_MESSAGE,
  CARD_PAYMENT_OPEN_MESSAGE,
  CHANGE_PAYMENT_UNCONFIRMED_MESSAGE,
  CHANGE_REFUND_UNCONFIRMED_MESSAGE,
  MOVE_NOT_SAVED_MESSAGE,
  MOVE_PAYMENT_NEEDED_MESSAGE,
  MOVE_WORDS,
  READER_PAYMENT_OPEN_MESSAGE,
  REFUND_OPEN_MESSAGE,
  REFUND_WORDS,
  moveRefundFailedMessage,
  refundRefusedDetail,
} from './failure-messages'
import { claimRefundKey } from './refunds'

// Brief W24: Move on the Worker, through the routes as the staff app calls them, on the replay's live schema. The
// bookings are made by the old createOrder (the frozen copy). Stripe is only ever the fake. The replay's clock is
// 10 Nov 2026 09:00. Sessions: Core 12 Nov 10:00 (£20 a seat), Peak 14 Nov 18:00 (£25.50; a Core member pays 15% less
// and has no credit), a later Core session 20 Nov 10:00; private: Core 13 Nov (£100 for 1-2), Peak 14 Nov (£140 for
// 1-2), a later Core one 20 Nov (£100).

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

/** A booking made by the old createOrder, then `work` on it. `prepare` adds to the seed. */
async function withBooking(order: Record<string, unknown>, work: (context: Context) => Promise<void>, prepare?: (db: Db, stripe: FakeStripe) => Promise<void>, customerId: string = ID.customer): Promise<void> {
  await replay(
    environment,
    {
      name: 'w24 move',
      async seed(seedDb, stripe) {
        await seed(seedDb, stripe)
        await sessionsToMoveBetween(seedDb)
        await laterPublicSession(seedDb)
        await prepare?.(seedDb, stripe)
      },
      async run(context) {
        replayStripe.current = context.stripe
        const placed = (await context.call('createOrder', { customerId, ...order })) as { bookingId: string }
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

type Quote = { priceImpact: { amountDue: number; refundDue: boolean; seatDeltas: Array<{ payBy: string; creditReleased: boolean; delta: number }>; legacyPricing: boolean }; blocked: { reason: string; message: string } | null; cardRefundAvailable: boolean; refundParts: { card: number; storeCredit: number } | null }
type Answer = {
  status: number
  body: {
    ok: boolean
    data?: Record<string, unknown> & { moved?: boolean; booking?: { id: string; price_paid: number | null }; held?: { message: string }; warning?: string; pendingReaderPayment?: { pendingId: string; paymentIntentId: string } }
    error?: { code: string; message: string; details?: Record<string, unknown> & { reason?: string; message?: string; priceImpact?: Quote['priceImpact'] } }
  }
}

async function post(route: typeof moveRoute, url: string, params: Record<string, string>, body: unknown, { key = crypto.randomUUID(), orderSwitch = BOOKING_KINDS_ON, email = REPLAY_USER.email } = {}): Promise<Answer> {
  const before = process.env.ORDER_SWITCH
  process.env.ORDER_SWITCH = orderSwitch
  try {
    const response = await route(
      new Request(`https://worker.test${url}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${KEY}`, 'x-staff-email': email, 'idempotency-key': key, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve(params) }
    )
    return { status: response.status, body: (await response.json()) as Answer['body'] }
  } finally {
    if (before === undefined) delete process.env.ORDER_SWITCH
    else process.env.ORDER_SWITCH = before
  }
}

const base = (bookingId: string) => `/api/v1/staff/bookings/${bookingId}`
async function quote(bookingId: string, newSessionId: string): Promise<Quote> {
  const answer = await post(moveQuoteRoute, `${base(bookingId)}/move/quote`, { bookingId }, { newSessionId })
  if (!answer.body.data) throw new Error(JSON.stringify(answer.body))
  return answer.body.data as unknown as Quote
}
const quoteAnswer = (bookingId: string, newSessionId: string) => post(moveQuoteRoute, `${base(bookingId)}/move/quote`, { bookingId }, { newSessionId })

type Press = { payment?: Record<string, unknown>; refundMethod?: string; figures?: { amountDue: number; toCollect?: number } }
/** The move as the dialog presses it: the quote's figures as confirmed, unless `press.figures` says otherwise. */
async function move(bookingId: string, newSessionId: string, press: Press = {}, options: Parameters<typeof post>[4] = {}): Promise<Answer> {
  const figures =
    press.figures ??
    (await (async () => {
      const q = await quote(bookingId, newSessionId)
      const due = q.priceImpact.amountDue
      const parts = Number((press.payment?.['giftCard'] as { amount?: number } | undefined)?.amount ?? 0) + Number((press.payment?.['storeCredit'] as { amount?: number } | undefined)?.amount ?? 0)
      return { amountDue: due, toCollect: due > 0 ? Math.max(0, Math.round((due - parts) * 100) / 100) : 0 }
    })())
  return post(moveRoute, `${base(bookingId)}/move`, { bookingId }, { newSessionId, confirmed: true, figures, ...press }, options)
}

async function flowStep(step: 'finalise' | 'cancel', pendingId: string) {
  const route = step === 'finalise' ? finaliseFlowRoute : cancelFlowRoute
  const response = await route(
    new Request(`https://worker.test/api/v1/staff/reader-flows/${pendingId}/${step}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'x-staff-email': REPLAY_USER.email, 'idempotency-key': crypto.randomUUID(), 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }),
    { params: Promise.resolve({ pendingId }) }
  )
  return (await response.json()) as { ok: boolean; data?: Record<string, unknown> }
}

const runReconcile = () => reconcile(db, replayStripe.current as FakeStripe, { actor: { type: 'system', id: null }, requestId: crypto.randomUUID(), maxItems: 50, budgetMs: 60_000 })
const pastTheWindow = () => vi.setSystemTime(Date.now() + 16 * 60_000)
const ageFlows = (bookingId: string, minutes = 20) =>
  db.query(`UPDATE pending_reader_payments SET created_at = created_at - make_interval(mins => $2::int) WHERE record_id = $1`, [bookingId, minutes])

type BookingRow = { session_id: string; price_paid: string; refund_owed_amount: string; band_id: string | null; redemption_source: string; credit_period_id: string | null; redeemed_membership_id: string | null; redeemed_session_pass_id: string | null; start_time: string }
const bookingRow = async (bookingId: string) =>
  (
    await db.query<BookingRow>(
      `SELECT session_id, price_paid::text AS price_paid, refund_owed_amount::text AS refund_owed_amount, band_id, redemption_source, credit_period_id,
              redeemed_membership_id, redeemed_session_pass_id, start_time::text AS start_time
       FROM bookings WHERE id = $1`,
      [bookingId]
    )
  )[0] as BookingRow
const seats = (bookingId: string) => db.query<{ unit_price: string | null; pay_by: string | null }>('SELECT unit_price::text AS unit_price, pay_by FROM booking_guests WHERE booking_id = $1 ORDER BY created_at, id', [bookingId])
const places = async (sessionId: string) => (await db.query<{ n: number }>('SELECT total_booked AS n FROM sessions WHERE id = $1', [sessionId]))[0]?.n
const passLeft = async (passId: string) => (await db.query<{ n: number }>('SELECT sessions_remaining AS n FROM customer_session_passes WHERE id = $1', [passId]))[0]?.n
const flows = (bookingId: string) =>
  db.query<{ id: string; status: string; payment_intent_id: string | null; expected_amount: string; snapshot: Record<string, unknown> }>(
    'SELECT id, status, payment_intent_id, round(expected_amount, 2)::text AS expected_amount, snapshot FROM pending_reader_payments WHERE record_id = $1 ORDER BY created_at, id',
    [bookingId]
  )
const charges = (stripe: FakeStripe) => stripe.calls.filter((call) => call.method === 'paymentIntents.create')
const refunds = (stripe: FakeStripe) => stripe.calls.filter((call) => call.method === 'refunds.create')
const auditRows = (bookingId: string, action: string) =>
  db.query<{ id: string; details: Record<string, unknown> }>("SELECT id, details FROM audit_log WHERE entity_type = 'booking' AND entity_id = $1 AND action = $2 ORDER BY at, id", [bookingId, action])
const cardOrders = (bookingId: string) =>
  db.query<{ order_total: string; payment_method: string | null; line_total: string }>(
    `SELECT o.order_total::text AS order_total, o.payment_method, l.line_total::text AS line_total FROM orders o JOIN order_line_items l ON l.order_id = o.id
     WHERE l.booking_id = $1 AND o.stripe_payment_intent_id IS NOT NULL ORDER BY o.created_at, o.id`,
    [bookingId]
  )
const bookingLines = (bookingId: string) =>
  db.query<{ order_id: string; card_refunded_amount: string }>("SELECT order_id, round(card_refunded_amount, 2)::text AS card_refunded_amount FROM order_line_items WHERE booking_id = $1 AND item_type = 'booking' ORDER BY created_at, id", [bookingId])
const storeCreditRows = (customerId = ID.customer) =>
  db.query<{ amount: string; reason: string; note: string }>('SELECT amount::text AS amount, reason, note FROM store_credit_transactions WHERE customer_id = $1 ORDER BY created_at, id', [customerId])

/** Everything a refused or undone move must leave exactly as it was (updated_at aside). */
async function snapshot(bookingId: string) {
  return {
    booking: await bookingRow(bookingId),
    seats: await seats(bookingId),
    places: { core: await places(ID.session), peak: await places(ID.peakSession), later: await places(ID.laterPublicSession), privateCore: await places(ID.privateSession), peakPrivate: await places(ID.peakPrivateSession), laterPrivate: await places(ID.laterPrivateSession) },
    pass: await passLeft(ID.ownedPass),
    corePass: await passLeft(ID.ownedCorePass),
    lines: await bookingLines(bookingId),
    credit: await storeCreditRows(),
  }
}

const peakPrivateOnCard = { booking: { ...paidSeat([sam, { name: 'Alex Guest', email: 'alex@example.com' }]), sessionId: ID.peakPrivateSession }, payment: { method: 'card' } }
const passSeat = { booking: { ...paidSeat([sam]), redemptionSource: 'session_pass_credit', sessionPassId: ID.ownedCorePass }, payment: {} }

describe('the quote', () => {
  it('public, dearer: the old seat differences and £11 due; nothing changes', async () => {
    await withBooking(publicOnCard, async ({ bookingId, stripe }) => {
      const before = await snapshot(bookingId)
      const q = await quote(bookingId, ID.peakSession)
      expect(q.priceImpact).toMatchObject({ amountDue: 11, refundDue: false, legacyPricing: false })
      expect(q.priceImpact.seatDeltas.map((seat) => seat.delta)).toEqual([5.5, 5.5])
      expect(q).toMatchObject({ blocked: null, refundParts: null })
      expect(await snapshot(bookingId)).toEqual(before)
      expect(charges(stripe)).toHaveLength(1)
    })
  })

  it('private, cheaper: £40 back, all of it to the card (Q37: the card offered from card money left)', async () => {
    await withBooking(peakPrivateOnCard, async ({ bookingId }) => {
      const q = await quote(bookingId, ID.laterPrivateSession)
      expect(q).toMatchObject({ priceImpact: { amountDue: -40, refundDue: true }, cardRefundAvailable: true, refundParts: { card: 40, storeCredit: 0 } })
    })
  })

  it('refused as the old first call was: same session, type mismatch, a promo booking', async () => {
    await withBooking(publicOnCard, async ({ bookingId }) => {
      expect((await quoteAnswer(bookingId, ID.session)).body.error?.details).toMatchObject({ reason: 'same_session' })
      expect((await quoteAnswer(bookingId, ID.laterPrivateSession)).body.error?.details).toMatchObject({ reason: 'booking_type_mismatch', message: MOVE_WORDS.typeMismatch })
    })
    await withBooking({ booking: paidSeat([sam]), promoCode: PROMO.percent, payment: { method: 'card' } }, async ({ bookingId }) => {
      const answer = await quoteAnswer(bookingId, ID.laterPublicSession)
      expect(answer.body.error?.details).toMatchObject({ reason: 'promo_discounted_booking', message: MOVE_WORDS.promoDiscounted })
      // And the press too, nothing changed.
      expect((await move(bookingId, ID.laterPublicSession, { figures: { amountDue: 0 } })).body.error?.details).toMatchObject({ reason: 'promo_discounted_booking' })
      expect((await bookingRow(bookingId)).session_id).toBe(ID.session)
    })
  })
})

describe('same price, and money in with no card (one transaction)', () => {
  it('same price: both sessions\' places, the booking and `booking.move`; no money, no Stripe call', async () => {
    await withBooking(publicOnCard, async ({ bookingId, stripe }) => {
      const answer = await move(bookingId, ID.laterPublicSession)
      expect(answer.status).toBe(200)
      expect(answer.body.data).toEqual({ moved: true, booking: { id: bookingId, price_paid: 40 } })
      expect(await bookingRow(bookingId)).toMatchObject({ session_id: ID.laterPublicSession, price_paid: '40.00' })
      expect([await places(ID.session), await places(ID.laterPublicSession)]).toEqual([0, 2])
      expect(charges(stripe)).toHaveLength(1)
      const [row] = await auditRows(bookingId, 'booking.move')
      expect(row?.details).toMatchObject({ amountDue: 0, method: null, refundMethod: null, pendingId: null, oldSessionId: ID.session, newSessionId: ID.laterPublicSession })
    })
  })

  it('dearer in cash with a gift card: £5 gift card (its row names the booking, no order) and £6 cash; no order (Q36)', async () => {
    await withBooking(publicOnCard, async ({ bookingId, stripe }) => {
      const answer = await move(bookingId, ID.peakSession, { payment: { method: 'cash', confirmedCashAmount: 6, giftCard: { giftCardId: ID.giftCard, amount: 5 } } })
      expect(answer.body.data).toMatchObject({ moved: true, booking: { price_paid: 51 } })
      expect([await places(ID.session), await places(ID.peakSession)]).toEqual([0, 2])
      expect(await db.query('SELECT amount_used::text AS a, order_id FROM gift_card_redemptions WHERE booking_id = $1', [bookingId])).toEqual([{ a: '5.00', order_id: null }])
      expect(await cardOrders(bookingId)).toHaveLength(1)
      expect(charges(stripe)).toHaveLength(1)
    })
  })

  it('Q18: a penny off is refused with the new figures and nothing changes; half a penny passes', async () => {
    await withBooking(publicOnCard, async ({ bookingId, stripe }) => {
      const before = await snapshot(bookingId)
      const off = await move(bookingId, ID.peakSession, { payment: { method: 'card' }, figures: { amountDue: 10.99, toCollect: 11 } })
      expect(off.status).toBe(409)
      expect(off.body.error?.details).toMatchObject({ reason: 'amount_changed', priceImpact: { amountDue: 11 } })
      expect(await snapshot(bookingId)).toEqual(before)
      const cashOff = await move(bookingId, ID.peakSession, { payment: { method: 'cash', confirmedCashAmount: 10.99 }, figures: { amountDue: 11, toCollect: 10.99 } })
      expect(cashOff.body.error?.details).toMatchObject({ reason: 'cash_amount_changed' })
      expect(await snapshot(bookingId)).toEqual(before)
      expect(charges(stripe)).toHaveLength(1)
      const half = await move(bookingId, ID.peakSession, { payment: { method: 'cash', confirmedCashAmount: 11.005 }, figures: { amountDue: 11.005, toCollect: 11.005 } })
      expect(half.body.data).toMatchObject({ moved: true })
    })
  })

  it('a refund confirmed as a different figure is refused with the refund words', async () => {
    await withBooking(peakPrivateOnCard, async ({ bookingId, stripe }) => {
      const answer = await move(bookingId, ID.laterPrivateSession, { refundMethod: 'card', figures: { amountDue: -39.99 } })
      expect(answer.body.error?.details).toMatchObject({ reason: 'refund_changed', message: REFUND_WORDS.figuresChanged, priceImpact: { amountDue: -40 } })
      expect(refunds(stripe)).toEqual([])
    })
  })
})

describe('dearer on the card (W19\'s flow pipeline)', () => {
  it('one charge keyed from the record, C2 writes the card order and gives back the old places; price_paid £51', async () => {
    await withBooking(publicOnCard, async ({ bookingId, stripe }) => {
      const answer = await move(bookingId, ID.peakSession, { payment: { method: 'card' } })
      expect(answer.body.data).toEqual({ moved: true, booking: { id: bookingId, price_paid: 51 } })
      const [flow] = await flows(bookingId)
      expect(flow).toMatchObject({ status: 'finalised', expected_amount: '11.00', snapshot: { method: 'card' } })
      expect(flow?.snapshot).not.toHaveProperty('release_session_pass_on_finalise')
      const charge = charges(stripe).at(-1)
      expect(charge?.idempotencyKey).toBe(`${flow?.id}:charge`)
      expect((charge?.params as { metadata?: Record<string, string> }).metadata).toEqual({ flow: 'move', record_id: bookingId, pending_id: flow?.id })
      const orders = await cardOrders(bookingId)
      expect(orders).toHaveLength(2)
      expect(orders[1]).toEqual({ order_total: '11.00', payment_method: 'card', line_total: '11.00' })
      expect([await places(ID.session), await places(ID.peakSession)]).toEqual([0, 2])
      expect((await auditRows(bookingId, 'booking.move'))[0]?.details).toMatchObject({ amountDue: 11, method: 'card', toCollect: 11, pendingId: flow?.id })
    })
  })

  it('declined: undone in one transaction, the old seat never released, the new one given back; the charge\'s words', async () => {
    await withBooking(publicOnCard, async ({ bookingId, stripe }) => {
      const before = await snapshot(bookingId)
      stripe.failNext('paymentIntents.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
      const answer = await move(bookingId, ID.peakSession, { payment: { method: 'card', storeCredit: { amount: 5 } } })
      expect(answer.status).toBe(402)
      expect(answer.body.error?.details).toMatchObject({ reason: 'card_charge_failed', message: 'Failed to charge saved card: Your card was declined.' })
      const after = await snapshot(bookingId)
      // The store credit was taken and given back: two rows, the balance as it was.
      expect({ ...after, credit: [] }).toEqual({ ...before, credit: [] })
      // The replay's clock stands still on the Worker's side, so the two rows share a moment: compared in any order.
      const rows = (list: typeof after.credit) => list.map((row) => `${row.amount} ${row.reason}`).sort()
      expect(rows(after.credit)).toEqual(rows([...before.credit, { amount: '-5.00', reason: 'redemption', note: '' }, { amount: '5.00', reason: 'redemption_reversal', note: '' }]))
      expect((await flows(bookingId))[0]?.status).toBe('cancelled')
    })
  })

  it('a lost answer: held with Q35\'s words; reconcile finds the payment and finishes the move, never charging again', async () => {
    await withBooking(publicOnCard, async ({ bookingId, stripe }) => {
      stripe.failNext('paymentIntents.create', { kind: 'lost_response' })
      stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
      const held = await move(bookingId, ID.peakSession, { payment: { method: 'card' } })
      expect(held.body.error).toMatchObject({ code: 'PAYMENT_UNCONFIRMED', message: CHANGE_PAYMENT_UNCONFIRMED_MESSAGE })
      // Held: moved, the old seat still held, and every other change refused.
      expect((await bookingRow(bookingId)).session_id).toBe(ID.peakSession)
      expect([await places(ID.session), await places(ID.peakSession)]).toEqual([2, 2])
      expect((await move(bookingId, ID.laterPublicSession)).body.error?.details).toMatchObject({ reason: 'card_payment_open', message: CARD_PAYMENT_OPEN_MESSAGE })
      expect((await quote(bookingId, ID.laterPublicSession)).blocked).toEqual({ reason: 'card_payment_open', message: CARD_PAYMENT_OPEN_MESSAGE })
      const sent = charges(stripe).length
      await ageFlows(bookingId)
      const run = await runReconcile()
      expect(run.items.find((item) => item.kind === 'flow')).toMatchObject({ outcome: 'finalised' })
      expect(charges(stripe)).toHaveLength(sent)
      expect([await places(ID.session), await places(ID.peakSession)]).toEqual([0, 2])
      expect(await cardOrders(bookingId)).toHaveLength(2)
    })
  })

  it('a lost answer retried once inside the press: the same key gets Stripe\'s first answer back, so the card is charged once and the move finishes', async () => {
    await withBooking(publicOnCard, async ({ bookingId, stripe }) => {
      stripe.failNext('paymentIntents.create', { kind: 'lost_response' })
      const answer = await move(bookingId, ID.peakSession, { payment: { method: 'card' } })
      expect(answer.body.data).toMatchObject({ moved: true, booking: { price_paid: 51 } })
      const [flow] = await flows(bookingId)
      const sends = charges(stripe).filter((call) => call.idempotencyKey === `${flow?.id}:charge`)
      expect(sends).toHaveLength(2)
      expect((await cardOrders(bookingId)).map((row) => row.order_total)).toEqual(['40.00', '11.00'])
      // What Stripe really took: the £40 order and the £11 move, once each.
      expect([...stripe.chargedByIntent.values()].sort()).toEqual([1100, 4000])
      expect(stripe.netPence).toBe(5100)
    })
  })

  it('W05l later 2: a Core pass seat moved into Peak on the card with a lost answer keeps its pass session until the payment is found', async () => {
    await withBooking(
      passSeat,
      async ({ bookingId, stripe }) => {
        expect(await passLeft(ID.ownedCorePass)).toBe(2)
        const q = await quote(bookingId, ID.peakSession)
        expect(q.priceImpact).toMatchObject({ amountDue: 25.5 })
        expect(q.priceImpact.seatDeltas[0]).toMatchObject({ payBy: 'paid', creditReleased: true })
        stripe.failNext('paymentIntents.create', { kind: 'lost_response' })
        stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
        expect((await move(bookingId, ID.peakSession, { payment: { method: 'card' } })).body.error).toMatchObject({ code: 'PAYMENT_UNCONFIRMED' })
        // The pass session isn't given back yet (C2 does that), and isn't lost: the record will put it back or give it back.
        expect(await passLeft(ID.ownedCorePass)).toBe(2)
        expect((await flows(bookingId))[0]?.snapshot).toMatchObject({ release_session_pass_on_finalise: true, old_redeemed_session_pass_id: ID.ownedCorePass })
        expect((await bookingRow(bookingId)).redeemed_session_pass_id).toBeNull()
        await ageFlows(bookingId)
        expect((await runReconcile()).items.find((item) => item.kind === 'flow')).toMatchObject({ outcome: 'finalised' })
        expect(await passLeft(ID.ownedCorePass)).toBe(3)
      },
      async (seedDb) => seedCorePass(seedDb)
    )
  })

  it('the same pass move whose charge never reached Stripe: reconcile undoes it and the booking keeps its pass seat', async () => {
    await withBooking(
      passSeat,
      async ({ bookingId, stripe }) => {
        const before = await snapshot(bookingId)
        stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
        stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
        expect((await move(bookingId, ID.peakSession, { payment: { method: 'card' } })).body.error).toMatchObject({ code: 'PAYMENT_UNCONFIRMED' })
        await ageFlows(bookingId)
        expect((await runReconcile()).items.find((item) => item.kind === 'flow')).toMatchObject({ outcome: 'undone' })
        expect(await snapshot(bookingId)).toEqual(before)
      },
      async (seedDb) => seedCorePass(seedDb)
    )
  })
})

describe('dearer on the card: C2 fails after the card paid (W6-3)', () => {
  it('the gift card\'s row can\'t be written: held, never refunded; reconcile, once it works, finishes the move (order, gift card row, old places)', async () => {
    await withBooking(publicOnCard, async ({ bookingId, stripe }) => {
      const answer = await whileFailing(db, giftCardRowFails, () => move(bookingId, ID.peakSession, { payment: { method: 'card', giftCard: { giftCardId: ID.giftCard, amount: 5 } } }))
      expect(answer.body.error).toMatchObject({ code: 'PAYMENT_UNCONFIRMED', details: { reason: 'paid_not_finished' } })
      expect([await places(ID.session), await places(ID.peakSession)]).toEqual([2, 2])
      expect(refunds(stripe)).toEqual([])
      await ageFlows(bookingId)
      expect((await runReconcile()).items.find((item) => item.kind === 'flow')).toMatchObject({ outcome: 'finalised' })
      expect(refunds(stripe)).toEqual([])
      expect([await places(ID.session), await places(ID.peakSession)]).toEqual([0, 2])
      expect((await cardOrders(bookingId))[1]).toEqual({ order_total: '6.00', payment_method: 'card', line_total: '6.00' })
      expect(await db.query('SELECT amount_used::text AS a, order_id FROM gift_card_redemptions WHERE booking_id = $1', [bookingId])).toEqual([{ a: '5.00', order_id: null }])
    })
  })
})

describe('dearer on the reader (pending first, W12-7)', () => {
  it('the intent keyed from the record; the old seat held until the tap is finalised', async () => {
    await withBooking(publicOnCard, async ({ bookingId, stripe }) => {
      const answer = await move(bookingId, ID.peakSession, { payment: { method: 'reader' } })
      const pending = answer.body.data?.pendingReaderPayment
      expect(answer.body.data).toMatchObject({ moved: true, booking: { price_paid: 51 }, pendingReaderPayment: { flow: 'move', amount: 11 } })
      expect(charges(stripe).at(-1)?.idempotencyKey).toBe(`${pending?.pendingId}:reader-intent`)
      expect([await places(ID.session), await places(ID.peakSession)]).toEqual([2, 2])
      stripe.completeReaderPayment(pending?.paymentIntentId ?? '')
      expect((await flowStep('finalise', pending?.pendingId ?? '')).data).toMatchObject({ finalised: true })
      expect([await places(ID.session), await places(ID.peakSession)]).toEqual([0, 2])
    })
  })

  it('cancelled: the move undone exactly, nothing charged', async () => {
    await withBooking(publicOnCard, async ({ bookingId, stripe }) => {
      const before = await snapshot(bookingId)
      const answer = await move(bookingId, ID.peakSession, { payment: { method: 'reader', giftCard: { giftCardId: ID.giftCard, amount: 5 } } })
      const pending = answer.body.data?.pendingReaderPayment
      expect((await flowStep('cancel', pending?.pendingId ?? '')).data).toMatchObject({ cancelled: true })
      expect(await snapshot(bookingId)).toEqual(before)
      expect(await db.query('SELECT remaining_balance::text AS b FROM gift_cards WHERE id = $1', [ID.giftCard])).toEqual([{ b: '40.00' }])
      expect(stripe.calls.filter((call) => call.method === 'paymentIntents.cancel')).toHaveLength(1)
    })
  })
})

describe('cheaper (W21\'s refund pipeline)', () => {
  it('to the card: one refund per order, keyed from the claim; the line records it; booking.move written by R2', async () => {
    await withBooking(peakPrivateOnCard, async ({ bookingId, stripe }) => {
      const answer = await move(bookingId, ID.laterPrivateSession, { refundMethod: 'card' })
      expect(answer.body.data).toEqual({ moved: true, booking: { id: bookingId, price_paid: 100 } })
      const [claim] = await auditRows(bookingId, 'booking.refund_claimed')
      expect(claim?.details).toMatchObject({ kind: 'move', amount: 40, method: 'card', worker: true, move: { oldSessionId: ID.peakPrivateSession, newSessionId: ID.laterPrivateSession, placesClaimed: 10, placesReleased: 10 } })
      expect(refunds(stripe)).toHaveLength(1)
      const [line] = await bookingLines(bookingId)
      expect(refunds(stripe)[0]?.idempotencyKey).toBe(claimRefundKey(claim?.id ?? '', line?.order_id ?? ''))
      expect(line?.card_refunded_amount).toBe('40.00')
      expect([await places(ID.peakPrivateSession), await places(ID.laterPrivateSession)]).toEqual([0, 10])
      expect((await auditRows(bookingId, 'booking.move'))[0]?.details).toMatchObject({ amountDue: -40, refundMethod: 'card', cardRefunded: 40, storeCreditRefunded: 0, owed: 0 })
      expect((await auditRows(bookingId, 'booking.refund_finished'))[0]?.details).toMatchObject({ outcome: 'given', cardRefunded: 40 })
    })
  })

  it('to store credit: one transaction, the old note, no Stripe call', async () => {
    await withBooking(peakPrivateOnCard, async ({ bookingId, stripe }) => {
      const answer = await move(bookingId, ID.laterPrivateSession, { refundMethod: 'credit' })
      expect(answer.body.data).toMatchObject({ moved: true, booking: { price_paid: 100 } })
      expect(refunds(stripe)).toEqual([])
      const rows = await storeCreditRows()
      expect(rows.at(-1)).toMatchObject({ amount: '40.00', reason: 'refund' })
      expect(rows.at(-1)?.note).toMatch(/^Refund of the price difference after a booking move\. \[ref [0-9a-f-]+\]$/)
    })
  })

  it('the first card refund refused: the move put back exactly (both sessions, the booking, the seats); the new words', async () => {
    await withBooking(peakPrivateOnCard, async ({ bookingId, stripe }) => {
      const before = await snapshot(bookingId)
      stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
      const answer = await move(bookingId, ID.laterPrivateSession, { refundMethod: 'card' })
      expect(answer.status).toBe(402)
      expect(answer.body.error?.details).toMatchObject({ reason: 'refund_failed', message: moveRefundFailedMessage(refundRefusedDetail('Your card was declined.')) })
      expect(await snapshot(bookingId)).toEqual(before)
      expect((await auditRows(bookingId, 'booking.refund_finished'))[0]?.details).toMatchObject({ outcome: 'put_back' })
      expect(await auditRows(bookingId, 'booking.move')).toEqual([])
    })
  })

  it('the first refusal of a public move with a pass seat and a paid guest puts both seats and both sessions back', async () => {
    await withBooking(
      { booking: { ...paidSeat([sam, { name: 'Alex Guest', email: 'alex@example.com' }]), sessionId: ID.peakSession, redemptionSource: 'session_pass_credit', sessionPassId: ID.ownedPass }, payment: { method: 'card' } },
      async ({ bookingId, stripe }) => {
        // The all-access pass covers the later Core session, so only the guest's seat is cheaper: £5.50 back.
        const q = await quote(bookingId, ID.laterPublicSession)
        expect(q.priceImpact.amountDue).toBe(-5.5)
        const before = await snapshot(bookingId)
        stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
        expect((await move(bookingId, ID.laterPublicSession, { refundMethod: 'card' })).status).toBe(402)
        expect(await snapshot(bookingId)).toEqual(before)
      }
    )
  })

  it('the first refusal of a move that released a pass seat (past its expiry) puts back the pass session, the seat\'s cover and the booking\'s pass too', async () => {
    const guests = ['Alex', 'Bea', 'Cy', 'Di'].map((name) => ({ name: `${name} Guest`, email: `${name.toLowerCase()}@example.com` }))
    await withBooking(
      { booking: { ...paidSeat([sam, ...guests]), sessionId: ID.peakSession, redemptionSource: 'session_pass_credit', sessionPassId: ID.ownedPass }, payment: { method: 'card' } },
      async ({ bookingId, stripe }) => {
        await db.query("UPDATE customer_session_passes SET expiry_date = '2026-11-15' WHERE id = $1", [ID.ownedPass])
        // Sam's pass seat is released (the pass ends before the 20th): +£20; four guests £25.50 to £20: -£22. £2 back.
        const q = await quote(bookingId, ID.laterPublicSession)
        expect(q.priceImpact.amountDue).toBe(-2)
        expect(q.priceImpact.seatDeltas[0]).toMatchObject({ payBy: 'paid', creditReleased: true })
        const before = await snapshot(bookingId)
        expect(before.booking).toMatchObject({ redemption_source: 'session_pass_credit', redeemed_session_pass_id: ID.ownedPass })
        stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
        const answer = await move(bookingId, ID.laterPublicSession, { refundMethod: 'card' })
        expect(answer.status).toBe(402)
        // R1 had given the pass session back; the undo took it back with everything else.
        const [claim] = await auditRows(bookingId, 'booking.refund_claimed')
        expect(claim?.details).toMatchObject({ move: { passReturned: ID.ownedPass, creditReleased: true } })
        expect(await snapshot(bookingId)).toEqual(before)
      }
    )
  })

  it('no clear answer: held (the booking moved); reconcile finds it went and records it, never sending it again', async () => {
    await withBooking(peakPrivateOnCard, async ({ bookingId, stripe }) => {
      stripe.failNext('refunds.create', { kind: 'lost_response' })
      stripe.failNext('refunds.create', { kind: 'unreachable' })
      const answer = await move(bookingId, ID.laterPrivateSession, { refundMethod: 'card' })
      expect(answer.body.data).toMatchObject({ moved: true, held: { message: CHANGE_REFUND_UNCONFIRMED_MESSAGE } })
      expect((await bookingRow(bookingId)).session_id).toBe(ID.laterPrivateSession)
      // Every other refund, and a move, is refused while it is checked; the quote shows it.
      expect((await move(bookingId, ID.peakPrivateSession, { payment: { method: 'card' } })).body.error?.details).toMatchObject({ reason: 'refund_open', message: REFUND_OPEN_MESSAGE })
      expect((await quote(bookingId, ID.privateSession)).blocked).toMatchObject({ reason: 'refund_open' })
      const sent = refunds(stripe).length
      pastTheWindow()
      expect((await runReconcile()).items.find((item) => item.kind === 'claim')).toMatchObject({ outcome: 'finalised' })
      expect(refunds(stripe)).toHaveLength(sent)
      expect((await bookingLines(bookingId))[0]?.card_refunded_amount).toBe('40.00')
      expect(await bookingRow(bookingId)).toMatchObject({ price_paid: '100.00', refund_owed_amount: '0.00' })
    })
  })

  it('no clear answer and Stripe never got it: reconcile leaves it owed on the booking (Refund the rest), never resent', async () => {
    await withBooking(peakPrivateOnCard, async ({ bookingId, stripe }) => {
      stripe.failNext('refunds.create', { kind: 'unreachable' })
      stripe.failNext('refunds.create', { kind: 'unreachable' })
      expect((await move(bookingId, ID.laterPrivateSession, { refundMethod: 'card' })).body.data).toMatchObject({ moved: true, held: {} })
      pastTheWindow()
      expect((await runReconcile()).items.find((item) => item.kind === 'claim')).toMatchObject({ outcome: 'finalised' })
      expect(refunds(stripe)).toHaveLength(2)
      expect(await bookingRow(bookingId)).toMatchObject({ session_id: ID.laterPrivateSession, price_paid: '140.00', refund_owed_amount: '40.00' })
    })
  })

  it('the card part went and R2\'s store credit write failed: held, the words say what went; reconcile, once it works, records the card part and gives the planned store credit', async () => {
    await withBooking({ ...peakPrivateOnCard, payment: { method: 'card', storeCredit: { amount: 30 } } }, async ({ bookingId, stripe }) => {
      // £100 back to the card first leaves £10 on the card, so the move's £40 refund is £10 to the card and £30 to store credit.
      expect((await post(partRoute, `${base(bookingId)}/refunds`, { bookingId }, { amount: 100, refundMethod: 'card', reason: 'Goodwill' })).body.ok).toBe(true)
      const answer = await whileFailing(db, refundCreditFails, () => move(bookingId, ID.laterPrivateSession, { refundMethod: 'card' }))
      expect(answer.body.data).toMatchObject({ moved: true, held: { reason: 'refund_not_recorded' } })
      expect(answer.body.data?.held?.message).toMatch(/^£10\.00 went back to the card, but the refund couldn't be finished on the booking yet\./)
      expect(await bookingRow(bookingId)).toMatchObject({ session_id: ID.laterPrivateSession, price_paid: '0.00', refund_owed_amount: '0.00' })
      const sent = refunds(stripe).length
      pastTheWindow()
      expect((await runReconcile()).items.find((item) => item.kind === 'claim')).toMatchObject({ outcome: 'finalised' })
      expect(refunds(stripe)).toHaveLength(sent)
      expect((await bookingLines(bookingId))[0]?.card_refunded_amount).toBe('110.00')
      expect((await storeCreditRows()).at(-1)).toMatchObject({ amount: '30.00', reason: 'refund' })
      expect((await auditRows(bookingId, 'booking.move'))[0]?.details).toMatchObject({ amountDue: -40, cardRefunded: 10, storeCreditRefunded: 30, owed: 0 })
    })
  })

  it('Issue refunds only where money goes back: refused for a cheaper move before anything changes; a dearer one needs none', async () => {
    await withBooking(peakPrivateOnCard, async ({ bookingId }) => {
      await db.query('UPDATE staff SET can_issue_refunds = false WHERE id = $1', [ID.staff])
      const before = await snapshot(bookingId)
      const refused = await move(bookingId, ID.laterPrivateSession, { refundMethod: 'credit' })
      expect(refused.status).toBe(403)
      expect(refused.body.error?.details).toMatchObject({ reason: 'no_refund_permission' })
      expect(await snapshot(bookingId)).toEqual(before)
    })
    await withBooking(publicOnCard, async ({ bookingId }) => {
      await db.query('UPDATE staff SET can_issue_refunds = false WHERE id = $1', [ID.staff])
      expect((await move(bookingId, ID.peakSession, { payment: { method: 'card' } })).body.data).toMatchObject({ moved: true })
    })
  })

  it('a store credit write failing in R1 rolls the whole move back: nothing moved or refunded', async () => {
    await withBooking(peakPrivateOnCard, async ({ bookingId }) => {
      const before = await snapshot(bookingId)
      const answer = await whileFailing(db, { table: 'store_credit_transactions', event: 'INSERT', when: 'true' }, () => move(bookingId, ID.laterPrivateSession, { refundMethod: 'credit' }))
      expect(answer.status).toBe(500)
      expect(answer.body.error?.details).toMatchObject({ reason: 'move_not_saved', message: MOVE_NOT_SAVED_MESSAGE })
      expect(await snapshot(bookingId)).toEqual(before)
    })
  })
})

describe('Q34 (N2): a credit stays only if it covers the new date', () => {
  it('a membership credit moved past the membership\'s last day: released, the seat charged its full price', async () => {
    await withBooking(
      { booking: { ...paidSeat([mo]), ...memberCredit }, payment: {} },
      async ({ bookingId }) => {
        const q = await quote(bookingId, ID.laterPublicSession)
        expect(q.priceImpact.amountDue).toBe(20)
        expect(q.priceImpact.seatDeltas[0]).toMatchObject({ payBy: 'paid', creditReleased: true, delta: 20 })
        const answer = await move(bookingId, ID.laterPublicSession, { payment: { method: 'cash', confirmedCashAmount: 20 } })
        expect(answer.body.data).toMatchObject({ moved: true, booking: { price_paid: 20 } })
        expect(await bookingRow(bookingId)).toMatchObject({ redemption_source: 'paid', credit_period_id: null, redeemed_membership_id: null })
      },
      async (seedDb) => lastDayIs('2026-11-15')(seedDb),
      ID.member
    )
  })

  it('…and moved to a date the membership still covers (its last day): the credit stays, nothing due', async () => {
    await withBooking(
      { booking: { ...paidSeat([mo]), ...memberCredit }, payment: {} },
      async ({ bookingId }) => {
        const q = await quote(bookingId, ID.laterPublicSession)
        expect(q.priceImpact).toMatchObject({ amountDue: 0 })
        expect(q.priceImpact.seatDeltas[0]).toMatchObject({ payBy: 'membership_credit', creditReleased: false })
        expect((await move(bookingId, ID.laterPublicSession)).body.data).toMatchObject({ moved: true })
        expect(await bookingRow(bookingId)).toMatchObject({ redemption_source: 'membership_credit', credit_period_id: ID.creditPeriod })
      },
      async (seedDb) => lastDayIs('2026-11-20')(seedDb),
      ID.member
    )
  })

  it('a pass seat moved past the pass\'s expiry: released (its session back while unexpired), the seat charged', async () => {
    await withBooking(
      { booking: { ...paidSeat([sam]), redemptionSource: 'session_pass_credit', sessionPassId: ID.ownedPass }, payment: {} },
      async ({ bookingId }) => {
        await db.query("UPDATE customer_session_passes SET expiry_date = '2026-11-15' WHERE id = $1", [ID.ownedPass])
        expect(await passLeft(ID.ownedPass)).toBe(2)
        const q = await quote(bookingId, ID.laterPublicSession)
        expect(q.priceImpact).toMatchObject({ amountDue: 20 })
        expect(q.priceImpact.seatDeltas[0]).toMatchObject({ creditReleased: true })
        expect((await move(bookingId, ID.laterPublicSession, { payment: { method: 'cash', confirmedCashAmount: 20 } })).body.data).toMatchObject({ moved: true })
        expect(await passLeft(ID.ownedPass)).toBe(3)
        expect(await bookingRow(bookingId)).toMatchObject({ redemption_source: 'paid', redeemed_session_pass_id: null })
      }
    )
  })

  it('…and moved inside the pass\'s life: the pass seat stays, nothing due', async () => {
    await withBooking({ booking: { ...paidSeat([sam]), redemptionSource: 'session_pass_credit', sessionPassId: ID.ownedPass }, payment: {} }, async ({ bookingId }) => {
      await db.query("UPDATE customer_session_passes SET expiry_date = '2026-11-20' WHERE id = $1", [ID.ownedPass])
      const q = await quote(bookingId, ID.laterPublicSession)
      expect(q.priceImpact).toMatchObject({ amountDue: 0 })
      expect((await move(bookingId, ID.laterPublicSession)).body.data).toMatchObject({ moved: true })
      expect(await passLeft(ID.ownedPass)).toBe(2)
      expect(await bookingRow(bookingId)).toMatchObject({ redemption_source: 'session_pass_credit', redeemed_session_pass_id: ID.ownedPass })
    })
  })
})

describe('refusals before any money moves', () => {
  // W24a (W24 review S1). A member's £20 seat on a credit; the renewal fails, so the booking awaits payment with the
  // credit still on it. Moved, Q34 would release the credit and take £20, the booking would still await payment, and
  // Settle would take £20 again: £40 for a £20 seat.
  it('S1: a booking awaiting payment is refused on the quote and the press, with its own words; nothing written, no Stripe call', async () => {
    await withBooking(
      { booking: { ...paidSeat([mo]), ...memberCredit }, payment: {} },
      async ({ bookingId, stripe }) => {
        await db.query(`UPDATE customer_memberships SET subscription_status = 'past_due' WHERE id = $1`, [ID.membership])
        await db.query(`UPDATE bookings SET status = 'payment_needed', payment_due_by = now() + interval '1 day' WHERE id = $1`, [bookingId])
        const state = async () => ({
          ...(await snapshot(bookingId)),
          row: await db.query('SELECT status, payment_due_by::text AS payment_due_by, updated_at::text AS updated_at FROM bookings WHERE id = $1', [bookingId]),
          memberCredit: await storeCreditRows(ID.member),
          orders: await db.query('SELECT count(*)::int AS n FROM orders WHERE customer_id = $1', [ID.member]),
          lines: await db.query('SELECT count(*)::int AS n FROM order_line_items WHERE booking_id = $1', [bookingId]),
          audit: await db.query("SELECT count(*)::int AS n FROM audit_log WHERE entity_type = 'booking' AND entity_id = $1", [bookingId]),
          flows: await flows(bookingId),
          stripeCalls: stripe.calls.length,
        })
        const before = await state()
        expect(before.row).toMatchObject([{ status: 'payment_needed' }])
        const refused = { reason: 'booking_not_movable', message: MOVE_PAYMENT_NEEDED_MESSAGE }

        const quoted = await quoteAnswer(bookingId, ID.laterPublicSession)
        expect(quoted.status).toBe(409)
        expect(quoted.body.error?.details).toMatchObject(refused)
        expect(quoted.body.error?.details?.['screenWords']).toBeUndefined()

        // The press with the figures the old rule would have quoted (£20 due), on every way of paying.
        for (const payment of [{ method: 'cash', confirmedCashAmount: 20 }, { method: 'card' }, { method: 'reader' }, { storeCredit: { amount: 20 } }]) {
          const pressed = await move(bookingId, ID.laterPublicSession, { payment, figures: { amountDue: 20, toCollect: 20 } })
          expect(pressed.status).toBe(409)
          expect(pressed.body.error?.details).toMatchObject(refused)
        }
        // ...and with nothing due (the dialog opened while the booking was still confirmed on its credit).
        const stale = await move(bookingId, ID.laterPublicSession, { figures: { amountDue: 0 } })
        expect(stale.body.error?.details).toMatchObject(refused)

        expect(await state()).toEqual(before)
        expect(await auditRows(bookingId, 'booking.move')).toEqual([])
        expect(charges(stripe)).toEqual([])
        expect(refunds(stripe)).toEqual([])
      },
      undefined,
      ID.member
    )
  })

  it('S1: a cancelled booking keeps the screen\'s own words (no message from the Worker)', async () => {
    await withBooking(publicOnCard, async ({ bookingId }) => {
      await db.query(`UPDATE bookings SET status = 'cancelled' WHERE id = $1`, [bookingId])
      const quoted = await quoteAnswer(bookingId, ID.peakSession)
      expect(quoted.body.error?.details).toMatchObject({ reason: 'booking_not_movable', screenWords: true })
      expect(JSON.stringify(quoted.body)).not.toContain(MOVE_PAYMENT_NEEDED_MESSAGE)
    })
  })

  it('N1: another booking on the new day refuses the quote and the press with New Order\'s words; nothing charged', async () => {
    await withBooking(
      publicOnCard,
      async ({ bookingId, stripe }) => {
        const before = await snapshot(bookingId)
        expect((await quoteAnswer(bookingId, ID.peakSession)).body.error?.details).toMatchObject({ reason: 'duplicate_day_booking', message: ORDER_WORDS['duplicate_day_booking'] })
        const pressed = await move(bookingId, ID.peakSession, { payment: { method: 'card' }, figures: { amountDue: 11, toCollect: 11 } })
        expect(pressed.body.error?.details).toMatchObject({ reason: 'duplicate_day_booking', message: ORDER_WORDS['duplicate_day_booking'] })
        expect(await snapshot(bookingId)).toEqual(before)
        expect(charges(stripe)).toHaveLength(1)
      },
      async (seedDb) => samsOtherBookingOn('2026-11-14')(seedDb)
    )
  })

  it('N1 at the write (a booking made between the check and the write): the trigger\'s refusal gets the same words, never the raw text', async () => {
    const earlyThatDay = '10000000-0000-4000-8000-0000000000f2'
    await withBooking(
      publicOnCard,
      async ({ bookingId }) => {
      const before = await snapshot(bookingId)
      // The new session's places are claimed before the booking is written: a trigger there makes Sam's other booking on
      // the new day, as another press would between the check and the write. Its own insert passes (this booking is still
      // on the 12th); this booking's write then meets the one-booking-a-day trigger.
      // Tables belong to the owner, not to the Worker's role (as whileFailing does it). Test data only: fixed names.
      await db.query('RESET ROLE')
      // A trigger's body takes no parameters, so the fixed ids are written out: the early session, Sam (ID.customer) and
      // the later public session (ID.laterPublicSession).
      await db.query(`CREATE OR REPLACE FUNCTION w24_book_the_day() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          INSERT INTO bookings (session_id, customer_id, party_size, price_paid, status, start_time, end_time)
          VALUES ('10000000-0000-4000-8000-0000000000f2', '10000000-0000-4000-8000-000000000005', 1, 20, 'pending', '2026-11-20 07:00:00+00', '2026-11-20 08:00:00+00');
          RETURN NEW;
        END $$`)
      await db.query(
        `CREATE TRIGGER w24_book_the_day AFTER UPDATE OF total_booked ON sessions FOR EACH ROW WHEN (NEW.id = '10000000-0000-4000-8000-000000000042') EXECUTE FUNCTION w24_book_the_day()`
      )
      await db.query('SET ROLE paddock_worker')
      try {
        const answer = await move(bookingId, ID.laterPublicSession, { figures: { amountDue: 0 } })
        expect(answer.status).toBe(409)
        expect(answer.body.error?.details).toMatchObject({ reason: 'duplicate_day_booking', message: ORDER_WORDS['duplicate_day_booking'] })
        // The trigger's own text names the date ("…a booking on 20 Nov 2026."): never shown.
        expect(JSON.stringify(answer.body)).not.toMatch(/booking on \d/)
      } finally {
        await db.query('RESET ROLE')
        await db.query('DROP TRIGGER w24_book_the_day ON sessions')
        await db.query('DROP FUNCTION w24_book_the_day()')
        await db.query('SET ROLE paddock_worker')
      }
      expect(await snapshot(bookingId)).toEqual(before)
      },
      // An earlier session that day, not overlapping the later one, for the booking made in between.
      async (seedDb) => void (await insert(seedDb, 'sessions', { id: earlyThatDay, service_type_id: ID.serviceType, start_time: '2026-11-20 07:00:00+00', end_time: '2026-11-20 08:00:00+00', type: 'public', capacity: 10, band_id: ID.band }))
    )
  })

  it('a legacy booking (no seat prices) keeps its price: nothing due', async () => {
    await withBooking(publicOnCard, async ({ bookingId }) => {
      await db.query('UPDATE booking_guests SET unit_price = NULL WHERE booking_id = $1', [bookingId])
      const q = await quote(bookingId, ID.peakSession)
      expect(q.priceImpact).toMatchObject({ amountDue: 0, legacyPricing: true })
      // The old function answered a legacy booking's price paid as null (it keeps the price it had): so does the Worker.
      expect((await move(bookingId, ID.peakSession)).body.data).toEqual({ moved: true, booking: { id: bookingId, price_paid: null } })
      expect((await bookingRow(bookingId)).price_paid).toBe('40.00')
    })
  })

  it('a payment still being taken refuses the press with W18a\'s words; the quote shows them', async () => {
    await withBooking(publicOnCard, async ({ bookingId }) => {
      const open = await move(bookingId, ID.peakSession, { payment: { method: 'reader' } })
      expect(open.body.data?.pendingReaderPayment).toBeDefined()
      expect((await quote(bookingId, ID.laterPublicSession)).blocked).toEqual({ reason: 'reader_payment_open', message: READER_PAYMENT_OPEN_MESSAGE })
      expect((await move(bookingId, ID.laterPublicSession, { figures: { amountDue: -11 }, refundMethod: 'card' })).body.error?.details).toMatchObject({ reason: 'reader_payment_open' })
    })
  })

  it('the switch: a card move is gated (`saved_card`), a quote never', async () => {
    await withBooking(publicOnCard, async ({ bookingId }) => {
      const off = await move(bookingId, ID.peakSession, { payment: { method: 'card' } }, { orderSwitch: 'no_stripe,booking_changes' })
      expect(off.body.error).toMatchObject({ code: 'BOOKING_PATH_OFF', message: BOOKING_PATH_OFF_MESSAGE })
      const q = await post(moveQuoteRoute, `${base(bookingId)}/move/quote`, { bookingId }, { newSessionId: ID.peakSession }, { orderSwitch: '' })
      expect(q.body.ok).toBe(true)
    })
  })

  it('two tabs: the same key gets the same answer, never a second move or charge', async () => {
    await withBooking(publicOnCard, async ({ bookingId, stripe }) => {
      const key = crypto.randomUUID()
      const press = { payment: { method: 'card' }, figures: { amountDue: 11, toCollect: 11 } }
      const first = await move(bookingId, ID.peakSession, press, { key })
      const again = await move(bookingId, ID.peakSession, press, { key })
      expect(again.body).toEqual(first.body)
      expect(charges(stripe)).toHaveLength(2)
      // A second tab with a new key finds it moved already.
      expect((await move(bookingId, ID.peakSession, { payment: { method: 'card' }, figures: { amountDue: 11, toCollect: 11 } })).body.error?.details).toMatchObject({ reason: 'same_session' })
      expect(charges(stripe)).toHaveLength(2)
    })
  })

  it('a part refund then a cheaper move: Q28 (the refund stops at what is left)', async () => {
    await withBooking(peakPrivateOnCard, async ({ bookingId }) => {
      const part = await post(partRoute, `${base(bookingId)}/refunds`, { bookingId }, { amount: 120, refundMethod: 'card', reason: 'Goodwill' })
      expect(part.body.ok).toBe(true)
      const q = await quote(bookingId, ID.laterPrivateSession)
      expect(q.priceImpact.amountDue).toBe(-20)
    })
  })
})
