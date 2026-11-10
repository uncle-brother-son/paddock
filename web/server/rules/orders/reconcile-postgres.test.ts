import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type Stripe from 'stripe'
import type { PlaceOrderInput } from '@/contracts'
import type { Db, Tx } from '@/server/db'
import { deferred, Refused, waitingOn } from '@/server/rules/testing/race'
import { fixtures, insert } from '@/server/rules/testing/database'
import { startRealPostgres, type RealPostgres } from '@/server/rules/testing/real-postgres'
import { FakeStripe } from '@/server/stripe/fake'
import { finaliseOrder } from './finalise-order'
import { placeOrder } from './place-order'
import { cancelReaderFlow, finaliseFlowInTransaction, finaliseReaderFlow } from './reader-flow'
import { cancelReaderOrder, finaliseReaderOrder } from './reader-order'
import { reconcile, SCHEDULED_LIMITS, type ReconcileOptions } from './reconcile'
import { undoOrder } from './undo-order'

// W12 on real Postgres 17.6, Worker clients on separate connections: reconcile racing the screen's T2, the
// finalise and cancel routes, the undo, and a second reconcile; the reader flows' finalise twice and against
// cancel (bug 12, W5-17); the automatic refund from two runs at once; and migration 022 (one PaymentIntent,
// one order). Held races keep one side open until Postgres reports the other waiting on it; the
// free-running rounds race for real. Every order a test makes is settled by its end, so the next test's
// reconcile finds only its own.

let pg: RealPostgres
let first: Db
let second: Db

beforeAll(async () => {
  pg = await startRealPostgres()
  first = pg.connect()
  second = pg.connect()
})
afterAll(() => pg.stop())

let product: string
let staffId: string
beforeAll(async () => {
  const soap = await insert(first, 'products', { name: 'Soap', base_price: '12.00', fulfillment_method: 'pickup' })
  product = await insert(first, 'product_variants', { product_id: soap, sku: `SOAP-${crypto.randomUUID()}`, stock_quantity: 100_000 })
  staffId = await insert(first, 'staff', { role: 'staff', first_name: 'Jo', last_name: 'Staff', email: 'w12-race@example.com' })
})

const asStaff = () => ({ actor: { type: 'staff' as const, id: staffId }, requestId: 'w12-race' })
const asSystem = { actor: { type: 'system' as const, id: null }, requestId: 'w12-race' }
const runOn = (db: Db, stripe: FakeStripe, options: Partial<ReconcileOptions> = {}) => reconcile(db, stripe, { ...asSystem, ...SCHEDULED_LIMITS, ...options })
const freshStripe = () => new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })

async function customerOf(stripe: FakeStripe): Promise<string> {
  const stripeId = `cus_${crypto.randomUUID().slice(0, 8)}`
  stripe.addCustomer(stripeId)
  return fixtures.customer(first, { stripe_customer_id: stripeId, saved_payment_method_id: `pm_${stripeId}` })
}

const soaps = (customerId: string, method: 'reader' | 'card'): PlaceOrderInput => ({
  customerId,
  products: [{ productVariantId: product, quantity: 2 }],
  payment: { method },
  confirmed: { toCollect: 24 },
})

