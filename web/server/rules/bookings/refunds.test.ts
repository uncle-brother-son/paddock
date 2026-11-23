import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { POST as partRoute } from '@/app/api/v1/staff/bookings/[bookingId]/refunds/route'
import { POST as owedRoute } from '@/app/api/v1/staff/bookings/[bookingId]/refunds/owed/route'
import { POST as arrivedRoute } from '@/app/api/v1/staff/bookings/[bookingId]/refunds/owed-arrived/route'
import { GET as figuresRoute } from '@/app/api/v1/staff/bookings/[bookingId]/refund-figures/route'
import { POST as closeRoute } from '@/app/api/v1/staff/orders/stuck/close/route'
import type { Db } from '@/server/db'
import { ORDER_KINDS } from '@/server/rules/orders/order-switch'
import { MANUAL_LIMITS, reconcile } from '@/server/rules/orders/reconcile'
import { CLAIM_WAITING_WORDS, stuckList, WATCH_WORDS } from '@/server/rules/orders/stuck-list'
import { readFlow } from '@/server/rules/orders/reader-flow'
import { CLOSE_WORDS } from '@/server/rules/orders/close-stuck'
import { PAYMENT_WATCH_DAYS, WATCHED_PAYMENT_WORDS } from '@/server/rules/orders/payment-watch'
import { MONEY_OWED_WORDS } from '@/server/rules/refunds/failure-messages'
import { moneyOwedList } from '@/server/rules/refunds/money-owed-list'
import { replay, REPLAY_USER, startReplay, type ReplayEnvironment, type ScenarioContext } from '@/server/rules/testing/sweep/run'
import { workerSide } from '@/server/rules/testing/sweep/worker'
import { asTheOldAddGuestPaidItByStoreCredit } from '@/server/rules/testing/sweep/old-states'
import { insert } from '@/server/rules/testing/database'
import { bea, ID, memberCredit, mo, paidSeat, PROMO, sam, seed, tieredPrivatePrices, whileFailing } from '@/server/rules/testing/replay/scenarios'
import { STRIPE_DEADLINE_MS } from '@/server/stripe/deadline'
import { replayStripe } from '@/server/rules/testing/replay/stripe-binding'
import { BOOKING_KINDS_ON } from '@/server/rules/testing/sweep/booking-presses'
import { fakeStripeErrors, type FakeStripe } from '@/server/stripe/fake'
import {
  BOOKING_PATH_OFF_MESSAGE,
  CHANGE_REFUND_UNCONFIRMED_MESSAGE,
  laterCardRefundNotSentMessage,
  laterCardRefundRefusedMessage,
  putBackFailedMessage,
  NO_CASH_LEFT_MESSAGE,
  onlyCardLeftMessage,
  onlyCashLeftMessage,
  onlyLeftMessage,
  owedChangedMessage,
  REFUND_OPEN_MESSAGE,
  REFUND_WORDS,
  refundGoneNotRecordedMessage,
} from './failure-messages'
import { loadBookingMoneyLeft, loadRefundFigures } from './money-left'
import { WATCH_DAYS, WATCH_READ_HOURS, WATCHES_DUE_SQL, type WatchDue } from '@/server/rules/refunds/refund-watch'
import { checkWatchedRefund } from '@/server/rules/refunds/refund-watch-settle'
import { claimRefundKey, readClaim, REFUND_CLAIMED, type ClaimDetails } from './refunds'

// Brief W21: the refund pipeline (D-plan 4.3, 4.10), Part refund, Refund the rest, It already arrived and the figures,
// on the replay's live schema (its triggers and the store credit function included), through the routes as the staff
// app calls them. The bookings are made through the Worker's routes, as the screens press them (sweep/worker.ts).
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
    workerSide()
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

async function close(kind: 'held_flow' | 'held_claim' | 'refund_watch' | 'payment_watch', id: string): Promise<Answer> {
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
    // W53 (migration 033): trim_scale, so a figure reads the same (`30`) whether the column is plain numeric or numeric(10,2).
    "SELECT order_id, trim_scale(card_refunded_amount)::text AS card_refunded_amount, created_at FROM order_line_items WHERE booking_id = $1 AND item_type = 'booking' ORDER BY created_at",
    [bookingId]
  )
