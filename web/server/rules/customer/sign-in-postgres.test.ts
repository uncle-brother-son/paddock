import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Db, Tx } from '@/server/db'
import { postgresRefusal } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import { createCustomer } from '@/server/rules/customers/create'
import { insert } from '@/server/rules/testing/database'
import { deferred } from '@/server/rules/testing/race'
import { startRealPostgres, type RealPostgres } from '@/server/rules/testing/real-postgres'
import { createSignInCustomer, linkSignIn } from './sign-in'

vi.setConfig({ testTimeout: 60_000 })

// Brief W85a item 3 on real Postgres 17.6 (the saved schema, carrying migration 036), each client on its own
// connection: the website's create at the same moment as another writer of the same email. The first writer's
// transaction is held open after its insert until Postgres reports the second as waiting on it, so it can't pass by
// timing. A staff create first: the website's create ends in the link (one customer, staff's details kept), never a
// duplicate and never a fault; the staff create rolled back instead: the website's create makes the customer. The
// website's create first: staff's create is refused with its duplicate words. Two of the website's creates for one
// login: one customer, the second answers linked. Two logins of one email at once: one customer, the other refused.

let pg: RealPostgres
let first: Db
let second: Db
let third: Db
let staffId: string
let n = 0

beforeAll(async () => {
  pg = await startRealPostgres()
  first = pg.connect()
  second = pg.connect()
  third = pg.connect()
  staffId = await insert(first, 'staff', { role: 'staff', first_name: 'Jo', last_name: 'Staff', email: 'w85a-race@example.com', can_issue_refunds: false })
}, 120_000)
afterAll(() => pg.stop())

const fresh = (): string => `w85a.race.${(n += 1)}@example.com`
async function newLogin(email: string): Promise<{ authUserId: string; email: string }> {
  const authUserId = crypto.randomUUID()
  await pg.admin.unsafe(`INSERT INTO auth.users (id) VALUES ('${authUserId}')`)
  return { authUserId, email }
}
const staffCreate = (db: Db, email: string) => createCustomer(db, { firstName: 'Staff', lastName: 'Made', email, dateOfBirth: '1985-05-05' }, { channel: 'staff', staffId, requestId: crypto.randomUUID() })
const webCreate = (db: Db, login: { authUserId: string; email: string }) => createSignInCustomer(db, login, { firstName: 'Web', lastName: 'Made' }, crypto.randomUUID())

type Outcome<T> = { answered: T } | { refused: string } | { database: string; constraint: string | null }
async function outcome<T>(work: Promise<T>): Promise<Outcome<T>> {
  try {
    return { answered: await work }
  } catch (err) {
    if (err instanceof ApiError) return { refused: String((err.details as { reason?: unknown } | undefined)?.reason ?? err.code) }
    const refused = postgresRefusal(err)
    if (refused) return { database: refused.code, constraint: refused.constraint }
    throw err
  }
}

/** `db`, with its first transaction held open after its work is done (nothing committed) until `finish`; `fail` rolls it back. */
function heldOpen(db: Db): { db: Db; pid: Promise<number>; finish(): void; fail(): void } {
  const release = deferred()
  let rollBack = false
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
          if (rollBack) throw new Error('rolled back by the test')
          return result
        })
      }
    },
  })
  return {
    db: held,
    pid,
    finish: () => release.resolve(),
    fail: () => {
      rollBack = true
      release.resolve()
    },
  }
}

