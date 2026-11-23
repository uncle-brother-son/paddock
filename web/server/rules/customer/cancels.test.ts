import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { POST as bookingCancelRoute } from '@/app/api/v1/customer/bookings/[bookingId]/cancel/route'
import { POST as bookingQuoteRoute } from '@/app/api/v1/customer/bookings/[bookingId]/cancel/quote/route'
import { POST as eventCancelRoute } from '@/app/api/v1/customer/event-bookings/[eventBookingId]/cancel/route'
import { POST as eventQuoteRoute } from '@/app/api/v1/customer/event-bookings/[eventBookingId]/cancel/quote/route'
import { POST as staffCreditQuoteRoute } from '@/app/api/v1/staff/bookings/[bookingId]/cancel-credit/quote/route'
import {
  customerBookingCancelOutputSchema,
  customerBookingCancelQuoteSchema,
  customerCancelRefusalDetailsSchema,
  customerEventCancelOutputSchema,
  customerEventCancelQuoteSchema,
} from '@/contracts'
import type { Db } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import { CANCEL_CREDIT_WORDS } from '@/server/rules/bookings/failure-messages'
import { BOOKING_KINDS_ON, withSwitch } from '@/server/rules/testing/sweep/booking-presses'
import { replay, REPLAY_USER, startReplay, type ReplayEnvironment, type ScenarioContext } from '@/server/rules/testing/sweep/run'
import { workerSide } from '@/server/rules/testing/sweep/worker'
import { bea, ID, memberCredit, mo, paidSeat, sam, seed } from '@/server/rules/testing/replay/scenarios'
import { replayStripe } from '@/server/rules/testing/replay/stripe-binding'
import { startsWithinRealHours } from '@/server/rules/time/london-time'
import type { FakeStripe } from '@/server/stripe/fake'
import { CUSTOMER_BOOKING_REFUSAL_WORDS, CUSTOMER_CANCEL_WORDS as WORDS, CUSTOMER_EVENT_REFUSAL_WORDS } from './cancel-words'
import { forCustomer } from './cancels'

// Brief W33 (E-plan 4.11, 5.1; Wayne's Q44): the website's four cancel routes, through the routes as the website will
// call them, on the replay's live schema (the database's own functions and constraints, migration 024's
// event_cancellation_quote among them). The bookings and event orders are made through the Worker's routes (sweep/worker.ts),
// as the screens press them. Stripe is only ever the fake, and a customer's cancel must never call it.
// The replay's clock is 10 Nov 2026 09:00; the session is 12 Nov 10:00; the event is 1 Dec 19:00, cut-off 30 Nov 19:00.

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
// The token here is the Supabase user's id. Checking a real token's signature is server/auth/customer.test.ts's; the
// customer is still found from it by the real authenticateCustomer.
vi.mock('@/server/auth/customer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/auth/customer')>()),
  defaultTokenVerifier: () => async (token: string) => ({ authUserId: token }),
}))

const STAFF_KEY = 'test-staff-api-key'
/** Sam (ID.customer) and Mo (ID.member) signed in; a third sign-in linked to no customer. */
const SAM = '33000000-0000-4000-8000-000000000001'
const MO = '33000000-0000-4000-8000-000000000002'
const NOBODY = '33000000-0000-4000-8000-000000000003'

/** ORDER_SWITCH as it is live today (CLAUDE.md, 15 Nov 2026): every kind but the website's. */
const LIVE_TODAY = 'no_stripe,saved_card,reader,membership,booking_changes,reader_flows,order_refunds,event_cancels'
/** With the website's cancels on. */
const CUSTOMER_KINDS_ON = `${LIVE_TODAY},customer_cancels`

let environment: ReplayEnvironment
let db: Db
beforeAll(async () => {
  process.env.STAFF_API_KEY = STAFF_KEY
  environment = await startReplay()
  db = environment.database.db
  holder.db = db
  // The three sign-ins. The Worker's own role can't reach the auth schema (as live), so the owner adds them, once:
  // the replay empties the public tables between scenarios, not this one.
  await environment.database.pg.exec(`RESET ROLE; INSERT INTO auth.users (id) VALUES ('${SAM}'), ('${MO}'), ('${NOBODY}'); SET ROLE paddock_worker;`)
})
afterAll(() => environment.stop())

/** The replay's seed, with Sam's and Mo's sign-ins. */
async function seedWithSignIns(seedDb: Db, stripe: FakeStripe): Promise<void> {
  await seed(seedDb, stripe)
  await seedDb.query('UPDATE customers SET auth_user_id = $1::uuid WHERE id = $2::uuid', [SAM, ID.customer])
  await seedDb.query('UPDATE customers SET auth_user_id = $1::uuid WHERE id = $2::uuid', [MO, ID.member])
}

type Details = { reason?: string; message?: string; quote?: Record<string, unknown>; kinds?: string[] }
type Answer = { status: number; replayed: boolean; body: { ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string; field?: string; details?: Details } } }
type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>
type Call = { as?: string | null; key?: string | null; orderSwitch?: string }

