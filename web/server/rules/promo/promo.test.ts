import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PromoEligibleLine } from '@/contracts'
import { fixtures, startTestDatabase, type TestDatabase } from '@/server/rules/testing/database'
import { spreadFixedDiscount } from './promo-codes'
import { validatePromoCode } from './validate-promo-code'

let t: TestDatabase
let customer: string, other: string

const seat = (amount: number, isMemberPriced = false) => ({ key: `seat:${amount}`, itemType: 'booking', amount, isMemberPriced })

beforeAll(async () => {
  t = await startTestDatabase()
  customer = await fixtures.customer(t.db)
  other = await fixtures.customer(t.db)
})

afterAll(() => t.stop())

const validate = (code: string, lines: PromoEligibleLine[] = [seat(50)], customerId = customer, now?: Date) =>
  validatePromoCode(t.db, { code, customerId, lines }, now)

async function promo(row: Record<string, unknown>): Promise<string> {
  const id = await fixtures.promo(t.db, row)
  const rows = await t.db.query<{ code: string }>('SELECT code FROM promo_codes WHERE id = $1', [id])
  return rows[0]?.code as string
}

describe('validatePromoCode', () => {
  it('not found', async () => {
    expect(await validate('NOPE')).toEqual({ ok: false, reason: 'not_found', message: 'That promo code does not exist.' })
  })

  it('finds the code in any case', async () => {
    await promo({ code: 'MIXED-1' })
    expect(await validate('mixed-1')).toMatchObject({ ok: true, code: 'MIXED-1' })
  })

  it('inactive', async () => {
    expect(await validate(await promo({ active: false }))).toEqual({ ok: false, reason: 'inactive', message: 'That promo code is not active.' })
  })

  it('expiry goes by the London date, and the day itself is still valid', async () => {
    const code = await promo({ expires_on: '2026-07-15' })

    // 23:30 UTC on the 15th is already the 16th in London (BST).
    expect(await validate(code, [seat(50)], customer, new Date('2026-07-15T22:59:59Z'))).toMatchObject({ ok: true })
    expect(await validate(code, [seat(50)], customer, new Date('2026-07-15T23:00:00Z'))).toEqual({
      ok: false,
      reason: 'expired',
      message: 'That promo code has expired.',
    })
  })

  it('used up', async () => {
    const code = await promo({ max_total_uses: 2 })
    const [row] = await t.db.query<{ id: string }>('SELECT id FROM promo_codes WHERE code = $1', [code])
    await fixtures.redemption(t.db, { promo_code_id: row?.id, customer_id: other })
    expect(await validate(code)).toMatchObject({ ok: true })

    await fixtures.redemption(t.db, { promo_code_id: row?.id, customer_id: other })
    expect(await validate(code)).toEqual({ ok: false, reason: 'max_uses_reached', message: 'That promo code has reached its maximum number of uses.' })
  })

  it('one per customer', async () => {
    const code = await promo({ one_use_per_customer: true })
    const [row] = await t.db.query<{ id: string }>('SELECT id FROM promo_codes WHERE code = $1', [code])
    await fixtures.redemption(t.db, { promo_code_id: row?.id, customer_id: customer })

    expect(await validate(code)).toEqual({ ok: false, reason: 'already_used_by_customer', message: 'This customer has already used that promo code.' })
    expect(await validate(code, [seat(50)], other)).toMatchObject({ ok: true })
  })

  it('single customer', async () => {
    const code = await promo({ restricted_customer_id: customer })

    expect(await validate(code)).toMatchObject({ ok: true })
    expect(await validate(code, [seat(50)], other)).toEqual({
      ok: false,
      reason: 'not_for_this_customer',
      message: 'That promo code is restricted to a different customer.',
    })
  })

  it('minimum spend is on the eligible subtotal before discount', async () => {
    const code = await promo({ min_spend: '30', applies_to: ['booking'] })

    expect(await validate(code, [seat(29.99), { key: 'p', itemType: 'product', amount: 100 }])).toEqual({
      ok: false,
      reason: 'below_min_spend',
      message: 'The eligible items do not reach this code’s minimum spend.',
    })
    expect(await validate(code, [seat(30)])).toMatchObject({ ok: true })
  })

  it('percentage: each line rounded to pence, the total their sum', async () => {
    const code = await promo({ discount_type: 'percentage', discount_value: '12.5' })

    expect(await validate(code, [{ ...seat(9.99), key: 'a' }, { ...seat(10.01), key: 'b' }])).toMatchObject({
      ok: true,
      discountType: 'percentage',
      discountValue: 12.5,
      discountTotal: 2.5,
      perLine: [
        { key: 'a', discount: 1.25 },
        { key: 'b', discount: 1.25 },
      ],
    })
  })

  it('fixed: spread by amount, never above a line or the subtotal', async () => {
    const code = await promo({ discount_type: 'fixed', discount_value: '10' })

    expect(await validate(code, [{ ...seat(30), key: 'a' }, { ...seat(70), key: 'b' }])).toMatchObject({
      discountType: 'fixed',
      discountTotal: 10,
      perLine: [
        { key: 'a', discount: 3 },
        { key: 'b', discount: 7 },
      ],
    })
    expect(await validate(code, [{ ...seat(4), key: 'a' }])).toMatchObject({ discountTotal: 4, perLine: [{ key: 'a', discount: 4 }] })
  })

  it('member-price lines are left out unless the code allows them', async () => {
    const standard = await promo({ applies_on_member_prices: false })
    const all = await promo({ applies_on_member_prices: true })
    const lines = [{ ...seat(20, true), key: 'member' }, { ...seat(20), key: 'guest' }]

    expect(await validate(standard, lines)).toMatchObject({ perLine: [{ key: 'guest', discount: 2 }] })
    expect(await validate(all, lines)).toMatchObject({
      perLine: [
        { key: 'member', discount: 2 },
        { key: 'guest', discount: 2 },
      ],
    })
    expect(await validate(standard, [seat(20, true)])).toEqual({
      ok: false,
      reason: 'nothing_eligible',
      message: 'Nothing in this basket is eligible for that promo code.',
    })
  })

  it('a line type the code does not cover, or no lines at all, is nothing eligible', async () => {
    const code = await promo({ applies_to: ['membership'] })

    expect(await validate(code)).toMatchObject({ reason: 'nothing_eligible' })
    expect(await validatePromoCode(t.db, { code, customerId: customer })).toMatchObject({ reason: 'nothing_eligible' })
  })

  it('checks access before the basket', async () => {
    const code = await promo({ active: false, min_spend: '1000' })
    expect(await validate(code, [])).toMatchObject({ reason: 'inactive' })
  })
})

describe('spreadFixedDiscount', () => {
  it('hands out leftover pence from the last line', () => {
    expect(spreadFixedDiscount(1, [10, 10, 10])).toEqual([0.33, 0.33, 0.34])
  })

  it('never gives more than the lines hold, or anything for nothing', () => {
    expect(spreadFixedDiscount(100, [1, 2])).toEqual([1, 2])
    expect(spreadFixedDiscount(0, [1, 2])).toEqual([0, 0])
    expect(spreadFixedDiscount(5, [])).toEqual([])
  })
})
