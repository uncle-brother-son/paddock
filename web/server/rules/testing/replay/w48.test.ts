import { writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Db } from '@/server/db'
import { CATALOG_ADMIN_REASONS } from '@/server/rules/catalog/failure-messages'
import { EVENT_ADMIN_REASONS, EVENT_ADMIN_WORDS } from '@/server/rules/events/admin-failure-messages'
import { ORDER_ADMIN_REASONS } from '@/server/rules/orders/admin-failure-messages'
import { PROMO_ADMIN_REASONS } from '@/server/rules/promo/admin-failure-messages'
import { SESSION_ADMIN_REASONS } from '@/server/rules/sessions/admin-failure-messages'
import { compareRecordings, type AllowedDifference, type Recording } from './compare'
import { LEGACY_ADMIN_ACTIONS, legacyAdminDir, oldFunctionPath, oldSide, readGolden, replay, startReplay, writeGolden, type ReplayEnvironment, type ReplayOptions } from './harness'
import { scenarios } from './scenarios'
import { W48_GROUPS, W48_PREFIX, w48Scenarios } from './w48-scenarios'
import { WHAT_EACH_PROVES } from './w48-what-each-proves'

// Brief W48 item 4 (G-plan 4.9 items 1 and 2, lead call L5): step G's golden files, recorded from the staff app's 82
// old functions and the seven legacy /api/catalog routes while they still exist, and replayed here against the frozen
// copy of them (legacy-admin/): each gives the same recording every time and matches its golden file. This file also
// says, in plain lines, what each scenario's steps do on the old code (w48-what-each-proves.ts), so a scenario that
// stopped reaching the branch it is named for fails here; that the list covers every function, every reason and every
// bug the plan names (GB1 to GB24); and (the brief's checks) that a deliberate difference from a golden file is
// caught and an allowance nobody needs fails.
//
// W49 to W57 replay these through the Worker's routes and name each difference. Until then they are the old code's.
//
// To record or re-record after a deliberate change to a scenario:
//   UPDATE_GOLDEN=1 npx vitest run --config vitest.unit.config.ts server/rules/testing/replay/w48.test.ts
//   W48_OUTCOMES_OUT=<file> npx vitest run --config vitest.unit.config.ts server/rules/testing/replay/w48.test.ts -t "says what"
// and read the diff of golden/ and of w48-what-each-proves.ts before keeping either.

vi.setConfig({ testTimeout: 30_000 })

const updating = process.env.UPDATE_GOLDEN === '1'
const w48 = w48Scenarios()
type Row = Record<string, unknown>
const short = (name: string) => name.slice(W48_PREFIX.length)
const golden = (name: string): Recording => {
  const recording = readGolden(`${W48_PREFIX}${name}`)
  if (!recording) throw new Error(`No golden file for ${W48_PREFIX}${name}: record it with UPDATE_GOLDEN=1.`)
  return recording
}

/** A value in a few words: text as it is, a list by its length, anything nested by its fields. */
function brief(value: unknown, depth = 0): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return value.length === 0 ? 'none' : `${value.length} (${value.slice(0, 2).map((item) => brief(item, depth + 1)).join('; ')}${value.length > 2 ? '; …' : ''})`
  if (typeof value !== 'object') return String(value)
  const fields = Object.entries(value as Row).filter(([key, item]) => !/(^|_)id$|_at$|^(created|updated)_|thumbnail|sanity_/.test(key) && item !== null && item !== undefined)
  if (depth >= 2) return `{${fields.length} fields}`
  return fields.slice(0, depth === 0 ? 9 : 5).map(([key, item]) => `${key} ${brief(item, depth + 1)}`).join(', ')
}

/**
 * One step's outcome in a line: the words a refusal gave, or what the answer says. Null for a set-up order placed
 * through the older copies' createOrder (not a step of the functions under test).
 */
