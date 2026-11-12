import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Db } from '@/server/db'
import { readFlow, type FlowRow } from '@/server/rules/orders/reader-flow'
import { postFlowStep } from '@/server/rules/testing/replay/flow-side'
import { oldSide, replay, startReplay, type ReplayEnvironment, type Scenario, type ScenarioContext } from '@/server/rules/testing/replay/harness'
import { bea, ID, lapsedSeat, publicOnCard, seed, sessionsToMoveBetween, whileFailing } from '@/server/rules/testing/replay/scenarios'
import { fakeStripeErrors, type FakeStripe } from '@/server/stripe/fake'
import { READER_PAYMENT_OPEN_MESSAGE, CARD_FLOW_CHARGED_WITHOUT_RECORD_MESSAGE, CARD_FLOW_PAID_NOT_FINISHED_MESSAGE, CHANGE_PAYMENT_UNCONFIRMED_MESSAGE, NOT_A_READER_FLOW_MESSAGE } from './failure-messages'
import { chargeCardFlow, flowChargeKey, settleCardFlow, undoCardFlow, writeFlowRecord, type CardFlowSnapshot } from './flow'

// W17 brief item 3: a booking change paid on the saved card is a flow with `method: 'card'`. Its C2 and undo are W12's
// flow finalise and undo; the charge is keyed from the record's id with `metadata.pending_id`. These run on PGlite with
// the replay's seed: the change itself is started by the frozen old function on the reader (its C1 writes the same
// record and holds the same claims a card flow's will), then made a Worker card flow, as W19 to W24's C1 will write it.
// Real Postgres races are in flow-postgres.test.ts.

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/server/db/connection', () => ({ openRequestDb: () => holder.db as Db, closeRequestDb: () => {} }))
vi.mock('@/server/stripe/client', async (importOriginal) => {
  const { stripeClientMock } = await import('@/server/rules/testing/replay/stripe-binding')
  return stripeClientMock(await importOriginal<typeof import('@/server/stripe/client')>())
})

const actor = { actor: { type: 'staff' as const, id: ID.staff }, requestId: 'w17-card-flow' }
type Pending = { pendingReaderPayment?: { pendingId: string } }

/** What a card flow's C1 writes onto the record, written onto the old start's (W19 to W24 write it themselves). */
async function asCardFlow(db: Db, pendingId: string): Promise<void> {
  await db.query(
    `UPDATE pending_reader_payments p
     SET payment_intent_id = NULL,
         snapshot = p.snapshot || jsonb_build_object('method', 'card', 'channel', 'staff', 'request_id', 'w17-card-flow',
                                                     'stripe_customer_id', c.stripe_customer_id, 'payment_method_id', c.saved_payment_method_id,
                                                     'livemode', false)
     FROM customers c
     WHERE p.id = $1::uuid AND c.id = (p.snapshot->>'customer_id')::uuid`,
    [pendingId]
  )
}

async function rows(db: Db, sql: string, params: unknown[] = []) {
  return db.query<Record<string, unknown>>(sql, params as never)
}

/** Mo's lapsed £20 seat settled with £5 of store credit and £15 on the card: the flow's record, pending. */
async function settleFlow({ call, db }: ScenarioContext): Promise<{ bookingId: string; pendingId: string }> {
  await db.query('UPDATE customers SET store_credit_balance = 10 WHERE id = $1', [ID.member])
  const bookingId = await lapsedSeat(call, db)
  const started = (await call('settleLapsedBooking', { bookingId, payment: { method: 'reader', storeCredit: { amount: 5 } } })) as Pending
  const pendingId = started.pendingReaderPayment?.pendingId as string
  await asCardFlow(db, pendingId)
  return { bookingId, pendingId }
}

/** Sam's two £20 seats moved to the £25.50 Peak session: £11 on the card. */
async function moveFlow({ call, db }: ScenarioContext): Promise<{ bookingId: string; pendingId: string }> {
  const { bookingId } = (await call('createOrder', { customerId: ID.customer, ...publicOnCard })) as { bookingId: string }
  await call('moveBooking', { bookingId, newSessionId: ID.peakSession })
  const started = (await call('moveBooking', { bookingId, newSessionId: ID.peakSession, confirmed: true, payment: { method: 'reader' } })) as Pending
  const pendingId = started.pendingReaderPayment?.pendingId as string
  await asCardFlow(db, pendingId)
  return { bookingId, pendingId }
}

