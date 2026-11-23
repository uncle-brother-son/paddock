import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { POST as closeRoute } from '@/app/api/v1/staff/orders/stuck/close/route'
import { stuckListOutputSchema } from '@/contracts'
import type { Db } from '@/server/db'
import { reconcile, SCHEDULED_LIMITS, type ReconcileOptions } from '@/server/rules/orders/reconcile'
import { stuckList } from '@/server/rules/orders/stuck-list'
import { ADMIN_TEST_KEY, pressRoute } from '@/server/rules/testing/admin-routes'
import { fixtures, insert, startTestDatabase, type TestDatabase } from '@/server/rules/testing/database'
import { FakeStripe } from '@/server/stripe/fake'
import { LEFT_STEP_WORDS } from './failure-messages'
import { FREQUENCY_LOOK_BACK_HOURS, FREQUENCY_MISMATCH_ACTION, FREQUENCY_READ_ACTION, FREQUENCY_READ_HOURS, frequencyReadsDue, MAX_FREQUENCY_READS_PER_RUN, MEMBERSHIP_FREQUENCY_MISMATCH } from './frequency-check'

// Brief W67 item 4 (L-new; lead call L-H14): once a day the scheduled run reads each live membership's subscription
// for the interval it renews at, and lists a membership whose row's `billing_frequency` says otherwise, once. Read
// only: nothing is sent to Stripe and the membership's row is never changed. PGlite with the live schema, the fake
// Stripe, the real reconcile. W66a: the list costs the same however many notes there are, and a failure of it stops
// nothing else (S2); a membership Stripe never answers about waits behind the others (F3); a mismatch is a line on the
// Orders page's list until Mark sorted (Wayne's Q62).

vi.setConfig({ testTimeout: 60_000 })

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))

