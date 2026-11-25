import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as browser from '@/lib/shop/gift-card-amount'
import type { Db } from '@/server/db'
import { insert, startTestDatabase, type TestDatabase } from '@/server/rules/testing/database'
import { SHOP_WORDS } from './failure-messages'
import { checkOtherAmount, otherAmountLimits } from './gift-card-amount'
import { readShopGiftCard, shopGiftCard } from './reads'

// Brief W76a (WQ19, WQ63): the gift card's read for its page, on the live schema, and the Other amount's one rule.
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
  await database.pg.exec('RESET ROLE; TRUNCATE gift_card_presets, gift_card_types CASCADE; SET ROLE paddock_worker;')
  holder.closed = 0
})

let made = 0
/** A gift card type on sale, with its presets: each `[amount, on sale]`, made in the order given. */
async function type(sanityId: string | null, row: Record<string, unknown> = {}, presets: Array<[amount: string, active?: boolean]> = []): Promise<void> {
  const id = await insert(db, 'gift_card_types', { sanity_gift_card_type_id: sanityId, name: sanityId ?? 'No document', stripe_product_id: `prod_gift_${++made}`, ...row })
  for (const [amount, active = true] of presets) {
    await insert(db, 'gift_card_presets', { gift_card_type_id: id, amount, active, stripe_price_id: `price_gift_${++made}` })
  }
}

const OTHER = { custom_amount_enabled: true, custom_amount_min: '1.00', custom_amount_max: '1000.00' }
const LIMITS = { lowest: '1.00', highest: '1000.00' }

describe("the gift card's read", () => {
  it('its amounts lowest first (as money, not as text), the Other limits and how long a card lasts; nothing else', async () => {
    await type('gift', { ...OTHER, expiry_months: 6 }, [['150.00'], ['30.00'], ['90.00'], ['15.00'], ['60.00']])
    // Another type's presets are its own.
    await type('other', {}, [['5.00']])
    expect(await shopGiftCard(db, 'gift')).toEqual({ sanityId: 'gift', amounts: ['15.00', '30.00', '60.00', '90.00', '150.00'], other: LIMITS, expiryMonths: 6 })
  })

  it('an inactive preset is left out, the lowest included; with none left there are no amounts', async () => {
    await type('gift', OTHER, [['10.00', false], ['25.00'], ['50.00', false], ['75.00']])
    expect((await shopGiftCard(db, 'gift'))?.amounts).toEqual(['25.00', '75.00'])
    await type('bare', OTHER, [['10.00', false]])
    expect(await shopGiftCard(db, 'bare')).toMatchObject({ amounts: [], other: LIMITS })
  })

  it('Other not allowed gives no limits, even with limits still on the row', async () => {
    await type('never', {}, [['25.00']])
    await type('turned-off', { ...OTHER, custom_amount_enabled: false }, [['25.00']])
    expect((await shopGiftCard(db, 'never'))?.other).toBeNull()
    expect((await shopGiftCard(db, 'turned-off'))?.other).toBeNull()
  })

  it('a type off sale, an unknown one and one with no Sanity document are not found', async () => {
    await type('off', { ...OTHER, active: false }, [['25.00']])
    await type(null, OTHER, [['25.00']])
    for (const id of ['off', 'unknown', '', 'null']) expect(await shopGiftCard(db, id), id).toBeNull()
  })

  it('holds no Stripe id and no database id', async () => {
    await type('gift', OTHER, [['25.00']])
    const answer = JSON.stringify(await readShopGiftCard('gift'))
    expect(answer).not.toMatch(/stripe|"(prod|price)_/i)
    expect(answer).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/)
  })

  it('readShopGiftCard reads on a connection of its own, and closes it, a failed read included', async () => {
    await type('gift', OTHER, [['25.00']])
    expect(await readShopGiftCard('gift')).toMatchObject({ sanityId: 'gift' })
    expect(holder.closed).toBe(1)
    const spy = vi.spyOn(db, 'query').mockRejectedValueOnce(new Error('down'))
    await expect(readShopGiftCard('gift')).rejects.toThrow('down')
    expect(holder.closed).toBe(2)
    spy.mockRestore()
  })
})

