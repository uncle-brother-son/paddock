import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { POST as cancelFlowRoute } from '@/app/api/v1/staff/reader-flows/[pendingId]/cancel/route'
import { POST as finaliseFlowRoute } from '@/app/api/v1/staff/reader-flows/[pendingId]/finalise/route'
import { POST as guestsRoute } from '@/app/api/v1/staff/bookings/[bookingId]/guests/route'
import type { Db } from '@/server/db'
import { CLIENT_SECRET_WINDOW_MINUTES, pruneClientSecrets } from '@/server/http/idempotency'
import { FAILURE_MESSAGES as ORDER_WORDS, NO_SAVED_CARD_MESSAGE } from '@/server/rules/orders/failure-messages'
import { GUESTS_OVER_18_NOT_CONFIRMED_MESSAGE } from '@/server/rules/orders/guest-validation'
import { FLOW_INTENT_UNCONFIRMED_MESSAGE, flowCustomerMismatchMessage, readFlow } from '@/server/rules/orders/reader-flow'
import { reconcile } from '@/server/rules/orders/reconcile'
import { CARD_FLOW_WAITING_WORDS, stuckList } from '@/server/rules/orders/stuck-list'
import { oldSide, replay, REPLAY_USER, startReplay, type ReplayEnvironment, type ScenarioContext } from '@/server/rules/testing/replay/harness'
import { BOOKING_KINDS_ON } from '@/server/rules/testing/replay/booking-side'
import { goodwill, ID, paidSeat, PROMO, sam, seed, tieredPrivatePrices, whileFailing } from '@/server/rules/testing/replay/scenarios'
import { replayStripe } from '@/server/rules/testing/replay/stripe-binding'
import { staffAppDir } from '@/server/rules/testing/staff-app-dir'
import { fakeStripeErrors, type FakeStripe } from '@/server/stripe/fake'
import { addGuestDescription } from './add-guest'
import {
  ADD_GUEST_NOT_SAVED_MESSAGE,
  ADD_GUEST_REASON_WORDS,
  ADD_GUEST_WORDS,
  ADD_ADDONS_REASON_WORDS,
  addGuestReaderNotStartedMessage,
  AMOUNT_CHANGED_MESSAGE,
  BOOKING_PATH_OFF_MESSAGE,
  CARD_FLOW_PAID_NOT_FINISHED_MESSAGE,
  CARD_PAYMENT_OPEN_MESSAGE,
  CHANGE_PAYMENT_UNCONFIRMED_MESSAGE,
  MOVE_WORDS,
  READER_PAYMENT_OPEN_MESSAGE,
} from './failure-messages'
import { CARD_FLOW_SEND_LIMIT_MINUTES, chargeCardFlow, flowChargeKey, flowReaderIntentKey, settleCardFlow, type CardFlowSnapshot } from './flow'

// Brief W20: Add Guest on the Worker (D-plan 1.3, 4.2, 4.7, 4.8), on the replay's live schema (its triggers,
// quote_booking and the store credit function included), through the route as the staff app calls it, and C1, the card
// and reader flows, reconcile and the crash points directly. Bookings are made by the frozen old order code (the
// replay's old side). Stripe is only ever the fake.

const holder = vi.hoisted(() => ({ db: null as unknown, crash: null as null | 'after_c1' | 'after_charge' }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))
vi.mock('@/server/stripe/client', async (importOriginal) => {
  const { stripeClientMock } = await import('@/server/rules/testing/replay/stripe-binding')
  return stripeClientMock(await importOriginal<typeof import('@/server/stripe/client')>())
})
// The crash points: the Worker dies straight after C1 commits (nothing sent), or straight after the charge's answer
// (before C2). What either leaves is what reconcile must settle.
vi.mock('./flow', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./flow')>()
  return {
    ...actual,
    settleCardFlow: async (...args: Parameters<typeof actual.settleCardFlow>) => {
      if (holder.crash === 'after_c1') throw new Error('the Worker died after C1')
      if (holder.crash === 'after_charge') {
        const [db, stripe, pendingId] = args
        const flow = await readFlow(db, pendingId)
        if (flow) await actual.chargeCardFlow(stripe, flow as Parameters<typeof actual.chargeCardFlow>[1])
        throw new Error('the Worker died after the charge')
      }
      return actual.settleCardFlow(...args)
    },
  }
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

const alex = { name: 'Alex Guest', email: 'alex@example.com' }
/** Sam and Alex on the £20 public session, paid in cash (£40), so the fake sees only Add Guest's calls. */
const publicBooking = { booking: paidSeat([sam, alex]), payment: { method: 'cash', confirmedCashAmount: 40 } }
/** Sam and Alex in the private session (£100 for up to two, or the tiered prices), in cash. */
const privateBooking = { booking: { ...paidSeat([sam, alex]), sessionId: ID.privateSession }, payment: { method: 'cash', confirmedCashAmount: 100 } }
/** The same with ALLTEN (10% off): £90 paid, £10 the promo's share. */
const privateWithPromo = { ...privateBooking, promoCode: PROMO.percent, payment: { method: 'cash', confirmedCashAmount: 90 } }

/** A booking made by the frozen old order code for `customerId`, then `work`. The fake is the route's. */
async function onABooking(
  order: Record<string, unknown>,
  work: (context: Context) => Promise<void>,
  { prepare, customerId = ID.customer }: { prepare?: (db: Db) => Promise<void>; customerId?: string } = {}
): Promise<void> {
  await replay(
    environment,
    {
      name: 'w20 add guest',
      async seed(seedDb, stripe) {
        await seed(seedDb, stripe)
        await prepare?.(seedDb)
      },
      async run(context) {
        replayStripe.current = context.stripe
        const placed = (await context.call('createOrder', { customerId, ...order })) as { bookingId: string }
        try {
          await work({ ...context, bookingId: placed.bookingId })
        } finally {
          replayStripe.current = null
          holder.crash = null
        }
      },
    },
    oldSide
  )
}

type Details = { reason?: string; message?: string; priceImpact?: Record<string, unknown>; pendingId?: string; guestIndex?: number; screenWords?: boolean; kinds?: string[] }
type Answer = { status: number; body: { ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string; details?: Details } } }

