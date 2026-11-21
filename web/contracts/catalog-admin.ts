import { z } from 'zod'
import {
  adminGetAddonsOutputSchema,
  adminGetGiftCardTypesOutputSchema,
  adminGetProductsOutputSchema,
  adminGetServiceTypesOutputSchema,
  adminGetStockAdjustmentsOutputSchema,
} from './admin'

// Briefs W55 + W56 (G-plan 4.3, the "Service Types", "Products, Add-ons" and "Session Passes, Gift Card Types" rows;
// bugs GB9, GB10, GB12, GB13, GB21, GB23; Wayne's Q52; lead calls L2, L11, L12; W53 review L7; W54a's stale-page
// rule): the catalogue's routes' own inputs and answers. The reads answer the old functions' rows (W48's contracts),
// with the stamp of each row an edit sends back whole. Each write answers its success; a refusal is an error whose
// `details` carry the old reason (or a new one) and the words (adminRefusalDetailsSchema). Every field the old function
// checked for itself is loose, so the rule answers in the old words. In their own file, exported last from index.ts,
// so the staff app's generated types keep the order of every earlier union.

/** A field the rule checks for itself: anything, or left out (refused by the rule, in the old words or new ones). */
const loose = z.unknown().optional()

// --- Reads

/** `GET catalog/products`: getProducts' rows, each variant with its stamp (the size and SKU, which the variant row's edit sends back). */
const productRowSchema = adminGetProductsOutputSchema.element
export const catalogProductsRouteOutputSchema = z.array(productRowSchema.extend({ variants: z.array(productRowSchema.shape.variants.element.extend({ stamp: z.string() })) }))
export type CatalogProductsRouteOutput = z.infer<typeof catalogProductsRouteOutputSchema>

/** `GET catalog/addons`: getAddons' rows. */
export const catalogAddonsRouteOutputSchema = adminGetAddonsOutputSchema
export type CatalogAddonsRouteOutput = z.infer<typeof catalogAddonsRouteOutputSchema>

/** `GET catalog/variants/:variantId/stock-adjustments`, with `limit` (the newest N): getStockAdjustments' rows. */
export const catalogStockHistoryRouteInputSchema = z.object({ variantId: z.string(), limit: loose })
export type CatalogStockHistoryRouteInput = z.infer<typeof catalogStockHistoryRouteInputSchema>
export const catalogStockHistoryRouteOutputSchema = adminGetStockAdjustmentsOutputSchema
export type CatalogStockHistoryRouteOutput = z.infer<typeof catalogStockHistoryRouteOutputSchema>

/**
 * `GET catalog/service-types`: getServiceTypes' rows, each with its stamp (the length, capacity and booking type the
 * details dialog sends back) and each tier with its size group's `range_stamp` (every tier of one group shares it).
 */
const serviceTypeRowSchema = adminGetServiceTypesOutputSchema.element
export const catalogServiceTypesRouteOutputSchema = z.array(
  serviceTypeRowSchema.extend({ stamp: z.string(), price_tiers: z.array(serviceTypeRowSchema.shape.price_tiers.element.extend({ range_stamp: z.string() })) })
)
export type CatalogServiceTypesRouteOutput = z.infer<typeof catalogServiceTypesRouteOutputSchema>

/** `GET catalog/session-pass-types`, with `sessionId`: getSessionPassTypes' rows; with a session, each says whether its level covers it. */
export const catalogPassTypesRouteInputSchema = z.object({ sessionId: z.string().optional() })
export type CatalogPassTypesRouteInput = z.infer<typeof catalogPassTypesRouteInputSchema>
export const catalogPassTypesRouteOutputSchema = z.array(
  z.object({
    id: z.string(),
    sanity_pass_type_id: z.string().nullable(),
    name: z.string(),
    thumbnail_url: z.string().nullable(),
    price: z.string().nullable(),
    sessions_included: z.number().nullable(),
    expiry_months: z.number().nullable(),
    level: z.enum(['core', 'all_access']),
    stripe_product_id: z.string().nullable(),
    stripe_price_id: z.string().nullable(),
    active: z.boolean().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    covers_session: z.boolean().optional(),
  })
)
export type CatalogPassTypesRouteOutput = z.infer<typeof catalogPassTypesRouteOutputSchema>

