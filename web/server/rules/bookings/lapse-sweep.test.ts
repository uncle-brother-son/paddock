import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { GET as figuresRoute } from '@/app/api/v1/staff/bookings/[bookingId]/refund-figures/route'
import type { BookingRefundFiguresRouteOutput } from '@/contracts'
import type { Db } from '@/server/db'
import { ORDER_KINDS } from '@/server/rules/orders/order-switch'
import { BOOKING_KINDS_ON, withSwitch } from '@/server/rules/testing/replay/booking-side'
import { oldSide, replay, REPLAY_USER, startReplay, type ReplayEnvironment, type ScenarioContext } from '@/server/rules/testing/replay/harness'
import { bea, ID, memberCredit, mo, paidSeat, runLapseSweep, seed } from '@/server/rules/testing/replay/scenarios'
import { replayStripe } from '@/server/rules/testing/replay/stripe-binding'
import { ApiError } from '@/server/http/errors'
import { BOOKING_LAPSED, LAPSE_LEFT_WORDS, lapseBooking, lapsePlanOf } from './cancel'
import { lapsedWords } from './failure-messages'
import { LAPSE_SWEEP_MAX_ITEMS, lapseSweep, lapseSweepOn, type LapseSweepResult } from './lapse-sweep'
import type { LoadedBooking } from './load-booking'
import { owedArrived, partRefund, refundOwed } from './refunds'
import { MONEY_OWED_WORDS } from '@/server/rules/refunds/failure-messages'
import { moneyOwedList } from '@/server/rules/refunds/money-owed-list'

// Brief W43 (F-plan 1.9, 4.8; Wayne's Q48, 15 Nov; N8, bugs FB18 and FB19): the lapse sweep on the Worker, on the
// replay's live schema (the database's own functions, constraints and its own sweep). The bookings are made by the old
// functions (the frozen copy), as the golden scenarios make them: Mo's membership credit seat, then flagged payment
// needed with its deadline backdated, as the lead's preview does. Stripe is only ever the fake, and the sweep must
// never call it. The replay's clock is 10 Nov 2026 09:00; the session is 12 Nov 10:00.
// The races are lapse-sweep-postgres.test.ts's; the parity with the database's sweep is replay/lapse-replay.test.ts's.

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

const ON = `${BOOKING_KINDS_ON},lapse_sweep`
/** 12 Nov 10:00, the session's start, as an instant (November: London is on UTC). */
const SESSION_START = new Date('2026-11-12T10:00:00.000Z').getTime()
const HOUR = 3600_000

let environment: ReplayEnvironment
let db: Db
beforeAll(async () => {
  process.env.STAFF_API_KEY = 'test-staff-api-key'
  environment = await startReplay()
  db = environment.database.db
  holder.db = db
})
afterAll(() => environment.stop())

type BookingContext = ScenarioContext & { bookingId: string }

