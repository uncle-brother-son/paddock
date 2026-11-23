import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Db } from '@/server/db'
import { reconcile, SCHEDULED_LIMITS, type ReconcileOptions } from '@/server/rules/orders/reconcile'
import { fixtures, startTestDatabase, type TestDatabase } from '@/server/rules/testing/database'
import { FakeStripe } from '@/server/stripe/fake'
import { FREQUENCY_MISMATCH_ACTION, FREQUENCY_READ_ACTION, MAX_FREQUENCY_READS_PER_RUN, MEMBERSHIP_FREQUENCY_MISMATCH } from './frequency-check'

// Brief W67 item 4 (L-new; lead call L-H14): once a day the scheduled run reads each live membership's subscription
// for the interval it renews at, and lists a membership whose row's `billing_frequency` says otherwise, once. Read
// only: nothing is sent to Stripe and the membership's row is never changed. PGlite with the live schema, the fake
// Stripe, the real reconcile.

vi.setConfig({ testTimeout: 60_000 })

let database: TestDatabase
let db: Db
let plan: string
beforeAll(async () => {
  database = await startTestDatabase({ schema: 'live' })
  db = database.db
  plan = await fixtures.plan(db, { level: 'core', sessions_included: 4 })
})
afterAll(() => database.stop())

const scheduled: ReconcileOptions = { actor: { type: 'system', id: null }, requestId: 'w67-frequency', ...SCHEDULED_LIMITS, readIntervals: true }
const runScheduled = (stripe: FakeStripe) => reconcile(db, stripe, { ...scheduled, requestId: crypto.randomUUID() })

/** A fake of its own with a monthly and a yearly price. */
function stripeWithPrices(): FakeStripe {
  const stripe = new FakeStripe({ idTag: crypto.randomUUID().slice(0, 8) })
  stripe.addPrice('price_monthly', 4000, 'month')
  stripe.addPrice('price_yearly', 40000, 'year')
  stripe.addCustomer('cus_freq')
  return stripe
}

/** A live member whose row says `frequency` and whose subscription renews on `price`. */
async function member(stripe: FakeStripe, frequency: string | null, price: 'price_monthly' | 'price_yearly', status = 'active'): Promise<{ membership: string; subscription: string }> {
  const subscription = `sub_freq_${crypto.randomUUID().slice(0, 8)}`
  const customer = await fixtures.customer(db)
  const membership = await fixtures.membership(db, { customer_id: customer, plan_id: plan, billing_frequency: frequency, subscription_status: status, stripe_subscription_id: subscription, next_renewal_date: '2027-01-10' })
  stripe.addSubscription(subscription, 'cus_freq', price)
  return { membership, subscription }
}

/** Every member made so far is no longer live, so each test reads only its own. */
const endEveryone = () => database.pg.exec("RESET ROLE; UPDATE customer_memberships SET subscription_status = 'cancelled'; SET ROLE paddock_worker;")
const reads = (stripe: FakeStripe) => stripe.calls.filter((call) => call.method === 'subscriptions.retrieve').map((call) => (call.params as { id?: string }).id)
const sends = (stripe: FakeStripe) => stripe.calls.filter((call) => !call.method.endsWith('.retrieve') && !call.method.endsWith('.list'))
const LISTED_ROWS_SQL = `SELECT details FROM audit_log WHERE action = '${FREQUENCY_MISMATCH_ACTION}' AND entity_id = $1 ORDER BY at, id`
const listedRows = async (membership: string) => (await db.query<{ details: Record<string, unknown> }>(LISTED_ROWS_SQL, [membership])).map((row) => row.details)
/** The day has passed since every read so far. */
const aDayLater = () => database.pg.exec(`RESET ROLE; UPDATE audit_log SET at = at - interval '25 hours' WHERE action = '${FREQUENCY_READ_ACTION}'; SET ROLE paddock_worker;`)
const rowOf = async (membership: string) => (await db.query<{ frequency: string | null; status: string }>('SELECT billing_frequency AS frequency, subscription_status AS status FROM customer_memberships WHERE id = $1', [membership]))[0]

