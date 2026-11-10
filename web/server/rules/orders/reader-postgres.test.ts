import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type Stripe from 'stripe'
import type { PlaceOrderInput, PlaceOrderOutput } from '@/contracts'
import type { Db, Tx } from '@/server/db'
import { deferred, Refused, waitingOn } from '@/server/rules/testing/race'
import { fixtures, insert } from '@/server/rules/testing/database'
import { startRealPostgres, type RealPostgres } from '@/server/rules/testing/real-postgres'
import { FakeStripe } from '@/server/stripe/fake'
import { finaliseOrder } from './finalise-order'
import { refusalDetails } from './order-refusal'
import { placeOrder } from './place-order'
import { cancelReaderOrder, finaliseReaderOrder } from './reader-order'
import { undoOrder } from './undo-order'

// W11 on real Postgres 17.6, with Worker clients on separate connections: finalise twice, cancel twice,
// finalise and cancel racing on one reader order, T2 and the undo on a reader order, and Q10's guard
// with two reader orders for one customer at once. Each held race keeps one side open until Postgres
// reports the other waiting on it, so none can pass by timing; the free-running rounds race for real.

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
  staffId = await insert(first, 'staff', { role: 'staff', first_name: 'Jo', last_name: 'Staff', email: 'w11-race@example.com' })
})

const asStaff = () => ({ actor: { type: 'staff' as const, id: staffId }, requestId: 'w11-race' })

/** A customer with a Stripe customer, known to `stripe`. */
async function readerCustomer(stripe: FakeStripe): Promise<string> {
  const stripeId = `cus_${crypto.randomUUID().slice(0, 8)}`
  stripe.addCustomer(stripeId)
  return fixtures.customer(first, { stripe_customer_id: stripeId })
}

/** Two soaps on the reader: £24, the card saved when asked. */
const soapsOnTheReader = (customerId: string, saveCard = false): PlaceOrderInput => ({
  customerId,
  products: [{ productVariantId: product, quantity: 2 }],
  payment: { method: 'reader', ...(saveCard ? { readerSaveCard: true } : {}) },
  confirmed: { toCollect: 24 },
})

const stockNow = async () => (await first.query<{ n: number }>('SELECT stock_quantity AS n FROM product_variants WHERE id = $1', [product]))[0]?.n as number
const orderStatus = async (orderId: string) => (await first.query<{ payment_status: string }>('SELECT payment_status FROM orders WHERE id = $1', [orderId]))[0]?.payment_status ?? 'gone'
const paidRows = async (orderId: string) =>
  (await first.query<{ n: number }>("SELECT count(*)::int AS n FROM audit_log WHERE entity_id = $1 AND action = 'order.paid'", [orderId]))[0]?.n

