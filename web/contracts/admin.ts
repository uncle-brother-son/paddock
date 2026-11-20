import { z } from 'zod'

/**
 * New in W48 (G-plan 4.1, 4.3; brief W48 item 1): the contracts step G's admin routes will use, one pair for each of
 * the staff app's 82 functions that were not a thin call when step G began (lead call L11: one staff app function
 * per old function, even where several call one route). No route uses them yet: each slice (W49 to W57) builds its
 * routes on them and turns its functions into thin calls with the same names and result shapes.
 *
 * Every answer is the old function's own, in its field names (snake_case columns, money and dates as the database
 * gives them, a moment as ISO text), so nothing a screen reads today is missing; an id or a moment is any text here,
 * so the recordings' own answers can be held to it (server/rules/testing/replay/w48-contracts.test.ts, which runs all
 * 271 step G scenarios through the frozen copy and checks every call).
 *
 * Every input is loose where the old function answered for itself: a word from a set (a role, a level, a reason) is
 * any text, and a number may be empty, so the rule can refuse in the old words instead of a generic validation
 * error. Where a read's old answer came from `SELECT *`, the answer here is the old function's declared type: the
 * columns it never named are left out (G-plan 4.2: named columns), and the test above names each one.
 *
 * A refusal is an ApiError whose details carry the old reason and words (`adminRefusalDetailsSchema`), so the thin
 * wrappers put the old result shapes back (`updated: false, reason, message`; `blocked: false, conflict: true…`; a
 * thrown message where the old function threw).
 *
 * First written from the frozen copy with the TypeScript checker (briefs/W48-logs/generate-admin-contracts.mjs in
 * the staff app repo) and kept by hand from here on.
 */

/** getCurrentStaff: GET staff/me. Level Read; W49. */
export const adminGetCurrentStaffInputSchema = z.object({})
export type AdminGetCurrentStaffInput = z.infer<typeof adminGetCurrentStaffInputSchema>
export const adminGetCurrentStaffOutputSchema = z.object({ id: z.string(), email: z.string(), role: z.enum(['admin', 'manager', 'staff']), can_issue_refunds: z.boolean().nullable(), can_manage_pricing: z.boolean().nullable(), active: z.boolean().nullable() }).nullable()
export type AdminGetCurrentStaffOutput = z.infer<typeof adminGetCurrentStaffOutputSchema>

/** getStaff: GET staff. Level Read; W49. */
export const adminGetStaffInputSchema = z.object({})
export type AdminGetStaffInput = z.infer<typeof adminGetStaffInputSchema>
export const adminGetStaffOutputSchema = z.array(z.object({ id: z.string(), first_name: z.string(), last_name: z.string(), email: z.string(), role: z.enum(['admin', 'manager', 'staff']), can_issue_refunds: z.boolean().nullable(), can_manage_pricing: z.boolean().nullable(), active: z.boolean().nullable(), created_at: z.string(), updated_at: z.string() }))
export type AdminGetStaffOutput = z.infer<typeof adminGetStaffOutputSchema>

/** createStaff: POST staff. Level B; W49. */
export const adminCreateStaffInputSchema = z.object({ firstName: z.string(), lastName: z.string(), email: z.string(), role: z.string(), canIssueRefunds: z.boolean().optional() })
export type AdminCreateStaffInput = z.infer<typeof adminCreateStaffInputSchema>
export const adminCreateStaffOutputSchema = z.object({ id: z.string(), first_name: z.string(), last_name: z.string(), email: z.string(), role: z.enum(['admin', 'manager', 'staff']), can_issue_refunds: z.boolean(), can_manage_pricing: z.boolean(), active: z.boolean(), created_at: z.string(), updated_at: z.string() })
export type AdminCreateStaffOutput = z.infer<typeof adminCreateStaffOutputSchema>

/** setStaffRole: POST staff/:staffId/role. Level B; W49. */
export const adminSetStaffRoleInputSchema = z.object({ staffId: z.string(), role: z.string() })
export type AdminSetStaffRoleInput = z.infer<typeof adminSetStaffRoleInputSchema>
export const adminSetStaffRoleOutputSchema = z.record(z.string(), z.unknown()).nullable()
export type AdminSetStaffRoleOutput = z.infer<typeof adminSetStaffRoleOutputSchema>

/** setStaffPermission: POST staff/:staffId/permissions. Level B; W49. */
export const adminSetStaffPermissionInputSchema = z.object({ staffId: z.string(), field: z.string(), value: z.boolean() })
export type AdminSetStaffPermissionInput = z.infer<typeof adminSetStaffPermissionInputSchema>
export const adminSetStaffPermissionOutputSchema = z.record(z.string(), z.unknown()).nullable()
export type AdminSetStaffPermissionOutput = z.infer<typeof adminSetStaffPermissionOutputSchema>

/** setStaffCanManagePricing: POST staff/:staffId/permissions. Level B; W49. */
export const adminSetStaffCanManagePricingInputSchema = z.object({ staffId: z.string(), canManagePricing: z.boolean() })
export type AdminSetStaffCanManagePricingInput = z.infer<typeof adminSetStaffCanManagePricingInputSchema>
export const adminSetStaffCanManagePricingOutputSchema = z.object({ id: z.string(), can_manage_pricing: z.boolean() }).nullable()
export type AdminSetStaffCanManagePricingOutput = z.infer<typeof adminSetStaffCanManagePricingOutputSchema>

/** getServiceTypes: GET catalog/service-types. Level Read; W56. */
export const adminGetServiceTypesInputSchema = z.object({})
export type AdminGetServiceTypesInput = z.infer<typeof adminGetServiceTypesInputSchema>
export const adminGetServiceTypesOutputSchema = z.array(z.object({ price_tiers: z.array(z.object({ id: z.string(), service_type_id: z.string(), band_id: z.string(), band_code: z.string().nullable(), band_name: z.string().nullable(), min_people: z.number(), max_people: z.number(), price: z.string().nullable(), stripe_price_id: z.string().nullable(), created_at: z.string(), updated_at: z.string() })), schedule_slots: z.array(z.object({ id: z.string(), service_type_id: z.string(), day_of_week: z.number(), start_time: z.string(), created_at: z.string(), updated_at: z.string() })), id: z.string(), sanity_service_type_id: z.string().nullable(), name: z.string(), thumbnail_url: z.string().nullable(), duration: z.number().nullable(), capacity: z.number().nullable(), booking_type: z.enum(['public', 'private']).nullable(), price: z.string().nullable(), active: z.boolean().nullable(), stripe_product_id: z.string().nullable(), stripe_price_id: z.string().nullable(), created_at: z.string(), updated_at: z.string() }))
export type AdminGetServiceTypesOutput = z.infer<typeof adminGetServiceTypesOutputSchema>

/** setServiceTypeActive: POST catalog/service-types/:serviceTypeId/active. Level B; W56. */
export const adminSetServiceTypeActiveInputSchema = z.object({ serviceTypeId: z.string(), active: z.boolean() })
export type AdminSetServiceTypeActiveInput = z.infer<typeof adminSetServiceTypeActiveInputSchema>
export const adminSetServiceTypeActiveOutputSchema = z.object({ id: z.string(), active: z.boolean() })
export type AdminSetServiceTypeActiveOutput = z.infer<typeof adminSetServiceTypeActiveOutputSchema>

/** setServiceTypeCapacityInfo: POST catalog/service-types/:serviceTypeId/details. Level B; W56. */
export const adminSetServiceTypeCapacityInfoInputSchema = z.object({ serviceTypeId: z.string(), duration: z.number().nullable(), capacity: z.number().nullable(), bookingType: z.string() })
export type AdminSetServiceTypeCapacityInfoInput = z.infer<typeof adminSetServiceTypeCapacityInfoInputSchema>
export const adminSetServiceTypeCapacityInfoOutputSchema = z.record(z.string(), z.unknown()).nullable()
export type AdminSetServiceTypeCapacityInfoOutput = z.infer<typeof adminSetServiceTypeCapacityInfoOutputSchema>

/** createServiceTypePriceTier: POST catalog/service-types/:serviceTypeId/tiers. Level B; W56. */
export const adminCreateServiceTypePriceTierInputSchema = z.object({ serviceTypeId: z.string(), minPeople: z.number().nullable(), maxPeople: z.number().nullable() })
export type AdminCreateServiceTypePriceTierInput = z.infer<typeof adminCreateServiceTypePriceTierInputSchema>
export const adminCreateServiceTypePriceTierOutputSchema = z.array(z.record(z.string(), z.unknown()))
export type AdminCreateServiceTypePriceTierOutput = z.infer<typeof adminCreateServiceTypePriceTierOutputSchema>

/** setServiceTypePriceTierRange: POST catalog/tier-groups/range. Level B; W56. */
export const adminSetServiceTypePriceTierRangeInputSchema = z.object({ tierId: z.string(), minPeople: z.number().nullable(), maxPeople: z.number().nullable() })
export type AdminSetServiceTypePriceTierRangeInput = z.infer<typeof adminSetServiceTypePriceTierRangeInputSchema>
export const adminSetServiceTypePriceTierRangeOutputSchema = z.record(z.string(), z.unknown()).nullable()
export type AdminSetServiceTypePriceTierRangeOutput = z.infer<typeof adminSetServiceTypePriceTierRangeOutputSchema>

/** updateTierPrice: POST catalog/tiers/:tierId/price. Level B; W56. */
export const adminUpdateTierPriceInputSchema = z.object({ tierId: z.string(), price: z.number().nullable() })
export type AdminUpdateTierPriceInput = z.infer<typeof adminUpdateTierPriceInputSchema>
export const adminUpdateTierPriceOutputSchema = z.object({ success: z.boolean(), tier: z.object({ id: z.string(), price: z.string() }).catchall(z.unknown()), stripePriceId: z.string() })
export type AdminUpdateTierPriceOutput = z.infer<typeof adminUpdateTierPriceOutputSchema>

/** addServiceTypeScheduleSlot: POST catalog/service-types/:serviceTypeId/schedule-slots. Level B; W51. */
export const adminAddServiceTypeScheduleSlotInputSchema = z.object({ serviceTypeId: z.string(), dayOfWeek: z.number().nullable(), startTime: z.string() })
export type AdminAddServiceTypeScheduleSlotInput = z.infer<typeof adminAddServiceTypeScheduleSlotInputSchema>
export const adminAddServiceTypeScheduleSlotOutputSchema = z.record(z.string(), z.unknown()).nullable()
export type AdminAddServiceTypeScheduleSlotOutput = z.infer<typeof adminAddServiceTypeScheduleSlotOutputSchema>

/** deleteServiceTypeScheduleSlot: POST catalog/schedule-slots/:slotId/remove. Level B; W51. */
export const adminDeleteServiceTypeScheduleSlotInputSchema = z.object({ slotId: z.string() })
export type AdminDeleteServiceTypeScheduleSlotInput = z.infer<typeof adminDeleteServiceTypeScheduleSlotInputSchema>
export const adminDeleteServiceTypeScheduleSlotOutputSchema = z.object({ deleted: z.boolean() })
export type AdminDeleteServiceTypeScheduleSlotOutput = z.infer<typeof adminDeleteServiceTypeScheduleSlotOutputSchema>

