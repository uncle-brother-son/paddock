import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type Stripe from 'stripe'
import type { Db } from '@/server/db'
import { fakeStripeErrors, type FakeStripe } from '@/server/stripe/fake'
import { asWorkerFlow, postFlowStep } from '@/server/rules/testing/replay/flow-side'
import { oldSide, replay, startReplay, type ReplayEnvironment, type ReplaySide } from '@/server/rules/testing/replay/harness'
import { ID, lapsedSeat, publicOnCard, seed, whileFailing } from '@/server/rules/testing/replay/scenarios'
import { replayStripe } from '@/server/rules/testing/replay/stripe-binding'
import {
  FLOW_CHARGED_WITHOUT_RECORD_MESSAGE,
  FLOW_INTENT_UNCONFIRMED_MESSAGE,
  FLOW_PAID_NOT_FINISHED_MESSAGE,
  FLOW_UNDO_INCOMPLETE_MESSAGE,
  finaliseFlowInTransaction,
  OLD_READER_FLOW_MESSAGE,
  undoFlowInTransaction,
  type CancelFlowOutput,
  type FinaliseFlowOutput,
} from './reader-flow'
import { otherModeMessage } from './reader-order'

// W12 item 2: the reader flows' finalise and cancel through the new routes, on PGlite with the live schema
// and the replay seed, FakeStripe for Stripe. A flow is started by the old function (as every flow is until
// step D) and given what step D's Worker start writes (asWorkerFlow). The replay (flow-replay.test.ts) holds
// every recorded flow to the old functions; this file holds what differs by decision, the refusals, a
// second press, and a failure at each step (each one transaction: R1, R2, bug 12, W5-17).

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))
vi.mock('@/server/stripe/client', async (importOriginal) => {
  const { stripeClientMock } = await import('@/server/rules/testing/replay/stripe-binding')
  return stripeClientMock(await importOriginal<typeof import('@/server/stripe/client')>())
})

let environment: ReplayEnvironment
let db: Db
beforeAll(async () => {
  process.env.STAFF_API_KEY = 'test-staff-api-key'
  environment = await startReplay()
  db = environment.database.db
  holder.db = db
})
afterAll(() => environment.stop())

const actor = { type: 'staff' as const, id: ID.staff }

interface Started {
  pendingId: string
  paymentIntentId: string
  bookingId: string
}

interface Context {
  stripe: FakeStripe
  old: ReplaySide
}

/** Runs `work` on a fresh seed; the routes reach the run's FakeStripe. */
async function onASeed(work: (context: Context) => Promise<void>, prepare?: (seedDb: Db) => Promise<void>): Promise<void> {
  await replay(
    environment,
    {
      name: 'reader flow test',
      async seed(seedDb, stripe) {
        await seed(seedDb, stripe)
        await prepare?.(seedDb)
      },
      async run({ stripe }) {
        replayStripe.current = stripe
        await work({ stripe, old: oldSide(db, stripe) })
        replayStripe.current = stripe
      },
    },
    (_db, stripe) => ({ name: 'test', call: async () => stripe })
  )
}

const withStoreCredit = (seedDb: Db) => seedDb.query('UPDATE customers SET store_credit_balance = 10 WHERE id = $1', [ID.member]).then(() => undefined)

/** Mo's lapsed £20 seat, settled with £5 of store credit and £15 on the reader: started by the old function, as a Worker flow. */
async function startSettle({ old }: Context, { worker = true }: { worker?: boolean } = {}): Promise<Started> {
  const call = (action: string, params: unknown) => old.call(action, params)
  const bookingId = await lapsedSeat(call, db)
  const started = (await old.call('settleLapsedBooking', { bookingId, payment: { method: 'reader', storeCredit: { amount: 5 } } })) as {
    pendingReaderPayment: { pendingId: string; paymentIntentId: string }
  }
  if (worker) await asWorkerFlow(db, started.pendingReaderPayment.pendingId)
  return { ...started.pendingReaderPayment, bookingId }
}

