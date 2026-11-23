import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { GET as figuresRoute } from '@/app/api/v1/staff/orders/[orderId]/refund-figures/route'
import { POST as refundRoute } from '@/app/api/v1/staff/orders/[orderId]/refunds/route'
import { POST as owedRoute } from '@/app/api/v1/staff/orders/[orderId]/refunds/owed/route'
import { POST as arrivedRoute } from '@/app/api/v1/staff/orders/[orderId]/refunds/owed-arrived/route'
import { POST as bookingRefundRoute } from '@/app/api/v1/staff/bookings/[bookingId]/refunds/route'
import { GET as bookingFiguresRoute } from '@/app/api/v1/staff/bookings/[bookingId]/refund-figures/route'
import { POST as closeRoute } from '@/app/api/v1/staff/orders/stuck/close/route'
import { POST as moveRoute } from '@/app/api/v1/staff/bookings/[bookingId]/move/route'
import { POST as cancelFlowRoute } from '@/app/api/v1/staff/reader-flows/[pendingId]/cancel/route'
import { POST as finaliseFlowRoute } from '@/app/api/v1/staff/reader-flows/[pendingId]/finalise/route'
import type { Db, Tx } from '@/server/db'
import { reconcile } from '@/server/rules/orders/reconcile'
import { ORDER_CLAIM_WAITING_WORDS, stuckList, WATCH_WORDS } from '@/server/rules/orders/stuck-list'
import { MONEY_OWED_WORDS } from '@/server/rules/refunds/failure-messages'
import { moneyOwedList } from '@/server/rules/refunds/money-owed-list'
import { claimRefundKey } from '@/server/rules/refunds/pipeline'
import { readOrderClaim } from '@/server/rules/refunds/claims'
import {
  ORDER_PAYMENT_REFUND_OPEN_MESSAGE,
  ORDER_REFUND_NEW_WORDS as NEW_WORDS,
  ORDER_REFUND_OPEN_MESSAGE,
  ORDER_REFUND_WORDS as WORDS,
  REFUND_PATH_OFF_MESSAGE,
} from '@/server/rules/refunds/failure-messages'
import { BOOKING_KINDS_ON, throughStaffApp, withSwitch } from '@/server/rules/testing/sweep/booking-presses'
import { replay, REPLAY_USER, startReplay, type ReplayEnvironment, type ScenarioContext } from '@/server/rules/testing/sweep/run'
import { workerSide } from '@/server/rules/testing/sweep/worker'
import { ORDER_REFUND_KINDS_ON } from '@/server/rules/testing/sweep/order-refund-presses'
import { ID, laterPublicSession, paidSeat, seed } from '@/server/rules/testing/replay/scenarios'
import { replayStripe } from '@/server/rules/testing/replay/stripe-binding'
import { fakeStripeErrors, type FakeStripe } from '@/server/stripe/fake'
import { refundOrderLines, type OrderRefundOptions } from './refund-lines'
import { WATCH_DAYS } from '@/server/rules/refunds/refund-watch'

// Brief W28 (E-plan 5.1): order refunds on the Worker, on the replay's live schema (its triggers and the store credit
// function included), through the routes as the staff app calls them. The orders are placed through the Worker's order
// route, as New Order places them (sweep/worker.ts). Stripe is only ever the fake.

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

// The sweep scenarios' baskets (scenarios.ts keeps its own to itself).
const soap = { productVariantId: ID.variant, quantity: 2, unitPrice: 12, systemUnitPrice: 12 }
const mug = { productVariantId: ID.mugVariant, quantity: 1, unitPrice: 15, systemUnitPrice: 15, fulfillmentChoice: 'pickup' }
const towel = { addonId: ID.addon, quantity: 1, unitPrice: 5, systemUnitPrice: 5 }
const digitalCard = { giftCardPresetId: ID.giftCardPreset, fulfillmentMethod: 'digital' }
const newPass = { sessionPassTypeId: ID.passType }
const card = { method: 'card' }
const cash = (amount: number) => ({ method: 'cash', confirmedCashAmount: amount })

type Context = ScenarioContext & { orderId: string; placed: Record<string, unknown>; lines(itemType?: string): Promise<string[]> }

/** An order placed by the old createOrder, then `work` with it. */
async function onAnOrder(order: Record<string, unknown>, work: (context: Context) => Promise<void>, prepare?: (context: ScenarioContext) => Promise<void>): Promise<void> {
  await replay(
    environment,
    {
      name: 'w28 order refunds',
      seed,
      async run(context) {
        replayStripe.current = context.stripe
        await prepare?.(context)
        const placed = (await context.call('createOrder', { customerId: ID.customer, ...order })) as Record<string, unknown>
        if (placed['success'] !== true) throw new Error(`The order failed: ${JSON.stringify(placed)}`)
        const orderId = String(placed['orderId'])
        const lines = async (itemType?: string) =>
          (
            await context.db.query<{ id: string }>('SELECT id FROM order_line_items WHERE order_id = $1::uuid AND ($2::text IS NULL OR item_type = $2::text) ORDER BY created_at, id', [
              orderId,
              itemType ?? null,
            ])
          ).map((row) => row.id)
        try {
          await work({ ...context, orderId, placed, lines })
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
    error?: { code: string; message: string; details?: { reason?: string; message?: string; figures?: Record<string, unknown> & { lines?: Array<Record<string, unknown>> } } }
  }
}

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>
const REFUND_ROUTES: Record<'refunds' | 'refunds/owed' | 'refunds/owed-arrived', Handler> = { refunds: refundRoute as Handler, 'refunds/owed': owedRoute as Handler, 'refunds/owed-arrived': arrivedRoute as Handler }

async function post(path: 'refunds' | 'refunds/owed' | 'refunds/owed-arrived', orderId: string, body: unknown, { key = crypto.randomUUID(), orderSwitch = ORDER_REFUND_KINDS_ON, email = REPLAY_USER.email } = {}): Promise<Answer> {
  return withSwitch(orderSwitch, async () => {
    const response = await REFUND_ROUTES[path](
      new Request(`https://worker.test/api/v1/staff/orders/${orderId}/${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${KEY}`, 'x-staff-email': email, 'idempotency-key': key, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ orderId }) }
    )
    return { status: response.status, body: (await response.json()) as Answer['body'] }
  })
}

async function figures(orderId: string): Promise<Answer> {
  const response = await (figuresRoute as Handler)(
    new Request(`https://worker.test/api/v1/staff/orders/${orderId}/refund-figures`, { headers: { authorization: `Bearer ${KEY}`, 'x-staff-email': REPLAY_USER.email } }),
    { params: Promise.resolve({ orderId }) }
  )
  return { status: response.status, body: (await response.json()) as Answer['body'] }
}

/** The total the dialog shows for the chosen lines, from the Worker's figures. */
async function shown(orderId: string, lineIds: readonly string[]): Promise<number> {
  const lines = ((await figures(orderId)).body.data?.['lines'] ?? []) as Array<{ lineItemId: string; refundable: number }>
  return Math.round(lines.filter((line) => lineIds.includes(line.lineItemId)).reduce((total, line) => total + line.refundable, 0) * 100) / 100
}

/** A refund as the dialog presses it: the figures' total sent back as confirmed, every product line with a restock decision. */
async function refund(orderId: string, lineItemIds: string[], refundMethod: string, { restock = {} as Record<string, boolean>, confirmed = undefined as number | undefined, key = undefined as string | undefined, orderSwitch = undefined as string | undefined } = {}): Promise<Answer> {
  const amount = confirmed ?? (await shown(orderId, lineItemIds))
  return post(
    'refunds',
    orderId,
    { lineItemIds, refundMethod, restock: { ...Object.fromEntries(lineItemIds.map((id) => [id, false])), ...restock }, confirmed: { amount } },
    { ...(key ? { key } : {}), ...(orderSwitch !== undefined ? { orderSwitch } : {}) }
  )
}

async function close(claimId: string): Promise<Answer> {
  const response = await closeRoute(
    new Request('https://worker.test/api/v1/staff/orders/stuck/close', {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'x-staff-email': REPLAY_USER.email, 'idempotency-key': crypto.randomUUID(), 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'held_claim', orderId: claimId, reason: 'Checked in Stripe by hand' }),
    })
  )
  return { status: response.status, body: (await response.json()) as Answer['body'] }
}

const runReconcile = () => reconcile(db, replayStripe.current as FakeStripe, { actor: { type: 'system', id: null }, requestId: crypto.randomUUID(), maxItems: 50, budgetMs: 60_000 })
/** Past the window, so reconcile and the stuck list look at what is held. */
const pastTheWindow = () => vi.setSystemTime(Date.now() + 16 * 60_000)

const order = async (orderId: string) => (await db.query<{ payment_status: string; owed: string }>('SELECT payment_status, refund_owed_amount::text AS owed FROM orders WHERE id = $1', [orderId]))[0]
const lineRows = async (orderId: string) =>
  db.query<{ id: string; item_type: string; refunded: boolean; refund_method: string | null; restocked: boolean | null; card: string }>(
    'SELECT id, item_type, refunded_at IS NOT NULL AS refunded, refund_method, restocked, card_refunded_amount::numeric(10,2)::text AS card FROM order_line_items WHERE order_id = $1 ORDER BY created_at, id',
    [orderId]
  )
const creditRefunds = async () => db.query<{ amount: string; order_id: string | null; note: string }>("SELECT amount::text AS amount, order_id, note FROM store_credit_transactions WHERE reason = 'refund' ORDER BY created_at, id")
const auditRows = async (action: string) => db.query<{ id: string; entity_id: string; details: Record<string, unknown> }>('SELECT id, entity_id, details FROM audit_log WHERE action = $1 ORDER BY at, ctid', [action])
const stock = async (variantId: string) => Number((await db.query<{ stock_quantity: number }>('SELECT stock_quantity FROM product_variants WHERE id = $1', [variantId]))[0]?.stock_quantity)
const refundsSent = (stripe: FakeStripe) => stripe.calls.filter((call) => call.method === 'refunds.create')
const moneyBack = (stripe: FakeStripe) => stripe.refundsSent.filter((sent) => sent.status !== 'failed' && sent.status !== 'canceled').reduce((total, sent) => total + sent.amount, 0)
const declined = () => ({ kind: 'error' as const, error: fakeStripeErrors.cardDeclined() })