/** A booking made by the old createOrder for Mo, then `work` on it. */
async function withBooking(order: Record<string, unknown>, work: (context: BookingContext) => Promise<void>): Promise<void> {
  await replay(
    environment,
    {
      name: 'w43 lapse sweep',
      seed,
      async run(context) {
        replayStripe.current = context.stripe
        const placed = (await context.call('createOrder', { customerId: ID.member, ...order })) as { bookingId: string }
        if (!placed.bookingId) throw new Error(`The order failed: ${JSON.stringify(placed)}`)
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

const alex = { name: 'Alex Guest', email: 'alex@example.com' }
const towel = { addonId: ID.addon, quantity: 1, unitPrice: 5, systemUnitPrice: 5 }
/** Mo's credit seat, nothing paid. */
const creditSeat = { booking: { ...paidSeat([mo]), ...memberCredit }, payment: {} }
/** Mo's credit seat with Alex, a paid guest (£20 in cash): FB18's booking. */
const creditSeatAndPaidGuest = { booking: { ...paidSeat([mo, alex]), ...memberCredit }, payment: { method: 'cash', confirmedCashAmount: 20 } }
/** The same, the guest paid for on Mo's saved card. */
const creditSeatAndCardGuest = { booking: { ...paidSeat([mo, alex]), ...memberCredit }, payment: { method: 'card' } }
/** Mo's credit seat with a paid towel (£5 in cash): FB19's booking. */
const creditSeatAndPaidTowel = { booking: { ...paidSeat([mo]), ...memberCredit, addons: [{ ...towel, redemptionSource: 'paid' }] }, payment: { method: 'cash', confirmedCashAmount: 5 } }
/** Mo's credit seat with a towel on an add-on credit. */
const creditSeatAndCreditTowel = { booking: { ...paidSeat([mo]), ...memberCredit, addons: [{ ...towel, redemptionSource: 'membership_credit', membershipId: ID.membership }] }, payment: {} }

/** Flagged payment needed, its deadline a minute ago (as the lead's preview: the deadline backdated). */
const paymentNeeded = (bookingId: string) => db.query("UPDATE bookings SET status = 'payment_needed', payment_due_by = now() - interval '1 minute' WHERE id = $1", [bookingId])

const sweep = (orderSwitch: string | null = ON, maxItems?: number): Promise<LapseSweepResult> =>
  lapseSweep(db, { requestId: 'lapse-sweep-test', orderSwitch, ...(maxItems !== undefined ? { maxItems } : {}) })

const bookingRow = async (bookingId: string) =>
  (
    await db.query<{ status: string; price_paid: string; refund_owed_amount: string; cancelled: boolean; cancel_reason: string | null; party_size: number; due: boolean }>(
      'SELECT status, price_paid::text, refund_owed_amount::text, cancelled_at IS NOT NULL AS cancelled, cancel_reason, party_size, payment_due_by IS NOT NULL AS due FROM bookings WHERE id = $1',
      [bookingId]
    )
  )[0]
const totalBooked = async () => (await db.query<{ total_booked: number }>('SELECT total_booked FROM sessions WHERE id = $1', [ID.session]))[0]?.total_booked
const balance = async () => Number((await db.query<{ balance: string }>('SELECT store_credit_balance::text AS balance FROM customers WHERE id = $1', [ID.member]))[0]?.balance)
const storeCreditRows = () =>
  db.query<{ amount: string; reason: string; staff_id: string | null; order_id: string | null; booking_id: string | null; note: string | null }>(
    "SELECT amount::numeric(10,2)::text AS amount, reason, staff_id, order_id, booking_id, regexp_replace(note, ' \\[ref [^\\]]+\\]$', '') AS note FROM store_credit_transactions WHERE customer_id = $1 AND reason = 'refund' ORDER BY created_at, id",
    [ID.member]
  )
const addonLines = (bookingId: string) =>
  db.query<{ removed: boolean; removed_by: string | null; refunded_amount: string; card_refunded_amount: string; refund_method: string | null }>(
    'SELECT removed_at IS NOT NULL AS removed, removed_by, refunded_amount::numeric(10,2)::text AS refunded_amount, card_refunded_amount::numeric(10,2)::text AS card_refunded_amount, refund_method FROM addon_order_lines WHERE booking_id = $1 ORDER BY created_at, id',
    [bookingId]
  )
const guests = async (bookingId: string) => (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM booking_guests WHERE booking_id = $1', [bookingId]))[0]?.n
const addonCredits = async () => (await db.query<{ n: number }>('SELECT addon_credits_remaining AS n FROM customer_memberships WHERE id = $1', [ID.membership]))[0]?.n
const creditsUsed = async () => Number((await db.query<{ used: number }>('SELECT credits_used AS used FROM membership_current_credits WHERE period_id = $1', [ID.creditPeriod]))[0]?.used)
type AuditRow = { actor_type: string; actor_id: string | null; action: string; request_id: string; details: Record<string, unknown> }
/**
 * The Worker's rows on the booking that a cancel or a lapse writes, by action (the replay's clock stands still inside a
 * run, so rows written a millisecond apart can't be read back in the order written).
 */
const lapseRows = async (bookingId: string) =>
  (await db.query<AuditRow>("SELECT actor_type, actor_id, action, request_id, details FROM audit_log WHERE entity_type = 'booking' AND entity_id = $1 ORDER BY action, id", [bookingId])).filter((row) =>
    /^booking\.(cancel|cancel_credit|lapsed|refund_claimed|refund_finished)$/.test(row.action)
  )
const rowOf = (rows: AuditRow[], action: string) => rows.find((row) => row.action === action)?.details
/** Every row the sweep wrote is the system's: no id, the run's request id. */
const allTheSystems = (rows: AuditRow[]) => rows.every((row) => row.actor_type === 'system' && row.actor_id === null && row.request_id === 'lapse-sweep-test')

/** Everything a booking the sweep leaves must keep exactly as it was. */
async function snapshot(bookingId: string) {
  return {
    booking: await bookingRow(bookingId),
    places: await totalBooked(),
    guests: await guests(bookingId),
    lines: await addonLines(bookingId),
    credits: await addonCredits(),
    balance: await balance(),
    storeCredit: (await storeCreditRows()).length,
    rows: (await lapseRows(bookingId)).length,
  }
}

const NOTHING: LapseSweepResult = { ran: true, lapsed: 0, left: 0, failed: 0, storeCreditRefunded: 0, more: false, items: [] }

/** W43a: a staff member with Issue refunds, for what staff can and can't do on a lapsed booking afterwards. */
const staff = { actor: { type: 'staff' as const, id: ID.staff }, requestId: 'w43a-staff' }
/** The reason a press was refused with, or null when it went through. */
async function refusedWith(work: () => Promise<unknown>): Promise<string | null> {
  try {
    await work()
    return null
  } catch (err) {
    if (!(err instanceof ApiError)) throw err
    return (err.details as { reason?: string } | undefined)?.reason ?? err.code
  }
}
/** W43a (review S2): the lead's count of lapses that kept money, as the report gives it. */
const keptMoneyCount = async (bookingId: string) =>
  (
    await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit_log WHERE action = 'booking.lapsed' AND entity_id = $1 AND details->>'back' = 'false' AND (details->>'pricePaid')::numeric - (details->>'refundOwed')::numeric + (details->>'addonsKept')::numeric > 0",
      [bookingId]
    )
  )[0]?.n

describe('the lapse sweep: nothing paid (brief W43 item 2)', () => {
  it("a credit booking with nothing paid, its deadline passed: cancelled with the database sweep's reason, its place released, its credit free again, one audit row each for the cancel and the lapse, no Stripe call", async () => {
    await withBooking(creditSeat, async ({ bookingId, stripe }) => {
      await paymentNeeded(bookingId)
      const calls = stripe.calls.length
      expect(await totalBooked()).toBe(1)
      expect(await creditsUsed()).toBe(1)
      expect(await sweep()).toEqual({
        ...NOTHING,
        lapsed: 1,
        items: [{ bookingId, outcome: 'lapsed', kind: 'cancel_credit', back: true, kept: null, storeCreditRefunded: 0, addonCreditsReturned: 0 }],
      })
      // Exactly what the database's sweep writes on the booking and its session (the parity compares every row).
      expect(await bookingRow(bookingId)).toEqual({ status: 'cancelled', price_paid: '0.00', refund_owed_amount: '0.00', cancelled: true, cancel_reason: 'membership_lapsed', party_size: 1, due: true })
      expect(await totalBooked()).toBe(0)
      // The membership credit is counted from bookings that aren't cancelled: free again, with no write.
      expect(await creditsUsed()).toBe(0)
      expect(await balance()).toBe(0)
      expect(await storeCreditRows()).toEqual([])
      const rows = await lapseRows(bookingId)
      expect(rows.map((row) => row.action)).toEqual(['booking.cancel_credit', BOOKING_LAPSED])
      expect(allTheSystems(rows)).toBe(true)
      const lapse = { back: true, kept: null, paymentDueBy: expect.any(String) as unknown }
      expect(rows[0]?.details).toMatchObject({ channel: 'system', lapse, placesReleased: 1, storeCreditRefunded: 0, cardRefunded: 0, owed: 0, addonLineIds: [] })
      expect(rows[1]?.details).toEqual({ ...lapse, pricePaid: 0, refundOwed: 0, addonsKept: 0, storeCreditRefunded: 0, placesReleased: 1 })
      expect(await keptMoneyCount(bookingId)).toBe(0)
      expect(stripe.calls.length).toBe(calls)
      // A second run finds nothing due.
      expect(await sweep()).toEqual(NOTHING)
    })
  })

  it('a booking whose deadline has not passed, and a confirmed one, are not read at all', async () => {
    await withBooking(creditSeat, async ({ bookingId }) => {
      const before = await snapshot(bookingId)
      expect(await sweep()).toEqual(NOTHING)
      await db.query("UPDATE bookings SET status = 'payment_needed', payment_due_by = now() + interval '1 hour' WHERE id = $1", [bookingId])
      expect(await sweep()).toEqual(NOTHING)
      expect(await snapshot(bookingId)).toEqual({ ...before, booking: { ...before.booking, status: 'payment_needed', due: true } })
    })
  })

  it('inside 24 hours and after the session has started, a booking with nothing paid lapses the same way (its clock is the deadline)', async () => {
    for (const now of [SESSION_START - HOUR, SESSION_START + HOUR / 2]) {
      await withBooking(creditSeat, async ({ bookingId }) => {
        vi.setSystemTime(now)
        await paymentNeeded(bookingId)
        const swept = await sweep()
        expect(swept).toMatchObject({ lapsed: 1, storeCreditRefunded: 0, items: [{ bookingId, outcome: 'lapsed', kind: 'cancel_credit', back: false, kept: now > SESSION_START ? 'session_started' : 'inside_24_hours' }] })
        expect(await bookingRow(bookingId)).toMatchObject({ status: 'cancelled', cancel_reason: 'membership_lapsed' })
        expect(await totalBooked()).toBe(0)
      })
    }
  })
})

describe('the lapse sweep: money on the booking (Q48; bug FB18)', () => {
  it("FB18, a paid guest (£20), 25 hours before the session: the booking lapses, both places are released and the guest's £20 goes to store credit (one row, no staff member, the paying order), through the claim, all in the system's name", async () => {
    await withBooking(creditSeatAndPaidGuest, async ({ bookingId, stripe }) => {
      vi.setSystemTime(SESSION_START - 25 * HOUR)
      await paymentNeeded(bookingId)
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'payment_needed', price_paid: '20.00', party_size: 2 })
      expect(await totalBooked()).toBe(2)
      const calls = stripe.calls.length
      // The database's own sweep never lapses it (FB18): run first, it leaves the booking exactly as it is.
      const before = await snapshot(bookingId)
      await runLapseSweep(db)
      expect(await snapshot(bookingId)).toEqual(before)

      expect(await sweep()).toEqual({
        ...NOTHING,
        lapsed: 1,
        storeCreditRefunded: 20,
        items: [{ bookingId, outcome: 'lapsed', kind: 'cancel_credit', back: true, kept: null, storeCreditRefunded: 20, addonCreditsReturned: 0 }],
      })
      // price_paid stays, as on every cancelled booking; nothing is owed.
      expect(await bookingRow(bookingId)).toEqual({ status: 'cancelled', price_paid: '20.00', refund_owed_amount: '0.00', cancelled: true, cancel_reason: 'membership_lapsed', party_size: 2, due: true })
      expect(await totalBooked()).toBe(0)
      expect(await balance()).toBe(20)
      const orderId = (await db.query<{ order_id: string }>("SELECT order_id FROM order_line_items WHERE booking_id = $1 AND item_type = 'booking'", [bookingId]))[0]?.order_id
      expect(await storeCreditRows()).toEqual([{ amount: '20.00', reason: 'refund', staff_id: null, order_id: orderId, booking_id: bookingId, note: 'Booking refund.' }])
      const rows = await lapseRows(bookingId)
      expect(rows.map((row) => row.action)).toEqual(['booking.cancel_credit', BOOKING_LAPSED, 'booking.refund_claimed', 'booking.refund_finished'])
      expect(allTheSystems(rows)).toBe(true)
      expect(rowOf(rows, 'booking.refund_claimed')).toMatchObject({ kind: 'cancel_credit', amount: 20, method: 'credit', worker: true, channel: 'system', livemode: null, plan: { card: [], storeCredit: 20 }, cancel: { channel: 'system', seatAmount: 20, lapse: { back: true, kept: null } } })
      expect(rowOf(rows, 'booking.cancel_credit')).toMatchObject({ channel: 'system', seatRefund: 20, refundMethod: 'credit', storeCreditRefunded: 20, cardRefunded: 0, owed: 0, placesReleased: 2 })
      expect(rowOf(rows, 'booking.refund_finished')).toMatchObject({ outcome: 'given', storeCreditRefunded: 20, cardRefunded: 0, owed: 0 })
      expect(rowOf(rows, BOOKING_LAPSED)).toEqual({ back: true, kept: null, paymentDueBy: expect.any(String) as unknown, pricePaid: 20, refundOwed: 0, addonsKept: 0, storeCreditRefunded: 20, placesReleased: 2 })
      expect(await keptMoneyCount(bookingId)).toBe(0)
      // The claim is finished in the transaction that wrote it: nothing for reconcile, nothing on the stuck list.
      expect(stripe.calls.length).toBe(calls)
      // Run again: nothing more is given.
      expect(await sweep()).toEqual(NOTHING)
      expect(await balance()).toBe(20)
    })
  })

  it('a paid guest (£20), 23 hours before the session: the booking lapses and its places are released, with nothing back. The £20 is kept and recorded (`booking.lapsed`); no refund button gives it afterwards (Part refund and Refund the rest refuse), so goodwill is Adjust store credit (W43a, review S3; Wayne, 18 Nov)', async () => {
    await withBooking(creditSeatAndPaidGuest, async ({ bookingId, stripe }) => {
      vi.setSystemTime(SESSION_START - 23 * HOUR)
      await paymentNeeded(bookingId)
      const calls = stripe.calls.length
      expect(await sweep()).toEqual({
        ...NOTHING,
        lapsed: 1,
        items: [{ bookingId, outcome: 'lapsed', kind: 'cancel_credit', back: false, kept: 'inside_24_hours', storeCreditRefunded: 0, addonCreditsReturned: 0 }],
      })
      expect(await bookingRow(bookingId)).toEqual({ status: 'cancelled', price_paid: '20.00', refund_owed_amount: '0.00', cancelled: true, cancel_reason: 'membership_lapsed', party_size: 2, due: true })
      expect(await totalBooked()).toBe(0)
      expect(await balance()).toBe(0)
      expect(await storeCreditRows()).toEqual([])
      const rows = await lapseRows(bookingId)
      expect(rows.map((row) => row.action)).toEqual(['booking.cancel_credit', BOOKING_LAPSED])
      expect(allTheSystems(rows)).toBe(true)
      expect(rows[0]?.details).toMatchObject({ channel: 'system', lapse: { back: false, kept: 'inside_24_hours' }, storeCreditRefunded: 0, placesReleased: 2 })
      expect(rows[0]?.details).not.toHaveProperty('seatRefund')
      expect(rows[1]?.details).toEqual({ back: false, kept: 'inside_24_hours', paymentDueBy: expect.any(String) as unknown, pricePaid: 20, refundOwed: 0, addonsKept: 0, storeCreditRefunded: 0, placesReleased: 2 })
      expect(await keptMoneyCount(bookingId)).toBe(1)
      expect(stripe.calls.length).toBe(calls)
      // W47 item 1: the kept £20 is listed below the money still to refund, for information: nothing is owed, and
      // the note names Adjust store credit as the way to give some back.
      const listed = await moneyOwedList(db)
      expect(listed.owed).toEqual([])
      expect(listed.lapsedKept).toMatchObject([{ bookingId, customerName: 'Mo Member', kept: 20, keptBecause: 'inside_24_hours' }])
      expect(listed.lapsedKept[0]?.words).toContain('£20.00 was kept: it lapsed inside 24 hours of the session.')
      expect(listed.keptNote).toBe(MONEY_OWED_WORDS.keptNote)
      expect(listed.keptNote).toContain('use Adjust store credit on the customer')
      // W43a (review S3, proof P1): the kept money can't be given from the cancelled booking by any refund button.
      for (const method of ['credit', 'cash', 'card'] as const) {
        expect(await refusedWith(() => partRefund(db, bookingId, { amount: 20, refundMethod: method, reason: 'goodwill' }, staff))).toBe('already_cancelled')
      }
      expect(await refusedWith(() => refundOwed(db, bookingId, { amount: 20, refundMethod: 'credit' }, staff))).toBe('nothing_owed')
      expect(await balance()).toBe(0)
    })
  })

  it('exactly 24 hours before the session the money comes back; a second inside it, it does not', async () => {
    for (const [now, back] of [
      [SESSION_START - 24 * HOUR, true],
      [SESSION_START - 24 * HOUR + 1000, false],
    ] as const) {
      await withBooking(creditSeatAndPaidGuest, async ({ bookingId }) => {
        vi.setSystemTime(now)
        await paymentNeeded(bookingId)
        expect(await sweep()).toMatchObject({ lapsed: 1, storeCreditRefunded: back ? 20 : 0, items: [{ back, kept: back ? null : 'inside_24_hours' }] })
        expect(await balance()).toBe(back ? 20 : 0)
      })
    }
  })

  it('a paid guest, the session already started: lapsed with nothing back', async () => {
    await withBooking(creditSeatAndPaidGuest, async ({ bookingId }) => {
      vi.setSystemTime(SESSION_START + HOUR / 2)
      await paymentNeeded(bookingId)
      expect(await sweep()).toMatchObject({ lapsed: 1, storeCreditRefunded: 0, items: [{ bookingId, outcome: 'lapsed', kind: 'cancel_credit', back: false, kept: 'session_started' }] })
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'cancelled', price_paid: '20.00', cancel_reason: 'membership_lapsed' })
      expect(await totalBooked()).toBe(0)
      expect(await balance()).toBe(0)
      expect((await lapseRows(bookingId)).map((row) => row.action)).toEqual(['booking.cancel_credit', BOOKING_LAPSED])
    })
  })

  it('a guest paid for on the saved card, 25 hours before: the £20 goes to store credit, never back to the card (no Stripe call, no card part, the order line not marked as card-refunded)', async () => {
    await withBooking(creditSeatAndCardGuest, async ({ bookingId, stripe }) => {
      vi.setSystemTime(SESSION_START - 25 * HOUR)
      await paymentNeeded(bookingId)
      const calls = stripe.calls.length
      expect(await sweep()).toMatchObject({ lapsed: 1, storeCreditRefunded: 20 })
      expect(stripe.calls.length).toBe(calls)
      expect(stripe.calls.some((call) => call.method.startsWith('refunds.'))).toBe(false)
      expect(await balance()).toBe(20)
      const line = (await db.query<{ card: string }>("SELECT card_refunded_amount::numeric(10,2)::text AS card FROM order_line_items WHERE booking_id = $1 AND item_type = 'booking'", [bookingId]))[0]
      expect(line?.card).toBe('0.00')
      const claim = (await lapseRows(bookingId)).find((row) => row.action === 'booking.refund_claimed')
      expect(claim?.details).toMatchObject({ method: 'credit', plan: { card: [], storeCredit: 20 } })
    })
  })

  // W43a (the W43 review's S1, its proof P3's shape). Card refund money owed is part of a live booking's price paid
  // (an earlier card refund that never arrived was put back on it as owed). Here it is set on the booking directly.
  const owed = (bookingId: string, amount: string) => db.query('UPDATE bookings SET refund_owed_amount = $1::numeric WHERE id = $2', [amount, bookingId])
  const creditSeatPaidGuestAndTowel = { booking: { ...paidSeat([mo, alex]), ...memberCredit, addons: [{ ...towel, redemptionSource: 'paid' }] }, payment: { method: 'cash', confirmedCashAmount: 25 } }

  it("S1, a £20 paid guest with £5 of card refund money owed (Q39), 25 hours before: the lapse gives £15 to store credit (the price paid less what is owed) and leaves the £5 owed on the cancelled booking; Refund the rest then gives the £5, once: £20 in all", async () => {
    await withBooking(creditSeatAndPaidGuest, async ({ bookingId, stripe }) => {
      vi.setSystemTime(SESSION_START - 25 * HOUR)
      await paymentNeeded(bookingId)
      await owed(bookingId, '5.00')
      const calls = stripe.calls.length
      expect(await sweep()).toEqual({
        ...NOTHING,
        lapsed: 1,
        storeCreditRefunded: 15,
        items: [{ bookingId, outcome: 'lapsed', kind: 'cancel_credit', back: true, kept: null, storeCreditRefunded: 15, addonCreditsReturned: 0 }],
      })
      // price_paid stays, as on every cancelled booking; what was owed is still owed, not a penny more or less.
      expect(await bookingRow(bookingId)).toEqual({ status: 'cancelled', price_paid: '20.00', refund_owed_amount: '5.00', cancelled: true, cancel_reason: 'membership_lapsed', party_size: 2, due: true })
      // W47 item 1: the lapsed booking is on the "Money still to refund" list, once, as lapsed. This lapse gave back
      // everything that wasn't owed, so it kept nothing and isn't under the money kept.
      const listed = await moneyOwedList(db)
      expect(listed.owed).toHaveLength(1)
      expect(listed.owed[0]).toMatchObject({ on: 'booking', bookingId, amount: 5, bookingStatus: 'cancelled', lapsed: true, where: MONEY_OWED_WORDS.lapsedBooking })
      expect(listed.lapsedKept).toEqual([])
      expect(await totalBooked()).toBe(0)
      expect(await balance()).toBe(15)
      expect(await storeCreditRows()).toMatchObject([{ amount: '15.00', reason: 'refund', staff_id: null, booking_id: bookingId, note: 'Booking refund.' }])
      const rows = await lapseRows(bookingId)
      expect(rows.map((row) => row.action)).toEqual(['booking.cancel_credit', BOOKING_LAPSED, 'booking.refund_claimed', 'booking.refund_finished'])
      expect(allTheSystems(rows)).toBe(true)
      expect(rowOf(rows, 'booking.refund_claimed')).toMatchObject({ kind: 'cancel_credit', amount: 15, method: 'credit', channel: 'system', plan: { card: [], storeCredit: 15 }, cancel: { seatAmount: 15, refundOwed: 5 } })
      expect(rowOf(rows, 'booking.cancel_credit')).toMatchObject({ channel: 'system', seatRefund: 15, storeCreditRefunded: 15, cardRefunded: 0, owed: 0 })
      expect(rowOf(rows, 'booking.refund_finished')).toMatchObject({ outcome: 'given', storeCreditRefunded: 15, cardRefunded: 0, owed: 0 })
      expect(rowOf(rows, BOOKING_LAPSED)).toEqual({ back: true, kept: null, paymentDueBy: expect.any(String) as unknown, pricePaid: 20, refundOwed: 5, addonsKept: 0, storeCreditRefunded: 15, placesReleased: 2 })
      expect(await keptMoneyCount(bookingId)).toBe(0)
      expect(stripe.calls.length).toBe(calls)
      // A second run gives nothing more.
      expect(await sweep()).toEqual(NOTHING)
      expect(await balance()).toBe(15)

      // Staff settle what is owed on the cancelled booking: Refund the rest, store credit, exactly the £5.
      expect(await refusedWith(() => partRefund(db, bookingId, { amount: 5, refundMethod: 'credit', reason: 'the rest' }, staff))).toBe('already_cancelled')
      expect(await refusedWith(() => refundOwed(db, bookingId, { amount: 20, refundMethod: 'credit' }, staff))).toBe('owed_changed')
      expect(await refundOwed(db, bookingId, { amount: 5, refundMethod: 'credit' }, staff)).toMatchObject({ storeCreditRefundedAmount: 5, cardRefundedAmount: 0 })
      expect(await balance()).toBe(20)
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'cancelled', price_paid: '20.00', refund_owed_amount: '0.00' })
      // Given once: a second press finds nothing owed, and £20 is all the customer ever gets.
      expect(await refusedWith(() => refundOwed(db, bookingId, { amount: 5, refundMethod: 'credit' }, staff))).toBe('nothing_owed')
      expect(await balance()).toBe(20)
      // Two rows, from two presses. Compared as a set: the replay's clock stands still, so they can share an instant and
      // read back in either order.
      expect((await storeCreditRows()).map((row) => row.amount).sort()).toEqual(['15.00', '5.00'])
    })
  })

  // Brief W46 item 6 (W43a "Noticed" 3). Before W46 the guest's order line kept `refunded_at` null for ever: the lapse
  // can't stamp it (£5 is still owed), and nothing stamped it when staff later gave the £5.
  const guestLine = async (bookingId: string) =>
    (
      await db.query<{ stamped: boolean; at: string | null; method: string | null; order_status: string }>(
        `SELECT oli.refunded_at IS NOT NULL AS stamped, oli.refunded_at::text AS at, oli.refund_method AS method, o.payment_status AS order_status
         FROM order_line_items oli JOIN orders o ON o.id = oli.order_id WHERE oli.booking_id = $1 AND oli.item_type = 'booking'`,
        [bookingId]
      )
    )
  /** W47: `arrivedOn` is where staff saw the money; with none, it is read as another way (as before W47). */
  const arrived = (bookingId: string, amount: number, arrivedOn?: 'card' | 'other') => owedArrived(db, bookingId, { amount, reason: 'Seen in Stripe', ...(arrivedOn ? { arrivedOn } : {}) }, staff)

  it("W46: a £20 guest with £5 owed, 25 hours before: the lapse gives £15 and can't stamp the guest's line (£5 is still owed). Refund the rest gives the £5: the line is stamped refunded, once, the order reads refunded, £20 in all, given once", async () => {
    await withBooking(creditSeatAndPaidGuest, async ({ bookingId }) => {
      vi.setSystemTime(SESSION_START - 25 * HOUR)
      await paymentNeeded(bookingId)
      await owed(bookingId, '5.00')
      expect(await sweep()).toMatchObject({ lapsed: 1, storeCreditRefunded: 15 })
      expect(await balance()).toBe(15)
      // One line holds the guest's £20. Not all of it is back yet: not stamped.
      expect(await guestLine(bookingId)).toEqual([{ stamped: false, at: null, method: null, order_status: 'partially_refunded' }])
      expect(await refundOwed(db, bookingId, { amount: 5, refundMethod: 'credit' }, staff)).toMatchObject({ storeCreditRefundedAmount: 5, cardRefundedAmount: 0 })
      const [line] = await guestLine(bookingId)
      expect(line).toMatchObject({ stamped: true, method: 'credit', order_status: 'refunded' })
      expect(await balance()).toBe(20)
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'cancelled', price_paid: '20.00', refund_owed_amount: '0.00' })
      // Once: a second press, a minute later, finds nothing owed; the stamp keeps its time and no more money is given.
      vi.setSystemTime(Date.now() + 60_000)
      expect(await refusedWith(() => refundOwed(db, bookingId, { amount: 5, refundMethod: 'credit' }, staff))).toBe('nothing_owed')
      expect(await guestLine(bookingId)).toEqual([line])
      expect(await balance()).toBe(20)
      expect((await storeCreditRows()).map((row) => row.amount).sort()).toEqual(['15.00', '5.00'])
      // And a later run of the sweep changes nothing.
      expect(await sweep()).toEqual(NOTHING)
      expect(await guestLine(bookingId)).toEqual([line])
    })
  })

  it('W46: the same with It already arrived for the £5 (it did reach the card): no money moves, the line is stamped and the order reads refunded; £15 of store credit is all that was given', async () => {
    await withBooking(creditSeatAndPaidGuest, async ({ bookingId }) => {
      vi.setSystemTime(SESSION_START - 25 * HOUR)
      await paymentNeeded(bookingId)
      await owed(bookingId, '5.00')
      expect(await sweep()).toMatchObject({ lapsed: 1, storeCreditRefunded: 15 })
      expect((await guestLine(bookingId))[0]).toMatchObject({ stamped: false })
      expect(await arrived(bookingId, 5)).toMatchObject({ cardRefundedAmount: 0, storeCreditRefundedAmount: 0 })
      expect((await guestLine(bookingId))[0]).toMatchObject({ stamped: true, order_status: 'refunded' })
      expect(await balance()).toBe(15)
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'cancelled', refund_owed_amount: '0.00' })
    })
  })

  it("W46: money a lapse kept is not stamped as refunded. 23 hours before, £5 of the £20 owed: nothing back, £15 kept. Refund the rest gives the £5: the guest's line stays unstamped (£5 of its £20 is back), and the order reads partially refunded, not refunded", async () => {
    await withBooking(creditSeatAndPaidGuest, async ({ bookingId }) => {
      vi.setSystemTime(SESSION_START - 23 * HOUR)
      await paymentNeeded(bookingId)
      await owed(bookingId, '5.00')
      expect(await sweep()).toMatchObject({ lapsed: 1, storeCreditRefunded: 0 })
      expect(await guestLine(bookingId)).toMatchObject([{ stamped: false, order_status: 'paid' }])
      expect(await refundOwed(db, bookingId, { amount: 5, refundMethod: 'credit' }, staff)).toMatchObject({ storeCreditRefundedAmount: 5 })
      expect(await guestLine(bookingId)).toMatchObject([{ stamped: false, order_status: 'partially_refunded' }])
      expect(await balance()).toBe(5)
    })
    // And with It already arrived: nothing stamped either, and the order as it was.
    await withBooking(creditSeatAndPaidGuest, async ({ bookingId }) => {
      vi.setSystemTime(SESSION_START - 23 * HOUR)
      await paymentNeeded(bookingId)
      await owed(bookingId, '5.00')
      expect(await sweep()).toMatchObject({ lapsed: 1, storeCreditRefunded: 0 })
      await arrived(bookingId, 5)
      expect(await guestLine(bookingId)).toMatchObject([{ stamped: false, order_status: 'paid' }])
    })
  })

  /**
   * Four towels (£20) removed from the booking earlier, their refund planned to a card in a claim that ended as
   * `outcome`, the line reading £0 back. Answers the towels' line id.
   */
  async function removedTowels(bookingId: string, outcome: 'owed' | 'put_back', onOrder: string | null = null): Promise<string> {
    const [guest] = await db.query<{ order_id: string }>("SELECT order_id FROM order_line_items WHERE booking_id = $1 AND item_type = 'booking'", [bookingId])
    const [towels] = await db.query<{ id: string }>(
      `INSERT INTO addon_order_lines (booking_id, addon_id, quantity, price_at_purchase, sku_at_purchase, redemption_source, order_id, removed_at, refunded_amount, card_refunded_amount, refund_method)
       VALUES ($1, $2, 4, 5, 'TOWEL', 'paid', $3::uuid, now(), 0, 0, 'none') RETURNING id`,
      [bookingId, ID.addon, onOrder]
    )
    const plan = { card: [{ orderId: guest?.order_id, paymentIntentId: 'pi_never_arrived', amount: 20, lines: [{ lineId: towels?.id, amount: 20 }] }], storeCredit: 0, cash: 0, ownOrderId: null }
    const [claim] = await db.query<{ id: string }>(
      "INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, request_id, details) VALUES ('staff', $1, 'booking.refund_claimed', 'booking', $2, 'w46-towels', $3::jsonb) RETURNING id",
      [ID.staff, bookingId, JSON.stringify({ kind: 'remove_addon', amount: 20, method: 'card', worker: true, plan })]
    )
    await db.query(
      "INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, request_id, details) VALUES ('staff', $1, 'booking.refund_finished', 'booking', $2, 'w46-towels', $3::jsonb)",
      [ID.staff, bookingId, JSON.stringify({ claimId: claim?.id, outcome, cardRefunded: 0, storeCreditRefunded: 0, owed: outcome === 'owed' ? 20 : 0 })]
    )
    return towels?.id as string
  }
  const towelsLine = async (lineId: string) => (await db.query<{ refunded: string; method: string }>('SELECT refunded_amount::numeric(10,2)::text AS refunded, refund_method AS method FROM addon_order_lines WHERE id = $1', [lineId]))[0]
  const auditRows = (bookingId: string, action: string) =>
    db.query<{ details: Record<string, unknown> }>("SELECT details FROM audit_log WHERE entity_type = 'booking' AND entity_id = $1 AND action = $2 ORDER BY at, id", [bookingId, action])
  const towelsCard = async (lineId: string) => (await db.query<{ card: string }>('SELECT card_refunded_amount::numeric(10,2)::text AS card FROM addon_order_lines WHERE id = $1', [lineId]))[0]?.card

  it("W46: money owed that was an add-on's never stamps a seat whose money was kept. £20 owed for removed towels (their card refund never arrived), the booking lapsed 23 hours before with the guest's £20 kept: It already arrived for the £20 leaves the guest's line unstamped; Refund the rest instead gives the towels' line its £20 and still leaves the guest's line unstamped", async () => {
    for (const how of ['arrived', 'refund the rest'] as const) {
      await withBooking(creditSeatAndPaidGuest, async ({ bookingId }) => {
        // The towels' £20 is on the booking as owed (part of its price paid while it is live).
        const towels = await removedTowels(bookingId, 'owed')
        await db.query('UPDATE bookings SET price_paid = 40, refund_owed_amount = 20 WHERE id = $1', [bookingId])
        vi.setSystemTime(SESSION_START - 23 * HOUR)
        await paymentNeeded(bookingId)
        expect(await sweep()).toMatchObject({ lapsed: 1, storeCreditRefunded: 0 })
        expect(await bookingRow(bookingId)).toMatchObject({ status: 'cancelled', refund_owed_amount: '20.00' })
        if (how === 'arrived') await arrived(bookingId, 20)
        else expect(await refundOwed(db, bookingId, { amount: 20, refundMethod: 'credit' }, staff)).toMatchObject({ storeCreditRefundedAmount: 20 })
        expect(await bookingRow(bookingId)).toMatchObject({ refund_owed_amount: '0.00' })
        // The guest's £20 was kept by the lapse: none of it is back, whatever the towels' £20 did.
        expect((await guestLine(bookingId))[0]).toMatchObject({ stamped: false })
        // W47 item 8, a named difference: It already arrived now stamps the towels' line as Refund the rest does
        // (before W47 it left it reading £0 back, `none`). No choice was sent, so the £20 is read as arrived another
        // way: nothing is recorded as card money, and the row is as it was before W47.
        expect(await towelsLine(towels)).toEqual({ refunded: '20.00', method: 'credit' })
        expect(await towelsCard(towels)).toBe('0.00')
        if (how === 'arrived') expect((await auditRows(bookingId, 'booking.refund_owed_arrived'))[0]?.details).toEqual({ amount: 20, reason: 'Seen in Stripe' })
      })
    }
  })

  it("W47 item 8, nothing counted twice: the same with the guest paid for on a card, and the towels on that order. It already arrived on the card for the towels' £20 puts it on the towels' line as card money, once; the guest's £20, kept by the lapse, is still not stamped as refunded", async () => {
    await withBooking(creditSeatAndCardGuest, async ({ bookingId }) => {
      const [guest] = await db.query<{ id: string; order_id: string }>("SELECT id, order_id FROM order_line_items WHERE booking_id = $1 AND item_type = 'booking'", [bookingId])
      const orderId = guest?.order_id as string
      // The towels were paid on the same card payment (£40 in all); their £20 card refund never arrived.
      const towels = await removedTowels(bookingId, 'owed', orderId)
      await db.query('UPDATE orders SET order_total = 40 WHERE id = $1', [orderId])
      await db.query('UPDATE bookings SET price_paid = 40, refund_owed_amount = 20 WHERE id = $1', [bookingId])
      vi.setSystemTime(SESSION_START - 23 * HOUR)
      await paymentNeeded(bookingId)
      expect(await sweep()).toMatchObject({ lapsed: 1, storeCreditRefunded: 0 })
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'cancelled', refund_owed_amount: '20.00' })
      expect(await arrived(bookingId, 20, 'card')).toMatchObject({ cardRefundedAmount: 0, storeCreditRefundedAmount: 0 })
      expect(await bookingRow(bookingId)).toMatchObject({ refund_owed_amount: '0.00' })
      // All £20 is the towels', on their line, as card money: the row has it on that line and nowhere else.
      expect((await auditRows(bookingId, 'booking.refund_owed_arrived'))[0]?.details).toEqual({ amount: 20, reason: 'Seen in Stripe', arrivedOn: 'card', card: 20, lines: [{ lineId: towels, orderId, amount: 20, addon: true }] })
      expect(await towelsLine(towels)).toEqual({ refunded: '20.00', method: 'card' })
      expect(await towelsCard(towels)).toBe('20.00')
      // Counted once. Were the £20 also counted from the row (as before W47), the guest's kept £20 would read as back
      // and its line would be stamped refunded.
      expect((await db.query<{ card: string }>('SELECT card_refunded_amount::numeric(10,2)::text AS card FROM order_line_items WHERE id = $1', [guest?.id]))[0]?.card).toBe('0.00')
      expect((await guestLine(bookingId))[0]).toMatchObject({ stamped: false, at: null, method: null })
      // The order's own status is the older rule's (orderPaymentStatusAfterRefunds): a cancelled booking's line with
      // nothing back isn't counted, so with the towels' line refunded the order reads `refunded`. Unchanged by W47.
      expect((await guestLine(bookingId))[0]?.order_status).toBe('refunded')
      expect(await balance()).toBe(0)
    })
  })

  it("W46: a removed add-on whose refund claim was put back is not part of what is owed: £5 of the guest's £20 owed, towels removed with nothing back after their own claim was put back, lapsed 23 hours before: Refund the rest gives the £5 and the towels' line still reads £0 back (their money was kept)", async () => {
    await withBooking(creditSeatAndPaidGuest, async ({ bookingId }) => {
      const towels = await removedTowels(bookingId, 'put_back')
      vi.setSystemTime(SESSION_START - 23 * HOUR)
      await paymentNeeded(bookingId)
      await owed(bookingId, '5.00')
      expect(await sweep()).toMatchObject({ lapsed: 1, storeCreditRefunded: 0 })
      expect(await refundOwed(db, bookingId, { amount: 5, refundMethod: 'credit' }, staff)).toMatchObject({ storeCreditRefundedAmount: 5 })
      expect(await towelsLine(towels)).toEqual({ refunded: '0.00', method: 'none' })
      expect((await guestLine(bookingId))[0]).toMatchObject({ stamped: false })
      expect(await balance()).toBe(5)
    })
  })

  it('S1 with a paid towel (£5) as well: £20 to store credit (£15 of the guest\'s money and the towel\'s £5), the towel line removed and refunded, the £5 still owed', async () => {
    await withBooking(creditSeatPaidGuestAndTowel, async ({ bookingId }) => {
      vi.setSystemTime(SESSION_START - 25 * HOUR)
      await paymentNeeded(bookingId)
      await owed(bookingId, '5.00')
      expect(await sweep()).toMatchObject({ lapsed: 1, storeCreditRefunded: 20, items: [{ bookingId, outcome: 'lapsed', kind: 'cancel_credit', back: true, kept: null, storeCreditRefunded: 20 }] })
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'cancelled', price_paid: '20.00', refund_owed_amount: '5.00', cancel_reason: 'membership_lapsed' })
      expect(await addonLines(bookingId)).toEqual([{ removed: true, removed_by: null, refunded_amount: '5.00', card_refunded_amount: '0.00', refund_method: 'credit' }])
      expect(await balance()).toBe(20)
      expect((await storeCreditRows()).map((row) => [row.amount, row.note])).toEqual([
        ['15.00', 'Booking refund.'],
        ['5.00', 'Add-on refund: 1× Towel.'],
      ])
      expect(rowOf(await lapseRows(bookingId), BOOKING_LAPSED)).toMatchObject({ back: true, kept: null, pricePaid: 20, refundOwed: 5, addonsKept: 0, storeCreditRefunded: 20 })
      expect(await keptMoneyCount(bookingId)).toBe(0)
      expect(await refundOwed(db, bookingId, { amount: 5, refundMethod: 'credit' }, staff)).toMatchObject({ storeCreditRefundedAmount: 5 })
      expect(await balance()).toBe(25)
    })
  })

  it('S1, all of the price paid owed (£20 of £20) and a paid towel, 25 hours before: the system gives none of the owed money, only the towel\'s £5; the £20 stays owed for staff', async () => {
    await withBooking(creditSeatPaidGuestAndTowel, async ({ bookingId }) => {
      vi.setSystemTime(SESSION_START - 25 * HOUR)
      await paymentNeeded(bookingId)
      await owed(bookingId, '20.00')
      expect(await sweep()).toMatchObject({ lapsed: 1, storeCreditRefunded: 5, items: [{ back: true, kept: null, storeCreditRefunded: 5 }] })
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'cancelled', price_paid: '20.00', refund_owed_amount: '20.00' })
      expect(await balance()).toBe(5)
      expect((await storeCreditRows()).map((row) => [row.amount, row.note])).toEqual([['5.00', 'Add-on refund: 1× Towel.']])
      expect(rowOf(await lapseRows(bookingId), BOOKING_LAPSED)).toMatchObject({ back: true, pricePaid: 20, refundOwed: 20, addonsKept: 0, storeCreditRefunded: 5 })
    })
  })

  it('S1, all of the price paid owed and nothing else on the booking, 25 hours before: lapsed with no claim and nothing given; the £20 stays owed', async () => {
    await withBooking(creditSeatAndPaidGuest, async ({ bookingId }) => {
      vi.setSystemTime(SESSION_START - 25 * HOUR)
      await paymentNeeded(bookingId)
      await owed(bookingId, '20.00')
      expect(await sweep()).toMatchObject({ lapsed: 1, storeCreditRefunded: 0, items: [{ back: true, kept: null, storeCreditRefunded: 0 }] })
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'cancelled', price_paid: '20.00', refund_owed_amount: '20.00', cancel_reason: 'membership_lapsed' })
      expect(await totalBooked()).toBe(0)
      expect(await balance()).toBe(0)
      expect(await storeCreditRows()).toEqual([])
      expect((await lapseRows(bookingId)).map((row) => row.action)).toEqual(['booking.cancel_credit', BOOKING_LAPSED])
      expect(await keptMoneyCount(bookingId)).toBe(0)
    })
  })

  it('S1 inside 24 hours (£5 owed on a £20 guest and a paid towel, 23 hours before): nothing back, as before; the £5 stays owed, and the lapse records the £15 and the towel\'s £5 as kept', async () => {
    await withBooking(creditSeatPaidGuestAndTowel, async ({ bookingId }) => {
      vi.setSystemTime(SESSION_START - 23 * HOUR)
      await paymentNeeded(bookingId)
      await owed(bookingId, '5.00')
      expect(await sweep()).toMatchObject({ lapsed: 1, storeCreditRefunded: 0, items: [{ back: false, kept: 'inside_24_hours', storeCreditRefunded: 0 }] })
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'cancelled', price_paid: '20.00', refund_owed_amount: '5.00' })
      expect(await addonLines(bookingId)).toEqual([{ removed: true, removed_by: null, refunded_amount: '0.00', card_refunded_amount: '0.00', refund_method: 'none' }])
      expect(await balance()).toBe(0)
      expect(await storeCreditRows()).toEqual([])
      expect(rowOf(await lapseRows(bookingId), BOOKING_LAPSED)).toMatchObject({ back: false, kept: 'inside_24_hours', pricePaid: 20, refundOwed: 5, addonsKept: 5, storeCreditRefunded: 0 })
      expect(await keptMoneyCount(bookingId)).toBe(1)
      // Staff can still settle the £5 owed, and only that.
      expect(await refundOwed(db, bookingId, { amount: 5, refundMethod: 'credit' }, staff)).toMatchObject({ storeCreditRefundedAmount: 5 })
      expect(await balance()).toBe(5)
    })
  })

  it("S1 on Cancel & Refund's way (money that isn't a paid guest's, £5 of it owed), 25 hours before: £15 to store credit, the £5 still owed", async () => {
    await withBooking(creditSeatAndPaidGuest, async ({ bookingId }) => {
      vi.setSystemTime(SESSION_START - 25 * HOUR)
      await paymentNeeded(bookingId)
      await db.query('UPDATE booking_guests SET unit_price = NULL, pay_by = NULL WHERE booking_id = $1', [bookingId])
      await db.query('UPDATE bookings SET credit_period_id = NULL WHERE id = $1', [bookingId])
      await owed(bookingId, '5.00')
      expect(await sweep()).toMatchObject({ lapsed: 1, storeCreditRefunded: 15, items: [{ bookingId, outcome: 'lapsed', kind: 'cancel', back: true, kept: null }] })
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'cancelled', price_paid: '20.00', refund_owed_amount: '5.00', cancel_reason: 'membership_lapsed' })
      expect(await balance()).toBe(15)
      expect(await refundOwed(db, bookingId, { amount: 5, refundMethod: 'credit' }, staff)).toMatchObject({ storeCreditRefundedAmount: 5 })
      expect(await balance()).toBe(20)
    })
  })

  it("money on the booking that isn't a paid guest's (a seat with no price of its own), 25 hours before: Cancel & Refund's way, the £20 to store credit", async () => {
    await withBooking(creditSeatAndPaidGuest, async ({ bookingId }) => {
      vi.setSystemTime(SESSION_START - 25 * HOUR)
      await paymentNeeded(bookingId)
      // As an older booking: its seats carry no price.
      await db.query('UPDATE booking_guests SET unit_price = NULL, pay_by = NULL WHERE booking_id = $1', [bookingId])
      await db.query('UPDATE bookings SET credit_period_id = NULL WHERE id = $1', [bookingId])
      expect(await sweep()).toMatchObject({ lapsed: 1, storeCreditRefunded: 20, items: [{ bookingId, outcome: 'lapsed', kind: 'cancel', back: true, kept: null }] })
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'cancelled', price_paid: '20.00', refund_owed_amount: '0.00', cancel_reason: 'membership_lapsed' })
      expect(await balance()).toBe(20)
      expect((await lapseRows(bookingId)).map((row) => row.action)).toEqual(['booking.cancel', BOOKING_LAPSED, 'booking.refund_claimed', 'booking.refund_finished'])
    })
  })
})