/** getProducts: GET catalog/products. Level Read; W55. */
export const adminGetProductsInputSchema = z.object({})
export type AdminGetProductsInput = z.infer<typeof adminGetProductsInputSchema>
export const adminGetProductsOutputSchema = z.array(z.object({ variants: z.array(z.object({ id: z.string(), product_id: z.string(), sku: z.string().nullable(), size: z.string().nullable(), stock_quantity: z.number(), price_override: z.string().nullable(), stripe_price_id: z.string().nullable(), created_at: z.string(), updated_at: z.string() })), id: z.string(), sanity_product_id: z.string().nullable(), name: z.string(), thumbnail_url: z.string().nullable(), category: z.string().nullable(), base_price: z.string(), member_price: z.string().nullable(), sale_price: z.string().nullable(), fulfillment_method: z.string().nullable(), stripe_product_id: z.string().nullable(), stripe_price_id_base: z.string().nullable(), stripe_price_id_member: z.string().nullable(), stripe_price_id_sale: z.string().nullable(), active: z.boolean().nullable(), created_at: z.string(), updated_at: z.string() }))
export type AdminGetProductsOutput = z.infer<typeof adminGetProductsOutputSchema>

/** setProductActive: POST catalog/products/:productId/active. Level B; W55. */
export const adminSetProductActiveInputSchema = z.object({ productId: z.string(), active: z.boolean() })
export type AdminSetProductActiveInput = z.infer<typeof adminSetProductActiveInputSchema>
export const adminSetProductActiveOutputSchema = z.object({ id: z.string(), active: z.boolean() })
export type AdminSetProductActiveOutput = z.infer<typeof adminSetProductActiveOutputSchema>

/** setProductFulfillmentMethod: POST catalog/products/:productId/fulfilment. Level B; W55. */
export const adminSetProductFulfillmentMethodInputSchema = z.object({ productId: z.string(), fulfillmentMethod: z.string() })
export type AdminSetProductFulfillmentMethodInput = z.infer<typeof adminSetProductFulfillmentMethodInputSchema>
export const adminSetProductFulfillmentMethodOutputSchema = z.record(z.string(), z.unknown()).nullable()
export type AdminSetProductFulfillmentMethodOutput = z.infer<typeof adminSetProductFulfillmentMethodOutputSchema>

/** setProductVariantDetails: POST catalog/variants/:variantId/details. Level B; W55. */
export const adminSetProductVariantDetailsInputSchema = z.object({ variantId: z.string(), size: z.string().nullable(), sku: z.string().nullable() })
export type AdminSetProductVariantDetailsInput = z.infer<typeof adminSetProductVariantDetailsInputSchema>
export const adminSetProductVariantDetailsOutputSchema = z.record(z.string(), z.unknown()).nullable()
export type AdminSetProductVariantDetailsOutput = z.infer<typeof adminSetProductVariantDetailsOutputSchema>

/** createProductVariant: POST catalog/products/:productId/variants. Level B; W55. */
export const adminCreateProductVariantInputSchema = z.object({ productId: z.string(), size: z.string(), sku: z.string(), stockQuantity: z.number().nullable().optional() })
export type AdminCreateProductVariantInput = z.infer<typeof adminCreateProductVariantInputSchema>
export const adminCreateProductVariantOutputSchema = z.record(z.string(), z.unknown())
export type AdminCreateProductVariantOutput = z.infer<typeof adminCreateProductVariantOutputSchema>

/** adjustVariantStock: POST catalog/variants/:variantId/stock. Level B; W55. */
export const adminAdjustVariantStockInputSchema = z.object({ variantId: z.string(), changeAmount: z.number().nullable(), reasonCategory: z.string(), note: z.string().optional() })
export type AdminAdjustVariantStockInput = z.infer<typeof adminAdjustVariantStockInputSchema>
export const adminAdjustVariantStockOutputSchema = z.object({ id: z.string(), stock_quantity: z.number() })
export type AdminAdjustVariantStockOutput = z.infer<typeof adminAdjustVariantStockOutputSchema>

/** getStockAdjustments: GET catalog/variants/:variantId/stock-adjustments. Level Read; W55. */
export const adminGetStockAdjustmentsInputSchema = z.object({ variantId: z.string(), limit: z.number().nullable().optional() })
export type AdminGetStockAdjustmentsInput = z.infer<typeof adminGetStockAdjustmentsInputSchema>
export const adminGetStockAdjustmentsOutputSchema = z.array(z.object({ id: z.string(), variant_id: z.string(), change_amount: z.number(), reason: z.string(), staff_id: z.string().nullable(), staff_first_name: z.string().nullable(), staff_last_name: z.string().nullable(), created_at: z.string() }))
export type AdminGetStockAdjustmentsOutput = z.infer<typeof adminGetStockAdjustmentsOutputSchema>

/** updateCatalogItemPrice: POST catalog/:itemType/:itemId/price. Level B (a plan: A); W55, W56, W57. */
export const adminUpdateCatalogItemPriceInputSchema = z.object({ itemType: z.string(), itemId: z.string(), basePrice: z.number().nullable().optional(), memberPrice: z.number().nullable().optional(), salePrice: z.number().nullable().optional(), monthlyPrice: z.number().nullable().optional(), yearlyPrice: z.number().nullable().optional() })
export type AdminUpdateCatalogItemPriceInput = z.infer<typeof adminUpdateCatalogItemPriceInputSchema>
export const adminUpdateCatalogItemPriceOutputSchema = z.object({ success: z.boolean(), item: z.object({ id: z.string(), price: z.string().optional(), base_price: z.string().optional(), member_price: z.string().nullable().optional(), sale_price: z.string().nullable().optional() }).catchall(z.unknown()), pricesUpdated: z.record(z.string(), z.unknown()), subscriptionMigration: z.object({ migrated: z.number(), alreadyCurrent: z.number(), skipped: z.number(), failed: z.array(z.object({ membershipId: z.string(), subscriptionId: z.string(), error: z.string() })) }).optional() })
export type AdminUpdateCatalogItemPriceOutput = z.infer<typeof adminUpdateCatalogItemPriceOutputSchema>

/** getAddons: GET catalog/addons. Level Read; W55. */
export const adminGetAddonsInputSchema = z.object({})
export type AdminGetAddonsInput = z.infer<typeof adminGetAddonsInputSchema>
export const adminGetAddonsOutputSchema = z.array(z.object({ id: z.string(), sanity_addon_id: z.string().nullable(), name: z.string(), thumbnail_url: z.string().nullable(), category: z.string().nullable(), sku: z.string().nullable(), base_price: z.string(), member_price: z.string().nullable(), sale_price: z.string().nullable(), stripe_product_id: z.string().nullable(), stripe_price_id_base: z.string().nullable(), stripe_price_id_member: z.string().nullable(), stripe_price_id_sale: z.string().nullable(), active: z.boolean().nullable(), created_at: z.string(), updated_at: z.string() }))
export type AdminGetAddonsOutput = z.infer<typeof adminGetAddonsOutputSchema>

/** setAddonActive: POST catalog/addons/:addonId/active. Level B; W55. */
export const adminSetAddonActiveInputSchema = z.object({ addonId: z.string(), active: z.boolean() })
export type AdminSetAddonActiveInput = z.infer<typeof adminSetAddonActiveInputSchema>
export const adminSetAddonActiveOutputSchema = z.object({ id: z.string(), active: z.boolean() })
export type AdminSetAddonActiveOutput = z.infer<typeof adminSetAddonActiveOutputSchema>

/** setAddonSku: POST catalog/addons/:addonId/sku. Level B; W55. */
export const adminSetAddonSkuInputSchema = z.object({ addonId: z.string(), sku: z.string() })
export type AdminSetAddonSkuInput = z.infer<typeof adminSetAddonSkuInputSchema>
export const adminSetAddonSkuOutputSchema = z.record(z.string(), z.unknown()).nullable()
export type AdminSetAddonSkuOutput = z.infer<typeof adminSetAddonSkuOutputSchema>

/** getSessionPassTypes: GET catalog/session-pass-types. Level Read; W56. */
export const adminGetSessionPassTypesInputSchema = z.object({ sessionId: z.string().optional() })
export type AdminGetSessionPassTypesInput = z.infer<typeof adminGetSessionPassTypesInputSchema>
export const adminGetSessionPassTypesOutputSchema = z.array(z.unknown())
export type AdminGetSessionPassTypesOutput = z.infer<typeof adminGetSessionPassTypesOutputSchema>

/** setSessionPassActive: POST catalog/session-pass-types/:passTypeId/active. Level B; W56. */
export const adminSetSessionPassActiveInputSchema = z.object({ passTypeId: z.string(), active: z.boolean() })
export type AdminSetSessionPassActiveInput = z.infer<typeof adminSetSessionPassActiveInputSchema>
export const adminSetSessionPassActiveOutputSchema = z.object({ id: z.string(), active: z.boolean() })
export type AdminSetSessionPassActiveOutput = z.infer<typeof adminSetSessionPassActiveOutputSchema>

/** setSessionPassExpiry: POST catalog/session-pass-types/:passTypeId/details. Level B; W56. */
export const adminSetSessionPassExpiryInputSchema = z.object({ passTypeId: z.string(), expiryMonths: z.number().nullable() })
export type AdminSetSessionPassExpiryInput = z.infer<typeof adminSetSessionPassExpiryInputSchema>
export const adminSetSessionPassExpiryOutputSchema = z.record(z.string(), z.unknown()).nullable()
export type AdminSetSessionPassExpiryOutput = z.infer<typeof adminSetSessionPassExpiryOutputSchema>

/** setSessionPassSessionsIncluded: POST catalog/session-pass-types/:passTypeId/details. Level B; W56. */
export const adminSetSessionPassSessionsIncludedInputSchema = z.object({ passTypeId: z.string(), sessionsIncluded: z.number().nullable() })
export type AdminSetSessionPassSessionsIncludedInput = z.infer<typeof adminSetSessionPassSessionsIncludedInputSchema>
export const adminSetSessionPassSessionsIncludedOutputSchema = z.record(z.string(), z.unknown()).nullable()
export type AdminSetSessionPassSessionsIncludedOutput = z.infer<typeof adminSetSessionPassSessionsIncludedOutputSchema>

/** setSessionPassLevel: POST catalog/session-pass-types/:passTypeId/details. Level B; W56. */
export const adminSetSessionPassLevelInputSchema = z.object({ passTypeId: z.string(), level: z.string() })
export type AdminSetSessionPassLevelInput = z.infer<typeof adminSetSessionPassLevelInputSchema>
export const adminSetSessionPassLevelOutputSchema = z.object({ updated: z.boolean(), reason: z.enum(['no_pricing_permission', 'invalid_level', 'pass_type_not_found']).optional(), passType: z.object({ id: z.string(), level: z.enum(['core', 'all_access']) }).optional() })
export type AdminSetSessionPassLevelOutput = z.infer<typeof adminSetSessionPassLevelOutputSchema>

/** getGiftCardTypes: GET catalog/gift-card-types. Level Read; W56. */
export const adminGetGiftCardTypesInputSchema = z.object({})
export type AdminGetGiftCardTypesInput = z.infer<typeof adminGetGiftCardTypesInputSchema>
export const adminGetGiftCardTypesOutputSchema = z.array(z.object({ presets: z.array(z.object({ id: z.string(), gift_card_type_id: z.string(), amount: z.string(), active: z.boolean(), stripe_price_id: z.string().nullable(), created_at: z.string(), updated_at: z.string() })), id: z.string(), sanity_gift_card_type_id: z.string().nullable(), name: z.string(), thumbnail_url: z.string().nullable(), active: z.boolean(), stripe_product_id: z.string().nullable(), custom_amount_enabled: z.boolean(), custom_amount_min: z.string().nullable(), custom_amount_max: z.string().nullable(), expiry_months: z.number().nullable(), created_at: z.string(), updated_at: z.string() }))
export type AdminGetGiftCardTypesOutput = z.infer<typeof adminGetGiftCardTypesOutputSchema>