async function call(route: unknown, url: string, params: Record<string, string>, body: unknown, { as = SAM, key = null, orderSwitch = CUSTOMER_KINDS_ON }: Call = {}): Promise<Answer> {
  return withSwitch(orderSwitch, async () => {
    const response = await (route as Handler)(
      new Request(`https://worker.test${url}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(as ? { authorization: `Bearer ${as}` } : {}), ...(key ? { 'idempotency-key': key } : {}) },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve(params) }
    )
    return { status: response.status, replayed: response.headers.get('Idempotency-Replayed') === 'true', body: (await response.json()) as Answer['body'] }
  })
}

const quoteBooking = (bookingId: string, options: Call = {}) => call(bookingQuoteRoute, `/api/v1/customer/bookings/${bookingId}/cancel/quote`, { bookingId }, {}, options)
const cancelBooking = (bookingId: string, storeCredit: number | undefined, options: Call = {}) =>
  call(bookingCancelRoute, `/api/v1/customer/bookings/${bookingId}/cancel`, { bookingId }, storeCredit === undefined ? {} : { confirmed: { storeCredit } }, { key: crypto.randomUUID(), ...options })
const quoteEvent = (eventBookingId: string, attendeeIds?: string[], options: Call = {}) =>
  call(eventQuoteRoute, `/api/v1/customer/event-bookings/${eventBookingId}/cancel/quote`, { eventBookingId }, attendeeIds ? { attendeeIds } : {}, options)
const cancelEvent = (eventBookingId: string, attendeeIds: string[] | undefined, storeCredit: number | undefined, options: Call = {}) =>
  call(
    eventCancelRoute,
    `/api/v1/customer/event-bookings/${eventBookingId}/cancel`,
    { eventBookingId },
    { ...(attendeeIds ? { attendeeIds } : {}), ...(storeCredit === undefined ? {} : { confirmed: { storeCredit } }) },
    { key: crypto.randomUUID(), ...options }
  )

/** Every sentence a customer may be told: a refusal's words must be one of them, never a staff sentence. */
const CUSTOMER_SENTENCES: ReadonlySet<string> = new Set(Object.values(WORDS))
function refusedWith(answer: Answer, status: number, code: string, reason: string, message: string): void {
  expect(answer.status).toBe(status)
  expect(answer.body.error).toMatchObject({ code, message, details: { reason, message } })
  expect(CUSTOMER_SENTENCES.has(answer.body.error?.message ?? '')).toBe(true)
  expect(customerCancelRefusalDetailsSchema.safeParse(answer.body.error?.details).success).toBe(true)
}

// --- What the tests read

const balance = async (customerId = ID.customer) => Number((await db.query<{ balance: string }>('SELECT store_credit_balance::text AS balance FROM customers WHERE id = $1', [customerId]))[0]?.balance)
const storeCreditRows = (customerId = ID.customer) =>
  db.query<{ amount: string; reason: string; staff_id: string | null; order_id: string | null; booking_id: string | null }>(
    "SELECT amount::numeric(10,2)::text AS amount, reason, staff_id, order_id, booking_id FROM store_credit_transactions WHERE customer_id = $1 AND reason = 'refund' ORDER BY amount, id",
    [customerId]
  )
const audit = (entityType: string, entityId: string) =>
  db.query<{ actor_type: string; actor_id: string | null; action: string; details: Record<string, unknown> }>(
    'SELECT actor_type, actor_id, action, details FROM audit_log WHERE entity_type = $1 AND entity_id = $2 ORDER BY action, id',
    [entityType, entityId]
  )
/** The Worker's rows a cancel writes, with who they name. */
const cancelRows = async (entityType: string, entityId: string) =>
  (await audit(entityType, entityId)).filter((row) => /\.(cancel|cancel_credit|cancel_places|refund_claimed|refund_finished)$/.test(row.action))
const stripeCalls = (stripe: FakeStripe) => stripe.calls.length

// --- Session bookings

type BookingContext = ScenarioContext & { bookingId: string }

/** A booking made by the old createOrder (for Sam unless `order.customerId` says otherwise), then `work` on it. */
async function withBooking(order: Record<string, unknown>, work: (context: BookingContext) => Promise<void>, prepare?: (seedDb: Db) => Promise<void>): Promise<void> {
  await replay(
    environment,
    {
      name: 'w33 customer cancel',
      async seed(seedDb, stripe) {
        await seedWithSignIns(seedDb, stripe)
        await prepare?.(seedDb)
      },
      async run(context) {
        replayStripe.current = context.stripe
        const placed = (await context.call('createOrder', { customerId: ID.customer, ...order })) as { bookingId: string }
        if (!placed.bookingId) throw new Error(`The order failed: ${JSON.stringify(placed)}`)
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

const towel = { addonId: ID.addon, quantity: 1, unitPrice: 5, systemUnitPrice: 5 }
const onCard = { booking: paidSeat([sam]), payment: { method: 'card' } }
const cardSeatAndTowel = { booking: { ...paidSeat([sam]), addons: [{ ...towel, redemptionSource: 'paid' }] }, payment: { method: 'card' } }
const inCash = { booking: paidSeat([sam]), payment: { method: 'cash', confirmedCashAmount: 20 } }
const passBooking = { booking: { ...paidSeat([sam]), redemptionSource: 'session_pass_credit', sessionPassId: ID.ownedPass }, payment: {} }
const memberBooking = { customerId: ID.member, booking: { ...paidSeat([mo]), ...memberCredit }, payment: {} }

const bookingRow = async (bookingId: string) =>
  (await db.query<{ status: string; price_paid: string; refund_owed_amount: string; cancelled: boolean }>('SELECT status, price_paid::text, refund_owed_amount::text, cancelled_at IS NOT NULL AS cancelled FROM bookings WHERE id = $1', [bookingId]))[0]
const totalBooked = async (sessionId = ID.session) => (await db.query<{ total_booked: number }>('SELECT total_booked FROM sessions WHERE id = $1', [sessionId]))[0]?.total_booked
const addonLines = (bookingId: string) =>
  db.query<{ id: string; removed: boolean; removed_by: string | null; refunded_amount: string; card_refunded_amount: string; refund_method: string | null }>(
    'SELECT id, removed_at IS NOT NULL AS removed, removed_by, refunded_amount::numeric(10,2)::text AS refunded_amount, card_refunded_amount::numeric(10,2)::text AS card_refunded_amount, refund_method FROM addon_order_lines WHERE booking_id = $1 ORDER BY created_at, id',
    [bookingId]
  )
const passSessions = async () => (await db.query<{ n: number }>('SELECT sessions_remaining AS n FROM customer_session_passes WHERE id = $1', [ID.ownedPass]))[0]?.n
const membershipCredits = async () => (await db.query<{ n: number }>('SELECT addon_credits_remaining AS n FROM customer_memberships WHERE id = $1', [ID.membership]))[0]?.n

/** Everything a refused cancel must leave exactly as it was. */
async function bookingSnapshot(bookingId: string, customerId = ID.customer) {
  return {
    booking: await bookingRow(bookingId),
    places: await totalBooked(),
    lines: await addonLines(bookingId),
    pass: await passSessions(),
    credits: await membershipCredits(),
    balance: await balance(customerId),
    storeCredit: (await storeCreditRows(customerId)).length,
    rows: (await cancelRows('booking', bookingId)).length,
  }
}

/** 12 Nov 10:00, the session's start, as an instant (November: London is on UTC). */
const SESSION_START = new Date('2026-11-12T10:00:00.000Z').getTime()
/** 13 Nov 10:00, the private session's start. */
const PRIVATE_START = new Date('2026-11-13T10:00:00.000Z').getTime()
/** Mo's membership credits used this period, as the database counts them (from bookings that aren't cancelled). */
const creditsUsed = async () => Number((await db.query<{ used: number }>('SELECT credits_used AS used FROM membership_current_credits WHERE period_id = $1', [ID.creditPeriod]))[0]?.used)

describe("a customer's own session booking (brief W33 items 1 and 5; Q44)", () => {
  it('a card-paid booking with a paid towel: everything (£25) goes to store credit, with no Stripe call at all; the booking cancelled, its place released, every add-on gone, the rows the customer\'s', async () => {
    await withBooking(cardSeatAndTowel, async ({ bookingId, stripe }) => {
      const quote = await quoteBooking(bookingId)
      expect(quote.status).toBe(200)
      expect(quote.body.data).toEqual({ bookingId, canCancel: true, storeCredit: 25, creditReturned: null, blocked: null })
      expect(customerBookingCancelQuoteSchema.safeParse(quote.body.data).success).toBe(true)

      const before = { calls: stripeCalls(stripe), balance: await balance(), places: (await totalBooked()) ?? 0 }
      const cancelled = await cancelBooking(bookingId, 25)
      expect(cancelled.status).toBe(200)
      expect(cancelled.body.data).toEqual({ cancelled: true, bookingId, storeCreditRefunded: 25, storeCreditBalance: before.balance + 25, creditReturned: null, creditUsableAgain: false, addonCreditsReturned: 0 })
      expect(customerBookingCancelOutputSchema.safeParse(cancelled.body.data).success).toBe(true)

      // Nothing online ever goes back to a card: Stripe was not called, for a refund or anything else.
      expect(stripeCalls(stripe)).toBe(before.calls)
      expect(stripe.refundsSent).toEqual([])
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'cancelled', cancelled: true, refund_owed_amount: '0.00' })
      expect(await totalBooked()).toBe(before.places - 1)
      expect(await balance()).toBe(before.balance + 25)
      // The store credit names no staff member; the towel's line is removed by nobody on the staff, refunded to credit.
      const credit = await storeCreditRows()
      expect(credit.reduce((total, row) => total + Number(row.amount), 0)).toBe(25)
      expect(credit.every((row) => row.staff_id === null)).toBe(true)
      expect(await addonLines(bookingId)).toEqual([expect.objectContaining({ removed: true, removed_by: null, refunded_amount: '5.00', card_refunded_amount: '0.00', refund_method: 'credit' })])
      // The claim, its finish and the cancel's own row: all the customer's, one transaction, marked as the website's.
      const rows = await cancelRows('booking', bookingId)
      expect(rows.map((row) => row.action)).toEqual(['booking.cancel', 'booking.refund_claimed', 'booking.refund_finished'])
      expect(rows.every((row) => row.actor_type === 'customer' && row.actor_id === ID.customer)).toBe(true)
      expect(rows[0]?.details).toMatchObject({ channel: 'customer', refundMethod: 'credit', seatRefund: 20, addonsRefund: 5, cardRefunded: 0, storeCreditRefunded: 25, owed: 0, placesReleased: 1 })
      expect(rows[1]?.details).toMatchObject({ channel: 'customer', kind: 'cancel', amount: 25, method: 'credit', worker: true, plan: { card: [], storeCredit: 25 } })
      expect(rows[2]?.details).toMatchObject({ outcome: 'given', cardRefunded: 0, storeCreditRefunded: 25, owed: 0 })
      // Nothing is left open: no claim holds the booking.
      expect((await quoteBooking(bookingId)).body.data).toMatchObject({ canCancel: false, blocked: { reason: 'already_cancelled', message: WORDS.alreadyCancelled } })
    })
  })

  it('money paid in cash goes to store credit too', async () => {
    await withBooking(inCash, async ({ bookingId, stripe }) => {
      const before = { calls: stripeCalls(stripe), balance: await balance() }
      expect((await quoteBooking(bookingId)).body.data).toMatchObject({ canCancel: true, storeCredit: 20 })
      const cancelled = await cancelBooking(bookingId, 20)
      expect(cancelled.body.data).toMatchObject({ cancelled: true, storeCreditRefunded: 20, storeCreditBalance: before.balance + 20 })
      expect(await balance()).toBe(before.balance + 20)
      expect(stripeCalls(stripe)).toBe(before.calls)
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'cancelled' })
    })
  })

  it('a paid guest: their seat goes to store credit with the booking (two seats on the card, £40)', async () => {
    await withBooking(onCard, async ({ bookingId, call: old, stripe }) => {
      await old('addBookingGuest', { bookingId, ...bea })
      await old('addBookingGuest', { bookingId, ...bea, payment: { method: 'card' } })
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'confirmed', price_paid: '40.00' })
      const before = { calls: stripeCalls(stripe), balance: await balance(), places: (await totalBooked()) ?? 0 }
      expect((await quoteBooking(bookingId)).body.data).toMatchObject({ canCancel: true, storeCredit: 40 })
      const cancelled = await cancelBooking(bookingId, 40)
      expect(cancelled.body.data).toMatchObject({ cancelled: true, storeCreditRefunded: 40, storeCreditBalance: before.balance + 40 })
      expect(await totalBooked()).toBe(before.places - 2)
      expect(stripeCalls(stripe)).toBe(before.calls)
    })
  })

  it('a membership credit booking: cancelled with its credit back and no money; no claim; the row is the customer\'s', async () => {
    await withBooking(memberBooking, async ({ bookingId, stripe }) => {
      const before = { calls: stripeCalls(stripe), balance: await balance(ID.member), places: (await totalBooked()) ?? 0 }
      expect((await quoteBooking(bookingId, { as: MO })).body.data).toEqual({ bookingId, canCancel: true, storeCredit: 0, creditReturned: 'membership_credit', blocked: null })
      const cancelled = await cancelBooking(bookingId, 0, { as: MO })
      expect(cancelled.body.data).toEqual({ cancelled: true, bookingId, storeCreditRefunded: 0, creditReturned: 'membership_credit', creditUsableAgain: true, addonCreditsReturned: 0 })
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'cancelled' })
      expect(await totalBooked()).toBe(before.places - 1)
      expect(await balance(ID.member)).toBe(before.balance)
      expect(stripeCalls(stripe)).toBe(before.calls)
      const rows = await cancelRows('booking', bookingId)
      expect(rows.map((row) => [row.action, row.actor_type, row.actor_id])).toEqual([['booking.cancel_credit', 'customer', ID.member]])
      expect(rows[0]?.details).toMatchObject({ channel: 'customer', creditUsableAgain: true, placesReleased: 1, storeCreditRefunded: 0 })
    })
  })

  it('a pass booking: cancelled, its pass session back', async () => {
    await withBooking(passBooking, async ({ bookingId }) => {
      const sessions = (await passSessions()) ?? 0
      expect((await quoteBooking(bookingId)).body.data).toEqual({ bookingId, canCancel: true, storeCredit: 0, creditReturned: 'session_pass_credit', blocked: null })
      const cancelled = await cancelBooking(bookingId, 0)
      expect(cancelled.body.data).toEqual({ cancelled: true, bookingId, storeCreditRefunded: 0, creditReturned: 'session_pass_credit', creditUsableAgain: true, addonCreditsReturned: 0 })
      expect(await passSessions()).toBe(sessions + 1)
      expect((await cancelRows('booking', bookingId))[0]).toMatchObject({ action: 'booking.cancel_credit', actor_type: 'customer', details: { channel: 'customer', passReturned: ID.ownedPass } })
    })
  })

  it("a pass booking with a paid guest: staff are told to remove the guest first; the customer's cancel gives the pass session back and the guest's £20 to store credit (Q44), with no Stripe call", async () => {
    await withBooking(passBooking, async ({ bookingId, call: old, stripe }) => {
      await old('addBookingGuest', { bookingId, ...bea })
      await old('addBookingGuest', { bookingId, ...bea, payment: { method: 'card' } })
      // Control: the staff quote for the same booking still refuses it from the booking page.
      const staff = await withSwitch(CUSTOMER_KINDS_ON, async () => {
        const response = await (staffCreditQuoteRoute as Handler)(
          new Request(`https://worker.test/api/v1/staff/bookings/${bookingId}/cancel-credit/quote`, {
            method: 'POST',
            headers: { authorization: `Bearer ${STAFF_KEY}`, 'x-staff-email': REPLAY_USER.email, 'content-type': 'application/json' },
            body: JSON.stringify({ addonLineIds: [] }),
          }),
          { params: Promise.resolve({ bookingId }) }
        )
        return (await response.json()) as { data?: { blocked: { reason: string; message: string } | null } }
      })
      expect(staff.data?.blocked).toEqual({ reason: 'paid_guests_present', message: CANCEL_CREDIT_WORDS.paidGuestsPresent })

      const before = { calls: stripeCalls(stripe), balance: await balance(), places: (await totalBooked()) ?? 0, sessions: (await passSessions()) ?? 0 }
      expect((await quoteBooking(bookingId)).body.data).toEqual({ bookingId, canCancel: true, storeCredit: 20, creditReturned: 'session_pass_credit', blocked: null })
      const cancelled = await cancelBooking(bookingId, 20)
      expect(cancelled.body.data).toEqual({ cancelled: true, bookingId, storeCreditRefunded: 20, storeCreditBalance: before.balance + 20, creditReturned: 'session_pass_credit', creditUsableAgain: true, addonCreditsReturned: 0 })
      expect(await passSessions()).toBe(before.sessions + 1)
      expect(await totalBooked()).toBe(before.places - 2)
      expect(await balance()).toBe(before.balance + 20)
      expect(stripeCalls(stripe)).toBe(before.calls)
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'cancelled', refund_owed_amount: '0.00' })
      const rows = await cancelRows('booking', bookingId)
      expect(rows.map((row) => row.action)).toEqual(['booking.cancel_credit', 'booking.refund_claimed', 'booking.refund_finished'])
      expect(rows.every((row) => row.actor_type === 'customer' && row.actor_id === ID.customer)).toBe(true)
      expect(rows[0]?.details).toMatchObject({ channel: 'customer', seatRefund: 20, refundMethod: 'credit', storeCreditRefunded: 20, cardRefunded: 0, passReturned: ID.ownedPass })
    })
  })

  it("a member's pass booking with a credit towel and a paid towel: the add-on credit back to the membership, the paid £5 to store credit, the pass session back", async () => {
    const creditTowel = { ...towel, redemptionSource: 'membership_credit', membershipId: ID.membership }
    const passWithACreditTowel = { customerId: ID.member, booking: { ...paidSeat([mo]), redemptionSource: 'session_pass_credit', sessionPassId: ID.ownedPass, addons: [creditTowel] }, payment: {} }
    await withBooking(
      passWithACreditTowel,
      async ({ bookingId, call: old, stripe }) => {
        await old('addBookingGuest', { bookingId, addons: [{ addonId: ID.addon, quantity: 1 }] })
        await old('addBookingGuest', { bookingId, addons: [{ addonId: ID.addon, quantity: 1 }], payment: { method: 'card' } })
        expect(await addonLines(bookingId)).toHaveLength(2)
        const before = { calls: stripeCalls(stripe), balance: await balance(ID.member), sessions: (await passSessions()) ?? 0, credits: (await membershipCredits()) ?? 0 }
        expect((await quoteBooking(bookingId, { as: MO })).body.data).toEqual({ bookingId, canCancel: true, storeCredit: 5, creditReturned: 'session_pass_credit', blocked: null })
        const cancelled = await cancelBooking(bookingId, 5, { as: MO })
        expect(cancelled.body.data).toEqual({ cancelled: true, bookingId, storeCreditRefunded: 5, storeCreditBalance: before.balance + 5, creditReturned: 'session_pass_credit', creditUsableAgain: true, addonCreditsReturned: 1 })
        expect(await membershipCredits()).toBe(before.credits + 1)
        expect(await passSessions()).toBe(before.sessions + 1)
        expect(await balance(ID.member)).toBe(before.balance + 5)
        expect(stripeCalls(stripe)).toBe(before.calls)
        const lines = await addonLines(bookingId)
        expect(lines.every((line) => line.removed && line.removed_by === null)).toBe(true)
        expect(lines.map((line) => line.refund_method).sort()).toEqual(['credit', 'credit_returned'])
      },
      async (seedDb) => {
        await seedDb.query('UPDATE customer_session_passes SET customer_id = $1, sessions_remaining = 5 WHERE id = $2', [ID.member, ID.ownedPass])
      }
    )
  })

  it("a payment-needed booking with nothing to give back is simply cancelled: no claim, inside 24 hours too (step D's rule for it); but not once its session has started (W33a, review S1)", async () => {
    await withBooking(passBooking, async ({ bookingId, stripe }) => {
      await db.query("UPDATE bookings SET status = 'payment_needed' WHERE id = $1", [bookingId])
      // Half an hour into the session: refused outright, nothing changed.
      vi.setSystemTime(SESSION_START + 30 * 60_000)
      const started = await bookingSnapshot(bookingId)
      expect((await quoteBooking(bookingId)).body.data).toMatchObject({ canCancel: false, storeCredit: 0, blocked: { reason: 'within_24_hours', message: WORDS.within24Hours } })
      refusedWith(await cancelBooking(bookingId, 0), 409, 'CONFLICT', 'within_24_hours', WORDS.within24Hours)
      expect(await bookingSnapshot(bookingId)).toEqual(started)
      vi.setSystemTime(SESSION_START - 22 * 3600_000)
      const before = { calls: stripeCalls(stripe), balance: await balance(), places: (await totalBooked()) ?? 0 }
      expect((await quoteBooking(bookingId)).body.data).toMatchObject({ canCancel: true, storeCredit: 0, blocked: null })
      const cancelled = await cancelBooking(bookingId, 0)
      expect(cancelled.body.data).toMatchObject({ cancelled: true, storeCreditRefunded: 0 })
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'cancelled' })
      expect(await totalBooked()).toBe(before.places - 1)
      expect(await balance()).toBe(before.balance)
      expect(stripeCalls(stripe)).toBe(before.calls)
      expect((await cancelRows('booking', bookingId)).map((row) => [row.action, row.actor_type])).toEqual([['booking.cancel_credit', 'customer']])
    })
  })
})

