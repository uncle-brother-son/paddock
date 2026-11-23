import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { POST as removeAddonRoute } from '@/app/api/v1/staff/bookings/addon-lines/[lineId]/remove/route'
import { POST as cancelQuoteRoute } from '@/app/api/v1/staff/bookings/[bookingId]/cancel-and-refund/quote/route'
import { POST as cancelRoute } from '@/app/api/v1/staff/bookings/[bookingId]/cancel-and-refund/route'
import { POST as guestsRoute } from '@/app/api/v1/staff/bookings/[bookingId]/guests/route'
import { POST as owedArrivedRoute } from '@/app/api/v1/staff/bookings/[bookingId]/refunds/owed-arrived/route'
import { POST as owedRoute } from '@/app/api/v1/staff/bookings/[bookingId]/refunds/owed/route'
import { POST as partRoute } from '@/app/api/v1/staff/bookings/[bookingId]/refunds/route'
import { POST as removeGuestRoute } from '@/app/api/v1/staff/bookings/guests/[guestId]/remove/route'
import type { Db } from '@/server/db'
import { reconcile } from '@/server/rules/orders/reconcile'
import { arrivedRecordedOnWords } from '@/server/rules/refunds/failure-messages'
import { BOOKING_KINDS_ON } from '@/server/rules/testing/sweep/booking-presses'
import { replay, REPLAY_USER, startReplay, type ReplayEnvironment, type ScenarioContext } from '@/server/rules/testing/sweep/run'
import { workerSide } from '@/server/rules/testing/sweep/worker'
import { asTheOldAddGuestLeftIt } from '@/server/rules/testing/sweep/old-states'
import { bea as beaOldWay, ID, paidSeat, sam, seed } from '@/server/rules/testing/replay/scenarios'
import { replayStripe } from '@/server/rules/testing/replay/stripe-binding'
import { fakeStripeErrors, type FakeStripe } from '@/server/stripe/fake'
import { orderPaymentStatusAfterRefunds, recordBookingOrdersPaymentStatus, recordOrderPaymentStatus } from './money-left'
import { guestLine } from './refunds'

// Brief W53 items 4 and 6 (the labels; card money on the line its payment took), through the routes as the staff app
// calls them, on the replay's live schema. Bookings are made through the Worker's order route; guests and later add-ons
// are added by the Worker's own Add Guest (which writes the `booking.guest_add` row W53 reads), except where a test
// says a guest was added the old way. Stripe is only ever the fake. The replay's clock is 10 Nov 2026 09:00; the
// booking's session is 12 Nov 10:00. Each test says what the same steps left before W53.

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))
vi.mock('@/server/stripe/client', async (importOriginal) => {
  const { stripeClientMock } = await import('@/server/rules/testing/replay/stripe-binding')
  return stripeClientMock(await importOriginal<typeof import('@/server/stripe/client')>())
})

vi.setConfig({ testTimeout: 120_000 })

const KEY = 'test-staff-api-key'
const alex = { name: 'Alex Guest', email: 'alex@example.com' }
const towelAddon = { addonId: ID.addon, quantity: 1, unitPrice: 5, systemUnitPrice: 5 }
/** Sam on the £20 public session with a £5 towel, one £25 card payment. */
const cardSeatAndTowel = { booking: { ...paidSeat([sam]), addons: [{ ...towelAddon, redemptionSource: 'paid' }] }, payment: { method: 'card' } }
/** Sam with a £5 towel (£25), £10 of it store credit: £15 on the card. */
const partCreditSeatAndTowel = { booking: { ...paidSeat([sam]), addons: [{ ...towelAddon, redemptionSource: 'paid' }] }, payment: { method: 'card', storeCredit: { amount: 10 } } }
/** Sam alone on the card (£20). */
const oneOnCard = { booking: paidSeat([sam]), payment: { method: 'card' } }
/** Sam and Alex on the card (£40), or in cash. */
const twoOnCard = { booking: paidSeat([sam, alex]), payment: { method: 'card' } }
const twoInCash = { booking: paidSeat([sam, alex]), payment: { method: 'cash', confirmedCashAmount: 40 } }

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

/** A booking made through the Worker's order route, then `work` on it. */
async function withBooking(order: Record<string, unknown>, work: (context: Context) => Promise<void>): Promise<void> {
  await replay(
    environment,
    {
      name: 'w53 labels',
      seed,
      async run(context) {
        replayStripe.current = context.stripe
        const placed = (await context.call('createOrder', { customerId: ID.customer, ...order })) as { bookingId: string }
        vi.setSystemTime(Date.now() + 1000)
        try {
          await work({ ...context, bookingId: placed.bookingId })
        } finally {
          replayStripe.current = null
        }
      },
    },
    workerSide()
  )
}

type Answer = {
  status: number
  body: { ok: boolean; data?: Record<string, unknown> & { held?: { claimId: string } }; error?: { code: string; message: string; details?: Record<string, unknown> & { reason?: string } } }
}
type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>

async function post(route: Handler, url: string, params: Record<string, string>, body: unknown): Promise<Answer> {
  const before = process.env.ORDER_SWITCH
  process.env.ORDER_SWITCH = BOOKING_KINDS_ON
  try {
    const response = await route(
      new Request(`https://worker.test${url}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${KEY}`, 'x-staff-email': REPLAY_USER.email, 'idempotency-key': crypto.randomUUID(), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve(params) }
    )
    // Each press a second on, so rows written by one press never tie with the next press's.
    vi.setSystemTime(Date.now() + 1000)
    return { status: response.status, body: (await response.json()) as Answer['body'] }
  } finally {
    if (before === undefined) delete process.env.ORDER_SWITCH
    else process.env.ORDER_SWITCH = before
  }
}
const ok = (answer: Answer): NonNullable<Answer['body']['data']> => {
  if (!answer.body.data) throw new Error(JSON.stringify(answer.body))
  return answer.body.data
}

const base = (bookingId: string) => `/api/v1/staff/bookings/${bookingId}`
/** A guest added by the Worker's Add Guest, paying their £20 as said: the dialog's figures sent as confirmed. */
const addGuest = (bookingId: string, guestName: string, guestEmail: string, payment: Record<string, unknown>) =>
  post(guestsRoute as Handler, `${base(bookingId)}/guests`, { bookingId }, { guestName, guestEmail, guestsOver18Confirmed: true, payment, figures: { amountDue: 20, toCollect: payment['method'] ? 20 : 0 } })
/** Bea added by the Worker's Add Guest, paying her £20 as said: the dialog's figures sent as confirmed. */
const addBea = (bookingId: string, payment: Record<string, unknown>) =>
  post(guestsRoute as Handler, `${base(bookingId)}/guests`, { bookingId }, { guestName: 'Bea Guest', guestEmail: 'bea@example.com', guestsOver18Confirmed: true, payment, figures: { amountDue: 20, toCollect: payment['method'] ? 20 : 0 } })
