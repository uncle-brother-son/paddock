import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '@/server/db'
import { startRealPostgres, type RealPostgres } from './real-postgres'

// Brief W85a item 1 (backend log 10): migration 036 lets a customer's date of birth be empty. It is written but NOT
// applied to live; the lead applies it before the W85a Worker is pushed. The saved schema (live-catalog.json,
// live-schema.sql) carries it already, as W72a did for 035, so every test runs against the schema live will have. This
// file holds the two to each other on real Postgres (the saved schema with 036's Down run differs only in that one
// column; 036 applied again is the saved schema, to the last character of the catalogue) and holds what 036 is: one
// column's NOT NULL dropped, no row written, the header's own checks. What the Worker does with an empty date of birth
// is held in server/rules/customer/sign-in.test.ts and server/rules/customers/customers.test.ts.

const MIGRATION = path.resolve(__dirname, '../../../../supabase/migrations/036_customer_date_of_birth_optional.sql')
const CATALOG_QUERY = readFileSync(path.join(__dirname, 'live-catalog-query.sql'), 'utf8')

const migration = (): string => readFileSync(MIGRATION, 'utf8')
/** The file's own statements: every line that isn't a comment. */
const statements = (): string =>
  migration()
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .trim()
/** The Down in the footer, its comment marks taken off. */
const down = (): string[] => {
  const lines = migration().split('\n')
  const from = lines.findIndex((line) => line.startsWith('-- Down ('))
  if (from < 0) throw new Error("Migration 036's Down wasn't found.")
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
  if (from < 0 || !sql) throw new Error(`No check under "${mark}" in migration 036.`)
  return sql.replace(/^-- {9}/, '')
}

interface Column {
  name: string
  type: string
  notNull: boolean
  default: string | null
}
interface Catalog {
  tables: Array<{ name: string; columns: Column[] }>
  [key: string]: unknown
}

describe("migration 036 (brief W85a item 1): a customer's date of birth may be empty", () => {
  let pg: RealPostgres
  let db: Db
  const catalog = async (): Promise<Catalog> => {
    const raw = (await pg.admin.unsafe(CATALOG_QUERY))[0]?.['catalog'] as Catalog | string
    return typeof raw === 'string' ? (JSON.parse(raw) as Catalog) : raw
  }
  const dateOfBirth = (from: Catalog): Column | undefined => from.tables.find((one) => one.name === 'customers')?.columns.find((one) => one.name === 'date_of_birth')
  const nullable = async (): Promise<boolean> => dateOfBirth(await catalog())?.notNull === false
  /** The file as the lead applies it: one transaction. */
  const apply = async (): Promise<void> => void (await pg.admin.begin((tx) => tx.unsafe(migration())))
  const runDown = async (): Promise<void> => {
    const [, setNotNull] = down()
    await pg.admin.unsafe(setNotNull as string)
  }

  beforeAll(async () => {
    pg = await startRealPostgres()
    db = pg.connect()
  }, 120_000)
  afterAll(() => pg.stop())

  /** The saved schema's own state before each test: 036 in, no customer. */
  beforeEach(async () => {
    await pg.admin.unsafe('DELETE FROM public.customers')
    if (!(await nullable())) await apply()
  })

  it('the file says it is not applied by W85a and must be applied as one transaction, and is: a lock time limit and the one column loses NOT NULL; nothing else, and its Down puts NOT NULL back after counting the empty ones', () => {
    const sql = migration()
    expect(sql).toContain('-- NOT APPLIED by W85a. The lead applies it, with Wayne\'s yes, BEFORE the W85a Worker is pushed')
    expect(sql).toContain('-- APPLY IT AS ONE TRANSACTION')
    expect(statements().split('\n').filter((line) => line.trim() !== '')).toEqual([
      "SET LOCAL lock_timeout = '5s';",
      'ALTER TABLE public.customers ALTER COLUMN date_of_birth DROP NOT NULL;',
    ])
    expect(down()).toEqual(['SELECT count(*) FROM public.customers WHERE date_of_birth IS NULL;', 'ALTER TABLE public.customers ALTER COLUMN date_of_birth SET NOT NULL;'])
  })

  it('the saved schema carries 036; with its Down run the catalogue differs only in that column; applied again it is the saved schema, to the last character', async () => {
    const saved = await catalog()
    expect(dateOfBirth(saved)).toMatchObject({ type: 'date', notNull: false, default: null })
    await runDown()
    const before = await catalog()
    expect(dateOfBirth(before)).toMatchObject({ type: 'date', notNull: true, default: null })
    const column = dateOfBirth(before)
    if (column) column.notNull = false
    expect(before).toEqual(saved)
    await apply()
    expect(await catalog()).toEqual(saved)
  })

  it('applied over customer rows it writes none; afterwards a customer can be written with no date of birth, and the Down is then refused until a decision is made', async () => {
    await runDown()
    await db.query("INSERT INTO customers (first_name, last_name, email, date_of_birth) VALUES ('Sam', 'Before', 'before@example.com', '1990-01-01')")
    await expect(db.query("INSERT INTO customers (first_name, last_name, email) VALUES ('No', 'Date', 'nodate@example.com')")).rejects.toThrow(/null value in column "date_of_birth"/)
    const rows = () => pg.admin.unsafe('SELECT id, date_of_birth::text AS date_of_birth, updated_at, xmin::text AS written_by FROM public.customers ORDER BY email')
    const before = await rows()
    await apply()
    expect(await rows()).toEqual(before)
    await db.query("INSERT INTO customers (first_name, last_name, email) VALUES ('No', 'Date', 'nodate@example.com')")
    expect(await db.query('SELECT email, date_of_birth FROM customers ORDER BY email')).toEqual([
      { email: 'before@example.com', date_of_birth: expect.anything() },
      { email: 'nodate@example.com', date_of_birth: null },
    ])
    const [count] = down()
    expect((await pg.admin.unsafe(count as string))[0]?.['count']).toBe('1')
    await expect(runDown()).rejects.toThrow(/contains null values/)
  })

  it("the header's own checks answer as it says once applied: YES, and 0 with no customer left without one", async () => {
    await db.query("INSERT INTO customers (first_name, last_name, email, date_of_birth) VALUES ('Sam', 'Before', 'before@example.com', '1990-01-01')")
    expect((await pg.admin.unsafe(checkUnder('the column may be empty')))[0]?.['is_nullable']).toBe('YES')
    expect((await pg.admin.unsafe(checkUnder('no row changed')))[0]?.['without_one']).toBe('0')
  })
})