/** setGiftCardTypeActive: POST catalog/gift-card-types/:giftCardTypeId/active. Level B; W56. */
export const adminSetGiftCardTypeActiveInputSchema = z.object({ giftCardTypeId: z.string(), active: z.boolean() })
export type AdminSetGiftCardTypeActiveInput = z.infer<typeof adminSetGiftCardTypeActiveInputSchema>
export const adminSetGiftCardTypeActiveOutputSchema = z.object({ id: z.string(), active: z.boolean() })
export type AdminSetGiftCardTypeActiveOutput = z.infer<typeof adminSetGiftCardTypeActiveOutputSchema>

/** setGiftCardPresetActive: POST catalog/gift-card-presets/:presetId/active. Level B; W56. */
export const adminSetGiftCardPresetActiveInputSchema = z.object({ presetId: z.string(), active: z.boolean() })
export type AdminSetGiftCardPresetActiveInput = z.infer<typeof adminSetGiftCardPresetActiveInputSchema>
export const adminSetGiftCardPresetActiveOutputSchema = z.object({ id: z.string(), active: z.boolean() })
export type AdminSetGiftCardPresetActiveOutput = z.infer<typeof adminSetGiftCardPresetActiveOutputSchema>

/** createGiftCardPreset: POST catalog/gift-card-types/:giftCardTypeId/presets. Level B; W56. */
export const adminCreateGiftCardPresetInputSchema = z.object({ giftCardTypeId: z.string(), amount: z.number().nullable() })
export type AdminCreateGiftCardPresetInput = z.infer<typeof adminCreateGiftCardPresetInputSchema>
export const adminCreateGiftCardPresetOutputSchema = z.record(z.string(), z.unknown())
export type AdminCreateGiftCardPresetOutput = z.infer<typeof adminCreateGiftCardPresetOutputSchema>

/** updateGiftCardPresetPrice: POST catalog/gift-card-presets/:presetId/price. Level B; W56. */
export const adminUpdateGiftCardPresetPriceInputSchema = z.object({ presetId: z.string(), amount: z.number().nullable() })
export type AdminUpdateGiftCardPresetPriceInput = z.infer<typeof adminUpdateGiftCardPresetPriceInputSchema>
export const adminUpdateGiftCardPresetPriceOutputSchema = z.record(z.string(), z.unknown())
export type AdminUpdateGiftCardPresetPriceOutput = z.infer<typeof adminUpdateGiftCardPresetPriceOutputSchema>

/** setGiftCardTypeCustomAmountSettings: POST catalog/gift-card-types/:giftCardTypeId/details. Level B; W56. */
export const adminSetGiftCardTypeCustomAmountSettingsInputSchema = z.object({ giftCardTypeId: z.string(), customAmountEnabled: z.boolean(), customAmountMin: z.number().nullable().optional(), customAmountMax: z.number().nullable().optional() })
export type AdminSetGiftCardTypeCustomAmountSettingsInput = z.infer<typeof adminSetGiftCardTypeCustomAmountSettingsInputSchema>
export const adminSetGiftCardTypeCustomAmountSettingsOutputSchema = z.record(z.string(), z.unknown()).nullable()
export type AdminSetGiftCardTypeCustomAmountSettingsOutput = z.infer<typeof adminSetGiftCardTypeCustomAmountSettingsOutputSchema>

/** setGiftCardTypeExpiry: POST catalog/gift-card-types/:giftCardTypeId/details. Level B; W56. */
export const adminSetGiftCardTypeExpiryInputSchema = z.object({ giftCardTypeId: z.string(), expiryMonths: z.number().nullable() })
export type AdminSetGiftCardTypeExpiryInput = z.infer<typeof adminSetGiftCardTypeExpiryInputSchema>
export const adminSetGiftCardTypeExpiryOutputSchema = z.record(z.string(), z.unknown()).nullable()
export type AdminSetGiftCardTypeExpiryOutput = z.infer<typeof adminSetGiftCardTypeExpiryOutputSchema>

/** getMembershipPlans: GET catalog/membership-plans. Level Read; W57. */
export const adminGetMembershipPlansInputSchema = z.object({})
export type AdminGetMembershipPlansInput = z.infer<typeof adminGetMembershipPlansInputSchema>
export const adminGetMembershipPlansOutputSchema = z.array(z.object({ id: z.string(), sanity_plan_id: z.string().nullable(), name: z.string(), thumbnail_url: z.string().nullable(), price_monthly: z.string().nullable(), price_yearly: z.string().nullable(), sessions_included: z.number().nullable(), addons_included: z.number().nullable(), level: z.enum(['core', 'all_access']).nullable(), is_unlimited: z.boolean(), stripe_product_id: z.string().nullable(), stripe_price_id: z.string().nullable(), stripe_price_id_yearly: z.string().nullable(), active: z.boolean().nullable(), created_at: z.string(), updated_at: z.string() }))
export type AdminGetMembershipPlansOutput = z.infer<typeof adminGetMembershipPlansOutputSchema>

/** createMembershipPlan: POST catalog/membership-plans. Level A; W57. */
export const adminCreateMembershipPlanInputSchema = z.object({ name: z.string(), level: z.string(), sessionsIncluded: z.number().nullable(), addonsIncluded: z.number().nullable(), isUnlimited: z.boolean(), priceMonthly: z.number().nullable().nullable(), priceYearly: z.number().nullable().nullable() })
export type AdminCreateMembershipPlanInput = z.infer<typeof adminCreateMembershipPlanInputSchema>
export const adminCreateMembershipPlanOutputSchema = z.object({ id: z.string(), sanity_plan_id: z.string().nullable(), name: z.string(), thumbnail_url: z.string().nullable(), price_monthly: z.string().nullable(), price_yearly: z.string().nullable(), sessions_included: z.number().nullable(), addons_included: z.number().nullable(), level: z.enum(['core', 'all_access']).nullable(), is_unlimited: z.boolean(), stripe_product_id: z.string().nullable(), stripe_price_id: z.string().nullable(), stripe_price_id_yearly: z.string().nullable(), active: z.boolean().nullable(), created_at: z.string(), updated_at: z.string() })
export type AdminCreateMembershipPlanOutput = z.infer<typeof adminCreateMembershipPlanOutputSchema>

/** setMembershipPlanActive: POST catalog/membership-plans/:planId/active. Level A; W57. */
export const adminSetMembershipPlanActiveInputSchema = z.object({ planId: z.string(), active: z.boolean() })
export type AdminSetMembershipPlanActiveInput = z.infer<typeof adminSetMembershipPlanActiveInputSchema>
export const adminSetMembershipPlanActiveOutputSchema = z.object({ id: z.string(), active: z.boolean() })
export type AdminSetMembershipPlanActiveOutput = z.infer<typeof adminSetMembershipPlanActiveOutputSchema>

/** setMembershipPlanDetails: POST catalog/membership-plans/:planId/details. Level A; W57. */
export const adminSetMembershipPlanDetailsInputSchema = z.object({ planId: z.string(), name: z.string().optional(), level: z.string(), isUnlimited: z.boolean(), sessionsIncluded: z.number().nullable(), addonsIncluded: z.number().nullable(), priceMonthly: z.number().nullable(), priceYearly: z.number().nullable() })
export type AdminSetMembershipPlanDetailsInput = z.infer<typeof adminSetMembershipPlanDetailsInputSchema>
export const adminSetMembershipPlanDetailsOutputSchema = z.object({ id: z.string(), sanity_plan_id: z.string().nullable(), name: z.string(), thumbnail_url: z.string().nullable(), price_monthly: z.string().nullable(), price_yearly: z.string().nullable(), sessions_included: z.number().nullable(), addons_included: z.number().nullable(), level: z.enum(['core', 'all_access']).nullable(), is_unlimited: z.boolean(), stripe_product_id: z.string().nullable(), stripe_price_id: z.string().nullable(), stripe_price_id_yearly: z.string().nullable(), active: z.boolean().nullable(), created_at: z.string(), updated_at: z.string() }).nullable()
export type AdminSetMembershipPlanDetailsOutput = z.infer<typeof adminSetMembershipPlanDetailsOutputSchema>

/** getMembershipSettings: GET membership-settings. Level Read; W57. */
export const adminGetMembershipSettingsInputSchema = z.object({})
export type AdminGetMembershipSettingsInput = z.infer<typeof adminGetMembershipSettingsInputSchema>
export const adminGetMembershipSettingsOutputSchema = z.object({ addonCreditWaitMonths: z.number() })
export type AdminGetMembershipSettingsOutput = z.infer<typeof adminGetMembershipSettingsOutputSchema>

/** setMembershipSettings: POST membership-settings. Level B; W57. */
export const adminSetMembershipSettingsInputSchema = z.object({ addonCreditWaitMonths: z.number().nullable() })
export type AdminSetMembershipSettingsInput = z.infer<typeof adminSetMembershipSettingsInputSchema>
export const adminSetMembershipSettingsOutputSchema = z.object({ addonCreditWaitMonths: z.number(), herdFlagsChanged: z.number() })
export type AdminSetMembershipSettingsOutput = z.infer<typeof adminSetMembershipSettingsOutputSchema>

/** getEvents: GET catalog/events. Level Read; W52. */
export const adminGetEventsInputSchema = z.object({})
export type AdminGetEventsInput = z.infer<typeof adminGetEventsInputSchema>
export const adminGetEventsOutputSchema = z.array(z.object({ id: z.string(), sanity_event_id: z.string().nullable(), name: z.string(), thumbnail_url: z.string().nullable(), has_extra_waiver: z.boolean(), starts_at: z.string().nullable(), ends_at: z.string().nullable(), capacity: z.number().nullable(), places_booked: z.number(), access: z.enum(['public', 'members_only', 'members_first']), public_release_at: z.string().nullable(), price_public: z.string().nullable(), price_pre_herd: z.string().nullable(), price_herd: z.string().nullable(), refund_cutoff_at: z.string().nullable(), active: z.boolean(), cancelled_at: z.string().nullable(), cancel_reason: z.string().nullable(), created_at: z.string(), updated_at: z.string() }))
export type AdminGetEventsOutput = z.infer<typeof adminGetEventsOutputSchema>

/** setEventActive: POST catalog/events/:eventId/active. Level B; W52. */
export const adminSetEventActiveInputSchema = z.object({ eventId: z.string(), active: z.boolean() })
export type AdminSetEventActiveInput = z.infer<typeof adminSetEventActiveInputSchema>
export const adminSetEventActiveOutputSchema = z.union([z.object({ updated: z.literal(true), event: z.object({ active: z.boolean(), id: z.string() }) }), z.object({ updated: z.literal(false), reason: z.enum(['event_not_found', 'event_incomplete']), message: z.string() })])
export type AdminSetEventActiveOutput = z.infer<typeof adminSetEventActiveOutputSchema>

/** setEventDetails: POST catalog/events/:eventId/details. Level B; W52. */
export const adminSetEventDetailsInputSchema = z.object({ eventId: z.string(), startsAt: z.string().nullable(), endsAt: z.string().nullable(), capacity: z.number().nullable().nullable(), access: z.string(), publicReleaseAt: z.string().nullable(), pricePublic: z.number().nullable().nullable(), pricePreHerd: z.number().nullable().nullable(), priceHerd: z.number().nullable().nullable(), refundCutoffAt: z.string().nullable() })
export type AdminSetEventDetailsInput = z.infer<typeof adminSetEventDetailsInputSchema>
export const adminSetEventDetailsOutputSchema = z.union([z.object({ updated: z.literal(true), event: z.object({ id: z.string(), sanity_event_id: z.string().nullable(), name: z.string(), thumbnail_url: z.string().nullable(), has_extra_waiver: z.boolean(), starts_at: z.string().nullable(), ends_at: z.string().nullable(), capacity: z.number().nullable(), places_booked: z.number(), access: z.enum(['public', 'members_only', 'members_first']), public_release_at: z.string().nullable(), price_public: z.string().nullable(), price_pre_herd: z.string().nullable(), price_herd: z.string().nullable(), refund_cutoff_at: z.string().nullable(), active: z.boolean(), cancelled_at: z.string().nullable(), cancel_reason: z.string().nullable(), created_at: z.string(), updated_at: z.string() }) }), z.object({ updated: z.literal(false), reason: z.enum(['event_not_found', 'invalid_params', 'event_cancelled', 'constraint']), message: z.string() })])
export type AdminSetEventDetailsOutput = z.infer<typeof adminSetEventDetailsOutputSchema>

