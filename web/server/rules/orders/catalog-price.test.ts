import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { staffAppDir } from '@/server/rules/testing/staff-app-dir'
import { addonMemberPriced, addonPriceFor, addonPriceGap, variantMemberPriced, variantPriceFor, variantPriceGap, type CatalogPrices, type VariantPrices } from './catalog-price'

// Brief W74b (Wayne's WQ46, 24 Nov 2026): a member pays the lower of the member price and what a non-member pays, for
// products and add-ons. The rule alone, with the figures written out; the quote, the order, Add Guest and the shop's
// display prices each have a test of their own that they answer by it.

const addon = (base: string | null, sale: string | null, member: string | null): CatalogPrices => ({ base_price: base, sale_price: sale, member_price: member })
const variant = (base: string | null, sale: string | null, member: string | null, override: string | null = null): VariantPrices => ({ ...addon(base, sale, member), price_override: override })

describe('WQ46: a member pays the lower of the member price and what a non-member pays', () => {
  it('an add-on: the member price when it is lower, the sale price when that is lower, either at the same price', () => {
    // Member lower: base £28, sale £26, member £24.
    expect(addonPriceFor(addon('28.00', '26.00', '24.00'), true)).toBe('24.00')
    // Sale lower (W74a's example): base £28, sale £21, member £24. Before W74b a member paid £24.
    expect(addonPriceFor(addon('28.00', '21.00', '24.00'), true)).toBe('21.00')
    // Equal.
    expect(addonPriceFor(addon('28.00', '24.00', '24.00'), true)).toBe('24.00')
    // The base lower than the member price, with no sale.
    expect(addonPriceFor(addon('5.00', null, '6.00'), true)).toBe('5.00')
    // A member price only; and no member price: the sale, else the base.
    expect(addonPriceFor(addon(null, null, '4.00'), true)).toBe('4.00')
    expect(addonPriceFor(addon('5.00', '4.00', null), true)).toBe('4.00')
    expect(addonPriceFor(addon('5.00', null, null), true)).toBe('5.00')
    expect(addonPriceFor(addon(null, null, null), true)).toBeNull()
  })

  it('a product size: the same, and its own price (the override) is what a non-member pays, before the sale', () => {
    expect(variantPriceFor(variant('28.00', '26.00', '24.00'), true)).toBe('24.00')
    expect(variantPriceFor(variant('28.00', '21.00', '24.00'), true)).toBe('21.00')
    expect(variantPriceFor(variant('28.00', '24.00', '24.00'), true)).toBe('24.00')
    expect(variantPriceFor(variant(null, null, '9.00'), true)).toBe('9.00')
    expect(variantPriceFor(variant('12.00', '9.00', null), true)).toBe('9.00')
    expect(variantPriceFor(variant(null, null, null), true)).toBeNull()
    // An override with a sale: base £12, sale £9, member £8. A non-member pays the override, never the sale.
    // Override £7 (below the member price): the member pays £7 too. Before W74b they paid £8.
    expect(variantPriceFor(variant('12.00', '9.00', '8.00', '7.00'), true)).toBe('7.00')
    // Override £10 (above the sale and the member price): the member pays £8; the sale is not theirs, as it isn't a non-member's.
    expect(variantPriceFor(variant('12.00', '9.00', '8.00', '10.00'), true)).toBe('8.00')
    // Override £35 with a sale of £9 below the member price of £20: the member pays £20, not the £9 nobody pays for this size.
    expect(variantPriceFor(variant('30.00', '9.00', '20.00', '35.00'), true)).toBe('20.00')
  })

  it('a non-member never pays the member price: the sale price, else the base (a size: its override first)', () => {
    expect(addonPriceFor(addon('28.00', '26.00', '24.00'), false)).toBe('26.00')
    expect(addonPriceFor(addon('28.00', '21.00', '24.00'), false)).toBe('21.00')
    expect(addonPriceFor(addon('28.00', null, '24.00'), false)).toBe('28.00')
    expect(addonPriceFor(addon(null, null, '4.00'), false)).toBeNull()
    expect(variantPriceFor(variant('28.00', '26.00', '24.00'), false)).toBe('26.00')
    expect(variantPriceFor(variant('12.00', '9.00', '8.00', '7.00'), false)).toBe('7.00')
    expect(variantPriceFor(variant('12.00', '9.00', '8.00', '10.00'), false)).toBe('10.00')
    expect(variantPriceFor(variant(null, null, '9.00'), false)).toBeNull()
  })

  it('prices are compared as money, never as text: £100.00 is more than £28.00, and £9.50 less than £10.00', () => {
    expect(addonPriceFor(addon('100.00', null, '28.00'), true)).toBe('28.00')
    expect(addonPriceFor(addon('28.00', null, '100.00'), true)).toBe('28.00')
    expect(variantPriceFor(variant('10.00', null, '9.50'), true)).toBe('9.50')
    expect(variantPriceFor(variant('9.50', null, '10.00'), true)).toBe('9.50')
    // A penny decides it.
    expect(addonPriceFor(addon('24.01', null, '24.00'), true)).toBe('24.00')
    expect(addonPriceFor(addon('23.99', null, '24.00'), true)).toBe('23.99')
  })

  it('a member never pays more than a non-member, and never more than the member price, whatever is set', () => {
    const amounts = [null, '0.00', '7.00', '9.50', '10.00', '24.00', '100.00']
    const pence = (money: string) => Math.round(Number(money) * 100)
    for (const base of amounts) for (const sale of amounts) for (const member of amounts) for (const override of amounts) {
      const one = variant(base, sale, member, override)
      const [open, own] = [variantPriceFor(one, false), variantPriceFor(one, true)]
      const [openAddon, ownAddon] = [addonPriceFor(one, false), addonPriceFor(one, true)]
      const label = JSON.stringify(one)
      // What a non-member pays is as it was before W74b.
      expect(open, label).toBe(override ?? sale ?? base)
      expect(openAddon, label).toBe(sale ?? base)
      for (const [nonMember, forMember] of [[open, own], [openAddon, ownAddon]] as const) {
        if (member === null) expect(forMember, label).toBe(nonMember)
        else if (nonMember === null) expect(forMember, label).toBe(member)
        else {
          expect(pence(forMember as string), label).toBe(Math.min(pence(member), pence(nonMember)))
          expect([member, nonMember], label).toContain(forMember)
        }
      }
    }
  })

  it('what can\'t be sold stays as it was (W55a, W55b): no price at all, or a member price only for a non-member', () => {
    expect(addonPriceGap(addon(null, null, null), true)).toBe('not_set')
    expect(addonPriceGap(addon(null, null, null), false)).toBe('not_set')
    expect(addonPriceGap(addon(null, null, '4.00'), false)).toBe('member_only')
    expect(addonPriceGap(addon(null, null, '4.00'), true)).toBeNull()
    expect(addonPriceGap(addon('28.00', '21.00', '24.00'), true)).toBeNull()
    expect(addonPriceGap(addon('28.00', '21.00', '24.00'), false)).toBeNull()
    expect(variantPriceGap(variant(null, null, null), true)).toBe('not_set')
    expect(variantPriceGap(variant(null, null, '9.00'), false)).toBe('member_only')
    expect(variantPriceGap(variant(null, null, '9.00'), true)).toBeNull()
    // A size with its own price sells to a non-member though the product has a member price only.
    expect(variantPriceGap(variant(null, null, '9.00', '7.00'), false)).toBeNull()
    expect(variantPriceGap(variant('12.00', '9.00', '8.00', '7.00'), true)).toBeNull()
  })
})

