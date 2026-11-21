import { CATALOG_ADMIN_WORDS, LEGACY_CATALOG_ROUTE_WORDS } from '@/server/rules/catalog/failure-messages'
import { CATALOG_ITEM_NEW_WORDS } from '@/server/rules/catalog/item-failure-messages'
import { STAFF_ADMIN_WORDS } from '@/server/rules/staff/failure-messages'
import { ADMIN_NO_ANSWER_WORDS, answerRefused, GONE, NO_STAFF_RECORD_WORDS, pinned, s3UnknownStaffOnManagePricing, type Matcher, type Pin } from './admin-differences'
import type { AllowedDifference, Recording } from './compare'
import { ID } from './scenarios'
import { W48_ID } from './w48-scenarios'

/*
 * Briefs W55 + W56 ("Parity and tests"; G-plan 4.9 items 3 and 4): the catalogue's golden families (W48's recordings
 * of the old functions) through the Worker's routes, and the only differences allowed in each, every one tied to a
 * decision. Kept in its own file beside admin-differences.ts (whose shared helpers it uses), as the families are many.
 *
 * Written by hand from a dump of the replay's raw differences (briefs/W55-W56-logs/04-replay-dump-3-summary.txt,
 * staff app repo), each read against the design. Every difference is pinned to the value the new routes give on its
 * path, and the replay holds each recording's raw differences to exactly the paths pinned (pathsPinnedBy).
 *
 * Two kinds are built from each golden file, because they are the same on every recording that has them:
 *  - L2: the Stripe calls the legacy routes made (each one GONE), and every Stripe price id they made in what staff
 *    saw and in the rows written (`price_fake_…`): the new routes make none, so each is none, or the id the row
 *    already had.
 *  - S3: a sign-in with no staff row told "…before performing this action." (admin-differences.ts).
 * As on every step G recording, the Worker's audit rows and stored answers are set aside and checked on their own.
 */

/** The W55 + W56 recordings: products, variants, stock, prices and add-ons; service types, tiers, passes and gift card types. */
export const isW55W56Scenario = (name: string): boolean =>
  /^w48-(products-read$|product-|gb15-|variant-|gb23-|gb12-|stock-|gb13-|price-|gb2-(product|tier|preset)-|addons-read$|addon-active-|addon-sku-|service-types-read$|service-type-|tier-|gb21-|pass-|gb10-|gb9-|gift-card-)/.test(name)

/**
 * The recordings whose `call` the old code let through and the Worker now refuses (GB10, GB12, GB21, GB23): replayed
 * with each refusal answered `{ thrown }`, as staff are shown it, so the recording runs on (admin-side.ts,
 * refusedPressesAsAnswers). Each refusal is a named difference.
 */
export const REFUSED_NOW: ReadonlySet<string> = new Set([
  'w48-gb10-a-pass-type-saved-with-no-sessions-and-a-negative-expiry',
  'w48-gb10-a-gift-card-type-saved-with-a-negative-expiry',
  'w48-gb12-a-variant-made-without-manage-pricing',
  'w48-gb21-a-range-may-overlap-the-next-size-group',
  'w48-gb23-variant-details-have-no-checks',
  // W55a (review S2): a new size group that overlaps another is refused.
  'w48-tier-create-where-one-band-already-has-the-group',
])

