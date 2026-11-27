import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '@/server/db'
import { FakeStripe } from '@/server/stripe/fake'
import { insert } from './database'
import { startRealPostgres, type RealPostgres } from './real-postgres'
import { ID, seed } from './replay/scenarios'

// Wayne's WQ99 (27 Nov 2026; W85a report "Noticed" 1): migration 037 makes customers_auth_user_id_fkey ON DELETE SET
// NULL, so deleting a website login never deletes its customer. Written but NOT applied to live; the lead applies it
// before the W85a Worker is pushed. The saved schema (live-catalog.json, live-schema.sql) carries it already, as 036.
// This file holds the two to each other on real Postgres (037's Down run, the catalogue differs only in that key; 037
// applied again is the saved schema to the last character) and holds what 037 does: a deleted login leaves its
// customer, their bookings, orders and store credit, with the login empty; under the old key the same delete took the
// customer (or was refused for an order).

const MIGRATION = path.resolve(__dirname, '../../../../supabase/migrations/037_deleting_a_login_keeps_its_customer.sql')
const CATALOG_QUERY = readFileSync(path.join(__dirname, 'live-catalog-query.sql'), 'utf8')
const KEY = 'customers_auth_user_id_fkey'
const SET_NULL = 'FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE SET NULL'
const CASCADE = 'FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE CASCADE'

const migration = (): string => readFileSync(MIGRATION, 'utf8')
const statements = (): string[] =>
  migration()
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--') && line.trim() !== '')
/** The Down in the footer, its comment marks taken off. */
const down = (): string[] => {
  const lines = migration().split('\n')
  const from = lines.findIndex((line) => line.startsWith('-- Down ('))
  if (from < 0) throw new Error("Migration 037's Down wasn't found.")
  return lines
    .slice(from + 1)
    .filter((line) => /^-- {3}\S/.test(line))
    .map((line) => line.replace(/^-- {3}/, ''))
}
/** A header check's SQL: the line indented nine spaces under the line holding `mark`. */
const checkUnder = (mark: string): string => {
  const lines = migration().split('\n')
  const from = lines.findIndex((line) => line.includes(mark))
  const sql = lines.slice(from + 1).find((line) => /^-- {9}\S/.test(line))
  if (from < 0 || !sql) throw new Error(`No check under "${mark}" in migration 037.`)
  return sql.replace(/^-- {9}/, '')
}

interface Catalog {
  constraints: Array<{ table: string; name: string; definition: string }>
  [key: string]: unknown
}