describe('the lapse sweep: add-ons (bug FB19)', () => {
  it('FB19 proved first: a payment-needed booking with `price_paid = 0` can hold a paid add-on (a credit seat, a £5 towel paid in cash, then flagged by the database\'s own flag_uncovered_credit_bookings), and the database\'s sweep cancels it, keeps the £5 and records nothing', async () => {
    await withBooking(creditSeatAndPaidTowel, async ({ bookingId }) => {
      // The membership no longer covers the session's day: the database flags the booking itself, as the webhook does.
      await environment.database.pg.exec(`RESET ROLE; SELECT public.flag_uncovered_credit_bookings('${ID.membership}'::uuid, '2026-11-10'::date); SET ROLE paddock_worker;`)
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'payment_needed', price_paid: '0.00', due: true })
      expect(await addonLines(bookingId)).toEqual([{ removed: false, removed_by: null, refunded_amount: '0.00', card_refunded_amount: '0.00', refund_method: null }])
      const paid = await db.query<{ price: string; source: string }>('SELECT price_at_purchase::numeric(10,2)::text AS price, redemption_source AS source FROM addon_order_lines WHERE booking_id = $1', [bookingId])
      expect(paid).toEqual([{ price: '5.00', source: 'paid' }])
      // Its deadline is the session's start (under 72 hours away), so it passes as the session starts.
      vi.setSystemTime(SESSION_START + 1000)
      await runLapseSweep(db)
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'cancelled', cancel_reason: 'membership_lapsed' })
      expect(await addonLines(bookingId)).toEqual([{ removed: false, removed_by: null, refunded_amount: '0.00', card_refunded_amount: '0.00', refund_method: null }])
      expect(await balance()).toBe(0)
      expect(await lapseRows(bookingId)).toEqual([])
    })
  })

  it('FB19, a paid towel (£5) on a `price_paid = 0` booking, 25 hours before: the booking lapses, the towel line is removed and its £5 goes to store credit, recorded', async () => {
    await withBooking(creditSeatAndPaidTowel, async ({ bookingId, stripe }) => {
      vi.setSystemTime(SESSION_START - 25 * HOUR)
      await paymentNeeded(bookingId)
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'payment_needed', price_paid: '0.00' })
      const calls = stripe.calls.length
      expect(await sweep()).toEqual({
        ...NOTHING,
        lapsed: 1,
        storeCreditRefunded: 5,
        items: [{ bookingId, outcome: 'lapsed', kind: 'cancel_credit', back: true, kept: null, storeCreditRefunded: 5, addonCreditsReturned: 0 }],
      })
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'cancelled', price_paid: '0.00', cancel_reason: 'membership_lapsed' })
      expect(await addonLines(bookingId)).toEqual([{ removed: true, removed_by: null, refunded_amount: '5.00', card_refunded_amount: '0.00', refund_method: 'credit' }])
      expect(await balance()).toBe(5)
      expect(await storeCreditRows()).toMatchObject([{ amount: '5.00', reason: 'refund', staff_id: null, booking_id: bookingId, note: 'Add-on refund: 1× Towel.' }])
      const rows = await lapseRows(bookingId)
      expect(rows.map((row) => row.action)).toEqual(['booking.cancel_credit', BOOKING_LAPSED, 'booking.refund_claimed', 'booking.refund_finished'])
      expect(allTheSystems(rows)).toBe(true)
      expect(rowOf(rows, 'booking.cancel_credit')).toMatchObject({ channel: 'system', addonRefund: 'credit', addonsRefund: 5, storeCreditRefunded: 5, placesReleased: 1 })
      expect(rowOf(rows, BOOKING_LAPSED)).toMatchObject({ back: true, kept: null, pricePaid: 0, storeCreditRefunded: 5 })
      expect(stripe.calls.length).toBe(calls)
    })
  })

  it("S2 (W43a), a paid towel (£5) on a `price_paid = 0` booking, 23 hours before: the booking lapses and the towel line is removed with nothing back; `booking.lapsed` carries the £5 as `addonsKept`, and the lead's count of lapses that kept money finds it", async () => {
    await withBooking(creditSeatAndPaidTowel, async ({ bookingId }) => {
      vi.setSystemTime(SESSION_START - 23 * HOUR)
      await paymentNeeded(bookingId)
      expect(await sweep()).toMatchObject({ lapsed: 1, storeCreditRefunded: 0, items: [{ back: false, kept: 'inside_24_hours' }] })
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'cancelled', cancel_reason: 'membership_lapsed' })
      expect(await addonLines(bookingId)).toEqual([{ removed: true, removed_by: null, refunded_amount: '0.00', card_refunded_amount: '0.00', refund_method: 'none' }])
      expect(await balance()).toBe(0)
      expect(await storeCreditRows()).toEqual([])
      const rows = await lapseRows(bookingId)
      expect(rows.map((row) => row.action)).toEqual(['booking.cancel_credit', BOOKING_LAPSED])
      expect(rowOf(rows, BOOKING_LAPSED)).toEqual({ back: false, kept: 'inside_24_hours', paymentDueBy: expect.any(String) as unknown, pricePaid: 0, refundOwed: 0, addonsKept: 5, storeCreditRefunded: 0, placesReleased: 1 })
      // The W43 count (`pricePaid > 0`) missed this booking; the count with `addonsKept` finds it.
      expect(await keptMoneyCount(bookingId)).toBe(1)
    })
  })

  it('S2: two towels on one line (£5 × 2), 23 hours before: `addonsKept` is price × quantity (£10)', async () => {
    const twoTowels = { booking: { ...paidSeat([mo]), ...memberCredit, addons: [{ ...towel, quantity: 2, redemptionSource: 'paid' }] }, payment: { method: 'cash', confirmedCashAmount: 10 } }
    await withBooking(twoTowels, async ({ bookingId }) => {
      vi.setSystemTime(SESSION_START - 23 * HOUR)
      await paymentNeeded(bookingId)
      expect(await sweep()).toMatchObject({ lapsed: 1, storeCreditRefunded: 0 })
      expect(rowOf(await lapseRows(bookingId), BOOKING_LAPSED)).toMatchObject({ back: false, pricePaid: 0, addonsKept: 10, storeCreditRefunded: 0 })
    })
  })

  it('a towel on an add-on credit: 25 hours before, the credit goes back while the membership is active, and not once it is past due; 23 hours before, never', async () => {
    const cases = [
      { hours: 25, status: 'active', returned: 1 },
      { hours: 25, status: 'past_due', returned: 0 },
      { hours: 23, status: 'active', returned: 0 },
    ]
    for (const { hours, status, returned } of cases) {
      await withBooking(creditSeatAndCreditTowel, async ({ bookingId }) => {
        vi.setSystemTime(SESSION_START - hours * HOUR)
        await paymentNeeded(bookingId)
        await db.query('UPDATE customer_memberships SET subscription_status = $1 WHERE id = $2', [status, ID.membership])
        const credits = await addonCredits()
        expect(await sweep()).toMatchObject({ lapsed: 1, storeCreditRefunded: 0, items: [{ addonCreditsReturned: returned }] })
        expect(await addonCredits()).toBe(Number(credits) + returned)
        expect(await addonLines(bookingId)).toMatchObject([{ removed: true, removed_by: null, refund_method: returned ? 'credit_returned' : 'none' }])
        expect(await balance()).toBe(0)
        // A credit line is never money kept, whether or not its credit came back.
        expect(rowOf(await lapseRows(bookingId), BOOKING_LAPSED)).toMatchObject({ addonsKept: 0 })
      })
    }
  })
})