/** A towel added later by the Worker, on the saved card: an order of its own (£5). */
const addTowelOnCard = (bookingId: string) => post(guestsRoute as Handler, `${base(bookingId)}/guests`, { bookingId }, { addons: [{ addonId: ID.addon, quantity: 1 }], payment: { method: 'card' }, figures: { amountDue: 5, toCollect: 5 } })
const removeGuest = (guestId: string, amount: number, refundMethod: 'card' | 'credit') =>
  post(removeGuestRoute as Handler, `/api/v1/staff/bookings/guests/${guestId}/remove`, { guestId }, { confirmedRefundAmount: amount, refundMethod })
const removeAddon = (lineId: string, refund: 'card' | 'credit', amount: number) => post(removeAddonRoute as Handler, `/api/v1/staff/bookings/addon-lines/${lineId}/remove`, { lineId }, { refund, confirmed: { refund: amount } })
const partRefund = (bookingId: string, amount: number, refundMethod: string) => post(partRoute as Handler, `${base(bookingId)}/refunds`, { bookingId }, { amount, reason: 'W53 test', refundMethod })
const refundTheRest = (bookingId: string, amount: number, refundMethod: 'card' | 'credit') => post(owedRoute as Handler, `${base(bookingId)}/refunds/owed`, { bookingId }, { amount, refundMethod })
const arrived = (bookingId: string, amount: number, arrivedOn: 'card' | 'other') => post(owedArrivedRoute as Handler, `${base(bookingId)}/refunds/owed-arrived`, { bookingId }, { amount, reason: 'Seen in Stripe', arrivedOn })
/** Cancel & Refund as the dialog presses it: the quote's figures as confirmed. */
async function cancel(bookingId: string, refundMethod: 'card' | 'credit', addonLineIds: string[] = []): Promise<Answer> {
  const quote = ok(await post(cancelQuoteRoute as Handler, `${base(bookingId)}/cancel-and-refund/quote`, { bookingId }, { addonLineIds })) as { refund: number; addonsRefund: number }
  return post(cancelRoute as Handler, `${base(bookingId)}/cancel-and-refund`, { bookingId }, { refundMethod, addonLineIds, confirmed: { refund: quote.refund, addonsRefund: quote.addonsRefund } })
}

const runReconcile = () => reconcile(db, replayStripe.current as FakeStripe, { actor: { type: 'system', id: null }, requestId: crypto.randomUUID(), maxItems: 50, budgetMs: 60_000 })
const pastTheWindow = () => vi.setSystemTime(Date.now() + 16 * 60_000)
/** The next card refund never reaches Stripe (sent, and sent once more): the claim is held, and reconcile then finds nothing. */
function nextRefundNeverArrives(stripe: FakeStripe): void {
  stripe.failNext('refunds.create', { kind: 'unreachable' })
  stripe.failNext('refunds.create', { kind: 'unreachable' })
}
/** A held claim settled as reconcile settles it once its window has passed: nothing found in Stripe, so the money is owed. */
async function settleAsNeverArrived(): Promise<void> {
  pastTheWindow()
  await runReconcile()
}

const bookingRow = async (bookingId: string) =>
  (await db.query<{ status: string; price_paid: string; owed: string }>('SELECT status, price_paid::text AS price_paid, refund_owed_amount::text AS owed FROM bookings WHERE id = $1', [bookingId]))[0]
interface LineRow {
  id: string
  order_id: string
  line_total: string
  card: string
  stamped: boolean
  method: string | null
}
/** The booking's lines, oldest first: the booking's own, then each later one. */
const bookingLines = (bookingId: string) =>
  db.query<LineRow>(
    "SELECT id, order_id, line_total::text AS line_total, trim_scale(card_refunded_amount)::text AS card, (refunded_at IS NOT NULL) AS stamped, refund_method AS method FROM order_line_items WHERE booking_id = $1 AND item_type = 'booking' ORDER BY created_at, id",
    [bookingId]
  )
const addonLines = (bookingId: string) =>
  db.query<{ id: string; order_id: string | null; refunded: string; card: string; method: string | null; removed: boolean }>(
    'SELECT id, order_id, trim_scale(refunded_amount)::text AS refunded, trim_scale(card_refunded_amount)::text AS card, refund_method AS method, (removed_at IS NOT NULL) AS removed FROM addon_order_lines WHERE booking_id = $1 ORDER BY created_at, id',
    [bookingId]
  )
const statusOf = async (orderId: string | null | undefined) => (await db.query<{ payment_status: string }>('SELECT payment_status FROM orders WHERE id = $1', [orderId ?? null]))[0]?.payment_status
const guestId = async (bookingId: string, name: string) => (await db.query<{ id: string }>('SELECT id FROM booking_guests WHERE booking_id = $1 AND guest_name = $2', [bookingId, name]))[0]?.id ?? ''
const creditRows = (bookingId: string) => db.query<{ amount: string; order_id: string | null }>("SELECT amount::text AS amount, order_id FROM store_credit_transactions WHERE booking_id = $1 AND reason = 'refund' ORDER BY created_at, id", [bookingId])
const refundsSent = (stripe: FakeStripe) => stripe.calls.filter((call) => call.method === 'refunds.create').map((call) => call.params as { amount: number; payment_intent: string })
const intentOf = async (orderId: string | null | undefined) => (await db.query<{ intent: string | null }>('SELECT stripe_payment_intent_id AS intent FROM orders WHERE id = $1', [orderId ?? null]))[0]?.intent
const auditDetails = async (bookingId: string, action: string) =>
  (await db.query<{ details: Record<string, unknown> }>("SELECT details FROM audit_log WHERE entity_type = 'booking' AND entity_id = $1 AND action = $2 ORDER BY at, id", [bookingId, action])).map((row) => row.details)

/** The towel removed to the card, its £5 refund never reaching Stripe: £5 owed on the live booking, the towel's line with nothing on it. */
async function towelRefundOwed({ bookingId, stripe }: Context): Promise<{ towel: string; orderId: string; sent: number }> {
  const [towel] = await addonLines(bookingId)
  nextRefundNeverArrives(stripe)
  expect(ok(await removeAddon(towel?.id ?? '', 'card', 5)).held).toBeDefined()
  await settleAsNeverArrived()
  expect(await bookingRow(bookingId)).toEqual({ status: 'confirmed', price_paid: '25.00', owed: '5.00' })
  expect((await addonLines(bookingId))[0]).toMatchObject({ removed: true, refunded: '0', card: '0', method: 'none' })
  // `sent`: the two tries that never reached Stripe are in the fake's list of calls; what is sent after them is what counts.
  return { towel: towel?.id ?? '', orderId: towel?.order_id ?? '', sent: refundsSent(stripe).length }
}

