import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Db } from '@/server/db'
import type { FakeStripe } from '@/server/stripe/fake'
import { asPressedNow, NEW_SIDE_CONFIRMS, REFUSED_PRESSES_AS_ANSWERS, REFUSED_READS_AS_ANSWERS, REPEATED_PRESS_SCENARIOS } from '../sweep/press-forms'
import { DROPPED, SWEEP_SCENARIOS } from '../sweep/sweep'
import { readRecording } from '../sweep/run'
import { newAccountSide } from './account-side'
import { isW37Scenario } from './account-differences'
import { isW49W54Scenario, isW50Scenario, isW51Scenario, isW52Scenario, isW53Scenario } from './admin-differences'
import { newAdminSide } from './admin-side'
import { newBookingSide } from './booking-side'
import { W53_LABEL_DIFFERENCES } from './booking-label-differences'
import { isW55W56Scenario } from './catalog-differences'
import { compareRecordings, withCanonicalGoneNumbers, withCanonicalStripeIds, type Difference, type Recording, type Row } from './compare'
import { isW39Scenario } from './customer-differences'
import { newCustomerSide } from './customer-side'
import { isEventPlacesScenario } from './event-places-differences'
import { newEventPlacesSide } from './event-places-side'
import { FLOW_SCENARIOS, newFlowSide } from './flow-side'
import { isW38Scenario } from './gift-card-differences'
import { newGiftCardSide } from './gift-card-side'
import { readGolden, replay, startReplay, type ReplayEnvironment, type ReplaySide, type Scenario } from './harness'
import { isW43Scenario } from './lapse-differences'
import { newLapseSide } from './lapse-side'
import { isW40Scenario } from './membership-differences'
import { newMembershipSide } from './membership-side'
import { ORDER_SCENARIOS } from './order-differences'
import { isOrderRefundScenario } from './order-refund-differences'
import { newOrderRefundSide } from './order-refund-side'
import { newOrderSide } from './order-side'
import { isW41Scenario } from './payment-date-differences'
import { newPaymentDateSide } from './payment-date-side'
import { isW57Scenario } from './plan-differences'
import { isWholeEventScenario } from './whole-event-differences'
import { newWholeEventSide } from './whole-event-side'

/*
 * W64 (H-plan 3.3 step 4, brief item 4): the bridge check, run once (`BRIDGE_OUT=<folder>`; skipped otherwise). For each
 * scenario of the all-Worker sweep, its recording (testing/recordings/) is compared with its golden file, and every
 * difference is put in one of three:
 *
 *  - accepted by a family's allowance: the family that moved the action replays the scenario on its own new side here
 *    (setup on the old side, its actions on the Worker), and that recording differs from the golden file at the same
 *    path with the same value. The family's replay test passes with that difference, named or set aside and checked,
 *    so it is a difference its allowances already accept;
 *  - a setup class: the difference comes from running on the Worker a step the family ran on the old code (the
 *    setup): the Worker's own audit and idempotency rows, keys and the metadata that names them, the order's
 *    payment_method stamp, W53's labels, and the answer fields a family sets aside and checks on its own;
 *  - unexplained: anything else. Listed for the review, never re-baselined here.
 *
 * The audit and idempotency rows (the Worker's bookkeeping) are compared as counts by action and by endpoint, not row
 * by row, because a setup the Worker now runs adds its rows at the front and shifts every index after them.
 * Lives with the old replay and goes with it at W65.
 */

vi.setConfig({ testTimeout: 600_000 })

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))
vi.mock('@/server/stripe/client', async (importOriginal) => {
  const { stripeClientMock } = await import('./stripe-binding')
  return stripeClientMock(await importOriginal<typeof import('@/server/stripe/client')>())
})

type MakeSide = (db: Db, stripe: FakeStripe) => ReplaySide
interface Family {
  name: string
  holds: (name: string) => boolean
  side: (name: string) => MakeSide
  /** The scenario as the family pressed it (its told-again and attempted forms). */
  scenario?: (scenario: Scenario) => Scenario
}

