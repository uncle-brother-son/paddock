import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { POST as cancelFlowRoute } from '@/app/api/v1/staff/reader-flows/[pendingId]/cancel/route'
import { POST as finaliseFlowRoute } from '@/app/api/v1/staff/reader-flows/[pendingId]/finalise/route'
import { POST as settleRoute } from '@/app/api/v1/staff/bookings/[bookingId]/settle/route'
import type { Db } from '@/server/db'
import { DbTimeoutError } from '@/server/db'
import { CLIENT_SECRET_WINDOW_MINUTES, pruneClientSecrets } from '@/server/http/idempotency'
import { readFlow, undoFlowInTransaction, finaliseFlowInTransaction, FLOW_INTENT_UNCONFIRMED_MESSAGE, flowCustomerMismatchMessage } from '@/server/rules/orders/reader-flow'
import { reconcile } from '@/server/rules/orders/reconcile'
import { stuckList, CARD_FLOW_WAITING_WORDS } from '@/server/rules/orders/stuck-list'
import { FAILURE_MESSAGES as ORDER_WORDS, NO_SAVED_CARD_MESSAGE } from '@/server/rules/orders/failure-messages'
import { oldSide, replay, REPLAY_USER, startReplay, type ReplayEnvironment, type ScenarioContext } from '@/server/rules/testing/replay/harness'
import { ID, lapsedSeat, seed, whileFailing, giftCardRowFails } from '@/server/rules/testing/replay/scenarios'
import { replayStripe } from '@/server/rules/testing/replay/stripe-binding'
import { BOOKING_KINDS_ON } from '@/server/rules/testing/replay/booking-side'
import { staffAppDir } from '@/server/rules/testing/staff-app-dir'
import path from 'node:path'
import { fakeStripeErrors, type FakeStripe } from '@/server/stripe/fake'
import {
  AMOUNT_CHANGED_MESSAGE,
  BOOKING_PATH_OFF_MESSAGE,
  CARD_FLOW_PAID_NOT_FINISHED_MESSAGE,
  CARD_PAYMENT_OPEN_MESSAGE,
  CHANGE_PAYMENT_UNCONFIRMED_MESSAGE,
  READER_PAYMENT_OPEN_MESSAGE,
  SETTLE_REASON_WORDS,
  settleReaderNotStartedMessage,
  settleReaderNotStartedNotUndoneMessage,
  DECLINED_NOT_UNDONE_MESSAGE,
} from './failure-messages'
import { CARD_FLOW_SEND_LIMIT_MINUTES, chargeCardFlow, flowChargeKey, flowReaderIntentKey, settleCardFlow, type CardFlowSnapshot } from './flow'
import { settleBooking, SETTLE_STORE_CREDIT_NOTE, settleDescription } from './settle'

// Brief W19: Settle on the Worker (D-plan 1.4, 4.2, 4.7, 4.10), on the replay's live schema (its triggers and the
// store credit function included), through the route as the staff app calls it, and C1, the card and reader flows,
// reconcile's card part and the crash points directly. Stripe is only ever the fake.

const holder = vi.hoisted(() => ({ db: null as unknown, crash: null as null | 'after_c1' | 'after_charge' }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))
vi.mock('@/server/stripe/client', async (importOriginal) => {
  const { stripeClientMock } = await import('@/server/rules/testing/replay/stripe-binding')
  return stripeClientMock(await importOriginal<typeof import('@/server/stripe/client')>())
})
// The crash points (brief "Tests"): the Worker dies straight after C1 commits (nothing sent to Stripe), or straight
// after the charge's answer (before C2). What either leaves is what reconcile must settle.
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

/** Mo's lapsed £20 seat (the replay's lapsedSeat), with £10 of store credit, then `work`. The fake is the route's. */
async function onALapsedSeat(work: (context: Context) => Promise<void>): Promise<void> {
  await replay(
    environment,
    {
      name: 'w19 settle',
      seed,
      async run(context) {
        replayStripe.current = context.stripe
        const bookingId = await lapsedSeat(context.call, context.db)
        await context.db.query('UPDATE customers SET store_credit_balance = 10 WHERE id = $1', [ID.member])
        try {
          await work({ ...context, bookingId })
        } finally {
          replayStripe.current = null
          holder.crash = null
        }
      },
    },
    oldSide
  )
}

type Answer = {
  status: number
  body: { ok: boolean; data?: Record<string, unknown>; error?: { code: string; message: string; details?: { reason?: string; message?: string; amountDue?: number; pendingId?: string } } }
}

