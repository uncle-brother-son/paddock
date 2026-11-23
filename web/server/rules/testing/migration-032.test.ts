import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '@/server/db'
import { SESSION_DAY_LOCK_SQL } from '@/server/rules/admin/locks'
import { insert } from './database'
import {
  CLOSED_DATES_TABLE,
  down032,
  functionParts032,
  functionStatement032,
  FUNCTIONS_BEFORE_032_SQL,
  GENERATOR,
  GENERATOR_BEFORE_032,
  GENERATOR_CHANGES_032,
  GENERATOR_DAYS_032,
  GENERATOR_GUARD_032,
  GENERATOR_MOVE_032,
  generatorAfter032,
  generatorBackFrom032,
  generatorFromFile032Sql,
  MADE_UP_TO_TABLE,
  migration032,
  REBAND,
  REBAND_BEFORE_032,
  REBAND_FIRST_LINE_032,
  REBAND_FIRST_LINE_BEFORE_032,
  rebandAfter032,
} from './migration-032'
import { waitingOn } from './race'
import { startRealPostgres, type RealPostgres } from './real-postgres'

// Brief W51 item 1 (G-plan 4.5; bugs GB3 and W51-1; W50 review L3) and brief W51a item 2 (closed dates: W51 review
// L3; Wayne, 20 Nov 2026) and item 6 (the lead's checks): migration 032 is written but NOT applied to live; the lead
// applies it after W51's review, before the Worker push. The saved schema (live-catalog.json, live-schema.sql)
// carries it already, each object as Postgres 17.6 prints it, so that every test runs against the schema live will
// have. This file holds the two to each other on real Postgres (the saved schema with 032 taken back out, then 032
// applied, is the saved schema again, to the last character of the catalog) and holds what 032 does: its row; the
// nightly job from its own date (a one-off session a year out no longer stops it); the band guard the job now takes;
// the closed dates the job leaves out, and makes on its next run once one is reopened; the date's lock; its Down.
// Once the lead has applied 032 and refreshed the snapshot from live, this still passes, and stays as the
// migration's own test. London's wall clock in re-banding needs a clock a test can set, so it is held in
// server/rules/pricing/reband-london-now.test.ts. Block Day and Unblock Day against the job are the Worker's rules,
// so those races are in server/rules/sessions/admin-postgres.test.ts.

const CATALOG_QUERY = readFileSync(path.join(__dirname, 'live-catalog-query.sql'), 'utf8')
const NAMES: readonly string[] = [GENERATOR, REBAND]
const TABLES: readonly string[] = [MADE_UP_TO_TABLE, CLOSED_DATES_TABLE]

interface Catalog {
  tables: Array<{ name: string; columns: Array<{ name: string; type: string; notNull: boolean; default: string | null }> }>
  constraints: Array<{ table: string; name: string; definition: string }>
  functions: Array<{ name: string; identity: string; definition: string }>
  [key: string]: unknown
}

const statement = functionStatement032
/**
 * A header check's SQL statements: the SQL under the line that starts with `mark`, up to the next line that isn't
 * SQL. In the header a check's own words are indented less than eight spaces and its SQL eight or more.
 */
const sqlUnder = (mark: string): string[] => {
  const lines = migration032().split('\n')
  const from = lines.findIndex((line) => line.startsWith(mark))
  if (from < 0) throw new Error(`No line starts "${mark}" in migration 032.`)
  const block: string[] = []
  for (const line of lines.slice(from + 1)) {
    const sql = /^-- {8,}\S/.test(line)
    if (!sql && block.length > 0) break
    if (sql) block.push(line.replace(/^--/, '').replace(/\s+--\s.*$/, ''))
  }
  return block
    .join('\n')
    .split(';')
    .map((sql) => sql.trim())
    .filter((sql) => sql !== '')
}