describe('migration 037 (WQ99): deleting a website login never deletes its customer', () => {
  let pg: RealPostgres
  let db: Db
  const catalog = async (): Promise<Catalog> => {
    const raw = (await pg.admin.unsafe(CATALOG_QUERY))[0]?.['catalog'] as Catalog | string
    return typeof raw === 'string' ? (JSON.parse(raw) as Catalog) : raw
  }
  const keyOf = (from: Catalog) => from.constraints.find((one) => one.name === KEY)?.definition
  const apply = async (): Promise<void> => void (await pg.admin.begin((tx) => tx.unsafe(migration())))
  const runDown = async (): Promise<void> => void (await pg.admin.begin((tx) => tx.unsafe(down().join('\n'))))
  /** A new customer linked to a new login, with a booking on the seed's session (and an order, when asked). */
  const linkedCustomer = async (withOrder: boolean): Promise<{ id: string; login: string }> => {
    const login = crypto.randomUUID()
    await pg.admin.unsafe(`INSERT INTO auth.users (id) VALUES ('${login}')`)
    const id = await insert(db, 'customers', { first_name: 'Lin', last_name: 'Ked', email: `${login}@example.com`, auth_user_id: login })
    await insert(db, 'bookings', { session_id: ID.session, customer_id: id, status: 'confirmed', price_paid: '20.00' })
    if (withOrder) await insert(db, 'orders', { customer_id: id, order_total: '20.00', payment_status: 'paid' })
    return { id, login }
  }
  const thingsOf = async (id: string) => ({
    customer: (await db.query<{ auth_user_id: string | null }>('SELECT auth_user_id::text AS auth_user_id FROM customers WHERE id = $1', [id]))[0] ?? null,
    bookings: Number((await db.query<{ n: string }>('SELECT count(*)::text AS n FROM bookings WHERE customer_id = $1', [id]))[0]?.n),
    orders: Number((await db.query<{ n: string }>('SELECT count(*)::text AS n FROM orders WHERE customer_id = $1', [id]))[0]?.n),
  })
  const deleteLogin = (login: string) => pg.admin.unsafe(`DELETE FROM auth.users WHERE id = '${login}'`)

  beforeAll(async () => {
    pg = await startRealPostgres()
    db = pg.connect()
    await seed(db, new FakeStripe())
  }, 120_000)
  afterAll(() => pg.stop())

  /** The saved schema's own state before each test: 037 in. */
  beforeEach(async () => {
    if (keyOf(await catalog()) !== SET_NULL) await apply()
  })

  it('the file says it is not applied by W85a and must be applied as one transaction, and is: a lock time limit, the key dropped and made again with SET NULL under its own name; its Down puts the cascade back', () => {
    const sql = migration()
    expect(sql).toContain("-- NOT APPLIED by W85a. The lead applies it, with Wayne's yes, BEFORE the W85a Worker is pushed")
    expect(sql).toContain('-- APPLY IT AS ONE TRANSACTION')
    expect(statements()).toEqual([
      "SET LOCAL lock_timeout = '5s';",
      `ALTER TABLE public.customers DROP CONSTRAINT ${KEY};`,
      `ALTER TABLE public.customers ADD CONSTRAINT ${KEY} ${SET_NULL};`,
    ])
    expect(down()).toEqual([`ALTER TABLE public.customers DROP CONSTRAINT ${KEY};`, `ALTER TABLE public.customers ADD CONSTRAINT ${KEY} ${CASCADE};`])
  })

  it('the saved schema carries 037; with its Down run the catalogue differs only in that key; applied again it is the saved schema, to the last character', async () => {
    const saved = await catalog()
    expect(keyOf(saved)).toBe(SET_NULL)
    await runDown()
    const before = await catalog()
    expect(keyOf(before)).toBe(CASCADE)
    const key = before.constraints.find((one) => one.name === KEY)
    if (key) key.definition = SET_NULL
    expect(before).toEqual(saved)
    await apply()
    expect(await catalog()).toEqual(saved)
  })

  it('a login deleted leaves its customer, their booking and order, with the login empty', async () => {
    for (const withOrder of [false, true]) {
      const { id, login } = await linkedCustomer(withOrder)
      expect((await thingsOf(id)).customer).toEqual({ auth_user_id: login })
      await deleteLogin(login)
      expect(await thingsOf(id)).toEqual({ customer: { auth_user_id: null }, bookings: 1, orders: withOrder ? 1 : 0 })
    }
  })

  it('under the old key (the Down) the same delete took the customer and their booking; with an order it was refused', async () => {
    await runDown()
    const plain = await linkedCustomer(false)
    await deleteLogin(plain.login)
    expect(await thingsOf(plain.id)).toEqual({ customer: null, bookings: 0, orders: 0 })
    const withOrder = await linkedCustomer(true)
    await expect(deleteLogin(withOrder.login)).rejects.toThrow(/orders_customer_id_fkey/)
  })

  it("the header's own checks answer as it says once applied", async () => {
    expect((await pg.admin.unsafe(checkUnder('the key now sets the login to empty')))[0]?.['pg_get_constraintdef']).toBe(SET_NULL)
    expect((await pg.admin.unsafe(checkUnder('still one such key on customers')))[0]?.['count']).toBe('1')
  })
})
