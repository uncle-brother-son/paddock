import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { POST as partRoute } from '@/app/api/v1/staff/bookings/[bookingId]/refunds/route'
import { POST as quoteRoute } from '@/app/api/v1/staff/bookings/addon-lines/[lineId]/remove/quote/route'
import { POST as removeRoute } from '@/app/api/v1/staff/bookings/addon-lines/[lineId]/remove/route'
import { POST as removeGuestRoute } from '@/app/api/v1/staff/bookings/guests/[guestId]/remove/route'
import type { Db } from '@/server/db'
import { reconcile } from '@/server/rules/orders/reconcile'
import { oldSide, replay, REPLAY_USER, startReplay, type ReplayEnvironment, type ScenarioContext } from '@/server/rules/testing/replay/harness'
import { bea, ID, mo, paidSeat, sam, seed } from '@/server/rules/testing/replay/scenarios'
import { replayStripe } from '@/server/rules/testing/replay/stripe-binding'
import { BOOKING_KINDS_ON } from '@/server/rules/testing/replay/booking-side'
import { fakeStripeErrors, type FakeStripe } from '@/server/stripe/fake'
import {
  ADDON_INSIDE_24_HOURS_NOTE,
  addonMembershipNotActiveNote,
  BOOKING_PATH_OFF_MESSAGE,
  CHANGE_REFUND_UNCONFIRMED_MESSAGE,
  ISSUE_REFUNDS_NEEDED_MESSAGE,
  READER_PAYMENT_OPEN_MESSAGE,
  REFUND_OPEN_MESSAGE,
  REFUND_WORDS,
  REMOVE_ADDON_WORDS,
} from './failure-messages'
import { claimRefundKey } from './refunds'

// Brief W22 item 2: Remove add-on on the Worker, through W21's refund pipeline, on the replay's live schema, through
// the routes as the staff app calls them. The bookings and add-ons are made by the old functions (the frozen copy).
// Stripe is only ever the fake. The replay's clock is 10 Nov 2026 09:00; the booking's session is 12 Nov 10:00.

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

type Context = ScenarioContext & { bookingId: string; lineId: string }
/**
 * Where the add-on was paid: on the booking's own order (the card), on an order of its own (Add Guest's add-ons alone,
 * on the card), inside a guest's order (an older guest-and-add-on payment on the card, W05c N5), in cash on its own
 * order, or with a membership's add-on credit (Mo, a member).
 */
type Paid = 'booking order' | 'own order' | 'guest order' | 'cash' | 'credit'