describe('migration 032 (brief W51 item 1; brief W51a items 2 and 6): the nightly job keeps its own "sessions made up to" date, takes the band guard and leaves closed dates out; re-banding compares with London\'s wall clock', () => {
  let pg: RealPostgres
  let db: Db
  let other: Db
  let jo = ''
  const catalog = async (): Promise<Catalog> => {
    const raw = (await pg.admin.unsafe(CATALOG_QUERY))[0]?.['catalog'] as Catalog | string
    return typeof raw === 'string' ? (JSON.parse(raw) as Catalog) : raw
  }
  const definition = (from: Catalog, name: string) => from.functions.find((fn) => fn.name === name)?.definition ?? ''
  const table = (from: Catalog, name = MADE_UP_TO_TABLE) => from.tables.find((one) => one.name === name)
  /** A catalogue with everything 032 touches left out: what must be the same before and after it. */
  const without = (from: Catalog): Catalog => ({
    ...from,
    tables: from.tables.filter((one) => !TABLES.includes(one.name)),
    constraints: from.constraints.filter((one) => !TABLES.includes(one.table)),
    functions: from.functions.filter((fn) => !NAMES.includes(fn.name)),
    indexes: (from['indexes'] as Array<{ name: string }>).filter((index) => !TABLES.some((name) => index.name.startsWith(name))),
  })
  const day = async (days: number) => (await pg.admin.unsafe<{ d: string }[]>("SELECT ((now() AT TIME ZONE 'Europe/London')::date + $1::int)::text AS d", [days]))[0]?.d as string
  const madeUpTo = async () => (await pg.admin.unsafe<{ d: string }[]>('SELECT made_up_to::text AS d FROM public.sessions_made_up_to'))[0]?.d ?? null
  /** The closed days the job has left out, as it keeps them on its row. */
  const skipped = async () => (await pg.admin.unsafe<{ d: string[] }[]>("SELECT ARRAY(SELECT to_char(s, 'YYYY-MM-DD') FROM unnest(closed_days_skipped) s ORDER BY s) AS d FROM public.sessions_made_up_to"))[0]?.d ?? null
  /** The nightly job, run as the job runs it (the tables' owner). */
  const runJob = async (): Promise<number> => Number((await pg.admin.unsafe<{ n: number }[]>('SELECT public.generate_upcoming_sessions() AS n'))[0]?.n)
  const sessionDays = async () => (await pg.admin.unsafe<{ d: string }[]>("SELECT (start_time AT TIME ZONE 'UTC')::date::text AS d FROM public.sessions ORDER BY start_time")).map((row) => row.d)
  /** A date closed as Block Day closes it: the Worker's role, the date, a reason and who. */
  const close = async (date: string, reason = 'Closed for Christmas') => db.query('INSERT INTO closed_dates (closed_on, reason, closed_by) VALUES ($1::date, $2, $3::uuid)', [date, reason, jo])
  const reopen = async (date: string) => db.query('DELETE FROM closed_dates WHERE closed_on = $1::date', [date])
  const startAt = async (days: number) => pg.admin.unsafe("INSERT INTO public.sessions_made_up_to (made_up_to) VALUES ((now() AT TIME ZONE 'Europe/London')::date + $1::int)", [days])
  let sauna = ''
  let core = ''
  let peak = ''

  beforeAll(async () => {
    pg = await startRealPostgres()
    db = pg.connect()
    other = pg.connect()
    // How the saved schema was given 032 (brief W51; as W27 did for 023; again in W51a, when closed dates were added
    // to the file): with W51_CATALOG_OUT set, the file is applied to this throwaway Postgres 17.6 if the saved schema
    // doesn't have it as it now is, and the catalogue is written to that path for `npm run schema:test -- --from
    // <path>`. Never run against live.
    if (process.env.W51_CATALOG_OUT) {
      if (!table(await catalog(), CLOSED_DATES_TABLE)) {
        // The saved schema has 032 as W51 wrote it (one table), or not at all: its table goes, and the file is applied whole.
        await pg.admin.unsafe('DROP TABLE IF EXISTS public.sessions_made_up_to')
        await pg.admin.unsafe(migration032())
      }
      await pg.admin.unsafe('DELETE FROM public.sessions_made_up_to')
      writeFileSync(process.env.W51_CATALOG_OUT, JSON.stringify([{ catalog: await catalog() }]))
    }
    // W68: migration 034 changes the job's times line. Once the saved schema carries it, this file still holds 032's own job.
    await pg.admin.unsafe(generatorAfter032())
    jo = await insert(db, 'staff', { role: 'admin', first_name: 'Jo', last_name: 'Staff', email: 'w51a-032@example.com', can_issue_refunds: true, can_manage_pricing: true })
    core = await insert(db, 'session_bands', { code: 'core', name: 'Core', price: '20.00' })
    peak = await insert(db, 'session_bands', { code: 'peak', name: 'Peak', price: '25.00' })
    sauna = await insert(db, 'service_types', { name: 'Sauna', booking_type: 'public', duration: 60, capacity: 10 })
  }, 120_000)
  afterAll(() => pg.stop())

  /** The saved schema's own state before each test: 032 in, no session, no slot, no date, no closed date, Core all day every day. */
  beforeEach(async () => {
    // The sessions go first: a test may have left one beyond the horizon, which 032 refuses to be applied over.
    await pg.admin.unsafe('DELETE FROM public.sessions; DELETE FROM public.service_type_schedule_slots; DELETE FROM public.band_rules;')
    if (!table(await catalog())) await pg.admin.unsafe(migration032())
    // The two functions as the migration FILE has them (held to the expected text in the first test), so every test
    // below runs what the lead will apply.
    await pg.admin.unsafe(`${statement(0).trimEnd()}; ${statement(1).trimEnd()};`)
    await pg.admin.unsafe('DELETE FROM public.sessions_made_up_to; DELETE FROM public.closed_dates;')
    for (let dow = 0; dow <= 6; dow++) await insert(db, 'band_rules', { band_id: core, day_of_week: dow, from_time: '00:00', to_time: '24:00' })
  })

  /** A weekly slot at 10:00 on every day of the week, so each day the job makes is one session. */
  const slotEveryDay = async () => {
    for (let dow = 0; dow <= 6; dow++) await insert(db, 'service_type_schedule_slots', { service_type_id: sauna, day_of_week: dow, start_time: '10:00' })
  }
  const oneOff = async (date: string, time = '10:00') =>
    (await db.query<{ id: string }>("INSERT INTO sessions (service_type_id, start_time, end_time, type, capacity) VALUES ($1, $2::timestamptz, $3::timestamptz + interval '1 hour', 'public', 10) RETURNING id", [sauna, `${date} ${time}:00+00`, `${date} ${time}:00+00`]))[0]?.id as string

  it('the file exists, says it is not applied by W51 or W51a and must be applied as one transaction, and is: the two tables (row level security on; the Worker reads the date, and reads, inserts and deletes a closed date), the row, and the two functions, each word for word as expected', () => {
    const sql = migration032()
    const { starts, ends } = functionParts032()
    expect(sql).toContain('NOT APPLIED by W51 or W51a')
    expect(sql).toContain('APPLY IT AS ONE TRANSACTION (`apply_migration`')
    // W51 review L9: the cron runs at 02:15 UTC, early morning; "tonight's run" named the wrong one.
    expect(sql).not.toMatch(/tonight/i)
    expect(sql).toContain('the 02:15 run')
    expect(starts).toHaveLength(2)
    expect(ends).toHaveLength(2)
    expect(statement(0)).toBe(generatorAfter032())
    expect(statement(1).replace("DEFAULT ((now() AT TIME ZONE 'Europe/London') AT TIME ZONE 'UTC')", "DEFAULT ((now() AT TIME ZONE 'Europe/London'::text) AT TIME ZONE 'UTC'::text)")).toBe(rebandAfter032())
    // Every statement the file runs, by its first words, in order.
    const live = sql.split('\n').filter((line) => line !== '' && !line.startsWith('--'))
    expect(live.filter((line) => /^[A-Z]/.test(line)).map((line) => line.split(' ').slice(0, 3).join(' '))).toEqual([
      'CREATE TABLE public.sessions_made_up_to',
      'ALTER TABLE public.sessions_made_up_to',
      'COMMENT ON TABLE',
      'REVOKE INSERT, UPDATE,',
      'GRANT SELECT ON',
      'DO $$',
      'DECLARE v_furthest date;',
      'BEGIN',
      'END $$;',
      'CREATE TABLE public.closed_dates',
      'ALTER TABLE public.closed_dates',
      'COMMENT ON TABLE',
      'REVOKE UPDATE ON',
      'GRANT SELECT, INSERT,',
      'CREATE OR REPLACE',
      'AS $function$',
      'CREATE OR REPLACE',
      'AS $function$',
      'DECLARE',
      'BEGIN',
      'END;',
    ])
    expect(sql).toContain('ALTER TABLE public.sessions_made_up_to ENABLE ROW LEVEL SECURITY;')
    expect(sql).toContain('REVOKE INSERT, UPDATE, DELETE ON public.sessions_made_up_to FROM paddock_worker;')
    expect(sql).toContain('ALTER TABLE public.closed_dates ENABLE ROW LEVEL SECURITY;')
    expect(sql).toContain('REVOKE UPDATE ON public.closed_dates FROM paddock_worker;')
    expect(sql).toContain('GRANT SELECT, INSERT, DELETE ON public.closed_dates TO paddock_worker;')
    // The cron entry calls the job by this name and signature: both are as they were.
    expect(statement(0).split('\n').slice(0, 5)).toEqual(GENERATOR_BEFORE_032.split('\n').slice(0, 5))
    expect(`${down032()}\n`).toBe(`${FUNCTIONS_BEFORE_032_SQL}\nDROP TABLE public.closed_dates;\nDROP TABLE public.sessions_made_up_to;\n`)
  })

  it('the nightly job is the old one with five changes and nothing else: taken back out, it is the old function line for line; re-banding is as it was but for its default', () => {
    const before = GENERATOR_BEFORE_032.split('\n')
    const after = generatorAfter032().split('\n')
    expect(GENERATOR_CHANGES_032).toHaveLength(5)
    const out = GENERATOR_CHANGES_032.reduce((sum, change) => sum + change.out.length, 0)
    const put = GENERATOR_CHANGES_032.reduce((sum, change) => sum + change.in.length, 0)
    // Five old lines go (the declare line, the furthest-session read's two, the early return, the series) and 27 come in.
    expect([out, put]).toEqual([5, 27])
    expect(after.length - before.length).toBe(put - out)
    expect(generatorBackFrom032(generatorAfter032())).toBe(GENERATOR_BEFORE_032)
    expect(generatorBackFrom032(statement(0))).toBe(GENERATOR_BEFORE_032)
    // The guard is the first thing the job does: before it reads the date, before any lock for a day, before any write.
    const guardAt = after.indexOf(GENERATOR_GUARD_032[0] as string)
    expect(after[guardAt - 1]).toBe('begin')
    expect(after[guardAt + 2]).toBe('  perform 1 from session_bands order by id for share;')
    expect(after.findIndex((line) => line.includes('insert into') || line.includes('sessions_made_up_to') || line.includes('pg_advisory_xact_lock'))).toBeGreaterThan(guardAt + 2)
    // The days' locks come before the closed dates are read, and both before the sessions are made.
    const lockAt = after.findIndex((line) => line.includes('pg_advisory_xact_lock'))
    const closedAt = after.findIndex((line) => line.includes('left join closed_dates'))
    const insertAt = after.indexOf('  insert into sessions (service_type_id, start_time, end_time, type, capacity, status)')
    expect(lockAt).toBeGreaterThan(0)
    expect(closedAt).toBeGreaterThan(lockAt)
    expect(insertAt).toBeGreaterThan(closedAt)
    expect(GENERATOR_DAYS_032.filter((line) => line.includes('closed_dates'))).toHaveLength(1)
    // The date is moved after the sessions are made, and before the answer.
    const moveAt = after.indexOf(GENERATOR_MOVE_032[0] as string)
    expect(after[moveAt - 1]).toBe('  get diagnostics v_inserted = row_count;')
    expect(after[moveAt + GENERATOR_MOVE_032.length]).toBe('  return v_inserted;')
    // The old function read the furthest session; the new one never does.
    expect(generatorAfter032()).not.toContain('max(start_time)')
    expect(REBAND_BEFORE_032.split('\n').slice(1)).toEqual(rebandAfter032().split('\n').slice(1))
    expect(REBAND_FIRST_LINE_032).not.toBe(REBAND_FIRST_LINE_BEFORE_032)
  })

  it('the saved schema carries 032: with its Down run as written the catalogue has the two old functions and neither table, and nothing else differs; applied again it is the saved schema, to the last character', async () => {
    const saved = await catalog()
    expect(table(saved)?.columns).toEqual([
      { name: 'id', type: 'boolean', notNull: true, default: 'true', generated: '', identity: '' },
      { name: 'made_up_to', type: 'date', notNull: true, default: null, generated: '', identity: '' },
      { name: 'updated_at', type: 'timestamp with time zone', notNull: true, default: 'now()', generated: '', identity: '' },
      { name: 'closed_days_skipped', type: 'date[]', notNull: true, default: "'{}'::date[]", generated: '', identity: '' },
    ])
    expect(saved.constraints.filter((one) => one.table === MADE_UP_TO_TABLE).map((one) => [one.name, one.definition])).toEqual([
      ['sessions_made_up_to_id_check', 'CHECK (id)'],
      ['sessions_made_up_to_pkey', 'PRIMARY KEY (id)'],
    ])
    expect(table(saved, CLOSED_DATES_TABLE)?.columns).toEqual([
      { name: 'closed_on', type: 'date', notNull: true, default: null, generated: '', identity: '' },
      { name: 'reason', type: 'text', notNull: false, default: null, generated: '', identity: '' },
      { name: 'closed_by', type: 'uuid', notNull: false, default: null, generated: '', identity: '' },
      { name: 'closed_at', type: 'timestamp with time zone', notNull: true, default: 'now()', generated: '', identity: '' },
    ])
    expect(saved.constraints.filter((one) => one.table === CLOSED_DATES_TABLE).map((one) => [one.name, one.definition])).toEqual([
      ['closed_dates_closed_by_fkey', 'FOREIGN KEY (closed_by) REFERENCES staff(id)'],
      ['closed_dates_pkey', 'PRIMARY KEY (closed_on)'],
    ])
    expect(definition(saved, GENERATOR)).toBe(generatorAfter032())
    expect(definition(saved, REBAND)).toBe(rebandAfter032())

    await pg.admin.unsafe(down032())
    const before = await catalog()
    expect(table(before)).toBeUndefined()
    expect(table(before, CLOSED_DATES_TABLE)).toBeUndefined()
    expect(definition(before, GENERATOR)).toBe(GENERATOR_BEFORE_032)
    expect(definition(before, REBAND)).toBe(REBAND_BEFORE_032)
    expect(without(before)).toEqual(without(saved))
    expect(before.tables.length).toBe(saved.tables.length - 2)

    await pg.admin.unsafe(migration032())
    expect(await catalog()).toEqual(saved)
  })

  it("032's row: the furthest session date already made, with no closed day left out; yesterday with no session at all; and with a session beyond the job's horizon the migration stops and changes nothing", async () => {
    // The furthest session, whatever else there is.
    await pg.admin.unsafe(down032())
    await oneOff(await day(3))
    await oneOff(await day(98), '23:30')
    await oneOff(await day(40))
    await pg.admin.unsafe(migration032())
    expect(await madeUpTo()).toBe(await day(98))
    expect(await skipped()).toEqual([])
    expect(Number((await pg.admin.unsafe('SELECT count(*)::int AS n FROM public.sessions_made_up_to'))[0]?.['n'])).toBe(1)
    expect(Number((await pg.admin.unsafe('SELECT count(*)::int AS n FROM public.closed_dates'))[0]?.['n'])).toBe(0)

    // Its day is the stored digits' (London wall-clock digits labelled UTC), whatever time zone the connection that
    // applies the migration is set to: 00:30 and 23:30 on the last day are both that day. Read in New York's time,
    // 00:30 would be the day before; in Tokyo's, 23:30 would be the day after (and past the horizon).
    for (const zone of ['America/New_York', 'Asia/Tokyo', 'Europe/London']) {
      await pg.admin.unsafe(down032())
      await pg.admin.unsafe('DELETE FROM public.sessions')
      await oneOff(await day(98), '00:30')
      await pg.admin.unsafe(`SET TIME ZONE '${zone}'`)
      try {
        await pg.admin.unsafe(migration032())
      } finally {
        await pg.admin.unsafe('RESET TIME ZONE')
      }
      expect(await madeUpTo(), `${zone}, 00:30`).toBe(await day(98))
      await pg.admin.unsafe(down032())
      await oneOff(await day(98), '23:30')
      await pg.admin.unsafe(`SET TIME ZONE '${zone}'`)
      try {
        await pg.admin.unsafe(migration032())
      } finally {
        await pg.admin.unsafe('RESET TIME ZONE')
      }
      expect(await madeUpTo(), `${zone}, 23:30`).toBe(await day(98))
    }

    // No session at all: yesterday, so the job starts from today.
    await pg.admin.unsafe(down032())
    await pg.admin.unsafe('DELETE FROM public.sessions')
    await pg.admin.unsafe(migration032())
    expect(await madeUpTo()).toBe(await day(-1))

    // A one-off beyond the horizon: the furthest session is not where the job has reached. It stops, in words.
    await pg.admin.unsafe(down032())
    await oneOff(await day(98))
    await oneOff(await day(99))
    const refused = await pg.admin.unsafe(migration032()).then(
      () => 'applied',
      (err: unknown) => (err instanceof Error ? err.message : String(err))
    )
    expect(refused).toBe(`Migration 032 stopped: a session exists on ${await day(99)}, after the nightly job's horizon (${await day(98)}). The furthest session is not the date the job has made up to: see the pre-check in the migration file.`)
    // Nothing of it is kept (the file ran as one transaction): no table, and the functions are still the old ones.
    const after = await catalog()
    expect(table(after)).toBeUndefined()
    expect(table(after, CLOSED_DATES_TABLE)).toBeUndefined()
    expect(definition(after, GENERATOR)).toBe(GENERATOR_BEFORE_032)
    expect(definition(after, REBAND)).toBe(REBAND_BEFORE_032)
  })

  it('the made-up-to table: row level security is on, one row only, and the Worker\'s role can read the date and not write it', async () => {
    await pg.admin.unsafe(down032())
    await pg.admin.unsafe(migration032())
    const can = async (privilege: string) => (await pg.admin.unsafe(`SELECT has_table_privilege('paddock_worker', 'public.sessions_made_up_to', '${privilege}') AS can`))[0]?.['can']
    expect([await can('SELECT'), await can('INSERT'), await can('UPDATE'), await can('DELETE')]).toEqual([true, false, false, false])
    expect((await pg.admin.unsafe("SELECT relrowsecurity FROM pg_class WHERE oid = 'public.sessions_made_up_to'::regclass"))[0]?.['relrowsecurity']).toBe(true)
    expect(await db.query('SELECT made_up_to::text AS made_up_to FROM sessions_made_up_to')).toEqual([{ made_up_to: await day(-1) }])
    await expect(db.query("UPDATE sessions_made_up_to SET made_up_to = '2030-01-01'")).rejects.toThrow(/permission denied/)
    await expect(db.query("UPDATE sessions_made_up_to SET closed_days_skipped = '{}'")).rejects.toThrow(/permission denied/)
    // A second row can't be: its id can only be true, and true is taken.
    await expect(pg.admin.unsafe("INSERT INTO public.sessions_made_up_to (id, made_up_to) VALUES (false, '2030-01-01')")).rejects.toThrow(/sessions_made_up_to_id_check/)
    await expect(pg.admin.unsafe("INSERT INTO public.sessions_made_up_to (made_up_to) VALUES ('2030-01-01')")).rejects.toThrow(/sessions_made_up_to_pkey/)
    // The job (SECURITY DEFINER) still moves it when the Worker's role calls it.
    await slotEveryDay()
    expect(Number((await db.query<{ n: number }>('SELECT public.generate_upcoming_sessions() AS n'))[0]?.n)).toBe(99)
    expect(await madeUpTo()).toBe(await day(98))
  })

  it("the closed dates table (W51a): row level security is on; the Worker's role can read, insert and delete a closed date and not rewrite one; a date is closed once; who closed it is a staff member", async () => {
    await pg.admin.unsafe(down032())
    await pg.admin.unsafe(migration032())
    const can = async (privilege: string) => (await pg.admin.unsafe(`SELECT has_table_privilege('paddock_worker', 'public.closed_dates', '${privilege}') AS can`))[0]?.['can']
    expect([await can('SELECT'), await can('INSERT'), await can('DELETE'), await can('UPDATE'), await can('TRUNCATE')]).toEqual([true, true, true, false, false])
    expect((await pg.admin.unsafe("SELECT relrowsecurity FROM pg_class WHERE oid = 'public.closed_dates'::regclass"))[0]?.['relrowsecurity']).toBe(true)
    const christmas = await day(200)
    await close(christmas)
    expect(await db.query("SELECT closed_on::text AS closed_on, reason, closed_by, closed_at IS NOT NULL AS stamped FROM closed_dates")).toEqual([{ closed_on: christmas, reason: 'Closed for Christmas', closed_by: jo, stamped: true }])
    await expect(db.query("UPDATE closed_dates SET reason = 'Something else'")).rejects.toThrow(/permission denied/)
    await expect(close(christmas, 'Again')).rejects.toThrow(/closed_dates_pkey/)
    await expect(db.query('INSERT INTO closed_dates (closed_on, closed_by) VALUES ($1::date, $2::uuid)', [await day(201), '00000000-0000-4000-8000-000000000001'])).rejects.toThrow(/closed_dates_closed_by_fkey/)
    await reopen(christmas)
    expect(await db.query('SELECT 1 FROM closed_dates')).toEqual([])
  })

  it('GB3: a one-off session a year out, then the nightly job. The job makes every day from its own date to today + 98 and moves the date; before 032 it made nothing', async () => {
    await slotEveryDay()
    await startAt(90)
    const farDay = await day(365)
    const far = await oneOff(farDay)

    // Control: the function as it was. The far session is past the target, so it makes nothing, tonight and every night.
    await pg.admin.unsafe(FUNCTIONS_BEFORE_032_SQL)
    expect(await runJob()).toBe(0)
    expect(await sessionDays()).toEqual([farDay])

    // 032's, as the file has it: days 91 to 98, one session each, and the date moved to today + 98.
    await pg.admin.unsafe(generatorFromFile032Sql())
    expect(await runJob()).toBe(8)
    const expected: string[] = []
    for (let n = 91; n <= 98; n++) expected.push(await day(n))
    expect(await sessionDays()).toEqual([...expected, farDay])
    expect(await madeUpTo()).toBe(await day(98))
    // The one-off is untouched, and a second run the same night makes nothing more.
    expect((await pg.admin.unsafe('SELECT id FROM public.sessions WHERE id = $1', [far])).length).toBe(1)
    expect(await runJob()).toBe(0)
    expect(await sessionDays()).toEqual([...expected, farDay])
    expect(await madeUpTo()).toBe(await day(98))
  })

  it('the date moves even on a night no slot falls on, so a slot added later starts after it (Q50: dates already made are left)', async () => {
    await startAt(97)
    // No weekly slot at all: nothing to make, and the date still moves to today + 98.
    expect(await runJob()).toBe(0)
    expect(await madeUpTo()).toBe(await day(98))
    // A slot added now reaches no date already made: the next run makes nothing for it.
    await slotEveryDay()
    expect(await runJob()).toBe(0)
    expect(await sessionDays()).toEqual([])
    // A day later the job would make day 99 only. Shown with a horizon one day longer.
    expect(Number((await pg.admin.unsafe('SELECT public.generate_upcoming_sessions(99) AS n'))[0]?.['n'])).toBe(1)
    expect(await sessionDays()).toEqual([await day(99)])
    expect(await madeUpTo()).toBe(await day(99))
  })

  it('with no row (a database never set up) the job starts from today, never makes a session twice, and writes the row', async () => {
    await slotEveryDay()
    // Tomorrow's session is already there: left as it is (on conflict do nothing).
    const tomorrow = await oneOff(await day(1))
    expect(await madeUpTo()).toBeNull()
    expect(await runJob()).toBe(98)
    expect((await sessionDays()).length).toBe(99)
    expect((await sessionDays())[0]).toBe(await day(0))
    expect((await pg.admin.unsafe('SELECT id FROM public.sessions WHERE id = $1', [tomorrow])).length).toBe(1)
    expect(await madeUpTo()).toBe(await day(98))
    expect(await skipped()).toEqual([])
  })

  describe('closed dates (W51a; W51 review L3; Wayne, 20 Nov 2026): the job never makes sessions on a closed date', () => {
    it('a date closed beyond "made up to", then the job run past it: no session is made that day, the next day\'s are, and the date still moves; before closed dates the job made that day open', async () => {
      await slotEveryDay()
      await startAt(95)
      const closed = await day(97)
      await close(closed)

      // Control: the job as W51 wrote it (it knew no closed dates) makes all three days, the closed one open.
      await pg.admin.unsafe(generatorFromFile032Sql().replace('  from unnest(v_open) as g(day_ts)', '  from unnest(v_days) as g(day_ts)'))
      await pg.admin.unsafe('BEGIN')
      try {
        expect(Number((await pg.admin.unsafe('SELECT public.generate_upcoming_sessions() AS n'))[0]?.['n'])).toBe(3)
        expect((await pg.admin.unsafe<{ status: string }[]>("SELECT status FROM public.sessions WHERE (start_time AT TIME ZONE 'UTC')::date = $1::date", [closed])).map((row) => row.status)).toEqual(['open'])
      } finally {
        await pg.admin.unsafe('ROLLBACK')
      }

      // 032's, as the file has it: the day before and the day after, and nothing on the closed date.
      await pg.admin.unsafe(generatorFromFile032Sql())
      expect(await runJob()).toBe(2)
      expect(await sessionDays()).toEqual([await day(96), await day(98)])
      expect(await madeUpTo()).toBe(await day(98))
      // The job keeps the closed day it left out, and a second run the same night changes nothing.
      expect(await skipped()).toEqual([closed])
      expect(await runJob()).toBe(0)
      expect(await sessionDays()).toEqual([await day(96), await day(98)])
      expect(await skipped()).toEqual([closed])
      // The night after (shown with a horizon one day longer): day 99 is made, the closed date still isn't.
      expect(Number((await pg.admin.unsafe('SELECT public.generate_upcoming_sessions(99) AS n'))[0]?.['n'])).toBe(1)
      expect(await sessionDays()).toEqual([await day(96), await day(98), await day(99)])
      expect(await skipped()).toEqual([closed])
    })

    it('a closed date the job has passed is reopened: the next run makes that day\'s sessions, once, and no other day already made is touched (Q50)', async () => {
      await slotEveryDay()
      await startAt(95)
      const closed = await day(97)
      await close(closed)
      expect(await runJob()).toBe(2)
      // A weekly slot added after those days were made: it must not reach day 96 or 98 when the job goes back for 97.
      await insert(db, 'service_type_schedule_slots', { service_type_id: sauna, day_of_week: 0, start_time: '18:00' })
      for (let dow = 1; dow <= 6; dow++) await insert(db, 'service_type_schedule_slots', { service_type_id: sauna, day_of_week: dow, start_time: '18:00' })

      await reopen(closed)
      // The next run: the reopened day's sessions (both slots, as the timetable now is), and nothing else.
      expect(await runJob()).toBe(2)
      expect(await sessionDays()).toEqual([await day(96), closed, closed, await day(98)])
      expect(await skipped()).toEqual([])
      expect(await madeUpTo()).toBe(await day(98))
      // And only once.
      expect(await runJob()).toBe(0)
      expect(await sessionDays()).toEqual([await day(96), closed, closed, await day(98)])
    })

    it('a date reopened before the job reaches it is made in its turn; one closed again before the next run stays left out; one that has passed is forgotten', async () => {
      await slotEveryDay()
      await startAt(95)
      // Closed and reopened before any run: an ordinary day.
      await close(await day(96))
      await reopen(await day(96))
      await close(await day(97))
      expect(await runJob()).toBe(2)
      expect(await skipped()).toEqual([await day(97)])
      // Reopened, then closed again (another reason) before the next run: still closed, still left out.
      await reopen(await day(97))
      await close(await day(97), 'Boiler repair')
      expect(await runJob()).toBe(0)
      expect(await skipped()).toEqual([await day(97)])
      expect(await sessionDays()).toEqual([await day(96), await day(98)])

      // A day the job left out that is now in the past is dropped, reopened or not: the job never makes a past day.
      await pg.admin.unsafe("UPDATE public.sessions_made_up_to SET closed_days_skipped = ARRAY[(now() AT TIME ZONE 'Europe/London')::date - 1, (now() AT TIME ZONE 'Europe/London')::date + 97]")
      await reopen(await day(97))
      expect(await runJob()).toBe(1)
      expect(await sessionDays()).toEqual([await day(96), await day(97), await day(98)])
      expect(await skipped()).toEqual([])
    })

    it('a run with a shorter horizon still makes a reopened day it owes, and never moves the date back', async () => {
      await slotEveryDay()
      await startAt(95)
      await close(await day(97))
      expect(await runJob()).toBe(2)
      await reopen(await day(97))
      expect(Number((await pg.admin.unsafe('SELECT public.generate_upcoming_sessions(50) AS n'))[0]?.['n'])).toBe(1)
      expect(await sessionDays()).toEqual([await day(96), await day(97), await day(98)])
      expect(await madeUpTo()).toBe(await day(98))
      // With nothing owed, a shorter horizon does nothing at all.
      expect(Number((await pg.admin.unsafe('SELECT public.generate_upcoming_sessions(50) AS n'))[0]?.['n'])).toBe(0)
      expect(await madeUpTo()).toBe(await day(98))
    })

    it("the date's lock: the job waits for a press that holds the lock of a day it is about to make (the Worker's own lock statement), then reads the closed date that press wrote; a day outside its run doesn't hold it up", async () => {
      await slotEveryDay()
      await startAt(95)
      const closing = await day(97)
      let release = () => {}
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let announce: (pid: number) => void = () => {}
      const holding = new Promise<number>((resolve) => {
        announce = resolve
      })
      // A press that holds day 97's lock (as Block Day does) and has written the closed date, not yet committed. It
      // also holds a day the job isn't making, which must not matter.
      const press = db.transaction(async (tx) => {
        await tx.query(SESSION_DAY_LOCK_SQL, [closing])
        await tx.query(SESSION_DAY_LOCK_SQL, [await day(120)])
        await tx.query('INSERT INTO closed_dates (closed_on, reason, closed_by) VALUES ($1::date, $2, $3::uuid)', [closing, 'Staff day', jo])
        announce((await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]?.pid as number)
        await gate
      })
      const holder = await holding
      let finished = false
      const job = other.query<{ n: number }>('SELECT public.generate_upcoming_sessions() AS n').finally(() => {
        finished = true
      })
      const giveUpAt = Date.now() + 4_000
      let waiter: number | null = null
      while (waiter === null && Date.now() < giveUpAt) {
        waiter = (await pg.admin.unsafe<{ pid: number }[]>('SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))', [holder]))[0]?.pid ?? null
        if (waiter === null) await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(waiter).not.toBeNull()
      expect(await waitingOn(pg, waiter as number)).toEqual(['advisory'])
      expect(finished).toBe(false)
      // Nothing is made while it waits.
      expect(await sessionDays()).toEqual([])
      release()
      await press
      // The job carries on: day 96 and day 98, and nothing on the date the press closed.
      expect(Number((await job)[0]?.n)).toBe(2)
      expect(await sessionDays()).toEqual([await day(96), await day(98)])
      expect(await skipped()).toEqual([closing])
    })
  })

  describe('W51-1: the job takes the band guard shared before it writes', () => {
    /** A band-window save as the Worker makes it, held open: every band's row FOR NO KEY UPDATE, then Peak all day in place of Core. */
    const heldSave = async () => {
      let release = () => {}
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let announce: (pid: number) => void = () => {}
      const holding = new Promise<number>((resolve) => {
        announce = resolve
      })
      const done = db.transaction(async (tx) => {
        await tx.query('SELECT id FROM session_bands ORDER BY id FOR NO KEY UPDATE')
        await tx.query('DELETE FROM band_rules')
        for (let dow = 0; dow <= 6; dow++) await tx.query("INSERT INTO band_rules (band_id, day_of_week, from_time, to_time) VALUES ($1, $2, '00:00', '24:00')", [peak, dow])
        announce((await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]?.pid as number)
        await gate
      })
      return { holder: await holding, release, done }
    }
    const bands = async () => [...new Set((await pg.admin.unsafe<{ band_id: string }[]>('SELECT band_id FROM public.sessions')).map((row) => (row.band_id === peak ? 'peak' : row.band_id === core ? 'core' : String(row.band_id))))]
    const blockedBy = async (holder: number, forMs = 4_000): Promise<number | null> => {
      const giveUpAt = Date.now() + forMs
      while (Date.now() < giveUpAt) {
        const rows = await pg.admin.unsafe<{ pid: number }[]>('SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))', [holder])
        if (rows[0]) return rows[0].pid
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      return null
    }

    it('a session the job makes while a band-window save is held gets the NEW band: the job waits on the band rows until the save commits', async () => {
      await slotEveryDay()
      await startAt(95)
      const save = await heldSave()
      let finished = false
      const job = other.query<{ n: number }>('SELECT public.generate_upcoming_sessions() AS n').finally(() => {
        finished = true
      })
      const waiter = await blockedBy(save.holder)
      expect(waiter).not.toBeNull()
      expect(await waitingOn(pg, waiter as number)).toEqual(['session_bands'])
      expect(finished).toBe(false)
      // Nothing is made while it waits.
      expect(await sessionDays()).toEqual([])
      save.release()
      await save.done
      expect(Number((await job)[0]?.n)).toBe(3)
      expect(await bands()).toEqual(['peak'])
    })

    it('control: the job as it was before 032 does not wait, and its sessions keep the OLD band after the save commits', async () => {
      await slotEveryDay()
      // The old job reads the furthest session: one at today + 95 (at 09:00, not a slot's time) stands in for the date.
      await pg.admin.unsafe(FUNCTIONS_BEFORE_032_SQL)
      await oneOff(await day(95), '09:00')
      const save = await heldSave()
      const made = await other.query<{ n: number }>('SELECT public.generate_upcoming_sessions() AS n')
      expect(Number(made[0]?.n)).toBe(3)
      expect(await blockedBy(save.holder, 200)).toBeNull()
      save.release()
      await save.done
      // The save's windows are Peak all day, and the three sessions made during it are Core: W51-1 as it was.
      const fresh = await pg.admin.unsafe<{ band_id: string }[]>("SELECT band_id FROM public.sessions WHERE (start_time AT TIME ZONE 'UTC')::date > (now() AT TIME ZONE 'Europe/London')::date + 95")
      expect(fresh.map((row) => (row.band_id === core ? 'core' : 'peak'))).toEqual(['core', 'core', 'core'])
    })

    it('a save that starts while the job is running waits for it (the guard is shared, and a save takes the rows for itself)', async () => {
      await slotEveryDay()
      await startAt(95)
      let release = () => {}
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let announce: (pid: number) => void = () => {}
      const holding = new Promise<number>((resolve) => {
        announce = resolve
      })
      const job = db.transaction(async (tx) => {
        await tx.query('SELECT public.generate_upcoming_sessions()')
        announce((await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))[0]?.pid as number)
        await gate
      })
      const holder = await holding
      const save = other.transaction(async (tx) => {
        await tx.query('SELECT id FROM session_bands ORDER BY id FOR NO KEY UPDATE')
      })
      const waiter = await blockedBy(holder)
      expect(waiter).not.toBeNull()
      expect(await waitingOn(pg, waiter as number)).toEqual(['session_bands'])
      // Two jobs at once don't wait on the guard (it is shared): a second reader of the bands is let through.
      await pg.admin.unsafe('SELECT 1 FROM public.session_bands ORDER BY id FOR SHARE')
      release()
      await job
      await save
    })
  })

  it("the header's own SQL runs (brief W51a item 6): the two pre-checks agree, and disagree when a one-off lies on the target day; the checks after applying give the date, no closed day left out, one readable row with row level security, both functions as the new ones (all false before 032), the standing band check in London's form, and the closed dates table's rights; the two questions before any Down", async () => {
    await slotEveryDay()
    // The job has made up to today + 97 (it is before the day's 02:15 run), each day at its weekly slot's 10:00.
    await oneOff(await day(97))
    await oneOff(await day(12))
    const [p1] = sqlUnder('--   P1. The furthest session')
    const [p2] = sqlUnder('--   P2. The last date the job made')
    expect(sqlUnder('--   P1. The furthest session')).toHaveLength(1)
    expect(sqlUnder('--   P2. The last date the job made')).toHaveLength(1)
    const pre = async () => {
      const [first] = await pg.admin.unsafe<{ furthest: string; target: string }[]>(`SELECT furthest::text AS furthest, target::text AS target FROM (${p1 as string}) q`)
      const [second] = await pg.admin.unsafe<{ last_made: string }[]>(`SELECT last_made::text AS last_made FROM (${p2 as string}) q`)
      return { furthest: first?.furthest, target: first?.target, lastMade: second?.last_made }
    }
    expect(await pre()).toEqual({ furthest: await day(97), target: await day(98), lastMade: await day(97) })
    // The case only the second pre-check sees (W51 review point 1): a one-off on exactly the target day, at a time
    // no weekly slot has. The migration itself wouldn't stop (it isn't after the target); the two dates differ.
    const stray = await oneOff(await day(98), '07:00')
    expect(await pre()).toEqual({ furthest: await day(98), target: await day(98), lastMade: await day(97) })
    await pg.admin.unsafe('DELETE FROM public.sessions WHERE id = $1', [stray])
    expect(sqlUnder('--   P3. The cron entry')).toHaveLength(1)

    const functionChecks = sqlUnder('--   4. Both functions are the new ones')
    expect(functionChecks).toHaveLength(4)
    const answers = async (checks: string[]) => Promise.all(checks.map(async (sql) => Object.values((await pg.admin.unsafe(sql))[0] ?? {})[0]))
    expect(await answers(functionChecks)).toEqual([true, true, true, true])
    await pg.admin.unsafe(down032())
    expect(await answers(functionChecks)).toEqual([false, false, false, false])
    await pg.admin.unsafe(migration032())
    expect(await answers(functionChecks)).toEqual([true, true, true, true])

    const dateChecks = sqlUnder('--   1. The date')
    expect(dateChecks).toHaveLength(2)
    expect((await pg.admin.unsafe(`SELECT made_up_to::text AS d FROM (${dateChecks[0] as string}) q`))[0]?.['d']).toBe(await day(97))
    expect((await pg.admin.unsafe(`SELECT closed_days_skipped::text AS d FROM (${dateChecks[1] as string}) q`))[0]?.['d']).toBe('{}')
    const rowChecks = sqlUnder('--   2. One row')
    expect(rowChecks).toHaveLength(3)
    expect((await answers(rowChecks)).map(String)).toEqual(['1', 'true', 'true'])

    // Check 6: the date, then the standing band check, in London's form (W51 review L5): the stored form of London's
    // wall clock now, as the re-band's own default compares.
    const morningAfter = sqlUnder('--   6. The morning after')
    expect(morningAfter).toHaveLength(2)
    expect(morningAfter[1]).toContain("start_time >= ((now() AT TIME ZONE 'Europe/London') AT TIME ZONE 'UTC')")
    expect(morningAfter[1]).not.toContain('start_time >= now()')
    expect(Number(Object.values((await pg.admin.unsafe(morningAfter[1] as string))[0] ?? {})[0])).toBe(0)
    // A future public session on the wrong band is counted by it.
    await pg.admin.unsafe('ALTER TABLE public.sessions DISABLE TRIGGER USER')
    await pg.admin.unsafe("UPDATE public.sessions SET band_id = $1 WHERE (start_time AT TIME ZONE 'UTC')::date = $2::date", [peak, await day(12)])
    await pg.admin.unsafe('ALTER TABLE public.sessions ENABLE TRIGGER USER')
    expect(Number(Object.values((await pg.admin.unsafe(morningAfter[1] as string))[0] ?? {})[0])).toBe(1)

    // Check 7: the closed dates table. Check 8: no open session on a closed date still to come.
    const closedChecks = sqlUnder('--   7. Closed dates')
    expect(closedChecks).toHaveLength(6)
    expect((await answers(closedChecks)).map(String)).toEqual(['0', 'true', 'true', 'true', 'true', 'false'])
    const [standing] = sqlUnder('--   8. Standing')
    expect(Number(Object.values((await pg.admin.unsafe(standing as string))[0] ?? {})[0])).toBe(0)
    await close(await day(12))
    expect(Number(Object.values((await pg.admin.unsafe(standing as string))[0] ?? {})[0])).toBe(1)

    // Before any Down (W51 review live query 9, and the closed dates that would be lost).
    const beforeDown = sqlUnder('-- BEFORE ANY DOWN')
    expect(beforeDown).toHaveLength(2)
    expect(await answers(beforeDown)).toEqual([false, true])
    await reopen(await day(12))
    await oneOff(await day(200))
    expect(await answers(beforeDown)).toEqual([true, false])
  })
})