function outcome(result: unknown): string | null {
  if (result === null || result === undefined) return 'null'
  if (Array.isArray(result)) return result.length === 0 ? 'no rows' : `${result.length} ${result.length === 1 ? 'row' : 'rows'}: ${brief(result[0], 1)}`
  if (typeof result !== 'object') return String(result)
  const r = result as Row
  if ('thrown' in r) return `thrown: ${String(r['thrown'])}`
  if ('success' in r && 'paymentMethodUsed' in r) return null
  if ('success' in r && r['success'] === false && 'stage' in r) return `order refused: ${String(r['reason'])}`
  for (const flag of ['updated', 'created', 'reset', 'blocked', 'saved', 'added', 'deleted', 'confirmed']) {
    if (r[flag] === false && 'reason' in r) return `refused: ${String(r['reason'])}${typeof r['message'] === 'string' ? ` "${r['message']}"` : ''}`
  }
  return brief(r)
}

const outcomes = (recording: Recording): string[] => recording.results.map(outcome).filter((line): line is string => line !== null)

/** What the scenario left behind: each table's rows added, changed and removed, and Stripe's calls in order. */
function left(recording: Recording): string {
  const tables = Object.entries(recording.tables)
    .map(([table, change]) => {
      const c = change as { added?: unknown[]; changed?: unknown[]; removed?: unknown[] }
      const parts = [c.added?.length ? `+${c.added.length}` : '', c.changed?.length ? `~${c.changed.length}` : '', c.removed?.length ? `-${c.removed.length}` : ''].filter(Boolean)
      return `${table} ${parts.join(' ')}`
    })
    .join(', ')
  const stripe = recording.stripeCalls.map((call) => call.method).join(', ')
  return `rows: ${tables || 'none'}${stripe ? `; Stripe: ${stripe}` : ''}`
}

const proves = (recording: Recording): string[] => [...outcomes(recording), left(recording)]

describe("step G's golden files, replayed against the frozen copy (brief W48 item 4)", () => {
  let environment: ReplayEnvironment
  beforeAll(async () => {
    environment = await startReplay()
  })
  afterAll(() => environment.stop())

  describe.each(w48.map((scenario) => scenario.name))('%s', (name) => {
    const scenario = w48.find((one) => one.name === name) as (typeof w48)[number]
    it('gives the same recording every time', async () => {
      const first = await replay(environment, scenario, oldSide)
      expect(compareRecordings(first, await replay(environment, scenario, oldSide))).toEqual([])
    })
    it('matches its golden file', async () => {
      const recording = await replay(environment, scenario, oldSide)
      if (updating) writeGolden(recording)
      const saved = readGolden(name)
      expect(saved, `No golden file for ${name}: run with UPDATE_GOLDEN=1.`).not.toBeNull()
      expect(compareRecordings(saved as Recording, recording)).toEqual([])
    })
  })
})