export const W55_W56_DECISIONS = {
  L2: 'Lead call L2 (G-plan section 6; brief W55 + W56 "Lead\'s checks": nothing reads a Stripe price for anything but membership plans, so the catalogue keeps none in step)',
  GB2: 'Bug GB2 (G-plan section 3), closed by lead call L2: no Stripe price is archived or made, so none can be left half-made',
  GB10: 'Bug GB10 (G-plan section 3); brief W55 + W56 item 9 (whole numbers of 1 or more; expiry 1 to 120 months)',
  GB12: 'Bug GB12 (G-plan section 3); brief W55 + W56 item 2 (Manage pricing; the variant and its ledger row in one transaction); W48 review L3',
  GB13: 'Bug GB13 (G-plan section 3); brief W55 + W56 item 3 (one transaction under the variant\'s lock; the press key)',
  GB21: 'Bug GB21 (G-plan section 3); brief W55 + W56 item 8 (one press changes a size group in every band; an overlap refused)',
  GB23: 'Bug GB23 (G-plan section 3); brief W55 + W56 item 4 (plain words, never the database\'s error)',
  WORDS: 'Briefs W55 + W56 (G-plan 4.2 item 1: refusals in words; the legacy routes\' plumbing is not passed on)',
  NO_ANSWER: 'Briefs W49 + W54 "Where I was unsure" 5, as every step G slice: a failed write is no answer to the staff app, and nothing is saved',
  PASS_LEVEL_STAFF: 'Bug GB14 / G-plan 4.2 (every route checks the staff member first); the old setSessionPassLevel read the permission itself',
  NEW_GROUP_OVERLAP: 'W55 + W56 review S2; brief W55a item 4 (a new size group is checked for an overlap as the range edit is; the same range only fills a band that lacks it)',
} as const
const D = W55_W56_DECISIONS

// --- What is built from each golden file

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
/** An answer that is a refusal in these words and nothing else (where the old answer was a list, not an object). */
const thrownOnly =
  (words: string): Matcher =>
  (value) =>
    isObject(value) && Object.keys(value).length === 1 && value['thrown'] === words
const MADE_BY_THE_LEGACY_ROUTE = /^price_fake_\d+$/
const madeHere = (value: unknown): boolean => typeof value === 'string' && MADE_BY_THE_LEGACY_ROUTE.test(value)
/** A Stripe price id on the new side: none, or the one the row already had: never one made by this press. */
const KEPT_OR_NONE: Matcher = (value) => value === undefined || value === null || (typeof value === 'string' && !MADE_BY_THE_LEGACY_ROUTE.test(value))

/** Every path in the golden file holding a Stripe price id a legacy route made (or a [before, after] pair with one). */
function madePricePaths(path: string, value: unknown, out: string[]): void {
  if (madeHere(value) || (Array.isArray(value) && value.length === 2 && value.some(madeHere) && !value.some((one) => isObject(one) || Array.isArray(one)))) {
    out.push(path)
    return
  }
  if (Array.isArray(value)) value.forEach((one, i) => madePricePaths(`${path}[${i}]`, one, out))
  else if (isObject(value)) for (const [key, one] of Object.entries(value)) madePricePaths(`${path}.${key}`, one, out)
}

/**
 * L2. The legacy routes' Stripe calls, each gone; and each Stripe price id they made, in what staff saw (`stripePriceId`,
 * an item's or a tier's price id) and in the rows written, now none or the id the row already had.
 */
function l2NoStripe(golden: Recording, skip: readonly string[] = []): AllowedDifference[] {
  const made: string[] = []
  madePricePaths('.results', golden.results, made)
  madePricePaths('.tables', golden.tables, made)
  const kept = made.filter((path) => !skip.some((prefix) => path.startsWith(prefix)))
  const calls = golden.stripeCalls.map((_call, i) => `.stripeCalls[${i}]`)
  const out: AllowedDifference[] = []
  if (calls.length > 0) {
    out.push(
      pinned(
        `Lead call L2: no Stripe product or price is switched, archived or made for this item (the legacy route made ${calls.length} Stripe call${calls.length === 1 ? '' : 's'} here). Nothing reads a Stripe price for anything but a membership plan.`,
        D.L2,
        calls.map((path) => [path, GONE] as const)
      )
    )
  }
  if (kept.length > 0) {
    out.push(
      pinned(
        '…so no Stripe price id is made: where the legacy route answered and wrote a new one, the item keeps the id it had (or none).',
        D.L2,
        kept.map((path) => [path, KEPT_OR_NONE] as const)
      )
    )
  }
  return out
}

