import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { POST as moveRoute } from '@/app/api/v1/staff/bookings/[bookingId]/move/route'
import { POST as moveQuoteRoute } from '@/app/api/v1/staff/bookings/[bookingId]/move/quote/route'
import type { Db } from '@/server/db'
import { reconcile } from '@/server/rules/orders/reconcile'
import { replay, REPLAY_USER, startReplay, type ReplayEnvironment, type ScenarioContext } from '@/server/rules/testing/sweep/run'
import { workerSide } from '@/server/rules/testing/sweep/worker'
import { BOOKING_KINDS_ON } from '@/server/rules/testing/sweep/booking-presses'
import { bea, goodwill, ID, laterPublicSession, paidSeat, peakPrivateOnCard, publicPeakOnCard, sam, seed, sessionsToMoveBetween } from '@/server/rules/testing/replay/scenarios'
import { replayStripe } from '@/server/rules/testing/replay/stripe-binding'
import type { FakeStripe } from '@/server/stripe/fake'
import { READER_PAYMENT_OPEN_MESSAGE } from './failure-messages'

/*
 * Brief W64a item 1 (W64 review S1): what the next step does with money owed on a booking. W05g's and W05h's golden
 * scenarios made the money owed on the old functions (a cheaper Move whose store credit write failed), so W64 dropped
 * them from the all-Worker sweep (sweep/sweep.ts, DROPPED). The state is reachable on the Worker, and live, the way
 * move.test.ts makes it: a cheaper Move's card refund that never reaches Stripe, found by reconcile past its window,
 * ends as money owed on the booking (`refund_owed_amount`), with `price_paid` still holding it. Each test then runs the
 * dropped scenario's next steps on the Worker, as the screens press them (sweep/worker.ts), and holds the figures
 * booking-replay accepted for it (its new side, N: the old setup, then the Worker; every difference from the golden
 * file was a key or the W53a payment-first change, none a figure: briefs/W64a-logs/owed-n-differences-read.txt).
 *
 * The replay's clock is 10 Nov 2026 09:00. Private hire: Peak 14 Nov (£140 for 1-2, £190 for 3-4), Core 13 Nov and
 * 20 Nov (£100 for 1-2, £150 for 3-4). Public seats: Peak 14 Nov £25.50, Core 12 Nov and 20 Nov £20. Store credit starts
 * at £30. Stripe is only ever the fake.
 */

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

/** One seat at Peak private hire on the card (£140): W05g's `oneOnCard`. */
const oneOnCard = { booking: { ...paidSeat([sam]), sessionId: ID.peakPrivateSession }, payment: { method: 'card' } }

type Steps = ScenarioContext & {
  bookingId: string
  /** The Move dialog: the quote, then the press with its figures (sweep/booking-presses.ts). Answers the press. */
  move(newSessionId: string, confirm?: Record<string, unknown>): Promise<Record<string, unknown>>
  /** Add Guest as the screen does it: the price first, then the payment when one is due. Answers both. */
  add(payment?: Record<string, unknown>): Promise<{ quoted: Record<string, unknown>; paid: Record<string, unknown> | null }>
}

/** A booking placed on the Worker, then `work` on it. */
async function onABooking(order: Record<string, unknown>, work: (steps: Steps) => Promise<void>, prepare: (db: Db) => Promise<void> = sessionsToMoveBetween): Promise<void> {
  await replay(
    environment,
    {
      name: 'w64a money owed',
      async seed(seedDb, stripe) {
        await seed(seedDb, stripe)
        await prepare(seedDb)
      },
      async run(context) {
        replayStripe.current = context.stripe
        const { bookingId } = (await context.call('createOrder', { customerId: ID.customer, ...order })) as { bookingId: string }
        try {
          await work({
            ...context,
            bookingId,
            async move(newSessionId, confirm = {}) {
              await context.call('moveBooking', { bookingId, newSessionId })
              return (await context.call('moveBooking', { bookingId, newSessionId, confirmed: true, ...confirm })) as Record<string, unknown>
            },
            async add(payment) {
              const quoted = (await context.call('addBookingGuest', { bookingId, ...bea })) as Record<string, unknown>
              const paid = payment ? ((await context.call('addBookingGuest', { bookingId, ...bea, payment })) as Record<string, unknown>) : null
              return { quoted, paid }
            },
          })
        } finally {
          replayStripe.current = null
        }
      },
    },
    workerSide()
  )
}

