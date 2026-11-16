import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { POST as createRoute } from '@/app/api/v1/staff/customers/route'
import type { Db, Tx } from '@/server/db'
import { postgresRefusal } from '@/server/db'
import { ApiError } from '@/server/http/errors'
import { insert } from '@/server/rules/testing/database'
import { deferred } from '@/server/rules/testing/race'
import { startRealPostgres, type RealPostgres } from '@/server/rules/testing/real-postgres'
import { createCustomer } from './create'

vi.setConfig({ testTimeout: 60_000 })

// Brief W39 item 6 on real Postgres 17.6, each client on its own connection: two creates of one email at once. The
// race holds the first create's transaction open, after its insert, until Postgres reports the second as waiting on
// it, so it can't pass by timing: both have passed the "already on file" check by then, and the database's unique
// rule decides. One is created; the other is refused with the old duplicate words, never a fault. The same with
// migration 027's index on, and against another writer who doesn't lower-case (the gap 027 closes). The control runs
// the insert on its own, the same way, and gets the database's raw violation.

const holder = vi.hoisted(() => ({ next: [] as unknown[] }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => {
    const db = holder.next.shift()
    if (!db) throw new Error('No connection was queued for this request.')
    return db as Db
  },
  closeRequestDb: () => {},
}))

const KEY = 'test-staff-api-key'
const STAFF_EMAIL = 'w39-race@example.com'
const DUPLICATE = 'A customer with this email address already exists'
const MIGRATION = path.resolve(__dirname, '../../../../supabase/migrations/027_customers_email_unique_in_any_case.sql')
const INDEX = 'customers_email_lower_key'

let pg: RealPostgres
let first: Db
let second: Db
let third: Db
let staffId: string
let n = 0

beforeAll(async () => {
  process.env.STAFF_API_KEY = KEY
  pg = await startRealPostgres()
  first = pg.connect()
  second = pg.connect()
  third = pg.connect()
  staffId = await insert(first, 'staff', { role: 'staff', first_name: 'Jo', last_name: 'Staff', email: STAFF_EMAIL, can_issue_refunds: false })
})
afterAll(() => pg.stop())

const by = () => ({ channel: 'staff' as const, staffId, requestId: crypto.randomUUID() })
const person = (email: string) => ({ firstName: 'Race', lastName: 'Runner', email, dateOfBirth: '1990-01-01' })
const fresh = (): string => `w39.race.${(n += 1)}@example.com`

type Outcome<T> = { answered: T } | { refused: string; message: string } | { database: string; constraint: string | null }
async function outcome<T>(work: Promise<T>): Promise<Outcome<T>> {
  try {
    return { answered: await work }
  } catch (err) {
    if (err instanceof ApiError) return { refused: String((err.details as { reason?: unknown } | undefined)?.reason ?? err.code), message: err.message }
    const refused = postgresRefusal(err)
    if (refused) return { database: refused.code, constraint: refused.constraint }
    throw err
  }
}

/** `db`, with its first transaction held open after its work is done (every write made, nothing committed) until `finish`; `fail` rolls it back instead. */
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

