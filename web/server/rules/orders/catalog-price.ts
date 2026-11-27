// New in W55b: the one rule for which catalogue price an add-on or a product variant is sold at, and when it has none
// for this customer. Used by the basket (the staff quote, the order and the website) and by Add Guest's add-ons, so
// the two can't disagree.
import 'server-only'

/** An add-on's (or a product's) price columns, as text, as the database gives them. */
export interface CatalogPrices {
  member_price: string | null
  sale_price: string | null
  base_price: string | null
}

/** A variant also has its own price override, which a non-member pays before the product's sale or base price. */
export interface VariantPrices extends CatalogPrices {
  price_override: string | null
}

/** The first price set, in order. Null when none is. */
function firstSet(...candidates: (string | null | undefined)[]): string | null {
  for (const candidate of candidates) {
    if (candidate !== null && candidate !== undefined) return candidate
  }
  return null
}

/** Money text ("28.00") as whole pence, to compare: text order would put "100.00" before "28.00". */
const pence = (money: string): number => Math.round(Number(money) * 100)

/**
 * WQ46 (W74b): a member pays the lower of the member price and what a non-member pays, so a sale (or a variant's own
 * price) below the member price is theirs too. With only one of the two set, that one. At the same price it is the
 * member price that is answered.
 */
function lowerForMember(memberPrice: string | null, nonMember: string | null): string | null {
  if (memberPrice === null) return nonMember
  if (nonMember === null) return memberPrice
  return pence(nonMember) < pence(memberPrice) ? nonMember : memberPrice
}

/**
 * As New Order prices it. A non-member: the sale price, else the base. A member: the lower of that and the member
 * price (WQ46). Null: no price for them.
 */
export function addonPriceFor(addon: CatalogPrices, member: boolean): string | null {
  const nonMember = firstSet(addon.sale_price, addon.base_price)
  return member ? lowerForMember(addon.member_price, nonMember) : nonMember
}

/**
 * A variant. A non-member: its own override, else the product's sale price, else its base. A member: the lower of
 * that and the member price (WQ46).
 */
export function variantPriceFor(variant: VariantPrices, member: boolean): string | null {
  const nonMember = firstSet(variant.price_override, variant.sale_price, variant.base_price)
  return member ? lowerForMember(variant.member_price, nonMember) : nonMember
}

/**
 * Whether a member's line at `unitPrice` is member-priced, which is what a promo code that skips member prices leaves
 * alone: the line is at the member price, and that is below what a non-member pays (or a non-member has no price).
 * At the same price it is everyone's price, so the code comes off it as it does for a non-member (Wayne, 27 Nov
 * 2026, on W74b's review; before, a line at the member price counted whatever a non-member paid). A seat and an
 * event place count the same way: only when the member's price is the lower.
 */
function atMemberPrice(memberPrice: string | null, nonMember: string | null, unitPrice: number): boolean {
  if (memberPrice === null || Math.round(unitPrice * 100) !== pence(memberPrice)) return false
  return nonMember === null || pence(memberPrice) < pence(nonMember)
}

export const addonMemberPriced = (addon: CatalogPrices, unitPrice: number): boolean => atMemberPrice(addon.member_price, addonPriceFor(addon, false), unitPrice)

export const variantMemberPriced = (variant: VariantPrices, unitPrice: number): boolean => atMemberPrice(variant.member_price, variantPriceFor(variant, false), unitPrice)

/**
 * Why an item can't be sold to this customer, or null when it can:
 * - `not_set`: no price at all (W55a, review S4);
 * - `member_only`: W55b, a member price and nothing else, for a non-member. The member price is never theirs, so
 *   without this the line would be priced at £0.
 */
export type PriceGap = 'not_set' | 'member_only'

export function addonPriceGap(addon: CatalogPrices, member: boolean): PriceGap | null {
  if (addonPriceFor(addon, member) !== null) return null
  return addon.member_price === null ? 'not_set' : 'member_only'
}

export function variantPriceGap(variant: VariantPrices, member: boolean): PriceGap | null {
  if (variantPriceFor(variant, member) !== null) return null
  return variant.member_price === null ? 'not_set' : 'member_only'
}