/**
 * `GET catalog/session-pass-types/:passTypeId/level-quote` (Wayne's Q52; the lead's words): how many customers hold
 * unused sessions on the pass type, and the sentence the level dialog shows before saving.
 */
export const catalogPassLevelQuoteRouteInputSchema = z.object({ passTypeId: z.string() })
export type CatalogPassLevelQuoteRouteInput = z.infer<typeof catalogPassLevelQuoteRouteInputSchema>
export const catalogPassLevelQuoteRouteOutputSchema = z.object({ passTypeId: z.string(), level: z.string(), holders: z.number(), message: z.string() })
export type CatalogPassLevelQuoteRouteOutput = z.infer<typeof catalogPassLevelQuoteRouteOutputSchema>

/** `GET catalog/gift-card-types`: getGiftCardTypes' rows, each with the stamp of its custom amounts (the edit dialog sends them back). */
export const catalogGiftCardTypesRouteOutputSchema = z.array(adminGetGiftCardTypesOutputSchema.element.extend({ stamp: z.string() }))
export type CatalogGiftCardTypesRouteOutput = z.infer<typeof catalogGiftCardTypesRouteOutputSchema>

// --- Writes shared by every item kind

/**
 * `POST catalog/{products,addons,service-types,session-pass-types,gift-card-types,gift-card-presets}/:id/active`: on
 * and off sale (Manage pricing). No Stripe product or price is switched (lead call L2).
 */
export const catalogActiveRouteInputSchema = z.object({ itemId: z.string(), active: z.boolean() })
export type CatalogActiveRouteInput = z.infer<typeof catalogActiveRouteInputSchema>
export const catalogActiveRouteOutputSchema = z.object({ id: z.string(), active: z.boolean() })
export type CatalogActiveRouteOutput = z.infer<typeof catalogActiveRouteOutputSchema>

/**
 * `POST catalog/{products,addons,service-types,session-pass-types}/:id/price`: updateCatalogItemPrice for those kinds
 * (Manage pricing; a membership plan's price stays on the legacy route until W57). Each price must be pounds and pence
 * (W53 review L7). No Stripe price is made (L2). Answers the item's row and each column set, with the number sent.
 */
export const catalogPriceRouteInputSchema = z.object({ itemId: z.string(), basePrice: loose, memberPrice: loose, salePrice: loose, monthlyPrice: loose, yearlyPrice: loose })
export type CatalogPriceRouteInput = z.infer<typeof catalogPriceRouteInputSchema>
export const catalogPriceRouteOutputSchema = z.object({ success: z.literal(true), item: z.record(z.string(), z.unknown()), pricesUpdated: z.record(z.string(), z.number()) })
export type CatalogPriceRouteOutput = z.infer<typeof catalogPriceRouteOutputSchema>

// --- Products, variants, stock and add-ons (W55)

/** `POST catalog/products/:productId/fulfilment`: setProductFulfillmentMethod (Manage pricing). */
export const catalogFulfilmentRouteInputSchema = z.object({ productId: z.string(), fulfillmentMethod: loose })
export type CatalogFulfilmentRouteInput = z.infer<typeof catalogFulfilmentRouteInputSchema>
export const catalogFulfilmentRouteOutputSchema = z.object({ id: z.string(), fulfillment_method: z.string() })
export type CatalogFulfilmentRouteOutput = z.infer<typeof catalogFulfilmentRouteOutputSchema>

/**
 * `POST catalog/products/:productId/variants`: createProductVariant (GB12: Manage pricing; the variant and its
 * "Initial stock" ledger row in one transaction). The dialog keeps its press key after no answer (lead call L12).
 */
export const catalogVariantCreateRouteInputSchema = z.object({ productId: z.string(), size: loose, sku: loose, stockQuantity: loose })
export type CatalogVariantCreateRouteInput = z.infer<typeof catalogVariantCreateRouteInputSchema>
export const catalogVariantCreateRouteOutputSchema = z.object({ success: z.literal(true), variant: z.record(z.string(), z.unknown()) })
export type CatalogVariantCreateRouteOutput = z.infer<typeof catalogVariantCreateRouteOutputSchema>

