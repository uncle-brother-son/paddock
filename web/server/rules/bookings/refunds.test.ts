import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { POST as partRoute } from '@/app/api/v1/staff/bookings/[bookingId]/refunds/route'
import { POST as owedRoute } from '@/app/api/v1/staff/bookings/[bookingId]/refunds/owed/route'
import { POST as arrivedRoute } from '@/app/api/v1/staff/bookings/[bookingId]/refunds/owed-arrived/route'
import { GET as figuresRoute } from '@/app/api/v1/staff/bookings/[bookingId]/refund-figures/route'
import { POST as closeRoute } from '@/app/api/v1/staff/orders/stuck/close/route'
import type { Db } from '@/server/db'
import { reconcile } from '@/server/rules/orders/reconcile'
import { CLAIM_WAITING_WORDS, stuckList } from '@/server/rules/orders/stuck-list'
import { readFlow } from '@/server/rules/orders/reader-flow'
import { oldSide, replay, REPLAY_USER, startReplay, type ReplayEnvironment, type ScenarioContext } from '@/server/rules/testing/replay/harness'
import { bea, ID, paidSeat, sam, seed, whileFailing, refundCreditFails } from '@/server/rules/testing/replay/scenarios'
import { STRIPE_DEADLINE_MS } from '@/server/stripe/deadline'
import { replayStripe } from '@/server/rules/testing/replay/stripe-binding'
import { BOOKING_KINDS_ON } from '@/server/rules/testing/replay/booking-side'
import { fakeStripeErrors, type FakeStripe } from '@/server/stripe/fake'
import {
  BOOKING_PATH_OFF_MESSAGE,
  CHANGE_REFUND_UNCONFIRMED_MESSAGE,
  laterCardRefundNotSentMessage,
  NO_CASH_LEFT_MESSAGE,
  oldRefundReachedCustomerMessage,
  onlyCardLeftMessage,
  onlyCashLeftMessage,
  onlyLeftMessage,
  owedChangedMessage,
  REFUND_CHECK_FAILED_MESSAGE,
  REFUND_OPEN_MESSAGE,
  REFUND_WORDS,
  refundGoneNotRecordedMessage,
} from './failure-messages'
import { loadBookingMoneyLeft } from './money-left'
import { claimRefundKey, readClaim, REFUND_CLAIMED, type ClaimDetails } from './refunds'

// Brief W21: the refund pipeline (D-plan 4.3, 4.10), Part refund, Refund the rest, It already arrived and the figures,
// on the replay's live schema (its triggers and the store credit function included), through the routes as the staff
// app calls them. The bookings are made by the old functions (the frozen copy), as the golden scenarios make them.
// Stripe is only ever the fake.

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

