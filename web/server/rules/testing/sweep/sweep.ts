import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { compareRecordings, type Recording } from '../replay/compare'
import { watchedForInvariants, WORKER_EXCEPTIONS, type InvariantExceptions, type InvariantSweep } from '../replay/invariants'
import { scenarios } from '../replay/scenarios'
import { w48Scenarios } from '../replay/w48-scenarios'
import { answeredStampProblems, type AnsweredPlanExtra, type AnsweredStamp } from './admin-presses'
import { sweepDb } from './db-holder'
import { W12_FLOW_SCENARIOS } from './flow-presses'
import { gBreaches, readGState, STAFF_WRITES, staffHoldersProblems } from './g-invariants'
import { NAMED_BREACHES } from './named-breaches'
import { asPressedNow, NEW_SIDE_CONFIRMS, REFUSED_PRESSES_AS_ANSWERS, REFUSED_READS_AS_ANSWERS, REPEATED_PRESS_SCENARIOS } from './press-forms'
import { readRecording, replay, startReplay, writeRecording, type ReplayEnvironment, type ReplayOptions, type Scenario } from './run'
import { workerSide, type WorkerSideOptions } from './worker'

/*
 * W64 (H-plan 3.1, 3.3 step 3; lead call L-H2): the all-Worker sweep. Every scenario the old replay recorded (scenarios.ts
 * with W27's and W36's, W12's reader flows, W48's step G recordings) runs on the Worker alone (worker.ts), from the same
 * seed, as each screen presses it. On each: the W05 invariants (replay/invariants.ts), G-plan 4.9 item 5's
 * (g-invariants.ts), the stamps set aside checked for their form, and then a comparison with its own recording in
 * `testing/recordings/`, made from the Worker once the bridge check held it to the golden files (W64 report). A
 * deliberate change re-records with `UPDATE_RECORDINGS=1` and the diff is read before it is kept.
 *
 * Split into files by family (sweep-*.test.ts, each naming its scenarios by prefix in SWEEP_FILES) so no file nears its
 * time limit; `coverage.test.ts` holds that every scenario is in exactly one file.
 */

/** Every scenario the sweep runs, in the order the old replay had them. */
export const SWEEP_SCENARIOS: readonly Scenario[] = [...scenarios, ...W12_FLOW_SCENARIOS, ...w48Scenarios()]

/** W64a item 1: the rule test file holding the next step on money owed, made on the Worker (each test named after its scenario). */
const OWED_NEXT = 'bookings/money-owed-next-steps.test.ts, the test named after this scenario'

/**
 * Scenarios only the old code can run, dropped from the sweep (H-plan 3.3 step 3), each with where its decided
 * behaviour is held in a rule test (briefs/W64-report.md lists them too).
 */
