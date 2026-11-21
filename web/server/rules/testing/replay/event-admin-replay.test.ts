import { appendFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Db } from '@/server/db'
import { CHANGED_SINCE_WORDS } from '@/server/rules/admin/stamp'
import { EVENT_ADMIN_NEW_WORDS } from '@/server/rules/events/admin-failure-messages'
import { isW52Scenario, pathsPinnedBy, W52_DECISIONS, W52_DIFFERING, w52Differences } from './admin-differences'
import {
  adminRowProblems,
  adminStoredAnswerProblems,
  answeredStampProblems,
  comparableAdmin,
  newAdminSide,
  STEP_G_ACTIONS_MOVED,
  STEP_G_AUDIT_ROWS,
  W52_ACTIONS,
  W52_FLAG_ROWS,
  W52_FLAGS,
  W52_READS,
  W52_WRITES,
  type AnsweredRefundOpen,
  type AnsweredStamp,
} from './admin-side'
import { compareRecordings, STAFF_SET_TIME_PREFIXES, type AllowedDifference, type Recording, type Row } from './compare'
import { readGolden, replay, startReplay, type ReplayEnvironment, type Scenario } from './harness'
import { ID } from './scenarios'
import { w48Scenarios } from './w48-scenarios'

// W52 (brief "Parity and tests"; G-plan 4.9 items 3 and 4): the event families (W48's recordings of the old functions)
// through the staff app's thin functions and the Worker's routes, as the screens press them. GB14's own recording
// (every read, by an inactive account and by a sign-in with no staff row) is replayed in admin-replay.test.ts, where
// W49 + W54 put it: its named difference now names W52's three reads too.
vi.setConfig({ testTimeout: 300_000 })

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))

const compareSides = (golden: Recording, recording: Recording, named: readonly AllowedDifference[]) => compareRecordings(comparableAdmin(golden), comparableAdmin(recording), named)

const everyStepGScenario = w48Scenarios()
const families = everyStepGScenario.filter((scenario) => isW52Scenario(scenario.name))

type AuditRow = Row & { action?: string; details?: { before?: Record<string, unknown> | null; after?: Record<string, unknown> | null; accepted?: boolean; which?: string; markWaiversSignedInPerson?: boolean; key?: string } }
const auditRowsOf = (recording: Recording): AuditRow[] => (recording.tables['audit_log']?.added ?? []) as AuditRow[]
const ownAuditRows = (recording: Recording): AuditRow[] => auditRowsOf(recording).filter((row) => W52_FLAG_ROWS.has(String(row.action)) || row.action === 'event.details_set' || row.action === 'event.active_set')

