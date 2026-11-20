import { appendFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Db } from '@/server/db'
import { SESSION_ADMIN_NEW_WORDS } from '@/server/rules/sessions/admin-failure-messages'
import { GENERATOR_BEFORE_032_NAME } from '../migration-032'
import { staffAppDir } from '../staff-app-dir'
import { isW51Scenario, W51_DECISIONS, W51_DELETED_FUNCTION_SCENARIOS, W51_DIFFERING, w51Differences } from './admin-differences'
import { adminRowProblems, adminStoredAnswerProblems, comparableAdmin, newAdminSide, STEP_G_ACTIONS_MOVED, STEP_G_AUDIT_ROWS, W51_ACTIONS, W51_READS, W51_WRITES } from './admin-side'
import { compareRecordings, showsStaffSetTimes, STAFF_SET_TIME_PREFIXES, type AllowedDifference, type Recording, type Row } from './compare'
import { legacyAdminDir, oldSide, readGolden, replay, startReplay, type ReplayEnvironment, type Scenario } from './harness'
import { ID, paidSeat } from './scenarios'
import { W48_ID, w48Scenarios } from './w48-scenarios'

// W51 (brief "Parity and tests"; G-plan 4.9 items 3 and 4): the session and timetable families (W48's recordings of
// the old functions) through the staff app's thin functions and the Worker's routes, as the screens press them.
// GB14's own recording (every read, by an inactive account and by a sign-in with no staff row) is replayed in
// admin-replay.test.ts, where W49 + W54 put it: its named difference now names W51's two reads too.
vi.setConfig({ testTimeout: 300_000 })

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))

const compareSides = (golden: Recording, recording: Recording, named: readonly AllowedDifference[]) => compareRecordings(comparableAdmin(golden), comparableAdmin(recording), named)

const THURSDAY = '2026-11-12'
const block = { sessionId: ID.session, reason: 'Staff training' }
const moved = { sessionId: ID.session, startTime: '2026-11-12T18:00:00.000Z' }
const samBooks = (call: (action: string, params: unknown) => Promise<unknown>) => call('createOrder', { customerId: ID.customer, booking: paidSeat(), payment: { method: 'cash', confirmedCashAmount: 20 } })

/**
 * Two recordings hold what happened when a booking landed between the old function's own statements (its check,
 * then its write). The old function's statements were the seam: the scenario put the booking between two of them.
 * A route that is one transaction under the session's lock has no such seam, so each is told again here as what can
 * still happen: the booking first (the order holds the session's lock until it commits, and the press waits for
 * it), then the press. The races themselves run on real Postgres (sessions/admin-postgres.test.ts).
 */
const TOLD_AGAIN: Readonly<Record<string, Scenario['run']>> = {
  'w48-gb5-a-booking-placed-between-the-check-and-the-block': async ({ call }) => {
    await samBooks(call)
    await call('blockSession', block)
  },
  'w48-session-start-time-refused-booking-placed-between-the-check-and-the-write': async ({ call }) => {
    await samBooks(call)
    await call('setSessionStartTime', moved)
  },
}
/**
 * Three recordings were made with `call`, which stops at the first throw: the old functions answered every step.
 * The Worker now refuses a step in each (a block or a band change of a session that isn't there; an unblock of a
 * session that isn't blocked), so each step is attempted (a refusal is recorded as what was thrown) and the scenario
 * runs to its end, as the recording did. Nothing else about the steps changes.
 */
const ATTEMPTED = ['w48-block-session', 'w48-session-band-set-for-one-session', 'w48-gb7-a-day-block-and-unblock-loses-an-earlier-block'] as const
const asPressedNow = (scenario: Scenario): Scenario => {
  if (TOLD_AGAIN[scenario.name]) return { ...scenario, run: TOLD_AGAIN[scenario.name] as Scenario['run'] }
  if ((ATTEMPTED as readonly string[]).includes(scenario.name)) return { ...scenario, run: (context) => scenario.run({ ...context, call: context.attempt }) }
  return scenario
}

const everyStepGScenario = w48Scenarios()
const families = everyStepGScenario.filter((scenario) => isW51Scenario(scenario.name))