const JO = 'jo.frequency@example.com'
const FRAN = 'fran.frequency@example.com'
let database: TestDatabase
let db: Db
let plan: string
let jo: string
beforeAll(async () => {
  process.env.STAFF_API_KEY = ADMIN_TEST_KEY
  database = await startTestDatabase({ schema: 'live' })
  db = database.db
  holder.db = db
  plan = await fixtures.plan(db, { name: 'Core', level: 'core', sessions_included: 4 })
  jo = await insert(db, 'staff', { role: 'staff', first_name: 'Jo', last_name: 'Staff', email: JO, can_issue_refunds: true })
  await insert(db, 'staff', { role: 'staff', first_name: 'Fran', last_name: 'Desk', email: FRAN, can_issue_refunds: false, can_manage_pricing: true })
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
async function member(stripe: FakeStripe, frequency: string | null, price: 'price_monthly' | 'price_yearly', status = 'active', who: Record<string, unknown> = {}): Promise<{ membership: string; subscription: string; customer: string }> {
  const subscription = `sub_freq_${crypto.randomUUID().slice(0, 8)}`
  const customer = await fixtures.customer(db, who)
  const membership = await fixtures.membership(db, { customer_id: customer, plan_id: plan, billing_frequency: frequency, subscription_status: status, stripe_subscription_id: subscription, next_renewal_date: '2027-01-10' })
  stripe.addSubscription(subscription, 'cus_freq', price)
  return { membership, subscription, customer }
}

/** Every member made so far is no longer live, so each test reads only its own. */
const endEveryone = () => database.pg.exec("RESET ROLE; UPDATE customer_memberships SET subscription_status = 'cancelled'; SET ROLE paddock_worker;")
const reads = (stripe: FakeStripe) => stripe.calls.filter((call) => call.method === 'subscriptions.retrieve').map((call) => (call.params as { id?: string }).id)
const sends = (stripe: FakeStripe) => stripe.calls.filter((call) => !call.method.endsWith('.retrieve') && !call.method.endsWith('.list'))
const LISTED_ROWS_SQL = `SELECT details FROM audit_log WHERE action = '${FREQUENCY_MISMATCH_ACTION}' AND entity_id = $1 ORDER BY at, ctid`
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

  it("a subscription renewing every 3 months (interval_count 3) is another interval than monthly: listed, with words that say so; every 1 month is monthly (W70a, the W70 audit's S1 d)", async () => {
    await endEveryone()
    const stripe = stripeWithPrices()
    stripe.addPrice('price_quarterly', 12000, 'month', 'gbp', true, 3)
    stripe.addPrice('price_two_yearly', 80000, 'year', 'gbp', true, 2)
    const quarterly = await member(stripe, 'monthly', 'price_quarterly' as 'price_monthly')
    const twoYearly = await member(stripe, 'yearly', 'price_two_yearly' as 'price_yearly')
    const monthly = await member(stripe, 'monthly', 'price_monthly')
    const run = await runScheduled(stripe)
    expect(new Set(reads(stripe))).toEqual(new Set([quarterly.subscription, twoYearly.subscription, monthly.subscription]))
    expect(await listedRows(quarterly.membership)).toMatchObject([{ state: 'listed', frequency: 'monthly', stripeInterval: 'monthx3' }])
    expect(await listedRows(twoYearly.membership)).toMatchObject([{ state: 'listed', frequency: 'yearly', stripeInterval: 'yearx2' }])
    expect(await listedRows(monthly.membership)).toEqual([])
    expect(run.items.map((item) => item.reason)).toEqual([MEMBERSHIP_FREQUENCY_MISMATCH, MEMBERSHIP_FREQUENCY_MISMATCH])
    const words = (await stuckList(db)).steps.filter((step) => step.what === 'frequency_mismatch').map((step) => step.words)
    expect(words.some((line) => line.includes('every 3 months'))).toBe(true)
    expect(sends(stripe)).toEqual([])
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

/** A note of memberships read (or tried), `hoursAgo`. */
const note = (details: Record<string, unknown>, hoursAgo: number) =>
  db.query(
    "INSERT INTO audit_log (at, actor_type, action, entity_type, entity_id, details) VALUES (now() - make_interval(mins => $1::int), 'system', $2, 'reconcile', $3, $4::jsonb)",
    [Math.round(hoursAgo * 60), FREQUENCY_READ_ACTION, crypto.randomUUID(), JSON.stringify(details)]
  )
const keyOf = (one: { membership: string; subscription: string }) => `${one.membership}|${one.subscription}`
const dueNow = async () => (await frequencyReadsDue(db, 50)).map((due) => due.membershipId)

describe('S2 (the W66 review): the list of reads due', () => {
  it('looks back 48 hours and no further: one read longer ago than that counts as never read, so it goes first, with the never read', async () => {
    expect([FREQUENCY_READ_HOURS, FREQUENCY_LOOK_BACK_HOURS]).toEqual([24, 48])
    await endEveryone()
    const stripe = stripeWithPrices()
    const made = [await member(stripe, 'monthly', 'price_monthly'), await member(stripe, 'monthly', 'price_monthly'), await member(stripe, 'monthly', 'price_monthly'), await member(stripe, 'monthly', 'price_monthly')]
    made.sort((a, b) => (a.membership < b.membership ? -1 : 1))
    const [longAgo, never, aDayAgo, today] = made as [(typeof made)[0], (typeof made)[0], (typeof made)[0], (typeof made)[0]]
    await note({ read: [keyOf(longAgo)] }, 49)
    await note({ read: [keyOf(aDayAgo)] }, 25)
    await note({ read: [keyOf(today)] }, 23)
    // By id among those never read (in the look-back): an unbounded look would put `never` before `longAgo`.
    expect(await dueNow()).toEqual([longAgo.membership, never.membership, aDayAgo.membership])
    // A note in another shape is no read, and never an error.
    await note({ read: 'not a list' }, 1)
    await note({}, 1)
    expect(await dueNow()).toEqual([longAgo.membership, never.membership, aDayAgo.membership])
  })

  it('a list that cannot be read reads nothing this run, and the rest of the run goes on', async () => {
    await endEveryone()
    const stripe = stripeWithPrices()
    const { membership } = await member(stripe, 'yearly', 'price_monthly')
    let asked = 0
    const failing = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== 'query') return Reflect.get(target, property, receiver) as unknown
        return (sql: string, params?: readonly never[]) => {
          if (sql.includes(FREQUENCY_READ_ACTION)) {
            asked += 1
            return Promise.reject(new Error('the list timed out'))
          }
          return target.query(sql, params)
        }
      },
    })
    const run = await reconcile(failing, stripe, { ...scheduled, requestId: crypto.randomUUID() })
    expect(asked).toBe(1)
    expect(run).toMatchObject({ checked: 0, left: 0, stripeRefused: false })
    expect(reads(stripe)).toEqual([])
    expect(await listedRows(membership)).toEqual([])
    // The next run, with the list read: as ever.
    await runScheduled(stripe)
    expect(await listedRows(membership)).toHaveLength(1)
  })
})

