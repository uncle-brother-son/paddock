import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PlaceOrderInput } from '@/contracts'
import type { Db, Tx } from '@/server/db'
import { deferred, Refused, waitingOn } from '@/server/rules/testing/race'
import { fixtures, insert } from '@/server/rules/testing/database'
import { startRealPostgres, type RealPostgres } from '@/server/rules/testing/real-postgres'
import { FakeStripe } from '@/server/stripe/fake'
import { closeStuckItem } from './close-stuck'
import { placeOrder } from './place-order'
import { reconcile, SCHEDULED_LIMITS } from './reconcile'
import { undoOrder } from './undo-order'

// Brief W14b item 4 on real Postgres 17.6, two connections: the manual close of a `changed_since` order racing
// reconcile (each way round, held until Postgres reports the other waiting, and free-running), and two closes at
// once. Whatever the order, the order goes once, its stock comes back once, and nothing else moves.

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
let eventId: string
beforeAll(async () => {
  const soap = await insert(first, 'products', { name: 'Soap', base_price: '12.00', fulfillment_method: 'pickup' })
  product = await insert(first, 'product_variants', { product_id: soap, sku: `SOAP-${crypto.randomUUID()}`, stock_quantity: 100_000 })
  staffId = await insert(first, 'staff', { role: 'staff', first_name: 'Jo', last_name: 'Staff', email: 'w14b-race@example.com', can_issue_refunds: true })
  eventId = await fixtures.event(first, { capacity: 100_000 })
})

afterAll(async () => {
  // Every test settles what it made.
  expect(await first.query("SELECT id FROM orders WHERE payment_status = 'pending'")).toEqual([])
})

const asStaff = () => ({ actor: { type: 'staff' as const, id: staffId }, requestId: 'w14b-race' })
const asSystem = { actor: { type: 'system' as const, id: null }, requestId: 'w14b-race' }
const runOn = (db: Db, stripe: FakeStripe) => reconcile(db, stripe, { ...asSystem, ...SCHEDULED_LIMITS })
const closeOn = (db: Db, orderId: string) => closeStuckItem(db, { kind: 'held_order', orderId, reason: 'Event cancelled on the old screens.' }, asStaff())