describe('the lapse sweep: what it leaves (brief W43 item 2: Settle, Remove Guest, a staff cancel, the database sweep)', () => {
  it('a payment still being taken on the booking (Settle on the card reader): left, nothing changed; once the payment is cancelled, the next run lapses it', async () => {
    await withBooking(creditSeat, async ({ bookingId }) => {
      await paymentNeeded(bookingId)
      const flowId = (
        await db.query<{ id: string }>(
          "INSERT INTO pending_reader_payments (flow, record_id, expected_amount, status, snapshot) VALUES ('settle', $1::uuid, 20, 'pending', '{}'::jsonb) RETURNING id",
          [bookingId]
        )
      )[0]?.id
      const before = await snapshot(bookingId)
      expect(await sweep()).toEqual({ ...NOTHING, left: 1, items: [{ bookingId, outcome: 'left', reason: 'reader_payment_open' }] })
      expect(await snapshot(bookingId)).toEqual(before)
      await db.query("UPDATE pending_reader_payments SET status = 'cancelled' WHERE id = $1", [flowId])
      expect(await sweep()).toMatchObject({ lapsed: 1, left: 0 })
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'cancelled' })
    })
  })

  it('a refund still being checked on the booking: left, nothing changed', async () => {
    await withBooking(creditSeatAndPaidGuest, async ({ bookingId }) => {
      vi.setSystemTime(SESSION_START - 25 * HOUR)
      await paymentNeeded(bookingId)
      await db.query(
        "INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, request_id, details) VALUES ('staff', $1, 'booking.refund_claimed', 'booking', $2, 'w43-open-claim', '{\"worker\": true}'::jsonb)",
        [ID.staff, bookingId]
      )
      const before = await snapshot(bookingId)
      expect(await sweep()).toEqual({ ...NOTHING, left: 1, items: [{ bookingId, outcome: 'left', reason: 'refund_open' }] })
      expect(await snapshot(bookingId)).toEqual(before)
    })
  })

  it('settled between the read and the lock (the booking confirmed again), cancelled by staff, or cancelled by the database sweep: `not_lapsed`, nothing changed, nothing given', async () => {
    await withBooking(creditSeatAndPaidGuest, async ({ bookingId }) => {
      vi.setSystemTime(SESSION_START - 25 * HOUR)
      await paymentNeeded(bookingId)
      // What R1 finds under the lock when Settle committed first: confirmed, no deadline.
      const settledFirst = async () => {
        await db.query("UPDATE bookings SET status = 'confirmed', payment_due_by = NULL WHERE id = $1", [bookingId])
      }
      const before = await snapshot(bookingId)
      // lapseBooking itself, with the booking changed after the sweep listed it.
      await settledFirst()
      expect(await lapseBooking(db, bookingId, 'lapse-sweep-test')).toEqual({ outcome: 'left', reason: 'not_lapsed' })
      expect(await snapshot(bookingId)).toEqual({ ...before, booking: { ...before.booking, status: 'confirmed', due: false } })
      await db.query("UPDATE bookings SET status = 'cancelled', cancelled_at = now() WHERE id = $1", [bookingId])
      expect(await lapseBooking(db, bookingId, 'lapse-sweep-test')).toEqual({ outcome: 'left', reason: 'not_lapsed' })
      expect(await balance()).toBe(0)
      expect(await lapseRows(bookingId)).toEqual([])
    })
  })

  it("under the lock, R1's own test of \"due\" is the database sweep's: a booking whose deadline was put back, or that was settled, after the sweep's read is left as `not_lapsed`", async () => {
    for (const change of ["UPDATE bookings SET payment_due_by = now() + interval '1 hour' WHERE id = $1", "UPDATE bookings SET status = 'confirmed' WHERE id = $1"]) {
      await withBooking(creditSeat, async ({ bookingId }) => {
        await paymentNeeded(bookingId)
        const realQuery = db.query.bind(db)
        let changed = false
        // The sweep's read (no lock) sees a due booking; before R1 takes the lock, the booking changes.
        const changing = Object.assign(Object.create(db) as Db, {
          query: async (sql: string, params?: never[]) => {
            const rows = await realQuery(sql, params)
            if (!changed && /FROM addon_order_lines WHERE booking_id = \$1::uuid AND removed_at IS NULL ORDER BY created_at, id/.test(sql)) {
              changed = true
              await realQuery(change, [bookingId] as never[])
            }
            return rows
          },
        })
        const before = await snapshot(bookingId)
        expect(await lapseBooking(changing, bookingId, 'lapse-sweep-test')).toEqual({ outcome: 'left', reason: 'not_lapsed' })
        expect(changed).toBe(true)
        expect(await snapshot(bookingId)).toEqual({ ...before, booking: { ...before.booking, status: change.includes('confirmed') ? 'confirmed' : 'payment_needed' } })
        expect(LAPSE_LEFT_WORDS.notLapsed).toMatch(/no longer waiting for payment/)
      })
    }
  })

  it('lapseBooking on a payment-needed booking whose deadline has not passed (never listed by the sweep): left as `not_lapsed`', async () => {
    await withBooking(creditSeat, async ({ bookingId }) => {
      await db.query("UPDATE bookings SET status = 'payment_needed', payment_due_by = now() + interval '1 hour' WHERE id = $1", [bookingId])
      expect(await lapseBooking(db, bookingId, 'lapse-sweep-test')).toEqual({ outcome: 'left', reason: 'not_lapsed' })
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'payment_needed' })
    })
  })

  it("under the lock, R1 refuses a booking that changed after the sweep's read (a guest paid for since: a different cancel) and one no longer due, with the sweep's own reasons", async () => {
    await withBooking(creditSeat, async ({ bookingId, call: old }) => {
      await paymentNeeded(bookingId)
      // The read with no lock sees a credit seat with nothing paid. Before R1 takes the lock, the booking changes.
      const realQuery = db.query.bind(db)
      let changed = false
      const changing = Object.assign(Object.create(db) as Db, {
        query: async (sql: string, params?: never[]) => {
          const rows = await realQuery(sql, params)
          if (!changed && /FROM addon_order_lines WHERE booking_id = \$1::uuid AND removed_at IS NULL ORDER BY created_at, id/.test(sql)) {
            changed = true
            await old('addBookingGuest', { bookingId, ...bea })
            await old('addBookingGuest', { bookingId, ...bea, addons: [{ ...towel, redemptionSource: 'paid' }], payment: { method: 'cash', confirmedCashAmount: 25 } })
          }
          return rows
        },
      })
      expect(await lapseBooking(changing, bookingId, 'lapse-sweep-test')).toEqual({ outcome: 'left', reason: 'booking_changed' })
      expect(changed).toBe(true)
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'payment_needed', price_paid: '20.00' })
      expect(await lapseRows(bookingId)).toEqual([])
      expect(LAPSE_LEFT_WORDS.bookingChanged).toMatch(/next run/)
    })
  })

  it('a fault on one booking is counted as failed, with nothing of it kept, and never stops the next booking', async () => {
    await withBooking(creditSeatAndPaidGuest, async ({ bookingId }) => {
      vi.setSystemTime(SESSION_START - 25 * HOUR)
      await paymentNeeded(bookingId)
      const before = await snapshot(bookingId)
      // The store credit can't be given (the customer's balance column refuses the write).
      await environment.database.pg.exec('RESET ROLE; ALTER TABLE customers ADD CONSTRAINT w43_no_credit CHECK (store_credit_balance = 0) NOT VALID; SET ROLE paddock_worker;')
      try {
        const swept = await sweep()
        expect(swept).toMatchObject({ ran: true, lapsed: 0, left: 0, failed: 1, storeCreditRefunded: 0 })
        expect(swept.items).toEqual([{ bookingId, outcome: 'failed', error: expect.stringMatching(/^ApiError: /) as unknown }])
        expect(await snapshot(bookingId)).toEqual(before)
      } finally {
        await environment.database.pg.exec('RESET ROLE; ALTER TABLE customers DROP CONSTRAINT w43_no_credit; SET ROLE paddock_worker;')
      }
      expect(await sweep()).toMatchObject({ lapsed: 1, failed: 0, storeCreditRefunded: 20 })
    })
  })
})