const confirmsFor = (name: string) => (input: Parameters<Parameters<typeof newOrderSide>[1] & object>[0]) => {
  const confirms = NEW_SIDE_CONFIRMS[name]
  return confirms ? { ...input, confirmed: { ...input.confirmed, toCollect: confirms.toCollect } } : input
}

/** Every family replay, with the scenarios it replays and the side it replays them on. */
const FAMILIES: readonly Family[] = [
  { name: 'booking-replay (W17 to W24)', holds: (name) => !name.startsWith('w48-') && !name.startsWith('w12-'), side: () => newBookingSide() },
  { name: 'order-replay (W06 to W13)', holds: (name) => ORDER_SCENARIOS.includes(name), side: (name) => newOrderSide([], confirmsFor(name)) },
  { name: 'flow-replay (W12)', holds: (name) => FLOW_SCENARIOS.includes(name) || name.startsWith('w12-'), side: () => newFlowSide() },
  { name: 'order-refund-replay (W28, W29)', holds: isOrderRefundScenario, side: () => newOrderRefundSide() },
  { name: 'event-places-replay (W30)', holds: isEventPlacesScenario, side: () => newEventPlacesSide() },
  { name: 'whole-event-replay (W31)', holds: isWholeEventScenario, side: () => newWholeEventSide() },
  { name: 'account-replay (W37)', holds: isW37Scenario, side: (name) => newAccountSide({ repeatedPress: REPEATED_PRESS_SCENARIOS.has(name) }) },
  { name: 'gift-card-replay (W38)', holds: isW38Scenario, side: (name) => newGiftCardSide({ repeatedPress: REPEATED_PRESS_SCENARIOS.has(name) }) },
  { name: 'customer-replay (W39)', holds: isW39Scenario, side: (name) => newCustomerSide({ refusedReadsAsAnswers: REFUSED_READS_AS_ANSWERS.has(name) }) },
  { name: 'membership-replay (W40)', holds: isW40Scenario, side: () => newMembershipSide() },
  { name: 'payment-date-replay (W41)', holds: isW41Scenario, side: () => newPaymentDateSide() },
  { name: 'lapse-replay (W43)', holds: isW43Scenario, side: () => newLapseSide() },
  { name: 'admin-replay (W49, W54)', holds: isW49W54Scenario, side: (name) => newAdminSide({ refusedReadsAsAnswers: REFUSED_READS_AS_ANSWERS.has(name), stamps: [] }), scenario: asPressedNow },
  { name: 'booking-admin-replay (W50)', holds: isW50Scenario, side: () => newAdminSide({}), scenario: asPressedNow },
  { name: 'session-admin-replay (W51)', holds: isW51Scenario, side: () => newAdminSide({ madeUpTo: [] }), scenario: asPressedNow },
  { name: 'event-admin-replay (W52)', holds: isW52Scenario, side: () => newAdminSide({ stamps: [], refundOpen: [] }) },
  { name: 'order-admin-replay (W53)', holds: isW53Scenario, side: () => newAdminSide({ paidBy: [] }) },
  { name: 'catalog-admin-replay (W55, W56)', holds: isW55W56Scenario, side: (name) => newAdminSide({ stamps: [], refusedPressesAsAnswers: REFUSED_PRESSES_AS_ANSWERS.has(name) }) },
  { name: 'plan-admin-replay (W57)', holds: isW57Scenario, side: (name) => newAdminSide({ stamps: [], planExtras: [], refusedPressesAsAnswers: REFUSED_PRESSES_AS_ANSWERS.has(name) }) },
]

