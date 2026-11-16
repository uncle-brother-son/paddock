import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ApiError } from '@/server/http/errors'
import { createCustomer } from '@/server/rules/customers/create'
import { CUSTOMER_EMAIL_UNIQUE_RULES } from '@/server/rules/customers/failure-messages'
import { insert } from './database'
import { startRealPostgres, type RealPostgres } from './real-postgres'
import { EMAIL_LOWER_INDEX } from './replay/scenarios'

// Brief W39 item 3 (F-plan bug FB21; lead call L10): migration 027 is written but NOT applied to live, and the saved
// schema (live-catalog.json, live-schema.sql) is left as live is today: the lead applies 027 after W39's review and
// refreshes the snapshot from live then. This file holds the migration on real Postgres either way: with the index
// taken out of whatever the saved schema has, 027 adds exactly that one index and nothing else, twice over changes
// nothing, and its "Down" takes it out again. Once the snapshot has the index, the first test also holds that 027
// makes the saved schema exactly.

const MIGRATION = path.resolve(__dirname, '../../../../supabase/migrations/027_customers_email_unique_in_any_case.sql')
const CATALOG_QUERY = readFileSync(path.join(__dirname, 'live-catalog-query.sql'), 'utf8')
const INDEX = 'customers_email_lower_key'
/** 027's "Down", as the migration file gives it. */
const DOWN = `DROP INDEX IF EXISTS public.${INDEX};`
/** 027's pre-check, as the migration file gives it. */
const PRE_CHECK = 'SELECT lower(email) AS email, count(*) FROM public.customers GROUP BY lower(email) HAVING count(*) > 1;'

interface Catalog {
  indexes: Array<{ name: string; definition: string }>
  [key: string]: unknown
}