const refundCalls = (stripe: FakeStripe) => stripe.calls.filter((call) => call.method === 'refunds.create')
const auditRows = async (action: string) => db.query<{ id: string; details: Record<string, unknown>; request_id: string | null }>('SELECT id, details, request_id FROM audit_log WHERE action = $1 ORDER BY at, ctid', [action])

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
        // W32: the finished row keeps each card refund's id and status. W32a (lead call 1): each is watched, succeeded too.
        expect(finished?.details).toEqual({
          claimId: claim?.id,
          outcome: 'given',
          cardRefunded: 70,
          storeCreditRefunded: 0,
          owed: 0,
          refunds: stripe.refundsSent.map((sent, index) => ({ orderId: orders[index], paymentIntentId: sent.payment_intent, refundId: sent.id, status: 'succeeded', amount: [20, 20, 30][index] })),
        })
        expect((await auditRows('refund.watch')).map((row) => [row.details['refundId'], row.details['status'], row.details['state']]).sort()).toEqual(
          stripe.refundsSent.map((sent) => [sent.id, 'succeeded', 'watching']).sort()
        )
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

  it("W26a (Wayne, 14 Nov): a later card part refused is never store credit: what went is recorded, the refused £30 is still to refund on the booking with Stripe's reason, reconcile does nothing, and a person gives it with Refund the rest", async () => {
    await onABooking(
      async ({ bookingId, stripe }) => {
        stripe.failNext('refunds.create', { kind: 'none' })
        stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
        const answer = await refund('part', bookingId, { amount: 50, refundMethod: 'card', reason: 'Goodwill' })
        const reason = 'Failed to refund payment: Your card was declined.'
        expect(answer.body.data).toMatchObject({
          cardRefundedAmount: 20,
          storeCreditRefundedAmount: 0,
          pricePaid: 40,
          warning: laterCardRefundRefusedMessage(30, reason, 30, false),
        })
        expect(answer.body.data?.['warning']).toBe(
          'A further card refund of £30.00 was refused (Failed to refund payment: Your card was declined.), so £30.00 shows on the booking as still to refund. Check Stripe first: if the money already reached the customer, use It already arrived; if not, use Refund the rest.'
        )
        expect(await storeCredit()).toEqual([])
        expect(await booking(bookingId)).toMatchObject({ price_paid: '40.00', part_refunded_amount: '50.00', refund_owed_amount: '30.00' })
        expect((await bookingLines(bookingId)).map((line) => line.card_refunded_amount)).toEqual(['0', '20'])
        const finished = await auditRows('booking.refund_finished')
        expect(finished).toHaveLength(1)
        expect(finished[0]?.details).toMatchObject({ outcome: 'owed', cardRefunded: 20, storeCreditRefunded: 0, owed: 30, refused: reason })
        expect((await auditRows('booking.refund_refused')).map((row) => row.details)).toMatchObject([{ amount: 30, detail: reason }])
        // Reconcile does nothing for it.
        const sent = refundCalls(stripe).length
        pastTheWindow()
        expect((await runReconcile()).items.filter((item) => item.kind === 'claim')).toEqual([])
        expect(refundCalls(stripe)).toHaveLength(sent)
        expect(await storeCredit()).toEqual([])
        // A person decides: Refund the rest, here to store credit.
        expect((await refund('owed', bookingId, { amount: 30, refundMethod: 'credit' })).body.data).toMatchObject({ cardRefundedAmount: 0, storeCreditRefundedAmount: 30, pricePaid: 10 })
        expect((await storeCredit()).map((row) => row.amount)).toEqual(['30.00'])
        expect(await booking(bookingId)).toMatchObject({ price_paid: '10.00', refund_owed_amount: '0.00' })
      },
      { guests: 1 }
    )
  })

  it("W26a (audit S2): the first card part refused and the undo fails (a database fault): the £30 ends there and then as still to refund on the booking, with Stripe's reason; reconcile does nothing", async () => {
    await onABooking(
      async ({ bookingId, stripe }) => {
        stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
        const undoFails = { table: 'audit_log', event: 'INSERT', when: "NEW.action = 'booking.refund_finished' AND NEW.details->>'outcome' = 'put_back'" } as const
        const answer = await whileFailing(db, undoFails, () => refund('part', bookingId, { amount: 30, refundMethod: 'card', reason: 'Goodwill' }))
        const reason = 'Failed to refund payment: Your card was declined.'
        expect(answer.status).toBe(200)
        expect(answer.body.data).toMatchObject({ cardRefundedAmount: 0, storeCreditRefundedAmount: 0, held: { reason: 'refund_refused_not_put_back', message: putBackFailedMessage(reason, 30, false) } })
        expect(answer.body.data?.held?.message).toBe(
          "The card refund was refused (Failed to refund payment: Your card was declined.), so it didn't go back to the card, and the booking couldn't be put back as it was. The change stands, and £30.00 shows on the booking as still to refund. Check Stripe first: if the money already reached the customer, use It already arrived; if not, use Refund the rest."
        )
        // W31 (W30a "Noticed" 1): never "nothing went back"; and with no store credit in the plan, none is named.
        expect(answer.body.data?.held?.message).not.toContain('nothing went back')
        expect(answer.body.data?.held?.message).not.toContain('went to store credit')
        expect(await booking(bookingId)).toMatchObject({ price_paid: '60.00', refund_owed_amount: '30.00' })
        expect(await storeCredit()).toEqual([])
        const finished = await auditRows('booking.refund_finished')
        expect(finished).toHaveLength(1)
        expect(finished[0]?.details).toMatchObject({ outcome: 'owed', cardRefunded: 0, owed: 30, by: { how: 'undo_failed', why: reason } })
        const sent = refundCalls(stripe).length
        pastTheWindow()
        expect((await runReconcile()).items.filter((item) => item.kind === 'claim')).toEqual([])
        expect(refundCalls(stripe)).toHaveLength(sent)
        expect(await storeCredit()).toEqual([])
        expect(await booking(bookingId)).toMatchObject({ price_paid: '60.00', refund_owed_amount: '30.00' })
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
        expect(answer.body.data).toMatchObject({ cardRefundedAmount: 20, storeCreditRefundedAmount: 0, pricePaid: 40, warning: laterCardRefundNotSentMessage(30, false) })
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
        // Bea's £20 goes; the first order's £30 is refused, and R2's finished row can't be written (W26a: R2 no longer
        // writes store credit for a refused part, so that write can't be the one that fails).
        stripe.failNext('refunds.create', { kind: 'none' })
        stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
        const finishFails = { table: 'audit_log', event: 'INSERT', when: "NEW.action = 'booking.refund_finished'" } as const
        const answer = await whileFailing(db, finishFails, () => refund('part', bookingId, { amount: 50, refundMethod: 'card', reason: 'Goodwill' }))
        expect(answer.body.data).toMatchObject({ cardRefundedAmount: 20, held: { reason: 'refund_not_recorded', message: refundGoneNotRecordedMessage(20) } })
        // Held: nothing on the lines yet, and no other refund.
        expect((await bookingLines(bookingId)).map((line) => line.card_refunded_amount)).toEqual(['0', '0'])
        pastTheWindow()
        const sent = refundCalls(stripe).length
        await runReconcile()
        expect(refundCalls(stripe)).toHaveLength(sent)
        // Reconcile records the £20 that went; the £30 Stripe refused ends as owed (D-plan 4.10; W26a: from the mark), not resent.
        expect((await auditRows('booking.refund_finished'))[0]?.details).toMatchObject({ outcome: 'owed', cardRefunded: 20, storeCreditRefunded: 0, owed: 30, refused: 'Failed to refund payment: Your card was declined.' })
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
        expect(shown.body.data).toMatchObject({ left: 40, cashLeft: 40, paidLine: 'Left to refund: £40.00 cash.', paidWords: 'Paid £40.00 in cash.' })
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
      // W68a: each way the money can go back.
      for (const refundMethod of ['card', 'credit', 'cash']) {
        const off = await refund('part', bookingId, { amount: 5, refundMethod, reason: 'x' }, { orderSwitch: 'no_stripe,saved_card' })
        expect(off.body.error, refundMethod).toMatchObject({ code: 'BOOKING_PATH_OFF', message: BOOKING_PATH_OFF_MESSAGE })
      }
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

describe("a booking line's refundable seat money leaves out its promo (W70a, the W70 audit's S1 e)", () => {
  /**
   * A £100 private hire with 10% off (£90) and a soap (£10.80) on one order, then a guest into the £150 tier (£50) on an
   * order of their own. The booking's money is £140; the soap's £10.80 is the order's, never the booking's.
   */
  async function onAPromoBooking(payment: Record<string, unknown>, guestPayment: Record<string, unknown>, work: (context: Context & { orderId: string; guestOrderId: string | undefined }) => Promise<void>): Promise<void> {
    await replay(
      environment,
      {
        name: 'w70a promo refunds',
        async seed(seedDb, stripe) {
          await seed(seedDb, stripe)
          await tieredPrivatePrices(seedDb)
        },
        async run(context) {
          replayStripe.current = context.stripe
          try {
            const placed = (await context.call('createOrder', {
              customerId: ID.customer,
              booking: { ...paidSeat([sam, { name: 'Alex Guest', email: 'alex@example.com' }]), sessionId: ID.privateSession },
              products: [{ productVariantId: ID.variant, quantity: 1 }],
              promoCode: PROMO.percent,
              payment,
            })) as { bookingId: string; orderId: string }
            const { bookingId, orderId } = placed
            vi.setSystemTime(Date.now() + 1000)
            await context.call('addBookingGuest', { bookingId, ...bea })
            await context.call('addBookingGuest', { bookingId, ...bea, payment: guestPayment })
            vi.setSystemTime(Date.now() + 1000)
            expect(await booking(bookingId)).toMatchObject({ price_paid: '140.00' })
            const guestOrderId = (await bookingLines(bookingId)).map((line) => line.order_id).find((id) => id !== orderId)
            await work({ ...context, bookingId, orderId, guestOrderId })
          } finally {
            replayStripe.current = null
          }
        },
      },
      workerSide()
    )
  }
  const sentParts = (stripe: FakeStripe) => stripe.refundsSent.map((sent) => [sent.payment_intent, sent.amount])
  const intentOf = async (orderId: string | undefined) => (await db.query<{ pi: string | null }>('SELECT stripe_payment_intent_id AS pi FROM orders WHERE id = $1', [orderId ?? null]))[0]?.pi
  const CASH = (amount: number) => ({ method: 'cash', confirmedCashAmount: amount })

  it('both on the card: £140 goes back in two parts, the guest\'s £50 to their order and £90 to the first; the soap\'s £10.80 stays', async () => {
    await onAPromoBooking({ method: 'card' }, { method: 'card' }, async ({ bookingId, orderId, guestOrderId, stripe }) => {
      expect((await figures(bookingId)).body.data).toMatchObject({ left: 140, cardLeft: 140, parts: { card: 140, giftCard: 0, storeCredit: 0, cash: 0 } })
      const answer = await refund('part', bookingId, { amount: 140, refundMethod: 'card', reason: 'Goodwill' })
      expect(answer.body.data).toMatchObject({ cardRefundedAmount: 140, storeCreditRefundedAmount: 0, pricePaid: 0 })
      expect(sentParts(stripe)).toEqual([[await intentOf(guestOrderId), 5000], [await intentOf(orderId), 9000]])
    })
  })

  it('the guest in cash: the card can take back the £90 it paid for the booking, never the £100 of the list price (the other £10 is the soap\'s); then nothing more', async () => {
    await onAPromoBooking({ method: 'card' }, CASH(50), async ({ bookingId, orderId, call, stripe }) => {
      expect((await figures(bookingId)).body.data).toMatchObject({ left: 140, cardLeft: 90, parts: { card: 90, cash: 50 } })
      const tooMuch = await refund('part', bookingId, { amount: 100, refundMethod: 'card', reason: 'Goodwill' })
      expect(tooMuch.body.ok).toBe(false)
      expect(refundCalls(stripe)).toEqual([])
      const answer = await refund('part', bookingId, { amount: 90, refundMethod: 'card', reason: 'Goodwill' })
      expect(answer.body.data).toMatchObject({ cardRefundedAmount: 90, storeCreditRefundedAmount: 0, pricePaid: 50 })
      expect((await figures(bookingId)).body.data).toMatchObject({ left: 50, cardLeft: 0, parts: { card: 0, cash: 50 } })
      // Cancel & Refund: the £50 of cash is store credit. No line has seat money left, so the soap's £10.80 stays on the card.
      expect(await call('refundBooking', { bookingId, refundMethod: 'card' })).toMatchObject({ cardRefundedAmount: 0, storeCreditRefundedAmount: 50 })
      expect(sentParts(stripe)).toEqual([[await intentOf(orderId), 9000]])
    })
  })

  it('all in cash, the guest on the card: the cash that can be handed back is the £90 paid for the booking, not £100', async () => {
    await onAPromoBooking(CASH(100.8), { method: 'card' }, async ({ bookingId }) => {
      expect((await figures(bookingId)).body.data).toMatchObject({ left: 140, cardLeft: 50, cashLeft: 90, parts: { card: 50, cash: 90 } })
      const tooMuch = await refund('part', bookingId, { amount: 100, refundMethod: 'cash', reason: 'Goodwill' })
      expect(tooMuch.body.ok).toBe(false)
      expect((await refund('part', bookingId, { amount: 90, refundMethod: 'cash', reason: 'Goodwill' })).body.ok).toBe(true)
      expect((await figures(bookingId)).body.data).toMatchObject({ left: 50, cashLeft: 0 })
    })
  })

  it('cash handed back for a promo guest is the £18 they paid, not their £20 seat, with cash on the booking no order records (a Settle\'s £20)', async () => {
    await replay(
      environment,
      {
        name: 'w70a promo cash',
        seed,
        async run(context) {
          replayStripe.current = context.stripe
          try {
            // Mo's seat on a credit, Alex's £20 seat with 10% off, and a soap, all the money in cash (£18 + £10.80).
            const { bookingId } = (await context.call('createOrder', {
              customerId: ID.member,
              booking: { ...paidSeat([mo, { name: 'Alex Guest', email: 'alex@example.com' }]), ...memberCredit },
              products: [{ productVariantId: ID.variant, quantity: 1 }],
              promoCode: PROMO.percent,
              payment: CASH(28.8),
            })) as { bookingId: string }
            await db.query("UPDATE bookings SET status = 'payment_needed', payment_due_by = now() + interval '1 day' WHERE id = $1", [bookingId])
            await context.call('settleLapsedBooking', { bookingId, payment: CASH(20) })
            expect(await booking(bookingId)).toMatchObject({ price_paid: '38.00' })
            // Q36: the Settle's £20 is on no order, so only the £18 can be handed back as cash (the rest as store credit).
            expect((await figures(bookingId)).body.data).toMatchObject({ left: 38, cashLeft: 18, parts: { card: 0, cash: 38 } })
            expect((await refund('part', bookingId, { amount: 20, refundMethod: 'cash', reason: 'Goodwill' })).body.ok).toBe(false)
            expect((await refund('part', bookingId, { amount: 18, refundMethod: 'cash', reason: 'Goodwill' })).body.ok).toBe(true)
          } finally {
            replayStripe.current = null
          }
        },
      },
      workerSide()
    )
  })

  it('two lines on one order count that order\'s card money once, the promo off each (W05g, two lines on one order)', async () => {
    await onAPromoBooking({ method: 'card' }, CASH(50), async ({ bookingId, orderId }) => {
      // Test data: only an old order can have two booking lines. A second £20 line, £2 of promo, for the same booking.
      await insert(db, 'order_line_items', { order_id: orderId, item_type: 'booking', booking_id: bookingId, quantity: 1, unit_price: '20.00', line_total: '20.00', discount_amount: '2.00' })
      // £90 and £18 of seat money, and only £100.80 of card money on the order.
      expect((await figures(bookingId)).body.data).toMatchObject({ cardLeft: 100.8 })
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
      // W47 item 1: a live booking with money owed is on the "Money still to refund" list, once.
      const listed = await moneyOwedList(db)
      expect(listed.owed).toHaveLength(1)
      expect(listed.owed[0]).toMatchObject({ on: 'booking', bookingId, orderId: null, amount: 20, bookingStatus: 'confirmed', lapsed: false, daysOwed: 0, where: MONEY_OWED_WORDS.booking })
      expect(listed.owed[0]?.owedSince).toEqual(expect.any(String))
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
      // Given: off the list.
      expect((await moneyOwedList(db)).owed).toEqual([])
    })
  })

  it('W68a (W68 review S2): the switch gates Refund the rest: with `booking_changes` off and every other kind on, 501 BOOKING_PATH_OFF in the switched-off words, to the card or to store credit; nothing sent to Stripe, nothing given and still owed', async () => {
    await onABooking(async ({ bookingId, stripe }) => {
      await withTwentyOwed(stripe, bookingId)
      const sent = stripe.calls.length
      const others = ORDER_KINDS.filter((kind) => kind !== 'booking_changes').join(',')
      for (const refundMethod of ['card', 'credit']) {
        const off = await refund('owed', bookingId, { amount: 20, refundMethod }, { orderSwitch: others })
        expect([off.status, off.body.error?.code, off.body.error?.message, off.body.error?.details], refundMethod).toEqual([
          501,
          'BOOKING_PATH_OFF',
          BOOKING_PATH_OFF_MESSAGE,
          { reason: 'booking_path_off', message: BOOKING_PATH_OFF_MESSAGE, kinds: ['booking_changes'] },
        ])
      }
      expect(stripe.calls.slice(sent)).toEqual([])
      expect(await booking(bookingId)).toMatchObject({ price_paid: '40.00', refund_owed_amount: '20.00' })
      expect(await storeCredit()).toEqual([])
      expect(await auditRows('booking.refund_owed')).toEqual([])
      expect((await moneyOwedList(db)).owed).toHaveLength(1)
      // On again: given.
      expect((await refund('owed', bookingId, { amount: 20, refundMethod: 'card' })).body.data).toMatchObject({ cardRefundedAmount: 20 })
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
      const done = await refund('arrived', bookingId, { amount: 20, reason: 'Seen in Stripe', arrivedOn: 'card' }, { orderSwitch: '' })
      expect(done.body.data).toEqual({ cardRefundedAmount: 0, storeCreditRefundedAmount: 0, pricePaid: 20 })
      expect(stripe.calls.length).toBe(sent)
      expect(await booking(bookingId)).toMatchObject({ price_paid: '20.00', refund_owed_amount: '0.00' })
      // W47 item 8 (the W35 audit's row 6), a named difference: staff said it reached the card, so the £20 is
      // recorded on the booking's line as card money, and the row says so (before W47: `{ amount, reason }`, nothing
      // on any line, and the booking's card money left read £20 too high).
      const [line] = await db.query<{ id: string; order_id: string; card: string }>("SELECT id, order_id, card_refunded_amount::numeric(10,2)::text AS card FROM order_line_items WHERE booking_id = $1 AND item_type = 'booking'", [bookingId])
      expect((await auditRows('booking.refund_owed_arrived'))[0]?.details).toEqual({ amount: 20, reason: 'Seen in Stripe', arrivedOn: 'card', card: 20, lines: [{ lineId: line?.id, orderId: line?.order_id, amount: 20 }] })
      expect(line?.card).toBe('20.00')
      expect(await loadRefundFigures(db, bookingId)).toMatchObject({ pricePaid: 20, refundOwed: 0, cardLeft: 20, parts: { card: 20 } })
    })
  })

  it('W28 (audit row 31): It already arrived takes part of what is owed; the rest stays owed, and more than is owed is still refused', async () => {
    await onABooking(async ({ bookingId, stripe }) => {
      await withTwentyOwed(stripe, bookingId)
      const sent = stripe.calls.length
      // £8 of the £20 turns out to be with the customer already (a refund of another amount found in Stripe).
      const part = await refund('arrived', bookingId, { amount: 8, reason: 'Seen in Stripe: £8 of it', arrivedOn: 'card' })
      expect(part.body.data).toEqual({ cardRefundedAmount: 0, storeCreditRefundedAmount: 0, pricePaid: 32 })
      expect(await booking(bookingId)).toMatchObject({ price_paid: '32.00', refund_owed_amount: '12.00' })
      // W47 item 8, a named difference: the £8 is on the line as card money, and the row says so.
      expect((await auditRows('booking.refund_owed_arrived'))[0]?.details).toMatchObject({ amount: 8, reason: 'Seen in Stripe: £8 of it', arrivedOn: 'card', card: 8, lines: [{ amount: 8 }] })
      expect((await db.query<{ card: string }>("SELECT card_refunded_amount::numeric(10,2)::text AS card FROM order_line_items WHERE booking_id = $1 AND item_type = 'booking'", [bookingId]))[0]?.card).toBe('8.00')
      // More than what is left owed: refused with the new figure, nothing changed.
      const over = await refund('arrived', bookingId, { amount: 12.01, reason: 'Seen in Stripe' })
      expect(over.body.error?.details).toMatchObject({ reason: 'owed_changed', message: owedChangedMessage(12) })
      expect(await booking(bookingId)).toMatchObject({ price_paid: '32.00', refund_owed_amount: '12.00' })
      // Refund the rest still gives exactly what is owed, now £12.
      expect((await refund('owed', bookingId, { amount: 20, refundMethod: 'credit' })).body.error?.details?.reason).toBe('owed_changed')
      expect((await refund('owed', bookingId, { amount: 12, refundMethod: 'credit' })).body.data).toMatchObject({ storeCreditRefundedAmount: 12, pricePaid: 20 })
      expect(await booking(bookingId)).toMatchObject({ price_paid: '20.00', refund_owed_amount: '0.00' })
      expect(stripe.calls.length).toBe(sent)
      expect((await refund('arrived', bookingId, { amount: 1, reason: 'Seen in Stripe' })).body.error?.details?.reason).toBe('nothing_owed')
    })
  })
})

describe('the figures route (W21)', () => {
  it('answers the old figures field for field, with cashLeft and the line of what is left to refund (W21a)', async () => {
    await onABooking(
      async ({ bookingId }) => {
        const answer = await figures(bookingId)
        const old = await loadBookingMoneyLeft(db, bookingId)
        expect(answer.body.data).toEqual({ ...old, cashLeft: 0, paidLine: 'Left to refund: £60.00 card money.', paidWords: 'Paid £60.00 by card.' })
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
      // W26a (audit S5): the paid line follows the booking: what is on it now, after the £15 went back.
      expect((await figures(bookingId)).body.data?.['paidWords']).toBe('Paid £25.00 by card.')
      await refund('part', bookingId, { amount: 25, refundMethod: 'card', reason: 'Goodwill' })
      expect((await figures(bookingId)).body.data).toMatchObject({ paidLine: 'Nothing left to refund.', paidWords: 'Nothing was paid.', left: 0 })
    })
  })

  it("a guest's store-credit-only own order (payment_method null, W20) is never read as card money", async () => {
    await onABooking(
      async ({ bookingId, stripe }) => {
        // W64: the guest is added through the Worker, which writes `store_credit` (L9); the order as the old Add Guest wrote it.
        await asTheOldAddGuestPaidItByStoreCredit(db, bookingId)
        const own = await db.query<{ payment_method: string | null; stripe_payment_intent_id: string | null }>(
          "SELECT o.payment_method, o.stripe_payment_intent_id FROM orders o JOIN order_line_items l ON l.order_id = o.id WHERE l.booking_id = $1 AND l.item_type = 'booking' ORDER BY l.created_at DESC LIMIT 1",
          [bookingId]
        )
        expect(own[0]).toEqual({ payment_method: null, stripe_payment_intent_id: null })
        const answer = await figures(bookingId)
        expect(answer.body.data).toMatchObject({ left: 60, cardLeft: 40, cashLeft: 0, parts: { card: 40, storeCredit: 20 } })
        expect(answer.body.data?.['paidLine']).toBe('Left to refund: £40.00 card money and £20.00 gift card / store credit.')
        // W26a (audit S5; Q37): the booking detail's payment line, from the same parts.
        expect(answer.body.data?.['paidWords']).toBe('Paid £40.00 by card and £20.00 by gift card / store credit.')
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
      workerSide()
    )
  })
})

describe('the stuck list and R1 against a held claim', () => {
  it('W26b (Wayne, 14 Nov): a booking cancelled while its Part refund is held: what Stripe never got ends owed on the cancelled booking, never store credit; Refund the rest then gives it once', async () => {
    await onABooking(
      async ({ bookingId, stripe }) => {
        stripe.failNext('refunds.create', { kind: 'unreachable' })
        stripe.failNext('refunds.create', { kind: 'unreachable' })
        await refund('part', bookingId, { amount: 20, refundMethod: 'card', reason: 'Goodwill' })
        const before = await booking(bookingId)
        await db.query("UPDATE bookings SET status = 'cancelled' WHERE id = $1", [bookingId])
        pastTheWindow()
        await runReconcile()
        // Owed alone rises on a cancelled booking (its price_paid stays as R1 left it); no store credit row.
        expect(await booking(bookingId)).toMatchObject({ status: 'cancelled', price_paid: before.price_paid, refund_owed_amount: '20.00' })
        expect(await storeCredit()).toEqual([])
        const finished = await auditRows('booking.refund_finished')
        expect(finished).toHaveLength(1)
        expect(finished[0]?.details).toMatchObject({ outcome: 'owed', cardRefunded: 0, storeCreditRefunded: 0, owed: 20, by: { how: 'reconcile' } })
        expect(finished[0]?.details).not.toHaveProperty('refused')
        // A person decides: Refund the rest (store credit only on a cancelled booking) gives it, once.
        expect((await refund('owed', bookingId, { amount: 20, refundMethod: 'credit' })).body.data).toMatchObject({ cardRefundedAmount: 0, storeCreditRefundedAmount: 20 })
        expect((await storeCredit()).map((row) => row.amount)).toEqual(['20.00'])
        expect(await booking(bookingId)).toMatchObject({ refund_owed_amount: '0.00' })
        expect((await refund('owed', bookingId, { amount: 20, refundMethod: 'credit' })).body.error?.details).toMatchObject({ reason: 'nothing_owed' })
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

// --- Brief W25 item 9: the manual close (W21 review L4, L5)

describe('W25 item 9: the manual close shows per-part findings, and watches a payment still processing', () => {
  it("L4: a held claim with one part gone and one part Stripe shows differently: the close records the part that went and puts only the other one owed, naming each", async () => {
    await onABooking(
      async ({ bookingId, stripe }) => {
        // £50 to the card: part A is Bea's order (£20, sent first), part B the first order (£30). A's answer is lost
        // (Stripe has it), so the claim is held and B is never sent.
        stripe.failNext('refunds.create', { kind: 'lost_response' })
        stripe.failNext('refunds.create', { kind: 'lost_response' })
        const held = await refund('part', bookingId, { amount: 50, refundMethod: 'card', reason: 'Goodwill' })
        const claimId = held.body.data?.held?.claimId ?? ''
        const claim = await readClaim(db, claimId)
        const [partA, partB] = claim?.details.plan.card ?? []
        expect([partA?.amount, partB?.amount]).toEqual([20, 30])
        // By hand in Stripe: a £10 refund naming the claim on B's payment (not the £30 planned).
        await stripe.refunds.create({ payment_intent: partB?.paymentIntentId ?? '', amount: 1000, metadata: { claim_id: claimId } })
        pastTheWindow()
        const run = await runReconcile()
        expect(run.items.filter((item) => item.kind === 'claim')).toMatchObject([{ outcome: 'left', reason: 'refund_mismatch' }])
        // The run's answer carries no findings; its audit row does, for the close.
        expect(run.items.find((item) => item.kind === 'claim')).not.toHaveProperty('record')
        const left = (await db.query<{ details: { parts?: Array<{ orderId: string; found: string }> } }>(
          "SELECT details FROM audit_log WHERE entity_type = 'refund_claim' AND entity_id = $1 AND action = 'order.reconcile' ORDER BY at DESC, ctid DESC LIMIT 1",
          [claimId]
        ))[0]
        expect(left?.details.parts).toMatchObject([
          { orderId: partA?.orderId, amount: 20, found: 'went' },
          { orderId: partB?.orderId, amount: 30, found: 'mismatch' },
        ])

        const closed = await close('held_claim', claimId)
        expect(closed.body.data).toMatchObject({ closed: true, kind: 'held_claim' })
        const givenBack = closed.body.data?.['givenBack'] as string[]
        const leftAsFound = closed.body.data?.['leftAsFound'] as string[]
        expect(givenBack).toEqual([
          `£20.00 to the card on order ${partA?.orderId.slice(0, 8)}: Stripe shows it went, so it is recorded as refunded`,
          '£30.00 back on the booking as money still to refund',
        ])
        expect(leftAsFound[0]).toMatch(new RegExp(`^£30\\.00 to the card on order ${partB?.orderId.slice(0, 8)}: Stripe shows a refund of a different amount`))
        // Only B is owed (£30, not the whole £50), and A's £20 is on its line, so Refund the rest can't plan it again.
        expect(await booking(bookingId)).toMatchObject({ price_paid: '40.00', part_refunded_amount: '50.00', refund_owed_amount: '30.00' })
        const lines = await bookingLines(bookingId)
        expect(lines.find((line) => line.order_id === partA?.orderId)?.card_refunded_amount).toBe('20')
        expect(lines.find((line) => line.order_id === partB?.orderId)?.card_refunded_amount).toBe('0')
        expect((await auditRows('booking.refund_finished'))[0]?.details).toMatchObject({ outcome: 'owed', cardRefunded: 20, owed: 30, by: { how: 'close' } })
        expect((await figures(bookingId)).body.data).toMatchObject({ refundOwed: 30 })
        // The close's own row keeps what was found for each part.
        const closeRow = (await db.query<{ details: { owed: number; parts: Array<{ found: string }> } }>(
          "SELECT details FROM audit_log WHERE action = 'order.close' AND entity_type = 'refund_claim' AND entity_id = $1",
          [claimId]
        ))[0]
        expect(closeRow?.details).toMatchObject({ owed: 30, parts: [{ found: 'went' }, { found: 'mismatch' }] })
      },
      { guests: 1 }
    )
  })

  /** A saved-card Settle held with nothing sent (the charge got no answer), as the "two payments" test sets one up. */
  async function heldCardSettle(context: Parameters<Parameters<typeof replay>[1]['run']>[0]): Promise<{ bookingId: string; pendingId: string }> {
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
    return { bookingId, pendingId }
  }
  const watchRows = (pendingId: string) =>
    db.query<{ action: string; details: Record<string, unknown> }>(
      "SELECT action, details FROM audit_log WHERE entity_type = 'reader_payment' AND entity_id = $1 AND action IN ('reader_payment.payment_watched', 'reader_payment.charge_without_record') ORDER BY at, ctid",
      [pendingId]
    )
  const flowItems = async () => (await runReconcile()).items.filter((item) => item.kind === 'flow' || item.kind === 'refund')

  it('L5: a held card flow closed while its payment is still processing: the payment is watched, and refunded automatically when it lands', async () => {
    await replay(
      environment,
      {
        name: 'w25 watched payment',
        seed,
        async run(context) {
          replayStripe.current = context.stripe
          try {
            const { bookingId, pendingId } = await heldCardSettle(context)
            const row = await readFlow(db, pendingId)
            const processing = await context.stripe.paymentIntents.create({
              amount: 2000,
              currency: 'gbp',
              customer: 'cus_member',
              metadata: { flow: 'settle', record_id: row?.record_id ?? '', pending_id: pendingId },
            })
            context.stripe.markProcessing(processing.id)
            pastTheWindow()
            expect(await flowItems()).toMatchObject([{ kind: 'flow', outcome: 'left', reason: 'payment_processing' }])
            // Under a day: the bank may still finish it, so the close refuses.
            expect((await close('held_flow', pendingId)).body.data).toMatchObject({ closed: false, reason: 'flow_not_left_for_a_person' })
            vi.setSystemTime(Date.now() + 25 * 60 * 60_000)
            const closed = await close('held_flow', pendingId)
            expect(closed.body.data).toMatchObject({ closed: true, kind: 'held_flow' })
            expect((closed.body.data?.['leftAsFound'] as string[])[0]).toMatch(/keeps watching it: if it goes through, it is refunded automatically/)
            expect((await readFlow(db, pendingId))?.status).toBe('cancelled')
            expect((await db.query<{ status: string }>('SELECT status FROM bookings WHERE id = $1', [bookingId]))[0]?.status).toBe('payment_needed')
            expect(await watchRows(pendingId)).toMatchObject([{ action: 'reader_payment.payment_watched', details: { state: 'watching', paymentIntentId: processing.id } }])

            // Still at the bank: watched, nothing refunded, nothing more written.
            // W47 (W25 review L1), a named difference: until W47 this read was an item of the run, `left` with the
            // reason `payment_watched`, so every Resolve now said "1 left for a person" with nothing listed. Now it
            // is no item: counted as watched, and a line of its own on the stuck list with nothing to do.
            const still = await runReconcile()
            expect(still.items.filter((item) => item.kind === 'flow' || item.kind === 'refund')).toEqual([])
            expect([still.left, still.checked, still.deferred, still.paymentsWatched]).toEqual([0, 0, 0, 1])
            expect(context.stripe.refundsSent).toHaveLength(0)
            expect(await watchRows(pendingId)).toHaveLength(1)
            const listed = (await stuckList(db)).watchedPayments
            expect(listed).toMatchObject([{ pendingId, paymentIntentId: processing.id, flow: 'settle', recordId: bookingId, customerName: 'Mo Member', state: 'watching' }])
            expect(listed[0]?.words).toBe(WATCHED_PAYMENT_WORDS.watching(processing.id))
            expect(listed[0]?.words).toContain('Nothing to do.')
            expect(listed[0]?.close).toBeUndefined()
            // One still watched can't be marked sorted: the automatic check has it.
            expect((await close('payment_watch', listed[0]?.watchId ?? '')).body.data).toMatchObject({ closed: false, reason: 'payment_still_watched' })

            // The bank completes it, two days on: recorded as a payment for a change already undone.
            vi.setSystemTime(Date.now() + 48 * 60 * 60_000)
            context.stripe.completeReaderPayment(processing.id)
            expect(await flowItems()).toMatchObject([{ kind: 'flow', outcome: 'left', reason: 'charged_without_record' }])
            expect(await watchRows(pendingId)).toMatchObject([
              { details: { state: 'watching' } },
              { action: 'reader_payment.payment_watched', details: { state: 'landed', paymentIntentId: processing.id, amount: 2000 } },
              { action: 'reader_payment.charge_without_record', details: { paymentIntentId: processing.id, amount: 2000, watched: true } },
            ])
            expect((await stuckList(db)).refunds).toMatchObject([{ kind: 'flow', id: pendingId, paymentIntentId: processing.id, amount: 20 }])
            // W47: once it has landed it is the automatic refund's line, and no longer a watched payment's.
            expect((await stuckList(db)).watchedPayments).toEqual([])
            // The next run refunds it in full, once; then nothing is left to watch or refund.
            expect(await flowItems()).toMatchObject([{ kind: 'refund', id: pendingId, outcome: 'refund_confirmed' }])
            expect(context.stripe.refundsSent).toMatchObject([{ payment_intent: processing.id, amount: 2000 }])
            // W32: a watched payment's refund is keyed by its own PaymentIntent.
            expect(refundCalls(context.stripe).map((call) => call.idempotencyKey)).toEqual([`${processing.id}:refund-watched`])
            const after = await runReconcile()
            expect(after.items.filter((item) => item.kind === 'flow' || item.kind === 'refund')).toEqual([])
            expect(after.paymentsWatched).toBe(0)
            expect(context.stripe.refundsSent).toHaveLength(1)
            expect((await stuckList(db)).refunds).toEqual([])
          } finally {
            replayStripe.current = null
          }
        },
      },
      workerSide()
    )
  })

  it("W32 item 4 (W25 review L3, the W26 audit's row 30): two payments watched on one flow both land: each is refunded under its own key (its PaymentIntent's), so the second is no longer refused by Stripe for sharing the flow's key", async () => {
    await replay(
      environment,
      {
        name: 'w32 two watched payments',
        seed,
        async run(context) {
          replayStripe.current = context.stripe
          try {
            const { pendingId } = await heldCardSettle(context)
            const row = await readFlow(db, pendingId)
            const processing: string[] = []
            for (let n = 0; n < 2; n += 1) {
              const intent = await context.stripe.paymentIntents.create({ amount: 2000, currency: 'gbp', customer: 'cus_member', metadata: { flow: 'settle', record_id: row?.record_id ?? '', pending_id: pendingId } })
              context.stripe.markProcessing(intent.id)
              processing.push(intent.id)
            }
            pastTheWindow()
            await runReconcile()
            vi.setSystemTime(Date.now() + 25 * 60 * 60_000)
            expect((await close('held_flow', pendingId)).body.data).toMatchObject({ closed: true })
            expect((await watchRows(pendingId)).filter((watched) => watched.details['state'] === 'watching')).toHaveLength(2)
            // Both go through at the bank.
            vi.setSystemTime(Date.now() + 5 * 60_000)
            for (const id of processing) context.stripe.completeReaderPayment(id)
            await runReconcile()
            expect((await watchRows(pendingId)).filter((watched) => watched.action === 'reader_payment.charge_without_record')).toHaveLength(2)
            // The next run refunds both, each in full, each under a key of its own.
            const refunded = (await runReconcile()).items.filter((item) => item.kind === 'refund')
            expect(refunded).toMatchObject([
              { id: pendingId, outcome: 'refund_confirmed' },
              { id: pendingId, outcome: 'refund_confirmed' },
            ])
            const sent = context.stripe.calls.filter((call) => call.method === 'refunds.create')
            expect(sent.map((call) => call.idempotencyKey).sort()).toEqual(processing.map((id) => `${id}:refund-watched`).sort())
            expect(context.stripe.refundsSent.map((made) => [made.payment_intent, made.amount, made.status]).sort()).toEqual(processing.map((id) => [id, 2000, 'succeeded']).sort())
            expect(context.stripe.refundedPence).toBe(4000)
            // Nothing is left for a person, and a further run sends nothing.
            expect((await stuckList(db)).refunds).toEqual([])
            expect(await flowItems()).toEqual([])
            expect(context.stripe.refundsSent).toHaveLength(2)
          } finally {
            replayStripe.current = null
          }
        },
      },
      workerSide()
    )
  })

  it('L5: a watched payment that ends with nothing taken: cancelled, the watch ends, nothing is refunded', async () => {
    await replay(
      environment,
      {
        name: 'w25 watched payment, nothing taken',
        seed,
        async run(context) {
          replayStripe.current = context.stripe
          try {
            const { pendingId } = await heldCardSettle(context)
            const row = await readFlow(db, pendingId)
            const processing = await context.stripe.paymentIntents.create({
              amount: 2000,
              currency: 'gbp',
              customer: 'cus_member',
              metadata: { flow: 'settle', record_id: row?.record_id ?? '', pending_id: pendingId },
            })
            context.stripe.markProcessing(processing.id)
            pastTheWindow()
            await runReconcile()
            vi.setSystemTime(Date.now() + 25 * 60 * 60_000)
            expect((await close('held_flow', pendingId)).body.data).toMatchObject({ closed: true })
            // The next run, five minutes on. The bank lets go of it without taking anything: reconcile cancels it, so
            // nothing can be taken later.
            vi.setSystemTime(Date.now() + 5 * 60_000)
            context.stripe.markRequiresCapture(processing.id)
            expect(await flowItems()).toMatchObject([{ kind: 'flow', id: pendingId, outcome: 'settled_elsewhere' }])
            expect(await watchRows(pendingId)).toMatchObject([{ details: { state: 'watching' } }, { details: { state: 'nothing_taken', paymentIntentId: processing.id } }])
            expect((await context.stripe.paymentIntents.retrieve(processing.id)).status).toBe('canceled')
            expect(await flowItems()).toEqual([])
            expect(context.stripe.refundsSent).toHaveLength(0)
          } finally {
            replayStripe.current = null
          }
        },
      },
      workerSide()
    )
  })
  // Brief W47 item 4 and brief W47a item 2 (W47 review S2). A watch runs out one way only: Stripe can't find the payment
  // with the key in use. A payment Stripe can read stays watched until it ends, and Mark sorted reads it again first.
  type ReplayContext = Parameters<Parameters<typeof replay>[1]['run']>[0]
  const DAY_MS = 24 * 60 * 60_000
  /** A £20 saved-card payment still `processing` when its Settle was undone by hand: watched from then on. */
  async function watchedPayment(context: ReplayContext): Promise<{ bookingId: string; pendingId: string; paymentIntentId: string; reads: () => number; states: () => Promise<unknown[]> }> {
    const { bookingId, pendingId } = await heldCardSettle(context)
    const row = await readFlow(db, pendingId)
    const processing = await context.stripe.paymentIntents.create({ amount: 2000, currency: 'gbp', customer: 'cus_member', metadata: { flow: 'settle', record_id: row?.record_id ?? '', pending_id: pendingId } })
    context.stripe.markProcessing(processing.id)
    pastTheWindow()
    await runReconcile()
    vi.setSystemTime(Date.now() + 25 * 60 * 60_000)
    expect((await close('held_flow', pendingId)).body.data).toMatchObject({ closed: true })
    return {
      bookingId,
      pendingId,
      paymentIntentId: processing.id,
      reads: () => context.stripe.calls.filter((call) => call.method === 'paymentIntents.retrieve' && (call.params as { id?: string }).id === processing.id).length,
      states: async () => (await watchRows(pendingId)).map((watched) => watched.details['state'] ?? watched.action),
    }
  }
  const inAReplay = (name: string, work: (context: ReplayContext) => Promise<void>) =>
    replay(
      environment,
      {
        name,
        seed,
        async run(context) {
          replayStripe.current = context.stripe
          try {
            await work(context)
          } finally {
            replayStripe.current = null
          }
        },
      },
      workerSide()
    )
  const closeRows = async () => (await db.query<{ details: Record<string, unknown> }>("SELECT details FROM audit_log WHERE action = 'order.close' AND details->>'kind' = 'payment_watch' ORDER BY at, ctid")).map((row) => row.details)

  it("W47a item 2 (W47 review S2): a payment Stripe reads as `processing` stays watched for as long as it takes. 31 days on, and 90, it is still read every run and still a line with nothing to do; when the bank then completes it, it is recorded and refunded automatically, once", async () => {
    await inAReplay('w47a watched payment, processing for months', async (context) => {
      const { pendingId, paymentIntentId, reads, states } = await watchedPayment(context)
      // The watch's days are 30 (written out here, so a changed constant can't move the test with it).
      expect(PAYMENT_WATCH_DAYS).toBe(30)
      for (const days of [31, 59]) {
        vi.setSystemTime(Date.now() + days * DAY_MS)
        const before = reads()
        const run = await runReconcile()
        // W47, as built, ended the watch here (`payment_watch_expired`), and nothing read the payment again.
        expect(run.items.filter((item) => item.kind === 'flow')).toEqual([])
        expect([run.left, run.paymentsWatched]).toEqual([0, 1])
        expect(reads()).toBeGreaterThan(before)
        expect(await states()).toEqual(['watching'])
        const line = (await stuckList(db)).watchedPayments[0]
        expect(line).toMatchObject({ pendingId, paymentIntentId, state: 'watching' })
        expect(line?.words).toBe(WATCHED_PAYMENT_WORDS.watching(paymentIntentId))
        expect(line?.close).toBeUndefined()
        // Still watched, so it can't be marked sorted, and that refusal reads nothing in Stripe.
        const readsBeforePress = reads()
        expect((await close('payment_watch', line?.watchId ?? '')).body.data).toMatchObject({ closed: false, reason: 'payment_still_watched' })
        expect(reads()).toBe(readsBeforePress)
      }
      // Day 91: the bank completes it. Recorded as a payment for a change already undone, then refunded in full, once.
      vi.setSystemTime(Date.now() + DAY_MS)
      context.stripe.completeReaderPayment(paymentIntentId)
      expect(await flowItems()).toMatchObject([{ kind: 'flow', outcome: 'left', reason: 'charged_without_record' }])
      expect(await states()).toEqual(['watching', 'landed', 'reader_payment.charge_without_record'])
      expect(await flowItems()).toMatchObject([{ kind: 'refund', id: pendingId, outcome: 'refund_confirmed' }])
      expect(context.stripe.refundsSent).toMatchObject([{ payment_intent: paymentIntentId, amount: 2000 }])
      expect(refundCalls(context.stripe).map((call) => call.idempotencyKey)).toEqual([`${paymentIntentId}:refund-watched`])
      const after = await runReconcile()
      expect([after.items.filter((item) => item.kind === 'flow' || item.kind === 'refund').length, after.paymentsWatched]).toEqual([0, 0])
      expect(context.stripe.refundsSent).toHaveLength(1)
      expect((await stuckList(db)).watchedPayments).toEqual([])
    })
  })

  it("W47a item 2: a read that gets no answer says nothing about the payment, so past the watch's days it ends nothing either: watched again next run", async () => {
    await inAReplay('w47a watched payment, a read with no answer', async (context) => {
      const { paymentIntentId, reads, states } = await watchedPayment(context)
      vi.setSystemTime(Date.now() + 31 * DAY_MS)
      context.stripe.failNext('paymentIntents.retrieve', { kind: 'lost_response' })
      const before = reads()
      const run = await runReconcile()
      expect(reads()).toBe(before + 1)
      expect([run.items.filter((item) => item.kind === 'flow').length, run.left, run.paymentsWatched]).toEqual([0, 0, 1])
      expect(await states()).toEqual(['watching'])
      expect((await stuckList(db)).watchedPayments).toMatchObject([{ paymentIntentId, state: 'watching' }])
    })
  })

  it("W47 item 4 (W25 review L2, the W26 audit's row 29), W47a: a payment Stripe still can't find with the key in use after the watch's 30 days (the key is the other Stripe mode's): the watch ends, once, as a line for a person with Mark sorted, and no run reads it again", async () => {
    await inAReplay('w47 watched payment, never readable', async (context) => {
      const { pendingId, paymentIntentId, reads, states } = await watchedPayment(context)
      // From here the system's key is the other mode's: Stripe answers "no such payment" for a payment that exists.
      context.stripe.keyLivemode = true
      // Day 29: still watched, read every run, nothing for a person.
      vi.setSystemTime(Date.now() + 29 * DAY_MS)
      const before = reads()
      const waiting = await runReconcile()
      expect([waiting.left, waiting.paymentsWatched, waiting.items.filter((item) => item.kind === 'flow').length]).toEqual([0, 1, 0])
      expect(reads()).toBeGreaterThan(before)
      expect((await stuckList(db)).watchedPayments).toMatchObject([{ state: 'watching' }])

      // Day 31: the watch ends for a person.
      vi.setSystemTime(Date.now() + 2 * DAY_MS)
      const ended = await runReconcile()
      expect(ended.items.filter((item) => item.kind === 'flow')).toMatchObject([{ kind: 'flow', id: pendingId, outcome: 'left', reason: 'payment_watch_expired' }])
      expect([ended.left, ended.paymentsWatched]).toEqual([1, 0])
      expect(await states()).toEqual(['watching', 'expired'])
      expect(context.stripe.refundsSent).toHaveLength(0)
      const line = (await stuckList(db)).watchedPayments[0]
      expect(line).toMatchObject({ pendingId, paymentIntentId, state: 'expired', close: { kind: 'payment_watch', orderId: line?.watchId } })
      // What Stripe said is kept on the end row; the line says it in its own words, true for the one way a watch ends.
      expect((await watchRows(pendingId))[1]?.details).toMatchObject({ state: 'expired', days: 30, detail: expect.stringContaining("Stripe can't find the card payment") })
      expect(line?.words).toBe(WATCHED_PAYMENT_WORDS.expired(paymentIntentId))
      expect(line?.words).toBe(
        `A card payment (${paymentIntentId}) was still at the bank when its booking change was undone by hand, and after 30 days Stripe still can't say how it ended with the payment account the system is using: it can't find the payment there (the system's Stripe key may be for the other Stripe mode, live or test, than the payment). So the automatic check has stopped watching it. Look at the payment in Stripe first and, if it took money, refund it there by hand (or tell a manager). Then press Mark sorted (needs the Issue refunds permission): if Stripe can see the payment now, the automatic check takes it back and refunds it if it took money (never again if it was refunded by hand); if not, the line is closed.`
      )
      // W58c (W58 review FL5): the look in Stripe (and any refund by hand) comes before the press, never after it.
      const words = line?.words ?? ''
      expect(words.indexOf('Look at the payment in Stripe first')).toBeGreaterThan(-1)
      expect(words.indexOf('Look at the payment in Stripe first')).toBeLessThan(words.indexOf('press Mark sorted'))
      expect(words).not.toContain('by hand first')

      // No later run reads it, or lists it again as an item.
      const readsAtEnd = reads()
      const later = await runReconcile()
      expect([later.items.filter((item) => item.kind === 'flow').length, later.left, later.paymentsWatched]).toEqual([0, 0, 0])
      expect(reads()).toBe(readsAtEnd)

      // Mark sorted, a minute later (under the test's clock the end rows would otherwise share a moment). W47a: it
      // reads the payment once; Stripe still can't find it, which is what the watch ran out on, so it is sorted, and
      // the close's row keeps what Stripe showed. A second press answers that it was closed already, with no read.
      vi.setSystemTime(Date.now() + 60_000)
      const sorted = await close('payment_watch', line?.watchId ?? '')
      expect(sorted.body.data).toMatchObject({ closed: true, kind: 'payment_watch', message: 'Marked as sorted. It is no longer listed.' })
      expect(reads()).toBe(readsAtEnd + 1)
      expect(await closeRows()).toMatchObject([{ kind: 'payment_watch', watchId: line?.watchId, paymentIntentId, stripeStatus: 'not_found' }])
      expect((await stuckList(db)).watchedPayments).toEqual([])
      expect(await states()).toEqual(['watching', 'expired', 'sorted'])
      expect((await close('payment_watch', line?.watchId ?? '')).body.data).toMatchObject({ closed: true, alreadyClosed: true })
      expect(reads()).toBe(readsAtEnd + 1)
      expect((await states()).filter((state) => state === 'sorted')).toHaveLength(1)
      // A watch that was never there is refused.
      expect((await close('payment_watch', crypto.randomUUID())).body.data).toMatchObject({ closed: false, reason: 'not_listed' })
      // Nothing was ever sent to Stripe for it by the close: reads only.
      expect(context.stripe.calls.filter((call) => call.method === 'paymentIntents.cancel' || call.method === 'refunds.create')).toEqual([])
    })
  })

  // Brief W47b item 1 (W47a "Noticed" 1 and 2; the lead's call, 19 Nov). Mark sorted never sorts a payment Stripe can
  // see: found, whatever its status, it is handed back to the automatic check; only "still not found" sorts it (the
  // test above); a read with no answer stays refused. A named difference: until W47b a `succeeded` or `canceled`
  // payment was sorted (W47a's last step here), and one still moving was refused (`payment_still_moving`).
  const HANDED_BACK_WORDS =
    'Stripe can see this payment now, so it has not been marked as sorted: the automatic check has taken it back. It reads the payment at its next run (every 5 minutes) and refunds it automatically if it took money; a payment already refunded in Stripe by hand is not refunded again. Nothing to do.'
  /**
   * A watch that ran out under the other mode's key (the wrong key for 31 days), then the key put right: Stripe can
   * read the payment again, the line for a person is still there, and the payment is still `processing`.
   */
  async function ranOutThenTheKeyPutRight(context: ReplayContext) {
    const watched = await watchedPayment(context)
    context.stripe.keyLivemode = true
    vi.setSystemTime(Date.now() + 31 * DAY_MS)
    expect((await runReconcile()).items.filter((item) => item.kind === 'flow')).toMatchObject([{ reason: 'payment_watch_expired' }])
    const line = (await stuckList(db)).watchedPayments[0]
    expect(line).toMatchObject({ state: 'expired', close: { kind: 'payment_watch' } })
    context.stripe.keyLivemode = false
    vi.setSystemTime(Date.now() + 60_000)
    return { ...watched, watchId: line?.watchId ?? '' }
  }
  /** The ids of a flow's `expired` rows, oldest first: what a hand-back names in `ends`. */
  const expiredIds = async (pendingId: string) =>
    (
      await db.query<{ id: string }>(
        "SELECT id::text AS id FROM audit_log WHERE entity_type = 'reader_payment' AND entity_id = $1 AND action = 'reader_payment.payment_watched' AND details->>'state' = 'expired' ORDER BY at, ctid",
        [pendingId]
      )
    ).map((row) => row.id)
  const sentToStripe = (stripe: FakeStripe) => stripe.calls.filter((call) => call.method === 'paymentIntents.cancel' || call.method === 'refunds.create')
  const lateRefundRows = async (pendingId: string) =>
    (
      await db.query<{ details: { refund?: Record<string, unknown> } }>(
        "SELECT details FROM audit_log WHERE entity_type = 'reader_payment' AND entity_id = $1 AND action = 'order.reconcile' AND details ? 'refund' ORDER BY at, CASE details->'refund'->>'state' WHEN 'started' THEN 1 ELSE 2 END",
        [pendingId]
      )
    ).map((row) => row.details.refund)

  it("W47b item 1 (W47a \"Noticed\" 1): Mark sorted never sorts a payment Stripe can see. The wrong key for 31 days, the key put right, the bank completed Mo's £20: Mark sorted hands it back to the automatic check; the next run records it, the run after refunds the £20 once under its own key, and a further run does nothing", async () => {
    await inAReplay('w47b mark sorted hands back a payment that went through', async (context) => {
      const { pendingId, bookingId, paymentIntentId, watchId, reads, states } = await ranOutThenTheKeyPutRight(context)
      context.stripe.completeReaderPayment(paymentIntentId)
      // The press: one read, and the whole answer. Until W47b this was sorted, and the £20 kept with nothing recorded.
      const before = reads()
      const pressed = await close('payment_watch', watchId)
      expect(pressed.body.data).toEqual({ kind: 'payment_watch', orderId: watchId, closed: true, reason: 'handed_back', message: HANDED_BACK_WORDS })
      expect(CLOSE_WORDS.payment_handed_back).toBe(HANDED_BACK_WORDS)
      expect(reads()).toBe(before + 1)
      // Not sorted: no `sorted` row and no close row. The hand-back's own row names the expiry it ends, who and why.
      expect(await states()).toEqual(['watching', 'expired', 'handed_back'])
      expect(await closeRows()).toEqual([])
      const handedBack = (await db.query<{ actor_type: string; actor_id: string | null; details: Record<string, unknown> }>(
        "SELECT actor_type, actor_id, details FROM audit_log WHERE entity_type = 'reader_payment' AND entity_id = $1 AND details->>'state' = 'handed_back'",
        [pendingId]
      ))[0]
      expect(handedBack).toMatchObject({ actor_type: 'staff', actor_id: ID.staff })
      expect(handedBack?.details).toEqual({ state: 'handed_back', paymentIntentId, ends: await expiredIds(pendingId), stripeStatus: 'succeeded', watchId, byHand: { why: 'Checked in Stripe by hand' } })
      expect(await expiredIds(pendingId)).toHaveLength(1)
      // On the list it is a watched payment again, with nothing to do and no Mark sorted.
      const line = (await stuckList(db)).watchedPayments
      expect(line).toMatchObject([{ watchId, pendingId, paymentIntentId, state: 'watching' }])
      expect(line[0]?.words).toBe(WATCHED_PAYMENT_WORDS.watching(paymentIntentId))
      expect(line[0]?.close).toBeUndefined()
      // A second press is refused as for any payment still watched, with no read.
      expect((await close('payment_watch', watchId)).body.data).toMatchObject({ closed: false, reason: 'payment_still_watched' })
      expect(reads()).toBe(before + 1)
      // The press sent nothing to Stripe: it only read.
      expect(sentToStripe(context.stripe)).toEqual([])

      // The next run, five minutes on, reads it: gone through, so recorded as a payment for a change already undone.
      vi.setSystemTime(Date.now() + 5 * 60_000)
      expect(await flowItems()).toMatchObject([{ kind: 'flow', id: pendingId, outcome: 'left', reason: 'charged_without_record' }])
      expect(await states()).toEqual(['watching', 'expired', 'handed_back', 'landed', 'reader_payment.charge_without_record'])
      expect((await stuckList(db)).watchedPayments).toEqual([])
      expect((await stuckList(db)).refunds).toMatchObject([{ kind: 'flow', id: pendingId, paymentIntentId, amount: 20 }])
      // The run after refunds the £20, once, under the payment's own key.
      vi.setSystemTime(Date.now() + 5 * 60_000)
      expect(await flowItems()).toMatchObject([{ kind: 'refund', id: pendingId, outcome: 'refund_confirmed' }])
      expect(context.stripe.refundsSent).toMatchObject([{ payment_intent: paymentIntentId, amount: 2000, status: 'succeeded' }])
      expect(refundCalls(context.stripe).map((call) => call.idempotencyKey)).toEqual([`${paymentIntentId}:refund-watched`])
      // A further run does nothing: no item, no read of the payment's watch, no second refund.
      vi.setSystemTime(Date.now() + 5 * 60_000)
      const after = await runReconcile()
      expect([after.items.filter((item) => item.kind === 'flow' || item.kind === 'refund').length, after.paymentsWatched]).toEqual([0, 0])
      expect(context.stripe.refundsSent).toHaveLength(1)
      expect(context.stripe.refundedPence).toBe(2000)
      expect(refundCalls(context.stripe)).toHaveLength(1)
      expect((await stuckList(db)).refunds).toEqual([])
      expect((await stuckList(db)).watchedPayments).toEqual([])
      // Nothing is owed on the booking, and Mark sorted has nothing left to act on.
      expect(await booking(bookingId)).toMatchObject({ refund_owed_amount: '0.00' })
      expect((await close('payment_watch', watchId)).body.data).toMatchObject({ closed: false, reason: 'not_listed' })
      expect((await states()).filter((state) => state === 'sorted')).toEqual([])
    })
  })

  it('W47b item 1: the same when Stripe shows the payment `canceled`: handed back, the next run ends the watch with nothing taken and nothing refunded, and a further run does nothing', async () => {
    await inAReplay('w47b mark sorted hands back a cancelled payment', async (context) => {
      const { pendingId, paymentIntentId, watchId, reads, states } = await ranOutThenTheKeyPutRight(context)
      // The bank let go of it without taking anything, and a person cancelled it in Stripe by hand.
      context.stripe.markRequiresCapture(paymentIntentId)
      await context.stripe.paymentIntents.cancel(paymentIntentId)
      const sentBefore = sentToStripe(context.stripe).length
      expect((await close('payment_watch', watchId)).body.data).toEqual({ kind: 'payment_watch', orderId: watchId, closed: true, reason: 'handed_back', message: HANDED_BACK_WORDS })
      expect(await states()).toEqual(['watching', 'expired', 'handed_back'])
      expect((await watchRows(pendingId))[2]?.details).toMatchObject({ state: 'handed_back', stripeStatus: 'canceled' })
      expect(await closeRows()).toEqual([])
      vi.setSystemTime(Date.now() + 5 * 60_000)
      expect(await flowItems()).toEqual([{ kind: 'flow', id: pendingId, outcome: 'settled_elsewhere', detail: `watched payment ${paymentIntentId} took nothing (canceled)` }])
      expect(await states()).toEqual(['watching', 'expired', 'handed_back', 'nothing_taken'])
      expect((await stuckList(db)).watchedPayments).toEqual([])
      // A further run reads nothing and does nothing; nothing was ever refunded or sent.
      vi.setSystemTime(Date.now() + 5 * 60_000)
      const readsAtEnd = reads()
      const after = await runReconcile()
      expect([after.items.filter((item) => item.kind === 'flow' || item.kind === 'refund').length, after.left, after.paymentsWatched]).toEqual([0, 0, 0])
      expect(reads()).toBe(readsAtEnd)
      expect(context.stripe.refundsSent).toHaveLength(0)
      expect(sentToStripe(context.stripe)).toHaveLength(sentBefore)
      expect((await stuckList(db)).refunds).toEqual([])
    })
  })

  it("W47b item 1 (W47a \"Noticed\" 2): a payment still `processing` is handed back too (W47a refused it), and stays watched until the bank ends it; a read with no answer is still refused with nothing written; when the bank completes it months later it is refunded automatically, once", async () => {
    await inAReplay('w47b mark sorted hands back a payment still processing', async (context) => {
      const { pendingId, paymentIntentId, watchId, reads, states } = await ranOutThenTheKeyPutRight(context)
      // A read that gets no answer says nothing about the payment: refused, nothing written, still a line for a person.
      context.stripe.failNext('paymentIntents.retrieve', { kind: 'lost_response' })
      expect((await close('payment_watch', watchId)).body.data).toEqual({
        kind: 'payment_watch',
        orderId: watchId,
        closed: false,
        reason: 'payment_not_read',
        message: "The booking system couldn't read this payment in Stripe just now, so it can't tell whether it could still take money. Nothing was changed. Press Mark sorted again in a minute.",
      })
      expect(await states()).toEqual(['watching', 'expired'])
      expect((await stuckList(db)).watchedPayments).toMatchObject([{ state: 'expired', close: { kind: 'payment_watch' } }])
      // Pressed again, the read answers: `processing`. Handed back, not refused and not sorted.
      const before = reads()
      expect((await close('payment_watch', watchId)).body.data).toEqual({ kind: 'payment_watch', orderId: watchId, closed: true, reason: 'handed_back', message: HANDED_BACK_WORDS })
      expect(reads()).toBe(before + 1)
      expect((await watchRows(pendingId))[2]?.details).toMatchObject({ state: 'handed_back', stripeStatus: 'processing' })
      expect(await closeRows()).toEqual([])
      // Every run reads it again, though it is long past the watch's 30 days: Stripe can read it, so nothing ends.
      for (const days of [1, 60]) {
        vi.setSystemTime(Date.now() + days * DAY_MS)
        const readsBefore = reads()
        const run = await runReconcile()
        expect(reads()).toBeGreaterThan(readsBefore)
        expect([run.items.filter((item) => item.kind === 'flow').length, run.left, run.paymentsWatched]).toEqual([0, 0, 1])
        expect(await states()).toEqual(['watching', 'expired', 'handed_back'])
        expect((await stuckList(db)).watchedPayments).toMatchObject([{ watchId, state: 'watching' }])
      }
      // The bank completes it: recorded, then refunded in full, once.
      vi.setSystemTime(Date.now() + DAY_MS)
      context.stripe.completeReaderPayment(paymentIntentId)
      expect(await flowItems()).toMatchObject([{ kind: 'flow', outcome: 'left', reason: 'charged_without_record' }])
      vi.setSystemTime(Date.now() + 5 * 60_000)
      expect(await flowItems()).toMatchObject([{ kind: 'refund', id: pendingId, outcome: 'refund_confirmed' }])
      vi.setSystemTime(Date.now() + 5 * 60_000)
      expect(await flowItems()).toEqual([])
      expect(context.stripe.refundsSent).toMatchObject([{ payment_intent: paymentIntentId, amount: 2000 }])
      expect(refundCalls(context.stripe).map((call) => call.idempotencyKey)).toEqual([`${paymentIntentId}:refund-watched`])
    })
  })

  it('W47b item 1: a payment waiting on the customer\'s bank approval (`requires_action`) is handed back, and the next run cancels it in Stripe so nothing can be taken later: the watch ends with nothing taken', async () => {
    await inAReplay('w47b mark sorted hands back a payment waiting for approval', async (context) => {
      const { pendingId, paymentIntentId, watchId, states } = await ranOutThenTheKeyPutRight(context)
      context.stripe.markRequiresAction(paymentIntentId)
      expect((await close('payment_watch', watchId)).body.data).toMatchObject({ closed: true, reason: 'handed_back' })
      expect((await watchRows(pendingId))[2]?.details).toMatchObject({ state: 'handed_back', stripeStatus: 'requires_action' })
      // The press itself cancelled nothing.
      expect(sentToStripe(context.stripe)).toEqual([])
      vi.setSystemTime(Date.now() + 5 * 60_000)
      expect(await flowItems()).toMatchObject([{ kind: 'flow', id: pendingId, outcome: 'settled_elsewhere' }])
      expect(await states()).toEqual(['watching', 'expired', 'handed_back', 'nothing_taken'])
      expect((await context.stripe.paymentIntents.retrieve(paymentIntentId)).status).toBe('canceled')
      expect(context.stripe.refundsSent).toHaveLength(0)
    })
  })

  it("W47b item 1: refunded in Stripe by hand first (as the expired line says), then Mark sorted: handed back, and the automatic check doesn't refund it again. Stripe refuses the second refund, which is recorded as done (\"already refunded\"): one refund in Stripe, nothing owed, nothing listed, and no later run tries again", async () => {
    await inAReplay('w47b mark sorted after a refund by hand', async (context) => {
      const { pendingId, bookingId, paymentIntentId, watchId, states } = await ranOutThenTheKeyPutRight(context)
      context.stripe.completeReaderPayment(paymentIntentId)
      const byHand = await context.stripe.refunds.create({ payment_intent: paymentIntentId })
      expect(byHand).toMatchObject({ amount: 2000, status: 'succeeded' })
      expect((await close('payment_watch', watchId)).body.data).toEqual({ kind: 'payment_watch', orderId: watchId, closed: true, reason: 'handed_back', message: HANDED_BACK_WORDS })
      // The next run records that it went through; until the refund is settled it is the automatic refund's line.
      vi.setSystemTime(Date.now() + 5 * 60_000)
      expect(await flowItems()).toMatchObject([{ kind: 'flow', id: pendingId, outcome: 'left', reason: 'charged_without_record' }])
      // The run after sends the refund under the payment's own key; Stripe refuses it (nothing is left to refund), and
      // that is recorded as done, in words, not as failed and not as money owed.
      vi.setSystemTime(Date.now() + 5 * 60_000)
      expect(await flowItems()).toEqual([{ kind: 'refund', id: pendingId, outcome: 'refund_confirmed', detail: 'already refunded' }])
      expect(refundCalls(context.stripe).map((call) => call.idempotencyKey ?? null)).toEqual([null, `${paymentIntentId}:refund-watched`])
      expect(context.stripe.refundsSent.map((refund) => [refund.id, refund.amount])).toEqual([[byHand.id, 2000]])
      expect(context.stripe.refundedPence).toBe(2000)
      expect(await lateRefundRows(pendingId)).toMatchObject([
        { state: 'started', paymentIntentId, key: `${paymentIntentId}:refund-watched` },
        { state: 'confirmed', paymentIntentId, key: `${paymentIntentId}:refund-watched`, alreadyRefunded: true },
      ])
      expect(await states()).toEqual(['watching', 'expired', 'handed_back', 'landed', 'reader_payment.charge_without_record'])
      // Nothing is left anywhere: no line, no watched payment, nothing owed, no store credit given.
      const list = await stuckList(db)
      expect([list.refunds, list.watchedPayments, list.watched]).toEqual([[], [], []])
      expect(await booking(bookingId)).toMatchObject({ refund_owed_amount: '0.00' })
      expect(await storeCredit()).toEqual([])
      // No retry: two more runs have no item and send nothing.
      for (let n = 0; n < 2; n += 1) {
        vi.setSystemTime(Date.now() + 5 * 60_000)
        const run = await runReconcile()
        expect([run.items.filter((item) => item.kind === 'flow' || item.kind === 'refund').length, run.left, run.paymentsWatched]).toEqual([0, 0, 0])
      }
      expect(refundCalls(context.stripe)).toHaveLength(2)
      expect(context.stripe.refundsSent).toHaveLength(1)
      expect(await lateRefundRows(pendingId)).toHaveLength(2)
    })
  })

  it('W47b item 1: part of it refunded by hand first (£5 of the £20): handed back, and the automatic refund gives back only the £15 Stripe still holds, once', async () => {
    await inAReplay('w47b mark sorted after a part refund by hand', async (context) => {
      const { pendingId, paymentIntentId, watchId } = await ranOutThenTheKeyPutRight(context)
      context.stripe.completeReaderPayment(paymentIntentId)
      await context.stripe.refunds.create({ payment_intent: paymentIntentId, amount: 500 })
      expect((await close('payment_watch', watchId)).body.data).toMatchObject({ closed: true, reason: 'handed_back' })
      vi.setSystemTime(Date.now() + 5 * 60_000)
      expect(await flowItems()).toMatchObject([{ kind: 'flow', outcome: 'left', reason: 'charged_without_record' }])
      vi.setSystemTime(Date.now() + 5 * 60_000)
      expect(await flowItems()).toMatchObject([{ kind: 'refund', id: pendingId, outcome: 'refund_confirmed' }])
      expect(context.stripe.refundsSent.map((refund) => refund.amount)).toEqual([500, 1500])
      expect(context.stripe.refundedPence).toBe(2000)
      vi.setSystemTime(Date.now() + 5 * 60_000)
      expect(await flowItems()).toEqual([])
      expect(context.stripe.refundsSent).toHaveLength(2)
    })
  })

  it('W58b (W47b "Noticed" 2): two runs reading a watch as it runs out write one `expired` row, not one each: the second run, which read the payment before the first wrote, writes nothing and has no item', async () => {
    await inAReplay('w58b one expired row from two runs', async (context) => {
      const { pendingId } = await watchedPayment(context)
      context.stripe.keyLivemode = true
      vi.setSystemTime(Date.now() + 31 * DAY_MS)
      // While this run is at Stripe for the payment, another run reads it too and ends the watch first.
      const retrieve = context.stripe.paymentIntents.retrieve
      let raced = false
      context.stripe.paymentIntents.retrieve = (async (...args: Parameters<typeof retrieve>) => {
        if (!raced) {
          raced = true
          expect((await runReconcile()).items.filter((item) => item.kind === 'flow')).toMatchObject([{ id: pendingId, reason: 'payment_watch_expired' }])
        }
        return retrieve(...args)
      }) as typeof retrieve
      const slower = await runReconcile()
      context.stripe.paymentIntents.retrieve = retrieve
      expect(raced).toBe(true)
      expect(slower.items.filter((item) => item.kind === 'flow')).toEqual([])
      expect(await expiredIds(pendingId)).toHaveLength(1)
      expect((await stuckList(db)).watchedPayments).toMatchObject([{ state: 'expired' }])
    })
  })

  it("W47b item 1: a hand-back ends every `expired` row standing (two runs at once can each write one), and only those: if the key stops finding the payment again, the watch runs out again at the next read, as a line for a person, and Mark sorted then sorts it (still not found)", async () => {
    await inAReplay('w47b handed back, then not found again', async (context) => {
      const { pendingId, paymentIntentId, watchId, reads, states } = await ranOutThenTheKeyPutRight(context)
      // A second `expired` row, as a second run reading the payment at the same moment would have written.
      await db.query(
        "INSERT INTO audit_log (at, actor_type, actor_id, action, entity_type, entity_id, request_id, details) SELECT at, actor_type, actor_id, action, entity_type, entity_id, request_id, details FROM audit_log WHERE entity_type = 'reader_payment' AND entity_id = $1 AND details->>'state' = 'expired'",
        [pendingId]
      )
      const both = await expiredIds(pendingId)
      expect(both).toHaveLength(2)
      expect((await stuckList(db)).watchedPayments).toMatchObject([{ watchId, state: 'expired' }])
      // Still `processing`: handed back, and one hand-back ends both rows.
      expect((await close('payment_watch', watchId)).body.data).toMatchObject({ closed: true, reason: 'handed_back' })
      const handedBack = (await watchRows(pendingId)).find((row) => row.details['state'] === 'handed_back')
      expect([...(handedBack?.details['ends'] as string[])].sort()).toEqual([...both].sort())
      expect((await stuckList(db)).watchedPayments).toMatchObject([{ watchId, state: 'watching' }])
      vi.setSystemTime(Date.now() + 5 * 60_000)
      const watchedAgain = await runReconcile()
      expect([watchedAgain.items.filter((item) => item.kind === 'flow').length, watchedAgain.paymentsWatched]).toEqual([0, 1])

      // The key is the other mode's again. The payment is past its days, so the next read ends the watch again.
      context.stripe.keyLivemode = true
      vi.setSystemTime(Date.now() + 5 * 60_000)
      expect((await runReconcile()).items.filter((item) => item.kind === 'flow')).toMatchObject([{ id: pendingId, outcome: 'left', reason: 'payment_watch_expired' }])
      expect(await expiredIds(pendingId)).toHaveLength(3)
      const line = (await stuckList(db)).watchedPayments
      expect(line).toMatchObject([{ watchId, state: 'expired', close: { kind: 'payment_watch', orderId: watchId } }])
      expect(line[0]?.words).toBe(WATCHED_PAYMENT_WORDS.expired(paymentIntentId))
      // No run reads it while it is expired again.
      vi.setSystemTime(Date.now() + 5 * 60_000)
      const readsExpired = reads()
      const quiet = await runReconcile()
      expect([quiet.items.filter((item) => item.kind === 'flow').length, quiet.paymentsWatched, reads()]).toEqual([0, 0, readsExpired])
      // Mark sorted: Stripe still can't find it, so this time it is sorted, as before W47b.
      vi.setSystemTime(Date.now() + 60_000)
      expect((await close('payment_watch', watchId)).body.data).toMatchObject({ closed: true, message: 'Marked as sorted. It is no longer listed.' })
      expect((await close('payment_watch', watchId)).body.data).toMatchObject({ closed: true, alreadyClosed: true })
      expect(await closeRows()).toMatchObject([{ kind: 'payment_watch', watchId, paymentIntentId, stripeStatus: 'not_found' }])
      expect((await states()).filter((state) => state !== 'expired')).toEqual(['watching', 'handed_back', 'sorted'])
      expect((await stuckList(db)).watchedPayments).toEqual([])
      // Sorted for good: no later run reads it.
      vi.setSystemTime(Date.now() + 5 * 60_000)
      const readsSorted = reads()
      await runReconcile()
      expect(reads()).toBe(readsSorted)
      // Nothing was ever refunded. (The one cancel Stripe was sent is the automatic check's, while it was watched
      // again: it tries to cancel a watched payment at every read, and Stripe refuses while the bank has it.)
      expect(refundCalls(context.stripe)).toEqual([])
      expect(sentToStripe(context.stripe).map((call) => call.method)).toEqual(['paymentIntents.cancel'])
    })
  })
})


// Brief W32 (E-plan section 5; W21 review L3, the W26 audit's row 11; lead call L7): the refund watch on a booking's
// claims. A card refund Stripe answers `pending` is recorded as gone, as before, and is now read by reconcile until it
// ends. Reconcile never sends a refund.
describe('W32: the refund watch on a booking', () => {
  const watchRows = async () => (await auditRows('refund.watch')).map((row) => row.details)
  /**
   * The watch's rows' states, sorted: rows written within one millisecond of the tests' clock can read in either order.
   * W32a: without the `checked` rows (one for each read that ended nothing: checkedRows).
   */
  const watchStates = async () => (await watchRows()).map((row) => String(row['state'])).filter((state) => state !== 'checked').sort()
  const checkedRows = async () => (await watchRows()).filter((row) => row['state'] === 'checked')
  const listsOf = (stripe: FakeStripe) => stripe.calls.filter((call) => call.method === 'refunds.list').length
  const minutes = (n: number) => vi.setSystemTime(Date.now() + n * 60_000)
  const DAY = 24 * 60
  const refundItems = async () => (await runReconcile()).items.filter((item) => item.kind === 'refund')
  /** A Part refund to the card that Stripe answers `pending`. */
  async function pendingPartRefund(bookingId: string, stripe: FakeStripe, amount: number): Promise<Answer> {
    stripe.refundsStayPending = true
    const answer = await refund('part', bookingId, { amount, refundMethod: 'card', reason: 'Goodwill' })
    stripe.refundsStayPending = false
    return answer
  }

  it('pending then succeeded: recorded as gone at once, watched, and the watch ends with nothing else changed; a run after that has nothing to read', async () => {
    await onABooking(async ({ bookingId, stripe }) => {
      const answer = await pendingPartRefund(bookingId, stripe, 30)
      expect(answer.body.data).toMatchObject({ cardRefundedAmount: 30, storeCreditRefundedAmount: 0, pricePaid: 10 })
      const sent = stripe.refundsSent[0]
      const claim = (await auditRows(REFUND_CLAIMED))[0]
      const orderId = (await bookingLines(bookingId))[0]?.order_id
      // The finished row keeps the refund's id and status.
      expect((await auditRows('booking.refund_finished'))[0]?.details).toMatchObject({ outcome: 'given', cardRefunded: 30, refunds: [{ orderId, paymentIntentId: sent?.payment_intent, refundId: sent?.id, status: 'pending', amount: 30 }] })
      // One watch, written with it, carrying what a failure would need.
      expect(await watchRows()).toEqual([
        { state: 'watching', refundId: sent?.id, paymentIntentId: sent?.payment_intent, amount: 30, status: 'pending', livemode: false, on: 'booking', subjectId: bookingId, orderId: null, claimId: claim?.id, lines: [{ lineId: expect.any(String), amount: 30 }] },
      ])
      // Still pending: read, left alone, and not listed for anyone. W32a (W32 review S2): the read is no item and
      // nothing for a person; it is counted as a refund waiting on Stripe, and kept as the watch's last read.
      expect(await runReconcile()).toMatchObject({ checked: 0, refunds: 0, left: 0, refundsWaiting: 1, items: [] })
      expect((await stuckList(db)).watched).toEqual([])
      expect(await watchStates()).toEqual(['watching'])
      expect(await checkedRows()).toEqual([{ state: 'checked', refundId: sent?.id, status: 'pending', reason: 'refund_pending' }])

      stripe.settleRefund(sent?.id as string, 'succeeded')
      minutes(5)
      // W32a (lead call 1): succeeded is not the end of the watch: Stripe can still fail it. It is read once a day.
      expect(await runReconcile()).toMatchObject({ refunds: 0, left: 0, refundsWaiting: 0, items: [] })
      expect(await watchStates()).toEqual(['watching'])
      const read = listsOf(stripe)
      minutes(5)
      await runReconcile()
      expect(listsOf(stripe)).toBe(read)
      minutes(DAY)
      await runReconcile()
      expect(listsOf(stripe)).toBe(read + 1)
      // At the end of its 50 days it ends quietly: no item, no line.
      minutes(WATCH_DAYS * DAY)
      expect(await refundItems()).toEqual([])
      expect(await watchStates()).toEqual(['succeeded', 'watching'])
      expect(await booking(bookingId)).toMatchObject({ price_paid: '10.00', part_refunded_amount: '30.00', refund_owed_amount: '0.00' })
      expect((await bookingLines(bookingId)).map((line) => line.card_refunded_amount)).toEqual(['30'])
      // The watch is over: nothing is read again, nothing was ever sent again, nothing is listed.
      const over = listsOf(stripe)
      minutes(DAY)
      expect(await refundItems()).toEqual([])
      expect(listsOf(stripe)).toBe(over)
      expect(refundCalls(stripe)).toHaveLength(1)
      expect((await stuckList(db)).watched).toEqual([])
      expect(await storeCredit()).toEqual([])
    })
  })

  it("W32a (lead call 1; Stripe's 5126 shape, end to end): a Part refund to the card answered succeeded is watched; Stripe fails it minutes later; the next day's read finds it: £30 off the line and back on the booking as still to refund, listed; the failed refund is never sent again", async () => {
    await onABooking(async ({ bookingId, stripe }) => {
      const answer = await refund('part', bookingId, { amount: 30, refundMethod: 'card', reason: 'Goodwill' })
      expect(answer.body.data).toMatchObject({ cardRefundedAmount: 30, storeCreditRefundedAmount: 0, pricePaid: 10 })
      const sent = stripe.refundsSent[0]
      expect(sent?.status).toBe('succeeded')
      const claim = (await auditRows(REFUND_CLAIMED))[0]
      expect(await watchRows()).toEqual([
        { state: 'watching', refundId: sent?.id, paymentIntentId: sent?.payment_intent, amount: 30, status: 'succeeded', livemode: false, on: 'booking', subjectId: bookingId, orderId: null, claimId: claim?.id, lines: [{ lineId: expect.any(String), amount: 30 }] },
      ])
      // Stripe fails it a few minutes on (the bank sent the money back): it is back on the payment.
      minutes(5)
      stripe.settleRefund(sent?.id as string, 'failed')
      expect(stripe.refundedPence).toBe(0)
      // The schedule reads a refund that read succeeded once a day: nothing is read before then.
      const before = listsOf(stripe)
      expect(await runReconcile()).toMatchObject({ refundsWaiting: 0, items: [] })
      expect(listsOf(stripe)).toBe(before)
      expect(await booking(bookingId)).toMatchObject({ price_paid: '10.00', refund_owed_amount: '0.00' })
      minutes(DAY)
      const found = await runReconcile()
      expect(found).toMatchObject({ checked: 1, refunds: 1, left: 1 })
      expect(found.items).toMatchObject([{ kind: 'refund', id: sent?.id, outcome: 'refund_failed', reason: 'refund_failed_later', detail: 'the refund failed: £30.00 is owed again' }])
      // Exactly as a refund answered pending that failed: owed on the booking, off the line, the card usable again.
      expect(await booking(bookingId)).toMatchObject({ price_paid: '40.00', part_refunded_amount: '30.00', refund_owed_amount: '30.00' })
      expect((await bookingLines(bookingId)).map((line) => line.card_refunded_amount)).toEqual(['0'])
      expect((await figures(bookingId)).body.data).toMatchObject({ refundOwed: 30, cardLeft: 40 })
      expect((await auditRows('booking.refund_failed_later')).map((row) => row.details)).toEqual([
        { claimId: claim?.id, refundId: sent?.id, paymentIntentId: sent?.payment_intent, amount: 30, owed: 30, status: 'failed' },
      ])
      expect((await stuckList(db)).watched).toMatchObject([{ refundId: sent?.id, on: 'booking', bookingId, customerName: 'Sam Test', amount: 30, owed: 30, state: 'failed', words: WATCH_WORDS.bookingFailed(30, sent?.id as string) }])
      // Never a second send, and the money goes back once, however many runs follow (two at once among them).
      await Promise.all([runReconcile(), runReconcile()])
      minutes(DAY)
      expect(await refundItems()).toEqual([])
      expect(await booking(bookingId)).toMatchObject({ price_paid: '40.00', refund_owed_amount: '30.00' })
      expect(refundCalls(stripe)).toHaveLength(1)
      expect(await storeCredit()).toEqual([])
      expect(await watchStates()).toEqual(['failed', 'watching'])
      // Staff decide: Refund the rest is a new refund under a new key (and is watched in its turn).
      const rest = await refund('owed', bookingId, { amount: 30, refundMethod: 'card' })
      expect(rest.body.data).toMatchObject({ cardRefundedAmount: 30, storeCreditRefundedAmount: 0, pricePaid: 10 })
      expect(new Set(refundCalls(stripe).map((call) => call.idempotencyKey)).size).toBe(2)
      expect(stripe.refundedPence).toBe(3000)
      expect(await watchStates()).toEqual(['failed', 'watching', 'watching'])
    })
  })

  it("W32a: Resolve now (a staff run) reads the watched refunds read longest ago whatever their last read, so a refund that failed is found without waiting for its daily read", async () => {
    await onABooking(async ({ bookingId, stripe }) => {
      await refund('part', bookingId, { amount: 30, refundMethod: 'card', reason: 'Goodwill' })
      const sent = stripe.refundsSent[0]
      minutes(5)
      stripe.settleRefund(sent?.id as string, 'failed')
      // The schedule's run leaves it for its daily read.
      expect((await runReconcile()).items).toEqual([])
      const pressed = await reconcile(db, stripe, { actor: { type: 'staff', id: 'staff-1' }, requestId: crypto.randomUUID(), ...MANUAL_LIMITS })
      expect(pressed.items).toMatchObject([{ kind: 'refund', id: sent?.id, outcome: 'refund_failed', reason: 'refund_failed_later' }])
      expect(await booking(bookingId)).toMatchObject({ price_paid: '40.00', refund_owed_amount: '30.00' })
      expect(refundCalls(stripe)).toHaveLength(1)
    })
  })

  it('pending then failed on a live booking: the £30 is off the line and back on the booking as still to refund, once however often reconcile runs, never store credit, never sent again; listed until Mark sorted; Refund the rest can use the card again', async () => {
    await onABooking(async ({ bookingId, stripe }) => {
      await pendingPartRefund(bookingId, stripe, 30)
      const sent = stripe.refundsSent[0]
      expect(await booking(bookingId)).toMatchObject({ price_paid: '10.00', part_refunded_amount: '30.00', refund_owed_amount: '0.00' })
      stripe.settleRefund(sent?.id as string, 'failed')
      expect(stripe.refundedPence).toBe(0)

      expect(await refundItems()).toMatchObject([{ kind: 'refund', id: sent?.id, outcome: 'refund_failed', reason: 'refund_failed_later' }])
      // As R2 owes a part that never went on a live booking: price_paid and what is owed both up by it.
      expect(await booking(bookingId)).toMatchObject({ price_paid: '40.00', part_refunded_amount: '30.00', refund_owed_amount: '30.00' })
      expect((await bookingLines(bookingId)).map((line) => line.card_refunded_amount)).toEqual(['0'])
      expect((await figures(bookingId)).body.data).toMatchObject({ refundOwed: 30, cardLeft: 40 })
      // Reconcile twice more (and twice at once): the money goes back once.
      await Promise.all([runReconcile(), runReconcile()])
      expect(await refundItems()).toEqual([])
      expect(await booking(bookingId)).toMatchObject({ price_paid: '40.00', refund_owed_amount: '30.00' })
      expect(await watchStates()).toEqual(['failed', 'watching'])
      expect((await auditRows('booking.refund_failed_later')).map((row) => row.details)).toEqual([
        { claimId: expect.any(String), refundId: sent?.id, paymentIntentId: sent?.payment_intent, amount: 30, owed: 30, status: 'failed' },
      ])
      expect(await storeCredit()).toEqual([])
      expect(refundCalls(stripe)).toHaveLength(1)

      // The stuck list's new line, with what to do.
      const listed = (await stuckList(db)).watched
      expect(listed).toMatchObject([
        { refundId: sent?.id, on: 'booking', bookingId, orderId: null, customerName: 'Sam Test', amount: 30, owed: 30, state: 'failed', words: WATCH_WORDS.bookingFailed(30, sent?.id as string) },
      ])
      expect(listed[0]?.words).toBe(
        `A card refund of £30.00 on this booking (${sent?.id}) was accepted by Stripe and then failed, so the money never reached the customer. It is back on the booking as money still to refund: open the booking and use Refund the rest (choose store credit if the card can't take a refund). Then press Mark sorted (needs the Issue refunds permission).`
      )
      expect(listed[0]?.close).toEqual({ kind: 'refund_watch', orderId: listed[0]?.watchId })

      // Staff decide: Refund the rest, to the card again (the payment can take it: the failed refund never left it).
      const rest = await refund('owed', bookingId, { amount: 30, refundMethod: 'card' })
      expect(rest.body.data).toMatchObject({ cardRefundedAmount: 30, storeCreditRefundedAmount: 0, pricePaid: 10 })
      expect(await booking(bookingId)).toMatchObject({ price_paid: '10.00', refund_owed_amount: '0.00' })
      expect(stripe.refundedPence).toBe(3000)
      const keys = refundCalls(stripe).map((call) => call.idempotencyKey)
      expect(new Set(keys).size).toBe(2)

      // Mark sorted takes the line off the list; a second press is "already closed".
      expect((await close('refund_watch', listed[0]?.watchId as string)).body.data).toMatchObject({ closed: true, kind: 'refund_watch', message: 'Marked as sorted. It is no longer listed.' })
      expect((await stuckList(db)).watched).toEqual([])
      expect((await close('refund_watch', listed[0]?.watchId as string)).body.data).toMatchObject({ closed: true, alreadyClosed: true })
      // W32a: the second `watching` is Refund the rest's own refund (answered succeeded), watched like any other.
      expect(await watchStates()).toEqual(['failed', 'sorted', 'watching', 'watching'])
    })
  })

  it('two card parts, both pending: the one that fails is owed, the one that goes through is left as recorded', async () => {
    await onABooking(
      async ({ bookingId, stripe }) => {
        // £50: Bea's £20 order first (newest), then £30 of the first order's £40.
        await pendingPartRefund(bookingId, stripe, 50)
        expect(stripe.refundsSent.map((sent) => [sent.amount, sent.status])).toEqual([
          [2000, 'pending'],
          [3000, 'pending'],
        ])
        expect(await watchRows()).toHaveLength(2)
        stripe.settleRefund(stripe.refundsSent[0]?.id as string, 'canceled')
        stripe.settleRefund(stripe.refundsSent[1]?.id as string, 'succeeded')
        const items = await refundItems()
        // W32a: the one that went through is no item, and stays watched (read once a day) until its days are up.
        expect(items.map((item) => item.outcome).sort()).toEqual(['refund_failed'])
        expect(await watchStates()).toEqual(['failed', 'watching', 'watching'])
        // Oldest line first: the first order keeps its £30; Bea's line gives its £20 back to "card left".
        expect((await bookingLines(bookingId)).map((line) => line.card_refunded_amount)).toEqual(['30', '0'])
        expect(await booking(bookingId)).toMatchObject({ price_paid: '30.00', part_refunded_amount: '50.00', refund_owed_amount: '20.00' })
        expect((await stuckList(db)).watched).toMatchObject([{ amount: 20, owed: 20, state: 'failed' }])
        expect(refundCalls(stripe)).toHaveLength(2)
      },
      { guests: 1 }
    )
  })

  it("a claim reconcile finished (the press's answers were lost): the refund it found pending is watched too, and its failure is owed", async () => {
    await onABooking(async ({ bookingId, stripe }) => {
      stripe.refundsStayPending = true
      stripe.failNext('refunds.create', { kind: 'lost_response' })
      stripe.failNext('refunds.create', { kind: 'lost_response' })
      const held = await refund('part', bookingId, { amount: 30, refundMethod: 'card', reason: 'Goodwill' })
      stripe.refundsStayPending = false
      expect(held.body.data?.held).toMatchObject({ reason: 'refund_unconfirmed' })
      expect(await watchRows()).toEqual([])
      pastTheWindow()
      await runReconcile()
      const sent = stripe.refundsSent[0]
      expect((await auditRows('booking.refund_finished'))[0]?.details).toMatchObject({ outcome: 'given', cardRefunded: 30, refunds: [{ refundId: sent?.id, status: 'pending' }], by: { how: 'reconcile' } })
      expect(await watchRows()).toMatchObject([{ state: 'watching', refundId: sent?.id, on: 'booking', subjectId: bookingId }])
      stripe.settleRefund(sent?.id as string, 'failed')
      await runReconcile()
      expect(await booking(bookingId)).toMatchObject({ price_paid: '40.00', refund_owed_amount: '30.00' })
      expect(stripe.refundsSent).toHaveLength(1)
    })
  })

  it('50 days (W32a, lead call 2; W32: 30, call L7): a refund still pending then ends the watch with a line for a person; the booking is left as recorded; Mark sorted closes it', async () => {
    await onABooking(async ({ bookingId, stripe }) => {
      await pendingPartRefund(bookingId, stripe, 30)
      const sent = stripe.refundsSent[0]
      // Day 49 (past Stripe's own 45): still watched, still nothing for a person.
      vi.setSystemTime(Date.now() + 49 * 24 * 60 * 60_000)
      expect(await runReconcile()).toMatchObject({ left: 0, refundsWaiting: 1, items: [] })
      expect(await watchStates()).toEqual(['watching'])
      vi.setSystemTime(Date.now() + 2 * 24 * 60 * 60_000)
      expect(await refundItems()).toMatchObject([{ kind: 'refund', id: sent?.id, outcome: 'refund_failed', reason: 'watch_expired' }])
      expect(await watchStates()).toEqual(['expired', 'watching'])
      expect(await booking(bookingId)).toMatchObject({ price_paid: '10.00', refund_owed_amount: '0.00' })
      const listed = (await stuckList(db)).watched
      expect(listed).toMatchObject([{ refundId: sent?.id, state: 'expired', owed: 0, words: WATCH_WORDS.expired(30, sent?.id as string) }])
      expect(listed[0]?.words).toContain('has been waiting at Stripe for more than 50 days, so the automatic check has stopped watching it')
      // W32a (W32 review S5): what to do while Stripe still shows it pending.
      expect(listed[0]?.words).toContain("If Stripe still shows it pending, don't give anything back: tell a manager and leave this line until Stripe says how it ended.")
      // The watch is over: a later run reads nothing, even if Stripe then fails it (a person is on it).
      stripe.settleRefund(sent?.id as string, 'failed')
      expect(await refundItems()).toEqual([])
      expect(await booking(bookingId)).toMatchObject({ refund_owed_amount: '0.00' })
      expect((await close('refund_watch', listed[0]?.watchId as string)).body.data).toMatchObject({ closed: true })
      expect((await stuckList(db)).watched).toEqual([])
    })
  })

  it('a refund that fails on the day the watch would run out is still put back as owed (Stripe\'s answer comes first)', async () => {
    await onABooking(async ({ bookingId, stripe }) => {
      await pendingPartRefund(bookingId, stripe, 30)
      stripe.settleRefund(stripe.refundsSent[0]?.id as string, 'failed')
      vi.setSystemTime(Date.now() + (WATCH_DAYS + 1) * 24 * 60 * 60_000)
      expect(await refundItems()).toMatchObject([{ outcome: 'refund_failed', reason: 'refund_failed_later' }])
      expect(await booking(bookingId)).toMatchObject({ price_paid: '40.00', refund_owed_amount: '30.00' })
    })
  })

  it("the other Stripe mode: nothing is concluded from a key that can't see the refund", async () => {
    await onABooking(async ({ bookingId, stripe }) => {
      await pendingPartRefund(bookingId, stripe, 30)
      stripe.keyLivemode = true
      const lists = stripe.calls.filter((call) => call.method === 'refunds.list').length
      // W32a: no item; the look is kept with the last status known.
      expect(await refundItems()).toEqual([])
      expect(stripe.calls.filter((call) => call.method === 'refunds.list')).toHaveLength(lists)
      expect(await watchStates()).toEqual(['watching'])
      expect(await checkedRows()).toMatchObject([{ status: 'pending', reason: 'other_mode' }])
      stripe.keyLivemode = false
    })
  })

  it('Mark sorted is refused for a watch that is still going: nothing is changed', async () => {
    await onABooking(async ({ bookingId, stripe }) => {
      await pendingPartRefund(bookingId, stripe, 30)
      const watchId = (await auditRows('refund.watch'))[0]?.id as string
      expect((await close('refund_watch', watchId)).body.data).toMatchObject({ closed: false, reason: 'not_listed' })
      expect(await watchStates()).toEqual(['watching'])
    })
  })

  it('a failure waits while another refund on the booking is open (held), and is put back once that one is settled', async () => {
    await onABooking(async ({ bookingId, stripe }) => {
      await pendingPartRefund(bookingId, stripe, 10)
      const first = stripe.refundsSent[0]
      // A second Part refund whose answers are lost: its claim is open, holding the booking.
      stripe.failNext('refunds.create', { kind: 'lost_response' })
      stripe.failNext('refunds.create', { kind: 'lost_response' })
      const held = await refund('part', bookingId, { amount: 10, refundMethod: 'card', reason: 'Goodwill' })
      expect(held.body.data?.held).toMatchObject({ reason: 'refund_unconfirmed' })
      stripe.settleRefund(first?.id as string, 'failed')
      // W32a: no item while it waits; the read is kept as failed, so the next run looks again.
      expect(await refundItems()).toEqual([])
      expect(await checkedRows()).toMatchObject([{ refundId: first?.id, status: 'failed', reason: 'refund_open' }])
      expect(await booking(bookingId)).toMatchObject({ price_paid: '20.00', refund_owed_amount: '0.00' })
      expect(await watchStates()).toEqual(['watching'])
      // Past the window the run settles the held claim (its refund went), then, last, puts the failed £10 back.
      pastTheWindow()
      await runReconcile()
      expect(await booking(bookingId)).toMatchObject({ price_paid: '30.00', part_refunded_amount: '20.00', refund_owed_amount: '10.00' })
      // W32a: the second `watching` is the held claim's own refund, which reconcile found gone (succeeded) and has watched.
      expect(await watchStates()).toEqual(['failed', 'watching', 'watching'])
      expect(stripe.refundsSent).toHaveLength(2)
    })
  })

  it('the same watch read twice from one list (two runs that both read it before either wrote): put back once', async () => {
    await onABooking(async ({ bookingId, stripe }) => {
      await pendingPartRefund(bookingId, stripe, 30)
      stripe.settleRefund(stripe.refundsSent[0]?.id as string, 'failed')
      const [due] = await db.query<WatchDue>(WATCHES_DUE_SQL, [WATCH_DAYS, WATCH_READ_HOURS, 50])
      const by = { actor: { type: 'system' as const, id: null }, requestId: 'w32-twice' }
      const answers = await Promise.all([checkWatchedRefund(db, stripe, due as WatchDue, by, undefined), checkWatchedRefund(db, stripe, due as WatchDue, by, undefined)])
      expect(answers.map((answer) => answer.outcome).sort()).toEqual(['ended_elsewhere', 'failed'])
      expect(await checkWatchedRefund(db, stripe, due as WatchDue, by, undefined)).toEqual({ outcome: 'ended_elsewhere' })
      expect(await booking(bookingId)).toMatchObject({ price_paid: '40.00', refund_owed_amount: '30.00' })
      expect(await watchStates()).toEqual(['failed', 'watching'])
    })
  })

  it('a claim closed by hand: the part reconcile found gone, still pending at Stripe, is watched from the close, and its failure is owed with the rest', async () => {
    await onABooking(
      async ({ bookingId, stripe }) => {
        // £50 to the card: part A (Bea's £20) is taken by Stripe as pending and its answer lost; part B (£30) is never sent.
        stripe.refundsStayPending = true
        stripe.failNext('refunds.create', { kind: 'lost_response' })
        stripe.failNext('refunds.create', { kind: 'lost_response' })
        const held = await refund('part', bookingId, { amount: 50, refundMethod: 'card', reason: 'Goodwill' })
        stripe.refundsStayPending = false
        const claimId = held.body.data?.held?.claimId ?? ''
        const claim = await readClaim(db, claimId)
        const [partA, partB] = claim?.details.plan.card ?? []
        // By hand in Stripe: a £10 refund naming the claim on B's payment, so reconcile leaves the claim for a person.
        await stripe.refunds.create({ payment_intent: partB?.paymentIntentId ?? '', amount: 1000, metadata: { claim_id: claimId } })
        pastTheWindow()
        await runReconcile()
        expect(await watchRows()).toEqual([])
        expect((await close('held_claim', claimId)).body.data).toMatchObject({ closed: true })
        const refundA = stripe.refundsSent.find((sent) => sent.payment_intent === partA?.paymentIntentId)
        expect((await auditRows('booking.refund_finished'))[0]?.details).toMatchObject({ outcome: 'owed', cardRefunded: 20, owed: 30, refunds: [{ orderId: partA?.orderId, refundId: refundA?.id, status: 'pending', amount: 20 }], by: { how: 'close' } })
        expect(await watchRows()).toMatchObject([{ state: 'watching', refundId: refundA?.id, amount: 20 }])
        expect(await booking(bookingId)).toMatchObject({ refund_owed_amount: '30.00' })
        stripe.settleRefund(refundA?.id as string, 'failed')
        await runReconcile()
        expect(await booking(bookingId)).toMatchObject({ refund_owed_amount: '50.00' })
        expect((await bookingLines(bookingId)).map((line) => line.card_refunded_amount)).toEqual(['0', '0'])
      },
      { guests: 1 }
    )
  })
})
