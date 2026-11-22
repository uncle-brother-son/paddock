import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ApiError } from '@/server/http/errors'
import { adjustMembershipCredits } from '@/server/rules/memberships/credits'
import { fixtures, insert } from './database'
import { startRealPostgres, type RealPostgres } from './real-postgres'

// Brief W37 item 4 (F-plan bug FB10; lead call L10): migration 025 is written but NOT applied to live, and the saved
// schema (live-catalog.json, live-schema.sql) is left as live is today: the lead applies 025 after W37's review and
// refreshes the snapshot from live then. This file holds the migration on real Postgres either way: with the check
// taken out of whatever the saved schema has, 025 adds exactly that one check and nothing else, twice over changes
// nothing, and its "Down" takes it out again. Once the snapshot has the check, the first test also holds that 025
// makes the saved schema exactly.

const MIGRATION = path.resolve(__dirname, '../../../../supabase/migrations/025_customer_memberships_addon_credits_not_below_zero.sql')
const CATALOG_QUERY = readFileSync(path.join(__dirname, 'live-catalog-query.sql'), 'utf8')
const CHECK = 'customer_memberships_addon_credits_remaining_check'
/** 025's "Down", as the migration file gives it. */
const DOWN = `ALTER TABLE public.customer_memberships DROP CONSTRAINT IF EXISTS ${CHECK};`

interface Catalog {
  constraints: Array<{ table: string; name: string; definition: string }>
  [key: string]: unknown
}