/** Sam's two seats on the card moved to the dearer Peak session: £11 on the reader. */
async function startMove({ old }: Context): Promise<Started> {
  const { bookingId } = (await old.call('createOrder', { customerId: ID.customer, ...publicOnCard })) as { bookingId: string }
  await old.call('moveBooking', { bookingId, newSessionId: ID.peakSession })
  const started = (await old.call('moveBooking', { bookingId, newSessionId: ID.peakSession, confirmed: true, payment: { method: 'reader' } })) as {
    pendingReaderPayment: { pendingId: string; paymentIntentId: string }
  }
  await asWorkerFlow(db, started.pendingReaderPayment.pendingId)
  return { ...started.pendingReaderPayment, bookingId }
}

const finalise = async (pendingId: string, key?: string) => (await postFlowStep('finalise', pendingId, key ? { key } : {})).body as { ok: true; data: FinaliseFlowOutput }
const cancel = async (pendingId: string, key?: string) => (await postFlowStep('cancel', pendingId, key ? { key } : {})).body as { ok: true; data: CancelFlowOutput }

async function figures(bookingId: string) {
  const booking = (await db.query<{ status: string; price_paid: string; session_id: string }>('SELECT status, price_paid::text, session_id FROM bookings WHERE id = $1', [bookingId]))[0]
  const credit = (await db.query<{ n: string }>('SELECT store_credit_balance::text AS n FROM customers WHERE id = $1', [ID.member]))[0]?.n
  const orders = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM orders WHERE payment_method = 'reader'"))[0]?.n
  const lines = (await db.query<{ n: number }>("SELECT count(*)::int AS n FROM order_line_items l JOIN orders o ON o.id = l.order_id WHERE o.payment_method = 'reader'"))[0]?.n
  const sessions = await db.query<{ id: string; total_booked: number }>('SELECT id, total_booked FROM sessions WHERE id = ANY($1::uuid[]) ORDER BY id', [[ID.session, ID.peakSession]])
  return { booking, credit, orders, lines, sessions }
}
const rowOf = async (pendingId: string) =>
  (await db.query<{ status: string; snapshot: Record<string, unknown> }>('SELECT status, snapshot FROM pending_reader_payments WHERE id = $1', [pendingId]))[0]
const flowAudit = async (pendingId: string) =>
  (await db.query<{ action: string }>("SELECT action FROM audit_log WHERE entity_type = 'reader_payment' AND entity_id = $1 ORDER BY at, id", [pendingId])).map((row) => row.action)

describe('a flow the old screens started is refused (old_reader_flow), as W11 refuses the old checkout', () => {
  it('finalise and cancel answer old_reader_flow and change nothing, tapped or not', async () => {
    await onASeed(async (context) => {
      const started = await startSettle(context, { worker: false })
      const before = await figures(started.bookingId)
      expect((await cancel(started.pendingId)).data).toMatchObject({ cancelled: false, reason: 'old_reader_flow', message: OLD_READER_FLOW_MESSAGE })
      context.stripe.completeReaderPayment(started.paymentIntentId)
      expect((await finalise(started.pendingId)).data).toMatchObject({ finalised: false, reason: 'old_reader_flow', message: OLD_READER_FLOW_MESSAGE })
      expect(await figures(started.bookingId)).toEqual(before)
      expect((await rowOf(started.pendingId))?.status).toBe('pending')
      // No Stripe call from the new routes (the old start made the intent).
      expect(context.stripe.calls.map((call) => call.method)).toEqual(['paymentIntents.create'])
    }, withStoreCredit)
  })
})