describe('the figures and the amount staff confirm (E1, Q18, review L3)', () => {
  it('E1: a £15 mug bought with 10% off shows £13.50, and the refund gives exactly that; the old dialog\'s £15 is refused with the new figures', async () => {
    await onAnOrder({ products: [{ ...soap, quantity: 1 }, mug], promoCode: 'ALLTEN', payment: card }, async ({ orderId, lines, stripe }) => {
      const [, mugLine] = await lines('product')
      const shownFigures = (await figures(orderId)).body.data as { lines: Array<{ lineItemId: string; lineTotal: number; discount: number; refundable: number }>; cardLeft: number; cashLeft: number; refundOwed: number; blocked: unknown }
      expect(shownFigures.lines.find((line) => line.lineItemId === mugLine)).toMatchObject({ lineTotal: 15, discount: 1.5, refundable: 13.5, refunded: false, blocked: null })
      expect(shownFigures).toMatchObject({ cardLeft: 24.3, cashLeft: 0, refundOwed: 0, blocked: null })
      // What the old dialog added up (line_total): refused, nothing moved, the figures to show instead.
      const wrong = await refund(orderId, [mugLine as string], 'card', { confirmed: 15 })
      expect(wrong.status).toBe(409)
      expect(wrong.body.error?.details).toMatchObject({ reason: 'figures_changed', message: NEW_WORDS.figuresChanged })
      expect(wrong.body.error?.details?.figures?.lines?.find((line) => line['lineItemId'] === mugLine)).toMatchObject({ refundable: 13.5 })
      expect(refundsSent(stripe)).toHaveLength(0)
      const right = await refund(orderId, [mugLine as string], 'card')
      expect(right.body.data).toEqual({ refundedAmount: 13.5, refundMethod: 'card', cardRefundedAmount: 13.5, orderPaymentStatus: 'partially_refunded' })
      expect(refundsSent(stripe).map((call) => (call.params as { amount: number }).amount)).toEqual([1350])
    })
  })

  it('review L3: no money moves without `confirmed`: refused with the figures, no claim, no refund, the line untouched', async () => {
    await onAnOrder({ products: [soap], payment: card }, async ({ orderId, lines, stripe }) => {
      const ids = await lines('product')
      const answer = await post('refunds', orderId, { lineItemIds: ids, refundMethod: 'card', restock: { [ids[0] as string]: true } })
      expect(answer.status).toBe(400)
      expect(answer.body.error?.details).toMatchObject({ reason: 'amount_not_confirmed', message: NEW_WORDS.amountNotConfirmed })
      expect(answer.body.error?.details?.figures).toMatchObject({ cardLeft: 24 })
      // The same for store credit, which needs no Stripe call at all.
      expect((await post('refunds', orderId, { lineItemIds: ids, refundMethod: 'credit', restock: { [ids[0] as string]: false } })).body.error?.details?.reason).toBe('amount_not_confirmed')
      expect(await auditRows('order.refund_claimed')).toHaveLength(0)
      expect(refundsSent(stripe)).toHaveLength(0)
      expect(await creditRefunds()).toHaveLength(0)
      expect((await lineRows(orderId))[0]).toMatchObject({ refunded: false, card: '0.00' })
      expect(await stock(ID.variant)).toBe(3)
    })
  })

  it('half a penny either way passes; a penny out is refused', async () => {
    await onAnOrder({ products: [soap], payment: card }, async ({ orderId, lines }) => {
      const ids = await lines('product')
      expect((await refund(orderId, ids, 'credit', { confirmed: 24.01 })).body.error?.details?.reason).toBe('figures_changed')
      expect((await refund(orderId, ids, 'credit', { confirmed: 23.99 })).body.error?.details?.reason).toBe('figures_changed')
      expect((await refund(orderId, ids, 'credit', { confirmed: 24.004 })).body.data).toMatchObject({ refundedAmount: 24, storeCreditRefundedAmount: 24 })
    })
  })
})

describe('refusals the old function kept, and the ones W28 adds', () => {
  it("R1 keeps the old refusal of a booking's line: the one-way hold between a booking's refund and an order's rests on it", async () => {
    await onAnOrder({ products: [soap], booking: paidSeat(), payment: card }, async ({ orderId, lines, stripe }) => {
      const [bookingLine] = await lines('booking')
      const all = await lines()
      for (const chosen of [[bookingLine as string], all]) {
        const answer = await refund(orderId, chosen, 'card', { confirmed: 20 })
        expect(answer.status).toBe(400)
        expect(answer.body.error?.details).toMatchObject({ reason: 'booking_not_supported', message: WORDS.bookingNotSupported })
      }
      // Nothing of the booking's, or beside it, was touched.
      expect(await auditRows('order.refund_claimed')).toHaveLength(0)
      expect(refundsSent(stripe)).toHaveLength(0)
      expect((await lineRows(orderId)).every((line) => !line.refunded)).toBe(true)
      // The figures say so too, so the dialog can't offer the line.
      const shownLines = (await figures(orderId)).body.data?.['lines'] as Array<{ itemType: string; blocked: { reason: string } | null }>
      expect(shownLines.find((line) => line.itemType === 'booking')?.blocked?.reason).toBe('booking_not_supported')
    })
  })

  it('a missing order is refused before the claim writer is reached: `order_not_found`, and no claim is written on an id with no row', async () => {
    await onAnOrder({ products: [soap], payment: card }, async ({ lines }) => {
      const UNKNOWN = '10000000-0000-4000-8000-0000000000e7'
      const answer = await post('refunds', UNKNOWN, { lineItemIds: await lines(), refundMethod: 'card', confirmed: { amount: 24 } })
      expect(answer.status).toBe(404)
      expect(answer.body.error?.details?.reason).toBe('order_not_found')
      expect((await post('refunds/owed', UNKNOWN, { amount: 5, refundMethod: 'credit' })).body.error?.details?.reason).toBe('order_not_found')
      expect((await post('refunds/owed-arrived', UNKNOWN, { amount: 5, reason: 'Seen in Stripe' })).body.error?.details?.reason).toBe('order_not_found')
      expect((await figures(UNKNOWN)).status).toBe(404)
      expect(await auditRows('order.refund_claimed')).toHaveLength(0)
    })
  })

  // W29: the membership line and the payment date change charge are built: their tests are in membership-refund.test.ts.

  it('E2: an order whose reader payment is still open is refused, nothing is given, and the payment can still be finalised; then it refunds', async () => {
    await replay(
      environment,
      {
        name: 'w28 e2',
        seed,
        async run({ call, db: database, stripe }) {
          replayStripe.current = stripe
          try {
            const placed = (await call('createOrder', { customerId: ID.customer, products: [soap], payment: { method: 'reader' } })) as { orderId: string; pendingReaderPayment: { paymentIntentId: string } }
            const line = (await database.query<{ id: string }>('SELECT id FROM order_line_items WHERE order_id = $1', [placed.orderId]))[0]?.id as string
            expect((await figures(placed.orderId)).body.data?.['blocked']).toEqual({ reason: 'order_not_paid', message: NEW_WORDS.orderNotPaid })
            for (const method of ['credit', 'card']) {
              const answer = await refund(placed.orderId, [line], method)
              expect(answer.status).toBe(409)
              expect(answer.body.error?.details).toMatchObject({ reason: 'order_not_paid', message: NEW_WORDS.orderNotPaid })
            }
            expect(await creditRefunds()).toHaveLength(0)
            expect(await order(placed.orderId)).toMatchObject({ payment_status: 'pending' })
            // The customer taps: the order is still pending, so it is finalised as usual (the old refund left it unable to be).
            stripe.completeReaderPayment(placed.pendingReaderPayment.paymentIntentId)
            expect(await call('finaliseReaderOrder', { orderId: placed.orderId })).toMatchObject({ finalised: true })
            expect(await order(placed.orderId)).toMatchObject({ payment_status: 'paid' })
            expect((await refund(placed.orderId, [line], 'card')).body.data).toMatchObject({ refundedAmount: 24, cardRefundedAmount: 24, orderPaymentStatus: 'refunded' })
            // A refunded order: the same lines again are the old `already_refunded`.
            expect((await refund(placed.orderId, [line], 'card', { confirmed: 24 })).body.error?.details?.reason).toBe('already_refunded')
          } finally {
            replayStripe.current = null
          }
        },
      },
      workerSide()
    )
  })

  it('REFUND_PATH_OFF: with `order_refunds` off (today\'s secret) a refund and Refund the rest answer the switched-off words before anything is read; the figures and It already arrived are not gated', async () => {
    await onAnOrder({ products: [soap], payment: card }, async ({ orderId, lines, stripe }) => {
      const ids = await lines('product')
      for (const orderSwitch of ['', BOOKING_KINDS_ON]) {
        const answer = await refund(orderId, ids, 'card', { confirmed: 24, orderSwitch })
        expect(answer.status).toBe(501)
        expect(answer.body.error).toMatchObject({ code: 'REFUND_PATH_OFF', message: REFUND_PATH_OFF_MESSAGE, details: { reason: 'refund_path_off', kinds: ['order_refunds'] } })
        expect((await post('refunds/owed', orderId, { amount: 5, refundMethod: 'credit' }, { orderSwitch })).body.error?.code).toBe('REFUND_PATH_OFF')
        // Not gated: it moves no money. (Nothing is owed here, so it is refused for that.)
        expect((await post('refunds/owed-arrived', orderId, { amount: 5, reason: 'Seen in Stripe' }, { orderSwitch })).body.error?.details?.reason).toBe('nothing_owed')
      }
      expect((await figures(orderId)).status).toBe(200)
      expect(refundsSent(stripe)).toHaveLength(0)
      expect((await lineRows(orderId))[0]?.refunded).toBe(false)
    })
  })

  it('Issue refunds is needed for all three actions, and not for the figures', async () => {
    await onAnOrder({ products: [soap], payment: card }, async ({ orderId, lines, db: database }) => {
      await database.query('UPDATE staff SET can_issue_refunds = false WHERE id = $1', [ID.staff])
      const ids = await lines('product')
      expect((await refund(orderId, ids, 'credit', { confirmed: 24 })).status).toBe(403)
      expect((await post('refunds/owed', orderId, { amount: 5, refundMethod: 'credit' })).status).toBe(403)
      expect((await post('refunds/owed-arrived', orderId, { amount: 5, reason: 'Seen' })).status).toBe(403)
      expect((await figures(orderId)).status).toBe(200)
      expect(await creditRefunds()).toHaveLength(0)
    })
  })
})

