import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { POST as partRoute } from '@/app/api/v1/staff/bookings/[bookingId]/refunds/route'
import { POST as owedRoute } from '@/app/api/v1/staff/bookings/[bookingId]/refunds/owed/route'
import { POST as quoteRoute } from '@/app/api/v1/staff/bookings/guests/[guestId]/remove/quote/route'
import { POST as removeRoute } from '@/app/api/v1/staff/bookings/guests/[guestId]/remove/route'
import { POST as closeRoute } from '@/app/api/v1/staff/orders/stuck/close/route'
import type { Db } from '@/server/db'
import { reconcile } from '@/server/rules/orders/reconcile'
import { stuckList } from '@/server/rules/orders/stuck-list'
import { oldSide, replay, REPLAY_USER, startReplay, type ReplayEnvironment, type ScenarioContext } from '@/server/rules/testing/replay/harness'
import { bea, ID, paidSeat, sam, seed, tieredPrivatePrices, whileFailing, refundCreditFails, type WriteFailure } from '@/server/rules/testing/replay/scenarios'
import { replayStripe } from '@/server/rules/testing/replay/stripe-binding'
import { BOOKING_KINDS_ON } from '@/server/rules/testing/replay/booking-side'
import { fakeStripeErrors, type FakeStripe } from '@/server/stripe/fake'
import {
  AMOUNT_CHANGED_MESSAGE,
  BOOKING_PATH_OFF_MESSAGE,
  CARD_PAYMENT_OPEN_MESSAGE,
  CHANGE_REFUND_UNCONFIRMED_MESSAGE,
  READER_PAYMENT_OPEN_MESSAGE,
  REFUND_OPEN_MESSAGE,
  REMOVE_GUEST_NOT_SAVED_MESSAGE,
  putBackBlockedMessage,
  refundGoneNotRecordedMessage,
  refundRefusedDetail,
} from './failure-messages'
import { claimRefundKey } from './refunds'

// Brief W22 item 1: Remove Guest on the Worker, through W21's refund pipeline, on the replay's live schema (its
// triggers and the store credit function included), through the routes as the staff app calls them. The bookings and
// their guests are made by the old functions (the frozen copy), as the golden scenarios make them. Stripe is only ever
// the fake.

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

type Context = ScenarioContext & { bookingId: string; guestId: string }

/**
 * A public booking for two on the card (£40), and Bea added on the card (£20, her own order): Sam, Alex and Bea. With
 * `privateBooking`, a private hire for two (£100, tiered) with Bea added on the card (the tier difference).
 */
