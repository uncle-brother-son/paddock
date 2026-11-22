import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { GET as bookingFiguresRoute } from '@/app/api/v1/staff/bookings/[bookingId]/refund-figures/route'
import { GET as figuresRoute } from '@/app/api/v1/staff/orders/[orderId]/refund-figures/route'
import { POST as refundRoute } from '@/app/api/v1/staff/orders/[orderId]/refunds/route'
import { POST as owedRoute } from '@/app/api/v1/staff/orders/[orderId]/refunds/owed/route'
import { POST as closeRoute } from '@/app/api/v1/staff/orders/stuck/close/route'
import { DbTimeoutError, type Db, type Tx } from '@/server/db'
import { reconcile } from '@/server/rules/orders/reconcile'
import { stuckList } from '@/server/rules/orders/stuck-list'
import { MEMBERSHIP_REFUND_WORDS, membershipUsedWords, ORDER_REFUND_NEW_WORDS as NEW_WORDS, ORDER_REFUND_WORDS as WORDS } from '@/server/rules/refunds/failure-messages'
import { withSwitch } from '@/server/rules/testing/sweep/booking-presses'
import { replay, REPLAY_USER, startReplay, type ReplayEnvironment } from '@/server/rules/testing/sweep/run'
import { workerSide } from '@/server/rules/testing/sweep/worker'
import { asTheOldCreateOrderRecordedIt } from '@/server/rules/testing/sweep/old-states'
import { ORDER_REFUND_KINDS_ON } from '@/server/rules/testing/sweep/order-refund-presses'
import { orderInput, postOrder, postReaderStep, withQuotedCardFigure, type OrderAnswer } from '@/server/rules/testing/sweep/order-presses'
import { ID, laterPublicSession, paidSeat, sam, seed } from '@/server/rules/testing/replay/scenarios'
import { replayStripe } from '@/server/rules/testing/replay/stripe-binding'
import { fakeStripeErrors, type FakeStripe } from '@/server/stripe/fake'
import { loadOrderCardPortion } from '@/server/rules/bookings/money-left'
import { orderOwedArrived, refundOrderLines, type OrderRefundOptions } from './refund-lines'

// Brief W29 (E-plan 4.3, 4.9, 5.1; Wayne's Q40 and Q41; bugs E3, E4, E10): the membership line and the payment date
// change charge, through the routes as the staff app calls them, on the replay's live schema (its functions and
// triggers included). The orders are placed by the Worker's own order route, so each carries the record a live order
// carries (orders.reader_payment, with the membership's own payment); one test places an order with the old
// createOrder, for an order from before that record. Stripe is only ever the fake.

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

let environment: ReplayEnvironment
let db: Db
beforeAll(async () => {
  process.env.STAFF_API_KEY = KEY
  environment = await startReplay()
  db = environment.database.db
  holder.db = db
})
afterAll(() => environment.stop())

const soap = { productVariantId: ID.variant, quantity: 2, unitPrice: 12, systemUnitPrice: 12 }
const monthly = { membershipPlanId: ID.plan, membershipBillingFrequency: 'monthly' }
const card = { method: 'card' }

type Answer = {
  status: number
  body: {
    ok: boolean
    data?: Record<string, unknown> & { held?: { claimId: string; reason: string; message: string } }
    error?: { code: string; message: string; details?: { reason?: string; message?: string; figures?: Record<string, unknown> } }
  }
}
type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>

async function post(path: 'refunds' | 'refunds/owed', orderId: string, body: unknown): Promise<Answer> {
  return withSwitch(ORDER_REFUND_KINDS_ON, async () => {
    const response = await ((path === 'refunds' ? refundRoute : owedRoute) as Handler)(
      new Request(`https://worker.test/api/v1/staff/orders/${orderId}/${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${KEY}`, 'x-staff-email': REPLAY_USER.email, 'idempotency-key': crypto.randomUUID(), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ orderId }) }
    )
    return { status: response.status, body: (await response.json()) as Answer['body'] }
  })
}

type LineFigures = { lineItemId: string; itemType: string; refundable: number; blocked: { reason: string; message: string } | null; membership?: { creditSessionsTaken: number; futureCreditBookings: number }; ownCardLeft?: number }
type Figures = { lines: LineFigures[]; cardLeft: number; cashLeft: number; refundOwed: number; owedCard?: { payment: string; left: number }; blocked: unknown }

async function figures(orderId: string): Promise<Figures> {
  const response = await (figuresRoute as Handler)(
    new Request(`https://worker.test/api/v1/staff/orders/${orderId}/refund-figures`, { headers: { authorization: `Bearer ${KEY}`, 'x-staff-email': REPLAY_USER.email } }),
    { params: Promise.resolve({ orderId }) }
  )
  return ((await response.json()) as { data: Figures }).data
}

/** A refund as the dialog presses it: the figures' total for the chosen lines sent back as confirmed. */
async function refund(orderId: string, lineItemIds: string[], refundMethod: string): Promise<Answer> {
  const shown = (await figures(orderId)).lines.filter((line) => lineItemIds.includes(line.lineItemId)).reduce((total, line) => total + line.refundable, 0)
  return post('refunds', orderId, { lineItemIds, refundMethod, restock: Object.fromEntries(lineItemIds.map((id) => [id, false])), confirmed: { amount: Math.round(shown * 100) / 100 } })
}

const place = async (params: Record<string, unknown>): Promise<OrderAnswer> => postOrder(await withQuotedCardFigure(orderInput(params)))
const placed = async (params: Record<string, unknown>): Promise<string> => {
  const answer = await place({ customerId: ID.customer, ...params })
  if (!answer.body.ok) throw new Error(`The order was refused: ${answer.body.error.code} ${answer.body.error.message} ${JSON.stringify(answer.body.error.details)}`)
  return answer.body.data.orderId
}

/** A seeded database with the later public session, the fake Stripe bound, then `work`. */
async function onASeed(work: (stripe: FakeStripe) => Promise<void>): Promise<void> {
  await replay(
    environment,
    {
      name: 'w29 membership refunds',
      async seed(seedDb, stripe) {
        await seed(seedDb, stripe)
        await laterPublicSession(seedDb)
      },
      async run({ stripe }) {
        replayStripe.current = stripe
        try {
          await work(stripe)
        } finally {
          replayStripe.current = null
        }
      },
    },
    (_db, stripe) => ({ name: 'test', call: async () => stripe })
  )
}

const linesOf = async (orderId: string, itemType?: string) =>
  (await db.query<{ id: string }>('SELECT id FROM order_line_items WHERE order_id = $1::uuid AND ($2::text IS NULL OR item_type = $2::text) ORDER BY created_at, id', [orderId, itemType ?? null])).map((row) => row.id)
const lineRows = async (orderId: string) =>
  db.query<{ item_type: string; refunded: boolean; refund_method: string | null; card: string }>(
    'SELECT item_type, refunded_at IS NOT NULL AS refunded, refund_method, card_refunded_amount::numeric(10,2)::text AS card FROM order_line_items WHERE order_id = $1 ORDER BY created_at, id',
    [orderId]
  )
const orderRow = async (orderId: string) =>
  (await db.query<{ payment_status: string; owed: string; intent: string | null; own: string | null }>(
    "SELECT payment_status, refund_owed_amount::text AS owed, stripe_payment_intent_id AS intent, reader_payment->'membership'->>'subscription_payment_intent_id' AS own FROM orders WHERE id = $1",
    [orderId]
  ))[0]
const membership = async () =>
  (await db.query<{ id: string; subscription: string | null; status: string; addons: number; ends: string | null }>(
    'SELECT id, stripe_subscription_id AS subscription, subscription_status AS status, addon_credits_remaining AS addons, cancel_effective_date::text AS ends FROM customer_memberships WHERE customer_id = $1 ORDER BY created_at DESC, id LIMIT 1',
    [ID.customer]
  ))[0] as { id: string; subscription: string | null; status: string; addons: number; ends: string | null }
const creditBookings = async (membershipId: string) =>
  db.query<{ id: string; session_id: string; status: string; due: boolean }>('SELECT id, session_id, status, payment_due_by IS NOT NULL AS due FROM bookings WHERE redeemed_membership_id = $1 ORDER BY start_time, id', [membershipId])
const auditRows = async (action: string) => db.query<{ id: string; entity_id: string; details: Record<string, unknown> }>('SELECT id, entity_id, details FROM audit_log WHERE action = $1 ORDER BY at, id', [action])
const storeCredit = async () => Number((await db.query<{ balance: string }>('SELECT store_credit_balance::text AS balance FROM customers WHERE id = $1', [ID.customer]))[0]?.balance)
const refundsSent = (stripe: FakeStripe) => stripe.calls.filter((call) => call.method === 'refunds.create').map((call) => call.params as { payment_intent: string; amount: number })
const cancelsSent = (stripe: FakeStripe) => stripe.calls.filter((call) => call.method === 'subscriptions.cancel').map((call) => (call.params as { id: string }).id)
const subscriptionStatus = async (stripe: FakeStripe, id: string) => (await stripe.subscriptions.retrieve(id)).status
const leftWarnings = async () => (await stuckList(db)).warnings.filter((warning) => warning.close?.kind === 'subscription_left')
const runReconcile = (stripe: FakeStripe) => reconcile(db, stripe, { actor: { type: 'system', id: null }, requestId: crypto.randomUUID(), maxItems: 50, budgetMs: 60_000 })
const pastTheWindow = () => vi.setSystemTime(Date.now() + 16 * 60_000)

/** A credit booking on the membership, placed as New Order places it. */
async function bookOnCredit(membershipId: string, sessionId: string): Promise<void> {
  await placed({ booking: { ...paidSeat(), sessionId, redemptionSource: 'membership_credit', membershipId }, payment: {} })
}

/** A Core membership on the saved card (£40, one card payment: the first invoice's), used once and booked once more. */
async function usedMembership(): Promise<{ orderId: string; line: string; membershipId: string; subscription: string; taken: string; future: string }> {
  const orderId = await placed({ ...monthly, payment: card })
  const [line] = await linesOf(orderId, 'membership')
  const made = await membership()
  await bookOnCredit(made.id, ID.session)
  await bookOnCredit(made.id, ID.laterPublicSession)
  // The first one has been and gone: a credit session already taken.
  await db.query("UPDATE bookings SET start_time = start_time - interval '30 days', status = 'completed' WHERE redeemed_membership_id = $1 AND session_id = $2", [made.id, ID.session])
  const bookings = await db.query<{ id: string; session_id: string }>('SELECT id, session_id FROM bookings WHERE redeemed_membership_id = $1', [made.id])
  return {
    orderId,
    line: line as string,
    membershipId: made.id,
    subscription: made.subscription as string,
    taken: bookings.find((booking) => booking.session_id === ID.session)?.id as string,
    future: bookings.find((booking) => booking.session_id === ID.laterPublicSession)?.id as string,
  }
}

