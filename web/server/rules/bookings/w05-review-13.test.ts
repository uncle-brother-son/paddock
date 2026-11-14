import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { POST as cancelRoute } from '@/app/api/v1/staff/bookings/[bookingId]/cancel-and-refund/route'
import { POST as cancelQuoteRoute } from '@/app/api/v1/staff/bookings/[bookingId]/cancel-and-refund/quote/route'
import { POST as owedRoute } from '@/app/api/v1/staff/bookings/[bookingId]/refunds/owed/route'
import { POST as partRoute } from '@/app/api/v1/staff/bookings/[bookingId]/refunds/route'
import { GET as figuresRoute } from '@/app/api/v1/staff/bookings/[bookingId]/refund-figures/route'
import type { Db } from '@/server/db'
import { reconcile } from '@/server/rules/orders/reconcile'
import { BOOKING_KINDS_ON } from '@/server/rules/testing/replay/booking-side'
import { oldSide, replay, REPLAY_USER, startReplay, type ReplayEnvironment } from '@/server/rules/testing/replay/harness'
import { ID, paidSeat, sam, seed } from '@/server/rules/testing/replay/scenarios'
import { replayStripe } from '@/server/rules/testing/replay/stripe-binding'
import type { FakeStripe } from '@/server/stripe/fake'
import { CHANGE_REFUND_UNCONFIRMED_MESSAGE, REFUND_OPEN_MESSAGE } from './failure-messages'

// Brief W27 item 7 ("plus the W05 review 13 test"; E-plan 2.1).
//
// W05 release review, finding 13 (proved on the old Retool code, shared/bookingMoneyClaim.ts): a £40 part refund is
// held at Stripe with no clear answer; a second staff member presses Cancel & Refund, which gives the other £60 and
// finishes; then the card declines the £40. The booking was left cancelled with £100 on it and the customer £40
// short, with no button to give it. It needed two staff and a decline together.
//
// Step D closed it (W21, W23, W25, W26a, W26b): an open refund claim holds the booking for every other refund
// (`refund_open`), so the cancel can't run past a held refund; a refund Stripe refuses ends as money owed on the
// booking; and money owed has its buttons on a live booking and on a cancelled one. This is that scenario, named,
// through the routes as the staff app calls them, so it stays closed. No booking code changed for it in W27.

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

type Answer = {
  status: number
  body: {
    ok: boolean
    data?: Record<string, unknown> & { held?: { claimId: string; reason: string; message: string } }
    error?: { code: string; message: string; details?: Record<string, unknown> & { reason?: string; message?: string } }
  }
}
type Route = (request: Request, context: { params: Promise<{ bookingId: string }> }) => Promise<Response>

