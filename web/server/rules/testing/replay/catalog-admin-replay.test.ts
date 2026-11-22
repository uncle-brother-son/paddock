import { appendFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Db } from '@/server/db'
import { CHANGED_SINCE_WORDS } from '@/server/rules/admin/stamp'
import { pathsPinnedBy } from './admin-differences'
import { adminRowProblems, adminStoredAnswerProblems, answeredStampProblems, comparableAdmin, newAdminSide, STEP_G_ACTIONS_MOVED, W55_ACTIONS, W56_ACTIONS, type AnsweredStamp } from './admin-side'
import { throughStaffApp } from './booking-side'
import { isW55W56Scenario, REFUSED_NOW, W55_W56_DECISIONS, W55_W56_DIFFERING, w55W56Differences } from './catalog-differences'
import { compareRecordings, type AllowedDifference, type Recording, type Row } from './compare'
import { oldSide, readGolden, replay, startReplay, type ReplayEnvironment, type Scenario } from './harness'
import { ID, paidSeat, sam } from './scenarios'
import { W48_ID, w48Scenarios } from './w48-scenarios'

// Briefs W55 + W56 ("Parity and tests"; G-plan 4.9 items 3 and 4): the catalogue's families (W48's recordings of the
// old functions) through the staff app's thin functions and the Worker's routes, as the screens press them.
vi.setConfig({ testTimeout: 300_000 })

const holder = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {},
}))

const compareSides = (golden: Recording, recording: Recording, named: readonly AllowedDifference[]) => compareRecordings(comparableAdmin(golden), comparableAdmin(recording), named)

const everyStepGScenario = w48Scenarios()
const families = everyStepGScenario.filter((scenario) => isW55W56Scenario(scenario.name))
const MOVED_HERE: ReadonlySet<string> = new Set([...W55_ACTIONS, ...W56_ACTIONS])