const s3 = (golden: Recording): AllowedDifference[] => [s3UnknownStaffOnManagePricing(golden)]

/** A press the old code refused (or that failed on Stripe's side) now saved: its answer's fields, the thrown words gone. */
function nowSaved(index: number, fields: Readonly<Record<string, Pin>>): Array<readonly [string, Pin]> {
  return [[`.results[${index}].thrown`, GONE], ...Object.entries(fields).map(([field, pin]) => [`.results[${index}].${field}`, pin] as const)]
}
/** An object whose fields include these. */
const withFields =
  (fields: Readonly<Record<string, unknown>>): Matcher =>
  (value) =>
    isObject(value) && Object.entries(fields).every(([key, one]) => value[key] === one)
/** A table's change on the new side: each changed row holds these columns as [before, after]. */
const changed =
  (rows: ReadonlyArray<Readonly<Record<string, unknown>>>): Matcher =>
  (value) =>
    isObject(value) && Array.isArray(value['changed']) && value['changed'].length === rows.length && rows.every((row, i) => JSON.stringify(withOnly((value['changed'] as unknown[])[i], Object.keys(row))) === JSON.stringify(row))
const withOnly = (value: unknown, keys: readonly string[]): unknown => (isObject(value) ? Object.fromEntries(keys.map((key) => [key, value[key]])) : value)
/** A table's change on the new side: added rows holding these columns. */
const added =
  (rows: ReadonlyArray<Readonly<Record<string, unknown>>>): Matcher =>
  (value) =>
    isObject(value) && Array.isArray(value['added']) && value['added'].length === rows.length && rows.every((row, i) => withFields(row)((value['added'] as unknown[])[i]))

const PRICING_WORDS = STAFF_ADMIN_WORDS.pricingStaff.youDoNotHavePermissionManage
const NEW = CATALOG_ITEM_NEW_WORDS

// --- Each recording's named differences

type Named = (golden: Recording) => readonly AllowedDifference[]

/** The "who may" recordings of a Manage pricing action: S3 only. */
const WHO_MAY_S3 = [
  'w48-service-type-active-who-may',
  'w48-service-type-details-who-may',
  'w48-tier-create-who-may',
  'w48-tier-range-who-may',
  'w48-tier-price-who-may',
  'w48-product-active-who-may',
  'w48-product-fulfilment-who-may',
  'w48-variant-details-who-may',
  'w48-price-who-may',
  'w48-addon-active-who-may',
  'w48-addon-sku-who-may',
  'w48-pass-active-who-may',
  'w48-pass-expiry-who-may',
  'w48-pass-sessions-who-may',
  'w48-gift-card-type-active-who-may',
  'w48-gift-card-preset-active-who-may',
  'w48-gift-card-preset-create-who-may',
  'w48-gift-card-preset-price-who-may',
  'w48-gift-card-type-custom-amounts-who-may',
  'w48-gift-card-type-expiry-who-may',
]

/** The recordings whose only difference is L2. */
const L2_ONLY = [
  'w48-service-type-active-off-and-on',
  'w48-tier-price-set',
  'w48-tier-price-set-for-the-first-time',
  'w48-gb2-tier-price-pressed-again-makes-a-second-stripe-price',
  'w48-product-active-off-and-on',
  'w48-variant-create-with-no-starting-stock',
  'w48-variant-create-with-starting-stock',
  'w48-price-product-base-member-and-sale',
  'w48-price-addon-base-and-member',
  'w48-price-session-pass',
  'w48-price-public-service-type',
  'w48-addon-active-off-and-on',
  'w48-pass-active-off-and-on',
  'w48-gift-card-type-active-off-and-on',
  'w48-gift-card-preset-active-off-and-on',
  'w48-gift-card-preset-create',
  'w48-gift-card-preset-price-set',
]