describe("Q40 on a live booking: money owed for a removed add-on goes on the add-on's line (W47 review L1)", () => {
  it("the review's example. A seat £20 and a towel £5 on one £25 card payment; the towel's £5 refund never arrives; It already arrived on the card: the £5 is on the TOWEL's line, the seat's line still holds its £20, and a later Cancel & Refund sends all £20 to the card (before W53: £5 on the seat's line, then £15 to the card and £5 to store credit)", async () => {
    await withBooking(cardSeatAndTowel, async (context) => {
      const { bookingId, stripe } = context
      const { towel, orderId, sent } = await towelRefundOwed(context)
      const answer = ok(await arrived(bookingId, 5, 'card'))
      // One card payment on the booking, so there was no choice of payment to name.
      expect(answer['arrivedRecordedOn']).toBeUndefined()
      expect(answer['arrivedOnCard']).toBeUndefined()
      expect(await bookingRow(bookingId)).toEqual({ status: 'confirmed', price_paid: '20.00', owed: '0.00' })
      // The towel's line has its £5 as card money, and is stamped now that nothing is owed. The seat's line is untouched.
      expect((await addonLines(bookingId))[0]).toMatchObject({ refunded: '5', card: '5', method: 'card' })
      expect((await bookingLines(bookingId))[0]).toMatchObject({ card: '0', stamped: false })
      expect((await auditDetails(bookingId, 'booking.refund_owed_arrived'))[0]).toMatchObject({ amount: 5, arrivedOn: 'card', card: 5, lines: [{ lineId: towel, orderId, amount: 5, addon: true }] })
      // Nothing is sent to Stripe by It already arrived.
      expect(refundsSent(stripe).slice(sent)).toEqual([])

      const cancelled = ok(await cancel(bookingId, 'card'))
      expect(cancelled).toMatchObject({ cardRefundedAmount: 20, storeCreditRefundedAmount: 0 })
      expect(refundsSent(stripe).slice(sent)).toEqual([expect.objectContaining({ amount: 2000, payment_intent: await intentOf(orderId) })])
      expect(await creditRows(bookingId)).toEqual([])
      expect((await bookingLines(bookingId))[0]).toMatchObject({ card: '20', stamped: true, method: 'card' })
      expect(await statusOf(orderId)).toBe('refunded')
    })
  })

  it("the same with Refund the rest to the card: one £5 refund is sent and recorded on the towel's line (before W53: on the seat's line); the cancel then sends £20 to the card", async () => {
    await withBooking(cardSeatAndTowel, async (context) => {
      const { bookingId, stripe } = context
      const { towel, orderId, sent } = await towelRefundOwed(context)
      expect(ok(await refundTheRest(bookingId, 5, 'card'))).toMatchObject({ cardRefundedAmount: 5, storeCreditRefundedAmount: 0 })
      expect(refundsSent(stripe).slice(sent)).toEqual([expect.objectContaining({ amount: 500, payment_intent: await intentOf(orderId) })])
      // The claim planned it on the towel's line, marked as an add-on's.
      const claims = await auditDetails(bookingId, 'booking.refund_claimed')
      expect(claims.at(-1)).toMatchObject({ kind: 'refund_owed', amount: 5, plan: { card: [{ orderId, amount: 5, lines: [{ lineId: towel, amount: 5, addon: true }] }], storeCredit: 0 } })
      expect((await addonLines(bookingId))[0]).toMatchObject({ refunded: '5', card: '5', method: 'card' })
      expect((await bookingLines(bookingId))[0]).toMatchObject({ card: '0', stamped: false })
      expect(await bookingRow(bookingId)).toEqual({ status: 'confirmed', price_paid: '20.00', owed: '0.00' })

      expect(ok(await cancel(bookingId, 'card'))).toMatchObject({ cardRefundedAmount: 20, storeCreditRefundedAmount: 0 })
      expect(refundsSent(stripe).slice(sent).map((one) => one.amount)).toEqual([500, 2000])
      expect(await creditRows(bookingId)).toEqual([])
    })
  })

  it("Refund the rest to store credit: the towel's line reads its £5 back as store credit (before W53 it read £0 back for ever on a live booking)", async () => {
    await withBooking(cardSeatAndTowel, async (context) => {
      const { bookingId, stripe } = context
      const { sent } = await towelRefundOwed(context)
      expect(ok(await refundTheRest(bookingId, 5, 'credit'))).toMatchObject({ cardRefundedAmount: 0, storeCreditRefundedAmount: 5 })
      expect(refundsSent(stripe).slice(sent)).toEqual([])
      expect((await addonLines(bookingId))[0]).toMatchObject({ refunded: '5', card: '0', method: 'credit' })
      expect((await bookingLines(bookingId))[0]).toMatchObject({ card: '0', stamped: false })
    })
  })

  it("part of it arrives: £3 on the card goes on the towel's line, which stays unstamped while £2 is owed; Refund the rest to the card then sends the £2, fills the line and stamps it", async () => {
    await withBooking(cardSeatAndTowel, async (context) => {
      const { bookingId, stripe } = context
      const { sent } = await towelRefundOwed(context)
      ok(await arrived(bookingId, 3, 'card'))
      expect((await addonLines(bookingId))[0]).toMatchObject({ refunded: '3', card: '3', method: 'none' })
      expect(await bookingRow(bookingId)).toMatchObject({ price_paid: '22.00', owed: '2.00' })
      expect(ok(await refundTheRest(bookingId, 2, 'card'))).toMatchObject({ cardRefundedAmount: 2 })
      expect(refundsSent(stripe).slice(sent).map((one) => one.amount)).toEqual([200])
      expect((await addonLines(bookingId))[0]).toMatchObject({ refunded: '5', card: '5', method: 'card' })
      expect((await bookingLines(bookingId))[0]).toMatchObject({ card: '0', stamped: false })
    })
  })
})

describe('Q40 on a live booking when the card payment has less left than is owed', () => {
  it("Sam £20 and a towel £5, £10 of it store credit (£15 on the card). The towel's £5 refund and a £15 part refund both never arrive: £20 owed, £15 of card money. Refund the rest to the card: the towel's line takes its £5 from the card first, the seat's line the other £10, and £5 goes to store credit (with the booking lines first, the seat's line took all £15 and the towel's £5 went to store credit)", async () => {
    await withBooking(partCreditSeatAndTowel, async (context) => {
      const { bookingId, stripe } = context
      const { sent } = await towelRefundOwed({ ...context, bookingId })
      nextRefundNeverArrives(stripe)
      expect(ok(await partRefund(bookingId, 15, 'card')).held).toBeDefined()
      await settleAsNeverArrived()
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'confirmed', owed: '20.00' })
      const already = refundsSent(stripe).length
      expect(already).toBe(sent + 2)

      expect(ok(await refundTheRest(bookingId, 20, 'card'))).toMatchObject({ cardRefundedAmount: 15, storeCreditRefundedAmount: 5 })
      expect(refundsSent(stripe).slice(already).map((refund) => refund.amount)).toEqual([1500])
      expect((await addonLines(bookingId))[0]).toMatchObject({ refunded: '5', card: '5' })
      expect((await bookingLines(bookingId))[0]).toMatchObject({ card: '10' })
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'confirmed', owed: '0.00' })
    })
  })
})

