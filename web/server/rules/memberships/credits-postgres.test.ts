import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { POST as storeCreditRoute } from '@/app/api/v1/staff/customers/[customerId]/store-credit/route'
import type { PlaceOrderInput } from '@/contracts'
import type { Db, Tx } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import { adjustStoreCredit } from '@/server/rules/customers/store-credit'
import { LOCK_ORDER } from '@/server/rules/orders/locks'
import { refusalDetails } from '@/server/rules/orders/order-refusal'
import { placeOrder } from '@/server/rules/orders/place-order'
import { fixtures, insert } from '@/server/rules/testing/database'
import { deferred, waitingOn } from '@/server/rules/testing/race'
import { startRealPostgres, type RealPostgres } from '@/server/rules/testing/real-postgres'
import { adjustMembershipCredits, CREDIT_ADJUSTMENT_LOCK_SQL, setMembershipHerd } from './credits'
import { MEMBERSHIP_CREDIT_NEW_WORDS, MEMBERSHIP_CREDIT_WORDS } from './failure-messages'

// Brief W37 item 7 (F-plan 4.12 item 7; bug FB7) on real Postgres 17.6, each Worker client on its own connection: a
// credit adjustment racing a booking paid with a credit (the Worker's own placeOrder), both ways round; two
// adjustments at once; two store credit presses at once, and two with one key. Each race holds one side's transaction
// open, after its writes, until Postgres reports the other as waiting on the row named, so none can pass by timing.
// The controls run the old function's own steps (read, then write a fixed figure) the same way, and go wrong.

const KEY = 'test-staff-api-key'
const STAFF_EMAIL = 'w37-race@example.com'

/** The routes' connections, handed out in order: each request its own, as on the Worker. */
const requests = vi.hoisted(() => ({ next: [] as unknown[] }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => {
    const db = requests.next.shift()
    if (!db) throw new Error('No connection queued for this request.')
    return db
  },
  closeRequestDb: () => {},
}))

let pg: RealPostgres
let first: Db
let second: Db
let third: Db
let staffId: string
let serviceType: string
let band: string
let plan: string
let towel: string
let day = 0

beforeAll(async () => {
  process.env.STAFF_API_KEY = KEY
  pg = await startRealPostgres()
  first = pg.connect()
  second = pg.connect()
  third = pg.connect()
  staffId = await insert(first, 'staff', { role: 'staff', first_name: 'Jo', last_name: 'Staff', email: STAFF_EMAIL, can_issue_refunds: true })
  serviceType = await fixtures.serviceType(first)
  band = await fixtures.band(first, { price: '20.00' })
  plan = await fixtures.plan(first, { level: 'core', sessions_included: 4 })
  await insert(first, 'membership_band_terms', { membership_level: 'core', band_id: band, credit_eligible: true })
  towel = await insert(first, 'addons', { name: 'Towel', sku: 'TOWEL-W37', base_price: '5.00' })
})
afterAll(() => pg.stop())

const by = () => ({ actor: { type: 'staff' as const, id: staffId, canIssueRefunds: true }, requestId: crypto.randomUUID() })
const orderBy = () => ({ actor: { type: 'staff' as const, id: staffId }, requestId: crypto.randomUUID() })
const reasoned = (creditType: 'session' | 'addon', amount: number) => ({ creditType, amount, reason: 'Race test' })

/** A session on its own day, in 2030, so nothing in one test can touch another's. */
async function session(): Promise<string> {
  day += 1
  const start = new Date(Date.UTC(2030, 0, day, 10)).toISOString()
  const end = new Date(Date.UTC(2030, 0, day, 11)).toISOString()
  return fixtures.session(first, { service_type_id: serviceType, band_id: band, start_time: start, end_time: end, capacity: 10 })
}