/** A Stripe refusal or a missing Stripe product no longer stops a press: saved, with L2's Stripe calls gone. */
const stripeNoLongerStops = (what: string, fields: (golden: Recording) => Readonly<Record<string, Pin>>, table: string, matcher: Matcher): Named => (golden) => [
  ...l2NoStripe(golden),
  pinned(
    `Lead call L2: ${what} no longer stops the press, because the Worker keeps no Stripe price or product in step for it: it is saved, and staff see the saved answer.`,
    D.L2,
    [...nowSaved(0, fields(golden)), [`.tables.${table}`, matcher]]
  ),
]

/** A write that fails part way is no answer to the staff app: the "may or may not have been saved" words, and nothing saved. */
const failedWriteIsNoAnswer = (words: string): Named => (golden) => [
  ...l2NoStripe(golden),
  pinned(`The write failing is no answer to the staff app: staff are told "${words.slice(0, 60)}…", and nothing is saved (one transaction). The old route showed the database's words.`, D.NO_ANSWER, [['.results[0].thrown', words]]),
]

const ADD_VARIANT_NO_ANSWER =
  "Adding the variant didn't get an answer, so it may or may not have been added. Press Add Variant again here (it won't add it twice), or reload the page and check the product's variants first."
const ADD_PRESET_NO_ANSWER =
  "Adding the preset didn't get an answer, so it may or may not have been added. Press Add Preset again here (it won't add it twice), or reload the page and check the presets first."
const STOCK_NO_ANSWER = "The stock change didn't get an answer, so it may or may not have been saved. Press Apply again here (it won't count twice), or reload the page and check the stock first."