async function send(route: Route, method: 'GET' | 'POST', path: string, bookingId: string, body?: unknown): Promise<Answer> {
  const before = process.env.ORDER_SWITCH
  process.env.ORDER_SWITCH = BOOKING_KINDS_ON
  try {
    const response = await route(
      new Request(`https://worker.test/api/v1/staff/bookings/${bookingId}/${path}`, {
        method,
        headers: { authorization: `Bearer ${KEY}`, 'x-staff-email': REPLAY_USER.email, 'content-type': 'application/json', ...(method === 'POST' ? { 'idempotency-key': crypto.randomUUID() } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      }),
      { params: Promise.resolve({ bookingId }) }
    )
    return { status: response.status, body: (await response.json()) as Answer['body'] }
  } finally {
    if (before === undefined) delete process.env.ORDER_SWITCH
    else process.env.ORDER_SWITCH = before
  }
}

const partRefund = (bookingId: string, amount: number) => send(partRoute as Route, 'POST', 'refunds', bookingId, { amount, refundMethod: 'card', reason: 'Late start' })
const refundTheRest = (bookingId: string, amount: number) => send(owedRoute as Route, 'POST', 'refunds/owed', bookingId, { amount, refundMethod: 'card' })
const figures = (bookingId: string) => send(figuresRoute as Route, 'GET', 'refund-figures', bookingId)
const cancelQuote = (bookingId: string) => send(cancelQuoteRoute as Route, 'POST', 'cancel-and-refund/quote', bookingId, { addonLineIds: [] })
/** Cancel & Refund as the dialog presses it: the quote's figures as confirmed. */
async function cancelAndRefund(bookingId: string): Promise<Answer> {
  const quote = (await cancelQuote(bookingId)).body.data as { refund: number; addonsRefund: number } | undefined
  return send(cancelRoute as Route, 'POST', 'cancel-and-refund', bookingId, { refundMethod: 'card', addonLineIds: [], confirmed: { refund: quote?.refund ?? 0, addonsRefund: quote?.addonsRefund ?? 0 } })
}

const booking = async (bookingId: string) =>
  (
    await db.query<{ status: string; price_paid: string; refund_owed_amount: string }>(
      'SELECT status, price_paid::text AS price_paid, refund_owed_amount::text AS refund_owed_amount FROM bookings WHERE id = $1',
      [bookingId]
    )
  )[0]
const storeCreditRefunds = () => db.query("SELECT 1 FROM store_credit_transactions WHERE reason = 'refund'")
const refundsSent = (stripe: FakeStripe) => stripe.calls.filter((call) => call.method === 'refunds.create')
const pastTheWindow = () => vi.setSystemTime(Date.now() + 16 * 60_000)
const runReconcile = () => reconcile(db, replayStripe.current as FakeStripe, { actor: { type: 'system', id: null }, requestId: crypto.randomUUID(), maxItems: 50, budgetMs: 60_000 })

/** A private hire for two at £100, paid on the card (the review's booking), then `work`. */
async function onAHundredPoundBooking(work: (made: { bookingId: string; stripe: FakeStripe }) => Promise<void>): Promise<void> {
  await replay(
    environment,
    {
      name: 'w05 review 13',
      seed,
      async run(context) {
        replayStripe.current = context.stripe
        const placed = (await context.call('createOrder', {
          customerId: ID.customer,
          booking: { ...paidSeat([sam, { name: 'Alex Guest', email: 'alex@example.com' }]), sessionId: ID.privateSession },
          payment: { method: 'card' },
        })) as { bookingId: string }
        try {
          await work({ bookingId: placed.bookingId, stripe: context.stripe })
        } finally {
          replayStripe.current = null
        }
      },
    },
    oldSide
  )
}

/** The £40 part refund, held: Stripe took it (pending) and both answers were lost. Answers the claim and Stripe's refund. */
async function heldPartRefund(bookingId: string, stripe: FakeStripe): Promise<{ claimId: string; refundId: string }> {
  stripe.refundsStayPending = true
  stripe.failNext('refunds.create', { kind: 'lost_response' })
  stripe.failNext('refunds.create', { kind: 'lost_response' })
  const held = await partRefund(bookingId, 40)
  stripe.refundsStayPending = false
  expect(held.status).toBe(200)
  expect(held.body.data?.held).toMatchObject({ reason: 'refund_unconfirmed', message: CHANGE_REFUND_UNCONFIRMED_MESSAGE })
  expect(stripe.refundsSent).toHaveLength(1)
  expect(stripe.refundsSent[0]).toMatchObject({ amount: 4000, status: 'pending' })
  return { claimId: held.body.data?.held?.claimId ?? '', refundId: stripe.refundsSent[0]?.id ?? '' }
}

describe('W05 review 13: a held part refund, then Cancel & Refund, then a decline (brief W27 item 7)', () => {
  it('the cancel is refused while the part refund is held; the decline ends as £40 still to refund; Cancel & Refund then gives all £100 back, once', async () => {
    await onAHundredPoundBooking(async ({ bookingId, stripe }) => {
      expect(await booking(bookingId)).toMatchObject({ status: 'confirmed', price_paid: '100.00', refund_owed_amount: '0.00' })

      // 1. The first staff member's £40 part refund gets no clear answer: held, the £40 claimed off the booking.
      const { refundId } = await heldPartRefund(bookingId, stripe)
      expect(await booking(bookingId)).toMatchObject({ status: 'confirmed', price_paid: '60.00' })
      const sentSoFar = refundsSent(stripe).length

      // 2. A second staff member presses Cancel & Refund. On the old code it gave £60 and finished. Now the quote says
      //    why not, and the press is refused before anything moves: nothing sent, the booking as it was.
      expect((await cancelQuote(bookingId)).body.data).toMatchObject({ blocked: { reason: 'refund_open', message: REFUND_OPEN_MESSAGE } })
      const refused = await cancelAndRefund(bookingId)
      expect(refused.status).toBe(409)
      expect(refused.body.error).toMatchObject({ code: 'CONFLICT', message: REFUND_OPEN_MESSAGE, details: { reason: 'refund_open' } })
      expect(await booking(bookingId)).toMatchObject({ status: 'confirmed', price_paid: '60.00', refund_owed_amount: '0.00' })
      expect(refundsSent(stripe)).toHaveLength(sentSoFar)

      // 3. Then the card declines the £40.
      stripe.settleRefund(refundId, 'failed')
      expect(stripe.refundedPence).toBe(0)

      // 4. Reconcile finds the refund that names the claim, failed: the £40 goes back on the booking as still to
      //    refund, with Stripe's reason. It is never given as store credit, and never sent again.
      pastTheWindow()
      await runReconcile()
      expect(await booking(bookingId)).toMatchObject({ status: 'confirmed', price_paid: '100.00', refund_owed_amount: '40.00' })
      expect(await storeCreditRefunds()).toEqual([])
      expect(refundsSent(stripe)).toHaveLength(sentSoFar)
      const finished = await db.query<{ details: Record<string, unknown> }>("SELECT details FROM audit_log WHERE action = 'booking.refund_finished' AND entity_id = $1", [bookingId])
      expect(finished).toHaveLength(1)
      expect(finished[0]?.details).toMatchObject({ outcome: 'owed', cardRefunded: 0, storeCreditRefunded: 0, owed: 40, refused: 'Failed to refund payment: the refund failed', by: { how: 'reconcile' } })

      // 5. The buttons the review found missing. The figures show the £40 owed; Cancel & Refund now runs, and gives
      //    back everything on the booking, the £40 included.
      expect((await figures(bookingId)).body.data).toMatchObject({ refundOwed: 40, pricePaid: 100 })
      const cancelled = await cancelAndRefund(bookingId)
      expect(cancelled.status).toBe(200)
      expect(cancelled.body.data).toMatchObject({ cardRefundedAmount: 100, storeCreditRefundedAmount: 0 })
      expect(cancelled.body.data).not.toHaveProperty('held')
      expect(await booking(bookingId)).toMatchObject({ status: 'cancelled', refund_owed_amount: '0.00' })

      // The customer paid £100 on the card and has £100 back on it: not £40 short, and not a penny over.
      expect([...stripe.chargedByIntent.values()].reduce((sum, pence) => sum + pence, 0)).toBe(10_000)
      expect(stripe.refundedPence).toBe(10_000)
      expect(await storeCreditRefunds()).toEqual([])
    })
  })

  it('or the first staff member finishes it with Refund the rest: £40 to the card, the booking live with £60 on it', async () => {
    await onAHundredPoundBooking(async ({ bookingId, stripe }) => {
      const { refundId } = await heldPartRefund(bookingId, stripe)
      stripe.settleRefund(refundId, 'failed')
      pastTheWindow()
      await runReconcile()
      expect(await booking(bookingId)).toMatchObject({ price_paid: '100.00', refund_owed_amount: '40.00' })

      const given = await refundTheRest(bookingId, 40)
      expect(given.status).toBe(200)
      expect(given.body.data).toMatchObject({ cardRefundedAmount: 40, storeCreditRefundedAmount: 0 })
      expect(await booking(bookingId)).toMatchObject({ status: 'confirmed', price_paid: '60.00', refund_owed_amount: '0.00' })
      expect(stripe.refundedPence).toBe(4_000)
      // Pressed again: nothing is owed, and nothing more goes.
      expect((await refundTheRest(bookingId, 40)).body.error?.details).toMatchObject({ reason: 'nothing_owed' })
      expect(stripe.refundedPence).toBe(4_000)
    })
  })

  it('and if the held £40 did go after all, reconcile records it, and the cancel then gives back the £60 that is left: £100 in all, never £140', async () => {
    await onAHundredPoundBooking(async ({ bookingId, stripe }) => {
      const { refundId } = await heldPartRefund(bookingId, stripe)
      expect((await cancelAndRefund(bookingId)).body.error?.details).toMatchObject({ reason: 'refund_open' })
      stripe.settleRefund(refundId, 'succeeded')
      pastTheWindow()
      await runReconcile()
      expect(await booking(bookingId)).toMatchObject({ status: 'confirmed', price_paid: '60.00', refund_owed_amount: '0.00' })

      const cancelled = await cancelAndRefund(bookingId)
      expect(cancelled.body.data).toMatchObject({ cardRefundedAmount: 60, storeCreditRefundedAmount: 0 })
      expect(await booking(bookingId)).toMatchObject({ status: 'cancelled', refund_owed_amount: '0.00' })
      expect(stripe.refundedPence).toBe(10_000)
    })
  })
})