describe('the switch kind `lapse_sweep` (brief W43 item 1)', () => {
  it('is its own kind, the last in the list when it was added, and turns nothing else on', () => {
    expect(ORDER_KINDS.indexOf('lapse_sweep')).toBe(12)
    // W47r, a named difference: one kind after it now (`payment_retries`, "Try the payment again now"). The twelve before it are as they were.
    expect(ORDER_KINDS).toHaveLength(14)
    expect(ORDER_KINDS.slice(13)).toEqual(['payment_retries'])
    expect(lapseSweepOn('payment_retries')).toBe(false)
    expect(lapseSweepOn('lapse_sweep')).toBe(true)
    expect(lapseSweepOn(ON)).toBe(true)
    for (const off of [null, undefined, '', BOOKING_KINDS_ON, 'lapse', 'lapse_sweeps', 'membership_changes,payment_date_changes,card_moves']) expect(lapseSweepOn(off)).toBe(false)
  })

  it("off (every other kind on, and the environment naming it): the sweep reads nothing and cancels nothing, and the database's own sweep is still the one that lapses the booking", async () => {
    await withBooking(creditSeat, async ({ bookingId }) => {
      await paymentNeeded(bookingId)
      const before = await snapshot(bookingId)
      const statements: string[] = []
      const watched = Object.assign(Object.create(db) as Db, {
        query: async (sql: string, params?: never[]) => {
          statements.push(sql)
          return db.query(sql, params)
        },
      })
      // The run's own switch decides: process.env naming the kind changes nothing.
      await withSwitch(ON, async () => {
        for (const off of [null, '', BOOKING_KINDS_ON]) {
          expect(await lapseSweep(watched, { requestId: 'lapse-sweep-test', orderSwitch: off })).toEqual({ ...NOTHING, ran: false })
        }
      })
      expect(statements).toEqual([])
      expect(await snapshot(bookingId)).toEqual(before)
      await runLapseSweep(db)
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'cancelled', cancel_reason: 'membership_lapsed' })
      expect(await lapseRows(bookingId)).toEqual([])
    })
  })

  it("on for the run with the environment's switch empty: the sweep runs (it never reads process.env)", async () => {
    await withBooking(creditSeat, async ({ bookingId }) => {
      await paymentNeeded(bookingId)
      await withSwitch('', async () => {
        expect(await lapseSweep(db, { requestId: 'lapse-sweep-test', orderSwitch: 'lapse_sweep' })).toMatchObject({ ran: true, lapsed: 1 })
      })
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'cancelled' })
    })
  })

  it('the cap is the scheduled bound of reconcile (50)', () => {
    expect(LAPSE_SWEEP_MAX_ITEMS).toBe(50)
  })
})

