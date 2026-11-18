import { appendFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Db } from '@/server/db'
import { BOOKING_LAPSED } from '@/server/rules/bookings/cancel'
import type { LapseSweepResult } from '@/server/rules/bookings/lapse-sweep'
import { compareRecordings, type AllowedDifference, type Recording, type Row } from './compare'
import { oldSide, readGolden, replay, startReplay, type ReplayEnvironment, type Scenario } from './harness'
import { sweepInvariants } from './invariants'
import { DECISION_SCENARIOS, isW43Scenario, pathsPinnedBy, W43_DIFFERENCES } from './lapse-differences'
import { comparableLapse, lapseRowProblems, newLapseSide, REPLAY_SWEEP_REQUEST, W43_AUDIT_ROWS, type LapseSideOptions } from './lapse-side'
import { scenarios } from './scenarios'

// W43 (brief item 5; F-plan 4.12): the lapse family. W36 recorded the database's own sweep on four seeds (nothing
// paid; a deadline not yet passed; FB18, a paid guest; FB19, a paid add-on). Here the Worker's sweep runs on the same
// seeds in its place, and what it leaves is held to each golden file: exactly, for a booking with nothing paid (the
// rows compared), and with one named, pinned difference each for FB18 and FB19 (Q48).
vi.setConfig({ testTimeout: 300_000 })

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))

const compareSides = (golden: Recording, recording: Recording, named: readonly AllowedDifference[]) => compareRecordings(comparableLapse(golden), comparableLapse(recording), named)

const families = scenarios.filter((scenario) => isW43Scenario(scenario.name))
const named = (name: string) => W43_DIFFERENCES.get(name) ?? []
/** Every path the scenario's named differences pin: its raw differences from the golden file must be exactly these. */
const pinnedPaths = (name: string) => named(name).flatMap((difference) => pathsPinnedBy(difference)).sort()
const rawPaths = (golden: Recording, recording: Recording) => compareSides(golden, recording, []).map((difference) => difference.path).sort()
const NOTHING_PAID = 'w36-lapse-sweep-a-booking-with-nothing-paid-is-cancelled'
const NOT_DUE = 'w36-lapse-sweep-leaves-a-booking-whose-deadline-has-not-passed'

