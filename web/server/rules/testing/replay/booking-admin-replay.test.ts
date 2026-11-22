import { appendFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Db } from '@/server/db'
import { BOOKING_ADMIN_NEW_WORDS } from '@/server/rules/bookings/admin-failure-messages'
import { isW50Scenario, pathsPinnedBy, W50_DECISIONS, W50_DIFFERING, w50Differences } from './admin-differences'
import { adminRowProblems, adminStoredAnswerProblems, comparableAdmin, newAdminSide, STEP_G_ACTIONS_MOVED, STEP_G_AUDIT_ROWS, STEP_G_FLAG_ROWS, W50_ACTIONS, W50_FLAGS, W50_READS } from './admin-side'
import { compareRecordings, type AllowedDifference, type Recording, type Row } from './compare'
import { readGolden, replay, startReplay, type ReplayEnvironment, type Scenario } from './harness'
import { ID } from './scenarios'
import { w48Scenarios } from './w48-scenarios'

// W50 (brief "Parity and tests"; G-plan 4.9 items 3 and 4): the bookings family and Overview's reads (W48's recordings
// of the old functions) through the staff app's thin functions and the Worker's routes, as the screens press them.
// GB14's own recording (every read, by an inactive account and by a sign-in with no staff row) is replayed in
// admin-replay.test.ts, where W49 + W54 put it: its named difference now names W50's six reads too.
vi.setConfig({ testTimeout: 300_000 })

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))

const compareSides = (golden: Recording, recording: Recording, named: readonly AllowedDifference[]) => compareRecordings(comparableAdmin(golden), comparableAdmin(recording), named)

const everyStepGScenario = w48Scenarios()
const families = everyStepGScenario.filter((scenario) => isW50Scenario(scenario.name))

/**
 * GB17's three recordings were made with `call`, which stops at the first throw: the old functions let every step
 * through. The Worker now refuses those steps, so each step is attempted (a refusal is recorded as what was thrown)
 * and the scenario runs to its end, as the recording did. Nothing else about the steps changes.
 */
const GB17_RECORDINGS = ['w48-gb17-a-cancelled-booking-and-a-payment-needed-one-are-checked-in', 'w48-gb17-a-cancelled-bookings-waiver-is-changed', 'w48-gb17-a-removed-addon-is-marked-prepared'] as const
const asPressedNow = (scenario: Scenario): Scenario => ((GB17_RECORDINGS as readonly string[]).includes(scenario.name) ? { ...scenario, run: (context) => scenario.run({ ...context, call: context.attempt }) } : scenario)

type AuditRow = Row & { action?: string; details?: { after?: Record<string, unknown> | null; accepted?: boolean; prepared?: boolean; key?: string } }
const ownAuditRows = (recording: Recording): AuditRow[] => ((recording.tables['audit_log']?.added ?? []) as AuditRow[]).filter((row) => STEP_G_FLAG_ROWS.has(String(row.action)))

