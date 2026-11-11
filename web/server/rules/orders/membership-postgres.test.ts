import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PlaceOrderInput } from '@/contracts'
import type { Db, Tx } from '@/server/db'
import { deferred, Refused, waitingOn } from '@/server/rules/testing/race'
import { fixtures, insert } from '@/server/rules/testing/database'
import { startRealPostgres, type RealPostgres } from '@/server/rules/testing/real-postgres'
import { FakeStripe } from '@/server/stripe/fake'
import { finaliseOrder } from './finalise-order'
import { findOrderSubscriptions, markCompensating, markSubscriptionStarting, SUBSCRIPTION_START_GUARD_SECONDS } from './membership'
import { placeOrder } from './place-order'
import { cancelReaderOrder, finaliseReaderOrder } from './reader-order'
import { reconcile, SCHEDULED_LIMITS } from './reconcile'

// W13 on real Postgres 17.6, with Worker clients on separate connections: a reader membership finalised
// twice at once, finalised and cancelled at once, and reconcile racing the screen's T2 on a saved-card
// membership whose Worker died before T2. Each held race keeps one side open until Postgres reports the
// other waiting on it; the free-running rounds race for real. Every race ends with exactly one outcome:
// one subscription (Stripe's key makes the second send the same one), the order paid once with one
// membership row, or undone with no subscription; never a live subscription without its membership row.

let pg: RealPostgres
let first: Db
let second: Db

beforeAll(async () => {
  pg = await startRealPostgres()
  first = pg.connect()
  second = pg.connect()
})
afterAll(() => pg.stop())

let plan: string
let staffId: string
beforeAll(async () => {
  plan = await fixtures.plan(first, { name: 'Core', sessions_included: 4, price_monthly: '40.00', price_yearly: '400.00', stripe_price_id: 'price_race', stripe_price_id_yearly: 'price_race_yearly' })
  staffId = await insert(first, 'staff', { role: 'staff', first_name: 'Jo', last_name: 'Staff', email: 'w13-race@example.com' })
})

const asStaff = () => ({ actor: { type: 'staff' as const, id: staffId }, requestId: 'w13-race' })
const asSystem = { actor: { type: 'system' as const, id: null }, requestId: 'w13-race' }

/** A fake of its own (ids tagged: one PaymentIntent per order, migration 022), with the plan's price and a customer. */
async function stripeAndCustomer(card: string | null): Promise<{ stripe: FakeStripe; customerId: string; stripeId: string }> {
  const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
  stripe.addPrice('price_race', 4000, 'month')
  const stripeId = `cus_${crypto.randomUUID().slice(0, 8)}`
  stripe.addCustomer(stripeId)
  const customerId = await fixtures.customer(first, { stripe_customer_id: stripeId, ...(card ? { saved_payment_method_id: card } : {}) })
  return { stripe, customerId, stripeId }
}

const membership = (customerId: string, payment: PlaceOrderInput['payment'], confirmed: PlaceOrderInput['confirmed']): PlaceOrderInput => ({
  customerId,
  membershipPlanId: plan,
  membershipBillingFrequency: 'monthly',
  payment,
  confirmed,
})

const orderStatus = async (orderId: string) => (await first.query<{ payment_status: string }>('SELECT payment_status FROM orders WHERE id = $1', [orderId]))[0]?.payment_status ?? 'gone'
const count = async (sql: string, params: unknown[]) => (await first.query<{ n: number }>(sql, params as never[]))[0]?.n ?? 0
const paidRows = (orderId: string) => count("SELECT count(*)::int AS n FROM audit_log WHERE entity_id = $1 AND action = 'order.paid'", [orderId])
const membershipRows = (customerId: string) => count('SELECT count(*)::int AS n FROM customer_memberships WHERE customer_id = $1', [customerId])