describe('lapsePlanOf (Q48)', () => {
  const booking = (over: Partial<LoadedBooking>): LoadedBooking =>
    ({ status: 'payment_needed', pricePaid: 0, refundOwed: 0, redemptionSource: 'membership_credit', creditPeriodId: 'p', seats: [{ guestType: 'account_holder', unitPrice: 20, payBy: 'membership_credit' }], ...over }) as LoadedBooking
  const paidGuest = { pricePaid: 20, seats: [{ guestType: 'account_holder', unitPrice: 20, payBy: 'membership_credit' }, { guestType: 'additional_guest', unitPrice: 20, payBy: 'paid' }] } as Partial<LoadedBooking>
  const before = { inside: false, started: false }
  const inside = { inside: true, started: false }
  const started = { inside: true, started: true }

  it('24 hours or more before: everything back, as the cancel the customer would make', () => {
    expect(lapsePlanOf(booking({}), before)).toEqual({ kind: 'cancel_credit', back: true, kept: null })
    expect(lapsePlanOf(booking(paidGuest), before)).toEqual({ kind: 'cancel_credit', back: true, kept: null })
    expect(lapsePlanOf(booking({ pricePaid: 20 }), before)).toEqual({ kind: 'cancel', back: true, kept: null })
  })

  it('inside 24 hours or started: Cancel & return credit with nothing back, and why; card refund money owed never decides it (W43a, review S1)', () => {
    expect(lapsePlanOf(booking(paidGuest), inside)).toEqual({ kind: 'cancel_credit', back: false, kept: 'inside_24_hours' })
    expect(lapsePlanOf(booking(paidGuest), started)).toEqual({ kind: 'cancel_credit', back: false, kept: 'session_started' })
    expect(lapsePlanOf(booking({ pricePaid: 20 }), inside)).toEqual({ kind: 'cancel_credit', back: false, kept: 'inside_24_hours' })
    // Money owed, 24 hours or more before: the same plan as with nothing owed (what is owed is left out of the figure, not out of the plan).
    expect(lapsePlanOf(booking({ ...paidGuest, refundOwed: 5 }), before)).toEqual({ kind: 'cancel_credit', back: true, kept: null })
    expect(lapsePlanOf(booking({ ...paidGuest, refundOwed: 20 }), before)).toEqual({ kind: 'cancel_credit', back: true, kept: null })
    expect(lapsePlanOf(booking({ pricePaid: 20, refundOwed: 5 }), before)).toEqual({ kind: 'cancel', back: true, kept: null })
    // Only the clock keeps money.
    expect(lapsePlanOf(booking({ ...paidGuest, refundOwed: 5 }), inside)).toEqual({ kind: 'cancel_credit', back: false, kept: 'inside_24_hours' })
    expect(lapsePlanOf(booking({ ...paidGuest, refundOwed: 5 }), started)).toEqual({ kind: 'cancel_credit', back: false, kept: 'session_started' })
  })
})