export const DROPPED: Readonly<Record<string, string>> = {
  // GB24 (W51): generateUpcomingSessions was deleted, not moved; nothing on the Worker answers for it. The nightly job
  // alone makes sessions.
  // Its "who may" recording stays in the sweep: each press is attempted, and each is refused with no function to load.
  'w48-gb24-generate-upcoming-sessions-is-dead-code-that-still-runs': 'GB24: server/rules/testing/sweep/dropped.test.ts (no such function in the staff app; no route; the job makes sessions: sessions/admin.test.ts)',
  // GB15 (W61): the scenario calls the legacy catalogue routes straight through paddockBackendApi2, which W61 removed;
  // every Worker route checks the staff member first (GB14).
  'w48-gb15-the-legacy-route-takes-the-shared-key-and-asks-no-staff-member': 'GB15: server/rules/testing/sweep/dropped.test.ts (no /api/catalog route in app/; an inactive account is refused setProductActive)',
  // GB24 too: the "who may" recording of the same deleted function. Each press reached the all-Worker side's own words
  // ("no press for generateUpcomingSessions"), so it recorded the harness, not the Worker (W64 review S5).
  'w48-generate-upcoming-sessions-who-may': 'GB24: server/rules/testing/sweep/dropped.test.ts (no such function in the staff app; no route; the job makes sessions: sessions/admin.test.ts)',
  // W05g's and W05h's money owed, set up on the old side (scenarios.ts onTheOldSide, fortyOwed, fortyLanded: a cheaper
  // move whose store credit failed or couldn't be told). On the Worker a move is one transaction, so that setup leaves
  // nothing owed. W64a item 1 (W64 review S1): money owed is still reached on the Worker, by a card refund Stripe never
  // got, so each next step is held in the rule test named, which makes it that way and holds the figures booking-replay
  // accepted. They stay dropped rather than rebuilt here: scenarios.ts is still the old replay's until W65, and a
  // different setup would no longer match the golden files there.
  ...Object.fromEntries(
    (
      [
        ['owed-then-a-same-price-move', OWED_NEXT],
        ['owed-then-a-dearer-move', OWED_NEXT],
        ['owed-then-a-dearer-move-then-cancel', OWED_NEXT],
        ['owed-with-nothing-left-then-a-same-price-move', OWED_NEXT],
        ['owed-public-then-a-same-price-move', OWED_NEXT],
        ['owed-then-a-guest-same-tier', OWED_NEXT],
        ['owed-then-a-guest-higher-tier', OWED_NEXT],
        ['owed-then-remove-guest-stops-at-what-is-left', OWED_NEXT],
        ['refund-the-rest-while-a-reader-move-is-open', OWED_NEXT],
        ['owed-arrived-then-a-same-price-move', OWED_NEXT],
        ['figures-with-money-owed', OWED_NEXT],
        ['owed-then-cancel', 'bookings/cancel.test.ts: "money owed from an earlier unclear refund is included once: the cancel gives what is left and what is owed, never the gone part twice"'],
        ['owed-then-cancel-write-fails', 'bookings/cancel.test.ts: "N4: a database fault after the cancel (the places) changes nothing" and "Cancel & Refund with £5 owed and a credit towel ticked, declined: refund_owed_amount back to 5, …"'],
        ['owed-then-cancel-write-fails-after-part-of-it', "bookings/cancel.test.ts: \"a failure seen while a cancel's refund is being sent waits for it: … the earlier £5 is still put back as owed afterwards (an undo never wipes it out)\""],
        ['refund-the-rest-card-then-store-credit', 'bookings/refunds.test.ts: "Refund the rest: exactly what is owed …, to store credit; never a part refund" and "Refund the rest to the card: the first part refused puts it back as owed"'],
        ['refund-the-rest-fails-partway-then-retried', 'bookings/refunds.test.ts: "Refund the rest to the card: the first part refused puts it back as owed"'],
        ['owed-arrived-after-a-lost-answer', 'bookings/refunds.test.ts: "It already arrived: off the booking, no money moves, a reason required, the amount checked" and "W28 (audit row 31): It already arrived takes part of what is owed; …"'],
        ['owed-arrived-then-cancel', 'bookings/cancel.test.ts: "money owed from an earlier unclear refund is included once: …" and "It already arrived runs on the cancelled booking: what is owed comes off, no money moves"'],
      ] as const
    ).map(([name, where]) => [name, `W05g / W05h money owed (set up on the old side): ${where}`])
  ),
}

/** Which file runs which scenarios: by the first word of the name, as replay/families.ts groups them. */
export const SWEEP_FILES: Readonly<Record<string, (name: string) => boolean>> = {
  orders: (name) => /^w(06|07|07a|08|09|09a|10|11|13)-/.test(name),
  flows: (name) => /^w12-/.test(name),
  'booking-gaps': (name) => /^(w17|w22a|w23a|w24)-/.test(name),
  refunds: (name) => /^w27-/.test(name),
  accounts: (name) => /^w36-/.test(name),
  'step-g-1': (name) => /^w48-/.test(name) && name < 'w48-gb',
  'step-g-2': (name) => /^w48-/.test(name) && name >= 'w48-gb' && name < 'w48-p',
  'step-g-3': (name) => /^w48-/.test(name) && name >= 'w48-p',
  'w05-q': (name) => /^(q[0-9]+|p[0-9]+)-/.test(name),
  'w05-rest': (name) => !/^(w\d+[a-z]?|q[0-9]+|p[0-9]+)-/.test(name) || /^w05l-/.test(name),
}