describe('a booking with two card payments: a partial It already arrived names where it was recorded (W47 review L3)', () => {
  it("a cancelled booking whose seat (£20) and towel (£5) are on two orders, both refunds never arriving: £5 arrives on the card and is recorded against the towel's payment, and the answer says so; the other £20 then against the seat's", async () => {
    await withBooking(oneOnCard, async ({ bookingId, stripe }) => {
      ok(await addTowelOnCard(bookingId))
      const [towel] = await addonLines(bookingId)
      const [seat] = await bookingLines(bookingId)
      expect(towel?.order_id).toBeTruthy()
      expect(towel?.order_id).not.toBe(seat?.order_id)
      nextRefundNeverArrives(stripe)
      expect(ok(await cancel(bookingId, 'card', [towel?.id ?? ''])).held).toBeDefined()
      await settleAsNeverArrived()
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'cancelled', owed: '25.00' })
      const sent = refundsSent(stripe).length

      const first = ok(await arrived(bookingId, 5, 'card'))
      const made = async (orderId: string | null | undefined) => new Date((await db.query<{ created_at: Date | string }>('SELECT created_at FROM orders WHERE id = $1', [orderId ?? null]))[0]?.created_at ?? '').toISOString()
      expect(first['arrivedRecordedOn']).toBe(arrivedRecordedOnWords([{ amount: 5, cardPayment: 5, orderedAt: await made(towel?.order_id) }], 2))
      // W53a (W53 review L2): Stripe refuses a refund for more than a payment has left; it doesn't cap it.
      expect(first['arrivedRecordedOn']).toBe(
        'This booking has 2 card payments. Recorded as back on the card: £5.00 against the £5.00 card payment of 10 November 2026. If the money came back to a different one of them, a later card refund to that payment may be refused by Stripe and will then show as money still to refund.'
      )
      // The screens show an answer's `warning` under the result: the same words are there.
      expect(first['warning']).toBe(first['arrivedRecordedOn'])
      expect((await addonLines(bookingId))[0]).toMatchObject({ refunded: '5', card: '5' })
      expect((await bookingLines(bookingId))[0]).toMatchObject({ card: '0' })
      expect((await auditDetails(bookingId, 'booking.refund_owed_arrived'))[0]).toMatchObject({ amount: 5, card: 5, lines: [{ lineId: towel?.id, orderId: towel?.order_id, amount: 5, addon: true }] })

      const second = ok(await arrived(bookingId, 20, 'card'))
      expect(second['arrivedRecordedOn']).toBe(arrivedRecordedOnWords([{ amount: 20, cardPayment: 20, orderedAt: await made(seat?.order_id) }], 2))
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'cancelled', owed: '0.00' })
      expect((await bookingLines(bookingId))[0]).toMatchObject({ card: '20', stamped: true, method: 'card' })
      expect((await addonLines(bookingId))[0]).toMatchObject({ refunded: '5', card: '5', method: 'card' })
      expect([await statusOf(seat?.order_id), await statusOf(towel?.order_id)]).toEqual(['refunded', 'refunded'])
      expect(refundsSent(stripe).slice(sent)).toEqual([])
    })
  })

  it("W53a (W53 review L1): a payment is named by what it took on the card, not its order's total. Sam £20 and a towel £5, £10 of it store credit (£15 on the card); a second towel added on the card (its own £5 payment). The first towel's £5 refund never arrives; It already arrived on the card records it against the first payment, named as the £15.00 card payment (until W53a: the £25.00 one)", async () => {
    await withBooking(partCreditSeatAndTowel, async ({ bookingId, stripe }) => {
      ok(await addTowelOnCard(bookingId))
      const [towel, second] = await addonLines(bookingId)
      expect(second?.order_id).not.toBe(towel?.order_id)
      nextRefundNeverArrives(stripe)
      expect(ok(await removeAddon(towel?.id ?? '', 'card', 5)).held).toBeDefined()
      await settleAsNeverArrived()
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'confirmed', owed: '5.00' })

      const answer = ok(await arrived(bookingId, 5, 'card'))
      expect(answer['arrivedRecordedOn']).toBe(
        'This booking has 2 card payments. Recorded as back on the card: £5.00 against the £15.00 card payment of 10 November 2026. If the money came back to a different one of them, a later card refund to that payment may be refused by Stripe and will then show as money still to refund.'
      )
      expect((await addonLines(bookingId))[0]).toMatchObject({ refunded: '5', card: '5' })
    })
  })

  it('another way (not on the card): nothing is recorded on a line, so there is nothing to name', async () => {
    await withBooking(oneOnCard, async ({ bookingId, stripe }) => {
      ok(await addTowelOnCard(bookingId))
      const [towel] = await addonLines(bookingId)
      nextRefundNeverArrives(stripe)
      ok(await cancel(bookingId, 'card', [towel?.id ?? '']))
      await settleAsNeverArrived()
      const answer = ok(await arrived(bookingId, 5, 'other'))
      expect(answer['arrivedRecordedOn']).toBeUndefined()
      expect(answer['warning']).toBeUndefined()
    })
  })
})