describe("L-new: a membership whose subscription renews at another interval than its row says (W67)", () => {
  it('a yearly row on a monthly subscription: listed once by the scheduled run, as a line for a person; not read again that day; read the next day and not listed again', async () => {
    await endEveryone()
    const stripe = stripeWithPrices()
    const { membership, subscription } = await member(stripe, 'yearly', 'price_monthly')
    const first = await runScheduled(stripe)
    expect(reads(stripe)).toEqual([subscription])
    expect(first.items).toEqual([expect.objectContaining({ kind: 'step', outcome: 'left', reason: MEMBERSHIP_FREQUENCY_MISMATCH, detail: expect.stringContaining(`row says yearly, and Stripe renews its subscription ${subscription} every month`) })])
    expect(first.left).toBe(1)
    expect(await listedRows(membership)).toEqual([{ state: 'listed', listingId: expect.any(String), subscriptionId: subscription, frequency: 'yearly', stripeInterval: 'month', stripeStatus: 'active' }])
    // The same day: not read again.
    const second = await runScheduled(stripe)
    expect(reads(stripe)).toEqual([subscription])
    expect(second.items).toEqual([])
    // The next day: read again, still wrong, listed already: nothing more.
    await aDayLater()
    const third = await runScheduled(stripe)
    expect(reads(stripe)).toEqual([subscription, subscription])
    expect(third.items).toEqual([])
    expect(await listedRows(membership)).toHaveLength(1)
    // Read only: nothing sent, and the row as it was.
    expect(sends(stripe)).toEqual([])
    expect(await rowOf(membership)).toEqual({ frequency: 'yearly', status: 'active' })
  })

  it('a monthly row on a yearly subscription is listed too; a row with no frequency counts as monthly', async () => {
    await endEveryone()
    const stripe = stripeWithPrices()
    const wrong = await member(stripe, 'monthly', 'price_yearly')
    const unsaid = await member(stripe, null, 'price_yearly')
    const fine = await member(stripe, null, 'price_monthly')
    const run = await runScheduled(stripe)
    expect(new Set(reads(stripe))).toEqual(new Set([wrong.subscription, unsaid.subscription, fine.subscription]))
    expect(run.items.map((item) => item.reason)).toEqual([MEMBERSHIP_FREQUENCY_MISMATCH, MEMBERSHIP_FREQUENCY_MISMATCH])
    expect(await listedRows(wrong.membership)).toMatchObject([{ frequency: 'monthly', stripeInterval: 'year' }])
    expect(await listedRows(unsaid.membership)).toMatchObject([{ frequency: 'monthly', stripeInterval: 'year' }])
    expect(await listedRows(fine.membership)).toEqual([])
  })

  it('a matching interval, a past-due member included: read, nothing listed', async () => {
    await endEveryone()
    const stripe = stripeWithPrices()
    const monthly = await member(stripe, 'monthly', 'price_monthly', 'past_due')
    const yearly = await member(stripe, 'yearly', 'price_yearly')
    expect((await runScheduled(stripe)).items).toEqual([])
    expect(new Set(reads(stripe))).toEqual(new Set([monthly.subscription, yearly.subscription]))
    expect(await listedRows(monthly.membership)).toEqual([])
    expect(await listedRows(yearly.membership)).toEqual([])
  })

  it("only the scheduled run reads: staff's Resolve now, and any run not asked to, reads nothing", async () => {
    await endEveryone()
    const stripe = stripeWithPrices()
    const { membership } = await member(stripe, 'yearly', 'price_monthly')
    await reconcile(db, stripe, { actor: { type: 'staff', id: 'jo' }, requestId: crypto.randomUUID(), maxItems: 10, budgetMs: 15_000 })
    await reconcile(db, stripe, { actor: { type: 'system', id: null }, requestId: crypto.randomUUID(), ...SCHEDULED_LIMITS })
    expect(reads(stripe)).toEqual([])
    expect(await listedRows(membership)).toEqual([])
  })

  it('a subscription ended in Stripe is read and never listed; a read with no clear answer is read again next run', async () => {
    await endEveryone()
    const stripe = stripeWithPrices()
    const ended = await member(stripe, 'yearly', 'price_monthly')
    await stripe.subscriptions.cancel(ended.subscription)
    const unclear = await member(stripe, 'yearly', 'price_monthly')
    stripe.failNext('subscriptions.retrieve', { kind: 'unreachable' })
    const first = await runScheduled(stripe)
    expect(await listedRows(ended.membership)).toEqual([])
    // One of the two got no clear read (the fault is on the first read made): it is read again on the next run.
    const firstReads = reads(stripe)
    expect(firstReads).toHaveLength(2)
    const second = await runScheduled(stripe)
    expect(reads(stripe).slice(2)).toEqual([firstReads[0]])
    expect([...first.items, ...second.items].filter((item) => item.reason === MEMBERSHIP_FREQUENCY_MISMATCH)).toEqual([expect.objectContaining({ detail: expect.stringContaining(unclear.subscription) })])
  })

  it(`at most ${MAX_FREQUENCY_READS_PER_RUN} reads a run; the rest on the next runs, each once a day`, async () => {
    await endEveryone()
    const stripe = stripeWithPrices()
    const made = []
    for (let i = 0; i < MAX_FREQUENCY_READS_PER_RUN + 2; i += 1) made.push(await member(stripe, 'monthly', 'price_monthly'))
    await runScheduled(stripe)
    expect(reads(stripe)).toHaveLength(MAX_FREQUENCY_READS_PER_RUN)
    await runScheduled(stripe)
    expect(new Set(reads(stripe))).toEqual(new Set(made.map((one) => one.subscription)))
    await runScheduled(stripe)
    expect(reads(stripe)).toHaveLength(MAX_FREQUENCY_READS_PER_RUN + 2)
  })
})