describe("step F's side of the replay: the lapse sweep (W43)", () => {
  let environment: ReplayEnvironment
  beforeAll(async () => {
    process.env.STAFF_API_KEY = 'test-staff-api-key'
    environment = await startReplay()
    holder.db = environment.database.db
  })
  afterAll(() => environment.stop())

  const scenario = (name: string): Scenario => {
    const found = scenarios.find((one) => one.name === name)
    if (!found) throw new Error(`No scenario ${name}`)
    return found
  }
  const golden = (name: string) => readGolden(name) as Recording
  const swept = async (name: string, options: LapseSideOptions = {}, tamper?: (db: Db) => Promise<void>) => {
    const runs: LapseSweepResult[] = []
    const recording = await replay(environment, scenario(name), newLapseSide({ ...options, runs }), tamper ? { tamper } : {})
    return { recording, runs }
  }
  const sweepRows = (recording: Recording) => ((recording.tables['audit_log']?.added ?? []) as Row[]).filter((row) => W43_AUDIT_ROWS.has(String(row['action'])) && row['actor_type'] === 'system')

  describe.each(families.map((one) => [one.name, one] as const))('%s', (name, one) => {
    it("the database's sweep still replays its golden file exactly; the Worker's sweep on the same seed matches it with its named differences only; its audit rows are right; it calls Stripe for nothing", async () => {
      expect(golden(name), `No golden file for ${name}`).not.toBeNull()
      // The old side: the database's own sweep, as recorded (the scenario's sweep is the side's, or the database's).
      expect(compareRecordings(golden(name), await replay(environment, one, oldSide), [])).toEqual([])
      const { recording, runs } = await swept(name)
      if (process.env.W43_DIFFERENCES_OUT) {
        appendFileSync(
          process.env.W43_DIFFERENCES_OUT,
          `${JSON.stringify({ name, runs, differences: compareSides(golden(name), recording, []), unnamed: compareSides(golden(name), recording, named(name)), rows: lapseRowProblems(recording), audit: recording.tables['audit_log']?.added ?? [] })}\n`
        )
        return
      }
      // The sweep ran once, as the Worker's, and nothing failed or was left.
      expect(runs).toHaveLength(1)
      expect(runs[0]).toMatchObject({ ran: true, left: 0, failed: 0, more: false })
      expect(lapseRowProblems(recording), `${name}: the sweep's audit rows`).toEqual([])
      expect(compareSides(golden(name), recording, named(name))).toEqual([])
      // Every pinned path differs, and nothing else does: a pin whose path went back to the golden value fails here.
      expect(rawPaths(golden(name), recording)).toEqual(pinnedPaths(name))
      // The golden file's Stripe calls are the order's alone, and the sweep adds none (compared above); none is a refund.
      expect(recording.stripeCalls.some((call) => /refund/i.test(String(call.method)))).toBe(false)
      expect(sweepRows(recording).every((row) => row['request_id'] === REPLAY_SWEEP_REQUEST)).toBe(true)
    })
  })

  it('the family is whole: the four lapse recordings of W36, two matching their golden files exactly and two with one named difference each (FB18, FB19), every one for a scenario that exists', () => {
    expect(families.map((one) => one.name).sort()).toEqual([DECISION_SCENARIOS.FB18, DECISION_SCENARIOS.FB19, NOTHING_PAID, NOT_DUE].sort())
    expect(families.filter((one) => !W43_DIFFERENCES.has(one.name)).map((one) => one.name).sort()).toEqual([NOTHING_PAID, NOT_DUE].sort())
    expect(W43_DIFFERENCES.size).toBe(2)
    expect([...W43_DIFFERENCES.keys()].every((name) => families.some((one) => one.name === name))).toBe(true)
    // Every recording W36 made of the database's sweep is in the family.
    expect(scenarios.filter((one) => /^w36-/.test(one.name) && /lapse-sweep/.test(one.name)).map((one) => one.name).sort()).toEqual(families.map((one) => one.name).sort())
  })

  it('FB18 and FB19 are each named, with Q48, on their own scenarios', () => {
    const NAMES = { FB18: /^Wayne's Q48 \(bug FB18, N8, is closed\)/, FB19: /^Wayne's Q48 \(bug FB19 is closed\)/ }
    const DECISIONS = { FB18: /^Wayne's Q48, 15 Nov .*bug FB18 \(F-plan section 3\); N8/, FB19: /^Wayne's Q48, 15 Nov .*bug FB19 \(F-plan section 3/ }
    for (const what of ['FB18', 'FB19'] as const) {
      const own = named(DECISION_SCENARIOS[what])
      expect(own, what).toHaveLength(1)
      expect(own[0]?.name, what).toMatch(NAMES[what])
      expect(own[0]?.decision, what).toMatch(DECISIONS[what])
    }
    expect(families.filter((one) => /^w36-fb/.test(one.name)).map((one) => one.name).sort()).toEqual([DECISION_SCENARIOS.FB18, DECISION_SCENARIOS.FB19].sort())
  })

  it("a booking with nothing paid: every row the Worker's sweep leaves is the row the database's left (the booking with its reason and cancel time set, its session, its order and lines), and only the two audit rows are new", async () => {
    const { recording, runs } = await swept(NOTHING_PAID)
    expect(runs[0]).toMatchObject({ lapsed: 1, storeCreditRefunded: 0 })
    // With nothing set aside, the whole difference from the golden file is the audit table.
    expect(compareRecordings(golden(NOTHING_PAID), recording, []).map((difference) => difference.path)).toEqual(['.tables.audit_log'])
    expect(recording.tables['bookings']).toEqual(golden(NOTHING_PAID).tables['bookings'])
    expect(recording.tables['bookings']?.added[0]).toMatchObject({ status: 'cancelled', cancel_reason: 'membership_lapsed', cancelled_at: '<set>', price_paid: '0.00' })
    expect(recording.tables['sessions']).toBeUndefined()
    expect(sweepRows(recording).map((row) => row['action']).sort()).toEqual(['booking.cancel_credit', BOOKING_LAPSED])
    expect(recording.tables['audit_log']?.added).toHaveLength(2)
  })

  it("an allowance that is not needed fails: FB18's on the scenario with nothing paid, and FB19's on FB18's", async () => {
    const plain = (await swept(NOTHING_PAID)).recording
    expect(compareSides(golden(NOTHING_PAID), plain, named(DECISION_SCENARIOS.FB18)).map((difference) => difference.path)).toEqual([expect.stringMatching(/^\(allowed difference not seen: Wayne's Q48 \(bug FB18/)])
    const fb18 = (await swept(DECISION_SCENARIOS.FB18)).recording
    const both = compareSides(golden(DECISION_SCENARIOS.FB18), fb18, [...named(DECISION_SCENARIOS.FB18), ...named(DECISION_SCENARIOS.FB19)]).map((difference) => difference.path)
    expect(both).toEqual([expect.stringMatching(/^\(allowed difference not seen: Wayne's Q48 \(bug FB19/)])
    // And without its allowance, each named scenario's differences show: nine paths for FB18, six for FB19.
    expect(rawPaths(golden(DECISION_SCENARIOS.FB18), fb18)).toEqual(pinnedPaths(DECISION_SCENARIOS.FB18))
    expect(pinnedPaths(DECISION_SCENARIOS.FB18)).toHaveLength(9)
    expect(rawPaths(golden(DECISION_SCENARIOS.FB19), (await swept(DECISION_SCENARIOS.FB19)).recording)).toEqual(pinnedPaths(DECISION_SCENARIOS.FB19))
    expect(pinnedPaths(DECISION_SCENARIOS.FB19)).toHaveLength(6)
    expect(pinnedPaths(NOTHING_PAID)).toEqual([])
  })

  it("a planted difference is caught: on a row the golden file holds, on a pinned value, and on the sweep's own audit rows", async () => {
    const planted: Array<readonly [string, string, 'compare' | 'rows' | 'pins', RegExp]> = [
      // [scenario, statement, where it must show, the path or problem]
      [NOTHING_PAID, "UPDATE bookings SET cancel_reason = 'lapsed'", 'compare', /^\.tables\.bookings\.added\[0\]\.cancel_reason$/],
      [NOTHING_PAID, 'UPDATE sessions SET total_booked = total_booked + 1', 'compare', /^\.tables\.sessions$/],
      [NOTHING_PAID, "UPDATE bookings SET status = 'payment_needed'", 'compare', /^\.tables\.bookings\.added\[0\]\.status$/],
      [DECISION_SCENARIOS.FB18, 'UPDATE store_credit_transactions SET amount = 40, balance_after = 40', 'compare', /^\.tables\.store_credit_transactions$/],
      [DECISION_SCENARIOS.FB18, 'UPDATE customers SET store_credit_balance = 40 WHERE store_credit_balance = 20', 'compare', /^\.tables\.customers$/],
      [DECISION_SCENARIOS.FB18, 'UPDATE sessions SET total_booked = 1', 'compare', /^\.tables\.sessions/],
      [DECISION_SCENARIOS.FB18, 'UPDATE store_credit_transactions SET staff_id = (SELECT id FROM staff LIMIT 1)', 'compare', /^\.tables\.store_credit_transactions$/],
      [DECISION_SCENARIOS.FB19, "UPDATE addon_order_lines SET refund_method = 'card'", 'compare', /^\.tables\.addon_order_lines\.added\[0\]\.refund_method$/],
      // A pinned path put back to the golden value (the towel line not removed after all): the allowance is still used
      // by its other paths, so only the check that every pinned path differs sees it.
      [DECISION_SCENARIOS.FB19, 'UPDATE addon_order_lines SET removed_at = NULL', 'pins', /^missing: \.tables\.addon_order_lines\.added\[0\]\.removed_at$/],
      [DECISION_SCENARIOS.FB18, "UPDATE orders SET payment_status = 'paid'", 'pins', /^missing: \.tables\.orders\.added\[0\]\.payment_status$/],
      [NOTHING_PAID, `DELETE FROM audit_log WHERE action = '${BOOKING_LAPSED}'`, 'rows', /0 booking\.lapsed rows for 1 bookings/],
      [NOTHING_PAID, `UPDATE audit_log SET actor_type = 'staff', actor_id = 'x' WHERE action = '${BOOKING_LAPSED}'`, 'compare', /^\.tables\.audit_log/],
      [NOTHING_PAID, `UPDATE audit_log SET details = details - 'kept' WHERE action = '${BOOKING_LAPSED}'`, 'rows', /booking\.lapsed: fields/],
      [NOTHING_PAID, `UPDATE audit_log SET details = details || '{"channel": "staff"}'::jsonb WHERE action = 'booking.cancel_credit'`, 'rows', /the cancel row is not the system's/],
      [DECISION_SCENARIOS.FB18, `UPDATE audit_log SET details = jsonb_set(details, '{storeCreditRefunded}', '0') WHERE action = '${BOOKING_LAPSED}'`, 'rows', /store credit rows of 2000p for 0p/],
      [DECISION_SCENARIOS.FB18, `UPDATE audit_log SET details = jsonb_set(details, '{method}', '"card"') WHERE action = 'booking.refund_claimed'`, 'rows', /booking\.lapsed: the claim/],
      [DECISION_SCENARIOS.FB18, "DELETE FROM audit_log WHERE action = 'booking.refund_finished'", 'rows', /1 claims and 0 finished rows/],
    ]
    for (const [name, statement, where, expected] of planted) {
      const { recording } = await swept(name, {}, async () => {
        await environment.database.pg.exec(`RESET ROLE; ${statement}; SET ROLE paddock_worker;`)
      })
      const raw = rawPaths(golden(name), recording)
      const found =
        where === 'compare'
          ? compareSides(golden(name), recording, named(name)).map((difference) => difference.path)
          : where === 'rows'
            ? lapseRowProblems(recording)
            : pinnedPaths(name).filter((path) => !raw.includes(path)).map((path) => `missing: ${path}`)
      expect(found.some((line) => expected.test(line)), `${name}: ${statement} -> ${JSON.stringify(found)}`).toBe(true)
    }
  })

  it("the kind off: the Worker's sweep changes nothing on any of the four seeds (no row of its own), and with the database's sweep run after it each matches its golden file exactly: the database stays in charge", async () => {
    for (const one of families) {
      const off = await swept(one.name, { orderSwitch: 'no_stripe,saved_card,reader,membership,booking_changes,reader_flows' })
      expect(off.runs).toEqual([{ ran: false, lapsed: 0, left: 0, failed: 0, storeCreditRefunded: 0, more: false, items: [] }])
      expect(sweepRows(off.recording)).toEqual([])
      expect(off.recording.tables['bookings']?.added[0]).toMatchObject({ status: 'payment_needed', cancel_reason: null })
      const both = await swept(one.name, { orderSwitch: null, database: 'after' })
      expect(compareRecordings(golden(one.name), both.recording, []), one.name).toEqual([])
    }
  })

  it("both in charge for a while (the kind on, before migration 028): whichever runs first, a booking with nothing paid ends as its golden file, cancelled once with its place released once, and FB18's booking is lapsed by the Worker's alone", async () => {
    // The database's first: the Worker's finds nothing due, and writes nothing.
    const databaseFirst = await swept(NOTHING_PAID, { database: 'first' })
    expect(databaseFirst.runs[0]).toMatchObject({ ran: true, lapsed: 0, left: 0, items: [] })
    expect(compareRecordings(golden(NOTHING_PAID), databaseFirst.recording, [])).toEqual([])
    // The Worker's first: the database's finds it cancelled.
    const workerFirst = await swept(NOTHING_PAID, { database: 'after' })
    expect(workerFirst.runs[0]).toMatchObject({ lapsed: 1 })
    expect(lapseRowProblems(workerFirst.recording)).toEqual([])
    expect(compareSides(golden(NOTHING_PAID), workerFirst.recording, [])).toEqual([])
    for (const database of ['first', 'after'] as const) {
      const fb18 = await swept(DECISION_SCENARIOS.FB18, { database })
      expect(fb18.runs[0]).toMatchObject({ lapsed: 1, storeCreditRefunded: 20 })
      expect(lapseRowProblems(fb18.recording)).toEqual([])
      expect(compareSides(golden(DECISION_SCENARIOS.FB18), fb18.recording, named(DECISION_SCENARIOS.FB18))).toEqual([])
    }
  })

  it("why migration 028 follows the switch: while the database's sweep still runs, it can reach FB19's booking first, and then the £5 is kept as before (the golden file exactly); the Worker's first gives it back", async () => {
    const databaseFirst = await swept(DECISION_SCENARIOS.FB19, { database: 'first' })
    expect(databaseFirst.runs[0]).toMatchObject({ lapsed: 0, items: [] })
    expect(compareRecordings(golden(DECISION_SCENARIOS.FB19), databaseFirst.recording, [])).toEqual([])
    const workerFirst = await swept(DECISION_SCENARIOS.FB19, { database: 'after' })
    expect(workerFirst.runs[0]).toMatchObject({ lapsed: 1, storeCreditRefunded: 5 })
    expect(compareSides(golden(DECISION_SCENARIOS.FB19), workerFirst.recording, named(DECISION_SCENARIOS.FB19))).toEqual([])
  })

  it('the invariants hold on both sides of the family', async () => {
    const fresh = await sweepInvariants(environment, families, newLapseSide())
    expect(fresh.wrong).toEqual([])
    const old = await sweepInvariants(environment, families, oldSide)
    expect(old.wrong).toEqual([])
  })
})