/** getEventAttendees: GET events/:eventId/attendees. Level Read; W52. */
export const adminGetEventAttendeesInputSchema = z.object({ eventId: z.string() })
export type AdminGetEventAttendeesInput = z.infer<typeof adminGetEventAttendeesInputSchema>
export const adminGetEventAttendeesOutputSchema = z.object({ event: z.object({ id: z.string(), name: z.string(), starts_at: z.string().nullable(), ends_at: z.string().nullable(), capacity: z.number().nullable(), places_booked: z.number(), has_extra_waiver: z.boolean(), refund_cutoff_at: z.string().nullable(), cancelled_at: z.string().nullable(), cancel_reason: z.string().nullable() }).nullable(), checkInWindow: z.enum(['not_open', 'open', 'closed']), bookings: z.array(z.object({ id: z.string(), customer_id: z.string(), customer_first_name: z.string(), customer_last_name: z.string(), customer_email: z.string().nullable(), customer_phone: z.string().nullable(), status: z.enum(['confirmed', 'cancelled']), places: z.number(), price_paid: z.string(), ordered_at: z.string(), cancelled_at: z.string().nullable(), cancel_reason: z.string().nullable(), order_id: z.string().nullable().optional(), refund_owed_amount: z.string().optional(), attendees: z.array(z.object({ id: z.string(), event_booking_id: z.string(), attendee_type: z.enum(['account_holder', 'guest']), name: z.string(), email: z.string().nullable(), price_level: z.enum(['public', 'pre_herd', 'herd']), unit_price: z.string(), waiver_accepted: z.boolean(), waiver_method: z.enum(['email_link', 'in_person', 'checkout']).nullable(), waiver_accepted_at: z.string().nullable(), extra_waiver_state: z.enum(['not_needed', 'accepted', 'older_version', 'pending']), event_waiver_method: z.enum(['email_link', 'in_person', 'checkout']).nullable(), event_waiver_accepted_at: z.string().nullable(), checked_in_at: z.string().nullable(), cancelled_at: z.string().nullable(), cancel_reason: z.string().nullable(), cancelled_by_name: z.string().nullable(), cancelled_value: z.string(), refunded_amount: z.string(), card_refunded_amount: z.string(), refund_method: z.enum(['card', 'credit', 'cash', 'none']).nullable(), refund_after_cutoff: z.boolean() })) })) })
export type AdminGetEventAttendeesOutput = z.infer<typeof adminGetEventAttendeesOutputSchema>

/** setEventAttendeeCheckIn: POST events/attendees/check-in, POST events/attendees/:attendeeId/check-in/undo. Level C; W52. */
export const adminSetEventAttendeeCheckInInputSchema = z.object({ attendeeId: z.string(), checkedIn: z.boolean(), markWaiversSignedInPerson: z.boolean().optional() })
export type AdminSetEventAttendeeCheckInInput = z.infer<typeof adminSetEventAttendeeCheckInInputSchema>
export const adminSetEventAttendeeCheckInOutputSchema = z.union([z.object({ updated: z.literal(true), attendee: z.object({ id: z.string(), waiver_accepted: z.boolean(), waiver_method: z.enum(['email_link', 'in_person', 'checkout']).nullable(), waiver_accepted_at: z.string().nullable(), extra_waiver_state: z.enum(['not_needed', 'accepted', 'older_version', 'pending']), event_waiver_method: z.enum(['email_link', 'in_person', 'checkout']).nullable(), event_waiver_accepted_at: z.string().nullable(), checked_in_at: z.string().nullable() }) }), z.object({ updated: z.literal(false), reason: z.enum(['event_cancelled', 'attendee_not_found', 'attendee_cancelled', 'booking_not_confirmed', 'check_in_not_open', 'check_in_closed', 'waivers_outstanding', 'extra_waiver_version_missing']), message: z.string() })])
export type AdminSetEventAttendeeCheckInOutput = z.infer<typeof adminSetEventAttendeeCheckInOutputSchema>

/** setEventAttendeesCheckIn: POST events/attendees/check-in. Level C; W52. */
export const adminSetEventAttendeesCheckInInputSchema = z.object({ attendeeIds: z.array(z.string()), markWaiversSignedInPerson: z.boolean().optional() })
export type AdminSetEventAttendeesCheckInInput = z.infer<typeof adminSetEventAttendeesCheckInInputSchema>
export const adminSetEventAttendeesCheckInOutputSchema = z.object({ results: z.array(z.union([z.object({ attendeeId: z.string(), updated: z.literal(true), attendee: z.object({ id: z.string(), waiver_accepted: z.boolean(), waiver_method: z.enum(['email_link', 'in_person', 'checkout']).nullable(), waiver_accepted_at: z.string().nullable(), extra_waiver_state: z.enum(['not_needed', 'accepted', 'older_version', 'pending']), event_waiver_method: z.enum(['email_link', 'in_person', 'checkout']).nullable(), event_waiver_accepted_at: z.string().nullable(), checked_in_at: z.string().nullable() }) }), z.object({ attendeeId: z.string(), updated: z.literal(false), reason: z.enum(['event_cancelled', 'attendee_not_found', 'attendee_cancelled', 'booking_not_confirmed', 'check_in_not_open', 'check_in_closed', 'waivers_outstanding', 'extra_waiver_version_missing']), message: z.string() })])) })
export type AdminSetEventAttendeesCheckInOutput = z.infer<typeof adminSetEventAttendeesCheckInOutputSchema>

/** setEventAttendeeWaiver: POST events/attendees/:attendeeId/waiver. Level C; W52. */
export const adminSetEventAttendeeWaiverInputSchema = z.object({ attendeeId: z.string(), which: z.string(), accepted: z.boolean(), method: z.string().optional() })
export type AdminSetEventAttendeeWaiverInput = z.infer<typeof adminSetEventAttendeeWaiverInputSchema>
export const adminSetEventAttendeeWaiverOutputSchema = z.union([z.object({ updated: z.literal(true), attendee: z.object({ id: z.string(), waiver_accepted: z.boolean(), waiver_method: z.enum(['email_link', 'in_person', 'checkout']).nullable(), waiver_accepted_at: z.string().nullable(), extra_waiver_state: z.enum(['not_needed', 'accepted', 'older_version', 'pending']), event_waiver_method: z.enum(['email_link', 'in_person', 'checkout']).nullable(), event_waiver_accepted_at: z.string().nullable(), checked_in_at: z.string().nullable() }) }), z.object({ updated: z.literal(false), reason: z.enum(['invalid_params', 'attendee_not_found', 'attendee_cancelled', 'booking_not_confirmed', 'extra_waiver_version_missing', 'no_extra_waiver']), message: z.string() })])
export type AdminSetEventAttendeeWaiverOutput = z.infer<typeof adminSetEventAttendeeWaiverOutputSchema>

/** getPromoCodes: GET promo-codes. Level Read; W54. */
export const adminGetPromoCodesInputSchema = z.object({})
export type AdminGetPromoCodesInput = z.infer<typeof adminGetPromoCodesInputSchema>
export const adminGetPromoCodesOutputSchema = z.array(z.object({ used_count: z.union([z.string(), z.number()]), restricted_customer_name: z.string().nullable(), id: z.string(), code: z.string(), description: z.string().nullable(), discount_type: z.string(), discount_value: z.string(), applies_to: z.array(z.string()), applies_on_member_prices: z.boolean(), expires_on: z.string().nullable(), max_total_uses: z.number().nullable(), one_use_per_customer: z.boolean(), min_spend: z.string().nullable(), restricted_customer_id: z.string().nullable(), active: z.boolean(), created_by: z.string().nullable(), created_at: z.string(), updated_at: z.string() }))
export type AdminGetPromoCodesOutput = z.infer<typeof adminGetPromoCodesOutputSchema>

/** getPromoCodeRedemptions: GET promo-codes/:promoCodeId/redemptions. Level Read; W54. */
export const adminGetPromoCodeRedemptionsInputSchema = z.object({ promoCodeId: z.string() })
export type AdminGetPromoCodeRedemptionsInput = z.infer<typeof adminGetPromoCodeRedemptionsInputSchema>
export const adminGetPromoCodeRedemptionsOutputSchema = z.array(z.object({ id: z.string(), order_id: z.string(), customer_id: z.string().nullable(), customer_first_name: z.string().nullable(), customer_last_name: z.string().nullable(), discount_amount: z.string(), created_at: z.string(), order_created_at: z.string() }))
export type AdminGetPromoCodeRedemptionsOutput = z.infer<typeof adminGetPromoCodeRedemptionsOutputSchema>

/** createPromoCode: POST promo-codes. Level B; W54. */
export const adminCreatePromoCodeInputSchema = z.object({ code: z.string(), description: z.string().optional(), discountType: z.string(), discountValue: z.number().nullable(), appliesTo: z.array(z.string()), appliesOnMemberPrices: z.boolean(), expiresOn: z.string().nullable(), maxTotalUses: z.number().nullable().nullable(), oneUsePerCustomer: z.boolean(), minSpend: z.number().nullable().nullable(), restrictedCustomerId: z.string().nullable() })
export type AdminCreatePromoCodeInput = z.infer<typeof adminCreatePromoCodeInputSchema>
export const adminCreatePromoCodeOutputSchema = z.object({ id: z.string(), code: z.string(), description: z.string().nullable(), discount_type: z.string(), discount_value: z.string(), applies_to: z.array(z.string()), applies_on_member_prices: z.boolean(), expires_on: z.string().nullable(), max_total_uses: z.number().nullable(), one_use_per_customer: z.boolean(), min_spend: z.string().nullable(), restricted_customer_id: z.string().nullable(), active: z.boolean(), created_by: z.string().nullable() })
export type AdminCreatePromoCodeOutput = z.infer<typeof adminCreatePromoCodeOutputSchema>

/** updatePromoCode: POST promo-codes/:id. Level B; W54. */
export const adminUpdatePromoCodeInputSchema = z.object({ id: z.string(), code: z.string(), description: z.string().optional(), discountType: z.string(), discountValue: z.number().nullable(), appliesTo: z.array(z.string()), appliesOnMemberPrices: z.boolean(), expiresOn: z.string().nullable(), maxTotalUses: z.number().nullable().nullable(), oneUsePerCustomer: z.boolean(), minSpend: z.number().nullable().nullable(), restrictedCustomerId: z.string().nullable(), active: z.boolean() })
export type AdminUpdatePromoCodeInput = z.infer<typeof adminUpdatePromoCodeInputSchema>
export const adminUpdatePromoCodeOutputSchema = z.object({ updated: z.boolean(), reason: z.enum(['not_found', 'code_locked']).optional(), message: z.string().optional(), promo: z.record(z.string(), z.unknown()).optional() })
export type AdminUpdatePromoCodeOutput = z.infer<typeof adminUpdatePromoCodeOutputSchema>

