import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PlaceOrderInput } from '@/contracts'
import type { Db, Tx } from '@/server/db'
import { refusalDetails } from '@/server/rules/orders/order-refusal'
import { placeOrder } from '@/server/rules/orders/place-order'
import catalog from './live-catalog.json'
import { fixtures, insert } from './database'
import { startRealPostgres, type RealPostgres } from './real-postgres'
import { attempt, deferred, makeRace, Refused, type Race } from './race'

// Two Worker clients on real Postgres, racing inside real db.transaction()s. The capacity half is
// the staff app's own SQL (shared/sessionCapacity.ts), as W04 copied it; T1's own session claim is
// proven in orders/place-order-postgres.test.ts. The store credit half is the ported claim: T1 itself,
// placing an order paid with store credit (W09, W06 report N1).

let pg: RealPostgres
let first: Db
let second: Db
let race: Race

beforeAll(async () => {
  pg = await startRealPostgres()
  first = pg.connect()
  second = pg.connect()
  race = makeRace(pg, first, second)
})

afterAll(() => pg.stop())

describe('real Postgres', () => {
  it('is the version live runs, with the live schema loaded', async () => {
    const [version] = await pg.admin`SHOW server_version`
    expect(version?.['server_version']).toBe('17.6')
    const [tables] = await pg.admin`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`
    expect(tables?.['n']).toBe(catalog.tables.length)
    const [triggers] = await pg.admin`SELECT count(*)::int AS n FROM pg_trigger WHERE NOT tgisinternal`
    expect(triggers?.['n']).toBe(catalog.triggers.length)
  })

  it('connects as the worker role, not the superuser', async () => {
    const rows = await first.query<{ who: string; superuser: string }>(
      `SELECT current_user AS who, current_setting('is_superuser') AS superuser`
    )
    expect(rows[0]).toStrictEqual({ who: 'paddock_worker', superuser: 'off' })
  })
})