async function post(route: typeof moveRoute, url: string, bookingId: string, body: unknown) {
  const before = process.env.ORDER_SWITCH
  process.env.ORDER_SWITCH = BOOKING_KINDS_ON
  try {
    const response = await route(
      new Request(`https://worker.test${url}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${KEY}`, 'x-staff-email': REPLAY_USER.email, 'idempotency-key': crypto.randomUUID(), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ bookingId }) }
    )
    return (await response.json()) as { ok: boolean; data?: Record<string, unknown> & { priceImpact?: { amountDue: number } }; error?: unknown }
  } finally {
    if (before === undefined) delete process.env.ORDER_SWITCH
    else process.env.ORDER_SWITCH = before
  }
}

/**
 * The money owed, made on the Worker as move.test.ts makes it ("no clear answer and Stripe never got it"): a cheaper
 * Move to `to` with its refund to the card, both sends unreachable, then reconcile past the window leaves it owed.
 * Answers the amount the quote said was coming back.
 */
async function oweTheDifference({ bookingId, stripe }: Steps, to: string): Promise<number> {
  const quote = await post(moveQuoteRoute, `/api/v1/staff/bookings/${bookingId}/move/quote`, bookingId, { newSessionId: to })
  const amountDue = quote.data?.priceImpact?.amountDue ?? 0
  expect(amountDue).toBeLessThan(0)
  stripe.failNext('refunds.create', { kind: 'unreachable' })
  stripe.failNext('refunds.create', { kind: 'unreachable' })
  const held = await post(moveRoute, `/api/v1/staff/bookings/${bookingId}/move`, bookingId, { newSessionId: to, confirmed: true, figures: { amountDue }, refundMethod: 'card' })
  expect(held.data).toMatchObject({ moved: true, held: {} })
  vi.setSystemTime(Date.now() + 16 * 60_000)
  const run = await reconcile(db, stripe, { actor: { type: 'system', id: null }, requestId: crypto.randomUUID(), maxItems: 50, budgetMs: 60_000 })
  expect(run.items.find((item) => item.kind === 'claim')).toMatchObject({ outcome: 'finalised' })
  return -amountDue
}

/** The booking's money figures, as text to the penny. */
async function figures(bookingId: string) {
  return (
    await db.query<{ status: string; session_id: string; price_paid: string; part_refunded_amount: string; refund_owed_amount: string }>(
      `SELECT status, session_id, price_paid::text AS price_paid, part_refunded_amount::text AS part_refunded_amount, refund_owed_amount::text AS refund_owed_amount
       FROM bookings WHERE id = $1`,
      [bookingId]
    )
  )[0]
}

/** The PaymentIntents of the booking's orders, oldest first. */
const intents = async (bookingId: string): Promise<string[]> =>
  (
    await db.query<{ intent: string }>(
      `SELECT o.stripe_payment_intent_id AS intent FROM orders o
       WHERE o.stripe_payment_intent_id IS NOT NULL AND EXISTS (SELECT 1 FROM order_line_items l WHERE l.order_id = o.id AND l.booking_id = $1)
       ORDER BY o.created_at, o.id`,
      [bookingId]
    )
  ).map((row) => row.intent)

/** What Stripe really took and gave back, per PaymentIntent (pence), whatever calls asked for it. */
async function money(stripe: FakeStripe, bookingId: string) {
  const list = await intents(bookingId)
  return {
    charged: list.map((intent) => stripe.chargedByIntent.get(intent) ?? 0),
    refunded: list.map((intent) => stripe.refundedByIntent.get(intent) ?? 0),
  }
}

const storeCredit = async () => (await db.query<{ balance: string }>('SELECT store_credit_balance::text AS balance FROM customers WHERE id = $1', [ID.customer]))[0]?.balance
const charges = (stripe: FakeStripe) => stripe.calls.filter((call) => call.method === 'paymentIntents.create').length

