import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PlaceOrderInput } from '@/contracts'
import type { Db, Tx } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import { fixtures, insert } from '@/server/rules/testing/database'
import { deferred, Refused } from '@/server/rules/testing/race'
import { startRealPostgres, type RealPostgres } from '@/server/rules/testing/real-postgres'
import { FakeStripe } from '@/server/stripe/fake'
import { placeOrder } from './place-order'
import { finaliseReaderOrder } from './reader-order'
import { reconcile } from './reconcile'
import { refundOrderLines, type OrderRefundOptions } from './refund-lines'
import { stuckList } from './stuck-list'

// Brief W28 item 9 (E-plan 4.13 item 7) on real Postgres 17.6, each Worker client on its own connection: two refunds of
// the same lines racing (W05 review 2, item 12), two card refunds of different lines racing, and a refund racing a held
// reader payment's finalise (E2). Each race holds the order's lock open until Postgres reports both sides waiting on
// it, so none can pass by timing.

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

let variant: string
let staffId: string
beforeAll(async () => {
  const soap = await insert(first, 'products', { name: 'Soap', base_price: '12.00', fulfillment_method: 'pickup' })
  variant = await insert(first, 'product_variants', { product_id: soap, sku: `SOAP-${crypto.randomUUID()}`, stock_quantity: 10_000 })
  staffId = await insert(first, 'staff', { role: 'staff', first_name: 'Jo', last_name: 'Staff', email: 'w28-race@example.com', can_issue_refunds: true })
})

const options = (stripe: FakeStripe): OrderRefundOptions => ({ actor: { type: 'staff', id: staffId }, requestId: crypto.randomUUID(), stripe: () => stripe })

/** An order of `lines` soaps (£24 each line) paid on the card: its lines and the fake's PaymentIntent. */
async function cardOrder(stripe: FakeStripe, lines: number): Promise<{ orderId: string; lineIds: string[]; customerId: string }> {
  const customerId = await fixtures.customer(first)
  const stripeCustomer = `cus_${crypto.randomUUID().slice(0, 8)}`
  stripe.addCustomer(stripeCustomer)
  const total = 24 * lines
  const intent = await stripe.paymentIntents.create({ amount: total * 100, currency: 'gbp', customer: stripeCustomer, payment_method: 'pm_w28', off_session: true, confirm: true })
  const orderId = await insert(first, 'orders', { customer_id: customerId, order_total: total.toFixed(2), payment_status: 'paid', stripe_payment_intent_id: intent.id, payment_method: 'card', order_source: 'staff_created' })
  const lineIds: string[] = []
  for (let i = 0; i < lines; i += 1) lineIds.push(await insert(first, 'order_line_items', { order_id: orderId, product_variant_id: variant, item_type: 'product', quantity: 2, unit_price: '12.00', line_total: '24.00' }))
  return { orderId, lineIds, customerId }
}

/** The order's lock held open on `third` until finished. */
async function holdingTheOrder(orderId: string) {
  const release = deferred()
  let announce: (pid: number) => void = () => {}
  const ready = new Promise<number>((resolve) => {
    announce = resolve
  })
  const done = third
    .transaction(async (tx: Tx) => {
      await tx.query('SELECT id FROM orders WHERE id = $1 FOR UPDATE', [orderId])
      announce((await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]?.pid as number)
      await release.promise
    })
    .catch((err: unknown) => {
      if (!(err instanceof Refused)) throw err
    })
  const pid = await ready
  return {
    pid,
    async finish() {
      release.resolve()
      await done
    },
  }
}