/** Waits until Postgres itself reports a session blocked by `holding`. */
async function blockedBy(holding: number): Promise<number> {
  const giveUpAt = Date.now() + 4_000
  while (Date.now() < giveUpAt) {
    const rows = await pg.admin.unsafe<{ pid: number }[]>('SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))', [holding])
    if (rows[0]) return rows[0].pid
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('Nothing waited on the holder.')
}

/** Runs `held` and keeps its transaction open, starts `waiter`, checks Postgres reports it waiting on the first, then lets the first commit or roll back. */
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

const stored = async (email: string) => (await third.query<{ email: string }>('SELECT email FROM customers WHERE lower(email) = lower($1) ORDER BY created_at, id', [email])).map((row) => row.email)
const created = async (email: string) => Number((await third.query<{ n: string }>("SELECT count(*)::text AS n FROM audit_log a JOIN customers c ON c.id::text = a.entity_id WHERE a.action = 'customer.created' AND lower(c.email) = lower($1)", [email]))[0]?.n)
const hasIndex = async () => (await pg.admin.unsafe(`SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = '${INDEX}'`)).length > 0

/** What another writer does: the address as typed, no lower-casing and no check first. */
const otherWriter = (db: Db, email: string) =>
  db.transaction((tx) => tx.query<{ id: string }>("INSERT INTO customers (first_name, last_name, email, date_of_birth) VALUES ('Other', 'Writer', $1, '1990-01-01') RETURNING id", [email]))

function raceTests(when: string): void {
  it(`${when}: two creates of one email at once: the second waits on the first; one is created, the other is refused with the duplicate words; one customer, one audit row`, async () => {
    const email = fresh()
    const result = await race(
      (db) => createCustomer(db, person(email), by()),
      (db) => createCustomer(db, person(email), by())
    )
    expect(result.held).toMatchObject({ answered: { email } })
    expect(result.waiter).toEqual({ refused: 'duplicate_email', message: DUPLICATE })
    expect(await stored(email)).toEqual([email])
    expect(await created(email)).toBe(1)
  })

  it(`${when}: the same, typed in two different cases: both are lower-cased, so the second is refused the same way`, async () => {
    const email = fresh()
    const result = await race(
      (db) => createCustomer(db, person(email.toUpperCase()), by()),
      (db) => createCustomer(db, person(` ${email.replace('w39', 'W39')} `), by())
    )
    expect(result.held).toMatchObject({ answered: { email } })
    expect(result.waiter).toEqual({ refused: 'duplicate_email', message: DUPLICATE })
    expect(await stored(email)).toEqual([email])
  })

  it(`${when}: the first rolls back: the second, which waited, is created (nothing of the first is kept)`, async () => {
    const email = fresh()
    const result = await race(
      (db) => createCustomer(db, person(email), by()),
      (db) => createCustomer(db, { ...person(email), firstName: 'Second' }, by()),
      'rollback'
    )
    expect(result.held).toEqual({ rolledBack: true })
    expect(result.waiter).toMatchObject({ answered: { email, first_name: 'Second' } })
    expect(await stored(email)).toEqual([email])
    expect(await created(email)).toBe(1)
  })

  it(`${when}: the control: the insert on its own, the same way, gets the database's raw violation (which the rule turns into the refusal)`, async () => {
    const email = fresh()
    const result = await race(
      (db) => createCustomer(db, person(email), by()),
      (db) => otherWriter(db, email)
    )
    expect(result.held).toMatchObject({ answered: { email } })
    expect(result.waiter).toMatchObject({ database: '23505' })
    expect(await stored(email)).toEqual([email])
  })
}

describe('two creates at once (brief W39 item 6; FB21)', () => {
  it('the saved schema has the key on the email as written, and this run starts as the saved schema is', async () => {
    const [key] = await pg.admin.unsafe("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = 'customers_email_key'")
    expect(key?.['definition']).toBe('UNIQUE (email)')
  })

  describe('with the index on lower(email) taken off (live before migration 027)', () => {
    beforeAll(() => pg.admin.unsafe(`DROP INDEX IF EXISTS public.${INDEX}`))
    raceTests('before 027')

    it('before 027, the gap it closes: another writer adds the address in capitals while ours is being made, and both are kept (two accounts for one person)', async () => {
      const email = fresh()
      expect(await hasIndex()).toBe(false)
      const ours = heldOpen(first)
      const making = outcome(createCustomer(ours.db, person(email), by()))
      await ours.pid
      // Not blocked: the key on `email` as written sees two different values.
      expect(await outcome(otherWriter(second, email.toUpperCase()))).toMatchObject({ answered: [expect.any(Object)] })
      ours.finish()
      expect(await making).toMatchObject({ answered: { email } })
      expect((await stored(email)).sort()).toEqual([email, email.toUpperCase()].sort())
      // And once it is there, the rule refuses a third in any case.
      expect(await outcome(createCustomer(third, person(email.replace('race', 'RACE')), by()))).toEqual({ refused: 'duplicate_email', message: DUPLICATE })
    })
  })

  describe('with migration 027 applied', () => {
    beforeAll(async () => {
      // 027 can't go on while two accounts share an address (its own pre-check): the pair the test above left is taken out first.
      await pg.admin.unsafe("DELETE FROM customers WHERE email <> lower(email) AND first_name = 'Other'")
      await pg.admin.unsafe(readFileSync(MIGRATION, 'utf8'))
    })
    raceTests('after 027')

    it('after 027: another writer adding the address in capitals while ours is being made now waits, and is refused by the index; one account', async () => {
      const email = fresh()
      expect(await hasIndex()).toBe(true)
      const result = await race(
        (db) => createCustomer(db, person(email), by()),
        (db) => otherWriter(db, email.toUpperCase())
      )
      expect(result.held).toMatchObject({ answered: { email } })
      expect(result.waiter).toEqual({ database: '23505', constraint: INDEX })
      expect(await stored(email)).toEqual([email])
    })

    it('after 027, the other way round: another writer first, in capitals: ours waits on it, and is refused with the duplicate words (the index\'s violation, never a fault)', async () => {
      const email = fresh()
      const result = await race(
        (db) => otherWriter(db, email.toUpperCase()),
        (db) => createCustomer(db, person(email), by())
      )
      expect(result.held).toMatchObject({ answered: [expect.any(Object)] })
      expect(result.waiter).toEqual({ refused: 'duplicate_email', message: DUPLICATE })
      expect(await stored(email)).toEqual([email.toUpperCase()])
    })
  })
})

describe('through the route, two requests on two connections', () => {
  type Answer = { status: number; body: { ok: boolean; data?: { id: string }; error?: { code: string; message: string; details?: { reason?: string } } } }
  async function press(db: Db, email: string, key: string): Promise<Answer> {
    holder.next.push(db)
    const response = await (createRoute as (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>)(
      new Request('https://worker.test/api/v1/staff/customers', {
        method: 'POST',
        headers: { authorization: `Bearer ${KEY}`, 'x-staff-email': STAFF_EMAIL, 'idempotency-key': key, 'content-type': 'application/json' },
        body: JSON.stringify(person(email)),
      }),
      { params: Promise.resolve({}) }
    )
    return { status: response.status, body: (await response.json()) as Answer['body'] }
  }

  it('two presses of one email at the same moment, 25 times over, with two keys: every time exactly one is created and the other is the duplicate refusal (409), never a fault', async () => {
    for (let round = 0; round < 25; round += 1) {
      const email = fresh()
      const answers = await Promise.all([press(first, email, crypto.randomUUID()), press(second, round % 2 ? email.toUpperCase() : email, crypto.randomUUID())])
      const statuses = answers.map((answer) => answer.status).sort()
      expect(statuses, `round ${round}: ${JSON.stringify(answers.map((answer) => answer.body.error))}`).toEqual([200, 409])
      const refused = answers.find((answer) => answer.status === 409)
      expect(refused?.body.error).toMatchObject({ code: 'CONFLICT', message: DUPLICATE, details: { reason: 'duplicate_email' } })
      expect(await stored(email)).toEqual([email])
      expect(await created(email)).toBe(1)
    }
  })

  it('a repeated press, the same key at the same moment, 25 times over: one customer every time, and never a fault; the key then answers with that customer', async () => {
    for (let round = 0; round < 25; round += 1) {
      const email = fresh()
      const key = crypto.randomUUID()
      const answers = await Promise.all([press(first, email, key), press(second, email, key)])
      for (const answer of answers) expect([200, 409], JSON.stringify(answer.body.error)).toContain(answer.status)
      expect(answers.some((answer) => answer.status === 200)).toBe(true)
      expect(await stored(email)).toEqual([email])
      expect(await created(email)).toBe(1)
      const made = answers.find((answer) => answer.status === 200)?.body.data?.id
      const again = await press(third, email, key)
      expect(again.status).toBe(200)
      expect(again.body.data?.id).toBe(made)
    }
    expect(await stored('nobody@example.com')).toEqual([])
  })
})