describe('the membership line (brief W29 items 1, 2 and 4)', () => {
  it('Q41: the figures say how much of the membership was used before the press, and the refund flags the future credit booking in the same step; the subscription is cancelled last', async () => {
    await onASeed(async (stripe) => {
      const { orderId, line, membershipId, subscription, taken, future } = await usedMembership()
      const before = await figures(orderId)
      expect(before.lines.find((one) => one.lineItemId === line)).toMatchObject({ itemType: 'membership', refundable: 40, blocked: null, membership: { creditSessionsTaken: 1, futureCreditBookings: 1 } })
      // One card payment (the first invoice's, which the order names): no payment of its own to show.
      expect(before.lines.find((one) => one.lineItemId === line)?.ownCardLeft).toBeUndefined()
      expect(before.cardLeft).toBe(40)
      expect(membershipUsedWords(1, 1)).toBe('1 credit session already taken; 1 future credit booking will need payment.')

      const answer = await refund(orderId, [line], 'card')
      expect(answer.body.data).toEqual({ refundedAmount: 40, refundMethod: 'card', cardRefundedAmount: 40, orderPaymentStatus: 'refunded', bookingsFlagged: 1 })
      // The whole £40 back to the payment that took it, then the cancel: in that order, and nothing else.
      const order = await orderRow(orderId)
      expect(refundsSent(stripe)).toEqual([expect.objectContaining({ payment_intent: order?.intent, amount: 4000 })])
      const sent = stripe.calls.map((call) => call.method)
      expect(sent.lastIndexOf('subscriptions.cancel')).toBeGreaterThan(sent.lastIndexOf('refunds.create'))
      expect(cancelsSent(stripe)).toEqual([subscription])
      expect(await subscriptionStatus(stripe, subscription)).toBe('canceled')
      // The membership as the old function left it, and Q41's flag made here, not by a webhook.
      expect(await membership()).toMatchObject({ id: membershipId, status: 'cancelled', addons: 0, ends: null })
      const bookings = await creditBookings(membershipId)
      expect(bookings.find((booking) => booking.id === future)).toMatchObject({ status: 'payment_needed', due: true })
      expect(bookings.find((booking) => booking.id === taken)).toMatchObject({ status: 'completed', due: false })
      // The figure the dialog showed is what R1 flagged, and what the claim keeps for the undo.
      const claim = (await auditRows('order.refund_claimed'))[0]?.details as { lines: Array<{ membership?: { id: string; subscriptionId: string; flaggedBookingIds: string[]; status: string } }> }
      expect(claim.lines[0]?.membership).toMatchObject({ id: membershipId, subscriptionId: subscription, status: 'active', flaggedBookingIds: [future] })
      // Recorded as left with the money, then closed by the cancel: nothing on the stuck list.
      // (The test clock doesn't move during a Stripe call, so the two rows can carry the same time: compared as a set.)
      expect((await auditRows('order.subscription_left')).map((row) => [row.details['state'], row.details['found'], row.details['subscriptionId'], row.details['claimId']]).sort()).toEqual([
        ['cancelled', 'refund', subscription, (await auditRows('order.refund_claimed'))[0]?.id],
        ['left', 'refund', subscription, (await auditRows('order.refund_claimed'))[0]?.id],
      ])
      expect(await leftWarnings()).toEqual([])
      expect((await lineRows(orderId))[0]).toMatchObject({ refunded: true, refund_method: 'card', card: '40.00' })
    })
  })

  it('Q41, my call on "future": a credit session later today is flagged too (a refund in full covers nothing from now on), and what the figures counted is exactly what was flagged', async () => {
    await onASeed(async () => {
      const { orderId, line, membershipId, taken, future } = await usedMembership()
      const counts = async () => (await figures(orderId)).lines.find((one) => one.lineItemId === line)?.membership
      // The two counts are told apart: with the session already taken cancelled instead, only the one to come counts.
      await db.query("UPDATE bookings SET status = 'cancelled' WHERE id = $1", [taken])
      expect(await counts()).toEqual({ creditSessionsTaken: 0, futureCreditBookings: 1 })
      await db.query("UPDATE bookings SET status = 'completed' WHERE id = $1", [taken])
      expect(await counts()).toEqual({ creditSessionsTaken: 1, futureCreditBookings: 1 })
      // The booking still to come is moved to this evening (the test's clock is 10 Nov 2026, 09:00).
      await db.query("UPDATE sessions SET start_time = '2026-11-10 18:00:00+00', end_time = '2026-11-10 19:00:00+00' WHERE id = $1", [ID.laterPublicSession])
      await db.query("UPDATE bookings SET start_time = '2026-11-10 18:00:00+00' WHERE id = $1", [future])
      const counted = await counts()
      expect(counted).toEqual({ creditSessionsTaken: 1, futureCreditBookings: 1 })
      const answer = await refund(orderId, [line], 'credit')
      expect(answer.body.data).toMatchObject({ bookingsFlagged: counted?.futureCreditBookings })
      expect((await creditBookings(membershipId)).find((booking) => booking.id === future)).toMatchObject({ status: 'payment_needed', due: true })
    })
  })

  /** A reader order with a £10 gift card part, tapped and finalised: recorded as `split`, with the reader's record. */
  async function splitReaderOrder(stripe: FakeStripe, basket: Record<string, unknown>): Promise<{ orderId: string; tap: string; bookingId: string | undefined }> {
    const answer = await place({ customerId: ID.customer, ...monthly, ...basket, payment: { method: 'reader', readerSaveCard: true, giftCard: { giftCardId: ID.giftCard, amount: 10 } } })
    if (!answer.body.ok) throw new Error(JSON.stringify(answer.body.error))
    const orderId = answer.body.data.orderId
    const tap = answer.body.data.pendingReaderPayment?.paymentIntentId as string
    stripe.completeReaderPayment(tap, { generatedCard: 'pm_reader_saved' })
    expect((await postReaderStep('finalise', orderId)).status).toBe(200)
    expect((await db.query<{ payment_method: string }>('SELECT payment_method FROM orders WHERE id = $1', [orderId]))[0]?.payment_method).toBe('split')
    const bookingId = (await db.query<{ booking_id: string | null }>("SELECT booking_id FROM order_line_items WHERE order_id = $1 AND item_type = 'booking'", [orderId]))[0]?.booking_id ?? undefined
    return { orderId, tap, bookingId }
  }

  it("a reader membership order part-paid by gift card (recorded as `split`) is still one card payment, and the whole tap is its card money (W29 review S1): £54 left, the membership's £40 all back to the tap, then the soap's £14 and the rest store credit", async () => {
    await onASeed(async (stripe) => {
      // £40 Core monthly + £24 of soap, £10 on a gift card, £54 tapped.
      const { orderId, tap } = await splitReaderOrder(stripe, { products: [soap] })
      expect(stripe.calls.filter((call) => call.method === 'paymentIntents.create').map((call) => (call.params as { amount: number }).amount)).toContain(5400)
      const [membershipLine] = await linesOf(orderId, 'membership')
      const [soapLine] = await linesOf(orderId, 'product')
      const creditBefore = await storeCredit()
      // Not a membership "paid by its own card payment": no figure for one, and Card isn't refused as unrecorded.
      const shown = await figures(orderId)
      expect(shown.lines.find((one) => one.lineItemId === membershipLine)?.ownCardLeft).toBeUndefined()
      // The tap took £54, and all of it can go back to the card (it read £14: the tap less the membership).
      expect(shown.cardLeft).toBe(54)

      const first = await refund(orderId, [membershipLine as string], 'card')
      expect(first.body.data).toMatchObject({ refundedAmount: 40, refundMethod: 'card', cardRefundedAmount: 40, orderPaymentStatus: 'partially_refunded' })
      expect(first.body.data?.['storeCreditRefundedAmount'] ?? 0).toBe(0)
      expect(refundsSent(stripe)).toEqual([expect.objectContaining({ payment_intent: tap, amount: 4000 })])
      expect(await storeCredit()).toBe(creditBefore)
      expect((await figures(orderId)).cardLeft).toBe(14)

      // The soap: the £14 of card money left, and the gift card's £10 as store credit.
      const second = await refund(orderId, [soapLine as string], 'card')
      expect(second.body.data).toMatchObject({ refundedAmount: 24, refundMethod: 'card', cardRefundedAmount: 14, storeCreditRefundedAmount: 10, orderPaymentStatus: 'refunded' })
      expect(refundsSent(stripe).map((sent) => [sent.payment_intent, sent.amount])).toEqual([
        [tap, 4000],
        [tap, 1400],
      ])
      expect(stripe.refundedByIntent.get(tap)).toBe(5400)
      expect(await storeCredit()).toBe(creditBefore + 10)
      expect((await lineRows(orderId)).map((line) => [line.item_type, line.card]).sort()).toEqual([
        ['membership', '40.00'],
        ['product', '14.00'],
      ])
      expect((await figures(orderId)).cardLeft).toBe(0)
    })
  })

  it("a booking bought on such an order gets the same figure (step D's refund figures read the same card money): its whole £20 seat can go back to the tap, not the £10 the tap took over the membership", async () => {
    await onASeed(async (stripe) => {
      // £40 Core monthly + a £20 seat, £10 on a gift card, £50 tapped.
      const { orderId, bookingId } = await splitReaderOrder(stripe, { booking: paidSeat() })
      expect(bookingId).toBeTruthy()
      expect((await figures(orderId)).cardLeft).toBe(50)
      const response = await (bookingFiguresRoute as Handler)(
        new Request(`https://worker.test/api/v1/staff/bookings/${bookingId}/refund-figures`, { headers: { authorization: `Bearer ${KEY}`, 'x-staff-email': REPLAY_USER.email } }),
        { params: Promise.resolve({ bookingId: bookingId as string }) }
      )
      const booking = ((await response.json()) as { data: { left: number; cardLeft: number; parts: { card: number } } }).data
      expect(booking).toMatchObject({ left: 20, cardLeft: 20, parts: expect.objectContaining({ card: 20 }) })
    })
  })

  it('a membership with no subscription: refunded to store credit with no Stripe call, and its future credit booking is still flagged (the old code never flagged it)', async () => {
    await onASeed(async (stripe) => {
      const { orderId, line, membershipId, future } = await usedMembership()
      await db.query('UPDATE customer_memberships SET stripe_subscription_id = NULL WHERE id = $1', [membershipId])
      const callsBefore = stripe.calls.length
      const creditBefore = await storeCredit()
      const answer = await refund(orderId, [line], 'credit')
      expect(answer.body.data).toMatchObject({ refundedAmount: 40, refundMethod: 'credit', storeCreditRefundedAmount: 40, orderPaymentStatus: 'refunded', bookingsFlagged: 1 })
      expect(stripe.calls.length).toBe(callsBefore)
      expect(await storeCredit()).toBe(creditBefore + 40)
      expect(await membership()).toMatchObject({ status: 'cancelled', addons: 0 })
      expect((await creditBookings(membershipId)).find((booking) => booking.id === future)?.status).toBe('payment_needed')
      // No subscription, so nothing to cancel and nothing recorded as left.
      expect(await auditRows('order.subscription_left')).toEqual([])
    })
  })

  it('a reader membership order: one tap took it, so the card refund goes back to the tap and the subscription is cancelled', async () => {
    await onASeed(async (stripe) => {
      const answer = await place({ customerId: ID.customer, ...monthly, payment: { method: 'reader', readerSaveCard: true } })
      if (!answer.body.ok) throw new Error(JSON.stringify(answer.body.error))
      const orderId = answer.body.data.orderId
      const tap = answer.body.data.pendingReaderPayment?.paymentIntentId as string
      stripe.completeReaderPayment(tap, { generatedCard: 'pm_reader_saved' })
      expect((await postReaderStep('finalise', orderId)).status).toBe(200)
      const [line] = await linesOf(orderId, 'membership')
      const made = await membership()
      const shown = await figures(orderId)
      expect(shown.cardLeft).toBe(40)
      expect(shown.lines[0]?.ownCardLeft).toBeUndefined()
      const refunded = await refund(orderId, [line as string], 'card')
      expect(refunded.body.data).toMatchObject({ refundedAmount: 40, cardRefundedAmount: 40, orderPaymentStatus: 'refunded' })
      expect(refundsSent(stripe)).toEqual([expect.objectContaining({ payment_intent: tap, amount: 4000 })])
      expect(cancelsSent(stripe)).toEqual([made.subscription])
      expect(await membership()).toMatchObject({ status: 'cancelled' })
    })
  })

  it('Q40: a £40 membership and £24 of soap on one saved card are two card payments, and each line goes back to the one that took it: £40 and £24 both on the card, nothing to store credit', async () => {
    await onASeed(async (stripe) => {
      const orderId = await placed({ ...monthly, products: [soap], payment: card })
      const [membershipLine] = await linesOf(orderId, 'membership')
      const [soapLine] = await linesOf(orderId, 'product')
      const order = await orderRow(orderId)
      // Two payments: the order names the remainder charge; the record names the membership's first invoice.
      expect(order?.own).toBeTruthy()
      expect(order?.own).not.toBe(order?.intent)
      const made = await membership()
      const creditBefore = await storeCredit()

      const shown = await figures(orderId)
      expect(shown.cardLeft).toBe(24)
      expect(shown.lines.find((line) => line.lineItemId === membershipLine)).toMatchObject({ refundable: 40, ownCardLeft: 40 })
      expect(shown.lines.find((line) => line.lineItemId === soapLine)?.ownCardLeft).toBeUndefined()

      // Both lines to the card at once: two payments, one card part. Refused, nothing moved.
      const together = await refund(orderId, [membershipLine as string, soapLine as string], 'card')
      expect(together.status).toBe(409)
      expect(together.body.error?.details).toMatchObject({ reason: 'membership_refund_alone', message: MEMBERSHIP_REFUND_WORDS.refundAlone })
      expect(await auditRows('order.refund_claimed')).toEqual([])
      expect(refundsSent(stripe)).toEqual([])
      expect(cancelsSent(stripe)).toEqual([])
      expect(await membership()).toMatchObject({ status: 'active' })

      // The membership on its own: £40 from its own payment (the old code took £24 from the soap's and gave £16 as store credit).
      const first = await refund(orderId, [membershipLine as string], 'card')
      expect(first.body.data).toEqual({ refundedAmount: 40, refundMethod: 'card', cardRefundedAmount: 40, orderPaymentStatus: 'partially_refunded' })
      expect(refundsSent(stripe)).toEqual([expect.objectContaining({ payment_intent: order?.own, amount: 4000 })])
      expect(cancelsSent(stripe)).toEqual([made.subscription])
      // The soap's payment is untouched, and still has all £24 to give back.
      expect((await figures(orderId)).cardLeft).toBe(24)

      const second = await refund(orderId, [soapLine as string], 'card')
      expect(second.body.data).toEqual({ refundedAmount: 24, refundMethod: 'card', cardRefundedAmount: 24, orderPaymentStatus: 'refunded' })
      expect(refundsSent(stripe)).toEqual([expect.objectContaining({ payment_intent: order?.own, amount: 4000 }), expect.objectContaining({ payment_intent: order?.intent, amount: 2400 })])
      expect(stripe.refundedByIntent.get(order?.own as string)).toBe(4000)
      expect(stripe.refundedByIntent.get(order?.intent as string)).toBe(2400)
      expect(await storeCredit()).toBe(creditBefore)
      expect(await lineRows(orderId)).toEqual([
        expect.objectContaining({ refunded: true, refund_method: 'card' }),
        expect.objectContaining({ refunded: true, refund_method: 'card' }),
      ])
      expect((await lineRows(orderId)).map((line) => [line.item_type, line.card]).sort()).toEqual([
        ['membership', '40.00'],
        ['product', '24.00'],
      ])
      expect(cancelsSent(stripe)).toEqual([made.subscription])
    })
  })

  it('Q40 the other way round, and to store credit: the soap first still leaves the membership its own £40; both lines to store credit go together', async () => {
    await onASeed(async (stripe) => {
      const orderId = await placed({ ...monthly, products: [soap], payment: card })
      const [membershipLine] = await linesOf(orderId, 'membership')
      const [soapLine] = await linesOf(orderId, 'product')
      const order = await orderRow(orderId)
      expect((await refund(orderId, [soapLine as string], 'card')).body.data).toMatchObject({ cardRefundedAmount: 24 })
      expect((await figures(orderId)).lines.find((line) => line.lineItemId === membershipLine)?.ownCardLeft).toBe(40)
      expect((await refund(orderId, [membershipLine as string], 'card')).body.data).toMatchObject({ cardRefundedAmount: 40, orderPaymentStatus: 'refunded' })
      expect(refundsSent(stripe).map((sent) => [sent.payment_intent, sent.amount])).toEqual([
        [order?.intent, 2400],
        [order?.own, 4000],
      ])
    })
    await onASeed(async (stripe) => {
      const orderId = await placed({ ...monthly, products: [soap], payment: card })
      const creditBefore = await storeCredit()
      const answer = await refund(orderId, await linesOf(orderId), 'credit')
      expect(answer.body.data).toMatchObject({ refundedAmount: 64, storeCreditRefundedAmount: 64, orderPaymentStatus: 'refunded' })
      expect(await storeCredit()).toBe(creditBefore + 64)
      expect(refundsSent(stripe)).toEqual([])
      expect(cancelsSent(stripe)).toHaveLength(1)
    })
  })

  it("Q40, an order from before the membership's own payment was recorded (placed by the old createOrder): Card is refused with clear words, never taken from the other payment; store credit goes", async () => {
    await replay(
      environment,
      {
        name: 'w29 old-shape order',
        seed,
        async run({ call, stripe }) {
          replayStripe.current = stripe
          try {
            const made = (await call('createOrder', { customerId: ID.customer, ...monthly, membershipIdempotencyKey: 'w29-old-shape', products: [soap], payment: card })) as { success: boolean; orderId: string }
            expect(made.success).toBe(true)
            // W64: placed through the Worker, which names the membership's own payment; the order as the old createOrder recorded it.
            await asTheOldCreateOrderRecordedIt(db, made.orderId)
            const [membershipLine] = await linesOf(made.orderId, 'membership')
            expect((await orderRow(made.orderId))?.own).toBeNull()
            const shown = await figures(made.orderId)
            expect(shown.cardLeft).toBe(24)
            expect(shown.lines.find((line) => line.lineItemId === membershipLine)).toMatchObject({ refundable: 40, ownCardLeft: 0 })
            const refused = await refund(made.orderId, [membershipLine as string], 'card')
            expect(refused.status).toBe(409)
            expect(refused.body.error?.details).toMatchObject({ reason: 'membership_payment_not_recorded', message: MEMBERSHIP_REFUND_WORDS.paymentNotRecorded })
            expect(refundsSent(stripe)).toEqual([])
            expect(cancelsSent(stripe)).toEqual([])
            expect(await membership()).toMatchObject({ status: 'active' })
            const credit = await refund(made.orderId, [membershipLine as string], 'credit')
            expect(credit.body.data).toMatchObject({ refundedAmount: 40, storeCreditRefundedAmount: 40 })
            expect(refundsSent(stripe)).toEqual([])
            // The soap's payment was never touched by the membership's refund.
            expect((await figures(made.orderId)).cardLeft).toBe(24)
          } finally {
            replayStripe.current = null
          }
        },
      },
      workerSide()
    )
  })

  it('a membership line whose membership row is gone keeps the old refusal, on the figures and on the press', async () => {
    await onASeed(async (stripe) => {
      const orderId = await placed({ ...monthly, payment: card })
      const [line] = await linesOf(orderId, 'membership')
      await db.query('UPDATE customer_memberships SET order_line_item_id = NULL WHERE order_line_item_id = $1', [line as string])
      const blocked = { reason: 'membership_instance_not_found', message: WORDS.membershipNotFound(line as string) }
      expect((await figures(orderId)).lines[0]?.blocked).toEqual(blocked)
      const answer = await post('refunds', orderId, { lineItemIds: [line], refundMethod: 'card', confirmed: { amount: 40 } })
      expect(answer.status).toBe(409)
      expect(answer.body.error?.details).toMatchObject(blocked)
      expect(refundsSent(stripe)).toEqual([])
      expect(cancelsSent(stripe)).toEqual([])
    })
  })
})