const NAMED: Readonly<Record<string, Named>> = {
  ...Object.fromEntries(WHO_MAY_S3.map((name) => [name, s3] as const)),
  ...Object.fromEntries(L2_ONLY.map((name) => [name, (golden: Recording) => l2NoStripe(golden)] as const)),

  // --- On and off sale
  'w48-service-type-active-refused-by-stripe': stripeNoLongerStops('Stripe refusing the product\'s switch', () => ({ id: ID.serviceType, active: false }), 'service_types', changed([{ id: ID.serviceType, active: [true, false] }])),
  'w48-service-type-active-stripe-went-then-the-write-fails': failedWriteIsNoAnswer(ADMIN_NO_ANSWER_WORDS),
  'w48-gift-card-preset-active-refused-by-stripe': stripeNoLongerStops('Stripe refusing the preset price\'s switch', () => ({ id: ID.giftCardPreset, active: false }), 'gift_card_presets', changed([{ id: ID.giftCardPreset, active: [true, false] }])),

  // --- Size groups (GB21) and tier prices
  'w48-gb21-a-size-group-range-saved-in-one-band-and-not-the-other': () => [
    pinned(
      'Bug GB21 is closed: the first press changes the size group in EVERY band, in one transaction, so the second (Peak\'s, which failed in the old recording) finds its tier already at 1 to 8 and is saved as a press that changes nothing; and the list reads 1 to 8 in both bands. (The old dialog saved one band at a time, and a failure left Core at 1 to 8 and Peak at 1 to 10: a party of 9 had a Peak price and no Core price.)',
      D.GB21,
      [
        ...nowSaved(1, { id: W48_ID.tierPeak, service_type_id: ID.privateType, min_people: 1, max_people: 8, price: '140.00' }),
        ['.results[2][0].price_tiers[1].max_people', 8],
        ['.tables.service_type_price_tiers.changed[1]', withFields({ id: W48_ID.tierPeak })],
      ]
    ),
  ],
  'w48-gb21-a-range-may-overlap-the-next-size-group': (golden) => [
    pinned(
      `Bug GB21 is closed: a range that overlaps another size group is refused in words ("${NEW.rangeOverlaps(11, 14)}"), and the group keeps its range. (The old code saved 1 to 12 beside an 11 to 14 group.)`,
      D.GB21,
      [...answerRefused(golden, 1, NEW.rangeOverlaps(11, 14)), ['.tables.service_type_price_tiers.changed[0]', GONE]]
    ),
  ],
  'w48-tier-create-where-one-band-already-has-the-group': () => [
    pinned(
      `W55a (review S2): a new 1 to 4 size group beside Core's 1 to 10 is refused in words ("${NEW.rangeOverlaps(1, 10)}"), both presses, and nothing is made. (The old code skipped Core without a word and gave Peak a 1 to 4 tier: a split group, so a party of 3 had two different groups' prices across the bands.)`,
      D.NEW_GROUP_OVERLAP,
      // Each old answer was a list of rows (one, then none), so the whole answer is replaced by the refusal.
      [['.results[0]', thrownOnly(NEW.rangeOverlaps(1, 10))], ['.results[1]', thrownOnly(NEW.rangeOverlaps(1, 10))], ['.tables.service_type_price_tiers', GONE]]
    ),
  ],
  'w48-tier-price-refusals': () => [
    pinned('A tier that isn\'t there is refused "Tier not found", the legacy route\'s words alone: the old function also passed on the route\'s lookup detail (": Expected one row.").', D.WORDS, [['.results[3].thrown', LEGACY_CATALOG_ROUTE_WORDS['update-tier-price'].tierNotFound]]),
  ],
  'w48-tier-price-refused-service-type-has-no-stripe-product': () => [
    pinned(
      'Lead call L2: a tier whose service type was never synced to Stripe can be priced (the legacy route refused it: "Service type has no Stripe product. Sync from Sanity first.").',
      D.L2,
      [...nowSaved(0, { success: true, tier: withFields({ id: ID.privateTier, price: '120.00' }) }), ['.tables.service_type_price_tiers', changed([{ id: ID.privateTier, price: ['100.00', '120.00'] }])]]
    ),
  ],
  'w48-gb2-tier-price-old-stripe-price-archived-then-the-new-one-fails': stripeNoLongerStops(
    'Stripe refusing the new price (bug GB2: the old route had already archived the old one, leaving the tier on an archived price)',
    () => ({ success: true, tier: withFields({ id: ID.privateTier, price: '120.00', stripe_price_id: 'price_tier_core' }) }),
    'service_type_price_tiers',
    changed([{ id: ID.privateTier, price: ['100.00', '120.00'] }])
  ),
  'w48-gb2-tier-price-made-in-stripe-then-the-write-fails': failedWriteIsNoAnswer(ADMIN_NO_ANSWER_WORDS),

  // --- Products and variants
  'w48-gb23-variant-details-have-no-checks': (golden) => [
    pinned(
      `Bug GB23 is closed: an empty size is refused in words ("${NEW.sizeRequired}") and nothing is saved; a SKU another variant has is refused in words; and an empty SKU is refused in words. (The old code saved the empty size, and showed the database's own errors for the other two.)`,
      D.GB23,
      [
        ...answerRefused(golden, 0, NEW.sizeRequired),
        ['.results[1].thrown', NEW.variantSkuTaken('CANDLE-1')],
        ['.results[2].thrown', NEW.skuRequired],
        ['.tables.product_variants', GONE],
      ]
    ),
  ],
  'w48-variant-create-who-may': (golden) => [
    // The price id the old press made is inside the answer and the row that are now gone whole.
    ...l2NoStripe(golden, ['.results[1]', '.tables.product_variants']),
    pinned(
      'Bug GB12 and W48 review L3: a sign-in with no staff row can no longer make a variant: the route\'s staff check refuses it in its words, and nothing is made. (The old code made the variant, and its Stripe price.)',
      D.GB12,
      [...answerRefused(golden, 1, NO_STAFF_RECORD_WORDS), ['.tables.product_variants', GONE]]
    ),
  ],
  'w48-variant-create-refusals': () => [
    pinned(`Bug GB23: a SKU another variant has is refused in plain words ("${NEW.variantSkuTaken('CANDLE-1')}"), in any letter case. (The legacy route said "SKU already exists", for the same case only.)`, D.GB23, [['.results[6].thrown', NEW.variantSkuTaken('CANDLE-1')]]),
    pinned(
      'Lead call L2: a variant can be made on a product never synced to Stripe (the legacy route refused: "Product has no Stripe product. Sync from Sanity first.").',
      D.L2,
      [...nowSaved(7, { success: true, variant: withFields({ product_id: ID.candle, sku: 'SOAP-L', size: 'Large', stock_quantity: 0, stripe_price_id: null }) }), ['.tables.product_variants', added([{ product_id: ID.candle, sku: 'SOAP-L', size: 'Large' }])]]
    ),
  ],
  'w48-variant-create-refused-by-stripe': stripeNoLongerStops(
    'Stripe refusing the variant\'s price',
    () => ({ success: true, variant: withFields({ product_id: ID.product, sku: 'SOAP-L', size: 'Large', stripe_price_id: null }) }),
    'product_variants',
    added([{ product_id: ID.product, sku: 'SOAP-L', size: 'Large', stripe_price_id: null }])
  ),
  'w48-variant-create-the-insert-fails': failedWriteIsNoAnswer(ADD_VARIANT_NO_ANSWER),
  'w48-gb12-a-variant-made-without-manage-pricing': (golden) => [
    ...l2NoStripe(golden, ['.results[0]', '.tables.product_variants']),
    pinned(
      `Bug GB12 is closed: a staff member without Manage pricing can no longer make a variant ("${PRICING_WORDS}"), and nothing is made: no variant, no ledger row. (The old code made both, and its Stripe price.)`,
      D.GB12,
      [...answerRefused(golden, 0, PRICING_WORDS), ['.tables.product_variants', GONE], ['.tables.stock_adjustments', GONE]]
    ),
  ],
  'w48-gb12-the-initial-stock-ledger-row-fails-on-its-own': (golden) => [
    ...l2NoStripe(golden),
    pinned(
      'Bug GB12 is closed: the variant and its "Initial stock" ledger row are one transaction, so the ledger row can\'t fail on its own: the recording\'s failure falls between two statements of the old function, which the Worker doesn\'t have, and both are written. (The old code left 10 in stock with no ledger row.) The failure inside the transaction is held by catalog/admin.test.ts: it leaves nothing.',
      D.GB12,
      [...nowSaved(0, { success: true, variant: withFields({ product_id: ID.product, sku: 'SOAP-L', stock_quantity: 10 }) }), ['.tables.stock_adjustments', added([{ change_amount: 10, reason: 'Initial stock', staff_id: ID.staff }])]]
    ),
  ],

  // --- Stock (GB13)
  'w48-stock-adjust-stock-sold-between-the-check-and-the-write': () => [
    pinned(
      'Bug GB13: the stock is read and changed under the variant\'s own lock, the one an order takes before it takes stock, so no sale can land between the check and the write: the recording\'s sale between two of the old function\'s statements has nowhere to go, and the press is saved (5 less 4 is 1). The race itself is run for real in catalog/admin-postgres.test.ts.',
      D.GB13,
      [...nowSaved(0, { id: ID.variant, stock_quantity: 1 }), ['.tables.stock_adjustments', added([{ variant_id: ID.variant, change_amount: -4, reason: 'Damage' }])]]
    ),
  ],
  'w48-stock-adjust-the-stock-write-fails': failedWriteIsNoAnswer(STOCK_NO_ANSWER),
  'w48-gb13-the-ledger-row-is-written-and-the-stock-change-never-runs': () => [
    pinned(
      'Bug GB13 is closed: the ledger row and the stock are one transaction, so the old function being cut off between them has nowhere to happen: both are written (5 and a delivery of 10 is 15). (The old code left a ledger row for stock that never moved.)',
      D.GB13,
      [...nowSaved(0, { id: ID.variant, stock_quantity: 15 }), ['.tables.product_variants', changed([{ id: ID.variant, stock_quantity: [5, 15] }])]]
    ),
  ],

  // --- Prices
  'w48-price-refusals': () => [
    pinned(
      'Lead call L2: a product never synced to Stripe can be priced (the legacy route refused: "Item has no Stripe product. Sync from Sanity first.").',
      D.L2,
      [
        ...nowSaved(8, { success: true, item: withFields({ id: ID.candle, base_price: '14.00' }), pricesUpdated: withFields({ base_price: 14 }) }),
        ['.tables.products', changed([{ id: ID.candle, base_price: ['20.00', '14.00'] }])],
      ]
    ),
  ],
  'w48-price-a-field-the-item-does-not-have': () => [
    pinned(`A price field the item's kind doesn't have is refused in words ("${NEW.fieldNotOnThisItem('monthlyPrice', 'a product')}"), before anything is read. (The legacy route failed: "Failed to update item".)`, D.WORDS, [['.results[0].thrown', NEW.fieldNotOnThisItem('monthlyPrice', 'a product')]]),
  ],
  'w48-gb2-product-price-old-stripe-price-archived-then-the-new-one-fails': stripeNoLongerStops(
    'Stripe refusing the new price (bug GB2: the old route had already archived the old one)',
    () => ({ success: true, item: withFields({ id: ID.product, base_price: '14.00', stripe_price_id_base: 'price_soap_base' }), pricesUpdated: withFields({ base_price: 14 }) }),
    'products',
    changed([{ id: ID.product, base_price: ['12.00', '14.00'] }])
  ),

  // --- Add-ons
  'w48-gb23-addon-sku-already-used-shows-the-database-error': () => [
    pinned(`Bug GB23 is closed: a SKU another add-on has is refused in plain words ("${NEW.addonSkuTaken('ROBE')}"), in any letter case. (The old code showed the database's unique-key error.)`, D.GB23, [['.results[0].thrown', NEW.addonSkuTaken('ROBE')]]),
  ],

  // --- Passes (GB10) and the level's who may
  'w48-gb10-a-pass-type-saved-with-no-sessions-and-a-negative-expiry': (golden) => [
    pinned(
      `Bug GB10 is closed: a pass type's sessions must be a whole number of 1 or more ("${NEW.sessionsWholeNumber}") and its expiry a whole number of months from 1 to 120 ("${NEW.expiryWholeMonths}"): 0 and -3 sessions, and -1 and 0 months, are refused, and the pass type keeps its 5 sessions and 12 months. (The old code saved all four; 1.5 and 2.5 reached the database's integer error.)`,
      D.GB10,
      [
        ...answerRefused(golden, 0, NEW.sessionsWholeNumber),
        ...answerRefused(golden, 1, NEW.sessionsWholeNumber),
        ...answerRefused(golden, 2, NEW.expiryWholeMonths),
        ...answerRefused(golden, 3, NEW.expiryWholeMonths),
        ['.results[4].thrown', NEW.expiryWholeMonths],
        ['.results[5].thrown', NEW.sessionsWholeNumber],
        ['.tables.session_pass_types', GONE],
      ]
    ),
  ],
  'w48-gb10-a-gift-card-type-saved-with-a-negative-expiry': (golden) => [
    pinned(
      `Bug GB10 is closed for a gift card type's expiry too: -1 and 0 months are refused ("${NEW.expiryWholeMonths}"), and the type keeps its 12 months. (The old code saved both; 1.5 reached the database's integer error.)`,
      D.GB10,
      [...answerRefused(golden, 0, NEW.expiryWholeMonths), ...answerRefused(golden, 1, NEW.expiryWholeMonths), ['.results[2].thrown', NEW.expiryWholeMonths], ['.tables.gift_card_types', GONE]]
    ),
  ],
  'w48-pass-level-who-may': (golden) => [
    pinned(
      'A sign-in with no staff row is refused the level change by the route\'s staff check, in its words. (The old function read the permission itself and answered `updated: false, reason: no_pricing_permission` for a sign-in it couldn\'t find; an inactive account is refused, as before.)',
      D.PASS_LEVEL_STAFF,
      answerRefused(golden, 2, NO_STAFF_RECORD_WORDS)
    ),
  ],

  // --- Gift card presets
  'w48-gift-card-preset-create-refused-type-has-no-stripe-product': () => [
    pinned(
      'Lead call L2: a preset can be made for a gift card type never synced to Stripe (the legacy route refused: "Gift card type has no Stripe product. Sync from Sanity first.").',
      D.L2,
      [...nowSaved(0, { success: true, preset: withFields({ gift_card_type_id: ID.giftCardType, amount: '25.00', stripe_price_id: null }) }), ['.tables.gift_card_presets', added([{ gift_card_type_id: ID.giftCardType, amount: '25.00' }])]]
    ),
  ],
  'w48-gift-card-preset-create-refused-by-stripe': stripeNoLongerStops(
    'Stripe refusing the preset\'s price',
    () => ({ success: true, preset: withFields({ gift_card_type_id: ID.giftCardType, amount: '25.00', stripe_price_id: null }) }),
    'gift_card_presets',
    added([{ gift_card_type_id: ID.giftCardType, amount: '25.00' }])
  ),
  'w48-gift-card-preset-create-the-insert-fails': failedWriteIsNoAnswer(ADD_PRESET_NO_ANSWER),
  'w48-gift-card-preset-price-refusals': () => [
    pinned('A preset that isn\'t there is refused "Preset not found", the legacy route\'s words alone (the old function also passed on its lookup detail).', D.WORDS, [['.results[3].thrown', LEGACY_CATALOG_ROUTE_WORDS['update-gift-card-preset-price'].presetNotFound]]),
  ],
  'w48-gift-card-preset-price-refused-type-has-no-stripe-product': () => [
    pinned(
      'Lead call L2: a preset of a gift card type never synced to Stripe can be re-priced (the legacy route refused it).',
      D.L2,
      [...nowSaved(0, { success: true, preset: withFields({ id: ID.giftCardPreset, amount: '75.00' }) }), ['.tables.gift_card_presets', changed([{ id: ID.giftCardPreset, amount: ['60.00', '75.00'] }])]]
    ),
  ],
  'w48-gb2-preset-price-made-in-stripe-then-the-write-fails': failedWriteIsNoAnswer(ADMIN_NO_ANSWER_WORDS),
  'w48-gb2-preset-price-old-stripe-price-archived-then-the-new-one-fails': stripeNoLongerStops(
    'Stripe refusing the new price (bug GB2)',
    () => ({ success: true, preset: withFields({ id: ID.giftCardPreset, amount: '75.00', stripe_price_id: 'price_preset_60' }) }),
    'gift_card_presets',
    changed([{ id: ID.giftCardPreset, amount: ['60.00', '75.00'] }])
  ),
}

/** The W55 + W56 recordings that have a named difference. */
export const W55_W56_DIFFERING: readonly string[] = Object.keys(NAMED)

/** The named differences of a W55 or W56 recording: none for the ones that match their golden files exactly. */
export const w55W56Differences = (name: string, golden: Recording): readonly AllowedDifference[] => NAMED[name]?.(golden) ?? []

/** Old words this file pins, so a test can hold that the sentences are the Worker's own (not copied). */
export const CATALOG_PINNED_OLD_WORDS = [CATALOG_ADMIN_WORDS.adjustVariantStock.variantNotFound] as const