describe("what a customer's session cancel is refused with, in their own words (brief W33 item 2)", () => {
  it("another customer's booking is refused exactly as one that doesn't exist, quote and cancel, and nothing changes", async () => {
    await withBooking(cardSeatAndTowel, async ({ bookingId }) => {
      const before = await bookingSnapshot(bookingId)
      const missing = crypto.randomUUID()
      // Mo asks about Sam's booking.
      const quote = await quoteBooking(bookingId, { as: MO })
      refusedWith(quote, 404, 'NOT_FOUND', 'booking_not_found', WORDS.bookingNotFound)
      expect(quote.body.error).toEqual((await quoteBooking(missing, { as: MO })).body.error)
      const cancel = await cancelBooking(bookingId, 25, { as: MO })
      refusedWith(cancel, 404, 'NOT_FOUND', 'booking_not_found', WORDS.bookingNotFound)
      expect(cancel.body.error).toEqual((await cancelBooking(missing, 25, { as: MO })).body.error)
      // Whatever amount is sent, and with none: never a different answer for a booking that exists.
      refusedWith(await cancelBooking(bookingId, 0, { as: MO }), 404, 'NOT_FOUND', 'booking_not_found', WORDS.bookingNotFound)
      expect(await bookingSnapshot(bookingId)).toEqual(before)
      // It is still Sam's to cancel.
      expect((await cancelBooking(bookingId, 25)).body.data).toMatchObject({ cancelled: true, storeCreditRefunded: 25 })
    })
  })

  it('not signed in, and a sign-in linked to no customer, are refused before anything is read', async () => {
    await withBooking(onCard, async ({ bookingId }) => {
      const before = await bookingSnapshot(bookingId)
      for (const route of [quoteBooking(bookingId, { as: null }), cancelBooking(bookingId, 20, { as: null })]) {
        const answer = await route
        expect(answer.status).toBe(401)
        expect(answer.body.error?.code).toBe('UNAUTHORISED')
      }
      const unlinked = await cancelBooking(bookingId, 20, { as: NOBODY })
      expect(unlinked.status).toBe(403)
      expect(unlinked.body.error?.code).toBe('CUSTOMER_NOT_LINKED')
      expect(await bookingSnapshot(bookingId)).toEqual(before)
    })
  })

  it('inside 24 hours: refused, nothing changed; a second more than 24 hours before is allowed; and exactly 24 hours counts as outside (step D\'s rule)', async () => {
    // The rule itself, to the millisecond: a start exactly 24 real hours away is not inside; one a millisecond nearer is.
    expect(startsWithinRealHours('2026-11-12T10:00:00', 24, new Date(SESSION_START - 24 * 3600_000))).toBe(false)
    expect(startsWithinRealHours('2026-11-12T10:00:00', 24, new Date(SESSION_START - 24 * 3600_000 + 1))).toBe(true)
    await withBooking(cardSeatAndTowel, async ({ bookingId }) => {
      // A second inside (the replay's clock moves a millisecond a statement, so the exact instant is the rule's own test above).
      vi.setSystemTime(SESSION_START - 24 * 3600_000 + 1000)
      const before = await bookingSnapshot(bookingId)
      expect((await quoteBooking(bookingId)).body.data).toEqual({ bookingId, canCancel: false, storeCredit: 0, creditReturned: null, blocked: { reason: 'within_24_hours', message: WORDS.within24Hours } })
      refusedWith(await cancelBooking(bookingId, 25), 409, 'CONFLICT', 'within_24_hours', WORDS.within24Hours)
      refusedWith(await cancelBooking(bookingId, 0), 409, 'CONFLICT', 'within_24_hours', WORDS.within24Hours)
      // Once it has started (an hour in), the same refusal: the words cover both (review L4).
      vi.setSystemTime(SESSION_START + 3600_000)
      expect((await quoteBooking(bookingId)).body.data).toMatchObject({ canCancel: false, blocked: { reason: 'within_24_hours', message: WORDS.within24Hours } })
      expect(WORDS.within24Hours).toContain('or has already started')
      expect(await bookingSnapshot(bookingId)).toEqual(before)
      // A second outside.
      vi.setSystemTime(SESSION_START - 24 * 3600_000 - 1000)
      expect((await quoteBooking(bookingId)).body.data).toMatchObject({ canCancel: true, storeCredit: 25 })
      expect((await cancelBooking(bookingId, 25)).body.data).toMatchObject({ cancelled: true, storeCreditRefunded: 25 })
    })
  })

  it('a credit booking inside 24 hours is refused too: the credit is not returned', async () => {
    await withBooking(passBooking, async ({ bookingId }) => {
      vi.setSystemTime(SESSION_START - 22 * 3600_000)
      const before = await bookingSnapshot(bookingId)
      expect((await quoteBooking(bookingId)).body.data).toMatchObject({ canCancel: false, blocked: { reason: 'within_24_hours', message: WORDS.within24Hours } })
      refusedWith(await cancelBooking(bookingId, 0), 409, 'CONFLICT', 'within_24_hours', WORDS.within24Hours)
      expect(await bookingSnapshot(bookingId)).toEqual(before)
    })
  })

  it("W33a (review S1), a payment-needed credit booking with a paid guest (£20): 23 hours before, and once the session has started, it is refused and nothing changes; 25 hours before, the guest's £20 goes to store credit", async () => {
    await withBooking(memberBooking, async ({ bookingId, call: old, stripe }) => {
      await old('addBookingGuest', { bookingId, ...bea })
      await old('addBookingGuest', { bookingId, ...bea, payment: { method: 'cash', confirmedCashAmount: 20 } })
      // As W29 leaves a refunded membership's future credit booking (Q41): payment needed, its credit and paid guest kept.
      await db.query("UPDATE bookings SET status = 'payment_needed' WHERE id = $1", [bookingId])
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'payment_needed', price_paid: '20.00' })
      const calls = stripeCalls(stripe)
      const before = await bookingSnapshot(bookingId, ID.member)
      const tooLate = { canCancel: false, storeCredit: 0, blocked: { reason: 'within_24_hours', message: WORDS.within24Hours } }
      // 23 hours before, an hour before, and half an hour into the session.
      for (const now of [SESSION_START - 23 * 3600_000, SESSION_START - 3600_000, SESSION_START + 30 * 60_000]) {
        vi.setSystemTime(now)
        expect((await quoteBooking(bookingId, { as: MO })).body.data).toMatchObject(tooLate)
        refusedWith(await cancelBooking(bookingId, 20, { as: MO }), 409, 'CONFLICT', 'within_24_hours', WORDS.within24Hours)
        refusedWith(await cancelBooking(bookingId, 0, { as: MO }), 409, 'CONFLICT', 'within_24_hours', WORDS.within24Hours)
        expect(await bookingSnapshot(bookingId, ID.member)).toEqual(before)
      }
      // 25 hours before: Q44, everything paid goes to store credit.
      vi.setSystemTime(SESSION_START - 25 * 3600_000)
      expect((await quoteBooking(bookingId, { as: MO })).body.data).toEqual({ bookingId, canCancel: true, storeCredit: 20, creditReturned: 'membership_credit', blocked: null })
      const cancelled = await cancelBooking(bookingId, 20, { as: MO })
      expect(cancelled.body.data).toMatchObject({ cancelled: true, storeCreditRefunded: 20, storeCreditBalance: before.balance + 20, creditReturned: 'membership_credit' })
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'cancelled' })
      expect(await balance(ID.member)).toBe(before.balance + 20)
      expect(stripeCalls(stripe)).toBe(calls)
    })
  })

  it('W33a (review S1), a payment-needed booking with a paid add-on (£5) and no paid guest: refused inside 24 hours (before, the cancel went through and the £5 was kept); 25 hours before, the £5 goes to store credit', async () => {
    const passWithAPaidTowel = { booking: { ...paidSeat([sam]), redemptionSource: 'session_pass_credit', sessionPassId: ID.ownedPass, addons: [{ ...towel, redemptionSource: 'paid' }] }, payment: { method: 'cash', confirmedCashAmount: 5 } }
    await withBooking(passWithAPaidTowel, async ({ bookingId }) => {
      await db.query("UPDATE bookings SET status = 'payment_needed' WHERE id = $1", [bookingId])
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'payment_needed', price_paid: '0.00' })
      vi.setSystemTime(SESSION_START - 23 * 3600_000)
      const before = await bookingSnapshot(bookingId)
      expect((await quoteBooking(bookingId)).body.data).toMatchObject({ canCancel: false, storeCredit: 0, blocked: { reason: 'within_24_hours', message: WORDS.within24Hours } })
      refusedWith(await cancelBooking(bookingId, 5), 409, 'CONFLICT', 'within_24_hours', WORDS.within24Hours)
      refusedWith(await cancelBooking(bookingId, 0), 409, 'CONFLICT', 'within_24_hours', WORDS.within24Hours)
      expect(await bookingSnapshot(bookingId)).toEqual(before)
      vi.setSystemTime(SESSION_START - 25 * 3600_000)
      expect((await quoteBooking(bookingId)).body.data).toMatchObject({ canCancel: true, storeCredit: 5 })
      expect((await cancelBooking(bookingId, 5)).body.data).toMatchObject({ cancelled: true, storeCreditRefunded: 5, storeCreditBalance: before.balance + 5 })
    })
  })

  it('a payment still open on the booking (a card reader payment at the club): refused in plain words, nothing changed', async () => {
    await withBooking(onCard, async ({ bookingId, call: old }) => {
      await old('addBookingGuest', { bookingId, ...bea })
      await old('addBookingGuest', { bookingId, ...bea, payment: { method: 'reader' } })
      const before = await bookingSnapshot(bookingId)
      expect((await quoteBooking(bookingId)).body.data).toMatchObject({ canCancel: false, storeCredit: 0, blocked: { reason: 'reader_payment_open', message: WORDS.paymentOpen } })
      refusedWith(await cancelBooking(bookingId, 20), 409, 'CONFLICT', 'reader_payment_open', WORDS.paymentOpen)
      expect(await bookingSnapshot(bookingId)).toEqual(before)
    })
  })

  it('a refund still being checked on the booking: refused in plain words, nothing changed', async () => {
    await withBooking(onCard, async ({ bookingId }) => {
      // A staff card refund whose answer never came: its claim is open (no finished row).
      await db.query(
        `INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, request_id, details)
         VALUES ('staff', $1, 'booking.refund_claimed', 'booking', $2, 'w33-open-claim', '{"worker": true, "kind": "part_refund", "amount": 5, "plan": {"card": [], "storeCredit": 0}}'::jsonb)`,
        [ID.staff, bookingId]
      )
      const before = await bookingSnapshot(bookingId)
      expect((await quoteBooking(bookingId)).body.data).toMatchObject({ canCancel: false, blocked: { reason: 'refund_open', message: WORDS.refundOpen } })
      refusedWith(await cancelBooking(bookingId, 20), 409, 'CONFLICT', 'refund_open', WORDS.refundOpen)
      expect(await bookingSnapshot(bookingId)).toEqual(before)
    })
  })

  it('already cancelled: the second cancel is refused; the same key again gets the first answer and cancels nothing twice', async () => {
    await withBooking(onCard, async ({ bookingId }) => {
      const key = crypto.randomUUID()
      const first = await cancelBooking(bookingId, 20, { key })
      expect(first.body.data).toMatchObject({ cancelled: true, storeCreditRefunded: 20 })
      const after = await bookingSnapshot(bookingId)
      const again = await cancelBooking(bookingId, 20, { key })
      expect(again.replayed).toBe(true)
      expect(again.body.data).toEqual(first.body.data)
      refusedWith(await cancelBooking(bookingId, 20), 409, 'CONFLICT', 'already_cancelled', WORDS.alreadyCancelled)
      refusedWith(await cancelBooking(bookingId, 0), 409, 'CONFLICT', 'already_cancelled', WORDS.alreadyCancelled)
      expect(await bookingSnapshot(bookingId)).toEqual(after)
      // A cancel needs its key: without one nothing runs.
      expect((await cancelBooking(bookingId, 20, { key: null })).status).toBe(400)
    })
  })

  it('a finished booking (completed, no-show) is refused', async () => {
    await withBooking(onCard, async ({ bookingId }) => {
      for (const status of ['completed', 'no-show']) {
        await db.query('UPDATE bookings SET status = $1 WHERE id = $2', [status, bookingId])
        const before = await bookingSnapshot(bookingId)
        expect((await quoteBooking(bookingId)).body.data).toMatchObject({ canCancel: false, blocked: { reason: 'not_cancellable', message: WORDS.notCancellable } })
        refusedWith(await cancelBooking(bookingId, 20), 409, 'CONFLICT', 'not_cancellable', WORDS.notCancellable)
        expect(await bookingSnapshot(bookingId)).toEqual(before)
      }
    })
  })

  it('a booking still waiting for its first payment is refused: nothing is given back on money that may never have been taken', async () => {
    await withBooking(onCard, async ({ bookingId }) => {
      await db.query("UPDATE bookings SET status = 'pending' WHERE id = $1", [bookingId])
      const before = await bookingSnapshot(bookingId)
      expect((await quoteBooking(bookingId)).body.data).toMatchObject({ canCancel: false, storeCredit: 0, blocked: { reason: 'booking_pending', message: WORDS.paymentOpen } })
      refusedWith(await cancelBooking(bookingId, 20), 409, 'CONFLICT', 'booking_pending', WORDS.paymentOpen)
      expect(await bookingSnapshot(bookingId)).toEqual(before)
    })
  })

  it("Q39: card refund money still owed on the booking is staff's to settle: the customer's cancel is refused, so it is never turned into store credit", async () => {
    await withBooking(onCard, async ({ bookingId }) => {
      // £5 of an earlier card refund never reached the customer: still to refund on the booking.
      await db.query('UPDATE bookings SET refund_owed_amount = 5 WHERE id = $1', [bookingId])
      const before = await bookingSnapshot(bookingId)
      expect((await quoteBooking(bookingId)).body.data).toMatchObject({ canCancel: false, storeCredit: 0, blocked: { reason: 'refund_owed', message: WORDS.refundOwed } })
      refusedWith(await cancelBooking(bookingId, 20), 409, 'CONFLICT', 'refund_owed', WORDS.refundOwed)
      refusedWith(await cancelBooking(bookingId, 15), 409, 'CONFLICT', 'refund_owed', WORDS.refundOwed)
      expect(await bookingSnapshot(bookingId)).toEqual(before)
    })
  })

  it('W33a (Wayne, 15 Nov), a private booking: 23 hours before it is refused like any other; 25 hours before, the whole tier price (£100) and its paid towel (£5) go to store credit with no Stripe call, and the whole session is freed', async () => {
    const privateOnCard = { booking: { ...paidSeat([sam, { name: 'Alex Guest', email: 'alex@example.com' }]), sessionId: ID.privateSession, addons: [{ ...towel, redemptionSource: 'paid' }] }, payment: { method: 'card' } }
    await withBooking(privateOnCard, async ({ bookingId, stripe }) => {
      const row = await bookingRow(bookingId)
      expect(row).toMatchObject({ status: 'confirmed', price_paid: '100.00' })
      const held = (await totalBooked(ID.privateSession)) ?? 0
      expect(held).toBeGreaterThan(0)
      const before = { calls: stripeCalls(stripe), balance: await balance(), rows: (await cancelRows('booking', bookingId)).length }

      // 23 hours before (12 Nov 11:00): the 24-hour rule, as for any booking.
      vi.setSystemTime(PRIVATE_START - 23 * 3600_000)
      expect((await quoteBooking(bookingId)).body.data).toEqual({ bookingId, canCancel: false, storeCredit: 0, creditReturned: null, blocked: { reason: 'within_24_hours', message: WORDS.within24Hours } })
      refusedWith(await cancelBooking(bookingId, 105), 409, 'CONFLICT', 'within_24_hours', WORDS.within24Hours)
      refusedWith(await cancelBooking(bookingId, 0), 409, 'CONFLICT', 'within_24_hours', WORDS.within24Hours)
      expect(await bookingRow(bookingId)).toEqual(row)
      expect(await totalBooked(ID.privateSession)).toBe(held)
      expect(await balance()).toBe(before.balance)
      expect((await addonLines(bookingId)).map((line) => line.removed)).toEqual([false])
      expect((await cancelRows('booking', bookingId)).length).toBe(before.rows)

      // 25 hours before (12 Nov 09:00).
      vi.setSystemTime(PRIVATE_START - 25 * 3600_000)
      expect((await quoteBooking(bookingId)).body.data).toEqual({ bookingId, canCancel: true, storeCredit: 105, creditReturned: null, blocked: null })
      const cancelled = await cancelBooking(bookingId, 105)
      expect(cancelled.body.data).toEqual({ cancelled: true, bookingId, storeCreditRefunded: 105, storeCreditBalance: before.balance + 105, creditReturned: null, creditUsableAgain: false, addonCreditsReturned: 0 })
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'cancelled', cancelled: true, refund_owed_amount: '0.00' })
      // The whole session, not the party of two.
      expect(await totalBooked(ID.privateSession)).toBe(0)
      expect(await balance()).toBe(before.balance + 105)
      expect(stripeCalls(stripe)).toBe(before.calls)
      expect(stripe.refundsSent).toEqual([])
      expect(await addonLines(bookingId)).toEqual([expect.objectContaining({ removed: true, removed_by: null, refunded_amount: '5.00', card_refunded_amount: '0.00', refund_method: 'credit' })])
      const rows = await cancelRows('booking', bookingId)
      expect(rows.map((entry) => entry.action)).toEqual(['booking.cancel', 'booking.refund_claimed', 'booking.refund_finished'])
      expect(rows.every((entry) => entry.actor_type === 'customer' && entry.actor_id === ID.customer)).toBe(true)
      expect(rows[0]?.details).toMatchObject({ channel: 'customer', refundMethod: 'credit', seatRefund: 100, addonsRefund: 5, cardRefunded: 0, storeCreditRefunded: 105 })
    })
  })

  it("W33a (review S2), an older pass booking whose money isn't recognised as its paid guest's (seat 1 with no pay-by, the guest with no seat price): refused, so its pass session is never lost; nothing changes", async () => {
    await withBooking(passBooking, async ({ bookingId, call: old }) => {
      await old('addBookingGuest', { bookingId, ...bea })
      await old('addBookingGuest', { bookingId, ...bea, payment: { method: 'card' } })
      // Control: as the Worker writes it, the guest's £20 is recognised and the cancel would return the pass session.
      expect((await quoteBooking(bookingId)).body.data).toEqual({ bookingId, canCancel: true, storeCredit: 20, creditReturned: 'session_pass_credit', blocked: null })
      // The older shape, from before seats had prices: Cancel & Refund would give £20 and no pass session.
      await db.query('UPDATE booking_guests SET pay_by = NULL, unit_price = NULL WHERE booking_id = $1', [bookingId])
      const before = await bookingSnapshot(bookingId)
      expect(before.booking).toMatchObject({ status: 'confirmed', price_paid: '20.00' })
      expect((await quoteBooking(bookingId)).body.data).toEqual({ bookingId, canCancel: false, storeCredit: 0, creditReturned: null, blocked: { reason: 'pass_session_not_returned', message: WORDS.cannotCancelOnline } })
      refusedWith(await cancelBooking(bookingId, 20), 409, 'CONFLICT', 'pass_session_not_returned', WORDS.cannotCancelOnline)
      refusedWith(await cancelBooking(bookingId, 0), 409, 'CONFLICT', 'pass_session_not_returned', WORDS.cannotCancelOnline)
      expect(await bookingSnapshot(bookingId)).toEqual(before)
    })
  })

  it('W33a (review S2): a membership credit booking in the same older shape is left cancellable: its money goes to store credit and its credit comes back by itself', async () => {
    await withBooking(memberBooking, async ({ bookingId, call: old, stripe }) => {
      await old('addBookingGuest', { bookingId, ...bea })
      await old('addBookingGuest', { bookingId, ...bea, payment: { method: 'cash', confirmedCashAmount: 20 } })
      await db.query('UPDATE booking_guests SET pay_by = NULL, unit_price = NULL WHERE booking_id = $1', [bookingId])
      expect(await bookingRow(bookingId)).toMatchObject({ status: 'confirmed', price_paid: '20.00' })
      const before = { calls: stripeCalls(stripe), balance: await balance(ID.member), used: await creditsUsed() }
      expect(before.used).toBe(1)
      expect((await quoteBooking(bookingId, { as: MO })).body.data).toEqual({ bookingId, canCancel: true, storeCredit: 20, creditReturned: null, blocked: null })
      expect((await cancelBooking(bookingId, 20, { as: MO })).body.data).toMatchObject({ cancelled: true, storeCreditRefunded: 20, storeCreditBalance: before.balance + 20 })
      expect(await creditsUsed()).toBe(0)
      expect(stripeCalls(stripe)).toBe(before.calls)
    })
  })

  it('Q18: the amount is required; a penny off is refused with the quote as it now stands and nothing changes; half a penny passes', async () => {
    await withBooking(cardSeatAndTowel, async ({ bookingId }) => {
      const before = await bookingSnapshot(bookingId)
      const none = await cancelBooking(bookingId, undefined)
      refusedWith(none, 400, 'VALIDATION', 'amount_not_confirmed', WORDS.amountNotConfirmed)
      expect(none.body.error?.field).toBe('confirmed')
      for (const wrong of [24.99, 25.01, 0, 20]) {
        const refused = await cancelBooking(bookingId, wrong)
        refusedWith(refused, 409, 'CONFLICT', 'refund_changed', WORDS.figuresChanged)
        expect(refused.body.error?.details?.quote).toEqual({ bookingId, canCancel: true, storeCredit: 25, creditReturned: null, blocked: null })
      }
      expect(await bookingSnapshot(bookingId)).toEqual(before)
      expect((await cancelBooking(bookingId, 25.004)).body.data).toMatchObject({ cancelled: true, storeCreditRefunded: 25 })
    })
  })

  it('a booking changed between the read and the lock (an add-on added at that moment) is refused whole: the new add-on is never left on a cancelled booking', async () => {
    await withBooking(onCard, async ({ bookingId }) => {
      const before = await bookingSnapshot(bookingId)
      // The cancel's first read of the add-on lines, with no lock: just after it, a paid towel lands on the booking.
      let added = false
      const real = db
      holder.db = new Proxy(real, {
        get(target, property, receiver) {
          if (property !== 'query') return Reflect.get(target, property, receiver) as unknown
          return async (sql: string, params?: unknown[]) => {
            const answer = await target.query(sql, params as never)
            if (!added && sql.includes('FROM addon_order_lines WHERE booking_id = $1::uuid AND removed_at IS NULL')) {
              added = true
              const line = (await target.query<{ order_id: string }>("SELECT order_id FROM order_line_items WHERE booking_id = $1 AND item_type = 'booking' LIMIT 1", [bookingId]))[0]
              await target.query(
                "INSERT INTO addon_order_lines (booking_id, order_id, addon_id, quantity, price_at_purchase, sku_at_purchase, redemption_source) VALUES ($1, $2, $3, 1, 5, 'TOWEL', 'paid')",
                [bookingId, line?.order_id, ID.addon]
              )
            }
            return answer
          }
        },
      })
      try {
        refusedWith(await cancelBooking(bookingId, 20), 409, 'CONFLICT', 'booking_changed', WORDS.bookingChanged)
      } finally {
        holder.db = real
      }
      expect(added).toBe(true)
      expect(await bookingRow(bookingId)).toEqual(before.booking)
      expect(await balance()).toBe(before.balance)
      expect((await addonLines(bookingId)).map((line) => line.removed)).toEqual([false])
      // Asked again, the quote counts the towel, and the cancel takes it too.
      expect((await quoteBooking(bookingId)).body.data).toMatchObject({ canCancel: true, storeCredit: 25 })
      expect((await cancelBooking(bookingId, 25)).body.data).toMatchObject({ cancelled: true, storeCreditRefunded: 25 })
      expect((await addonLines(bookingId)).map((line) => line.removed)).toEqual([true])
    })
  })
})