async function withAGuest(work: (context: Context) => Promise<void>, { privateBooking = false, guestPayment = { method: 'card' } as Record<string, unknown> } = {}): Promise<void> {
  await replay(
    environment,
    {
      name: 'w22 remove guest',
      seed,
      async run(context) {
        replayStripe.current = context.stripe
        if (privateBooking) await tieredPrivatePrices(context.db)
        const seats = paidSeat([sam, { name: 'Alex Guest', email: 'alex@example.com' }])
        const placed = (await context.call('createOrder', {
          customerId: ID.customer,
          booking: privateBooking ? { ...seats, sessionId: ID.privateSession } : seats,
          payment: { method: 'card' },
        })) as { bookingId: string }
        const bookingId = placed.bookingId
        await context.call('addBookingGuest', { bookingId, ...bea })
        await context.call('addBookingGuest', { bookingId, ...bea, payment: guestPayment })
        vi.setSystemTime(Date.now() + 1000)
        const guestId = (await context.db.query<{ id: string }>("SELECT id FROM booking_guests WHERE booking_id = $1 AND guest_name = 'Bea Guest'", [bookingId]))[0]?.id ?? ''
        try {
          await work({ ...context, bookingId, guestId })
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
    data?: Record<string, unknown> & { held?: { claimId: string; reason: string; message: string }; quote?: Record<string, unknown> }
    error?: { code: string; message: string; details?: Record<string, unknown> & { reason?: string; message?: string } }
  }
}

async function call(route: typeof removeRoute, url: string, params: Record<string, string>, body: unknown, { key = crypto.randomUUID(), orderSwitch = BOOKING_KINDS_ON, email = REPLAY_USER.email } = {}): Promise<Answer> {
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

const quote = (guestId: string) => call(quoteRoute, `/api/v1/staff/bookings/guests/${guestId}/remove/quote`, { guestId }, {})
const remove = (guestId: string, body: Record<string, unknown>, options: Parameters<typeof call>[4] = {}) =>
  call(removeRoute, `/api/v1/staff/bookings/guests/${guestId}/remove`, { guestId }, body, options)
const partRefund = (bookingId: string, body: Record<string, unknown>) => call(partRoute, `/api/v1/staff/bookings/${bookingId}/refunds`, { bookingId }, body)
const refundTheRest = (bookingId: string, body: Record<string, unknown>) => call(owedRoute, `/api/v1/staff/bookings/${bookingId}/refunds/owed`, { bookingId }, body)

const runReconcile = () => reconcile(db, replayStripe.current as FakeStripe, { actor: { type: 'system', id: null }, requestId: crypto.randomUUID(), maxItems: 50, budgetMs: 60_000 })
const pastTheWindow = () => vi.setSystemTime(Date.now() + 16 * 60_000)

async function booking(bookingId: string) {
  return (
    await db.query<{ price_paid: string; party_size: number; refund_owed_amount: string; total_booked: number }>(
      `SELECT b.price_paid::text AS price_paid, b.party_size, b.refund_owed_amount::text AS refund_owed_amount, s.total_booked
       FROM bookings b JOIN sessions s ON s.id = b.session_id WHERE b.id = $1`,
      [bookingId]
    )
  )[0]
}
const guestRow = async (guestId: string) => (await db.query<Record<string, unknown>>('SELECT to_jsonb(g) AS row FROM booking_guests g WHERE id = $1', [guestId]))[0]?.['row']
const bookingLines = async (bookingId: string) =>
  db.query<{ order_id: string; card_refunded_amount: string; refunded_at: unknown; refund_method: string | null }>(
    "SELECT order_id, card_refunded_amount::text AS card_refunded_amount, refunded_at, refund_method FROM order_line_items WHERE booking_id = $1 AND item_type = 'booking' ORDER BY created_at",
    [bookingId]
  )
const creditRefunds = async () => db.query<{ amount: string; note: string; order_id: string | null }>("SELECT amount::text AS amount, note, order_id FROM store_credit_transactions WHERE reason = 'refund' ORDER BY created_at")
const refundCalls = (stripe: FakeStripe) => stripe.calls.filter((call) => call.method === 'refunds.create')
const auditRows = async (action: string) => db.query<{ id: string; details: Record<string, unknown> }>('SELECT id, details FROM audit_log WHERE action = $1 ORDER BY at', [action])

describe('Remove Guest: the quote (W22)', () => {
  it("the seat's price, the account holder blocked, a guest gone, and nothing changed", async () => {
    await withAGuest(async ({ bookingId, guestId }) => {
      const answer = await quote(guestId)
      expect(answer.body.data).toEqual({ removed: false, blocked: false, guestId, quote: { bookingId, bookingType: 'public', refundAmount: 20, refundable: true, insideTwentyFourHours: false, partySize: 3 } })
      const holderId = (await db.query<{ id: string }>("SELECT id FROM booking_guests WHERE booking_id = $1 AND guest_type = 'account_holder'", [bookingId]))[0]?.id ?? ''
      expect((await quote(holderId)).body.data).toEqual({ removed: false, blocked: true, guestId: holderId })
      const gone = await quote(crypto.randomUUID())
      expect(gone.body.error?.details).toMatchObject({ reason: 'guest_not_found', message: 'This guest has already been removed.', screenWords: true })
      expect(await booking(bookingId)).toMatchObject({ price_paid: '60.00', party_size: 3 })
    })
  })

  it("Q38: a private hire's guest refunds £0, even when removing them drops the tier (Part refund instead)", async () => {
    await withAGuest(
      async ({ bookingId, guestId, stripe }) => {
        expect((await quote(guestId)).body.data?.quote).toMatchObject({ bookingType: 'private', refundAmount: 0, refundable: false })
        const answer = await remove(guestId, { confirmedRefundAmount: 0 })
        expect(answer.body.data).toMatchObject({ removed: true, refundedAmount: 0, cardRefundedAmount: 0, storeCreditRefundedAmount: 0 })
        expect(refundCalls(stripe)).toEqual([])
        expect(await auditRows('booking.refund_claimed')).toEqual([])
        // A private hire holds its whole session: no place goes back.
        expect(await booking(bookingId)).toMatchObject({ party_size: 2 })
        expect((await auditRows('booking.guest_remove'))[0]?.details).toEqual({ guestId, refundAmount: 0, method: null, cardRefunded: 0, storeCreditRefunded: 0, owed: 0 })
      },
      { privateBooking: true }
    )
  })
})

describe('Remove Guest: the removal (W22)', () => {
  it('to the card: R1 deletes the guest, releases the place, lowers the party size and price paid; one refund keyed from the claim; the line stamped', async () => {
    await withAGuest(async ({ bookingId, guestId, stripe }) => {
      const before = await booking(bookingId)
      const answer = await remove(guestId, { confirmedRefundAmount: 20, refundMethod: 'card' })
      expect(answer.body.data).toEqual({ removed: true, blocked: false, guestId, refundedAmount: 20, cardRefundedAmount: 20, storeCreditRefundedAmount: 0 })
      expect(await guestRow(guestId)).toBeUndefined()
      expect(await booking(bookingId)).toMatchObject({ price_paid: '40.00', party_size: 2, total_booked: (before?.total_booked ?? 0) - 1 })
      const claim = (await auditRows('booking.refund_claimed'))[0]
      expect(claim?.details).toMatchObject({ kind: 'remove_guest', amount: 20, method: 'card', worker: true, guest: { id: guestId, name: 'Bea Guest', seatPrice: 20, placeReleased: true } })
      const lines = await bookingLines(bookingId)
      // Bea's own order (the newest) takes it; her line is stamped.
      expect(refundCalls(stripe).map((call) => [(call.params as { amount: number }).amount, call.idempotencyKey])).toEqual([[2000, claimRefundKey(claim?.id ?? '', lines[1]?.order_id ?? '')]])
      expect(lines.map((line) => [line.card_refunded_amount, line.refund_method])).toEqual([
        ['0', null],
        ['20', 'card'],
      ])
      expect((await auditRows('booking.guest_remove'))[0]?.details).toEqual({ guestId, refundAmount: 20, method: 'card', cardRefunded: 20, storeCreditRefunded: 0, owed: 0 })
      expect((await auditRows('booking.refund_finished'))[0]?.details).toMatchObject({ outcome: 'given', cardRefunded: 20, owed: 0 })
    })
  })

  it("to store credit: one transaction, nothing sent to Stripe, the old note and the booking's own order", async () => {
    await withAGuest(async ({ bookingId, guestId, stripe }) => {
      const answer = await remove(guestId, { confirmedRefundAmount: 20, refundMethod: 'credit' })
      expect(answer.body.data).toMatchObject({ removed: true, cardRefundedAmount: 0, storeCreditRefundedAmount: 20 })
      expect(typeof answer.body.data?.['storeCreditBalance']).toBe('number')
      expect(refundCalls(stripe)).toEqual([])
      const credit = (await creditRefunds())[0]
      expect(credit?.amount).toBe('20.00')
      expect(credit?.note).toMatch(/^Refund for a guest removed from the booking \(Bea Guest\)\. \[ref /)
      expect(credit?.order_id).toBe((await bookingLines(bookingId))[0]?.order_id)
      expect((await auditRows('booking.refund_claimed'))[0]?.details).not.toHaveProperty('guest.restore')
    })
  })

  it('Q18 at half a penny (the old code allowed a penny): a penny off is refused with the new quote; half a penny passes', async () => {
    await withAGuest(async ({ bookingId, guestId }) => {
      const penny = await remove(guestId, { confirmedRefundAmount: 20.01, refundMethod: 'credit' })
      expect(penny.status).toBe(409)
      expect(penny.body.error?.details).toMatchObject({ reason: 'refund_amount_mismatch', message: AMOUNT_CHANGED_MESSAGE, quote: { refundAmount: 20 } })
      expect(await guestRow(guestId)).toBeDefined()
      const under = await remove(guestId, { confirmedRefundAmount: 19.99, refundMethod: 'credit' })
      expect(under.body.error?.details?.reason).toBe('refund_amount_mismatch')
      const half = await remove(guestId, { confirmedRefundAmount: 20.005, refundMethod: 'credit' })
      expect(half.body.data).toMatchObject({ removed: true, storeCreditRefundedAmount: 20 })
      expect(await booking(bookingId)).toMatchObject({ price_paid: '40.00' })
    })
  })

  it('the first card refund refused: the guest comes back exactly as they were, with their place and money; the old words; the next press is a new claim', async () => {
    await withAGuest(async ({ bookingId, guestId, stripe }) => {
      const row = await guestRow(guestId)
      const before = await booking(bookingId)
      stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
      const refused = await remove(guestId, { confirmedRefundAmount: 20, refundMethod: 'card' })
      expect(refused.status).toBe(402)
      const given = 'The card refund failed, so nothing was refunded: Failed to refund payment: Your card was declined.'
      expect(refused.body.error?.details).toMatchObject({
        reason: `refund_failed: ${given}`,
        message: `The refund didn't go through, so the guest hasn't been removed. Please try again. (${given})`,
      })
      expect(await guestRow(guestId)).toEqual(row)
      expect(await booking(bookingId)).toEqual(before)
      expect((await auditRows('booking.refund_finished'))[0]?.details).toMatchObject({ outcome: 'put_back', cardRefunded: 0, owed: 0 })
      expect(await auditRows('booking.guest_remove')).toEqual([])
      const again = await remove(guestId, { confirmedRefundAmount: 20, refundMethod: 'card' })
      expect(again.body.data).toMatchObject({ removed: true, cardRefundedAmount: 20 })
      const keys = refundCalls(stripe).map((call) => call.idempotencyKey)
      expect(new Set(keys).size).toBe(2)
    })
  })

  it("W25a (W25 review L5): the first card refund refused after the guest's place was taken again: the guest stays removed (the session never one over), the £20 still to refund on the booking there and then, with Stripe's reason; Refund the rest gives it", async () => {
    await withAGuest(async ({ bookingId, guestId, stripe }) => {
      const capacity = (await db.query<{ capacity: number }>('SELECT capacity FROM sessions WHERE id = $1', [ID.session]))[0]?.capacity ?? 0
      // Another booking takes every free place (the guest's included) between R1 and the card's answer.
      const create = stripe.refunds.create
      stripe.refunds.create = (async (...args: Parameters<typeof create>) => {
        await db.query('UPDATE sessions SET total_booked = capacity WHERE id = $1', [ID.session])
        return create(...args)
      }) as typeof create
      stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
      const answer = await remove(guestId, { confirmedRefundAmount: 20, refundMethod: 'card' })
      expect(answer.status).toBe(200)
      expect(answer.body.data).toMatchObject({
        removed: true,
        refundedAmount: 0,
        cardRefundedAmount: 0,
        storeCreditRefundedAmount: 0,
        held: { reason: 'refund_refused_not_put_back', message: putBackBlockedMessage(refundRefusedDetail('Your card was declined.'), 20, false) },
      })
      // Nothing of the undo is kept: the guest gone, the party of two, the session full and not one over.
      expect(await guestRow(guestId)).toBeUndefined()
      expect(await booking(bookingId)).toMatchObject({ price_paid: '60.00', refund_owed_amount: '20.00', party_size: 2, total_booked: capacity })
      expect((await auditRows('booking.refund_finished'))[0]?.details).toMatchObject({ outcome: 'owed', cardRefunded: 0, owed: 20, by: { how: 'undo_blocked', why: refundRefusedDetail('Your card was declined.') } })
      expect((await auditRows('booking.guest_remove'))[0]?.details).toMatchObject({ guestId, cardRefunded: 0, storeCreditRefunded: 0, owed: 20 })
      expect(await creditRefunds()).toEqual([])
      // Reconcile has nothing to do for it; Refund the rest sends it to the card.
      pastTheWindow()
      expect((await runReconcile()).items.filter((item) => item.kind === 'claim')).toEqual([])
      const rest = await refundTheRest(bookingId, { amount: 20, refundMethod: 'card' })
      expect(rest.body.data).toMatchObject({ cardRefundedAmount: 20, pricePaid: 40 })
      expect(await booking(bookingId)).toMatchObject({ refund_owed_amount: '0.00', total_booked: capacity })
    })
  })

  it('a later card part refused: it goes to store credit (today\'s rule), with the old warning; the guest stays removed', async () => {
    await withAGuest(async ({ bookingId, guestId, stripe }) => {
      // A £10 part refund takes Bea's order down to £10, so her £20 seat is £10 from her order and £10 from the first.
      expect((await partRefund(bookingId, { amount: 10, refundMethod: 'card', reason: 'Goodwill' })).body.data).toMatchObject({ cardRefundedAmount: 10 })
      stripe.failNext('refunds.create', { kind: 'none' })
      stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
      const answer = await remove(guestId, { confirmedRefundAmount: 20, refundMethod: 'card' })
      expect(answer.body.data).toMatchObject({
        removed: true,
        cardRefundedAmount: 10,
        storeCreditRefundedAmount: 10,
        warning: 'A further card refund of £10.00 failed (Failed to refund payment: Your card was declined.), so the rest went to store credit.',
      })
      expect((await creditRefunds()).at(-1)?.note).toMatch(/^Refund for a guest removed from the booking \(Bea Guest\) \(the rest went back to the card\)\. \[ref /)
      expect(await guestRow(guestId)).toBeUndefined()
      expect(await booking(bookingId)).toMatchObject({ price_paid: '30.00', party_size: 2 })
    })
  })

  it('no clear answer, and Stripe has it: the guest stays removed, held (Q35); reconcile records it and stamps the line; never resent', async () => {
    await withAGuest(async ({ bookingId, guestId, stripe }) => {
      stripe.failNext('refunds.create', { kind: 'lost_response' })
      stripe.failNext('refunds.create', { kind: 'lost_response' })
      const answer = await remove(guestId, { confirmedRefundAmount: 20, refundMethod: 'card' })
      expect(answer.body.data).toMatchObject({ removed: true, held: { reason: 'refund_unconfirmed', message: CHANGE_REFUND_UNCONFIRMED_MESSAGE } })
      expect(await guestRow(guestId)).toBeUndefined()
      expect(await booking(bookingId)).toMatchObject({ price_paid: '40.00', party_size: 2 })
      // The held refund holds every other refund, and a removal, on the booking.
      expect((await partRefund(bookingId, { amount: 5, refundMethod: 'credit', reason: 'x' })).body.error?.details?.reason).toBe('refund_open')
      pastTheWindow()
      expect((await stuckList(db)).claims).toMatchObject([{ bookingId, amount: 20 }])
      const sent = refundCalls(stripe).length
      expect((await runReconcile()).items.filter((item) => item.kind === 'claim')).toMatchObject([{ outcome: 'finalised' }])
      expect(refundCalls(stripe)).toHaveLength(sent)
      expect((await bookingLines(bookingId)).map((line) => [line.card_refunded_amount, line.refund_method])).toEqual([
        ['0', null],
        ['20', 'card'],
      ])
      expect((await auditRows('booking.guest_remove'))[0]?.details).toMatchObject({ refundAmount: 20, cardRefunded: 20, owed: 0 })
      expect(await booking(bookingId)).toMatchObject({ price_paid: '40.00', refund_owed_amount: '0.00' })
    })
  })

  it('no clear answer, and Stripe never got it: the guest stays removed; reconcile puts the £20 on the booking as owed (line not stamped); Refund the rest gives it', async () => {
    await withAGuest(async ({ bookingId, guestId, stripe }) => {
      stripe.failNext('refunds.create', { kind: 'unreachable' })
      stripe.failNext('refunds.create', { kind: 'unreachable' })
      expect((await remove(guestId, { confirmedRefundAmount: 20, refundMethod: 'card' })).body.data?.held?.reason).toBe('refund_unconfirmed')
      pastTheWindow()
      const sent = refundCalls(stripe).length
      await runReconcile()
      expect(refundCalls(stripe)).toHaveLength(sent)
      expect(await guestRow(guestId)).toBeUndefined()
      expect(await booking(bookingId)).toMatchObject({ price_paid: '60.00', refund_owed_amount: '20.00', party_size: 2 })
      expect((await bookingLines(bookingId)).map((line) => line.refund_method)).toEqual([null, null])
      expect((await auditRows('booking.refund_finished'))[0]?.details).toMatchObject({ outcome: 'owed', cardRefunded: 0, owed: 20 })
      const rest = await refundTheRest(bookingId, { amount: 20, refundMethod: 'card' })
      expect(rest.body.data).toMatchObject({ cardRefundedAmount: 20, pricePaid: 40 })
    })
  })

  it("the card went and R2's store credit couldn't be written: held, never sent again; reconcile records the card and gives the store credit", async () => {
    await withAGuest(async ({ bookingId, guestId, stripe }) => {
      expect((await partRefund(bookingId, { amount: 10, refundMethod: 'card', reason: 'Goodwill' })).body.data).toMatchObject({ cardRefundedAmount: 10 })
      // Bea's order has £10 left on its card; the first order's card is refused, so R2's store credit takes £10, and fails.
      stripe.failNext('refunds.create', { kind: 'none' })
      stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
      const answer = await whileFailing(db, refundCreditFails, () => remove(guestId, { confirmedRefundAmount: 20, refundMethod: 'card' }))
      expect(answer.body.data).toMatchObject({ removed: true, cardRefundedAmount: 10, held: { reason: 'refund_not_recorded', message: refundGoneNotRecordedMessage(10) } })
      pastTheWindow()
      const sent = refundCalls(stripe).length
      await runReconcile()
      expect(refundCalls(stripe)).toHaveLength(sent)
      // Reconcile finds the £10 that went and the refused part never went: owed (D-plan 4.10), never resent.
      expect((await auditRows('booking.refund_finished')).at(-1)?.details).toMatchObject({ outcome: 'owed', cardRefunded: 10, owed: 10 })
      expect(await booking(bookingId)).toMatchObject({ price_paid: '40.00', refund_owed_amount: '10.00' })
    })
  })

  it('a held guest refund left for a person (the other Stripe mode), then closed by hand: the guest stays removed, the £20 owed on the booking', async () => {
    await withAGuest(async ({ bookingId, guestId, stripe }) => {
      stripe.failNext('refunds.create', { kind: 'unreachable' })
      stripe.failNext('refunds.create', { kind: 'unreachable' })
      const claimId = (await remove(guestId, { confirmedRefundAmount: 20, refundMethod: 'card' })).body.data?.held?.claimId ?? ''
      await db.query("UPDATE audit_log SET details = jsonb_set(details, '{livemode}', 'true') WHERE id = $1", [claimId])
      pastTheWindow()
      expect((await runReconcile()).items.filter((item) => item.kind === 'claim')).toMatchObject([{ outcome: 'left', reason: 'other_mode' }])
      expect((await stuckList(db)).claims).toMatchObject([{ reason: 'other_mode', close: { kind: 'held_claim', orderId: claimId } }])
      const response = await closeRoute(
        new Request('https://worker.test/api/v1/staff/orders/stuck/close', {
          method: 'POST',
          headers: { authorization: `Bearer ${KEY}`, 'x-staff-email': REPLAY_USER.email, 'idempotency-key': crypto.randomUUID(), 'content-type': 'application/json' },
          body: JSON.stringify({ kind: 'held_claim', orderId: claimId, reason: 'Checked in Stripe by hand' }),
        })
      )
      expect(((await response.json()) as Answer['body']).data).toMatchObject({ closed: true, kind: 'held_claim' })
      expect(await guestRow(guestId)).toBeUndefined()
      expect(await booking(bookingId)).toMatchObject({ price_paid: '60.00', refund_owed_amount: '20.00', party_size: 2 })
      expect((await auditRows('booking.guest_remove'))[0]?.details).toMatchObject({ refundAmount: 20, cardRefunded: 0, owed: 20 })
      expect((await stuckList(db)).claims).toEqual([])
    })
  })

  it('two tabs, one after the other: the second finds the guest gone; one refund, one place released', async () => {
    await withAGuest(async ({ bookingId, guestId, stripe }) => {
      const before = await booking(bookingId)
      const first = await remove(guestId, { confirmedRefundAmount: 20, refundMethod: 'card' })
      const second = await remove(guestId, { confirmedRefundAmount: 20, refundMethod: 'card' })
      expect(first.body.data).toMatchObject({ removed: true, cardRefundedAmount: 20 })
      expect(second.body.error?.details).toMatchObject({ reason: 'guest_not_found' })
      expect(refundCalls(stripe)).toHaveLength(1)
      expect(await booking(bookingId)).toMatchObject({ price_paid: '40.00', party_size: 2, total_booked: (before?.total_booked ?? 0) - 1 })
    })
  })

  it('the same press twice (no answer, then again): one removal, one refund, the stored answer', async () => {
    await withAGuest(async ({ guestId, stripe }) => {
      const key = crypto.randomUUID()
      const first = await remove(guestId, { confirmedRefundAmount: 20, refundMethod: 'card' }, { key })
      const second = await remove(guestId, { confirmedRefundAmount: 20, refundMethod: 'card' }, { key })
      expect(second.body.data).toEqual(first.body.data)
      expect(refundCalls(stripe)).toHaveLength(1)
    })
  })

  it('refused while a refund on the booking is held, or a payment is still being taken (W18a\'s words)', async () => {
    await withAGuest(async ({ bookingId, guestId, stripe }) => {
      stripe.failNext('refunds.create', { kind: 'unreachable' })
      stripe.failNext('refunds.create', { kind: 'unreachable' })
      expect((await partRefund(bookingId, { amount: 5, refundMethod: 'card', reason: 'x' })).body.data?.held).toBeDefined()
      const open = await remove(guestId, { confirmedRefundAmount: 20, refundMethod: 'credit' })
      expect(open.body.error?.details).toMatchObject({ reason: 'refund_open', message: REFUND_OPEN_MESSAGE })
      expect(await guestRow(guestId)).toBeDefined()
    })
    await withAGuest(async ({ bookingId, guestId, call }) => {
      // A second guest on the reader: its flow is open until the reader is finished or cancelled.
      await call('addBookingGuest', { bookingId, guestName: 'Cy Guest', guestEmail: 'cy@example.com', guestsOver18Confirmed: true, payment: { method: 'reader' } })
      const reader = await remove(guestId, { confirmedRefundAmount: 20, refundMethod: 'credit' })
      expect(reader.body.error?.details).toMatchObject({ reason: 'reader_payment_open', message: READER_PAYMENT_OPEN_MESSAGE })
      // A saved-card flow held for reconcile: the card words (W18a).
      await db.query("UPDATE pending_reader_payments SET snapshot = snapshot || '{\"method\":\"card\",\"request_id\":\"r\"}'::jsonb WHERE status = 'pending'")
      const card = await remove(guestId, { confirmedRefundAmount: 20, refundMethod: 'credit' })
      expect(card.body.error?.details).toMatchObject({ reason: 'card_payment_open', message: CARD_PAYMENT_OPEN_MESSAGE })
      // The quote is a read: never refused for either.
      expect((await quote(guestId)).body.data?.quote).toMatchObject({ refundAmount: 20 })
    })
  })

  // W22a: Wayne's decision (13 Nov): Remove Guest follows the 24-hour rule, as Cancel & Refund and Remove add-on. The
  // session starts 12 Nov 10:00 (GMT), so 24 real hours before is 11 Nov 10:00Z.
  it("the 24-hour rule (Wayne's decision): outside it the seat refunds; inside it the guest goes with nothing back, the place released, no claim, no Issue refunds", async () => {
    await withAGuest(async ({ bookingId, guestId, stripe }) => {
      vi.setSystemTime(new Date('2026-11-11T09:59:00.000Z'))
      expect((await quote(guestId)).body.data?.quote).toMatchObject({ refundAmount: 20, refundable: true, insideTwentyFourHours: false })
      vi.setSystemTime(new Date('2026-11-11T10:00:00.000Z'))
      expect((await quote(guestId)).body.data?.quote).toMatchObject({ refundAmount: 20, insideTwentyFourHours: false })
      vi.setSystemTime(new Date('2026-11-11T10:01:00.000Z'))
      expect((await quote(guestId)).body.data?.quote).toEqual({ bookingId, bookingType: 'public', refundAmount: 0, refundable: true, insideTwentyFourHours: true, partySize: 3 })
      // A press with the £20 shown before the 24 hours began is refused with the new £0 quote; nothing changes.
      const stale = await remove(guestId, { confirmedRefundAmount: 20, refundMethod: 'card' })
      expect(stale.body.error?.details).toMatchObject({ reason: 'refund_amount_mismatch', message: AMOUNT_CHANGED_MESSAGE, quote: { refundAmount: 0, insideTwentyFourHours: true } })
      expect(await guestRow(guestId)).toBeDefined()
      const before = await booking(bookingId)
      // £0 goes for anyone: no Issue refunds, and the switch off.
      await db.query("INSERT INTO staff (first_name, last_name, email, role, can_issue_refunds, active) VALUES ('No', 'Refunds', 'nore@example.com', 'staff', false, true)")
      const answer = await remove(guestId, { confirmedRefundAmount: 0 }, { email: 'nore@example.com', orderSwitch: '' })
      expect(answer.body.data).toEqual({ removed: true, blocked: false, guestId, refundedAmount: 0, cardRefundedAmount: 0, storeCreditRefundedAmount: 0 })
      expect(await guestRow(guestId)).toBeUndefined()
      // The place is released and the party size lowered; the seat's £20 stays on the booking (Part refund can give it).
      expect(await booking(bookingId)).toMatchObject({ price_paid: '60.00', party_size: 2, refund_owed_amount: '0.00', total_booked: (before?.total_booked ?? 0) - 1 })
      expect(refundCalls(stripe)).toEqual([])
      expect(await creditRefunds()).toEqual([])
      expect(await auditRows('booking.refund_claimed')).toEqual([])
      expect((await bookingLines(bookingId)).map((line) => [line.refunded_at, line.refund_method])).toEqual([
        [null, null],
        [null, null],
      ])
      expect((await auditRows('booking.guest_remove'))[0]?.details).toEqual({ guestId, refundAmount: 0, method: null, cardRefunded: 0, storeCreditRefunded: 0, owed: 0, reason: 'inside_24_hours' })
      // Part refund still gives something back if staff want to.
      const part = await partRefund(bookingId, { amount: 20, refundMethod: 'card', reason: 'Guest removed inside 24 hours' })
      expect(part.body.data).toMatchObject({ cardRefundedAmount: 20 })
    })
  })

  it('inside 24 hours with the seat\'s money all gone back already (a Part refund of everything): the old rule, the line stamped, no reason named', async () => {
    await withAGuest(async ({ bookingId, guestId }) => {
      await partRefund(bookingId, { amount: 60, refundMethod: 'credit', reason: 'Goodwill' })
      vi.setSystemTime(new Date('2026-11-11T10:01:00.000Z'))
      expect((await quote(guestId)).body.data?.quote).toMatchObject({ refundAmount: 0, refundable: true, insideTwentyFourHours: true })
      expect((await remove(guestId, { confirmedRefundAmount: 0 })).body.data).toMatchObject({ removed: true, refundedAmount: 0 })
      expect((await auditRows('booking.guest_remove'))[0]?.details).toEqual({ guestId, refundAmount: 0, method: null, cardRefunded: 0, storeCreditRefunded: 0, owed: 0 })
      expect((await bookingLines(bookingId))[1]?.refunded_at).not.toBeNull()
    })
  })

  it('Issue refunds only when money goes back; the switch gates money out, never a £0 removal', async () => {
    await withAGuest(async ({ bookingId, guestId }) => {
      await db.query("INSERT INTO staff (first_name, last_name, email, role, can_issue_refunds, active) VALUES ('No', 'Refunds', 'nore@example.com', 'staff', false, true)")
      const forbidden = await remove(guestId, { confirmedRefundAmount: 20, refundMethod: 'credit' }, { email: 'nore@example.com' })
      expect(forbidden.status).toBe(403)
      expect(forbidden.body.error?.details).toMatchObject({ reason: 'no_refund_permission', blockedByRefundPermission: true, screenWords: true })
      const off = await remove(guestId, { confirmedRefundAmount: 20, refundMethod: 'card' }, { orderSwitch: 'no_stripe,saved_card' })
      expect(off.body.error).toMatchObject({ code: 'BOOKING_PATH_OFF', message: BOOKING_PATH_OFF_MESSAGE })
      expect(await guestRow(guestId)).toBeDefined()
      // A seat with nothing left to refund (all of it part refunded) goes for anyone, switch off or not.
      await partRefund(bookingId, { amount: 60, refundMethod: 'credit', reason: 'Goodwill' })
      expect((await quote(guestId)).body.data?.quote).toMatchObject({ refundAmount: 0, refundable: true })
      const free = await remove(guestId, { confirmedRefundAmount: 0 }, { email: 'nore@example.com', orderSwitch: '' })
      expect(free.body.data).toMatchObject({ removed: true, refundedAmount: 0 })
    })
  })

  it('a refund method other than the card or store credit is refused with the old words; a database fault in R1 changes nothing', async () => {
    await withAGuest(async ({ bookingId, guestId }) => {
      const method = await remove(guestId, { confirmedRefundAmount: 20, refundMethod: 'cash' })
      expect(method.body.error?.details).toMatchObject({ reason: 'refund_method_required', message: 'Choose how to refund the difference (original card or store credit).', quote: { refundAmount: 20 } })
      const deleteFails: WriteFailure = { table: 'booking_guests', event: 'DELETE', when: 'true' }
      const fault = await whileFailing(db, deleteFails, () => remove(guestId, { confirmedRefundAmount: 20, refundMethod: 'credit' }))
      expect(fault.body.error?.details).toMatchObject({ reason: 'guest_remove_not_saved', message: REMOVE_GUEST_NOT_SAVED_MESSAGE })
      expect(await guestRow(guestId)).toBeDefined()
      expect(await booking(bookingId)).toMatchObject({ price_paid: '60.00', party_size: 3 })
      expect(await creditRefunds()).toEqual([])
    })
  })
})