/**
 * `POST catalog/variants/:variantId/details`: setProductVariantDetails (Manage pricing; GB23's checks). `stamp` is the
 * variant's as the products list read it: a variant whose size or SKU changed since is refused `changed_since`.
 */
export const catalogVariantDetailsRouteInputSchema = z.object({ variantId: z.string(), size: loose, sku: loose, stamp: loose })
export type CatalogVariantDetailsRouteInput = z.infer<typeof catalogVariantDetailsRouteInputSchema>
export const catalogVariantDetailsRouteOutputSchema = z.object({ id: z.string(), size: z.string().nullable(), sku: z.string(), stamp: z.string() })
export type CatalogVariantDetailsRouteOutput = z.infer<typeof catalogVariantDetailsRouteOutputSchema>

/**
 * `POST catalog/variants/:variantId/stock`: adjustVariantStock (any active staff member; GB13: one transaction under
 * the variant's lock, and the press's key, so the same press made again is answered from the first).
 */
export const catalogStockAdjustRouteInputSchema = z.object({ variantId: z.string(), changeAmount: loose, reasonCategory: loose, note: loose })
export type CatalogStockAdjustRouteInput = z.infer<typeof catalogStockAdjustRouteInputSchema>
export const catalogStockAdjustRouteOutputSchema = z.object({ id: z.string(), stock_quantity: z.number() })
export type CatalogStockAdjustRouteOutput = z.infer<typeof catalogStockAdjustRouteOutputSchema>

/** `POST catalog/addons/:addonId/sku`: setAddonSku (Manage pricing; GB23: a SKU another add-on has, in any case, refused in words). */
export const catalogAddonSkuRouteInputSchema = z.object({ addonId: z.string(), sku: loose })
export type CatalogAddonSkuRouteInput = z.infer<typeof catalogAddonSkuRouteInputSchema>
export const catalogAddonSkuRouteOutputSchema = z.object({ id: z.string(), sku: z.string().nullable() })
export type CatalogAddonSkuRouteOutput = z.infer<typeof catalogAddonSkuRouteOutputSchema>

// --- Service types and size groups (W56)

/** `POST catalog/service-types/:serviceTypeId/details`: setServiceTypeCapacityInfo (Manage pricing; W54a's stamp). */
export const catalogServiceTypeDetailsRouteInputSchema = z.object({ serviceTypeId: z.string(), duration: loose, capacity: loose, bookingType: loose, stamp: loose })
export type CatalogServiceTypeDetailsRouteInput = z.infer<typeof catalogServiceTypeDetailsRouteInputSchema>
export const catalogServiceTypeDetailsRouteOutputSchema = z.object({ id: z.string(), duration: z.number().nullable(), capacity: z.number().nullable(), booking_type: z.string().nullable(), stamp: z.string() })
export type CatalogServiceTypeDetailsRouteOutput = z.infer<typeof catalogServiceTypeDetailsRouteOutputSchema>

/** `POST catalog/service-types/:serviceTypeId/tiers`: createServiceTypePriceTier (Manage pricing). The dialog keeps its press key after no answer. */
export const catalogTierCreateRouteInputSchema = z.object({ serviceTypeId: z.string(), minPeople: loose, maxPeople: loose })
export type CatalogTierCreateRouteInput = z.infer<typeof catalogTierCreateRouteInputSchema>
export const catalogTierCreateRouteOutputSchema = z.array(z.record(z.string(), z.unknown()))
export type CatalogTierCreateRouteOutput = z.infer<typeof catalogTierCreateRouteOutputSchema>

/**
 * `POST catalog/tier-groups/range`: setServiceTypePriceTierRange (GB21: the pressed tier's size group, in every band,
 * in one transaction; an overlap with another group refused). `stamp` is the group's `range_stamp` as the list read it.
 */
export const catalogTierRangeRouteInputSchema = z.object({ tierId: loose, minPeople: loose, maxPeople: loose, stamp: loose })
export type CatalogTierRangeRouteInput = z.infer<typeof catalogTierRangeRouteInputSchema>
export const catalogTierRangeRouteOutputSchema = z.object({ id: z.string(), service_type_id: z.string(), min_people: z.number(), max_people: z.number(), price: z.string().nullable(), range_stamp: z.string() })
export type CatalogTierRangeRouteOutput = z.infer<typeof catalogTierRangeRouteOutputSchema>