describe("a removed guest's own line (W05h step E items 2 to 6)", () => {
  it("item 2, to store credit. Two in cash (£40), Bea added in cash (£20, her own order). Remove Bea to store credit: the credit is linked to BEA's order, which reads refunded; the booking's own order, which gave nothing back, still reads paid (before W53: the credit was linked to the booking's own order, which read partially_refunded)", async () => {
    await withBooking(twoInCash, async ({ bookingId, stripe }) => {
      ok(await addBea(bookingId, { method: 'cash', confirmedCashAmount: 20 }))
      const [own, beas] = await bookingLines(bookingId)
      const bea = await guestId(bookingId, 'Bea Guest')
      // What links her to her line: Add Guest's own row.
      expect(await guestLine(db, bookingId, bea)).toEqual({ id: beas?.id, orderId: beas?.order_id })
      expect(ok(await removeGuest(bea, 20, 'credit'))).toMatchObject({ removed: true, storeCreditRefundedAmount: 20, cardRefundedAmount: 0 })
      expect(await creditRows(bookingId)).toEqual([{ amount: '20.00', order_id: beas?.order_id }])
      expect((await bookingLines(bookingId)).map((line) => [line.stamped, line.method])).toEqual([
        [false, null],
        [true, 'credit'],
      ])
      expect([await statusOf(own?.order_id), await statusOf(beas?.order_id)]).toEqual(['paid', 'refunded'])
      expect((await auditDetails(bookingId, 'booking.refund_claimed'))[0]).toMatchObject({ kind: 'remove_guest', guest: { id: bea, line: { id: beas?.id, orderId: beas?.order_id } } })
      expect(refundsSent(stripe)).toEqual([])
    })
  })

  it("item 5, a cash guest refunded from another order's card. Two on the card (£40), Bea added in cash. Remove Bea to the card: the £20 comes back from the booking's own card payment, and Bea's line reads card (before W53: credit, though no store credit was given)", async () => {
    await withBooking(twoOnCard, async ({ bookingId, stripe }) => {
      ok(await addBea(bookingId, { method: 'cash', confirmedCashAmount: 20 }))
      const [own, beas] = await bookingLines(bookingId)
      expect(ok(await removeGuest(await guestId(bookingId, 'Bea Guest'), 20, 'card'))).toMatchObject({ cardRefundedAmount: 20, storeCreditRefundedAmount: 0 })
      expect(refundsSent(stripe)).toEqual([expect.objectContaining({ amount: 2000, payment_intent: await intentOf(own?.order_id) })])
      expect(await creditRows(bookingId)).toEqual([])
      const [ownAfter, beasAfter] = await bookingLines(bookingId)
      expect(beasAfter).toMatchObject({ stamped: true, method: 'card', card: '0' })
      expect(ownAfter).toMatchObject({ stamped: false, card: '20' })
      expect([await statusOf(own?.order_id), await statusOf(beas?.order_id)]).toEqual(['partially_refunded', 'refunded'])
    })
  })

  it("item 3, a guest whose seat got cheaper. Bea added on the card (£20, her own order); the seats are then £15 each, as a cheaper Move leaves them, £5 of hers given back then. Remove Bea (£15, to the card): her line is found by who added her, not by its price, and her order reads refunded (before W53: her £20 line held more than the £15 seat, so it was never found, and her order stayed partially_refunded with all of its money back)", async () => {
    await withBooking(twoOnCard, async ({ bookingId, stripe }) => {
      ok(await addBea(bookingId, { method: 'card' }))
      const [, beas] = await bookingLines(bookingId)
      // As a cheaper Move leaves the booking: each seat £15, and the £15 difference off what is on it.
      await db.query('UPDATE booking_guests SET unit_price = 15 WHERE booking_id = $1', [bookingId])
      await db.query('UPDATE bookings SET price_paid = price_paid - 15 WHERE id = $1', [bookingId])
      expect(ok(await removeGuest(await guestId(bookingId, 'Bea Guest'), 15, 'card'))).toMatchObject({ cardRefundedAmount: 15 })
      expect(refundsSent(stripe).at(-1)).toMatchObject({ amount: 1500, payment_intent: await intentOf(beas?.order_id) })
      expect((await bookingLines(bookingId))[1]).toMatchObject({ line_total: '20.00', card: '15', stamped: true, method: 'card' })
      expect(await statusOf(beas?.order_id)).toBe('refunded')
    })
  })

  /** A dearer Move's own charge, as its card flow leaves it: a £6 card order with a booking line, newer than every guest's, and the flow's finished record. */
  async function moveChargeLine(bookingId: string): Promise<string> {
    const intent = `pi_w53_move_${crypto.randomUUID().slice(0, 8)}`
    const [order] = await db.query<{ id: string }>(
      "INSERT INTO orders (customer_id, order_total, payment_status, order_source, payment_method, stripe_payment_intent_id, created_at) VALUES ($1, 6, 'paid', 'staff_created', 'card', $2, now() + interval '1 hour') RETURNING id",
      [ID.customer, intent]
    )
    const [line] = await db.query<{ id: string }>(
      "INSERT INTO order_line_items (order_id, item_type, quantity, unit_price, line_total, booking_id, created_at) VALUES ($1, 'booking', 1, 6, 6, $2, now() + interval '1 hour') RETURNING id",
      [order?.id, bookingId]
    )
    await db.query("INSERT INTO pending_reader_payments (flow, record_id, payment_intent_id, expected_amount, snapshot, status) VALUES ('move', $1, $2, 6, '{}'::jsonb, 'finalised')", [bookingId, intent])
    await db.query('UPDATE bookings SET price_paid = price_paid + 6 WHERE id = $1', [bookingId])
    return line?.id ?? ''
  }

  it("item 4, a Move's own charge line is never stamped as a guest's. Bea added by the Worker: her own line is stamped, the Move's £6 line (the newest small line on the booking) is left alone", async () => {
    await withBooking(twoInCash, async ({ bookingId }) => {
      ok(await addBea(bookingId, { method: 'cash', confirmedCashAmount: 20 }))
      const moveLine = await moveChargeLine(bookingId)
      ok(await removeGuest(await guestId(bookingId, 'Bea Guest'), 20, 'credit'))
      const lines = await bookingLines(bookingId)
      expect(lines.map((line) => [line.line_total, line.stamped])).toEqual([
        ['40.00', false],
        ['20.00', true],
        ['6.00', false],
      ])
      expect(lines.find((line) => line.id === moveLine)).toMatchObject({ stamped: false })
    })
  })

  it("item 4 again, for a guest added the old way (nothing names her line): the price guess no longer picks the Move's charge line; it picks her own (before W53: the Move's £6 line, the newest that held no more than her seat, was stamped in her place)", async () => {
    await withBooking(twoInCash, async ({ bookingId, call }) => {
      await call('addBookingGuest', { bookingId, ...beaOldWay })
      await call('addBookingGuest', { bookingId, ...beaOldWay, payment: { method: 'cash', confirmedCashAmount: 20 } })
      // W64: added through the Worker, then as the old Add Guest left her: no row names her line (sweep/old-states.ts).
      await asTheOldAddGuestLeftIt(db, bookingId)
      vi.setSystemTime(Date.now() + 1000)
      const bea = await guestId(bookingId, 'Bea Guest')
      expect(await guestLine(db, bookingId, bea)).toBeNull()
      const moveLine = await moveChargeLine(bookingId)
      ok(await removeGuest(bea, 20, 'credit'))
      const lines = await bookingLines(bookingId)
      expect(lines.map((line) => [line.line_total, line.stamped])).toEqual([
        ['40.00', false],
        ['20.00', true],
        ['6.00', false],
      ])
      expect(lines.find((line) => line.id === moveLine)).toMatchObject({ stamped: false })
      // And the store credit is linked to the order of the line that was stamped (item 2), not the booking's own.
      expect((await creditRows(bookingId))[0]?.order_id).toBe(lines[1]?.order_id)
    })
  })

  it("one of the party the booking was made with is removed while a guest added later stays: the later guest's line is not stamped as theirs (before W53 Bea's line, the newest that fitted, was stamped, and her order read refunded with Bea still booked)", async () => {
    await withBooking(twoInCash, async ({ bookingId }) => {
      ok(await addBea(bookingId, { method: 'cash', confirmedCashAmount: 20 }))
      const [own, beas] = await bookingLines(bookingId)
      ok(await removeGuest(await guestId(bookingId, 'Alex Guest'), 20, 'credit'))
      expect((await bookingLines(bookingId)).map((line) => line.stamped)).toEqual([false, false])
      // Alex's seat is in the booking's own line, so the credit is linked there, and that order reads part refunded.
      expect(await creditRows(bookingId)).toEqual([{ amount: '20.00', order_id: own?.order_id }])
      expect([await statusOf(own?.order_id), await statusOf(beas?.order_id)]).toEqual(['partially_refunded', 'paid'])
      expect(await guestId(bookingId, 'Bea Guest')).not.toBe('')
    })
  })

  it.each([
    ['Refund the rest to the card', 'card'],
    ['It already arrived on the card', 'arrived-card'],
    ['Refund the rest to store credit', 'credit'],
  ] as const)("item 6, a shortfall settled later (%s). Bea added on the card; her £20 refund never arrives, so it is owed and her line is left unstamped; once the £20 is settled her line is stamped and her order reads refunded (before W53 it stayed unstamped, and her order partially_refunded, for ever)", async (_how, how) => {
    await withBooking(twoOnCard, async ({ bookingId, stripe }) => {
      ok(await addBea(bookingId, { method: 'card' }))
      const [own, beas] = await bookingLines(bookingId)
      nextRefundNeverArrives(stripe)
      expect(ok(await removeGuest(await guestId(bookingId, 'Bea Guest'), 20, 'card')).held).toBeDefined()
      await settleAsNeverArrived()
      expect(await bookingRow(bookingId)).toEqual({ status: 'confirmed', price_paid: '60.00', owed: '20.00' })
      expect((await bookingLines(bookingId))[1]).toMatchObject({ stamped: false, card: '0' })
      // While her £20 is owed, her order doesn't read refunded.
      expect(await statusOf(beas?.order_id)).not.toBe('refunded')

      if (how === 'card') expect(ok(await refundTheRest(bookingId, 20, 'card'))).toMatchObject({ cardRefundedAmount: 20 })
      else if (how === 'arrived-card') ok(await arrived(bookingId, 20, 'card'))
      else expect(ok(await refundTheRest(bookingId, 20, 'credit'))).toMatchObject({ storeCreditRefundedAmount: 20 })

      expect(await bookingRow(bookingId)).toEqual({ status: 'confirmed', price_paid: '40.00', owed: '0.00' })
      expect((await bookingLines(bookingId))[1]).toMatchObject({ stamped: true, method: how === 'credit' ? 'credit' : 'card', card: how === 'credit' ? '0' : '20' })
      expect(await statusOf(beas?.order_id)).toBe('refunded')
      // The booking's own line, with Sam and Alex still on it, is never stamped by this.
      expect((await bookingLines(bookingId))[0]).toMatchObject({ stamped: false })
      expect(await statusOf(own?.order_id)).toBe('paid')
    })
  })
})

