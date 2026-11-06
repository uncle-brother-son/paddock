import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Db, Tx } from '@/server/db'
import catalog from './live-catalog.json'
import { fixtures } from './database'
import { startRealPostgres, type RealPostgres } from './real-postgres'

// Two Worker clients on real Postgres, racing inside real db.transaction()s. There is no order code
// here yet, so the claims are the staff app's own SQL, as W06 will port it: the capacity UPDATE from
// shared/sessionCapacity.ts, then the store_credit_apply function from the live schema.

/** The refusal a claim gives. Thrown so that db.transaction rolls back, as the order code will. */
class Refused extends Error {
  constructor(
    readonly reason: string,
    readonly balance?: string | number
  ) {
    super(reason)
  }
}

type Outcome<T> = { won: T } | { refused: Refused }

/** One attempt in its own transaction. Anything but a refusal is a test failure, so it is rethrown. */
async function attempt<T>(db: Db, work: (tx: Tx) => Promise<T>): Promise<Outcome<T>> {
  try {
    return { won: await db.transaction(work) }
  } catch (err) {
    if (err instanceof Refused) return { refused: err }
    throw err
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

let pg: RealPostgres
let first: Db
let second: Db

/** Waits until Postgres itself reports a session blocked by `holder`, and returns that session. */
async function sessionBlockedBy(holder: number): Promise<number> {
  const giveUpAt = Date.now() + 4_000
  while (Date.now() < giveUpAt) {
    const rows = await pg.admin.unsafe<{ pid: number }[]>(
      `SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))`,
      [holder]
    )
    if (rows[0]) return rows[0].pid
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('The second transaction never waited on the first.')
}

const backendPid = async (tx: Tx) => (await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]?.pid as number

/**
 * The race with its timing fixed. The first transaction makes its claim and stays open. The second
 * makes the same claim, and Postgres must report it as blocked by the first. Only then does the
 * first finish, by committing or rolling back, and the second carries on with what it finds.
 */
async function race<T>(claim: (tx: Tx, who: 'first' | 'second') => Promise<T>, firstEnds: 'commit' | 'rollback') {
  const finish = deferred()
  let announce: (pid: number) => void = () => {}
  const claimed = new Promise<number>((resolve) => {
    announce = resolve
  })

  const holder = attempt(first, async (tx) => {
    const result = await claim(tx, 'first')
    announce(await backendPid(tx))
    await finish.promise
    if (firstEnds === 'rollback') throw new Refused('first_rolled_back')
    return result
  })
  // If the first claim fails, this rejects rather than waiting for ever.
  const holderPid = await Promise.race([claimed, holder.then(() => Promise.reject(new Error('The first claim ended early.')))])

  let waiterPid = 0
  let waiterSettled = false
  const waiter = attempt(second, async (tx) => {
    waiterPid = await backendPid(tx)
    return claim(tx, 'second')
  }).finally(() => {
    waiterSettled = true
  })

  const blocked = await sessionBlockedBy(holderPid)
  expect(blocked).toBe(waiterPid)
  expect(waiterSettled).toBe(false)

  finish.resolve()
  return { first: await holder, second: await waiter }
}

beforeAll(async () => {
  pg = await startRealPostgres()
  first = pg.connect()
  second = pg.connect()
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
  interface Applied {
    ok: boolean
    reason?: string
    balance?: string | number
    transaction_id?: string
  }

  /** applyStoreCredit's call. A refusal comes back as a value, so it is thrown to roll back. */
  async function spend(tx: Tx, customer: string, amount: number): Promise<Applied> {
    const rows = await tx.query<{ result: Applied }>(
      `SELECT public.store_credit_apply($1::uuid, $2::numeric, $3::text, $4::uuid, $5::uuid, $6::uuid, $7::text, $8::uuid) AS result`,
      [customer, -amount, 'redemption', null, null, null, null, null]
    )
    const result = rows[0]?.result as Applied
    if (!result.ok) throw new Refused(result.reason as string, result.balance)
    return result
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

  it('lets the first spend it and refuses the second, who waited', async () => {
    const customer = await customerWith('10.00')
    const result = await race((tx) => spend(tx, customer, 10), 'commit')

    expect(result.first).toMatchObject({ won: { ok: true, balance: 0 } })
    expect(result.second).toMatchObject({ refused: { reason: 'insufficient_store_credit', balance: 0 } })
    expect(await state(customer)).toStrictEqual({ balance: '0.00', spends: 1 })
  })

  it('refuses the second against what is left, not the balance it started with', async () => {
    const customer = await customerWith('15.00')
    const result = await race((tx) => spend(tx, customer, 10), 'commit')

    expect(result.first).toMatchObject({ won: { ok: true, balance: 5 } })
    expect(result.second).toMatchObject({ refused: { reason: 'insufficient_store_credit', balance: 5 } })
    expect(await state(customer)).toStrictEqual({ balance: '5.00', spends: 1 })
  })

  it('lets the second spend it if the first rolls back', async () => {
    const customer = await customerWith('10.00')
    const result = await race((tx) => spend(tx, customer, 10), 'rollback')

    expect(result.first).toMatchObject({ refused: { reason: 'first_rolled_back' } })
    expect(result.second).toMatchObject({ won: { ok: true, balance: 0 } })
    expect(await state(customer)).toStrictEqual({ balance: '0.00', spends: 1 })
  })

  it('lets both spend when there is enough for both', async () => {
    const customer = await customerWith('20.00')
    const result = await race((tx) => spend(tx, customer, 10), 'commit')

    expect(result.first).toHaveProperty('won')
    expect(result.second).toMatchObject({ won: { ok: true, balance: 0 } })
    expect(await state(customer)).toStrictEqual({ balance: '0.00', spends: 2 })
  })

  it('has one winner in every free-running race', async () => {
    for (let round = 0; round < 25; round += 1) {
      const customer = await customerWith('10.00')
      const results = await Promise.all([
        attempt(first, (tx) => spend(tx, customer, 10)),
        attempt(second, (tx) => spend(tx, customer, 10)),
      ])

      expect(results.filter((r) => 'won' in r)).toHaveLength(1)
      expect(results.find((r) => 'refused' in r)).toMatchObject({ refused: { reason: 'insufficient_store_credit' } })
      expect(await state(customer)).toStrictEqual({ balance: '0.00', spends: 1 })
    }
  }, 30_000)

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