describe("W53 (Wayne's Q40; the W28 QA's step G note): card money is recorded on the line its payment took", () => {
  it("store credit covered the soap and the membership's first invoice took the £40: one card payment. A refund of both lines to the card sends £40 and records it on the MEMBERSHIP's line; the soap's £24 goes back as store credit (before W53 the £40 was recorded on the lines in line order, whichever came first)", async () => {
    await onASeed(async (stripe) => {
      await db.query('UPDATE customers SET store_credit_balance = 24 WHERE id = $1', [ID.customer])
      const orderId = await placed({ ...monthly, products: [soap], payment: { ...card, storeCredit: { amount: 24 } } })
      const [membershipLine] = await linesOf(orderId, 'membership')
      const [soapLine] = await linesOf(orderId, 'product')
      // One card payment, and it was the membership's own: no remainder charge beside it.
      expect(await loadOrderCardPortion(db, orderId)).toMatchObject({ cardPortion: 40, membershipPayment: null, cardTookMembership: true })

      // Chosen soap first, as the lines are listed: the card part still goes on the membership's line.
      const answer = await refund(orderId, [soapLine as string, membershipLine as string], 'card')
      expect(answer.body.data).toMatchObject({ refundedAmount: 64, refundMethod: 'card', cardRefundedAmount: 40, storeCreditRefundedAmount: 24, orderPaymentStatus: 'refunded' })
      expect(refundsSent(stripe).map((sent) => sent.amount)).toEqual([4000])
      const claim = (await auditRows('order.refund_claimed'))[0]?.details as { plan: { card: Array<{ amount: number; lines: Array<{ lineId: string; amount: number }> }>; storeCredit: number } }
      expect(claim.plan).toMatchObject({ card: [{ amount: 40, lines: [{ lineId: membershipLine, amount: 40 }] }], storeCredit: 24 })
      const rows = await lineRows(orderId)
      expect(rows.find((row) => row.item_type === 'membership')).toEqual({ item_type: 'membership', refunded: true, refund_method: 'card', card: '40.00' })
      expect(rows.find((row) => row.item_type === 'product')).toEqual({ item_type: 'product', refunded: true, refund_method: 'credit', card: '0.00' })
    })
  })

  it("store credit covered more than the soap, so the invoice took only part of the membership: the card's £30 is on the membership's line with £10 of store credit, and the soap's £24 is all store credit", async () => {
    await onASeed(async (stripe) => {
      await db.query('UPDATE customers SET store_credit_balance = 34 WHERE id = $1', [ID.customer])
      const orderId = await placed({ ...monthly, products: [soap], payment: { ...card, storeCredit: { amount: 34 } } })
      const [membershipLine] = await linesOf(orderId, 'membership')
      const [soapLine] = await linesOf(orderId, 'product')
      expect(await loadOrderCardPortion(db, orderId)).toMatchObject({ cardPortion: 30, membershipPayment: null, cardTookMembership: true })
      const answer = await refund(orderId, [soapLine as string, membershipLine as string], 'card')
      expect(answer.body.data).toMatchObject({ refundedAmount: 64, cardRefundedAmount: 30, storeCreditRefundedAmount: 34 })
      expect(refundsSent(stripe).map((sent) => sent.amount)).toEqual([3000])
      const rows = await lineRows(orderId)
      expect(rows.find((row) => row.item_type === 'membership')).toMatchObject({ refund_method: 'card', card: '30.00' })
      expect(rows.find((row) => row.item_type === 'product')).toMatchObject({ refund_method: 'credit', card: '0.00' })
    })
  })

  it("every other order keeps line order: two card payments (a remainder charge) and a reader order's one tap are not the membership's own payment", async () => {
    await onASeed(async () => {
      const twoPayments = await placed({ ...monthly, products: [soap], payment: card })
      expect(await loadOrderCardPortion(db, twoPayments)).toMatchObject({ cardPortion: 24, cardTookMembership: false })
      expect((await loadOrderCardPortion(db, twoPayments))?.membershipPayment).not.toBeNull()
      const soapOnly = await placed({ products: [soap], payment: card })
      expect(await loadOrderCardPortion(db, soapOnly)).toMatchObject({ cardPortion: 24, membershipPayment: null, cardTookMembership: false })
    })
  })
})