describe('the last place on a session', () => {
  let serviceType: string
  let day = 0

  /** A public session with one place left, and a customer for each side. */
  async function lastPlace() {
    day += 1
    const start = new Date(Date.UTC(2030, 0, day, 10)).toISOString()
    const end = new Date(Date.UTC(2030, 0, day, 11)).toISOString()
    return {
      session: await fixtures.session(first, {
        service_type_id: serviceType,
        start_time: start,
        end_time: end,
        capacity: 6,
        total_booked: 5,
      }),
      start,
      end,
      first: await fixtures.customer(first),
      second: await fixtures.customer(first),
    }
  }

  type Seed = Awaited<ReturnType<typeof lastPlace>>

  /** A booking row as createBooking writes one, with the session's times copied on. */
  const insertBooking = async (tx: Tx, seed: Seed, customer: string) => {
    const rows = await tx.query<{ id: string }>(
      `INSERT INTO bookings (session_id, customer_id, price_paid, status, start_time, end_time)
       VALUES ($1, $2, 0, 'confirmed', $3, $4) RETURNING id`,
      [seed.session, customer, seed.start, seed.end]
    )
    return rows[0]?.id as string
  }

  /** claimSessionCapacity for a public session, then createBooking's refusal and its booking row. */
  async function book(tx: Tx, seed: Seed, customer: string): Promise<string> {
    const claimed = await tx.query(
      `UPDATE sessions
       SET total_booked = total_booked + $1, updated_at = now()
       WHERE id = $2 AND status = 'open' AND (capacity - total_booked) >= $3
       RETURNING id`,
      [1, seed.session, 1]
    )
    if (claimed.length === 0) throw new Refused('insufficient_capacity')
    return insertBooking(tx, seed, customer)
  }

  const state = async (session: string) => {
    const rows = await first.query<{ total_booked: number; bookings: number }>(
      `SELECT s.total_booked, (SELECT count(*)::int FROM bookings b WHERE b.session_id = s.id) AS bookings
       FROM sessions s WHERE s.id = $1`,
      [session]
    )
    return rows[0]
  }

  beforeAll(async () => {
    serviceType = await fixtures.serviceType(first)
  })

  it('gives it to the first and refuses the second, who waited', async () => {
    const seed = await lastPlace()
    const result = await race((tx, who) => book(tx, seed, seed[who]), 'commit')

    expect(result.first).toHaveProperty('won')
    expect(result.second).toMatchObject({ refused: { reason: 'insufficient_capacity' } })
    expect(await state(seed.session)).toStrictEqual({ total_booked: 6, bookings: 1 })
  })

  it('gives it to the second if the first rolls back', async () => {
    const seed = await lastPlace()
    const result = await race((tx, who) => book(tx, seed, seed[who]), 'rollback')

    expect(result.first).toMatchObject({ refused: { reason: 'first_rolled_back' } })
    expect(result.second).toHaveProperty('won')
    expect(await state(seed.session)).toStrictEqual({ total_booked: 6, bookings: 1 })
  })

  it('has one winner in every free-running race', async () => {
    for (let round = 0; round < 25; round += 1) {
      const seed = await lastPlace()
      const results = await Promise.all([
        attempt(first, (tx) => book(tx, seed, seed.first)),
        attempt(second, (tx) => book(tx, seed, seed.second)),
      ])

      expect(results.filter((r) => 'won' in r)).toHaveLength(1)
      expect(results.find((r) => 'refused' in r)).toMatchObject({ refused: { reason: 'insufficient_capacity' } })
      expect(await state(seed.session)).toStrictEqual({ total_booked: 6, bookings: 1 })
    }
  }, 30_000)

  // Shows the tests above can fail: without the guard in the UPDATE, these same connections overbook.
  it('overbooks if the check is a read before the write, so the race is real', async () => {
    const seed = await lastPlace()
    const bothRead = [deferred(), deferred()] as const
    const unguarded = (index: 0 | 1, customer: string) => async (tx: Tx) => {
      const rows = await tx.query<{ left: number }>('SELECT capacity - total_booked AS left FROM sessions WHERE id = $1', [seed.session])
      bothRead[index].resolve()
      await Promise.all(bothRead.map((read) => read.promise))
      if ((rows[0]?.left ?? 0) < 1) throw new Refused('insufficient_capacity')
      await tx.query('UPDATE sessions SET total_booked = total_booked + 1 WHERE id = $1', [seed.session])
      await insertBooking(tx, seed, customer)
    }

    const results = await Promise.all([attempt(first, unguarded(0, seed.first)), attempt(second, unguarded(1, seed.second))])

    expect(results.filter((r) => 'won' in r)).toHaveLength(2)
    expect(await state(seed.session)).toStrictEqual({ total_booked: 7, bookings: 2 })
  })
})

