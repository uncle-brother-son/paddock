import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST as serviceTypeActiveRoute } from '@/app/api/v1/staff/catalog/service-types/[serviceTypeId]/active/route'
import { GET as serviceTypesRoute } from '@/app/api/v1/staff/catalog/service-types/route'
import { GET as customersRoute } from '@/app/api/v1/staff/customers/route'
import { GET as oneOffQuoteRoute } from '@/app/api/v1/staff/sessions/one-off/quote/route'
import { GET as sessionsRoute, POST as oneOffRoute } from '@/app/api/v1/staff/sessions/route'
import type { OneOffSessionQuoteRouteOutput } from '@/contracts'
import type { Db } from '@/server/db'
import { ADMIN_TEST_KEY, pressRoute, type AdminRouteHandler } from './admin-routes'
import { fixtures, insert, startTestDatabase, type TestDatabase } from './database'
import { AUDIT_INDEX, down034, DROPPED_BY_034_SQL, EMAIL_INDEX, GENERATOR, JOB_TIMES_034, JOB_TIMES_BEFORE_034, jobBefore034, migration034 } from './migration-034'
import { startRealPostgres, type RealPostgres } from './real-postgres'

// Brief W68 item 5 (H-plan H9, H10, H11; the W45 audit's rows 20 and 59; Wayne's yes to the drops, 23 Nov 2026): migration 034 is
// written but NOT applied to live, and the saved schema is left as live is today until the lead applies it and refreshes.
// This file holds the migration either way. It starts from the database as it was before 034 (what it drops put back from
// migration-034.ts, its Down run), and holds: exactly what changes and nothing else; the stop, with nothing changed, on a
// row that would be lost; a reader of something dropped stops it too (no CASCADE); (W68a, review L4) a table in use fails it at
// once, with nothing changed; the purge's cron job alone goes; the nightly job makes
// the same rows under UTC, London, New York and Sydney, where the old one didn't; its Down; and the routes that touched a
// dropped thing still answer once it is applied.

vi.setConfig({ testTimeout: 60_000 })

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))

const CATALOG_QUERY = readFileSync(path.join(__dirname, 'live-catalog-query.sql'), 'utf8')

interface Catalog {
  tables: Array<{ name: string; columns: Array<{ name: string; type: string }> }>
  constraints: Array<{ table: string; name: string }>
  indexes: Array<{ name: string; definition: string }>
  views: Array<{ name: string }>
  functions: Array<{ name: string; identity: string; definition: string }>
  [key: string]: unknown
}
const DROPPED_FUNCTIONS: readonly string[] = ['purge_parity_log', 'membership_period_for', 'lapse_sweep_expired_bookings']