/** A Herd member with `credits` session credits in a period covering today, and `addon` add-on credits. */
async function member(credits: number, addon = 2): Promise<{ customer: string; membership: string; period: string }> {
  const customer = await fixtures.customer(first)
  const membership = await fixtures.membership(first, { customer_id: customer, plan_id: plan, is_herd: true, billing_frequency: 'monthly', addon_credits_remaining: addon })
  const rows = await first.query<{ id: string }>(
    `INSERT INTO membership_credit_periods (membership_id, period_start, period_end, credits_allocated)
     VALUES ($1, (now() AT TIME ZONE 'Europe/London')::date - 5, (now() AT TIME ZONE 'Europe/London')::date + 25, $2) RETURNING id`,
    [membership, credits]
  )
  return { customer, membership, period: rows[0]?.id as string }
}

const holderGuest = { name: 'Sam Test', email: 'sam@example.com', dateOfBirth: '1990-01-01' }
const creditOrder = (customerId: string, sessionId: string, membershipId: string): PlaceOrderInput => ({ customerId, booking: { sessionId, guests: [holderGuest], redemptionSource: 'membership_credit', membershipId }, payment: {} })
/** A paid seat (£20 in cash) with a towel on one of the membership's add-on credits. */
const towelOnCredit = (customerId: string, sessionId: string, membershipId: string): PlaceOrderInput => ({
  customerId,
  booking: { sessionId, guests: [holderGuest], redemptionSource: 'paid', addons: [{ addonId: towel, quantity: 1, redemptionSource: 'membership_credit', membershipId }] },
  payment: { method: 'cash' },
  confirmed: { toCollect: 20 },
})

type Outcome<T> = { answered: T } | { refused: string; message: string }

async function outcome<T>(work: Promise<T>): Promise<Outcome<T>> {
  try {
    return { answered: await work }
  } catch (err) {
    const order = refusalDetails(err)
    if (order) return { refused: order.reason, message: err instanceof Error ? err.message : '' }
    if (err instanceof ApiError) return { refused: String((err.details as { reason?: unknown } | undefined)?.reason ?? err.code), message: err.message }
    throw err
  }
}

/**
 * `db`, with its first transaction held open after its work is done (every write made, nothing committed) until
 * `finish`. `pid` resolves once the work is done, with that transaction's backend.
 */
function heldOpen(db: Db): { db: Db; pid: Promise<number>; finish(): void } {
  const release = deferred()
  let announce: (pid: number) => void = () => {}
  const pid = new Promise<number>((resolve) => {
    announce = resolve
  })
  let count = 0
  const held = new Proxy(db, {
    get(target, property, receiver) {
      if (property !== 'transaction') return Reflect.get(target, property, receiver) as unknown
      return async <T>(work: (tx: Tx) => Promise<T>): Promise<T> => {
        count += 1
        if (count > 1) return target.transaction(work)
        return target.transaction(async (tx) => {
          const result = await work(tx)
          announce(Number((await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]?.pid))
          await release.promise
          return result
        })
      }
    },
  })
  return { db: held, pid, finish: () => release.resolve() }
}