const BOOKKEEPING = new Set(['audit_log', 'api_idempotency'])
const canonical = (recording: Recording): Recording => withCanonicalStripeIds(withCanonicalGoneNumbers(recording))
const withoutBookkeeping = (recording: Recording): Recording => ({ ...recording, tables: Object.fromEntries(Object.entries(recording.tables).filter(([table]) => !BOOKKEEPING.has(table))) })
const counts = (rows: readonly Row[], key: (row: Row) => string): Map<string, number> => {
  const found = new Map<string, number>()
  for (const row of rows) found.set(key(row), (found.get(key(row)) ?? 0) + 1)
  return found
}
const keyOfAudit = (row: Row) => String(row['action'])
const keyOfPress = (row: Row) => `${String(row['endpoint'])} ${String(row['http_status'])}`
const rowsOf = (recording: Recording, table: string): Row[] => recording.tables[table]?.added ?? []
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * The setup classes (brief item 4): a difference here comes from a step the family ran on the old code and the sweep
 * runs on the Worker. Each is narrow: a path and, where it can be, the values.
 */
const LABEL = /^([a-z_]+|gone)#\d+$/
/** A value with every label number masked (`orders#3` and `gone#7` read `orders#*` and `gone#*`; `pi_fake#2` reads `pi_fake#*`). */
const masked = (value: unknown): string => JSON.stringify(value ?? null).replace(/([a-z_]+)#\d+/g, '$1#*')
const SETUP_CLASSES: ReadonlyArray<{ name: string; is: (difference: Difference, scenario: string) => boolean }> = [
  // The order route's own keys and the metadata naming its rows (order-replay's allowances: the key, metadata.order_id).
  { name: "keys: a Stripe call's idempotency key from the Worker's record", is: ({ path }) => /^\.stripeCalls\[\d+\]\.idempotencyKey$/.test(path) },
  {
    name: "keys: a Stripe call's metadata naming the Worker's rows (a label, or the metadata added whole)",
    is: ({ path, actual }) => /^\.stripeCalls\[\d+\]\.params\.metadata(\.[A-Za-z_]+)?$/.test(path) && ((typeof actual === 'string' && LABEL.test(actual)) || (actual !== null && typeof actual === 'object')),
  },
  // Q9 (order-replay): an order the Worker places records its payment_method.
  // order-replay's allowance (W06 to W13): an order the Worker places carries its own record of how it was paid.
  { name: "the order route's own record on an order it placed (reader_payment: method, request, held booking, keys)", is: ({ path }) => /^\.tables\.orders\.added\[\d+\]\.reader_payment(\.|$)/.test(path) },
  // The Worker's extra rows in a setup (its audit and idempotency rows, its stored requests) renumber the labels that
  // follow them: a value equal to the golden file's once label numbers are masked differs only in that numbering.
  { name: 'label numbering only: the same value with every label number masked (the setup\'s own rows renumber what follows)', is: ({ expected, actual }) => masked(expected) === masked(actual) },
  { name: 'payment_method stamps: the order route records how the order was paid (Q9)', is: ({ path }) => /^\.tables\.orders\.(added\[\d+\]|changed\[\d+\])\.payment_method$/.test(path) },
  // W53's labels: an order's status worked out by the Worker's rule (booking-label-differences.ts names each for the families).
  { name: "W53's labels: a label booking-label-differences.ts names for this scenario", is: ({ path }, scenario) => (W53_LABEL_DIFFERENCES.get(scenario) ?? []).some((allowance) => allowance.path.test(path)) },
  // The answer fields a family sets aside and checks on its own (W51 madeUpTo, W52 refund_open, W53 the paid-by label).
  { name: 'answer fields a family sets aside and checks on its own (refund_open, payment_method_label)', is: ({ path, expected }) => /\.(refund_open|payment_method_label)$/.test(path) && expected === undefined },
  {
    name: "W51's calendar read: the sessions with madeUpTo beside them (session-admin-replay sets the date aside)",
    is: ({ path, expected, actual }) => /^\.results\[\d+\]$/.test(path) && Array.isArray(expected) && actual !== null && typeof actual === 'object' && same((actual as { sessions?: unknown }).sessions, expected),
  },
]

interface BridgeLine {
  scenario: string
  path: string
  old: unknown
  new: unknown
  class: string
}

describe.skipIf(!process.env.BRIDGE_OUT)('the bridge check: the sweep\'s recordings against the golden files (W64, run once)', () => {
  let environment: ReplayEnvironment
  const lines: BridgeLine[] = []
  const bookkeeping: Array<{ scenario: string; table: string; key: string; golden: number; family: number; sweep: number; class: string }> = []
  beforeAll(async () => {
    process.env.STAFF_API_KEY = 'test-staff-api-key'
    environment = await startReplay()
    holder.db = environment.database.db
  })
  afterAll(async () => {
    await environment.stop()
    const out = process.env.BRIDGE_OUT as string
    mkdirSync(out, { recursive: true })
    writeFileSync(path.join(out, `bridge-${process.env.BRIDGE_PART ?? 'all'}.json`), `${JSON.stringify({ lines, bookkeeping }, null, 1)}\n`)
  })

  const part = process.env.BRIDGE_PART
  const list = SWEEP_SCENARIOS.filter((scenario) => !(scenario.name in DROPPED)).filter((scenario) => !part || scenario.name.startsWith(part) || (part === 'rest' && !/^w(27|36|48)-/.test(scenario.name)))

  it.each(list.map((scenario) => scenario.name))('%s', async (name) => {
    const scenario = list.find((one) => one.name === name) as Scenario
    const golden = readGolden(name)
    const swept = readRecording(name)
    expect(golden, name).not.toBeNull()
    expect(swept, name).not.toBeNull()
    const G = canonical(golden as Recording)
    const S = canonical(swept as Recording)
    const families = FAMILIES.filter((family) => family.holds(name))
    const familyRecordings: Recording[] = []
    for (const family of families) familyRecordings.push(canonical(await replay(environment, (family.scenario ?? ((one: Scenario) => one))(scenario), family.side(name))))

    // Everything but the bookkeeping, path by path.
    const swDiffs = compareRecordings(withoutBookkeeping(G), withoutBookkeeping(S))
    const famDiffs = familyRecordings.map((N) => compareRecordings(withoutBookkeeping(G), withoutBookkeeping(N)))
    for (const difference of swDiffs) {
      const accepted = famDiffs.findIndex((diffs) => diffs.some((one) => one.path === difference.path && same(one.actual, difference.actual)))
      // The family's own difference at the same path, label numbers aside (the setup's rows renumber the labels).
      const acceptedMasked = accepted >= 0 ? -1 : famDiffs.findIndex((diffs) => diffs.some((one) => one.path === difference.path && masked(one.actual) === masked(difference.actual)))
      const setup = SETUP_CLASSES.find((one) => one.is(difference, name))
      const kind = accepted >= 0 ? `accepted: ${families[accepted]?.name}` : acceptedMasked >= 0 ? `accepted, label numbers aside: ${families[acceptedMasked]?.name}` : setup ? `setup: ${setup.name}` : 'unexplained'
      lines.push({ scenario: name, path: difference.path, old: difference.expected, new: difference.actual, class: kind })
    }
    // The bookkeeping, by count: each action's audit rows and each endpoint's stored answers.
    for (const [table, key] of [['audit_log', keyOfAudit], ['api_idempotency', keyOfPress]] as const) {
      const g = counts(rowsOf(G, table), key)
      const s = counts(rowsOf(S, table), key)
      const f = familyRecordings.map((N) => counts(rowsOf(N, table), key))
      for (const one of new Set([...g.keys(), ...s.keys(), ...f.flatMap((m) => [...m.keys()])])) {
        const inSweep = s.get(one) ?? 0
        const inGolden = g.get(one) ?? 0
        if (inSweep === inGolden) continue
        const familyCount = Math.max(0, ...f.map((m) => m.get(one) ?? 0))
        // The family has as many: its replay sets them aside and checks them (each family's *RowProblems and stored answers).
        const kind = f.some((m) => (m.get(one) ?? 0) === inSweep)
          ? 'accepted: the family sets these rows aside and checks them on their own'
          : inSweep > familyCount
            ? "setup: the Worker's own audit and idempotency rows from a setup the old code made"
            : 'unexplained'
        bookkeeping.push({ scenario: name, table, key: one, golden: inGolden, family: familyCount, sweep: inSweep, class: kind })
      }
    }
  })
})