describe("W53a (W53 review S1; Wayne's Q40): Remove Guest refunds the payment that took the guest's seat first", () => {
  /** The card parts Remove Guest's last claim planned: each part's order and amount, in the plan's order. */
  const plannedParts = async (bookingId: string) =>
    ((await auditDetails(bookingId, 'booking.refund_claimed')).at(-1)?.['plan'] as { card: Array<{ orderId: string; amount: number }>; storeCredit: number } | undefined) ?? null

  it("the review's example. Sam and Alex on Sam's card (£40, payment A); Bea added on her own card (£20, payment B, the newest). Alex removed to the card: his £20 goes back to payment A (until W53a: to Bea's payment B). Bea removed: her £20 goes back to payment B", async () => {
    await withBooking(twoOnCard, async ({ bookingId, stripe }) => {
      ok(await addBea(bookingId, { method: 'card' }))
      const [own, beas] = await bookingLines(bookingId)
      const [a, b] = [await intentOf(own?.order_id), await intentOf(beas?.order_id)]
      expect(a).toBeTruthy()
      expect(b).toBeTruthy()
      expect(a).not.toBe(b)

      expect(ok(await removeGuest(await guestId(bookingId, 'Alex Guest'), 20, 'card'))).toMatchObject({ cardRefundedAmount: 20, storeCreditRefundedAmount: 0 })
      expect(refundsSent(stripe)).toEqual([expect.objectContaining({ amount: 2000, payment_intent: a })])
      expect(await plannedParts(bookingId)).toMatchObject({ card: [{ orderId: own?.order_id, amount: 20 }], storeCredit: 0 })
      // Bea is still booked and her payment untouched: her order still reads paid.
      expect(await statusOf(beas?.order_id)).toBe('paid')
      expect((await bookingLines(bookingId)).map((line) => line.card)).toEqual(['20', '0'])

      expect(ok(await removeGuest(await guestId(bookingId, 'Bea Guest'), 20, 'card'))).toMatchObject({ cardRefundedAmount: 20, storeCreditRefundedAmount: 0 })
      expect(refundsSent(stripe).map((one) => [one.amount, one.payment_intent])).toEqual([
        [2000, a],
        [2000, b],
      ])
      expect((await bookingLines(bookingId)).map((line) => [line.card, line.stamped])).toEqual([
        ['20', false],
        ['20', true],
      ])
      expect([await statusOf(own?.order_id), await statusOf(beas?.order_id)]).toEqual(['partially_refunded', 'refunded'])
      expect(await creditRows(bookingId)).toEqual([])
    })
  })

  it("the older of two guests (the replay's remove-guest-the-older-of-two). Bea, then Cy, each added on their own card. Bea removed to the card: her £20 goes back to her own payment, not Cy's newer one (until W53a: Cy's); Cy's order still reads paid", async () => {
    await withBooking(oneOnCard, async ({ bookingId, stripe }) => {
      ok(await addGuest(bookingId, 'Bea Guest', 'bea@example.com', { method: 'card' }))
      ok(await addGuest(bookingId, 'Cy Guest', 'cy@example.com', { method: 'card' }))
      const [, beas, cys] = await bookingLines(bookingId)
      expect(ok(await removeGuest(await guestId(bookingId, 'Bea Guest'), 20, 'card'))).toMatchObject({ cardRefundedAmount: 20 })
      expect(refundsSent(stripe)).toEqual([expect.objectContaining({ amount: 2000, payment_intent: await intentOf(beas?.order_id) })])
      expect([await statusOf(beas?.order_id), await statusOf(cys?.order_id)]).toEqual(['refunded', 'paid'])
      expect((await bookingLines(bookingId)).map((line) => [line.card, line.stamped])).toEqual([
        ['0', false],
        ['20', true],
        ['0', false],
      ])
    })
  })

  it("a guest added by the OLD Add Guest (no booking.guest_add row) on her own card: her £20 goes back to her own payment, the order of the line R2 stamps as hers (W53's price guess; Wayne, 21 Nov), not the booking's own; one of the original party removed later goes back to the booking's own payment", async () => {
    await withBooking(twoOnCard, async ({ bookingId, call, stripe }) => {
      await call('addBookingGuest', { bookingId, ...beaOldWay })
      await call('addBookingGuest', { bookingId, ...beaOldWay, payment: { method: 'card' } })
      // W64: added through the Worker, then as the old Add Guest left her: no row names her line (sweep/old-states.ts).
      await asTheOldAddGuestLeftIt(db, bookingId)
      vi.setSystemTime(Date.now() + 1000)
      const bea = await guestId(bookingId, 'Bea Guest')
      expect(await guestLine(db, bookingId, bea)).toBeNull()
      const [own, beas] = await bookingLines(bookingId)
      const [a, b] = [await intentOf(own?.order_id), await intentOf(beas?.order_id)]
      expect(a).not.toBe(b)
      // Sent before her: the old code's own calls to the fake (none are refunds).
      expect(refundsSent(stripe)).toEqual([])

      expect(ok(await removeGuest(bea, 20, 'card'))).toMatchObject({ cardRefundedAmount: 20 })
      expect(refundsSent(stripe)).toEqual([expect.objectContaining({ amount: 2000, payment_intent: b })])
      expect((await bookingLines(bookingId)).map((line) => [line.card, line.stamped])).toEqual([
        ['0', false],
        ['20', true],
      ])

      expect(ok(await removeGuest(await guestId(bookingId, 'Alex Guest'), 20, 'card'))).toMatchObject({ cardRefundedAmount: 20 })
      expect(refundsSent(stripe).map((one) => one.payment_intent)).toEqual([b, a])
    })
  })

  it("a guest whose own payment has less left than the seat. Sam and Alex £40, £30 of it store credit (£10 on payment A); Bea on her own card (£20, payment B); a £15 part refund to the card comes off B (the newest), leaving it £5. Bea removed (£20) to the card: £5 from her own payment B first, then £10 from the other payment A, then £5 to store credit", async () => {
    const twoPartCredit = { booking: paidSeat([sam, alex]), payment: { method: 'card', storeCredit: { amount: 30 } } }
    await withBooking(twoPartCredit, async ({ bookingId, stripe }) => {
      ok(await addBea(bookingId, { method: 'card' }))
      const [own, beas] = await bookingLines(bookingId)
      const [a, b] = [await intentOf(own?.order_id), await intentOf(beas?.order_id)]
      expect(ok(await partRefund(bookingId, 15, 'card'))).toMatchObject({ cardRefundedAmount: 15 })
      expect(refundsSent(stripe)).toEqual([expect.objectContaining({ amount: 1500, payment_intent: b })])

      expect(ok(await removeGuest(await guestId(bookingId, 'Bea Guest'), 20, 'card'))).toMatchObject({ cardRefundedAmount: 15, storeCreditRefundedAmount: 5 })
      expect(await plannedParts(bookingId)).toMatchObject({
        card: [
          { orderId: beas?.order_id, amount: 5 },
          { orderId: own?.order_id, amount: 10 },
        ],
        storeCredit: 5,
      })
      expect(refundsSent(stripe).slice(1).map((one) => [one.amount, one.payment_intent])).toEqual([
        [500, b],
        [1000, a],
      ])
      expect(await creditRows(bookingId)).toEqual([{ amount: '5.00', order_id: beas?.order_id }])
      expect(await bookingRow(bookingId)).toMatchObject({ price_paid: '25.00', owed: '0.00' })
    })
  })
})