/** setBandPrice: POST pricing/bands/:bandId/price. Level B; W54. */
export const adminSetBandPriceInputSchema = z.object({ bandId: z.string(), price: z.number().nullable() })
export type AdminSetBandPriceInput = z.infer<typeof adminSetBandPriceInputSchema>
export const adminSetBandPriceOutputSchema = z.object({ updated: z.boolean(), band: z.object({ id: z.string(), code: z.string(), name: z.string(), price: z.string() }).optional() })
export type AdminSetBandPriceOutput = z.infer<typeof adminSetBandPriceOutputSchema>

/** setBandRules: POST pricing/band-rules/:dayOfWeek. Level B; W54. */
export const adminSetBandRulesInputSchema = z.object({ dayOfWeek: z.number().nullable(), rules: z.array(z.object({ bandId: z.string(), fromTime: z.string(), toTime: z.string() })) })
export type AdminSetBandRulesInput = z.infer<typeof adminSetBandRulesInputSchema>
export const adminSetBandRulesOutputSchema = z.object({ saved: z.boolean(), rebandedSessions: z.number(), rules: z.array(z.object({ id: z.string(), band_id: z.string(), from_time: z.string(), to_time: z.string() })).optional() })
export type AdminSetBandRulesOutput = z.infer<typeof adminSetBandRulesOutputSchema>

/** setMembershipBandTerm: POST pricing/member-band-terms. Level B; W54. */
export const adminSetMembershipBandTermInputSchema = z.object({ membershipLevel: z.string(), bandId: z.string(), creditEligible: z.boolean(), discountPercent: z.number().nullable() })
export type AdminSetMembershipBandTermInput = z.infer<typeof adminSetMembershipBandTermInputSchema>
export const adminSetMembershipBandTermOutputSchema = z.object({ saved: z.boolean(), term: z.object({ id: z.string(), membership_level: z.string(), band_id: z.string(), credit_eligible: z.boolean(), discount_percent: z.string() }).optional() })
export type AdminSetMembershipBandTermOutput = z.infer<typeof adminSetMembershipBandTermOutputSchema>

/** setPostageSettings: POST postage/settings. Level B; W54. */
export const adminSetPostageSettingsInputSchema = z.object({ standardPrice: z.number().nullable(), expressPrice: z.number().nullable(), freeShippingThreshold: z.number().nullable() })
export type AdminSetPostageSettingsInput = z.infer<typeof adminSetPostageSettingsInputSchema>
export const adminSetPostageSettingsOutputSchema = z.object({ standardPrice: z.number(), expressPrice: z.number(), freeShippingThreshold: z.number() })
export type AdminSetPostageSettingsOutput = z.infer<typeof adminSetPostageSettingsOutputSchema>

/** getSessionsForRange: GET sessions. Level Read; W51. */
export const adminGetSessionsForRangeInputSchema = z.object({ startDate: z.string(), endDate: z.string() })
export type AdminGetSessionsForRangeInput = z.infer<typeof adminGetSessionsForRangeInputSchema>
export const adminGetSessionsForRangeOutputSchema = z.array(z.object({ id: z.string(), service_type_id: z.string(), service_type_name: z.string(), booking_type: z.enum(['public', 'private']), start_time: z.string(), end_time: z.string(), capacity: z.number(), total_booked: z.number(), status: z.string(), blocked_reason: z.string().nullable(), blocked_by: z.string().nullable(), started: z.boolean(), confirmed_booking_count: z.number(), band_id: z.string().nullable(), band_code: z.string().nullable(), band_name: z.string().nullable(), band_price: z.string().nullable(), band_overridden: z.boolean().nullable() }))
export type AdminGetSessionsForRangeOutput = z.infer<typeof adminGetSessionsForRangeOutputSchema>

/** getServiceTypesForSlot: GET sessions/for-slot. Level Read; W51. */
export const adminGetServiceTypesForSlotInputSchema = z.object({ startTime: z.string() })
export type AdminGetServiceTypesForSlotInput = z.infer<typeof adminGetServiceTypesForSlotInputSchema>
export const adminGetServiceTypesForSlotOutputSchema = z.array(z.object({ service_type_id: z.string(), service_type_name: z.string(), booking_type: z.enum(['public', 'private']), duration: z.number(), session_id: z.string(), start_time: z.string(), end_time: z.string(), capacity: z.number(), total_booked: z.number(), status: z.string(), blocked_reason: z.string().nullable(), started: z.boolean(), band_id: z.string().nullable(), band_code: z.string().nullable(), band_name: z.string().nullable(), band_price: z.string().nullable(), band_overridden: z.boolean().nullable() }))
export type AdminGetServiceTypesForSlotOutput = z.infer<typeof adminGetServiceTypesForSlotOutputSchema>

/** blockSession: POST sessions/:sessionId/block. Level B; W51. */
export const adminBlockSessionInputSchema = z.object({ sessionId: z.string(), reason: z.string() })
export type AdminBlockSessionInput = z.infer<typeof adminBlockSessionInputSchema>
export const adminBlockSessionOutputSchema = z.object({ blocked: z.boolean(), conflict: z.boolean(), conflictingBookings: z.array(z.object({ id: z.string(), customer_first_name: z.string(), customer_last_name: z.string(), party_size: z.number(), price_paid: z.string(), redemption_source: z.string(), status: z.string() })), session: z.record(z.string(), z.unknown()).nullable() })
export type AdminBlockSessionOutput = z.infer<typeof adminBlockSessionOutputSchema>

/** blockDay: POST sessions/days/:date/block. Level B; W51. */
export const adminBlockDayInputSchema = z.object({ date: z.string(), reason: z.string() })
export type AdminBlockDayInput = z.infer<typeof adminBlockDayInputSchema>
export const adminBlockDayOutputSchema = z.object({ blocked: z.boolean(), conflict: z.boolean(), conflictingBookings: z.array(z.object({ id: z.string(), session_id: z.string(), service_type_name: z.string(), booking_type: z.enum(['public', 'private']), session_start_time: z.string(), session_end_time: z.string(), customer_first_name: z.string(), customer_last_name: z.string(), party_size: z.number(), price_paid: z.string(), redemption_source: z.string(), status: z.string() })), blockedCount: z.number() })
export type AdminBlockDayOutput = z.infer<typeof adminBlockDayOutputSchema>

/** unblockSession: POST sessions/:sessionId/unblock. Level B; W51. */
export const adminUnblockSessionInputSchema = z.object({ sessionId: z.string() })
export type AdminUnblockSessionInput = z.infer<typeof adminUnblockSessionInputSchema>
export const adminUnblockSessionOutputSchema = z.record(z.string(), z.unknown()).nullable()
export type AdminUnblockSessionOutput = z.infer<typeof adminUnblockSessionOutputSchema>

/** unblockDay: POST sessions/days/:date/unblock (and its quote). Level B; W51. */
export const adminUnblockDayInputSchema = z.object({ date: z.string(), confirmed: z.boolean().optional() })
export type AdminUnblockDayInput = z.infer<typeof adminUnblockDayInputSchema>
export const adminUnblockDayOutputSchema = z.object({ confirmed: z.boolean(), blockedSessions: z.number(), unblocked: z.number().optional() })
export type AdminUnblockDayOutput = z.infer<typeof adminUnblockDayOutputSchema>

/** setSessionBand: POST sessions/:sessionId/band, POST sessions/days/:date/band (and its quote). Level B; W51. */
export const adminSetSessionBandInputSchema = z.object({ sessionId: z.string().optional(), date: z.string().optional(), bandId: z.string(), confirmed: z.boolean().optional() })
export type AdminSetSessionBandInput = z.infer<typeof adminSetSessionBandInputSchema>
export const adminSetSessionBandOutputSchema = z.object({ confirmed: z.boolean(), sessionsAffected: z.number(), bookingsAffected: z.number() })
export type AdminSetSessionBandOutput = z.infer<typeof adminSetSessionBandOutputSchema>

/** resetSessionBand: POST sessions/:sessionId/band/reset. Level B; W51. */
export const adminResetSessionBandInputSchema = z.object({ sessionId: z.string() })
export type AdminResetSessionBandInput = z.infer<typeof adminResetSessionBandInputSchema>
export const adminResetSessionBandOutputSchema = z.object({ reset: z.boolean(), reason: z.enum(['session_not_found', 'not_overridden']).optional(), band: z.object({ code: z.string(), name: z.string() }).nullable().optional() })
export type AdminResetSessionBandOutput = z.infer<typeof adminResetSessionBandOutputSchema>

/** setSessionStartTime: POST sessions/:sessionId/start-time. Level B; W51. */
export const adminSetSessionStartTimeInputSchema = z.object({ sessionId: z.string(), startTime: z.string() })
export type AdminSetSessionStartTimeInput = z.infer<typeof adminSetSessionStartTimeInputSchema>
export const adminSetSessionStartTimeOutputSchema = z.object({ updated: z.boolean(), reason: z.enum(['session_not_found', 'invalid_start_time', 'session_has_bookings', 'slot_already_exists']).optional(), message: z.string().optional(), session: z.object({ id: z.string(), start_time: z.string(), end_time: z.string() }).optional(), band: z.object({ code: z.string(), name: z.string(), overridden: z.boolean() }).nullable().optional() })
export type AdminSetSessionStartTimeOutput = z.infer<typeof adminSetSessionStartTimeOutputSchema>

/** createOneOffSession: POST sessions. Level B; W51. */
export const adminCreateOneOffSessionInputSchema = z.object({ serviceTypeId: z.string(), startTime: z.string() })
export type AdminCreateOneOffSessionInput = z.infer<typeof adminCreateOneOffSessionInputSchema>
export const adminCreateOneOffSessionOutputSchema = z.object({ created: z.boolean(), reason: z.enum(['slot_already_exists', 'service_type_not_found', 'service_type_incomplete']).optional(), session: z.object({ id: z.string(), service_type_id: z.string(), start_time: z.string(), end_time: z.string(), capacity: z.number(), type: z.string() }).optional() })
export type AdminCreateOneOffSessionOutput = z.infer<typeof adminCreateOneOffSessionOutputSchema>

/** generateUpcomingSessions: none: dead code, deleted at W51 (GB24). Level none; W51. */
export const adminGenerateUpcomingSessionsInputSchema = z.object({})
export type AdminGenerateUpcomingSessionsInput = z.infer<typeof adminGenerateUpcomingSessionsInputSchema>
export const adminGenerateUpcomingSessionsOutputSchema = z.object({ slotsInserted: z.number(), horizonEnd: z.string() })
export type AdminGenerateUpcomingSessionsOutput = z.infer<typeof adminGenerateUpcomingSessionsOutputSchema>

/** getBookings: GET bookings. Level Read; W50. */
export const adminGetBookingsInputSchema = z.object({ startDate: z.string().optional(), endDate: z.string().optional(), status: z.string().optional() })
export type AdminGetBookingsInput = z.infer<typeof adminGetBookingsInputSchema>
export const adminGetBookingsOutputSchema = z.array(z.object({ id: z.string(), session_id: z.string(), customer_id: z.string(), party_size: z.number(), status: z.string(), price_paid: z.string(), stripe_payment_id: z.string().nullable(), redemption_source: z.string().nullable(), special_requests: z.string().nullable(), credit_period_id: z.string().nullable(), payment_method: z.string().nullable(), checked_in_at: z.string().nullable(), cancelled_at: z.string().nullable(), created_at: z.string(), updated_at: z.string(), start_time: z.string(), end_time: z.string(), service_type_id: z.string(), service_type_name: z.string(), booking_type: z.enum(['public', 'private']), customer_first_name: z.string(), customer_last_name: z.string(), customer_email: z.string(), band_id: z.string().nullable(), cancel_reason: z.string().nullable(), guests_over_18_confirmed_at: z.string().nullable(), part_refunded_amount: z.string(), payment_due_by: z.string().nullable(), redeemed_membership_id: z.string().nullable(), redeemed_session_pass_id: z.string().nullable(), refund_owed_amount: z.string() }))
export type AdminGetBookingsOutput = z.infer<typeof adminGetBookingsOutputSchema>