async function post(bookingId: string, body: unknown, { key = crypto.randomUUID(), orderSwitch = BOOKING_KINDS_ON } = {}): Promise<Answer> {
  const before = process.env.ORDER_SWITCH
  process.env.ORDER_SWITCH = orderSwitch
  try {
    const response = await settleRoute(
      new Request(`https://worker.test/api/v1/staff/bookings/${bookingId}/settle`, {
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

const figures = (amountDue: number, toCollect: number) => ({ figures: { amountDue, toCollect } })
const onCard = (extra: Record<string, unknown> = {}) => ({ payment: { method: 'card', ...extra }, ...figures(20, 20 - Number((extra['storeCredit'] as { amount?: number } | undefined)?.amount ?? 0) - Number((extra['giftCard'] as { amount?: number } | undefined)?.amount ?? 0)) })

type BookingRow = { status: string; price_paid: string; redemption_source: string; credit_period_id: string | null; payment_due_by: unknown }
const booking = async (bookingId: string) =>
  (await db.query<BookingRow>('SELECT status, price_paid::text AS price_paid, redemption_source, credit_period_id, payment_due_by FROM bookings WHERE id = $1', [bookingId]))[0] as BookingRow
const seat1PayBy = async (bookingId: string) =>
  (await db.query<{ pay_by: string }>("SELECT pay_by FROM booking_guests WHERE booking_id = $1 AND guest_type = 'account_holder'", [bookingId]))[0]?.pay_by
const storeCredit = async () => (await db.query<{ b: string }>('SELECT store_credit_balance::text AS b FROM customers WHERE id = $1', [ID.member]))[0]?.b
const giftCard = async () => (await db.query<{ b: string; r: boolean }>('SELECT remaining_balance::text AS b, redeemed_at IS NOT NULL AS r FROM gift_cards WHERE id = $1', [ID.giftCard]))[0]
const flows = async (bookingId: string) =>
  db.query<{ id: string; status: string; payment_intent_id: string | null; expected_amount: string; snapshot: CardFlowSnapshot & Record<string, unknown> }>(
    'SELECT id, status, payment_intent_id, round(expected_amount, 2)::text AS expected_amount, snapshot FROM pending_reader_payments WHERE record_id = $1 ORDER BY created_at, id',
    [bookingId]
  )
const ordersFor = async (bookingId: string) =>
  db.query<{ id: string; order_total: string; payment_method: string | null; stripe_payment_intent_id: string | null }>(
    `SELECT o.id, o.order_total::text AS order_total, o.payment_method, o.stripe_payment_intent_id FROM orders o
     JOIN order_line_items l ON l.order_id = o.id WHERE l.booking_id = $1 AND o.stripe_payment_intent_id IS NOT NULL ORDER BY o.created_at, o.id`,
    [bookingId]
  )
const audits = async (bookingId: string) =>
  db.query<{ action: string; details: Record<string, unknown> }>("SELECT action, details FROM audit_log WHERE entity_id = $1 AND action = 'booking.settle' ORDER BY at, id", [bookingId])
const creditRows = async (bookingId: string) =>
  db.query<{ amount: string; reason: string; note: string; staff_id: string | null }>(
    'SELECT amount::text AS amount, reason, note, staff_id FROM store_credit_transactions WHERE booking_id = $1 ORDER BY created_at, id',
    [bookingId]
  )
const giftRows = async (bookingId: string) =>
  db.query<{ amount_used: string; order_id: string | null }>('SELECT amount_used::text AS amount_used, order_id FROM gift_card_redemptions WHERE booking_id = $1 ORDER BY redeemed_at, id', [bookingId])
const creates = (stripe: FakeStripe) => stripe.calls.filter((call) => call.method === 'paymentIntents.create')

/** Everything as it was before any press: the lapsed seat untouched. */
async function untouched(bookingId: string): Promise<void> {
  expect(await booking(bookingId)).toMatchObject({ status: 'payment_needed', price_paid: '0.00', redemption_source: 'membership_credit' })
  expect(await seat1PayBy(bookingId)).toBe('membership_credit')
  expect(await storeCredit()).toBe('10.00')
  expect(await giftCard()).toEqual({ b: '40.00', r: false })
  expect(await creditRows(bookingId)).toEqual([])
  expect(await audits(bookingId)).toEqual([])
  expect(await flows(bookingId)).toEqual([])
}

const runReconcile = (stripe: FakeStripe) =>
  reconcile(db, stripe, { actor: { type: 'system', id: null }, requestId: 'w19-reconcile', maxItems: 50, budgetMs: 120_000 })
/** Past the 15-minute window (the replay's clock stands still, Postgres's too). */
const ageFlows = (bookingId: string, minutes = 20) =>
  db.query(`UPDATE pending_reader_payments SET created_at = created_at - make_interval(mins => $2::int) WHERE record_id = $1`, [bookingId, minutes])

describe('Settle with no card money (C1 finishes it: one transaction, Q36: no order)', () => {
  it('cash: confirmed, seat 1 paid, credit released, booking.settle written; nothing else', async () => {
    await onALapsedSeat(async ({ bookingId }) => {
      const answer = await post(bookingId, { payment: { method: 'cash', confirmedCashAmount: 20 }, ...figures(20, 20) })
      expect(answer.status).toBe(200)
      expect(answer.body.data).toEqual({
        settled: true,
        booking: { id: bookingId, status: 'confirmed', redemption_source: 'paid', price_paid: '20.00', payment_due_by: null },
        amountCharged: 20,
      })
      expect(await booking(bookingId)).toMatchObject({ status: 'confirmed', price_paid: '20.00', redemption_source: 'paid', credit_period_id: null, payment_due_by: null })
      expect(await seat1PayBy(bookingId)).toBe('paid')
      expect(await ordersFor(bookingId)).toEqual([])
      expect(await flows(bookingId)).toEqual([])
      expect((await audits(bookingId)).map((row) => row.details)).toEqual([{ amount: 20, storeCredit: 0, giftCard: 0, method: 'cash', toCollect: 20, pendingId: null }])
    })
  })

  it('gift card and store credit covering it all: their rows as today (the gift card row with the booking and no order), no order, no Stripe', async () => {
    await onALapsedSeat(async ({ bookingId, stripe }) => {
      const answer = await post(bookingId, { payment: { storeCredit: { amount: 5 }, giftCard: { giftCardId: ID.giftCard, amount: 15 } }, ...figures(20, 0) })
      expect(answer.body.data).toMatchObject({ settled: true, amountCharged: 20 })
      expect(await creditRows(bookingId)).toEqual([{ amount: '-5.00', reason: 'redemption', note: SETTLE_STORE_CREDIT_NOTE, staff_id: ID.staff }])
      expect(await storeCredit()).toBe('5.00')
      expect(await giftCard()).toEqual({ b: '25.00', r: false })
      expect(await giftRows(bookingId)).toEqual([{ amount_used: '15.00', order_id: null }])
      expect(await ordersFor(bookingId)).toEqual([])
      expect(stripe.calls).toEqual([])
    })
  })

  it("a gift card used up is stamped redeemed, as New Order's claim does", async () => {
    await onALapsedSeat(async ({ bookingId }) => {
      await db.query('UPDATE gift_cards SET remaining_balance = 20 WHERE id = $1', [ID.giftCard])
      expect((await post(bookingId, { payment: { giftCard: { giftCardId: ID.giftCard, amount: 20 } }, ...figures(20, 0) })).body.data).toMatchObject({ settled: true })
      expect(await giftCard()).toEqual({ b: '0.00', r: true })
    })
  })

  it('the same key twice: one settle, one audit row (the stored answer)', async () => {
    await onALapsedSeat(async ({ bookingId }) => {
      const key = crypto.randomUUID()
      const body = { payment: { method: 'cash', confirmedCashAmount: 20 }, ...figures(20, 20) }
      const first = await post(bookingId, body, { key })
      const second = await post(bookingId, body, { key })
      expect(second.body.data).toEqual(first.body.data)
      expect(await audits(bookingId)).toHaveLength(1)
    })
  })

  it('R4-style: a fault after the store credit claim inside C1 keeps nothing (one transaction), and says so plainly', async () => {
    await onALapsedSeat(async ({ bookingId }) => {
      const answer = await whileFailing(db, { table: 'audit_log', event: 'INSERT', when: "NEW.action = 'booking.settle'" }, () =>
        post(bookingId, { payment: { storeCredit: { amount: 5 }, giftCard: { giftCardId: ID.giftCard, amount: 15 } }, ...figures(20, 0) })
      )
      expect(answer.status).toBe(500)
      expect(answer.body.error?.details).toMatchObject({ reason: 'settle_not_saved', action: 'settle' })
      await untouched(bookingId)
    })
  })
})

describe('refusals, in the old order, with nothing written', () => {
  const refused = (answer: Answer) => ({ status: answer.status, reason: answer.body.error?.details?.reason, message: answer.body.error?.message, amountDue: answer.body.error?.details?.amountDue })

  it('no such booking; not awaiting payment; seat 1 with no price', async () => {
    await onALapsedSeat(async ({ bookingId }) => {
      expect(refused(await post(crypto.randomUUID(), { payment: { method: 'cash', confirmedCashAmount: 20 } }))).toMatchObject({ status: 404, reason: 'booking_not_found', message: SETTLE_REASON_WORDS['booking_not_found'] })
      await db.query("UPDATE booking_guests SET unit_price = NULL WHERE booking_id = $1", [bookingId])
      expect(refused(await post(bookingId, { payment: { method: 'cash', confirmedCashAmount: 20 } }))).toMatchObject({ status: 409, reason: 'seat_price_missing' })
      await db.query("UPDATE booking_guests SET unit_price = 20 WHERE booking_id = $1", [bookingId])
      await db.query("UPDATE bookings SET status = 'confirmed' WHERE id = $1", [bookingId])
      expect(refused(await post(bookingId, { payment: { method: 'cash', confirmedCashAmount: 20 } }))).toMatchObject({ status: 409, reason: 'booking_not_payment_needed', message: SETTLE_REASON_WORDS['booking_not_payment_needed'] })
    })
  })

  it('Q18: the cash figure, the card figure and the amount due, each refused over half a penny with the new figure (Q11 words); half a penny passes', async () => {
    await onALapsedSeat(async ({ bookingId, stripe }) => {
      expect(refused(await post(bookingId, { payment: { method: 'cash', confirmedCashAmount: 19.99 }, ...figures(20, 19.99) }))).toEqual({
        status: 409,
        reason: 'cash_amount_changed',
        message: 'The amount due has changed to £20.00. Check it with the customer and confirm again.',
        amountDue: 20,
      })
      expect(refused(await post(bookingId, { payment: { method: 'card' }, ...figures(20, 20.01) }))).toEqual({
        status: 409,
        reason: 'amount_changed',
        message: 'The amount due has changed to £20.00. Check it with the customer and confirm again.',
        amountDue: 20,
      })
      expect(refused(await post(bookingId, { payment: { method: 'reader' }, ...figures(19.99, 20) }))).toMatchObject({ reason: 'amount_changed', amountDue: 20 })
      // No figure at all for the card counts as nothing confirmed.
      expect(refused(await post(bookingId, { payment: { method: 'card' } }))).toMatchObject({ reason: 'amount_changed' })
      expect(stripe.calls).toEqual([])
      await untouched(bookingId)
      expect((await post(bookingId, { payment: { method: 'cash', confirmedCashAmount: 20.004 }, ...figures(20.004, 20.004) })).body.data).toMatchObject({ settled: true })
    })
  })

  it('the money checks: over the amount, no method, the reader with nothing to take, an unknown method, store credit short, bad amounts', async () => {
    await onALapsedSeat(async ({ bookingId, stripe }) => {
      expect(refused(await post(bookingId, { payment: { method: 'cash', giftCard: { giftCardId: ID.giftCard, amount: 25 } }, ...figures(20, 0) }))).toMatchObject({ reason: 'gift_card_amount_exceeds_total', amountDue: 20 })
      expect(refused(await post(bookingId, { payment: { storeCredit: { amount: 10 }, giftCard: { giftCardId: ID.giftCard, amount: 15 } }, ...figures(20, 0) }))).toMatchObject({ reason: 'store_credit_amount_exceeds_total' })
      expect(refused(await post(bookingId, { payment: { storeCredit: { amount: 5 } }, ...figures(20, 15) }))).toMatchObject({ reason: 'payment_method_required', message: SETTLE_REASON_WORDS['payment_method_required'] })
      expect(refused(await post(bookingId, { payment: { method: 'reader', storeCredit: { amount: 10 }, giftCard: { giftCardId: ID.giftCard, amount: 10 } }, ...figures(20, 0) }))).toMatchObject({ reason: 'payment_method_required', message: AMOUNT_CHANGED_MESSAGE })
      expect(refused(await post(bookingId, { payment: { method: 'cheque' }, ...figures(20, 20) }))).toMatchObject({ status: 400, reason: 'invalid_payment_method', message: ORDER_WORDS['invalid_payment_method'] })
      expect(refused(await post(bookingId, { payment: { method: 'cash', confirmedCashAmount: 5, storeCredit: { amount: 15 } }, ...figures(20, 5) }))).toMatchObject({ reason: 'store_credit_insufficient_or_invalid' })
      expect(refused(await post(bookingId, { payment: { method: 'cash', confirmedCashAmount: 25, giftCard: { giftCardId: ID.giftCard, amount: -5 } }, ...figures(20, 25) }))).toMatchObject({ reason: 'gift_card_amount_invalid' })
      expect(refused(await post(bookingId, { payment: { method: 'cash', confirmedCashAmount: 19.995, storeCredit: { amount: 0.005 } }, ...figures(20, 19.995) }))).toMatchObject({ reason: 'store_credit_amount_invalid' })
      expect(stripe.calls).toEqual([])
      await untouched(bookingId)
    })
  })

  it("gift cards: New Order's words for voided, expired, not found and used up; the store credit claimed before it goes back", async () => {
    await onALapsedSeat(async ({ bookingId }) => {
      const body = (giftCardId: string) => ({ payment: { method: 'cash', confirmedCashAmount: 5, storeCredit: { amount: 5 }, giftCard: { giftCardId, amount: 10 } }, ...figures(20, 5) })
      await db.query('UPDATE gift_cards SET voided = true WHERE id = $1', [ID.giftCard])
      expect(refused(await post(bookingId, body(ID.giftCard)))).toMatchObject({ reason: 'gift_card_insufficient_or_invalid', message: ORDER_WORDS['gift_card_voided'] })
      await db.query("UPDATE gift_cards SET voided = false, expiry_date = '2020-01-01' WHERE id = $1", [ID.giftCard])
      expect(refused(await post(bookingId, body(ID.giftCard)))).toMatchObject({ reason: 'gift_card_insufficient_or_invalid', message: ORDER_WORDS['gift_card_expired'] })
      await db.query("UPDATE gift_cards SET expiry_date = '2030-01-01', remaining_balance = 0 WHERE id = $1", [ID.giftCard])
      expect(refused(await post(bookingId, body(ID.giftCard)))).toMatchObject({ reason: 'gift_card_insufficient_or_invalid', message: ORDER_WORDS['gift_card_insufficient_or_invalid'] })
      expect(refused(await post(bookingId, body(crypto.randomUUID())))).toMatchObject({ reason: 'gift_card_insufficient_or_invalid', message: ORDER_WORDS['gift_card_not_found'] })
      await db.query('UPDATE gift_cards SET remaining_balance = 40 WHERE id = $1', [ID.giftCard])
      await untouched(bookingId)
    })
  })

  it('a payment still open on the booking: the reader words, or the card words (Resolve now only) when every open flow is a saved-card one', async () => {
    await onALapsedSeat(async ({ bookingId }) => {
      const flow = (method: string) =>
        db.query(
          `INSERT INTO pending_reader_payments (flow, record_id, expected_amount, snapshot, status) VALUES ('settle', $1, 20, $2::jsonb, 'pending')`,
          [bookingId, JSON.stringify({ customer_id: ID.member, description: 'x', method, request_id: 'r' })]
        )
      await flow('card')
      expect(refused(await post(bookingId, { payment: { method: 'cash', confirmedCashAmount: 20 }, ...figures(20, 20) }))).toMatchObject({ reason: 'card_payment_open', message: CARD_PAYMENT_OPEN_MESSAGE })
      await flow('reader')
      expect(refused(await post(bookingId, { payment: { method: 'cash', confirmedCashAmount: 20 }, ...figures(20, 20) }))).toMatchObject({ reason: 'reader_payment_open', message: READER_PAYMENT_OPEN_MESSAGE })
      expect(await booking(bookingId)).toMatchObject({ status: 'payment_needed' })
    })
  })

  it('the switch: off answers BOOKING_PATH_OFF before anything is read; the card needs saved_card, the reader reader_flows and reader', async () => {
    await onALapsedSeat(async ({ bookingId }) => {
      const off = async (body: unknown, orderSwitch: string) => (await post(bookingId, body, { orderSwitch })).body.error
      expect(await off({ payment: { method: 'cash', confirmedCashAmount: 20 } }, 'no_stripe,saved_card,reader,membership')).toMatchObject({ code: 'BOOKING_PATH_OFF', message: BOOKING_PATH_OFF_MESSAGE })
      expect(await off(onCard(), 'booking_changes,reader_flows,reader')).toMatchObject({ code: 'BOOKING_PATH_OFF', details: { kinds: ['saved_card'] } })
      expect(await off({ payment: { method: 'reader' }, ...figures(20, 20) }, 'booking_changes,saved_card,reader')).toMatchObject({ code: 'BOOKING_PATH_OFF', details: { kinds: ['reader_flows'] } })
      expect(await off({ payment: { method: 'reader' }, ...figures(20, 20) }, 'booking_changes,saved_card,reader_flows')).toMatchObject({ code: 'BOOKING_PATH_OFF', details: { kinds: ['reader'] } })
      await untouched(bookingId)
    })
  })

  it('the card with no saved card: the legacy route\'s words, nothing claimed', async () => {
    await onALapsedSeat(async ({ bookingId, stripe }) => {
      await db.query('UPDATE customers SET saved_payment_method_id = NULL WHERE id = $1', [ID.member])
      expect(refused(await post(bookingId, onCard({ storeCredit: { amount: 5 } })))).toMatchObject({ status: 409, reason: 'no_saved_card', message: NO_SAVED_CARD_MESSAGE })
      expect(stripe.calls).toEqual([])
      await untouched(bookingId)
    })
  })

  it("C1 meets a deadlock: it runs once more (T1's rule, W17 review S2)", async () => {
    await onALapsedSeat(async ({ bookingId }) => {
      let first = true
      const flaky = Object.create(db) as Db
      flaky.transaction = ((work: Parameters<Db['transaction']>[0]) => {
        if (first) {
          first = false
          return Promise.reject(new DbTimeoutError('The database took too long to respond.', '40P01: deadlock detected'))
        }
        return db.transaction(work)
      }) as Db['transaction']
      const answer = await settleBooking(flaky, bookingId, { payment: { method: 'cash', confirmedCashAmount: 20 }, ...figures(20, 20) }, { actor: { type: 'staff', id: ID.staff }, requestId: 'w19-deadlock' })
      expect(answer).toMatchObject({ settled: true })
      expect(first).toBe(false)
    })
  })
})

describe('the saved card (pending first, keyed from the record, C2 or the undo)', () => {
  it('paid: the record written before the charge, the charge keyed `<pendingId>:charge` with the record in its metadata, C2 records the card part as today', async () => {
    await onALapsedSeat(async ({ bookingId, stripe }) => {
      const answer = await post(bookingId, onCard({ storeCredit: { amount: 5 } }))
      expect(answer.body.data).toEqual({
        settled: true,
        booking: { id: bookingId, status: 'confirmed', redemption_source: 'paid', price_paid: '20.00', payment_due_by: null },
        amountCharged: 20,
      })
      const [flow] = await flows(bookingId)
      if (!flow) throw new Error('no flow record')
      expect(flow).toMatchObject({ status: 'finalised', expected_amount: '15.00' })
      expect(flow.snapshot).toMatchObject({ method: 'card', channel: 'staff', stripe_customer_id: 'cus_member', payment_method_id: 'pm_member', livemode: false, store_credit_amount: 5, old_status: 'payment_needed' })
      expect(typeof flow.snapshot.request_id).toBe('string')
      const [charge] = creates(stripe)
      expect(charge?.idempotencyKey).toBe(flowChargeKey(flow.id))
      expect(charge?.params).toMatchObject({ amount: 1500, customer: 'cus_member', payment_method: 'pm_member', off_session: true, confirm: true, description: settleDescription(bookingId), metadata: { flow: 'settle', record_id: bookingId, pending_id: flow.id } })
      expect(flow.payment_intent_id).toBe((await ordersFor(bookingId))[0]?.stripe_payment_intent_id)
      expect(await ordersFor(bookingId)).toEqual([expect.objectContaining({ order_total: '15.00', payment_method: 'card' })])
      expect((await audits(bookingId))[0]?.details).toMatchObject({ amount: 20, storeCredit: 5, method: 'card', toCollect: 15, pendingId: flow.id })
    })
  })

  it('declined, then pressed again: undone in one transaction (store credit back), and the retry is a new record with a new key that pays', async () => {
    await onALapsedSeat(async ({ bookingId, stripe }) => {
      stripe.failNext('paymentIntents.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
      const declined = await post(bookingId, onCard({ storeCredit: { amount: 5 } }))
      expect(declined.status).toBe(402)
      expect(declined.body.error).toMatchObject({ code: 'PAYMENT_FAILED', message: 'Failed to charge saved card: Your card was declined.', details: { reason: 'card_declined' } })
      expect(await booking(bookingId)).toMatchObject({ status: 'payment_needed', price_paid: '0.00', redemption_source: 'membership_credit' })
      expect(await seat1PayBy(bookingId)).toBe('membership_credit')
      expect(await storeCredit()).toBe('10.00')
      const paid = await post(bookingId, onCard({ storeCredit: { amount: 5 } }))
      expect(paid.body.data).toMatchObject({ settled: true })
      // The replay's clock stands still for the Worker's statements, so the two records may share a created_at.
      const records = await flows(bookingId)
      const cancelled = records.find((row) => row.status === 'cancelled')
      const finalised = records.find((row) => row.status === 'finalised')
      expect(records).toHaveLength(2)
      expect(creates(stripe).map((call) => call.idempotencyKey)).toEqual([flowChargeKey(cancelled?.id ?? ''), flowChargeKey(finalised?.id ?? '')])
      expect(await storeCredit()).toBe('5.00')
      expect(await ordersFor(bookingId)).toHaveLength(1)
    })
  })

  it('authentication needed: PAYMENT_NEEDS_AUTHENTICATION with the old words, undone', async () => {
    await onALapsedSeat(async ({ bookingId, stripe }) => {
      stripe.failNext('paymentIntents.create', { kind: 'error', error: fakeStripeErrors.authenticationRequired() })
      const answer = await post(bookingId, onCard())
      expect(answer.body.error).toMatchObject({ code: 'PAYMENT_NEEDS_AUTHENTICATION', details: { reason: 'card_needs_authentication' } })
      expect(await booking(bookingId)).toMatchObject({ status: 'payment_needed' })
    })
  })

  it('no clear answer: held with Q35\'s words, never undone; reconcile finds the payment by `metadata.pending_id` and finishes it, sending no charge', async () => {
    await onALapsedSeat(async ({ bookingId, stripe }) => {
      stripe.failNext('paymentIntents.create', { kind: 'lost_response' })
      stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
      const held = await post(bookingId, onCard())
      expect(held.status).toBe(502)
      expect(held.body.error).toMatchObject({ code: 'PAYMENT_UNCONFIRMED', message: CHANGE_PAYMENT_UNCONFIRMED_MESSAGE, details: { reason: 'payment_unconfirmed' } })
      expect(await booking(bookingId)).toMatchObject({ status: 'confirmed', price_paid: '20.00' })
      // The stuck list shows it with the card words; then reconcile, past the window.
      await ageFlows(bookingId)
      const listed = (await stuckList(db)).flows.find((item) => item.recordId === bookingId)
      expect(listed).toMatchObject({ reason: 'waiting', words: CARD_FLOW_WAITING_WORDS })
      const sent = creates(stripe).length
      const run = await runReconcile(stripe)
      expect(run.items.find((item) => item.kind === 'flow')).toMatchObject({ outcome: 'finalised' })
      expect(creates(stripe)).toHaveLength(sent)
      expect(stripe.calls.at(-1)?.method).not.toBe('paymentIntents.create')
      expect(await ordersFor(bookingId)).toHaveLength(1)
      expect((await flows(bookingId))[0]?.status).toBe('finalised')
    })
  })

  it('no clear answer, and nothing reached Stripe: reconcile finds none past the window and undoes it (store credit back)', async () => {
    await onALapsedSeat(async ({ bookingId, stripe }) => {
      stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
      stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
      expect((await post(bookingId, onCard({ storeCredit: { amount: 5 } }))).body.error).toMatchObject({ code: 'PAYMENT_UNCONFIRMED' })
      expect(await storeCredit()).toBe('5.00')
      // Inside the window, reconcile leaves it.
      expect((await runReconcile(stripe)).items).toEqual([])
      await ageFlows(bookingId)
      const run = await runReconcile(stripe)
      expect(run.items.find((item) => item.kind === 'flow')).toMatchObject({ outcome: 'undone' })
      expect(await booking(bookingId)).toMatchObject({ status: 'payment_needed', price_paid: '0.00' })
      expect(await storeCredit()).toBe('10.00')
      expect(creates(stripe)).toHaveLength(2)
    })
  })

  it('reconcile: a payment for the record still processing is left held, nothing sent', async () => {
    await onALapsedSeat(async ({ bookingId, stripe }) => {
      holder.crash = 'after_c1'
      expect((await post(bookingId, onCard())).status).toBe(500)
      holder.crash = null
      const [flow] = await flows(bookingId)
      if (!flow) throw new Error('no flow')
      const processing = await stripe.paymentIntents.create({ amount: 2000, currency: 'gbp', customer: 'cus_member', metadata: { pending_id: flow.id } })
      stripe.markProcessing(processing.id)
      await ageFlows(bookingId)
      const sent = creates(stripe).length
      expect((await runReconcile(stripe)).items).toEqual([expect.objectContaining({ kind: 'flow', outcome: 'left', reason: 'payment_processing' })])
      expect((await stuckList(db)).flows.find((item) => item.pendingId === flow.id)).toMatchObject({ reason: 'payment_processing' })
      expect(creates(stripe)).toHaveLength(sent)
      expect(await booking(bookingId)).toMatchObject({ status: 'confirmed' })
    })
  })

  it('reconcile: a declined payment for the record (requires_payment_method) means nothing was taken: undone', async () => {
    await onALapsedSeat(async ({ bookingId, stripe }) => {
      holder.crash = 'after_c1'
      expect((await post(bookingId, onCard({ storeCredit: { amount: 5 } }))).status).toBe(500)
      holder.crash = null
      const [flow] = await flows(bookingId)
      if (!flow) throw new Error('no flow')
      const declined = await stripe.paymentIntents.create({ amount: 1500, currency: 'gbp', customer: 'cus_member', metadata: { pending_id: flow.id } })
      expect(declined.status).toBe('requires_payment_method')
      await ageFlows(bookingId)
      expect((await runReconcile(stripe)).items).toEqual([expect.objectContaining({ kind: 'flow', outcome: 'undone' })])
      expect(await booking(bookingId)).toMatchObject({ status: 'payment_needed' })
      expect(await storeCredit()).toBe('10.00')
    })
  })

  it('crash after C1 (nothing sent): reconcile finds no payment and undoes it', async () => {
    await onALapsedSeat(async ({ bookingId, stripe }) => {
      holder.crash = 'after_c1'
      expect((await post(bookingId, onCard({ storeCredit: { amount: 5 } }))).status).toBe(500)
      holder.crash = null
      expect(await booking(bookingId)).toMatchObject({ status: 'confirmed' })
      expect(creates(stripe)).toHaveLength(0)
      await ageFlows(bookingId)
      expect((await runReconcile(stripe)).items.find((item) => item.kind === 'flow')).toMatchObject({ outcome: 'undone' })
      expect(await booking(bookingId)).toMatchObject({ status: 'payment_needed' })
      expect(await storeCredit()).toBe('10.00')
      expect(creates(stripe)).toHaveLength(0)
    })
  })

  it('crash after the charge, before C2: reconcile finds the payment and runs C2 (one order, one charge)', async () => {
    await onALapsedSeat(async ({ bookingId, stripe }) => {
      holder.crash = 'after_charge'
      expect((await post(bookingId, onCard())).status).toBe(500)
      holder.crash = null
      expect(creates(stripe)).toHaveLength(1)
      expect(await ordersFor(bookingId)).toEqual([])
      await ageFlows(bookingId)
      expect((await runReconcile(stripe)).items.find((item) => item.kind === 'flow')).toMatchObject({ outcome: 'finalised' })
      expect(await ordersFor(bookingId)).toHaveLength(1)
      expect(creates(stripe)).toHaveLength(1)
      expect(stripe.netPence).toBe(2000 + 0)
    })
  })

  it("C2 fails after the card paid (the gift card's row refused): held, never refunded, its PaymentIntent written on the row; reconcile finishes it", async () => {
    await onALapsedSeat(async ({ bookingId, stripe }) => {
      const answer = await whileFailing(db, giftCardRowFails, () => post(bookingId, onCard({ giftCard: { giftCardId: ID.giftCard, amount: 5 } })))
      expect(answer.body.error).toMatchObject({ code: 'PAYMENT_UNCONFIRMED', message: CARD_FLOW_PAID_NOT_FINISHED_MESSAGE, details: { reason: 'paid_not_finished' } })
      const [flow] = await flows(bookingId)
      expect(flow?.status).toBe('pending')
      expect(flow?.payment_intent_id).toMatch(/^pi_fake_/)
      expect(stripe.refundsSent).toEqual([])
      await ageFlows(bookingId)
      expect((await runReconcile(stripe)).items.find((item) => item.kind === 'flow')).toMatchObject({ outcome: 'finalised' })
      expect(await ordersFor(bookingId)).toHaveLength(1)
      expect(await giftRows(bookingId)).toEqual([{ amount_used: '5.00', order_id: null }])
      expect(stripe.refundsSent).toEqual([])
    })
  })

  it('S1: a record older than the bound sends nothing; it is held with Q35\'s words and reconcile settles it', async () => {
    await onALapsedSeat(async ({ bookingId, stripe }) => {
      holder.crash = 'after_c1'
      await post(bookingId, onCard())
      holder.crash = null
      const [flow] = await flows(bookingId)
      if (!flow) throw new Error('no flow')
      await ageFlows(bookingId, CARD_FLOW_SEND_LIMIT_MINUTES + 1)
      const outcome = await settleCardFlow(db, stripe, flow.id, { actor: { type: 'staff', id: ID.staff }, requestId: 'w19-old' })
      expect(outcome).toMatchObject({ outcome: 'held', reason: 'payment_unconfirmed', message: CHANGE_PAYMENT_UNCONFIRMED_MESSAGE })
      expect(stripe.calls).toEqual([])
      // Just inside the bound, it sends.
      await db.query('UPDATE pending_reader_payments SET created_at = now() - make_interval(mins => $2::int) WHERE id = $1', [flow.id, CARD_FLOW_SEND_LIMIT_MINUTES - 1])
      expect(await settleCardFlow(db, stripe, flow.id, { actor: { type: 'staff', id: ID.staff }, requestId: 'w19-old' })).toMatchObject({ outcome: 'finished' })
      expect(creates(stripe)).toHaveLength(1)
    })
  })

  it("later 2: a second run meets Stripe's 409 key-in-use while the first is in flight: held; reconcile finishes it with the first's payment", async () => {
    await onALapsedSeat(async ({ bookingId, stripe }) => {
      holder.crash = 'after_c1'
      await post(bookingId, onCard())
      holder.crash = null
      const [flow] = await flows(bookingId)
      if (!flow) throw new Error('no flow')
      // The first run's charge took effect and its answer was lost, and that run died.
      stripe.failNext('paymentIntents.create', { kind: 'lost_response' })
      stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
      const row = await readFlow(db, flow.id)
      await chargeCardFlow(stripe, row as Parameters<typeof chargeCardFlow>[1])
      // The second run: Stripe still says the key is in use, twice.
      stripe.forgetIdempotencyKeys()
      stripe.failNext('paymentIntents.create', { kind: 'key_in_use' })
      stripe.failNext('paymentIntents.create', { kind: 'key_in_use' })
      expect(await settleCardFlow(db, stripe, flow.id, { actor: { type: 'staff', id: ID.staff }, requestId: 'w19-second' })).toMatchObject({ outcome: 'held', reason: 'payment_unconfirmed' })
      await ageFlows(bookingId)
      expect((await runReconcile(stripe)).items.find((item) => item.kind === 'flow')).toMatchObject({ outcome: 'finalised' })
      expect(await ordersFor(bookingId)).toHaveLength(1)
      expect([...stripe.chargedByIntent.values()]).toEqual([2000])
    })
  })

  it('later 3: a charge that lands on a card flow already undone is kept for the automatic refund, and reconcile refunds it through to refund_confirmed', async () => {
    await onALapsedSeat(async ({ bookingId, stripe }) => {
      holder.crash = 'after_c1'
      await post(bookingId, onCard())
      holder.crash = null
      const [flow] = await flows(bookingId)
      if (!flow) throw new Error('no flow')
      const row = await readFlow(db, flow.id)
      // The undo wins the race (reconcile, say), then the press's charge answers.
      await undoFlowInTransaction(db, flow.id, { actor: { type: 'system', id: null }, requestId: 'w19-race', why: 'race' })
      const charge = await chargeCardFlow(stripe, row as Parameters<typeof chargeCardFlow>[1])
      if (charge.outcome !== 'answered') throw new Error('not charged')
      expect(await finaliseFlowInTransaction(db, flow.id, charge.paymentIntent, { actor: { type: 'staff', id: ID.staff }, requestId: 'w19-race' })).toEqual({ finalised: false, reason: 'charged_without_record' })
      const run = await runReconcile(stripe)
      expect(run.items).toEqual([expect.objectContaining({ kind: 'refund', id: flow.id, outcome: 'refund_confirmed' })])
      expect(stripe.refundsSent.map((refund) => [refund.payment_intent, refund.amount])).toEqual([[charge.paymentIntent.id, 2000]])
      expect(stripe.netPence).toBe(0)
      expect(await booking(bookingId)).toMatchObject({ status: 'payment_needed' })
    })
  })
})

describe('the reader, pending first (W12-7), finished or cancelled by the flow routes', () => {
  it('the record first, then the intent under `<pendingId>:reader-intent` naming the record; finalise records the payment; the switch never gates finishing', async () => {
    await onALapsedSeat(async ({ bookingId, stripe }) => {
      const answer = await post(bookingId, { payment: { method: 'reader', storeCredit: { amount: 5 } }, ...figures(20, 15) })
      const pending = answer.body.data?.['pendingReaderPayment'] as { pendingId: string; paymentIntentId: string; clientSecret: string; amount: number; flow: string; recordId: string }
      expect(answer.body.data).toMatchObject({ settled: false, pendingReaderPayment: { flow: 'settle', recordId: bookingId, amount: 15 } })
      const [flow] = await flows(bookingId)
      expect(flow).toMatchObject({ id: pending.pendingId, status: 'pending', payment_intent_id: pending.paymentIntentId, expected_amount: '15.00' })
      expect(flow?.snapshot).toMatchObject({ method: 'reader', stripe_customer_id: 'cus_member', livemode: false, store_credit_amount: 5 })
      const [intent] = creates(stripe)
      expect(intent?.idempotencyKey).toBe(flowReaderIntentKey(pending.pendingId))
      expect(intent?.params).toMatchObject({ amount: 1500, customer: 'cus_member', payment_method_types: ['card_present'], metadata: { flow: 'settle', record_id: bookingId, pending_id: pending.pendingId, supabase_customer_id: ID.member } })
      expect(await booking(bookingId)).toMatchObject({ status: 'confirmed' })
      stripe.completeReaderPayment(pending.paymentIntentId, { simulatedReader: true })
      process.env.ORDER_SWITCH = ''
      expect((await flowStep('finalise', pending.pendingId)).data).toMatchObject({ finalised: true, paymentIntentId: pending.paymentIntentId })
      delete process.env.ORDER_SWITCH
      expect(await ordersFor(bookingId)).toEqual([expect.objectContaining({ order_total: '15.00', payment_method: 'reader' })])
    })
  })

  // W19a (W19 review later 2): the stored answer keeps the intent's client secret so a lost answer gets it back; after
  // the pending window pruneClientSecrets takes it out. Through the route, so the endpoint is the one it really stores.
  it("the stored answer's client secret is taken out after 15 minutes, the rest kept", async () => {
    await onALapsedSeat(async ({ bookingId }) => {
      const key = crypto.randomUUID()
      const answer = await post(bookingId, { payment: { method: 'reader' }, ...figures(20, 20) }, { key })
      const pending = answer.body.data?.['pendingReaderPayment'] as Record<string, unknown>
      expect(pending['clientSecret']).toEqual(expect.any(String))
      const stored = () =>
        db.query<{ endpoint: string; secret: string | null; kept: Record<string, unknown> }>(
          `SELECT endpoint, response #>> '{data,pendingReaderPayment,clientSecret}' AS secret, response #> '{data,pendingReaderPayment}' AS kept
           FROM api_idempotency WHERE key = $1`,
          [key]
        )
      // Inside the window: kept.
      expect(await pruneClientSecrets(db)).toBe(0)
      expect(await stored()).toEqual([{ endpoint: `POST /api/v1/staff/bookings/${bookingId}/settle`, secret: pending['clientSecret'], kept: pending }])
      await db.query(`UPDATE api_idempotency SET created_at = now() - make_interval(mins => $2::int) WHERE key = $1`, [key, CLIENT_SECRET_WINDOW_MINUTES + 1])
      expect(await pruneClientSecrets(db)).toBe(1)
      const rest = Object.fromEntries(Object.entries(pending).filter(([field]) => field !== 'clientSecret'))
      expect(await stored()).toEqual([{ endpoint: `POST /api/v1/staff/bookings/${bookingId}/settle`, secret: null, kept: rest }])
    })
  })

  it('cancelled on the reader: the intent cancelled, the settle undone (store credit back)', async () => {
    await onALapsedSeat(async ({ bookingId }) => {
      const answer = await post(bookingId, { payment: { method: 'reader', storeCredit: { amount: 5 } }, ...figures(20, 15) })
      const pending = answer.body.data?.['pendingReaderPayment'] as { pendingId: string }
      expect((await flowStep('cancel', pending.pendingId)).data).toMatchObject({ cancelled: true })
      expect(await booking(bookingId)).toMatchObject({ status: 'payment_needed', price_paid: '0.00' })
      expect(await storeCredit()).toBe('10.00')
    })
  })

  it("Stripe refuses the intent: the settle undone at once, the old words; no clear answer: held with the reader's words, and reconcile undoes it", async () => {
    await onALapsedSeat(async ({ bookingId, stripe }) => {
      stripe.failNext('paymentIntents.create', { kind: 'error', error: fakeStripeErrors.invalid('parameter_invalid', 'Bad request') })
      const refused = await post(bookingId, { payment: { method: 'reader' }, ...figures(20, 20) })
      expect(refused.body.error).toMatchObject({ code: 'PAYMENT_FAILED', message: settleReaderNotStartedMessage('Failed to create PaymentIntent: Bad request'), details: { reason: 'settle_undo_failed' } })
      expect(await booking(bookingId)).toMatchObject({ status: 'payment_needed' })
      stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
      stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
      const held = await post(bookingId, { payment: { method: 'reader' }, ...figures(20, 20) })
      expect(held.body.error).toMatchObject({ code: 'PAYMENT_UNCONFIRMED', message: FLOW_INTENT_UNCONFIRMED_MESSAGE })
      await ageFlows(bookingId)
      expect((await runReconcile(stripe)).items.find((item) => item.kind === 'flow')).toMatchObject({ outcome: 'undone' })
      expect(await booking(bookingId)).toMatchObject({ status: 'payment_needed' })
    })
  })

  // W19a (W19 review later 3): Stripe refuses the intent and the undo then fails (a database fault): the words don't
  // say the settle was undone. The booking stays confirmed with its flow pending; reconcile puts it back.
  it("Stripe refuses the intent and the undo fails: words that don't say it was undone; reconcile undoes it", async () => {
    await onALapsedSeat(async ({ bookingId, stripe }) => {
      stripe.failNext('paymentIntents.create', { kind: 'error', error: fakeStripeErrors.invalid('parameter_invalid', 'Bad request') })
      const refused = await whileFailing(db, { table: 'audit_log', event: 'INSERT', when: "NEW.action = 'reader_payment.cancel'" }, () =>
        post(bookingId, { payment: { method: 'reader' }, ...figures(20, 20) })
      )
      const words = settleReaderNotStartedNotUndoneMessage('Failed to create PaymentIntent: Bad request')
      expect(words).toBe(`Creating the card reader payment failed (Failed to create PaymentIntent: Bad request). ${DECLINED_NOT_UNDONE_MESSAGE}`)
      expect(words).not.toContain('undone')
      expect(refused.body.error).toMatchObject({ code: 'PAYMENT_FAILED', message: words, details: { reason: 'settle_undo_failed' } })
      expect(await booking(bookingId)).toMatchObject({ status: 'confirmed' })
      expect(await flows(bookingId)).toEqual([expect.objectContaining({ status: 'pending', payment_intent_id: null })])
      await ageFlows(bookingId)
      expect((await runReconcile(stripe)).items.find((item) => item.kind === 'flow')).toMatchObject({ outcome: 'undone' })
      expect(await booking(bookingId)).toMatchObject({ status: 'payment_needed' })
      expect(stripe.netPence).toBe(0)
    })
  })

  it("W12 F2: a payment made for another Stripe customer isn't finalised", async () => {
    await onALapsedSeat(async ({ bookingId, stripe }) => {
      const answer = await post(bookingId, { payment: { method: 'reader' }, ...figures(20, 20) })
      const pending = answer.body.data?.['pendingReaderPayment'] as { pendingId: string; paymentIntentId: string }
      stripe.addCustomer('cus_other')
      const other = await stripe.paymentIntents.create({ amount: 2000, currency: 'gbp', customer: 'cus_other', payment_method_types: ['card_present'], metadata: { flow: 'settle', record_id: bookingId, pending_id: pending.pendingId } })
      stripe.completeReaderPayment(other.id)
      await db.query('UPDATE pending_reader_payments SET payment_intent_id = $2 WHERE id = $1', [pending.pendingId, other.id])
      expect((await flowStep('finalise', pending.pendingId)).data).toMatchObject({ finalised: false, reason: 'customer_mismatch', message: flowCustomerMismatchMessage(other.id) })
      expect(await ordersFor(bookingId)).toEqual([])
      expect((await flows(bookingId))[0]?.status).toBe('pending')
    })
  })
})

describe("a held card flow is the Worker's to settle (brief W19 item 5; W25: the old sweep is gone)", () => {
  it("a held Worker card flow is listed as waiting, with the card words, and reconcile checks it", async () => {
    await onALapsedSeat(async ({ bookingId, stripe }) => {
      holder.crash = 'after_c1'
      await post(bookingId, onCard())
      holder.crash = null
      await ageFlows(bookingId)
      const listed = (await stuckList(db)).flows.find((item) => item.recordId === bookingId)
      expect(listed).toMatchObject({ reason: 'waiting', words: CARD_FLOW_WAITING_WORDS })
      expect((await runReconcile(stripe)).checked).toBe(1)
    })
  })

  it("the staff app's stuck list shows a held Worker card flow once, with the Worker's words (W17 \"For W19\" 1)", async () => {
    await onALapsedSeat(async ({ bookingId }) => {
      holder.crash = 'after_c1'
      await post(bookingId, onCard())
      holder.crash = null
      await ageFlows(bookingId)
      const [flow] = await flows(bookingId)
      const staffApp = (name: string) => import(/* @vite-ignore */ path.join(staffAppDir(), 'backend/paddock', `${name}.ts`)) as Promise<{ default: (req: { params: unknown; user: { email: string } }) => Promise<unknown> }>
      expect((await flows(bookingId))[0]).toMatchObject({ status: 'pending' })
      const listed = (await (await staffApp('getStuckReaderPayments')).default({ params: { olderThanMinutes: 15 }, user: REPLAY_USER })) as { flows: Array<{ pendingId: string; reason: string; words: string }> }
      expect(listed.flows.filter((item) => item.pendingId === flow?.id)).toEqual([expect.objectContaining({ reason: 'waiting', words: CARD_FLOW_WAITING_WORDS })])
    })
  })
})