describe('W53a (W53 review L5): a recount never writes to an order that was never paid', () => {
  it.each(['pending', 'failed'] as const)("an order reading %s is left alone by both recounts, though its lines would read part refunded; the same order reading paid is recounted", async (unpaid) => {
    await withBooking(twoOnCard, async ({ bookingId }) => {
      const [own] = await bookingLines(bookingId)
      const orderId = own?.order_id ?? ''
      expect(ok(await partRefund(bookingId, 20, 'card'))).toMatchObject({ cardRefundedAmount: 20 })
      expect(await statusOf(orderId)).toBe('partially_refunded')
      expect(await orderPaymentStatusAfterRefunds(db, orderId)).toBe('partially_refunded')

      // The order as T1 or a failed payment would leave it (a test fixture: no route writes this after a refund).
      await db.query('UPDATE orders SET payment_status = $1 WHERE id = $2', [unpaid, orderId])
      expect(await recordOrderPaymentStatus(db, orderId)).toBe('partially_refunded')
      await recordBookingOrdersPaymentStatus(db, bookingId)
      expect(await statusOf(orderId)).toBe(unpaid)

      for (const paid of ['paid', 'refunded'] as const) {
        await db.query('UPDATE orders SET payment_status = $1 WHERE id = $2', [paid, orderId])
        await recordBookingOrdersPaymentStatus(db, bookingId)
        expect(await statusOf(orderId)).toBe('partially_refunded')
        await db.query('UPDATE orders SET payment_status = $1 WHERE id = $2', [paid, orderId])
        await recordOrderPaymentStatus(db, orderId)
        expect(await statusOf(orderId)).toBe('partially_refunded')
      }
    })
  })
})

describe('cash, and money owed (the W26 audit\'s row 10; W32 "Noticed" 4)', () => {
  it("a cash part refund: £10 of a £40 cash booking handed back in cash, and its order reads partially_refunded (before W53 it stayed paid: nothing on the order records cash handed back)", async () => {
    await withBooking(twoInCash, async ({ bookingId }) => {
      const [own] = await bookingLines(bookingId)
      expect(await statusOf(own?.order_id)).toBe('paid')
      expect(ok(await partRefund(bookingId, 10, 'cash'))).toMatchObject({ cashRefundedAmount: 10 })
      expect(await statusOf(own?.order_id)).toBe('partially_refunded')
      expect(await bookingRow(bookingId)).toMatchObject({ price_paid: '30.00', owed: '0.00' })
    })
  })

  it("a card booking's order is not moved by cash handed back for a cash guest on another order: only the cash order reads part refunded", async () => {
    await withBooking(twoOnCard, async ({ bookingId }) => {
      ok(await addBea(bookingId, { method: 'cash', confirmedCashAmount: 20 }))
      const [own, beas] = await bookingLines(bookingId)
      expect(ok(await partRefund(bookingId, 5, 'cash'))).toMatchObject({ cashRefundedAmount: 5 })
      expect([await statusOf(own?.order_id), await statusOf(beas?.order_id)]).toEqual(['paid', 'partially_refunded'])
    })
  })

  it("money owed after a cancel. Two on the card (£40) and Bea on the card (£20): Cancel & Refund sends Bea's £20, and the £40 is refused, so £40 is owed with every line stamped. Neither order reads refunded while it is owed; once Refund the rest gives it, both do (before W53 both read refunded from the cancel on, with £40 still to refund)", async () => {
    await withBooking(twoOnCard, async ({ bookingId, stripe }) => {
      ok(await addBea(bookingId, { method: 'card' }))
      const [own, beas] = await bookingLines(bookingId)
      // Newest order first: Bea's part goes, the booking's own is refused.
      stripe.failNext('refunds.create', { kind: 'none' })
      stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
      expect(ok(await cancel(bookingId, 'card'))).toMatchObject({ cardRefundedAmount: 20 })
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'cancelled', owed: '40.00' })
      expect((await bookingLines(bookingId)).map((line) => line.stamped)).toEqual([true, true])
      expect([await statusOf(own?.order_id), await statusOf(beas?.order_id)]).toEqual(['partially_refunded', 'partially_refunded'])

      // On a cancelled booking Refund the rest is store credit only.
      expect(ok(await refundTheRest(bookingId, 40, 'credit'))).toMatchObject({ storeCreditRefundedAmount: 40 })
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'cancelled', owed: '0.00' })
      expect([await statusOf(own?.order_id), await statusOf(beas?.order_id)]).toEqual(['refunded', 'refunded'])
    })
  })
})