/** getBookingById: GET bookings/:bookingId. Level Read; W50. */
export const adminGetBookingByIdInputSchema = z.object({ bookingId: z.string() })
export type AdminGetBookingByIdInput = z.infer<typeof adminGetBookingByIdInputSchema>
export const adminGetBookingByIdOutputSchema = z.object({ id: z.string(), session_id: z.string(), customer_id: z.string(), party_size: z.number(), status: z.string(), price_paid: z.string(), stripe_payment_id: z.string().nullable(), redemption_source: z.string().nullable(), special_requests: z.string().nullable(), credit_period_id: z.string().nullable(), payment_method: z.string().nullable(), checked_in_at: z.string().nullable(), cancelled_at: z.string().nullable(), created_at: z.string(), updated_at: z.string(), start_time: z.string(), end_time: z.string(), service_type_id: z.string(), service_type_name: z.string(), booking_type: z.enum(['public', 'private']), customer_first_name: z.string(), customer_last_name: z.string(), customer_email: z.string(), band_id: z.string().nullable(), cancel_reason: z.string().nullable(), guests_over_18_confirmed_at: z.string().nullable(), part_refunded_amount: z.string(), payment_due_by: z.string().nullable(), redeemed_membership_id: z.string().nullable(), redeemed_session_pass_id: z.string().nullable(), refund_owed_amount: z.string() }).nullable()
export type AdminGetBookingByIdOutput = z.infer<typeof adminGetBookingByIdOutputSchema>

/** getBookingDetail: GET bookings/:bookingId/detail. Level Read; W50. */
export const adminGetBookingDetailInputSchema = z.object({ bookingId: z.string() })
export type AdminGetBookingDetailInput = z.infer<typeof adminGetBookingDetailInputSchema>
export const adminGetBookingDetailOutputSchema = z.object({ guests: z.array(z.object({ id: z.string(), booking_id: z.string(), guest_name: z.string(), guest_email: z.string().nullable(), guest_type: z.string(), date_of_birth: z.string().nullable(), waiver_accepted: z.boolean().nullable(), waiver_accepted_at: z.string().nullable(), waiver_method: z.string().nullable(), waiver_version: z.string().nullable(), reminder_sent_at: z.string().nullable(), created_at: z.string(), unit_price: z.string().nullable(), pay_by: z.string().nullable() })), addonLines: z.array(z.object({ id: z.string(), booking_id: z.string(), addon_id: z.string(), addon_name: z.string(), quantity: z.number(), price_at_purchase: z.string(), sku_at_purchase: z.string(), redemption_source: z.string().nullable(), prepared: z.boolean(), prepared_at: z.string().nullable(), prepared_by: z.string().nullable(), created_at: z.string(), redeemed_membership_id: z.string().nullable(), removed_at: z.string().nullable(), removed_by_name: z.string().nullable(), refunded_amount: z.string(), card_refunded_amount: z.string(), refund_method: z.enum(['card', 'credit', 'none', 'credit_returned']).nullable(), order_has_card: z.boolean() })), specialRequests: z.string().nullable(), refundOwedAmount: z.string(), readerPaymentOpenMessage: z.string().nullable() })
export type AdminGetBookingDetailOutput = z.infer<typeof adminGetBookingDetailOutputSchema>

/** getAddonPrepChecklistForRange: GET bookings/addon-prep. Level Read; W50. */
export const adminGetAddonPrepChecklistForRangeInputSchema = z.object({ startDate: z.string(), endDate: z.string() })
export type AdminGetAddonPrepChecklistForRangeInput = z.infer<typeof adminGetAddonPrepChecklistForRangeInputSchema>
export const adminGetAddonPrepChecklistForRangeOutputSchema = z.array(z.object({ id: z.string(), booking_id: z.string(), addon_id: z.string(), addon_name: z.string(), quantity: z.number(), prepared: z.boolean(), prepared_at: z.string().nullable(), prepared_by: z.string().nullable(), session_id: z.string(), start_time: z.string(), end_time: z.string(), service_type_name: z.string(), customer_first_name: z.string(), customer_last_name: z.string(), booking_status: z.string(), special_requests: z.string().nullable() }))
export type AdminGetAddonPrepChecklistForRangeOutput = z.infer<typeof adminGetAddonPrepChecklistForRangeOutputSchema>

/** setBookingCheckedIn: POST bookings/:bookingId/check-in. Level C; W50. */
export const adminSetBookingCheckedInInputSchema = z.object({ bookingId: z.string(), checkedIn: z.boolean() })
export type AdminSetBookingCheckedInInput = z.infer<typeof adminSetBookingCheckedInInputSchema>
export const adminSetBookingCheckedInOutputSchema = z.record(z.string(), z.unknown()).nullable()
export type AdminSetBookingCheckedInOutput = z.infer<typeof adminSetBookingCheckedInOutputSchema>

/** setGuestWaiverStatus: POST bookings/guests/:guestId/waiver. Level C; W50. */
export const adminSetGuestWaiverStatusInputSchema = z.object({ guestId: z.string(), accepted: z.boolean(), waiverMethod: z.string().optional(), waiverVersion: z.string().optional() })
export type AdminSetGuestWaiverStatusInput = z.infer<typeof adminSetGuestWaiverStatusInputSchema>
export const adminSetGuestWaiverStatusOutputSchema = z.record(z.string(), z.unknown()).nullable()
export type AdminSetGuestWaiverStatusOutput = z.infer<typeof adminSetGuestWaiverStatusOutputSchema>

/** setAddonLinePrepared: POST bookings/addon-lines/:lineId/prepared. Level C; W50. */
export const adminSetAddonLinePreparedInputSchema = z.object({ lineId: z.string(), prepared: z.boolean() })
export type AdminSetAddonLinePreparedInput = z.infer<typeof adminSetAddonLinePreparedInputSchema>
export const adminSetAddonLinePreparedOutputSchema = z.record(z.string(), z.unknown()).nullable()
export type AdminSetAddonLinePreparedOutput = z.infer<typeof adminSetAddonLinePreparedOutputSchema>

/** getOrders: GET orders. Level Read; W53. */
export const adminGetOrdersInputSchema = z.object({ startDate: z.string().optional(), endDate: z.string().optional(), paymentStatus: z.string().optional(), orderSource: z.string().optional(), search: z.string().optional(), view: z.string().optional() })
export type AdminGetOrdersInput = z.infer<typeof adminGetOrdersInputSchema>
export const adminGetOrdersOutputSchema = z.array(z.object({ id: z.string(), customer_id: z.string(), customer_first_name: z.string(), customer_last_name: z.string(), customer_email: z.string(), order_total: z.string(), payment_status: z.enum(['pending', 'paid', 'failed', 'refunded', 'partially_refunded']), order_source: z.enum(['online', 'staff_created']).nullable(), discount_amount: z.string().nullable(), promo_code: z.string().nullable(), stripe_payment_intent_id: z.string().nullable(), tracking_number: z.string().nullable(), shipping_status: z.string().nullable(), created_at: z.string(), updated_at: z.string(), payment_method: z.string().nullable(), refund_owed_amount: z.string(), shipping_address: z.record(z.string(), z.unknown()).nullable(), reader_payment: z.record(z.string(), z.unknown()).nullable(), computed_status: z.enum(['needs_action', 'upcoming', 'complete']) }))
export type AdminGetOrdersOutput = z.infer<typeof adminGetOrdersOutputSchema>

/** getOrderLineItems: GET orders/:orderId/lines. Level Read; W53. */
export const adminGetOrderLineItemsInputSchema = z.object({ orderId: z.string() })
export type AdminGetOrderLineItemsInput = z.infer<typeof adminGetOrderLineItemsInputSchema>
export const adminGetOrderLineItemsOutputSchema = z.array(z.object({ id: z.string(), order_id: z.string(), item_type: z.enum(['product', 'addon', 'booking', 'session_pass', 'membership', 'event', 'gift_card', 'postage']), quantity: z.number(), unit_price: z.string(), line_total: z.string(), booking_id: z.string().nullable(), product_variant_id: z.string().nullable(), membership_plan_id: z.string().nullable(), session_pass_type_id: z.string().nullable(), gift_card_id: z.string().nullable(), addon_id: z.string().nullable(), refunded_at: z.string().nullable(), refund_method: z.string().nullable(), restocked: z.boolean().nullable(), fulfillment_status: z.enum(['pending', 'fulfilled']).nullable(), system_unit_price: z.string().nullable(), price_override_reason: z.string().nullable(), discount_amount: z.string().nullable(), service_type_name: z.string().nullable(), product_name: z.string().nullable(), product_variant_size: z.string().nullable(), membership_plan_name: z.string().nullable(), session_pass_type_name: z.string().nullable(), gift_card_code: z.string().nullable(), gift_card_fulfillment_method: z.enum(['shipping', 'pickup', 'digital']).nullable(), gift_card_picked_up: z.boolean().nullable(), gift_card_shipped_at: z.string().nullable(), addon_name: z.string().nullable(), event_booking_id: z.string().nullable(), event_name: z.string().nullable(), event_starts_at: z.string().nullable(), event_attendees: z.array(z.object({ attendee_type: z.enum(['account_holder', 'guest']), name: z.string(), price_level: z.enum(['public', 'pre_herd', 'herd']), unit_price: z.union([z.string(), z.number()]), cancelled_at: z.string().nullable(), refunded_amount: z.union([z.string(), z.number()]), card_refunded_amount: z.union([z.string(), z.number()]), refund_method: z.enum(['card', 'credit', 'none']).nullable() })).nullable(), event_cancelled_at: z.string().nullable(), event_cancellation_summary: z.string().nullable(), addon_refund_summary: z.string().nullable(), payment_date_change_extra_days: z.number().nullable(), created_at: z.string(), item_name: z.string() }))
export type AdminGetOrderLineItemsOutput = z.infer<typeof adminGetOrderLineItemsOutputSchema>

/** setOrderLineItemFulfilled: POST orders/lines/:lineItemId/fulfilled. Level C; W53. */
export const adminSetOrderLineItemFulfilledInputSchema = z.object({ lineItemId: z.string(), fulfilled: z.boolean() })
export type AdminSetOrderLineItemFulfilledInput = z.infer<typeof adminSetOrderLineItemFulfilledInputSchema>
export const adminSetOrderLineItemFulfilledOutputSchema = z.object({ updated: z.boolean(), reason: z.enum(['not_found', 'not_a_product_line']).optional(), lineItem: z.record(z.string(), z.unknown()).optional() })
export type AdminSetOrderLineItemFulfilledOutput = z.infer<typeof adminSetOrderLineItemFulfilledOutputSchema>