async function blockedBy(holding: number): Promise<void> {
  const giveUpAt = Date.now() + 4_000
  while (Date.now() < giveUpAt) {
    const rows = await pg.admin.unsafe<{ pid: number }[]>('SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))', [holding])
    if (rows[0]) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Nothing waited on the holder.')
}

async function race<A, B>(held: (db: Db) => Promise<A>, waiter: (db: Db) => Promise<B>, firstEnds: 'commit' | 'rollback' = 'commit'): Promise<{ held: Outcome<A> | { rolledBack: true }; waiter: Outcome<B> }> {
  const holding = heldOpen(first)
  const heldWork = outcome(held(holding.db)).catch((err: unknown) => {
    if (err instanceof Error && err.message === 'rolled back by the test') return { rolledBack: true as const }
    throw err
  })
  const holdingPid = await Promise.race([holding.pid, heldWork.then(() => Promise.reject(new Error('The first ended before it could be held.')))])
  let settled = false
  const waiting = outcome(waiter(second)).finally(() => {
    settled = true
  })
  await blockedBy(holdingPid)
  expect(settled).toBe(false)
  if (firstEnds === 'commit') holding.finish()
  else holding.fail()
  return { held: await heldWork, waiter: await waiting }
}

const stored = (email: string) =>
  third.query<{ first_name: string; date_of_birth: string | null; auth_user_id: string | null }>(
    'SELECT first_name, date_of_birth::text AS date_of_birth, auth_user_id::text AS auth_user_id FROM customers WHERE lower(email) = lower($1) ORDER BY created_at, id',
    [email]
  )

describe('create on sign-up against another writer of the same email, at the same moment (W85a item 3)', () => {
  it('a staff create first: the website create waits on it, then links that customer: one customer, staff\'s details kept, no fault', async () => {
    const email = fresh()
    const login = await newLogin(email)
    const result = await race(
      (db) => staffCreate(db, email),
      (db) => webCreate(db, login)
    )
    expect(result.held).toMatchObject({ answered: { email, first_name: 'Staff' } })
    expect(result.waiter).toEqual({ answered: { status: 'linked', customer: { firstName: 'Staff', email }, change: 'linked' } })
    expect(await stored(email)).toEqual([{ first_name: 'Staff', date_of_birth: '1985-05-05', auth_user_id: login.authUserId }])
  })

  it('the staff create rolls back: the website create, which waited, makes the customer', async () => {
    const email = fresh()
    const login = await newLogin(email)
    const result = await race(
      (db) => staffCreate(db, email),
      (db) => webCreate(db, login),
      'rollback'
    )
    expect(result.held).toEqual({ rolledBack: true })
    expect(result.waiter).toMatchObject({ answered: { change: 'created', customer: { firstName: 'Web' } } })
    expect(await stored(email)).toEqual([{ first_name: 'Web', date_of_birth: null, auth_user_id: login.authUserId }])
  })

  it('the website create first: staff\'s create waits, then is refused with its duplicate words (as any duplicate)', async () => {
    const email = fresh()
    const login = await newLogin(email)
    const result = await race(
      (db) => webCreate(db, login),
      (db) => staffCreate(db, email)
    )
    expect(result.held).toMatchObject({ answered: { change: 'created' } })
    expect(result.waiter).toEqual({ refused: 'duplicate_email' })
    expect(await stored(email)).toEqual([{ first_name: 'Web', date_of_birth: null, auth_user_id: login.authUserId }])
  })

  it('two creates for one login at once (a double press): one customer; the second answers linked', async () => {
    const email = fresh()
    const login = await newLogin(email)
    const result = await race(
      (db) => webCreate(db, login),
      (db) => webCreate(db, login)
    )
    expect(result.held).toMatchObject({ answered: { change: 'created' } })
    expect(result.waiter).toMatchObject({ answered: { status: 'linked', change: 'none' } })
    expect(await stored(email)).toHaveLength(1)
  })

  it('two logins of one email at once: one customer, linked to the first; the second is refused as linked elsewhere', async () => {
    const email = fresh()
    const one = await newLogin(email)
    const two = await newLogin(email)
    const result = await race(
      (db) => webCreate(db, one),
      (db) => webCreate(db, two)
    )
    expect(result.held).toMatchObject({ answered: { change: 'created' } })
    expect(result.waiter).toEqual({ refused: 'email_linked_elsewhere' })
    expect(await stored(email)).toEqual([{ first_name: 'Web', date_of_birth: null, auth_user_id: one.authUserId }])
  })

  it('W85a review (b)4: another writer of the same address in capitals at the same moment (the lower(email) rule, not the email key, is the one hit): the website create waits, then links that row; one customer', async () => {
    const email = fresh()
    const login = await newLogin(email)
    const capitals = email.toUpperCase()
    const result = await race(
      (db) => db.transaction((tx) => tx.query<{ id: string }>("INSERT INTO customers (first_name, last_name, email, date_of_birth) VALUES ('Cap', 'Ital', $1, '1990-01-01') RETURNING id", [capitals])),
      (db) => webCreate(db, login)
    )
    expect(result.held).toMatchObject({ answered: [{ id: expect.any(String) }] })
    expect(result.waiter).toEqual({ answered: { status: 'linked', customer: { firstName: 'Cap', email: capitals }, change: 'linked' } })
    expect(await stored(email)).toEqual([{ first_name: 'Cap', date_of_birth: '1990-01-01', auth_user_id: login.authUserId }])
  })

  it('two logins of one email linking one existing customer at once: the second waits on the first\'s lock, then is refused as linked elsewhere; the customer has the first login (W85a Level 1)', async () => {
    const email = fresh()
    await staffCreate(third, email)
    const one = await newLogin(email)
    const two = await newLogin(email)
    const result = await race(
      (db) => linkSignIn(db, one, crypto.randomUUID()),
      (db) => linkSignIn(db, two, crypto.randomUUID())
    )
    expect(result.held).toMatchObject({ answered: { status: 'linked', change: 'linked' } })
    expect(result.waiter).toEqual({ refused: 'email_linked_elsewhere' })
    expect(await stored(email)).toEqual([{ first_name: 'Staff', date_of_birth: '1985-05-05', auth_user_id: one.authUserId }])
  })

  it('one login linking twice at once (a double press): the second waits, then answers linked with nothing done', async () => {
    const email = fresh()
    await staffCreate(third, email)
    const login = await newLogin(email)
    const result = await race(
      (db) => linkSignIn(db, login, crypto.randomUUID()),
      (db) => linkSignIn(db, login, crypto.randomUUID())
    )
    expect(result.held).toMatchObject({ answered: { change: 'linked' } })
    expect(result.waiter).toMatchObject({ answered: { status: 'linked', change: 'none' } })
    expect(await stored(email)).toEqual([{ first_name: 'Staff', date_of_birth: '1985-05-05', auth_user_id: login.authUserId }])
  })

  it('a link at the same moment as a staff create: the link waits on nothing (it finds no customer yet) and answers needs details, and nothing is linked by it', async () => {
    const email = fresh()
    const login = await newLogin(email)
    const holding = heldOpen(first)
    const made = outcome(staffCreate(holding.db, email))
    await holding.pid
    expect(await linkSignIn(second, login, crypto.randomUUID())).toEqual({ status: 'needs_details' })
    holding.finish()
    expect(await made).toMatchObject({ answered: { email } })
    // Signing in again now finds the staff customer.
    expect(await linkSignIn(second, login, crypto.randomUUID())).toMatchObject({ status: 'linked', change: 'linked' })
  })
})