const stockNow = async () => (await first.query<{ n: number }>('SELECT stock_quantity AS n FROM product_variants WHERE id = $1', [product]))[0]?.n as number
const placesNow = async () => (await first.query<{ n: number }>('SELECT places_booked AS n FROM events WHERE id = $1', [eventId]))[0]?.n as number
const orderStatus = async (orderId: string) => (await first.query<{ payment_status: string }>('SELECT payment_status FROM orders WHERE id = $1', [orderId]))[0]?.payment_status ?? 'gone'
const actions = async (orderId: string, action: string) =>
  (await first.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_log WHERE entity_id = $1 AND action = $2', [orderId, action]))[0]?.n

/**
 * A Worker card order for an event place and two soaps (£64), both charge attempts unanswered (held); over the
 * window; old code cancels the event booking and gives its place back (test data standing in for the old screens);
 * reconcile finds nothing in Stripe and leaves it `changed_since`.
 */
async function heldChanged(stripe: FakeStripe): Promise<string> {
  const stripeId = `cus_${crypto.randomUUID().slice(0, 8)}`
  stripe.addCustomer(stripeId)
  const customerId = await fixtures.customer(first, { stripe_customer_id: stripeId, saved_payment_method_id: `pm_${stripeId}` })
  stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
  stripe.failNext('paymentIntents.create', { kind: 'unreachable' })
  const input: PlaceOrderInput = {
    customerId,
    event: { eventId, accountHolderAttending: true, guestsOver18Confirmed: true, attendees: [{ name: 'Sam Test', email: 'sam@example.com', dateOfBirth: '1990-01-01', isAccountHolder: true }] },
    products: [{ productVariantId: product, quantity: 2 }],
    payment: { method: 'card' },
    confirmed: { toCollect: 64 },
  }
  await placeOrder(first, input, { ...asStaff(), stripe: () => stripe }).catch(() => undefined)
  const orderId = (await first.query<{ id: string }>('SELECT id FROM orders WHERE customer_id = $1', [customerId]))[0]?.id as string
  expect(await orderStatus(orderId)).toBe('pending')
  await first.query(
    `UPDATE orders SET created_at = now() - interval '20 minutes',
       reader_payment = jsonb_set(reader_payment, '{created_at}', to_jsonb(now() - interval '20 minutes'))
     WHERE id = $1`,
    [orderId]
  )
  await first.query(`UPDATE event_bookings SET status = 'cancelled' WHERE id = (SELECT event_booking_id FROM order_line_items WHERE order_id = $1 AND event_booking_id IS NOT NULL LIMIT 1)`, [orderId])
  await first.query('UPDATE events SET places_booked = places_booked - 1 WHERE id = $1', [eventId])
  const ran = await runOn(first, stripe)
  expect(ran.items).toEqual([expect.objectContaining({ id: orderId, outcome: 'left', reason: 'changed_since' })])
  return orderId
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

/** Runs `work` in a transaction on `db` and keeps it open (its locks held) until finish(). */
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

describe('the manual close racing reconcile', () => {
  it('the close held: reconcile waits on the order, then finds it gone; the stock comes back once, the event place not at all', async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const orderId = await heldChanged(stripe)
    const stock = await stockNow()
    const places = await placesNow()
    const close = await holding(first, () => closeOn(first, orderId))
    expect(close.result).toMatchObject({ closed: true })
    const running = runOn(second, stripe)
    const waiter = await blockedBy(close.pid)
    expect(await waitingOn(pg, waiter)).toEqual(['orders'])
    await close.finish()
    expect((await running).items).toEqual([expect.objectContaining({ id: orderId, outcome: 'settled_elsewhere' })])
    expect(await orderStatus(orderId)).toBe('gone')
    expect(await stockNow()).toBe(stock + 2)
    expect(await placesNow()).toBe(places)
    expect(await actions(orderId, 'order.close')).toBe(1)
    expect(await actions(orderId, 'order.undo')).toBe(0)
  })

  it("reconcile's undo held (it refuses: changed_since): the close waits on the order, then closes it", async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const orderId = await heldChanged(stripe)
    const stock = await stockNow()
    const undo = await holding(second, () => undoOrder(second, orderId, { ...asSystem, why: 'race' }))
    expect(undo.result).toMatchObject({ undone: false, reason: 'changed_since' })
    const closing = closeOn(first, orderId)
    const waiter = await blockedBy(undo.pid)
    expect(await waitingOn(pg, waiter)).toEqual(['orders'])
    await undo.finish()
    expect(await closing).toMatchObject({ closed: true })
    expect(await orderStatus(orderId)).toBe('gone')
    expect(await stockNow()).toBe(stock + 2)
  })

  it('the close and reconcile at once, 20 free-running rounds: the order gone once, the stock back once', async () => {
    for (let round = 0; round < 20; round += 1) {
      const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
      const orderId = await heldChanged(stripe)
      const stock = await stockNow()
      const places = await placesNow()
      const [closed] = await Promise.all([closeOn(first, orderId), runOn(second, stripe)])
      expect(closed, `round ${round}`).toMatchObject({ closed: true })
      expect(await orderStatus(orderId), `round ${round}`).toBe('gone')
      expect(await stockNow(), `round ${round}`).toBe(stock + 2)
      expect(await placesNow(), `round ${round}`).toBe(places)
      expect(await actions(orderId, 'order.close'), `round ${round}`).toBe(1)
      expect(stripe.netPence, `round ${round}`).toBe(0)
    }
  })

  it('two closes at once (two presses, two keys), 20 rounds: one closes it, the other answers closed already; the stock back once', async () => {
    for (let round = 0; round < 20; round += 1) {
      const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
      const orderId = await heldChanged(stripe)
      const stock = await stockNow()
      const answers = await Promise.all([closeOn(first, orderId), closeOn(second, orderId)])
      expect(answers.map((answer) => answer.closed), `round ${round}`).toEqual([true, true])
      expect(answers.filter((answer) => answer.alreadyClosed === true), `round ${round}`).toHaveLength(1)
      expect(await stockNow(), `round ${round}`).toBe(stock + 2)
      expect(await actions(orderId, 'order.close'), `round ${round}`).toBe(1)
    }
  })
})