/**
 * What differs by chance between two runs of the same scenario on the Worker, kept in place and in form but not in
 * value: a stored press's `request_hash` (a SHA-256 of a body that names new ids), and a stamp's fingerprint (an MD5 of
 * a row whose id is new each run), and the order of a set of rows' stamps (listed by id: `<row>@<stamp>,...`), and a
 * gift card code that no row is left to label (a cancelled order's stored answer). Everything else in a recording is
 * compared exactly. The golden files never held any of them (the old code wrote no press rows and answered no stamps).
 */
const SHA_256 = /^[0-9a-f]{64}$/
const STAMP_HASH = /#[0-9a-f]{32}\b/g
const STAMP_SET = /^[^,@]+@[^,@]+(,[^,@]+@[^,@]+)+$/
const GIFT_CARD_CODE = /\bPWC-[A-Z0-9]{8}\b/g
const steadyText = (value: string): string => {
  if (SHA_256.test(value)) return '<sha-256>'
  const text = value.replace(STAMP_HASH, '#<md5>').replace(GIFT_CARD_CODE, '<gift card code>')
  return STAMP_SET.test(text) ? text.split(',').sort().join(',') : text
}
export function steadied(recording: Recording): Recording {
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return steadyText(value)
    if (Array.isArray(value)) return value.map(walk)
    if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, walk(inner)]))
    return value
  }
  return { ...recording, results: walk(recording.results) as unknown[], stripeCalls: walk(recording.stripeCalls) as Recording['stripeCalls'], tables: walk(recording.tables) as Recording['tables'] }
}

/** The all-Worker side's options for a scenario: the forms its family pressed it in (press-forms.ts). */
export function sideOptionsFor(name: string): WorkerSideOptions {
  const confirms = NEW_SIDE_CONFIRMS[name]
  return {
    ...(confirms ? { confirms } : {}),
    ...(REPEATED_PRESS_SCENARIOS.has(name) ? { repeatedPress: true } : {}),
    ...(REFUSED_READS_AS_ANSWERS.has(name) ? { refusedReadsAsAnswers: true } : {}),
    ...(REFUSED_PRESSES_AS_ANSWERS.has(name) ? { refusedPressesAsAnswers: true } : {}),
  }
}

export interface SweptScenario {
  recording: Recording
  /** Every invariant breach and every stamp of the wrong form. */
  problems: string[]
  /** The W05 exceptions used (replay/invariants.ts, WORKER_EXCEPTIONS): `<list name>/<scenario>`. */
  exceptionsUsed: string[]
}

/**
 * W64a item 4 (W64 review S3): every W05 exception the Worker's lists give the scenarios in `names`, as
 * `<list name>/<scenario>`: what a sweep file must use, exactly.
 */
export function exceptionsListedFor(names: readonly string[], exceptions: InvariantExceptions = WORKER_EXCEPTIONS): string[] {
  const lists = { stripeRefundsNotOnRows: exceptions.stripeRefundsNotOnRows, cancelledWithoutAllTheMoney: exceptions.cancelledWithoutAllTheMoney, chargesNotOnOneOrder: exceptions.chargesNotOnOneOrder }
  return Object.entries(lists)
    .flatMap(([kind, list]) => Object.keys(list).filter((name) => names.includes(name)).map((name) => `${kind}/${name}`))
    .sort()
}