describe("an order the refund never touched is worked out again when what is owed changes (W32 \"Noticed\" 4)", () => {
  it("Bea and Cat each added on the card (their own orders). Bea removed to store credit (linked to her order): her order reads refunded. Cat removed to the card, her £20 never arriving: £20 owed on the booking, so Bea's order reads part refunded though nothing on it changed; It already arrived (another way) then settles the £20, Cat's line is stamped and both orders read refunded", async () => {
    await withBooking(oneOnCard, async ({ bookingId, stripe }) => {
      ok(await addGuest(bookingId, 'Bea Guest', 'bea@example.com', { method: 'card' }))
      ok(await addGuest(bookingId, 'Cat Guest', 'cat@example.com', { method: 'card' }))
      const [own, beas, cats] = await bookingLines(bookingId)
      expect(new Set([own?.order_id, beas?.order_id, cats?.order_id]).size).toBe(3)

      // To store credit, so no card payment is touched (until W53a a card refund came from the newest card payment,
      // Cat's: W53 report, "Noticed" 3; since W53a it comes from Bea's own).
      expect(ok(await removeGuest(await guestId(bookingId, 'Bea Guest'), 20, 'credit'))).toMatchObject({ storeCreditRefundedAmount: 20 })
      expect([await statusOf(own?.order_id), await statusOf(beas?.order_id), await statusOf(cats?.order_id)]).toEqual(['paid', 'refunded', 'paid'])

      nextRefundNeverArrives(stripe)
      expect(ok(await removeGuest(await guestId(bookingId, 'Cat Guest'), 20, 'card')).held).toBeDefined()
      await settleAsNeverArrived()
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'confirmed', owed: '20.00' })
      // Bea's order: the press that made money owed touched only Cat's order.
      expect([await statusOf(own?.order_id), await statusOf(beas?.order_id), await statusOf(cats?.order_id)]).toEqual(['paid', 'partially_refunded', 'paid'])

      ok(await arrived(bookingId, 20, 'other'))
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'confirmed', owed: '0.00' })
      expect((await bookingLines(bookingId)).map((line) => line.stamped)).toEqual([false, true, true])
      // Bea's order again: It already arrived touched only Cat's line.
      expect([await statusOf(own?.order_id), await statusOf(beas?.order_id), await statusOf(cats?.order_id)]).toEqual(['paid', 'refunded', 'refunded'])
    })
  })
})

describe('a refund that fails later (W32 "Noticed" 4)', () => {
  it("two on the card (£40) and Bea on the card (£20): Cancel & Refund's two refunds are accepted, then Bea's fails at Stripe. Her £20 is owed again, and neither order reads refunded while it is, the booking's own included, though its own refund stands (before W53 both went on reading refunded); It already arrived on the card then leaves nothing owed and both read refunded", async () => {
    await withBooking(twoOnCard, async ({ bookingId, stripe }) => {
      ok(await addBea(bookingId, { method: 'card' }))
      const [own, beas] = await bookingLines(bookingId)
      stripe.refundsStayPending = true
      expect(ok(await cancel(bookingId, 'card'))).toMatchObject({ cardRefundedAmount: 60 })
      stripe.refundsStayPending = false
      expect([await statusOf(own?.order_id), await statusOf(beas?.order_id)]).toEqual(['refunded', 'refunded'])

      const beasRefund = stripe.refundsSent.find((sent) => sent.amount === 2000)
      stripe.settleRefund(beasRefund?.id as string, 'failed')
      await runReconcile()
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'cancelled', owed: '20.00' })
      expect((await bookingLines(bookingId)).map((line) => [line.stamped, line.card])).toEqual([
        [true, '40'],
        [true, '0'],
      ])
      expect([await statusOf(own?.order_id), await statusOf(beas?.order_id)]).toEqual(['partially_refunded', 'partially_refunded'])

      ok(await arrived(bookingId, 20, 'card'))
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'cancelled', owed: '0.00' })
      expect([await statusOf(own?.order_id), await statusOf(beas?.order_id)]).toEqual(['refunded', 'refunded'])
    })
  })
})

describe("an order's status, worked out from its lines (W47 review L5)", () => {
  /** An order of Sam's with a booking line for the booking (seat money as given) and a towel line on it, removed and refunded to the card. */
  async function seatAndRefundedTowel(bookingId: string, seatMoney: number): Promise<string> {
    const [order] = await db.query<{ id: string }>("INSERT INTO orders (customer_id, order_total, payment_status, order_source, payment_method) VALUES ($1, $2, 'paid', 'staff_created', 'cash') RETURNING id", [ID.customer, seatMoney + 20])
    await db.query("INSERT INTO order_line_items (order_id, item_type, quantity, unit_price, line_total, booking_id) VALUES ($1, 'booking', 1, $2, $2, $3)", [order?.id, seatMoney, bookingId])
    await db.query(
      "INSERT INTO addon_order_lines (booking_id, addon_id, quantity, price_at_purchase, sku_at_purchase, redemption_source, order_id, removed_at, refunded_amount, card_refunded_amount, refund_method) VALUES ($1, $2, 4, 5, 'TOWEL', 'paid', $3, now(), 20, 0, 'credit')",
      [bookingId, ID.addon, order?.id]
    )
    return order?.id ?? ''
  }

  it("a cancelled booking's line with no stamp that still holds seat money (kept by a lapse or a cancel inside 24 hours) is counted: with the towels refunded the order reads partially_refunded (before W53: refunded, though the guest's £20 was kept); a line that held no seat money is still left out", async () => {
    await withBooking(twoInCash, async ({ bookingId }) => {
      const kept = await seatAndRefundedTowel(bookingId, 20)
      const creditSeat = await seatAndRefundedTowel(bookingId, 0)
      // While the booking is live both lines count, as they always did.
      expect([await orderPaymentStatusAfterRefunds(db, kept), await orderPaymentStatusAfterRefunds(db, creditSeat)]).toEqual(['partially_refunded', 'partially_refunded'])
      await db.query("UPDATE bookings SET status = 'cancelled', cancelled_at = now() WHERE id = $1", [bookingId])
      expect(await orderPaymentStatusAfterRefunds(db, kept)).toBe('partially_refunded')
      expect(await orderPaymentStatusAfterRefunds(db, creditSeat)).toBe('refunded')
      // With nothing refunded at all a kept seat's order is left as it is (null), as before.
      await db.query("UPDATE addon_order_lines SET removed_at = NULL, refunded_amount = 0, refund_method = NULL WHERE order_id = $1", [kept])
      expect(await orderPaymentStatusAfterRefunds(db, kept)).toBeNull()
    })
  })
})
