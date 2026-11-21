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

/** A variant also has its own price override, charged first after a member price. */
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

/** As New Order prices it: the member price for a member, else the sale price, else the base. Null: no price for them. */
export const addonPriceFor = (addon: CatalogPrices, member: boolean): string | null => firstSet(member ? addon.member_price : null, addon.sale_price, addon.base_price)

/** A variant: the member price for a member, else its own override, else the product's sale price, else its base. */
export const variantPriceFor = (variant: VariantPrices, member: boolean): string | null =>
  firstSet(member ? variant.member_price : null, variant.price_override, variant.sale_price, variant.base_price)

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