describe("what step G's golden files prove on the old code", () => {
  it('says what every scenario does, step by step (w48-what-each-proves.ts), read from its golden file', () => {
    const found = Object.fromEntries(w48.map((scenario) => [short(scenario.name), proves(golden(short(scenario.name)))]))
    if (process.env.W48_OUTCOMES_OUT) writeFileSync(process.env.W48_OUTCOMES_OUT, `${JSON.stringify(found, null, 2)}\n`)
    expect(Object.keys(found).sort()).toEqual(Object.keys(WHAT_EACH_PROVES).sort())
    for (const [name, lines] of Object.entries(found)) expect(lines, name).toEqual(WHAT_EACH_PROVES[name])
  })

  it('271 scenarios, each named once, each with a golden file, none in the older list (and the older list has none of these)', () => {
    expect(w48).toHaveLength(271)
    expect(new Set(w48.map((scenario) => scenario.name)).size).toBe(271)
    for (const scenario of w48) expect(scenario.name.startsWith(W48_PREFIX), scenario.name).toBe(true)
    expect(scenarios.filter((scenario) => scenario.name.startsWith(W48_PREFIX))).toEqual([])
    const older = new Set(scenarios.map((scenario) => scenario.name))
    expect(w48.filter((scenario) => older.has(scenario.name))).toEqual([])
  })

  it('by screen (the report\'s counts)', () => {
    expect(Object.fromEntries(W48_GROUPS.map((group) => [group.screen, group.scenarios().length]))).toEqual({
      Staff: 22,
      'Catalog: service types': 36,
      'Catalog: products, stock and add-ons': 39,
      'Catalog: session passes and gift card types': 36,
      'Catalog: membership plans and settings': 26,
      'Catalog: events, and the attendee list': 25,
      'Promo codes': 10,
      Pricing: 16,
      'Sessions and the timetable': 38,
      'Bookings, orders and Overview': 23,
    })
    expect(W48_GROUPS.reduce((sum, group) => sum + group.scenarios().length, 0)).toBe(271)
  })

  it('every one of the 82 old functions is loaded from the frozen copy, never from the staff app', () => {
    expect(LEGACY_ADMIN_ACTIONS.size).toBe(82)
    for (const action of LEGACY_ADMIN_ACTIONS) expect(oldFunctionPath(action).startsWith(legacyAdminDir), action).toBe(true)
  })

  it('every bug the plan names has its recording: GB1 to GB24', () => {
    const named = new Set(w48.map((scenario) => /^w48-gb(\d+)-/.exec(scenario.name)?.[1]).filter((n): n is string => n !== undefined).map(Number))
    expect([...named].sort((a, b) => a - b)).toEqual(Array.from({ length: 24 }, (_, i) => i + 1))
  })

  it("every reason an old function's result type names is answered in some recording", () => {
    const answered = new Set(w48.flatMap((scenario) => golden(short(scenario.name)).results.flatMap((result) => JSON.stringify(result).match(/"reason":"[a-z_]+"/g) ?? [])).map((found) => found.slice(10, -1)))
    const named = [CATALOG_ADMIN_REASONS, PROMO_ADMIN_REASONS, SESSION_ADMIN_REASONS, EVENT_ADMIN_REASONS, ORDER_ADMIN_REASONS].flatMap((reasons) => Object.values(reasons).flat())
    expect(named.filter((reason) => !answered.has(reason))).toEqual([])
    // And every reason of the event check-in's record, with the two the attendee list words.
    for (const reason of [...Object.keys(EVENT_ADMIN_WORDS.eventCheckIn), 'check_in_not_open', 'check_in_closed']) expect(answered.has(reason), reason).toBe(true)
  })

  it('GB1: a plan price change moves the live members and the function answers only the plan row; the route itself counts them', () => {
    const silent = golden('gb1-plan-price-change-moves-every-live-member-and-says-nothing')
    expect(silent.stripeCalls.map((call) => call.method)).toEqual(['prices.update', 'prices.create', 'subscriptions.retrieve', 'subscriptions.update', 'subscriptions.retrieve', 'subscriptions.update', 'subscriptions.retrieve'])
    expect(silent.stripeCalls.filter((call) => call.method === 'subscriptions.update').map((call) => (call.params as { proration_behavior: string }).proration_behavior)).toEqual(['none', 'none'])
    expect(silent.stripeCalls.every((call) => call.idempotencyKey === null)).toBe(true)
    expect(JSON.stringify(silent.results)).not.toContain('subscriptionMigration')
    expect(silent.tables['audit_log']).toBeUndefined()
    const counted = golden('gb1-the-legacy-route-answers-the-counts-the-plan-function-drops').results[0] as { subscriptionMigration: { migrated: number; failed: unknown[] } }
    expect(counted.subscriptionMigration).toMatchObject({ migrated: 2, alreadyCurrent: 0, skipped: 0 })
    expect(counted.subscriptionMigration.failed).toHaveLength(1)
  })

  it('GB3: with one session far ahead the nightly job makes nothing; without it, 13', () => {
    expect(golden('nightly-job-makes-sessions-98-days-ahead').tables['sessions']?.added).toHaveLength(13)
    const stopped = golden('gb3-one-far-future-session-stops-the-nightly-job')
    expect(stopped.tables['sessions']?.added).toHaveLength(1)
    expect(stopped.results[1]).toEqual([])
  })

  it('GB13: the same stock press twice counts twice (5 + 10 + 10)', () => {
    expect(golden('gb13-a-stock-press-made-twice-counts-twice').results).toEqual([
      { id: '10000000-0000-4000-8000-000000000008', stock_quantity: 15 },
      { id: '10000000-0000-4000-8000-000000000008', stock_quantity: 25 },
    ])
  })

  it('GB14: the 23 reads answer an inactive account and a sign-in with no staff row; only the staff list refuses', () => {
    const results = golden('gb14-the-reads-check-nobody').results.slice(1)
    expect(results).toHaveLength(48)
    const thrown = results.filter((result) => result !== null && typeof result === 'object' && 'thrown' in result).map((result) => (result as { thrown: string }).thrown)
    expect(thrown).toEqual(['This staff account is inactive. Ask an admin to reactivate it.', "No staff record matches the logged-in user's email (jo@example.com). Ask an admin to add you as staff before performing this action."])
  })

  it('a staff-set time is recorded as the moment it holds, so a wrong date can be seen (the 991 older recordings show only that a time is set)', () => {
    const moved = golden('session-start-time-set')
    expect(moved.results[0]).toMatchObject({ session: { start_time: '2026-11-12T18:00:00.000Z', end_time: '2026-11-12T19:00:00.000Z' } })
    expect(moved.tables['sessions']?.changed[0]).toMatchObject({ start_time: ['2026-11-12T10:00:00.000Z', '2026-11-12T18:00:00.000Z'] })
    const event = golden('gb11-cut-off-date-and-prices-change-after-places-are-sold').tables['events']?.changed[0] as Row
    expect(event['refund_cutoff_at']).toEqual(['2026-11-30T19:00:00.000Z', '2026-11-10T08:00:00.000Z'])
    expect(readGolden('cash-booking-two-guests-addon')?.tables['bookings']?.added[0]).toMatchObject({ start_time: '<set>' })
  })
})