/** Waits until Postgres itself reports a session blocked by `holder`, and answers that session. */
async function blockedBy(holder: number): Promise<number> {
  const giveUpAt = Date.now() + 4_000
  while (Date.now() < giveUpAt) {
    const rows = await pg.admin.unsafe<{ pid: number }[]>('SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))', [holder])
    if (rows[0]) return rows[0].pid
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Nothing waited on the holder.')
}

/** Runs `held` and keeps it open, starts `waiter`, checks Postgres reports it waiting on `table`, then lets both finish. */
async function race<A, B>(held: (db: Db) => Promise<A>, waiter: (db: Db) => Promise<B>, table: string): Promise<{ held: Outcome<A>; waiter: Outcome<B> }> {
  const holding = heldOpen(first)
  const heldWork = outcome(held(holding.db))
  const holder = await Promise.race([holding.pid, heldWork.then(() => Promise.reject(new Error('The first ended before it could be held.')))])
  let settled = false
  const waiting = outcome(waiter(second)).finally(() => {
    settled = true
  })
  const blocked = await blockedBy(holder)
  expect(settled).toBe(false)
  expect(await waitingOn(pg, blocked)).toEqual([table])
  holding.finish()
  return { held: await heldWork, waiter: await waiting }
}

const one = async <T>(sql: string, params: unknown[]): Promise<T | undefined> => (await third.query<T>(sql, params as never[]))[0]
const allocated = async (period: string) => (await one<{ n: number }>('SELECT credits_allocated AS n FROM membership_credit_periods WHERE id = $1', [period]))?.n
const used = async (period: string) =>
  (await one<{ n: number }>(`SELECT count(*)::int AS n FROM bookings WHERE credit_period_id = $1 AND redemption_source = 'membership_credit' AND status <> 'cancelled'`, [period]))?.n
const addonLeft = async (membership: string) => (await one<{ n: number }>('SELECT addon_credits_remaining AS n FROM customer_memberships WHERE id = $1', [membership]))?.n
const adjustments = async (membership: string) => (await third.query<{ amount: number }>('SELECT amount FROM membership_credit_adjustments WHERE membership_id = $1 ORDER BY created_at, id', [membership])).map((row) => row.amount)
const auditOf = async (entityId: string, action: string) => (await third.query<{ details: Record<string, unknown> }>('SELECT details FROM audit_log WHERE entity_id = $1 AND action = $2 ORDER BY at, id', [entityId, action])).map((row) => row.details)
const ordersFor = async (customer: string) => (await one<{ n: number }>('SELECT count(*)::int AS n FROM orders WHERE customer_id = $1', [customer]))?.n

/** The old adjustMembershipCredits's session branch, step by step: read the allocation and what is used, check, then write a fixed figure. */
async function oldRead(db: Db, membership: string): Promise<{ periodId: string; newAllocated: (amount: number) => number; used: number }> {
  const [row] = await db.query<{ period_id: string; credits_allocated: number; credits_used: number }>('SELECT period_id, credits_allocated, credits_used FROM membership_current_credits WHERE membership_id = $1', [membership])
  if (!row) throw new Error('No current period.')
  return { periodId: row.period_id, newAllocated: (amount) => row.credits_allocated + amount, used: row.credits_used }
}
const oldWrite = (db: Db, periodId: string, value: number) => db.query('UPDATE membership_credit_periods SET credits_allocated = $1 WHERE id = $2', [value, periodId])

describe("the adjustment's lock statement", () => {
  it('takes the credit period, then the membership, in LOCK_ORDER; the membership names the period, so Postgres takes them in that order; both with the lock an UPDATE takes', () => {
    const laterals = [...CREDIT_ADJUSTMENT_LOCK_SQL.matchAll(/JOIN LATERAL \(([\s\S]*?)\) (\w+) ON true/g)].map((match) => ({ body: match[1] ?? '', alias: match[2] ?? '' }))
    expect(laterals.map((lateral) => [lateral.alias, /FROM (\w+)\s+WHERE/.exec(lateral.body)?.[1], /FOR (?:NO KEY )?UPDATE/.exec(lateral.body)?.[0]])).toEqual([
      ['p', 'membership_credit_periods', 'FOR NO KEY UPDATE'],
      ['m', 'customer_memberships', 'FOR NO KEY UPDATE'],
    ])
    expect(LOCK_ORDER.indexOf('credit_period')).toBeLessThan(LOCK_ORDER.indexOf('membership'))
    const membership = laterals[1]?.body ?? ''
    expect(/\bp\.id\b/.test(membership.slice(membership.indexOf('WHERE')))).toBe(true)
    // The period is the one covering today's London date, exactly as lockForOrder finds it.
    expect(laterals[0]?.body).toContain("(now() AT TIME ZONE 'Europe/London')::date BETWEEN period_start AND period_end")
  })
})

describe('a credit booking against an adjustment (FB7)', () => {
  it("the adjustment first (−1 of 1 allocated, none used): the booking waits on the credit period, then is refused (insufficient_membership_credit): 0 allocated, 0 used, no order", async () => {
    const { customer, membership, period } = await member(1)
    const sessionId = await session()
    const result = await race(
      (db) => adjustMembershipCredits(db, membership, reasoned('session', -1), by()),
      (db) => placeOrder(db, creditOrder(customer, sessionId, membership), orderBy()),
      'membership_credit_periods'
    )
    expect(result.held).toMatchObject({ answered: { period: { credits_allocated: 0, credits_used: 0 } } })
    expect(result.waiter).toMatchObject({ refused: 'insufficient_membership_credit' })
    expect([await allocated(period), await used(period), await ordersFor(customer)]).toEqual([0, 0, 0])
    expect(await adjustments(membership)).toEqual([-1])
  })

  it('the booking first: the adjustment waits on the credit period, then is refused below what is used, in the old words: 1 allocated, 1 used, nothing recorded', async () => {
    const { customer, membership, period } = await member(1)
    const sessionId = await session()
    const result = await race(
      (db) => placeOrder(db, creditOrder(customer, sessionId, membership), orderBy()),
      (db) => adjustMembershipCredits(db, membership, reasoned('session', -1), by()),
      'membership_credit_periods'
    )
    expect(result.held).toHaveProperty('answered')
    expect(result.waiter).toEqual({ refused: 'below_used', message: MEMBERSHIP_CREDIT_WORDS.belowUsed(0, 1) })
    expect(result.waiter).toMatchObject({ message: 'Adjustment rejected: the period would be left with 0 allocated credit(s), below the 1 already used.' })
    expect([await allocated(period), await used(period), await ordersFor(customer)]).toEqual([1, 1, 1])
    expect(await adjustments(membership)).toEqual([])
    expect(await auditOf(membership, 'membership.credits_adjusted')).toEqual([])
  })

  it('the adjustment first, then rolled back: the booking, which waited on the credit period, gets the credit', async () => {
    const { customer, membership, period } = await member(1)
    const sessionId = await session()
    const release = deferred()
    const made = deferred()
    let holder = 0
    // The adjustment joins this transaction, which is then thrown away after the booking has queued behind it.
    const adjusting = outcome(
      first.transaction(async (tx) => {
        await adjustMembershipCredits(tx as unknown as Db, membership, reasoned('session', -1), by())
        holder = Number((await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]?.pid)
        made.resolve()
        await release.promise
        throw new ApiError('CONFLICT', 'rolled back by the test')
      })
    )
    await made.promise
    const ordering = outcome(placeOrder(second, creditOrder(customer, sessionId, membership), orderBy()))
    expect(await waitingOn(pg, await blockedBy(holder))).toEqual(['membership_credit_periods'])
    release.resolve()
    expect(await adjusting).toMatchObject({ refused: 'CONFLICT' })
    expect(await ordering).toHaveProperty('answered')
    expect([await allocated(period), await used(period)]).toEqual([1, 1])
    expect(await adjustments(membership)).toEqual([])
    expect(await auditOf(membership, 'membership.credits_adjusted')).toEqual([])
  })

  it("the control, the old function's own steps: it checks 0 allocated against 0 used, a booking takes the credit, and its write leaves 0 allocated with 1 used", async () => {
    const { customer, membership, period } = await member(1)
    const sessionId = await session()
    const read = await oldRead(first, membership)
    expect(read.newAllocated(-1) < read.used).toBe(false)
    await placeOrder(second, creditOrder(customer, sessionId, membership), orderBy())
    await oldWrite(first, read.periodId, read.newAllocated(-1))
    expect([await allocated(period), await used(period)]).toEqual([0, 1])
  })
})

describe('two adjustments at once (FB7)', () => {
  it('session credits, +1 and +2 on 4: the second waits on the credit period and adds to what the first left: 7, both recorded, the second from 5', async () => {
    const { membership, period } = await member(4)
    const result = await race(
      (db) => adjustMembershipCredits(db, membership, reasoned('session', 1), by()),
      (db) => adjustMembershipCredits(db, membership, reasoned('session', 2), by()),
      'membership_credit_periods'
    )
    expect(result.held).toMatchObject({ answered: { period: { credits_allocated: 5 } } })
    expect(result.waiter).toMatchObject({ answered: { period: { credits_allocated: 7 } } })
    expect(await allocated(period)).toBe(7)
    expect(await adjustments(membership)).toEqual([1, 2])
    expect((await auditOf(membership, 'membership.credits_adjusted')).map((row) => [row['before'], row['after']])).toEqual([
      [4, 5],
      [5, 7],
    ])
  })

  it("the control, the old function's own steps: both read 4, and the later write overwrites the earlier: 5, not 7", async () => {
    const { membership, period } = await member(4)
    const [tabOne, tabTwo] = [await oldRead(first, membership), await oldRead(second, membership)]
    await oldWrite(second, tabTwo.periodId, tabTwo.newAllocated(2))
    await oldWrite(first, tabOne.periodId, tabOne.newAllocated(1))
    expect(await allocated(period)).toBe(5)
  })

  it('add-on credits, −2 and −2 on 3: the second waits on the membership, then is refused below zero: 1 left, one record', async () => {
    const { membership } = await member(4, 3)
    const result = await race(
      (db) => adjustMembershipCredits(db, membership, reasoned('addon', -2), by()),
      (db) => adjustMembershipCredits(db, membership, reasoned('addon', -2), by()),
      'customer_memberships'
    )
    expect(result.held).toEqual({ answered: { addon_credits_remaining: 1 } })
    expect(result.waiter).toEqual({ refused: 'addon_below_zero', message: MEMBERSHIP_CREDIT_NEW_WORDS.addonBelowZero(-1) })
    expect(await addonLeft(membership)).toBe(1)
    expect(await adjustments(membership)).toEqual([-2])
  })

  it('a session adjustment and an add-on adjustment on one membership: the second waits on the membership, and both go through', async () => {
    const { membership, period } = await member(4, 2)
    const result = await race(
      (db) => adjustMembershipCredits(db, membership, reasoned('session', 1), by()),
      (db) => adjustMembershipCredits(db, membership, reasoned('addon', 1), by()),
      'customer_memberships'
    )
    expect(result.held).toHaveProperty('answered')
    expect(result.waiter).toEqual({ answered: { addon_credits_remaining: 3 } })
    expect([await allocated(period), await addonLeft(membership)]).toEqual([5, 3])
  })
})

describe('an add-on credit against an adjustment, and Herd', () => {
  it('the adjustment first (−1 of 1 add-on credit): a booking with a towel on that credit waits on the membership, then is refused; the balance is 0, never below', async () => {
    const { customer, membership } = await member(4, 1)
    const sessionId = await session()
    const result = await race(
      (db) => adjustMembershipCredits(db, membership, reasoned('addon', -1), by()),
      (db) => placeOrder(db, towelOnCredit(customer, sessionId, membership), orderBy()),
      'customer_memberships'
    )
    expect(result.held).toEqual({ answered: { addon_credits_remaining: 0 } })
    expect(result.waiter).toMatchObject({ refused: 'insufficient_addon_membership_credit' })
    expect([await addonLeft(membership), await ordersFor(customer)]).toEqual([0, 0])
  })

  it('the booking first: the adjustment waits on the membership, then is refused below zero: the towel keeps its credit, and the balance is 0', async () => {
    const { customer, membership } = await member(4, 1)
    const sessionId = await session()
    const result = await race(
      (db) => placeOrder(db, towelOnCredit(customer, sessionId, membership), orderBy()),
      (db) => adjustMembershipCredits(db, membership, reasoned('addon', -1), by()),
      'customer_memberships'
    )
    expect(result.held).toHaveProperty('answered')
    expect(result.waiter).toEqual({ refused: 'addon_below_zero', message: MEMBERSHIP_CREDIT_NEW_WORDS.addonBelowZero(-1) })
    expect([await addonLeft(membership), await ordersFor(customer)]).toEqual([0, 1])
  })

  it('two Herd changes at once: the second waits on the membership and records what the first left as its before', async () => {
    const { membership } = await member(4)
    const result = await race(
      (db) => setMembershipHerd(db, membership, false, by()),
      (db) => setMembershipHerd(db, membership, null, by()),
      'customer_memberships'
    )
    expect(result.held).toMatchObject({ answered: { membership: { is_herd: false, herd_override: false } } })
    // A monthly member since January 2026: Herd by the rule once six months have passed.
    expect(result.waiter).toMatchObject({ answered: { membership: { herd_override: null } } })
    expect(await auditOf(membership, 'membership.herd_set')).toMatchObject([
      { herd: false, before: { isHerd: true, override: null }, after: { isHerd: false, override: false } },
      { herd: null, before: { isHerd: false, override: false }, after: { override: null } },
    ])
  })
})

describe('store credit: two presses at once, and two with one key (FB12)', () => {
  const withBalance = async (balance: string) => fixtures.customer(first, { store_credit_balance: balance })
  const balanceOf = async (customer: string) => (await one<{ balance: string }>('SELECT store_credit_balance::text AS balance FROM customers WHERE id = $1', [customer]))?.balance
  const movements = async (customer: string) => (await third.query<{ amount: string }>('SELECT amount::text AS amount FROM store_credit_transactions WHERE customer_id = $1 ORDER BY created_at, id', [customer])).map((row) => row.amount)
  const remove20 = { mode: 'remove', amount: 20, reason: 'Race test' }

  it('two removals of £20 from £30 at once: the second waits on the customer, then is refused (it would go below zero): £10 left, one movement', async () => {
    const customer = await withBalance('30.00')
    const result = await race(
      (db) => adjustStoreCredit(db, customer, remove20, by()),
      (db) => adjustStoreCredit(db, customer, remove20, by()),
      'customers'
    )
    expect(result.held).toMatchObject({ answered: { appliedAmount: -20, balance: 10 } })
    expect(result.waiter).toMatchObject({ refused: 'insufficient_store_credit' })
    expect(await balanceOf(customer)).toBe('10.00')
    expect(await movements(customer)).toEqual(['-20.00'])
    expect(await auditOf(customer, 'customer.store_credit_adjusted')).toHaveLength(1)
  })

  it('two additions of £20 at once both go on, one after the other: £30, £50, £70', async () => {
    const customer = await withBalance('30.00')
    const add20 = { mode: 'add', amount: 20, reason: 'Race test' }
    const result = await race(
      (db) => adjustStoreCredit(db, customer, add20, by()),
      (db) => adjustStoreCredit(db, customer, add20, by()),
      'customers'
    )
    expect(result.held).toMatchObject({ answered: { balance: 50 } })
    expect(result.waiter).toMatchObject({ answered: { balance: 70 } })
    expect((await auditOf(customer, 'customer.store_credit_adjusted')).map((row) => [row['balanceBefore'], row['balanceAfter']])).toEqual([
      [30, 50],
      [50, 70],
    ])
  })

  it('two presses with one key, the second while the first is still running: the second is told it is already being processed and changes nothing; once the first has answered, the key gives that answer: £20 on, once', async () => {
    const customer = await withBalance('30.00')
    const key = crypto.randomUUID()
    const send = (db: Db) => {
      requests.next.push(db)
      return storeCreditRoute(
        new Request(`https://worker.test/api/v1/staff/customers/${customer}/store-credit`, {
          method: 'POST',
          headers: { authorization: `Bearer ${KEY}`, 'x-staff-email': STAFF_EMAIL, 'idempotency-key': key, 'content-type': 'application/json' },
          body: JSON.stringify({ mode: 'add', amount: 20, reason: 'Race test' }),
        }),
        { params: Promise.resolve({ customerId: customer }) }
      )
    }
    const holding = heldOpen(first)
    const firstPress = send(holding.db)
    await holding.pid
    // The first press has given the credit inside its transaction and not committed.
    const during = await send(second)
    expect(during.status).toBe(409)
    expect(((await during.json()) as { error: { code: string; message: string } }).error).toEqual({ code: 'CONFLICT', message: 'This request is already being processed' })
    expect(await balanceOf(customer)).toBe('30.00')
    holding.finish()
    const answered = await firstPress
    expect(answered.status).toBe(200)
    const firstBody = (await answered.json()) as { data: unknown }
    expect(firstBody.data).toMatchObject({ appliedAmount: 20, balance: 50 })
    const after = await send(second)
    expect(after.status).toBe(200)
    expect(after.headers.get('Idempotency-Replayed')).toBe('true')
    expect(((await after.json()) as { data: unknown }).data).toEqual(firstBody.data)
    expect(await balanceOf(customer)).toBe('50.00')
    expect(await movements(customer)).toEqual(['20.00'])
    expect(await auditOf(customer, 'customer.store_credit_adjusted')).toHaveLength(1)
  })
})
