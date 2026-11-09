import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PlaceOrderInput, PlaceOrderOutput } from '@/contracts'
import { DbTimeoutError, isDeadlock, type Db, type Tx } from '@/server/db'
import { attempt, deferred, makeRace, Refused, waitingOn, type Outcome, type Race } from '@/server/rules/testing/race'
import { fixtures, insert } from '@/server/rules/testing/database'
import { startRealPostgres, type RealPostgres } from '@/server/rules/testing/real-postgres'
import { ORDER_ROWS_SQL } from './order-rows'
import { refusalDetails } from './order-refusal'
import { placeOrder } from './place-order'

// T1 on real Postgres 17.6, two (and for the lock order three) Worker clients at once, each a real
// db.transaction() through the real driver. The races hold the first order open, after its writes,
// until Postgres reports the second as waiting on it, so none of these can pass by luck of timing.

let pg: RealPostgres
let first: Db
let second: Db
let prober: Db
let race: Race

const options = { actor: { type: 'staff' as const, id: 'race-test' }, requestId: 'race-test' }

beforeAll(async () => {
  pg = await startRealPostgres()
  first = pg.connect()
  second = pg.connect()
  prober = pg.connect()
  race = makeRace(pg, first, second)
})
afterAll(() => pg.stop())

// --- A small world: a public sauna on a Core band, members with a credit, customers who pay

let serviceType: string
let plungeType: string
let band: string
let plan: string
let towel: string
let day = 0

beforeAll(async () => {
  serviceType = await fixtures.serviceType(first)
  plungeType = await fixtures.serviceType(first, { name: 'Cold Plunge' })
  band = await fixtures.band(first, { price: '20.00' })
  plan = await fixtures.plan(first, { level: 'core', sessions_included: 1 })
  await insert(first, 'membership_band_terms', { membership_level: 'core', band_id: band, credit_eligible: true })
  towel = await insert(first, 'addons', { name: 'Towel', sku: 'TOWEL', base_price: '5.00' })
})

/** A session on its own day, in 2030, so nothing in one test can touch another's. */
async function session(row: Record<string, unknown> = {}, sameDayAs?: { start: string }): Promise<{ id: string; start: string }> {
  if (!sameDayAs) day += 1
  const base = sameDayAs ? new Date(sameDayAs.start) : new Date(Date.UTC(2030, 0, day, 10))
  const start = new Date(base.getTime() + (sameDayAs ? 3 : 0) * 3_600_000).toISOString()
  const end = new Date(new Date(start).getTime() + 3_600_000).toISOString()
  const id = await fixtures.session(first, { service_type_id: serviceType, band_id: band, start_time: start, end_time: end, capacity: 10, ...row })
  return { id, start }
}

/** A Herd member with one session credit left in a period covering today, and add-on credits. */
async function member(credits = 1): Promise<{ customer: string; membership: string; period: string }> {
  const customer = await fixtures.customer(first)
  const membership = await fixtures.membership(first, { customer_id: customer, plan_id: plan, is_herd: true, addon_credits_remaining: 5 })
  const rows = await first.query<{ id: string }>(
    `INSERT INTO membership_credit_periods (membership_id, period_start, period_end, credits_allocated)
     VALUES ($1, (now() AT TIME ZONE 'Europe/London')::date - 5, (now() AT TIME ZONE 'Europe/London')::date + 25, $2) RETURNING id`,
    [membership, credits]
  )
  return { customer, membership, period: rows[0]?.id as string }
}

const holderGuest = { name: 'Sam Test', email: 'sam@example.com', dateOfBirth: '1990-01-01' }

function paidOrder(customerId: string, sessionId: string): PlaceOrderInput {
  return {
    customerId,
    booking: { sessionId, guests: [holderGuest], redemptionSource: 'paid' },
    payment: { method: 'cash' },
    confirmed: { toCollect: 20 },
  }
}

function creditOrder(customerId: string, sessionId: string, membershipId: string): PlaceOrderInput {
  return { customerId, booking: { sessionId, guests: [holderGuest], redemptionSource: 'membership_credit', membershipId }, payment: {} }
}

/** placeOrder inside the race's transaction (it joins it), with a refusal turned into the race's Refused. */
function placing(input: (who: 'first' | 'second') => PlaceOrderInput, as: typeof options = options) {
  return async (_tx: Tx, who: 'first' | 'second') => {
    try {
      return await placeOrder(who === 'first' ? first : second, input(who), as)
    } catch (err) {
      const details = refusalDetails(err)
      if (details) throw new Refused(details.reason)
      throw err
    }
  }
}

const count = async (sql: string, params: unknown[]) => (await first.query<{ n: number }>(sql, params as never[]))[0]?.n

const bookingsOn = (sessionId: string) => count('SELECT count(*)::int AS n FROM bookings WHERE session_id = $1', [sessionId])
const creditUsed = (period: string) =>
  count(`SELECT count(*)::int AS n FROM bookings WHERE credit_period_id = $1 AND redemption_source = 'membership_credit' AND status <> 'cancelled'`, [period])
const ordersFor = (customer: string) => count('SELECT count(*)::int AS n FROM orders WHERE customer_id = $1', [customer])