describe('migration 025 (brief W37 item 4): add-on credits never below zero', () => {
  let pg: RealPostgres
  const catalog = async (): Promise<Catalog> => {
    const raw = (await pg.admin.unsafe(CATALOG_QUERY))[0]?.['catalog'] as Catalog | string
    return typeof raw === 'string' ? (JSON.parse(raw) as Catalog) : raw
  }
  const check = (from: Catalog) => from.constraints.find((one) => one.name === CHECK)
  const without = (from: Catalog): Catalog => ({ ...from, constraints: from.constraints.filter((one) => one.name !== CHECK) })
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
  let membership: string

  beforeAll(async () => {
    pg = await startRealPostgres()
  }, 120_000)
  afterAll(() => pg.stop())

  it('the file exists, says it is not applied by W37, names its Down, and writes or rewrites no row', () => {
    const sql = migration()
    expect(sql).toContain('NOT APPLIED by W37')
    expect(sql).toContain(`--   ${DOWN}`)
    const statements = sql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
    expect(statements).not.toMatch(/\b(DELETE|TRUNCATE|UPDATE|INSERT|DROP)\b/i)
    expect(statements).not.toMatch(/CONCURRENTLY/i)
    expect(statements).not.toMatch(/NOT VALID/i)
    expect(statements.match(/ADD CONSTRAINT/gi)).toHaveLength(1)
  })

  it('with the check taken out of the saved schema, 025 adds that one check and nothing else; applied twice it changes nothing; its Down takes it out again', async () => {
    const saved = await catalog()
    await pg.admin.unsafe(DOWN)
    const before = await catalog()
    expect(check(before)).toBeUndefined()
    expect(before).toEqual(without(saved))

    await pg.admin.unsafe(migration())
    const applied = await catalog()
    expect(check(applied)).toMatchObject({ table: 'customer_memberships', name: CHECK, definition: 'CHECK ((addon_credits_remaining >= 0))' })
    expect(without(applied)).toEqual(before)
    // Once the lead has applied 025 and refreshed the snapshot, the saved schema has the check and this is exact.
    if (check(saved)) expect(applied).toEqual(saved)

    await pg.admin.unsafe(migration())
    expect(await catalog()).toEqual(applied)

    await pg.admin.unsafe(DOWN)
    expect(await catalog()).toEqual(before)
    await pg.admin.unsafe(migration())
    expect(await catalog()).toEqual(applied)
  })

  it('the check holds: 0 is allowed, below zero is refused, on an insert and on an update, and a balance can still go up and down above it', async () => {
    const db = pg.connect()
    const customer = await fixtures.customer(db)
    const plan = await fixtures.plan(db)
    membership = await fixtures.membership(db, { customer_id: customer, plan_id: plan, billing_frequency: 'monthly', addon_credits_remaining: 2 })
    const set = (value: string) => `UPDATE customer_memberships SET addon_credits_remaining = ${value} WHERE id = '${membership}'`
    expect(await refused(set('0'))).toBe('accepted')
    expect(await refused(set('addon_credits_remaining + 5'))).toBe('accepted')
    expect(await refused(set('addon_credits_remaining - 2'))).toBe('accepted')
    expect(await refused(set('addon_credits_remaining - 3'))).toMatch(new RegExp(CHECK))
    expect(await refused(set('-1'))).toMatch(new RegExp(CHECK))
    expect(await refused(`INSERT INTO customer_memberships (customer_id, plan_id, start_date, addon_credits_remaining) VALUES ('${customer}', '${plan}', '2026-01-01', -1)`)).toMatch(new RegExp(CHECK))
    expect(await refused(`INSERT INTO customer_memberships (customer_id, plan_id, start_date) VALUES ('${customer}', '${plan}', '2026-01-01')`)).toBe('accepted')
  })

  it("the old function's own statement (add-on credits plus the amount, no floor) is now refused by the database where it used to leave −3", async () => {
    // adjustMembershipCredits.ts, the add-on branch: its first statement, so nothing is half-written.
    const old = `UPDATE customer_memberships SET addon_credits_remaining = addon_credits_remaining + (-5), updated_at = now() WHERE id = '${membership}' RETURNING addon_credits_remaining`
    expect(await refused(old)).toMatch(new RegExp(CHECK))
    expect((await pg.admin.unsafe(`SELECT addon_credits_remaining AS n FROM customer_memberships WHERE id = '${membership}'`))[0]?.['n']).toBe(2)
  })

  it("the Worker's adjustment still refuses first, in its own words, and still takes a balance to exactly zero", async () => {
    const db = pg.connect()
    const staff = await insert(db, 'staff', { role: 'staff', first_name: 'Jo', last_name: 'Staff', email: 'w37-migration@example.com', can_issue_refunds: true })
    const by = () => ({ actor: { type: 'staff' as const, id: staff, canIssueRefunds: true }, requestId: crypto.randomUUID() })
    const below = await adjustMembershipCredits(db, membership, { creditType: 'addon', amount: -5, reason: 'Migration test' }, by()).catch((err: unknown) => err)
    expect(below).toBeInstanceOf(ApiError)
    expect((below as ApiError).message).toBe('Adjustment rejected: the membership would be left with minus 3 add-on credit(s), below zero.')
    expect(await adjustMembershipCredits(db, membership, { creditType: 'addon', amount: -2, reason: 'Migration test' }, by())).toEqual({ addon_credits_remaining: 0 })
  })

  it('on a database that already has a balance below zero the migration fails and changes nothing (so the lead checks for 0 first)', async () => {
    await pg.admin.unsafe(DOWN)
    await pg.admin.unsafe(`UPDATE customer_memberships SET addon_credits_remaining = -1 WHERE id = '${membership}'`)
    const before = await catalog()
    await expect(pg.admin.unsafe(migration())).rejects.toThrow(new RegExp(CHECK))
    expect(await catalog()).toEqual(before)
    expect(check(before)).toBeUndefined()
    // Put right, it goes on.
    await pg.admin.unsafe(`UPDATE customer_memberships SET addon_credits_remaining = 0 WHERE id = '${membership}'`)
    await pg.admin.unsafe(migration())
    expect(check(await catalog())?.definition).toBe('CHECK ((addon_credits_remaining >= 0))')
  })
})