describe("step G's side of the replay: the catalogue (W55 + W56)", () => {
  let environment: ReplayEnvironment
  beforeAll(async () => {
    process.env.STAFF_API_KEY = 'test-staff-api-key'
    environment = await startReplay()
    holder.db = environment.database.db
  })
  afterAll(() => environment.stop())

  const golden = (name: string) => readGolden(name) as Recording
  const named = (name: string): readonly AllowedDifference[] => w55W56Differences(name, golden(name))
  const left = (name: string, recording: Recording, allowed: readonly AllowedDifference[] = named(name)) => compareSides(golden(name), recording, allowed).map((difference) => difference.path)
  const rawPaths = (name: string, recording: Recording): string[] => left(name, recording, []).sort()
  const pinnedPaths = (name: string): string[] => named(name).flatMap((difference) => [...pathsPinnedBy(difference)]).sort()

  describe.each(families.map((one) => [one.name, one] as const))('%s', (name, one: Scenario) => {
    it('matches its golden file, with its named differences only; its audit rows, stored answers and stamps are right', async () => {
      const calls: Array<{ action: string; side: 'new' | 'old' }> = []
      const stamps: AnsweredStamp[] = []
      const recording = await replay(environment, one, newAdminSide({ calls, stamps, refusedPressesAsAnswers: REFUSED_NOW.has(name) }))
      expect(golden(name), `No golden file for ${name}`).not.toBeNull()
      expect(calls.filter((call) => STEP_G_ACTIONS_MOVED.has(call.action)).every((call) => call.side === 'new')).toBe(true)
      expect(calls.some((call) => MOVED_HERE.has(call.action))).toBe(true)
      if (process.env.W55_DIFFERENCES_OUT) {
        appendFileSync(
          process.env.W55_DIFFERENCES_OUT,
          `${JSON.stringify({ name, differences: compareSides(golden(name), recording, []), unnamed: compareSides(golden(name), recording, named(name)), rows: adminRowProblems(recording), stored: adminStoredAnswerProblems(recording), stamps: answeredStampProblems(stamps), audit: recording.tables['audit_log']?.added ?? [], results: recording.results })}\n`
        )
        return
      }
      expect(adminRowProblems(recording), `${name}: the Worker's audit rows`).toEqual([])
      expect(adminStoredAnswerProblems(recording), `${name}: the stored answers`).toEqual([])
      expect(answeredStampProblems(stamps), `${name}: the stamps`).toEqual([])
      expect(compareSides(golden(name), recording, named(name))).toEqual([])
      expect(rawPaths(name, recording)).toEqual(pinnedPaths(name))
    })
  })

  const scenario = (name: string): Scenario => {
    const found = everyStepGScenario.find((one) => one.name === name)
    if (!found) throw new Error(`No scenario ${name}`)
    return found
  }
  const runNew = (name: string, options: Parameters<typeof newAdminSide>[0] = {}, replayOptions: Parameters<typeof replay>[3] = {}) =>
    replay(environment, scenario(name), newAdminSide({ refusedPressesAsAnswers: REFUSED_NOW.has(name), ...options }), replayOptions)
  type AuditRow = Row & { action?: string; entity_type?: string; details?: Record<string, unknown> }
  const ownAuditRows = (recording: Recording): AuditRow[] => ((recording.tables['audit_log']?.added ?? []) as AuditRow[]).filter((row) => /^(catalog|stock)\./.test(String(row.action)))

  it('the families are whole: every catalogue recording W48 made is replayed here, and every named difference is for a recording that exists', () => {
    expect(families.length).toBe(103)
    expect(W55_W56_DIFFERING.every((name) => families.some((one) => one.name === name))).toBe(true)
    // 32 match their golden files exactly; 71 have named differences (W55a: the new size group refused, review S2).
    expect(W55_W56_DIFFERING.length).toBe(71)
    expect(families.filter((one) => named(one.name).length === 0).length).toBe(32)
    expect([...REFUSED_NOW].every((name) => W55_W56_DIFFERING.includes(name))).toBe(true)
    // GB9 is kept by Wayne's decision (Q52): its recording matches exactly.
    expect(named('w48-gb9-a-level-change-reaches-passes-already-sold')).toEqual([])
    expect(Object.keys(W55_W56_DECISIONS).sort()).toEqual(['GB10', 'GB12', 'GB13', 'GB2', 'GB21', 'GB23', 'L2', 'NEW_GROUP_OVERLAP', 'NO_ANSWER', 'PASS_LEVEL_STAFF', 'W61', 'WORDS'])
    expect([W55_ACTIONS.size, W56_ACTIONS.size]).toEqual([11, 18])
  })

  describe('what the old functions never recorded is now recorded', () => {
    it('a new variant with starting stock: one audit row, and its ledger row naming the staff member; a stock press: the stock before and after', async () => {
      const made = await runNew('w48-variant-create-with-starting-stock')
      expect(ownAuditRows(made).map((row) => [row.action, row['actor_id'], row.entity_type, row.details?.['startingStock']])).toEqual([['catalog.variant_created', ID.staff, 'product_variant', 10]])
      const ledger = (made.tables['stock_adjustments']?.added ?? []) as Row[]
      expect(ledger.map((row) => [row['change_amount'], row['reason'], row['staff_id']])).toEqual([[10, 'Initial stock', ID.staff]])
      const stock = await runNew('w48-stock-adjust-each-reason')
      expect(ownAuditRows(stock).map((row) => [(row.details?.['before'] as { stock_quantity?: number })?.stock_quantity, (row.details?.['after'] as { stock_quantity?: number })?.stock_quantity])).toEqual([
        [5, 15],
        [15, 13],
        [13, 12],
        [12, 11],
        [11, 12],
        [12, 0],
      ])
    })

    it('a price: who, and the prices before and after; a level change: the holder count', async () => {
      const price = await runNew('w48-price-product-base-member-and-sale')
      expect(ownAuditRows(price).map((row) => [row.action, row.entity_type, row.details?.['before'], row.details?.['after']])).toEqual([
        ['catalog.price_set', 'product', { base_price: '12.00', member_price: null, sale_price: null }, { base_price: '14.00', member_price: '11.50', sale_price: '9.99' }],
      ])
      const level = await runNew('w48-gb9-a-level-change-reaches-passes-already-sold')
      expect(ownAuditRows(level).map((row) => [row.action, row.details?.['after'], row.details?.['holders']])).toEqual([['catalog.details_set', { level: 'core' }, 1]])
    })

    it('a refused press leaves no row', async () => {
      for (const name of ['w48-gb21-a-range-may-overlap-the-next-size-group', 'w48-gb10-a-pass-type-saved-with-no-sessions-and-a-negative-expiry', 'w48-stock-adjust-refusals', 'w48-variant-create-refusals', 'w48-tier-create-where-one-band-already-has-the-group']) {
        const recording = await runNew(name)
        const rows = ownAuditRows(recording)
        // variant-create-refusals saves one press (L2: a product never synced to Stripe), and the overlap recording
        // first makes the 11 to 14 group: only those have a row, and none is the refused press's.
        const saved: Record<string, string[]> = { 'w48-variant-create-refusals': ['catalog.variant_created'], 'w48-gb21-a-range-may-overlap-the-next-size-group': ['catalog.tier_created'] }
        expect(rows.map((row) => row.action), name).toEqual(saved[name] ?? [])
      }
    })
  })

  describe("the stale-page rule: an edit pressed with no stamp (a page that read nothing first) is refused `changed_since`, and nothing is written", () => {
    it.each([
      ['w48-variant-details-set', 'product_variants'],
      ['w48-service-type-details-set', 'service_types'],
      ['w48-tier-range-set', 'service_type_price_tiers'],
      ['w48-gift-card-type-custom-amounts-set-and-off', 'gift_card_types'],
    ] as const)('%s', async (name, table) => {
      const recording = await runNew(name, { pressWithoutReading: true, refusedPressesAsAnswers: true })
      const refused = recording.results.filter((result) => JSON.stringify(result) === JSON.stringify({ thrown: CHANGED_SINCE_WORDS }))
      expect(refused.length).toBeGreaterThan(0)
      expect(recording.tables[table]).toBeUndefined()
      expect(ownAuditRows(recording)).toEqual([])
    })
  })

  describe("New Order's basket quote before and after each price change agrees with the old code's", () => {
    const cash = { method: 'cash' }
    const baskets: Record<string, unknown> = {
      'Sam, two soaps': { customerId: ID.customer, products: [{ productVariantId: ID.variant, quantity: 2, unitPrice: 12, systemUnitPrice: 12 }], payment: cash },
      'Sam, a paid seat with a towel': { customerId: ID.customer, booking: { ...paidSeat(), addons: [{ addonId: ID.addon, quantity: 1, unitPrice: 5, systemUnitPrice: 5 }] }, payment: cash },
      'Sam, a session pass': { customerId: ID.customer, sessionPassTypeId: ID.passType, payment: cash },
      'Sam and Alex, the private session': { customerId: ID.customer, booking: { ...paidSeat([sam, { name: 'Alex Guest', email: 'alex@example.com' }]), sessionId: ID.privateSession }, payment: cash },
      'Sam, a £60 gift card': { customerId: ID.customer, giftCard: { giftCardPresetId: ID.giftCardPreset, fulfillmentMethod: 'digital' }, payment: cash },
    }
    type Quotes = Record<string, unknown>
    async function quotesNow(db: Db): Promise<Quotes> {
      const quotes: Quotes = {}
      for (const [label, basket] of Object.entries(baskets)) quotes[label] = await throughStaffApp('quoteBasket')(db, basket)
      return quotes
    }
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
      await replay(environment, watched, side === 'old' ? oldSide : newAdminSide({ refusedPressesAsAnswers: REFUSED_NOW.has(name) }), {
        async tamper(db) {
          after = await quotesNow(db)
        },
      })
      return { before, after }
    }

    it.each([
      ['w48-price-product-base-member-and-sale', 'Sam, two soaps'],
      ['w48-price-addon-base-and-member', 'Sam, a paid seat with a towel'],
      ['w48-price-session-pass', 'Sam, a session pass'],
      ['w48-tier-price-set', 'Sam and Alex, the private session'],
      ['w48-gift-card-preset-price-set', 'Sam, a £60 gift card'],
      ['w48-tier-range-set', null],
      ['w48-price-public-service-type', null],
    ] as const)('%s: every basket quotes the same before and after as on the old side; "%s" is one the change moved', async (name, moved) => {
      const old = await quotesAround(name, 'old')
      const now = await quotesAround(name, 'new')
      expect(now.before).toEqual(old.before)
      expect(now.after).toEqual(old.after)
      if (moved) {
        // The check bites: the change is one this basket's quote follows.
        expect(JSON.stringify(old.after[moved])).not.toEqual(JSON.stringify(old.before[moved]))
      }
    })
  })

  describe('a deliberate difference is caught', () => {
    it('a price a penny out in an answer, a stock figure one out, a size group left in one band', async () => {
      const price = 'w48-price-product-base-member-and-sale'
      const pennyOut = await runNew(price, { adjust: (action, answer) => (action === 'updateCatalogItemPrice' ? { ...(answer as object), item: { ...(answer as { item: object }).item, sale_price: '9.98' } } : answer) })
      expect(left(price, pennyOut)).toEqual(['.results[0].item.sale_price'])

      const stock = 'w48-stock-adjust-each-reason'
      const oneOut = await runNew(stock, { adjust: (action, answer) => (action === 'adjustVariantStock' && (answer as { stock_quantity?: number }).stock_quantity === 15 ? { ...(answer as object), stock_quantity: 16 } : answer) })
      expect(left(stock, oneOut)).toEqual(['.results[0].stock_quantity'])

      const range = 'w48-gb21-a-size-group-range-saved-in-one-band-and-not-the-other'
      // Peak put back to 1 to 10, as the old code left it: the comparison alone lets that path through (its value is the
      // golden file's), and the pinned paths catch it.
      const halfMoved = await runNew(range, {}, { tamper: async (db) => void (await db.query('UPDATE service_type_price_tiers SET max_people = 10 WHERE id = $1', [W48_ID.tierPeak])) })
      expect(rawPaths(range, halfMoved)).not.toEqual(pinnedPaths(range))
      expect(rawPaths(range, await runNew(range))).toEqual(pinnedPaths(range))
    })

    it('a Stripe price made after all (L2) is caught by its pin', async () => {
      const name = 'w48-variant-create-with-no-starting-stock'
      // The answer carrying a price made as the old route made it: the same value as the golden file, so only the
      // pinned paths see it.
      const made = await runNew(name, { adjust: (action, answer) => (action === 'createProductVariant' ? { ...(answer as object), stripePriceId: 'price_fake_0001' } : answer) })
      expect(pinnedPaths(name)).toContain('.results[0].stripePriceId')
      expect(rawPaths(name, made)).not.toContain('.results[0].stripePriceId')
      expect(rawPaths(name, made)).not.toEqual(pinnedPaths(name))
      // A made price under another id is caught by the pin itself.
      const other = await runNew(name, { adjust: (action, answer) => (action === 'createProductVariant' ? { ...(answer as object), stripePriceId: 'price_fake_0009' } : answer) })
      expect(left(name, other)).toEqual(['.results[0].stripePriceId'])
    })

    it('an allowance nobody needs fails: L2\'s on a recording that matches exactly', async () => {
      const exact = 'w48-products-read'
      const recording = await runNew(exact)
      expect(left(exact, recording, [])).toEqual([])
      const unneeded = named('w48-product-active-off-and-on')
      expect(left(exact, recording, unneeded)).toEqual(unneeded.map(() => expect.stringContaining('allowed difference not seen')))
    })
  })
})