/** A reader order placed and waiting for the tap. */
async function onTheReader(stripe: FakeStripe, saveCard = false): Promise<{ orderId: string; intent: string; customerId: string }> {
  const customerId = await readerCustomer(stripe)
  const placed: PlaceOrderOutput = await placeOrder(first, soapsOnTheReader(customerId, saveCard), { ...asStaff(), stripe: () => stripe })
  if (!placed.pendingReaderPayment) throw new Error('no intent')
  return { orderId: placed.orderId, intent: placed.pendingReaderPayment.paymentIntentId, customerId }
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

const asReconcile = { actor: { type: 'system' as const, id: null }, requestId: 'w11-race' }
const retrieved = (stripe: FakeStripe, intent: string): Promise<Stripe.PaymentIntent> => stripe.paymentIntents.retrieve(intent)

describe('finalise twice at once', () => {
  it('the second waits on the order, then finds it paid with the same payment: already finalised, the card saved once', async () => {
    const stripe = new FakeStripe()
    const { orderId, intent, customerId } = await onTheReader(stripe, true)
    stripe.completeReaderPayment(intent, { generatedCard: 'pm_race' })
    const card = { paymentMethodId: 'pm_race', reusable: true, last4: '4242', brand: 'visa' }
    const paymentIntent = await retrieved(stripe, intent)
    const t2 = await holding(first, () => finaliseOrder(first, orderId, paymentIntent, { ...asReconcile, saveCard: card }))
    expect(t2.result).toEqual({ finalised: true, alreadyPaid: false, cardSaved: true })
    const again = finaliseReaderOrder(second, stripe, orderId, asReconcile)
    const waiter = await blockedBy(t2.pid)
    expect(await waitingOn(pg, waiter)).toEqual(['orders'])
    await t2.finish('commit')
    expect(await again).toMatchObject({ finalised: true, alreadyFinalised: true })
    expect(await paidRows(orderId)).toBe(1)
    const saves = await first.query<{ n: number }>("SELECT count(*)::int AS n FROM audit_log WHERE entity_id = $1 AND action = 'customer.card_saved'", [customerId])
    expect(saves[0]?.n).toBe(1)
  })
})

describe('cancel twice at once', () => {
  it('the second waits on the order, then finds it gone: given back once', async () => {
    const stripe = new FakeStripe()
    const stockBefore = await stockNow()
    const { orderId, intent } = await onTheReader(stripe)
    expect(await stockNow()).toBe(stockBefore - 2)
    await stripe.paymentIntents.cancel(intent)
    const undo = await holding(first, () => undoOrder(first, orderId, { ...asReconcile, why: 'race' }))
    expect(undo.result).toEqual({ undone: true })
    const again = cancelReaderOrder(second, stripe, orderId, asReconcile)
    const waiter = await blockedBy(undo.pid)
    expect(await waitingOn(pg, waiter)).toEqual(['orders'])
    await undo.finish('commit')
    expect(await again).toMatchObject({ cancelled: true, alreadyGone: true })
    expect(await stockNow()).toBe(stockBefore)
  })
})

describe('finalise and cancel racing on one order', () => {
  it('the tap went through: cancel finds it succeeded and finalises instead, waiting on the T2 already running; paid once', async () => {
    const stripe = new FakeStripe()
    const { orderId, intent } = await onTheReader(stripe)
    stripe.completeReaderPayment(intent)
    const t2 = await holding(first, async () => finaliseOrder(first, orderId, await retrieved(stripe, intent), asReconcile))
    const cancelling = cancelReaderOrder(second, stripe, orderId, asReconcile)
    const waiter = await blockedBy(t2.pid)
    expect(await waitingOn(pg, waiter)).toEqual(['orders'])
    await t2.finish('commit')
    expect(await cancelling).toMatchObject({ cancelled: false, finalisedInstead: true, finaliseResult: { finalised: true, alreadyFinalised: true } })
    expect(await orderStatus(orderId)).toBe('paid')
    expect(await paidRows(orderId)).toBe(1)
  })

  it('T2 held, the undo waits on the order, then finds it paid and refuses: nothing given back', async () => {
    const stripe = new FakeStripe()
    const { orderId, intent } = await onTheReader(stripe)
    stripe.completeReaderPayment(intent)
    const stock = await stockNow()
    const t2 = await holding(first, async () => finaliseOrder(first, orderId, await retrieved(stripe, intent), asReconcile))
    const undo = undoOrder(second, orderId, { ...asReconcile, why: 'race' })
    await blockedBy(t2.pid)
    await t2.finish('commit')
    expect(await undo).toEqual({ undone: false, reason: 'paid' })
    expect(await stockNow()).toBe(stock)
  })

  it('the undo held, T2 waits on the order, then finds it gone: nothing marked, the payment recorded as needing a refund', async () => {
    const stripe = new FakeStripe()
    const { orderId, intent } = await onTheReader(stripe)
    stripe.completeReaderPayment(intent)
    const undo = await holding(first, () => undoOrder(first, orderId, { ...asReconcile, why: 'race' }))
    const finalising = finaliseReaderOrder(second, stripe, orderId, asReconcile)
    await blockedBy(undo.pid)
    await undo.finish('commit')
    expect(await finalising).toMatchObject({ finalised: false, reason: 'charged_without_order' })
    const recorded = await first.query<{ action: string }>('SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY at', [orderId])
    expect(recorded.map((row) => row.action)).toEqual(['order.create', 'order.undo', 'order.charge_without_order'])
  })

  it('has exactly one outcome in every free-running race (30 rounds each): tapped, paid once and nothing given back; not tapped, undone once and never paid', async () => {
    for (let round = 0; round < 30; round += 1) {
      const stripe = new FakeStripe()
      const stock = await stockNow()
      const { orderId, intent } = await onTheReader(stripe)
      stripe.completeReaderPayment(intent)
      const [finalised, cancelled] = await Promise.all([finaliseReaderOrder(first, stripe, orderId, asReconcile), cancelReaderOrder(second, stripe, orderId, asReconcile)])
      expect(finalised.finalised || cancelled.finaliseResult?.finalised, `round ${round}`).toBe(true)
      expect(cancelled.cancelled, `round ${round}`).toBe(false)
      expect(await orderStatus(orderId)).toBe('paid')
      expect(await paidRows(orderId)).toBe(1)
      expect(await stockNow()).toBe(stock - 2)
    }
    for (let round = 0; round < 30; round += 1) {
      const stripe = new FakeStripe()
      const stock = await stockNow()
      const { orderId } = await onTheReader(stripe)
      const [finalised, cancelled] = await Promise.all([finaliseReaderOrder(first, stripe, orderId, asReconcile), cancelReaderOrder(second, stripe, orderId, asReconcile)])
      expect(finalised.finalised, `round ${round}`).toBe(false)
      expect(['payment_not_succeeded', 'order_not_found']).toContain(finalised.reason)
      expect(cancelled.cancelled, `round ${round}`).toBe(true)
      expect(await orderStatus(orderId)).toBe('gone')
      expect(await stockNow()).toBe(stock)
    }
  })

  it('two cancels free-running (30 rounds): undone once, given back once', async () => {
    for (let round = 0; round < 30; round += 1) {
      const stripe = new FakeStripe()
      const stock = await stockNow()
      const { orderId } = await onTheReader(stripe)
      const answers = await Promise.all([cancelReaderOrder(first, stripe, orderId, asReconcile), cancelReaderOrder(second, stripe, orderId, asReconcile)])
      expect(answers.every((answer) => answer.cancelled), `round ${round}`).toBe(true)
      expect(answers.filter((answer) => answer.alreadyGone)).toHaveLength(1)
      expect(await stockNow()).toBe(stock)
    }
  })
})

describe("Q10's guard with two reader orders for one customer at once", () => {
  async function outcome(db: Db, input: PlaceOrderInput, stripe: FakeStripe): Promise<string> {
    try {
      return (await placeOrder(db, input, { ...asStaff(), stripe: () => stripe })).status
    } catch (err) {
      return refusalDetails(err)?.reason ?? String(err)
    }
  }

  it('both wait on the customer; whichever goes first commits pending, and the other, reading after it, is refused', async () => {
    const stripe = new FakeStripe()
    const customer = await readerCustomer(stripe)
    const holder = await holding(third, (tx) => tx.query('SELECT id FROM customers WHERE id = $1 FOR NO KEY UPDATE', [customer]))
    const one = outcome(first, soapsOnTheReader(customer), stripe)
    const firstWaiter = await blockedBy(holder.pid)
    expect(await waitingOn(pg, firstWaiter)).toEqual(['customers'])
    const other = outcome(second, soapsOnTheReader(customer), stripe)
    const giveUpAt = Date.now() + 4_000
    while ((await pg.admin.unsafe<{ n: number }[]>('SELECT count(*)::int AS n FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid)) > 0'))[0]?.n !== 2) {
      if (Date.now() > giveUpAt) throw new Error('The second order never queued.')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    await holder.finish('commit')
    expect([await one, await other].sort()).toEqual(['order_still_processing', 'pending_reader'])
    expect(stripe.calls.filter((call) => call.method === 'paymentIntents.create')).toHaveLength(1)
  })

  it('in every free-running race (20 rounds) one waits for its tap and the other is refused, never two intents', async () => {
    for (let round = 0; round < 20; round += 1) {
      const stripe = new FakeStripe()
      const customer = await readerCustomer(stripe)
      const outcomes = await Promise.all([outcome(first, soapsOnTheReader(customer), stripe), outcome(second, soapsOnTheReader(customer), stripe)])
      expect(outcomes.sort(), `round ${round}`).toEqual(['order_still_processing', 'pending_reader'])
      expect(stripe.calls.filter((call) => call.method === 'paymentIntents.create')).toHaveLength(1)
    }
  })

  it('a held reader order three hours old still refuses a reader order on another connection', async () => {
    const stripe = new FakeStripe()
    const { orderId, customerId } = await onTheReader(stripe)
    await first.query(`UPDATE orders SET created_at = now() - interval '3 hours' WHERE id = $1`, [orderId])
    expect(await outcome(second, soapsOnTheReader(customerId), stripe)).toBe('order_still_processing')
  })
})

// W11a (review S1, from the review's proof T1): the statements a reader order press makes between its
// Stripe calls are bounded by Postgres. ensureStripeCustomer's read and write-back each run in their own
// transaction with the lock and statement limits cut to what is left before the 30 s Stripe deadline;
// recordReaderIntent runs in its own transaction (a lock waited for at most 5 s). A statement Postgres
// stops is rolled back, so it never lands after the press has answered.
describe("W11a: the press's statements between its Stripe calls are bounded (review S1)", () => {
  interface Timed {
    ms: number
    ok: boolean
    endedAt: number
  }
  /** `db`, with every statement matching `pattern` timed, inside transactions too. */
  function watching(db: Db, pattern: RegExp, seen: Timed[]): Db {
    const time = async <T>(sql: string, run: () => Promise<T>): Promise<T> => {
      if (!pattern.test(sql)) return run()
      const startedAt = Date.now()
      try {
        const rows = await run()
        seen.push({ ms: Date.now() - startedAt, ok: true, endedAt: Date.now() })
        return rows
      } catch (err) {
        seen.push({ ms: Date.now() - startedAt, ok: false, endedAt: Date.now() })
        throw err
      }
    }
    const wrap = (tx: Tx): Tx => ({
      query: (sql, params) => time(sql, () => tx.query(sql, params)) as never,
      selectForUpdate: (sql, params, options) => tx.selectForUpdate(sql, params, options) as never,
      transaction: (fn) => tx.transaction((inner) => fn(wrap(inner))),
    })
    return {
      query: (sql, params) => time(sql, () => db.query(sql, params)) as never,
      transaction: (fn) => db.transaction((tx) => fn(wrap(tx))),
      close: () => db.close(),
    }
  }

  /** Once `method` has answered, another connection holds the row `lockSql` names for `ms`. */
  function holdAfter(
    stripe: FakeStripe,
    method: 'customers.create' | 'paymentIntents.create',
    lockSql: string,
    idOf: (made: { metadata?: Record<string, string> | null }, customerId: string) => string,
    customerId: string,
    ms: number
  ): { held: () => Promise<void>; heldAt: () => number } {
    let holder: Promise<void> = Promise.resolve()
    let heldAt = 0
    const [group, name] = method.split('.') as ['customers' | 'paymentIntents', 'create']
    const methods = stripe[group] as unknown as Record<string, (...args: unknown[]) => Promise<{ metadata?: Record<string, string> | null }>>
    const real = methods[name] as (...args: unknown[]) => Promise<{ metadata?: Record<string, string> | null }>
    methods[name] = async (...args: unknown[]) => {
      const made = await real(...args)
      const locked = deferred()
      holder = second.transaction(async (tx) => {
        await tx.query(lockSql, [idOf(made, customerId)])
        locked.resolve()
        await new Promise((resolve) => setTimeout(resolve, ms))
      })
      await locked.promise
      heldAt = Date.now()
      return made
    }
    return { held: () => holder, heldAt: () => heldAt }
  }

  const holdTheCustomer = (stripe: FakeStripe, customerId: string, ms: number) =>
    holdAfter(stripe, 'customers.create', 'SELECT id FROM customers WHERE id = $1 FOR NO KEY UPDATE', (_made, id) => id, customerId, ms)

  async function press(db: Db, input: PlaceOrderInput, stripe: FakeStripe, startedAt: number): Promise<string> {
    try {
      return (await placeOrder(db, input, { ...asStaff(), stripe: () => stripe, startedAt })).status
    } catch (err) {
      return refusalDetails(err)?.reason ?? (err as { code?: string }).code ?? String(err)
    }
  }
  const stripeCustomerOf = async (customerId: string) =>
    (await first.query<{ id: string | null }>('SELECT stripe_customer_id AS id FROM customers WHERE id = $1', [customerId]))[0]?.id ?? null

  it("the review's case: 4 s left and the customer's row held 7 s once Stripe has made the customer: the write gives up by the deadline and never lands; nothing asked for, undone", async () => {
    const stripe = new FakeStripe()
    const customerId = await fixtures.customer(first) // no Stripe customer yet
    const stock = await stockNow()
    const hold = holdTheCustomer(stripe, customerId, 7_000)
    const writes: Timed[] = []
    const startedAt = Date.now() - 26_000
    const deadline = startedAt + 30_000
    const answer = await press(watching(first, /UPDATE customers SET stripe_customer_id/, writes), soapsOnTheReader(customerId), stripe, startedAt)
    const answeredAt = Date.now()
    await hold.held()

    expect(answer).toBe('reader_intent_failed')
    // W11: the write waited for the row, past the deadline (the client's 10 s), and then saved the id.
    expect(writes).toHaveLength(1)
    expect(writes[0]?.ok).toBe(false)
    expect(writes[0]?.endedAt).toBeLessThanOrEqual(deadline + 300)
    expect(await stripeCustomerOf(customerId)).toBe(null)
    expect(stripe.calls.map((call) => call.method)).toEqual(['customers.search', 'customers.create'])
    // The undo waited for the row (inside its own 5 s lock limit) and gave everything back.
    expect(await stockNow()).toBe(stock)
    expect(answeredAt - deadline).toBeLessThan(13_100)
  }, 30_000)

  it("plenty of time and the row held 2 s: the write waits for it and saves the id, and the intent is made", async () => {
    const stripe = new FakeStripe()
    const customerId = await fixtures.customer(first)
    const hold = holdTheCustomer(stripe, customerId, 2_000)
    const writes: Timed[] = []
    const answer = await press(watching(first, /UPDATE customers SET stripe_customer_id/, writes), soapsOnTheReader(customerId), stripe, Date.now())
    await hold.held()
    expect(answer).toBe('pending_reader')
    expect(writes[0]).toMatchObject({ ok: true })
    expect(writes[0]?.ms).toBeGreaterThan(1_500)
    expect(await stripeCustomerOf(customerId)).toMatch(/^cus_fake_/)
  }, 30_000)

  it("plenty of time and the row held 7 s: the write gives up at the 5 s lock limit, not the client's 10 s, and never lands; undone", async () => {
    const stripe = new FakeStripe()
    const customerId = await fixtures.customer(first)
    const stock = await stockNow()
    const hold = holdTheCustomer(stripe, customerId, 7_000)
    const writes: Timed[] = []
    const answer = await press(watching(first, /UPDATE customers SET stripe_customer_id/, writes), soapsOnTheReader(customerId), stripe, Date.now())
    await hold.held()
    expect(answer).toBe('reader_intent_failed')
    expect(writes[0]?.ok).toBe(false)
    expect(writes[0]?.ms).toBeGreaterThanOrEqual(4_500)
    expect(writes[0]?.ms).toBeLessThan(6_000)
    expect(await stripeCustomerOf(customerId)).toBe(null)
    expect(stripe.calls.map((call) => call.method)).not.toContain('paymentIntents.create')
    expect(await stockNow()).toBe(stock)
  }, 30_000)

  it("the intent made and the order's row held 6.5 s: writing it on gives up at the 5 s lock limit and never lands; held (PAYMENT_UNCONFIRMED), never undone", async () => {
    const stripe = new FakeStripe()
    const customerId = await readerCustomer(stripe)
    const stock = await stockNow()
    const hold = holdAfter(stripe, 'paymentIntents.create', 'SELECT id FROM orders WHERE id = $1 FOR UPDATE', (made) => made.metadata?.['order_id'] ?? '', customerId, 6_500)
    const writes: Timed[] = []
    const answer = await press(watching(first, /UPDATE orders\s+SET reader_payment = reader_payment/, writes), soapsOnTheReader(customerId), stripe, Date.now())
    await hold.held()
    expect(answer).toBe('payment_unconfirmed')
    expect(writes[0]?.ok).toBe(false)
    expect(writes[0]?.ms).toBeGreaterThanOrEqual(4_500)
    expect(writes[0]?.ms).toBeLessThan(6_000)
    const order = (
      await first.query<{ payment_status: string; reader_payment: Record<string, unknown> }>('SELECT payment_status, reader_payment FROM orders WHERE customer_id = $1', [customerId])
    )[0]
    expect(order?.payment_status).toBe('pending')
    expect(order?.reader_payment['payment_intent_id']).toBeUndefined()
    expect(await stockNow()).toBe(stock - 2)
  }, 30_000)
})