// --- Event places

type EventContext = ScenarioContext & { orderId: string; eventBookingId: string; places(): Promise<string[]> }

const samAttending = { name: 'Sam Test', email: 'sam@example.com', dateOfBirth: '1990-01-01', isAccountHolder: true }
const alexGuest = { name: 'Alex Guest', email: 'alex@example.com', isAccountHolder: false }
/** Sam and a guest at the public price: £80. */
const twoPlaces = { eventId: ID.event, accountHolderAttending: true, guestsOver18Confirmed: true, attendees: [samAttending, alexGuest] }
const eventOnCard = { event: twoPlaces, payment: { method: 'card' } }
const eventInCash = { event: twoPlaces, payment: { method: 'cash', confirmedCashAmount: 80 } }

/** An event order placed by the old createOrder for Sam, then `work` with it. */
async function onAnEventOrder(order: Record<string, unknown>, work: (context: EventContext) => Promise<void>, prepare?: (seedDb: Db) => Promise<void>): Promise<void> {
  await replay(
    environment,
    {
      name: 'w33 customer event cancel',
      async seed(seedDb, stripe) {
        await seedWithSignIns(seedDb, stripe)
        await prepare?.(seedDb)
      },
      async run(context) {
        replayStripe.current = context.stripe
        const placed = (await context.call('createOrder', { customerId: ID.customer, ...order })) as Record<string, unknown>
        if (placed['success'] !== true) throw new Error(`The order failed: ${JSON.stringify(placed)}`)
        const eventBookingId = String(placed['eventBookingId'])
        const places = async () => (await context.db.query<{ id: string }>('SELECT id FROM event_attendees WHERE event_booking_id = $1::uuid ORDER BY created_at, id', [eventBookingId])).map((row) => row.id)
        vi.setSystemTime(Date.now() + 1000)
        try {
          await work({ ...context, orderId: String(placed['orderId']), eventBookingId, places })
        } finally {
          replayStripe.current = null
        }
      },
    },
    workerSide()
  )
}