type AuditRow = Row & { action?: string; details?: { before?: unknown; after?: unknown; sessionIds?: string[]; key?: string } & Record<string, unknown> }
const ownAuditRows = (recording: Recording): AuditRow[] => ((recording.tables['audit_log']?.added ?? []) as AuditRow[]).filter((row) => STEP_G_AUDIT_ROWS.has(String(row.action)))
/** The date the calendar read answered beside its sessions: none on a database with no such row, else a date. */
const madeUpToProblems = (found: readonly unknown[]): string[] => found.filter((value) => value !== null && !(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value))).map((value) => JSON.stringify(value))

describe("step G's side of the replay: sessions and the timetable (W51)", () => {
  let environment: ReplayEnvironment
  beforeAll(async () => {
    process.env.STAFF_API_KEY = 'test-staff-api-key'
    environment = await startReplay()
    holder.db = environment.database.db
  })
  afterAll(() => environment.stop())

  const scenario = (name: string): Scenario => {
    const found = everyStepGScenario.find((one) => one.name === name)
    if (!found) throw new Error(`No scenario ${name}`)
    return found
  }
  const golden = (name: string) => readGolden(name) as Recording
  const named = (name: string): readonly AllowedDifference[] => w51Differences(name, golden(name))
  const runNew = (name: string, options: Parameters<typeof newAdminSide>[0] = {}, replayOptions: Parameters<typeof replay>[3] = {}) => replay(environment, asPressedNow(scenario(name)), newAdminSide(options), replayOptions)
  const left = (name: string, recording: Recording, allowed: readonly AllowedDifference[] = named(name)) => compareSides(golden(name), recording, allowed).map((difference) => difference.path)

  describe.each(families.map((one) => [one.name, one] as const))('%s', (name, one) => {
    it('matches its golden file, with its named differences only; its audit rows and stored answers are right', async () => {
      const calls: Array<{ action: string; side: 'new' | 'old' }> = []
      const madeUpTo: unknown[] = []
      const recording = await replay(environment, asPressedNow(one), newAdminSide({ calls, madeUpTo }))
      expect(golden(name), `No golden file for ${name}`).not.toBeNull()
      if (process.env.W51_DIFFERENCES_OUT) {
        appendFileSync(
          process.env.W51_DIFFERENCES_OUT,
          `${JSON.stringify({ name, differences: compareSides(golden(name), recording, []), unnamed: compareSides(golden(name), recording, named(name)), rows: adminRowProblems(recording), stored: adminStoredAnswerProblems(recording), audit: recording.tables['audit_log']?.added ?? [], results: recording.results, madeUpTo, calls })}\n`
        )
        return
      }
      // Every call of a moved function went through the staff app's thin function and the Worker.
      expect(calls.filter((call) => STEP_G_ACTIONS_MOVED.has(call.action)).every((call) => call.side === 'new')).toBe(true)
      // The nightly job's two recordings press no function of W51's own in every step, but every other recording does.
      if (!/^w48-nightly-job-/.test(name)) expect(calls.some((call) => W51_ACTIONS.has(call.action))).toBe(true)
      expect(adminRowProblems(recording), `${name}: the Worker's audit rows`).toEqual([])
      expect(adminStoredAnswerProblems(recording), `${name}: the stored answers`).toEqual([])
      expect(madeUpToProblems(madeUpTo), `${name}: the date sessions are made up to`).toEqual([])
      expect(compareSides(golden(name), recording, named(name))).toEqual([])
    })
  })

  it('the family is whole: every session and timetable recording W48 made is replayed here, and every named difference is for a recording that exists', () => {
    expect(families.length).toBe(43)
    const count = (pattern: RegExp) => families.filter((one) => pattern.test(one.name)).length
    // The two reads; block and unblock (a session, a day); bands; start times; one-off sessions; weekly slots.
    expect(count(/^w48-(sessions-read|sessions-for-slot-read)$/)).toBe(2)
    expect(count(/^w48-(block-session|block-day|unblock-session|unblock-day)/)).toBe(10)
    expect(count(/^w48-session-band-/)).toBe(8)
    expect(count(/^w48-session-start-time-/)).toBe(6)
    expect(count(/^w48-one-off-session-/)).toBe(3)
    expect(count(/^w48-(slot-add|slot-remove)/)).toBe(5)
    // The nightly job's control, and the bugs: GB3, GB4 (the two slot ones), GB5 (three), GB6, GB7.
    expect(count(/^w48-(nightly-job-|gb3-|gb4-|gb5-|gb6-|gb7-)/)).toBe(9)
    expect(W51_READS.size).toBe(2)
    expect(W51_WRITES.size).toBe(10)
    expect(W51_ACTIONS.size).toBe(12)
    expect(W51_DIFFERING.every((name) => families.some((one) => one.name === name))).toBe(true)
    expect(Object.keys(TOLD_AGAIN).every((name) => W51_DIFFERING.includes(name) || name === 'w48-session-start-time-refused-booking-placed-between-the-check-and-the-write')).toBe(true)
    expect([...ATTEMPTED].every((name) => W51_DIFFERING.includes(name))).toBe(true)
    // 21 match their golden files exactly; 22 have named differences (W51a: Block Day's own recording, whose two
    // presses now record their dates as closed).
    expect(W51_DIFFERING.length).toBe(22)
    expect(families.filter((one) => named(one.name).length === 0).map((one) => one.name).sort()).toEqual(
      [
        'w48-block-day-refused-confirmed-bookings-in-the-way',
        'w48-block-day-who-may',
        'w48-block-session-refused-confirmed-booking-in-the-way',
        'w48-block-session-who-may',
        'w48-gb4-a-new-weekly-slot-makes-no-session-on-dates-already-made',
        'w48-gb4-a-removed-weekly-slot-leaves-its-sessions',
        'w48-one-off-session-create',
        'w48-session-band-refusals',
        'w48-session-band-refused-band-switched-off',
        'w48-session-band-reset-with-no-window-for-its-time',
        'w48-session-band-set-for-a-day',
        'w48-session-start-time-refusals',
        'w48-session-start-time-refused-booking-on-it',
        'w48-session-start-time-refused-booking-placed-between-the-check-and-the-write',
        'w48-session-start-time-set',
        'w48-session-start-time-set-keeps-a-band-set-by-hand',
        'w48-sessions-for-slot-read',
        'w48-sessions-read',
        'w48-slot-add',
        'w48-slot-remove-refusals',
        'w48-unblock-session',
      ].sort()
    )
    expect(Object.keys(W51_DECISIONS).sort()).toEqual(['CLOSED_DATES', 'GB14_COUNT', 'GB3', 'GB5', 'GB6', 'GB7', 'NO_STAFF_ROW', 'Q50_PART_2', 'WORDS'])
  })

  it("GB24: generateUpcomingSessions is deleted, not moved. Its two recordings stay as the old function's (the frozen copy still runs them), there is no such function in the staff app any more, and no route stands in for it", () => {
    for (const name of W51_DELETED_FUNCTION_SCENARIOS) {
      expect(everyStepGScenario.some((one) => one.name === name), name).toBe(true)
      expect(isW51Scenario(name), name).toBe(false)
      expect(golden(name), name).not.toBeNull()
    }
    expect(existsSync(path.join(staffAppDir(), 'backend/paddock/generateUpcomingSessions.ts'))).toBe(false)
    expect(existsSync(path.join(legacyAdminDir, 'generateUpcomingSessions.ts'))).toBe(true)
    expect(STEP_G_ACTIONS_MOVED.has('generateUpcomingSessions')).toBe(false)
  })

  it('W48 review L6: a later slice\'s own recordings show the times staff set, as step G\'s golden files do', () => {
    expect(STAFF_SET_TIME_PREFIXES).toEqual(['w48-', 'w51-'])
    expect(showsStaffSetTimes('w48-session-start-time-set')).toBe(true)
    expect(showsStaffSetTimes('w51-a-one-off-session-a-year-out')).toBe(true)
    // The 991 recordings before step G are read exactly as they were written.
    expect(showsStaffSetTimes('move-cheaper-to-store-credit')).toBe(false)
    expect(showsStaffSetTimes('w36-membership-cancel')).toBe(false)
  })

  describe('what the old functions never recorded is now recorded', () => {
    it('a block and an unblock each have their row: who, the session, and its block before and after', async () => {
      const blocked = await runNew('w48-block-session')
      expect(ownAuditRows(blocked).map((row) => [row.action, row['actor_id'], row['entity_type'], row['entity_id']])).toEqual([['session.blocked', ID.staff, 'session', ID.session]])
      expect(ownAuditRows(blocked)[0]?.details).toMatchObject({ before: { status: 'open', blocked_reason: null }, after: { status: 'blocked', blocked_reason: 'Staff training', blocked_by: ID.staff } })
      const unblocked = await runNew('w48-unblock-session')
      expect(ownAuditRows(unblocked).map((row) => [row.action, row['entity_id']])).toEqual([['session.unblocked', W48_ID.sameDaySession]])
      expect(ownAuditRows(unblocked)[0]?.details).toMatchObject({ before: { status: 'blocked', blocked_reason: 'Boiler repair' }, after: { status: 'open', blocked_reason: null, blocked_by: null } })
    })

    it('a day block names the sessions it blocked, and the day unblock the ones it reopened (GB7: only those)', async () => {
      const recording = await runNew('w48-gb7-a-day-block-and-unblock-loses-an-earlier-block')
      const rows = ownAuditRows(recording)
      expect(rows.map((row) => [row.action, row['entity_type'], row['entity_id']])).toEqual([['session.blocked', 'session_day', THURSDAY], ['session.unblocked', 'session_day', THURSDAY]])
      expect(rows[0]?.details?.sessionIds).toEqual([ID.session])
      expect(rows[1]?.details?.sessionIds).toEqual([ID.session])
      expect(rows[1]?.details).toMatchObject({ unblocked: 1, leftBlocked: 1 })
    })

    it('a band set by hand, a reset, a start time moved, a one-off session and a weekly slot each have their row', async () => {
      const band = ownAuditRows(await runNew('w48-session-band-reset'))
      expect(band.map((row) => row.action)).toEqual(['session.band_set', 'session.band_reset'])
      const time = ownAuditRows(await runNew('w48-session-start-time-set'))
      expect(time.map((row) => row.action)).toEqual(['session.start_time_set'])
      expect(time[0]?.details).toMatchObject({ before: { start_time: '2026-11-12T10:00:00.000Z' }, after: { start_time: '2026-11-12T18:00:00.000Z', end_time: '2026-11-12T19:00:00.000Z' } })
      const made = ownAuditRows(await runNew('w48-one-off-session-create'))
      expect(made.map((row) => [row.action, row.details?.before])).toEqual([['session.created', null], ['session.created', null]])
      const slots = ownAuditRows(await runNew('w48-gb4-a-removed-weekly-slot-leaves-its-sessions'))
      expect(slots.map((row) => [row.action, row['entity_id'], row.details?.after])).toEqual([['timetable.slot_removed', W48_ID.slot, null]])
      expect(slots[0]?.details?.before).toMatchObject({ id: W48_ID.slot, day_of_week: 4, start_time: '10:00:00' })
    })

    it('a refused press leaves no row: GB5\'s and GB6\'s recordings write none of the session rows at all', async () => {
      for (const name of ['w48-gb5-a-payment-needed-booking-does-not-stop-a-block', 'w48-gb5-a-pending-booking-does-not-stop-a-block', 'w48-gb5-a-booking-placed-between-the-check-and-the-block', 'w48-gb6-a-session-with-a-payment-needed-booking-is-moved-into-peak']) {
        expect(ownAuditRows(await runNew(name)), name).toEqual([])
      }
    })
  })

  describe('the nightly job (migration 032)', () => {
    it('the recorded side still runs the job as it was before 032, so GB3\'s recording is still the old outcome: nothing made', async () => {
      const name = 'w48-gb3-one-far-future-session-stops-the-nightly-job'
      const recording = await replay(environment, scenario(name), oldSide)
      expect(compareRecordings(golden(name), recording, [])).toEqual([])
      expect(GENERATOR_BEFORE_032_NAME).toBe('generate_upcoming_sessions_before_032')
      // The old job wrote no date.
      expect(recording.tables['sessions_made_up_to']).toBeUndefined()
    })

    it('the Worker\'s side runs the job as it is now: the calendar read after it answers the date it moved', async () => {
      const madeUpTo: unknown[] = []
      await runNew('w48-gb3-one-far-future-session-stops-the-nightly-job', { madeUpTo })
      expect(madeUpTo).toEqual(['2027-02-16'])
      const before: unknown[] = []
      await runNew('w48-sessions-read', { madeUpTo: before })
      expect(before).toEqual([null, null])
    })
  })

  describe('a deliberate difference is caught', () => {
    it('in what staff are told: a field dropped from the calendar, a band price a penny out, the wrong words on a refusal', async () => {
      const read = 'w48-sessions-read'
      const withoutBand = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([field]) => field !== 'band_code'))
      const dropped = await runNew(read, { adjust: (action, answer) => (action === 'getSessionsForRange' && Array.isArray(answer) ? (answer as Array<Record<string, unknown>>).map(withoutBand) : answer) })
      // Every session the two reads answered: four in the first range asked for, none in the second.
      expect(left(read, dropped)).toEqual(['.results[1][0].band_code', '.results[1][1].band_code', '.results[1][2].band_code', '.results[1][3].band_code'])
      const pennyOut = await runNew(read, { adjust: (action, answer) => (action === 'getSessionsForRange' && Array.isArray(answer) ? (answer as Array<Record<string, unknown>>).map((row, i) => (i === 0 ? { ...row, band_price: '20.01' } : row)) : answer) })
      expect(left(read, pennyOut)).toEqual(['.results[1][0].band_price'])

      const gb7 = 'w48-gb7-a-day-block-and-unblock-loses-an-earlier-block'
      const recording = await runNew(gb7)
      expect(left(gb7, recording)).toEqual([])
      expect(recording.results[0]).toEqual({ thrown: SESSION_ADMIN_NEW_WORDS.notBlocked })
      const reworded: Recording = { ...recording, results: recording.results.map((result, i) => (i === 0 ? { thrown: 'This session is open.' } : result)) }
      expect(left(gb7, reworded)).toEqual(['.results[0].thrown'])
    })

    it('in a row: a block that lands anyway on a session with a Payment needed booking, a start time that moves anyway, the repair block lost', async () => {
      const gb5 = 'w48-gb5-a-payment-needed-booking-does-not-stop-a-block'
      const blockedAnyway = await runNew(gb5, {}, { tamper: async (db) => void (await db.query("UPDATE sessions SET status = 'blocked', blocked_reason = 'Staff training', blocked_by = $1 WHERE id = $2", [ID.staff, ID.session])) })
      // The golden file has the session blocked (the old code's fault): the allowance is pinned to it NOT being.
      expect(left(gb5, blockedAnyway).some((one) => one.includes('allowed difference not seen'))).toBe(true)

      const gb6 = 'w48-gb6-a-session-with-a-payment-needed-booking-is-moved-into-peak'
      const movedAnyway = await runNew(gb6, {}, { tamper: async (db) => void (await db.query("UPDATE sessions SET start_time = '2026-11-12 18:00:00+00', end_time = '2026-11-12 19:00:00+00' WHERE id = $1", [ID.session])) })
      expect(left(gb6, movedAnyway).some((one) => one.includes('allowed difference not seen'))).toBe(true)

      const gb7 = 'w48-gb7-a-day-block-and-unblock-loses-an-earlier-block'
      const repairLost = await runNew(gb7, {}, { tamper: async (db) => void (await db.query("UPDATE sessions SET status = 'open', blocked_reason = NULL, blocked_by = NULL WHERE id = $1", [W48_ID.sameDaySession])) })
      expect(left(gb7, repairLost).some((one) => one.includes('allowed difference not seen'))).toBe(true)
    })

    it('in the job: with the job as it was before 032 on the Worker\'s side, GB3\'s named differences are not seen', async () => {
      const name = 'w48-gb3-one-far-future-session-stops-the-nightly-job'
      const side = newAdminSide()
      const withTheOldJob: typeof side = (db, stripe) => {
        const made = side(db, stripe)
        delete made.nightlyJob
        return made
      }
      const recording = await replay(environment, scenario(name), withTheOldJob)
      expect(left(name, recording).filter((one) => one.includes('allowed difference not seen')).length).toBe(2)
    })

    it('in what was set aside: a block with no audit row, a second row for one press, a customer\'s name in a session row', async () => {
      const name = 'w48-block-session'
      const noRow = await runNew(name, {}, { tamper: async (db) => void (await db.query("DELETE FROM audit_log WHERE action = 'session.blocked'")) })
      expect(adminRowProblems(noRow)).toEqual(['session.blocked: 0 rows for 1 presses answered with a success'])
      const twice = await runNew(name, {}, { tamper: async (db) => void (await db.query("INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, request_id, details) SELECT actor_type, actor_id, action, entity_type, entity_id, request_id, details FROM audit_log WHERE action = 'session.blocked'")) })
      expect(adminRowProblems(twice)).toEqual(['session.blocked: 2 rows for 1 presses answered with a success'])
      const named = await runNew(name, {}, { tamper: async (db) => void (await db.query("UPDATE audit_log SET details = details || '{\"customer_first_name\": \"Sam\"}'::jsonb WHERE action = 'session.blocked'")) })
      expect(adminRowProblems(named).some((problem) => problem.startsWith('session.blocked: a name in a session row'))).toBe(true)
      // W51a (W51 review L1; closed dates): a block that didn't keep when it took its lock, and a day press that
      // doesn't say whether it closed the date, or removed a closed date.
      const noClock = await runNew(name, {}, { tamper: async (db) => void (await db.query("UPDATE audit_log SET details = details - 'lockedAt' WHERE action = 'session.blocked'")) })
      expect(adminRowProblems(noClock).some((problem) => problem.startsWith('session.blocked: when the block took its lock'))).toBe(true)
      const gb7 = 'w48-gb7-a-day-block-and-unblock-loses-an-earlier-block'
      expect(adminRowProblems(await runNew(gb7))).toEqual([])
      const unsaid = await runNew(gb7, {}, { tamper: async (db) => void (await db.query("UPDATE audit_log SET details = details - 'closedDate' - 'closedDateRemoved' WHERE entity_type = 'session_day'")) })
      expect(adminRowProblems(unsaid).map((problem) => problem.split(' (')[0]).sort()).toEqual(['session.blocked: whether the day press closed the date', 'session.unblocked: whether the day press removed a closed date'])
    })

    it('the figures a press confirms: pressed as the golden file has it, with no quote read first, Block Day and a band change are refused `changed_since` and nothing is written', async () => {
      const day = await runNew('w48-block-day', { pressWithoutFigures: true })
      expect(day.results[0]).toMatchObject({ blocked: false, changed: true, toBlock: 2, alreadyBlocked: 0, message: SESSION_ADMIN_NEW_WORDS.countsChanged })
      expect(day.tables['sessions']).toBeUndefined()
      const band = await runNew('w48-session-band-set-for-a-day', { pressWithoutFigures: true })
      expect(band.results[2]).toMatchObject({ confirmed: false, changed: true, sessionsAffected: 2, bookingsAffected: 1 })
      expect(ownAuditRows(band)).toEqual([])
    })

    it("an allowance nobody needs fails: GB5's on a recording that matches exactly", async () => {
      const exact = 'w48-block-session-refused-confirmed-booking-in-the-way'
      const recording = await runNew(exact)
      expect(left(exact, recording, [])).toEqual([])
      const unneeded = named('w48-gb5-a-payment-needed-booking-does-not-stop-a-block')
      expect(unneeded).toHaveLength(2)
      expect(left(exact, recording, unneeded)).toEqual(unneeded.map(() => expect.stringContaining('allowed difference not seen')))
    })
  })
})