// Wayne, 27 Nov 2026 (on W74b's review): a promo code that skips member prices skipped any member's line at the member
// price, so with the member price the same as the sale a member was refused a code a non-member got, and paid more.
describe('a line is member-priced only when the member price is below what a non-member pays', () => {
  it('an add-on: at the member price and that the lower: yes; at the same price as the sale or the base: no; at the sale price below it: no', () => {
    // Member £24 below the sale £26, the line at £24.
    expect(addonMemberPriced(addon('28.00', '26.00', '24.00'), 24)).toBe(true)
    // The same price as the sale, and as the base with no sale: it is everyone's price.
    expect(addonMemberPriced(addon('28.00', '24.00', '24.00'), 24)).toBe(false)
    expect(addonMemberPriced(addon('24.00', null, '24.00'), 24)).toBe(false)
    // The sale £21 below the member price: the line is at £21, and a line typed in at £24 is no member price either.
    expect(addonMemberPriced(addon('28.00', '21.00', '24.00'), 21)).toBe(false)
    expect(addonMemberPriced(addon('28.00', '21.00', '24.00'), 24)).toBe(false)
    // A penny below is a member price; a line at another price (changed by staff) is not.
    expect(addonMemberPriced(addon('24.01', null, '24.00'), 24)).toBe(true)
    expect(addonMemberPriced(addon('28.00', '26.00', '24.00'), 23.99)).toBe(false)
    expect(addonMemberPriced(addon('28.00', '26.00', '24.00'), 26)).toBe(false)
    // Only a member can buy it: a member price.
    expect(addonMemberPriced(addon(null, null, '4.00'), 4)).toBe(true)
    // No member price.
    expect(addonMemberPriced(addon('5.00', '4.00', null), 4)).toBe(false)
    // As money, not text.
    expect(addonMemberPriced(addon('100.00', null, '28.00'), 28)).toBe(true)
    expect(addonMemberPriced(addon('28.00', null, '100.00'), 100)).toBe(false)
  })

  it("a product size: the same, against the size's own price when it has one", () => {
    expect(variantMemberPriced(variant('28.00', '26.00', '24.00'), 24)).toBe(true)
    expect(variantMemberPriced(variant('28.00', '24.00', '24.00'), 24)).toBe(false)
    expect(variantMemberPriced(variant('28.00', '21.00', '24.00'), 21)).toBe(false)
    expect(variantMemberPriced(variant(null, null, '9.00'), 9)).toBe(true)
    // The size sells at £10: the member price £8 is below it, whatever the product's sale (£7) is.
    expect(variantMemberPriced(variant('12.00', '7.00', '8.00', '10.00'), 8)).toBe(true)
    // The size sells at £8, the member price: everyone's price, though the product's sale and base are above it.
    expect(variantMemberPriced(variant('12.00', '9.00', '8.00', '8.00'), 8)).toBe(false)
    // The size sells at £7, below the member price: the line is at £7.
    expect(variantMemberPriced(variant('12.00', '9.00', '8.00', '7.00'), 7)).toBe(false)
  })
})

