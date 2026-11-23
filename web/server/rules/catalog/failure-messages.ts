// Brief W48 item 1 (G-plan 4.1): the words of the catalogue: service types and tiers, products, variants and stock,
// add-ons, session passes, gift card types and presets, membership plans and settings (W55 to W57), moved word for
// word from the staff app's old
// functions as they were at W48. Each action that moved (W49 to W57) answers its refusals
// with these, so the screens' handling still works. Generated once by briefs/W48-logs/generate-words-files.py in the
// staff app repo and kept by hand from here on; server/rules/admin/words.test.ts holds this file to the old
// sentences (read from the old code with the TypeScript parser, pinned in testing/old-words.json), both ways. A sentence that takes a value is a
// function of it. Not here, on purpose (the same test holds that they stay out): the plumbing between Retool and
// the legacy routes ("returned an HTML page", "Unauthorized", "Missing required fields", "Internal server
// error", the fallbacks for an error with no words) and "saved but could not be read back", which one transaction
// can't leave. W68 (H3): nor the sentences of the seven legacy /api/catalog routes nothing answers any more; the six
// the Worker still answers ("Item not found", ...) are each with the function that answers it.

export const CATALOG_ADMIN_WORDS = {
  /** toggleItemActive */
  toggleItemActive: {
    itemidRequired: 'itemId is required',
    itemNotFound: 'Item not found',
  },
  /** setServiceTypeCapacityInfo */
  setServiceTypeCapacityInfo: {
    durationMustPositiveWholeNumberMinutes: 'Duration must be a positive whole number of minutes',
    capacityMustPositiveWholeNumber: 'Capacity must be a positive whole number',
    invalidBookingType: (first: unknown): string => `Invalid booking type: ${String(first)}`,
  },
  /** createServiceTypePriceTier */
  createServiceTypePriceTier: {
    servicetypeidRequired: 'serviceTypeId is required',
    minPeopleMustPositiveWholeNumber: 'Min people must be a positive whole number',
    maxPeopleMustPositiveWholeNumber: 'Max people must be a positive whole number',
    minPeopleCannotGreaterThanMax: 'Min people cannot be greater than max people',
  },
  /** setServiceTypePriceTierRange */
  setServiceTypePriceTierRange: {
    minPeopleMustPositiveWholeNumber: 'Min people must be a positive whole number',
    maxPeopleMustPositiveWholeNumber: 'Max people must be a positive whole number',
    minPeopleCannotGreaterThanMax: 'Min people cannot be greater than max people',
  },
  /** updateTierPrice */
  updateTierPrice: {
    tieridRequired: 'tierId is required',
    priceMustNonNegativeNumber: 'price must be a non-negative number',
    tierNotFound: 'Tier not found',
  },
  /** setProductFulfillmentMethod */
  setProductFulfillmentMethod: {
    invalidFulfillmentMethod: (first: unknown): string => `Invalid fulfillment method: ${String(first)}`,
  },
  /** createProductVariant */
  createProductVariant: {
    productidSizeAndSkuAreRequired: 'productId, size, and sku are required',
    productNotFound: 'Product not found',
    stockquantityMustNonNegativeWholeNumber: 'stockQuantity must be a non-negative whole number',
  },
  /** adjustVariantStock */
  adjustVariantStock: {
    variantidRequired: 'variantId is required',
    changeamountMustNonZeroWholeNumber: 'changeAmount must be a non-zero whole number',
    invalidReasonCategory: (first: unknown): string => `Invalid reason category: ${String(first)}`,
    noteRequiredWhenReasonOther: 'A note is required when the reason is "Other"',
    variantNotFound: 'Variant not found',
    adjustmentWouldBringStockBelowZero: (first: unknown, second: unknown): string => `This adjustment would bring stock below zero (current stock: ${String(first)}, change: ${String(second)}).`,
    stockChangedConcurrentlyAndAdjustmentWould: 'Stock changed concurrently and this adjustment would now bring it below zero — please retry.',
  },
  /** getStockAdjustments */
  getStockAdjustments: {
    variantidRequired: 'variantId is required',
  },
  /** updateCatalogItemPrice */
  updateCatalogItemPrice: {
    itemidRequired: 'itemId is required',
    itemNotFound: 'Item not found',
    atLeastOnePriceFieldMust: 'At least one price field must be provided',
    mustNonNegativeNumber: (first: unknown): string => `${String(first)} must be a non-negative number`,
  },
  /** createGiftCardPreset */
  createGiftCardPreset: {
    giftcardtypeidRequired: 'giftCardTypeId is required',
    giftCardTypeNotFound: 'Gift card type not found',
    amountMustPositiveNumber: 'amount must be a positive number',
  },
  /** updateGiftCardPresetPrice */
  updateGiftCardPresetPrice: {
    presetidRequired: 'presetId is required',
    presetNotFound: 'Preset not found',
    amountMustPositiveNumber: 'amount must be a positive number',
  },
  /** setGiftCardTypeCustomAmountSettings */
  setGiftCardTypeCustomAmountSettings: {
    giftcardtypeidRequired: 'giftCardTypeId is required',
    customamountminMustNonNegativeNumberWhen: 'customAmountMin must be a non-negative number when custom amounts are enabled',
    customamountmaxMustPositiveNumberWhenCustom: 'customAmountMax must be a positive number when custom amounts are enabled',
    customamountminCannotGreaterThanCustomamountmax: 'customAmountMin cannot be greater than customAmountMax',
  },
  /** createMembershipPlan */
  createMembershipPlan: {
    nameRequired: 'Name is required',
    levelMustEitherCoreOrAll: 'Level must be either "core" or "all_access"',
    sessionsIncludedMustNonNegativeWhole: 'Sessions included must be a non-negative whole number',
    sessionsIncludedMustPositiveWholeNumber: 'Sessions included must be a positive whole number for non-unlimited plans',
    addOnsIncludedMustNonNegative: 'Add-ons included must be a non-negative whole number',
    isunlimitedMustTrueOrFalse: 'isUnlimited must be true or false',
    atLeastOnePriceMustProvided: 'At least one price must be provided',
    monthlyPriceMustNonNegativeNumber: 'Monthly price must be a non-negative number',
    yearlyPriceMustNonNegativeNumber: 'Yearly price must be a non-negative number',
  },
  /** setMembershipPlanDetails */
  setMembershipPlanDetails: {
    nameRequired: 'Name is required',
    levelMustEitherCoreOrAll: 'Level must be either "core" or "all_access"',
    sessionsIncludedMustNonNegativeWhole: 'Sessions included must be a non-negative whole number',
    sessionsIncludedMustPositiveWholeNumber: 'Sessions included must be a positive whole number for non-unlimited plans',
    addOnsIncludedMustNonNegative: 'Add-ons included must be a non-negative whole number',
    monthlyPriceMustNonNegativeNumber: 'Monthly price must be a non-negative number',
    yearlyPriceMustNonNegativeNumber: 'Yearly price must be a non-negative number',
    membershipPlanNotFound: 'Membership plan not found',
  },
  /** setMembershipSettings */
  setMembershipSettings: {
    waitingPeriodMustWholeNumberMonths: 'The waiting period must be a whole number of months between 0 and 60.',
    membershipSettingsRowMissingInsertIt: 'The membership_settings row is missing — insert it (id = true) before editing the setting.',
  },
} as const

/** The price move's own failure for one member (lib/membership-price-migration.ts, removed at W61), which the legacy route listed and the plan function drops (GB1). */
export const PLAN_PRICE_MOVE_WORDS = {
  expectedOneSubscriptionItem: (first: unknown): string => `Expected one subscription item, found ${String(first)}.`,
} as const

/** The reasons each old function's own result type names, in its order. */
export const CATALOG_ADMIN_REASONS = {
  setSessionPassLevel: ['no_pricing_permission', 'invalid_level', 'pass_type_not_found'],
} as const

/**
 * The dialogs' own sentences for the refusals above that the old function answers with a reason and no words: what
 * staff read today, so what the Worker's refusal carries.
 */
export const CATALOG_ADMIN_DIALOG_WORDS = {
  EditSessionPassTypeDialog: {
    no_pricing_permission: 'Needs the Manage pricing permission to change the pass level.',
    invalid_level: 'Choose Core or All-Access.',
    pass_type_not_found: 'This pass type no longer exists.',
  },
} as const