describe('migration 034 (brief W68 item 5): the audit index, the drops, and the nightly job naming its zone', () => {
  let pg: RealPostgres
  const catalog = async (): Promise<Catalog> => {
    const raw = (await pg.admin.unsafe(CATALOG_QUERY))[0]?.['catalog'] as Catalog | string
    return typeof raw === 'string' ? (JSON.parse(raw) as Catalog) : raw
  }
  const one = async <T>(sql: string): Promise<T | undefined> => (await pg.admin.unsafe<T[]>(sql))[0]
  const apply = async (): Promise<void> => void (await pg.admin.begin((tx) => tx.unsafe(migration034())))
  const asBefore = async (): Promise<void> => void (await pg.admin.unsafe(`${DROPPED_BY_034_SQL}\n${down034()}`))
  const job = (from: Catalog) => from.functions.find((fn) => fn.name === GENERATOR)?.definition ?? ''

  beforeAll(async () => {
    pg = await startRealPostgres()
    // For the saved schema with 034 in it (a scratch copy's, to run the suite as live will be; as 032 and 033): the file is
    // applied to this throwaway Postgres 17.6 and the catalogue written to that path. Never run against live.
    if (process.env.W68_CATALOG_OUT) {
      await apply()
      writeFileSync(process.env.W68_CATALOG_OUT, JSON.stringify([{ catalog: await catalog() }]))
    }
  }, 120_000)
  afterAll(() => pg.stop())
  beforeEach(async () => {
    await pg.admin.unsafe('DROP SCHEMA IF EXISTS cron CASCADE; DROP VIEW IF EXISTS public.w68_reader; DELETE FROM public.sessions; DELETE FROM public.sessions_made_up_to; DELETE FROM public.service_type_schedule_slots; DELETE FROM public.service_types; DELETE FROM public.band_rules; DELETE FROM public.session_bands')
    await asBefore()
    await pg.admin.unsafe('DELETE FROM public.parity_log')
  })

  it('the file says it is not applied, gives up after 5 s waiting for a lock, drops nothing with CASCADE, stops before it changes anything, and writes no row', () => {
    const sql = migration034()
    expect(sql).toContain('NOT APPLIED by W68')
    const body = sql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
    expect(body).toContain("SET LOCAL lock_timeout = '5s';")
    // W68a (review L4): its first statement after that, the three busy tables together, never waiting.
    expect(body.trim().split('\n').slice(0, 3)).toEqual(["SET LOCAL lock_timeout = '5s';", '', 'LOCK TABLE public.audit_log, public.customers, public.service_types IN ACCESS EXCLUSIVE MODE NOWAIT;'])
    expect(body).not.toMatch(/\bCASCADE\b/i)
    expect(body.indexOf('RAISE EXCEPTION')).toBeGreaterThan(0)
    expect(body.indexOf('RAISE EXCEPTION')).toBeLessThan(body.search(/CREATE INDEX|DROP /))
    expect(body).not.toMatch(/\b(UPDATE|DELETE FROM|TRUNCATE|INSERT INTO)\b(?! sessions| sessions_made_up_to)/)
    // Everything dropped, once each.
    expect([...body.matchAll(/^(?:DROP (?:INDEX|VIEW|FUNCTION|TABLE)|ALTER TABLE \S+ DROP COLUMN) [^;]+;/gm)].map((match) => match[0])).toEqual([
      'DROP INDEX IF EXISTS public.idx_customers_email;',
      'DROP VIEW IF EXISTS public.membership_credit_period_balances;',
      'ALTER TABLE public.service_types DROP COLUMN IF EXISTS price;',
      'DROP FUNCTION IF EXISTS public.purge_parity_log();',
      'DROP TABLE IF EXISTS public.parity_log;',
      'DROP FUNCTION IF EXISTS public.membership_period_for(date, date);',
      'DROP FUNCTION IF EXISTS public.lapse_sweep_expired_bookings();',
    ])
    // The header: what is saved first, and the runbook's line.
    for (const saved of ['SELECT * FROM public.parity_log ORDER BY at;', 'SELECT id, name, price FROM public.service_types ORDER BY name;', 'SELECT * FROM public.membership_credit_period_balances']) expect(sql).toContain(saved)
    expect(sql.replace(/\n--\s+/g, ' ')).toContain('RUNBOOK: `lapse_sweep` off pauses lapsing')
    expect(sql).toContain('ALTER TABLE public.service_types ADD COLUMN price numeric(10,2);')
    // W68a (review S1, L4, L7, L8): never 028's Down; when to apply it; the review's pre-checks and checks after.
    expect(sql).toContain("-- Never run 028's Down after 034 (the hourly job calls the dropped function).\n")
    const said = sql.replace(/\n--\s+/g, ' ')
    expect(said).toContain('AFTER the W68 Worker is LIVE: `GET /api/test` answers 404')
    expect(said).not.toContain('Worker is pushed')
    expect(said).toContain('WITH NOBODY PRESSING (no sale, no booking change), and NOT ON A 5-MINUTE MARK')
    for (const check of ['P5 (B1)', 'P6 (B2)', 'P7 (B3)', 'P8 (B4)', 'P9 (B5)', 'P10 (B6)', '6 (A2)', '7 (A3)', '8 (A4)']) expect(sql, check).toContain(`--   ${check}.`)
  })

  it("review L4: a table in use (even only being read by an open transaction) fails it at once, with nothing at all changed, however it is sent; once it is free the file applies", async () => {
    const before = await catalog()
    const other = pg.connect()
    // As `apply_migration` sends it, and as the SQL editor does: one multi-statement run with no BEGIN.
    const asOneRun = async (): Promise<void> => void (await pg.admin.unsafe(migration034()))
    for (const [table, read] of [['audit_log', 'SELECT 1 FROM public.audit_log LIMIT 1'], ['customers', 'SELECT 1 FROM public.customers LIMIT 1'], ['service_types', 'SELECT 1 FROM public.service_types LIMIT 1']] as const) {
      let free = () => {}
      const held = new Promise<void>((resolve) => {
        free = resolve
      })
      let reading: Promise<unknown> = Promise.resolve()
      await new Promise<void>((started, failed) => {
        reading = other.transaction(async (tx) => {
          await tx.query(read)
          started()
          await held
        })
        reading.catch(failed)
      })
      try {
        for (const send of [apply, asOneRun]) {
          const from = Date.now()
          await expect(send(), table).rejects.toThrow(`could not obtain lock on relation "public.${table}"`)
          // At once: not after lock_timeout's 5 s.
          expect(Date.now() - from, table).toBeLessThan(2_000)
          expect(await catalog(), table).toEqual(before)
        }
      } finally {
        free()
        await reading
      }
    }
    await asOneRun()
    const after = await catalog()
    expect(after.tables.map((table) => table.name)).not.toContain('parity_log')
    expect(after.indexes.map((index) => index.name)).toContain(AUDIT_INDEX)
  })

  it('from the database as it was, it changes exactly these things and nothing else; applied twice it changes nothing; the job keeps its grants; its Down puts the parts that are not drops back', async () => {
    const before = await catalog()
    const grants = async () => (await one<{ acl: string | null }>(`SELECT proacl::text AS acl FROM pg_proc WHERE oid = 'public.${GENERATOR}(integer)'::regprocedure`))?.acl
    const grantsBefore = await grants()
    await apply()
    const after = await catalog()

    const names = (from: ReadonlyArray<{ name: string }>) => from.map((item) => item.name)
    expect(names(before.tables).filter((name) => !names(after.tables).includes(name))).toEqual(['parity_log'])
    expect(names(before.views).filter((name) => !names(after.views).includes(name))).toEqual(['membership_credit_period_balances'])
    expect(names(before.functions).filter((name) => !names(after.functions).includes(name)).sort()).toEqual([...DROPPED_FUNCTIONS].sort())
    expect(names(before.indexes).filter((name) => !names(after.indexes).includes(name)).sort()).toEqual([EMAIL_INDEX, 'parity_log_action_idx'].sort())
    expect(after.indexes.filter((index) => !names(before.indexes).includes(index.name))).toEqual([{ name: AUDIT_INDEX, definition: `CREATE INDEX ${AUDIT_INDEX} ON public.audit_log USING btree (action, entity_type, entity_id)` }])
    const typesColumns = (from: Catalog) => from.tables.find((table) => table.name === 'service_types')?.columns.map((column) => column.name) ?? []
    expect(typesColumns(before).filter((name) => !typesColumns(after).includes(name))).toEqual(['price'])
    // The job: its two lines, and the two comment lines.
    expect(job(before)).toBe(jobBefore034())
    expect(job(after)).toBe(job(before).replace(JOB_TIMES_BEFORE_034.join('\n'), JOB_TIMES_034.join('\n')))
    expect(job(after)).not.toBe(job(before))
    // Everything else, to the last character.
    const rest = (from: Catalog) => ({
      ...from,
      tables: from.tables.filter((table) => table.name !== 'parity_log').map((table) => (table.name === 'service_types' ? { ...table, columns: table.columns.filter((column) => column.name !== 'price') } : table)),
      constraints: from.constraints.filter((constraint) => constraint.table !== 'parity_log'),
      indexes: from.indexes.filter((index) => ![EMAIL_INDEX, AUDIT_INDEX, 'parity_log_action_idx'].includes(index.name)),
      views: from.views.filter((view) => view.name !== 'membership_credit_period_balances'),
      functions: from.functions.filter((fn) => fn.name !== GENERATOR && !DROPPED_FUNCTIONS.includes(fn.name)),
    })
    const restBefore = JSON.stringify(rest(before))
    // The dependencies list names the view dropped.
    const withoutTheView = (from: Record<string, unknown>) => Object.fromEntries(Object.entries(from).map(([key, value]) => [key, Array.isArray(value) ? value.filter((item) => !/membership_credit_period_balances|parity_log/.test(JSON.stringify(item))) : value]))
    expect(withoutTheView(rest(after))).toEqual(withoutTheView(JSON.parse(restBefore) as Record<string, unknown>))
    expect(await grants()).toBe(grantsBefore)

    await apply()
    expect(await catalog()).toEqual(after)
    await pg.admin.unsafe(down034())
    const down = await catalog()
    expect(job(down)).toBe(job(before))
    expect(names(down.indexes)).toContain(EMAIL_INDEX)
    expect(names(down.indexes)).not.toContain(AUDIT_INDEX)
    expect(await grants()).toBe(grantsBefore)
  })

  it('a row that would be lost stops it, with nothing at all changed: a parity_log row, or a priced service type', async () => {
    const before = await catalog()
    await pg.admin.unsafe("INSERT INTO public.parity_log (action, matches) VALUES ('w68', true)")
    await expect(apply()).rejects.toThrow('Migration 034 stopped and changed nothing: parity_log has 1 row(s), service_types has 0 priced row(s)')
    expect(await catalog()).toEqual(before)
    await pg.admin.unsafe("DELETE FROM public.parity_log; INSERT INTO public.service_types (name, booking_type, price) VALUES ('W68 Sauna', 'public', 20)")
    await expect(apply()).rejects.toThrow('parity_log has 0 row(s), service_types has 1 priced row(s)')
    expect(await catalog()).toEqual(before)
    expect((await one<{ price: string }>('SELECT price::text AS price FROM public.service_types'))?.price).toBe('20.00')
  })

  it('something that reads a dropped thing stops it too, with nothing changed (no CASCADE)', async () => {
    await pg.admin.unsafe('CREATE VIEW public.w68_reader AS SELECT name, price FROM public.service_types')
    const before = await catalog()
    await expect(apply()).rejects.toThrow(/cannot drop column price of table (public\.)?service_types because other objects depend on it/)
    expect(await catalog()).toEqual(before)
  })

  it("pg_cron's purge-parity-log goes and the five other jobs stay as they were; with no pg_cron (a test database) the file applies all the same", async () => {
    await pg.admin.unsafe(`
      CREATE SCHEMA cron;
      CREATE TABLE cron.job (jobid bigint PRIMARY KEY, jobname text, schedule text, command text, active boolean DEFAULT true);
      CREATE FUNCTION cron.unschedule(id bigint) RETURNS boolean LANGUAGE sql AS 'DELETE FROM cron.job WHERE jobid = id RETURNING true';
      INSERT INTO cron.job (jobid, jobname, schedule, command) VALUES
        (1, 'allocate-membership-credit-periods', '0 1 * * *', 'a'), (2, 'generate-upcoming-sessions', '15 2 * * *', 'b'), (3, 'membership-maintenance-hourly', '5 * * * *', 'c'),
        (4, 'refresh-herd-flags', '0 4 * * *', 'd'), (5, 'purge-api-idempotency', '0 3 * * *', 'e'), (6, 'purge-parity-log', '35 3 * * *', 'select public.purge_parity_log();');`)
    const others = async () => pg.admin.unsafe("SELECT * FROM cron.job WHERE jobname <> 'purge-parity-log' ORDER BY jobid")
    const before = [...(await others())]
    expect(before).toHaveLength(5)
    await apply()
    expect((await pg.admin.unsafe('SELECT jobname FROM cron.job')).map((row) => row['jobname'])).not.toContain('purge-parity-log')
    expect([...(await others())]).toEqual(before)
  })

  describe('H11: the nightly job makes the same rows whatever zone its connection is in', () => {
    type Made = { start: string; end: string; band: string | null; type: string; capacity: number }
    const ZONES = ['UTC', 'Europe/London', 'America/New_York', 'Australia/Sydney']
    /** A run far enough ahead to cross a change of the clocks in each zone, in a transaction that is put back. */
    async function runIn(zone: string): Promise<{ made: number; rows: Made[] }> {
      let out: { made: number; rows: Made[] } | null = null
      await pg.admin
        .begin(async (tx) => {
          await tx.unsafe(`SET LOCAL TIME ZONE '${zone}'`)
          const made = Number((await tx.unsafe(`SELECT public.${GENERATOR}(300) AS n`))[0]?.['n'])
          const rows = await tx.unsafe<Made[]>(
            `SELECT to_char(s.start_time AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS start, to_char(s.end_time AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS end, b.code AS band, s.type, s.capacity
               FROM public.sessions s LEFT JOIN public.session_bands b ON b.id = s.band_id ORDER BY s.start_time, s.service_type_id`
          )
          out = { made, rows: rows.map((row) => ({ ...row })) }
          throw new Error('put back')
        })
        .catch((err: unknown) => {
          if (!(err instanceof Error) || err.message !== 'put back') throw err
        })
      if (!out) throw new Error('The job did not run.')
      return out
    }
    beforeEach(async () => {
      const db = pg.connect()
      const core = await insert(db, 'session_bands', { code: 'core', name: 'Core', price: '20.00' })
      const peak = await insert(db, 'session_bands', { code: 'peak', name: 'Peak', price: '25.00' })
      const sauna = await insert(db, 'service_types', { name: 'Sauna', booking_type: 'public', duration: 60, capacity: 10 })
      const hire = await insert(db, 'service_types', { name: 'Hire', booking_type: 'private', duration: 150, capacity: 8 })
      for (let day = 0; day <= 6; day++) {
        await insert(db, 'band_rules', { band_id: core, day_of_week: day, from_time: '00:00', to_time: '17:00' })
        await insert(db, 'band_rules', { band_id: peak, day_of_week: day, from_time: '17:00', to_time: '24:00' })
        // The small hours too: the hour the clocks change in, and either side of midnight.
        for (const time of ['00:30', '01:30', '02:30', '10:00', '16:30', '23:30']) await insert(db, 'service_type_schedule_slots', { service_type_id: sauna, day_of_week: day, start_time: time })
        await insert(db, 'service_type_schedule_slots', { service_type_id: hire, day_of_week: day, start_time: '18:15' })
      }
    })

    it("034's job: every row the same under UTC, London, New York and Sydney, each at its slot's own digits and banded by them", async () => {
      await apply()
      const utc = await runIn('UTC')
      expect(utc.made).toBe(301 * 7)
      expect(utc.rows).toHaveLength(301 * 7)
      for (const zone of ZONES.slice(1)) expect(await runIn(zone), zone).toEqual(utc)
      // Each row's digits are a slot's, its length the type's, its band the hour's.
      for (const row of utc.rows) {
        expect(['00:30:00', '01:30:00', '02:30:00', '10:00:00', '16:30:00', '23:30:00', '18:15:00']).toContain(row.start.slice(11))
        expect((Date.parse(`${row.end.replace(' ', 'T')}Z`) - Date.parse(`${row.start.replace(' ', 'T')}Z`)) / 60_000).toBe(row.type === 'private' ? 150 : 60)
        expect(row.band).toBe(row.start.slice(11, 13) >= '17' ? 'peak' : 'core')
      }
    })

    it('control, the job as it was: under UTC the same rows as 034 makes (live is UTC, so nothing changes there); under New York, and under London in summer, it moves them', async () => {
      const old = { utc: await runIn('UTC'), london: await runIn('Europe/London'), newYork: await runIn('America/New_York') }
      await apply()
      expect(old.utc).toEqual(await runIn('UTC'))
      expect(old.newYork.rows).not.toEqual(old.utc.rows)
      expect(old.newYork.rows.some((row) => row.start.slice(11) === '15:00:00' || row.start.slice(11) === '14:00:00')).toBe(true)
      expect(old.london.rows).not.toEqual(old.utc.rows)
    })
  })
})