// New Order and Add Guest fill a line's Price box from the catalogue themselves and send it with the press; a staff
// member with Manage pricing is then asked for a reason when it isn't the Worker's price. So the screens' copy of the
// rule (the staff app's frontend/utils/catalogPrice.ts: a screen can't import this one) must answer as the rule does.
describe("WQ46: the staff app's screens start a line at the Worker's price", () => {
  type ScreenRule = {
    cataloguePriceFor: (prices: CatalogPrices, isMember: boolean, variantOverride?: string | null) => string | null
    isAtMemberPrice: (prices: CatalogPrices, unitPrice: number, variantOverride?: string | null) => boolean
  }
  const screenRule = () => import(/* @vite-ignore */ path.join(staffAppDir(), 'frontend/utils/catalogPrice.ts')) as Promise<ScreenRule>
  const file = (name: string) => readFileSync(path.join(staffAppDir(), name), 'utf8')

  it("the screens' rule answers what the Worker's does, price by price, for a member and a non-member, a size and an add-on", async () => {
    const { cataloguePriceFor } = await screenRule()
    const amounts = [null, '0.00', '7.00', '9.50', '10.00', '24.00', '100.00']
    let compared = 0
    for (const base of amounts) for (const sale of amounts) for (const member of amounts) for (const isMember of [true, false]) {
      const prices = addon(base, sale, member)
      expect(cataloguePriceFor(prices, isMember), JSON.stringify({ prices, isMember })).toBe(addonPriceFor(prices, isMember))
      for (const override of amounts) {
        expect(cataloguePriceFor(prices, isMember, override), JSON.stringify({ prices, override, isMember })).toBe(variantPriceFor({ ...prices, price_override: override }, isMember))
        compared += 1
      }
    }
    expect(compared).toBe(7 * 7 * 7 * 2 * 7)
    // The figures written out, so a change made to both rules alike still fails here.
    expect(cataloguePriceFor(addon('28.00', '21.00', '24.00'), true)).toBe('21.00')
    expect(cataloguePriceFor(addon('28.00', '26.00', '24.00'), true)).toBe('24.00')
    expect(cataloguePriceFor(addon('28.00', '26.00', '24.00'), false)).toBe('26.00')
    expect(cataloguePriceFor(addon('12.00', '9.00', '8.00'), true, '7.00')).toBe('7.00')
  })

  it('"Member price applied" is shown for the lines the Worker counts as member-priced, and no others', async () => {
    const { isAtMemberPrice } = await screenRule()
    const amounts = [null, '0.00', '7.00', '9.50', '10.00', '24.00', '100.00']
    const typed = [0, 7, 9.5, 10, 23.99, 24, 100]
    let compared = 0
    for (const base of amounts) for (const sale of amounts) for (const member of amounts) for (const unitPrice of typed) {
      const prices = addon(base, sale, member)
      expect(isAtMemberPrice(prices, unitPrice), JSON.stringify({ prices, unitPrice })).toBe(addonMemberPriced(prices, unitPrice))
      for (const override of amounts) {
        expect(isAtMemberPrice(prices, unitPrice, override), JSON.stringify({ prices, override, unitPrice })).toBe(variantMemberPriced({ ...prices, price_override: override }, unitPrice))
        compared += 1
      }
    }
    expect(compared).toBe(7 * 7 * 7 * 7 * 7)
    // Written out: the lower member price is one; the same price as the sale is not.
    expect(isAtMemberPrice(addon('28.00', '26.00', '24.00'), 24)).toBe(true)
    expect(isAtMemberPrice(addon('28.00', '24.00', '24.00'), 24)).toBe(false)
    expect(isAtMemberPrice(addon('12.00', '9.00', '8.00'), 8, '8.00')).toBe(false)
    const file = (name: string) => readFileSync(path.join(staffAppDir(), name), 'utf8')
    expect(file('frontend/components/checkout/ProductLineEditor.tsx')).toContain('          isAtMemberPrice(owningProduct, line.unitPrice, lineVariant?.price_override ?? null)\n')
    expect(file('frontend/components/checkout/ProductLineEditor.tsx')).toContain('        const lineVariant = owningProduct?.variants.find((v) => v.id === line.productVariantId)\n')
    expect(file('frontend/components/checkout/AddonLineEditor.tsx')).toContain('        const memberPriceApplied = customerHasActiveMembership && lineAddon !== undefined && isAtMemberPrice(lineAddon, line.unitPrice)\n')
  })

  it('New Order (products and add-ons) and Add Guest use it, and nothing else works a member\'s price out', () => {
    const products = file('frontend/components/checkout/ProductLineEditor.tsx')
    const addons = file('frontend/components/checkout/AddonLineEditor.tsx')
    expect(products).toContain("  const price = cataloguePriceFor(product, isMember, variant?.price_override ?? null)\n  return price ? Number.parseFloat(price) : 0\n")
    expect(addons).toContain('  const price = cataloguePriceFor(addon, isMember)\n  return price ? Number.parseFloat(price) : 0\n')
    // Add Guest's add-ons and New Order's repricing go through the same two functions.
    expect(file('frontend/components/AddGuestDialog.tsx')).toContain('return repriceLine(line, addon ? defaultPriceFor(addon, hasActiveMembership) : null)')
    const checkout = file('frontend/components/CheckoutDialog.tsx')
    expect(checkout).toContain('return repriceLine(line, addon ? defaultPriceFor(addon, hasActiveMembership) : null)')
    expect(checkout).toContain('return repriceLine(line, product ? variantPrice(product, line.productVariantId, hasActiveMembership) : null)')
    // The old chain (the member price first, whatever the sale) is in no screen.
    for (const name of ['frontend/components/checkout/ProductLineEditor.tsx', 'frontend/components/checkout/AddonLineEditor.tsx', 'frontend/components/AddGuestDialog.tsx', 'frontend/components/CheckoutDialog.tsx']) {
      expect(file(name), name).not.toMatch(/isMember && \w+\.member_price\) \|\|/)
      expect(file(name), name).not.toMatch(/member_price \|\| /)
    }
  })
})