// Brief W46 item 5 (G-plan 2.1; W43 "Noticed" 4): the booking's lapse facts on the refund-figures read, which the
// booking detail already calls (W47 shows them). Before W46 a lapsed booking said nothing about why it was cancelled or
// what happened to its money on any screen.
describe('W46 item 5: the refund-figures read says why a booking lapsed, and what was given back, kept and left owed (only a lapsed booking has `lapse`)', () => {
  async function figures(bookingId: string): Promise<BookingRefundFiguresRouteOutput> {
    const response = await figuresRoute(
      new Request(`https://worker.test/api/v1/staff/bookings/${bookingId}/refund-figures`, { headers: { authorization: 'Bearer test-staff-api-key', 'x-staff-email': REPLAY_USER.email } }),
      { params: Promise.resolve({ bookingId }) }
    )
    expect(response.status).toBe(200)
    return ((await response.json()) as { data: BookingRefundFiguresRouteOutput }).data
  }
  const owed = (bookingId: string, amount: string) => db.query('UPDATE bookings SET refund_owed_amount = $1::numeric WHERE id = $2', [amount, bookingId])
  const FIRST = "the membership payment wasn't made by the deadline."

  it('a booking that has not lapsed has no lapse: payment needed, confirmed, and cancelled by staff', async () => {
    await withBooking(creditSeatAndPaidGuest, async ({ bookingId }) => {
      const before = await figures(bookingId)
      // The read is exactly as it was before W46: the figures and their words, and no `lapse` field at all.
      expect(before).not.toHaveProperty('lapse')
      expect(Object.keys(before).sort()).toEqual(['cardLeft', 'cashLeft', 'customerId', 'left', 'paidLine', 'paidWords', 'parts', 'pricePaid', 'refundOwed', 'status'])
      expect(before).toMatchObject({ status: 'confirmed', pricePaid: 20, refundOwed: 0, left: 20, cashLeft: 20, paidLine: expect.any(String), paidWords: expect.any(String) })
      await paymentNeeded(bookingId)
      expect(await figures(bookingId)).not.toHaveProperty('lapse')
      await db.query("UPDATE bookings SET status = 'cancelled', cancelled_at = now() WHERE id = $1", [bookingId])
      const cancelled = await figures(bookingId)
      expect(cancelled.status).toBe('cancelled')
      expect(cancelled).not.toHaveProperty('lapse')
    })
  })

  it('nothing paid: when it lapsed and the deadline that passed, with nothing given, kept or owed, and the one sentence', async () => {
    await withBooking(creditSeat, async ({ bookingId }) => {
      vi.setSystemTime(SESSION_START - 25 * HOUR)
      await paymentNeeded(bookingId)
      await sweep()
      const { lapse, status } = await figures(bookingId)
      expect(status).toBe('cancelled')
      expect(lapse).toEqual({ at: expect.any(String), paymentDueBy: expect.any(String), givenBack: 0, kept: 0, keptBecause: null, owed: 0, words: `Lapsed on 11 November 2026: ${FIRST}` })
      // The time is the lapse's own row's, and the deadline the one that passed (a minute before).
      const [row] = await db.query<{ at: Date }>("SELECT at FROM audit_log WHERE action = 'booking.lapsed' AND entity_id = $1", [bookingId])
      expect(lapse?.at).toBe(new Date(row?.at as Date).toISOString())
      expect(new Date(lapse?.paymentDueBy ?? 0).getTime()).toBeLessThan(new Date(lapse?.at ?? 0).getTime())
    })
  })

  it('a £20 paid guest, 25 hours before: £20 given back as store credit, nothing kept', async () => {
    await withBooking(creditSeatAndPaidGuest, async ({ bookingId }) => {
      vi.setSystemTime(SESSION_START - 25 * HOUR)
      await paymentNeeded(bookingId)
      await sweep()
      expect((await figures(bookingId)).lapse).toMatchObject({ givenBack: 20, kept: 0, keptBecause: null, owed: 0, words: `Lapsed on 11 November 2026: ${FIRST} £20.00 went back as store credit.` })
    })
  })

  it.each([
    ['23 hours before', SESSION_START - 23 * HOUR, 'inside_24_hours', 'it lapsed inside 24 hours of the session'],
    ['an hour after the session started', SESSION_START + HOUR, 'session_started', 'the session had already started'],
  ] as const)('a £20 paid guest, %s: nothing given back, £20 kept, and why', async (_name, at, because, why) => {
    await withBooking(creditSeatAndPaidGuest, async ({ bookingId }) => {
      vi.setSystemTime(at)
      await paymentNeeded(bookingId)
      await sweep()
      const day = at < SESSION_START ? '11 November 2026' : '12 November 2026'
      expect((await figures(bookingId)).lapse).toMatchObject({ givenBack: 0, kept: 20, keptBecause: because, owed: 0, words: `Lapsed on ${day}: ${FIRST} £20.00 was kept: ${why}.` })
    })
  })

  it('£5 of the £20 owed, 25 hours before: £15 given back, nothing kept, £5 left owed; what is owed now is in the figures, and comes off when staff give it, while the lapse still says £5 was owed then', async () => {
    await withBooking(creditSeatAndPaidGuest, async ({ bookingId }) => {
      vi.setSystemTime(SESSION_START - 25 * HOUR)
      await paymentNeeded(bookingId)
      await owed(bookingId, '5.00')
      await sweep()
      const words = `Lapsed on 11 November 2026: ${FIRST} £15.00 went back as store credit. £5.00 of card refund money was still owed on it, and was left owed.`
      expect(await figures(bookingId)).toMatchObject({ refundOwed: 5, lapse: { givenBack: 15, kept: 0, keptBecause: null, owed: 5, words } })
      await refundOwed(db, bookingId, { amount: 5, refundMethod: 'credit' }, staff)
      expect(await figures(bookingId)).toMatchObject({ refundOwed: 0, lapse: { givenBack: 15, kept: 0, owed: 5, words } })
    })
  })

  it("£5 of the £20 owed and a paid towel (£5), 23 hours before: nothing given back; £20 kept (the guest's £15 that isn't owed and the towel's £5); £5 left owed", async () => {
    await withBooking({ booking: { ...paidSeat([mo, alex]), ...memberCredit, addons: [{ ...towel, redemptionSource: 'paid' }] }, payment: { method: 'cash', confirmedCashAmount: 25 } }, async ({ bookingId }) => {
      vi.setSystemTime(SESSION_START - 23 * HOUR)
      await paymentNeeded(bookingId)
      await owed(bookingId, '5.00')
      await sweep()
      expect((await figures(bookingId)).lapse).toMatchObject({
        givenBack: 0,
        kept: 20,
        keptBecause: 'inside_24_hours',
        owed: 5,
        words: `Lapsed on 11 November 2026: ${FIRST} £20.00 was kept: it lapsed inside 24 hours of the session. £5.00 of card refund money was still owed on it, and was left owed.`,
      })
    })
  })

  it("a booking the database's old sweep lapsed (its reason on the booking, no row of its own; it only ever lapsed one with nothing paid): when it was cancelled, and the one sentence", async () => {
    await withBooking(creditSeat, async ({ bookingId }) => {
      await db.query("UPDATE bookings SET status = 'cancelled', cancelled_at = '2026-11-09T14:00:00Z', cancel_reason = 'membership_lapsed' WHERE id = $1", [bookingId])
      expect((await figures(bookingId)).lapse).toEqual({ at: '2026-11-09T14:00:00.000Z', paymentDueBy: null, givenBack: 0, kept: 0, keptBecause: null, owed: 0, words: `Lapsed on 9 November 2026: ${FIRST}` })
    })
  })

  it('the words: the date is the London date (23:30 UTC on 10 July is 11 July in London); each part appears only when it has an amount', () => {
    const none = { givenBack: 0, kept: 0, keptBecause: null, owed: 0 }
    expect(lapsedWords({ at: '2026-07-10T23:30:00.000Z', ...none })).toBe(`Lapsed on 11 July 2026: ${FIRST}`)
    expect(lapsedWords({ at: '2026-12-01T00:30:00.000Z', ...none, givenBack: 20.5, owed: 4 })).toBe(`Lapsed on 1 December 2026: ${FIRST} £20.50 went back as store credit. £4.00 of card refund money was still owed on it, and was left owed.`)
    expect(lapsedWords({ at: '2026-12-01T00:30:00.000Z', ...none, kept: 5, keptBecause: 'session_started' })).toBe(`Lapsed on 1 December 2026: ${FIRST} £5.00 was kept: the session had already started.`)
  })
})