describe('the limits, from the staff app settings', () => {
  it.each([
    ['the live ones', true, '1.00', '1000.00', LIMITS],
    ['a lowest of 0: from £1', true, '0.00', '50.00', { lowest: '1.00', highest: '50.00' }],
    ['pence: the whole pounds inside them', true, '1.01', '99.99', { lowest: '2.00', highest: '99.00' }],
    ['one amount', true, '20.00', '20.00', { lowest: '20.00', highest: '20.00' }],
    ['no whole pound between them', true, '5.10', '5.90', null],
    ['no lowest', true, null, '50.00', null],
    ['no highest', true, '1.00', null, null],
    ['not allowed', false, '1.00', '1000.00', null],
  ])('%s', (_what, allowed, min, max, limits) => {
    expect(otherAmountLimits(allowed, min, max)).toEqual(limits)
  })
})

describe('the Other amount (WQ63)', () => {
  it.each([
    ['1', '1.00'],
    ['2', '2.00'],
    ['999', '999.00'],
    ['1000', '1000.00'],
    ['1,000', '1000.00'],
    ['£1,000', '1000.00'],
    ['25.00', '25.00'],
    ['25.0', '25.00'],
    [' £25 ', '25.00'],
    ['0025', '25.00'],
  ])('takes "%s"', (typed, amount) => {
    expect(checkOtherAmount(typed, LIMITS)).toEqual({ ok: true, amount })
  })

  it.each([
    ['0', 'below_lowest'],
    ['0.00', 'below_lowest'],
    ['1001', 'above_highest'],
    ['1,001', 'above_highest'],
    ['99999999999999999999999', 'above_highest'],
    ['25.50', 'not_whole_pounds'],
    ['25.5', 'not_whole_pounds'],
    ['0.99', 'not_whole_pounds'],
    ['1000.01', 'not_whole_pounds'],
    ['25.000', 'not_whole_pounds'],
    ['', 'not_whole_pounds'],
    ['   ', 'not_whole_pounds'],
    ['£', 'not_whole_pounds'],
    ['abc', 'not_whole_pounds'],
    ['25a', 'not_whole_pounds'],
    ['-5', 'not_whole_pounds'],
    ['+5', 'not_whole_pounds'],
    ['1e2', 'not_whole_pounds'],
    ['0x10', 'not_whole_pounds'],
    ['1,00', 'not_whole_pounds'],
    ['10 00', 'not_whole_pounds'],
    ['Infinity', 'not_whole_pounds'],
    ['25\n30', 'not_whole_pounds'],
  ] as const)('refuses "%s": %s', (typed, reason) => {
    expect(checkOtherAmount(typed, LIMITS)).toEqual({ ok: false, reason, message: SHOP_WORDS.otherAmount[reason](LIMITS) })
  })

  it("the type's own limits, both included", () => {
    const limits = { lowest: '20.00', highest: '200.00' }
    const outcome = (typed: string) => {
      const answer = checkOtherAmount(typed, limits)
      return answer.ok ? answer.amount : answer.reason
    }
    expect(['19', '20', '100', '200', '201'].map(outcome)).toEqual(['below_lowest', '20.00', '100.00', '200.00', 'above_highest'])
  })

  it('the words for each reason', () => {
    const { not_whole_pounds, below_lowest, above_highest } = SHOP_WORDS.otherAmount
    expect([not_whole_pounds(), below_lowest(LIMITS), above_highest({ lowest: '20.00', highest: '200.00' })]).toEqual([
      'Enter an amount in whole pounds',
      'Enter an amount between £1 and £1,000',
      'Enter an amount between £20 and £200',
    ])
  })

  it('is one rule: the page is given this very function', () => {
    expect(browser.checkOtherAmount).toBe(checkOtherAmount)
  })

  it('is pure, for the browser: it imports only the words, which import nothing', () => {
    const source = (file: string) => readFileSync(path.resolve(__dirname, file), 'utf8')
    const imports = (file: string) => [...source(file).matchAll(/(?:^|[\s;])(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map(([, name]) => name)
    expect(imports('gift-card-amount.ts')).toEqual(['./failure-messages'])
    expect(imports('failure-messages.ts')).toEqual([])
    // The check sees one: the read has 'server-only'.
    expect(imports('reads.ts')).toContain('server-only')
  })
})