describe('with 034 applied, the routes that touched what it drops still answer', () => {
  let database: TestDatabase
  let db: Db
  const JO = 'jo@example.com'
  const call = <T = Record<string, unknown>>(route: AdminRouteHandler, method: 'GET' | 'POST', params: Record<string, string>, body: unknown = {}, query: Record<string, string> = {}) => {
    const withQuery: AdminRouteHandler = (request, context) => {
      const url = new URL(request.url)
      for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value)
      return route(method === 'GET' ? new Request(url, { method, headers: request.headers }) : request, context)
    }
    return pressRoute<T>(withQuery, method, { email: JO, params, ...(method === 'POST' ? { body } : {}) })
  }

  beforeAll(async () => {
    process.env.STAFF_API_KEY = ADMIN_TEST_KEY
    database = await startTestDatabase({ schema: 'live' })
    db = database.db
    holder.db = db
    await database.pg.exec(`RESET ROLE; BEGIN; ${migration034()} COMMIT; SET ROLE paddock_worker;`)
    await insert(db, 'staff', { role: 'admin', first_name: 'Jo', last_name: 'Staff', email: JO, can_issue_refunds: true, can_manage_pricing: true })
  })
  afterAll(() => database.stop())

  it('the service types read, on and off sale, a one-off session shown and made, the calendar and the customer list', async () => {
    const band = await insert(db, 'session_bands', { code: 'core', name: 'Core', price: '20.00' })
    for (let day = 0; day <= 6; day++) await insert(db, 'band_rules', { band_id: band, day_of_week: day, from_time: '00:00', to_time: '24:00' })
    const type = await fixtures.serviceType(db, { duration: 60, capacity: 10 })
    await fixtures.customer(db, { first_name: 'Sam', last_name: 'Test', email: 'sam@example.com' })
    const types = await call<Array<Record<string, unknown>>>(serviceTypesRoute, 'GET', {})
    expect(types.status).toBe(200)
    expect(types.data?.map((row) => row['id'])).toEqual([type])
    expect(types.data?.[0]).not.toHaveProperty('price')
    for (const active of [false, true]) expect((await call(serviceTypeActiveRoute, 'POST', { serviceTypeId: type }, { active })).data).toEqual({ id: type, active })
    const startTime = '2031-03-02T10:00:00.000Z'
    const shown = await call<OneOffSessionQuoteRouteOutput>(oneOffQuoteRoute, 'GET', {}, {}, { serviceTypeId: type, startTime })
    expect(shown.data).toMatchObject({ band: { code: 'core' }, pricePerPerson: 20 })
    expect((await call(oneOffRoute, 'POST', {}, { serviceTypeId: type, startTime, stamp: shown.data?.stamp })).status).toBe(200)
    const calendar = await call<{ sessions: unknown[] }>(sessionsRoute, 'GET', {}, {}, { startDate: '2031-03-01', endDate: '2031-03-07' })
    expect(calendar.data?.sessions).toHaveLength(1)
    expect((await call(customersRoute, 'GET', {})).status).toBe(200)
  })

  it("nothing in the Worker's own code (not its tests) names anything 034 drops", () => {
    const web = path.resolve(__dirname, '../../..')
    const sources = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const file = path.join(dir, name)
        if (statSync(file).isDirectory()) return /^(node_modules|testing|\.next|\.open-next|\.wrangler)$/.test(name) ? [] : sources(file)
        return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [file] : []
      })
    const withoutComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
    const gone = /membership_credit_period_balances|parity_log|membership_period_for|lapse_sweep_expired_bookings|idx_customers_email|\bst\.price\b|service_types SET price/
    expect(['server', 'app', 'lib', 'contracts'].flatMap((dir) => sources(path.join(web, dir))).filter((file) => gone.test(withoutComments(readFileSync(file, 'utf8')))).map((file) => path.relative(web, file))).toEqual([])
  })
})
