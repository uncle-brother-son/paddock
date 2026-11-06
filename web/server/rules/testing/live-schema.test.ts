import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import catalog from './live-catalog.json'
import { startTestDatabase, type TestDatabase } from './database'

// The generated schema really holds what the live catalog holds. These read the loaded database
// back, so a section the generator dropped would show here, not in some later test's odd failure.
describe('live-schema.sql', () => {
  let t: TestDatabase

  const count = async (sql: string) => Number((await t.pg.query<{ n: number }>(sql)).rows[0]?.n)

  beforeAll(async () => {
    t = await startTestDatabase({ schema: 'live' })
  })
  afterAll(() => t.stop())

  it('is up to date with the catalog snapshot', () => {
    const script = path.resolve(__dirname, '../../../scripts/generate-test-schema.mjs')
    expect(() => execFileSync(process.execPath, [script, '--check'], { stdio: 'pipe' })).not.toThrow()
  })

  it('has every table, view, function and trigger', async () => {
    expect(
      await count(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                   WHERE n.nspname = 'public' AND c.relkind = 'r'`)
    ).toBe(catalog.tables.length)
    expect(
      await count(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                   WHERE n.nspname = 'public' AND c.relkind = 'v'`)
    ).toBe(catalog.views.length)
    expect(
      await count(`SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                   WHERE n.nspname = 'public'
                     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')`)
    ).toBe(catalog.functions.length)
    expect(await count(`SELECT count(*)::int AS n FROM pg_trigger WHERE NOT tgisinternal`)).toBe(catalog.triggers.length)
  })

  it.each([
    ['foreign keys', 'f'],
    ['exclusion constraints', 'x'],
    ['check constraints', 'c'],
    ['unique constraints', 'u'],
    ['primary keys', 'p'],
  ])('has every one of the %s', async (_, type) => {
    const loaded = await count(`SELECT count(*)::int AS n FROM pg_constraint k JOIN pg_namespace n ON n.oid = k.connamespace
                                WHERE n.nspname = 'public' AND k.contype = '${type}'`)
    expect(loaded).toBe(catalog.constraints.filter((k) => k.type === type).length)
    expect(loaded).toBeGreaterThan(0)
  })

  it('blocks on a foreign key, as live does', async () => {
    await expect(
      t.pg.query(`INSERT INTO bookings (session_id, customer_id, price_paid) VALUES (gen_random_uuid(), gen_random_uuid(), 0)`)
    ).rejects.toThrow('foreign key')
  })

  it('runs the live triggers: a new session takes its band from the timetable', async () => {
    const id = async (sql: string) => (await t.pg.query<{ id: string }>(sql)).rows[0]?.id as string
    const band = await id(`INSERT INTO session_bands (code, name, price) VALUES ('peak', 'Peak', 25) RETURNING id`)
    await t.pg.query(`INSERT INTO band_rules (band_id, day_of_week, from_time, to_time) VALUES ($1, 4, '09:00', '12:00')`, [band])
    const service = await id(`INSERT INTO service_types (name) VALUES ('Sauna') RETURNING id`)
    const session = await t.pg.query<{ band_id: string }>(
      `INSERT INTO sessions (service_type_id, start_time, end_time, type)
       VALUES ($1, '2026-11-12 10:00:00+00', '2026-11-12 11:00:00+00', 'public') RETURNING band_id`,
      [service]
    )
    expect(session.rows[0]?.band_id).toBe(band)
  })
})
