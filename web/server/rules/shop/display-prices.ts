// New in W74a: the prices the shop shows. Every one is what the checkout's own rule answers (variantPriceFor), so the
// shop can't show a price the bag wouldn't charge; nothing here decides which of a variant's prices applies. The one
// thing worked out is the sale's percent.
import 'server-only'
import type { ShopSize } from '@/contracts'
import { variantPriceFor, type VariantPrices } from '@/server/rules/orders/catalog-price'

export type DisplayPrices = Pick<ShopSize, 'price' | 'memberPrice' | 'priceBeforeSale' | 'percentOff'>

/** Money text ("28.00") as whole pence, to compare: text order would put "100.00" before "28.00". */
const pence = (money: string): number => Math.round(Number(money) * 100)

/** The lowest of some prices, as its own text. Null when there is none. */
export const lowest = (prices: readonly (string | null)[]): string | null =>
  prices.reduce((low, price) => (price !== null && (low === null || pence(price) < pence(low)) ? price : low), null)

const percentOff = (before: string, now: string): number => Math.round(((pence(before) - pence(now)) / pence(before)) * 100)

/**
 * One size's prices. The price before the sale is what the same rule answers with the sale taken away, and only when
 * that is more: a size that sells at its own override isn't reduced by the product's sale, and a "sale" price at or
 * above the base price isn't a reduction.
 */
export function sizePrices(variant: VariantPrices): DisplayPrices {
  const price = variantPriceFor(variant, false)
  const without = variantPriceFor({ ...variant, sale_price: null }, false)
  const before = price !== null && without !== null && pence(without) > pence(price) ? without : null
  return {
    price,
    memberPrice: variant.member_price === null ? null : variantPriceFor(variant, true),
    priceBeforeSale: before,
    percentOff: before !== null && price !== null ? percentOff(before, price) : null,
  }
}

export interface ProductPrices extends DisplayPrices {
  /** The sizes' non-member prices differ: the site says "From". */
  from: boolean
}

/**
 * A product's prices across its sizes: the lowest a non-member pays, and the lowest a member pays. The price before the
 * sale goes with the price shown, so it is given only when every size at that price is reduced (the lowest, if they
 * were at more than one price before).
 */
export function productPrices(variants: readonly VariantPrices[]): ProductPrices {
  const sizes = variants.map(sizePrices)
  const price = lowest(sizes.map((size) => size.price))
  const shown = price === null ? [] : sizes.filter((size) => size.price !== null && pence(size.price) === pence(price))
  const priceBeforeSale = shown.every((size) => size.priceBeforeSale !== null) ? lowest(shown.map((size) => size.priceBeforeSale)) : null
  return {
    price,
    from: new Set(sizes.map((size) => (size.price === null ? null : pence(size.price)))).size > 1,
    memberPrice: lowest(sizes.map((size) => size.memberPrice)),
    priceBeforeSale,
    percentOff: priceBeforeSale !== null && price !== null ? percentOff(priceBeforeSale, price) : null,
  }
}