describe('F3 (the W66 review): a membership Stripe gives no clear answer about', () => {
  it('is noted as tried, so it waits behind the others: five of them never take every run', async () => {
    await endEveryone()
    const stripe = stripeWithPrices()
    const made = []
    for (let i = 0; i < MAX_FREQUENCY_READS_PER_RUN + 2; i += 1) made.push(await member(stripe, 'monthly', 'price_monthly'))
    made.sort((a, b) => (a.membership < b.membership ? -1 : 1))
    const stuck = made.slice(0, MAX_FREQUENCY_READS_PER_RUN)
    const others = made.slice(MAX_FREQUENCY_READS_PER_RUN)
    // The first five (by id) get no answer.
    for (let i = 0; i < MAX_FREQUENCY_READS_PER_RUN; i += 1) stripe.failNext('subscriptions.retrieve', { kind: 'unreachable' })
    await runScheduled(stripe)
    expect(reads(stripe)).toEqual(stuck.map((one) => one.subscription))
    const [noted] = await db.query<{ details: { read?: string[]; tried?: string[] } }>("SELECT details FROM audit_log WHERE action = $1 AND at > now() - interval '1 minute' ORDER BY at DESC, ctid DESC LIMIT 1", [FREQUENCY_READ_ACTION])
    expect(noted?.details).toEqual({ read: [], tried: stuck.map(keyOf) })
    // The next run takes the two never looked at first, then the ones tried.
    expect((await dueNow()).slice(0, 2)).toEqual(others.map((one) => one.membership))
    for (let i = 0; i < 3; i += 1) stripe.failNext('subscriptions.retrieve', { kind: 'unreachable' })
    stripe.calls.length = 0
    await runScheduled(stripe)
    expect(reads(stripe)).toHaveLength(MAX_FREQUENCY_READS_PER_RUN)
    expect(reads(stripe).slice(0, 2)).toEqual(others.map((one) => one.subscription))
    // One read once Stripe answers: read that day, and not again.
    stripe.calls.length = 0
    await runScheduled(stripe)
    await runScheduled(stripe)
    await runScheduled(stripe)
    expect(new Set(reads(stripe)).size).toBe(reads(stripe).length)
    expect(await dueNow()).toEqual([])
  })
})

// --- Wayne's Q62 (23 Nov): the line on the Orders page's list

/** The subscription now renews on another price, as a person leaves it in Stripe's dashboard (the fake models no switch across intervals, so it is put there again on that price). */
const moveTo = (stripe: FakeStripe, subscription: string, price: string) => stripe.addSubscription(subscription, 'cus_freq', price)
const lines = async () => (await stuckList(db)).steps.filter((step) => step.what === 'frequency_mismatch')
const close = (listingId: string, email = JO, reason = 'Put right in Stripe by hand', key: string = crypto.randomUUID()) =>
  pressRoute<Record<string, unknown>>(closeRoute, 'POST', { email, params: {}, body: { kind: 'frequency_mismatch', orderId: listingId, reason }, key })

