// Briefs W55 + W56 (G-plan 1.1 to 1.3; bugs GB10, GB12, GB13, GB21, GB23; Wayne's Q52; W53 review L7): the new
// words of the catalogue's items, for refusals the old functions had no words of their own for (they showed the
// database's error, or let the value through). The old functions' own sentences stay in failure-messages.ts
// (CATALOG_ADMIN_WORDS, LEGACY_CATALOG_ROUTE_WORDS), held to the frozen copy by server/rules/admin/words.test.ts;
// these are kept apart so that test still holds both ways. Each is answered as a refusal's `message`, with its reason.
// Read-only: a read may import it.

/** £100,000,000: every catalogue price column is numeric(10,2), whose largest value is £99,999,999.99. */
export const PRICE_LIMIT_POUNDS = 100_000_000

/** 2,147,483,647: the largest stock a variant can hold (stock_quantity and the ledger's change_amount are int). */
export const STOCK_LIMIT = 2_147_483_647

export const CATALOG_ITEM_NEW_WORDS = {
  /**
   * W53 review L7: a price that isn't pounds and pence (three decimals), or is too big for its column. The database
   * would round it, so what is stored and anything worked out from what was typed could differ by a penny.
   */
  notPoundsAndPence: (field: unknown): string => `${String(field)} must be pounds and pence: no more than two decimal places, and less than £100,000,000.`,
  /** A price field the item's kind doesn't have (a monthly price on a product). The old route failed with "Failed to update item". */
  fieldNotOnThisItem: (field: unknown, kind: unknown): string => `${String(field)} can't be set on ${String(kind)}.`,
  /** GB23: a variant's size left empty (the old edit saved it). */
  sizeRequired: 'Enter a size for this variant.',
  /** GB23: a variant's SKU left empty (the old edit showed the database's error). */
  skuRequired: 'Enter a SKU for this variant.',
  /** GB23: a SKU another variant has, in any letter case. */
  variantSkuTaken: (sku: unknown): string => `The SKU "${String(sku)}" is already used by another variant. Each SKU can only be used once, whatever its capitals.`,
  /** GB23: a size the product already has, in any letter case. */
  sizeTaken: (size: unknown): string => `This product already has a "${String(size)}" size. Each size can only be listed once.`,
  /**
   * W55a (review B1): a variant for a product with no base price, or a base price of £0. The legacy create-variant
   * route refused both (`!variantPrice`: "No price available. Set priceOverride or ensure product has base_price.");
   * without it the product would sell at £0.
   */
  variantNeedsBasePrice: "Set this product's base price before adding a variant.",
  /** GB23: a SKU another add-on has, in any letter case. */
  addonSkuTaken: (sku: unknown): string => `The SKU "${String(sku)}" is already used by another add-on. Each SKU can only be used once, whatever its capitals.`,
  /** W55a (review N4): a stock change that would take the stock past what the column holds. */
  stockAboveLimit: (stock: unknown, change: unknown): string =>
    `This adjustment would bring stock above 2,147,483,647, the most a variant can hold (current stock: ${String(stock)}, change: ${String(change)}).`,
  /** GB10: a pass type's sessions. */
  sessionsWholeNumber: 'Sessions included must be a whole number, 1 or more.',
  /** GB10: a pass type's or a gift card type's expiry (W38a's cap: 120 months). */
  expiryWholeMonths: 'Expiry must be a whole number of months, from 1 to 120.',
  /** GB21: a size group's new range overlaps another size group of the same service type. */
  rangeOverlaps: (min: unknown, max: unknown): string =>
    `That range overlaps the ${String(min)} to ${String(max)} people size group. Change that group first, or choose a range that doesn't overlap it.`,
  /** Not found, where the old function's own words named nothing (a size group's tier). */
  tierNotFound: 'That size group no longer exists. Reload the page and try again.',
  /** A new size group for a service type that isn't there (the old function showed the database's foreign-key error). */
  serviceTypeNotFound: 'That service type no longer exists. Reload the page and try again.',
  /** A pass type or gift card type that isn't there, where the old function answered nothing. */
  passTypeNotFound: 'This pass type no longer exists.',
  giftCardTypeNotFound: 'That gift card type no longer exists. Reload the page and try again.',
  /**
   * W61 (the lead's call): a base price on a private service type. The legacy update-price route's own words sent
   * staff to the legacy tier price route, which W61 removed with the other legacy catalogue routes.
   */
  privateServiceTypeUsesTiers: 'Private service types are priced by their tiers: change the tier prices instead.',
} as const

/**
 * Wayne's Q52 (21 Nov 2026: leave as today) and the lead's words: before a pass type's level is saved, the dialog
 * says how many customers hold unused sessions on it, and that the change reaches their remaining sessions. Answered
 * by the level quote (`GET catalog/session-pass-types/:id/level-quote`) and shown by EditSessionPassTypeDialog.
 */
export function passLevelHolderWords(holders: number): string {
  if (holders <= 0) return 'No customer has unused sessions on this pass, so changing the level only changes what new sales cover.'
  const who = holders === 1 ? '1 customer has' : `${holders} customers have`
  return `${who} unused sessions on this pass. Changing the level changes what their remaining sessions cover.`
}