/** getPaymentAttentionItems: GET overview/payment-attention. Level Read; W50. */
export const adminGetPaymentAttentionItemsInputSchema = z.object({})
export type AdminGetPaymentAttentionItemsInput = z.infer<typeof adminGetPaymentAttentionItemsInputSchema>
export const adminGetPaymentAttentionItemsOutputSchema = z.object({ bookings: z.array(z.object({ id: z.string(), customer_id: z.string(), party_size: z.number(), status: z.string(), price_paid: z.string(), payment_due_by: z.string().nullable(), session_id: z.string(), stripe_payment_id: z.string().nullable(), redemption_source: z.string().nullable(), special_requests: z.string().nullable(), credit_period_id: z.string().nullable(), payment_method: z.string().nullable(), checked_in_at: z.string().nullable(), cancelled_at: z.string().nullable(), created_at: z.string(), updated_at: z.string(), service_type_id: z.string(), start_time: z.string(), end_time: z.string(), service_type_name: z.string(), booking_type: z.string(), customer_first_name: z.string(), customer_last_name: z.string(), customer_email: z.string(), band_id: z.string().nullable(), cancel_reason: z.string().nullable(), guests_over_18_confirmed_at: z.string().nullable(), part_refunded_amount: z.string(), redeemed_membership_id: z.string().nullable(), redeemed_session_pass_id: z.string().nullable(), refund_owed_amount: z.string() })), memberships: z.array(z.object({ membership_id: z.string(), customer_id: z.string(), first_name: z.string(), last_name: z.string(), email: z.string(), plan_name: z.string() })) })
export type AdminGetPaymentAttentionItemsOutput = z.infer<typeof adminGetPaymentAttentionItemsOutputSchema>

/** getWaiverGapsForRange: GET bookings/waiver-gaps. Level Read; W50. */
export const adminGetWaiverGapsForRangeInputSchema = z.object({ startDate: z.string(), endDate: z.string() })
export type AdminGetWaiverGapsForRangeInput = z.infer<typeof adminGetWaiverGapsForRangeInputSchema>
export const adminGetWaiverGapsForRangeOutputSchema = z.array(z.object({ id: z.string(), booking_id: z.string(), guest_name: z.string(), guest_type: z.string(), customer_first_name: z.string(), customer_last_name: z.string(), start_time: z.string(), service_type_name: z.string() }))
export type AdminGetWaiverGapsForRangeOutput = z.infer<typeof adminGetWaiverGapsForRangeOutputSchema>

/** getTodaysEvents: GET events/today. Level Read; W52. */
export const adminGetTodaysEventsInputSchema = z.object({})
export type AdminGetTodaysEventsInput = z.infer<typeof adminGetTodaysEventsInputSchema>
export const adminGetTodaysEventsOutputSchema = z.object({ events: z.array(z.object({ id: z.string(), name: z.string(), starts_at: z.string(), ends_at: z.string().nullable(), capacity: z.number().nullable(), places_booked: z.number(), has_extra_waiver: z.boolean(), attendee_count: z.number(), checked_in_count: z.number(), standard_waivers_outstanding: z.number(), extra_waivers_outstanding: z.number() })), waiverGaps: z.array(z.object({ id: z.string(), name: z.string(), attendee_type: z.enum(['account_holder', 'guest']), event_id: z.string(), event_name: z.string(), starts_at: z.string(), customer_first_name: z.string(), customer_last_name: z.string(), standard_outstanding: z.boolean(), extra_outstanding: z.boolean() })) })
export type AdminGetTodaysEventsOutput = z.infer<typeof adminGetTodaysEventsOutputSchema>

/** Every step G contract by the staff app function it is for (lead call L11). */
export const ADMIN_CONTRACTS = {
  getCurrentStaff: { input: adminGetCurrentStaffInputSchema, output: adminGetCurrentStaffOutputSchema },
  getStaff: { input: adminGetStaffInputSchema, output: adminGetStaffOutputSchema },
  createStaff: { input: adminCreateStaffInputSchema, output: adminCreateStaffOutputSchema },
  setStaffRole: { input: adminSetStaffRoleInputSchema, output: adminSetStaffRoleOutputSchema },
  setStaffPermission: { input: adminSetStaffPermissionInputSchema, output: adminSetStaffPermissionOutputSchema },
  setStaffCanManagePricing: { input: adminSetStaffCanManagePricingInputSchema, output: adminSetStaffCanManagePricingOutputSchema },
  getServiceTypes: { input: adminGetServiceTypesInputSchema, output: adminGetServiceTypesOutputSchema },
  setServiceTypeActive: { input: adminSetServiceTypeActiveInputSchema, output: adminSetServiceTypeActiveOutputSchema },
  setServiceTypeCapacityInfo: { input: adminSetServiceTypeCapacityInfoInputSchema, output: adminSetServiceTypeCapacityInfoOutputSchema },
  createServiceTypePriceTier: { input: adminCreateServiceTypePriceTierInputSchema, output: adminCreateServiceTypePriceTierOutputSchema },
  setServiceTypePriceTierRange: { input: adminSetServiceTypePriceTierRangeInputSchema, output: adminSetServiceTypePriceTierRangeOutputSchema },
  updateTierPrice: { input: adminUpdateTierPriceInputSchema, output: adminUpdateTierPriceOutputSchema },
  addServiceTypeScheduleSlot: { input: adminAddServiceTypeScheduleSlotInputSchema, output: adminAddServiceTypeScheduleSlotOutputSchema },
  deleteServiceTypeScheduleSlot: { input: adminDeleteServiceTypeScheduleSlotInputSchema, output: adminDeleteServiceTypeScheduleSlotOutputSchema },
  getProducts: { input: adminGetProductsInputSchema, output: adminGetProductsOutputSchema },
  setProductActive: { input: adminSetProductActiveInputSchema, output: adminSetProductActiveOutputSchema },
  setProductFulfillmentMethod: { input: adminSetProductFulfillmentMethodInputSchema, output: adminSetProductFulfillmentMethodOutputSchema },
  setProductVariantDetails: { input: adminSetProductVariantDetailsInputSchema, output: adminSetProductVariantDetailsOutputSchema },
  createProductVariant: { input: adminCreateProductVariantInputSchema, output: adminCreateProductVariantOutputSchema },
  adjustVariantStock: { input: adminAdjustVariantStockInputSchema, output: adminAdjustVariantStockOutputSchema },
  getStockAdjustments: { input: adminGetStockAdjustmentsInputSchema, output: adminGetStockAdjustmentsOutputSchema },
  updateCatalogItemPrice: { input: adminUpdateCatalogItemPriceInputSchema, output: adminUpdateCatalogItemPriceOutputSchema },
  getAddons: { input: adminGetAddonsInputSchema, output: adminGetAddonsOutputSchema },
  setAddonActive: { input: adminSetAddonActiveInputSchema, output: adminSetAddonActiveOutputSchema },
  setAddonSku: { input: adminSetAddonSkuInputSchema, output: adminSetAddonSkuOutputSchema },
  getSessionPassTypes: { input: adminGetSessionPassTypesInputSchema, output: adminGetSessionPassTypesOutputSchema },
  setSessionPassActive: { input: adminSetSessionPassActiveInputSchema, output: adminSetSessionPassActiveOutputSchema },
  setSessionPassExpiry: { input: adminSetSessionPassExpiryInputSchema, output: adminSetSessionPassExpiryOutputSchema },
  setSessionPassSessionsIncluded: { input: adminSetSessionPassSessionsIncludedInputSchema, output: adminSetSessionPassSessionsIncludedOutputSchema },
  setSessionPassLevel: { input: adminSetSessionPassLevelInputSchema, output: adminSetSessionPassLevelOutputSchema },
  getGiftCardTypes: { input: adminGetGiftCardTypesInputSchema, output: adminGetGiftCardTypesOutputSchema },
  setGiftCardTypeActive: { input: adminSetGiftCardTypeActiveInputSchema, output: adminSetGiftCardTypeActiveOutputSchema },
  setGiftCardPresetActive: { input: adminSetGiftCardPresetActiveInputSchema, output: adminSetGiftCardPresetActiveOutputSchema },
  createGiftCardPreset: { input: adminCreateGiftCardPresetInputSchema, output: adminCreateGiftCardPresetOutputSchema },
  updateGiftCardPresetPrice: { input: adminUpdateGiftCardPresetPriceInputSchema, output: adminUpdateGiftCardPresetPriceOutputSchema },
  setGiftCardTypeCustomAmountSettings: { input: adminSetGiftCardTypeCustomAmountSettingsInputSchema, output: adminSetGiftCardTypeCustomAmountSettingsOutputSchema },
  setGiftCardTypeExpiry: { input: adminSetGiftCardTypeExpiryInputSchema, output: adminSetGiftCardTypeExpiryOutputSchema },
  getMembershipPlans: { input: adminGetMembershipPlansInputSchema, output: adminGetMembershipPlansOutputSchema },
  createMembershipPlan: { input: adminCreateMembershipPlanInputSchema, output: adminCreateMembershipPlanOutputSchema },
  setMembershipPlanActive: { input: adminSetMembershipPlanActiveInputSchema, output: adminSetMembershipPlanActiveOutputSchema },
  setMembershipPlanDetails: { input: adminSetMembershipPlanDetailsInputSchema, output: adminSetMembershipPlanDetailsOutputSchema },
  getMembershipSettings: { input: adminGetMembershipSettingsInputSchema, output: adminGetMembershipSettingsOutputSchema },
  setMembershipSettings: { input: adminSetMembershipSettingsInputSchema, output: adminSetMembershipSettingsOutputSchema },
  getEvents: { input: adminGetEventsInputSchema, output: adminGetEventsOutputSchema },
  setEventActive: { input: adminSetEventActiveInputSchema, output: adminSetEventActiveOutputSchema },
  setEventDetails: { input: adminSetEventDetailsInputSchema, output: adminSetEventDetailsOutputSchema },
  getEventAttendees: { input: adminGetEventAttendeesInputSchema, output: adminGetEventAttendeesOutputSchema },
  setEventAttendeeCheckIn: { input: adminSetEventAttendeeCheckInInputSchema, output: adminSetEventAttendeeCheckInOutputSchema },
  setEventAttendeesCheckIn: { input: adminSetEventAttendeesCheckInInputSchema, output: adminSetEventAttendeesCheckInOutputSchema },
  setEventAttendeeWaiver: { input: adminSetEventAttendeeWaiverInputSchema, output: adminSetEventAttendeeWaiverOutputSchema },
  getPromoCodes: { input: adminGetPromoCodesInputSchema, output: adminGetPromoCodesOutputSchema },
  getPromoCodeRedemptions: { input: adminGetPromoCodeRedemptionsInputSchema, output: adminGetPromoCodeRedemptionsOutputSchema },
  createPromoCode: { input: adminCreatePromoCodeInputSchema, output: adminCreatePromoCodeOutputSchema },
  updatePromoCode: { input: adminUpdatePromoCodeInputSchema, output: adminUpdatePromoCodeOutputSchema },
  setBandPrice: { input: adminSetBandPriceInputSchema, output: adminSetBandPriceOutputSchema },
  setBandRules: { input: adminSetBandRulesInputSchema, output: adminSetBandRulesOutputSchema },
  setMembershipBandTerm: { input: adminSetMembershipBandTermInputSchema, output: adminSetMembershipBandTermOutputSchema },
  setPostageSettings: { input: adminSetPostageSettingsInputSchema, output: adminSetPostageSettingsOutputSchema },
  getSessionsForRange: { input: adminGetSessionsForRangeInputSchema, output: adminGetSessionsForRangeOutputSchema },
  getServiceTypesForSlot: { input: adminGetServiceTypesForSlotInputSchema, output: adminGetServiceTypesForSlotOutputSchema },
  blockSession: { input: adminBlockSessionInputSchema, output: adminBlockSessionOutputSchema },
  blockDay: { input: adminBlockDayInputSchema, output: adminBlockDayOutputSchema },
  unblockSession: { input: adminUnblockSessionInputSchema, output: adminUnblockSessionOutputSchema },
  unblockDay: { input: adminUnblockDayInputSchema, output: adminUnblockDayOutputSchema },
  setSessionBand: { input: adminSetSessionBandInputSchema, output: adminSetSessionBandOutputSchema },
  resetSessionBand: { input: adminResetSessionBandInputSchema, output: adminResetSessionBandOutputSchema },
  setSessionStartTime: { input: adminSetSessionStartTimeInputSchema, output: adminSetSessionStartTimeOutputSchema },
  createOneOffSession: { input: adminCreateOneOffSessionInputSchema, output: adminCreateOneOffSessionOutputSchema },
  generateUpcomingSessions: { input: adminGenerateUpcomingSessionsInputSchema, output: adminGenerateUpcomingSessionsOutputSchema },
  getBookings: { input: adminGetBookingsInputSchema, output: adminGetBookingsOutputSchema },
  getBookingById: { input: adminGetBookingByIdInputSchema, output: adminGetBookingByIdOutputSchema },
  getBookingDetail: { input: adminGetBookingDetailInputSchema, output: adminGetBookingDetailOutputSchema },
  getAddonPrepChecklistForRange: { input: adminGetAddonPrepChecklistForRangeInputSchema, output: adminGetAddonPrepChecklistForRangeOutputSchema },
  setBookingCheckedIn: { input: adminSetBookingCheckedInInputSchema, output: adminSetBookingCheckedInOutputSchema },
  setGuestWaiverStatus: { input: adminSetGuestWaiverStatusInputSchema, output: adminSetGuestWaiverStatusOutputSchema },
  setAddonLinePrepared: { input: adminSetAddonLinePreparedInputSchema, output: adminSetAddonLinePreparedOutputSchema },
  getOrders: { input: adminGetOrdersInputSchema, output: adminGetOrdersOutputSchema },
  getOrderLineItems: { input: adminGetOrderLineItemsInputSchema, output: adminGetOrderLineItemsOutputSchema },
  setOrderLineItemFulfilled: { input: adminSetOrderLineItemFulfilledInputSchema, output: adminSetOrderLineItemFulfilledOutputSchema },
  getPaymentAttentionItems: { input: adminGetPaymentAttentionItemsInputSchema, output: adminGetPaymentAttentionItemsOutputSchema },
  getWaiverGapsForRange: { input: adminGetWaiverGapsForRangeInputSchema, output: adminGetWaiverGapsForRangeOutputSchema },
  getTodaysEvents: { input: adminGetTodaysEventsInputSchema, output: adminGetTodaysEventsOutputSchema },
} as const
export type AdminFunctionName = keyof typeof ADMIN_CONTRACTS

