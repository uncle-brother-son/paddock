import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Db } from '@/server/db'
import { insert, startTestDatabase, type TestDatabase } from '@/server/rules/testing/database'
import { listShopPasses, listShopPlans, readShopMemberships, saveUpTo, shopMemberships, type ShopPlan } from './memberships'

// Brief W80a (WQ84-WQ86): the memberships' and passes' read for the website, on the live schema.
vi.setConfig({ testTimeout: 60_000 })

const holder = vi.hoisted(() => ({ db: null as unknown, closed: 0 }))
vi.mock('@/server/db/connection', () => ({
  openRequestDb: () => holder.db as Db,
  closeRequestDb: () => {
    holder.closed += 1
  },
}))

let database: TestDatabase
let db: Db

beforeAll(async () => {
  database = await startTestDatabase({ schema: 'live' })
  db = database.db
  holder.db = db
})
afterAll(() => database.stop())
beforeEach(async () => {
  await database.pg.exec('RESET ROLE; TRUNCATE membership_plans, session_pass_types CASCADE; SET ROLE paddock_worker;')
  holder.closed = 0
})

let made = 0
/** A plan on sale, set up in Stripe. */
async function plan(sanityId: string | null, monthly: string | null, yearly: string | null, row: Record<string, unknown> = {}): Promise<void> {
  made += 1
  await insert(db, 'membership_plans', {
    sanity_plan_id: sanityId,
    name: sanityId ?? `No document ${made}`,
    level: 'core',
    price_monthly: monthly,
    price_yearly: yearly,
    sessions_included: 4,
    addons_included: 2,
    stripe_product_id: `prod_plan_${made}`,
    stripe_price_id: `price_plan_${made}`,
    stripe_price_id_yearly: `price_plan_yearly_${made}`,
    ...row,
  })
}

/** A pass type on sale. */
async function pass(sanityId: string | null, row: Record<string, unknown> = {}): Promise<void> {
  made += 1
  await insert(db, 'session_pass_types', {
    sanity_pass_type_id: sanityId,
    name: sanityId ?? `No document ${made}`,
    level: 'core',
    price: '50.00',
    sessions_included: 5,
    expiry_months: 3,
    stripe_product_id: `prod_pass_${made}`,
    stripe_price_id: `price_pass_${made}`,
    ...row,
  })
}

const onSale = (yearlyBefore: string | null, priceYearly: string): ShopPlan => ({
  sanityId: 'x',
  level: 'core',
  priceMonthly: '10.00',
  priceYearly,
  yearlyBefore,
  sessionsPerMonth: 4,
  addonsIncluded: 0,
})

describe('the plans', () => {
  it('each with its level, both prices, the yearly before-price (12 x monthly), sessions a month and add-ons; by name', async () => {
    await plan('yearling-core', '45.00', '480.00', { name: 'Yearling - Core', sessions_included: 4, addons_included: 1 })
    await plan('champion-all', '99.00', '1000.00', { name: 'Champion - All-Access', level: 'all_access', is_unlimited: true, sessions_included: 0, addons_included: 4 })
    expect(await listShopPlans(db)).toEqual([
      { sanityId: 'champion-all', level: 'all_access', priceMonthly: '99.00', priceYearly: '1000.00', yearlyBefore: '1188.00', sessionsPerMonth: 'unlimited', addonsIncluded: 4 },
      { sanityId: 'yearling-core', level: 'core', priceMonthly: '45.00', priceYearly: '480.00', yearlyBefore: '540.00', sessionsPerMonth: 4, addonsIncluded: 1 },
    ])
  })

  it('a yearly price at or above 12 x monthly has no before-price, and so does a plan missing either price', async () => {
    await plan('above', '10.00', '130.00')
    await plan('equal', '10.00', '120.00')
    await plan('monthly-only', '10.00', null)
    await plan('yearly-only', null, '100.00')
    const before = Object.fromEntries((await listShopPlans(db)).map((one) => [one.sanityId, one.yearlyBefore]))
    expect(before).toEqual({ above: null, equal: null, 'monthly-only': null, 'yearly-only': null })
  })

  it('pence are kept: 12 x 33.33 is 399.96', async () => {
    await plan('pence', '33.33', '300.00')
    expect((await listShopPlans(db))[0]?.yearlyBefore).toBe('399.96')
  })

  it('an inactive plan, one with no Sanity document, one not set up in Stripe and one with no price are left out', async () => {
    await plan('on-sale', '10.00', '100.00')
    await plan('off-sale', '10.00', '100.00', { active: false })
    await plan(null, '10.00', '100.00')
    await plan('not-in-stripe', '10.00', '100.00', { stripe_product_id: null })
    await plan('unpriced', null, null)
    expect((await listShopPlans(db)).map((one) => one.sanityId)).toEqual(['on-sale'])
  })
})