describe('finalise', () => {
  it('records the payment, its line and the gift card or store credit parts in one transaction, marks the row, and writes reader_payment.finalise', async () => {
    await onASeed(async (context) => {
      const started = await startSettle(context)
      context.stripe.completeReaderPayment(started.paymentIntentId)
      expect((await finalise(started.pendingId)).data).toEqual({ finalised: true, pendingId: started.pendingId, flow: 'settle', recordId: started.bookingId, paymentIntentId: started.paymentIntentId })
      expect(await figures(started.bookingId)).toMatchObject({ booking: { status: 'confirmed', price_paid: '20.00' }, credit: '5.00', orders: 1, lines: 1 })
      expect((await rowOf(started.pendingId))?.status).toBe('finalised')
      expect(await flowAudit(started.pendingId)).toEqual(['reader_payment.finalise'])
    }, withStoreCredit)
  })

  it('twice (bug 12, W5-17): the second finds it finalised and writes nothing; one order for the one payment', async () => {
    await onASeed(async (context) => {
      const started = await startSettle(context)
      context.stripe.completeReaderPayment(started.paymentIntentId)
      await finalise(started.pendingId)
      expect((await finalise(started.pendingId)).data).toMatchObject({ finalised: true, alreadyFinalised: true })
      // And T2 itself, called again with the same payment (as reconcile would), finds it finalised.
      const paymentIntent = await context.stripe.paymentIntents.retrieve(started.paymentIntentId)
      expect(await finaliseFlowInTransaction(db, started.pendingId, paymentIntent, { actor, requestId: 'again' })).toMatchObject({ finalised: true, alreadyFinalised: true })
      expect(await figures(started.bookingId)).toMatchObject({ orders: 1, lines: 1 })
      expect(await flowAudit(started.pendingId)).toEqual(['reader_payment.finalise'])
    }, withStoreCredit)
  })

  it('to the exact penny: a tap a penny over or under is left pending for a person (the old check let 1p through)', async () => {
    for (const pence of [1501, 1499]) {
      await onASeed(async (context) => {
        const started = await startSettle(context)
        context.stripe.completeReaderPayment(started.paymentIntentId, { amount: pence })
        const answer = (await finalise(started.pendingId)).data
        expect(answer).toMatchObject({ finalised: false, reason: 'amount_mismatch' })
        expect(answer.message).toContain(`The reader charged £${(pence / 100).toFixed(2)} but £15.00 was expected`)
        expect((await rowOf(started.pendingId))?.status).toBe('pending')
        expect(await figures(started.bookingId)).toMatchObject({ orders: 0 })
      }, withStoreCredit)
    }
  })

  it("an intent for another Stripe customer, or naming another flow row, is refused: nothing written", async () => {
    await onASeed(async (context) => {
      const started = await startSettle(context)
      context.stripe.completeReaderPayment(started.paymentIntentId)
      await db.query("UPDATE pending_reader_payments SET snapshot = snapshot || '{\"stripe_customer_id\": \"cus_someone_else\"}' WHERE id = $1", [started.pendingId])
      expect((await finalise(started.pendingId)).data).toMatchObject({ finalised: false, reason: 'customer_mismatch' })
      expect(await figures(started.bookingId)).toMatchObject({ orders: 0 })
    }, withStoreCredit)
  })

  it('a database fault in T2 after the tap (R2): nothing written, not the order without its line; held, never refunded; finalise again finishes it once', async () => {
    await onASeed(async (context) => {
      const started = await startSettle(context)
      context.stripe.completeReaderPayment(started.paymentIntentId)
      const answer = await whileFailing(db, { table: 'order_line_items', event: 'INSERT', when: 'true' }, () => finalise(started.pendingId))
      expect(answer.data).toMatchObject({ finalised: false, reason: 'finalise_failed', message: FLOW_PAID_NOT_FINISHED_MESSAGE })
      expect(await figures(started.bookingId)).toMatchObject({ orders: 0, lines: 0 })
      expect((await rowOf(started.pendingId))?.status).toBe('pending')
      expect(context.stripe.refundedPence).toBe(0)
      expect((await finalise(started.pendingId)).data).toMatchObject({ finalised: true })
      expect(await figures(started.bookingId)).toMatchObject({ orders: 1, lines: 1 })
    }, withStoreCredit)
  })

  it('a fault marking the row (bug 12): the payment is not recorded either; finalise again records it once', async () => {
    await onASeed(async (context) => {
      const started = await startSettle(context)
      context.stripe.completeReaderPayment(started.paymentIntentId)
      const answer = await whileFailing(db, { table: 'pending_reader_payments', event: 'UPDATE', when: "NEW.status = 'finalised'" }, () => finalise(started.pendingId))
      expect(answer.data).toMatchObject({ finalised: false, reason: 'finalise_failed' })
      expect(await figures(started.bookingId)).toMatchObject({ orders: 0, lines: 0 })
      await finalise(started.pendingId)
      expect(await figures(started.bookingId)).toMatchObject({ orders: 1, lines: 1 })
    }, withStoreCredit)
  })

  it('a move: the old session gives its places back only at finalise, once', async () => {
    await onASeed(async (context) => {
      const started = await startMove(context)
      const before = await figures(started.bookingId)
      expect(before.sessions).toEqual([
        { id: ID.session, total_booked: 2 },
        { id: ID.peakSession, total_booked: 2 },
      ])
      context.stripe.completeReaderPayment(started.paymentIntentId)
      await finalise(started.pendingId)
      await finalise(started.pendingId)
      expect((await figures(started.bookingId)).sessions).toEqual([
        { id: ID.session, total_booked: 0 },
        { id: ID.peakSession, total_booked: 2 },
      ])
    })
  })

  it('the flow undone while Stripe was read: nothing recorded, reader_payment.charge_without_record kept for the automatic refund', async () => {
    await onASeed(async (context) => {
      const started = await startSettle(context)
      context.stripe.completeReaderPayment(started.paymentIntentId)
      const paymentIntent = (await context.stripe.paymentIntents.retrieve(started.paymentIntentId)) as Stripe.PaymentIntent
      expect(await undoFlowInTransaction(db, started.pendingId, { actor, requestId: 'r', why: 'test' })).toMatchObject({ undone: true })
      vi.setSystemTime(Date.now() + 1_000) // the replay's clock stands still; real time moves between the two
      expect(await finaliseFlowInTransaction(db, started.pendingId, paymentIntent, { actor, requestId: 'r' })).toEqual({ finalised: false, reason: 'charged_without_record' })
      expect(await flowAudit(started.pendingId)).toEqual(['reader_payment.cancel', 'reader_payment.charge_without_record'])
      expect(await figures(started.bookingId)).toMatchObject({ orders: 0, booking: { status: 'payment_needed' } })
      expect(FLOW_CHARGED_WITHOUT_RECORD_MESSAGE).toContain('needs refunding')
    }, withStoreCredit)
  })

  it('a Worker flow held with no intent on its row: finalise and cancel answer intent_unconfirmed (reconcile settles it)', async () => {
    await onASeed(async (context) => {
      const started = await startSettle(context)
      await db.query('UPDATE pending_reader_payments SET payment_intent_id = NULL WHERE id = $1', [started.pendingId])
      expect((await finalise(started.pendingId)).data).toMatchObject({ finalised: false, reason: 'intent_unconfirmed', message: FLOW_INTENT_UNCONFIRMED_MESSAGE })
      expect((await cancel(started.pendingId)).data).toMatchObject({ cancelled: false, reason: 'intent_unconfirmed' })
    }, withStoreCredit)
  })
})