/**
 * What each step G write records in audit_log, in the same transaction as the change (G-plan 4.6, lead call L6): who,
 * the row before and after, and the press's key. The `plan.*` and `membership.price_moved` rows are level A's (W57).
 */
export const ADMIN_ACTIONS = [
  'staff.created',
  'staff.role_set',
  'staff.permission_set',
  'catalog.active_set',
  'catalog.price_set',
  'catalog.details_set',
  'catalog.tier_created',
  'catalog.tier_range_set',
  'catalog.variant_created',
  'stock.adjusted',
  'catalog.preset_created',
  'plan.created',
  'plan.details_set',
  'plan.price_change',
  'plan.active_set',
  'membership.price_moved',
  'membership_settings.set',
  'event.details_set',
  'event.active_set',
  'promo.created',
  'promo.updated',
  'pricing.band_price_set',
  'pricing.band_rules_set',
  'pricing.member_term_set',
  'postage.set',
  'session.blocked',
  'session.unblocked',
  'session.band_set',
  'session.band_reset',
  'session.start_time_set',
  'session.created',
  'timetable.slot_added',
  'timetable.slot_removed',
  'booking.checked_in',
  'booking.guest_waiver_set',
  'addon_line.prepared_set',
  'event_attendee.checked_in',
  'event_attendee.waiver_set',
  'order_line.fulfilled_set',
] as const
export const adminActionSchema = z.enum(ADMIN_ACTIONS)
export type AdminAction = z.infer<typeof adminActionSchema>

/**
 * `details` on every step G refusal: the old reason (or a new one, where the old function gave only words), the
 * words staff see, the action or read refused, and the switch kinds that are off for a plan action (MEMBERSHIP_PATH_OFF
 * with `plan_changes`).
 */
export const adminRefusalDetailsSchema = z.object({
  reason: z.string(),
  message: z.string(),
  /** An audit action for a write (`catalog.price_set`), or the read's name (`staff.list`). */
  action: z.string(),
  kinds: z.array(z.string()).optional(),
})
export type AdminRefusalDetails = z.infer<typeof adminRefusalDetailsSchema>

// ---------------------------------------------------------------------------------------------------------------------
// W49 + W54: the routes' own inputs and answers, where a route's are not one old function's. A route's input is its
// path's parameters with its body; every field the old function checked for itself is `unknown` here, so the rule
// answers in the old words (a missing name, a role that isn't one, a price that isn't a number, band windows sent as
// text) instead of the route answering a generic validation error. Kept after everything W48 wrote, so the staff
// app's generated types keep their order.

/** A field the rule checks for itself: anything, or left out (a missing field is refused by the rule, in the old words). */
const loose = z.unknown().optional()

/** Staff (W49). `GET staff/me` and `GET staff` take nothing and answer adminGetCurrentStaffOutputSchema and adminGetStaffOutputSchema. */
export const staffCreateRouteInputSchema = z.object({ firstName: loose, lastName: loose, email: loose, role: loose, canIssueRefunds: loose })
export type StaffCreateRouteInput = z.infer<typeof staffCreateRouteInputSchema>

/** `POST staff/:staffId/role`: setStaffRole. */
export const staffRoleRouteInputSchema = z.object({ staffId: z.string(), role: loose })
export type StaffRoleRouteInput = z.infer<typeof staffRoleRouteInputSchema>
export const staffRoleRouteOutputSchema = z.object({ id: z.string(), role: z.enum(['admin', 'manager', 'staff']) })
export type StaffRoleRouteOutput = z.infer<typeof staffRoleRouteOutputSchema>

/**
 * `POST staff/:staffId/permissions`: one switch a press, named by its column (`can_issue_refunds`,
 * `can_manage_pricing` or `active`). The staff app's setStaffPermission sends the first or the last, and
 * setStaffCanManagePricing the middle one (lead call L11: one function per old function, two functions on one route).
 * The answer is the staff member's id and the switch as it now is, under its column's name, as both old functions answered.
 */
export const staffPermissionRouteInputSchema = z.object({ staffId: z.string(), field: loose, value: z.boolean() })
export type StaffPermissionRouteInput = z.infer<typeof staffPermissionRouteInputSchema>
export const staffPermissionRouteOutputSchema = z.object({ id: z.string(), can_issue_refunds: z.boolean().optional(), can_manage_pricing: z.boolean().optional(), active: z.boolean().optional() })
export type StaffPermissionRouteOutput = z.infer<typeof staffPermissionRouteOutputSchema>

/** Pricing (W54). `POST pricing/bands/:bandId/price`: setBandPrice. Answers adminSetBandPriceOutputSchema (`updated: true` and the band). */
export const bandPriceRouteInputSchema = z.object({ bandId: z.string(), price: loose })
export type BandPriceRouteInput = z.infer<typeof bandPriceRouteInputSchema>

/** `POST pricing/band-rules/:dayOfWeek`: setBandRules. The day comes from the path, so as text. Answers adminSetBandRulesOutputSchema. */
export const bandRulesRouteInputSchema = z.object({ dayOfWeek: z.string(), rules: loose, stamp: loose })
export type BandRulesRouteInput = z.infer<typeof bandRulesRouteInputSchema>

/** `POST pricing/member-band-terms`: setMembershipBandTerm. Answers adminSetMembershipBandTermOutputSchema. */
export const memberBandTermRouteInputSchema = z.object({ membershipLevel: loose, bandId: loose, creditEligible: loose, discountPercent: loose, stamp: loose })
export type MemberBandTermRouteInput = z.infer<typeof memberBandTermRouteInputSchema>

/** `POST postage/settings`: setPostageSettings. Answers adminSetPostageSettingsOutputSchema. */
export const postageSettingsRouteInputSchema = z.object({ standardPrice: loose, expressPrice: loose, freeShippingThreshold: loose, stamp: loose })
export type PostageSettingsRouteInput = z.infer<typeof postageSettingsRouteInputSchema>

/** Promo codes (W54). The fields create and edit share, each checked by the rule in the old words. */
const promoFieldsShape = {
  code: loose,
  description: loose,
  discountType: loose,
  discountValue: loose,
  appliesTo: loose,
  appliesOnMemberPrices: loose,
  expiresOn: loose,
  maxTotalUses: loose,
  oneUsePerCustomer: loose,
  minSpend: loose,
  restrictedCustomerId: loose,
}
/** `POST promo-codes`: createPromoCode. Answers adminCreatePromoCodeOutputSchema. */
export const promoCreateRouteInputSchema = z.object(promoFieldsShape)
export type PromoCreateRouteInput = z.infer<typeof promoCreateRouteInputSchema>
/** `POST promo-codes/:promoCodeId`: updatePromoCode (every field, and `active`: the page's switch). Answers `updated: true` and the code's row. */
export const promoUpdateRouteInputSchema = z.object({ promoCodeId: z.string(), ...promoFieldsShape, active: loose, stamp: loose })
export type PromoUpdateRouteInput = z.infer<typeof promoUpdateRouteInputSchema>
export const promoUpdateRouteOutputSchema = z.object({ updated: z.literal(true), promo: z.record(z.string(), z.unknown()), stamp: z.string() })
export type PromoUpdateRouteOutput = z.infer<typeof promoUpdateRouteOutputSchema>
/** `GET promo-codes/:promoCodeId/redemptions`: getPromoCodeRedemptions. Answers adminGetPromoCodeRedemptionsOutputSchema. */
export const promoRedemptionsRouteInputSchema = z.object({ promoCodeId: z.string() })
export type PromoRedemptionsRouteInput = z.infer<typeof promoRedemptionsRouteInputSchema>

// ---------------------------------------------------------------------------------------------------------------------
// W54a (W49 + W54 review S1; the lead's call: one step G rule). An edit that writes a whole row, or a whole day's
// rows, is refused `changed_since` when the row has changed since the screen read it. Each read answers a `stamp`
// beside what it shows, the press sends it back (`stamp` on the four route inputs above), and each answer carries
// the row's new stamp, so the screen can save again without reading again. The old functions had no stamp, so these
// are the routes' own answers: W48's contracts above stay as the old functions answered. Kept last, so the staff
// app's generated types keep their order.

/** `GET promo-codes`: getPromoCodes' rows, each with its stamp. */
export const promoListRouteOutputSchema = z.array(adminGetPromoCodesOutputSchema.element.extend({ stamp: z.string() }))
export type PromoListRouteOutput = z.infer<typeof promoListRouteOutputSchema>

/** `POST pricing/band-rules/:dayOfWeek`: setBandRules' answer, with the day's new stamp. */
export const bandRulesRouteOutputSchema = adminSetBandRulesOutputSchema.extend({ stamp: z.string() })
export type BandRulesRouteOutput = z.infer<typeof bandRulesRouteOutputSchema>

/** `POST pricing/member-band-terms`: setMembershipBandTerm's answer, with the term's new stamp. */
export const memberBandTermRouteOutputSchema = adminSetMembershipBandTermOutputSchema.extend({ stamp: z.string() })
export type MemberBandTermRouteOutput = z.infer<typeof memberBandTermRouteOutputSchema>

/** `POST postage/settings`: setPostageSettings' answer, with the settings row's new stamp. */
export const postageSettingsRouteOutputSchema = adminSetPostageSettingsOutputSchema.extend({ stamp: z.string() })
export type PostageSettingsRouteOutput = z.infer<typeof postageSettingsRouteOutputSchema>