describe('money owed on a booking, then the next step (W64a item 1; W05g, W05h)', () => {
  it('owed-then-a-same-price-move: the £40 owed is carried and nothing is due; Refund the rest gives the £40 once, then Cancel & Refund the £100', async () => {
    await onABooking(peakPrivateOnCard, async (steps) => {
      const { bookingId, stripe, call } = steps
      expect(await oweTheDifference(steps, ID.laterPrivateSession)).toBe(40)
      expect(await figures(bookingId)).toMatchObject({ session_id: ID.laterPrivateSession, price_paid: '140.00', part_refunded_amount: '0.00', refund_owed_amount: '40.00' })
      const quoted = (await call('moveBooking', { bookingId, newSessionId: ID.privateSession })) as { priceImpact: { amountDue: number } }
      expect(quoted.priceImpact.amountDue).toBe(0)
      expect(await steps.move(ID.privateSession)).toMatchObject({ moved: true, booking: { price_paid: 140 } })
      expect(await figures(bookingId)).toMatchObject({ session_id: ID.privateSession, price_paid: '140.00', part_refunded_amount: '0.00', refund_owed_amount: '40.00' })
      expect(await money(stripe, bookingId)).toEqual({ charged: [14000], refunded: [0] })
      expect(await call('refundBooking', { bookingId, refundMethod: 'card', amount: 40, refundOwed: true })).toMatchObject({ cardRefundedAmount: 40, storeCreditRefundedAmount: 0, pricePaid: 100 })
      expect(await figures(bookingId)).toMatchObject({ price_paid: '100.00', part_refunded_amount: '0.00', refund_owed_amount: '0.00' })
      expect(await call('refundBooking', { bookingId, refundMethod: 'card' })).toMatchObject({ cardRefundedAmount: 100, storeCreditRefundedAmount: 0 })
      expect(await figures(bookingId)).toMatchObject({ status: 'cancelled', part_refunded_amount: '0.00', refund_owed_amount: '0.00' })
      // £140 in, £140 out, each once; no store credit.
      expect(await money(stripe, bookingId)).toEqual({ charged: [14000], refunded: [14000] })
      expect(await storeCredit()).toBe('30.00')
    })
  })

  it('owed-then-a-dearer-move: only the £40 difference is charged and the £40 owed is left as it was; Refund the rest gives it from the move\'s payment, the cancel £140', async () => {
    await onABooking(peakPrivateOnCard, async (steps) => {
      const { bookingId, stripe, call } = steps
      await oweTheDifference(steps, ID.laterPrivateSession)
      const quoted = (await call('moveBooking', { bookingId, newSessionId: ID.peakPrivateSession })) as { priceImpact: { amountDue: number } }
      expect(quoted.priceImpact.amountDue).toBe(40)
      expect(await steps.move(ID.peakPrivateSession, { payment: { method: 'card' } })).toMatchObject({ moved: true, booking: { price_paid: 180 } })
      expect(await figures(bookingId)).toMatchObject({ session_id: ID.peakPrivateSession, price_paid: '180.00', part_refunded_amount: '0.00', refund_owed_amount: '40.00' })
      expect(await money(stripe, bookingId)).toEqual({ charged: [14000, 4000], refunded: [0, 0] })
      expect(await call('refundBooking', { bookingId, refundMethod: 'card', amount: 40, refundOwed: true })).toMatchObject({ cardRefundedAmount: 40, pricePaid: 140 })
      expect(await money(stripe, bookingId)).toEqual({ charged: [14000, 4000], refunded: [0, 4000] })
      expect(await call('refundBooking', { bookingId, refundMethod: 'card' })).toMatchObject({ cardRefundedAmount: 140 })
      // £180 in, £180 out.
      expect(await money(stripe, bookingId)).toEqual({ charged: [14000, 4000], refunded: [14000, 4000] })
      expect(await figures(bookingId)).toMatchObject({ status: 'cancelled', part_refunded_amount: '0.00', refund_owed_amount: '0.00' })
      expect(await storeCredit()).toBe('30.00')
    })
  })

  it('owed-then-a-dearer-move-then-cancel: Cancel & Refund gives the owed too: £180 back, £40 to the move\'s payment and £140 to the order\'s', async () => {
    await onABooking(peakPrivateOnCard, async (steps) => {
      const { bookingId, stripe, call } = steps
      await oweTheDifference(steps, ID.laterPrivateSession)
      await steps.move(ID.peakPrivateSession, { payment: { method: 'card' } })
      expect(await figures(bookingId)).toMatchObject({ price_paid: '180.00', part_refunded_amount: '0.00', refund_owed_amount: '40.00' })
      expect(await call('refundBooking', { bookingId, refundMethod: 'card' })).toMatchObject({ cardRefundedAmount: 180, storeCreditRefundedAmount: 0 })
      expect(await money(stripe, bookingId)).toEqual({ charged: [14000, 4000], refunded: [14000, 4000] })
      expect(await figures(bookingId)).toMatchObject({ status: 'cancelled', part_refunded_amount: '0.00', refund_owed_amount: '0.00' })
      // W64b (W64a check C1): the £40 owed went to the card, not to store credit as well.
      expect(await storeCredit()).toBe('30.00')
    })
  })

  it('owed-with-nothing-left-then-a-same-price-move: £110 back by a part refund, the last £30 owed; a same-price move owes nothing and takes nothing from the £30', async () => {
    await onABooking(peakPrivateOnCard, async (steps) => {
      const { bookingId, stripe, call } = steps
      expect(await call('refundBooking', { bookingId, refundMethod: 'card', amount: 110, ...goodwill })).toMatchObject({ cardRefundedAmount: 110, pricePaid: 30 })
      expect(await oweTheDifference(steps, ID.laterPrivateSession)).toBe(30)
      expect(await figures(bookingId)).toMatchObject({ price_paid: '30.00', part_refunded_amount: '110.00', refund_owed_amount: '30.00' })
      const quoted = (await call('moveBooking', { bookingId, newSessionId: ID.privateSession })) as { priceImpact: { amountDue: number } }
      expect(quoted.priceImpact.amountDue).toBe(0)
      const sent = stripe.calls.length
      expect(await steps.move(ID.privateSession, { refundMethod: 'credit' })).toMatchObject({ moved: true, booking: { price_paid: 30 } })
      expect(stripe.calls.length).toBe(sent)
      expect(await figures(bookingId)).toMatchObject({ status: 'confirmed', session_id: ID.privateSession, price_paid: '30.00', part_refunded_amount: '110.00', refund_owed_amount: '30.00' })
      expect(await money(stripe, bookingId)).toEqual({ charged: [14000], refunded: [11000] })
      expect(await storeCredit()).toBe('30.00')
    })
  })

  it('owed-public-then-a-same-price-move: public seats, £11 owed carried by a same-price move; Refund the rest to store credit (£11), then Cancel & Refund £40 to the card', async () => {
    await onABooking(
      publicPeakOnCard,
      async (steps) => {
        const { bookingId, stripe, call } = steps
        expect(await oweTheDifference(steps, ID.laterPublicSession)).toBe(11)
        expect(await figures(bookingId)).toMatchObject({ price_paid: '51.00', part_refunded_amount: '0.00', refund_owed_amount: '11.00' })
        expect(await steps.move(ID.session)).toMatchObject({ moved: true, booking: { price_paid: 51 } })
        expect(await figures(bookingId)).toMatchObject({ session_id: ID.session, price_paid: '51.00', part_refunded_amount: '0.00', refund_owed_amount: '11.00' })
        expect(await call('refundBooking', { bookingId, refundMethod: 'credit', amount: 11, refundOwed: true })).toMatchObject({ cardRefundedAmount: 0, storeCreditRefundedAmount: 11, pricePaid: 40 })
        expect(await storeCredit()).toBe('41.00')
        expect(await call('refundBooking', { bookingId, refundMethod: 'card' })).toMatchObject({ cardRefundedAmount: 40 })
        expect(await money(stripe, bookingId)).toEqual({ charged: [5100], refunded: [4000] })
        expect(await figures(bookingId)).toMatchObject({ status: 'cancelled', part_refunded_amount: '0.00', refund_owed_amount: '0.00' })
        // W64b (W64a check C1): the cancel's £40 went to the card only; the balance is still the £30 and the £11.
        expect(await storeCredit()).toBe('41.00')
      },
      laterPublicSession
    )
  })

  it('owed-then-a-guest-same-tier: a second person in the same tier is added with nothing due and the £40 owed untouched; then Refund the rest £40 and the cancel £100', async () => {
    await onABooking(oneOnCard, async (steps) => {
      const { bookingId, stripe, call } = steps
      expect(await oweTheDifference(steps, ID.laterPrivateSession)).toBe(40)
      const { quoted } = await steps.add()
      expect(quoted).toMatchObject({ added: true })
      expect(charges(stripe)).toBe(1)
      expect(await figures(bookingId)).toMatchObject({ price_paid: '140.00', part_refunded_amount: '0.00', refund_owed_amount: '40.00' })
      expect(await call('refundBooking', { bookingId, refundMethod: 'card', amount: 40, refundOwed: true })).toMatchObject({ cardRefundedAmount: 40, pricePaid: 100 })
      expect(await call('refundBooking', { bookingId, refundMethod: 'card' })).toMatchObject({ cardRefundedAmount: 100 })
      expect(await money(stripe, bookingId)).toEqual({ charged: [14000], refunded: [14000] })
      // W64b (W64a check C1): every £ went back to the card; none to store credit as well.
      expect(await figures(bookingId)).toMatchObject({ status: 'cancelled', part_refunded_amount: '0.00', refund_owed_amount: '0.00' })
      expect(await storeCredit()).toBe('30.00')
    })
  })

  it('owed-then-a-guest-higher-tier: the third person costs the full £50 (the £40 owed pays for nothing) and the owed stays; Refund the rest gives £40 from the guest\'s payment, the cancel £150', async () => {
    await onABooking(peakPrivateOnCard, async (steps) => {
      const { bookingId, stripe, call } = steps
      await oweTheDifference(steps, ID.laterPrivateSession)
      const { quoted, paid } = await steps.add({ method: 'card' })
      expect(quoted).toMatchObject({ added: false, priceImpact: { amountDue: 50, guestAmount: 50 } })
      expect(paid).toMatchObject({ added: true })
      expect(await figures(bookingId)).toMatchObject({ price_paid: '190.00', part_refunded_amount: '0.00', refund_owed_amount: '40.00' })
      expect(await money(stripe, bookingId)).toEqual({ charged: [14000, 5000], refunded: [0, 0] })
      expect(await call('refundBooking', { bookingId, refundMethod: 'card', amount: 40, refundOwed: true })).toMatchObject({ cardRefundedAmount: 40, pricePaid: 150 })
      expect(await money(stripe, bookingId)).toEqual({ charged: [14000, 5000], refunded: [0, 4000] })
      expect(await call('refundBooking', { bookingId, refundMethod: 'card' })).toMatchObject({ cardRefundedAmount: 150 })
      // £190 in, £190 out: £10 more from the guest's payment, £140 from the order's.
      expect(await money(stripe, bookingId)).toEqual({ charged: [14000, 5000], refunded: [14000, 5000] })
      expect(await figures(bookingId)).toMatchObject({ status: 'cancelled', part_refunded_amount: '0.00', refund_owed_amount: '0.00' })
      // W64b (W64a check C1): none of it went to store credit as well.
      expect(await storeCredit()).toBe('30.00')
    })
  })

  it('owed-then-remove-guest-stops-at-what-is-left: £16.50 owed and £50 part refunded leave £10, so removing the £20 guest gives £10, not the seat; Refund the rest the £16.50 to store credit', async () => {
    await onABooking(
      publicPeakOnCard,
      async (steps) => {
        const { bookingId, stripe, call } = steps
        const { paid } = await steps.add({ method: 'card' })
        const guestId = (paid as { guest?: { id: string } } | null)?.guest?.id
        expect(await oweTheDifference(steps, ID.laterPublicSession)).toBe(16.5)
        expect(await figures(bookingId)).toMatchObject({ price_paid: '76.50', part_refunded_amount: '0.00', refund_owed_amount: '16.50' })
        expect(await call('refundBooking', { bookingId, refundMethod: 'card', amount: 50, ...goodwill })).toMatchObject({ cardRefundedAmount: 50, pricePaid: 26.5 })
        // Newest first: the guest's £25.50, then £24.50 of the order's.
        expect(await money(stripe, bookingId)).toEqual({ charged: [5100, 2550], refunded: [2450, 2550] })
        expect(await figures(bookingId)).toMatchObject({ price_paid: '26.50', part_refunded_amount: '50.00', refund_owed_amount: '16.50' })
        const quote = (await call('removeBookingGuest', { guestId })) as { quote?: { refundAmount?: number } }
        expect(quote.quote?.refundAmount).toBe(10)
        expect(await call('removeBookingGuest', { guestId, confirmedRefundAmount: 10, refundMethod: 'card' })).toMatchObject({ removed: true })
        expect(await money(stripe, bookingId)).toEqual({ charged: [5100, 2550], refunded: [3450, 2550] })
        expect(await figures(bookingId)).toMatchObject({ price_paid: '16.50', part_refunded_amount: '50.00', refund_owed_amount: '16.50' })
        expect(await call('refundBooking', { bookingId, refundMethod: 'credit', amount: 16.5, refundOwed: true })).toMatchObject({ storeCreditRefundedAmount: 16.5, pricePaid: 0 })
        expect(await storeCredit()).toBe('46.50')
        expect(await figures(bookingId)).toMatchObject({ status: 'confirmed', price_paid: '0.00', part_refunded_amount: '50.00', refund_owed_amount: '0.00' })
      },
      laterPublicSession
    )
  })

  it('refund-the-rest-while-a-reader-move-is-open: Refund the rest is refused while the tap is open (the reader flow words), then gives the £11 once after the reader is cancelled', async () => {
    await onABooking(
      publicPeakOnCard,
      async (steps) => {
        const { bookingId, stripe, call } = steps
        expect(await oweTheDifference(steps, ID.laterPublicSession)).toBe(11)
        const started = (await call('moveBooking', { bookingId, newSessionId: ID.peakSession, confirmed: true, payment: { method: 'reader' } })) as { pendingReaderPayment?: { pendingId: string } }
        const pendingId = started.pendingReaderPayment?.pendingId
        expect(pendingId).toEqual(expect.any(String))
        // A reader tap still open: the reader's words (a saved-card charge still being checked has CARD_PAYMENT_OPEN_MESSAGE's).
        await expect(call('refundBooking', { bookingId, refundMethod: 'card', amount: 11, refundOwed: true })).rejects.toThrow(READER_PAYMENT_OPEN_MESSAGE)
        expect(stripe.refundedPence).toBe(0)
        expect(await figures(bookingId)).toMatchObject({ price_paid: '62.00', part_refunded_amount: '0.00', refund_owed_amount: '11.00' })
        expect(await call('cancelReaderPayment', { pendingId })).toMatchObject({ cancelled: true })
        expect(await figures(bookingId)).toMatchObject({ session_id: ID.laterPublicSession, price_paid: '51.00', part_refunded_amount: '0.00', refund_owed_amount: '11.00' })
        expect(await call('refundBooking', { bookingId, refundMethod: 'card', amount: 11, refundOwed: true })).toMatchObject({ cardRefundedAmount: 11, pricePaid: 40 })
        expect(await money(stripe, bookingId)).toEqual({ charged: [5100], refunded: [1100] })
        expect(stripe.refundedPence).toBe(1100)
        expect(await figures(bookingId)).toMatchObject({ price_paid: '40.00', part_refunded_amount: '0.00', refund_owed_amount: '0.00' })
        // W64b (W64a check C1): the £11 went to the card only.
        expect(await storeCredit()).toBe('30.00')
      },
      laterPublicSession
    )
  })

  it('figures-with-money-owed: the Part refund dialog\'s figures leave the £40 owed out of what is left (£100 card money)', async () => {
    await onABooking(peakPrivateOnCard, async (steps) => {
      const { bookingId, call } = steps
      await oweTheDifference(steps, ID.laterPrivateSession)
      expect(await call('getBookingRefundFigures', { bookingId })).toEqual({
        status: 'confirmed',
        customerId: ID.customer,
        pricePaid: 140,
        refundOwed: 40,
        left: 100,
        cardLeft: 140,
        parts: { card: 100, giftCard: 0, storeCredit: 0, cash: 0 },
        cashLeft: 0,
        paidLine: 'Left to refund: £100.00 card money.',
        paidWords: 'Paid £100.00 by card.',
      })
    })
  })

  it('owed-arrived-then-a-same-price-move: It already arrived takes the £40 off with no money moving; a same-price move then has nothing due and nothing to give', async () => {
    await onABooking(peakPrivateOnCard, async (steps) => {
      const { bookingId, stripe, call } = steps
      await oweTheDifference(steps, ID.laterPrivateSession)
      const sent = stripe.calls.length
      expect(await call('refundBooking', { bookingId, refundMethod: 'credit', amount: 40, owedArrived: true, reason: 'Found on their balance' })).toMatchObject({ cardRefundedAmount: 0, storeCreditRefundedAmount: 0, pricePaid: 100 })
      expect(await figures(bookingId)).toMatchObject({ price_paid: '100.00', part_refunded_amount: '0.00', refund_owed_amount: '0.00' })
      expect(await steps.move(ID.privateSession)).toMatchObject({ moved: true, booking: { price_paid: 100 } })
      expect(stripe.calls.length).toBe(sent)
      expect(await figures(bookingId)).toMatchObject({ status: 'confirmed', session_id: ID.privateSession, price_paid: '100.00', part_refunded_amount: '0.00', refund_owed_amount: '0.00' })
      expect(await money(stripe, bookingId)).toEqual({ charged: [14000], refunded: [0] })
      expect(await storeCredit()).toBe('30.00')
    })
  })
})