const eventBookingRow = async (eventBookingId: string) =>
  (await db.query<{ status: string; places: number; cancelled_by: string | null }>('SELECT status, places, cancelled_by FROM event_bookings WHERE id = $1', [eventBookingId]))[0]
const placeRows = (eventBookingId: string) =>
  db.query<{ id: string; cancelled: boolean; cancelled_by: string | null; cancelled_value: string; refunded: string; card: string; refund_method: string | null; refund_after_cutoff: boolean }>(
    `SELECT id, cancelled_at IS NOT NULL AS cancelled, cancelled_by, cancelled_value::numeric(10,2)::text AS cancelled_value, refunded_amount::numeric(10,2)::text AS refunded,
            card_refunded_amount::numeric(10,2)::text AS card, refund_method, refund_after_cutoff
     FROM event_attendees WHERE event_booking_id = $1 ORDER BY created_at, id`,
    [eventBookingId]
  )
const placesBooked = async () => Number((await db.query<{ places_booked: number }>('SELECT places_booked FROM events WHERE id = $1', [ID.event]))[0]?.places_booked)

async function eventSnapshot(eventBookingId: string) {
  return {
    booking: await eventBookingRow(eventBookingId),
    places: await placeRows(eventBookingId),
    booked: await placesBooked(),
    balance: await balance(),
    storeCredit: (await storeCreditRows()).length,
    rows: (await cancelRows('event_booking', eventBookingId)).length,
  }
}