/** A public booking for two on the card (£40), with `guests` more each added on the card (£20 each, their own order). */
async function onABooking(
  work: (context: Context) => Promise<void>,
  {
    guests = 0,
    payment = { method: 'card' } as Record<string, unknown>,
    guestPayment = { method: 'card' } as Record<string, unknown>,
    privatePrice = undefined as number | undefined,
  } = {}
): Promise<void> {
  await replay(
    environment,
    {
      name: 'w21 refunds',
      seed,
      async run(context) {
        replayStripe.current = context.stripe
        await context.db.query('UPDATE customers SET store_credit_balance = 100 WHERE id = $1', [ID.customer])
        // W21a: a private hire at `privatePrice` (the review's £200 example) instead of the public seats.
        if (privatePrice !== undefined) await context.db.query('UPDATE service_type_price_tiers SET price = $1 WHERE id = $2', [privatePrice, ID.privateTier])
        const seats = paidSeat([sam, { name: 'Alex Guest', email: 'alex@example.com' }])
        const placed = (await context.call('createOrder', {
          customerId: ID.customer,
          booking: privatePrice === undefined ? seats : { ...seats, sessionId: ID.privateSession },
          payment,
        })) as { bookingId: string }
        const bookingId = placed.bookingId
        const extra = [bea, { guestName: 'Cy Guest', guestEmail: 'cy@example.com', guestsOver18Confirmed: true }]
        for (const guest of extra.slice(0, guests)) {
          await context.call('addBookingGuest', { bookingId, ...guest })
          await context.call('addBookingGuest', { bookingId, ...guest, payment: guestPayment })
          vi.setSystemTime(Date.now() + 1000)
        }
        try {
          await work({ ...context, bookingId })
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
    error?: { code: string; message: string; details?: { reason?: string; message?: string; figures?: Record<string, unknown> } }
  }
}

type RefundPath = 'part' | 'owed' | 'arrived'
const ROUTES = { part: partRoute, owed: owedRoute, arrived: arrivedRoute }
const SUFFIX = { part: 'refunds', owed: 'refunds/owed', arrived: 'refunds/owed-arrived' }

async function refund(path: RefundPath, bookingId: string, body: unknown, { key = crypto.randomUUID(), orderSwitch = BOOKING_KINDS_ON, email = REPLAY_USER.email } = {}): Promise<Answer> {
  const before = process.env.ORDER_SWITCH
  process.env.ORDER_SWITCH = orderSwitch
  try {
    const response = await ROUTES[path](
      new Request(`https://worker.test/api/v1/staff/bookings/${bookingId}/${SUFFIX[path]}`, {
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

async function figures(bookingId: string): Promise<Answer> {
  const response = await figuresRoute(
    new Request(`https://worker.test/api/v1/staff/bookings/${bookingId}/refund-figures`, { headers: { authorization: `Bearer ${KEY}`, 'x-staff-email': REPLAY_USER.email } }),
    { params: Promise.resolve({ bookingId }) }
  )
  return { status: response.status, body: (await response.json()) as Answer['body'] }
}

async function close(kind: 'held_flow' | 'held_claim', id: string): Promise<Answer> {
  const response = await closeRoute(
    new Request('https://worker.test/api/v1/staff/orders/stuck/close', {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'x-staff-email': REPLAY_USER.email, 'idempotency-key': crypto.randomUUID(), 'content-type': 'application/json' },
      body: JSON.stringify({ kind, orderId: id, reason: 'Checked in Stripe by hand' }),
    })
  )
  return { status: response.status, body: (await response.json()) as Answer['body'] }
}

const runReconcile = () => reconcile(db, replayStripe.current as FakeStripe, { actor: { type: 'system', id: null }, requestId: crypto.randomUUID(), maxItems: 50, budgetMs: 60_000 })
/** Past the window, so reconcile and the stuck list look at what is held. */
const pastTheWindow = () => vi.setSystemTime(Date.now() + 16 * 60_000)

async function booking(bookingId: string) {
  return (
    await db.query<{ price_paid: string; part_refunded_amount: string; refund_owed_amount: string; status: string }>(
      'SELECT price_paid::text AS price_paid, part_refunded_amount::text AS part_refunded_amount, refund_owed_amount::text AS refund_owed_amount, status FROM bookings WHERE id = $1',
      [bookingId]
    )
  )[0]
}
const storeCredit = async () =>
  db.query<{ amount: string; reason: string; order_id: string | null; booking_id: string | null; note: string }>(
    "SELECT amount::text AS amount, reason, order_id, booking_id, note FROM store_credit_transactions WHERE reason = 'refund' ORDER BY created_at"
  )
const bookingLines = async (bookingId: string) =>
  db.query<{ order_id: string; card_refunded_amount: string; created_at: Date }>(
    "SELECT order_id, card_refunded_amount::text AS card_refunded_amount, created_at FROM order_line_items WHERE booking_id = $1 AND item_type = 'booking' ORDER BY created_at",
    [bookingId]
  )
const refundCalls = (stripe: FakeStripe) => stripe.calls.filter((call) => call.method === 'refunds.create')
const auditRows = async (action: string) => db.query<{ id: string; details: Record<string, unknown>; request_id: string | null }>('SELECT id, details, request_id FROM audit_log WHERE action = $1 ORDER BY at', [action])

describe('Part refund (W21)', () => {
  it('to the card across three orders, newest first, each capped at its own card money; keys and metadata from the claim', async () => {
    await onABooking(
      async ({ bookingId, stripe }) => {
        const answer = await refund('part', bookingId, { amount: 70, refundMethod: 'card', reason: 'Goodwill' })
        expect(answer.status).toBe(200)
        expect(answer.body.data).toMatchObject({ cardRefundedAmount: 70, storeCreditRefundedAmount: 0, pricePaid: 10 })
        const lines = await bookingLines(bookingId)
        // Newest first: Cy's £20, Bea's £20, then £30 of the first order's £40.
        expect(lines.map((line) => line.card_refunded_amount)).toEqual(['30', '20', '20'])
        const claim = (await auditRows(REFUND_CLAIMED))[0]
        const calls = refundCalls(stripe)
        expect(calls.map((call) => (call.params as { amount: number }).amount)).toEqual([2000, 2000, 3000])
        const orders = [lines[2]?.order_id, lines[1]?.order_id, lines[0]?.order_id]
        expect(calls.map((call) => call.idempotencyKey)).toEqual(orders.map((orderId) => claimRefundKey(claim?.id ?? '', orderId ?? '')))
        expect(calls.map((call) => (call.params as { metadata: Record<string, string> }).metadata)).toEqual(
          orders.map((orderId) => ({ refund_key: claimRefundKey(claim?.id ?? '', orderId ?? ''), claim_id: claim?.id }))
        )
        expect(await booking(bookingId)).toMatchObject({ price_paid: '10.00', part_refunded_amount: '70.00', refund_owed_amount: '0.00' })
        const finished = (await auditRows('booking.refund_finished'))[0]
        expect(finished?.details).toEqual({ claimId: claim?.id, outcome: 'given', cardRefunded: 70, storeCreditRefunded: 0, owed: 0 })
        expect((await auditRows('booking.part_refund'))[0]?.details).toEqual({ amount: 70, reason: 'Goodwill', method: 'card', cardRefunded: 70, storeCreditRefunded: 0, owed: 0 })
        // W05 invariant: money back never above what was paid.
        const back = lines.reduce((total, line) => total + Number(line.card_refunded_amount), 0)
        expect(back).toBeLessThanOrEqual(80)
      },
      { guests: 2 }
    )
  })

  it('to store credit: one transaction, nothing sent to Stripe, the old note and the booking\'s own order', async () => {
    await onABooking(async ({ bookingId, stripe }) => {
      const answer = await refund('part', bookingId, { amount: 15, refundMethod: 'credit', reason: 'Goodwill' })
      expect(answer.body.data).toMatchObject({ cardRefundedAmount: 0, storeCreditRefundedAmount: 15, pricePaid: 25 })
      expect(typeof answer.body.data?.['storeCreditBalance']).toBe('number')
      expect(refundCalls(stripe)).toEqual([])
      const credit = (await storeCredit())[0]
      const ownOrder = (await bookingLines(bookingId))[0]?.order_id
      expect(credit).toMatchObject({ amount: '15.00', order_id: ownOrder, booking_id: bookingId })
      expect(credit?.note).toMatch(/^Booking partial refund: Goodwill\. \[ref [0-9a-f-]{36}\]$/)
    })
  })

  it('the first card part refused: R1 undone in one transaction, nothing kept, the old words; the next press is a new claim and key', async () => {
    await onABooking(
      async ({ bookingId, stripe }) => {
        stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
        const refused = await refund('part', bookingId, { amount: 30, refundMethod: 'card', reason: 'Goodwill' })
        expect(refused.status).toBe(402)
        expect(refused.body.error?.details).toMatchObject({ reason: 'refund_failed', message: 'The card refund failed, so nothing was refunded: Failed to refund payment: Your card was declined.' })
        expect(await booking(bookingId)).toMatchObject({ price_paid: '60.00', part_refunded_amount: '0.00' })
        expect((await auditRows('booking.refund_finished'))[0]?.details).toMatchObject({ outcome: 'put_back' })
        expect(await auditRows('booking.part_refund')).toEqual([])
        const again = await refund('part', bookingId, { amount: 30, refundMethod: 'card', reason: 'Goodwill' })
        expect(again.body.data).toMatchObject({ cardRefundedAmount: 30 })
        const keys = refundCalls(stripe).map((call) => call.idempotencyKey)
        expect(new Set(keys).size).toBe(keys.length)
      },
      { guests: 1 }
    )
  })

  it('a later card part refused: it and the rest go to store credit (today\'s rule), with the old warning', async () => {
    await onABooking(
      async ({ bookingId, stripe }) => {
        stripe.failNext('refunds.create', { kind: 'none' })
        stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
        const answer = await refund('part', bookingId, { amount: 50, refundMethod: 'card', reason: 'Goodwill' })
        expect(answer.body.data).toMatchObject({
          cardRefundedAmount: 20,
          storeCreditRefundedAmount: 30,
          pricePaid: 10,
          warning: 'A further card refund of £30.00 failed (Failed to refund payment: Your card was declined.), so the rest went to store credit.',
        })
        expect((await storeCredit())[0]?.note).toMatch(/^Booking partial refund: Goodwill \(the rest went back to the card\)\. \[ref /)
        expect((await bookingLines(bookingId)).map((line) => line.card_refunded_amount)).toEqual(['0', '20'])
      },
      { guests: 1 }
    )
  })

  it('W21a (review L6): a later card part with no time left to send ends as owed (Refund the rest sends it to the card), not store credit', async () => {
    await onABooking(
      async ({ bookingId, stripe }) => {
        // Stripe is slow on the first part (Bea's £20 goes, the whole deadline later), so the first order's £30 is never sent.
        const create = stripe.refunds.create.bind(stripe.refunds)
        const slow = vi.spyOn(stripe.refunds, 'create').mockImplementationOnce(async (...args: Parameters<typeof create>) => {
          const made = await create(...args)
          vi.setSystemTime(Date.now() + STRIPE_DEADLINE_MS)
          return made
        })
        const answer = await refund('part', bookingId, { amount: 50, refundMethod: 'card', reason: 'Goodwill' })
        slow.mockRestore()
        expect(answer.body.data).toMatchObject({ cardRefundedAmount: 20, storeCreditRefundedAmount: 0, pricePaid: 40, warning: laterCardRefundNotSentMessage(30) })
        expect(refundCalls(stripe).map((call) => (call.params as { amount: number }).amount)).toEqual([2000])
        expect(await storeCredit()).toEqual([])
        // Still a part refund of £50 (Q27), £30 of it owed.
        expect(await booking(bookingId)).toMatchObject({ price_paid: '40.00', part_refunded_amount: '50.00', refund_owed_amount: '30.00' })
        expect((await auditRows('booking.refund_finished'))[0]?.details).toMatchObject({ outcome: 'owed', cardRefunded: 20, storeCreditRefunded: 0, owed: 30 })
        expect((await auditRows('booking.part_refund'))[0]?.details).toEqual({ amount: 50, reason: 'Goodwill', method: 'card', cardRefunded: 20, storeCreditRefunded: 0, owed: 30 })
        // Refund the rest sends it to the card: the first order's £30.
        const rest = await refund('owed', bookingId, { amount: 30, refundMethod: 'card' })
        expect(rest.body.data).toMatchObject({ cardRefundedAmount: 30, storeCreditRefundedAmount: 0, pricePaid: 10 })
        expect(refundCalls(stripe).map((call) => (call.params as { amount: number }).amount)).toEqual([2000, 3000])
        expect((await bookingLines(bookingId)).map((line) => line.card_refunded_amount)).toEqual(['30', '20'])
        expect(await storeCredit()).toEqual([])
      },
      { guests: 1 }
    )
  })

  it('no clear answer, and Stripe has it: held with Q35\'s words; never sent again; reconcile finds it and finishes (found -> R2)', async () => {
    await onABooking(
      async ({ bookingId, stripe }) => {
        stripe.failNext('refunds.create', { kind: 'lost_response' })
        stripe.failNext('refunds.create', { kind: 'lost_response' })
        const answer = await refund('part', bookingId, { amount: 20, refundMethod: 'card', reason: 'Goodwill' })
        expect(answer.body.data?.held).toMatchObject({ reason: 'refund_unconfirmed', message: CHANGE_REFUND_UNCONFIRMED_MESSAGE })
        // Held holds every other refund on the booking.
        const second = await refund('part', bookingId, { amount: 5, refundMethod: 'credit', reason: 'Goodwill' })
        expect(second.body.error?.details).toMatchObject({ reason: 'refund_open', message: REFUND_OPEN_MESSAGE })
        // Not yet past the window: reconcile leaves it.
        expect((await runReconcile()).items.filter((item) => item.kind === 'claim')).toEqual([])
        pastTheWindow()
        const listed = await stuckList(db)
        expect(listed.claims).toMatchObject([{ bookingId, amount: 20, reason: 'waiting', words: CLAIM_WAITING_WORDS }])
        expect(listed.claims[0]?.close).toBeUndefined()
        const sent = refundCalls(stripe).length
        const run = await runReconcile()
        expect(run.items.filter((item) => item.kind === 'claim')).toMatchObject([{ outcome: 'finalised' }])
        // Reconcile never resends a refund: it only lists.
        expect(refundCalls(stripe)).toHaveLength(sent)
        expect(stripe.calls.filter((call) => call.method === 'refunds.list').length).toBeGreaterThan(0)
        expect(await booking(bookingId)).toMatchObject({ price_paid: '40.00', part_refunded_amount: '20.00', refund_owed_amount: '0.00' })
        expect((await bookingLines(bookingId)).map((line) => line.card_refunded_amount)).toEqual(['0', '20'])
        expect((await auditRows('booking.refund_finished'))[0]?.details).toMatchObject({ outcome: 'given', cardRefunded: 20, owed: 0, by: { how: 'reconcile' } })
        expect((await stuckList(db)).claims).toEqual([])
        // A second run finds nothing to do.
        expect((await runReconcile()).items.filter((item) => item.kind === 'claim')).toEqual([])
      },
      { guests: 1 }
    )
  })

  it('no clear answer, and Stripe never got it: reconcile finds nothing, and the money ends as owed (Refund the rest); never resent', async () => {
    await onABooking(
      async ({ bookingId, stripe }) => {
        stripe.failNext('refunds.create', { kind: 'unreachable' })
        stripe.failNext('refunds.create', { kind: 'unreachable' })
        const answer = await refund('part', bookingId, { amount: 20, refundMethod: 'card', reason: 'Goodwill' })
        expect(answer.body.data?.held?.reason).toBe('refund_unconfirmed')
        pastTheWindow()
        const sent = refundCalls(stripe).length
        await runReconcile()
        expect(refundCalls(stripe)).toHaveLength(sent)
        // Still a part refund (Q27: goodwill on its way), now owed.
        expect(await booking(bookingId)).toMatchObject({ price_paid: '60.00', part_refunded_amount: '20.00', refund_owed_amount: '20.00' })
        expect((await auditRows('booking.refund_finished'))[0]?.details).toMatchObject({ outcome: 'owed', cardRefunded: 0, owed: 20 })
        // Refund the rest gives it.
        const rest = await refund('owed', bookingId, { amount: 20, refundMethod: 'card' })
        expect(rest.body.data).toMatchObject({ cardRefundedAmount: 20, pricePaid: 40 })
        expect(await booking(bookingId)).toMatchObject({ price_paid: '40.00', refund_owed_amount: '0.00' })
      },
      { guests: 1 }
    )
  })

  it('the card went and R2 couldn\'t record it: held (never refunded again), and reconcile records it', async () => {
    await onABooking(
      async ({ bookingId, stripe }) => {
        // Bea's £20 goes; the first order's £30 is refused, so R2 sends it to store credit, and that write fails.
        stripe.failNext('refunds.create', { kind: 'none' })
        stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
        const answer = await whileFailing(db, refundCreditFails, () => refund('part', bookingId, { amount: 50, refundMethod: 'card', reason: 'Goodwill' }))
        expect(answer.body.data).toMatchObject({ cardRefundedAmount: 20, held: { reason: 'refund_not_recorded', message: refundGoneNotRecordedMessage(20) } })
        // Held: nothing on the lines yet, and no other refund.
        expect((await bookingLines(bookingId)).map((line) => line.card_refunded_amount)).toEqual(['0', '0'])
        pastTheWindow()
        const sent = refundCalls(stripe).length
        await runReconcile()
        expect(refundCalls(stripe)).toHaveLength(sent)
        // Reconcile records the £20 that went; the £30 Stripe never took ends as owed (D-plan 4.10), not resent.
        expect((await auditRows('booking.refund_finished'))[0]?.details).toMatchObject({ outcome: 'owed', cardRefunded: 20, storeCreditRefunded: 0, owed: 30 })
        expect((await bookingLines(bookingId)).map((line) => line.card_refunded_amount)).toEqual(['0', '20'])
        expect(await booking(bookingId)).toMatchObject({ price_paid: '40.00', part_refunded_amount: '50.00', refund_owed_amount: '30.00' })
      },
      { guests: 1 }
    )
  })

  it('Q18: over what is left by a penny is refused with the old words and the new figures; half a penny passes', async () => {
    await onABooking(async ({ bookingId }) => {
      const over = await refund('part', bookingId, { amount: 40.01, refundMethod: 'credit', reason: 'Goodwill' })
      expect(over.body.error?.details).toMatchObject({ reason: 'more_than_left', message: onlyLeftMessage(40) })
      expect(over.body.error?.details?.figures).toMatchObject({ left: 40, cashLeft: 0, paidLine: 'Left to refund: £40.00 card money.' })
      const cardOver = await refund('part', bookingId, { amount: 40.01, refundMethod: 'card', reason: 'Goodwill' })
      expect(cardOver.body.error?.details?.reason).toBe('more_than_left')
      const half = await refund('part', bookingId, { amount: 40.004, refundMethod: 'credit', reason: 'Goodwill' })
      expect(half.body.data).toMatchObject({ storeCreditRefundedAmount: 40, pricePaid: 0 })
      const nothing = await refund('part', bookingId, { amount: 1, refundMethod: 'credit', reason: 'Goodwill' })
      expect(nothing.body.error?.details).toMatchObject({ reason: 'nothing_left', message: REFUND_WORDS.nothingLeft })
    })
  })

  it('the old refusals, in the old order: method, payment open, cancelled, amount, reason, card left', async () => {
    await onABooking(async ({ bookingId }) => {
      expect((await refund('part', bookingId, { amount: 5, refundMethod: 'cheque', reason: 'x' })).body.error?.details?.reason).toBe('refund_method_invalid')
      expect((await refund('part', bookingId, { amount: 0, refundMethod: 'credit', reason: 'x' })).body.error?.message).toBe(REFUND_WORDS.amountNotPositive)
      expect((await refund('part', bookingId, { amount: 5, refundMethod: 'credit', reason: '  ' })).body.error?.message).toBe('A reason is required for a part refund.')
      expect((await refund('part', bookingId, { amount: 5, refundMethod: 'credit', reason: 'x'.repeat(201) })).body.error?.message).toBe('The reason must be 200 characters or fewer.')
      expect((await refund('part', crypto.randomUUID(), { amount: 5, refundMethod: 'credit', reason: 'x' })).body.error).toMatchObject({ code: 'NOT_FOUND', message: REFUND_WORDS.bookingNotFound })
      // £10 to store credit, then only £30 of card money left (the card was £40 and the line's net is what's left).
      await refund('part', bookingId, { amount: 10, refundMethod: 'credit', reason: 'x' })
      const cardOver = await refund('part', bookingId, { amount: 30.01, refundMethod: 'card', reason: 'x' })
      expect(cardOver.body.error?.details?.message).toBe(onlyLeftMessage(30))
      await db.query("UPDATE bookings SET status = 'cancelled' WHERE id = $1", [bookingId])
      expect((await refund('part', bookingId, { amount: 5, refundMethod: 'credit', reason: 'x' })).body.error?.message).toBe(REFUND_WORDS.alreadyCancelled)
    })
  })

  it('card money left is checked: a cash booking has none, and card is refused with the old words', async () => {
    await onABooking(
      async ({ bookingId }) => {
        const answer = await refund('part', bookingId, { amount: 10, refundMethod: 'card', reason: 'x' })
        expect(answer.body.error?.details).toMatchObject({ reason: 'more_than_card_left', message: REFUND_WORDS.noCardLeft })
      },
      { payment: { method: 'cash', confirmedCashAmount: 40 } }
    )
  })

  it('Q26: cash back, capped at the cash on the booking\'s orders, R1 only, who handed it over in the claim', async () => {
    await onABooking(
      async ({ bookingId, stripe }) => {
        const shown = await figures(bookingId)
        expect(shown.body.data).toMatchObject({ left: 40, cashLeft: 40, paidLine: 'Left to refund: £40.00 cash.' })
        const over = await refund('part', bookingId, { amount: 40.01, refundMethod: 'cash', reason: 'Handed back' })
        expect(over.body.error?.details?.reason).toBe('more_than_left')
        const given = await refund('part', bookingId, { amount: 15, refundMethod: 'cash', reason: 'Handed back' })
        expect(given.body.data).toMatchObject({ cardRefundedAmount: 0, storeCreditRefundedAmount: 0, cashRefundedAmount: 15, pricePaid: 25 })
        expect(refundCalls(stripe)).toEqual([])
        const claim = (await auditRows(REFUND_CLAIMED))[0]?.details as unknown as ClaimDetails
        expect(claim).toMatchObject({ method: 'cash', amount: 15, handedOverBy: expect.any(String), plan: { cash: 15, storeCredit: 0, card: [] } })
        expect((await figures(bookingId)).body.data).toMatchObject({ left: 25, cashLeft: 25 })
        // £20 more to store credit, then only £5 of cash is left to hand back.
        await refund('part', bookingId, { amount: 20, refundMethod: 'credit', reason: 'x' })
        const capped = await refund('part', bookingId, { amount: 6, refundMethod: 'cash', reason: 'x' })
        expect(capped.body.error?.details?.reason).toBe('more_than_left')
        expect((await refund('part', bookingId, { amount: 5, refundMethod: 'cash', reason: 'x' })).body.data).toMatchObject({ cashRefundedAmount: 5, pricePaid: 0 })
      },
      { payment: { method: 'cash', confirmedCashAmount: 40 } }
    )
  })

  it('Q26: card money is never handed back in cash', async () => {
    await onABooking(async ({ bookingId }) => {
      expect((await figures(bookingId)).body.data).toMatchObject({ cashLeft: 0 })
      const answer = await refund('part', bookingId, { amount: 5, refundMethod: 'cash', reason: 'x' })
      expect(answer.body.error?.details).toMatchObject({ reason: 'more_than_cash_left', message: NO_CASH_LEFT_MESSAGE })
    })
  })

  it('Issue refunds is needed; the switch gates money out before anything is read', async () => {
    await onABooking(async ({ bookingId }) => {
      await db.query("INSERT INTO staff (first_name, last_name, email, role, can_issue_refunds, active) VALUES ('No', 'Refunds', 'nore@example.com', 'staff', false, true)")
      const forbidden = await refund('part', bookingId, { amount: 5, refundMethod: 'credit', reason: 'x' }, { email: 'nore@example.com' })
      expect(forbidden.body.error).toMatchObject({ code: 'FORBIDDEN', message: 'Needs Issue refunds permission — this action moves money back to the customer.' })
      const off = await refund('part', bookingId, { amount: 5, refundMethod: 'card', reason: 'x' }, { orderSwitch: 'no_stripe,saved_card' })
      expect(off.body.error).toMatchObject({ code: 'BOOKING_PATH_OFF', message: BOOKING_PATH_OFF_MESSAGE })
      expect(await booking(bookingId)).toMatchObject({ price_paid: '40.00' })
    })
  })

  it('the same key twice: one refund, the stored answer', async () => {
    await onABooking(async ({ bookingId, stripe }) => {
      const key = crypto.randomUUID()
      const first = await refund('part', bookingId, { amount: 10, refundMethod: 'card', reason: 'x' }, { key })
      const second = await refund('part', bookingId, { amount: 10, refundMethod: 'card', reason: 'x' }, { key })
      expect(second.body.data).toEqual(first.body.data)
      expect(refundCalls(stripe)).toHaveLength(1)
      expect(await booking(bookingId)).toMatchObject({ price_paid: '30.00' })
    })
  })
})

describe('Refund the rest and It already arrived (W21)', () => {
  /** £20 owed: a card refund Stripe never got, settled by reconcile as owed. */
  async function withTwentyOwed(stripe: FakeStripe, bookingId: string) {
    stripe.failNext('refunds.create', { kind: 'unreachable' })
    stripe.failNext('refunds.create', { kind: 'unreachable' })
    await refund('part', bookingId, { amount: 20, refundMethod: 'card', reason: 'Goodwill' })
    pastTheWindow()
    await runReconcile()
    expect(await booking(bookingId)).toMatchObject({ refund_owed_amount: '20.00' })
  }

  it('Refund the rest: exactly what is owed (half a penny either way), to store credit; never a part refund', async () => {
    await onABooking(async ({ bookingId, stripe }) => {
      await withTwentyOwed(stripe, bookingId)
      const changed = await refund('owed', bookingId, { amount: 19.99, refundMethod: 'credit' })
      expect(changed.body.error?.details).toMatchObject({ reason: 'owed_changed', message: owedChangedMessage(20) })
      const more = await refund('owed', bookingId, { amount: 20.01, refundMethod: 'credit' })
      expect(more.body.error?.details?.reason).toBe('owed_changed')
      expect((await refund('owed', bookingId, { amount: 20, refundMethod: 'cash' })).body.error?.details?.reason).toBe('refund_method_invalid')
      const given = await refund('owed', bookingId, { amount: 20.004, refundMethod: 'credit' })
      expect(given.body.data).toMatchObject({ storeCreditRefundedAmount: 20, pricePaid: 20 })
      expect(await booking(bookingId)).toMatchObject({ price_paid: '20.00', part_refunded_amount: '20.00', refund_owed_amount: '0.00' })
      expect((await storeCredit())[0]?.note).toMatch(/^Refund the rest of a failed booking refund\. \[ref /)
      expect((await auditRows('booking.refund_owed'))[0]?.details).toEqual({ amount: 20, method: 'credit', cardRefunded: 0, storeCreditRefunded: 20, owed: 0 })
      const nothing = await refund('owed', bookingId, { amount: 20, refundMethod: 'credit' })
      expect(nothing.body.error?.details).toMatchObject({ reason: 'nothing_owed', message: REFUND_WORDS.nothingOwed })
    })
  })

  it('Refund the rest to the card: the first part refused puts it back as owed', async () => {
    await onABooking(async ({ bookingId, stripe }) => {
      await withTwentyOwed(stripe, bookingId)
      stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
      const refused = await refund('owed', bookingId, { amount: 20, refundMethod: 'card' })
      expect(refused.body.error?.details?.reason).toBe('refund_failed')
      expect(await booking(bookingId)).toMatchObject({ price_paid: '40.00', refund_owed_amount: '20.00' })
      expect((await auditRows('booking.refund_finished')).at(-1)?.details).toMatchObject({ outcome: 'owed', owed: 20 })
    })
  })

  it('It already arrived: off the booking, no money moves, a reason required, the amount checked', async () => {
    await onABooking(async ({ bookingId, stripe }) => {
      await withTwentyOwed(stripe, bookingId)
      const sent = stripe.calls.length
      expect((await refund('arrived', bookingId, { amount: 20, reason: '' })).body.error?.message).toBe('A reason is required for this.')
      expect((await refund('arrived', bookingId, { amount: 21, reason: 'Seen in Stripe' })).body.error?.details?.reason).toBe('owed_changed')
      // Moves no money: not gated by the switch.
      const done = await refund('arrived', bookingId, { amount: 20, reason: 'Seen in Stripe' }, { orderSwitch: '' })
      expect(done.body.data).toEqual({ cardRefundedAmount: 0, storeCreditRefundedAmount: 0, pricePaid: 20 })
      expect(stripe.calls.length).toBe(sent)
      expect(await booking(bookingId)).toMatchObject({ price_paid: '20.00', refund_owed_amount: '0.00' })
      expect((await auditRows('booking.refund_owed_arrived'))[0]?.details).toEqual({ amount: 20, reason: 'Seen in Stripe' })
    })
  })
})

describe("Refund the rest after the old screens' card refund got no clear answer (the old 24-hour look-up's job)", () => {
  /** What old Move, Remove Guest or Cancel & Refund leave: £20 owed, and their note of the card refund with no clear answer. */
  async function oldUnsureOwed(stripe: FakeStripe, bookingId: string, { went }: { went: boolean }) {
    const intent = (await db.query<{ stripe_payment_intent_id: string }>(
      "SELECT o.stripe_payment_intent_id FROM orders o JOIN order_line_items l ON l.order_id = o.id WHERE l.booking_id = $1 AND l.item_type = 'booking' ORDER BY l.created_at LIMIT 1",
      [bookingId]
    ))[0]?.stripe_payment_intent_id as string
    const key = `booking-refund:old-line:4000:0:2000:0`
    if (went) await stripe.refunds.create({ payment_intent: intent, amount: 2000, metadata: { refund_key: key } }, { idempotencyKey: key })
    await db.query('UPDATE bookings SET refund_owed_amount = 20 WHERE id = $1', [bookingId])
    await db.query(
      "INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, details) VALUES ('staff', $1, 'booking.card_refund_unsure', 'booking', $2, $3::jsonb)",
      [ID.staff, bookingId, JSON.stringify({ key, paymentIntentId: intent, amount: 20 })]
    )
  }

  it('it went: Refund the rest finds it by its old key and records it as the card refund; nothing is sent again', async () => {
    await onABooking(async ({ bookingId, stripe }) => {
      await oldUnsureOwed(stripe, bookingId, { went: true })
      const before = refundCalls(stripe).length
      const answer = await refund('owed', bookingId, { amount: 20, refundMethod: 'card' })
      expect(answer.body.data).toMatchObject({ cardRefundedAmount: 20, storeCreditRefundedAmount: 0, pricePaid: 20 })
      expect(refundCalls(stripe)).toHaveLength(before)
      expect((await bookingLines(bookingId)).map((line) => line.card_refunded_amount)).toEqual(['20'])
      expect(await booking(bookingId)).toMatchObject({ refund_owed_amount: '0.00' })
    })
  })

  it('it never went: Refund the rest sends it, under its own claim key', async () => {
    await onABooking(async ({ bookingId, stripe }) => {
      await oldUnsureOwed(stripe, bookingId, { went: false })
      const answer = await refund('owed', bookingId, { amount: 20, refundMethod: 'card' })
      expect(answer.body.data).toMatchObject({ cardRefundedAmount: 20 })
      expect(refundCalls(stripe).at(-1)?.idempotencyKey).toMatch(/:refund:/)
    })
  })

  it("Stripe can't be asked: nothing is sent, the claim is put back (still owed), and staff try again", async () => {
    await onABooking(async ({ bookingId, stripe }) => {
      await oldUnsureOwed(stripe, bookingId, { went: true })
      stripe.failNext('refunds.list', { kind: 'error', error: fakeStripeErrors.server() })
      const before = refundCalls(stripe).length
      const answer = await refund('owed', bookingId, { amount: 20, refundMethod: 'card' })
      expect(answer.body.error?.details).toMatchObject({ reason: 'refund_check_failed' })
      expect(refundCalls(stripe)).toHaveLength(before)
      expect(await booking(bookingId)).toMatchObject({ price_paid: '40.00', refund_owed_amount: '20.00' })
    })
  })

  /**
   * W21a: several old refunds with no clear answer on the booking's first order (PaymentIntent X), each that went or
   * not, and `extra` owed besides (money a Worker refund put back as owed): owed is their total.
   */
  async function oldUnsureNotes(stripe: FakeStripe, bookingId: string, notes: Array<{ amount: number; went: boolean }>, extra = 0) {
    const intent = (await db.query<{ stripe_payment_intent_id: string }>(
      "SELECT o.stripe_payment_intent_id FROM orders o JOIN order_line_items l ON l.order_id = o.id WHERE l.booking_id = $1 AND l.item_type = 'booking' ORDER BY l.created_at LIMIT 1",
      [bookingId]
    ))[0]?.stripe_payment_intent_id as string
    for (const [index, note] of notes.entries()) {
      const key = `booking-refund:old-line:${index}:${note.amount * 100}`
      if (note.went) await stripe.refunds.create({ payment_intent: intent, amount: note.amount * 100, metadata: { refund_key: key } }, { idempotencyKey: key })
      await db.query(
        "INSERT INTO audit_log (at, actor_type, actor_id, action, entity_type, entity_id, details) VALUES (clock_timestamp() + $1::int * interval '1 millisecond', 'staff', $2, 'booking.card_refund_unsure', 'booking', $3, $4::jsonb)",
        [index, ID.staff, bookingId, JSON.stringify({ key, paymentIntentId: intent, amount: note.amount })]
      )
    }
    const owed = notes.reduce((total, note) => total + note.amount, extra)
    await db.query('UPDATE bookings SET refund_owed_amount = $1 WHERE id = $2', [owed, bookingId])
    return intent
  }
  const refundsOn = (stripe: FakeStripe, intent: string) => stripe.refundsSent.filter((made) => made.payment_intent === intent && made.status !== 'failed').map((made) => made.amount)

  it("W21a (review L1): the review's £200 example: £40 and £20 old refunds went on X, £60 owed planned as one £60 part on X: nothing sent", async () => {
    await onABooking(
      async ({ bookingId, stripe }) => {
        const x = await oldUnsureNotes(stripe, bookingId, [
          { amount: 40, went: true },
          { amount: 20, went: true },
        ])
        const before = refundCalls(stripe).length
        const answer = await refund('owed', bookingId, { amount: 60, refundMethod: 'card' })
        expect(answer.status).toBe(409)
        expect(answer.body.error?.details).toMatchObject({ reason: 'refund_check_failed', message: oldRefundReachedCustomerMessage([40, 20]) })
        expect(answer.body.error?.message).toBe('Earlier card refunds of £40.00 and £20.00 on this booking reached the customer, so nothing was refunded. Check Stripe, then use It already arrived for what arrived.')
        // Nothing sent (the customer has £60 back, not £120), nothing claimed, the booking as it was.
        expect(refundCalls(stripe)).toHaveLength(before)
        expect(refundsOn(stripe, x)).toEqual([4000, 2000])
        expect(await auditRows(REFUND_CLAIMED)).toEqual([])
        expect(await booking(bookingId)).toMatchObject({ price_paid: '200.00', refund_owed_amount: '60.00' })
        // Every page is looked through: the look-up is a list of X, a read with no key.
        const looks = stripe.calls.filter((call) => call.method === 'refunds.list')
        expect(looks.map((call) => [call.params, call.idempotencyKey])).toEqual([[{ payment_intent: x, limit: 100 }, null]])
        // Staff check Stripe and use It already arrived.
        const arrived = await refund('arrived', bookingId, { amount: 60, reason: 'Both seen in Stripe' })
        expect(arrived.body.data).toMatchObject({ cardRefundedAmount: 0, pricePaid: 140 })
        expect(await booking(bookingId)).toMatchObject({ refund_owed_amount: '0.00' })
      },
      { privatePrice: 200 }
    )
  })

  it('W21a (review L1): one old refund that went and one Worker refund Stripe never got (£40 + £20 owed): nothing sent', async () => {
    await onABooking(
      async ({ bookingId, stripe }) => {
        const x = await oldUnsureNotes(stripe, bookingId, [{ amount: 40, went: true }], 20)
        const answer = await refund('owed', bookingId, { amount: 60, refundMethod: 'card' })
        expect(answer.body.error?.details).toMatchObject({ reason: 'refund_check_failed', message: oldRefundReachedCustomerMessage([40]) })
        expect(answer.body.error?.message).toBe('An earlier card refund of £40.00 on this booking reached the customer, so nothing was refunded. Check Stripe, then use It already arrived for what arrived.')
        expect(refundsOn(stripe, x)).toEqual([4000])
        expect(await booking(bookingId)).toMatchObject({ price_paid: '200.00', refund_owed_amount: '60.00' })
      },
      { privatePrice: 200 }
    )
  })

  it('W21a: the look-up pages through every refund on X (more than one page), as reconcile does', async () => {
    await onABooking(
      async ({ bookingId, stripe }) => {
        // The old £20 that went, then 100 more refunds of 1p on X (newer, so they come first): the old one is on page 2.
        const x = await oldUnsureNotes(stripe, bookingId, [{ amount: 20, went: true }])
        for (let n = 0; n < 100; n += 1) await stripe.refunds.create({ payment_intent: x, amount: 1 }, { idempotencyKey: `penny-${n}` })
        const before = refundCalls(stripe).length
        const answer = await refund('owed', bookingId, { amount: 20, refundMethod: 'card' })
        expect(answer.body.data).toMatchObject({ cardRefundedAmount: 20, storeCreditRefundedAmount: 0 })
        expect(refundCalls(stripe)).toHaveLength(before)
        expect(stripe.calls.filter((call) => call.method === 'refunds.list')).toHaveLength(2)
      },
      { privatePrice: 200 }
    )
  })

  it('W21a: an old note written while Stripe was being asked: R1 sees the notes changed, nothing is sent or claimed, try again', async () => {
    await onABooking(
      async ({ bookingId, stripe }) => {
        const x = await oldUnsureNotes(stripe, bookingId, [{ amount: 20, went: true }])
        const list = stripe.refunds.list.bind(stripe.refunds)
        const late = vi.spyOn(stripe.refunds, 'list').mockImplementationOnce(async (...args: Parameters<typeof list>) => {
          const listed = await list(...args)
          await db.query(
            "INSERT INTO audit_log (at, actor_type, actor_id, action, entity_type, entity_id, details) VALUES (clock_timestamp() + interval '1 second', 'staff', $1, 'booking.card_refund_unsure', 'booking', $2, $3::jsonb)",
            [ID.staff, bookingId, JSON.stringify({ key: 'booking-refund:old-line:late', paymentIntentId: x, amount: 5 })]
          )
          return listed
        })
        const before = refundCalls(stripe).length
        const answer = await refund('owed', bookingId, { amount: 20, refundMethod: 'card' })
        late.mockRestore()
        expect(answer.body.error?.details).toMatchObject({ reason: 'refund_check_failed', message: REFUND_CHECK_FAILED_MESSAGE })
        expect(refundCalls(stripe)).toHaveLength(before)
        expect(await auditRows(REFUND_CLAIMED)).toEqual([])
        expect(await booking(bookingId)).toMatchObject({ refund_owed_amount: '20.00' })
      },
      { privatePrice: 200 }
    )
  })

  it("W21a (review L2): a part matched to an old refund is stored on the claim; the other part held, reconcile counts it gone: no £40 twice", async () => {
    await onABooking(
      async ({ bookingId, stripe }) => {
        // £60 owed: the old £40 on X (the first order) went, and £20 more. The plan: Bea's £20 on Y (newer), then £40 on X.
        const x = await oldUnsureNotes(stripe, bookingId, [{ amount: 40, went: true }], 20)
        stripe.failNext('refunds.create', { kind: 'lost_response' })
        stripe.failNext('refunds.create', { kind: 'lost_response' })
        const answer = await refund('owed', bookingId, { amount: 60, refundMethod: 'card' })
        expect(answer.body.data?.held).toMatchObject({ reason: 'refund_unconfirmed' })
        const claim = await readClaim(db, answer.body.data?.held?.claimId ?? '')
        const xOrder = (await bookingLines(bookingId))[0]?.order_id
        const oldRefund = stripe.refundsSent.find((made) => made.payment_intent === x)?.id
        expect(claim?.details.plan.card.map((part) => part.amount)).toEqual([20, 40])
        expect(claim?.details.matched).toEqual([{ orderId: xOrder, refundId: oldRefund }])
        // Only Y's £20 was sent.
        expect(refundCalls(stripe).filter((call) => call.idempotencyKey?.includes(':refund:')).map((call) => (call.params as { amount: number }).amount)).toEqual([2000, 2000])
        pastTheWindow()
        expect((await runReconcile()).items.filter((item) => item.kind === 'claim')).toMatchObject([{ outcome: 'finalised' }])
        // Reconcile found Y's £20 and counted X's £40 as gone: nothing owed, so nothing for Refund the rest to send again.
        expect((await auditRows('booking.refund_finished'))[0]?.details).toMatchObject({ outcome: 'given', cardRefunded: 60, owed: 0, by: { how: 'reconcile' } })
        expect(await booking(bookingId)).toMatchObject({ price_paid: '0.00', refund_owed_amount: '0.00' })
        expect((await bookingLines(bookingId)).map((line) => line.card_refunded_amount)).toEqual(['40', '20'])
        expect((await refund('owed', bookingId, { amount: 40, refundMethod: 'card' })).body.error?.details?.reason).toBe('nothing_owed')
        expect(refundsOn(stripe, x)).toEqual([4000])
      },
      { guests: 1 }
    )
  })

  it('W21a (review L2): a held claim with a matched part closed by hand: only the part never sent is owed; X never gets £40 twice', async () => {
    await onABooking(
      async ({ bookingId, stripe }) => {
        const x = await oldUnsureNotes(stripe, bookingId, [{ amount: 40, went: true }], 20)
        stripe.failNext('refunds.create', { kind: 'unreachable' })
        stripe.failNext('refunds.create', { kind: 'unreachable' })
        const claimId = (await refund('owed', bookingId, { amount: 60, refundMethod: 'card' })).body.data?.held?.claimId ?? ''
        // Left for a person (the claim's mode isn't the key's), then closed.
        await db.query("UPDATE audit_log SET details = jsonb_set(details, '{livemode}', 'true') WHERE id = $1", [claimId])
        pastTheWindow()
        expect((await runReconcile()).items.filter((item) => item.kind === 'claim')).toMatchObject([{ outcome: 'left', reason: 'other_mode' }])
        expect((await close('held_claim', claimId)).body.data).toMatchObject({ closed: true })
        expect((await auditRows('booking.refund_finished'))[0]?.details).toMatchObject({ outcome: 'owed', cardRefunded: 40, owed: 20, by: { how: 'close' } })
        expect(await booking(bookingId)).toMatchObject({ price_paid: '20.00', refund_owed_amount: '20.00' })
        // Refund the rest sends the £20 to Bea's order; X never gets its £40 again.
        const rest = await refund('owed', bookingId, { amount: 20, refundMethod: 'card' })
        expect(rest.body.data).toMatchObject({ cardRefundedAmount: 20, pricePaid: 0 })
        expect(refundsOn(stripe, x)).toEqual([4000])
        expect((await bookingLines(bookingId)).map((line) => line.card_refunded_amount)).toEqual(['40', '20'])
      },
      { guests: 1 }
    )
  })

  it('a note already dealt with (It already arrived since) is not looked for again', async () => {
    await onABooking(async ({ bookingId, stripe }) => {
      await oldUnsureOwed(stripe, bookingId, { went: true })
      await refund('arrived', bookingId, { amount: 20, reason: 'Seen in Stripe' })
      // New money owed later (a Worker refund Stripe never got): sent, not taken for the old one.
      await db.query('UPDATE bookings SET price_paid = price_paid + 20, refund_owed_amount = 20 WHERE id = $1', [bookingId])
      const before = stripe.calls.filter((call) => call.method === 'refunds.list').length
      const answer = await refund('owed', bookingId, { amount: 20, refundMethod: 'card' })
      expect(answer.body.data).toMatchObject({ cardRefundedAmount: 20 })
      expect(stripe.calls.filter((call) => call.method === 'refunds.list')).toHaveLength(before)
    })
  })
})

describe('the figures route (W21)', () => {
  it('answers the old figures field for field, with cashLeft and the line of what is left to refund (W21a)', async () => {
    await onABooking(
      async ({ bookingId }) => {
        const answer = await figures(bookingId)
        const old = await loadBookingMoneyLeft(db, bookingId)
        expect(answer.body.data).toEqual({ ...old, cashLeft: 0, paidLine: 'Left to refund: £60.00 card money.' })
        expect((await figures(crypto.randomUUID())).body.error).toMatchObject({ code: 'NOT_FOUND', message: 'Booking not found.' })
      },
      { guests: 1 }
    )
  })

  it("W21a (review S1): the line says what is left to refund, not what was paid: £25 left after a £15 part refund, then nothing", async () => {
    await onABooking(async ({ bookingId }) => {
      expect((await figures(bookingId)).body.data?.['paidLine']).toBe('Left to refund: £40.00 card money.')
      await refund('part', bookingId, { amount: 15, refundMethod: 'card', reason: 'Goodwill' })
      expect((await figures(bookingId)).body.data?.['paidLine']).toBe('Left to refund: £25.00 card money.')
      await refund('part', bookingId, { amount: 25, refundMethod: 'card', reason: 'Goodwill' })
      expect((await figures(bookingId)).body.data?.['paidLine']).toBe('Nothing left to refund.')
    })
  })

  it("a guest's store-credit-only own order (payment_method null, W20) is never read as card money", async () => {
    await onABooking(
      async ({ bookingId, stripe }) => {
        const own = await db.query<{ payment_method: string | null; stripe_payment_intent_id: string | null }>(
          "SELECT o.payment_method, o.stripe_payment_intent_id FROM orders o JOIN order_line_items l ON l.order_id = o.id WHERE l.booking_id = $1 AND l.item_type = 'booking' ORDER BY l.created_at DESC LIMIT 1",
          [bookingId]
        )
        expect(own[0]).toEqual({ payment_method: null, stripe_payment_intent_id: null })
        const answer = await figures(bookingId)
        expect(answer.body.data).toMatchObject({ left: 60, cardLeft: 40, cashLeft: 0, parts: { card: 40, storeCredit: 20 } })
        expect(answer.body.data?.['paidLine']).toBe('Left to refund: £40.00 card money and £20.00 gift card / store credit.')
        const over = await refund('part', bookingId, { amount: 40.01, refundMethod: 'card', reason: 'x' })
        expect(over.body.error?.details).toMatchObject({ reason: 'more_than_card_left', message: onlyCardLeftMessage(40) })
        // £40 to the card goes only to the first order's card; nothing is sent against the store credit order.
        await refund('part', bookingId, { amount: 40, refundMethod: 'card', reason: 'x' })
        expect(refundCalls(stripe).map((call) => (call.params as { amount: number }).amount)).toEqual([4000])
      },
      { guests: 1, guestPayment: { storeCredit: { amount: 20 } } }
    )
  })
})

describe('held claims and flows closed by hand (W21, W19 review later 1)', () => {
  it('a held claim in the other Stripe mode: left for a person, then closed: its card money owed on the booking', async () => {
    await onABooking(
      async ({ bookingId, stripe }) => {
        stripe.failNext('refunds.create', { kind: 'unreachable' })
        stripe.failNext('refunds.create', { kind: 'unreachable' })
        const held = await refund('part', bookingId, { amount: 20, refundMethod: 'card', reason: 'Goodwill' })
        const claimId = held.body.data?.held?.claimId ?? ''
        // Not left for a person yet: the close refuses.
        expect((await close('held_claim', claimId)).body.data).toMatchObject({ closed: false, reason: 'claim_not_left_for_a_person' })
        // Left for the next run (Stripe didn't answer the list): still not a person's, still refused.
        pastTheWindow()
        stripe.failNext('refunds.list', { kind: 'error', error: fakeStripeErrors.server() })
        expect((await runReconcile()).items.filter((item) => item.kind === 'claim')).toMatchObject([{ outcome: 'left', reason: 'unclear' }])
        expect((await close('held_claim', claimId)).body.data).toMatchObject({ closed: false, reason: 'claim_not_left_for_a_person' })
        // The next scheduled run, five minutes on. The claim was made with a live key; the key now is test.
        vi.setSystemTime(Date.now() + 5 * 60_000)
        await db.query("UPDATE audit_log SET details = jsonb_set(details, '{livemode}', 'true') WHERE id = $1", [claimId])
        pastTheWindow()
        const run = await runReconcile()
        expect(run.items.filter((item) => item.kind === 'claim')).toMatchObject([{ outcome: 'left', reason: 'other_mode' }])
        const listed = (await stuckList(db)).claims[0]
        expect(listed).toMatchObject({ reason: 'other_mode', close: { kind: 'held_claim', orderId: claimId } })
        const closed = await close('held_claim', claimId)
        expect(closed.body.data).toMatchObject({ closed: true, kind: 'held_claim' })
        expect(await booking(bookingId)).toMatchObject({ price_paid: '60.00', refund_owed_amount: '20.00' })
        expect((await auditRows('booking.refund_finished'))[0]?.details).toMatchObject({ outcome: 'owed', owed: 20, by: { how: 'close', why: 'Checked in Stripe by hand' } })
        // Closed once: a second press says so; reconcile leaves it.
        expect((await close('held_claim', claimId)).body.data).toMatchObject({ closed: true, alreadyClosed: true })
        expect((await runReconcile()).items.filter((item) => item.kind === 'claim')).toEqual([])
        expect((await stuckList(db)).claims).toEqual([])
        const claim = await readClaim(db, claimId)
        expect(claim?.details.plan.card).toHaveLength(1)
      },
      { guests: 1 }
    )
  })

  it('a held card flow with two payments: left for a person, then closed: undone, the payments named for a person', async () => {
    await replay(
      environment,
      {
        name: 'w21 held flow',
        seed,
        async run(context) {
          replayStripe.current = context.stripe
          try {
            const { lapsedSeat } = await import('@/server/rules/testing/replay/scenarios')
            const bookingId = await lapsedSeat(context.call, context.db)
            const { settleBooking } = await import('./settle')
            context.stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
            context.stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
            const before = process.env.ORDER_SWITCH
            process.env.ORDER_SWITCH = BOOKING_KINDS_ON
            let pendingId = ''
            try {
              await settleBooking(db, bookingId, { payment: { method: 'card' }, figures: { amountDue: 20, toCollect: 20 } }, {
                actor: { type: 'staff', id: ID.staff },
                requestId: crypto.randomUUID(),
                stripe: () => context.stripe,
              }).catch((err: { details?: { pendingId?: string } }) => {
                pendingId = err.details?.pendingId ?? ''
              })
            } finally {
              if (before === undefined) delete process.env.ORDER_SWITCH
              else process.env.ORDER_SWITCH = before
            }
            expect(pendingId).not.toBe('')
            // Two succeeded payments naming the one record (can't happen under one key; coded for).
            const row = await readFlow(db, pendingId)
            for (let i = 0; i < 2; i += 1) {
              await context.stripe.paymentIntents.create({
                amount: 2000,
                currency: 'gbp',
                customer: 'cus_member',
                payment_method: 'pm_member',
                off_session: true,
                confirm: true,
                metadata: { flow: 'settle', record_id: row?.record_id ?? '', pending_id: pendingId },
              })
            }
            // Not left for a person yet: the close refuses, and nothing changes.
            expect((await close('held_flow', pendingId)).body.data).toMatchObject({ closed: false, reason: 'flow_not_left_for_a_person' })
            pastTheWindow()
            // Left for the next run (Stripe didn't answer the list): still not a person's.
            context.stripe.failNext('paymentIntents.list', { kind: 'error', error: fakeStripeErrors.server() })
            expect((await runReconcile()).items.filter((item) => item.kind === 'flow')).toMatchObject([{ outcome: 'left', reason: 'unclear' }])
            expect((await close('held_flow', pendingId)).body.data).toMatchObject({ closed: false, reason: 'flow_not_left_for_a_person' })
            // The next scheduled run, five minutes on.
            vi.setSystemTime(Date.now() + 5 * 60_000)
            const run = await runReconcile()
            expect(run.items.filter((item) => item.kind === 'flow')).toMatchObject([{ outcome: 'left', reason: 'several_payments' }])
            const flow = (await stuckList(db)).flows[0]
            expect(flow).toMatchObject({ reason: 'several_payments', close: { kind: 'held_flow', orderId: pendingId } })
            const closed = await close('held_flow', pendingId)
            expect(closed.body.data).toMatchObject({ closed: true, kind: 'held_flow' })
            expect((closed.body.data?.['leftAsFound'] as string[])[0]).toMatch(/refund it there by hand/)
            expect((await readFlow(db, pendingId))?.status).toBe('cancelled')
            const settled = (await db.query<{ status: string }>('SELECT status FROM bookings WHERE id = $1', [bookingId]))[0]
            expect(settled?.status).toBe('payment_needed')
            expect((await close('held_flow', pendingId)).body.data).toMatchObject({ closed: true, alreadyClosed: true })
          } finally {
            replayStripe.current = null
          }
        },
      },
      oldSide
    )
  })
})

describe('the stuck list and R1 against a held claim', () => {
  it('a cash booking cancelled while its claim is held: what Stripe never got goes to store credit (no button left for owed)', async () => {
    await onABooking(
      async ({ bookingId, stripe }) => {
        stripe.failNext('refunds.create', { kind: 'unreachable' })
        stripe.failNext('refunds.create', { kind: 'unreachable' })
        await refund('part', bookingId, { amount: 20, refundMethod: 'card', reason: 'Goodwill' })
        await db.query("UPDATE bookings SET status = 'cancelled' WHERE id = $1", [bookingId])
        pastTheWindow()
        await runReconcile()
        expect(await booking(bookingId)).toMatchObject({ refund_owed_amount: '0.00' })
        expect((await storeCredit()).map((row) => row.amount)).toEqual(['20.00'])
      },
      { guests: 1 }
    )
  })

  it('onlyCardLeftMessage and onlyCashLeftMessage say the limit', () => {
    expect(onlyCardLeftMessage(12.5)).toBe('Only £12.50 of card money is left on this booking. Check the amount and confirm again.')
    expect(onlyCashLeftMessage(5)).toContain('£5.00')
  })
})