describe('the payment date change charge (brief W29 item 3)', () => {
  it('refunds as a plain line: £6.50 back to its own charge, no cancel, the membership and its new date untouched', async () => {
    await onASeed(async (stripe) => {
      const charge = await stripe.paymentIntents.create({ amount: 650, currency: 'gbp', customer: 'cus_member', payment_method: 'pm_member', off_session: true, confirm: true })
      const orderId = (
        await db.query<{ id: string }>(
          "INSERT INTO orders (customer_id, order_total, payment_status, payment_method, order_source, stripe_payment_intent_id) VALUES ($1, 6.50, 'paid', 'card', 'staff_created', $2) RETURNING id",
          [ID.member, charge.id]
        )
      )[0]?.id as string
      const line = (
        await db.query<{ id: string }>("INSERT INTO order_line_items (order_id, item_type, membership_plan_id, quantity, unit_price, line_total) VALUES ($1, 'membership', $2, 1, 6.50, 6.50) RETURNING id", [orderId, ID.plan])
      )[0]?.id as string
      await db.query(
        "INSERT INTO membership_payment_date_changes (membership_id, old_renewal_date, new_renewal_date, extra_days, amount_charged, stripe_payment_intent_id, order_id, staff_id, status) VALUES ($1, '2026-12-10', '2026-12-15', 5, 6.50, $2, $3, $4, 'done')",
        [ID.membership, charge.id, orderId, ID.staff]
      )
      const memberBefore = (await db.query('SELECT subscription_status, addon_credits_remaining, next_renewal_date::text FROM customer_memberships WHERE id = $1', [ID.membership]))[0]

      const shown = await figures(orderId)
      // A plain line: no membership counts (it sold no membership), not blocked, the charge's own card money.
      expect(shown.lines[0]).toMatchObject({ itemType: 'membership', refundable: 6.5, blocked: null })
      expect(shown.lines[0]?.membership).toBeUndefined()
      expect(shown.cardLeft).toBe(6.5)
      const answer = await refund(orderId, [line], 'card')
      expect(answer.body.data).toEqual({ refundedAmount: 6.5, refundMethod: 'card', cardRefundedAmount: 6.5, orderPaymentStatus: 'refunded' })
      expect(refundsSent(stripe)).toEqual([expect.objectContaining({ payment_intent: charge.id, amount: 650 })])
      expect(cancelsSent(stripe)).toEqual([])
      expect(stripe.calls.filter((call) => call.method.startsWith('subscriptions.'))).toEqual([])
      expect((await db.query('SELECT subscription_status, addon_credits_remaining, next_renewal_date::text FROM customer_memberships WHERE id = $1', [ID.membership]))[0]).toEqual(memberBefore)
      expect((await db.query<{ status: string; new_renewal_date: string }>('SELECT status, new_renewal_date::text FROM membership_payment_date_changes WHERE order_id = $1', [orderId]))[0]).toEqual({ status: 'done', new_renewal_date: '2026-12-15' })
      expect(await auditRows('order.subscription_left')).toEqual([])
      const claim = (await auditRows('order.refund_claimed'))[0]?.details as { lines: Array<Record<string, unknown>> }
      expect(claim.lines[0]?.['membership']).toBeUndefined()
    })
  })
})

