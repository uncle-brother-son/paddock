import { appendFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Db } from '@/server/db'
import { staffAppDir } from '../staff-app-dir'
import { ADMIN_NO_ANSWER_WORDS, createdByIsTheStoredEmail, createdByPaths, DECISION_SCENARIOS, GB14_SCENARIO, isW49W54Scenario, NOW_RECORDED_SCENARIOS, S3_OLD_WORDS, s3Paths, W49_W54_DIFFERENCES, w49W54Differences } from './admin-differences'
import { adminRowProblems, adminStoredAnswerProblems, answeredStampProblems, comparableAdmin, newAdminSide, STAMPED_EDITS, STEP_G_ACTIONS_MOVED, STEP_G_AUDIT_ROWS, STEP_G_WRITE_ROUTES, W49_ACTIONS, W54_ACTIONS, type AnsweredStamp } from './admin-side'
import { throughStaffApp } from './booking-side'
import { compareRecordings, type AllowedDifference, type Recording, type Row } from './compare'
import { oldSide, readGolden, replay, startReplay, type ReplayEnvironment, type Scenario } from './harness'
import { ID, mo, paidSeat, whileFailing } from './scenarios'
import { W48_ID, w48Scenarios } from './w48-scenarios'

// W49 + W54 (brief "Parity and tests"): the staff, pricing and promo code golden families (W48's recordings of the
// old functions) through the staff app's thin wrappers and the Worker's routes, as the screens press them.
vi.setConfig({ testTimeout: 300_000 })

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))

const compareSides = (golden: Recording, recording: Recording, named: Parameters<typeof compareRecordings>[2]) => compareRecordings(comparableAdmin(golden), comparableAdmin(recording), named)

const SATURDAY = 6
const recut = { dayOfWeek: SATURDAY, rules: [{ bandId: ID.peakBand, fromTime: '12:00', toTime: '24:00' }, { bandId: ID.band, fromTime: '00:00', toTime: '12:00' }] }
const allTen = { id: ID.promoPercent, code: 'ALLTEN', discountType: 'percentage', discountValue: 10, appliesTo: ['booking', 'addon', 'product', 'session_pass', 'membership', 'event'], appliesOnMemberPrices: false, expiresOn: null, maxTotalUses: null, oneUsePerCustomer: false, minSpend: null, restrictedCustomerId: null, active: true }

/**
 * Five recordings hold what two presses did when one landed in the middle of the other (GB16, GB18), or what a
 * failure between the old function's separate statements left behind (GB8). The old function's own statements were
 * the seam: the scenario put its gap or its failure between two of them. A route that is one transaction has no such
 * seam, so each is told again here as what can still happen: the two presses one after the other (the second finds
 * what the first left, as it would after waiting for its lock), and a write failing inside the transaction. The
 * races themselves run on real Postgres (staff/, pricing/ and promo/ admin-postgres.test.ts).
 */
const TOLD_AGAIN: Readonly<Record<string, Scenario['run']>> = {
  // The other admin's press lands first (the recording's gap: Jo's Manage pricing taken), then this one.
  'w48-gb16-two-admins-remove-each-others-manage-pricing': async ({ attempt, db }) => {
    await db.query('UPDATE staff SET can_manage_pricing = false, updated_at = now() WHERE id = $1', [ID.staff])
    await attempt('setStaffCanManagePricing', { staffId: W48_ID.secondAdmin, canManagePricing: false })
  },
  // The order using ALLTEN is placed first (the recording's gap), then the edit of the code's text.
  'w48-gb18-the-text-lock-is-a-read-then-a-write': async ({ call }) => {
    await call('createOrder', { customerId: ID.customer, booking: paidSeat(), promoCode: 'ALLTEN', payment: { method: 'cash', confirmedCashAmount: 18 } })
    await call('updatePromoCode', { ...allTen, code: 'ALLTWENTY', discountValue: 20 })
  },
  // A window's insert fails: the first, in two of the recordings; the second, after the first went in, in the third.
  'w48-gb8-band-windows-deleted-then-an-insert-fails-and-the-old-ones-are-put-back': async ({ attempt, db }) => {
    await whileFailing(db, { table: 'band_rules', event: 'INSERT', when: "NEW.from_time = '00:00'" }, () => attempt('setBandRules', recut))
  },
  'w48-gb8-band-windows-deleted-and-the-put-back-fails-too': async ({ attempt, db }) => {
    await whileFailing(db, { table: 'band_rules', event: 'INSERT', when: 'true' }, () => attempt('setBandRules', recut))
  },
  'w48-gb8-band-windows-half-saved-then-the-put-back-overlaps': async ({ attempt, db }) => {
    await whileFailing(db, { table: 'band_rules', event: 'INSERT', when: "NEW.from_time = '12:00'" }, () => attempt('setBandRules', recut))
  },
}