describe('Save up to N% (WQ85)', () => {
  it('is the largest saving across the plans on sale, rounded to a whole percent', async () => {
    // 1 - 100/120 = 16.67% (17); 1 - 480/540 = 11.1%; 130 > 120 saves nothing and isn't counted.
    await plan('a', '10.00', '100.00')
    await plan('b', '45.00', '480.00')
    await plan('c', '10.00', '130.00')
    expect((await shopMemberships(db)).saveUpTo).toBe(17)
  })

  it("a plan off sale or with no document isn't counted", async () => {
    await plan('b', '45.00', '480.00')
    await plan('off', '10.00', '50.00', { active: false })
    await plan(null, '10.00', '50.00')
    expect((await shopMemberships(db)).saveUpTo).toBe(11)
  })

  it('rounds to the nearest: 15.5% is 16, 15.4% is 15', () => {
    expect(saveUpTo([onSale('100.00', '84.50')])).toBe(16)
    expect(saveUpTo([onSale('100.00', '84.60')])).toBe(15)
  })

  it('is null when no plan saves, or there are none', async () => {
    expect(saveUpTo([])).toBeNull()
    await plan('above', '10.00', '130.00')
    await plan('equal', '10.00', '120.00')
    await plan('monthly-only', '10.00', null)
    expect((await shopMemberships(db)).saveUpTo).toBeNull()
  })
})

describe('the passes', () => {
  it('each with its level, price, sessions and how long it lasts; by name', async () => {
    await pass('ten-all', { name: '10 Session - All-Access', level: 'all_access', price: '120.00', sessions_included: 10, expiry_months: 6 })
    await pass('five-core', { name: '5 Session - Core', price: '50.00', sessions_included: 5, expiry_months: 3 })
    expect(await listShopPasses(db)).toEqual([
      { sanityId: 'ten-all', level: 'all_access', price: '120.00', sessions: 10, expiryMonths: 6 },
      { sanityId: 'five-core', level: 'core', price: '50.00', sessions: 5, expiryMonths: 3 },
    ])
  })

  it('an inactive pass type, one with no Sanity document, and one with no price or no sessions are left out', async () => {
    await pass('on-sale')
    await pass('off-sale', { active: false })
    await pass(null)
    await pass('unpriced', { price: null })
    await pass('no-sessions', { sessions_included: null })
    expect((await listShopPasses(db)).map((one) => one.sanityId)).toEqual(['on-sale'])
  })
})

describe('the whole read', () => {
  it('holds no Stripe id and no database id', async () => {
    await plan('plan', '10.00', '100.00')
    await pass('pass')
    const answer = JSON.stringify(await readShopMemberships())
    expect(answer).toContain('"plan"')
    expect(answer).toContain('"pass"')
    expect(answer).not.toMatch(/stripe|"(prod|price)_/i)
    expect(answer).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/)
  })

  it('names only its own fields', async () => {
    await plan('plan', '10.00', '100.00')
    await pass('pass')
    const answer = await readShopMemberships()
    expect(Object.keys(answer).sort()).toEqual(['passes', 'plans', 'saveUpTo'])
    expect(Object.keys(answer.plans[0] ?? {}).sort()).toEqual(['addonsIncluded', 'level', 'priceMonthly', 'priceYearly', 'sanityId', 'sessionsPerMonth', 'yearlyBefore'])
    expect(Object.keys(answer.passes[0] ?? {}).sort()).toEqual(['expiryMonths', 'level', 'price', 'sanityId', 'sessions'])
  })

  it('reads on a connection of its own, and closes it, a failed read included', async () => {
    expect(await readShopMemberships()).toEqual({ plans: [], saveUpTo: null, passes: [] })
    expect(holder.closed).toBe(1)
    const spy = vi.spyOn(db, 'query').mockRejectedValueOnce(new Error('down'))
    await expect(readShopMemberships()).rejects.toThrow('down')
    expect(holder.closed).toBe(2)
    spy.mockRestore()
  })
})