const stockNow = async () => (await first.query<{ n: number }>('SELECT stock_quantity AS n FROM product_variants WHERE id = $1', [product]))[0]?.n as number
const orderStatus = async (orderId: string) => (await first.query<{ payment_status: string }>('SELECT payment_status FROM orders WHERE id = $1', [orderId]))[0]?.payment_status ?? 'gone'
const actions = async (orderId: string, action: string) =>
  (await first.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_log WHERE entity_id = $1 AND action = $2', [orderId, action]))[0]?.n

/** Past the 15-minute window: the real clock can't be moved, so the order's own times are. */
async function aged(orderId: string): Promise<void> {
  await first.query(
    `UPDATE orders SET created_at = now() - interval '20 minutes',
       reader_payment = jsonb_set(reader_payment, '{created_at}', to_jsonb(now() - interval '20 minutes'))
     WHERE id = $1`,
    [orderId]
  )
}

async function onTheReader(stripe: FakeStripe): Promise<{ orderId: string; intent: string }> {
  const placed = await placeOrder(first, soaps(await customerOf(stripe), 'reader'), { ...asStaff(), stripe: () => stripe })
  if (!placed.pendingReaderPayment) throw new Error('no intent')
  await aged(placed.orderId)
  return { orderId: placed.orderId, intent: placed.pendingReaderPayment.paymentIntentId }
}

/** A card order whose charge went through and whose answer was lost twice: held, the money taken. */
async function heldCard(stripe: FakeStripe): Promise<{ orderId: string }> {
  stripe.failNext('paymentIntents.create', { kind: 'lost_response' })
  stripe.failNext('paymentIntents.create', { kind: 'lost_response' })
  await placeOrder(first, soaps(await customerOf(stripe), 'card'), { ...asStaff(), stripe: () => stripe }).catch(() => undefined)
  const orderId = (await first.query<{ id: string }>("SELECT id FROM orders WHERE payment_status = 'pending' ORDER BY created_at DESC LIMIT 1"))[0]?.id as string
  await aged(orderId)
  return { orderId }
}

async function blockedBy(holder: number): Promise<number> {
  const giveUpAt = Date.now() + 4_000
  while (Date.now() < giveUpAt) {
    const rows = await pg.admin.unsafe<{ pid: number }[]>('SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))', [holder])
    if (rows[0]) return rows[0].pid
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Nothing waited on the holder.')
}

async function holding<T>(db: Db, work: (tx: Tx) => Promise<T>) {
  const release = deferred()
  let announce: (value: { pid: number; result: T }) => void = () => {}
  const ready = new Promise<{ pid: number; result: T }>((resolve) => {
    announce = resolve
  })
  const done = db
    .transaction(async (tx) => {
      const result = await work(tx)
      announce({ pid: (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]?.pid as number, result })
      await release.promise
    })
    .catch((err: unknown) => {
      if (!(err instanceof Refused)) throw err
    })
  const { pid, result } = await Promise.race([ready, done.then(() => Promise.reject(new Error('The holder ended early.')))])
  return {
    pid,
    result,
    async finish() {
      release.resolve()
      await done
    },
  }
}

const retrieved = (stripe: FakeStripe, intent: string): Promise<Stripe.PaymentIntent> => stripe.paymentIntents.retrieve(intent)

afterAll(async () => {
  // Every test settles what it made: nothing is left pending for another file's reconcile.
  expect(await first.query("SELECT id FROM orders WHERE payment_status = 'pending'")).toEqual([])
})

describe("reconcile against the screen's T2", () => {
  it('the screen T2 held: reconcile waits on the order, then finds it paid; one order.paid', async () => {
    const stripe = freshStripe()
    const { orderId, intent } = await onTheReader(stripe)
    stripe.completeReaderPayment(intent)
    const t2 = await holding(first, async () => finaliseOrder(first, orderId, await retrieved(stripe, intent), asSystem))
    const running = runOn(second, stripe)
    const waiter = await blockedBy(t2.pid)
    expect(await waitingOn(pg, waiter)).toEqual(['orders'])
    await t2.finish()
    expect((await running).items).toEqual([expect.objectContaining({ id: orderId, outcome: 'settled_elsewhere' })])
    expect(await actions(orderId, 'order.paid')).toBe(1)
  })

  it('a card order charged with its answer lost: the press T2 and reconcile in 20 free-running rounds, paid once, never undone', async () => {
    for (let round = 0; round < 20; round += 1) {
      const stripe = freshStripe()
      const { orderId } = await heldCard(stripe)
      const intent = [...stripe.chargedByIntent.keys()][0] as string
      const [, ran] = await Promise.all([finaliseOrder(first, orderId, await retrieved(stripe, intent), asStaff()).catch(() => null), runOn(second, stripe)])
      expect(ran.undone, `round ${round}`).toBe(0)
      expect(await orderStatus(orderId), `round ${round}`).toBe('paid')
      expect(await actions(orderId, 'order.paid'), `round ${round}`).toBe(1)
      expect(stripe.calls.filter((call) => call.method === 'paymentIntents.create'), `round ${round}`).toHaveLength(2)
    }
  })
})

describe('reconcile against the finalise and cancel routes, and the undo', () => {
  it('tapped: finalise and reconcile in 30 free-running rounds, paid once and nothing given back', async () => {
    for (let round = 0; round < 30; round += 1) {
      const stripe = freshStripe()
      const stock = await stockNow()
      const { orderId, intent } = await onTheReader(stripe)
      stripe.completeReaderPayment(intent)
      await Promise.all([finaliseReaderOrder(first, stripe, orderId, asStaff()), runOn(second, stripe)])
      expect(await orderStatus(orderId), `round ${round}`).toBe('paid')
      expect(await actions(orderId, 'order.paid'), `round ${round}`).toBe(1)
      expect(await stockNow(), `round ${round}`).toBe(stock - 2)
    }
  })

  it('not tapped: cancel and reconcile in 30 free-running rounds, undone once and never paid', async () => {
    for (let round = 0; round < 30; round += 1) {
      const stripe = freshStripe()
      const stock = await stockNow()
      const { orderId } = await onTheReader(stripe)
      await Promise.all([cancelReaderOrder(first, stripe, orderId, asStaff()), runOn(second, stripe)])
      expect(await orderStatus(orderId), `round ${round}`).toBe('gone')
      expect(await actions(orderId, 'order.undo'), `round ${round}`).toBe(1)
      expect(await stockNow(), `round ${round}`).toBe(stock)
    }
  })

  it('the undo held: reconcile waits on the order, then finds it gone; given back once', async () => {
    const stripe = freshStripe()
    const stock = await stockNow()
    const { orderId, intent } = await onTheReader(stripe)
    await stripe.paymentIntents.cancel(intent)
    const undo = await holding(first, () => undoOrder(first, orderId, { ...asSystem, why: 'race' }))
    const running = runOn(second, stripe)
    const waiter = await blockedBy(undo.pid)
    expect(await waitingOn(pg, waiter)).toEqual(['orders'])
    await undo.finish()
    expect((await running).items).toEqual([expect.objectContaining({ id: orderId, outcome: 'settled_elsewhere' })])
    expect(await stockNow()).toBe(stock)
  })

  it('a second reconcile: two runs at once over tapped, untapped and card orders settle each once', async () => {
    for (let round = 0; round < 10; round += 1) {
      const stripe = freshStripe()
      const stock = await stockNow()
      const tapped = await onTheReader(stripe)
      stripe.completeReaderPayment(tapped.intent)
      const untapped = await onTheReader(stripe)
      const card = await heldCard(stripe)
      await Promise.all([runOn(first, stripe), runOn(second, stripe)])
      expect([await orderStatus(tapped.orderId), await orderStatus(untapped.orderId), await orderStatus(card.orderId)], `round ${round}`).toEqual(['paid', 'gone', 'paid'])
      for (const orderId of [tapped.orderId, card.orderId]) expect(await actions(orderId, 'order.paid'), `round ${round}`).toBe(1)
      expect(await actions(untapped.orderId, 'order.undo'), `round ${round}`).toBe(1)
      expect(await stockNow(), `round ${round}`).toBe(stock - 4)
      expect(stripe.refundedPence, `round ${round}`).toBe(0)
    }
  })

  it('a late payment refunded from two runs at once: one refund at Stripe, one started row', async () => {
    for (let round = 0; round < 10; round += 1) {
      const stripe = freshStripe()
      const { orderId, intent } = await onTheReader(stripe)
      stripe.completeReaderPayment(intent)
      await undoOrder(first, orderId, { ...asSystem, why: 'race' })
      expect(await finaliseOrder(first, orderId, await retrieved(stripe, intent), asSystem)).toEqual({ finalised: false, reason: 'order_gone' })
      await Promise.all([runOn(first, stripe), runOn(second, stripe)])
      expect(stripe.refundedPence, `round ${round}`).toBe(2400)
      const started = await first.query("SELECT 1 FROM audit_log WHERE entity_id = $1 AND action = 'order.reconcile' AND details->'refund'->>'state' = 'started'", [orderId])
      expect(started, `round ${round}`).toHaveLength(1)
      expect(new Set(stripe.calls.filter((call) => call.method === 'refunds.create').map((call) => call.idempotencyKey)), `round ${round}`).toEqual(new Set([`${orderId}:refund-reader`]))
    }
  })
})

// --- The reader flows: one transaction each

let sharedSession: string | null = null
/** One session for every flow's booking (the live schema refuses overlapping bookings in different sessions). */
async function flowSession(): Promise<string> {
  sharedSession ??= await fixtures.session(first, { service_type_id: await fixtures.serviceType(first, {}), capacity: 100_000 })
  return sharedSession
}

/** A Worker settle flow: Mo's lapsed seat confirmed while pending, £5 of store credit taken, £15 on the reader. */
async function settleFlow(stripe: FakeStripe): Promise<{ pendingId: string; intent: string; bookingId: string; customerId: string }> {
  const stripeId = `cus_${crypto.randomUUID().slice(0, 8)}`
  stripe.addCustomer(stripeId)
  const customerId = await fixtures.customer(first, { stripe_customer_id: stripeId, store_credit_balance: '5.00' })
  const session = await flowSession()
  const bookingId = await fixtures.booking(first, { session_id: session, customer_id: customerId, party_size: 1, price_paid: '20', start_time: '2030-06-15 10:00:00+00', end_time: '2030-06-15 11:00:00+00' })
  const intent = await stripe.paymentIntents.create({ amount: 1500, currency: 'gbp', customer: stripeId, metadata: { flow: 'settle', record_id: bookingId } })
  const snapshot = {
    customer_id: customerId,
    description: 'Settle',
    old_status: 'payment_needed',
    old_price_paid: '0',
    amount: 20,
    store_credit_amount: 5,
    method: 'reader',
    channel: 'staff',
    request_id: 'w12-race',
    stripe_customer_id: stripeId,
    livemode: false,
  }
  const pendingId = await insert(first, 'pending_reader_payments', { flow: 'settle', record_id: bookingId, payment_intent_id: intent.id, expected_amount: '15', snapshot, status: 'pending' })
  return { pendingId, intent: intent.id, bookingId, customerId }
}
const flowStatus = async (pendingId: string) => (await first.query<{ status: string }>('SELECT status FROM pending_reader_payments WHERE id = $1', [pendingId]))[0]?.status
const ordersFor = async (intent: string) => (await first.query<{ n: number }>('SELECT count(*)::int AS n FROM orders WHERE stripe_payment_intent_id = $1', [intent]))[0]?.n
const creditOf = async (customerId: string) => (await first.query<{ n: string }>('SELECT store_credit_balance::text AS n FROM customers WHERE id = $1', [customerId]))[0]?.n

describe('reader flows on two connections', () => {
  it('finalise twice at once (bug 12, W5-17), 30 free-running rounds: one order for the one payment, the row finalised', async () => {
    for (let round = 0; round < 30; round += 1) {
      const stripe = freshStripe()
      const flow = await settleFlow(stripe)
      stripe.completeReaderPayment(flow.intent)
      const [a, b] = await Promise.all([finaliseReaderFlow(first, stripe, flow.pendingId, asStaff()), finaliseReaderFlow(second, stripe, flow.pendingId, asStaff())])
      expect([a.finalised, b.finalised], `round ${round}`).toEqual([true, true])
      expect([a.alreadyFinalised, b.alreadyFinalised].filter(Boolean), `round ${round}`).toHaveLength(1)
      expect(await ordersFor(flow.intent), `round ${round}`).toBe(1)
      expect(await flowStatus(flow.pendingId), `round ${round}`).toBe('finalised')
    }
  })

  it('the flow T2 held: a second finalise waits on the flow row, then finds it finalised', async () => {
    const stripe = freshStripe()
    const flow = await settleFlow(stripe)
    stripe.completeReaderPayment(flow.intent)
    const t2 = await holding(first, async () => finaliseFlowInTransaction(first, flow.pendingId, await retrieved(stripe, flow.intent), asStaff()))
    const again = finaliseReaderFlow(second, stripe, flow.pendingId, asStaff())
    const waiter = await blockedBy(t2.pid)
    expect(await waitingOn(pg, waiter)).toEqual(['pending_reader_payments'])
    await t2.finish()
    expect(await again).toMatchObject({ finalised: true, alreadyFinalised: true })
    expect(await ordersFor(flow.intent)).toBe(1)
  })

  it('not tapped: cancel twice at once, 30 rounds: the store credit given back once (R1)', async () => {
    for (let round = 0; round < 30; round += 1) {
      const stripe = freshStripe()
      const flow = await settleFlow(stripe)
      await Promise.all([cancelReaderFlow(first, stripe, flow.pendingId, asStaff()), cancelReaderFlow(second, stripe, flow.pendingId, asStaff())])
      expect(await flowStatus(flow.pendingId), `round ${round}`).toBe('cancelled')
      expect(await creditOf(flow.customerId), `round ${round}`).toBe('10.00')
    }
  })

  it('tapped: finalise and cancel, and reconcile, all at once, 20 rounds: one outcome, one order, nothing given back', async () => {
    for (let round = 0; round < 20; round += 1) {
      const stripe = freshStripe()
      const flow = await settleFlow(stripe)
      stripe.completeReaderPayment(flow.intent)
      await first.query("UPDATE pending_reader_payments SET created_at = now() - interval '20 minutes' WHERE id = $1", [flow.pendingId])
      await Promise.all([finaliseReaderFlow(first, stripe, flow.pendingId, asStaff()), cancelReaderFlow(second, stripe, flow.pendingId, asStaff()), runOn(pg.connect(), stripe)])
      expect(await flowStatus(flow.pendingId), `round ${round}`).toBe('finalised')
      expect(await ordersFor(flow.intent), `round ${round}`).toBe(1)
      expect(await creditOf(flow.customerId), `round ${round}`).toBe('5.00')
    }
  })
})

// --- Migration 022

describe('migration 022: one PaymentIntent, one order', () => {
  it('the index is there, and a second order for one PaymentIntent is refused by the database', async () => {
    const index = await first.query<{ indexdef: string }>("SELECT indexdef FROM pg_indexes WHERE indexname = 'orders_stripe_payment_intent_id_key'")
    expect(index[0]?.indexdef).toBe('CREATE UNIQUE INDEX orders_stripe_payment_intent_id_key ON public.orders USING btree (stripe_payment_intent_id) WHERE (stripe_payment_intent_id IS NOT NULL)')
    const customerId = await fixtures.customer(first, {})
    const row = { customer_id: customerId, order_total: '1', payment_status: 'paid', order_source: 'staff_created', stripe_payment_intent_id: `pi_022_${crypto.randomUUID()}` }
    await insert(first, 'orders', row)
    await expect(insert(first, 'orders', row)).rejects.toThrow(/orders_stripe_payment_intent_id_key/)
    // Orders without a PaymentIntent are as many as ever.
    await insert(first, 'orders', { ...row, stripe_payment_intent_id: null })
    await insert(first, 'orders', { ...row, stripe_payment_intent_id: null })
  })

  it("the reader T2 writes only its own order's intent: another order's paid intent is refused (metadata), nothing written", async () => {
    const stripe = freshStripe()
    const a = await onTheReader(stripe)
    const b = await onTheReader(stripe)
    stripe.completeReaderPayment(a.intent)
    expect(await finaliseOrder(first, b.orderId, await retrieved(stripe, a.intent), asStaff())).toEqual({ finalised: false, reason: 'metadata_mismatch' })
    expect(await ordersFor(a.intent)).toBe(0)
    await finaliseReaderOrder(first, stripe, a.orderId, asStaff())
    expect(await ordersFor(a.intent)).toBe(1)
    await cancelReaderOrder(first, stripe, b.orderId, asStaff())
  })

  it("the flow finalise writes only its own flow's intent: another flow's is refused (metadata), and an intent already on an order makes no second order", async () => {
    const stripe = freshStripe()
    const a = await settleFlow(stripe)
    const b = await settleFlow(stripe)
    stripe.completeReaderPayment(a.intent)
    expect(await finaliseFlowInTransaction(first, b.pendingId, await retrieved(stripe, a.intent), asStaff())).toEqual({ finalised: false, reason: 'metadata_mismatch' })
    // An order already carries a's payment (the old finalise recorded it, then failed to mark the row).
    const customerId = a.customerId
    await insert(first, 'orders', { customer_id: customerId, order_total: '15', payment_status: 'paid', order_source: 'staff_created', payment_method: 'reader', stripe_payment_intent_id: a.intent })
    expect(await finaliseReaderFlow(first, stripe, a.pendingId, asStaff())).toMatchObject({ finalised: true })
    expect(await ordersFor(a.intent)).toBe(1)
    expect(await flowStatus(a.pendingId)).toBe('finalised')
    await cancelReaderFlow(first, stripe, b.pendingId, asStaff())
  })
})