const everyStepGScenario = w48Scenarios()
const families = everyStepGScenario.filter((scenario) => isW49W54Scenario(scenario.name))
const asPressedNow = (scenario: Scenario): Scenario => (TOLD_AGAIN[scenario.name] ? { ...scenario, run: TOLD_AGAIN[scenario.name] as Scenario['run'] } : scenario)
const sideFor = (name: string, options: Parameters<typeof newAdminSide>[0] = {}) => newAdminSide({ ...options, refusedReadsAsAnswers: name === GB14_SCENARIO })

type AuditRow = Row & { action?: string; details?: { before?: Record<string, unknown> | null; after?: Record<string, unknown> | null; field?: string } }
const ownAuditRows = (recording: Recording): AuditRow[] => ((recording.tables['audit_log']?.added ?? []) as AuditRow[]).filter((row) => STEP_G_AUDIT_ROWS.has(String(row.action)))

/** W54a: the four edits that send a whole row back, by the audit action each writes. */
const STAMPED_ACTIONS: ReadonlySet<string> = new Set(['promo.updated', 'pricing.band_rules_set', 'pricing.member_term_set', 'postage.set'])
const STAMPED_ROUTES = STEP_G_WRITE_ROUTES.filter((one) => STAMPED_ACTIONS.has(one.action))
/** How many presses of a stamped edit were answered with a success: the stored answers of 200 on those four routes. */
const stampedSaves = (recording: Recording): number => ((recording.tables['api_idempotency']?.added ?? []) as Row[]).filter((row) => row['http_status'] === 200 && STAMPED_ROUTES.some(({ route }) => route.test(String(row['endpoint'])))).length
const CHANGED_SINCE_WORDS = 'This was changed by someone else since the page loaded. The page has been reloaded: check it and save again.'