describe("a customer's own event booking (brief W33 items 1 and 5; Q44)", () => {
  it('a card-paid booking, one place of two: its £40 goes to store credit with no Stripe call; the place cancelled by the customer, the other left; then the rest cancels the booking', async () => {
    await onAnEventOrder(eventOnCard, async ({ eventBookingId, orderId, places, stripe }) => {
      const [first, second] = await places()
      const quote = await quoteEvent(eventBookingId, [first as string])
      expect(quote.body.data).toEqual({ eventBookingId, canCancel: true, places: 1, wholeBooking: false, storeCredit: 40, refundCutoffAt: expect.stringContaining('2026-11-30') as unknown, blocked: null })
      expect(customerEventCancelQuoteSchema.safeParse(quote.body.data).success).toBe(true)

      const before = { calls: stripeCalls(stripe), balance: await balance(), booked: await placesBooked() }
      const cancelled = await cancelEvent(eventBookingId, [first as string], 40)
      expect(cancelled.status).toBe(200)
      expect(cancelled.body.data).toEqual({ cancelled: true, eventBookingId, places: 1, storeCreditRefunded: 40, storeCreditBalance: before.balance + 40, bookingCancelled: false, placesLeft: 1 })
      expect(customerEventCancelOutputSchema.safeParse(cancelled.body.data).success).toBe(true)
      expect(stripeCalls(stripe)).toBe(before.calls)
      expect(stripe.refundsSent).toEqual([])
      expect(await balance()).toBe(before.balance + 40)
      expect(await placesBooked()).toBe(before.booked - 1)
      expect(await eventBookingRow(eventBookingId)).toEqual({ status: 'confirmed', places: 1, cancelled_by: null })
      expect(await placeRows(eventBookingId)).toEqual([
        { id: first, cancelled: true, cancelled_by: null, cancelled_value: '40.00', refunded: '40.00', card: '0.00', refund_method: 'credit', refund_after_cutoff: false },
        expect.objectContaining({ id: second, cancelled: false }),
      ])
      expect(await storeCreditRows()).toEqual([{ amount: '40.00', reason: 'refund', staff_id: null, order_id: orderId, booking_id: null }])
      const rows = await cancelRows('event_booking', eventBookingId)
      expect(rows.map((row) => row.action)).toEqual(['event_booking.cancel_places', 'event_booking.refund_claimed', 'event_booking.refund_finished'])
      expect(rows.every((row) => row.actor_type === 'customer' && row.actor_id === ID.customer)).toBe(true)
      expect(rows[0]?.details).toMatchObject({ channel: 'customer', places: 1, refund: 'credit', reason: null, afterCutoff: false, amount: 40, cardRefunded: 0, storeCreditRefunded: 40, owed: 0 })
      expect(rows[1]?.details).toMatchObject({ channel: 'customer', kind: 'cancel_places', amount: 40, method: 'credit', worker: true, plan: { card: [], storeCredit: 40, cash: 0 } })

      // The rest: every place left with none named, and the booking is cancelled with it.
      expect((await quoteEvent(eventBookingId)).body.data).toMatchObject({ canCancel: true, places: 1, wholeBooking: true, storeCredit: 40 })
      const rest = await cancelEvent(eventBookingId, undefined, 40)
      expect(rest.body.data).toEqual({ cancelled: true, eventBookingId, places: 1, storeCreditRefunded: 40, storeCreditBalance: before.balance + 80, bookingCancelled: true, placesLeft: 0 })
      expect(await eventBookingRow(eventBookingId)).toEqual({ status: 'cancelled', places: 0, cancelled_by: null })
      expect(await placesBooked()).toBe(before.booked - 2)
      expect(stripeCalls(stripe)).toBe(before.calls)
      expect((await quoteEvent(eventBookingId)).body.data).toMatchObject({ canCancel: false, places: 0, storeCredit: 0, blocked: { reason: 'booking_not_confirmed', message: WORDS.eventBookingCancelled } })
    })
  })

  it('a cash-paid booking: a place goes to store credit, never back as cash', async () => {
    await onAnEventOrder(eventInCash, async ({ eventBookingId, places, stripe }) => {
      const [first] = await places()
      const before = { calls: stripeCalls(stripe), balance: await balance() }
      const cancelled = await cancelEvent(eventBookingId, [first as string], 40)
      expect(cancelled.body.data).toMatchObject({ cancelled: true, places: 1, storeCreditRefunded: 40, storeCreditBalance: before.balance + 40 })
      expect((await placeRows(eventBookingId))[0]).toMatchObject({ cancelled: true, refunded: '40.00', card: '0.00', refund_method: 'credit' })
      expect((await cancelRows('event_booking', eventBookingId))[0]?.details).not.toHaveProperty('cashRefunded')
      expect(stripeCalls(stripe)).toBe(before.calls)
    })
  })

  it("places worth nothing (the order's line at £0): cancelled with no money and no claim; the cancel's own row is still the customer's", async () => {
    await onAnEventOrder(eventInCash, async ({ eventBookingId, places }) => {
      const [first] = await places()
      await db.query("UPDATE order_line_items SET line_total = 0, unit_price = 0 WHERE event_booking_id = $1 AND item_type = 'event'", [eventBookingId])
      const before = await balance()
      expect((await quoteEvent(eventBookingId, [first as string])).body.data).toMatchObject({ canCancel: true, places: 1, storeCredit: 0 })
      expect((await cancelEvent(eventBookingId, [first as string], 0)).body.data).toEqual({ cancelled: true, eventBookingId, places: 1, storeCreditRefunded: 0, bookingCancelled: false, placesLeft: 1 })
      expect(await balance()).toBe(before)
      expect((await placeRows(eventBookingId))[0]).toMatchObject({ cancelled: true, cancelled_by: null, refund_method: 'none' })
      const rows = await cancelRows('event_booking', eventBookingId)
      expect(rows.map((row) => [row.action, row.actor_type, row.actor_id])).toEqual([['event_booking.cancel_places', 'customer', ID.customer]])
      expect(rows[0]?.details).toMatchObject({ channel: 'customer', refund: 'credit', amount: 0 })
    })
  })

  it('the whole booking at once (£80)', async () => {
    await onAnEventOrder(eventOnCard, async ({ eventBookingId, stripe }) => {
      const before = { calls: stripeCalls(stripe), balance: await balance(), booked: await placesBooked() }
      expect((await quoteEvent(eventBookingId)).body.data).toMatchObject({ canCancel: true, places: 2, wholeBooking: true, storeCredit: 80 })
      expect((await cancelEvent(eventBookingId, undefined, 80)).body.data).toEqual({ cancelled: true, eventBookingId, places: 2, storeCreditRefunded: 80, storeCreditBalance: before.balance + 80, bookingCancelled: true, placesLeft: 0 })
      expect(await placesBooked()).toBe(before.booked - 2)
      expect(stripeCalls(stripe)).toBe(before.calls)
    })
  })
})