async function post(bookingId: string, body: unknown, { key = crypto.randomUUID(), orderSwitch = BOOKING_KINDS_ON } = {}): Promise<Answer> {
  const before = process.env.ORDER_SWITCH
  process.env.ORDER_SWITCH = orderSwitch
  try {
    const response = await guestsRoute(
      new Request(`https://worker.test/api/v1/staff/bookings/${bookingId}/guests`, {
        method: 'POST',
        headers: { authorization: `Bearer ${KEY}`, 'x-staff-email': REPLAY_USER.email, 'idempotency-key': key, 'content-type': 'application/json' },
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

async function flowStep(step: 'finalise' | 'cancel', pendingId: string) {
  const route = step === 'finalise' ? finaliseFlowRoute : cancelFlowRoute
  const response = await route(
    new Request(`https://worker.test/api/v1/staff/reader-flows/${pendingId}/${step}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'x-staff-email': REPLAY_USER.email, 'idempotency-key': crypto.randomUUID(), 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }),
    { params: Promise.resolve({ pendingId }) }
  )
  return (await response.json()) as { ok: boolean; data?: Record<string, unknown> }
}

const bea = { guestName: 'Bea Guest', guestEmail: 'bea@example.com', guestsOver18Confirmed: true }
const towel = (quantity = 1, extra: Record<string, unknown> = {}) => ({ addonId: ID.addon, quantity, ...extra })
const figures = (amountDue: number, toCollect: number) => ({ figures: { amountDue, toCollect } })
const refused = (answer: Answer) => ({
  status: answer.status,
  reason: answer.body.error?.details?.reason,
  message: answer.body.error?.message,
  priceImpact: answer.body.error?.details?.priceImpact,
})
const impact = (amountDue: number, guestAmount: number, addonsAmount: number) => ({ amountDue, guestAmount, addonsAmount, creditAvailable: false })

type BookingRow = { status: string; price_paid: string; party_size: number }
const booking = async (bookingId: string) =>
  (await db.query<BookingRow>('SELECT status, price_paid::text AS price_paid, party_size FROM bookings WHERE id = $1', [bookingId]))[0] as BookingRow
const guests = async (bookingId: string) =>
  db.query<{ id: string; guest_name: string; unit_price: string | null; pay_by: string | null }>(
    'SELECT id, guest_name, unit_price::text AS unit_price, pay_by FROM booking_guests WHERE booking_id = $1 ORDER BY created_at, id',
    [bookingId]
  )
const places = async (sessionId: string = ID.session) => (await db.query<{ n: number }>('SELECT total_booked AS n FROM sessions WHERE id = $1', [sessionId]))[0]?.n
const storeCredit = async (customerId: string = ID.customer) => (await db.query<{ b: string }>('SELECT store_credit_balance::text AS b FROM customers WHERE id = $1', [customerId]))[0]?.b
const giftCard = async () => (await db.query<{ b: string; r: boolean }>('SELECT remaining_balance::text AS b, redeemed_at IS NOT NULL AS r FROM gift_cards WHERE id = $1', [ID.giftCard]))[0]
const addonCredits = async () => (await db.query<{ n: number }>('SELECT addon_credits_remaining AS n FROM customer_memberships WHERE id = $1', [ID.membership]))[0]?.n
const flows = async (bookingId: string) =>
  db.query<{ id: string; status: string; payment_intent_id: string | null; expected_amount: string; snapshot: CardFlowSnapshot & Record<string, unknown> }>(
    'SELECT id, status, payment_intent_id, round(expected_amount, 2)::text AS expected_amount, snapshot FROM pending_reader_payments WHERE record_id = $1 ORDER BY created_at, id',
    [bookingId]
  )
/** The orders this booking's Add Guest presses wrote (every order but the booking's own, orders#1). */
const addOrders = async (bookingId: string) =>
  db.query<{ id: string; order_total: string; payment_method: string | null; stripe_payment_intent_id: string | null; payment_status: string }>(
    `SELECT o.id, o.order_total::text AS order_total, o.payment_method, o.stripe_payment_intent_id, o.payment_status FROM orders o
     WHERE o.customer_id = (SELECT customer_id FROM bookings WHERE id = $1)
       AND o.id <> (SELECT order_id FROM order_line_items WHERE booking_id = $1 ORDER BY created_at, id LIMIT 1)
     ORDER BY o.created_at, o.id`,
    [bookingId]
  )
const bookingLines = async (orderId: string) =>
  db.query<{ unit_price: string; line_total: string }>("SELECT unit_price::text AS unit_price, line_total::text AS line_total FROM order_line_items WHERE order_id = $1 AND item_type = 'booking'", [orderId])
const addonLines = async (bookingId: string) =>
  db.query<{ id: string; order_id: string | null; quantity: number; price_at_purchase: string; redemption_source: string; redeemed_membership_id: string | null }>(
    'SELECT id, order_id, quantity, price_at_purchase::text AS price_at_purchase, redemption_source, redeemed_membership_id FROM addon_order_lines WHERE booking_id = $1 ORDER BY created_at, id',
    [bookingId]
  )
const audits = async (bookingId: string) =>
  db.query<{ details: Record<string, unknown> }>("SELECT details FROM audit_log WHERE entity_id = $1 AND action = 'booking.guest_add' ORDER BY at, id", [bookingId])
const giftRows = async (bookingId: string) =>
  db.query<{ amount_used: string; order_id: string | null }>('SELECT amount_used::text AS amount_used, order_id FROM gift_card_redemptions WHERE booking_id = $1 ORDER BY redeemed_at, id', [bookingId])
const creditRows = async (bookingId: string) =>
  db.query<{ amount: string; reason: string; order_id: string | null; note: string }>(
    'SELECT amount::text AS amount, reason, order_id, note FROM store_credit_transactions WHERE booking_id = $1 ORDER BY created_at, id',
    [bookingId]
  )
const creates = (stripe: FakeStripe) => stripe.calls.filter((call) => call.method === 'paymentIntents.create')
const runReconcile = (stripe: FakeStripe) => reconcile(db, stripe, { actor: { type: 'system', id: null }, requestId: 'w20-reconcile', maxItems: 50, budgetMs: 120_000 })
/** Past the 15-minute window (the replay's clock stands still, Postgres's too). */
const ageFlows = (bookingId: string, minutes = 20) =>
  db.query('UPDATE pending_reader_payments SET created_at = created_at - make_interval(mins => $2::int) WHERE record_id = $1', [bookingId, minutes])

/**
 * Nothing of an Add Guest left on the public booking: two guests, two places, £40, the money parts as seeded. An undone
 * flow keeps C1's `booking.guest_add` row (as Settle's keeps `booking.settle`), so `audited` says how many there are.
 */
async function untouched(bookingId: string, { audited = 0 }: { audited?: number } = {}): Promise<void> {
  expect(await booking(bookingId)).toMatchObject({ status: 'confirmed', price_paid: '40.00', party_size: 2 })
  expect(await guests(bookingId)).toHaveLength(2)
  expect(await places()).toBe(2)
  expect(await storeCredit()).toBe('30.00')
  expect(await giftCard()).toEqual({ b: '40.00', r: false })
  expect(await addonLines(bookingId)).toEqual([])
  expect(await addOrders(bookingId)).toEqual([])
  expect(await audits(bookingId)).toHaveLength(audited)
}

describe('the quote and an add with no card money (C1 finishes it: one transaction, its own order as today)', () => {
  it("the first call: the Worker's figures and nothing added; a quote is never refused by the switch", async () => {
    await onABooking(publicBooking, async ({ bookingId }) => {
      const quote = await post(bookingId, { ...bea, addons: [towel(2)] }, { orderSwitch: '' })
      expect(quote.status).toBe(200)
      expect(quote.body.data).toEqual({ added: false, priceImpact: impact(30, 20, 10) })
      await untouched(bookingId)
    })
  })

  it('a guest in cash: the guest, the place, price_paid; its own paid order with the seat on its booking line; booking.guest_add', async () => {
    await onABooking(publicBooking, async ({ bookingId, stripe }) => {
      const answer = await post(bookingId, { ...bea, payment: { method: 'cash', confirmedCashAmount: 20 }, ...figures(20, 20) })
      const [, , bea3] = await guests(bookingId)
      expect(answer.body.data).toEqual({
        added: true,
        limitReached: false,
        guest: { id: bea3?.id, guest_name: 'Bea Guest', guest_email: 'bea@example.com', guest_type: 'additional_guest', unit_price: 20, pay_by: 'paid' },
        addonLineIds: [],
      })
      expect(await booking(bookingId)).toMatchObject({ price_paid: '60.00', party_size: 3 })
      expect(await places()).toBe(3)
      const [order] = await addOrders(bookingId)
      expect(order).toMatchObject({ order_total: '20.00', payment_method: 'cash', payment_status: 'paid', stripe_payment_intent_id: null })
      expect(await bookingLines(order?.id ?? '')).toEqual([{ unit_price: '20.00', line_total: '20.00' }])
      expect(await flows(bookingId)).toEqual([])
      expect((await audits(bookingId)).map((row) => row.details)).toEqual([
        { guestId: bea3?.id, addonLineIds: [], guestAmount: 20, addonsAmount: 0, amountDue: 20, storeCredit: 0, giftCard: 0, method: 'cash', toCollect: 20, orderId: order?.id, pendingId: null },
      ])
      expect(stripe.calls).toEqual([])
    })
  })

  it('add-ons alone, paid by store credit, gift card and cash: one order (split) holding every part, no booking line, the lines on it', async () => {
    await onABooking(publicBooking, async ({ bookingId }) => {
      const body = { addons: [towel(2)], payment: { method: 'cash', confirmedCashAmount: 5, storeCredit: { amount: 3 }, giftCard: { giftCardId: ID.giftCard, amount: 2 } }, ...figures(10, 5) }
      expect((await post(bookingId, body)).body.data).toMatchObject({ added: true, guest: null })
      const [order] = await addOrders(bookingId)
      expect(order).toMatchObject({ order_total: '10.00', payment_method: 'split' })
      expect(await bookingLines(order?.id ?? '')).toEqual([])
      expect(await addonLines(bookingId)).toEqual([expect.objectContaining({ order_id: order?.id, quantity: 2, price_at_purchase: '5.00', redemption_source: 'paid' })])
      expect(await giftRows(bookingId)).toEqual([{ amount_used: '2.00', order_id: order?.id }])
      expect(await creditRows(bookingId)).toEqual([
        { amount: '-3.00', reason: 'redemption', order_id: order?.id, note: `Store credit redeemed: ${addGuestDescription(bookingId, false, true).toLowerCase()}.` },
      ])
      expect(await booking(bookingId)).toMatchObject({ price_paid: '40.00', party_size: 2 })
      expect(await places()).toBe(2)
    })
  })

  it("a gift card used up is stamped redeemed (W09 review O1), as New Order's claim does", async () => {
    await onABooking(publicBooking, async ({ bookingId }) => {
      await db.query('UPDATE gift_cards SET remaining_balance = 20 WHERE id = $1', [ID.giftCard])
      expect((await post(bookingId, { ...bea, payment: { giftCard: { giftCardId: ID.giftCard, amount: 20 } }, ...figures(20, 0) })).body.data).toMatchObject({ added: true })
      expect(await giftCard()).toEqual({ b: '0.00', r: true })
      expect((await addOrders(bookingId))[0]).toMatchObject({ payment_method: 'gift_card', order_total: '20.00' })
    })
  })

  it('a free private guest (same tier): added with no payment and no order; the switch off refuses it (the quote never is)', async () => {
    await onABooking(privateBooking, async ({ bookingId }) => {
      const off = await post(bookingId, bea, { orderSwitch: 'no_stripe,saved_card,reader,membership' })
      expect(off.body.error).toMatchObject({ code: 'BOOKING_PATH_OFF', message: BOOKING_PATH_OFF_MESSAGE })
      expect(await guests(bookingId)).toHaveLength(2)
      const added = await post(bookingId, bea)
      expect(added.body.data).toMatchObject({ added: true, limitReached: false, guest: { unit_price: null, pay_by: null } })
      expect(await booking(bookingId)).toMatchObject({ price_paid: '100.00', party_size: 3 })
      expect(await places(ID.privateSession)).toBe(10)
      expect(await addOrders(bookingId)).toEqual([])
    })
  })

  it('Q25: a private tier crossing with a promo charges only the tier difference (£150 less £90 paid and the £10 promo share)', async () => {
    await onABooking(
      privateWithPromo,
      async ({ bookingId }) => {
        expect((await post(bookingId, bea)).body.data).toEqual({ added: false, priceImpact: impact(50, 50, 0) })
        expect((await post(bookingId, { ...bea, payment: { method: 'cash', confirmedCashAmount: 50 }, ...figures(50, 50) })).body.data).toMatchObject({ added: true })
        expect(await booking(bookingId)).toMatchObject({ price_paid: '140.00', party_size: 3 })
        // The fourth is the same tier: nothing more.
        expect((await post(bookingId, { ...bea, guestName: 'Cy Guest' })).body.data).toMatchObject({ added: true })
        expect(await booking(bookingId)).toMatchObject({ price_paid: '140.00', party_size: 4 })
      },
      { prepare: tieredPrivatePrices }
    )
  })

  it('a group already covered above the tier price (the tier lowered since): the guest is £0, never a negative price', async () => {
    await onABooking(privateBooking, async ({ bookingId }) => {
      await db.query("UPDATE service_type_price_tiers SET price = 80 WHERE id = $1", [ID.privateTier])
      // With a towel: the seat is £0 (not −£20), so the towel's £5 is still due.
      expect((await post(bookingId, { ...bea, addons: [towel(1)] })).body.data).toEqual({ added: false, priceImpact: impact(5, 0, 5) })
      expect((await post(bookingId, { ...bea, addons: [towel(1)], payment: { method: 'cash', confirmedCashAmount: 5 }, ...figures(5, 5) })).body.data).toMatchObject({ added: true })
      expect(await booking(bookingId)).toMatchObject({ price_paid: '100.00', party_size: 3 })
      expect((await addOrders(bookingId))[0]).toMatchObject({ order_total: '5.00', payment_method: 'cash' })
    })
  })

  it('Q27: a part refund stays with the customer: £100 paid, £30 part refunded, the third guest costs only the £50 tier difference', async () => {
    await onABooking(
      privateBooking,
      async ({ bookingId, call }) => {
        await call('refundBooking', { bookingId, refundMethod: 'credit', amount: 30, ...goodwill })
        expect((await post(bookingId, bea)).body.data).toEqual({ added: false, priceImpact: impact(50, 50, 0) })
      },
      { prepare: tieredPrivatePrices }
    )
  })

  it("add-on on credit: a Herd member's add-on credit taken, no money, no order; too few credits or not Herd refused", async () => {
    await onABooking(
      { booking: paidSeat([sam]), payment: { method: 'cash', confirmedCashAmount: 20 } },
      async ({ bookingId }) => {
        const credit = (quantity: number) => ({ addons: [towel(quantity, { redemptionSource: 'membership_credit', membershipId: ID.membership })] })
        expect(refused(await post(bookingId, credit(3)))).toMatchObject({ reason: 'insufficient_addon_membership_credit', message: ADD_ADDONS_REASON_WORDS['insufficient_addon_membership_credit'] })
        expect(await addonCredits()).toBe(2)
        expect((await post(bookingId, credit(1))).body.data).toMatchObject({ added: true, guest: null })
        expect(await addonCredits()).toBe(1)
        expect(await addonLines(bookingId)).toEqual([expect.objectContaining({ order_id: null, redemption_source: 'membership_credit', redeemed_membership_id: ID.membership })])
        expect(await addOrders(bookingId)).toEqual([])
        await db.query('UPDATE customer_memberships SET is_herd = false WHERE id = $1', [ID.membership])
        expect(refused(await post(bookingId, credit(1)))).toMatchObject({ reason: 'addon_membership_too_new' })
        expect(refused(await post(bookingId, { addons: [towel(1, { redemptionSource: 'membership_credit' })] }))).toMatchObject({ reason: 'addon_membership_id_required' })
      },
      { customerId: ID.member }
    )
  })

  it('add-on prices as New Order: a sent price counts only with Manage pricing, and a different one needs a reason', async () => {
    await onABooking(publicBooking, async ({ bookingId }) => {
      expect(refused(await post(bookingId, { addons: [towel(1, { unitPrice: 4 })] }))).toMatchObject({ status: 400, reason: 'price_override_reason_required', message: ADD_GUEST_WORDS.overrideReasonRequired })
      expect(refused(await post(bookingId, { addons: [towel(1, { unitPrice: -1, priceOverrideReason: 'x' })] }))).toMatchObject({ reason: 'invalid_addon_price' })
      expect((await post(bookingId, { addons: [towel(1, { unitPrice: 4, priceOverrideReason: 'Damaged' })] })).body.data).toEqual({ added: false, priceImpact: impact(4, 0, 4) })
      await db.query('UPDATE staff SET can_manage_pricing = false')
      expect((await post(bookingId, { addons: [towel(1, { unitPrice: 4 })] })).body.data).toEqual({ added: false, priceImpact: impact(5, 0, 5) })
    })
  })

  it('the same key twice: one guest, the stored answer', async () => {
    await onABooking(publicBooking, async ({ bookingId }) => {
      const key = crypto.randomUUID()
      const body = { ...bea, payment: { method: 'cash', confirmedCashAmount: 20 }, ...figures(20, 20) }
      const first = await post(bookingId, body, { key })
      const second = await post(bookingId, body, { key })
      expect(second.body.data).toEqual(first.body.data)
      expect(await guests(bookingId)).toHaveLength(3)
      expect(await audits(bookingId)).toHaveLength(1)
    })
  })

  it('a fault after every claim inside C1 keeps nothing (one transaction: R4a, R1c), and says so plainly', async () => {
    await onABooking(publicBooking, async ({ bookingId }) => {
      const body = { ...bea, addons: [towel(1)], payment: { method: 'cash', confirmedCashAmount: 15, storeCredit: { amount: 5 }, giftCard: { giftCardId: ID.giftCard, amount: 5 } }, ...figures(25, 15) }
      const answer = await whileFailing(db, { table: 'audit_log', event: 'INSERT', when: "NEW.action = 'booking.guest_add'" }, () => post(bookingId, body))
      expect(answer.status).toBe(500)
      expect(answer.body.error).toMatchObject({ message: ADD_GUEST_NOT_SAVED_MESSAGE, details: { reason: 'add_guest_not_saved', action: 'add_guest' } })
      await untouched(bookingId)
    })
  })
})

describe('refusals, in the old order, with nothing written', () => {
  it('the guest: a name or add-ons, the 18+ tick (guestIndex 0, W06 F4), before anything is read', async () => {
    await onABooking(publicBooking, async ({ bookingId }) => {
      expect(await post(bookingId, { guestName: '  ' })).toMatchObject({
        status: 400,
        body: { error: { message: ADD_GUEST_WORDS.guestNameRequired, details: { reason: 'guest_name_required', guestIndex: 0 } } },
      })
      expect(await post(crypto.randomUUID(), { guestName: 'Bea' })).toMatchObject({
        status: 400,
        body: { error: { message: GUESTS_OVER_18_NOT_CONFIRMED_MESSAGE, details: { reason: 'guests_over_18_not_confirmed', guestIndex: 0 } } },
      })
      await untouched(bookingId)
    })
  })

  it("the booking: not found, cancelled, a payment open (the card words or the reader words), the session started, the guest limit", async () => {
    await onABooking(publicBooking, async ({ bookingId }) => {
      expect(refused(await post(crypto.randomUUID(), bea))).toMatchObject({ status: 404, reason: 'booking_not_found', message: ADD_GUEST_REASON_WORDS['booking_not_found'] })
      const flow = (method: string) =>
        db.query(`INSERT INTO pending_reader_payments (flow, record_id, expected_amount, snapshot, status) VALUES ('settle', $1, 20, $2::jsonb, 'pending') RETURNING id`, [
          bookingId,
          JSON.stringify({ customer_id: ID.customer, description: 'x', method, request_id: 'r' }),
        ])
      await flow('card')
      expect(refused(await post(bookingId, bea))).toMatchObject({ status: 409, reason: 'card_payment_open', message: CARD_PAYMENT_OPEN_MESSAGE })
      await flow('reader')
      expect(refused(await post(bookingId, bea))).toMatchObject({ reason: 'reader_payment_open', message: READER_PAYMENT_OPEN_MESSAGE })
      await db.query("UPDATE pending_reader_payments SET status = 'cancelled' WHERE record_id = $1", [bookingId])
      // The wrapper leaves out the dialog's own words (screenWords) when the old function sent none.
      const started = await (async () => {
        await db.query("UPDATE sessions SET start_time = now() - interval '1 hour' WHERE id = $1", [ID.session])
        try {
          return await post(bookingId, bea)
        } finally {
          // Its band is set again from the start time by a trigger, so it is put back as seeded.
          await db.query("UPDATE sessions SET start_time = '2026-11-12 10:00:00+00' WHERE id = $1", [ID.session])
          await db.query('UPDATE sessions SET band_id = $2 WHERE id = $1', [ID.session, ID.band])
        }
      })()
      expect(started.body.error?.details).toMatchObject({ reason: 'session_already_started', message: ADD_GUEST_REASON_WORDS['session_already_started'], screenWords: true })
      await db.query("UPDATE bookings SET status = 'cancelled' WHERE id = $1", [bookingId])
      expect(refused(await post(bookingId, bea))).toMatchObject({ reason: 'booking_cancelled', message: ADD_GUEST_REASON_WORDS['booking_cancelled'] })
      await db.query("UPDATE bookings SET status = 'confirmed' WHERE id = $1", [bookingId])
      for (let i = 0; i < 4; i += 1) {
        await db.query("INSERT INTO booking_guests (booking_id, guest_type, guest_name, unit_price, pay_by) VALUES ($1, 'additional_guest', 'Extra', 20, 'paid')", [bookingId])
      }
      expect((await post(bookingId, bea)).body.data).toEqual({ added: false, limitReached: true, guest: null })
    })
  })

  it('the prices: no private tier, a tier with no price, credit asked for a guest, the session full', async () => {
    await onABooking(privateBooking, async ({ bookingId }) => {
      await db.query('UPDATE service_type_price_tiers SET price = NULL WHERE id = $1', [ID.privateTier])
      expect(refused(await post(bookingId, bea))).toMatchObject({ reason: 'price_pending' })
      await db.query('DELETE FROM service_type_price_tiers WHERE id = $1', [ID.privateTier])
      expect(refused(await post(bookingId, bea))).toMatchObject({ reason: 'private_price_not_set', message: MOVE_WORDS.privatePriceNotSet })
    })
    await onABooking(publicBooking, async ({ bookingId }) => {
      expect(refused(await post(bookingId, { ...bea, useExistingCredit: true }))).toMatchObject({ reason: 'credit_not_available_for_guests' })
      await db.query('UPDATE sessions SET total_booked = capacity WHERE id = $1', [ID.session])
      expect(refused(await post(bookingId, { ...bea, payment: { method: 'cash', confirmedCashAmount: 20 }, ...figures(20, 20) }))).toMatchObject({ reason: 'insufficient_capacity' })
      expect(await guests(bookingId)).toHaveLength(2)
    })
  })

  it('the add-ons: quantity, not found, not on sale, another customer\'s membership', async () => {
    await onABooking(publicBooking, async ({ bookingId }) => {
      expect(refused(await post(bookingId, { addons: [towel(0)] }))).toMatchObject({ reason: 'invalid_addon_quantity' })
      expect(refused(await post(bookingId, { addons: [{ addonId: crypto.randomUUID(), quantity: 1 }] }))).toMatchObject({ reason: 'addon_not_found' })
      expect(refused(await post(bookingId, { addons: [towel(1, { redemptionSource: 'membership_credit', membershipId: ID.membership })] }))).toMatchObject({ reason: 'addon_membership_not_found' })
      await db.query('UPDATE addons SET active = false WHERE id = $1', [ID.addon])
      expect(refused(await post(bookingId, { addons: [towel(1)] }))).toMatchObject({ reason: 'addon_inactive' })
      await untouched(bookingId)
    })
  })

  it('Q18: the cash figure, the card figure and the amount due, each refused over half a penny with the new figures (Q11 words); half a penny passes', async () => {
    await onABooking(publicBooking, async ({ bookingId, stripe }) => {
      const body = (method: string, toCollect: number, amountDue = 20) => ({ ...bea, payment: { method, ...(method === 'cash' ? { confirmedCashAmount: toCollect } : {}) }, ...figures(amountDue, toCollect) })
      const changed = 'The amount due has changed to £20.00. Check it with the customer and confirm again.'
      expect(refused(await post(bookingId, body('cash', 19.99)))).toEqual({ status: 409, reason: 'cash_amount_changed', message: changed, priceImpact: impact(20, 20, 0) })
      expect(refused(await post(bookingId, body('card', 20.01)))).toEqual({ status: 409, reason: 'amount_changed', message: changed, priceImpact: impact(20, 20, 0) })
      expect(refused(await post(bookingId, body('reader', 20, 19.99)))).toMatchObject({ reason: 'amount_changed', priceImpact: impact(20, 20, 0) })
      expect(refused(await post(bookingId, { ...bea, payment: { method: 'card' } }))).toMatchObject({ reason: 'amount_changed' })
      expect(stripe.calls).toEqual([])
      await untouched(bookingId)
      expect((await post(bookingId, body('cash', 20.004, 20.004))).body.data).toMatchObject({ added: true })
    })
  })

  it('the money checks: over the amount, no method, the reader with nothing to take, an unknown method, store credit short, bad amounts', async () => {
    await onABooking(publicBooking, async ({ bookingId, stripe }) => {
      const pay = (payment: Record<string, unknown>, toCollect: number) => ({ ...bea, payment, ...figures(20, toCollect) })
      expect(refused(await post(bookingId, pay({ method: 'cash', giftCard: { giftCardId: ID.giftCard, amount: 25 } }, 0)))).toMatchObject({ reason: 'gift_card_amount_exceeds_total', priceImpact: impact(20, 20, 0) })
      expect(refused(await post(bookingId, pay({ storeCredit: { amount: 10 }, giftCard: { giftCardId: ID.giftCard, amount: 15 } }, 0)))).toMatchObject({ reason: 'store_credit_amount_exceeds_total' })
      expect(refused(await post(bookingId, pay({ storeCredit: { amount: 5 } }, 15)))).toMatchObject({ reason: 'payment_method_required', message: ADD_GUEST_REASON_WORDS['payment_method_required'] })
      expect(refused(await post(bookingId, pay({ method: 'reader', storeCredit: { amount: 10 }, giftCard: { giftCardId: ID.giftCard, amount: 10 } }, 0)))).toMatchObject({ reason: 'payment_method_required', message: AMOUNT_CHANGED_MESSAGE })
      expect(refused(await post(bookingId, pay({ method: 'cheque' }, 20)))).toMatchObject({ status: 400, reason: 'invalid_payment_method', message: ORDER_WORDS['invalid_payment_method'] })
      await db.query('UPDATE customers SET store_credit_balance = 2 WHERE id = $1', [ID.customer])
      expect(refused(await post(bookingId, pay({ method: 'cash', confirmedCashAmount: 15, storeCredit: { amount: 5 } }, 15)))).toMatchObject({ reason: 'store_credit_insufficient_or_invalid' })
      await db.query('UPDATE customers SET store_credit_balance = 30 WHERE id = $1', [ID.customer])
      expect(refused(await post(bookingId, pay({ method: 'cash', confirmedCashAmount: 25, giftCard: { giftCardId: ID.giftCard, amount: -5 } }, 25)))).toMatchObject({ reason: 'gift_card_amount_invalid' })
      expect(stripe.calls).toEqual([])
      await untouched(bookingId)
    })
  })

  it("gift cards: New Order's words for voided, expired, not found and used up; the place and store credit claimed before it go back", async () => {
    await onABooking(publicBooking, async ({ bookingId }) => {
      const body = (giftCardId: string) => ({ ...bea, payment: { method: 'cash', confirmedCashAmount: 5, storeCredit: { amount: 5 }, giftCard: { giftCardId, amount: 10 } }, ...figures(20, 5) })
      await db.query('UPDATE gift_cards SET voided = true WHERE id = $1', [ID.giftCard])
      expect(refused(await post(bookingId, body(ID.giftCard)))).toMatchObject({ reason: 'gift_card_insufficient_or_invalid', message: ORDER_WORDS['gift_card_voided'] })
      await db.query("UPDATE gift_cards SET voided = false, expiry_date = '2020-01-01' WHERE id = $1", [ID.giftCard])
      expect(refused(await post(bookingId, body(ID.giftCard)))).toMatchObject({ message: ORDER_WORDS['gift_card_expired'] })
      await db.query("UPDATE gift_cards SET expiry_date = '2030-01-01', remaining_balance = 0 WHERE id = $1", [ID.giftCard])
      expect(refused(await post(bookingId, body(ID.giftCard)))).toMatchObject({ message: ORDER_WORDS['gift_card_insufficient_or_invalid'] })
      expect(refused(await post(bookingId, body(crypto.randomUUID())))).toMatchObject({ message: ORDER_WORDS['gift_card_not_found'] })
      await db.query('UPDATE gift_cards SET remaining_balance = 40 WHERE id = $1', [ID.giftCard])
      await untouched(bookingId)
    })
  })

  it('the switch: a payment is gated before anything is read; the card needs saved_card, the reader reader_flows and reader', async () => {
    await onABooking(publicBooking, async ({ bookingId }) => {
      const off = async (method: string, orderSwitch: string) => (await post(bookingId, { ...bea, payment: { method }, ...figures(20, 20) }, { orderSwitch })).body.error
      expect(await off('cash', 'no_stripe,saved_card,reader,membership')).toMatchObject({ code: 'BOOKING_PATH_OFF' })
      expect(await off('card', 'booking_changes,reader_flows,reader')).toMatchObject({ code: 'BOOKING_PATH_OFF', details: { kinds: ['saved_card'] } })
      expect(await off('reader', 'booking_changes,saved_card,reader')).toMatchObject({ details: { kinds: ['reader_flows'] } })
      expect(await off('reader', 'booking_changes,saved_card,reader_flows')).toMatchObject({ details: { kinds: ['reader'] } })
      await untouched(bookingId)
    })
  })

  it("the card with no saved card: the legacy route's words, nothing claimed", async () => {
    await onABooking(publicBooking, async ({ bookingId, stripe }) => {
      await db.query('UPDATE customers SET saved_payment_method_id = NULL WHERE id = $1', [ID.customer])
      expect(refused(await post(bookingId, { ...bea, payment: { method: 'card', storeCredit: { amount: 5 } }, ...figures(20, 15) }))).toMatchObject({ reason: 'no_saved_card', message: NO_SAVED_CARD_MESSAGE })
      expect(stripe.calls).toEqual([])
      await untouched(bookingId)
    })
  })
})

const onCard = (extra: Record<string, unknown> = {}, amountDue = 20, toCollect = amountDue) => ({ payment: { method: 'card', ...extra }, ...figures(amountDue, toCollect) })

describe('the saved card (pending first, keyed from the record, C2 or the undo)', () => {
  it('a guest and an add-on: the record before the charge, `<pendingId>:charge` naming the record; C2 writes the seat on the booking line and the add-on on its own line of the same order (W05c N5)', async () => {
    await onABooking(publicBooking, async ({ bookingId, stripe }) => {
      const answer = await post(bookingId, { ...bea, addons: [towel(1)], ...onCard({ storeCredit: { amount: 5 } }, 25, 20) })
      expect(answer.body.data).toMatchObject({ added: true, limitReached: false, guest: { guest_name: 'Bea Guest', unit_price: 20 } })
      const [flow] = await flows(bookingId)
      if (!flow) throw new Error('no flow record')
      expect(flow).toMatchObject({ status: 'finalised', expected_amount: '20.00' })
      expect(flow.snapshot).toMatchObject({ method: 'card', channel: 'staff', stripe_customer_id: 'cus_seed', payment_method_id: 'pm_seed', livemode: false, store_credit_amount: 5, price_increment: 20, claimed_extra_capacity: true })
      const [charge] = creates(stripe)
      expect(charge?.idempotencyKey).toBe(flowChargeKey(flow.id))
      expect(charge?.params).toMatchObject({ amount: 2000, customer: 'cus_seed', payment_method: 'pm_seed', description: addGuestDescription(bookingId, true, true), metadata: { flow: 'add_guest', record_id: bookingId, pending_id: flow.id } })
      const [order] = await addOrders(bookingId)
      expect(order).toMatchObject({ order_total: '20.00', payment_method: 'card', stripe_payment_intent_id: flow.payment_intent_id })
      // £20 on the card: £5 of it is the towel (its own line), so the seat's part is £15 (the £5 store credit covered the rest).
      expect(await bookingLines(order?.id ?? '')).toEqual([{ unit_price: '15.00', line_total: '15.00' }])
      expect(await addonLines(bookingId)).toEqual([expect.objectContaining({ order_id: order?.id, price_at_purchase: '5.00' })])
      expect(await booking(bookingId)).toMatchObject({ price_paid: '60.00', party_size: 3 })
      expect((await audits(bookingId))[0]?.details).toMatchObject({ amountDue: 25, guestAmount: 20, addonsAmount: 5, storeCredit: 5, method: 'card', toCollect: 20, pendingId: flow.id, orderId: null })
    })
  })

  it('add-ons alone on the saved card: the card order holds them, with no booking line', async () => {
    await onABooking(publicBooking, async ({ bookingId }) => {
      expect((await post(bookingId, { addons: [towel(2)], ...onCard({}, 10) })).body.data).toMatchObject({ added: true, guest: null })
      const [order] = await addOrders(bookingId)
      expect(order).toMatchObject({ order_total: '10.00', payment_method: 'card' })
      expect(await bookingLines(order?.id ?? '')).toEqual([])
      expect(await addonLines(bookingId)).toEqual([expect.objectContaining({ order_id: order?.id, quantity: 2 })])
      expect(await booking(bookingId)).toMatchObject({ price_paid: '40.00', party_size: 2 })
    })
  })

  it('declined, then pressed again: undone in one transaction (guest, place, store credit, gift card and its stamp, add-on credits back), and the retry is a new record with a new key', async () => {
    await onABooking(
      { booking: paidSeat([sam]), payment: { method: 'cash', confirmedCashAmount: 20 } },
      async ({ bookingId, stripe }) => {
        await db.query('UPDATE gift_cards SET remaining_balance = 5 WHERE id = $1', [ID.giftCard])
        await db.query('UPDATE customers SET store_credit_balance = 10 WHERE id = $1', [ID.member])
        const body = {
          ...bea,
          addons: [towel(1, { redemptionSource: 'membership_credit', membershipId: ID.membership })],
          ...onCard({ storeCredit: { amount: 5 }, giftCard: { giftCardId: ID.giftCard, amount: 5 } }, 20, 10),
        }
        stripe.failNext('paymentIntents.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
        const declined = await post(bookingId, body)
        expect(declined.status).toBe(402)
        expect(declined.body.error).toMatchObject({ code: 'PAYMENT_FAILED', message: 'Failed to charge saved card: Your card was declined.', details: { reason: 'card_declined' } })
        expect(await guests(bookingId)).toHaveLength(1)
        expect(await booking(bookingId)).toMatchObject({ price_paid: '20.00', party_size: 1 })
        expect(await places()).toBe(1)
        expect(await storeCredit(ID.member)).toBe('10.00')
        expect(await giftCard()).toEqual({ b: '5.00', r: false })
        expect(await addonCredits()).toBe(2)
        expect(await addonLines(bookingId)).toEqual([])
        const paid = await post(bookingId, body)
        expect(paid.body.data).toMatchObject({ added: true })
        const records = await flows(bookingId)
        expect(records.map((row) => row.status).sort()).toEqual(['cancelled', 'finalised'])
        expect(new Set(creates(stripe).map((call) => call.idempotencyKey)).size).toBe(2)
        expect(await giftCard()).toEqual({ b: '0.00', r: true })
        expect(await addonCredits()).toBe(1)
      },
      { customerId: ID.member }
    )
  })

  it("no clear answer: held with Q35's words, never undone; reconcile finds the payment by `metadata.pending_id` and finishes it, sending no charge", async () => {
    await onABooking(publicBooking, async ({ bookingId, stripe }) => {
      stripe.failNext('paymentIntents.create', { kind: 'lost_response' })
      stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
      const held = await post(bookingId, { ...bea, ...onCard() })
      expect(held.status).toBe(502)
      expect(held.body.error).toMatchObject({ code: 'PAYMENT_UNCONFIRMED', message: CHANGE_PAYMENT_UNCONFIRMED_MESSAGE, details: { reason: 'payment_unconfirmed' } })
      expect(await guests(bookingId)).toHaveLength(3)
      await ageFlows(bookingId)
      expect((await stuckList(db)).flows.find((item) => item.recordId === bookingId)).toMatchObject({ madeBy: 'worker', words: CARD_FLOW_WAITING_WORDS })
      const sent = creates(stripe).length
      expect((await runReconcile(stripe)).items.find((item) => item.kind === 'flow')).toMatchObject({ outcome: 'finalised' })
      expect(creates(stripe)).toHaveLength(sent)
      expect(await addOrders(bookingId)).toHaveLength(1)
    })
  })

  it('no clear answer and nothing reached Stripe: left inside the window; past it reconcile undoes it (the guest, the place, the store credit back)', async () => {
    await onABooking(publicBooking, async ({ bookingId, stripe }) => {
      stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
      stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
      expect((await post(bookingId, { ...bea, ...onCard({ storeCredit: { amount: 5 } }, 20, 15) })).body.error).toMatchObject({ code: 'PAYMENT_UNCONFIRMED' })
      expect((await runReconcile(stripe)).items).toEqual([])
      await ageFlows(bookingId)
      expect((await runReconcile(stripe)).items.find((item) => item.kind === 'flow')).toMatchObject({ outcome: 'undone' })
      await untouched(bookingId, { audited: 1 })
    })
  })

  it('crash after C1 (nothing sent): reconcile finds no payment and undoes it', async () => {
    await onABooking(publicBooking, async ({ bookingId, stripe }) => {
      holder.crash = 'after_c1'
      expect((await post(bookingId, { ...bea, ...onCard({ storeCredit: { amount: 5 } }, 20, 15) })).status).toBe(500)
      holder.crash = null
      expect(await guests(bookingId)).toHaveLength(3)
      expect(creates(stripe)).toHaveLength(0)
      await ageFlows(bookingId)
      expect((await runReconcile(stripe)).items.find((item) => item.kind === 'flow')).toMatchObject({ outcome: 'undone' })
      await untouched(bookingId, { audited: 1 })
      expect(creates(stripe)).toHaveLength(0)
    })
  })

  it('crash after the charge, before C2: reconcile finds the payment and runs C2 (one order, one charge)', async () => {
    await onABooking(publicBooking, async ({ bookingId, stripe }) => {
      holder.crash = 'after_charge'
      expect((await post(bookingId, { ...bea, ...onCard() })).status).toBe(500)
      holder.crash = null
      expect(creates(stripe)).toHaveLength(1)
      expect(await addOrders(bookingId)).toEqual([])
      await ageFlows(bookingId)
      expect((await runReconcile(stripe)).items.find((item) => item.kind === 'flow')).toMatchObject({ outcome: 'finalised' })
      expect(await addOrders(bookingId)).toHaveLength(1)
      expect(creates(stripe)).toHaveLength(1)
    })
  })

  it("R2d: C2 fails after the card paid (its order refused): held, never refunded, its PaymentIntent on the row; reconcile writes the order", async () => {
    await onABooking(publicBooking, async ({ bookingId, stripe }) => {
      const answer = await whileFailing(db, { table: 'orders', event: 'INSERT', when: 'true' }, () => post(bookingId, { ...bea, ...onCard({ storeCredit: { amount: 5 } }, 20, 15) }))
      expect(answer.body.error).toMatchObject({ code: 'PAYMENT_UNCONFIRMED', message: CARD_FLOW_PAID_NOT_FINISHED_MESSAGE, details: { reason: 'paid_not_finished' } })
      const [flow] = await flows(bookingId)
      expect(flow).toMatchObject({ status: 'pending', payment_intent_id: expect.stringMatching(/^pi_fake_/) })
      expect(await guests(bookingId)).toHaveLength(3)
      expect(await storeCredit()).toBe('25.00')
      expect(stripe.refundsSent).toEqual([])
      await ageFlows(bookingId)
      expect((await runReconcile(stripe)).items.find((item) => item.kind === 'flow')).toMatchObject({ outcome: 'finalised' })
      expect(await addOrders(bookingId)).toEqual([expect.objectContaining({ order_total: '15.00', payment_method: 'card' })])
      expect(stripe.refundsSent).toEqual([])
    })
  })

  it("S1's bound: a record older than an hour sends nothing (held with Q35's words); just inside it, it sends", async () => {
    await onABooking(publicBooking, async ({ bookingId, stripe }) => {
      holder.crash = 'after_c1'
      await post(bookingId, { ...bea, ...onCard() })
      holder.crash = null
      const [flow] = await flows(bookingId)
      if (!flow) throw new Error('no flow')
      await ageFlows(bookingId, CARD_FLOW_SEND_LIMIT_MINUTES + 1)
      expect(await settleCardFlow(db, stripe, flow.id, { actor: { type: 'staff', id: ID.staff }, requestId: 'w20-old' })).toMatchObject({ outcome: 'held', reason: 'payment_unconfirmed' })
      expect(stripe.calls).toEqual([])
      await db.query('UPDATE pending_reader_payments SET created_at = now() - make_interval(mins => $2::int) WHERE id = $1', [flow.id, CARD_FLOW_SEND_LIMIT_MINUTES - 1])
      expect(await settleCardFlow(db, stripe, flow.id, { actor: { type: 'staff', id: ID.staff }, requestId: 'w20-old' })).toMatchObject({ outcome: 'finished' })
      expect(creates(stripe)).toHaveLength(1)
    })
  })

  it("Stripe's 409 key-in-use while the first send is in flight: held; reconcile finishes it with the first payment (one charge)", async () => {
    await onABooking(publicBooking, async ({ bookingId, stripe }) => {
      holder.crash = 'after_c1'
      await post(bookingId, { ...bea, ...onCard() })
      holder.crash = null
      const [flow] = await flows(bookingId)
      if (!flow) throw new Error('no flow')
      stripe.failNext('paymentIntents.create', { kind: 'lost_response' })
      stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
      await chargeCardFlow(stripe, (await readFlow(db, flow.id)) as Parameters<typeof chargeCardFlow>[1])
      stripe.forgetIdempotencyKeys()
      stripe.failNext('paymentIntents.create', { kind: 'key_in_use' })
      stripe.failNext('paymentIntents.create', { kind: 'key_in_use' })
      expect(await settleCardFlow(db, stripe, flow.id, { actor: { type: 'staff', id: ID.staff }, requestId: 'w20-second' })).toMatchObject({ outcome: 'held' })
      await ageFlows(bookingId)
      expect((await runReconcile(stripe)).items.find((item) => item.kind === 'flow')).toMatchObject({ outcome: 'finalised' })
      expect([...stripe.chargedByIntent.values()]).toEqual([2000])
      expect(await addOrders(bookingId)).toHaveLength(1)
    })
  })
})

describe('the reader, pending first (W12-7), finished or cancelled by the flow routes', () => {
  it('a guest and an add-on: the record first, the intent under `<pendingId>:reader-intent`; finalise writes the seat on the booking line and the add-on on its own line (W05c N5)', async () => {
    await onABooking(publicBooking, async ({ bookingId, stripe }) => {
      const answer = await post(bookingId, { ...bea, addons: [towel(1)], payment: { method: 'reader' }, ...figures(25, 25) })
      const pending = answer.body.data?.['pendingReaderPayment'] as { pendingId: string; paymentIntentId: string }
      expect(answer.body.data).toMatchObject({ added: true, guest: { guest_name: 'Bea Guest' }, pendingReaderPayment: { flow: 'add_guest', recordId: bookingId, amount: 25 } })
      expect(answer.body.data).not.toHaveProperty('limitReached')
      const [flow] = await flows(bookingId)
      expect(flow).toMatchObject({ id: pending.pendingId, status: 'pending', payment_intent_id: pending.paymentIntentId, expected_amount: '25.00' })
      expect(flow?.snapshot).toMatchObject({ method: 'reader', stripe_customer_id: 'cus_seed', livemode: false })
      const [intent] = creates(stripe)
      expect(intent?.idempotencyKey).toBe(flowReaderIntentKey(pending.pendingId))
      expect(intent?.params).toMatchObject({ amount: 2500, payment_method_types: ['card_present'], metadata: { flow: 'add_guest', record_id: bookingId, pending_id: pending.pendingId, supabase_customer_id: ID.customer } })
      stripe.completeReaderPayment(pending.paymentIntentId, { simulatedReader: true })
      expect((await flowStep('finalise', pending.pendingId)).data).toMatchObject({ finalised: true })
      const [order] = await addOrders(bookingId)
      expect(order).toMatchObject({ order_total: '25.00', payment_method: 'reader' })
      expect(await bookingLines(order?.id ?? '')).toEqual([{ unit_price: '20.00', line_total: '20.00' }])
      expect(await addonLines(bookingId)).toEqual([expect.objectContaining({ order_id: order?.id })])
    })
  })

  it('cancelled on the reader: the intent cancelled, the guest and add-on taken off, the place and store credit back', async () => {
    await onABooking(publicBooking, async ({ bookingId }) => {
      const answer = await post(bookingId, { ...bea, addons: [towel(1)], payment: { method: 'reader', storeCredit: { amount: 5 } }, ...figures(25, 20) })
      const pending = answer.body.data?.['pendingReaderPayment'] as { pendingId: string }
      expect((await flowStep('cancel', pending.pendingId)).data).toMatchObject({ cancelled: true })
      await untouched(bookingId, { audited: 1 })
    })
  })

  it("Stripe refuses the intent: undone at once with the old words; no clear answer: held with the reader's words, and reconcile undoes it", async () => {
    await onABooking(publicBooking, async ({ bookingId, stripe }) => {
      stripe.failNext('paymentIntents.create', { kind: 'error', error: fakeStripeErrors.invalid('parameter_invalid', 'Bad request') })
      const no = await post(bookingId, { ...bea, payment: { method: 'reader' }, ...figures(20, 20) })
      expect(no.body.error).toMatchObject({ code: 'PAYMENT_FAILED', message: addGuestReaderNotStartedMessage(true, 'Failed to create PaymentIntent: Bad request'), details: { reason: 'guest_add_failed' } })
      await untouched(bookingId, { audited: 1 })
      stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
      stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
      expect((await post(bookingId, { ...bea, payment: { method: 'reader' }, ...figures(20, 20) })).body.error).toMatchObject({ code: 'PAYMENT_UNCONFIRMED', message: FLOW_INTENT_UNCONFIRMED_MESSAGE })
      await ageFlows(bookingId)
      expect((await runReconcile(stripe)).items.find((item) => item.kind === 'flow')).toMatchObject({ outcome: 'undone' })
      await untouched(bookingId, { audited: 2 })
    })
  })

  it("W12 F2: a payment made for another Stripe customer isn't finalised", async () => {
    await onABooking(publicBooking, async ({ bookingId, stripe }) => {
      const answer = await post(bookingId, { ...bea, payment: { method: 'reader' }, ...figures(20, 20) })
      const pending = answer.body.data?.['pendingReaderPayment'] as { pendingId: string }
      stripe.addCustomer('cus_other')
      const other = await stripe.paymentIntents.create({ amount: 2000, currency: 'gbp', customer: 'cus_other', payment_method_types: ['card_present'], metadata: { flow: 'add_guest', record_id: bookingId, pending_id: pending.pendingId } })
      stripe.completeReaderPayment(other.id)
      await db.query('UPDATE pending_reader_payments SET payment_intent_id = $2 WHERE id = $1', [pending.pendingId, other.id])
      expect((await flowStep('finalise', pending.pendingId)).data).toMatchObject({ finalised: false, reason: 'customer_mismatch', message: flowCustomerMismatchMessage(other.id) })
      expect(await addOrders(bookingId)).toEqual([])
    })
  })

  it("the stored answer's client secret is taken out after 15 minutes, the rest kept", async () => {
    await onABooking(publicBooking, async ({ bookingId }) => {
      const key = crypto.randomUUID()
      const answer = await post(bookingId, { ...bea, payment: { method: 'reader' }, ...figures(20, 20) }, { key })
      const pending = answer.body.data?.['pendingReaderPayment'] as Record<string, unknown>
      const stored = () =>
        db.query<{ endpoint: string; secret: string | null }>(`SELECT endpoint, response #>> '{data,pendingReaderPayment,clientSecret}' AS secret FROM api_idempotency WHERE key = $1`, [key])
      expect(await pruneClientSecrets(db)).toBe(0)
      expect(await stored()).toEqual([{ endpoint: `POST /api/v1/staff/bookings/${bookingId}/guests`, secret: pending['clientSecret'] }])
      await db.query('UPDATE api_idempotency SET created_at = now() - make_interval(mins => $2::int) WHERE key = $1', [key, CLIENT_SECRET_WINDOW_MINUTES + 1])
      expect(await pruneClientSecrets(db)).toBe(1)
      expect(await stored()).toEqual([{ endpoint: `POST /api/v1/staff/bookings/${bookingId}/guests`, secret: null }])
    })
  })
})

describe('the old code leaves a held Worker Add Guest alone (brief W20 item 4)', () => {
  it("the staff app's old sweep skips a held Worker card Add Guest, and its stuck list shows it once, as the Worker's", async () => {
    await onABooking(publicBooking, async ({ bookingId, stripe }) => {
      holder.crash = 'after_c1'
      await post(bookingId, { ...bea, ...onCard() })
      holder.crash = null
      await ageFlows(bookingId)
      const [held] = await flows(bookingId)
      expect(held?.status).toBe('pending')
      const staffApp = (name: string) =>
        import(/* @vite-ignore */ path.join(staffAppDir(), 'backend/paddock', `${name}.ts`)) as Promise<{ default: (req: { params: unknown; user: { email: string } }) => Promise<unknown> }>
      const swept = (await (await staffApp('sweepPendingReaderPayments')).default({ params: { olderThanMinutes: 15 }, user: REPLAY_USER })) as { checked: number }
      expect(swept.checked).toBe(0)
      const listed = (await (await staffApp('getStuckReaderPayments')).default({ params: { olderThanMinutes: 15 }, user: REPLAY_USER })) as { flows: Array<{ pendingId: string; madeBy: string }> }
      expect(listed.flows.filter((item) => item.pendingId === held?.id)).toEqual([expect.objectContaining({ madeBy: 'worker' })])
      expect((await flows(bookingId))[0]?.status).toBe('pending')
      // And reconcile counts nothing of it as the old code's.
      expect((await runReconcile(stripe)).oldLeftAlone).toEqual({ orders: 0, flows: 0 })
    })
  })
})