describe('E5: a pass is used when a seat was taken with it and not returned', () => {
  /** A pass bought on the card, then a booking paid with one of its sessions. */
  async function passWithABooking(work: (context: Context & { passLine: string; passId: string; bookingId: string }) => Promise<void>): Promise<void> {
    await onAnOrder({ ...newPass, payment: card }, async (context) => {
      const [passLine] = await context.lines('session_pass')
      const passId = (await context.db.query<{ id: string }>('SELECT id FROM customer_session_passes WHERE order_line_item_id = $1', [passLine as string]))[0]?.id as string
      const booked = (await context.call('createOrder', { customerId: ID.customer, booking: { ...paidSeat(), redemptionSource: 'session_pass_credit', sessionPassId: passId }, payment: {} })) as { success: boolean; bookingId: string }
      expect(booked.success).toBe(true)
      await work({ ...context, passLine: passLine as string, passId, bookingId: booked.bookingId })
    })
  }

  it('a pass with a seat taken is refused however its type is edited since (the old test compared with the type today, and refunded £50 in full once the type was edited down)', async () => {
    await passWithABooking(async ({ orderId, passLine, passId, db: database, stripe }) => {
      expect((await database.query<{ sessions_remaining: number }>('SELECT sessions_remaining FROM customer_session_passes WHERE id = $1', [passId]))[0]?.sessions_remaining).toBe(4)
      // The type edited down to what is left: the old test (4 is not below 4) called it unused.
      await database.query('UPDATE session_pass_types SET sessions_included = 4 WHERE id = $1', [ID.passType])
      const sentBefore = refundsSent(stripe).length
      const answer = await refund(orderId, [passLine], 'card', { confirmed: 50 })
      expect(answer.status).toBe(409)
      // The words count what the pass really held: 4 left of the 5 it has had (4 left and 1 taken).
      expect(answer.body.error?.details).toMatchObject({ reason: 'session_pass_already_used', message: WORDS.passUsed(passLine, 4, 5) })
      expect(((await figures(orderId)).body.data?.['lines'] as Array<{ blocked: { reason: string } | null }>)[0]?.blocked?.reason).toBe('session_pass_already_used')
      expect(refundsSent(stripe)).toHaveLength(sentBefore)
      expect((await database.query<{ sessions_remaining: number }>('SELECT sessions_remaining FROM customer_session_passes WHERE id = $1', [passId]))[0]?.sessions_remaining).toBe(4)
    })
  })

  it('once the booking is cancelled with its credit returned, the seat is no longer taken and the pass refunds (emptied); an unused pass refunds however its type is edited up', async () => {
    await passWithABooking(async ({ orderId, passLine, passId, bookingId, db: database }) => {
      const cancelled = (await withSwitch(BOOKING_KINDS_ON, () => throughStaffApp('cancelCreditBooking')(database, { bookingId, confirmed: { addonsRefund: 0 }, idempotencyKey: crypto.randomUUID() }))) as { cancelled?: boolean }
      expect(cancelled.cancelled).toBe(true)
      expect((await database.query<{ sessions_remaining: number }>('SELECT sessions_remaining FROM customer_session_passes WHERE id = $1', [passId]))[0]?.sessions_remaining).toBe(5)
      // The type edited up: the old test (5 is below 10) called this unused pass used.
      await database.query('UPDATE session_pass_types SET sessions_included = 10 WHERE id = $1', [ID.passType])
      expect((await refund(orderId, [passLine], 'card')).body.data).toMatchObject({ refundedAmount: 50, cardRefundedAmount: 50, orderPaymentStatus: 'refunded' })
      expect((await database.query<{ sessions_remaining: number }>('SELECT sessions_remaining FROM customer_session_passes WHERE id = $1', [passId]))[0]?.sessions_remaining).toBe(0)
    })
  })

  it('a booking cancelled with nothing back kept its session: the pass stays used', async () => {
    await passWithABooking(async ({ orderId, passLine, bookingId, db: database }) => {
      // Cancelled with no credit returned (as a cancel inside 24 hours leaves it): the booking still names the pass.
      await database.query("UPDATE bookings SET status = 'cancelled', cancelled_at = now() WHERE id = $1", [bookingId])
      expect((await refund(orderId, [passLine], 'card', { confirmed: 50 })).body.error?.details?.reason).toBe('session_pass_already_used')
    })
  })

  // W28a (review S1). The pass ends on 15 Nov, so a Move to the 20 Nov session releases its seat: £20 on the reader.
  // While the reader waits, the booking names no pass and the session hasn't come back (4 left): the old rule read
  // that as an unused pass and refunded the £50 in full.
  it('review S1: a pass booking moved on the simulated reader, pending: the pass refund is refused `session_pass_already_used`; after the tap the pass has its session back and refunds; after the cancel the booking holds its seat again and it stays used', async () => {
    const bookingPost = async (route: Handler, path: string, params: Record<string, string>, body: unknown) =>
      withSwitch(BOOKING_KINDS_ON, async () => {
        const response = await route(
          new Request(`https://worker.test/api/v1/staff/${path}`, {
            method: 'POST',
            headers: { authorization: `Bearer ${KEY}`, 'x-staff-email': REPLAY_USER.email, 'idempotency-key': crypto.randomUUID(), 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
          { params: Promise.resolve(params) }
        )
        return (await response.json()) as { ok: boolean; data?: Record<string, unknown> & { pendingReaderPayment?: { pendingId: string; paymentIntentId: string } } }
      })
    const passLeft = async (passId: string) => (await db.query<{ n: number }>('SELECT sessions_remaining AS n FROM customer_session_passes WHERE id = $1', [passId]))[0]?.n
    const bookingPass = async (bookingId: string) => (await db.query<{ id: string | null }>('SELECT redeemed_session_pass_id AS id FROM bookings WHERE id = $1', [bookingId]))[0]?.id
    const blockedReason = async (orderId: string) => ((await figures(orderId)).body.data?.['lines'] as Array<{ blocked: { reason: string } | null }>)[0]?.blocked?.reason

    for (const ending of ['tap', 'cancel'] as const) {
      await passWithABooking(async ({ orderId, passLine, passId, bookingId, db: database, stripe }) => {
        await laterPublicSession(database)
        await database.query("UPDATE customer_session_passes SET expiry_date = '2026-11-15' WHERE id = $1", [passId])
        const moved = await bookingPost(moveRoute as Handler, `bookings/${bookingId}/move`, { bookingId }, { newSessionId: ID.laterPublicSession, confirmed: true, figures: { amountDue: 20, toCollect: 20 }, payment: { method: 'reader' } })
        const pending = moved.data?.pendingReaderPayment
        expect(moved.data).toMatchObject({ moved: true, pendingReaderPayment: { flow: 'move', amount: 20 } })
        // The window: no booking names the pass, and its session hasn't come back.
        expect([await bookingPass(bookingId), await passLeft(passId)]).toEqual([null, 4])

        const sentBefore = refundsSent(stripe).length
        const answer = await refund(orderId, [passLine], 'card', { confirmed: 50 })
        expect(answer.status).toBe(409)
        expect(answer.body.error?.details).toMatchObject({ reason: 'session_pass_already_used', message: WORDS.passUsed(passLine, 4, 5) })
        expect(await blockedReason(orderId)).toBe('session_pass_already_used')
        expect(refundsSent(stripe)).toHaveLength(sentBefore)
        expect(await passLeft(passId)).toBe(4)
        expect(await order(orderId)).toMatchObject({ payment_status: 'paid', owed: '0.00' })

        if (ending === 'tap') {
          stripe.completeReaderPayment(pending?.paymentIntentId ?? '')
          expect((await bookingPost(finaliseFlowRoute as Handler, `reader-flows/${pending?.pendingId}/finalise`, { pendingId: pending?.pendingId ?? '' }, {})).data).toMatchObject({ finalised: true })
          // The session is back on the pass and the booking is a paid one: nothing is taken with the pass any more.
          expect([await bookingPass(bookingId), await passLeft(passId)]).toEqual([null, 5])
          expect(await blockedReason(orderId)).toBeUndefined()
          expect(await shown(orderId, [passLine])).toBe(50)
          expect((await refund(orderId, [passLine], 'card')).body.data).toMatchObject({ refundedAmount: 50, cardRefundedAmount: 50, orderPaymentStatus: 'refunded' })
          expect(await passLeft(passId)).toBe(0)
        } else {
          expect((await bookingPost(cancelFlowRoute as Handler, `reader-flows/${pending?.pendingId}/cancel`, { pendingId: pending?.pendingId ?? '' }, {})).data).toMatchObject({ cancelled: true })
          // The booking is back on its old session with its pass seat: used, counted once (4 left of 5).
          expect([await bookingPass(bookingId), await passLeft(passId)]).toEqual([passId, 4])
          expect((await refund(orderId, [passLine], 'card', { confirmed: 50 })).body.error?.details).toMatchObject({ reason: 'session_pass_already_used', message: WORDS.passUsed(passLine, 4, 5) })
          expect(refundsSent(stripe)).toHaveLength(sentBefore)
          expect(await passLeft(passId)).toBe(4)
        }
      })
    }
  })
})

describe('the card: refused, undone, blocked, unclear', () => {
  it('refused then undone: every reversal is put back exactly, the refusal is marked, the old words are answered, and the next press goes through once', async () => {
    await onAnOrder({ products: [soap], standaloneAddons: [towel], giftCard: digitalCard, ...newPass, payment: card }, async ({ orderId, lines, stripe, db: database }) => {
      const all = await lines()
      const [product] = await lines('product')
      const before = { lines: await lineRows(orderId), stock: await stock(ID.variant), adjustments: (await database.query('SELECT id FROM stock_adjustments')).length }
      stripe.failNext('refunds.create', declined())
      const refused = await refund(orderId, all, 'card', { restock: { [product as string]: true } })
      expect(refused.status).toBe(402)
      expect(refused.body.error?.details).toMatchObject({ reason: 'refund_failed', message: 'Failed to refund payment: Your card was declined.' })
      // Put back: the lines unstamped, the stock out again with its adjustment row gone, the gift card valid, the pass full.
      expect(await lineRows(orderId)).toEqual(before.lines)
      expect(await stock(ID.variant)).toBe(before.stock)
      expect((await database.query('SELECT id FROM stock_adjustments')).length).toBe(before.adjustments)
      expect((await database.query<{ voided: boolean }>('SELECT voided FROM gift_cards WHERE id IN (SELECT gift_card_id FROM order_line_items WHERE order_id = $1)', [orderId]))[0]?.voided).toBe(false)
      expect((await database.query<{ sessions_remaining: number }>('SELECT sessions_remaining FROM customer_session_passes WHERE order_line_item_id = ANY($1::uuid[])', [all]))[0]?.sessions_remaining).toBe(5)
      expect(await order(orderId)).toEqual({ payment_status: 'paid', owed: '0.00' })
      // Never given as store credit by the system (Wayne, 14 Nov).
      expect(await creditRefunds()).toHaveLength(0)
      const [claim] = await auditRows('order.refund_claimed')
      expect((await auditRows('order.refund_refused'))[0]?.details).toMatchObject({ claimId: claim?.id, orderId, amount: 139, detail: 'Failed to refund payment: Your card was declined.' })
      expect((await auditRows('order.refund_finished'))[0]?.details).toEqual({ claimId: claim?.id, outcome: 'put_back', cardRefunded: 0, storeCreditRefunded: 0, owed: 0 })
      expect(await auditRows('order.refund')).toHaveLength(0)
      expect(moneyBack(stripe)).toBe(0)
      // Staff choose again: a new claim, a new key, one refund.
      const again = await refund(orderId, all, 'card', { restock: { [product as string]: true } })
      expect(again.body.data).toEqual({ refundedAmount: 139, refundMethod: 'card', cardRefundedAmount: 139, orderPaymentStatus: 'refunded' })
      expect(moneyBack(stripe)).toBe(13900)
      expect(await stock(ID.variant)).toBe(before.stock + 2)
      expect((await auditRows('order.refund'))[0]?.details).toMatchObject({ lineItemIds: all, restocked: [product], amount: 139, method: 'card', cardRefunded: 139, storeCreditRefunded: 0, owed: 0 })
    })
  })

  it("W30a (W30 review S1, the same words here), the split case: refused with the undo blocked on a plan with store credit: the £10 of store credit is given once and named in the warning, the £14 is owed, and the words never say nothing went back", async () => {
    await onAnOrder({ products: [soap], payment: { method: 'card', storeCredit: { amount: 10 } } }, async ({ orderId, lines, stripe, db: database }) => {
      const [soapLine] = await lines('product')
      // £24 of soap, £14 on the card: the plan is £14 to the card and £10 to store credit. Between R1 and the refusal
      // the restocked soaps are sold, so the order can't be put back.
      const create = stripe.refunds.create
      stripe.refunds.create = async () => {
        stripe.refunds.create = create
        await database.query('UPDATE product_variants SET stock_quantity = stock_quantity - 5 WHERE id = $1', [ID.variant])
        throw fakeStripeErrors.cardDeclined()
      }
      const held = await refund(orderId, [soapLine as string], 'card', { restock: { [soapLine as string]: true } })
      expect(held.status).toBe(200)
      expect(held.body.data).toMatchObject({ refundOwed: 14 })
      expect(held.body.data?.held?.reason).toBe('refund_refused_not_put_back')
      expect(held.body.data?.held?.message).toBe(
        "The card refund was refused (Failed to refund payment: Your card was declined.), so it didn't go back to the card (£10.00 went to store credit as planned), and the order can't be put back as it was: stock it returned has been sold since. The refund stands, and £14.00 shows on the order as still to refund. Use Refund the rest to give it another way."
      )
      expect(held.body.data?.held?.message).not.toContain('nothing went back')
      expect((await creditRefunds()).map((row) => [row.amount, row.order_id])).toEqual([['10.00', orderId]])
      expect(await order(orderId)).toMatchObject({ owed: '14.00' })
      expect(moneyBack(stripe)).toBe(0)
      expect((await auditRows('order.refund_finished'))[0]?.details).toMatchObject({ outcome: 'owed', owed: 14, cardRefunded: 0, storeCreditRefunded: 10, by: { how: 'undo_blocked' } })
    })
  })

  it('refused with the undo blocked (the restocked soap sold meanwhile): the refund stands, the £24 is owed on the order with Stripe\'s reason, and Refund the rest then It already arrived settle it', async () => {
    await onAnOrder({ products: [soap, mug], payment: card }, async ({ orderId, lines, stripe, db: database }) => {
      const [soapLine] = await lines('product')
      // Between R1 and the refusal, the two restocked soaps are sold.
      const create = stripe.refunds.create
      stripe.refunds.create = async () => {
        stripe.refunds.create = create
        await database.query('UPDATE product_variants SET stock_quantity = stock_quantity - 5 WHERE id = $1', [ID.variant])
        throw fakeStripeErrors.cardDeclined()
      }
      const held = await refund(orderId, [soapLine as string], 'card', { restock: { [soapLine as string]: true } })
      expect(held.status).toBe(200)
      expect(held.body.data).toMatchObject({ refundedAmount: 24, refundMethod: 'card', refundOwed: 24, orderPaymentStatus: 'partially_refunded' })
      expect(held.body.data?.held).toMatchObject({ reason: 'refund_refused_not_put_back', message: NEW_WORDS.putBackBlocked('Failed to refund payment: Your card was declined.', 24) })
      // W28a (review S2): Stripe has just said no, so the advice is Refund the rest, never "Check Stripe first".
      expect(held.body.data?.held?.message).toBe(
        "The card refund was refused (Failed to refund payment: Your card was declined.), so it didn't go back to the card, and the order can't be put back as it was: stock it returned has been sold since. The refund stands, and £24.00 shows on the order as still to refund. Use Refund the rest to give it another way."
      )
      expect((await lineRows(orderId))[0]).toMatchObject({ refunded: true, refund_method: 'card', restocked: true, card: '0.00' })
      expect(await order(orderId)).toEqual({ payment_status: 'partially_refunded', owed: '24.00' })
      expect(await creditRefunds()).toHaveLength(0)
      expect((await auditRows('order.refund_finished'))[0]?.details).toMatchObject({ outcome: 'owed', owed: 24, cardRefunded: 0, storeCreditRefunded: 0, refused: 'Failed to refund payment: Your card was declined.', by: { how: 'undo_blocked' } })
      expect((await figures(orderId)).body.data).toMatchObject({ refundOwed: 24, cardLeft: 39, blocked: null })
      // W47 item 6 (F3): while money is owed, the figures name the payment Refund the rest would use and what it can take.
      expect((await figures(orderId)).body.data?.owedCard).toEqual({ payment: 'order', left: 39 })
      // W47 item 1: the order is on the "Money still to refund" list, once, from the moment the money is owed.
      const listed = await moneyOwedList(database)
      expect(listed.owed).toHaveLength(1)
      expect(listed.owed[0]).toMatchObject({ on: 'order', orderId, bookingId: null, amount: 24, daysOwed: 0, where: MONEY_OWED_WORDS.order })
      expect(listed.owed[0]?.owedSince).toEqual(expect.any(String))
      expect(listed.owed[0]).not.toHaveProperty('eventBookings')
      expect(listed.total).toBe(24)
      // Refund the rest: exactly what is owed (my call), to the card as a new claim.
      expect((await post('refunds/owed', orderId, { amount: 20, refundMethod: 'card' })).body.error?.details).toMatchObject({ reason: 'owed_changed', message: NEW_WORDS.owedChanged(24) })
      expect((await post('refunds/owed', orderId, { amount: 24, refundMethod: 'cheque' })).body.error?.details?.reason).toBe('invalid_params')
      // Refused again: the money is owed again, with the words, and nothing went.
      stripe.failNext('refunds.create', declined())
      const again = await post('refunds/owed', orderId, { amount: 24, refundMethod: 'card' })
      expect(again.body.error?.details).toMatchObject({ reason: 'refund_failed', message: NEW_WORDS.owedCardRefundFailed('Failed to refund payment: Your card was declined.') })
      expect(await order(orderId)).toMatchObject({ owed: '24.00' })
      // £10 of it turns out to have reached the customer: It already arrived takes part of it (audit row 31).
      expect((await post('refunds/owed-arrived', orderId, { amount: 10, reason: '' })).body.error?.details?.reason).toBe('reason_required')
      expect((await post('refunds/owed-arrived', orderId, { amount: 24.01, reason: 'Seen in Stripe' })).body.error?.details).toMatchObject({ reason: 'more_than_owed', message: NEW_WORDS.onlyOwed(24) })
      expect((await post('refunds/owed-arrived', orderId, { amount: 10, reason: 'Seen in Stripe', arrivedOn: 'card' })).body.data).toEqual({ cardRefundedAmount: 0, storeCreditRefundedAmount: 0, refundOwed: 14 })
      // W47 item 8 (the W35 audit's row 6; W28 review L4), a named difference: staff said it reached the card, so the
      // £10 is recorded on the refunded line as card money, where Refund the rest to the card would record it, and the
      // row says so. Before W47 nothing
      // was recorded (`{ amount, reason, owedBefore, owedAfter }`), so the order's card money left read £10 too high
      // from here on (£39, and £25 at the end, where the payment really had £29 and then £15 left).
      expect((await auditRows('order.owed_arrived'))[0]?.details).toEqual({ amount: 10, reason: 'Seen in Stripe', owedBefore: 24, owedAfter: 14, arrivedOn: 'card', card: 10, lines: [{ lineId: soapLine, amount: 10 }] })
      expect((await lineRows(orderId))[0]).toMatchObject({ card: '10.00' })
      expect((await figures(orderId)).body.data).toMatchObject({ refundOwed: 14, cardLeft: 29, owedCard: { payment: 'order', left: 29 } })
      expect(moneyBack(stripe)).toBe(0)
      // The other £14 goes to the card now: recorded on the refunded line, so the order's card money left stays right.
      const rest = await post('refunds/owed', orderId, { amount: 14, refundMethod: 'card' })
      expect(rest.body.data).toEqual({ cardRefundedAmount: 14, storeCreditRefundedAmount: 0, refundOwed: 0 })
      expect((await lineRows(orderId))[0]).toMatchObject({ card: '24.00' })
      expect(await order(orderId)).toMatchObject({ owed: '0.00' })
      expect((await figures(orderId)).body.data).toMatchObject({ refundOwed: 0, cardLeft: 15 })
      // Nothing owed any more: the read is as it was before W47, with no `owedCard`, and the order is off the list.
      expect((await figures(orderId)).body.data).not.toHaveProperty('owedCard')
      expect(await moneyOwedList(database)).toMatchObject({ owed: [], total: 0 })
      expect(moneyBack(stripe)).toBe(1400)
      expect((await post('refunds/owed', orderId, { amount: 14, refundMethod: 'card' })).body.error?.details?.reason).toBe('nothing_owed')
    })
  })

  /** The £24 soap's card refund refused with the order not put back (its restocked soap sold meanwhile): £24 owed, the card with £39 left. */
  async function soapOwed(orderId: string, soapLine: string, stripe: FakeStripe, database: Db): Promise<void> {
    const create = stripe.refunds.create
    stripe.refunds.create = async () => {
      stripe.refunds.create = create
      await database.query('UPDATE product_variants SET stock_quantity = stock_quantity - 5 WHERE id = $1', [ID.variant])
      throw fakeStripeErrors.cardDeclined()
    }
    await refund(orderId, [soapLine], 'card', { restock: { [soapLine]: true } })
    expect(await order(orderId)).toMatchObject({ owed: '24.00' })
  }

  it.each([
    ['no choice sent (a staff app from before W47)', undefined],
    ['staff say it reached them another way', 'other'],
  ] as const)('W47 item 8, It already arrived, %s: the money comes off what is owed with nothing recorded on any line, the row as it was before W47, and the card money left unchanged', async (_name, arrivedOn) => {
    await onAnOrder({ products: [soap, mug], payment: card }, async ({ orderId, lines, stripe, db: database }) => {
      const [soapLine] = await lines('product')
      await soapOwed(orderId, soapLine as string, stripe, database)
      const answer = await post('refunds/owed-arrived', orderId, { amount: 24, reason: 'Found on their balance', ...(arrivedOn ? { arrivedOn } : {}) })
      expect(answer.body.data).toEqual({ cardRefundedAmount: 0, storeCreditRefundedAmount: 0, refundOwed: 0 })
      expect((await auditRows('order.owed_arrived'))[0]?.details).toEqual({ amount: 24, reason: 'Found on their balance', owedBefore: 24, owedAfter: 0 })
      expect((await lineRows(orderId)).map((line) => line.card)).toEqual(['0.00', '0.00'])
      expect((await figures(orderId)).body.data).toMatchObject({ refundOwed: 0, cardLeft: 39 })
      expect(moneyBack(stripe)).toBe(0)
    })
  })

  it("W47 item 8, It already arrived on the card for more than the payment can account for: only what the payment has left is recorded as card money, and the row says how much; the rest is on no line", async () => {
    await onAnOrder({ products: [soap, mug], payment: card }, async ({ orderId, lines, stripe, db: database }) => {
      const [soapLine, mugLine] = await lines('product')
      await soapOwed(orderId, soapLine as string, stripe, database)
      // £30 of the payment's £39 has gone back to the card since (recorded on the mug's line): £9 is left.
      await database.query('UPDATE order_line_items SET card_refunded_amount = 30 WHERE id = $1', [mugLine])
      expect((await figures(orderId)).body.data).toMatchObject({ refundOwed: 24, cardLeft: 9, owedCard: { payment: 'order', left: 9 } })
      const answer = await post('refunds/owed-arrived', orderId, { amount: 24, reason: 'Seen in Stripe', arrivedOn: 'card' })
      // W47a (W47 review L2), a named difference: the answer was the three figures alone and the screen said nothing.
      // Now it carries what was recorded against the card and what wasn't, and says so in words.
      expect(answer.body.data).toEqual({
        cardRefundedAmount: 0,
        storeCreditRefundedAmount: 0,
        refundOwed: 0,
        arrivedOnCard: { recorded: 9, other: 15 },
        warning: 'Only £9.00 could be recorded against the card payment (it had £9.00 left); the other £15.00 is recorded as reached another way. Check you chose the right place.',
      })
      expect((await auditRows('order.owed_arrived'))[0]?.details).toEqual({ amount: 24, reason: 'Seen in Stripe', owedBefore: 24, owedAfter: 0, arrivedOn: 'card', card: 9, lines: [{ lineId: soapLine, amount: 9 }] })
      expect((await lineRows(orderId)).map((line) => line.card)).toEqual(['9.00', '30.00'])
      expect((await figures(orderId)).body.data).toMatchObject({ refundOwed: 0, cardLeft: 0 })
    })
  })

  it('W47a (W47 review L2): It already arrived "on the card" on an order with no card payment records nothing as card money and says so; "another way" for the same money says nothing', async () => {
    await onAnOrder({ products: [soap], payment: cash(24) }, async ({ orderId, db: database }) => {
      // Test data standing in for money an old screen left owed on a cash order.
      await database.query('UPDATE orders SET refund_owed_amount = 10 WHERE id = $1', [orderId])
      const onCard = await post('refunds/owed-arrived', orderId, { amount: 6, reason: 'Seen in Stripe', arrivedOn: 'card' })
      expect(onCard.body.data).toEqual({
        cardRefundedAmount: 0,
        storeCreditRefundedAmount: 0,
        refundOwed: 4,
        arrivedOnCard: { recorded: 0, other: 6 },
        warning: 'None of the £6.00 could be recorded against a card payment (the order has no card money left to record it against); it is recorded as reached another way. Check you chose the right place.',
      })
      expect((await auditRows('order.owed_arrived'))[0]?.details).toEqual({ amount: 6, reason: 'Seen in Stripe', owedBefore: 10, owedAfter: 4, arrivedOn: 'card', card: 0, lines: [] })
      expect((await lineRows(orderId)).map((line) => line.card)).toEqual(['0.00'])
      const another = await post('refunds/owed-arrived', orderId, { amount: 4, reason: 'Handed back in cash', arrivedOn: 'other' })
      expect(another.body.data).toEqual({ cardRefundedAmount: 0, storeCreditRefundedAmount: 0, refundOwed: 0 })
    })
  })

  it('Refund the rest to store credit gives exactly what is owed, with its own note, and clears it', async () => {
    await onAnOrder({ products: [soap], payment: card }, async ({ orderId, lines, stripe, db: database }) => {
      const ids = await lines('product')
      const create = stripe.refunds.create
      stripe.refunds.create = async () => {
        stripe.refunds.create = create
        await database.query('UPDATE product_variants SET stock_quantity = 0 WHERE id = $1', [ID.variant])
        throw fakeStripeErrors.cardDeclined()
      }
      await refund(orderId, ids, 'card', { restock: { [ids[0] as string]: true } })
      expect(await order(orderId)).toMatchObject({ owed: '24.00' })
      expect((await post('refunds/owed', orderId, { amount: 24, refundMethod: 'credit' })).body.data).toMatchObject({ cardRefundedAmount: 0, storeCreditRefundedAmount: 24, refundOwed: 0 })
      const credit = await creditRefunds()
      expect(credit).toHaveLength(1)
      expect(credit[0]).toMatchObject({ amount: '24.00', order_id: orderId })
      expect(credit[0]?.note.startsWith('Refund the rest of a failed order refund. [ref ')).toBe(true)
      expect((await auditRows('order.refund_owed'))[0]?.details).toEqual({ amount: 24, method: 'credit', cardRefunded: 0, storeCreditRefunded: 24, owed: 0 })
      // Cash is never offered for card money (Q42): this order has no cash paid on it.
      await database.query('UPDATE orders SET refund_owed_amount = 5 WHERE id = $1', [orderId])
      expect((await post('refunds/owed', orderId, { amount: 5, refundMethod: 'cash' })).body.error?.details).toMatchObject({ reason: 'no_cash_left', message: NEW_WORDS.noCashLeft })
      expect(await order(orderId)).toMatchObject({ owed: '5.00' })
    })
  })

  it('no clear answer, and the refund is in Stripe: held, every other refund on the order refused (`refund_open`), on the stuck list with the order\'s words; reconcile finds it and records it, never sending it again', async () => {
    await onAnOrder({ products: [soap, mug], payment: card }, async ({ orderId, lines, stripe }) => {
      const [soapLine, mugLine] = await lines('product')
      stripe.failNext('refunds.create', { kind: 'lost_response' })
      stripe.failNext('refunds.create', { kind: 'lost_response' })
      const held = await refund(orderId, [soapLine as string], 'card')
      expect(held.body.data).toMatchObject({ refundedAmount: 0, refundMethod: 'card' })
      expect(held.body.data?.held).toMatchObject({ reason: 'refund_unconfirmed', message: NEW_WORDS.unconfirmed })
      const claimId = held.body.data?.held?.claimId as string
      // Sent once, and once more under the same key and request: one refund in Stripe.
      expect(refundsSent(stripe).map((call) => call.idempotencyKey)).toEqual([claimRefundKey(claimId, orderId), claimRefundKey(claimId, orderId)])
      expect(moneyBack(stripe)).toBe(2400)
      // The claim holds the order: another line, the same line, Refund the rest and It already arrived are all refused.
      for (const answer of [await refund(orderId, [mugLine as string], 'credit', { confirmed: 15 }), await refund(orderId, [soapLine as string], 'card', { confirmed: 24 }), await post('refunds/owed', orderId, { amount: 5, refundMethod: 'credit' }), await post('refunds/owed-arrived', orderId, { amount: 5, reason: 'Seen' })]) {
        expect(answer.status).toBe(409)
        expect(answer.body.error?.details).toMatchObject({ reason: 'refund_open', message: ORDER_REFUND_OPEN_MESSAGE })
      }
      expect((await figures(orderId)).body.data?.['blocked']).toEqual({ reason: 'refund_open', message: ORDER_REFUND_OPEN_MESSAGE })
      expect(await creditRefunds()).toHaveLength(0)
      // Inside the window nothing is listed; past it, the order's own words, and reconcile settles it.
      expect((await stuckList(db)).claims).toHaveLength(0)
      pastTheWindow()
      expect((await stuckList(db)).claims).toEqual([expect.objectContaining({ claimId, orderId, bookingId: null, amount: 24, reason: 'waiting', words: ORDER_CLAIM_WAITING_WORDS })])
      const run = await runReconcile()
      expect(run.items).toEqual([expect.objectContaining({ kind: 'claim', id: claimId, outcome: 'finalised' })])
      expect(refundsSent(stripe)).toHaveLength(2)
      expect(moneyBack(stripe)).toBe(2400)
      expect((await lineRows(orderId))[0]).toMatchObject({ refunded: true, refund_method: 'card', card: '24.00' })
      expect(await order(orderId)).toEqual({ payment_status: 'partially_refunded', owed: '0.00' })
      expect((await auditRows('order.refund_finished'))[0]?.details).toMatchObject({ claimId, outcome: 'given', cardRefunded: 24, owed: 0, by: { how: 'reconcile', type: 'system' } })
      expect((await stuckList(db)).claims).toHaveLength(0)
      // The order is free again.
      expect((await refund(orderId, [mugLine as string], 'card')).body.data).toMatchObject({ refundedAmount: 15, cardRefundedAmount: 15, orderPaymentStatus: 'refunded' })
    })
  })

  it('no clear answer, and Stripe never got it: reconcile leaves the £24 on the order as still to refund, never store credit and never sent again; a second run does nothing', async () => {
    await onAnOrder({ products: [soap], payment: { method: 'card', storeCredit: { amount: 10 } } }, async ({ orderId, lines, stripe }) => {
      const ids = await lines('product')
      stripe.failNext('refunds.create', { kind: 'unreachable' })
      stripe.failNext('refunds.create', { kind: 'unreachable' })
      // £24 of soap, £14 of it on the card: the £10 planned for store credit waits for R2 with the card part.
      const held = await refund(orderId, ids, 'card')
      expect(held.body.data?.held?.reason).toBe('refund_unconfirmed')
      expect(await creditRefunds()).toHaveLength(0)
      pastTheWindow()
      const run = await runReconcile()
      expect(run.items).toEqual([expect.objectContaining({ kind: 'claim', outcome: 'finalised' })])
      // The plan's own £10 store credit is given; the £14 the card never got is owed, not given another way.
      // W53 (W32 "Noticed" 4), a named difference: while money is owed the order reads `partially_refunded`, however
      // its lines are stamped (it read `refunded` with £14 still to refund).
      expect(await order(orderId)).toEqual({ payment_status: 'partially_refunded', owed: '14.00' })
      expect((await creditRefunds()).map((row) => row.amount)).toEqual(['10.00'])
      expect((await creditRefunds())[0]?.note.startsWith('Refund to store credit — order line items refunded by staff. [ref ')).toBe(true)
      expect((await auditRows('order.refund_finished'))[0]?.details).toMatchObject({ outcome: 'owed', cardRefunded: 0, storeCreditRefunded: 10, owed: 14, by: { how: 'reconcile' } })
      expect(moneyBack(stripe)).toBe(0)
      expect(refundsSent(stripe)).toHaveLength(2)
      expect((await runReconcile()).items).toEqual([])
      expect(refundsSent(stripe)).toHaveLength(2)
      // W53 (W32 "Noticed" 4): once the £14 has been recorded as arrived, nothing is owed and the order reads refunded
      // again (It already arrived on an order now works its status out again, as a booking's does).
      expect((await post('refunds/owed-arrived', orderId, { amount: 14, reason: 'Seen in Stripe', arrivedOn: 'card' })).body.data).toMatchObject({ refundOwed: 0 })
      expect(await order(orderId)).toEqual({ payment_status: 'refunded', owed: '0.00' })
    })
  })

  it('reconcile leaves a claim for a person (two refunds in Stripe name it): listed with a close; the manual close puts the money on the order as owed, and a second close does nothing', async () => {
    await onAnOrder({ products: [soap, mug], payment: card }, async ({ orderId, lines, stripe }) => {
      const ids = (await lines('product')).slice(0, 1)
      stripe.failNext('refunds.create', { kind: 'lost_response' })
      stripe.failNext('refunds.create', { kind: 'lost_response' })
      const held = await refund(orderId, ids, 'card')
      const claimId = held.body.data?.held?.claimId as string
      const claim = await readOrderClaim(db, claimId)
      const part = claim?.details.plan.card[0]
      // A second refund naming the claim (made by hand in Stripe, say).
      await stripe.refunds.create({ payment_intent: part?.paymentIntentId as string, amount: 100, metadata: { claim_id: claimId } })
      pastTheWindow()
      expect((await close(claimId)).body.data).toMatchObject({ closed: false, reason: 'claim_not_left_for_a_person' })
      expect((await runReconcile()).items).toEqual([expect.objectContaining({ kind: 'claim', id: claimId, outcome: 'left', reason: 'several_refunds' })])
      const listed = (await stuckList(db)).claims
      expect(listed).toEqual([expect.objectContaining({ claimId, orderId, reason: 'several_refunds', close: { kind: 'held_claim', orderId: claimId } })])
      const closed = await close(claimId)
      expect(closed.body.data).toMatchObject({ closed: true, kind: 'held_claim' })
      expect(String(closed.body.data?.['message'])).toContain('on the order as money still to refund')
      expect(await order(orderId)).toEqual({ payment_status: 'partially_refunded', owed: '24.00' })
      expect(await creditRefunds()).toHaveLength(0)
      expect((await auditRows('order.refund_finished'))[0]?.details).toMatchObject({ outcome: 'owed', owed: 24, by: { how: 'close' } })
      expect((await close(claimId)).body.data).toMatchObject({ closed: true, alreadyClosed: true })
      expect((await stuckList(db)).claims).toHaveLength(0)
      expect(await order(orderId)).toMatchObject({ owed: '24.00' })
    })
  })

  it("review L4: an order held by a booking's card part says so (\"this order's card payment\"), for the refund and on the figures", async () => {
    await onAnOrder({ products: [soap], booking: paidSeat(), payment: card }, async ({ orderId, placed, lines, stripe }) => {
      const bookingId = String(placed['bookingId'])
      // A Part refund of the booking, held with no clear answer: a booking claim with a card part on this order's payment.
      stripe.failNext('refunds.create', { kind: 'lost_response' })
      stripe.failNext('refunds.create', { kind: 'lost_response' })
      const partRefund = await withSwitch(BOOKING_KINDS_ON, async () => {
        const response = await (bookingRefundRoute as Handler)(
          new Request(`https://worker.test/api/v1/staff/bookings/${bookingId}/refunds`, {
            method: 'POST',
            headers: { authorization: `Bearer ${KEY}`, 'x-staff-email': REPLAY_USER.email, 'idempotency-key': crypto.randomUUID(), 'content-type': 'application/json' },
            body: JSON.stringify({ amount: 10, refundMethod: 'card', reason: 'Goodwill' }),
          }),
          { params: Promise.resolve({ bookingId }) }
        )
        return (await response.json()) as Answer['body']
      })
      expect(partRefund.data?.held?.reason).toBe('refund_unconfirmed')
      const answer = await refund(orderId, await lines('product'), 'card', { confirmed: 24 })
      expect(answer.status).toBe(409)
      expect(answer.body.error?.details).toMatchObject({ reason: 'refund_open', message: ORDER_PAYMENT_REFUND_OPEN_MESSAGE })
      expect((await figures(orderId)).body.data?.['blocked']).toEqual({ reason: 'refund_open', message: ORDER_PAYMENT_REFUND_OPEN_MESSAGE })
      expect(await auditRows('order.refund_claimed')).toHaveLength(0)
    })
  })
})

describe('a crash at each step: nothing is paid twice and nothing is hidden', () => {
  /** A Db whose transactions die from the `from`th on (1 is R1), as a Worker killed part way leaves them. */
  function dyingFrom(from: number): { db: Db; revive(): void } {
    let count = 0
    let dead = true
    const proxy = new Proxy(db, {
      get(target, property, receiver) {
        if (property === 'transaction') {
          return <T>(work: (tx: Tx) => Promise<T>): Promise<T> => {
            count += 1
            if (dead && count >= from) return Promise.reject(new Error('the Worker died'))
            return target.transaction(work)
          }
        }
        return Reflect.get(target, property, receiver) as unknown
      },
    })
    return { db: proxy, revive: () => (dead = false) }
  }
  const options = (stripe: FakeStripe): OrderRefundOptions => ({ actor: { type: 'staff', id: ID.staff }, requestId: crypto.randomUUID(), stripe: () => stripe })
  const press = (through: Db, stripe: FakeStripe, orderId: string, lineItemIds: string[], amount: number) =>
    refundOrderLines(through, orderId, { lineItemIds, refundMethod: 'card', restock: Object.fromEntries(lineItemIds.map((id) => [id, false])), confirmed: { amount } }, options(stripe))

  it('no time left to send the card refund (the press started 29 seconds ago): never sent, R1 undone, plain words, and the same refund then goes through', async () => {
    await onAnOrder({ products: [soap], payment: card }, async ({ orderId, lines, stripe }) => {
      const ids = await lines('product')
      const late: OrderRefundOptions = { ...options(stripe), startedAt: Date.now() - 29_000 }
      const pressed = refundOrderLines(db, orderId, { lineItemIds: ids, refundMethod: 'card', restock: { [ids[0] as string]: true }, confirmed: { amount: 24 } }, late)
      await expect(pressed).rejects.toMatchObject({ code: 'PAYMENT_FAILED', details: { reason: 'refund_failed', message: NEW_WORDS.notSentInTime } })
      expect(refundsSent(stripe)).toHaveLength(0)
      // Stripe never saw it, so it isn't marked as refused, and nothing is owed: the order is as it was.
      expect(await auditRows('order.refund_refused')).toHaveLength(0)
      expect((await auditRows('order.refund_finished'))[0]?.details).toMatchObject({ outcome: 'put_back' })
      expect((await lineRows(orderId))[0]).toMatchObject({ refunded: false, restocked: null, card: '0.00' })
      expect(await stock(ID.variant)).toBe(3)
      expect(await order(orderId)).toEqual({ payment_status: 'paid', owed: '0.00' })
      expect((await refund(orderId, ids, 'card')).body.data).toMatchObject({ cardRefundedAmount: 24, orderPaymentStatus: 'refunded' })
      expect(moneyBack(stripe)).toBe(2400)
    })
  })

  it('dies in R1: nothing is kept, nothing is sent, and the same refund then goes through', async () => {
    await onAnOrder({ products: [soap], payment: card }, async ({ orderId, lines, stripe }) => {
      const ids = await lines('product')
      await expect(press(dyingFrom(1).db, stripe, orderId, ids, 24)).rejects.toThrow('the Worker died')
      expect(await auditRows('order.refund_claimed')).toHaveLength(0)
      expect(refundsSent(stripe)).toHaveLength(0)
      expect((await lineRows(orderId))[0]?.refunded).toBe(false)
      expect((await refund(orderId, ids, 'card')).body.data).toMatchObject({ cardRefundedAmount: 24 })
    })
  })

  it('"died after one line, then another line" is closed: dies after the card refund and before R2, the next line is refused (`refund_open`), reconcile records the £24 once, then the next line refunds: £48 back, £48 recorded', async () => {
    await onAnOrder({ products: [soap, { ...soap, quantity: 2 }], payment: card }, async ({ orderId, lines, stripe }) => {
      const [first, second] = await lines('product')
      // R1 commits, the refund goes, then every later transaction dies (R2 never runs).
      const held = await press(dyingFrom(2).db, stripe, orderId, [first as string], 24)
      expect(held.held).toMatchObject({ reason: 'refund_not_recorded', message: NEW_WORDS.goneNotRecorded(24) })
      expect(held).toMatchObject({ refundedAmount: 24, cardRefundedAmount: 24 })
      expect(moneyBack(stripe)).toBe(2400)
      // The old code let the second line go here, and £48 went back with £24 recorded on the wrong line.
      const another = await refund(orderId, [second as string], 'card', { confirmed: 24 })
      expect(another.body.error?.details?.reason).toBe('refund_open')
      expect(moneyBack(stripe)).toBe(2400)
      pastTheWindow()
      expect((await runReconcile()).items).toEqual([expect.objectContaining({ kind: 'claim', outcome: 'finalised' })])
      expect(await lineRows(orderId)).toEqual([expect.objectContaining({ id: first, refunded: true, card: '24.00' }), expect.objectContaining({ id: second, refunded: false, card: '0.00' })])
      expect((await refund(orderId, [second as string], 'card')).body.data).toMatchObject({ cardRefundedAmount: 24, orderPaymentStatus: 'refunded' })
      expect(moneyBack(stripe)).toBe(4800)
      expect((await lineRows(orderId)).map((line) => line.card)).toEqual(['24.00', '24.00'])
      expect(refundsSent(stripe)).toHaveLength(2)
    })
  })

  it('dies after R1 and before anything reaches Stripe: the claim holds the order; reconcile finds nothing in Stripe and leaves the £24 owed, never sent by anyone but a new press', async () => {
    await onAnOrder({ products: [soap], payment: card }, async ({ orderId, lines, stripe }) => {
      const ids = await lines('product')
      // Nothing reaches Stripe, and the Worker dies before it can write anything more.
      stripe.failNext('refunds.create', { kind: 'unreachable' })
      stripe.failNext('refunds.create', { kind: 'unreachable' })
      const held = await press(dyingFrom(2).db, stripe, orderId, ids, 24)
      expect(held.held?.reason).toBe('refund_unconfirmed')
      expect((await refund(orderId, ids, 'card', { confirmed: 24 })).body.error?.details?.reason).toBe('refund_open')
      pastTheWindow()
      await runReconcile()
      // W53: `partially_refunded` while the £24 is owed (it read `refunded`).
      expect(await order(orderId)).toEqual({ payment_status: 'partially_refunded', owed: '24.00' })
      expect(moneyBack(stripe)).toBe(0)
      // Refund the rest sends it, once, under a new claim's key.
      expect((await post('refunds/owed', orderId, { amount: 24, refundMethod: 'card' })).body.data).toMatchObject({ cardRefundedAmount: 24, refundOwed: 0 })
      expect(moneyBack(stripe)).toBe(2400)
    })
  })

  it('refused, then dies before the mark, the undo or the finish can be written: held with Stripe\'s reason; reconcile ends it as money owed (never store credit), and nothing was sent twice', async () => {
    await onAnOrder({ products: [soap], payment: { method: 'card', storeCredit: { amount: 10 } } }, async ({ orderId, lines, stripe }) => {
      const ids = await lines('product')
      stripe.failNext('refunds.create', declined())
      const held = await press(dyingFrom(2).db, stripe, orderId, ids, 24)
      expect(held.held).toMatchObject({ reason: 'refund_refused_not_put_back', message: NEW_WORDS.putBackFailedNotRecorded('Failed to refund payment: Your card was declined.') })
      expect(await auditRows('order.refund_refused')).toHaveLength(0)
      expect(await creditRefunds()).toHaveLength(0)
      pastTheWindow()
      expect((await runReconcile()).items).toEqual([expect.objectContaining({ kind: 'claim', outcome: 'finalised' })])
      // The £14 the card refused is owed; only the plan's own £10 went to store credit.
      // W53: `partially_refunded` while the £14 is owed (it read `refunded`).
      expect(await order(orderId)).toEqual({ payment_status: 'partially_refunded', owed: '14.00' })
      expect((await creditRefunds()).map((row) => row.amount)).toEqual(['10.00'])
      expect(refundsSent(stripe)).toHaveLength(1)
      expect(moneyBack(stripe)).toBe(0)
    })
  })

  it('dies after the refusal\'s mark and before the undo: reconcile reads the mark and ends it as money owed with Stripe\'s reason', async () => {
    await onAnOrder({ products: [soap], payment: card }, async ({ orderId, lines, stripe }) => {
      const ids = await lines('product')
      stripe.failNext('refunds.create', declined())
      // R1 (1) and the mark (2) are written; the undo and the finish die.
      const held = await press(dyingFrom(3).db, stripe, orderId, ids, 24)
      expect(held.held?.reason).toBe('refund_refused_not_put_back')
      expect(await auditRows('order.refund_refused')).toHaveLength(1)
      pastTheWindow()
      await runReconcile()
      // W53: `partially_refunded` while the £24 is owed (it read `refunded`).
      expect(await order(orderId)).toEqual({ payment_status: 'partially_refunded', owed: '24.00' })
      expect((await auditRows('order.refund_finished'))[0]?.details).toMatchObject({ outcome: 'owed', owed: 24, refused: 'Failed to refund payment: Your card was declined.', by: { how: 'reconcile' } })
      expect(await creditRefunds()).toHaveLength(0)
    })
  })
})

describe('cash back (Q42): only up to the cash paid on the order', () => {
  it("Wayne's example: £14 cash + £10 gift card gives £14 in cash and £10 to store credit, who handed it over recorded; nothing more in cash after", async () => {
    await onAnOrder({ products: [soap], payment: { ...cash(14), giftCard: { giftCardId: ID.giftCard, amount: 10 } } }, async ({ orderId, lines, stripe }) => {
      const ids = await lines('product')
      expect((await figures(orderId)).body.data).toMatchObject({ cardLeft: 0, cashLeft: 14 })
      // Card is never offered for cash money: the old refusal.
      expect((await refund(orderId, ids, 'card', { confirmed: 24 })).body.error?.details?.reason).toBe('no_payment_intent_for_card_refund')
      const answer = await refund(orderId, ids, 'cash')
      expect(answer.body.data).toEqual({ refundedAmount: 24, refundMethod: 'cash', storeCreditRefundedAmount: 10, cashRefundedAmount: 14, storeCreditBalance: 40, orderPaymentStatus: 'refunded' })
      expect((await lineRows(orderId))[0]).toMatchObject({ refunded: true, refund_method: 'cash', card: '0.00' })
      const [claim] = await auditRows('order.refund_claimed')
      expect(claim?.details).toMatchObject({ method: 'cash', amount: 24, handedOverBy: ID.staff, plan: { card: [], storeCredit: 10, cash: 14 } })
      expect((await auditRows('order.refund'))[0]?.details).toMatchObject({ method: 'cash', cashRefunded: 14, handedOverBy: ID.staff, storeCreditRefunded: 10, cardRefunded: 0, owed: 0 })
      expect((await auditRows('order.refund_finished'))[0]?.details).toMatchObject({ outcome: 'given', cash: 14, storeCreditRefunded: 10 })
      expect((await figures(orderId)).body.data).toMatchObject({ cashLeft: 0 })
      expect(stripe.calls.filter((call) => call.method.startsWith('refunds.'))).toHaveLength(0)
    })
  })

  it('cash over the cap: two lines of a cash order, one handed back in cash; the cap falls, the second gets only what is left in cash and the rest as store credit; with none left, cash is refused', async () => {
    await onAnOrder({ products: [soap, mug], payment: { ...cash(29), giftCard: { giftCardId: ID.giftCard, amount: 10 } } }, async ({ orderId, lines }) => {
      const [soapLine, mugLine] = await lines('product')
      // £39 of lines, £29 of it cash. The £24 soap goes back in cash: £5 of cash is left on the order.
      expect((await refund(orderId, [soapLine as string], 'cash')).body.data).toMatchObject({ cashRefundedAmount: 24 })
      expect((await figures(orderId)).body.data).toMatchObject({ cashLeft: 5 })
      // The £15 mug: £5 in cash, never £15; the other £10 to store credit.
      expect((await refund(orderId, [mugLine as string], 'cash')).body.data).toMatchObject({ refundedAmount: 15, cashRefundedAmount: 5, storeCreditRefundedAmount: 10 })
      expect((await figures(orderId)).body.data).toMatchObject({ cashLeft: 0 })
    })
    await onAnOrder({ products: [soap], payment: card }, async ({ orderId, lines }) => {
      const answer = await refund(orderId, await lines('product'), 'cash')
      expect(answer.status).toBe(409)
      expect(answer.body.error?.details).toMatchObject({ reason: 'no_cash_left', message: NEW_WORDS.noCashLeft })
      expect(answer.body.error?.details?.figures).toMatchObject({ cashLeft: 0 })
    })
  })

  it("the same cash is never handed back twice across a booking's Part refund (step D's Q26) and its order's refund: what the booking handed back comes off the order's cash", async () => {
    await onAnOrder({ products: [soap], booking: paidSeat(), payment: { ...cash(34), giftCard: { giftCardId: ID.giftCard, amount: 10 } } }, async ({ orderId, placed, lines }) => {
      const bookingId = String(placed['bookingId'])
      const bookingCash = async () => {
        const response = await (bookingFiguresRoute as Handler)(new Request(`https://worker.test/api/v1/staff/bookings/${bookingId}/refund-figures`, { headers: { authorization: `Bearer ${KEY}`, 'x-staff-email': REPLAY_USER.email } }), {
          params: Promise.resolve({ bookingId }),
        })
        return ((await response.json()) as Answer['body']).data?.['cashLeft']
      }
      // £44 order (a £20 seat and £24 of soap): £10 on a gift card, £34 in cash. The booking counts the gift card
      // against its seat first, so £10 of the seat can go back in cash; the order has £34 of cash in all.
      expect(await bookingCash()).toBe(10)
      expect((await figures(orderId)).body.data).toMatchObject({ cashLeft: 34 })
      const partRefund = await withSwitch(BOOKING_KINDS_ON, async () => {
        const response = await (bookingRefundRoute as Handler)(
          new Request(`https://worker.test/api/v1/staff/bookings/${bookingId}/refunds`, {
            method: 'POST',
            headers: { authorization: `Bearer ${KEY}`, 'x-staff-email': REPLAY_USER.email, 'idempotency-key': crypto.randomUUID(), 'content-type': 'application/json' },
            body: JSON.stringify({ amount: 10, refundMethod: 'cash', reason: 'Goodwill' }),
          }),
          { params: Promise.resolve({ bookingId }) }
        )
        return (await response.json()) as Answer['body']
      })
      expect(partRefund.data).toMatchObject({ cashRefundedAmount: 10 })
      // £10 of the order's cash has gone back through the booking: £24 is left for its other lines.
      expect((await figures(orderId)).body.data).toMatchObject({ cashLeft: 24 })
      expect((await refund(orderId, await lines('product'), 'cash')).body.data).toMatchObject({ cashRefundedAmount: 24 })
      expect((await figures(orderId)).body.data).toMatchObject({ cashLeft: 0 })
      expect(await bookingCash()).toBe(0)
      // £34 was paid in cash, and £34 has been handed back: never more.
      const handed = await db.query<{ cash: string }>("SELECT COALESCE(SUM((details->'plan'->>'cash')::numeric), 0)::text AS cash FROM audit_log WHERE action IN ('order.refund_claimed', 'booking.refund_claimed')")
      expect(Number(handed[0]?.cash)).toBe(34)
    })
  })
})

// Brief W32 (E-plan section 5): the refund watch on an order's claim. A card refund Stripe answers `pending` is
// recorded as gone and read by reconcile until it ends; a failure is put back as money owed on the order (Q39).
describe('W32: the refund watch on an order', () => {
  /** W32a: without the `checked` rows (one for each read that ended nothing). */
  const watchStates = async () => (await auditRows('refund.watch')).map((row) => String(row.details['state'])).filter((state) => state !== 'checked').sort()
  const minutes = (n: number) => vi.setSystemTime(Date.now() + n * 60_000)
  const DAY = 24 * 60
  const refundItems = async () => (await runReconcile()).items.filter((item) => item.kind === 'refund')
  async function pendingRefund(orderId: string, lineIds: string[], stripe: FakeStripe): Promise<Answer> {
    stripe.refundsStayPending = true
    const answer = await refund(orderId, lineIds, 'card')
    stripe.refundsStayPending = false
    return answer
  }

  it('pending then succeeded: the order is as the press left it and the watch ends', async () => {
    await onAnOrder({ products: [{ ...soap, quantity: 1 }, mug], payment: card }, async ({ orderId, lines, stripe }) => {
      const [, mugLine] = await lines('product')
      const answer = await pendingRefund(orderId, [mugLine as string], stripe)
      expect(answer.body.data).toMatchObject({ refundedAmount: 15, cardRefundedAmount: 15, orderPaymentStatus: 'partially_refunded' })
      const sent = stripe.refundsSent[0]
      const claim = (await auditRows('order.refund_claimed'))[0]
      expect((await auditRows('order.refund_finished'))[0]?.details).toMatchObject({ outcome: 'given', cardRefunded: 15, refunds: [{ orderId, paymentIntentId: sent?.payment_intent, refundId: sent?.id, status: 'pending', amount: 15 }] })
      expect((await auditRows('refund.watch')).map((row) => row.details)).toEqual([
        { state: 'watching', refundId: sent?.id, paymentIntentId: sent?.payment_intent, amount: 15, status: 'pending', livemode: false, on: 'order', subjectId: orderId, orderId, claimId: claim?.id, lines: [{ lineId: mugLine, amount: 15 }] },
      ])
      // W32a (W32 review S2): on its way: read, no item, nothing for a person; counted as waiting on Stripe.
      expect(await runReconcile()).toMatchObject({ refunds: 0, left: 0, refundsWaiting: 1, items: [] })
      stripe.settleRefund(sent?.id as string, 'succeeded')
      minutes(5)
      // W32a (lead call 1): succeeded is not the end of the watch; it ends, quietly, when its 50 days are up.
      expect(await runReconcile()).toMatchObject({ refunds: 0, left: 0, refundsWaiting: 0, items: [] })
      expect(await watchStates()).toEqual(['watching'])
      minutes(WATCH_DAYS * DAY)
      expect(await refundItems()).toEqual([])
      expect(await watchStates()).toEqual(['succeeded', 'watching'])
      expect(await order(orderId)).toEqual({ payment_status: 'partially_refunded', owed: '0.00' })
      minutes(DAY)
      expect(await refundItems()).toEqual([])
      expect(refundsSent(stripe)).toHaveLength(1)
      expect((await stuckList(db)).watched).toEqual([])
    })
  })

  it('pending then failed: the £15 is off the line and owed on the order (Q39), once, never store credit, never sent again; the line stays refunded; listed with what to do; Refund the rest sends it to the card again', async () => {
    await onAnOrder({ products: [{ ...soap, quantity: 1 }, mug], payment: card }, async ({ orderId, lines, stripe }) => {
      const [, mugLine] = await lines('product')
      await pendingRefund(orderId, [mugLine as string], stripe)
      const sent = stripe.refundsSent[0]
      expect((await lineRows(orderId)).find((line) => line.id === mugLine)).toMatchObject({ refunded: true, refund_method: 'card', card: '15.00' })
      stripe.settleRefund(sent?.id as string, 'failed')

      expect(await refundItems()).toMatchObject([{ kind: 'refund', id: sent?.id, outcome: 'refund_failed', reason: 'refund_failed_later' }])
      expect(await order(orderId)).toEqual({ payment_status: 'partially_refunded', owed: '15.00' })
      // The line is still refunded (the mug stays refunded: staff decide about the money), with no card money on it.
      expect((await lineRows(orderId)).find((line) => line.id === mugLine)).toMatchObject({ refunded: true, refund_method: 'card', card: '0.00' })
      expect((await figures(orderId)).body.data).toMatchObject({ cardLeft: 27, refundOwed: 15 })
      await Promise.all([runReconcile(), runReconcile()])
      expect(await refundItems()).toEqual([])
      expect(await order(orderId)).toMatchObject({ owed: '15.00' })
      expect(await watchStates()).toEqual(['failed', 'watching'])
      expect((await auditRows('order.refund_failed_later')).map((row) => [row.entity_id, row.details['owed'], row.details['refundId']])).toEqual([[orderId, 15, sent?.id]])
      expect(await creditRefunds()).toEqual([])
      expect(refundsSent(stripe)).toHaveLength(1)

      const listed = (await stuckList(db)).watched
      expect(listed).toMatchObject([{ refundId: sent?.id, on: 'order', bookingId: null, orderId, amount: 15, owed: 15, state: 'failed', words: WATCH_WORDS.orderFailed(15, sent?.id as string) }])
      expect(listed[0]?.words).toBe(
        `A card refund of £15.00 on this order (${sent?.id}) was accepted by Stripe and then failed, so the money never reached the customer. It is back on the order as money still to refund: find the order on the Orders page and use Refund the rest (choose store credit if the card can't take a refund). Then press Mark sorted (needs the Issue refunds permission).`
      )

      const rest = await post('refunds/owed', orderId, { amount: 15, refundMethod: 'card' })
      expect(rest.body.data).toMatchObject({ cardRefundedAmount: 15, storeCreditRefundedAmount: 0, refundOwed: 0 })
      expect(moneyBack(stripe)).toBe(1500)
      expect(new Set(refundsSent(stripe).map((call) => call.idempotencyKey)).size).toBe(2)
      expect((await lineRows(orderId)).find((line) => line.id === mugLine)).toMatchObject({ card: '15.00' })
    })
  })

  it("W32a (lead call 1; Stripe's 5126 shape, end to end): a card refund that succeeds at once is kept on the finished row and watched too; Stripe fails it afterwards: the next day's read takes the £15 off the line and puts it back as owed on the order, listed; the failed refund is never sent again", async () => {
    await onAnOrder({ products: [mug], payment: card }, async ({ orderId, lines, stripe }) => {
      const [mugLine] = await lines('product')
      await refund(orderId, [mugLine as string], 'card')
      const sent = stripe.refundsSent[0]
      const claim = (await auditRows('order.refund_claimed'))[0]
      expect((await auditRows('order.refund_finished'))[0]?.details).toMatchObject({ refunds: [{ refundId: sent?.id, status: 'succeeded' }] })
      expect((await auditRows('refund.watch')).map((row) => row.details)).toEqual([
        { state: 'watching', refundId: sent?.id, paymentIntentId: sent?.payment_intent, amount: 15, status: 'succeeded', livemode: false, on: 'order', subjectId: orderId, orderId, claimId: claim?.id, lines: [{ lineId: mugLine, amount: 15 }] },
      ])
      const lists = () => stripe.calls.filter((call) => call.method === 'refunds.list').length
      // Stripe fails it minutes later; the money is back on the payment.
      minutes(5)
      stripe.settleRefund(sent?.id as string, 'failed')
      expect(moneyBack(stripe)).toBe(0)
      // Nothing is read until a day after it was recorded.
      const before = lists()
      expect(await refundItems()).toEqual([])
      expect(lists()).toBe(before)
      expect(await order(orderId)).toMatchObject({ owed: '0.00' })
      minutes(DAY)
      const found = await runReconcile()
      expect(found).toMatchObject({ refunds: 1, left: 1 })
      expect(found.items).toMatchObject([{ kind: 'refund', id: sent?.id, outcome: 'refund_failed', reason: 'refund_failed_later' }])
      expect(await order(orderId)).toMatchObject({ owed: '15.00' })
      expect((await lineRows(orderId)).find((line) => line.id === mugLine)).toMatchObject({ refunded: true, refund_method: 'card', card: '0.00' })
      expect((await auditRows('order.refund_failed_later')).map((row) => [row.entity_id, row.details['owed'], row.details['refundId']])).toEqual([[orderId, 15, sent?.id]])
      expect((await stuckList(db)).watched).toMatchObject([{ refundId: sent?.id, on: 'order', orderId, amount: 15, owed: 15, state: 'failed', words: WATCH_WORDS.orderFailed(15, sent?.id as string) }])
      // Once, and never a second send, however many runs follow.
      await Promise.all([runReconcile(), runReconcile()])
      minutes(DAY)
      expect(await refundItems()).toEqual([])
      expect(await order(orderId)).toMatchObject({ owed: '15.00' })
      expect(await creditRefunds()).toEqual([])
      expect(refundsSent(stripe)).toHaveLength(1)
      // Staff decide: Refund the rest is a new refund under a new key.
      const rest = await post('refunds/owed', orderId, { amount: 15, refundMethod: 'card' })
      expect(rest.body.data).toMatchObject({ cardRefundedAmount: 15, storeCreditRefundedAmount: 0, refundOwed: 0 })
      expect(new Set(refundsSent(stripe).map((call) => call.idempotencyKey)).size).toBe(2)
      expect(moneyBack(stripe)).toBe(1500)
    })
  })

  it('a refund to store credit or cash has no card refund: no `refunds` on the finished row, no watch', async () => {
    await onAnOrder({ products: [mug], payment: card }, async ({ orderId, lines }) => {
      await refund(orderId, await lines('product'), 'credit')
      expect((await auditRows('order.refund_finished'))[0]?.details).not.toHaveProperty('refunds')
      expect(await auditRows('refund.watch')).toEqual([])
    })
  })

  it("a claim reconcile finished (the press's answers were lost) with its refund still pending: watched from then, and its failure is owed on the order", async () => {
    await onAnOrder({ products: [mug], payment: card }, async ({ orderId, lines, stripe }) => {
      stripe.refundsStayPending = true
      stripe.failNext('refunds.create', { kind: 'lost_response' })
      stripe.failNext('refunds.create', { kind: 'lost_response' })
      const held = await refund(orderId, await lines('product'), 'card')
      stripe.refundsStayPending = false
      expect(held.body.data?.held).toMatchObject({ reason: 'refund_unconfirmed' })
      expect(await auditRows('refund.watch')).toEqual([])
      pastTheWindow()
      await runReconcile()
      const sent = stripe.refundsSent[0]
      expect((await auditRows('order.refund_finished'))[0]?.details).toMatchObject({ outcome: 'given', cardRefunded: 15, refunds: [{ refundId: sent?.id, status: 'pending' }], by: { how: 'reconcile' } })
      expect((await auditRows('refund.watch')).map((row) => row.details)).toMatchObject([{ state: 'watching', refundId: sent?.id, on: 'order', subjectId: orderId }])
      stripe.settleRefund(sent?.id as string, 'failed')
      await runReconcile()
      expect(await order(orderId)).toMatchObject({ owed: '15.00' })
      expect(refundsSent(stripe)).toHaveLength(2)
      expect(stripe.refundsSent).toHaveLength(1)
    })
  })
})