describe('migration 027 (brief W39 item 3): one customer per email address, whatever its case', () => {
  let pg: RealPostgres
  const catalog = async (): Promise<Catalog> => {
    const raw = (await pg.admin.unsafe(CATALOG_QUERY))[0]?.['catalog'] as Catalog | string
    return typeof raw === 'string' ? (JSON.parse(raw) as Catalog) : raw
  }
  const index = (from: Catalog) => from.indexes.find((one) => one.name === INDEX)
  const without = (from: Catalog): Catalog => ({ ...from, indexes: from.indexes.filter((one) => one.name !== INDEX) })
  const migration = () => readFileSync(MIGRATION, 'utf8')
  /** Runs `sql` and rolls it back: 'accepted', or the database's refusal. */
  const refused = async (sql: string): Promise<string> => {
    await pg.admin.unsafe('BEGIN')
    try {
      await pg.admin.unsafe(sql)
      return 'accepted'
    } catch (err) {
      return err instanceof Error ? err.message : String(err)
    } finally {
      await pg.admin.unsafe('ROLLBACK')
    }
  }
  const add = (email: string) => `INSERT INTO customers (first_name, last_name, email, date_of_birth) VALUES ('Case', 'Test', '${email}', '1990-01-01')`

  beforeAll(async () => {
    pg = await startRealPostgres()
  }, 120_000)
  afterAll(() => pg.stop())

  it('the file exists, says it is not applied by W39, names L10 and FB21 in the index\'s own comment, gives its pre-check and its Down, and writes or rewrites no row', () => {
    const sql = migration()
    expect(sql).toContain('NOT APPLIED by W39')
    expect(sql).toContain(`--   ${DOWN}`)
    expect(sql).toContain(`--    ${PRE_CHECK}`)
    const statements = sql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
    expect(statements).not.toMatch(/\b(DELETE|TRUNCATE|UPDATE|INSERT|DROP|ALTER)\b/i)
    expect(statements).not.toMatch(/CONCURRENTLY/i)
    expect(statements.match(/CREATE UNIQUE INDEX/gi)).toHaveLength(1)
    expect(statements).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS customers_email_lower_key ON public\.customers \(lower\(email\)\);/)
    const comment = /COMMENT ON INDEX public\.customers_email_lower_key IS '([^']*)';/.exec(statements)?.[1] ?? ''
    expect(comment).toContain('L10')
    expect(comment).toContain('FB21')
    // The index's name is the one the Worker's rule answers as a duplicate, and the one the replay lifts.
    expect(CUSTOMER_EMAIL_UNIQUE_RULES).toContain(INDEX)
    expect(EMAIL_LOWER_INDEX).toBe(INDEX)
  })

  it('with the index taken out of the saved schema, 027 adds that one index and nothing else; applied twice it changes nothing; its Down takes it out again', async () => {
    const saved = await catalog()
    await pg.admin.unsafe(DOWN)
    const before = await catalog()
    expect(index(before)).toBeUndefined()
    expect(before).toEqual(without(saved))

    await pg.admin.unsafe(migration())
    const applied = await catalog()
    expect(index(applied)).toEqual({ name: INDEX, definition: 'CREATE UNIQUE INDEX customers_email_lower_key ON public.customers USING btree (lower(email))' })
    expect(without(applied)).toEqual(before)
    // Once the lead has applied 027 and refreshed the snapshot, the saved schema has the index and this is exact.
    if (index(saved)) expect(applied).toEqual(saved)
    // The old key is still there, beside it.
    expect((await pg.admin.unsafe("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = 'customers_email_key'"))[0]?.['definition']).toBe('UNIQUE (email)')
    expect((await pg.admin.unsafe(`SELECT obj_description('public.${INDEX}'::regclass) AS comment`))[0]?.['comment']).toContain('L10')

    await pg.admin.unsafe(migration())
    expect(await catalog()).toEqual(applied)

    await pg.admin.unsafe(DOWN)
    expect(await catalog()).toEqual(before)
    await pg.admin.unsafe(migration())
    expect(await catalog()).toEqual(applied)
  })

  it('the index holds: another address is allowed; the same address in another case is refused, on an insert and on an update; the same case is still refused by the old key', async () => {
    await pg.admin.unsafe(add('case@example.com'))
    expect(await refused(add('other@example.com'))).toBe('accepted')
    expect(await refused(add('CASE@example.com'))).toMatch(new RegExp(INDEX))
    expect(await refused(add('Case@Example.COM'))).toMatch(new RegExp(INDEX))
    expect(await refused(add('case@example.com'))).toMatch(/customers_email(_lower)?_key/)
    await pg.admin.unsafe(add('second@example.com'))
    expect(await refused("UPDATE customers SET email = 'CASE@EXAMPLE.COM' WHERE email = 'second@example.com'")).toMatch(new RegExp(INDEX))
    expect(await refused("UPDATE customers SET email = 'SECOND@example.com' WHERE email = 'second@example.com'")).toBe('accepted')
  })

  it("the old function's own statement, for an address on file in another case, is now refused by the database where it used to add a second account; its words for that are the old duplicate words", async () => {
    // createCustomer.ts lower-cased, then inserted; anything with "duplicate key" in it became the duplicate words.
    await pg.admin.unsafe(add('WRITTEN.BY.ANOTHER@example.com'))
    const old = "INSERT INTO customers (first_name, last_name, email, phone, date_of_birth) VALUES ('Dee', 'Dale', 'written.by.another@example.com', NULL, '1992-02-29')"
    const answer = await refused(old)
    expect(answer).toMatch(new RegExp(INDEX))
    expect(answer).toContain('duplicate key')
    expect(Number((await pg.admin.unsafe("SELECT count(*)::int AS n FROM customers WHERE lower(email) = 'written.by.another@example.com'"))[0]?.['n'])).toBe(1)
  })

  it("the Worker's create still refuses first, in its own words, and still makes a customer whose address is new", async () => {
    const db = pg.connect()
    const staff = await insert(db, 'staff', { role: 'staff', first_name: 'Jo', last_name: 'Staff', email: 'w39-migration@example.com', can_issue_refunds: false })
    const by = () => ({ channel: 'staff' as const, staffId: staff, requestId: crypto.randomUUID() })
    const dee = { firstName: 'Dee', lastName: 'Dale', dateOfBirth: '1992-02-29' }
    const duplicate = await createCustomer(db, { ...dee, email: 'Case@Example.com' }, by()).catch((err: unknown) => err)
    expect(duplicate).toBeInstanceOf(ApiError)
    expect((duplicate as ApiError).message).toBe('A customer with this email address already exists')
    expect(await createCustomer(db, { ...dee, email: 'New.One@Example.com' }, by())).toMatchObject({ email: 'new.one@example.com' })
  })

  it('on a database that already has one address in two cases the migration fails and changes nothing, and its pre-check finds the pair (so the lead checks for 0 rows first)', async () => {
    await pg.admin.unsafe(DOWN)
    await pg.admin.unsafe(add('PAIR@example.com'))
    await pg.admin.unsafe(add('pair@example.com'))
    const before = await catalog()
    expect((await pg.admin.unsafe(PRE_CHECK)).map((row) => [row['email'], Number(row['count'])])).toEqual([['pair@example.com', 2]])
    await expect(pg.admin.unsafe(migration())).rejects.toThrow(new RegExp(INDEX))
    expect(await catalog()).toEqual(before)
    expect(index(before)).toBeUndefined()
    // Put right (by a person, on live: two accounts merged), it goes on, and the pre-check is clear.
    await pg.admin.unsafe("DELETE FROM customers WHERE email = 'PAIR@example.com'")
    expect(await pg.admin.unsafe(PRE_CHECK)).toHaveLength(0)
    await pg.admin.unsafe(migration())
    expect(index(await catalog())?.definition).toBe('CREATE UNIQUE INDEX customers_email_lower_key ON public.customers USING btree (lower(email))')
  })
})