describe('cancel', () => {
  it('cancels the intent, then the undo puts everything back and marks the row, in one transaction', async () => {
    await onASeed(async (context) => {
      const started = await startSettle(context)
      expect((await figures(started.bookingId)).credit).toBe('5.00')
      expect((await cancel(started.pendingId)).data).toMatchObject({ cancelled: true, flow: 'settle', message: 'Payment not taken. The booking payment was undone and nothing was charged.' })
      expect(await figures(started.bookingId)).toMatchObject({ booking: { status: 'payment_needed' }, credit: '10.00', orders: 0 })
      expect((await rowOf(started.pendingId))?.status).toBe('cancelled')
      expect(await flowAudit(started.pendingId)).toEqual(['reader_payment.cancel'])
    }, withStoreCredit)
  })

  it('twice: the second finds it cancelled and gives nothing back again', async () => {
    await onASeed(async (context) => {
      const started = await startSettle(context)
      await cancel(started.pendingId)
      expect((await cancel(started.pendingId)).data).toMatchObject({ cancelled: true, alreadyDone: true })
      expect(await undoFlowInTransaction(db, started.pendingId, { actor, requestId: 'r', why: 'again' })).toEqual({ undone: false, reason: 'already_cancelled' })
      expect((await figures(started.bookingId)).credit).toBe('10.00')
      expect(await flowAudit(started.pendingId)).toEqual(['reader_payment.cancel'])
    }, withStoreCredit)
  })

  it('a fault in the undo (R1, W03a later 1): nothing given back and the row not marked; cancel again gives back once', async () => {
    await onASeed(async (context) => {
      const started = await startSettle(context)
      const answer = await whileFailing(db, { table: 'pending_reader_payments', event: 'UPDATE', when: "NEW.status = 'cancelled'" }, () => cancel(started.pendingId))
      expect(answer.data).toMatchObject({ cancelled: false, reason: 'undo_incomplete', message: FLOW_UNDO_INCOMPLETE_MESSAGE })
      expect(await figures(started.bookingId)).toMatchObject({ booking: { status: 'confirmed' }, credit: '5.00' })
      expect((await rowOf(started.pendingId))?.status).toBe('pending')
      await cancel(started.pendingId)
      expect(await figures(started.bookingId)).toMatchObject({ booking: { status: 'payment_needed' }, credit: '10.00' })
    }, withStoreCredit)
  })

  it('the tap had gone through: finalised instead, with the payment just read (one read fewer than the old function)', async () => {
    await onASeed(async (context) => {
      const started = await startSettle(context)
      context.stripe.completeReaderPayment(started.paymentIntentId)
      const answer = (await cancel(started.pendingId)).data
      expect(answer).toMatchObject({ cancelled: false, finalisedInstead: true, finaliseResult: { finalised: true }, message: 'The reader payment actually succeeded — the booking payment was completed instead of cancelled.' })
      expect(context.stripe.calls.map((call) => call.method)).toEqual(['paymentIntents.create', 'paymentIntents.retrieve'])
      expect(await figures(started.bookingId)).toMatchObject({ orders: 1, credit: '5.00' })
    }, withStoreCredit)
  })

  it('unclear from Stripe, or a 404 from a key of the other mode: nothing changes', async () => {
    await onASeed(async (context) => {
      const started = await startSettle(context)
      context.stripe.failNext('paymentIntents.retrieve', { kind: 'error', error: fakeStripeErrors.server() })
      expect((await cancel(started.pendingId)).data).toMatchObject({ cancelled: false, reason: 'stripe_error' })
      context.stripe.keyLivemode = true
      expect((await cancel(started.pendingId)).data).toMatchObject({ cancelled: false, reason: 'stripe_error', message: otherModeMessage(started.paymentIntentId) })
      expect(await figures(started.bookingId)).toMatchObject({ booking: { status: 'confirmed' }, credit: '5.00' })
      context.stripe.keyLivemode = false
      expect((await cancel(started.pendingId)).data).toMatchObject({ cancelled: true })
    }, withStoreCredit)
  })

  it('a move cancelled: the new session gives its places back, the booking goes back to the old session, the old session keeps its places', async () => {
    await onASeed(async (context) => {
      const started = await startMove(context)
      await cancel(started.pendingId)
      const after = await figures(started.bookingId)
      expect(after.booking).toMatchObject({ session_id: ID.session, price_paid: '40.00', status: 'confirmed' })
      expect(after.sessions).toEqual([
        { id: ID.session, total_booked: 2 },
        { id: ID.peakSession, total_booked: 0 },
      ])
    })
  })

  it('finalise after the cancel: refused as cancelled, nothing read from Stripe', async () => {
    await onASeed(async (context) => {
      const started = await startSettle(context)
      await cancel(started.pendingId)
      const calls = context.stripe.calls.length
      expect((await finalise(started.pendingId)).data).toMatchObject({ finalised: false, reason: 'unexpected_state', message: 'This pending payment was already cancelled.' })
      expect(context.stripe.calls.length).toBe(calls)
    }, withStoreCredit)
  })
})