describe("step G's side of the replay: Events (W52)", () => {
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
  const named = (name: string): readonly AllowedDifference[] => w52Differences(name, golden(name))
  const runNew = (name: string, options: Parameters<typeof newAdminSide>[0] = {}, replayOptions: Parameters<typeof replay>[3] = {}) => replay(environment, scenario(name), newAdminSide(options), replayOptions)
  const left = (name: string, recording: Recording, allowed: readonly AllowedDifference[] = named(name)) => compareSides(golden(name), recording, allowed).map((difference) => difference.path)
  /** Every path on which a recording differs from its golden file, with nothing allowed. */
  const rawPaths = (name: string, recording: Recording): string[] => left(name, recording, []).sort()
  /** Every path the recording's named differences pin. */
  const pinnedPaths = (name: string): string[] => named(name).flatMap((difference) => [...pathsPinnedBy(difference)]).sort()

  describe.each(families.map((one) => [one.name, one] as const))('%s', (name, one) => {
    it('matches its golden file, with its named differences only; its audit rows, stored answers and stamps are right', async () => {
      const calls: Array<{ action: string; side: 'new' | 'old' }> = []
      const stamps: AnsweredStamp[] = []
      const refundOpen: AnsweredRefundOpen[] = []
      const recording = await replay(environment, one, newAdminSide({ calls, stamps, refundOpen }))
      expect(golden(name), `No golden file for ${name}`).not.toBeNull()
      // Every call of a moved function went through the staff app's thin function and the Worker, and there was one.
      expect(calls.filter((call) => STEP_G_ACTIONS_MOVED.has(call.action)).every((call) => call.side === 'new')).toBe(true)
      expect(calls.some((call) => W52_ACTIONS.has(call.action))).toBe(true)
      if (process.env.W52_DIFFERENCES_OUT) {
        appendFileSync(
          process.env.W52_DIFFERENCES_OUT,
          `${JSON.stringify({ name, differences: compareSides(golden(name), recording, []), unnamed: compareSides(golden(name), recording, named(name)), rows: adminRowProblems(recording), stored: adminStoredAnswerProblems(recording), stamps: answeredStampProblems(stamps), refundOpen, audit: recording.tables['audit_log']?.added ?? [], results: recording.results })}\n`
        )
        return
      }
      expect(adminRowProblems(recording), `${name}: the Worker's audit rows`).toEqual([])
      expect(adminStoredAnswerProblems(recording), `${name}: the stored answers`).toEqual([])
      expect(answeredStampProblems(stamps), `${name}: the stamps`).toEqual([])
      // No recording has a refund still being checked: the attendee list says so of every booking it lists.
      expect(refundOpen.every((one) => one.refundOpen === false), `${name}: refund_open`).toBe(true)
      expect(compareSides(golden(name), recording, named(name))).toEqual([])
      // Every pin bites: what differs from the golden file is exactly the paths its named differences pin, no more
      // and no fewer. (An allowance with several paths is still "seen" when one of them has gone back to what the old
      // code recorded, so the comparison alone would let that through.)
      expect(rawPaths(name, recording)).toEqual(pinnedPaths(name))
    })
  })

  it('the family is whole: every event recording W48 made is replayed here, and every named difference is for a recording that exists', () => {
    expect(families.length).toBe(25)
    // The three reads: 4 recordings. On and off sale: 3. The edit: 6, and GB11's. The three flags: 6 (check-in) and 5 (waivers).
    expect(families.filter((one) => /^w48-(events-read$|event-attendees-read$|todays-events-read)/.test(one.name)).length).toBe(4)
    expect(families.filter((one) => /^w48-event-active-/.test(one.name)).length).toBe(3)
    expect(families.filter((one) => /^w48-event-details-/.test(one.name)).length).toBe(6)
    expect(families.filter((one) => /^w48-gb11-/.test(one.name)).length).toBe(1)
    expect(families.filter((one) => /^w48-event-check-in-/.test(one.name)).length).toBe(6)
    expect(families.filter((one) => /^w48-event-waiver-/.test(one.name)).length).toBe(5)
    expect([W52_READS.size, W52_WRITES.size, W52_FLAGS.size, W52_ACTIONS.size]).toEqual([3, 2, 3, 8])
    expect(W52_DIFFERING.every((name) => families.some((one) => one.name === name))).toBe(true)
    // 17 match their golden files exactly. 8 have named differences.
    expect(W52_DIFFERING.length).toBe(8)
    expect(families.filter((one) => named(one.name).length === 0).map((one) => one.name).sort()).toEqual(
      [
        'w48-event-active-off-and-on',
        'w48-event-active-refused-unfinished-or-cancelled',
        'w48-event-attendees-read',
        'w48-event-check-in-many',
        'w48-event-check-in-refusals',
        'w48-event-check-in-signing-at-the-desk-then-undo',
        'w48-event-details-cleared-while-off-sale',
        'w48-event-details-refused-cancelled-event',
        'w48-event-details-refused-capacity-below-places-booked',
        'w48-event-details-set',
        'w48-event-waiver-an-older-extra-version-is-outstanding',
        'w48-event-waiver-extra-and-both',
        'w48-event-waiver-refusals',
        'w48-event-waiver-standard-signed-and-revoked',
        'w48-events-read',
        'w48-todays-events-read',
        'w48-todays-events-read-nothing-today',
      ].sort()
    )
    expect(Object.keys(W52_DECISIONS).sort()).toEqual(['NOT_A_NUMBER', 'NO_STAFF_ROW', 'Q51', 'UNDO'])
    // W48 review L6 (brief item 13): W52 adds no recording of its own, so no `w52-` prefix is needed for staff-set
    // times; the event recordings are W48's, whose prefix already shows them.
    expect(STAFF_SET_TIME_PREFIXES).toContain('w48-')
    expect(everyStepGScenario.some((one) => one.name.startsWith('w52-'))).toBe(false)
  })

  describe('what the old functions never recorded is now recorded', () => {
    it('an event edit: who, and the date, places, access, prices and cut-off before and after, with the places booked at the time', async () => {
      const recording = await runNew('w48-event-details-set')
      const rows = ownAuditRows(recording)
      expect(rows.map((row) => [row.action, row['actor_type'], row['actor_id'], row['entity_type'], row['entity_id']])).toEqual([
        ['event.details_set', 'staff', ID.staff, 'event', ID.event],
        ['event.details_set', 'staff', ID.staff, 'event', ID.event],
        ['event.details_set', 'staff', ID.staff, 'event', ID.event],
      ])
      const [first] = rows
      expect(first?.details?.before).toMatchObject({ capacity: 10, price_public: '40.00', price_pre_herd: '30.00', price_herd: '20.00', access: 'public', places_booked: 0 })
      expect(first?.details?.after).toMatchObject({ capacity: 14, price_public: '45.00', price_pre_herd: '35.50', price_herd: '0.00', access: 'public', places_booked: 0 })
      expect(Object.keys(first?.details?.after ?? {}).sort()).toEqual(['access', 'capacity', 'ends_at', 'places_booked', 'price_herd', 'price_pre_herd', 'price_public', 'public_release_at', 'refund_cutoff_at', 'starts_at'])
    })

    it('on and off sale: who, and the switch before and after; a refused switch leaves no row', async () => {
      const recording = await runNew('w48-event-active-off-and-on')
      expect(ownAuditRows(recording).map((row) => [row.action, row['actor_id'], row.details?.before?.['active'], row.details?.after?.['active']])).toEqual([
        ['event.active_set', ID.staff, true, false],
        ['event.active_set', ID.staff, false, true],
      ])
      const refused = await runNew('w48-event-active-refused-unfinished-or-cancelled')
      expect(ownAuditRows(refused)).toEqual([])
    })

    it('a check-in: one row for each attendee checked in, saying who and whether the waivers were marked at the desk; an undo its own row; and never a name or an email', async () => {
      const many = await runNew('w48-event-check-in-many')
      // The third press checks Sam in (Alex is refused, two ids are nobody's); the fourth, with the waivers marked, both.
      expect(ownAuditRows(many).map((row) => [row.action, row['entity_type'], row.details?.markWaiversSignedInPerson, typeof row.details?.after?.['checked_in_at']])).toEqual([
        ['event_attendee.checked_in', 'event_attendee', false, 'string'],
        ['event_attendee.checked_in', 'event_attendee', true, 'string'],
        ['event_attendee.checked_in', 'event_attendee', true, 'string'],
      ])
      const desk = await runNew('w48-event-check-in-signing-at-the-desk-then-undo')
      const rows = ownAuditRows(desk)
      expect(rows.map((row) => row.action)).toEqual(['event_attendee.checked_in', 'event_attendee.check_in_undone'])
      expect(rows[0]?.details?.after).toMatchObject({ waiver_accepted: true, waiver_method: 'in_person', waiver_version: 'v1', extra_waiver_state: 'accepted', event_waiver_method: 'in_person' })
      // Undone: not checked in, and the waivers signed at the desk stay signed.
      expect(rows[1]?.details?.after).toMatchObject({ checked_in_at: null, waiver_accepted: true, extra_waiver_state: 'accepted' })
      expect(rows.every((row) => row['actor_id'] === ID.staff)).toBe(true)
      expect(JSON.stringify([...ownAuditRows(many), ...rows])).not.toMatch(/Sam Test|Alex Guest|@example\.com/)
    })

    it('a waiver: who, which waiver and which way, how it was signed and against which version', async () => {
      const recording = await runNew('w48-event-waiver-extra-and-both')
      expect(ownAuditRows(recording).map((row) => [row.action, row.details?.which, row.details?.accepted, row.details?.after?.['extra_waiver_state'], row.details?.after?.['event_waiver_method'], row.details?.after?.['waiver_method']])).toEqual([
        ['event_attendee.waiver_set', 'extra', true, 'accepted', 'in_person', null],
        ['event_attendee.waiver_set', 'extra', false, 'pending', null, null],
        ['event_attendee.waiver_set', 'both', true, 'accepted', 'email_link', 'email_link'],
      ])
      expect(ownAuditRows(recording).every((row) => typeof row.details?.key === 'string')).toBe(true)
    })

    it("a refused press leaves no row: GB11's two refused edits, and every refusal recording, write none of W52's rows", async () => {
      for (const name of ['w48-gb11-cut-off-date-and-prices-change-after-places-are-sold', 'w48-event-details-refusals', 'w48-event-waiver-refusals', 'w48-event-check-in-refusals']) {
        const recording = await runNew(name)
        expect(ownAuditRows(recording), name).toEqual([])
        expect(auditRowsOf(recording).filter((row) => STEP_G_AUDIT_ROWS.has(String(row['action'])) && String(row['action']).startsWith('event')), name).toEqual([])
      }
    })
  })

  describe('Q51 and the stale-page rule, on the recordings', () => {
    it("GB11's recording: both edits are refused in Q51's words, with the earliest cut-off allowed, and the event keeps its date, price and cut-off", async () => {
      const name = 'w48-gb11-cut-off-date-and-prices-change-after-places-are-sold'
      const recording = await runNew(name)
      const words = EVENT_ADMIN_NEW_WORDS.cutoffEarlier('Mon 30 Nov 2026, 7:00 pm')
      expect(recording.results[1]).toEqual({ updated: false, reason: 'cutoff_earlier', message: words })
      expect(recording.results[2]).toEqual({ updated: false, reason: 'cutoff_earlier', message: words })
      expect(words).toBe("Places are already booked on this event, so the refund cut-off can't be made earlier: customers keep at least the cut-off they booked under. The earliest it can be is Mon 30 Nov 2026, 7:00 pm.")
      expect(left(name, recording)).toEqual([])
      // The allowance is pinned to those words: any others on that step are a difference.
      const reworded: Recording = { ...recording, results: recording.results.map((result, i) => (i === 1 ? { updated: false, reason: 'cutoff_earlier', message: 'No.' } : result)) }
      expect(left(name, reworded)).toEqual(['.results[1].message'])
    })

    it('an edit pressed with no stamp (a page that read nothing first) is refused `changed_since`, and nothing is written: the recording\'s own edit, sent as the golden file has it', async () => {
      const name = 'w48-event-details-set'
      const recording = await runNew(name, { pressWithoutReading: true })
      expect(recording.results.slice(0, 3)).toEqual([
        { updated: false, reason: 'changed_since', message: CHANGED_SINCE_WORDS },
        { updated: false, reason: 'changed_since', message: CHANGED_SINCE_WORDS },
        { updated: false, reason: 'changed_since', message: CHANGED_SINCE_WORDS },
      ])
      expect(recording.tables['events']).toBeUndefined()
      expect(ownAuditRows(recording)).toEqual([])
    })
  })

  describe('a deliberate difference is caught', () => {
    it('in what staff are told: a field dropped from the events list, a price a penny out in a saved edit, a count one out on today\'s events, a waiver state on the attendee list', async () => {
      const list = 'w48-events-read'
      const withoutCutoff = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([field]) => field !== 'refund_cutoff_at'))
      const dropped = await runNew(list, { adjust: (action, answer) => (action === 'getEvents' && Array.isArray(answer) ? (answer as Array<Record<string, unknown>>).map(withoutCutoff) : answer) })
      expect(left(list, dropped).length).toBeGreaterThan(0)
      expect(left(list, dropped).every((path) => path.endsWith('.refund_cutoff_at'))).toBe(true)

      const edit = 'w48-event-details-set'
      const pennyOut = await runNew(edit, {
        adjust: (action, answer) => {
          const saved = answer as { updated?: boolean; event?: Record<string, unknown> }
          return action === 'setEventDetails' && saved.event ? { ...saved, event: { ...saved.event, price_public: '45.01' } } : answer
        },
      })
      expect(left(edit, pennyOut)).toEqual(['.results[0].event.price_public', '.results[1].event.price_public', '.results[2].event.price_public'])

      const today = 'w48-todays-events-read'
      const oneOut = await runNew(today, {
        adjust: (action, answer) => {
          const card = answer as { events?: Array<Record<string, unknown>> }
          return action === 'getTodaysEvents' && card.events?.[0] ? { ...card, events: card.events.map((event) => ({ ...event, checked_in_count: Number(event['checked_in_count']) + 1 })) } : answer
        },
      })
      expect(left(today, oneOut).length).toBeGreaterThan(0)
      expect(left(today, oneOut).every((path) => path.endsWith('.checked_in_count'))).toBe(true)

      const older = 'w48-event-waiver-an-older-extra-version-is-outstanding'
      const readAsSigned = await runNew(older, {
        adjust: (action, answer) => {
          const listed = answer as { bookings?: Array<{ attendees?: Array<Record<string, unknown>> }> }
          if (action !== 'getEventAttendees' || !listed.bookings) return answer
          return { ...listed, bookings: listed.bookings.map((booking) => ({ ...booking, attendees: (booking.attendees ?? []).map((attendee) => (attendee['extra_waiver_state'] === 'older_version' ? { ...attendee, extra_waiver_state: 'accepted' } : attendee)) })) }
        },
      })
      expect(left(older, readAsSigned).some((path) => path.endsWith('.extra_waiver_state'))).toBe(true)
    })

    it('in a row: an edit that lands although it was refused, a check-in that lands anyway on the cancelled booking\'s undo', async () => {
      const gb11 = 'w48-gb11-cut-off-date-and-prices-change-after-places-are-sold'
      const landed = await runNew(gb11, {}, { tamper: async (db) => void (await db.query("UPDATE events SET refund_cutoff_at = '2026-11-10 08:00:00+00' WHERE id = $1", [ID.event])) })
      // The golden file has the cut-off moved (the old code's fault): the allowance is pinned to it NOT having moved.
      expect(left(gb11, landed).some((path) => path.includes('allowed difference not seen'))).toBe(true)

      const undo = 'w48-event-check-in-undo-has-no-checks'
      const cleared = await runNew(undo, {}, { tamper: async (db) => void (await db.query('UPDATE event_attendees SET checked_in_at = NULL')) })
      expect(left(undo, cleared).length).toBeGreaterThan(0)
    })

    it('in what was set aside: a check-in with no audit row, a second row for one waiver, a stamp that is not one', async () => {
      const many = 'w48-event-check-in-many'
      const noRow = await runNew(many, {}, { tamper: async (db) => void (await db.query("DELETE FROM audit_log WHERE id = (SELECT id FROM audit_log WHERE action = 'event_attendee.checked_in' ORDER BY at LIMIT 1)")) })
      expect(adminRowProblems(noRow)).toEqual(['event_attendee.checked_in: 2 rows for 3 attendees checked in'])

      const waiver = 'w48-event-waiver-standard-signed-and-revoked'
      const twice = await runNew(waiver, {}, { tamper: async (db) => void (await db.query("INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, request_id, details) SELECT actor_type, actor_id, action, entity_type, entity_id, request_id, details FROM audit_log WHERE action = 'event_attendee.waiver_set' ORDER BY at LIMIT 1")) })
      expect(adminRowProblems(twice)).toEqual(['event_attendee.waiver_set: 4 rows for 3 presses answered with a success'])

      expect(answeredStampProblems([{ action: 'getEvents', where: '[0].stamp', stamp: 'fields#0123456789abcdef0123456789abcdef' }])).toEqual([])
      expect(answeredStampProblems([{ action: 'getEvents', where: '[0].stamp', stamp: 'fields#' }])).toEqual(['getEvents [0].stamp: "fields#"'])
      expect(answeredStampProblems([{ action: 'setEventDetails', where: 'event.stamp', stamp: undefined }])).toHaveLength(1)
    })

    it('one pin of several put back to what the old code recorded: the comparison alone lets it through, and the pinned paths catch it', async () => {
      // "Check in all" by a sign-in with no staff row: the old code signed the waiver in person and checked the
      // attendee in. Here the waiver's method alone is put back as the old code left it.
      const name = 'w48-event-check-in-many-who-may'
      const putBack = await runNew(name, {}, { tamper: async (db) => void (await db.query("UPDATE event_attendees SET waiver_method = 'in_person' WHERE attendee_type = 'account_holder'")) })
      expect(left(name, putBack)).toEqual([])
      expect(pinnedPaths(name)).toContain('.tables.event_attendees.added[0].waiver_method')
      expect(rawPaths(name, putBack)).not.toContain('.tables.event_attendees.added[0].waiver_method')
      expect(rawPaths(name, putBack)).not.toEqual(pinnedPaths(name))
      // …and untampered, the two are the same.
      expect(rawPaths(name, await runNew(name))).toEqual(pinnedPaths(name))
    })

    it("an allowance nobody needs fails: Q51's on a recording that matches exactly", async () => {
      const exact = 'w48-event-details-set'
      const recording = await runNew(exact)
      expect(left(exact, recording, [])).toEqual([])
      const unneeded = named('w48-gb11-cut-off-date-and-prices-change-after-places-are-sold')
      expect(unneeded).toHaveLength(4)
      expect(left(exact, recording, unneeded)).toEqual(unneeded.map(() => expect.stringContaining('allowed difference not seen')))
    })
  })
})