describe("step G's side of the replay: staff, pricing and promo codes (W49 + W54)", () => {
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
  const named = (name: string) => w49W54Differences(name, golden(name))
  const runNew = (name: string, options: Parameters<typeof newAdminSide>[0] = {}, replayOptions: Parameters<typeof replay>[3] = {}) => replay(environment, asPressedNow(scenario(name)), sideFor(name, options), replayOptions)
  const left = (name: string, recording: Recording, allowed: readonly AllowedDifference[] = named(name)) => compareSides(golden(name), recording, allowed).map((difference) => difference.path)

  describe.each(families.map((one) => [one.name, one] as const))('%s', (name, one) => {
    it('matches its golden file, with its named differences only; its audit rows and stored answers are right', async () => {
      const calls: Array<{ action: string; side: 'new' | 'old' }> = []
      const stamps: AnsweredStamp[] = []
      const recording = await replay(environment, asPressedNow(one), sideFor(name, { calls, stamps }))
      expect(golden(name), `No golden file for ${name}`).not.toBeNull()
      expect(calls.filter((call) => STEP_G_ACTIONS_MOVED.has(call.action)).every((call) => call.side === 'new')).toBe(true)
      expect(calls.some((call) => STEP_G_ACTIONS_MOVED.has(call.action))).toBe(true)
      if (process.env.W49_DIFFERENCES_OUT) {
        appendFileSync(
          process.env.W49_DIFFERENCES_OUT,
          `${JSON.stringify({ name, differences: compareSides(golden(name), recording, []), unnamed: compareSides(golden(name), recording, named(name)), rows: adminRowProblems(recording), stored: adminStoredAnswerProblems(recording), audit: recording.tables['audit_log']?.added ?? [], results: recording.results })}\n`
        )
        return
      }
      expect(adminRowProblems(recording), `${name}: the Worker's audit rows`).toEqual([])
      expect(adminStoredAnswerProblems(recording), `${name}: the stored answers`).toEqual([])
      // W54a: the stamps the new answers carry are set aside (the old functions had none) and checked here: each is a
      // stamp, and every press of a stamped edit answered with a success carried one.
      expect(answeredStampProblems(stamps), `${name}: the stamps`).toEqual([])
      expect(stamps.filter((one) => STAMPED_EDITS.has(one.action)).length, `${name}: a stamp for each saved edit`).toBe(stampedSaves(recording))
      expect(compareSides(golden(name), recording, named(name))).toEqual([])
    })
  })

  it('the families are whole: every staff, pricing and promo code scenario W48 recorded is replayed here, and every named difference is for a scenario that exists', () => {
    expect(families.length).toBe(49)
    // Staff: 19 and GB16's three. Promo codes: 8 and GB18's two. Pricing: 13 and GB8's three. And GB14's one (every read).
    expect(families.filter((one) => /^w48-staff-/.test(one.name)).length).toBe(19)
    expect(families.filter((one) => /^w48-gb16-/.test(one.name)).length).toBe(3)
    expect(families.filter((one) => /^w48-promo-/.test(one.name)).length).toBe(8)
    expect(families.filter((one) => /^w48-gb18-/.test(one.name)).length).toBe(2)
    expect(families.filter((one) => /^w48-(band-|member-band-term-|postage-)/.test(one.name)).length).toBe(13)
    expect(families.filter((one) => /^w48-gb8-/.test(one.name)).length).toBe(3)
    expect(families.filter((one) => one.name === GB14_SCENARIO).length).toBe(1)
    // Every scenario that calls a function W49 or W54 moved is in the families: none is replayed only through old code.
    const source = readFileSync(path.join(__dirname, 'w48-scenarios.ts'), 'utf8')
    for (const action of STEP_G_ACTIONS_MOVED) expect(source, action).toContain(`'${action}'`)
    expect(W49_ACTIONS.size + W54_ACTIONS.size).toBe(14)

    const differing = new Set([...W49_W54_DIFFERENCES.keys(), ...DECISION_SCENARIOS.S3])
    expect([...differing].every((name) => families.some((one) => one.name === name))).toBe(true)
    // 32 match their golden files exactly. 17 have named differences: 11 for the bugs and the missing words, 6 for S3.
    expect(W49_W54_DIFFERENCES.size).toBe(11)
    expect(DECISION_SCENARIOS.S3.length).toBe(6)
    expect(differing.size).toBe(17)
    expect(families.filter((one) => !differing.has(one.name)).length).toBe(32)
    for (const name of NOW_RECORDED_SCENARIOS) expect(differing.has(name), name).toBe(false)
    // The five told again are five of the named ones: a scenario told again can never pass as an exact match.
    for (const name of Object.keys(TOLD_AGAIN)) expect(W49_W54_DIFFERENCES.has(name), name).toBe(true)
  })

  describe('S3 (W48 review; the lead\'s call): one decision for every slice', () => {
    it('34 of step G\'s golden files hold the old "…before managing pricing." sentence, each once; six are W54\'s, and each of those is the no-staff-row step of a "who may" recording', () => {
      const holding = everyStepGScenario.map((one) => ({ name: one.name, paths: s3Paths(golden(one.name)) })).filter((one) => one.paths.length > 0)
      expect(holding.length).toBe(34)
      expect(holding.every((one) => one.paths.length === 1)).toBe(true)
      expect(holding.every((one) => /-who-may$/.test(one.name))).toBe(true)
      const ours = holding.filter((one) => isW49W54Scenario(one.name)).map((one) => one.name)
      expect(ours.sort()).toEqual([...DECISION_SCENARIOS.S3].sort())
      for (const one of holding.filter((each) => isW49W54Scenario(each.name))) expect(one.paths).toEqual(['.results[2].thrown'])
      // The sentence is nowhere else in a golden file: not in a row, and not in an answer that wasn't thrown.
      for (const one of everyStepGScenario) {
        const text = JSON.stringify(golden(one.name))
        expect(text.split(JSON.stringify(S3_OLD_WORDS).slice(1, -1)).length - 1, one.name).toBe(s3Paths(golden(one.name)).length)
      }
    })

    it('the allowance is pinned to the staff check\'s own sentence: any other words on that step are a difference', async () => {
      const name = 'w48-band-price-who-may'
      const reworded = await runNew(name, { adjust: (_action, answer) => answer })
      expect(left(name, reworded)).toEqual([])
      const wrong: Recording = { ...reworded, results: reworded.results.map((result, i) => (i === 2 ? { thrown: 'Something else.' } : result)) }
      expect(left(name, wrong)).toEqual(['.results[2].thrown', expect.stringContaining('allowed difference not seen')])
    })
  })

  describe('what the old functions never recorded is now recorded (GB16, GB18)', () => {
    it('GB16: each permission change has its audit row: who, which switch, and the staff member before and after', async () => {
      const recording = await runNew(NOW_RECORDED_SCENARIOS[0])
      const rows = ownAuditRows(recording)
      expect(rows.map((row) => row.action)).toEqual(['staff.permission_set', 'staff.permission_set'])
      expect(rows.map((row) => row['actor_id'])).toEqual([ID.staff, ID.staff])
      expect(rows.map((row) => row['entity_id'])).toEqual([W48_ID.teamMember, W48_ID.teamMember])
      expect(rows.map((row) => row.details?.field)).toEqual(['can_issue_refunds', 'can_manage_pricing'])
      expect(rows[0]?.details?.before).toEqual({ role: 'staff', can_issue_refunds: false, can_manage_pricing: false, active: true })
      expect(rows[0]?.details?.after).toEqual({ role: 'staff', can_issue_refunds: true, can_manage_pricing: false, active: true })
      expect(rows[1]?.details?.before).toEqual({ role: 'staff', can_issue_refunds: true, can_manage_pricing: false, active: true })
      expect(rows[1]?.details?.after).toEqual({ role: 'staff', can_issue_refunds: true, can_manage_pricing: true, active: true })
    })

    it('GB18: a code edited from 10% to 100% and back ends as it began, and both edits are on record with the discount before and after', async () => {
      const recording = await runNew(NOW_RECORDED_SCENARIOS[1])
      const rows = ownAuditRows(recording)
      expect(rows.map((row) => row.action)).toEqual(['promo.updated', 'promo.updated'])
      expect(rows.map((row) => row['entity_id'])).toEqual([ID.promoPercent, ID.promoPercent])
      expect(rows.map((row) => [row.details?.before?.['discount_value'], row.details?.after?.['discount_value']])).toEqual([['10', '100'], ['100', '10']])
      expect(rows.every((row) => row.details?.before?.['code'] === 'ALLTEN' && row.details?.after?.['code'] === 'ALLTEN')).toBe(true)
    })
  })

  describe("New Order's basket quote before and after each pricing change agrees with the old code's", () => {
    const cash = { method: 'cash' }
    const baskets: Record<string, unknown> = {
      'Sam, a paid seat in Core': { customerId: ID.customer, booking: paidSeat(), payment: cash },
      'Sam, a paid seat in Peak': { customerId: ID.customer, booking: { ...paidSeat(), sessionId: ID.peakSession }, payment: cash },
      'Sam, a paid seat on Saturday afternoon': { customerId: ID.customer, booking: { ...paidSeat(), sessionId: W48_ID.sameDaySession }, payment: cash },
      'Mo (a Core member), a paid seat in Peak': { customerId: ID.member, booking: { ...paidSeat([mo]), sessionId: ID.peakSession }, payment: cash },
      'Sam, a candle posted': {
        customerId: ID.customer,
        products: [{ productVariantId: ID.candleVariant, quantity: 1, unitPrice: 20, systemUnitPrice: 20 }],
        shippingAddress: { name: 'Sam Test', line1: '1 Mill Lane', city: 'Hebden Bridge', postcode: 'HX7 1AA', country: 'United Kingdom' },
        postageMethod: 'standard',
        payment: cash,
      },
    }
    type Quotes = Record<string, unknown>
    /** Every basket's quote as New Order gets it: the staff app's quoteBasket, through the Worker's one quote route. */
    async function quotesNow(db: Db): Promise<Quotes> {
      const quotes: Quotes = {}
      for (const [label, basket] of Object.entries(baskets)) quotes[label] = await throughStaffApp('quoteBasket')(db, basket)
      return quotes
    }
    /** The scenario's quotes before its steps and after them, on one side. */
    async function quotesAround(name: string, side: 'old' | 'new'): Promise<{ before: Quotes; after: Quotes }> {
      const one = scenario(name)
      let before: Quotes = {}
      let after: Quotes = {}
      const watched: Scenario = {
        ...one,
        async run(context) {
          before = await quotesNow(context.db)
          await one.run(context)
        },
      }
      await replay(environment, watched, side === 'old' ? oldSide : sideFor(name), {
        async tamper(db) {
          after = await quotesNow(db)
        },
      })
      return { before, after }
    }
    const total = (quote: unknown): unknown => (quote as { ok?: boolean; quote?: { totals?: { amountDue?: unknown } } } | null)?.quote?.totals?.amountDue

    it.each([
      ['w48-band-price-set', 'Sam, a paid seat in Core'],
      ['w48-band-rules-set', 'Sam, a paid seat on Saturday afternoon'],
      ['w48-member-band-term-set', 'Mo (a Core member), a paid seat in Peak'],
      ['w48-postage-set', 'Sam, a candle posted'],
    ] as const)('%s: every basket quotes the same after the change as after the old function\'s, and "%s" is one the change moved', async (name, moved) => {
      const old = await quotesAround(name, 'old')
      const now = await quotesAround(name, 'new')
      expect(now.before).toEqual(old.before)
      expect(now.after).toEqual(old.after)
      // The check bites: the change is one a quote follows.
      expect((old.before[moved] as { ok?: boolean }).ok).toBe(true)
      expect((old.after[moved] as { ok?: boolean }).ok).toBe(true)
      expect(total(old.after[moved])).not.toEqual(total(old.before[moved]))
      expect(total(now.after[moved])).toEqual(total(old.after[moved]))
    })
  })

  describe('a deliberate difference is caught', () => {
    it('in what staff are told: a band price a penny out, a staff role, a promo code\'s discount, a field dropped from the staff list', async () => {
      const price = 'w48-band-price-set'
      const pennyOut = await runNew(price, { adjust: (action, answer) => (action === 'setBandPrice' && (answer as { band?: { price: string } }).band?.price === '22.50' ? { ...(answer as object), band: { ...(answer as { band: object }).band, price: '22.51' } } : answer) })
      expect(left(price, pennyOut)).toEqual(['.results[3].band.price'])

      const role = 'w48-staff-role-up-and-down'
      const wrongRole = await runNew(role, { adjust: (action, answer) => (action === 'setStaffRole' ? { ...(answer as object), role: 'admin' } : answer) })
      expect(left(role, wrongRole)).toEqual(['.results[0].role', '.results[2].role'])

      const promo = 'w48-promo-create'
      const wrongDiscount = await runNew(promo, { adjust: (action, answer) => (action === 'createPromoCode' ? { ...(answer as object), discount_value: '26' } : answer) })
      expect(left(promo, wrongDiscount)).toEqual(['.results[0].discount_value', '.results[1].discount_value'])

      const list = 'w48-staff-list'
      const withoutEmail = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([field]) => field !== 'email'))
      const dropped = await runNew(list, { adjust: (_action, answer) => (answer as Array<Record<string, unknown>>).map(withoutEmail) })
      expect(left(list, dropped)).toEqual(['.results[0][0].email', '.results[0][1].email', '.results[0][2].email'])
    })

    it('in a row: a switch that lands on the wrong staff member, a band window with the wrong band, a postage figure', async () => {
      const permission = 'w48-staff-permission-issue-refunds-on-and-off'
      const wrongMember = await runNew(permission, {}, { tamper: async (db) => void (await db.query('UPDATE staff SET can_issue_refunds = false WHERE id = $1', [ID.staff])) })
      // The recording's own switch goes on and off again, so no staff row is left changed: this one is.
      expect(left(permission, wrongMember)).toEqual(['.tables.staff'])

      const rules = 'w48-band-rules-set'
      const wrongBand = await runNew(rules, {}, { tamper: async (db) => void (await db.query("UPDATE band_rules SET band_id = $1 WHERE day_of_week = 6 AND from_time = '12:00'", [ID.band])) })
      expect(left(rules, wrongBand)).toContain('.tables.band_rules.added[1].band_id')

      const postage = 'w48-postage-set'
      const wrongFigure = await runNew(postage, {}, { tamper: async (db) => void (await db.query("UPDATE postage_settings SET express_price = '9.96'")) })
      expect(left(postage, wrongFigure)).toEqual(['.tables.postage_settings.changed[0].express_price'])
    })

    it('in what was set aside: a write with no audit row, a second audit row for one press, a press left unfinished', async () => {
      const name = 'w48-promo-update'
      const noRow = await runNew(name, {}, { tamper: async (db) => void (await db.query("DELETE FROM audit_log WHERE id = (SELECT id FROM audit_log WHERE action = 'promo.updated' ORDER BY at LIMIT 1)")) })
      expect(adminRowProblems(noRow)).toEqual(['promo.updated: 1 rows for 2 presses answered with a success'])

      const twice = await runNew(name, {}, { tamper: async (db) => void (await db.query("INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, request_id, details) SELECT actor_type, actor_id, action, entity_type, entity_id, request_id, details FROM audit_log WHERE action = 'promo.updated' ORDER BY at LIMIT 1")) })
      expect(adminRowProblems(twice)).toEqual(['promo.updated: 3 rows for 2 presses answered with a success'])

      const unfinished = await runNew(name, {}, { tamper: async (db) => void (await db.query("UPDATE api_idempotency SET status = 'in_progress', http_status = NULL WHERE key = (SELECT key FROM api_idempotency ORDER BY created_at LIMIT 1)")) })
      expect(adminStoredAnswerProblems(unfinished).length).toBe(1)
    })

    it('an allowance nobody needs fails, and a named difference can\'t be used on another path', async () => {
      const exact = 'w48-postage-set'
      const recording = await runNew(exact)
      const unneeded = W49_W54_DIFFERENCES.get(DECISION_SCENARIOS.GB8_SAVED[0]) ?? []
      expect(left(exact, recording, unneeded)).toEqual([expect.stringContaining('allowed difference not seen: Bug GB8 is closed')])

      // GB18's allowance on its own recording, with the edit let through as the old code let it: every path differs from its pin.
      const gb18 = DECISION_SCENARIOS.GB18[0]
      const asTheOldCode = await replay(environment, scenario(gb18), oldSide)
      expect(left(gb18, asTheOldCode, [])).toEqual([])
      expect(left(gb18, asTheOldCode)).toEqual([expect.stringContaining('allowed difference not seen: Bug GB18 is closed')])
    })
  })

  it("the words the differences name are the staff app's own, word for word", () => {
    const helper = readFileSync(path.join(staffAppDir(), 'backend/paddock/shared/adminWorker.ts'), 'utf8')
    expect(helper).toContain(`"${ADMIN_NO_ANSWER_WORDS}"`)
  })

  // W54a (W49 + W54 review S1; the lead's call: one step G rule). The golden files' params carry no stamp (the old
  // functions took none), so the replay presses each stamped edit as its screen does: the screen's read, then the
  // press with the stamp that read gave. These show the stamp is doing something, on the recordings' own seeds.
  describe('W54a: the stamp an edit carries', () => {
    it('there are four stamped edits, each one of the moved writes; every recording that saves one is replayed above with its stamps checked', () => {
      expect([...STAMPED_EDITS].sort()).toEqual(['setBandRules', 'setMembershipBandTerm', 'setPostageSettings', 'updatePromoCode'])
      for (const action of STAMPED_EDITS) expect(W54_ACTIONS.has(action), action).toBe(true)
      expect(STAMPED_ROUTES.map((one) => one.action).sort()).toEqual([...STAMPED_ACTIONS].sort())
    })

    it.each([
      ['w48-postage-set', 'setPostageSettings', 'postage_settings'],
      ['w48-band-rules-set', 'setBandRules', 'band_rules'],
      ['w48-member-band-term-set', 'setMembershipBandTerm', 'membership_band_terms'],
      ['w48-promo-update', 'updatePromoCode', 'promo_codes'],
    ] as const)('%s pressed exactly as the golden file has it, with no stamp (an older staff app): every %s is refused, and %s is untouched', async (name, action, table) => {
      // Every step attempted, so the scenario runs to its end whatever is refused.
      const one = scenario(name)
      const attempted: Scenario = { ...one, run: (context) => one.run({ ...context, call: context.attempt }) }
      const recording = await replay(environment, attempted, sideFor(name, { pressWithoutReading: true }))
      const presses = golden(name).results.length
      expect(presses).toBeGreaterThan(0)
      const refused = recording.results.filter((result) => (result as { thrown?: unknown; message?: unknown } | null)?.thrown === CHANGED_SINCE_WORDS || (result as { reason?: unknown } | null)?.reason === 'changed_since')
      // Each step that the recording saved (or refused after reading the row) is refused here instead.
      const saved = golden(name).results.filter((result) => !(result as { thrown?: unknown } | null)?.thrown).length
      expect(saved).toBeGreaterThan(0)
      expect(refused.length).toBeGreaterThanOrEqual(saved)
      expect(recording.tables[table], `${action}: ${table}`).toBeUndefined()
      expect(ownAuditRows(recording)).toEqual([])
      expect(stampedSaves(recording)).toBe(0)
    })

    it("the reviewer's example on a recording's own seed: ALLTEN corrected from 10% to 5% by one page, then switched off from a page loaded before it: refused, and ALLTEN stays 5% and on", async () => {
      const name = 'w48-promo-update'
      const one = scenario(name)
      const told: Scenario = {
        ...one,
        async run({ attempt, db }) {
          // Both pages load the list.
          const loaded = ((await throughStaffApp('getPromoCodes')(db, {})) as Array<{ id: string; stamp: string }>).find((row) => row.id === ID.promoPercent)?.stamp
          // B corrects the discount (the replay reads B's stamp for it, as B's page would hold it).
          await attempt('updatePromoCode', { ...allTen, discountValue: 5 })
          // A's switch, from the page loaded before B's change: every field as A's page has it, and A's stamp.
          await attempt('updatePromoCode', { ...allTen, active: false, stamp: loaded })
        },
      }
      const recording = await replay(environment, told, sideFor(name))
      expect(recording.results[0]).toMatchObject({ updated: true, promo: { discount_value: '5', active: true } })
      expect(recording.results[1]).toEqual({ updated: false, reason: 'changed_since', message: CHANGED_SINCE_WORDS })
      const rows = ownAuditRows(recording)
      expect(rows.map((row) => [row.details?.before?.['discount_value'], row.details?.after?.['discount_value'], row.details?.after?.['active']])).toEqual([['10', '5', true]])
      // The code's row: the discount B set, and nothing else. Still on. (The replay's clock is frozen, so B's change
      // left `updated_at` where it was: it is the stamp's fingerprint of the row that tells A's page it is out of date.)
      expect(recording.tables['promo_codes']?.changed).toEqual([{ id: ID.promoPercent, discount_value: ['10.00', '5.00'] }])
    })
  })

  // W54a (brief item 4; W49 + W54 review section 2 and "Claims" 3): the `created_by` difference, named in the shared
  // differences. No golden recording shows it, because the old function refused a sign-in in another letter case
  // before it wrote anything. Shown here on promo-create's own steps with the staff row stored in capitals.
  describe('W54a: who a new promo code says made it, for a sign-in in another letter case than its staff row', () => {
    const name = 'w48-promo-create'
    const STORED = 'Jo@Example.com'
    /** promo-create's own seed, with Jo's staff row stored in capitals; every step attempted. */
    const inCapitals = (): Scenario => {
      const one = scenario(name)
      return {
        ...one,
        async seed(db, stripe) {
          await one.seed(db, stripe)
          await db.query('UPDATE staff SET email = $1 WHERE id = $2', [STORED, ID.staff])
        },
        run: (context) => one.run({ ...context, call: context.attempt }),
      }
    }

    it('the old function refused such a sign-in outright: nothing was made', async () => {
      const old = await replay(environment, inCapitals(), oldSide)
      expect(old.results).toEqual([{ thrown: S3_OLD_WORDS }, { thrown: S3_OLD_WORDS }])
      expect(old.tables['promo_codes']).toBeUndefined()
    })

    it("now both codes are made, and `created_by` is the staff row's email, not the sign-in as typed: the one difference from the golden file, named", async () => {
      const recording = await replay(environment, inCapitals(), sideFor(name))
      const paths = createdByPaths(recording)
      expect(paths).toEqual(['.results[0].created_by', '.results[1].created_by', '.tables.promo_codes.added[0].created_by', '.tables.promo_codes.added[1].created_by'])
      // Unnamed, those four paths are all that differ from the golden file (made with the sign-in spelt as stored).
      expect(left(name, recording, []).sort()).toEqual([...paths].sort())
      expect((recording.results as Array<{ created_by?: unknown }>).map((result) => result.created_by)).toEqual([STORED, STORED])
      // Named, nothing is left; and the name is pinned to the stored email: the sign-in as typed there is a difference.
      expect(left(name, recording, [createdByIsTheStoredEmail(recording, STORED)])).toEqual([])
      const asTyped: Recording = { ...recording, results: recording.results.map((result, i) => (i === 0 ? { ...(result as object), created_by: 'JO@EXAMPLE.COM' } : result)) }
      expect(left(name, asTyped, [createdByIsTheStoredEmail(recording, STORED)])).toContain('.results[0].created_by')
    })

    it('with the sign-in spelt as its staff row (every golden recording), there is nothing to name: an allowance for it would not be needed, and fails', async () => {
      const recording = await runNew(name)
      expect(left(name, recording, [])).toEqual([])
      expect(left(name, recording, [createdByIsTheStoredEmail(recording, 'jo@example.com')])).toEqual([expect.stringContaining('allowed difference not seen')])
    })
  })
})
