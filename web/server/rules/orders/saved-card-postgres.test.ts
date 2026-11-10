import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type Stripe from 'stripe'
import type { PlaceOrderInput } from '@/contracts'
import type { Db, Tx } from '@/server/db'
import { deferred, Refused, waitingOn } from '@/server/rules/testing/race'
import { fixtures, insert } from '@/server/rules/testing/database'
import { startRealPostgres, type RealPostgres } from '@/server/rules/testing/real-postgres'
import { FakeStripe } from '@/server/stripe/fake'
import { collectSavedCard, type PendingCharge } from './collect-saved-card'
import { finaliseOrder } from './finalise-order'
import { refusalDetails } from './order-refusal'
import type { CardSnapshot } from './pending-order'
import { placeOrder } from './place-order'
import { undoOrder } from './undo-order'

// W10 on real Postgres 17.6, with Worker clients on separate connections: T2 and the one undo racing
// on one order, and W03-decisions Q10's guard with two card orders for one customer at once. Each
// race holds one side open until Postgres reports the other waiting on it, so none can pass by timing.

let pg: RealPostgres
let first: Db
let second: Db
let third: Db

beforeAll(async () => {
  pg = await startRealPostgres()
  first = pg.connect()
  second = pg.connect()
  third = pg.connect()
})
afterAll(() => pg.stop())

let product: string
let staffId: string
beforeAll(async () => {
  const soap = await insert(first, 'products', { name: 'Soap', base_price: '12.00', fulfillment_method: 'pickup' })
  product = await insert(first, 'product_variants', { product_id: soap, sku: `SOAP-${crypto.randomUUID()}`, stock_quantity: 10_000 })
  staffId = await insert(first, 'staff', { role: 'staff', first_name: 'Jo', last_name: 'Staff', email: 'w10-race@example.com' })
})

const asStaff = () => ({ actor: { type: 'staff' as const, id: staffId }, requestId: 'w10-race' })

/** A customer with a saved card, known to `stripe`. */
async function cardCustomer(stripe: FakeStripe): Promise<string> {
  const stripeId = `cus_${crypto.randomUUID().slice(0, 8)}`
  stripe.addCustomer(stripeId)
  return fixtures.customer(first, { stripe_customer_id: stripeId, saved_payment_method_id: 'pm_saved' })
}

/** Two soaps on the saved card: £24. */
const soapsOnCard = (customerId: string): PlaceOrderInput => ({
  customerId,
  products: [{ productVariantId: product, quantity: 2 }],
  payment: { method: 'card' },
  confirmed: { toCollect: 24 },
})

const stockNow = async () => (await first.query<{ n: number }>('SELECT stock_quantity AS n FROM product_variants WHERE id = $1', [product]))[0]?.n

/** A pending card order with nothing charged yet: Stripe unreachable twice, so it is held (PAYMENT_UNCONFIRMED). */
async function pendingOrder(stripe: FakeStripe, customerId: string): Promise<PendingCharge> {
  stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
  stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
  await expect(placeOrder(first, soapsOnCard(customerId), { ...asStaff(), stripe: () => stripe })).rejects.toMatchObject({ code: 'PAYMENT_UNCONFIRMED' })
  const rows = await first.query<{ id: string; reader_payment: CardSnapshot }>(
    `SELECT id, reader_payment FROM orders WHERE customer_id = $1 AND payment_status = 'pending'`,
    [customerId]
  )
  const row = rows[0]
  if (!row) throw new Error('no pending order')
  return { orderId: row.id, customerId, snapshot: row.reader_payment }
}

/** The charge Stripe made for it, as T2 is given it. */
async function charged(stripe: FakeStripe, charge: PendingCharge): Promise<Stripe.PaymentIntent> {
  const answer = await collectSavedCard(first, stripe, charge)
  if (answer.outcome !== 'answered') throw new Error('not charged')
  return answer.paymentIntent
}