describe('the subscription is cancelled last, and a cancel that fails is left, listed and retried (brief W29 item 6; E10)', () => {
  it('cancel refused: the refund stands with a warning, the cancel is on the stuck list, and reconcile cancels it without sending the refund again', async () => {
    await onASeed(async (stripe) => {
      const { orderId, line, subscription } = await usedMembership()
      stripe.failNext('subscriptions.cancel', { kind: 'error', error: fakeStripeErrors.invalid('subscription_locked', 'This subscription cannot be cancelled right now.') })
      const answer = await refund(orderId, [line], 'card')
      expect(answer.status).toBe(200)
      expect(answer.body.data).toEqual({
        refundedAmount: 40,
        refundMethod: 'card',
        cardRefundedAmount: 40,
        orderPaymentStatus: 'refunded',
        bookingsFlagged: 1,
        warning: MEMBERSHIP_REFUND_WORDS.cancelLeft(subscription),
        subscriptionCancelLeft: [subscription],
      })
      expect(await subscriptionStatus(stripe, subscription)).toBe('active')
      expect(refundsSent(stripe)).toHaveLength(1)
      // Listed, with its own words and a way to mark it sorted.
      const listed = await leftWarnings()
      expect(listed).toEqual([expect.objectContaining({ kind: 'order', id: orderId, warning: MEMBERSHIP_REFUND_WORDS.cancelLeftListed(subscription), close: { kind: 'subscription_left', orderId, subscriptionId: subscription } })])
      // The refund is finished: the order isn't held, and nothing is owed.
      expect((await stuckList(db, { olderThanMinutes: 0 })).claims).toEqual([])
      expect(await orderRow(orderId)).toMatchObject({ payment_status: 'refunded', owed: '0.00' })

      const run = await runReconcile(stripe)
      expect(run.items).toEqual([expect.objectContaining({ kind: 'order', id: orderId, outcome: 'undone', detail: `subscription ${subscription} cancelled: its membership was refunded` })])
      expect(await subscriptionStatus(stripe, subscription)).toBe('canceled')
      expect(await leftWarnings()).toEqual([])
      // Never the refund again, and never W13's put-back (which refunds the first invoice).
      expect(refundsSent(stripe)).toHaveLength(1)
      expect(stripe.refundedByIntent.get((await orderRow(orderId))?.intent as string)).toBe(4000)
      // A second run finds nothing to do.
      expect((await runReconcile(stripe)).items).toEqual([])
    })
  })

  it('cancel unclear (Stripe answers neither the cancel nor the read): left, then every run tries again until it goes; a store credit refund is not taken back', async () => {
    await onASeed(async (stripe) => {
      const { orderId, line, subscription } = await usedMembership()
      const creditBefore = await storeCredit()
      stripe.failNext('subscriptions.cancel', { kind: 'error', error: fakeStripeErrors.server() })
      stripe.failNext('subscriptions.retrieve', { kind: 'error', error: fakeStripeErrors.connection() })
      const answer = await refund(orderId, [line], 'credit')
      expect(answer.body.data).toMatchObject({ refundedAmount: 40, storeCreditRefundedAmount: 40, warning: MEMBERSHIP_REFUND_WORDS.cancelLeft(subscription), subscriptionCancelLeft: [subscription] })
      // The old code took the store credit back here and refunded nothing.
      expect(await storeCredit()).toBe(creditBefore + 40)
      expect(await leftWarnings()).toHaveLength(1)

      // Still no answer on the next run: left again, one reconcile row, still listed.
      stripe.failNext('subscriptions.cancel', { kind: 'error', error: fakeStripeErrors.server() })
      stripe.failNext('subscriptions.retrieve', { kind: 'error', error: fakeStripeErrors.connection() })
      const stillLeft = await runReconcile(stripe)
      expect(stillLeft.items).toEqual([expect.objectContaining({ kind: 'order', id: orderId, outcome: 'left', reason: 'subscription_cancel_left' })])
      expect(await leftWarnings()).toHaveLength(1)
      expect(await subscriptionStatus(stripe, subscription)).toBe('active')

      expect((await runReconcile(stripe)).items).toEqual([expect.objectContaining({ outcome: 'undone' })])
      expect(await subscriptionStatus(stripe, subscription)).toBe('canceled')
      expect(await leftWarnings()).toEqual([])
      expect(refundsSent(stripe)).toEqual([])
      expect(await storeCredit()).toBe(creditBefore + 40)
    })
  })

  it('a card refund Stripe refuses leaves the subscription untouched: the membership, its add-on credits and its bookings are put back, and no cancel is ever sent', async () => {
    await onASeed(async (stripe) => {
      const { orderId, line, membershipId, subscription, future } = await usedMembership()
      await db.query('UPDATE customer_memberships SET addon_credits_remaining = 3 WHERE id = $1', [membershipId])
      stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
      const answer = await refund(orderId, [line], 'card')
      expect(answer.status).toBe(402)
      expect(answer.body.error?.details).toMatchObject({ reason: 'refund_failed', message: 'Failed to refund payment: Your card was declined.' })
      expect(cancelsSent(stripe)).toEqual([])
      expect(await subscriptionStatus(stripe, subscription)).toBe('active')
      expect(await membership()).toMatchObject({ status: 'active', addons: 3, ends: null })
      expect((await creditBookings(membershipId)).find((booking) => booking.id === future)).toMatchObject({ status: 'confirmed', due: false })
      expect((await lineRows(orderId))[0]).toMatchObject({ refunded: false, refund_method: null, card: '0.00' })
      expect((await auditRows('order.refund_finished'))[0]?.details).toMatchObject({ outcome: 'put_back' })
      expect(await auditRows('order.subscription_left')).toEqual([])
      expect(await orderRow(orderId)).toMatchObject({ payment_status: 'paid', owed: '0.00' })
      // Nothing for reconcile to cancel either.
      pastTheWindow()
      expect((await runReconcile(stripe)).items).toEqual([])
      expect(cancelsSent(stripe)).toEqual([])
      // The same refund then goes through, and only then is the subscription cancelled.
      expect((await refund(orderId, [line], 'card')).body.data).toMatchObject({ cardRefundedAmount: 40 })
      expect(cancelsSent(stripe)).toEqual([subscription])
      // And the add-on credits it had been given back go with it.
      expect(await membership()).toMatchObject({ status: 'cancelled', addons: 0 })
    })
  })

  const options = (stripe: FakeStripe): OrderRefundOptions => ({ actor: { type: 'staff', id: ID.staff }, requestId: crypto.randomUUID(), stripe: () => stripe })

  it("W29 review L1: the undo after a refusal, ended by Postgres in a deadlock, is run once more and puts the order back: the membership active again, its bookings confirmed, nothing owed, no cancel", async () => {
    await onASeed(async (stripe) => {
      const { orderId, line, membershipId, subscription, future } = await usedMembership()
      await db.query('UPDATE customer_memberships SET addon_credits_remaining = 3 WHERE id = $1', [membershipId])
      stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
      // The first transaction opened once Stripe's refusal is on the claim is the undo. It runs in full, and then
      // Postgres ends it as the loser of a deadlock: nothing of it is kept. Every other transaction is untouched.
      let deadlocks = 0
      let undoTries = 0
      const flaky = Object.create(db) as Db
      flaky.transaction = (async (work: (tx: Tx) => Promise<unknown>) => {
        if ((await auditRows('order.refund_refused')).length === 0) return db.transaction(work as Parameters<Db['transaction']>[0])
        undoTries += 1
        if (deadlocks > 0) return db.transaction(work as Parameters<Db['transaction']>[0])
        deadlocks += 1
        return db.transaction(async (tx) => {
          await work(tx)
          throw new DbTimeoutError('The database took too long to respond.', '40P01: deadlock detected')
        })
      }) as Db['transaction']

      const pressed = refundOrderLines(flaky, orderId, { lineItemIds: [line], refundMethod: 'card', restock: {}, confirmed: { amount: 40 } }, options(stripe))
      // The refusal's own words, as when the undo goes through first time: not "refused, not put back".
      await expect(pressed).rejects.toMatchObject({ details: { reason: 'refund_failed', message: 'Failed to refund payment: Your card was declined.' } })
      expect(deadlocks).toBe(1)
      expect(undoTries).toBe(2)
      expect(await membership()).toMatchObject({ status: 'active', addons: 3, ends: null })
      expect((await creditBookings(membershipId)).find((booking) => booking.id === future)).toMatchObject({ status: 'confirmed', due: false })
      expect((await lineRows(orderId))[0]).toMatchObject({ refunded: false, refund_method: null, card: '0.00' })
      expect((await auditRows('order.refund_finished')).map((row) => row.details['outcome'])).toEqual(['put_back'])
      expect(await orderRow(orderId)).toMatchObject({ payment_status: 'paid', owed: '0.00' })
      expect(cancelsSent(stripe)).toEqual([])
      expect(await subscriptionStatus(stripe, subscription)).toBe('active')
      expect(await auditRows('order.subscription_left')).toEqual([])
    })
  })

  /** A Stripe whose subscription cancel never answers: the Worker died between the refund and the cancel. */
  function dyingAtTheCancel(stripe: FakeStripe): { client: FakeStripe; died: Promise<void> } {
    let dead: () => void = () => undefined
    const died = new Promise<void>((resolve) => {
      dead = resolve
    })
    const client = Object.create(stripe) as FakeStripe
    Object.defineProperty(client, 'subscriptions', {
      value: {
        ...stripe.subscriptions,
        cancel: () => {
          dead()
          return new Promise<never>(() => undefined)
        },
      },
    })
    return { client, died }
  }

  it('a crash between the refund and the cancel: the refund is recorded, the subscription is listed as still to cancel, and reconcile cancels it and never sends the refund again', async () => {
    await onASeed(async (stripe) => {
      const { orderId, line, subscription } = await usedMembership()
      const dying = dyingAtTheCancel(stripe)
      void refundOrderLines(db, orderId, { lineItemIds: [line], refundMethod: 'card', restock: {}, confirmed: { amount: 40 } }, options(dying.client))
      await dying.died
      // R2 committed with the money: the line refunded, £40 back once, and the subscription recorded as left.
      expect((await lineRows(orderId))[0]).toMatchObject({ refunded: true, card: '40.00' })
      expect(refundsSent(stripe)).toHaveLength(1)
      expect((await auditRows('order.subscription_left')).map((row) => row.details['state'])).toEqual(['left'])
      expect((await auditRows('order.subscription_left'))[0]?.details).toMatchObject({ found: 'refund', subscriptionId: subscription, left: [MEMBERSHIP_REFUND_WORDS.notCancelledYet] })
      expect(await subscriptionStatus(stripe, subscription)).toBe('active')
      expect(await leftWarnings()).toHaveLength(1)

      const run = await runReconcile(stripe)
      expect(run.items).toEqual([expect.objectContaining({ kind: 'order', id: orderId, outcome: 'undone' })])
      expect(await subscriptionStatus(stripe, subscription)).toBe('canceled')
      expect(await leftWarnings()).toEqual([])
      expect(refundsSent(stripe)).toHaveLength(1)
      expect(stripe.refundedByIntent.get((await orderRow(orderId))?.intent as string)).toBe(4000)
    })
  })

  it('a refund held with no clear answer cancels nothing; reconcile finds the refund, records it, and only then cancels the subscription', async () => {
    await onASeed(async (stripe) => {
      const { orderId, line, subscription } = await usedMembership()
      // The refund reaches Stripe but its answer is lost, twice (the press sends it once more under the same key).
      stripe.failNext('refunds.create', { kind: 'lost_response' })
      stripe.failNext('refunds.create', { kind: 'lost_response' })
      const answer = await refund(orderId, [line], 'card')
      expect(answer.body.data?.held).toMatchObject({ reason: 'refund_unconfirmed', message: NEW_WORDS.unconfirmed })
      expect(cancelsSent(stripe)).toEqual([])
      expect(await auditRows('order.subscription_left')).toEqual([])
      expect(await subscriptionStatus(stripe, subscription)).toBe('active')

      pastTheWindow()
      const run = await runReconcile(stripe)
      expect(run.items).toEqual([expect.objectContaining({ kind: 'claim', outcome: 'finalised', detail: expect.stringContaining(`subscription ${subscription} cancelled`) })])
      expect(cancelsSent(stripe)).toEqual([subscription])
      expect(await subscriptionStatus(stripe, subscription)).toBe('canceled')
      expect((await lineRows(orderId))[0]).toMatchObject({ refunded: true, card: '40.00' })
      expect(await leftWarnings()).toEqual([])
      // One refund in all: reconcile never sent one.
      expect(stripe.refundedByIntent.get((await orderRow(orderId))?.intent as string)).toBe(4000)
    })
  })

  it('a refund Stripe never received ends as money owed with the refund standing, so the subscription is cancelled; Refund the rest then sends it to the membership\'s own payment (Q40)', async () => {
    await onASeed(async (stripe) => {
      const orderId = await placed({ ...monthly, products: [soap], payment: card })
      const [membershipLine] = await linesOf(orderId, 'membership')
      const made = await membership()
      const order = await orderRow(orderId)
      // Neither send reaches Stripe.
      stripe.failNext('refunds.create', { kind: 'unreachable' })
      stripe.failNext('refunds.create', { kind: 'unreachable' })
      const held = await refund(orderId, [membershipLine as string], 'card')
      expect(held.body.data?.held?.reason).toBe('refund_unconfirmed')
      pastTheWindow()
      await runReconcile(stripe)
      expect(await orderRow(orderId)).toMatchObject({ owed: '40.00' })
      expect(cancelsSent(stripe)).toEqual([made.subscription])
      expect(await membership()).toMatchObject({ status: 'cancelled' })

      const rest = await post('refunds/owed', orderId, { amount: 40, refundMethod: 'card' })
      expect(rest.body.data).toMatchObject({ cardRefundedAmount: 40, storeCreditRefundedAmount: 0, refundOwed: 0 })
      // To the membership's own payment, not the soap's: the soap's £24 is still all there.
      expect(stripe.refundedByIntent.get(order?.own as string)).toBe(4000)
      expect(stripe.refundedByIntent.get(order?.intent as string) ?? 0).toBe(0)
      expect((await figures(orderId)).cardLeft).toBe(24)
      expect((await lineRows(orderId)).find((line) => line.item_type === 'membership')).toMatchObject({ card: '40.00' })
    })
  })

  it('the manual close marks a left cancel as sorted once a person has cancelled it in Stripe: it leaves the list and reconcile stops trying', async () => {
    await onASeed(async (stripe) => {
      const { orderId, line, subscription } = await usedMembership()
      stripe.failNext('subscriptions.cancel', { kind: 'error', error: fakeStripeErrors.invalid('subscription_locked', 'No.') })
      await refund(orderId, [line], 'credit')
      expect(await leftWarnings()).toHaveLength(1)
      const response = await closeRoute(
        new Request('https://worker.test/api/v1/staff/orders/stuck/close', {
          method: 'POST',
          headers: { authorization: `Bearer ${KEY}`, 'x-staff-email': REPLAY_USER.email, 'idempotency-key': crypto.randomUUID(), 'content-type': 'application/json' },
          body: JSON.stringify({ kind: 'subscription_left', orderId, subscriptionId: subscription, reason: 'Cancelled in Stripe by hand' }),
        })
      )
      expect(((await response.json()) as { data: { closed: boolean } }).data.closed).toBe(true)
      expect(await leftWarnings()).toEqual([])
      const cancelsBefore = cancelsSent(stripe).length
      expect((await runReconcile(stripe)).items).toEqual([])
      expect(cancelsSent(stripe)).toHaveLength(cancelsBefore)
    })
  })

  it("W36 (lead call L7; W29 review L2, the W35 audit's row 11): a cancel Stripe refuses again on the automatic check's retry ends as a line for a person: recorded as refused, listed with its own words, never retried, and Mark sorted closes it", async () => {
    await onASeed(async (stripe) => {
      const { orderId, line, subscription } = await usedMembership()
      const no = () => ({ kind: 'error' as const, error: fakeStripeErrors.invalid('subscription_locked', 'This subscription cannot be cancelled right now.') })
      stripe.failNext('subscriptions.cancel', no())
      const answer = await refund(orderId, [line], 'card')
      // The press: left, exactly as before W36, and its words are still true (the automatic check tries once more).
      expect(answer.body.data).toMatchObject({ refundedAmount: 40, warning: MEMBERSHIP_REFUND_WORDS.cancelLeft(subscription), subscriptionCancelLeft: [subscription] })
      expect((await leftWarnings()).map((warning) => warning.warning)).toEqual([MEMBERSHIP_REFUND_WORDS.cancelLeftListed(subscription)])

      // The retry: Stripe says no again, and the subscription still reads as live.
      stripe.failNext('subscriptions.cancel', no())
      const run = await runReconcile(stripe)
      expect(run.items).toEqual([expect.objectContaining({ kind: 'order', id: orderId, outcome: 'left', reason: 'subscription_cancel_refused' })])
      expect(run.left).toBe(1)
      const rows = (await auditRows('order.subscription_left')).map((row) => row.details)
      expect(rows.map((details) => details['state']).sort()).toEqual(['left', 'refused'])
      expect(rows.find((details) => details['state'] === 'refused')).toMatchObject({
        found: 'refund',
        subscriptionId: subscription,
        invoicePaymentIntentId: null,
        amountPaid: 0,
        refunded: [],
        left: ['refused (This subscription cannot be cancelled right now.)'],
      })
      // Listed for a person, in words that no longer promise another try, with the same way to mark it sorted.
      const words = `A membership was refunded, but Stripe refused to cancel its subscription (${subscription}), so the automatic check has stopped trying and it could still take its next payment. Cancel it in Stripe by hand (or tell a manager), then press Mark sorted (needs the Issue refunds permission).`
      expect(MEMBERSHIP_REFUND_WORDS.cancelRefusedListed(subscription)).toBe(words)
      expect(await leftWarnings()).toEqual([expect.objectContaining({ kind: 'order', id: orderId, warning: words, close: { kind: 'subscription_left', orderId, subscriptionId: subscription } })])

      // Not retried: the next two runs send no cancel and find nothing to do. The refund is never sent again.
      const cancelsBefore = cancelsSent(stripe).length
      expect((await runReconcile(stripe)).items).toEqual([])
      expect((await runReconcile(stripe)).items).toEqual([])
      expect(cancelsSent(stripe)).toHaveLength(cancelsBefore)
      expect(await subscriptionStatus(stripe, subscription)).toBe('active')
      expect(refundsSent(stripe)).toHaveLength(1)
      expect(await leftWarnings()).toHaveLength(1)

      // A person cancels it in Stripe and presses Mark sorted: it leaves the list.
      const response = await closeRoute(
        new Request('https://worker.test/api/v1/staff/orders/stuck/close', {
          method: 'POST',
          headers: { authorization: `Bearer ${KEY}`, 'x-staff-email': REPLAY_USER.email, 'idempotency-key': crypto.randomUUID(), 'content-type': 'application/json' },
          body: JSON.stringify({ kind: 'subscription_left', orderId, subscriptionId: subscription, reason: 'Cancelled in Stripe by hand' }),
        })
      )
      expect(((await response.json()) as { data: { closed: boolean } }).data.closed).toBe(true)
      expect(await leftWarnings()).toEqual([])
      expect((await runReconcile(stripe)).items).toEqual([])
    })
  })

  it("W36: a subscription Stripe can't find with the key in use (deleted, or the other mode's) is refused for good on the retry too; no clear answer is not a refusal and is tried again", async () => {
    await onASeed(async (stripe) => {
      const { orderId, line, subscription } = await usedMembership()
      // The press, and then the first retry: no clear answer either time (neither the cancel nor the read answers).
      for (let i = 0; i < 2; i++) {
        stripe.failNext('subscriptions.cancel', { kind: 'error', error: fakeStripeErrors.server() })
        stripe.failNext('subscriptions.retrieve', { kind: 'error', error: fakeStripeErrors.connection() })
        if (i === 0) await refund(orderId, [line], 'credit')
        else expect((await runReconcile(stripe)).items).toEqual([expect.objectContaining({ outcome: 'left', reason: 'subscription_cancel_left' })])
      }
      expect((await auditRows('order.subscription_left')).map((row) => row.details['state'])).toEqual(['left'])
      // The second retry: the cancel fails and the read says there is no such subscription.
      stripe.failNext('subscriptions.cancel', { kind: 'error', error: fakeStripeErrors.server() })
      stripe.failNext('subscriptions.retrieve', { kind: 'error', error: fakeStripeErrors.missing(`subscription: '${subscription}'`) })
      expect((await runReconcile(stripe)).items).toEqual([expect.objectContaining({ kind: 'order', id: orderId, outcome: 'left', reason: 'subscription_cancel_refused' })])
      // W58b (the W45 audit's row 26; W40 call 8): worded as Stripe not finding it, not as a refusal; the row says so.
      expect((await leftWarnings()).map((warning) => warning.warning)).toEqual([MEMBERSHIP_REFUND_WORDS.cancelMissingListed(subscription)])
      expect(MEMBERSHIP_REFUND_WORDS.cancelMissingListed(subscription)).not.toContain('refused')
      expect((await auditRows('order.subscription_left')).find((row) => row.details['state'] === 'refused')?.details['missing']).toBe(true)
      expect((await runReconcile(stripe)).items).toEqual([])
    })
  })

  it("W13's put-back retry never takes a refunded membership's subscription, even with its order gone: the first invoice is never refunded by it", async () => {
    await onASeed(async (stripe) => {
      const { orderId, line, subscription } = await usedMembership()
      stripe.failNext('subscriptions.cancel', { kind: 'error', error: fakeStripeErrors.invalid('subscription_locked', 'No.') })
      await refund(orderId, [line], 'credit')
      // The record alone, as if its order no longer existed (what W13's retry looks for).
      const tx = db as unknown as { transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> }
      await tx.transaction(async (inside) => {
        await inside.query("UPDATE audit_log SET entity_id = '10000000-0000-4000-8000-0000000000e9' WHERE action = 'order.subscription_left'")
      })
      const run = await runReconcile(stripe)
      expect(run.items).toEqual([expect.objectContaining({ outcome: 'undone', detail: `subscription ${subscription} cancelled: its membership was refunded` })])
      expect(refundsSent(stripe)).toEqual([])
    })
  })
})