describe("what a customer's event cancel is refused with, in their own words (brief W33 items 2 and 3)", () => {
  it("another customer's event booking is refused exactly as one that doesn't exist, and nothing changes", async () => {
    await onAnEventOrder(eventOnCard, async ({ eventBookingId, places }) => {
      const [first] = await places()
      const before = await eventSnapshot(eventBookingId)
      const missing = crypto.randomUUID()
      const quote = await quoteEvent(eventBookingId, undefined, { as: MO })
      refusedWith(quote, 404, 'NOT_FOUND', 'booking_not_found', WORDS.eventBookingNotFound)
      expect(quote.body.error).toEqual((await quoteEvent(missing, undefined, { as: MO })).body.error)
      const cancel = await cancelEvent(eventBookingId, [first as string], 40, { as: MO })
      refusedWith(cancel, 404, 'NOT_FOUND', 'booking_not_found', WORDS.eventBookingNotFound)
      expect(cancel.body.error).toEqual((await cancelEvent(missing, [first as string], 40, { as: MO })).body.error)
      refusedWith(await cancelEvent(eventBookingId, undefined, 80, { as: MO }), 404, 'NOT_FOUND', 'booking_not_found', WORDS.eventBookingNotFound)
      expect(await eventSnapshot(eventBookingId)).toEqual(before)
      expect((await cancelEvent(eventBookingId, [first as string], 40)).body.data).toMatchObject({ cancelled: true })
    })
  })

  it('after the cut-off: refused, nothing changed (staff can still refund then, with a reason; a customer cannot)', async () => {
    await onAnEventOrder(eventOnCard, async ({ eventBookingId, places }) => {
      const [first] = await places()
      // An hour before the cut-off (30 Nov 19:00): allowed.
      vi.setSystemTime(new Date('2026-11-30T18:00:00.000Z'))
      expect((await quoteEvent(eventBookingId, [first as string])).body.data).toMatchObject({ canCancel: true, storeCredit: 40 })
      // An hour after it, a day before the event.
      vi.setSystemTime(new Date('2026-11-30T20:00:00.000Z'))
      const before = await eventSnapshot(eventBookingId)
      expect((await quoteEvent(eventBookingId, [first as string])).body.data).toEqual({ eventBookingId, canCancel: false, places: 0, wholeBooking: false, storeCredit: 0, refundCutoffAt: null, blocked: { reason: 'after_cutoff', message: WORDS.afterCutoff } })
      refusedWith(await cancelEvent(eventBookingId, [first as string], 40), 409, 'CONFLICT', 'after_cutoff', WORDS.afterCutoff)
      refusedWith(await cancelEvent(eventBookingId, undefined, 80), 409, 'CONFLICT', 'after_cutoff', WORDS.afterCutoff)
      expect(await eventSnapshot(eventBookingId)).toEqual(before)
    })
  })

  it('Q43, an event with no cut-off: a customer can cancel until it starts (the database function says so itself, migration 024), and not after', async () => {
    await onAnEventOrder(
      eventOnCard,
      async ({ eventBookingId, places }) => {
        const [first, second] = await places()
        // An event on sale always has a cut-off (events_on_sale_complete), so one with none is off sale.
        await db.query('UPDATE events SET active = false, refund_cutoff_at = NULL WHERE id = $1', [ID.event])
        // The function's own answer, three weeks before the event: before the cut-off.
        const fromTheDatabase = (await db.query<{ quote: { before_cutoff: boolean; refund_cutoff_at: string | null } }>('SELECT public.event_cancellation_quote($1::uuid, NULL::uuid[]) AS quote', [eventBookingId]))[0]?.quote
        expect(fromTheDatabase).toMatchObject({ before_cutoff: true, refund_cutoff_at: null })
        expect((await quoteEvent(eventBookingId, [first as string])).body.data).toEqual({ eventBookingId, canCancel: true, places: 1, wholeBooking: false, storeCredit: 40, refundCutoffAt: null, blocked: null })
        expect((await cancelEvent(eventBookingId, [first as string], 40)).body.data).toMatchObject({ cancelled: true, places: 1, storeCreditRefunded: 40 })
        expect((await placeRows(eventBookingId))[0]).toMatchObject({ cancelled: true, refund_after_cutoff: false })
        // A minute before it starts (1 Dec 19:00): still allowed. A minute after: not.
        vi.setSystemTime(new Date('2026-12-01T18:59:00.000Z'))
        expect((await quoteEvent(eventBookingId, [second as string])).body.data).toMatchObject({ canCancel: true, storeCredit: 40 })
        vi.setSystemTime(new Date('2026-12-01T19:01:00.000Z'))
        const before = await eventSnapshot(eventBookingId)
        expect((await quoteEvent(eventBookingId, [second as string])).body.data).toMatchObject({ canCancel: false, blocked: { reason: 'after_cutoff', message: WORDS.afterCutoff } })
        refusedWith(await cancelEvent(eventBookingId, [second as string], 40), 409, 'CONFLICT', 'after_cutoff', WORDS.afterCutoff)
        expect(await eventSnapshot(eventBookingId)).toEqual(before)
      }
    )
  })

  it('a checked-in place is refused; the other place can still go', async () => {
    await onAnEventOrder(eventOnCard, async ({ eventBookingId, places }) => {
      const [first, second] = await places()
      await db.query('UPDATE event_attendees SET checked_in_at = now() WHERE id = $1', [first])
      const before = await eventSnapshot(eventBookingId)
      expect((await quoteEvent(eventBookingId, [first as string])).body.data).toMatchObject({ canCancel: false, blocked: { reason: 'attendee_checked_in', message: WORDS.placeCheckedIn } })
      refusedWith(await cancelEvent(eventBookingId, [first as string], 40), 409, 'CONFLICT', 'attendee_checked_in', WORDS.placeCheckedIn)
      // The whole booking holds the checked-in place, so it is refused too.
      refusedWith(await cancelEvent(eventBookingId, undefined, 80), 409, 'CONFLICT', 'attendee_checked_in', WORDS.placeCheckedIn)
      expect(await eventSnapshot(eventBookingId)).toEqual(before)
      expect((await cancelEvent(eventBookingId, [second as string], 40)).body.data).toMatchObject({ cancelled: true, places: 1, placesLeft: 1 })
    })
  })

  it("a cancelled event is refused (W31 \"For the Worker step\" 2): the club's own cancel gives that money back", async () => {
    await onAnEventOrder(eventOnCard, async ({ eventBookingId, places }) => {
      const [first] = await places()
      await db.query("UPDATE events SET active = false, cancelled_at = now(), cancelled_by = $1, cancel_reason = 'Storm' WHERE id = $2", [ID.staff, ID.event])
      const before = await eventSnapshot(eventBookingId)
      expect((await quoteEvent(eventBookingId)).body.data).toMatchObject({ canCancel: false, storeCredit: 0, blocked: { reason: 'event_cancelled', message: WORDS.eventCancelled } })
      refusedWith(await cancelEvent(eventBookingId, [first as string], 40), 409, 'CONFLICT', 'event_cancelled', WORDS.eventCancelled)
      refusedWith(await cancelEvent(eventBookingId, undefined, 80), 409, 'CONFLICT', 'event_cancelled', WORDS.eventCancelled)
      expect(await eventSnapshot(eventBookingId)).toEqual(before)
    })
  })

  it('a payment still open on the booking, and a refund still being checked on its order: refused in plain words, nothing changed', async () => {
    await onAnEventOrder(eventOnCard, async ({ eventBookingId, orderId, places }) => {
      const [first] = await places()
      // A refund on the order still being checked (a staff card refund with no answer yet).
      const claim = (
        await db.query<{ id: string }>(
          `INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, request_id, details)
           VALUES ('staff', $1, 'order.refund_claimed', 'order', $2, 'w33-open-claim', '{"worker": true, "kind": "refund", "amount": 5}'::jsonb) RETURNING id`,
          [ID.staff, orderId]
        )
      )[0]
      let before = await eventSnapshot(eventBookingId)
      expect((await quoteEvent(eventBookingId, [first as string])).body.data).toMatchObject({ canCancel: false, blocked: { reason: 'refund_open', message: WORDS.eventRefundOpen } })
      refusedWith(await cancelEvent(eventBookingId, [first as string], 40), 409, 'CONFLICT', 'refund_open', WORDS.eventRefundOpen)
      expect(await eventSnapshot(eventBookingId)).toEqual(before)
      await db.query('DELETE FROM audit_log WHERE id = $1', [claim?.id])

      // A payment still being taken for it (the booking is pending until its reader payment finishes).
      await db.query("UPDATE event_bookings SET status = 'pending' WHERE id = $1", [eventBookingId])
      before = await eventSnapshot(eventBookingId)
      expect((await quoteEvent(eventBookingId, [first as string])).body.data).toMatchObject({ canCancel: false, blocked: { reason: 'booking_pending', message: WORDS.eventPaymentOpen } })
      refusedWith(await cancelEvent(eventBookingId, [first as string], 40), 409, 'CONFLICT', 'booking_pending', WORDS.eventPaymentOpen)
      expect(await eventSnapshot(eventBookingId)).toEqual(before)
    })
  })

  it('a place already cancelled, a place that is not on the booking, and no place chosen', async () => {
    await onAnEventOrder(eventOnCard, async ({ eventBookingId, places }) => {
      const [first] = await places()
      expect((await cancelEvent(eventBookingId, [first as string], 40)).body.data).toMatchObject({ cancelled: true })
      const before = await eventSnapshot(eventBookingId)
      refusedWith(await cancelEvent(eventBookingId, [first as string], 40), 409, 'CONFLICT', 'already_cancelled', WORDS.placeAlreadyCancelled)
      refusedWith(await cancelEvent(eventBookingId, [crypto.randomUUID()], 40), 404, 'NOT_FOUND', 'attendee_not_found', WORDS.placeNotFound)
      refusedWith(await quoteEvent(eventBookingId, ['not-an-id']), 404, 'NOT_FOUND', 'attendee_not_found', WORDS.placeNotFound)
      refusedWith(await cancelEvent(eventBookingId, [], 40), 400, 'VALIDATION', 'invalid_params', WORDS.choosePlace)
      expect(await eventSnapshot(eventBookingId)).toEqual(before)
    })
  })

  it('Q18: the amount is required; a penny off is refused with the quote as it now stands and nothing changes; half a penny passes', async () => {
    await onAnEventOrder(eventOnCard, async ({ eventBookingId, places }) => {
      const [first] = await places()
      const before = await eventSnapshot(eventBookingId)
      const none = await cancelEvent(eventBookingId, [first as string], undefined)
      refusedWith(none, 400, 'VALIDATION', 'amount_not_confirmed', WORDS.amountNotConfirmed)
      for (const wrong of [39.99, 40.01, 0, 80]) {
        const refused = await cancelEvent(eventBookingId, [first as string], wrong)
        refusedWith(refused, 409, 'CONFLICT', 'figures_changed', WORDS.figuresChanged)
        expect(refused.body.error?.details?.quote).toMatchObject({ eventBookingId, canCancel: true, places: 1, storeCredit: 40, blocked: null })
        // The customer's quote, never the staff one: no card part, cash or money owed.
        expect(Object.keys(refused.body.error?.details?.quote ?? {}).sort()).toEqual(['blocked', 'canCancel', 'eventBookingId', 'places', 'refundCutoffAt', 'storeCredit', 'wholeBooking'])
      }
      expect(await eventSnapshot(eventBookingId)).toEqual(before)
      expect((await cancelEvent(eventBookingId, [first as string], 40.004)).body.data).toMatchObject({ cancelled: true, storeCreditRefunded: 40 })
    })
  })
})