async function withAnAddon(paid: Paid, work: (context: Context) => Promise<void>): Promise<void> {
  await replay(
    environment,
    {
      name: 'w22 remove add-on',
      seed,
      async run(context) {
        replayStripe.current = context.stripe
        const credit = paid === 'credit'
        const placed = (await context.call('createOrder', {
          customerId: credit ? ID.member : ID.customer,
          booking: {
            ...paidSeat(credit ? [mo] : [sam]),
            ...(paid === 'booking order' ? { addons: [{ ...towel, redemptionSource: 'paid' }] } : {}),
            ...(credit ? { addons: [{ ...towel, redemptionSource: 'membership_credit', membershipId: ID.membership }] } : {}),
          },
          payment: { method: 'card' },
        })) as { bookingId: string }
        const bookingId = placed.bookingId
        const addons = [{ addonId: ID.addon, quantity: 1 }]
        if (paid === 'own order' || paid === 'cash') {
          await context.call('addBookingGuest', { bookingId, addons })
          await context.call('addBookingGuest', { bookingId, addons, payment: paid === 'cash' ? { method: 'cash', confirmedCashAmount: 5 } : { method: 'card' } })
        }
        if (paid === 'guest order') {
          await context.call('addBookingGuest', { bookingId, ...bea, addons })
          await context.call('addBookingGuest', { bookingId, ...bea, addons, payment: { method: 'card' } })
        }
        vi.setSystemTime(Date.now() + 1000)
        const lineId = (await context.db.query<{ id: string }>('SELECT id FROM addon_order_lines WHERE booking_id = $1 ORDER BY created_at', [bookingId]))[0]?.id ?? ''
        try {
          await work({ ...context, bookingId, lineId })
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
    error?: { code: string; message: string; details?: Record<string, unknown> & { reason?: string; message?: string } }
  }
}

async function post(route: typeof removeRoute, url: string, params: Record<string, string>, body: unknown, { key = crypto.randomUUID(), orderSwitch = BOOKING_KINDS_ON, email = REPLAY_USER.email } = {}): Promise<Answer> {
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

const quote = (lineId: string) => post(quoteRoute, `/api/v1/staff/bookings/addon-lines/${lineId}/remove/quote`, { lineId }, {})
const remove = (lineId: string, refund: string, confirmedRefund: number | undefined, options: Parameters<typeof post>[4] = {}) =>
  post(removeRoute, `/api/v1/staff/bookings/addon-lines/${lineId}/remove`, { lineId }, { refund, ...(confirmedRefund === undefined ? {} : { confirmed: { refund: confirmedRefund } }) }, options)

const runReconcile = () => reconcile(db, replayStripe.current as FakeStripe, { actor: { type: 'system', id: null }, requestId: crypto.randomUUID(), maxItems: 50, budgetMs: 60_000 })
const pastTheWindow = () => vi.setSystemTime(Date.now() + 16 * 60_000)
/** 22 hours before the session (12 Nov 10:00): inside the 24-hour rule. */
const insideTwentyFourHours = () => vi.setSystemTime(new Date('2026-11-11T12:00:00.000Z'))

const line = async (lineId: string) =>
  (
    await db.query<{ removed_at: unknown; refunded_amount: string; card_refunded_amount: string; refund_method: string | null; order_id: string | null }>(
      'SELECT removed_at, refunded_amount::text AS refunded_amount, card_refunded_amount::text AS card_refunded_amount, refund_method, order_id FROM addon_order_lines WHERE id = $1',
      [lineId]
    )
  )[0]
const booking = async (bookingId: string) =>
  (await db.query<{ price_paid: string; refund_owed_amount: string }>('SELECT price_paid::text AS price_paid, refund_owed_amount::text AS refund_owed_amount FROM bookings WHERE id = $1', [bookingId]))[0]
const orderStatus = async (orderId: string | null | undefined) => (await db.query<{ payment_status: string }>('SELECT payment_status FROM orders WHERE id = $1', [orderId ?? null]))[0]?.payment_status
const creditRefunds = async () => db.query<{ amount: string; note: string; order_id: string | null }>("SELECT amount::text AS amount, note, order_id FROM store_credit_transactions WHERE reason = 'refund' ORDER BY created_at")
const refundCalls = (stripe: FakeStripe) => stripe.calls.filter((call) => call.method === 'refunds.create')
const auditRows = async (action: string) => db.query<{ id: string; details: Record<string, unknown> }>('SELECT id, details FROM audit_log WHERE action = $1 ORDER BY at', [action])
const credits = async () => (await db.query<{ n: number }>('SELECT addon_credits_remaining AS n FROM customer_memberships WHERE id = $1', [ID.membership]))[0]?.n

describe('Remove add-on: the quote (W22)', () => {
  it("a paid add-on's price × quantity; £0 of money inside 24 hours; the old refusals", async () => {
    await withAnAddon('booking order', async ({ bookingId, lineId }) => {
      expect((await quote(lineId)).body.data).toEqual({ lineId, bookingId, paid: true, amount: 5, insideTwentyFourHours: false, refund: 5 })
      insideTwentyFourHours()
      expect((await quote(lineId)).body.data).toMatchObject({ insideTwentyFourHours: true, refund: 0 })
      expect((await quote(crypto.randomUUID())).body.error?.details).toMatchObject({ reason: 'line_not_found', message: REMOVE_ADDON_WORDS.lineNotFound })
      vi.setSystemTime(new Date('2026-11-12T10:30:00.000Z'))
      expect((await quote(lineId)).body.error?.details).toMatchObject({ reason: 'session_started', message: REMOVE_ADDON_WORDS.sessionStarted })
    })
  })
})

describe('Remove add-on: the removal (W22)', () => {
  it("on the booking's own order, to the card: keyed from the claim; the line stamped; the order partly refunded; the old summary", async () => {
    await withAnAddon('booking order', async ({ lineId, stripe }) => {
      const answer = await remove(lineId, 'card', 5)
      expect(answer.body.data).toEqual({
        removed: true,
        summary: '1 add-on cancelled: £5.00 to the card',
        cancelledLineIds: [lineId],
        refundedAmount: 5,
        cardRefundedAmount: 5,
        storeCreditRefundedAmount: 0,
        creditsReturned: 0,
        notes: [],
      })
      const claim = (await auditRows('booking.refund_claimed'))[0]
      expect(claim?.details).toMatchObject({ kind: 'remove_addon', amount: 5, method: 'card', addon: { described: '1× Towel', names: 'Towel', refund: 'card' } })
      const row = await line(lineId)
      expect(refundCalls(stripe).map((call) => [(call.params as { amount: number }).amount, call.idempotencyKey])).toEqual([[500, claimRefundKey(claim?.id ?? '', row?.order_id ?? '')]])
      expect(row).toMatchObject({ refunded_amount: '5', card_refunded_amount: '5', refund_method: 'card' })
      expect(row?.removed_at).not.toBeNull()
      expect(await orderStatus(row?.order_id)).toBe('partially_refunded')
      expect((await auditRows('booking.addon_remove'))[0]?.details).toEqual({ lineIds: [lineId], refund: 'card', amount: 5, cardRefunded: 5, storeCreditRefunded: 0, owed: 0, creditsReturned: 0 })
    })
  })

  it('on an order of its own (add-ons alone on the card): that order\'s card, nothing from the booking\'s', async () => {
    await withAnAddon('own order', async ({ bookingId, lineId, stripe }) => {
      const row = await line(lineId)
      const intent = (await db.query<{ pi: string }>('SELECT stripe_payment_intent_id AS pi FROM orders WHERE id = $1', [row?.order_id]))[0]?.pi
      expect((await remove(lineId, 'card', 5)).body.data).toMatchObject({ cardRefundedAmount: 5 })
      expect(refundCalls(stripe).map((call) => (call.params as { payment_intent: string }).payment_intent)).toEqual([intent])
      expect(await orderStatus(row?.order_id)).toBe('refunded')
      expect(await booking(bookingId)).toMatchObject({ price_paid: '20.00' })
    })
  })

  it("inside a guest's order (W05c N5): the add-on's £5 from that card, then Remove Guest's £20; that payment never gives back more than it took", async () => {
    await withAnAddon('guest order', async ({ bookingId, lineId, stripe }) => {
      const row = await line(lineId)
      expect((await remove(lineId, 'card', 5)).body.data).toMatchObject({ cardRefundedAmount: 5, storeCreditRefundedAmount: 0 })
      const guestId = (await db.query<{ id: string }>("SELECT id FROM booking_guests WHERE booking_id = $1 AND guest_name = 'Bea Guest'", [bookingId]))[0]?.id ?? ''
      const guest = await post(removeGuestRoute, `/api/v1/staff/bookings/guests/${guestId}/remove`, { guestId }, { confirmedRefundAmount: 20, refundMethod: 'card' })
      expect(guest.body.data).toMatchObject({ removed: true, cardRefundedAmount: 20 })
      const intent = (await db.query<{ pi: string; total: string }>('SELECT stripe_payment_intent_id AS pi, order_total::text AS total FROM orders WHERE id = $1', [row?.order_id]))[0]
      const backOnIt = refundCalls(stripe)
        .filter((call) => (call.params as { payment_intent: string }).payment_intent === intent?.pi)
        .reduce((total, call) => total + (call.params as { amount: number }).amount, 0)
      expect(backOnIt).toBe(2500)
      expect(intent?.total).toBe('25.00')
      expect(await orderStatus(row?.order_id)).toBe('refunded')
    })
  })

  it('to store credit: one transaction, the old note, linked to the add-on\'s order; nothing sent to Stripe', async () => {
    await withAnAddon('booking order', async ({ lineId, stripe }) => {
      const answer = await remove(lineId, 'credit', 5)
      expect(answer.body.data).toMatchObject({ summary: '1 add-on cancelled: £5.00 to store credit', storeCreditRefundedAmount: 5 })
      expect(typeof answer.body.data?.['storeCreditBalance']).toBe('number')
      const row = await line(lineId)
      expect(await creditRefunds()).toMatchObject([{ amount: '5.00', order_id: row?.order_id }])
      expect((await creditRefunds())[0]?.note).toMatch(/^Add-on refund: 1× Towel\. \[ref /)
      expect(row).toMatchObject({ refunded_amount: '5', card_refunded_amount: '0', refund_method: 'credit' })
      expect(refundCalls(stripe)).toEqual([])
    })
  })

  it("card first, capped at what the paying order's card can still take back; the rest to store credit on that order", async () => {
    await withAnAddon('own order', async ({ lineId, stripe }) => {
      // £3 of the add-on's own £5 card payment already went back (recorded on its line, as a Worker refund would).
      await db.query('UPDATE addon_order_lines SET card_refunded_amount = 3 WHERE id = $1', [lineId])
      const answer = await remove(lineId, 'card', 5)
      expect(answer.body.data).toMatchObject({ summary: '1 add-on cancelled: £2.00 to the card, £3.00 to store credit', cardRefundedAmount: 2, storeCreditRefundedAmount: 3 })
      expect(refundCalls(stripe).map((call) => (call.params as { amount: number }).amount)).toEqual([200])
      expect((await creditRefunds())[0]?.note).toMatch(/^Add-on refund: 1× Towel\. \[ref /)
      expect(await line(lineId)).toMatchObject({ refunded_amount: '5', card_refunded_amount: '2', refund_method: 'card' })
    })
  })

  it("the card asked for on a cash add-on: all of it to store credit (as before)", async () => {
    await withAnAddon('cash', async ({ lineId, stripe }) => {
      expect((await remove(lineId, 'card', 5)).body.data).toMatchObject({ cardRefundedAmount: 0, storeCreditRefundedAmount: 5 })
      expect(refundCalls(stripe)).toEqual([])
    })
  })

  it('"Remove, no refund": removed with nothing back, by anyone; no claim', async () => {
    await withAnAddon('booking order', async ({ lineId }) => {
      await db.query("INSERT INTO staff (first_name, last_name, email, role, can_issue_refunds, active) VALUES ('No', 'Refunds', 'nore@example.com', 'staff', false, true)")
      const answer = await remove(lineId, 'none', 0, { email: 'nore@example.com' })
      expect(answer.body.data).toMatchObject({ summary: '1 add-on cancelled, nothing given back', refundedAmount: 0, notes: [] })
      expect(await line(lineId)).toMatchObject({ refunded_amount: '0', refund_method: 'none' })
      expect(await auditRows('booking.refund_claimed')).toEqual([])
    })
  })

  it('inside 24 hours: nothing back, money or credit (the old note); the confirmed £0 passes and £5 is refused with the new quote', async () => {
    await withAnAddon('booking order', async ({ lineId, stripe }) => {
      insideTwentyFourHours()
      const stale = await remove(lineId, 'card', 5)
      expect(stale.body.error?.details).toMatchObject({ reason: 'refund_changed', message: REFUND_WORDS.figuresChanged, addonQuote: { insideTwentyFourHours: true, refund: 0 } })
      const answer = await remove(lineId, 'card', 0)
      expect(answer.body.data).toMatchObject({ refundedAmount: 0, notes: [ADDON_INSIDE_24_HOURS_NOTE] })
      expect(await line(lineId)).toMatchObject({ refund_method: 'none', refunded_amount: '0' })
      expect(refundCalls(stripe)).toEqual([])
    })
    await withAnAddon('credit', async ({ lineId }) => {
      insideTwentyFourHours()
      const before = await credits()
      expect((await remove(lineId, 'none', 0)).body.data).toMatchObject({ creditsReturned: 0, notes: [ADDON_INSIDE_24_HOURS_NOTE] })
      expect(await credits()).toBe(before)
    })
  })

  it('a credit add-on: its credit back while the membership is active; not once it has ended (the old note)', async () => {
    await withAnAddon('credit', async ({ lineId }) => {
      const before = await credits()
      const answer = await remove(lineId, 'none', 0)
      expect(answer.body.data).toMatchObject({ summary: '1 add-on cancelled: 1 add-on credit returned', creditsReturned: 1, refundedAmount: 0 })
      expect(await credits()).toBe((before ?? 0) + 1)
      expect(await line(lineId)).toMatchObject({ refund_method: 'credit_returned' })
    })
    await withAnAddon('credit', async ({ lineId }) => {
      await db.query("UPDATE customer_memberships SET cancel_effective_date = '2026-11-09' WHERE id = $1", [ID.membership])
      const before = await credits()
      const answer = await remove(lineId, 'none', 0)
      expect(answer.body.data).toMatchObject({ creditsReturned: 0, notes: [addonMembershipNotActiveNote('Towel')] })
      expect(await credits()).toBe(before)
      expect(await line(lineId)).toMatchObject({ refund_method: 'none' })
    })
  })

  it('the first card refund refused: the add-on goes back on the booking, the old words; the next press is a new claim', async () => {
    await withAnAddon('booking order', async ({ lineId, stripe }) => {
      stripe.failNext('refunds.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
      const refused = await remove(lineId, 'card', 5)
      expect(refused.status).toBe(402)
      expect(refused.body.error?.details).toMatchObject({
        reason: 'refund_failed',
        message: 'The card refund for Towel failed (Failed to refund payment: Your card was declined.), so it was left on the booking — refund it manually.',
      })
      expect(await line(lineId)).toMatchObject({ removed_at: null, refund_method: null })
      expect((await auditRows('booking.refund_finished'))[0]?.details).toMatchObject({ outcome: 'put_back' })
      expect((await remove(lineId, 'card', 5)).body.data).toMatchObject({ cardRefundedAmount: 5 })
      const keys = refundCalls(stripe).map((call) => call.idempotencyKey)
      expect(new Set(keys).size).toBe(2)
    })
  })

  it('no clear answer: removed and held (Q35); reconcile records it if Stripe has it, else owes it on the booking; never resent', async () => {
    await withAnAddon('booking order', async ({ lineId, stripe }) => {
      stripe.failNext('refunds.create', { kind: 'lost_response' })
      stripe.failNext('refunds.create', { kind: 'lost_response' })
      const answer = await remove(lineId, 'card', 5)
      expect(answer.body.data).toMatchObject({ removed: true, cardRefundedAmount: 0, warning: CHANGE_REFUND_UNCONFIRMED_MESSAGE, held: { reason: 'refund_unconfirmed' } })
      pastTheWindow()
      const sent = refundCalls(stripe).length
      await runReconcile()
      expect(refundCalls(stripe)).toHaveLength(sent)
      expect(await line(lineId)).toMatchObject({ refunded_amount: '5', card_refunded_amount: '5', refund_method: 'card' })
    })
    await withAnAddon('booking order', async ({ bookingId, lineId, stripe }) => {
      stripe.failNext('refunds.create', { kind: 'unreachable' })
      stripe.failNext('refunds.create', { kind: 'unreachable' })
      expect((await remove(lineId, 'card', 5)).body.data?.held).toBeDefined()
      pastTheWindow()
      await runReconcile()
      // As the old function kept an unclear add-on refund: owed on the live booking, the line removed with nothing on it.
      expect(await booking(bookingId)).toMatchObject({ price_paid: '25.00', refund_owed_amount: '5.00' })
      expect(await line(lineId)).toMatchObject({ refunded_amount: '0', refund_method: 'none' })
      expect((await auditRows('booking.refund_finished'))[0]?.details).toMatchObject({ outcome: 'owed', owed: 5 })
    })
  })

  it('two tabs, one after the other: the second finds it removed; one refund', async () => {
    await withAnAddon('booking order', async ({ lineId, stripe }) => {
      expect((await remove(lineId, 'card', 5)).body.data).toMatchObject({ cardRefundedAmount: 5 })
      expect((await remove(lineId, 'card', 5)).body.error?.details).toMatchObject({ reason: 'already_removed', message: REMOVE_ADDON_WORDS.alreadyRemoved })
      expect(refundCalls(stripe)).toHaveLength(1)
    })
  })

  it('refused while a refund on the booking is held, or a payment is still being taken', async () => {
    await withAnAddon('booking order', async ({ bookingId, lineId, stripe }) => {
      stripe.failNext('refunds.create', { kind: 'unreachable' })
      stripe.failNext('refunds.create', { kind: 'unreachable' })
      const part = await post(partRoute, `/api/v1/staff/bookings/${bookingId}/refunds`, { bookingId }, { amount: 5, refundMethod: 'card', reason: 'x' })
      expect(part.body.data?.held).toBeDefined()
      expect((await remove(lineId, 'credit', 5)).body.error?.details).toMatchObject({ reason: 'refund_open', message: REFUND_OPEN_MESSAGE })
      expect(await line(lineId)).toMatchObject({ removed_at: null })
    })
    await withAnAddon('booking order', async ({ bookingId, lineId, call }) => {
      await call('addBookingGuest', { bookingId, ...bea, payment: { method: 'reader' } })
      expect((await remove(lineId, 'credit', 5)).body.error?.details).toMatchObject({ reason: 'reader_payment_open', message: READER_PAYMENT_OPEN_MESSAGE })
    })
  })

  it('Issue refunds for a paid add-on refunded; the switch gates money out; a missing confirmed refund is refused', async () => {
    await withAnAddon('booking order', async ({ lineId }) => {
      await db.query("INSERT INTO staff (first_name, last_name, email, role, can_issue_refunds, active) VALUES ('No', 'Refunds', 'nore@example.com', 'staff', false, true)")
      const forbidden = await remove(lineId, 'credit', 5, { email: 'nore@example.com' })
      expect(forbidden.body.error).toMatchObject({ code: 'FORBIDDEN', message: ISSUE_REFUNDS_NEEDED_MESSAGE })
      const off = await remove(lineId, 'card', 5, { orderSwitch: 'no_stripe' })
      expect(off.body.error).toMatchObject({ code: 'BOOKING_PATH_OFF', message: BOOKING_PATH_OFF_MESSAGE })
      const missing = await remove(lineId, 'card', undefined)
      expect(missing.body.error?.details).toMatchObject({ reason: 'refund_changed', addonQuote: { refund: 5 } })
      expect(await line(lineId)).toMatchObject({ removed_at: null })
    })
  })
})