// Brief W32 item 1: the refund watch on a membership's refund. The part's PaymentIntent is the claim's own: the
// membership's first invoice (W29, Q40), not the order's remainder charge.
describe('W32: the refund watch on a membership refund', () => {
  it("a £40 membership bought with £24 of soap, refunded to the card, pending then failed: watched on the first invoice's payment, £40 owed on the order, the soap's payment untouched; Refund the rest goes back to the first invoice's payment", async () => {
    await onASeed(async (stripe) => {
      const orderId = await placed({ ...monthly, products: [soap], payment: card })
      const [membershipLine] = await linesOf(orderId, 'membership')
      const order = await orderRow(orderId)
      const made = await membership()
      stripe.refundsStayPending = true
      const answer = await refund(orderId, [membershipLine as string], 'card')
      stripe.refundsStayPending = false
      expect(answer.body.data).toMatchObject({ refundedAmount: 40, cardRefundedAmount: 40 })
      const sent = stripe.refundsSent[0]
      expect(sent).toMatchObject({ payment_intent: order?.own, amount: 4000, status: 'pending' })
      expect((await auditRows('refund.watch')).map((row) => row.details)).toMatchObject([
        { state: 'watching', refundId: sent?.id, paymentIntentId: order?.own, amount: 40, on: 'order', subjectId: orderId, orderId, lines: [{ lineId: membershipLine, amount: 40 }] },
      ])
      // The subscription was cancelled last, as before; the watch changes nothing about that.
      expect(cancelsSent(stripe)).toEqual([made.subscription])

      stripe.settleRefund(sent?.id as string, 'failed')
      const items = (await runReconcile(stripe)).items.filter((item) => item.kind === 'refund')
      expect(items).toMatchObject([{ id: sent?.id, outcome: 'refund_failed', reason: 'refund_failed_later' }])
      expect(await orderRow(orderId)).toMatchObject({ owed: '40.00' })
      expect((await lineRows(orderId)).find((line) => line.item_type === 'membership')).toMatchObject({ refunded: true, refund_method: 'card', card: '0.00' })
      // Each payment's card money is right again: the membership's own £40, the soap's £24.
      const shown = await figures(orderId)
      expect(shown).toMatchObject({ cardLeft: 24, refundOwed: 40 })
      // W47 item 6 (the W35 audit's F3, its own example): `cardLeft` is the soap's payment, so the dialog showed "£24
      // to the card, £16 to store credit" while the press sent all £40 to the membership's own payment. The figures
      // now name the payment Refund the rest will use and what it can take: all £40, so nothing goes to store credit.
      expect(shown.owedCard).toEqual({ payment: 'membership', left: 40 })
      expect(await membership()).toMatchObject({ status: 'cancelled' })
      expect(refundsSent(stripe)).toHaveLength(1)
      expect((await runReconcile(stripe)).items.filter((item) => item.kind === 'refund')).toEqual([])
      expect(await orderRow(orderId)).toMatchObject({ owed: '40.00' })

      // Refund the rest to the card: back to the first invoice's payment, never the soap's.
      const rest = await post('refunds/owed', orderId, { amount: 40, refundMethod: 'card' })
      expect(rest.body.data).toMatchObject({ cardRefundedAmount: 40, storeCreditRefundedAmount: 0, refundOwed: 0 })
      expect(stripe.refundedByIntent.get(order?.own as string)).toBe(4000)
      expect(stripe.refundedByIntent.get(order?.intent as string) ?? 0).toBe(0)
      expect(cancelsSent(stripe)).toEqual([made.subscription])
    })
  })
  // Brief W47 items 6 and 8 on an order with two card payments (Q40): the £40 membership's first invoice, and the
  // order's own payment for the £24 of soap.
  const failedLater = async (stripe: FakeStripe, orderId: string): Promise<void> => {
    const [membershipLine] = await linesOf(orderId, 'membership')
    stripe.refundsStayPending = true
    await refund(orderId, [membershipLine as string], 'card')
    stripe.refundsStayPending = false
    const sent = stripe.refundsSent.at(-1)
    stripe.settleRefund(sent?.id as string, 'failed')
    await runReconcile(stripe)
    expect(await orderRow(orderId)).toMatchObject({ owed: '40.00' })
  }
  const by = { actor: { type: 'staff' as const, id: ID.staff }, requestId: 'w47-arrived' }

  it("W47 item 6 (F3, the other half of its example): with the soap already refunded to its own payment, the order's card money left is £0, and Card was greyed out though the membership's payment can take all £40. The figures say so, and Refund the rest sends the £40 there", async () => {
    await onASeed(async (stripe) => {
      const orderId = await placed({ ...monthly, products: [soap], payment: card })
      const order = await orderRow(orderId)
      const [soapLine] = await linesOf(orderId, 'product')
      expect((await refund(orderId, [soapLine as string], 'card')).body.data).toMatchObject({ cardRefundedAmount: 24 })
      await failedLater(stripe, orderId)
      expect(await figures(orderId)).toMatchObject({ cardLeft: 0, refundOwed: 40, owedCard: { payment: 'membership', left: 40 } })
      const rest = await post('refunds/owed', orderId, { amount: 40, refundMethod: 'card' })
      expect(rest.body.data).toMatchObject({ cardRefundedAmount: 40, storeCreditRefundedAmount: 0, refundOwed: 0 })
      expect(stripe.refundedByIntent.get(order?.own as string)).toBe(4000)
      expect(stripe.refundedByIntent.get(order?.intent as string)).toBe(2400)
      // Nothing owed any more: the read carries no `owedCard`.
      expect(await figures(orderId)).not.toHaveProperty('owedCard')
    })
  })

  it("W47 item 6: money owed for lines of both payments is the order's own payment's, as the press has always sent it: the figures name the order's payment and what it can take, and the rest goes to store credit", async () => {
    await onASeed(async (stripe) => {
      const orderId = await placed({ ...monthly, products: [soap], payment: card })
      const order = await orderRow(orderId)
      await failedLater(stripe, orderId)
      // The soap's refund fails later too: £64 owed, for lines of both payments.
      const [soapLine] = await linesOf(orderId, 'product')
      stripe.refundsStayPending = true
      await refund(orderId, [soapLine as string], 'card')
      stripe.refundsStayPending = false
      stripe.settleRefund(stripe.refundsSent.at(-1)?.id as string, 'failed')
      await runReconcile(stripe)
      expect(await figures(orderId)).toMatchObject({ cardLeft: 24, refundOwed: 64, owedCard: { payment: 'order', left: 24 } })
      const rest = await post('refunds/owed', orderId, { amount: 64, refundMethod: 'card' })
      expect(rest.body.data).toMatchObject({ cardRefundedAmount: 24, storeCreditRefundedAmount: 40, refundOwed: 0 })
      expect(stripe.refundedByIntent.get(order?.intent as string)).toBe(2400)
      expect(stripe.refundedByIntent.get(order?.own as string) ?? 0).toBe(0)
    })
  })

  it("W47 item 8 on two payments: It already arrived for the membership's £40 records it on the membership's line, so its own payment has nothing left to give and the soap's £24 is still all there; no money moves", async () => {
    await onASeed(async (stripe) => {
      const orderId = await placed({ ...monthly, products: [soap], payment: card })
      const [membershipLine] = await linesOf(orderId, 'membership')
      await failedLater(stripe, orderId)
      const sent = refundsSent(stripe).length
      expect(await orderOwedArrived(db, orderId, { amount: 40, reason: 'Seen on the first invoice in Stripe', arrivedOn: 'card' }, by)).toEqual({ cardRefundedAmount: 0, storeCreditRefundedAmount: 0, refundOwed: 0 })
      expect((await auditRows('order.owed_arrived')).at(-1)?.details).toEqual({ amount: 40, reason: 'Seen on the first invoice in Stripe', owedBefore: 40, owedAfter: 0, arrivedOn: 'card', card: 40, lines: [{ lineId: membershipLine, amount: 40 }] })
      expect((await lineRows(orderId)).map((line) => [line.item_type, line.card])).toEqual(expect.arrayContaining([['membership', '40.00'], ['product', '0.00']]))
      expect(await loadOrderCardPortion(db, orderId)).toMatchObject({ cardPortionRemaining: 24, membershipPayment: { took: 40, refunded: 40, remaining: 0 } })
      expect(await figures(orderId)).toMatchObject({ cardLeft: 24, refundOwed: 0 })
      expect(refundsSent(stripe)).toHaveLength(sent)
    })
  })

  it("W47 item 6 (the W35 audit's row 19; W30 review L5): an event booking's owed money on a two-payment order is the order's own payment's, even when the membership's line is short of its card money. Before W47 it went to the membership's payment", async () => {
    await onASeed(async (stripe) => {
      const orderId = await placed({ ...monthly, event: { eventId: ID.event, accountHolderAttending: true, guestsOver18Confirmed: true, attendees: [{ ...sam, isAccountHolder: true }] }, payment: card })
      const order = await orderRow(orderId)
      const portion = await loadOrderCardPortion(db, orderId)
      // Two payments: the membership's own, and the order's for the event place.
      expect(portion?.membershipPayment).toMatchObject({ took: 40, remaining: 40 })
      const eventPaid = portion?.cardPortionRemaining as number
      expect(eventPaid).toBeGreaterThan(0)
      const [membershipLine] = await linesOf(orderId, 'membership')
      const [eventLine] = await db.query<{ id: string; event_booking_id: string }>("SELECT id, event_booking_id FROM order_line_items WHERE order_id = $1 AND item_type = 'event'", [orderId])
      // The membership was refunded, £30 of it to its card and £10 to store credit by design: stamped `card`, £10 short.
      await db.query("UPDATE order_line_items SET refunded_at = now(), refund_method = 'card', card_refunded_amount = 30 WHERE id = $1", [membershipLine])
      // A place was cancelled and its card refund never reached the customer: owed on the order, the claim ended `owed`.
      await db.query('UPDATE orders SET refund_owed_amount = $1::numeric WHERE id = $2', [eventPaid, orderId])
      await db.query(
        "INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, details) VALUES ('staff', $1, 'event_booking.refund_finished', 'event_booking', $2, $3::jsonb)",
        [ID.staff, eventLine?.event_booking_id, JSON.stringify({ claimId: crypto.randomUUID(), outcome: 'owed', owed: eventPaid, orderId })]
      )
      expect(await figures(orderId)).toMatchObject({ refundOwed: eventPaid, owedCard: { payment: 'order', left: eventPaid } })
      const rest = await post('refunds/owed', orderId, { amount: eventPaid, refundMethod: 'card' })
      expect(rest.body.data).toMatchObject({ cardRefundedAmount: eventPaid, storeCreditRefundedAmount: 0, refundOwed: 0 })
      // To the order's own payment, and recorded on the event's line; the membership's payment is untouched.
      expect(stripe.refundedByIntent.get(order?.intent as string)).toBe(Math.round(eventPaid * 100))
      expect(stripe.refundedByIntent.get(order?.own as string) ?? 0).toBe(0)
      expect((await db.query<{ card: string }>('SELECT card_refunded_amount::float8 AS card FROM order_line_items WHERE id = $1', [eventLine?.id]))[0]?.card).toBe(eventPaid)
      expect((await lineRows(orderId)).find((line) => line.item_type === 'membership')).toMatchObject({ card: '30.00' })
    })
  })

  // Brief W47a item 1 (W47 review S1, its proof A). Sam buys Core monthly (£40, the subscription's first invoice) and
  // an event place (the order's own payment) on one saved card. The place's card refund once ended owed and staff
  // gave it with Refund the rest. Days later the membership is refunded to the card and that refund fails: £40 owed,
  // and it is the membership's. W47 read "this order has an event line with money owed" from rows that never clear,
  // so the £40 went to the order's own payment, which had nothing left: store credit.
  const later = (minutes = 5) => vi.setSystemTime(Date.now() + minutes * 60_000)
  async function eventMoneyGivenThenMembershipOwed(stripe: FakeStripe, how: 'refund_the_rest' | 'it_already_arrived' = 'refund_the_rest'): Promise<{ orderId: string; own: string; intent: string; eventPaid: number; membershipLine: string; eventLine: string }> {
    const orderId = await placed({ ...monthly, event: { eventId: ID.event, accountHolderAttending: true, guestsOver18Confirmed: true, attendees: [{ ...sam, isAccountHolder: true }] }, payment: card })
    const order = await orderRow(orderId)
    const eventPaid = (await loadOrderCardPortion(db, orderId))?.cardPortionRemaining as number
    expect(eventPaid).toBeGreaterThan(0)
    const [membershipLine] = await linesOf(orderId, 'membership')
    const [eventLine] = await db.query<{ id: string; event_booking_id: string }>("SELECT id, event_booking_id FROM order_line_items WHERE order_id = $1 AND item_type = 'event'", [orderId])
    // A place's card refund never reached Sam: owed on the order, the claim ended `owed` (the row-19 test's set-up).
    await db.query('UPDATE orders SET refund_owed_amount = $1::numeric WHERE id = $2', [eventPaid, orderId])
    await db.query(
      "INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, details) VALUES ('staff', $1, 'event_booking.refund_finished', 'event_booking', $2, $3::jsonb)",
      [ID.staff, eventLine?.event_booking_id, JSON.stringify({ claimId: crypto.randomUUID(), outcome: 'owed', owed: eventPaid, orderId })]
    )
    later()
    // While it is owed, it is the order's own payment's (W47's row 19, unchanged).
    expect(await figures(orderId)).toMatchObject({ refundOwed: eventPaid, owedCard: { payment: 'order', left: eventPaid } })
    if (how === 'it_already_arrived') {
      // Staff find it reached Sam another way after all: It already arrived, all of it. Nothing on any line.
      expect(await orderOwedArrived(db, orderId, { amount: eventPaid, reason: 'Found on their balance' }, by)).toEqual({ cardRefundedAmount: 0, storeCreditRefundedAmount: 0, refundOwed: 0 })
    } else {
      // The next day staff give it with Refund the rest, to the card: back to the order's own payment, on the event's line.
      const given = await post('refunds/owed', orderId, { amount: eventPaid, refundMethod: 'card' })
      expect(given.body.data).toMatchObject({ cardRefundedAmount: eventPaid, storeCreditRefundedAmount: 0, refundOwed: 0 })
      expect(stripe.refundedByIntent.get(order?.intent as string)).toBe(Math.round(eventPaid * 100))
      expect((await db.query<{ card: number }>('SELECT card_refunded_amount::float8 AS card FROM order_line_items WHERE id = $1', [eventLine?.id]))[0]?.card).toBe(eventPaid)
    }
    later(10 * 24 * 60)
    // Ten days on the membership is refunded to the card, and that refund fails later: £40 owed, the membership's own.
    await failedLater(stripe, orderId)
    later()
    return { orderId, own: order?.own as string, intent: order?.intent as string, eventPaid, membershipLine: membershipLine as string, eventLine: eventLine?.id as string }
  }

  it("W47a (W47 review S1, proof A): an event place's owed money that was given days ago no longer turns a later owed membership refund away from the membership's own payment: the figures name it, and Refund the rest sends Sam's £40 there, not to store credit", async () => {
    await onASeed(async (stripe) => {
      const { orderId, own, intent, eventPaid, membershipLine } = await eventMoneyGivenThenMembershipOwed(stripe)
      // The order's own payment has nothing left (the place's money went back to it); the membership's has all £40.
      expect(await figures(orderId)).toMatchObject({ cardLeft: 0, refundOwed: 40, owedCard: { payment: 'membership', left: 40 } })
      const balance = await storeCredit()
      const rest = await post('refunds/owed', orderId, { amount: 40, refundMethod: 'card' })
      expect(rest.body.data).toMatchObject({ cardRefundedAmount: 40, storeCreditRefundedAmount: 0, refundOwed: 0 })
      expect(stripe.refundedByIntent.get(own)).toBe(4000)
      expect(stripe.refundedByIntent.get(intent)).toBe(Math.round(eventPaid * 100))
      expect(await storeCredit()).toBe(balance)
      // Recorded on the membership's line, as the claim's card part says.
      expect((await auditRows('order.refund_claimed')).at(-1)?.details).toMatchObject({ kind: 'refund_owed', plan: { card: [{ paymentIntentId: own, amount: 40, lines: [{ lineId: membershipLine, amount: 40 }] }], storeCredit: 0 } })
      expect((await lineRows(orderId)).find((line) => line.item_type === 'membership')).toMatchObject({ card: '40.00' })
      expect(await loadOrderCardPortion(db, orderId)).toMatchObject({ membershipPayment: { took: 40, refunded: 40, remaining: 0 } })
      // That Refund the rest fails later too: the £40 is owed again, by the order's own row this time. Its claim put
      // the money on the membership's line, not the event's, so it is still the membership's own payment's.
      later()
      stripe.settleRefund(stripe.refundsSent.at(-1)?.id as string, 'failed')
      later(24 * 60)
      await runReconcile(stripe)
      expect(await orderRow(orderId)).toMatchObject({ owed: '40.00' })
      later()
      expect(await figures(orderId)).toMatchObject({ refundOwed: 40, owedCard: { payment: 'membership', left: 40 } })
      const again = await post('refunds/owed', orderId, { amount: 40, refundMethod: 'card' })
      expect(again.body.data).toMatchObject({ cardRefundedAmount: 40, storeCreditRefundedAmount: 0, refundOwed: 0 })
      expect(stripe.refundedByIntent.get(own)).toBe(4000)
      expect(await storeCredit()).toBe(balance)
    })
  })

  it("W47a (W47 review S1): the same when the place's owed money was settled with It already arrived (all of it) and not Refund the rest: the later owed membership refund is the membership's own payment's, and the order's own payment keeps the place's money", async () => {
    await onASeed(async (stripe) => {
      const { orderId, own, intent, eventPaid } = await eventMoneyGivenThenMembershipOwed(stripe, 'it_already_arrived')
      expect(await figures(orderId)).toMatchObject({ cardLeft: eventPaid, refundOwed: 40, owedCard: { payment: 'membership', left: 40 } })
      const rest = await post('refunds/owed', orderId, { amount: 40, refundMethod: 'card' })
      expect(rest.body.data).toMatchObject({ cardRefundedAmount: 40, storeCreditRefundedAmount: 0, refundOwed: 0 })
      expect(stripe.refundedByIntent.get(own)).toBe(4000)
      expect(stripe.refundedByIntent.get(intent) ?? 0).toBe(0)
    })
  })

  it("W47a (W47 review S1), It already arrived \"on the card\" in the same case: the £40 is recorded on the membership's line against its own payment (it was recorded nowhere, the order's own payment having nothing left); no money moves", async () => {
    await onASeed(async (stripe) => {
      const { orderId, eventPaid, membershipLine, eventLine } = await eventMoneyGivenThenMembershipOwed(stripe)
      const sent = refundsSent(stripe).length
      expect(await orderOwedArrived(db, orderId, { amount: 40, reason: 'Seen on the first invoice in Stripe', arrivedOn: 'card' }, by)).toEqual({ cardRefundedAmount: 0, storeCreditRefundedAmount: 0, refundOwed: 0 })
      expect((await auditRows('order.owed_arrived')).at(-1)?.details).toEqual({ amount: 40, reason: 'Seen on the first invoice in Stripe', owedBefore: 40, owedAfter: 0, arrivedOn: 'card', card: 40, lines: [{ lineId: membershipLine, amount: 40 }] })
      expect((await lineRows(orderId)).find((line) => line.item_type === 'membership')).toMatchObject({ card: '40.00' })
      // The event's line keeps what Refund the rest recorded on it, and no more.
      expect((await db.query<{ card: number }>('SELECT card_refunded_amount::float8 AS card FROM order_line_items WHERE id = $1', [eventLine]))[0]?.card).toBe(eventPaid)
      expect(await loadOrderCardPortion(db, orderId)).toMatchObject({ cardPortionRemaining: 0, membershipPayment: { took: 40, refunded: 40, remaining: 0 } })
      expect(await figures(orderId)).toMatchObject({ refundOwed: 0 })
      expect(refundsSent(stripe)).toHaveLength(sent)
    })
  })

  it("W47a (W47 review S1): the place's money owed again counts again. The Refund the rest that gave it fails later (it is the order's row now, of a claim that names the event's line): with the membership's £40 owed too, the owed money is the order's own payment's (row 19; the review's L6), and the place's part goes back on the event's line", async () => {
    await onASeed(async (stripe) => {
      const { orderId, own, intent, eventPaid, eventLine } = await eventMoneyGivenThenMembershipOwed(stripe)
      // The refund that gave the place's money back fails after all, 10 days on: off the event's line, owed on the order.
      const gave = stripe.refundsSent.find((sent) => sent.payment_intent === intent)
      stripe.settleRefund(gave?.id as string, 'failed')
      later(24 * 60)
      await runReconcile(stripe)
      const owed = Math.round((40 + eventPaid) * 100) / 100
      expect(Number((await orderRow(orderId))?.owed)).toBe(owed)
      expect((await auditRows('order.refund_failed_later')).at(-1)?.details).toMatchObject({ refundId: gave?.id, owed: eventPaid })
      expect((await db.query<{ card: number }>('SELECT card_refunded_amount::float8 AS card FROM order_line_items WHERE id = $1', [eventLine]))[0]?.card).toBe(0)
      later()
      expect(await figures(orderId)).toMatchObject({ refundOwed: owed, owedCard: { payment: 'order', left: eventPaid } })
      const rest = await post('refunds/owed', orderId, { amount: owed, refundMethod: 'card' })
      expect(rest.body.data).toMatchObject({ cardRefundedAmount: eventPaid, storeCreditRefundedAmount: 40, refundOwed: 0 })
      expect(stripe.refundedByIntent.get(intent)).toBe(Math.round(eventPaid * 100))
      expect(stripe.refundedByIntent.get(own) ?? 0).toBe(0)
      expect((await db.query<{ card: number }>('SELECT card_refunded_amount::float8 AS card FROM order_line_items WHERE id = $1', [eventLine]))[0]?.card).toBe(eventPaid)
    })
  })
})