/** Waits until Postgres reports a session blocked by `holder`, and returns it. */
async function blockedBy(holder: number): Promise<number> {
  const giveUpAt = Date.now() + 4_000
  while (Date.now() < giveUpAt) {
    const rows = await pg.admin.unsafe<{ pid: number }[]>('SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))', [holder])
    if (rows[0]) return rows[0].pid
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Nothing waited on the holder.')
}

/** `work` inside a transaction on `db` (T2 and the undo join it), held open after it until finished. */
async function holding<T>(db: Db, work: (tx: Tx) => Promise<T>) {
  const release = deferred()
  let end: 'commit' | 'rollback' = 'commit'
  let announce: (value: { pid: number; result: T }) => void = () => {}
  const ready = new Promise<{ pid: number; result: T }>((resolve) => {
    announce = resolve
  })
  const done = db
    .transaction(async (tx) => {
      const result = await work(tx)
      announce({ pid: (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]?.pid as number, result })
      await release.promise
      if (end === 'rollback') throw new Refused('holder_rolled_back')
    })
    .catch((err: unknown) => {
      if (!(err instanceof Refused)) throw err
    })
  const { pid, result } = await Promise.race([ready, done.then(() => Promise.reject(new Error('The holder ended early.')))])
  return {
    pid,
    result,
    async finish(how: 'commit' | 'rollback') {
      end = how
      release.resolve()
      await done
    },
  }
}

const reconcile = { actor: { type: 'system' as const, id: null }, requestId: 'w10-race' }
const orderStatus = async (orderId: string) => (await first.query<{ payment_status: string }>('SELECT payment_status FROM orders WHERE id = $1', [orderId]))[0]?.payment_status ?? 'gone'

describe('T2 and the undo racing on one order', () => {
  it('T2 first: the undo waits on the order, then finds it paid and refuses; nothing given back', async () => {
    const stripe = new FakeStripe()
    const charge = await pendingOrder(stripe, await cardCustomer(stripe))
    const paymentIntent = await charged(stripe, charge)
    const t2 = await holding(first, () => finaliseOrder(first, charge.orderId, paymentIntent, reconcile))
    expect(t2.result).toEqual({ finalised: true, alreadyPaid: false, cardSaved: false })
    const undo = undoOrder(second, charge.orderId, { ...reconcile, why: 'race' })
    const waiter = await blockedBy(t2.pid)
    expect(await waitingOn(pg, waiter)).toEqual(['orders'])
    const stock = await stockNow()
    await t2.finish('commit')
    expect(await undo).toEqual({ undone: false, reason: 'paid' })
    expect(await orderStatus(charge.orderId)).toBe('paid')
    expect(await stockNow()).toBe(stock)
  })

  it('the undo first: T2 waits on the order, then finds it gone, writes nothing but the record of a charge with no order', async () => {
    const stripe = new FakeStripe()
    const charge = await pendingOrder(stripe, await cardCustomer(stripe))
    const paymentIntent = await charged(stripe, charge)
    const stock = await stockNow()
    const undo = await holding(first, () => undoOrder(first, charge.orderId, { ...reconcile, why: 'race' }))
    expect(undo.result).toEqual({ undone: true })
    const t2 = finaliseOrder(second, charge.orderId, paymentIntent, reconcile)
    const waiter = await blockedBy(undo.pid)
    expect(await waitingOn(pg, waiter)).toEqual(['orders'])
    await undo.finish('commit')
    expect(await t2).toEqual({ finalised: false, reason: 'order_gone' })
    expect(await orderStatus(charge.orderId)).toBe('gone')
    expect(await stockNow()).toBe((stock ?? 0) + 2)
    const kept = await first.query<{ action: string }>(`SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY at`, [charge.orderId])
    expect(kept.map((row) => row.action)).toEqual(['order.create', 'order.undo', 'order.charge_without_order'])
  })

  it('a T2 that rolls back leaves the order to the undo, which then gives everything back', async () => {
    const stripe = new FakeStripe()
    const charge = await pendingOrder(stripe, await cardCustomer(stripe))
    const paymentIntent = await charged(stripe, charge)
    const stock = await stockNow()
    const t2 = await holding(first, () => finaliseOrder(first, charge.orderId, paymentIntent, reconcile))
    const undo = undoOrder(second, charge.orderId, { ...reconcile, why: 'race' })
    await blockedBy(t2.pid)
    await t2.finish('rollback')
    expect(await undo).toEqual({ undone: true })
    expect(await stockNow()).toBe((stock ?? 0) + 2)
  })

  it('two undos at once: one gives back, the other finds the order gone; given back once', async () => {
    const stripe = new FakeStripe()
    const charge = await pendingOrder(stripe, await cardCustomer(stripe))
    const stock = await stockNow()
    const one = await holding(first, () => undoOrder(first, charge.orderId, { ...reconcile, why: 'race' }))
    const other = undoOrder(second, charge.orderId, { ...reconcile, why: 'race' })
    await blockedBy(one.pid)
    await one.finish('commit')
    expect(await other).toEqual({ undone: false, reason: 'gone' })
    expect(await stockNow()).toBe((stock ?? 0) + 2)
  })

  it('has exactly one outcome in every free-running race (30 rounds): paid and not undone, or undone and not paid', async () => {
    for (let round = 0; round < 30; round += 1) {
      const stripe = new FakeStripe()
      const customer = await cardCustomer(stripe)
      const charge = await pendingOrder(stripe, customer)
      const paymentIntent = await charged(stripe, charge)
      const stock = await stockNow()
      const [t2, undo] = await Promise.all([
        finaliseOrder(first, charge.orderId, paymentIntent, reconcile),
        undoOrder(second, charge.orderId, { ...reconcile, why: 'race' }),
      ])
      const status = await orderStatus(charge.orderId)
      if (status === 'paid') {
        expect(t2).toEqual({ finalised: true, alreadyPaid: false, cardSaved: false })
        expect(undo).toEqual({ undone: false, reason: 'paid' })
        expect(await stockNow()).toBe(stock)
      } else {
        expect(status).toBe('gone')
        expect(undo).toEqual({ undone: true })
        expect(t2).toEqual({ finalised: false, reason: 'order_gone' })
        expect(await stockNow()).toBe((stock ?? 0) + 2)
      }
    }
  })
})

describe("Q10's guard with two card orders for one customer at once", () => {
  /** A Stripe whose charge waits for `gate`: the order is committed pending and stays so meanwhile. */
  function gated(stripe: FakeStripe, gate: Promise<void>): FakeStripe {
    const create = stripe.paymentIntents.create
    stripe.paymentIntents.create = async (params, options) => {
      await gate
      return create(params, options)
    }
    return stripe
  }

  async function outcome(db: Db, input: PlaceOrderInput, stripe: FakeStripe): Promise<string> {
    try {
      await placeOrder(db, input, { ...asStaff(), stripe: () => stripe })
      return 'paid'
    } catch (err) {
      return refusalDetails(err)?.reason ?? String(err)
    }
  }

  it('both wait on the customer; whichever goes first commits pending, and the other, reading after it, is refused', async () => {
    const stripe = new FakeStripe()
    const gate = deferred()
    gated(stripe, gate.promise)
    const customer = await cardCustomer(stripe)
    const holder = await holding(third, (tx) => tx.query('SELECT id FROM customers WHERE id = $1 FOR NO KEY UPDATE', [customer]))
    const one = outcome(first, soapsOnCard(customer), stripe)
    const firstWaiter = await blockedBy(holder.pid)
    expect(await waitingOn(pg, firstWaiter)).toEqual(['customers'])
    const other = outcome(second, soapsOnCard(customer), stripe)
    // Both queue on the customer: the first behind the holder, the second behind the first's place in the queue.
    const giveUpAt = Date.now() + 4_000
    while ((await pg.admin.unsafe<{ n: number }[]>('SELECT count(*)::int AS n FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid)) > 0'))[0]?.n !== 2) {
      if (Date.now() > giveUpAt) throw new Error('The second order never queued.')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    await holder.finish('commit')
    // The one that went first is now at the charge, held at the gate with its order pending; the other has been refused.
    const refused = await Promise.race([one, other])
    expect(refused).toBe('order_still_processing')
    gate.resolve()
    expect([await one, await other].sort()).toEqual(['order_still_processing', 'paid'])
    expect(stripe.calls).toHaveLength(1)
    expect(stripe.netPence).toBe(2400)
  })

  it('a cash order for the same customer at the same time is not affected', async () => {
    const stripe = new FakeStripe()
    const gate = deferred()
    gated(stripe, gate.promise)
    const customer = await cardCustomer(stripe)
    const card = outcome(first, soapsOnCard(customer), stripe)
    // Wait until the card order is pending (committed) and held at the charge.
    const giveUpAt = Date.now() + 4_000
    while ((await first.query<{ n: number }>(`SELECT count(*)::int AS n FROM orders WHERE customer_id = $1 AND payment_status = 'pending'`, [customer]))[0]?.n !== 1) {
      if (Date.now() > giveUpAt) throw new Error('The card order never went pending.')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const cash = await outcome(second, { ...soapsOnCard(customer), payment: { method: 'cash' } }, stripe)
    expect(cash).toBe('paid')
    gate.resolve()
    expect(await card).toBe('paid')
  })

  it('in every free-running race (20 rounds) one is charged and the other refused, never two charges', async () => {
    for (let round = 0; round < 20; round += 1) {
      const stripe = new FakeStripe()
      const gate = deferred()
      gated(stripe, gate.promise)
      const customer = await cardCustomer(stripe)
      const one = outcome(first, soapsOnCard(customer), stripe)
      const other = outcome(second, soapsOnCard(customer), stripe)
      // The one charged waits at the gate, its order pending, so the first to settle is the refusal.
      expect(await Promise.race([one, other])).toBe('order_still_processing')
      gate.resolve()
      expect([await one, await other].sort()).toEqual(['order_still_processing', 'paid'])
      expect(stripe.calls).toHaveLength(1)
    }
  })
})

describe("Q10 as changed by W10a: a held Worker card order counts however old; only a card with something to charge is checked", () => {
  const refusedOn = async (db: Db, input: PlaceOrderInput, stripe: FakeStripe) =>
    placeOrder(db, input, { ...asStaff(), stripe: () => stripe }).then(
      () => 'paid',
      (err: unknown) => refusalDetails(err)?.reason ?? String(err)
    )
  const age = (customer: string, minutes: number) =>
    first.query(`UPDATE orders SET created_at = now() - make_interval(mins => $1::int) WHERE customer_id = $2 AND payment_status = 'pending'`, [minutes, customer])

  it('held 16 minutes on (review R2) and three hours on: a card order on another connection is refused, nothing charged', async () => {
    const stripe = new FakeStripe()
    const customer = await cardCustomer(stripe)
    await pendingOrder(stripe, customer)
    for (const minutes of [16, 180]) {
      await age(customer, minutes)
      expect(await refusedOn(second, soapsOnCard(customer), stripe)).toBe('order_still_processing')
    }
    // Only the held order's two sends, both unreachable.
    expect(stripe.calls).toHaveLength(2)
    expect(stripe.netPence).toBe(0)
  })

  it('nothing on the card while one is held: goes through on another connection, with no Stripe call', async () => {
    const stripe = new FakeStripe()
    const customer = await cardCustomer(stripe)
    await pendingOrder(stripe, customer)
    await first.query('UPDATE customers SET store_credit_balance = 30 WHERE id = $1', [customer])
    const creditPays: PlaceOrderInput = { ...soapsOnCard(customer), payment: { method: 'card', storeCredit: { amount: 24 } }, confirmed: { toCollect: 0 } }
    expect(await refusedOn(second, creditPays, stripe)).toBe('paid')
    expect(stripe.calls).toHaveLength(2)
  })

  it('any other pending order counts for 15 minutes only: refused at 14, through at 16', async () => {
    const stripe = new FakeStripe()
    const customer = await cardCustomer(stripe)
    await insert(first, 'orders', { customer_id: customer, order_total: '10.00', payment_status: 'pending', order_source: 'staff_created' })
    await age(customer, 14)
    expect(await refusedOn(second, soapsOnCard(customer), stripe)).toBe('order_still_processing')
    await age(customer, 16)
    expect(await refusedOn(second, soapsOnCard(customer), stripe)).toBe('paid')
    expect(stripe.netPence).toBe(2400)
  })
})

describe('the undo keeps LOCK_ORDER: the order, then what it gives back to', () => {
  it('with a T1 holding the customer, the undo (holding the order) waits on the customer, and both finish', async () => {
    const stripe = new FakeStripe()
    const customer = await cardCustomer(stripe)
    const charge = await pendingOrder(stripe, customer)
    const holder = await holding(third, (tx) => tx.query('SELECT id FROM customers WHERE id = $1 FOR NO KEY UPDATE', [customer]))
    const undo = undoOrder(second, charge.orderId, { ...reconcile, why: 'race' })
    const waiter = await blockedBy(holder.pid)
    expect(await waitingOn(pg, waiter)).toEqual(['customers'])
    await holder.finish('commit')
    expect(await undo).toEqual({ undone: true })
  })

  it('an undo and cash orders on the same customer and product never deadlock (30 free-running rounds)', async () => {
    for (let round = 0; round < 30; round += 1) {
      const stripe = new FakeStripe()
      const customer = await cardCustomer(stripe)
      const charge = await pendingOrder(stripe, customer)
      const cash = { ...soapsOnCard(customer), payment: { method: 'cash' } }
      const [undone, placedInCash] = await Promise.all([
        undoOrder(second, charge.orderId, { ...reconcile, why: 'race' }),
        placeOrder(first, cash, asStaff()).then(() => 'paid'),
      ])
      expect(undone).toEqual({ undone: true })
      expect(placedInCash).toBe('paid')
    }
  })
})