/** Bea added to Sam's booking at £20 on the card. */
async function addGuestFlow({ call, db }: ScenarioContext): Promise<{ bookingId: string; pendingId: string }> {
  const { bookingId } = (await call('createOrder', { customerId: ID.customer, ...publicOnCard })) as { bookingId: string }
  await call('addBookingGuest', { bookingId, ...bea })
  const started = (await call('addBookingGuest', { bookingId, ...bea, payment: { method: 'reader' } })) as Pending
  const pendingId = started.pendingReaderPayment?.pendingId as string
  await asCardFlow(db, pendingId)
  return { bookingId, pendingId }
}

type CardRow = FlowRow & { snapshot: CardFlowSnapshot }

const charges = (stripe: FakeStripe) => stripe.calls.filter((c) => c.method === 'paymentIntents.create' && (c.idempotencyKey ?? '').endsWith(':charge'))

describe('a card flow: charge, C2 and undo (W17)', () => {
  let environment: ReplayEnvironment

  beforeAll(async () => {
    process.env.STAFF_API_KEY = 'test-staff-api-key'
    environment = await startReplay()
    holder.db = environment.database.db
  })
  afterAll(() => environment.stop())

  /** Runs `steps` after the seed, on the old side for whatever the old code does. */
  const run = (name: string, steps: (context: ScenarioContext) => Promise<void>, seedWith: Scenario['seed'] = seed) =>
    replay(environment, { name, seed: seedWith, run: steps }, oldSide)
  const movingSeed: Scenario['seed'] = async (db, stripe) => {
    await seed(db, stripe)
    await sessionsToMoveBetween(db)
  }

  it('Settle: charged once under the record\'s key and metadata, then C2 records it on a card order, in one go', async () => {
    await run('w17-flow-settle', async (context) => {
      const { db, stripe } = context
      const { bookingId, pendingId } = await settleFlow(context)
      const outcome = await settleCardFlow(db, stripe, pendingId, actor)
      expect(outcome).toMatchObject({ outcome: 'finished', pendingId, alreadyFinished: false })
      const charge = charges(stripe)
      expect(charge).toHaveLength(1)
      expect(charge[0]).toMatchObject({
        idempotencyKey: `${pendingId}:charge`,
        params: { amount: 1500, currency: 'gbp', customer: 'cus_member', payment_method: 'pm_member', off_session: true, confirm: true, metadata: { flow: 'settle', record_id: bookingId, pending_id: pendingId } },
      })
      expect(flowChargeKey(pendingId)).toBe(`${pendingId}:charge`)
      const row = await readFlow(db, pendingId)
      expect(row).toMatchObject({ status: 'finalised', payment_intent_id: outcome.outcome === 'finished' ? outcome.paymentIntentId : 'x' })
      const [order] = await rows(db, "SELECT payment_method, payment_status, order_total::text AS total, stripe_payment_intent_id FROM orders WHERE stripe_payment_intent_id = $1", [row?.payment_intent_id])
      expect(order).toMatchObject({ payment_method: 'card', payment_status: 'paid', total: '15.00' })
      const [line] = await rows(db, "SELECT item_type, line_total::text AS total, booking_id FROM order_line_items oli JOIN orders o ON o.id = oli.order_id WHERE o.stripe_payment_intent_id = $1", [row?.payment_intent_id])
      expect(line).toMatchObject({ item_type: 'booking', total: '15.00', booking_id: bookingId })
      const [booking] = await rows(db, 'SELECT status, price_paid::text AS paid FROM bookings WHERE id = $1', [bookingId])
      expect(booking).toMatchObject({ status: 'confirmed', paid: '20.00' })
      expect(stripe.netPence).toBe(1500)
      // Again (a second press, or reconcile): nothing more is charged or written.
      expect(await settleCardFlow(db, stripe, pendingId, actor)).toMatchObject({ outcome: 'finished', alreadyFinished: true, orderId: outcome.outcome === 'finished' ? outcome.orderId : 'x' })
      expect(charges(stripe)).toHaveLength(1)
      expect(await rows(db, "SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY at", [pendingId])).toEqual([{ action: 'reader_payment.finalise' }])
    })
  })

  it('Settle declined: nothing taken, and the one undo puts the booking and the store credit back, with the old words', async () => {
    await run('w17-flow-settle-declined', async (context) => {
      const { db, stripe } = context
      const { bookingId, pendingId } = await settleFlow(context)
      stripe.failNext('paymentIntents.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
      expect(await settleCardFlow(db, stripe, pendingId, actor)).toEqual({
        outcome: 'declined', pendingId, message: 'Failed to charge saved card: Your card was declined.', needsAuthentication: false, stripeCode: 'card_declined', undone: true,
      })
      expect(await rows(db, 'SELECT status, price_paid::text AS paid FROM bookings WHERE id = $1', [bookingId])).toEqual([{ status: 'payment_needed', paid: '0.00' }])
      expect(await rows(db, 'SELECT store_credit_balance::text AS balance FROM customers WHERE id = $1', [ID.member])).toEqual([{ balance: '10.00' }])
      expect((await readFlow(db, pendingId))?.status).toBe('cancelled')
      expect(await rows(db, 'SELECT id FROM orders WHERE payment_method = $1', ['card'])).toEqual([])
      // A new press is a new record with a new key; this record is done.
      expect(await settleCardFlow(db, stripe, pendingId, actor)).toEqual({ outcome: 'not_open', pendingId, state: 'cancelled' })
      expect(stripe.netPence).toBe(0)
    })
  })

  it('needing the customer present is a decline with the old route\'s words', async () => {
    await run('w17-flow-settle-authentication', async (context) => {
      const { db, stripe } = context
      const { pendingId } = await settleFlow(context)
      stripe.failNext('paymentIntents.create', { kind: 'error', error: fakeStripeErrors.authenticationRequired() })
      expect(await settleCardFlow(db, stripe, pendingId, actor)).toMatchObject({
        outcome: 'declined',
        needsAuthentication: true,
        message: 'Card requires additional authentication and cannot be charged off-session. Ask the customer to complete a new payment.',
      })
    })
  })

  it('no clear answer: held, nothing undone (Q35 words); the next try charges nothing more and finishes it', async () => {
    await run('w17-flow-settle-unclear', async (context) => {
      const { db, stripe } = context
      const { bookingId, pendingId } = await settleFlow(context)
      stripe.failNext('paymentIntents.create', { kind: 'lost_response' })
      stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
      expect(await settleCardFlow(db, stripe, pendingId, actor)).toMatchObject({ outcome: 'held', reason: 'payment_unconfirmed', message: CHANGE_PAYMENT_UNCONFIRMED_MESSAGE })
      expect((await readFlow(db, pendingId))?.status).toBe('pending')
      expect(await rows(db, 'SELECT status FROM bookings WHERE id = $1', [bookingId])).toEqual([{ status: 'confirmed' }])
      expect(stripe.netPence).toBe(1500)
      expect(await settleCardFlow(db, stripe, pendingId, actor)).toMatchObject({ outcome: 'finished', alreadyFinished: false })
      expect(stripe.netPence).toBe(1500)
      expect(new Set(charges(stripe).map((call) => call.idempotencyKey))).toEqual(new Set([`${pendingId}:charge`]))
    })
  })

  it('a crash after the charge and before C2: the next run gets the same payment back and finishes it, once', async () => {
    await run('w17-flow-settle-crash-after-charge', async (context) => {
      const { db, stripe } = context
      const { pendingId } = await settleFlow(context)
      const row = await readFlow(db, pendingId)
      const first = await chargeCardFlow(stripe, row as CardRow)
      expect(first.outcome).toBe('answered')
      // The press dies here. Reconcile (W19) or a second press runs the same steps from the record.
      const outcome = await settleCardFlow(db, stripe, pendingId, actor)
      expect(outcome).toMatchObject({ outcome: 'finished', paymentIntentId: first.outcome === 'answered' ? first.paymentIntent.id : 'x' })
      expect(stripe.netPence).toBe(1500)
      expect(await rows(db, "SELECT count(*)::int AS n FROM orders WHERE payment_method = 'card' AND customer_id = $1", [ID.member])).toEqual([{ n: 1 }])
    })
  })

  it('a crash after C1, before anything is sent: the record alone is enough to finish it', async () => {
    await run('w17-flow-settle-crash-after-c1', async (context) => {
      const { db, stripe } = context
      const { pendingId } = await settleFlow(context)
      expect(stripe.netPence).toBe(0)
      expect(await settleCardFlow(db, stripe, pendingId, actor)).toMatchObject({ outcome: 'finished' })
      expect(stripe.netPence).toBe(1500)
    })
  })

  it('C2 failing after the card paid: held (never refunded, W6-3), nothing written; the next run finishes it with no second charge', async () => {
    await run('w17-flow-settle-c2-fails', async (context) => {
      const { db, stripe } = context
      const { pendingId } = await settleFlow(context)
      const held = await whileFailing(db, { table: 'orders', event: 'INSERT', when: 'true' }, () => settleCardFlow(db, stripe, pendingId, actor))
      expect(held).toMatchObject({ outcome: 'held', reason: 'paid_not_finished', message: CARD_FLOW_PAID_NOT_FINISHED_MESSAGE })
      expect(await rows(db, "SELECT count(*)::int AS n FROM orders WHERE payment_method = 'card'")).toEqual([{ n: 0 }])
      expect((await readFlow(db, pendingId))?.status).toBe('pending')
      expect(await settleCardFlow(db, stripe, pendingId, actor)).toMatchObject({ outcome: 'finished' })
      expect(stripe.netPence).toBe(1500)
      expect(charges(stripe)).toHaveLength(2)
      expect(new Set(charges(stripe).map((call) => call.idempotencyKey)).size).toBe(1)
    })
  })

  it('a charge that lands on a flow already undone is kept for reconcile\'s refund, and the undo is not reversed', async () => {
    await run('w17-flow-settle-charged-after-undo', async (context) => {
      const { db, stripe } = context
      const { bookingId, pendingId } = await settleFlow(context)
      const row = await readFlow(db, pendingId)
      expect(await undoCardFlow(db, pendingId, { ...actor, why: 'test' })).toEqual({ undone: true, problems: [] })
      // The charge went out before the undo committed (a press racing reconcile's undo).
      const charge = await chargeCardFlow(stripe, row as CardRow)
      expect(charge.outcome).toBe('answered')
      const { finaliseFlowInTransaction } = await import('@/server/rules/orders/reader-flow')
      if (charge.outcome !== 'answered') throw new Error('not charged')
      expect(await finaliseFlowInTransaction(db, pendingId, charge.paymentIntent, actor)).toEqual({ finalised: false, reason: 'charged_without_record' })
      expect(await rows(db, "SELECT action FROM audit_log WHERE entity_id = $1 AND action = 'reader_payment.charge_without_record'", [pendingId])).toHaveLength(1)
      expect(await rows(db, 'SELECT status FROM bookings WHERE id = $1', [bookingId])).toEqual([{ status: 'payment_needed' }])
      expect(CARD_FLOW_CHARGED_WITHOUT_RECORD_MESSAGE).toContain('needs refunding')
    })
  })

  it('Move: C2 gives the old session\'s places back and records £11 on a card order; declined, the undo puts it back on the old session', async () => {
    await run('w17-flow-move', async (context) => {
      const { db, stripe } = context
      const { bookingId, pendingId } = await moveFlow(context)
      const places = async () => Object.fromEntries((await rows(db, 'SELECT id, total_booked FROM sessions WHERE id = ANY($1::uuid[])', [[ID.session, ID.peakSession]])).map((r) => [r['id'] === ID.session ? 'core' : 'peak', r['total_booked']]))
      expect(await places()).toEqual({ core: 2, peak: 2 })
      expect(await settleCardFlow(db, stripe, pendingId, actor)).toMatchObject({ outcome: 'finished' })
      expect(await places()).toEqual({ core: 0, peak: 2 })
      expect(await rows(db, 'SELECT session_id, price_paid::text AS paid FROM bookings WHERE id = $1', [bookingId])).toEqual([{ session_id: ID.peakSession, paid: '51.00' }])
      expect(charges(stripe)[0]?.params).toMatchObject({ amount: 1100, metadata: { flow: 'move', record_id: bookingId, pending_id: pendingId } })
    }, movingSeed)
    await run('w17-flow-move-declined', async (context) => {
      const { db, stripe } = context
      const { bookingId, pendingId } = await moveFlow(context)
      stripe.failNext('paymentIntents.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
      expect(await settleCardFlow(db, stripe, pendingId, actor)).toMatchObject({ outcome: 'declined', undone: true })
      expect(await rows(db, 'SELECT session_id, price_paid::text AS paid FROM bookings WHERE id = $1', [bookingId])).toEqual([{ session_id: ID.session, paid: '40.00' }])
      expect(await rows(db, 'SELECT total_booked FROM sessions WHERE id = ANY($1::uuid[]) ORDER BY id', [[ID.session, ID.peakSession]])).toEqual([{ total_booked: 2 }, { total_booked: 0 }])
    }, movingSeed)
  })

  it('Add Guest: C2 records £20 for the guest; declined, the guest and the place go', async () => {
    await run('w17-flow-add-guest', async (context) => {
      const { db, stripe } = context
      const { bookingId, pendingId } = await addGuestFlow(context)
      expect(await settleCardFlow(db, stripe, pendingId, actor)).toMatchObject({ outcome: 'finished' })
      expect(await rows(db, 'SELECT party_size, price_paid::text AS paid FROM bookings WHERE id = $1', [bookingId])).toEqual([{ party_size: 3, paid: '60.00' }])
    })
    await run('w17-flow-add-guest-declined', async (context) => {
      const { db, stripe } = context
      const { bookingId, pendingId } = await addGuestFlow(context)
      stripe.failNext('paymentIntents.create', { kind: 'error', error: fakeStripeErrors.cardDeclined() })
      expect(await settleCardFlow(db, stripe, pendingId, actor)).toMatchObject({ outcome: 'declined', undone: true })
      expect(await rows(db, 'SELECT party_size, price_paid::text AS paid FROM bookings WHERE id = $1', [bookingId])).toEqual([{ party_size: 2, paid: '40.00' }])
      expect(await rows(db, 'SELECT total_booked FROM sessions WHERE id = $1', [ID.session])).toEqual([{ total_booked: 2 }])
    })
  })

  it('held means held: while a card flow is open the old functions refuse the booking, and the reader routes refuse the card flow', async () => {
    await run('w17-flow-held', async (context) => {
      const { db, call, attempt } = context
      const { bookingId, pendingId } = await settleFlow(context)
      const refusal = { reason: 'reader_payment_open' }
      // refundBooking throws its refusal; staff see the words.
      expect(await attempt('refundBooking', { bookingId, refundMethod: 'credit', amount: 5, reason: 'Goodwill' })).toEqual({ thrown: READER_PAYMENT_OPEN_MESSAGE })
      expect(await call('addBookingGuest', { bookingId, ...bea, payment: { method: 'cash', confirmedCashAmount: 20 } })).toMatchObject(refusal)
      for (const step of ['finalise', 'cancel'] as const) {
        const answer = await postFlowStep(step, pendingId)
        expect(answer.body).toMatchObject({ ok: true, data: { reason: 'not_a_reader_flow', message: NOT_A_READER_FLOW_MESSAGE } })
      }
      expect((await readFlow(db, pendingId))?.status).toBe('pending')
    })
  })

  it("writeFlowRecord writes the record pending with no PaymentIntent, as C1 will (bug 14's rule)", async () => {
    await run('w17-flow-record', async ({ db }) => {
      const [booking] = await rows(db, "INSERT INTO bookings (session_id, customer_id, party_size, price_paid, status) VALUES ($1, $2, 1, 20, 'confirmed') RETURNING id", [ID.session, ID.customer])
      const bookingId = booking?.['id'] as string
      const snapshot: CardFlowSnapshot = {
        customer_id: ID.customer,
        description: 'Booking payment',
        booking_id: bookingId,
        method: 'card',
        channel: 'staff',
        request_id: 'req-1',
        stripe_customer_id: 'cus_seed',
        payment_method_id: 'pm_seed',
        livemode: false,
      }
      const pendingId = await db.transaction((tx) => writeFlowRecord(tx, { flow: 'settle', recordId: bookingId, expectedAmount: 15, snapshot }))
      expect(await readFlow(db, pendingId)).toMatchObject({ flow: 'settle', record_id: bookingId, payment_intent_id: null, expected_amount: '15', status: 'pending', snapshot })
    })
  })
})