async function allBlockedBy(holderPid: number, count: number): Promise<number[]> {
  const giveUpAt = Date.now() + 4_000
  while (Date.now() < giveUpAt) {
    const rows = await pg.admin.unsafe<{ pid: number }[]>(
      `WITH RECURSIVE queued(pid) AS (
         SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))
         UNION
         SELECT a.pid FROM pg_stat_activity a JOIN queued q ON q.pid = ANY(pg_blocking_pids(a.pid))
       ) SELECT pid FROM queued`,
      [holderPid]
    )
    if (rows.length >= count) return rows.map((row) => row.pid)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Fewer than ${count} waited on the holder.`)
}

type Outcome = { answered: Record<string, unknown> } | { refused: string }
const outcome = (promise: Promise<unknown>): Promise<Outcome> =>
  promise.then(
    (value) => ({ answered: value as Record<string, unknown> }),
    (err: unknown) => ({ refused: err instanceof ApiError ? ((err.details as { reason?: string } | undefined)?.reason ?? err.code) : String(err) })
  )
const refusals = (outcomes: Outcome[]): string[] => outcomes.flatMap((one) => ('refused' in one ? [one.refused] : []))
const answers = (outcomes: Outcome[]): Array<Record<string, unknown>> => outcomes.flatMap((one) => ('answered' in one ? [one.answered] : []))

const press = (db: Db, stripe: FakeStripe, orderId: string, lineItemIds: string[], refundMethod: string) =>
  outcome(refundOrderLines(db, orderId, { lineItemIds, refundMethod, restock: Object.fromEntries(lineItemIds.map((id) => [id, false])), confirmed: { amount: 24 * lineItemIds.length } }, options(stripe)))

const lineRows = async (orderId: string) =>
  first.query<{ id: string; refunded: boolean; card: string }>('SELECT id, refunded_at IS NOT NULL AS refunded, card_refunded_amount::numeric(10,2)::text AS card FROM order_line_items WHERE order_id = $1 ORDER BY created_at, id', [orderId])
const creditRefunds = async (customerId: string) => (await first.query<{ amount: string }>("SELECT amount::text AS amount FROM store_credit_transactions WHERE customer_id = $1 AND reason = 'refund'", [customerId])).map((row) => row.amount)
const claims = async (orderId: string) => (await first.query<{ n: number }>("SELECT count(*)::int AS n FROM audit_log WHERE action = 'order.refund_claimed' AND entity_id = $1", [orderId]))[0]?.n
const finished = async (orderId: string) => (await first.query<{ n: number }>("SELECT count(*)::int AS n FROM audit_log WHERE action = 'order.refund_finished' AND entity_id = $1", [orderId]))[0]?.n
const moneyBack = (stripe: FakeStripe) => stripe.refundsSent.reduce((total, sent) => total + sent.amount, 0)

describe('two refunds racing on one order (W05 review 2, item 12)', () => {
  it('the same line to store credit, twice at once: both wait on the order; one gives £24, the other finds the line refunded; £24 of store credit, once', async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const { orderId, lineIds, customerId } = await cardOrder(stripe, 1)
    const gate = await holdingTheOrder(orderId)
    const a = press(first, stripe, orderId, lineIds, 'credit')
    const b = press(second, stripe, orderId, lineIds, 'credit')
    await allBlockedBy(gate.pid, 2)
    await gate.finish()
    const outcomes = await Promise.all([a, b])
    expect(answers(outcomes)).toHaveLength(1)
    expect(answers(outcomes)[0]).toMatchObject({ refundedAmount: 24, storeCreditRefundedAmount: 24 })
    expect(refusals(outcomes)).toEqual(['already_refunded'])
    // The old code gave the store credit part to both presses.
    expect(await creditRefunds(customerId)).toEqual(['24.00'])
    expect(await claims(orderId)).toBe(1)
    expect(await finished(orderId)).toBe(1)
  })

  it('the same line to the card, twice at once: one refund is sent, under one claim\'s key; the other press is refused (the line refunded, or a refund still being checked)', async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const { orderId, lineIds } = await cardOrder(stripe, 2)
    const gate = await holdingTheOrder(orderId)
    const a = press(first, stripe, orderId, [lineIds[0] as string], 'card')
    const b = press(second, stripe, orderId, [lineIds[0] as string], 'card')
    await allBlockedBy(gate.pid, 2)
    await gate.finish()
    const outcomes = await Promise.all([a, b])
    expect(answers(outcomes)).toHaveLength(1)
    expect(refusals(outcomes)).toHaveLength(1)
    expect(['refund_open', 'already_refunded']).toContain(refusals(outcomes)[0])
    expect(moneyBack(stripe)).toBe(2400)
    expect(stripe.calls.filter((call) => call.method === 'refunds.create')).toHaveLength(1)
    expect((await lineRows(orderId)).map((line) => [line.refunded, line.card])).toEqual([
      [true, '24.00'],
      [false, '0.00'],
    ])
    expect(await claims(orderId)).toBe(1)
  })

  it('two different lines to the card at once: every refund sent is recorded on its own line, and a press refused while the other is being checked sends nothing', async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const { orderId, lineIds } = await cardOrder(stripe, 2)
    const gate = await holdingTheOrder(orderId)
    const a = press(first, stripe, orderId, [lineIds[0] as string], 'card')
    const b = press(second, stripe, orderId, [lineIds[1] as string], 'card')
    await allBlockedBy(gate.pid, 2)
    await gate.finish()
    const outcomes = await Promise.all([a, b])
    // The second to get the lock finds the first's claim open (refused), or, if the first had finished, goes through.
    const went = answers(outcomes).length
    expect(went === 1 || went === 2).toBe(true)
    expect(refusals(outcomes).every((reason) => reason === 'refund_open')).toBe(true)
    expect(moneyBack(stripe)).toBe(2400 * went)
    expect((await lineRows(orderId)).filter((line) => line.refunded && line.card === '24.00')).toHaveLength(went)
    expect((await lineRows(orderId)).filter((line) => !line.refunded && line.card === '0.00')).toHaveLength(2 - went)
    expect(await claims(orderId)).toBe(went)
    expect(await finished(orderId)).toBe(went)
  })
})

/** A customer with a Stripe customer, known to `stripe`. */
async function readerCustomer(stripe: FakeStripe): Promise<string> {
  const stripeId = `cus_${crypto.randomUUID().slice(0, 8)}`
  stripe.addCustomer(stripeId)
  return fixtures.customer(first, { stripe_customer_id: stripeId })
}

describe("a refund racing a held payment's finalise (E2)", () => {
  it('a reader order tapped but not yet finalised: the refund and the finalise both wait on the order; the refund is refused while it is pending, or goes back to the card once it is paid; nothing is ever given on an unpaid order', async () => {
    for (let round = 0; round < 4; round += 1) {
      const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
      const customerId = await readerCustomer(stripe)
      const basket: PlaceOrderInput = { customerId, products: [{ productVariantId: variant, quantity: 2 }], payment: { method: 'reader' }, confirmed: { toCollect: 24 } }
      const placed = await placeOrder(first, basket, { actor: { type: 'staff', id: staffId }, requestId: crypto.randomUUID(), stripe: () => stripe })
      const orderId = placed.orderId
      stripe.completeReaderPayment(placed.pendingReaderPayment?.paymentIntentId as string)
      const line = (await first.query<{ id: string }>('SELECT id FROM order_line_items WHERE order_id = $1', [orderId]))[0]?.id as string
      const gate = await holdingTheOrder(orderId)
      // Turn about, so each gets to ask for the lock first.
      const refund = () => press(round % 2 === 0 ? first : second, stripe, orderId, [line], round < 2 ? 'credit' : 'card')
      const finalise = () => outcome(finaliseReaderOrder(round % 2 === 0 ? second : first, stripe, orderId, { actor: { type: 'staff', id: staffId }, requestId: crypto.randomUUID() }))
      const [a, b] = round % 2 === 0 ? [refund(), finalise()] : [finalise(), refund()]
      await allBlockedBy(gate.pid, 2)
      await gate.finish()
      const [x, y] = await Promise.all([a, b])
      const [refunded, finalised] = round % 2 === 0 ? [x, y] : [y, x]
      // The payment is always recorded: the order is finalised whatever the refund did.
      expect('answered' in (finalised as Outcome) && (finalised as { answered: { finalised?: boolean } }).answered.finalised).toBe(true)
      const status = (await first.query<{ payment_status: string }>('SELECT payment_status FROM orders WHERE id = $1', [orderId]))[0]?.payment_status
      const credit = await creditRefunds(customerId)
      if ('refused' in (refunded as Outcome)) {
        // The refund got the lock first: the order was still pending, so nothing was given.
        expect((refunded as { refused: string }).refused).toBe('order_not_paid')
        expect(status).toBe('paid')
        expect(credit).toEqual([])
        expect(moneyBack(stripe)).toBe(0)
        expect(await claims(orderId)).toBe(0)
      } else {
        // The finalise got it first: the order was paid, and its money went back once.
        expect(status).toBe('refunded')
        expect(round < 2 ? credit : moneyBack(stripe)).toEqual(round < 2 ? ['24.00'] : 2400)
        expect(await claims(orderId)).toBe(1)
      }
    }
  })
})

describe('E2: reconcile still finds a payment on an order in any state', () => {
  it('an order moved out of pending while its reader payment was open (what the old refund left) is still read by reconcile and listed, with what Stripe took; and the new route never makes that state', async () => {
    const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
    const customerId = await readerCustomer(stripe)
    const basket: PlaceOrderInput = { customerId, products: [{ productVariantId: variant, quantity: 2 }], payment: { method: 'reader' }, confirmed: { toCollect: 24 } }
    const placed = await placeOrder(first, basket, { actor: { type: 'staff', id: staffId }, requestId: crypto.randomUUID(), stripe: () => stripe })
    const orderId = placed.orderId
    const line = (await first.query<{ id: string }>('SELECT id FROM order_line_items WHERE order_id = $1', [orderId]))[0]?.id as string

    // The new route refuses a refund while the payment is open, so it leaves the order pending, where reconcile's own
    // list finds it.
    expect(await press(first, stripe, orderId, [line], 'credit')).toEqual({ refused: 'order_not_paid' })
    expect((await first.query<{ payment_status: string }>('SELECT payment_status FROM orders WHERE id = $1', [orderId]))[0]?.payment_status).toBe('pending')
    expect(await creditRefunds(customerId)).toEqual([])

    // What the old refundOrder did (E2's recording): the order marked refunded while its reader payment was still open,
    // and then the customer tapped. No screen could cancel or finalise it after that.
    await first.query("UPDATE orders SET payment_status = 'refunded' WHERE id = $1", [orderId])
    stripe.completeReaderPayment(placed.pendingReaderPayment?.paymentIntentId as string)

    // Reconcile's pass for orders that are neither pending nor paid (W12a) still reads Stripe for its payment.
    const run = await reconcile(first, stripe, { actor: { type: 'system', id: null }, requestId: crypto.randomUUID(), maxItems: 500, budgetMs: 60_000, windowMinutes: 0 })
    expect(run.items).toContainEqual(expect.objectContaining({ kind: 'order', id: orderId, outcome: 'left', reason: 'changed_elsewhere', finding: expect.objectContaining({ state: 'taken', amount: 2400 }) }))
    // It never acts on it: nothing cancelled, refunded or finalised; a person is shown it on the Orders page.
    expect(moneyBack(stripe)).toBe(0)
    const listed = (await stuckList(first, { olderThanMinutes: 0 })).checkout.find((item) => item.orderId === orderId)
    expect(listed).toMatchObject({ reason: 'changed_elsewhere', paymentStatus: 'refunded', finding: { state: 'taken', amount: 2400 } })
    expect(listed?.words).toContain('Stripe shows £24.00 taken')
  })
})