describe("Q62: a frequency mismatch on the Orders page's list", () => {
  it('is a line for a person naming the member, the plan, the two frequencies and what to do; Mark sorted closes it, audited, once', async () => {
    await endEveryone()
    const stripe = stripeWithPrices()
    const { membership, subscription, customer } = await member(stripe, 'yearly', 'price_monthly', 'active', { first_name: 'Mo', last_name: 'Member' })
    await runScheduled(stripe)
    const [listing] = await listedRows(membership)
    const listingId = String(listing?.['listingId'])
    const words = `Mo Member's Core membership is paid yearly here, but Stripe renews its subscription (${subscription}) every month, so a change to the plan's price could pass this member by. Nothing was changed. Check the subscription in Stripe: if Stripe is wrong, put it right there; if the membership here is wrong, tell a manager. Then press Mark sorted (needs the Issue refunds permission). If the two still differ at the next day's check, it is listed again.`
    expect(await lines()).toEqual([
      { stepId: listingId, membershipId: membership, subscriptionId: subscription, step: 'price', what: 'frequency_mismatch', customerId: customer, customerName: 'Mo Member', state: 'refused', at: expect.any(String), words, close: { kind: 'frequency_mismatch', orderId: listingId } },
    ])
    // The contract the staff app reads takes it.
    expect(stuckListOutputSchema.parse(JSON.parse(JSON.stringify(await stuckList(db)))).steps?.map((step) => step.what)).toEqual(['frequency_mismatch'])

    stripe.calls.length = 0
    // Without Issue refunds (Manage pricing is not enough): refused, still listed.
    expect((await close(listingId, FRAN)).status).toBe(403)
    expect(await lines()).toHaveLength(1)
    const before = await rowOf(membership)
    expect((await close(listingId)).data).toEqual({ closed: true, kind: 'frequency_mismatch', orderId: listingId, message: 'Marked as sorted. It is no longer listed.' })
    expect(await lines()).toEqual([])
    const audited = await db.query<{ actor_type: string; actor_id: string | null; action: string; entity_type: string; entity_id: string; details: Record<string, unknown> }>(
      "SELECT actor_type, actor_id, action, entity_type, entity_id, details FROM audit_log WHERE (details->>'listingId' = $1 AND details->>'state' = 'sorted') OR (entity_id = $1 AND action = 'order.close') ORDER BY action",
      [listingId]
    )
    const detail = { subscriptionId: subscription, frequency: 'yearly', stripeInterval: 'month' }
    expect(audited).toEqual([
      { actor_type: 'staff', actor_id: jo, action: FREQUENCY_MISMATCH_ACTION, entity_type: 'membership', entity_id: membership, details: { state: 'sorted', listingId, ...detail, byHand: { why: 'Put right in Stripe by hand' } } },
      { actor_type: 'staff', actor_id: jo, action: 'order.close', entity_type: 'membership_frequency', entity_id: listingId, details: { kind: 'frequency_mismatch', why: 'Put right in Stripe by hand', membershipId: membership, ...detail } },
    ])
    // Pressed again (an answer lost): closed already, nothing more written. Nothing to Stripe, and the membership as it was.
    expect((await close(listingId)).data).toEqual({ closed: true, alreadyClosed: true, kind: 'frequency_mismatch', orderId: listingId, message: 'Marked as sorted. It is no longer listed.' })
    expect(await db.query("SELECT 1 FROM audit_log WHERE action = 'order.close' AND entity_id = $1", [listingId])).toHaveLength(1)
    expect(stripe.calls).toEqual([])
    expect(await rowOf(membership)).toEqual(before)
  })

  it('marked sorted and put right in Stripe: never listed again; marked sorted and still wrong: listed again at the next day\'s read, as a new line', async () => {
    await endEveryone()
    const stripe = stripeWithPrices()
    const right = await member(stripe, 'yearly', 'price_monthly')
    const wrong = await member(stripe, 'yearly', 'price_monthly')
    await runScheduled(stripe)
    for (const line of await lines()) expect((await close(String(line.stepId))).data).toMatchObject({ closed: true })
    moveTo(stripe, right.subscription, 'price_yearly')
    // The same day: nothing read, nothing listed.
    await runScheduled(stripe)
    expect(await lines()).toEqual([])
    await aDayLater()
    const run = await runScheduled(stripe)
    expect(run.items.map((item) => item.reason)).toEqual([MEMBERSHIP_FREQUENCY_MISMATCH])
    expect((await lines()).map((line) => line.membershipId)).toEqual([wrong.membership])
    expect((await listedRows(wrong.membership)).filter((row) => row['state'] === 'listed')).toHaveLength(2)
    // And not again while that line stands.
    await aDayLater()
    expect((await runScheduled(stripe)).items).toEqual([])
    expect(await lines()).toHaveLength(1)
  })

  it('Stripe\'s interval changed again: one line, saying the newest; the older listing can no longer be marked sorted', async () => {
    await endEveryone()
    const stripe = stripeWithPrices()
    const { membership, subscription } = await member(stripe, 'yearly', 'price_monthly')
    await runScheduled(stripe)
    const older = String((await lines())[0]?.stepId)
    stripe.addPrice('price_weekly', 1000, 'week' as never)
    moveTo(stripe, subscription, 'price_weekly')
    await aDayLater()
    await runScheduled(stripe)
    const now = await lines()
    expect(now).toHaveLength(1)
    expect(now[0]?.words).toContain(`Stripe renews its subscription (${subscription}) every week`)
    expect((await close(older)).data).toEqual({ closed: false, reason: 'not_listed', kind: 'frequency_mismatch', orderId: older, message: LEFT_STEP_WORDS.notListed })
    expect((await close(String(now[0]?.stepId))).data).toMatchObject({ closed: true })
    expect(await lines()).toEqual([])
    expect((await listedRows(membership)).filter((row) => row['state'] === 'listed')).toHaveLength(2)
  })

  it('goes by itself when the membership ends, or its frequency here is put right; Mark sorted is then refused, as for an id that names no line', async () => {
    await endEveryone()
    const stripe = stripeWithPrices()
    const ended = await member(stripe, 'yearly', 'price_monthly')
    const fixed = await member(stripe, 'yearly', 'price_monthly')
    await runScheduled(stripe)
    const ids = new Map((await lines()).map((line) => [line.membershipId, String(line.stepId)]))
    expect(ids.size).toBe(2)
    await database.pg.exec(`RESET ROLE; UPDATE customer_memberships SET subscription_status = 'cancelled' WHERE id = '${ended.membership}'; UPDATE customer_memberships SET billing_frequency = 'monthly' WHERE id = '${fixed.membership}'; SET ROLE paddock_worker;`)
    expect(await lines()).toEqual([])
    const before = (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_log'))[0]?.n
    for (const id of [ids.get(ended.membership) as string, ids.get(fixed.membership) as string, crypto.randomUUID()]) {
      expect((await close(id)).data).toEqual({ closed: false, reason: 'not_listed', kind: 'frequency_mismatch', orderId: id, message: LEFT_STEP_WORDS.notListed })
    }
    expect((await db.query<{ n: number }>('SELECT count(*)::int AS n FROM audit_log'))[0]?.n).toBe(before)
  })

  it('the words for each interval, and with no name or plan known', () => {
    const words = LEFT_STEP_WORDS.frequencyMismatch
    expect(words('Mo Member', 'Core', 'monthly', 'year', 'sub_1')).toContain("Mo Member's Core membership is paid monthly here, but Stripe renews its subscription (sub_1) every year, so")
    expect(words('Mo Member', 'Core', 'yearly', 'monthx3', 'sub_1')).toContain('Stripe renews its subscription (sub_1) every 3 months, so')
    expect(words(null, null, 'yearly', 'unknown', 'sub_1')).toContain("A membership is paid yearly here, but Stripe doesn't show one renewal period for its subscription (sub_1), so")
  })
})

// Last in the file: it leaves 300 members and 2,000 notes behind.
describe('S2: 2,000 old notes', () => {
  it('leave the list as fast as it was: 300 live members, under 250 ms (the unbounded list took about 740 ms here)', async () => {
    await endEveryone()
    await db.query(
      `WITH people AS (INSERT INTO customers (first_name, last_name, email, date_of_birth) SELECT 'Timing', 'Member ' || i, 'timing-' || i || '@example.com', '1980-01-01' FROM generate_series(1, 300) i RETURNING id)
       INSERT INTO customer_memberships (customer_id, plan_id, start_date, billing_frequency, subscription_status, stripe_subscription_id, next_renewal_date)
       SELECT id, $1::uuid, '2026-01-01', 'monthly', 'active', 'sub_timing_' || id, '2027-01-10' FROM people`,
      [plan]
    )
    await db.query(
      `INSERT INTO audit_log (at, actor_type, action, entity_type, entity_id, details)
       SELECT now() - make_interval(hours => 72 + i), 'system', $1, 'reconcile', gen_random_uuid()::text,
              jsonb_build_object('read', (SELECT jsonb_agg(k.key) FROM (SELECT cm.id::text || '|' || cm.stripe_subscription_id AS key FROM customer_memberships cm WHERE cm.subscription_status = 'active' ORDER BY cm.id OFFSET (i * 5) % 300 LIMIT 5) k))
       FROM generate_series(1, 2000) i`,
      [FREQUENCY_READ_ACTION]
    )
    const took: number[] = []
    for (let i = 0; i < 3; i += 1) {
      const started = performance.now()
      expect(await frequencyReadsDue(db)).toHaveLength(MAX_FREQUENCY_READS_PER_RUN)
      took.push(performance.now() - started)
    }
    expect(Math.min(...took), `took ${took.map((ms) => Math.round(ms)).join(', ')} ms`).toBeLessThan(250)
  })
})