/** One scenario through the Worker alone, with every check on what it leaves. `extra` plants a deliberate difference. */
export async function sweepOne(
  environment: ReplayEnvironment,
  scenario: Scenario,
  extra: { side?: WorkerSideOptions; replay?: ReplayOptions; exceptions?: InvariantExceptions } = {}
): Promise<SweptScenario> {
  const invariants: InvariantSweep = { wrong: [], needed: new Set<string>(), bookingsChecked: 0 }
  const watched = watchedForInvariants(asPressedNow(scenario), invariants, extra.exceptions ?? WORKER_EXCEPTIONS)
  const g: string[] = []
  const checked: Scenario = {
    ...watched,
    async run(context) {
      const before = await readGState(context.db, context.stripe)
      await watched.run(context)
      g.push(...(await gBreaches(context.db, context.stripe, before)))
    },
  }
  const stamps: AnsweredStamp[] = []
  const planExtras: AnsweredPlanExtra[] = []
  const side = workerSide({ ...sideOptionsFor(scenario.name), stamps, planExtras, ...extra.side })
  // G-plan 4.9 item 5's sixth: a staff press never takes away the last active admin or Manage pricing holder. Read
  // around each staff press, as the scenarios themselves change staff rows by hand (a "who may" recording's inactive
  // account, say), which no press did.
  const watchedSide: typeof side = (db, stripe) => {
    const inner = side(db, stripe)
    return {
      ...inner,
      async call(action, params) {
        if (!STAFF_WRITES.has(action)) return inner.call(action, params)
        const before = await readGState(db, stripe)
        const answer = await inner.call(action, params)
        g.push(...(await staffHoldersProblems(db, stripe, before, action)))
        return answer
      },
    }
  }
  const recording = await replay(environment, checked, watchedSide, { readRedemptionsInOrder: true, ...extra.replay })
  return {
    recording: steadied(recording),
    problems: [...invariants.wrong, ...g, ...answeredStampProblems(stamps).map((one) => `a stamp of the wrong form: ${one}`)],
    exceptionsUsed: [...invariants.needed],
  }
}

function dumpForReading(dir: string, recording: Recording, problems: readonly string[]): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, `${recording.scenario}.json`), `${JSON.stringify({ ...recording, problems }, null, 2)}\n`)
}

/** The vitest suite for one file of the sweep. */
export function sweepFile(file: string): void {
  const inFile = SWEEP_FILES[file]
  if (!inFile) throw new Error(`No sweep file ${file}`)
  const list = SWEEP_SCENARIOS.filter((scenario) => inFile(scenario.name) && !(scenario.name in DROPPED))
  vi.setConfig({ testTimeout: 120_000 })

  describe(`the all-Worker sweep: ${file} (${list.length} scenarios)`, () => {
    let environment: ReplayEnvironment
    beforeAll(async () => {
      process.env.STAFF_API_KEY = 'test-staff-api-key'
      environment = await startReplay()
      sweepDb.db = environment.database.db
    })
    afterAll(() => environment.stop())

    const used: string[] = []
    const swept: string[] = []
    it.each(list.map((scenario) => scenario.name))('%s: the invariants hold, and it does what its recording says', async (name) => {
      const scenario = list.find((one) => one.name === name) as Scenario
      const { recording, problems, exceptionsUsed } = await sweepOne(environment, scenario)
      used.push(...exceptionsUsed)
      swept.push(name)
      // Investigating a failure: every recording and its problems, whatever they are, in a folder of your choosing.
      if (process.env.SWEEP_DUMP_DIR) dumpForReading(process.env.SWEEP_DUMP_DIR, recording, problems)
      expect(problems).toEqual([...(NAMED_BREACHES[name]?.lines ?? [])])
      if (process.env.UPDATE_RECORDINGS === '1') {
        writeRecording(recording)
        return
      }
      const kept = readRecording(name)
      expect(kept, `No recording for ${name}: run with UPDATE_RECORDINGS=1 and read the diff`).not.toBeNull()
      expect(compareRecordings(kept as Recording, recording)).toEqual([])
    })

    // W64a item 4 (W64 review S3; w05d.test.ts held the old side the same way): after this file's scenarios, the W05
    // exceptions they used are exactly the Worker's lists' entries for them. One listed and not used is stale (it could
    // hide a new breach); one needed and not listed fails its scenario above as a breach.
    it('the W05 exceptions these scenarios used are exactly the ones listed for them (WORKER_EXCEPTIONS)', () => {
      expect(swept.sort()).toEqual(list.map((scenario) => scenario.name).sort())
      expect([...new Set(used)].sort()).toEqual(exceptionsListedFor(swept))
    })
  })
}