/** `POST catalog/tiers/:tierId/price`: updateTierPrice (Manage pricing; L7; no Stripe price: L2). */
export const catalogTierPriceRouteInputSchema = z.object({ tierId: z.string(), price: loose })
export type CatalogTierPriceRouteInput = z.infer<typeof catalogTierPriceRouteInputSchema>
export const catalogTierPriceRouteOutputSchema = z.object({ success: z.literal(true), tier: z.record(z.string(), z.unknown()) })
export type CatalogTierPriceRouteOutput = z.infer<typeof catalogTierPriceRouteOutputSchema>

// --- Session pass types and gift card types (W56)

/**
 * `POST catalog/session-pass-types/:passTypeId/details`: setSessionPassSessionsIncluded, setSessionPassExpiry and
 * setSessionPassLevel (lead call L11: three functions, one route), one `field` a press (`sessions_included`,
 * `expiry_months` or `level`). GB10: sessions and expiry whole numbers of 1 or more (expiry up to 120 months). The
 * level answers Q52's holder count, read under the pass type's lock.
 */
export const catalogPassDetailsRouteInputSchema = z.object({ passTypeId: z.string(), field: loose, value: loose })
export type CatalogPassDetailsRouteInput = z.infer<typeof catalogPassDetailsRouteInputSchema>
export const catalogPassDetailsRouteOutputSchema = z.object({ id: z.string(), sessions_included: z.number().nullable().optional(), expiry_months: z.number().optional(), level: z.string().optional(), holders: z.number().optional() })
export type CatalogPassDetailsRouteOutput = z.infer<typeof catalogPassDetailsRouteOutputSchema>

/**
 * `POST catalog/gift-card-types/:giftCardTypeId/details`: setGiftCardTypeCustomAmountSettings (`field:
 * 'custom_amounts'`, with the three fields and the stamp of the three) and setGiftCardTypeExpiry (`field:
 * 'expiry_months'`, `value`; GB10: 1 to 120 months).
 */
export const catalogGiftCardTypeDetailsRouteInputSchema = z.object({ giftCardTypeId: z.string(), field: loose, value: loose, customAmountEnabled: loose, customAmountMin: loose, customAmountMax: loose, stamp: loose })
export type CatalogGiftCardTypeDetailsRouteInput = z.infer<typeof catalogGiftCardTypeDetailsRouteInputSchema>
export const catalogGiftCardTypeDetailsRouteOutputSchema = z.object({
  id: z.string(),
  custom_amount_enabled: z.boolean().optional(),
  custom_amount_min: z.string().nullable().optional(),
  custom_amount_max: z.string().nullable().optional(),
  expiry_months: z.number().optional(),
  stamp: z.string().optional(),
})
export type CatalogGiftCardTypeDetailsRouteOutput = z.infer<typeof catalogGiftCardTypeDetailsRouteOutputSchema>

/** `POST catalog/gift-card-types/:giftCardTypeId/presets`: createGiftCardPreset (Manage pricing; L7; no Stripe price: L2). The manager keeps its press key after no answer. */
export const catalogPresetCreateRouteInputSchema = z.object({ giftCardTypeId: z.string(), amount: loose })
export type CatalogPresetCreateRouteInput = z.infer<typeof catalogPresetCreateRouteInputSchema>
/** `POST catalog/gift-card-presets/:presetId/price`: updateGiftCardPresetPrice (Manage pricing; L7; gift cards already sold keep their amount). */
export const catalogPresetPriceRouteInputSchema = z.object({ presetId: z.string(), amount: loose })
export type CatalogPresetPriceRouteInput = z.infer<typeof catalogPresetPriceRouteInputSchema>
export const catalogPresetRouteOutputSchema = z.object({ success: z.literal(true), preset: z.record(z.string(), z.unknown()) })
export type CatalogPresetRouteOutput = z.infer<typeof catalogPresetRouteOutputSchema>