/** A reader membership placed (the price checked, the intent made), tapped with a reusable card. */
async function tappedReaderMembership(tap = true) {
  const { stripe, customerId, stripeId } = await stripeAndCustomer(null)
  const placed = await placeOrder(first, membership(customerId, { method: 'reader', readerSaveCard: true }, { toCollect: 40 }), { ...asStaff(), stripe: () => stripe })
  const intent = placed.pendingReaderPayment?.paymentIntentId as string
  if (tap) stripe.completeReaderPayment(intent, { generatedCard: `pm_${crypto.randomUUID().slice(0, 6)}` })
  return { stripe, customerId, stripeId, orderId: placed.orderId, intent }
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

/** `work` inside a transaction on `db` (T2 joins it), held open after it until finished. */
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

/** Exactly one outcome for one order: paid once with one membership row and one live subscription, or gone with none. */
async function oneOutcome(stripe: FakeStripe, orderId: string, customerId: string): Promise<'paid' | 'gone'> {
  const status = await orderStatus(orderId)
  const live = stripe.liveSubscriptions
  if (status === 'paid') {
    expect(await paidRows(orderId)).toBe(1)
    expect(await membershipRows(customerId)).toBe(1)
    expect(live).toHaveLength(1)
    return 'paid'
  }
  expect(status).toBe('gone')
  expect(await membershipRows(customerId)).toBe(0)
  expect(live).toEqual([])
  expect(stripe.netPence).toBe(0)
  return 'gone'
}

describe('a reader membership finalised twice at once', () => {
  it('held: a finalise waits on the order behind the first one\'s T2, at its start (W13a B1a: written before Stripe is asked, so no subscription yet), then makes it under the order\'s key and is paid', async () => {
    const { stripe, customerId, orderId } = await tappedReaderMembership()
    // The first finalise's T2, held at its lock on the order (the same row lock T2 takes first).
    const t2 = await holding(first, async (tx) => (await tx.query<{ id: string }>('SELECT id FROM orders WHERE id = $1 FOR UPDATE', [orderId]))[0]?.id)
    const finalising = finaliseReaderOrder(second, stripe, orderId, asSystem)
    const waiter = await blockedBy(t2.pid)
    expect(await waitingOn(pg, waiter)).toEqual(['orders'])
    // W13a: it waits at its start, before the subscription.
    expect(stripe.subscriptionsMade).toEqual([])
    await t2.finish()
    expect(await finalising).toMatchObject({ finalised: true })
    expect(stripe.calls.filter((call) => call.method === 'subscriptions.create').map((call) => call.idempotencyKey)).toEqual([`${orderId}:subscription`])
    // A second finalise now: the same key gives the same subscription, and T2 finds the order paid.
    expect(await finaliseReaderOrder(second, stripe, orderId, asSystem)).toMatchObject({ finalised: true, alreadyFinalised: true })
    expect(stripe.subscriptionsMade).toHaveLength(1)
    expect(await oneOutcome(stripe, orderId, customerId)).toBe('paid')
  })

  it('free-running, 20 rounds: one subscription, paid once, one membership row', async () => {
    const answers: string[] = []
    for (let round = 0; round < 20; round += 1) {
      const { stripe, customerId, orderId } = await tappedReaderMembership()
      const both = await Promise.all([finaliseReaderOrder(first, stripe, orderId, asSystem), finaliseReaderOrder(second, stripe, orderId, asSystem)])
      // W13c (W13a review B1, variant A): one press at a time. The other finds the order paid (already finalised),
      // or the first press's start still young: held (`subscription_starting`), with nothing sent and nothing compensated.
      expect(both.some((answer) => answer.finalised)).toBe(true)
      for (const answer of both) if (!answer.finalised) expect(answer).toMatchObject({ reason: 'subscription_starting' })
      answers.push(both.map((answer) => (answer.finalised ? (answer.alreadyFinalised ? 'already' : 'paid') : answer.reason)).join('/'))
      expect(stripe.subscriptionsMade).toHaveLength(1)
      expect(stripe.refundedPence).toBe(0)
      expect(await oneOutcome(stripe, orderId, customerId)).toBe('paid')
    }
    process.stdout.write(`\nW13c finalised twice at once, free-running: ${JSON.stringify(answers)}\n`)
  })
})

describe('a reader membership finalised and cancelled at once', () => {
  it('free-running, 20 rounds each: tapped, paid once with one subscription; not tapped, undone with none', async () => {
    for (let round = 0; round < 20; round += 1) {
      const tapped = await tappedReaderMembership(true)
      await Promise.all([finaliseReaderOrder(first, tapped.stripe, tapped.orderId, asSystem), cancelReaderOrder(second, tapped.stripe, tapped.orderId, asSystem)])
      expect(await oneOutcome(tapped.stripe, tapped.orderId, tapped.customerId)).toBe('paid')

      const untapped = await tappedReaderMembership(false)
      await Promise.all([finaliseReaderOrder(first, untapped.stripe, untapped.orderId, asSystem), cancelReaderOrder(second, untapped.stripe, untapped.orderId, asSystem)])
      expect(await oneOutcome(untapped.stripe, untapped.orderId, untapped.customerId)).toBe('gone')
      expect(untapped.stripe.subscriptionsMade).toEqual([])
    }
  })
})

describe("reconcile against the screen's T2", () => {
  /** A saved-card membership whose Worker died after the subscription and the charge, before T2. */
  async function heldBeforeT2() {
    const { stripe, customerId, stripeId } = await stripeAndCustomer('pm_saved')
    const hang = deferred()
    const client = Object.create(stripe) as FakeStripe
    Object.defineProperty(client, 'paymentIntents', {
      value: {
        ...stripe.paymentIntents,
        create: async (...args: Parameters<FakeStripe['paymentIntents']['create']>) => {
          await stripe.paymentIntents.create(...args)
          hang.resolve()
          return new Promise<never>(() => undefined)
        },
      },
    })
    const fixturesProduct = await insert(first, 'products', { name: 'Soap', base_price: '12.00', fulfillment_method: 'pickup' })
    const variant = await insert(first, 'product_variants', { product_id: fixturesProduct, sku: `SOAP-${crypto.randomUUID()}`, stock_quantity: 5 })
    void placeOrder(first, { ...membership(customerId, { method: 'card' }, { toCollect: 12, firstInvoice: 40 }), products: [{ productVariantId: variant, quantity: 1 }] }, { ...asStaff(), stripe: () => client })
    await hang.promise
    const orderId = (await first.query<{ id: string }>('SELECT id FROM orders WHERE customer_id = $1', [customerId]))[0]?.id as string
    const subscriptions = await findOrderSubscriptions(stripe, undefined, stripeId, orderId)
    if (subscriptions.kind !== 'found') throw new Error('unclear')
    const charge = (await stripe.paymentIntents.list({ customer: stripeId })).data.find((intent) => intent.metadata?.['order_id'] === orderId)
    return { stripe, customerId, orderId, subscription: subscriptions.subscriptions[0] ?? null, charge: charge ?? null }
  }

  it('held: reconcile waits on the order behind T2, then finds it paid: never compensated, nothing refunded', async () => {
    const { stripe, customerId, orderId, subscription, charge } = await heldBeforeT2()
    const t2 = await holding(first, () => finaliseOrder(first, orderId, charge, { ...asSystem, subscription }))
    expect(t2.result).toMatchObject({ finalised: true, alreadyPaid: false })
    const running = reconcile(second, stripe, { ...asSystem, ...SCHEDULED_LIMITS, windowMinutes: 0 })
    const waiter = await blockedBy(t2.pid)
    expect(await waitingOn(pg, waiter)).toEqual(['orders'])
    await t2.finish()
    expect((await running).items.find((item) => item.id === orderId)).toMatchObject({ outcome: 'settled_elsewhere' })
    expect(stripe.refundedPence).toBe(0)
    expect(await oneOutcome(stripe, orderId, customerId)).toBe('paid')
  })

  it('free-running, 15 rounds: T2 and reconcile at once: paid once, one membership row, nothing refunded', async () => {
    for (let round = 0; round < 15; round += 1) {
      const { stripe, customerId, orderId, subscription, charge } = await heldBeforeT2()
      await Promise.all([
        finaliseOrder(first, orderId, charge, { ...asSystem, subscription }),
        reconcile(second, stripe, { ...asSystem, ...SCHEDULED_LIMITS, windowMinutes: 0 }),
      ])
      expect(stripe.refundedPence).toBe(0)
      expect(await oneOutcome(stripe, orderId, customerId)).toBe('paid')
    }
  })
})

describe("W13a B1: the screen's finalise of a reader membership against reconcile", () => {
  /** Holds the fake's next `method` call until released. */
  function holdNext(target: object, method: string) {
    const reached = deferred()
    const gate = deferred()
    const methods = target as Record<string, (...args: unknown[]) => Promise<unknown>>
    const original = methods[method] as (...args: unknown[]) => Promise<unknown>
    let waiting = true
    methods[method] = async (...args: unknown[]) => {
      if (waiting) {
        waiting = false
        reached.resolve()
        await gate.promise
      }
      return original(...args)
    }
    return { reached: reached.promise, release: () => gate.resolve() }
  }
  const runReconcile = (stripe: FakeStripe) => reconcile(second, stripe, { ...asSystem, ...SCHEDULED_LIMITS, windowMinutes: 0 })

  it("P1, held: reconcile runs while the screen's subscription is being made: reconcile leaves the order (its start under 2 minutes old); the screen is paid; one outcome", async () => {
    const { stripe, customerId, orderId } = await tappedReaderMembership()
    const held = holdNext(stripe.subscriptions, 'create')
    const screen = finaliseReaderOrder(first, stripe, orderId, asStaff())
    await held.reached
    const ran = await runReconcile(stripe)
    expect(ran.items.find((item) => item.id === orderId)).toMatchObject({ outcome: 'left', reason: 'subscription_starting' })
    expect(stripe.refundedPence).toBe(0)
    held.release()
    expect(await screen).toMatchObject({ finalised: true })
    expect(await oneOutcome(stripe, orderId, customerId)).toBe('paid')
  })

  it("held the other way: reconcile marks first: the screen's start is refused, so it makes no subscription; one outcome (undone)", async () => {
    const { stripe, customerId, orderId } = await tappedReaderMembership()
    const held = holdNext(stripe.prices, 'retrieve')
    const screen = finaliseReaderOrder(first, stripe, orderId, asStaff())
    await held.reached
    expect((await runReconcile(stripe)).items.find((item) => item.id === orderId)).toMatchObject({ outcome: 'undone' })
    held.release()
    expect(await screen).toMatchObject({ finalised: false, reason: 'compensation_unfinished' })
    expect(stripe.subscriptionsMade).toEqual([])
    expect(await oneOutcome(stripe, orderId, customerId)).toBe('gone')
  })

  it('free-running, 20 rounds: the screen and reconcile at once: paid once with its row, or undone with no subscription; never a live subscription without its row', async () => {
    const outcomes: string[] = []
    for (let round = 0; round < 20; round += 1) {
      const { stripe, customerId, orderId } = await tappedReaderMembership()
      await Promise.all([finaliseReaderOrder(first, stripe, orderId, asStaff()), runReconcile(stripe)])
      // A screen held by reconcile's mark leaves reconcile to finish the compensation; a reconcile left by the screen's start leaves the screen to finish.
      outcomes.push(await oneOutcome(stripe, orderId, customerId))
    }
    process.stdout.write(`\nW13a B1 free-running outcomes: ${JSON.stringify(outcomes)}\n`)
    expect(outcomes.every((outcome) => outcome === 'paid' || outcome === 'gone')).toBe(true)
  })
})

describe('W13c B1: the start and the mark on the locked row, each waiting on the other uncommitted (the W13a review\'s RPG1 to RPG3)', () => {
  const startOf = async (orderId: string) =>
    (await first.query<{ at: string | null; by: string | null; marked: boolean }>(
      "SELECT reader_payment->'membership'->>'subscription_started_at' AS at, reader_payment->'membership'->>'subscription_started_by' AS by, reader_payment ? 'compensation' AS marked FROM orders WHERE id = $1",
      [orderId]
    ))[0]

  it("RPG1: the screen's start written and not yet committed; reconcile's guarded mark waits on the row, then sees it: not marked, 'starting'", async () => {
    const { orderId } = await tappedReaderMembership()
    const start = await holding(first, () => markSubscriptionStarting(first, orderId, 'press-A'))
    expect(start.result).toEqual({ kind: 'started', replaced: false })
    const marking = markCompensating(second, orderId, 'test: reconcile found no subscription', { press: null })
    const waiter = await blockedBy(start.pid)
    expect(await waitingOn(pg, waiter)).toEqual(['orders'])
    await start.finish()
    expect(await marking).toEqual({ marked: false, why: 'starting' })
    expect(await startOf(orderId)).toMatchObject({ by: 'press-A', marked: false })
  })

  it("RPG2: reconcile's mark written and not yet committed; the screen's start waits on the row, then is refused (no subscription may follow)", async () => {
    const { orderId } = await tappedReaderMembership()
    const mark = await holding(first, () => markCompensating(first, orderId, 'test: reconcile found no subscription', { press: null }))
    expect(mark.result).toMatchObject({ marked: true, startedAt: null })
    const starting = markSubscriptionStarting(second, orderId, 'press-A')
    const waiter = await blockedBy(mark.pid)
    expect(await waitingOn(pg, waiter)).toEqual(['orders'])
    await mark.finish()
    expect(await starting).toEqual({ kind: 'not_pending' })
    expect(await startOf(orderId)).toMatchObject({ at: null, marked: true })
  })

  it("RPG3: press Y's start written and not yet committed; press X's start waits on the row, then is refused while Y's is young ('starting'): Y's start stays, and X's own guarded mark is then held off by it", async () => {
    const { orderId } = await tappedReaderMembership()
    const y = await holding(first, () => markSubscriptionStarting(first, orderId, 'press-Y'))
    expect(y.result).toEqual({ kind: 'started', replaced: false })
    const x = markSubscriptionStarting(second, orderId, 'press-X')
    const waiter = await blockedBy(y.pid)
    expect(await waitingOn(pg, waiter)).toEqual(['orders'])
    await y.finish()
    expect(await x).toEqual({ kind: 'starting' })
    expect(await startOf(orderId)).toMatchObject({ by: 'press-Y', marked: false })
    // Before W13c, X's start overwrote Y's, so X's compensation was let through under its "own" start.
    expect(await markCompensating(second, orderId, "test: X's own definite failure", { press: 'press-X' })).toEqual({ marked: false, why: 'starting' })
  })

  it("an expired start (older than the guard): another press's start takes its place, and says it replaced one", async () => {
    const { orderId } = await tappedReaderMembership()
    expect(await markSubscriptionStarting(first, orderId, 'press-Y')).toEqual({ kind: 'started', replaced: false })
    // Test data: Y's start moved back past the guard (a press that died).
    await first.query(
      `UPDATE orders SET reader_payment = jsonb_set(reader_payment, '{membership,subscription_started_at}', to_jsonb(now() - make_interval(secs => $2::int + 5))) WHERE id = $1`,
      [orderId, SUBSCRIPTION_START_GUARD_SECONDS]
    )
    expect(await markSubscriptionStarting(second, orderId, 'press-X')).toEqual({ kind: 'started', replaced: true })
    expect(await startOf(orderId)).toMatchObject({ by: 'press-X' })
    // The same press again: its own start, not a replacement.
    expect(await markSubscriptionStarting(second, orderId, 'press-X')).toEqual({ kind: 'started', replaced: false })
  })
})
