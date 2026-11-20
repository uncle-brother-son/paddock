import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Db } from '@/server/db'
import { insert, startTestDatabase, type TestDatabase } from '@/server/rules/testing/database'
import { asOwner, FUNCTIONS_BEFORE_032_SQL, rebandAfter032 } from '@/server/rules/testing/migration-032'
import { LONDON_WALL_CLOCK_NOW_SQL } from '@/server/rules/time/london-day-sql'
import { REBAND_SQL, SESSIONS_TO_REBAND_SQL, setBandRules } from './admin'
import { getPricingConfig } from './pricing-config'

vi.setConfig({ testTimeout: 60_000 })

// Brief W51 item 1 (W50 review L3): re-banding compares session times with London's wall clock now, never with the
// real now(). A session's start is London wall-clock digits labelled UTC, so in summer the real now() is an hour
// behind the wall: a band-window save at 10:30 on the wall (09:30 UTC) used to re-band a session that had started at
// 10:00. Held here on a clock the test sets (the database's now() follows it), for the Worker's two statements and
// for the database function's own default (migration 032).

// Thursday 1 July 2027, 10:30 on the wall in London (British Summer Time): 09:30 UTC.
const SUMMER_NOW = '2027-07-01T09:30:00.000Z'
// Thursday 7 January 2027, 10:30 on the wall in London (GMT): 10:30 UTC.
const WINTER_NOW = '2027-01-07T10:30:00.000Z'
const THURSDAY = 4

let database: TestDatabase
let db: Db
let jo = ''
let core = ''
let peak = ''
let sauna = ''

beforeAll(async () => {
  // Started on the real clock: Postgres's own start-up waits on time passing.
  database = await startTestDatabase({ schema: 'live' })
  db = database.db
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(SUMMER_NOW) })
})
afterAll(async () => {
  vi.useRealTimers()
  await database.stop()
})

/** Core all day, every day; the function as migration 032 leaves it. */
beforeEach(async () => {
  vi.setSystemTime(new Date(SUMMER_NOW))
  await asOwner(database.pg, `${rebandAfter032().trimEnd()};`)
  await database.pg.exec('RESET ROLE; TRUNCATE audit_log, sessions, service_types, band_rules, session_bands, staff CASCADE; SET ROLE paddock_worker;')
  jo = await insert(db, 'staff', { role: 'admin', first_name: 'Jo', last_name: 'Staff', email: 'jo@example.com', can_issue_refunds: true, can_manage_pricing: true })
  core = await insert(db, 'session_bands', { code: 'core', name: 'Core', price: '20.00' })
  peak = await insert(db, 'session_bands', { code: 'peak', name: 'Peak', price: '25.50' })
  for (let day = 0; day <= 6; day++) await insert(db, 'band_rules', { band_id: core, day_of_week: day, from_time: '00:00', to_time: '24:00' })
  sauna = await insert(db, 'service_types', { name: 'Sauna', booking_type: 'public', duration: 60, capacity: 10 })
})

const sessionAt = (start: string) => insert(db, 'sessions', { service_type_id: sauna, start_time: `${start}:00+00`, end_time: `${start.slice(0, 13)}:59:00+00`, type: 'public', capacity: 10, band_id: core })
const bandOf = async (session: string) => ((await db.query<{ band_id: string }>('SELECT band_id FROM sessions WHERE id = $1', [session]))[0]?.band_id === core ? 'core' : 'peak')
const by = () => ({ actor: { type: 'staff' as const, id: jo, role: 'admin' as const, canManagePricing: true, canIssueRefunds: true }, requestId: crypto.randomUUID(), pressKey: crypto.randomUUID() })
/** Thursday re-cut so that Peak starts at 09:00: every Thursday session from 09:00 would move from Core to Peak. */
const peakFromNine = () => [{ bandId: core, fromTime: '00:00', toTime: '09:00' }, { bandId: peak, fromTime: '09:00', toTime: '24:00' }]
const saveThursday = async () => setBandRules(db, THURSDAY, peakFromNine(), (await getPricingConfig(db, true)).bandRulesStamps[THURSDAY], by())