// --- The switch (brief W33 item 4)

describe('the switch: the four customer routes are off unless ORDER_SWITCH names customer_cancels', () => {
  it("with today's live value all four answer REFUND_PATH_OFF in the customer's words, before any booking is read, and nothing changes", async () => {
    expect(LIVE_TODAY.split(',')).not.toContain('customer_cancels')
    await withBooking(cardSeatAndTowel, async ({ bookingId }) => {
      const before = await bookingSnapshot(bookingId)
      const missing = crypto.randomUUID()
      const off = { orderSwitch: LIVE_TODAY }
      const answers = [
        await quoteBooking(bookingId, off),
        await cancelBooking(bookingId, 25, off),
        await cancelBooking(bookingId, 0, off),
        // Off before any booking is read: someone else's booking, and one that doesn't exist, answer the same.
        await quoteBooking(bookingId, { ...off, as: MO }),
        await cancelBooking(missing, 25, off),
        await quoteEvent(missing, undefined, off),
        await cancelEvent(missing, undefined, 40, off),
        await cancelEvent(missing, undefined, 0, off),
      ]
      for (const answer of answers) {
        refusedWith(answer, 501, 'REFUND_PATH_OFF', 'customer_cancels_off', WORDS.switchedOff)
        expect(answer.body.error?.details?.kinds).toEqual(['customer_cancels'])
      }
      // Unset, and empty, are off too. Signing in still comes first.
      for (const orderSwitch of ['', 'customer_cancel', 'booking_changes event_cancels']) {
        refusedWith(await quoteBooking(bookingId, { orderSwitch }), 501, 'REFUND_PATH_OFF', 'customer_cancels_off', WORDS.switchedOff)
      }
      expect((await quoteBooking(bookingId, { ...off, as: null })).status).toBe(401)
      expect(await bookingSnapshot(bookingId)).toEqual(before)
    })
  })

  it('with customer_cancels on, money back still needs the kind staff need for it (booking_changes); a cancel with no money back does not', async () => {
    await withBooking(cardSeatAndTowel, async ({ bookingId }) => {
      const noBookingChanges = 'customer_cancels,event_cancels,order_refunds'
      const before = await bookingSnapshot(bookingId)
      expect((await quoteBooking(bookingId, { orderSwitch: noBookingChanges })).body.data).toMatchObject({ canCancel: true, storeCredit: 25 })
      const refused = await cancelBooking(bookingId, 25, { orderSwitch: noBookingChanges })
      refusedWith(refused, 501, 'REFUND_PATH_OFF', 'customer_cancels_off', WORDS.switchedOff)
      expect(refused.body.error?.details?.kinds).toEqual(['booking_changes'])
      expect(await bookingSnapshot(bookingId)).toEqual(before)
      // Sending £0 to get past the switch cancels nothing: the amount no longer matches.
      refusedWith(await cancelBooking(bookingId, 0, { orderSwitch: noBookingChanges }), 409, 'CONFLICT', 'refund_changed', WORDS.figuresChanged)
      expect(await bookingSnapshot(bookingId)).toEqual(before)
    })
    await withBooking(passBooking, async ({ bookingId }) => {
      expect((await cancelBooking(bookingId, 0, { orderSwitch: 'customer_cancels' })).body.data).toMatchObject({ cancelled: true, storeCreditRefunded: 0 })
    })
  })

  it('the same for event places (event_cancels)', async () => {
    await onAnEventOrder(eventOnCard, async ({ eventBookingId, places }) => {
      const [first] = await places()
      const noEventCancels = `${BOOKING_KINDS_ON},customer_cancels`
      const before = await eventSnapshot(eventBookingId)
      const refused = await cancelEvent(eventBookingId, [first as string], 40, { orderSwitch: noEventCancels })
      refusedWith(refused, 501, 'REFUND_PATH_OFF', 'customer_cancels_off', WORDS.switchedOff)
      expect(refused.body.error?.details?.kinds).toEqual(['event_cancels'])
      refusedWith(await cancelEvent(eventBookingId, [first as string], 0, { orderSwitch: noEventCancels }), 409, 'CONFLICT', 'figures_changed', WORDS.figuresChanged)
      expect(await eventSnapshot(eventBookingId)).toEqual(before)
    })
  })
})

// --- The words

describe("the customer's words (brief W33 item 2)", () => {
  const STAFF_TERMS = /cancel & refund|return credit|issue refunds|reader|stripe|claim|staff|manager|booking system|press|dialog|refund the rest|reload/i

  it('no sentence uses a staff term, each ends as a sentence, and none is used for two different things by mistake', () => {
    for (const [name, sentence] of Object.entries(WORDS)) {
      expect(sentence, name).not.toMatch(STAFF_TERMS)
      expect(sentence, name).toMatch(/[.]$/)
      expect(sentence.length, name).toBeGreaterThan(20)
    }
    expect(WORDS.bookingNotFound).not.toBe(WORDS.eventBookingNotFound)
  })

  it('every reason the rules can refuse a customer with has words of its own, and an unknown reason gets the fallback, never a staff sentence', () => {
    const sentences = new Set<string>(Object.values(WORDS))
    for (const words of [CUSTOMER_BOOKING_REFUSAL_WORDS, CUSTOMER_EVENT_REFUSAL_WORDS]) {
      for (const [reason, sentence] of Object.entries(words)) expect(sentences.has(sentence), reason).toBe(true)
    }
    // The reasons bookings/cancel.ts can reach on the customer channel.
    for (const reason of ['booking_not_found', 'already_cancelled', 'booking_pending', 'not_cancellable', 'refund_owed', 'pass_session_not_returned', 'within_24_hours', 'card_payment_open', 'reader_payment_open', 'refund_open', 'booking_changed', 'refund_changed', 'cancel_not_saved']) {
      expect(CUSTOMER_BOOKING_REFUSAL_WORDS[reason], reason).toBeTruthy()
    }
    // The reasons events/cancel-places.ts and the database's quote can reach on the customer channel.
    for (const reason of ['booking_not_found', 'booking_not_confirmed', 'attendee_not_found', 'already_cancelled', 'nothing_to_cancel', 'attendee_checked_in', 'invalid_params', 'event_cancelled', 'after_cutoff', 'booking_pending', 'refund_open', 'changed_by_someone_else', 'figures_changed', 'amount_not_confirmed', 'cancel_not_saved']) {
      expect(CUSTOMER_EVENT_REFUSAL_WORDS[reason], reason).toBeTruthy()
    }
  })

  it('a refusal with no words of its own reaches the customer as the fallback, with the staff words kept for the log only', () => {
    // No such refusal can be reached on the customer channel today (each staff-only reason is stepped round by the
    // rule), so this holds the wrapper itself: a staff sentence handed to it never comes out.
    const staff = new ApiError('CONFLICT', CANCEL_CREDIT_WORDS.paidGuestsPresent, { details: { reason: 'paid_guests_present', message: CANCEL_CREDIT_WORDS.paidGuestsPresent, action: 'cancel_credit', cancelQuote: { parts: { card: 20 } } } })
    const told = forCustomer(staff, CUSTOMER_BOOKING_REFUSAL_WORDS) as ApiError
    expect(told).toBeInstanceOf(ApiError)
    expect(told.code).toBe('CONFLICT')
    expect(told.message).toBe(WORDS.fallback)
    expect(told.details).toEqual({ reason: 'paid_guests_present', message: WORDS.fallback })
    expect(JSON.stringify(told.toBody())).not.toContain('Remove paid guests')
    expect(told.logDetail).toContain(CANCEL_CREDIT_WORDS.paidGuestsPresent)
    // Anything that isn't a refusal is passed on untouched (the route turns it into the plain internal words).
    const fault = new Error('connection lost')
    expect(forCustomer(fault, CUSTOMER_BOOKING_REFUSAL_WORDS)).toBe(fault)
  })
})
