import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '@/server/db'
import { insert } from './database'
import { CATEGORIES_TABLE, down035, migration035, sqlUnder035, statements035 } from './migration-035'
import { startRealPostgres, type RealPostgres } from './real-postgres'

// Brief W72a item 1 (Wayne's WQ7; the lead's design, 24 Nov 2026): migration 035 is written but NOT applied to live;
// the lead applies it before the W72a Worker is pushed. The saved schema (live-catalog.json, live-schema.sql) carries
// it already, each object as Postgres 17.6 prints it, so that every test runs against the schema live will have. This
// file holds the two to each other on real Postgres (the saved schema with 035's Down run, then 035 applied, is the
// saved schema again, to the last character of the catalogue) and holds what 035 is: one new table and nothing else
// changed; no product row written; the Worker's role's rights; the header's own SQL. Once the lead has applied 035
// and refreshed the snapshot from live, this still passes, and stays as the migration's own test. What the Worker
// does with the table is held in app/api/sanity/webhook/categories.test.ts.

const CATALOG_QUERY = readFileSync(path.join(__dirname, 'live-catalog-query.sql'), 'utf8')

interface Catalog {
  tables: Array<{ name: string; columns: Array<{ name: string; type: string; notNull: boolean; default: string | null }> }>
  constraints: Array<{ table: string; name: string; definition: string }>
  indexes: Array<{ name: string; definition: string }>
  [key: string]: unknown
}