describe('a deliberate difference from a step G golden file is caught, and an allowance nobody needs fails (brief W48 checks)', () => {
  let environment: ReplayEnvironment
  beforeAll(async () => {
    environment = await startReplay()
  })
  afterAll(() => environment.stop())

  const scenario = (name: string) => {
    const found = w48.find((one) => one.name === `${W48_PREFIX}${name}`)
    if (!found) throw new Error(`No scenario ${name}`)
    return found
  }
  const run = (name: string, options?: ReplayOptions) => replay(environment, scenario(name), oldSide, options)
  const against = async (name: string, tamper: NonNullable<ReplayOptions['tamper']>) => compareRecordings(golden(name), await run(name, { tamper }))
  const paths = async (name: string, tamper: (db: Db) => Promise<unknown>) => (await against(name, (db) => tamper(db).then(() => undefined))).map((difference) => difference.path)

  const STAFF = 'staff-permission-issue-refunds-on-and-off'
  const PRICE = 'tier-price-set'
  const STOCK = 'stock-adjust-each-reason'
  const WINDOWS = 'band-rules-set'
  const START = 'session-start-time-set'
  const CHECK_IN = 'event-check-in-signing-at-the-desk-then-undo'
  const ALL = [STAFF, PRICE, STOCK, WINDOWS, START, CHECK_IN]

  it('untouched, each of the six matches its golden file exactly', async () => {
    for (const name of ALL) expect(compareRecordings(golden(name), await run(name)), name).toEqual([])
  })

  it('staff: a permission left on that the recording ends with off, and a second staff member changed', async () => {
    expect(await paths(STAFF, (db) => db.query("UPDATE staff SET can_issue_refunds = true WHERE email = 'tia@example.com'"))).toContain('.tables.staff')
    expect((await paths(STAFF, (db) => db.query("UPDATE staff SET can_manage_pricing = false WHERE email = 'jo@example.com'"))).join()).toContain('.tables.staff')
  })

  it('a price: a penny out on the tier, a penny out in what Stripe was sent, the old price not archived, a second price made', async () => {
    expect(await paths(PRICE, (db) => db.query('UPDATE service_type_price_tiers SET price = price + 0.01 WHERE price = 120'))).toContain('.tables.service_type_price_tiers.changed[0].price[1]')
    const penny = await against(PRICE, async (_db, stripe) => {
      const made = stripe.calls.find((call) => call.method === 'prices.create')
      if (made) (made.params as { unit_amount: number }).unit_amount += 1
    })
    expect(penny).toContainEqual({ path: '.stripeCalls[1].params.unit_amount', expected: 12000, actual: 12001 })
    const kept = await against(PRICE, async (_db, stripe) => {
      stripe.calls.splice(0, 1)
    })
    expect(kept.map((difference) => difference.path).join()).toContain('.stripeCalls[0]')
    const twice = await against(PRICE, async (_db, stripe) => {
      stripe.calls.push({ ...(stripe.calls[1] as (typeof stripe.calls)[number]) })
    })
    expect(twice.map((difference) => difference.path)).toContain('.stripeCalls[2]')
  })

  it('stock: one more on the shelf, a ledger row missing, the staff member not recorded', async () => {
    expect(await paths(STOCK, (db) => db.query('UPDATE product_variants SET stock_quantity = stock_quantity + 1 WHERE sku = $1', ['SOAP-1']))).toContain('.tables.product_variants.changed[0].stock_quantity[1]')
    expect((await paths(STOCK, (db) => db.query("DELETE FROM stock_adjustments WHERE reason = 'Damage'"))).join()).toContain('.tables.stock_adjustments.added')
    expect(await paths(STOCK, (db) => db.query('UPDATE stock_adjustments SET staff_id = NULL'))).toContain('.tables.stock_adjustments.added[0].staff_id')
  })

  it('band windows: a window an hour out, a session left in its old band, the day left with a gap', async () => {
    expect(await paths(WINDOWS, (db) => db.query("UPDATE band_rules SET from_time = '13:00' WHERE day_of_week = 6 AND from_time = '12:00'"))).toContain('.tables.band_rules.added[1].from_time')
    expect((await paths(WINDOWS, (db) => db.query("UPDATE sessions SET band_id = (SELECT id FROM session_bands WHERE code = 'core') WHERE start_time = '2026-11-14 14:00:00+00'"))).join()).toContain('.tables.sessions')
    expect((await paths(WINDOWS, (db) => db.query("DELETE FROM band_rules WHERE day_of_week = 6 AND from_time = '00:00'"))).join()).toContain('.tables.band_rules.added')
  })

  it('a start time: the session an hour out, its end not moved with it, its band not following', async () => {
    expect(await paths(START, (db) => db.query("UPDATE sessions SET start_time = '2026-11-12 19:00:00+00' WHERE start_time = '2026-11-12 18:00:00+00'"))).toContain('.tables.sessions.changed[0].start_time[1]')
    expect(await paths(START, (db) => db.query("UPDATE sessions SET end_time = '2026-11-12 11:00:00+00' WHERE start_time = '2026-11-12 18:00:00+00'"))).toContain('.tables.sessions.changed[0].end_time')
    expect((await paths(START, (db) => db.query("UPDATE sessions SET band_id = (SELECT id FROM session_bands WHERE code = 'core') WHERE start_time = '2026-11-12 18:00:00+00'"))).join()).toContain('.tables.sessions.changed[0].band_id')
  })

  it('an event check-in: the attendee left checked in after the undo, and a waiver signed by another method', async () => {
    expect((await paths(CHECK_IN, (db) => db.query("UPDATE event_attendees SET checked_in_at = now() WHERE attendee_type = 'account_holder'"))).join()).toContain('.tables.event_attendees.added[0].checked_in_at')
    expect(await paths(CHECK_IN, (db) => db.query("UPDATE event_attendees SET waiver_method = 'email_link' WHERE waiver_method = 'in_person'"))).toContain('.tables.event_attendees.added[0].waiver_method')
  })

  it('an audit row (the Worker will write one; the old code writes none) shows as a whole table appearing', async () => {
    for (const name of [STAFF, PRICE, STOCK, WINDOWS, START]) {
      expect(golden(name).tables['audit_log'], name).toBeUndefined()
      const found = await paths(name, (db) => db.query("INSERT INTO audit_log (actor_type, action, entity_type, entity_id, details) VALUES ('staff', 'catalog.price_set', 'tier', 'x', '{}')"))
      expect(found, name).toContain('.tables.audit_log')
    }
  })

  it('different words for staff, and a different shape of answer', async () => {
    const refusal = 'staff-manage-pricing-last-holder-refused'
    const recorded = await run(refusal)
    const reworded = compareRecordings(golden(refusal), { ...recorded, results: [{ thrown: 'You cannot remove the last pricing manager.' }, recorded.results[1]] })
    expect(reworded.map((difference) => difference.path)).toEqual(['.results[0].thrown'])
    const reshaped = compareRecordings(golden(START), { ...(await run(START)), results: [{ updated: true, session: { id: '10000000-0000-4000-8000-000000000004' } }] })
    expect(reshaped.map((difference) => difference.path).sort()).toEqual(['.results[0].band', '.results[0].session.end_time', '.results[0].session.start_time'])
  })

  it('an allowance that is needed passes its own path only: every other difference still shows', async () => {
    const key: AllowedDifference = { name: 'a key on the new price (test only)', decision: 'none: this test', path: /^\.stripeCalls\[1\]\.idempotencyKey$/ }
    const tampered = await run(PRICE, {
      tamper: async (db, stripe) => {
        const made = stripe.calls.find((call) => call.method === 'prices.create')
        if (made) made.idempotencyKey = 'change-1:price'
        await db.query('UPDATE service_type_price_tiers SET price = price + 0.01 WHERE price = 120')
      },
    })
    expect(compareRecordings(golden(PRICE), tampered, [key]).map((difference) => difference.path)).toEqual(['.tables.service_type_price_tiers.changed[0].price[1]'])
  })

  it('an allowance can check the value it lets through: the wrong value on its path still fails', async () => {
    const later: AllowedDifference = {
      name: 'the session starts at 19:00 (test only)',
      decision: 'none: this test',
      path: /^\.tables\.sessions\.changed\[0\]\.start_time\[1\]$/,
      actual: (actual) => actual === '2026-11-12T19:00:00.000Z',
    }
    const at = (hour: string) => run(START, { tamper: (db) => db.query("UPDATE sessions SET start_time = $1::timestamptz WHERE start_time = '2026-11-12 18:00:00+00'", [`2026-11-12 ${hour}:00:00+00`]).then(() => undefined) })
    expect(compareRecordings(golden(START), await at('19'), [later])).toEqual([])
    expect(compareRecordings(golden(START), await at('20'), [later]).map((difference) => difference.path)).toEqual(['.tables.sessions.changed[0].start_time[1]', '(allowed difference not seen: the session starts at 19:00 (test only))'])
  })

  it('an allowance nobody needs fails, naming itself and its decision, so a stale one can never stay', async () => {
    const stale: AllowedDifference = { name: 'W54 named this and no longer needs it', decision: 'G-plan 4.9 item 4', path: /^\.tables\.audit_log$/ }
    for (const name of ALL) {
      expect(compareRecordings(golden(name), await run(name), [stale]), name).toEqual([{ path: '(allowed difference not seen: W54 named this and no longer needs it)', expected: 'G-plan 4.9 item 4', actual: undefined }])
    }
  })
})