/** Waits until Postgres reports a session blocked by `holder`. */
async function blockedBy(holder: number): Promise<number> {
  const giveUpAt = Date.now() + 4_000
  while (Date.now() < giveUpAt) {
    const rows = await pg.admin.unsafe<{ pid: number }[]>('SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))', [holder])
    if (rows[0]) return rows[0].pid
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Nothing waited on the holder.')
}

/**
 * A transaction on `db` that runs `hold`, reports its backend pid and stays open until released.
 * What another writer in Retool (the old functions take no customer lock) or a second request does.
 */
async function holding(db: Db, hold: (tx: Tx) => Promise<void>) {
  const release = deferred()
  let end: 'commit' | 'rollback' = 'commit'
  let announce: (pid: number) => void = () => {}
  const pid = new Promise<number>((resolve) => {
    announce = resolve
  })
  const done = db
    .transaction(async (tx) => {
      await hold(tx)
      announce((await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]?.pid as number)
      await release.promise
      if (end === 'rollback') throw new Refused('holder_rolled_back')
    })
    .catch((err: unknown) => {
      if (!(err instanceof Refused)) throw err
    })
  const ended = done.then(() => Promise.reject(new Error('The holder ended before it was released.')))
  return {
    pid: await Promise.race([pid, ended]),
    async finish(how: 'commit' | 'rollback') {
      end = how
      release.resolve()
      await done
    },
  }
}

/** placeOrder on its own, its refusal as an outcome. */
async function placed(db: Db, input: PlaceOrderInput, as: typeof options = options): Promise<Outcome<unknown>> {
  try {
    return { won: await placeOrder(db, input, as) }
  } catch (err) {
    const details = refusalDetails(err)
    if (details) return { refused: new Refused(details.reason) }
    throw err
  }
}

// --- W07: products and passes bought

/** A product picked up at the desk (£12), and its one variant with `stock` in stock. */
async function variant(stock: number, id?: string): Promise<string> {
  const product = await insert(first, 'products', { name: `Soap ${crypto.randomUUID().slice(0, 8)}`, base_price: '12.00', fulfillment_method: 'pickup' })
  return insert(first, 'product_variants', { ...(id ? { id } : {}), product_id: product, sku: `SKU-${crypto.randomUUID()}`, stock_quantity: stock })
}

function productOrder(customerId: string, lines: ReadonlyArray<readonly [string, number]>): PlaceOrderInput {
  return {
    customerId,
    products: lines.map(([productVariantId, quantity]) => ({ productVariantId, quantity })),
    payment: { method: 'cash' },
    confirmed: { toCollect: lines.reduce((sum, [, quantity]) => sum + 12 * quantity, 0) },
  }
}

const stockOf = (variantId: string) => count('SELECT stock_quantity AS n FROM product_variants WHERE id = $1', [variantId])
const ledgerFor = (variantId: string) => count('SELECT count(*)::int AS n FROM stock_adjustments WHERE variant_id = $1', [variantId])

// --- W08: events

/** An event order names the member of staff who placed it, so it needs a real one. */
let asStaff: typeof options
beforeAll(async () => {
  const staffId = await insert(first, 'staff', { role: 'staff', first_name: 'Jo', last_name: 'Staff', email: 'race-staff@example.com' })
  asStaff = { actor: { type: 'staff' as const, id: staffId }, requestId: 'race-test' }
})

/** The customer at the event (public, £40 a place), with `guests` more. */
function eventPart(eventId: string, guests = 0): NonNullable<PlaceOrderInput['event']> {
  return {
    eventId,
    accountHolderAttending: true,
    ...(guests > 0 ? { guestsOver18Confirmed: true } : {}),
    attendees: [
      { ...holderGuest, isAccountHolder: true },
      ...Array.from({ length: guests }, (_, i) => ({ name: `Guest ${i + 1}`, email: null, isAccountHolder: false })),
    ],
  }
}

function eventOrder(customerId: string, eventId: string, guests = 0): PlaceOrderInput {
  return { customerId, event: eventPart(eventId, guests), payment: { method: 'cash' }, confirmed: { toCollect: 40 * (guests + 1) } }
}

const placesBooked = (eventId: string) => count('SELECT places_booked AS n FROM events WHERE id = $1', [eventId])
const eventBookingsFor = (eventId: string) => count('SELECT count(*)::int AS n FROM event_bookings WHERE event_id = $1', [eventId])

describe('the last place in a session', () => {
  async function lastPlace() {
    const last = await session({ capacity: 6, total_booked: 5 })
    return { session: last.id, first: await fixtures.customer(first), second: await fixtures.customer(first) }
  }

  it('goes to the first; the second waited on the session and is refused', async () => {
    const seed = await lastPlace()
    const result = await race(placing((who) => paidOrder(seed[who], seed.session)), 'commit', 'sessions')
    expect(result.first).toHaveProperty('won')
    expect(result.second).toMatchObject({ refused: { reason: 'insufficient_capacity' } })
    expect(await bookingsOn(seed.session)).toBe(1)
    expect(await ordersFor(seed.second)).toBe(0)
  })

  it('goes to the second if the first rolls back', async () => {
    const seed = await lastPlace()
    const result = await race(placing((who) => paidOrder(seed[who], seed.session)), 'rollback')
    expect(result.second).toHaveProperty('won')
    expect(await bookingsOn(seed.session)).toBe(1)
  })

  it('has one winner in every free-running race', async () => {
    for (let round = 0; round < 15; round += 1) {
      const seed = await lastPlace()
      const results = await Promise.all([placed(first, paidOrder(seed.first, seed.session)), placed(second, paidOrder(seed.second, seed.session))])
      expect(results.filter((r) => 'won' in r)).toHaveLength(1)
      expect(results.find((r) => 'refused' in r)).toMatchObject({ refused: { reason: 'insufficient_capacity' } })
      expect(await bookingsOn(seed.session)).toBe(1)
    }
  }, 60_000)
})

describe('the last membership credit', () => {
  // A membership belongs to the customer who orders, and T1 locks the customer first, so a second
  // order on the same membership queues on the customer, not on the credit period. The period lock
  // is proven by "2.4 item 2" below, where the holder takes the period without the customer.
  it('two orders on one membership: the second waits on the customer, then sees the credit gone', async () => {
    const { customer, membership, period } = await member(1)
    const sessions = { first: (await session()).id, second: (await session()).id }
    const result = await race(placing((who) => creditOrder(customer, sessions[who], membership)), 'commit', 'customers')
    expect(result.first).toHaveProperty('won')
    expect(result.second).toMatchObject({ refused: { reason: 'insufficient_membership_credit' } })
    expect(await creditUsed(period)).toBe(1)
  })

  it('the second, waiting on the customer, gets it if the first rolls back', async () => {
    const { customer, membership, period } = await member(1)
    const sessions = { first: (await session()).id, second: (await session()).id }
    const result = await race(placing((who) => creditOrder(customer, sessions[who], membership)), 'rollback', 'customers')
    expect(result.second).toHaveProperty('won')
    expect(await creditUsed(period)).toBe(1)
  })

  /** What createBooking does: lock the period, then a booking on it. It takes no customer lock. */
  const oldCreditBooking = (sessionId: string, customer: string, membership: string, period: string) => async (tx: Tx) => {
    await tx.query('SELECT id FROM membership_credit_periods WHERE id = $1 FOR UPDATE', [period])
    await tx.query(
      `INSERT INTO bookings (session_id, customer_id, party_size, status, price_paid, redemption_source, start_time, end_time, redeemed_membership_id, credit_period_id)
       SELECT s.id, $2, 1, 'confirmed', 0, 'membership_credit', s.start_time, s.end_time, $3, $4 FROM sessions s WHERE s.id = $1`,
      [sessionId, customer, membership, period]
    )
  }

  it("2.4 item 2: an order that waited on the period's lock counts the credit afresh", async () => {
    const { customer, membership, period } = await member(1)
    const [taken, wanted] = [await session(), await session()]
    const holder = await holding(second, oldCreditBooking(taken.id, customer, membership, period))
    const order = placed(first, creditOrder(customer, wanted.id, membership))
    const waiter = await blockedBy(holder.pid)
    // The order waits on the period, and in its own lock statement. Without that statement it would
    // still wait on the period, but later, in the booking statement (the foreign key's KEY SHARE
    // against the holder's FOR UPDATE), with the count it read before waiting.
    expect(await waitingOn(pg, waiter)).toEqual(['membership_credit_periods'])
    const [waiting] = await pg.admin.unsafe<{ query: string }[]>('SELECT query FROM pg_stat_activity WHERE pid = $1', [waiter])
    expect(waiting?.query).toMatch(/^\s*SELECT s\.id AS session_id, p\.id AS credit_period_id/)
    await holder.finish('commit')
    expect(await order).toMatchObject({ refused: { reason: 'insufficient_membership_credit' } })
    expect(await creditUsed(period)).toBe(1)
  })

  // The control: createBooking's own guarded INSERT, as the one waiting. Postgres re-checks the
  // period row it waited for, but not the count, which it read before waiting: it spends a credit
  // that has gone. So the order's separate lock statement is what keeps the credit right.
  it('2.4 item 2, the control: a guarded INSERT that waited spends the credit twice', async () => {
    const { customer, membership, period } = await member(1)
    const [taken, wanted] = [await session(), await session()]
    const holder = await holding(second, oldCreditBooking(taken.id, customer, membership, period))
    const guarded = first.transaction((tx) =>
      tx.query<{ id: string }>(
        `INSERT INTO bookings (session_id, customer_id, party_size, status, price_paid, redemption_source, start_time, end_time, redeemed_membership_id, credit_period_id)
         SELECT s.id, $2, 1, 'confirmed', 0, 'membership_credit', s.start_time, s.end_time, $3, p.id
         FROM membership_credit_periods p
         JOIN customer_memberships cm ON cm.id = p.membership_id
         JOIN sessions s ON s.id = $1
         WHERE p.id = $4 AND cm.subscription_status = 'active'
           AND (p.is_unlimited OR (SELECT count(*) FROM bookings b WHERE b.credit_period_id = p.id
                                   AND b.redemption_source = 'membership_credit' AND b.status <> 'cancelled') < p.credits_allocated)
         FOR UPDATE OF p
         RETURNING id`,
        [wanted.id, customer, membership, period]
      )
    )
    await blockedBy(holder.pid)
    await holder.finish('commit')
    expect(await guarded).toHaveLength(1)
    expect(await creditUsed(period)).toBe(2)
  })

  it('has one winner in every free-running race', async () => {
    for (let round = 0; round < 10; round += 1) {
      const { customer, membership, period } = await member(1)
      const [a, b] = [await session(), await session()]
      const results = await Promise.all([placed(first, creditOrder(customer, a.id, membership)), placed(second, creditOrder(customer, b.id, membership))])
      expect(results.filter((r) => 'won' in r)).toHaveLength(1)
      expect(await creditUsed(period)).toBe(1)
    }
  }, 60_000)
})

describe('one booking a day', () => {
  it('two orders for one customer on one day: the second waits on the customer, then is refused', async () => {
    const customer = await fixtures.customer(first)
    const morning = await session()
    const afternoon = await session({}, morning)
    const sessions = { first: morning.id, second: afternoon.id }
    const result = await race(placing((who) => paidOrder(customer, sessions[who])), 'commit', 'customers')
    expect(result.first).toHaveProperty('won')
    expect(result.second).toMatchObject({ refused: { reason: 'duplicate_day_booking' } })
    expect(await ordersFor(customer)).toBe(1)
  })

  it("a booking T1 couldn't see is caught by the trigger, and becomes the reason after the rollback", async () => {
    const customer = await fixtures.customer(first)
    const morning = await session()
    const afternoon = await session({}, morning)
    const holder = await holding(second, async (tx) => {
      await tx.query(
        `INSERT INTO bookings (session_id, customer_id, price_paid, status, start_time, end_time)
         SELECT id, $2, 20, 'confirmed', start_time, end_time FROM sessions WHERE id = $1`,
        [morning.id, customer]
      )
    })
    const order = placed(first, paidOrder(customer, afternoon.id))
    await blockedBy(holder.pid)
    await holder.finish('commit')
    expect(await order).toMatchObject({ refused: { reason: 'duplicate_day_booking' } })
    expect(await ordersFor(customer)).toBe(0)
    expect(await bookingsOn(afternoon.id)).toBe(0)
    expect(await count('SELECT total_booked AS n FROM sessions WHERE id = $1', [afternoon.id])).toBe(0)
  })
})

describe('an overlapping booking in another service type', () => {
  async function overlapping() {
    const sauna = await session()
    const plungeStart = new Date(new Date(sauna.start).getTime() + 30 * 60_000).toISOString()
    const plunge = await fixtures.session(first, {
      service_type_id: plungeType,
      band_id: band,
      start_time: plungeStart,
      end_time: new Date(new Date(plungeStart).getTime() + 3_600_000).toISOString(),
      capacity: 10,
    })
    const other = await fixtures.customer(first)
    const holder = await holding(second, async (tx) => {
      await tx.query(
        `INSERT INTO bookings (session_id, customer_id, price_paid, status, start_time, end_time)
         SELECT id, $2, 20, 'confirmed', start_time, end_time FROM sessions WHERE id = $1`,
        [plunge, other]
      )
    })
    return { sauna: sauna.id, holder, customer: await fixtures.customer(first) }
  }

  it('is caught by the exclusion constraint once it commits, and becomes time_conflict after the rollback', async () => {
    const seed = await overlapping()
    const order = placed(first, paidOrder(seed.customer, seed.sauna))
    await blockedBy(seed.holder.pid)
    await seed.holder.finish('commit')
    expect(await order).toMatchObject({ refused: { reason: 'time_conflict' } })
    expect(await ordersFor(seed.customer)).toBe(0)
    expect(await count('SELECT total_booked AS n FROM sessions WHERE id = $1', [seed.sauna])).toBe(0)
  })

  it('two orders at once on overlapping sessions: the second waits on the first, then is refused', async () => {
    const sauna = await session()
    const plungeStart = new Date(new Date(sauna.start).getTime() + 30 * 60_000).toISOString()
    const plunge = await fixtures.session(first, {
      service_type_id: plungeType,
      band_id: band,
      start_time: plungeStart,
      end_time: new Date(new Date(plungeStart).getTime() + 3_600_000).toISOString(),
      capacity: 10,
    })
    const customers = { first: await fixtures.customer(first), second: await fixtures.customer(first) }
    const sessions = { first: sauna.id, second: plunge }
    const result = await race(placing((who) => paidOrder(customers[who], sessions[who])), 'commit')
    expect(result.first).toHaveProperty('won')
    expect(result.second).toMatchObject({ refused: { reason: 'time_conflict' } })
    expect(await ordersFor(customers.second)).toBe(0)
    expect(await count('SELECT total_booked AS n FROM sessions WHERE id = $1', [plunge])).toBe(0)
  })

  // Free running, neither held: both insert their booking at once, each finds the other's
  // uncommitted row in the exclusion index and waits on it, and Postgres ends the deadlock by
  // aborting one (40P01) after a second. T1 runs once more after a deadlock, sees the other order
  // committed and refuses (W06 review S1). Without that retry about 1 round in 17 told staff the
  // database took too long.
  it('has one winner and a time_conflict in every free-running race (300 rounds)', async () => {
    const outcomes: Record<string, number> = {}
    const told = (outcome: Outcome<unknown>) => ('won' in outcome ? 'won' : outcome.refused.reason)
    const failed = (err: unknown) => `${(err as Error).name}: ${(err as { detail?: string }).detail ?? (err as Error).message}`
    for (let round = 0; round < 300; round += 1) {
      const sauna = await session()
      const plungeStart = new Date(new Date(sauna.start).getTime() + 30 * 60_000).toISOString()
      const plunge = await fixtures.session(first, {
        service_type_id: plungeType,
        band_id: band,
        start_time: plungeStart,
        end_time: new Date(new Date(plungeStart).getTime() + 3_600_000).toISOString(),
        capacity: 10,
      })
      const [a, b] = [await fixtures.customer(first), await fixtures.customer(first)]
      const results = await Promise.all([
        placed(first, paidOrder(a, sauna.id)).then(told, failed),
        placed(second, paidOrder(b, plunge)).then(told, failed),
      ])
      const key = [...results].sort().join(' + ')
      outcomes[key] = (outcomes[key] ?? 0) + 1
    }
    expect(outcomes).toEqual({ 'time_conflict + won': 300 })
  }, 300_000)

  /**
   * A deadlock made on purpose. Another writer books a plunge (10:30 to 11:30) and stays open; the
   * order books the sauna (10:00 to 11:00) and waits on it; then the writer books an earlier plunge
   * (9:00 to 10:15), which overlaps the order's sauna booking but not its own, and waits on the
   * order. The order has waited longer, so its deadlock check fires first and Postgres aborts it
   * (40P01). The writer then commits.
   */
  async function deadlocked(order: (customer: string, sauna: string) => Promise<string>) {
    const sauna = await session()
    const at = (minutes: number) => new Date(new Date(sauna.start).getTime() + minutes * 60_000).toISOString()
    const plungeAt = (from: number, to: number) =>
      fixtures.session(first, { service_type_id: plungeType, band_id: band, start_time: at(from), end_time: at(to), capacity: 10 })
    const [plunge, earlierPlunge] = [await plungeAt(30, 90), await plungeAt(-60, 15)]
    // Two customers for the writer's two bookings: one customer would hit the one-a-day rule.
    const [writer, earlierWriter, customer] = [await fixtures.customer(first), await fixtures.customer(first), await fixtures.customer(first)]
    const book = `INSERT INTO bookings (session_id, customer_id, price_paid, status, start_time, end_time)
                  SELECT id, $2, 20, 'confirmed', start_time, end_time FROM sessions WHERE id = $1`
    const secondStep = deferred()
    let announce: (pid: number) => void = () => {}
    const writerPid = new Promise<number>((resolve) => {
      announce = resolve
    })
    const writing = second.transaction(async (tx) => {
      await tx.query(book, [plunge, writer])
      announce((await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]?.pid as number)
      await secondStep.promise
      await tx.query(book, [earlierPlunge, earlierWriter])
    })
    const pid = await writerPid
    const told = order(customer, sauna.id)
    await blockedBy(pid)
    secondStep.resolve()
    await writing
    return { told: await told, customer }
  }

  const answer = (outcome: Promise<unknown>) =>
    outcome.then(
      () => 'won',
      (err: unknown) => refusalDetails(err)?.reason ?? `${(err as Error).name}: ${(err as { detail?: string }).detail ?? (err as Error).message}`
    )

  it('an order Postgres aborts in a deadlock runs once more, and is refused with time_conflict', async () => {
    const { told, customer } = await deadlocked((customer, sauna) => answer(placeOrder(first, paidOrder(customer, sauna), options)))
    expect(told).toBe('time_conflict')
    expect(await ordersFor(customer)).toBe(0)
  })

  it('is not run again inside a transaction it joined: that transaction is its caller’s, and has failed', async () => {
    const { told, customer } = await deadlocked((customer, sauna) =>
      answer(first.transaction(() => placeOrder(first, paidOrder(customer, sauna), options)))
    )
    expect(told).toMatch(/^DbTimeoutError: 40P01/)
    expect(await ordersFor(customer)).toBe(0)
  })

  it('goes through if that booking rolls back', async () => {
    const seed = await overlapping()
    const order = placed(first, paidOrder(seed.customer, seed.sauna))
    await blockedBy(seed.holder.pid)
    await seed.holder.finish('rollback')
    expect(await order).toHaveProperty('won')
    expect(await ordersFor(seed.customer)).toBe(1)
  })
})

describe('the one lock order (W03-plan 2.4 item 8)', () => {
  /** Whether `prober` can take the row now: false when someone holds it. */
  async function free(table: string, id: string): Promise<boolean> {
    try {
      // Test data only: the table names are literals from this file.
      const lockNow = `SELECT id FROM ${table} WHERE id = $1 FOR UPDATE NOWAIT`
      await prober.transaction((tx) => tx.query(lockNow, [id]))
      return true
    } catch (err) {
      if (err instanceof DbTimeoutError && /55P03/.test(err.detail ?? '')) return false
      throw err
    }
  }

  type Row = [table: string, id: string]

  /**
   * Holds row `k` of `chain`, starts the order, and once Postgres says the order is waiting on it,
   * checks that every row before `k` is already the order's and every row after it is still free.
   */
  async function provesOrder(chain: Row[], input: PlaceOrderInput, as: typeof options = options) {
    for (let k = 0; k < chain.length; k += 1) {
      const [table, id] = chain[k] as Row
      // Test data only: the table names are literals from this file.
      const lock = `SELECT id FROM ${table} WHERE id = $1 FOR UPDATE`
      const holder = await holding(second, async (tx) => void (await tx.query(lock, [id])))
      const order = placed(first, input, as).finally(() => undefined)
      await blockedBy(holder.pid)
      const seen = await Promise.all(chain.map(async ([t, rowId], i) => (i === k ? 'held' : (await free(t, rowId)) ? 'free' : 'taken')))
      expect(seen).toEqual(chain.map((_, i) => (i < k ? 'taken' : i === k ? 'held' : 'free')))
      await holder.finish('rollback')
      // Let the order finish, then give its row back for the next round.
      const outcome = await order
      if ('won' in outcome) {
        await first.query("UPDATE bookings SET status = 'cancelled' WHERE customer_id = $1", [input.customerId ?? null])
        await first.query('UPDATE sessions SET total_booked = 0 WHERE id = $1', [input.booking?.sessionId ?? null])
      }
    }
  }

  it('customer, session, credit period, then the add-on memberships in id order', async () => {
    const { customer, membership, period } = await member(10)
    // Two more memberships for the add-on credits, the higher id stored first: a lock taken in
    // storage order, or in the order the basket lists them, would be the wrong way round.
    const [low, high] = [crypto.randomUUID(), crypto.randomUUID()].sort() as [string, string]
    for (const id of [high, low]) {
      await fixtures.membership(first, { id, customer_id: customer, plan_id: plan, is_herd: true, addon_credits_remaining: 5 })
    }
    const { id: sessionId } = await session()
    const chain: Row[] = [
      ['customers', customer],
      ['sessions', sessionId],
      ['membership_credit_periods', period],
      ['customer_memberships', low],
      ['customer_memberships', high],
    ]
    const input: PlaceOrderInput = {
      ...creditOrder(customer, sessionId, membership),
      booking: {
        ...(creditOrder(customer, sessionId, membership).booking as NonNullable<PlaceOrderInput['booking']>),
        addons: [high, low].map((id) => ({ addonId: towel, quantity: 1, redemptionSource: 'membership_credit' as const, membershipId: id })),
      },
    }
    await provesOrder(chain, input)
  }, 60_000)

  it('W07: customer, session, credit period, add-on memberships, then the product variants, each in id order', async () => {
    const { customer, membership, period } = await member(10)
    const [lowMember, highMember] = [crypto.randomUUID(), crypto.randomUUID()].sort() as [string, string]
    for (const id of [highMember, lowMember]) {
      await fixtures.membership(first, { id, customer_id: customer, plan_id: plan, is_herd: true, addon_credits_remaining: 5 })
    }
    // The higher id stored first and listed first in the basket: a lock in storage or basket order is the wrong way round.
    const [low, high] = [crypto.randomUUID(), crypto.randomUUID()].sort() as [string, string]
    await variant(100, high)
    await variant(100, low)
    const { id: sessionId } = await session()
    const booking = creditOrder(customer, sessionId, membership).booking as NonNullable<PlaceOrderInput['booking']>
    const input: PlaceOrderInput = {
      ...productOrder(customer, [[high, 1], [low, 1]]),
      booking: { ...booking, addons: [highMember, lowMember].map((id) => ({ addonId: towel, quantity: 1, redemptionSource: 'membership_credit' as const, membershipId: id })) },
    }
    await provesOrder(
      [
        ['customers', customer],
        ['sessions', sessionId],
        ['membership_credit_periods', period],
        ['customer_memberships', lowMember],
        ['customer_memberships', highMember],
        ['product_variants', low],
        ['product_variants', high],
      ],
      input
    )
  }, 60_000)

  it('W08: customer, session, credit period, add-on memberships, product variants, then the event', async () => {
    const { customer, membership, period } = await member(10)
    const [lowMember, highMember] = [crypto.randomUUID(), crypto.randomUUID()].sort() as [string, string]
    for (const id of [highMember, lowMember]) {
      await fixtures.membership(first, { id, customer_id: customer, plan_id: plan, is_herd: true, addon_credits_remaining: 5 })
    }
    const [low, high] = [crypto.randomUUID(), crypto.randomUUID()].sort() as [string, string]
    await variant(100, high)
    await variant(100, low)
    const eventId = await fixtures.event(first, { capacity: 50 })
    const { id: sessionId } = await session()
    const booking = creditOrder(customer, sessionId, membership).booking as NonNullable<PlaceOrderInput['booking']>
    const input: PlaceOrderInput = {
      ...productOrder(customer, [[high, 1], [low, 1]]),
      // Listed before everything else in the basket: the event is still locked last.
      event: eventPart(eventId),
      booking: { ...booking, addons: [highMember, lowMember].map((id) => ({ addonId: towel, quantity: 1, redemptionSource: 'membership_credit' as const, membershipId: id })) },
      confirmed: { toCollect: 24 + 40 },
    }
    await provesOrder(
      [
        ['customers', customer],
        ['sessions', sessionId],
        ['membership_credit_periods', period],
        ['customer_memberships', lowMember],
        ['customer_memberships', highMember],
        ['product_variants', low],
        ['product_variants', high],
        ['events', eventId],
      ],
      input,
      asStaff
    )
  }, 60_000)

  it('customer, session, then the pass', async () => {
    const customer = await fixtures.customer(first)
    const passType = await fixtures.passType(first)
    const pass = await fixtures.pass(first, { customer_id: customer, pass_type_id: passType, sessions_remaining: 10 })
    const { id: sessionId } = await session()
    const input: PlaceOrderInput = {
      customerId: customer,
      booking: { sessionId, guests: [holderGuest], redemptionSource: 'session_pass_credit', sessionPassId: pass },
      payment: {},
    }
    await provesOrder(
      [
        ['customers', customer],
        ['sessions', sessionId],
        ['customer_session_passes', pass],
      ],
      input
    )
  }, 60_000)
})

describe("the order's lines in createOrder's order, on a clock that moves (W07)", () => {
  // PGlite's clock stands still in the replay, so only here can the booking's line, written a
  // statement after the others, show whether it keeps its place among them. Through Hyperdrive the
  // booking's statement starts a round trip (about 20 ms) after the order's; on this machine it can be
  // under a millisecond, so the order's statement is made to take 30 ms, as that round trip would.
  it('a booking on a pass bought in the basket, an add-on and a product: pass, booking, add-on, product', async () => {
    const customer = await fixtures.customer(first)
    const passType = await fixtures.passType(first, { price: '50.00', sessions_included: 5 })
    const { id: sessionId } = await session()
    const soap = await variant(5)
    await pg.admin.unsafe(`CREATE OR REPLACE FUNCTION public.slow_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.03); RETURN NULL; END $$`)
    await pg.admin.unsafe('CREATE TRIGGER slow_write AFTER INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION public.slow_write()')
    const placedOrder = await placeOrder(
      first,
      {
        customerId: customer,
        booking: { sessionId, guests: [holderGuest], redemptionSource: 'buy_new_session_pass' },
        sessionPassTypeId: passType,
        standaloneAddons: [{ addonId: towel, quantity: 1 }],
        products: [{ productVariantId: soap, quantity: 1 }],
        payment: { method: 'cash' },
        confirmed: { toCollect: 67 },
      },
      options
    ).finally(() => pg.admin.unsafe('DROP TRIGGER slow_write ON public.orders'))
    const lines = await first.query<{ item_type: string }>('SELECT item_type FROM order_line_items WHERE order_id = $1 ORDER BY created_at, id', [placedOrder.orderId])
    expect(lines.map((line) => line.item_type)).toEqual(['session_pass', 'booking', 'addon', 'product'])
    const tied = await count('SELECT count(*)::int - count(DISTINCT created_at)::int AS n FROM order_line_items WHERE order_id = $1', [placedOrder.orderId])
    expect(tied).toBe(0)
  })
})

describe('the last item in stock (W07)', () => {
  async function lastItem() {
    return { variant: await variant(1), first: await fixtures.customer(first), second: await fixtures.customer(first) }
  }

  it('goes to the first; the second waited on the variant and is refused with createOrder\'s reason', async () => {
    const seed = await lastItem()
    const result = await race(placing((who) => productOrder(seed[who], [[seed.variant, 1]])), 'commit', 'product_variants')
    expect(result.first).toHaveProperty('won')
    expect(result.second).toMatchObject({ refused: { reason: 'insufficient_stock' } })
    expect(await stockOf(seed.variant)).toBe(0)
    expect(await ledgerFor(seed.variant)).toBe(1)
    expect(await ordersFor(seed.second)).toBe(0)
  })

  it('goes to the second if the first rolls back', async () => {
    const seed = await lastItem()
    const result = await race(placing((who) => productOrder(seed[who], [[seed.variant, 1]])), 'rollback', 'product_variants')
    expect(result.second).toHaveProperty('won')
    expect(await stockOf(seed.variant)).toBe(0)
    expect(await ledgerFor(seed.variant)).toBe(1)
  })

  it('an order waits for the variant in its lock statement, then counts the stock afresh', async () => {
    // Another writer (the old createOrder's claim) takes the last one and stays open. Without the
    // variant in the lock statement the order would read the stock before waiting, find one, and be
    // stopped only later by the claim's own guard.
    const seed = await lastItem()
    const holder = await holding(second, async (tx) => {
      await tx.query('UPDATE product_variants SET stock_quantity = stock_quantity - 1 WHERE id = $1 AND stock_quantity >= 1', [seed.variant])
    })
    const order = placed(first, productOrder(seed.first, [[seed.variant, 1]]))
    const waiter = await blockedBy(holder.pid)
    expect(await waitingOn(pg, waiter)).toEqual(['product_variants'])
    const [waiting] = await pg.admin.unsafe<{ query: string }[]>('SELECT query FROM pg_stat_activity WHERE pid = $1', [waiter])
    expect(waiting?.query).toMatch(/^\s*SELECT s\.id AS session_id, p\.id AS credit_period_id/)
    await holder.finish('commit')
    expect(await order).toMatchObject({ refused: { reason: 'insufficient_stock' } })
    expect(await stockOf(seed.variant)).toBe(0)
  })

  it('has one winner in every free-running race', async () => {
    for (let round = 0; round < 15; round += 1) {
      const seed = await lastItem()
      const results = await Promise.all([placed(first, productOrder(seed.first, [[seed.variant, 1]])), placed(second, productOrder(seed.second, [[seed.variant, 1]]))])
      expect(results.filter((r) => 'won' in r)).toHaveLength(1)
      expect(results.find((r) => 'refused' in r)).toMatchObject({ refused: { reason: 'insufficient_stock' } })
      expect(await stockOf(seed.variant)).toBe(0)
    }
  }, 60_000)
})

describe('two orders taking the same two variants in opposite basket order (W07)', () => {
  async function twoVariants() {
    return { a: await variant(50), b: await variant(50), first: await fixtures.customer(first), second: await fixtures.customer(first) }
  }

  it('the second waits on a variant, then both go through', async () => {
    const seed = await twoVariants()
    const baskets = { first: [[seed.a, 1], [seed.b, 1]] as const, second: [[seed.b, 1], [seed.a, 1]] as const }
    const result = await race(placing((who) => productOrder(seed[who], baskets[who])), 'commit', 'product_variants')
    expect(result.first).toHaveProperty('won')
    expect(result.second).toHaveProperty('won')
    expect([await stockOf(seed.a), await stockOf(seed.b)]).toEqual([48, 48])
  })

  it('never deadlocks in 50 free-running races, with nothing to run it again (each joins a transaction of its own)', async () => {
    // T1 runs once more after a deadlock when it opened the transaction; joining one turns that off,
    // so a deadlock here would surface as an error.
    const seed = { ...(await twoVariants()), a: await variant(200), b: await variant(200) }
    for (let round = 0; round < 50; round += 1) {
      const results = await Promise.all([
        attempt(first, () => placeOrder(first, productOrder(seed.first, [[seed.a, 1], [seed.b, 1]]), options)),
        attempt(second, () => placeOrder(second, productOrder(seed.second, [[seed.b, 1], [seed.a, 1]]), options)),
      ])
      expect(results.map((r) => 'won' in r)).toEqual([true, true])
    }
    expect([await stockOf(seed.a), await stockOf(seed.b)]).toEqual([100, 100])
  }, 60_000)

  it('the control: locking in basket order instead deadlocks', async () => {
    const seed = await twoVariants()
    const lock = 'SELECT id FROM product_variants WHERE id = $1 FOR NO KEY UPDATE'
    const aTaken = deferred()
    const bTaken = deferred()
    const one = first.transaction(async (tx) => {
      await tx.query(lock, [seed.a])
      aTaken.resolve()
      await bTaken.promise
      await tx.query(lock, [seed.b])
    })
    const two = second.transaction(async (tx) => {
      await tx.query(lock, [seed.b])
      bTaken.resolve()
      await aTaken.promise
      await tx.query(lock, [seed.a])
    })
    const settled = await Promise.allSettled([one, two])
    expect(settled.filter((outcome) => outcome.status === 'rejected' && isDeadlock(outcome.reason))).toHaveLength(1)
  })
})

describe('the last session on a pass bought in the same basket (W07)', () => {
  // A pass bought in an order is its own until the order commits: another order can't even see it.
  // Once it has, an order using it waits on the customer (the pass belongs to the order's customer)
  // and counts the pass afresh.
  async function onePass() {
    return {
      customer: await fixtures.customer(first),
      passType: await fixtures.passType(first, { price: '50.00', sessions_included: 1 }),
      sessions: { first: (await session()).id, second: (await session()).id },
    }
  }

  function passOrders(seed: Awaited<ReturnType<typeof onePass>>) {
    let newPass: string | null = null
    const input = (who: 'first' | 'second'): PlaceOrderInput =>
      who === 'first'
        ? {
            customerId: seed.customer,
            booking: { sessionId: seed.sessions.first, guests: [holderGuest], redemptionSource: 'buy_new_session_pass' },
            sessionPassTypeId: seed.passType,
            payment: { method: 'cash' },
            confirmed: { toCollect: 50 },
          }
        : {
            customerId: seed.customer,
            booking: { sessionId: seed.sessions.second, guests: [holderGuest], redemptionSource: 'session_pass_credit', sessionPassId: newPass },
            payment: {},
          }
    const claim = async (tx: Tx, who: 'first' | 'second') => {
      const placedOrder = (await placing(input)(tx, who)) as PlaceOrderOutput
      if (who === 'first') newPass = placedOrder.sessionPassId
      return placedOrder
    }
    return { claim, newPass: () => newPass }
  }

  it('the booking takes it with the pass; a second order on that pass, waiting on the customer, finds it used', async () => {
    const seed = await onePass()
    const orders = passOrders(seed)
    const result = await race(orders.claim, 'commit', 'customers')
    expect(result.first).toHaveProperty('won')
    expect(result.second).toMatchObject({ refused: { reason: 'insufficient_session_pass_credit' } })
    expect(await count('SELECT sessions_remaining AS n FROM customer_session_passes WHERE id = $1', [orders.newPass()])).toBe(0)
    expect(await bookingsOn(seed.sessions.second)).toBe(0)
  })

  it('if the first rolls back, the pass and its session were never there', async () => {
    const seed = await onePass()
    const orders = passOrders(seed)
    const result = await race(orders.claim, 'rollback', 'customers')
    expect(result.second).toMatchObject({ refused: { reason: 'session_pass_not_found' } })
    expect(await count('SELECT count(*)::int AS n FROM customer_session_passes WHERE customer_id = $1', [seed.customer])).toBe(0)
    expect(await bookingsOn(seed.sessions.first)).toBe(0)
  })
})

describe("the read-back finds the order's ledger rows through the variant index (W07a, review L4)", () => {
  // The ledger names the order only in its free-text reason, which no index covers. Filtering on the
  // order's own variants as well lets Postgres use idx_stock_adjustments_variant_created, instead of
  // reading every row of stock_adjustments while the dry run holds its locks.
  const READ_WITHOUT_THE_VARIANTS = ORDER_ROWS_SQL.replace('sa.variant_id IN (SELECT l.product_variant_id FROM l) AND ', '')
  /** The plan Postgres picks for the read of this order. */
  async function planFor(sql: string, orderId: string): Promise<string> {
    // Both texts are the code's own constants; the id is a param.
    const explain = `EXPLAIN (COSTS OFF) ${sql}`
    return (await first.query<{ 'QUERY PLAN': string }>(explain, [orderId])).map((row) => row['QUERY PLAN']).join('\n')
  }

  it('a ledger of 20,000 rows on 200 other variants: an index scan, and the same rows read back', async () => {
    const soap = await variant(5)
    const { orderId } = await placeOrder(first, productOrder(await fixtures.customer(first), [[soap, 2]]), options)
    await pg.admin.unsafe(`
      WITH p AS (INSERT INTO products (name, base_price, fulfillment_method) VALUES ('Ledger filler', '1.00', 'pickup') RETURNING id),
      v AS (INSERT INTO product_variants (product_id, sku, stock_quantity) SELECT p.id, 'FILL-' || g, 0 FROM p, generate_series(1, 200) g RETURNING id)
      INSERT INTO stock_adjustments (variant_id, change_amount, reason) SELECT v.id, 1, 'Stock take ' || g FROM v, generate_series(1, 100) g`)
    await pg.admin.unsafe('ANALYZE stock_adjustments')

    const plan = await planFor(ORDER_ROWS_SQL, orderId)
    // An index scan or a bitmap one, as the planner prefers; either reads only the order's variants.
    expect(plan, plan).toMatch(/(Index Scan using|Bitmap Index Scan on) idx_stock_adjustments_variant_created\b/)
    expect(plan, plan).not.toMatch(/Seq Scan on stock_adjustments/)
    // The control: the read without the variants scans the whole ledger.
    const before = await planFor(READ_WITHOUT_THE_VARIANTS, orderId)
    expect(before, before).toMatch(/Seq Scan on stock_adjustments sa/)

    const read = async (sql: string) => (await first.query<{ rows: { stock_adjustments: unknown[] } }>(sql, [orderId]))[0]?.rows.stock_adjustments
    expect(await read(ORDER_ROWS_SQL)).toEqual([{ variant_id: soap, change_amount: -2, by_staff: false }])
    expect(await read(ORDER_ROWS_SQL)).toEqual(await read(READ_WITHOUT_THE_VARIANTS))
  })
})

describe("the event's line among the order's lines, and its attendees, on a clock that moves (W08)", () => {
  // As W07's test above: the booking's line is written a statement after the event's (about 20 ms
  // through Hyperdrive), so the order's statement is made to take 30 ms. The attendees are written in
  // one statement, a millisecond apart, so they keep their place order whatever the gap.
  it('a booking, an event for two, an add-on and a product: booking, event, add-on, product; the account holder first', async () => {
    const customer = await fixtures.customer(first)
    const eventId = await fixtures.event(first)
    const { id: sessionId } = await session()
    const soap = await variant(5)
    await pg.admin.unsafe(`CREATE OR REPLACE FUNCTION public.slow_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.03); RETURN NULL; END $$`)
    await pg.admin.unsafe('CREATE TRIGGER slow_write AFTER INSERT ON public.orders FOR EACH ROW EXECUTE FUNCTION public.slow_write()')
    const placedOrder = await placeOrder(
      first,
      {
        customerId: customer,
        // The guest listed first: the account holder must still be place 1.
        event: { ...eventPart(eventId, 1), attendees: [...eventPart(eventId, 1).attendees].reverse() },
        booking: { sessionId, guests: [holderGuest], redemptionSource: 'paid' },
        standaloneAddons: [{ addonId: towel, quantity: 1 }],
        products: [{ productVariantId: soap, quantity: 1 }],
        payment: { method: 'cash' },
        confirmed: { toCollect: 20 + 80 + 5 + 12 },
      },
      asStaff
    ).finally(() => pg.admin.unsafe('DROP TRIGGER slow_write ON public.orders'))
    const lines = await first.query<{ item_type: string }>('SELECT item_type FROM order_line_items WHERE order_id = $1 ORDER BY created_at, id', [placedOrder.orderId])
    expect(lines.map((line) => line.item_type)).toEqual(['booking', 'event', 'addon', 'product'])
    expect(await count('SELECT count(*)::int - count(DISTINCT created_at)::int AS n FROM order_line_items WHERE order_id = $1', [placedOrder.orderId])).toBe(0)
    const attendees = await first.query<{ attendee_type: string; name: string }>(
      'SELECT attendee_type, name FROM event_attendees WHERE event_booking_id = $1 ORDER BY created_at, id',
      [placedOrder.eventBookingId]
    )
    expect(attendees).toEqual([
      { attendee_type: 'account_holder', name: 'Sam Test' },
      { attendee_type: 'guest', name: 'Guest 1' },
    ])
    expect(await count('SELECT count(*)::int - count(DISTINCT created_at)::int AS n FROM event_attendees WHERE event_booking_id = $1', [placedOrder.eventBookingId])).toBe(0)
  })
})

describe('the last place at an event (W08)', () => {
  async function lastPlace() {
    return { event: await fixtures.event(first, { capacity: 1 }), first: await fixtures.customer(first), second: await fixtures.customer(first) }
  }

  it("goes to the first; the second waited on the event and is refused with createOrder's reason", async () => {
    const seed = await lastPlace()
    const result = await race(placing((who) => eventOrder(seed[who], seed.event), asStaff), 'commit', 'events')
    expect(result.first).toHaveProperty('won')
    expect(result.second).toMatchObject({ refused: { reason: 'event_full' } })
    expect(await placesBooked(seed.event)).toBe(1)
    expect(await eventBookingsFor(seed.event)).toBe(1)
    expect(await ordersFor(seed.second)).toBe(0)
  })

  it('goes to the second if the first rolls back', async () => {
    const seed = await lastPlace()
    const result = await race(placing((who) => eventOrder(seed[who], seed.event), asStaff), 'rollback', 'events')
    expect(result.second).toHaveProperty('won')
    expect(await placesBooked(seed.event)).toBe(1)
    expect(await eventBookingsFor(seed.event)).toBe(1)
  })

  it('an order waits for the event in its lock statement, then counts the places afresh', async () => {
    // Another writer (the old createOrder's claim_event_places) takes the last place and stays open.
    // Without the event in the lock statement the order would read the places before waiting, find
    // one, and be stopped only later by the claim's own guard.
    const seed = await lastPlace()
    const holder = await holding(second, async (tx) => {
      await tx.query('SELECT claim_event_places($1, 1)', [seed.event])
    })
    const order = placed(first, eventOrder(seed.first, seed.event), asStaff)
    const waiter = await blockedBy(holder.pid)
    expect(await waitingOn(pg, waiter)).toEqual(['events'])
    const [waiting] = await pg.admin.unsafe<{ query: string }[]>('SELECT query FROM pg_stat_activity WHERE pid = $1', [waiter])
    expect(waiting?.query).toMatch(/^\s*SELECT s\.id AS session_id, p\.id AS credit_period_id/)
    await holder.finish('commit')
    expect(await order).toMatchObject({ refused: { reason: 'event_full' } })
    expect(await placesBooked(seed.event)).toBe(1)
    expect(await eventBookingsFor(seed.event)).toBe(0)
  })

  it('two places wanted with one left: refused whole, nothing claimed', async () => {
    const seed = await lastPlace()
    await first.query('UPDATE events SET capacity = 2, places_booked = 1 WHERE id = $1', [seed.event])
    expect(await placed(first, eventOrder(seed.first, seed.event, 1), asStaff)).toMatchObject({ refused: { reason: 'event_full' } })
    expect(await placesBooked(seed.event)).toBe(1)
  })

  it('has one winner in every free-running race', async () => {
    for (let round = 0; round < 15; round += 1) {
      const seed = await lastPlace()
      const results = await Promise.all([placed(first, eventOrder(seed.first, seed.event), asStaff), placed(second, eventOrder(seed.second, seed.event), asStaff)])
      expect(results.filter((r) => 'won' in r)).toHaveLength(1)
      expect(results.find((r) => 'refused' in r)).toMatchObject({ refused: { reason: 'event_full' } })
      expect(await placesBooked(seed.event)).toBe(1)
      expect(await eventBookingsFor(seed.event)).toBe(1)
    }
  }, 60_000)
})

describe('two orders for places at one event at once (W08)', () => {
  // The lock is FOR NO KEY UPDATE, so the second order waits for the first before it reads the places.
  // A shared lock would let both read and then both try to claim: a deadlock, which T1 runs once more
  // only when it opened the transaction itself. These join a transaction of their own, so it would show.
  it('the second waits on the event, then both go through', async () => {
    const eventId = await fixtures.event(first, { capacity: 10 })
    const customers = { first: await fixtures.customer(first), second: await fixtures.customer(first) }
    const result = await race(placing((who) => eventOrder(customers[who], eventId), asStaff), 'commit', 'events')
    expect(result.first).toHaveProperty('won')
    expect(result.second).toHaveProperty('won')
    expect(await placesBooked(eventId)).toBe(2)
  })

  it('never deadlocks in 50 free-running races, with nothing to run it again (each joins a transaction of its own)', async () => {
    const eventId = await fixtures.event(first, { capacity: 200 })
    for (let round = 0; round < 50; round += 1) {
      const results = await Promise.all([
        attempt(first, async () => placeOrder(first, eventOrder(await fixtures.customer(prober), eventId), asStaff)),
        attempt(second, async () => placeOrder(second, eventOrder(await fixtures.customer(prober), eventId), asStaff)),
      ])
      expect(results.map((r) => 'won' in r)).toEqual([true, true])
    }
    expect(await placesBooked(eventId)).toBe(100)
    expect(await eventBookingsFor(eventId)).toBe(100)
  }, 120_000)
})

describe('an event, a session and two variants in one basket, against another order with them the other way round (W08)', () => {
  // Order one lists the booking, then the variants a then b, then the event; order two the event, the
  // variants b then a, then the booking. T1 locks in LOCK_ORDER whatever the basket's order.
  async function world() {
    return {
      session: (await session({ capacity: 200 })).id,
      a: await variant(200),
      b: await variant(200),
      event: await fixtures.event(first, { capacity: 200 }),
    }
  }

  function baskets(seed: Awaited<ReturnType<typeof world>>, customers: { first: string; second: string }) {
    const booking = (customerId: string) => paidOrder(customerId, seed.session).booking as NonNullable<PlaceOrderInput['booking']>
    const one: PlaceOrderInput = {
      customerId: customers.first,
      booking: booking(customers.first),
      products: [{ productVariantId: seed.a, quantity: 1 }, { productVariantId: seed.b, quantity: 1 }],
      event: eventPart(seed.event),
      payment: { method: 'cash' },
      confirmed: { toCollect: 20 + 24 + 40 },
    }
    const two: PlaceOrderInput = {
      customerId: customers.second,
      event: eventPart(seed.event),
      products: [{ productVariantId: seed.b, quantity: 1 }, { productVariantId: seed.a, quantity: 1 }],
      booking: booking(customers.second),
      payment: { method: 'cash' },
      confirmed: { toCollect: 20 + 24 + 40 },
    }
    return { first: one, second: two }
  }

  it('the second waits on the session (the first row they share), then both go through', async () => {
    const seed = await world()
    const orders = baskets(seed, { first: await fixtures.customer(first), second: await fixtures.customer(first) })
    const result = await race(placing((who) => orders[who], asStaff), 'commit', 'sessions')
    expect(result.first).toHaveProperty('won')
    expect(result.second).toHaveProperty('won')
    expect([await stockOf(seed.a), await stockOf(seed.b), await placesBooked(seed.event), await bookingsOn(seed.session)]).toEqual([198, 198, 2, 2])
  })

  it('never deadlocks in 50 free-running races, with nothing to run it again (each joins a transaction of its own)', async () => {
    const seed = await world()
    for (let round = 0; round < 50; round += 1) {
      // New customers each round: one booking a day each.
      const orders = baskets(seed, { first: await fixtures.customer(first), second: await fixtures.customer(first) })
      const results = await Promise.all([
        attempt(first, () => placeOrder(first, orders.first, asStaff)),
        attempt(second, () => placeOrder(second, orders.second, asStaff)),
      ])
      expect(results.map((r) => 'won' in r)).toEqual([true, true])
    }
    expect([await stockOf(seed.a), await stockOf(seed.b), await placesBooked(seed.event), await bookingsOn(seed.session)]).toEqual([100, 100, 100, 100])
  }, 120_000)

  it('the control: locking the event and the session in basket order instead deadlocks', async () => {
    const seed = await world()
    const lockSession = 'SELECT id FROM sessions WHERE id = $1 FOR NO KEY UPDATE'
    const lockEvent = 'SELECT id FROM events WHERE id = $1 FOR NO KEY UPDATE'
    const sessionTaken = deferred()
    const eventTaken = deferred()
    const one = first.transaction(async (tx) => {
      await tx.query(lockSession, [seed.session])
      sessionTaken.resolve()
      await eventTaken.promise
      await tx.query(lockEvent, [seed.event])
    })
    const two = second.transaction(async (tx) => {
      await tx.query(lockEvent, [seed.event])
      eventTaken.resolve()
      await sessionTaken.promise
      await tx.query(lockSession, [seed.session])
    })
    const settled = await Promise.allSettled([one, two])
    expect(settled.filter((outcome) => outcome.status === 'rejected' && isDeadlock(outcome.reason))).toHaveLength(1)
  })
})

// --- W09: promo codes, store credit and gift cards used to pay

/** A promo code: unlimited unless `row` says, fixed £1 off products, events and bookings. */
async function promo(row: Record<string, unknown> = {}): Promise<{ id: string; code: string }> {
  const code = `W09-${crypto.randomUUID().slice(0, 8).toUpperCase()}`
  const id = await fixtures.promo(first, { code, discount_type: 'fixed', discount_value: '1', applies_to: ['booking', 'product', 'event'], ...row })
  return { id, code }
}

/** A gift card with `balance` on it. */
async function giftCard(balance: string): Promise<string> {
  return insert(first, 'gift_cards', {
    code: `W09-${crypto.randomUUID().slice(0, 10)}`,
    type: 'monetary',
    original_value: balance,
    remaining_balance: balance,
    origin: 'customer_purchase',
    expiry_date: '2099-01-01',
  })
}

/** One £12 soap, with `promoCode` (£1 off) and whatever `payment` says, the rest in cash. */
function soapOrder(customerId: string, variantId: string, extra: Partial<PlaceOrderInput> & { toCollect: number }): PlaceOrderInput {
  const { toCollect, ...rest } = extra
  return { customerId, products: [{ productVariantId: variantId, quantity: 1 }], payment: { method: 'cash' }, confirmed: { toCollect }, ...rest }
}

const usesOf = (promoId: string) => count('SELECT count(*)::int AS n FROM promo_code_redemptions WHERE promo_code_id = $1', [promoId])
const balanceOf = async (customerId: string) => (await first.query<{ b: string }>('SELECT store_credit_balance::text AS b FROM customers WHERE id = $1', [customerId]))[0]?.b
const cardBalance = async (cardId: string) => (await first.query<{ b: string }>('SELECT remaining_balance::text AS b FROM gift_cards WHERE id = $1', [cardId]))[0]?.b
const creditRows = (customerId: string) => count('SELECT count(*)::int AS n FROM store_credit_transactions WHERE customer_id = $1', [customerId])
const cardRows = (cardId: string) => count('SELECT count(*)::int AS n FROM gift_card_redemptions WHERE gift_card_id = $1', [cardId])

describe('the last use of a promo code (W09)', () => {
  async function lastUse() {
    return { promo: await promo({ max_total_uses: 1 }), variant: await variant(10), first: await fixtures.customer(first), second: await fixtures.customer(first) }
  }
  const order = (seed: Awaited<ReturnType<typeof lastUse>>, who: 'first' | 'second') => soapOrder(seed[who], seed.variant, { promoCode: seed.promo.code, toCollect: 11 })

  it("goes to the first; the second waited on the promo code and is refused with createOrder's words", async () => {
    const seed = await lastUse()
    const result = await race(placing((who) => order(seed, who)), 'commit', 'promo_codes')
    expect(result.first).toHaveProperty('won')
    expect(result.second).toMatchObject({ refused: { reason: 'promo_code_invalid' } })
    expect(await usesOf(seed.promo.id)).toBe(1)
    expect(await ordersFor(seed.second)).toBe(0)
  })

  it('goes to the second if the first rolls back', async () => {
    const seed = await lastUse()
    const result = await race(placing((who) => order(seed, who)), 'rollback', 'promo_codes')
    expect(result.second).toHaveProperty('won')
    expect(await usesOf(seed.promo.id)).toBe(1)
  })

  it('has one winner in every free-running race', async () => {
    for (let round = 0; round < 15; round += 1) {
      const seed = await lastUse()
      const results = await Promise.all([placed(first, order(seed, 'first')), placed(second, order(seed, 'second'))])
      expect(results.filter((r) => 'won' in r)).toHaveLength(1)
      expect(results.find((r) => 'refused' in r)).toMatchObject({ refused: { reason: 'promo_code_invalid' } })
      expect(await usesOf(seed.promo.id)).toBe(1)
    }
  }, 60_000)

  it('once per customer: a second order by the same customer waits, then is refused', async () => {
    const seed = await lastUse()
    await first.query('UPDATE promo_codes SET max_total_uses = NULL, one_use_per_customer = true WHERE id = $1', [seed.promo.id])
    const result = await race(placing(() => order(seed, 'first')), 'commit', 'customers')
    expect(result.first).toHaveProperty('won')
    expect(result.second).toMatchObject({ refused: { reason: 'promo_code_invalid' } })
    expect(await usesOf(seed.promo.id)).toBe(1)
  })

  describe("beside the old createOrder's insert-then-count (the W15 side-by-side case)", () => {
    /** createOrder.ts's claimPromoRedemption: its order, then its redemption, then the count, each a statement of its own. */
    async function oldClaim(tx: Tx, promoId: string, customerId: string): Promise<string> {
      const orderId = (await tx.query<{ id: string }>(`INSERT INTO orders (customer_id, order_total, payment_status, order_source) VALUES ($1, 12, 'pending', 'staff_created') RETURNING id`, [customerId]))[0]?.id as string
      await tx.query('INSERT INTO promo_code_redemptions (promo_code_id, order_id, customer_id, discount_amount) VALUES ($1, $2, $3, 1) ON CONFLICT (promo_code_id, order_id) DO NOTHING', [promoId, orderId, customerId])
      const [counted] = await tx.query<{ total: number }>('SELECT count(*)::int AS total FROM promo_code_redemptions WHERE promo_code_id = $1', [promoId])
      const [limits] = await tx.query<{ max: number | null }>('SELECT max_total_uses AS max FROM promo_codes WHERE id = $1', [promoId])
      if (limits?.max !== null && limits?.max !== undefined && (counted?.total ?? 0) > limits.max) throw new Refused('promo_code_invalid')
      return orderId
    }

    it("the old order's redemption waits on T1's lock (its foreign key), then its count sees T1's use and it refuses", async () => {
      const seed = await lastUse()
      const result = await race(
        async (tx, who) => (who === 'first' ? placing(() => order(seed, 'first'))(tx, who) : oldClaim(tx, seed.promo.id, seed.second)),
        'commit',
        'promo_codes'
      )
      expect(result.first).toHaveProperty('won')
      expect(result.second).toMatchObject({ refused: { reason: 'promo_code_invalid' } })
      expect(await usesOf(seed.promo.id)).toBe(1)
    })

    it('the other way round: T1 waits for nothing the old order holds, and counts its committed use', async () => {
      const seed = await lastUse()
      await first.transaction((tx) => oldClaim(tx, seed.promo.id, seed.second))
      expect(await placed(first, order(seed, 'first'))).toMatchObject({ refused: { reason: 'promo_code_invalid' } })
      expect(await usesOf(seed.promo.id)).toBe(1)
    })

    it('the control: a lock an insert does not wait for (FOR NO KEY UPDATE) lets both keep the last use', async () => {
      const seed = await lastUse()
      // T1's order of events, by hand, with the weaker lock: lock, count (none used), then its own use, held open.
      const holder = await holding(second, async (tx) => {
        await tx.query('SELECT id FROM promo_codes WHERE id = $1 FOR NO KEY UPDATE', [seed.promo.id])
        const orderId = (await tx.query<{ id: string }>(`INSERT INTO orders (customer_id, order_total, payment_status, order_source) VALUES ($1, 12, 'paid', 'staff_created') RETURNING id`, [seed.first]))[0]?.id
        await tx.query('INSERT INTO promo_code_redemptions (promo_code_id, order_id, customer_id, discount_amount) VALUES ($1, $2, $3, 1)', [seed.promo.id, orderId, seed.first])
      })
      // The old order goes straight through: its count can't see the holder's uncommitted use.
      const old = await attempt(first, (tx) => oldClaim(tx, seed.promo.id, seed.second))
      expect(old).toHaveProperty('won')
      await holder.finish('commit')
      expect(await usesOf(seed.promo.id)).toBe(2)
    })
  })
})

describe('a store credit balance spent by another order at the same time (W09)', () => {
  async function tenPounds() {
    return { customer: await fixtures.customer(first, { store_credit_balance: '10.00' }), variant: await variant(10) }
  }
  const spending = (seed: Awaited<ReturnType<typeof tenPounds>>) => soapOrder(seed.customer, seed.variant, { payment: { method: 'cash', storeCredit: { amount: 10 } }, toCollect: 2 })

  it("two orders: the second waits on the customer, then is refused with createOrder's words", async () => {
    const seed = await tenPounds()
    const result = await race(placing(() => spending(seed), asStaff), 'commit', 'customers')
    expect(result.first).toHaveProperty('won')
    expect(result.second).toMatchObject({ refused: { reason: 'store_credit_insufficient' } })
    expect(await balanceOf(seed.customer)).toBe('0.00')
    expect(await creditRows(seed.customer)).toBe(1)
  })

  it('an order waits for the old store_credit_apply in its lock statement, then reads the balance afresh', async () => {
    const seed = await tenPounds()
    const holder = await holding(second, async (tx) => {
      await tx.query(`SELECT public.store_credit_apply($1::uuid, -10, 'redemption')`, [seed.customer])
    })
    const pending = placed(first, spending(seed), asStaff)
    const waiter = await blockedBy(holder.pid)
    expect(await waitingOn(pg, waiter)).toEqual(['customers'])
    const [waiting] = await pg.admin.unsafe<{ query: string }[]>('SELECT query FROM pg_stat_activity WHERE pid = $1', [waiter])
    expect(waiting?.query).toMatch(/^\s*SELECT s\.id AS session_id, p\.id AS credit_period_id/)
    await holder.finish('commit')
    expect(await pending).toMatchObject({ refused: { reason: 'store_credit_insufficient' } })
    expect(await balanceOf(seed.customer)).toBe('0.00')
    expect(await creditRows(seed.customer)).toBe(1)
  })

  it('the old store_credit_apply waits for T1, then refuses on what T1 left', async () => {
    const seed = await tenPounds()
    const result = await race(
      async (tx, who) => {
        if (who === 'first') return placing(() => spending(seed), asStaff)(tx, who)
        const [row] = await tx.query<{ result: { ok: boolean; reason?: string } }>(`SELECT public.store_credit_apply($1::uuid, -10, 'redemption') AS result`, [seed.customer])
        if (!row?.result.ok) throw new Refused(row?.result.reason ?? 'refused')
        return row.result
      },
      'commit',
      'customers'
    )
    expect(result.first).toHaveProperty('won')
    expect(result.second).toMatchObject({ refused: { reason: 'insufficient_store_credit' } })
    expect(await balanceOf(seed.customer)).toBe('0.00')
  })

  it('has one winner in every free-running race', async () => {
    for (let round = 0; round < 15; round += 1) {
      const seed = await tenPounds()
      const results = await Promise.all([placed(first, spending(seed), asStaff), placed(second, spending(seed), asStaff)])
      expect(results.filter((r) => 'won' in r)).toHaveLength(1)
      expect(results.find((r) => 'refused' in r)).toMatchObject({ refused: { reason: 'store_credit_insufficient' } })
      expect(await balanceOf(seed.customer)).toBe('0.00')
    }
  }, 60_000)
})

describe('a gift card balance spent elsewhere (W09)', () => {
  // A soap each, so the card is the only row the two orders share.
  async function tenOnACard() {
    return { card: await giftCard('10.00'), variants: { first: await variant(10), second: await variant(10) }, first: await fixtures.customer(first), second: await fixtures.customer(first) }
  }
  const paying = (seed: Awaited<ReturnType<typeof tenOnACard>>, who: 'first' | 'second') =>
    soapOrder(seed[who], seed.variants[who], { payment: { method: 'cash', giftCard: { giftCardId: seed.card, amount: 10 } }, toCollect: 2 })

  it("two orders on one card: the second waits on the card, then is refused with createOrder's words", async () => {
    const seed = await tenOnACard()
    const result = await race(placing((who) => paying(seed, who)), 'commit', 'gift_cards')
    expect(result.first).toHaveProperty('won')
    expect(result.second).toMatchObject({ refused: { reason: 'gift_card_insufficient_or_invalid' } })
    expect(await cardBalance(seed.card)).toBe('0.00')
    expect(await cardRows(seed.card)).toBe(1)
    expect(await ordersFor(seed.second)).toBe(0)
  })

  it('goes to the second if the first rolls back', async () => {
    const seed = await tenOnACard()
    const result = await race(placing((who) => paying(seed, who)), 'rollback', 'gift_cards')
    expect(result.second).toHaveProperty('won')
    expect(await cardBalance(seed.card)).toBe('0.00')
    expect(await cardRows(seed.card)).toBe(1)
  })

  it("an order waits for the old createOrder's claim in its lock statement, then reads the balance afresh", async () => {
    const seed = await tenOnACard()
    const holder = await holding(second, async (tx) => {
      await tx.query(
        `UPDATE gift_cards SET remaining_balance = remaining_balance - $1, updated_at = now()
         WHERE id = $2 AND remaining_balance >= $3 AND voided IS NOT TRUE AND expiry_date >= (now() AT TIME ZONE 'Europe/London')::date`,
        [10, seed.card, 10]
      )
    })
    const pending = placed(first, paying(seed, 'first'))
    const waiter = await blockedBy(holder.pid)
    expect(await waitingOn(pg, waiter)).toEqual(['gift_cards'])
    const [waiting] = await pg.admin.unsafe<{ query: string }[]>('SELECT query FROM pg_stat_activity WHERE pid = $1', [waiter])
    expect(waiting?.query).toMatch(/^\s*SELECT s\.id AS session_id, p\.id AS credit_period_id/)
    await holder.finish('commit')
    expect(await pending).toMatchObject({ refused: { reason: 'gift_card_insufficient_or_invalid' } })
    expect(await cardBalance(seed.card)).toBe('0.00')
    expect(await cardRows(seed.card)).toBe(0)
  })

  it("the old createOrder's claim waits for T1, then finds nothing left (its guard re-checks the row T1 changed)", async () => {
    const seed = await tenOnACard()
    const result = await race(
      async (tx, who) => {
        if (who === 'first') return placing((w) => paying(seed, w))(tx, who)
        const claimed = await tx.query(
          `UPDATE gift_cards SET remaining_balance = remaining_balance - $1, updated_at = now()
           WHERE id = $2 AND remaining_balance >= $3 AND voided IS NOT TRUE AND expiry_date >= (now() AT TIME ZONE 'Europe/London')::date RETURNING id`,
          [10, seed.card, 10]
        )
        if (claimed.length === 0) throw new Refused('gift_card_insufficient_or_invalid')
        return claimed
      },
      'commit',
      'gift_cards'
    )
    expect(result.first).toHaveProperty('won')
    expect(result.second).toMatchObject({ refused: { reason: 'gift_card_insufficient_or_invalid' } })
    expect(await cardBalance(seed.card)).toBe('0.00')
  })

  it('two orders on a card with enough for both, in transactions of their own: the second waits on the card, then both go through, 50 rounds with no deadlock', async () => {
    // The card is locked FOR NO KEY UPDATE, so the second order waits before it reads the balance. A shared
    // lock would let both read and then both claim: a deadlock, which T1 runs once more only when it opened
    // the transaction itself. These join a transaction of their own, so it would show (as W08's event test).
    const card = await giftCard('200.00')
    const variants = { first: await variant(200), second: await variant(200) }
    const pay = (customerId: string, who: 'first' | 'second') => soapOrder(customerId, variants[who], { payment: { method: 'cash', giftCard: { giftCardId: card, amount: 1 } }, toCollect: 11 })
    const customers = { first: await fixtures.customer(first), second: await fixtures.customer(first) }
    const result = await race(placing((who) => pay(customers[who], who)), 'commit', 'gift_cards')
    expect(result.first).toHaveProperty('won')
    expect(result.second).toHaveProperty('won')
    for (let round = 0; round < 50; round += 1) {
      const results = await Promise.all([
        attempt(first, async () => placeOrder(first, pay(await fixtures.customer(prober), 'first'), options)),
        attempt(second, async () => placeOrder(second, pay(await fixtures.customer(prober), 'second'), options)),
      ])
      expect(results.map((r) => 'won' in r)).toEqual([true, true])
    }
    expect(await cardBalance(card)).toBe('98.00')
    expect(await cardRows(card)).toBe(102)
  }, 120_000)

  it('has one winner in every free-running race', async () => {
    for (let round = 0; round < 15; round += 1) {
      const seed = await tenOnACard()
      const results = await Promise.all([placed(first, paying(seed, 'first')), placed(second, paying(seed, 'second'))])
      expect(results.filter((r) => 'won' in r)).toHaveLength(1)
      expect(results.find((r) => 'refused' in r)).toMatchObject({ refused: { reason: 'gift_card_insufficient_or_invalid' } })
      expect(await cardBalance(seed.card)).toBe('0.00')
    }
  }, 60_000)
})

describe('the full lock chain, with W09 (W03-plan 2.4 item 8)', () => {
  /** Whether `prober` can take the row now: false when someone holds it. */
  async function free(table: string, id: string): Promise<boolean> {
    try {
      // Test data only: the table names are literals from this file.
      const lockNow = `SELECT id FROM ${table} WHERE id = $1 FOR UPDATE NOWAIT`
      await prober.transaction((tx) => tx.query(lockNow, [id]))
      return true
    } catch (err) {
      if (err instanceof DbTimeoutError && /55P03/.test(err.detail ?? '')) return false
      throw err
    }
  }

  type Row = [table: string, id: string]

  /** As W06's: hold row `k`, start the order, and check every row before `k` is the order's and every row after it is free. */
  async function provesOrder(chain: Row[], input: PlaceOrderInput) {
    for (let k = 0; k < chain.length; k += 1) {
      const [table, id] = chain[k] as Row
      // Test data only: the table names are literals from this file.
      const lock = `SELECT id FROM ${table} WHERE id = $1 FOR UPDATE`
      const holder = await holding(second, async (tx) => void (await tx.query(lock, [id])))
      const order = placed(first, input, asStaff).finally(() => undefined)
      await blockedBy(holder.pid)
      const seen = await Promise.all(chain.map(async ([t, rowId], i) => (i === k ? 'held' : (await free(t, rowId)) ? 'free' : 'taken')))
      expect(seen).toEqual(chain.map((_, i) => (i < k ? 'taken' : i === k ? 'held' : 'free')))
      await holder.finish('rollback')
      const outcome = await order
      expect(outcome, `round ${k}: ${'refused' in outcome ? outcome.refused.reason : ''}`).toHaveProperty('won')
      await first.query("UPDATE bookings SET status = 'cancelled' WHERE customer_id = $1", [input.customerId ?? null])
      await first.query('UPDATE sessions SET total_booked = 0 WHERE id = $1', [input.booking?.sessionId ?? null])
    }
  }

  it('customer, promo code, session, credit period, add-on memberships, product variants, event, then the gift card', async () => {
    const { customer, membership, period } = await member(20)
    const [lowMember, highMember] = [crypto.randomUUID(), crypto.randomUUID()].sort() as [string, string]
    for (const id of [highMember, lowMember]) {
      await fixtures.membership(first, { id, customer_id: customer, plan_id: plan, is_herd: true, addon_credits_remaining: 20 })
    }
    const [low, high] = [crypto.randomUUID(), crypto.randomUUID()].sort() as [string, string]
    await variant(100, high)
    await variant(100, low)
    const eventId = await fixtures.event(first, { capacity: 50 })
    const code = await promo()
    const card = await giftCard('100.00')
    const { id: sessionId } = await session()
    const booking = creditOrder(customer, sessionId, membership).booking as NonNullable<PlaceOrderInput['booking']>
    const input: PlaceOrderInput = {
      customerId: customer,
      // Listed in the opposite order to LOCK_ORDER wherever a basket has an order: still locked in it.
      event: eventPart(eventId),
      products: [{ productVariantId: high, quantity: 1 }, { productVariantId: low, quantity: 1 }],
      booking: { ...booking, addons: [highMember, lowMember].map((id) => ({ addonId: towel, quantity: 1, redemptionSource: 'membership_credit' as const, membershipId: id })) },
      promoCode: code.code,
      payment: { method: 'cash', giftCard: { giftCardId: card, amount: 1 } },
      // £24 of soap and a Herd member's £20 place, £1 off, £1 on the card.
      confirmed: { toCollect: 42 },
    }
    await provesOrder(
      [
        ['customers', customer],
        ['promo_codes', code.id],
        ['sessions', sessionId],
        ['membership_credit_periods', period],
        ['customer_memberships', lowMember],
        ['customer_memberships', highMember],
        ['product_variants', low],
        ['product_variants', high],
        ['events', eventId],
        ['gift_cards', card],
      ],
      input
    )
  }, 90_000)

  it('customer, promo code, session, the pass, then the gift card', async () => {
    const customer = await fixtures.customer(first)
    const passType = await fixtures.passType(first)
    const pass = await fixtures.pass(first, { customer_id: customer, pass_type_id: passType, sessions_remaining: 10 })
    const [soap] = [await variant(100)]
    const code = await promo()
    const card = await giftCard('100.00')
    const { id: sessionId } = await session()
    const input: PlaceOrderInput = {
      customerId: customer,
      booking: { sessionId, guests: [holderGuest], redemptionSource: 'session_pass_credit', sessionPassId: pass },
      products: [{ productVariantId: soap as string, quantity: 1 }],
      promoCode: code.code,
      payment: { method: 'cash', giftCard: { giftCardId: card, amount: 1 } },
      confirmed: { toCollect: 10 },
    }
    await provesOrder(
      [
        ['customers', customer],
        ['promo_codes', code.id],
        ['sessions', sessionId],
        ['customer_session_passes', pass],
        ['gift_cards', card],
      ],
      input
    )
  }, 60_000)
})

describe('a promo code, a session, two variants, an event and a gift card in one basket, against another order with them the other way round (W09)', () => {
  // Order one lists the booking, the variants a then b, the event, then pays with the card; order two the
  // event, the variants b then a, then the booking, and pays with the same card. T1 locks in LOCK_ORDER.
  async function world() {
    return {
      session: (await session({ capacity: 200 })).id,
      a: await variant(200),
      b: await variant(200),
      event: await fixtures.event(first, { capacity: 200 }),
      promo: await promo(),
      card: await giftCard('500.00'),
    }
  }

  function baskets(seed: Awaited<ReturnType<typeof world>>, customers: { first: string; second: string }) {
    const booking = (customerId: string) => paidOrder(customerId, seed.session).booking as NonNullable<PlaceOrderInput['booking']>
    // £20 + £24 + £40, £1 off, £1 on the card: £82 in cash.
    const pay = { payment: { method: 'cash', giftCard: { giftCardId: seed.card, amount: 1 } }, confirmed: { toCollect: 82 }, promoCode: seed.promo.code }
    const one: PlaceOrderInput = {
      customerId: customers.first,
      booking: booking(customers.first),
      products: [{ productVariantId: seed.a, quantity: 1 }, { productVariantId: seed.b, quantity: 1 }],
      event: eventPart(seed.event),
      ...pay,
    }
    const two: PlaceOrderInput = {
      customerId: customers.second,
      event: eventPart(seed.event),
      products: [{ productVariantId: seed.b, quantity: 1 }, { productVariantId: seed.a, quantity: 1 }],
      booking: booking(customers.second),
      ...pay,
    }
    return { first: one, second: two }
  }

  it('the second waits on the promo code (the first row they share), then both go through', async () => {
    const seed = await world()
    const orders = baskets(seed, { first: await fixtures.customer(first), second: await fixtures.customer(first) })
    const result = await race(placing((who) => orders[who], asStaff), 'commit', 'promo_codes')
    expect(result.first).toHaveProperty('won')
    expect(result.second).toHaveProperty('won')
    expect([await usesOf(seed.promo.id), await cardBalance(seed.card), await placesBooked(seed.event)]).toEqual([2, '498.00', 2])
  })

  it('never deadlocks in 50 free-running races, with nothing to run it again (each joins a transaction of its own)', async () => {
    const seed = await world()
    for (let round = 0; round < 50; round += 1) {
      const orders = baskets(seed, { first: await fixtures.customer(first), second: await fixtures.customer(first) })
      const results = await Promise.all([
        attempt(first, () => placeOrder(first, orders.first, asStaff)),
        attempt(second, () => placeOrder(second, orders.second, asStaff)),
      ])
      expect(results.map((r) => 'won' in r)).toEqual([true, true])
    }
    expect([await usesOf(seed.promo.id), await cardBalance(seed.card), await stockOf(seed.a), await placesBooked(seed.event), await bookingsOn(seed.session)]).toEqual([100, '400.00', 100, 100, 100])
  }, 180_000)

  it('the control: locking the gift card and the promo code in opposite orders instead deadlocks', async () => {
    const seed = await world()
    const lockPromo = 'SELECT id FROM promo_codes WHERE id = $1 FOR UPDATE'
    const lockCard = 'SELECT id FROM gift_cards WHERE id = $1 FOR NO KEY UPDATE'
    const promoTaken = deferred()
    const cardTaken = deferred()
    const one = first.transaction(async (tx) => {
      await tx.query(lockPromo, [seed.promo.id])
      promoTaken.resolve()
      await cardTaken.promise
      await tx.query(lockCard, [seed.card])
    })
    const two = second.transaction(async (tx) => {
      await tx.query(lockCard, [seed.card])
      cardTaken.resolve()
      await promoTaken.promise
      await tx.query(lockPromo, [seed.promo.id])
    })
    const settled = await Promise.allSettled([one, two])
    expect(settled.filter((outcome) => outcome.status === 'rejected' && isDeadlock(outcome.reason))).toHaveLength(1)
  })
})