describe('migration 035 (brief W72a item 1): product categories have a table of their own, and products.category stays text', () => {
  let pg: RealPostgres
  let db: Db
  const catalog = async (): Promise<Catalog> => {
    const raw = (await pg.admin.unsafe(CATALOG_QUERY))[0]?.['catalog'] as Catalog | string
    return typeof raw === 'string' ? (JSON.parse(raw) as Catalog) : raw
  }
  const table = (from: Catalog, name = CATEGORIES_TABLE) => from.tables.find((one) => one.name === name)
  /** A catalogue with 035's table left out: what must be the same before and after it. */
  const without = (from: Catalog): Catalog => ({
    ...from,
    tables: from.tables.filter((one) => one.name !== CATEGORIES_TABLE),
    constraints: from.constraints.filter((one) => one.table !== CATEGORIES_TABLE),
    indexes: from.indexes.filter((index) => !index.name.startsWith(CATEGORIES_TABLE)),
  })
  /** The file as the lead applies it: one transaction. */
  const apply = async (): Promise<void> => void (await pg.admin.begin((tx) => tx.unsafe(migration035())))
  const answers = async (checks: string[]) => Promise.all(checks.map(async (sql) => Object.values((await pg.admin.unsafe(sql))[0] ?? {})[0]))

  beforeAll(async () => {
    pg = await startRealPostgres()
    db = pg.connect()
    // How the saved schema was given 035 (as W51 did for 032): with W72A_CATALOG_OUT set, the file is applied to this
    // throwaway Postgres 17.6 if the saved schema doesn't have it, and the catalogue is written to that path for
    // `npm run schema:test -- --from <path>`. Never run against live.
    if (process.env.W72A_CATALOG_OUT) {
      if (!table(await catalog())) await apply()
      writeFileSync(process.env.W72A_CATALOG_OUT, JSON.stringify([{ catalog: await catalog() }]))
    }
  }, 120_000)
  afterAll(() => pg.stop())

  /** The saved schema's own state before each test: 035 in, no category, no product. */
  beforeEach(async () => {
    if (!table(await catalog())) await apply()
    await pg.admin.unsafe('DELETE FROM public.product_categories; DELETE FROM public.products;')
  })

  it('the file says it is not applied by W72a and must be applied as one transaction, and is: a lock time limit, the table, row level security, its comment, the Worker\'s rights and a comment on products.category; it writes no row, changes no column and drops nothing', () => {
    const sql = migration035()
    expect(sql).toContain('-- NOT APPLIED by W72a. The lead applies it BEFORE the W72a Worker is pushed')
    expect(sql).toContain('-- APPLY IT AS ONE TRANSACTION')
    const body = statements035()
    expect(body.split('\n').filter((line) => /^[A-Z]/.test(line)).map((line) => line.split(' ').slice(0, 4).join(' '))).toEqual([
      'SET LOCAL lock_timeout =',
      'CREATE TABLE public.product_categories (',
      'ALTER TABLE public.product_categories ENABLE',
      'COMMENT ON TABLE public.product_categories',
      'GRANT SELECT, INSERT, UPDATE,',
      'COMMENT ON COLUMN public.products.category',
    ])
    expect(body).toContain(
      ['CREATE TABLE public.product_categories (', '  sanity_category_id text PRIMARY KEY,', '  title text NOT NULL,', '  sort_order integer,', '  updated_at timestamptz NOT NULL DEFAULT now()', ');'].join('\n')
    )
    expect(body.trim().split('\n')[0]).toBe("SET LOCAL lock_timeout = '5s';")
    expect(body).toContain('GRANT SELECT, INSERT, UPDATE, DELETE ON public.product_categories TO paddock_worker;')
    expect(body).not.toMatch(/\b(UPDATE public|DELETE FROM|TRUNCATE|INSERT INTO|DROP|CASCADE|ALTER COLUMN|REFERENCES)\b/i)
    expect(body.match(/\bALTER TABLE\b/g)).toHaveLength(1)
    // The Down, as written: the table, then the comment.
    expect(down035()).toBe('DROP TABLE public.product_categories;\nCOMMENT ON COLUMN public.products.category IS NULL;')
  })

  it('the saved schema carries 035: the table as written, products.category still text; with its Down run the catalogue has no such table and nothing else differs; applied again it is the saved schema, to the last character', async () => {
    const saved = await catalog()
    expect(table(saved)?.columns).toEqual([
      { name: 'sanity_category_id', type: 'text', notNull: true, default: null, generated: '', identity: '' },
      { name: 'title', type: 'text', notNull: true, default: null, generated: '', identity: '' },
      { name: 'sort_order', type: 'integer', notNull: false, default: null, generated: '', identity: '' },
      { name: 'updated_at', type: 'timestamp with time zone', notNull: true, default: 'now()', generated: '', identity: '' },
    ])
    expect(saved.constraints.filter((one) => one.table === CATEGORIES_TABLE).map((one) => [one.name, one.definition])).toEqual([['product_categories_pkey', 'PRIMARY KEY (sanity_category_id)']])
    expect(table(saved, 'products')?.columns.find((column) => column.name === 'category')).toMatchObject({ type: 'text', notNull: false, default: null })
    // No key from a product to its category: Sanity's deliveries come in any order.
    expect(saved.constraints.filter((one) => one.table === 'products' && /categor/.test(one.definition))).toEqual([])

    await pg.admin.unsafe(down035())
    const before = await catalog()
    expect(table(before)).toBeUndefined()
    expect(without(before)).toEqual(without(saved))
    expect(before.tables.length).toBe(saved.tables.length - 1)

    await apply()
    expect(await catalog()).toEqual(saved)
  })

  it('applied over product rows it writes none: each keeps its category, word for word, and its updated_at', async () => {
    await pg.admin.unsafe(down035())
    const tee = await insert(db, 'products', { name: 'Paddock T-Shirt', category: 'apparel', sanity_product_id: 'w72a-035-tee' })
    const bare = await insert(db, 'products', { name: 'No category', sanity_product_id: 'w72a-035-bare' })
    const rows = () => pg.admin.unsafe('SELECT id, category, updated_at, xmin::text AS written_by FROM public.products ORDER BY name')
    const before = await rows()
    await apply()
    expect(await rows()).toEqual(before)
    expect(before.map((row) => [row['id'], row['category']])).toEqual([
      [bare, null],
      [tee, 'apparel'],
    ])
    expect(await pg.admin.unsafe('SELECT count(*)::int AS n FROM public.product_categories')).toEqual([{ n: 0 }])
  })

  it("the table: row level security is on; the Worker's role can read, insert, update and delete a category and nothing more; one row a Sanity id; a category has a title; its order may be empty", async () => {
    await pg.admin.unsafe(down035())
    await apply()
    const can = async (privilege: string) => (await pg.admin.unsafe(`SELECT has_table_privilege('paddock_worker', 'public.product_categories', '${privilege}') AS can`))[0]?.['can']
    expect([await can('SELECT'), await can('INSERT'), await can('UPDATE'), await can('DELETE'), await can('TRUNCATE')]).toEqual([true, true, true, true, false])
    expect((await pg.admin.unsafe("SELECT relrowsecurity FROM pg_class WHERE oid = 'public.product_categories'::regclass"))[0]?.['relrowsecurity']).toBe(true)
    await db.query("INSERT INTO product_categories (sanity_category_id, title, sort_order) VALUES ('cat-apparel', 'Apparel', 1), ('cat-books', 'Books', NULL)")
    expect(await db.query('SELECT sanity_category_id, title, sort_order, updated_at IS NOT NULL AS stamped FROM product_categories ORDER BY sanity_category_id')).toEqual([
      { sanity_category_id: 'cat-apparel', title: 'Apparel', sort_order: 1, stamped: true },
      { sanity_category_id: 'cat-books', title: 'Books', sort_order: null, stamped: true },
    ])
    await expect(db.query("INSERT INTO product_categories (sanity_category_id, title) VALUES ('cat-apparel', 'Again')")).rejects.toThrow(/product_categories_pkey/)
    await expect(db.query("INSERT INTO product_categories (sanity_category_id) VALUES ('cat-untitled')")).rejects.toThrow(/null value in column "title"/)
    await db.query("UPDATE product_categories SET title = 'Clothing' WHERE sanity_category_id = 'cat-apparel'")
    await db.query("DELETE FROM product_categories WHERE sanity_category_id = 'cat-books'")
    expect(await db.query('SELECT title FROM product_categories')).toEqual([{ title: 'Clothing' }])
    // A product may name a category that has no row (it arrived first, or holds a word from before W72a).
    await insert(db, 'products', { name: 'Early', category: 'cat-not-here-yet', sanity_product_id: 'w72a-035-early' })
  })

  it("the header's own SQL runs: the pre-checks before it is applied; the checks after give an empty table with row level security and the Worker's four rights, the product rows as they were, and the standing check lists a product whose category is no category's id; the question before any Down", async () => {
    await pg.admin.unsafe(down035())
    await insert(db, 'products', { name: 'Paddock T-Shirt', category: 'apparel', sanity_product_id: 'w72a-035-header' })
    const [p1] = sqlUnder035('--   P1. The table')
    const [p2] = sqlUnder035('--   P2. What the product rows hold now')
    expect(sqlUnder035('--   P1. The table')).toHaveLength(1)
    expect(sqlUnder035('--   P2. What the product rows hold now')).toHaveLength(1)
    expect(await answers([p1 as string])).toEqual([null])
    const held = async (sql: string) => (await pg.admin.unsafe(sql)).map((row) => [row['category'], Number(row['count'])])
    expect(await held(p2 as string)).toEqual([['apparel', 1]])

    await apply()
    expect(await answers([p1 as string])).toEqual(['product_categories'])
    const tableChecks = sqlUnder035('--   1. The table is there')
    expect(tableChecks).toHaveLength(2)
    expect((await answers(tableChecks)).map(String)).toEqual(['0', 'true'])
    const rights = sqlUnder035("--   2. The Worker's role")
    expect(rights).toHaveLength(4)
    expect(await answers(rights)).toEqual([true, true, true, true])
    const [unchanged] = sqlUnder035('--   3. No product row changed')
    expect(await held(unchanged as string)).toEqual([['apparel', 1]])

    // Check 4, the standing one: the product still holding its old word is listed, and goes once it holds a category's id.
    const [standing] = sqlUnder035('--   4. Standing')
    expect(sqlUnder035('--   4. Standing')).toHaveLength(1)
    expect((await pg.admin.unsafe(standing as string)).map((row) => [row['name'], row['category']])).toEqual([['Paddock T-Shirt', 'apparel']])
    await db.query("INSERT INTO product_categories (sanity_category_id, title, sort_order) VALUES ('cat-apparel', 'Apparel', 1)")
    await pg.admin.unsafe("UPDATE public.products SET category = 'cat-apparel'")
    expect(await pg.admin.unsafe(standing as string)).toEqual([])
    await insert(db, 'products', { name: 'No category', sanity_product_id: 'w72a-035-none' })
    expect(await pg.admin.unsafe(standing as string)).toEqual([])

    const beforeDown = sqlUnder035('-- BEFORE ANY DOWN')
    expect(beforeDown).toHaveLength(1)
    expect(await answers(beforeDown)).toEqual([true])
    await db.query('DELETE FROM product_categories')
    expect(await answers(beforeDown)).toEqual([false])
  })
})