describe("step G's side of the replay: Bookings admin and Overview (W50)", () => {
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
  const named = (name: string): readonly AllowedDifference[] => w50Differences(name, golden(name))
  const runNew = (name: string, options: Parameters<typeof newAdminSide>[0] = {}, replayOptions: Parameters<typeof replay>[3] = {}) => replay(environment, asPressedNow(scenario(name)), newAdminSide(options), replayOptions)
  const left = (name: string, recording: Recording, allowed: readonly AllowedDifference[] = named(name)) => compareSides(golden(name), recording, allowed).map((difference) => difference.path)

  describe.each(families.map((one) => [one.name, one] as const))('%s', (name, one) => {
    it('matches its golden file, with its named differences only; its audit rows and stored answers are right', async () => {
      const calls: Array<{ action: string; side: 'new' | 'old' }> = []
      const recording = await replay(environment, asPressedNow(one), newAdminSide({ calls }))
      expect(golden(name), `No golden file for ${name}`).not.toBeNull()
      // Every call of a moved function went through the staff app's thin function and the Worker, and there was one.
      expect(calls.filter((call) => STEP_G_ACTIONS_MOVED.has(call.action)).every((call) => call.side === 'new')).toBe(true)
      expect(calls.some((call) => W50_ACTIONS.has(call.action))).toBe(true)
      if (process.env.W50_DIFFERENCES_OUT) {
        appendFileSync(
          process.env.W50_DIFFERENCES_OUT,
          `${JSON.stringify({ name, differences: compareSides(golden(name), recording, []), unnamed: compareSides(golden(name), recording, named(name)), rows: adminRowProblems(recording), stored: adminStoredAnswerProblems(recording), audit: recording.tables['audit_log']?.added ?? [], results: recording.results })}\n`
        )
        return
      }
      expect(adminRowProblems(recording), `${name}: the Worker's audit rows`).toEqual([])
      expect(adminStoredAnswerProblems(recording), `${name}: the stored answers`).toEqual([])
      expect(compareSides(golden(name), recording, named(name))).toEqual([])
      // W58b (W52 "For later" 6): every pin bites (as event-admin-replay.test.ts): exactly the pinned paths differ.
      expect(left(name, recording, []).sort(), `${name}: the raw paths`).toEqual(named(name).flatMap((difference) => [...pathsPinnedBy(difference)]).sort())
    })
  })

  it('the family is whole: every booking and Overview recording W48 made is replayed here, and every named difference is for a recording that exists', () => {
    expect(families.length).toBe(16)
    // The six reads: 7 recordings. The three flags: 6, and GB17's three.
    expect(families.filter((one) => /^w48-(bookings-read|booking-detail-read-|addon-prep-read$|waiver-gaps-read$|payment-attention-read$)/.test(one.name)).length).toBe(7)
    expect(families.filter((one) => /^w48-(booking-check-in-|guest-waiver-|addon-prepared-)/.test(one.name)).length).toBe(6)
    expect(families.filter((one) => /^w48-gb17-/.test(one.name)).length).toBe(3)
    expect(W50_READS.size).toBe(6)
    expect(W50_FLAGS.size).toBe(3)
    expect(W50_ACTIONS.size).toBe(9)
    expect(W50_DIFFERING.every((name) => families.some((one) => one.name === name))).toBe(true)
    // 10 match their golden files exactly: every read, and the flags pressed on a live booking by an active staff
    // member. 6 have named differences: GB17's three, and the three "who may" recordings (a sign-in with no staff row).
    expect(W50_DIFFERING.length).toBe(6)
    expect(families.filter((one) => named(one.name).length === 0).map((one) => one.name).sort()).toEqual(
      [
        'w48-addon-prep-read',
        'w48-addon-prepared-and-undo',
        'w48-booking-check-in-and-undo',
        'w48-booking-detail-read-with-a-card-payment-being-checked',
        'w48-booking-detail-read-with-a-reader-payment-open',
        'w48-bookings-read',
        'w48-bookings-read-the-method-of-the-bookings-own-order',
        'w48-guest-waiver-signed-and-revoked',
        'w48-payment-attention-read',
        'w48-waiver-gaps-read',
      ].sort()
    )
    expect([...GB17_RECORDINGS].every((name) => W50_DIFFERING.includes(name))).toBe(true)
    expect(Object.keys(W50_DECISIONS).sort()).toEqual(['GB17_CANCELLED', 'GB17_REMOVED_ADDON', 'NO_STAFF_ROW', 'Q49'])
  })

  describe('what the old functions never recorded is now recorded (GB17: nothing said who)', () => {
    it('a check-in and its undo each have their row: who, the booking, and the check-in time as it now is', async () => {
      const recording = await runNew('w48-booking-check-in-and-undo')
      const rows = ownAuditRows(recording)
      expect(rows.map((row) => row.action)).toEqual(['booking.checked_in', 'booking.check_in_undone'])
      expect(rows.map((row) => [row['actor_type'], row['actor_id'], row['entity_type']])).toEqual([['staff', ID.staff, 'booking'], ['staff', ID.staff, 'booking']])
      expect(typeof rows[0]?.details?.after?.['checked_in_at']).toBe('string')
      expect(rows[1]?.details?.after).toEqual({ checked_in_at: null })
    })

    it("a waiver signed and revoked: who, how it was signed and its version, and never the guest's name, email or date of birth", async () => {
      const recording = await runNew('w48-guest-waiver-signed-and-revoked')
      const rows = ownAuditRows(recording)
      expect(rows.map((row) => [row.action, row.details?.accepted, row.details?.after?.['waiver_method'], row.details?.after?.['waiver_version']])).toEqual([
        ['booking.guest_waiver_set', true, 'in_person', 'v1'],
        ['booking.guest_waiver_set', true, 'email_link', 'v2'],
        ['booking.guest_waiver_set', false, null, null],
      ])
      expect(rows.every((row) => row['actor_id'] === ID.staff && row['entity_type'] === 'booking_guest')).toBe(true)
      expect(JSON.stringify(rows)).not.toMatch(/Sam Test|Alex Guest|sam@example\.com|alex@example\.com|1990-01-01/)
    })

    it('an add-on prepared and un-prepared: who pressed, which way, and who it is recorded as prepared by', async () => {
      const recording = await runNew('w48-addon-prepared-and-undo')
      const rows = ownAuditRows(recording)
      expect(rows.map((row) => [row.action, row.details?.prepared, row.details?.after?.['prepared'], row.details?.after?.['prepared_by']])).toEqual([
        ['booking.addon_prepared_set', true, true, ID.staff],
        ['booking.addon_prepared_set', false, false, null],
      ])
      expect(rows.every((row) => row['actor_id'] === ID.staff && row['entity_type'] === 'addon_order_line')).toBe(true)
    })

    it('a refused press leaves no row: GB17\'s three recordings write none of the flags\' rows at all', async () => {
      for (const name of GB17_RECORDINGS) {
        const recording = await runNew(name)
        expect(ownAuditRows(recording), name).toEqual([])
        expect(((recording.tables['audit_log']?.added ?? []) as Row[]).filter((row) => STEP_G_AUDIT_ROWS.has(String(row['action']))), name).toEqual([])
      }
    })
  })

  describe('a deliberate difference is caught', () => {
    it('in what staff are told: a field dropped from the booking list, a price a penny out in the detail, the wrong words on Q49', async () => {
      const list = 'w48-bookings-read'
      const withoutMethod = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([field]) => field !== 'payment_method'))
      const dropped = await runNew(list, { adjust: (action, answer) => (action === 'getBookings' && Array.isArray(answer) ? (answer as Array<Record<string, unknown>>).map(withoutMethod) : answer) })
      expect(left(list, dropped)).toEqual(['.results[2][0].payment_method', '.results[4][0].payment_method', '.results[5][0].payment_method'])

      const pennyOut = await runNew(list, {
        adjust: (action, answer) => {
          const detail = answer as { guests?: Array<Record<string, unknown>> }
          return action === 'getBookingDetail' && detail.guests?.[0] ? { ...detail, guests: detail.guests.map((guest, i) => (i === 0 ? { ...guest, unit_price: '20.01' } : guest)) } : answer
        },
      })
      expect(left(list, pennyOut)).toEqual(['.results[10].guests[0].unit_price'])

      const q49 = 'w48-gb17-a-cancelled-booking-and-a-payment-needed-one-are-checked-in'
      const recording = await runNew(q49)
      expect(left(q49, recording)).toEqual([])
      expect(recording.results[1]).toEqual({ thrown: BOOKING_ADMIN_NEW_WORDS.paymentNeededCheckIn })
      // W50a item 1: Wayne's sentence itself, as changed to name the button ("Take Payment", where it said "Settle").
      expect(recording.results[1]).toEqual({ thrown: 'This booking needs payment first. Use Take Payment.' })
      const reworded: Recording = { ...recording, results: recording.results.map((result, i) => (i === 1 ? { thrown: 'This booking needs payment first.' } : result)) }
      // The allowance is pinned to Wayne's sentence: any other words on that step are a difference.
      expect(left(q49, reworded)).toEqual(['.results[1].thrown'])
      // …and so are the words W50 shipped with.
      const oldWords: Recording = { ...recording, results: recording.results.map((result, i) => (i === 1 ? { thrown: 'This booking needs payment first. Use Settle.' } : result)) }
      expect(left(q49, oldWords)).toEqual(['.results[1].thrown'])
    })

    it('in a row: a check-in that lands anyway on the cancelled booking, a waiver signed for the other guest, an add-on left prepared', async () => {
      const cancelled = 'w48-gb17-a-cancelled-booking-and-a-payment-needed-one-are-checked-in'
      const checkedInAnyway = await runNew(cancelled, {}, { tamper: async (db) => void (await db.query('UPDATE bookings SET checked_in_at = now()')) })
      // The golden file has the booking checked in (the old code's fault): the allowance is pinned to it NOT being.
      expect(left(cancelled, checkedInAnyway).some((path) => path.includes('allowed difference not seen'))).toBe(true)

      const waiver = 'w48-guest-waiver-signed-and-revoked'
      const otherGuest = await runNew(waiver, {}, { tamper: async (db) => void (await db.query("UPDATE booking_guests SET waiver_accepted = true, waiver_method = 'in_person', waiver_version = 'v1', waiver_accepted_at = now() WHERE guest_type = 'account_holder'")) })
      expect(left(waiver, otherGuest)).toEqual(expect.arrayContaining(['.tables.booking_guests.added[0].waiver_accepted', '.tables.booking_guests.added[0].waiver_method']))

      const prepared = 'w48-addon-prepared-and-undo'
      const leftPrepared = await runNew(prepared, {}, { tamper: async (db) => void (await db.query('UPDATE addon_order_lines SET prepared = true')) })
      expect(left(prepared, leftPrepared)).toEqual(['.tables.addon_order_lines.added[0].prepared'])
    })

    it('in what was set aside: a flag with no audit row, a second row for one press', async () => {
      const name = 'w48-addon-prepared-and-undo'
      const noRow = await runNew(name, {}, { tamper: async (db) => void (await db.query("DELETE FROM audit_log WHERE id = (SELECT id FROM audit_log WHERE action = 'booking.addon_prepared_set' ORDER BY at LIMIT 1)")) })
      expect(adminRowProblems(noRow)).toEqual(['booking.addon_prepared_set: 1 rows for 2 presses answered with a success'])

      const check = 'w48-booking-check-in-and-undo'
      const twice = await runNew(check, {}, { tamper: async (db) => void (await db.query("INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, request_id, details) SELECT actor_type, actor_id, action, entity_type, entity_id, request_id, details FROM audit_log WHERE action = 'booking.check_in_undone' ORDER BY at LIMIT 1")) })
      // The route's two actions are counted together: three rows for its two presses.
      expect(adminRowProblems(twice)).toEqual(['booking.checked_in: 3 rows for 2 presses answered with a success'])
    })

    it("an allowance nobody needs fails: GB17's on a recording that matches exactly", async () => {
      const exact = 'w48-booking-check-in-and-undo'
      const recording = await runNew(exact)
      expect(left(exact, recording, [])).toEqual([])
      const unneeded = named(GB17_RECORDINGS[0])
      expect(unneeded).toHaveLength(3)
      expect(left(exact, recording, unneeded)).toEqual(unneeded.map(() => expect.stringContaining('allowed difference not seen')))
    })
  })
})