describe("re-banding is from London's wall clock now (W50 review L3)", () => {
  it('the clock the test sets is the database\'s: 09:30 UTC, and 10:30 on the wall in London, in the stored form', async () => {
    // eslint-disable-next-line no-restricted-syntax -- test only: the fragment is a literal in time/london-day-sql.ts
    const [row] = await db.query<{ real: string; wall: string }>(`SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') AS real, to_char(${LONDON_WALL_CLOCK_NOW_SQL} AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI') AS wall`)
    expect(row).toEqual({ real: '2027-07-01 09:30', wall: '2027-07-01 10:30' })
    expect(LONDON_WALL_CLOCK_NOW_SQL).toBe("((now() AT TIME ZONE 'Europe/London') AT TIME ZONE 'UTC')")
  })

  it('summer: a save at 10:30 on the wall re-bands the 11:00 session and leaves the one that started at 10:00, and the 10:29 one', async () => {
    const started = await sessionAt('2027-07-01 10:00')
    const justStarted = await sessionAt('2027-07-01 10:29')
    const atNow = await sessionAt('2027-07-01 10:30')
    const later = await sessionAt('2027-07-01 11:00')
    const nextWeek = await sessionAt('2027-07-08 09:00')
    const answer = await saveThursday()
    expect(answer.rebandedSessions).toBe(3)
    expect([await bandOf(started), await bandOf(justStarted), await bandOf(atNow), await bandOf(later), await bandOf(nextWeek)]).toEqual(['core', 'core', 'peak', 'peak', 'peak'])
  })

  it('control: compared with the real now() (the old way), the same save also re-bands the session that started at 10:00', async () => {
    const started = await sessionAt('2027-07-01 10:00')
    const later = await sessionAt('2027-07-01 11:00')
    await db.transaction(async (tx) => {
      await tx.query('DELETE FROM band_rules WHERE day_of_week = $1', [THURSDAY])
      await tx.query("INSERT INTO band_rules (band_id, day_of_week, from_time, to_time) VALUES ($1, $2, '00:00', '09:00'), ($3, $2, '09:00', '24:00')", [core, THURSDAY, peak])
      // The Worker's old statement: "from" is the real now(), 09:30, which the 10:00 session's stored digits are after.
      const [row] = await tx.query<{ n: number }>('SELECT reassign_session_bands(now()) AS n')
      expect(Number(row?.n)).toBe(2)
    })
    expect([await bandOf(started), await bandOf(later)]).toEqual(['peak', 'peak'])
  })

  it("the database function's own default is the same moment since migration 032; before it, the default was the real now()", async () => {
    const started = await sessionAt('2027-07-01 10:00')
    const later = await sessionAt('2027-07-01 11:00')
    const recut = async () => {
      await db.query('UPDATE sessions SET band_id = $1', [core])
      await db.query('DELETE FROM band_rules WHERE day_of_week = $1', [THURSDAY])
      await db.query("INSERT INTO band_rules (band_id, day_of_week, from_time, to_time) VALUES ($1, $2, '00:00', '09:00'), ($3, $2, '09:00', '24:00')", [core, THURSDAY, peak])
    }
    await recut()
    expect(Number((await db.query<{ n: number }>('SELECT reassign_session_bands() AS n'))[0]?.n)).toBe(1)
    expect([await bandOf(started), await bandOf(later)]).toEqual(['core', 'peak'])
    // The function as it was before 032: called with no argument it re-bands the started session too.
    await asOwner(database.pg, FUNCTIONS_BEFORE_032_SQL)
    await recut()
    expect(Number((await db.query<{ n: number }>('SELECT reassign_session_bands() AS n'))[0]?.n)).toBe(2)
    expect([await bandOf(started), await bandOf(later)]).toEqual(['peak', 'peak'])
    // ...and the Worker's save is right on that database too, because it passes London's wall clock itself.
    await db.query('UPDATE sessions SET band_id = $1', [core])
    await db.query('DELETE FROM band_rules WHERE day_of_week = $1', [THURSDAY])
    await db.query("INSERT INTO band_rules (band_id, day_of_week, from_time, to_time) VALUES ($1, $2, '00:00', '24:00')", [core, THURSDAY])
    expect((await saveThursday()).rebandedSessions).toBe(1)
    expect([await bandOf(started), await bandOf(later)]).toEqual(['core', 'peak'])
  })

  it('winter: the wall clock and UTC agree, so the answer is the same either way', async () => {
    vi.setSystemTime(new Date(WINTER_NOW))
    const started = await sessionAt('2027-01-07 10:00')
    const later = await sessionAt('2027-01-07 11:00')
    expect((await saveThursday()).rebandedSessions).toBe(1)
    expect([await bandOf(started), await bandOf(later)]).toEqual(['core', 'peak'])
  })

  it('the two statements the save runs name the same moment: the sessions it locks are the sessions the function then re-bands', async () => {
    expect(SESSIONS_TO_REBAND_SQL).toContain(`AND s.start_time >= ${LONDON_WALL_CLOCK_NOW_SQL}`)
    expect(SESSIONS_TO_REBAND_SQL).not.toMatch(/>= now\(\)/)
    expect(REBAND_SQL).toBe(`SELECT reassign_session_bands(${LONDON_WALL_CLOCK_NOW_SQL}) AS n`)
    const started = await sessionAt('2027-07-01 10:00')
    const later = await sessionAt('2027-07-01 11:00')
    await db.query('DELETE FROM band_rules WHERE day_of_week = $1', [THURSDAY])
    await db.query("INSERT INTO band_rules (band_id, day_of_week, from_time, to_time) VALUES ($1, $2, '00:00', '09:00'), ($3, $2, '09:00', '24:00')", [core, THURSDAY, peak])
    expect((await db.query<{ id: string }>(SESSIONS_TO_REBAND_SQL)).map((row) => row.id)).toEqual([later])
    expect(started).not.toBe(later)
  })
})