describe('the same store credit', () => {
  let addon: string
  let staffId: string

  beforeAll(async () => {
    // A £10 add-on on its own, paid wholly with store credit, so nothing is left to pay.
    addon = await insert(first, 'addons', { name: 'Robe', sku: `ROBE-${crypto.randomUUID()}`, base_price: '10.00' })
    staffId = await insert(first, 'staff', { role: 'staff', first_name: 'Jo', last_name: 'Staff', email: `jo-${crypto.randomUUID()}@example.com` })
  })

  const storeCreditOrder = (customer: string, amount: number): PlaceOrderInput => ({
    customerId: customer,
    standaloneAddons: [{ addonId: addon, quantity: amount / 10 }],
    payment: { storeCredit: { amount } },
  })

  /** T1 paid with £`amount` of store credit, in the race's transaction (it joins it). A refusal becomes the race's Refused. */
  const spend = (customer: string, amount: number) => async (_tx: Tx, who: 'first' | 'second') => {
    try {
      return await placeOrder(who === 'first' ? first : second, storeCreditOrder(customer, amount), { actor: { type: 'staff', id: staffId }, requestId: 'two-connections' })
    } catch (err) {
      const details = refusalDetails(err)
      if (details) throw new Refused(details.reason)
      throw err
    }
  }

  const state = async (customer: string) => {
    const rows = await first.query<{ balance: string; spends: number }>(
      `SELECT c.store_credit_balance AS balance,
              (SELECT count(*)::int FROM store_credit_transactions t WHERE t.customer_id = c.id) AS spends
       FROM customers c WHERE c.id = $1`,
      [customer]
    )
    return rows[0]
  }

  const customerWith = (balance: string) => fixtures.customer(first, { store_credit_balance: balance })

  it('lets the first spend it and refuses the second, who waited on the customer', async () => {
    const customer = await customerWith('10.00')
    const result = await race(spend(customer, 10), 'commit', 'customers')

    expect(result.first).toMatchObject({ won: { payment: { method: 'store_credit', storeCreditApplied: 10 } } })
    expect(result.second).toMatchObject({ refused: { reason: 'store_credit_insufficient' } })
    expect(await state(customer)).toStrictEqual({ balance: '0.00', spends: 1 })
  })

  it('refuses the second against what is left, not the balance it started with', async () => {
    const customer = await customerWith('15.00')
    const result = await race(spend(customer, 10), 'commit', 'customers')

    expect(result.first).toHaveProperty('won')
    expect(result.second).toMatchObject({ refused: { reason: 'store_credit_insufficient' } })
    expect(await state(customer)).toStrictEqual({ balance: '5.00', spends: 1 })
  })

  it('lets the second spend it if the first rolls back', async () => {
    const customer = await customerWith('10.00')
    const result = await race(spend(customer, 10), 'rollback', 'customers')

    expect(result.first).toMatchObject({ refused: { reason: 'first_rolled_back' } })
    expect(result.second).toHaveProperty('won')
    expect(await state(customer)).toStrictEqual({ balance: '0.00', spends: 1 })
  })

  it('lets both spend when there is enough for both', async () => {
    const customer = await customerWith('20.00')
    const result = await race(spend(customer, 10), 'commit', 'customers')

    expect(result.first).toHaveProperty('won')
    expect(result.second).toHaveProperty('won')
    expect(await state(customer)).toStrictEqual({ balance: '0.00', spends: 2 })
  })

  it('has one winner in every free-running race', async () => {
    for (let round = 0; round < 25; round += 1) {
      const customer = await customerWith('10.00')
      const results = await Promise.all([attempt(first, (tx) => spend(customer, 10)(tx, 'first')), attempt(second, (tx) => spend(customer, 10)(tx, 'second'))])

      expect(results.filter((r) => 'won' in r)).toHaveLength(1)
      expect(results.find((r) => 'refused' in r)).toMatchObject({ refused: { reason: 'store_credit_insufficient' } })
      expect(await state(customer)).toStrictEqual({ balance: '0.00', spends: 1 })
    }
  }, 60_000)

  // Shows the tests above can fail: reading the balance first, both spend the same £10.
  it('spends it twice if the balance is read before the write, so the race is real', async () => {
    const customer = await customerWith('10.00')
    const bothRead = [deferred(), deferred()] as const
    const unguarded = (index: 0 | 1) => async (tx: Tx) => {
      const rows = await tx.query<{ balance: string }>('SELECT store_credit_balance AS balance FROM customers WHERE id = $1', [customer])
      bothRead[index].resolve()
      await Promise.all(bothRead.map((read) => read.promise))
      const left = Number(rows[0]?.balance) - 10
      if (left < 0) throw new Refused('insufficient_store_credit')
      await tx.query('UPDATE customers SET store_credit_balance = $1 WHERE id = $2', [left, customer])
    }

    const results = await Promise.all([attempt(first, unguarded(0)), attempt(second, unguarded(1))])

    expect(results.filter((r) => 'won' in r)).toHaveLength(2)
    expect((await state(customer))?.balance).toBe('0.00')
  })
})
