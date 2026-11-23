// Brief W48 item 1 (G-plan 4.1): the words of pricing: band prices, band windows, member band terms and postage (W54),
// moved word for word from the staff app's old
// functions as they were at W48. Each action that moved (W49 to W57) answers its refusals
// with these, so the screens' handling still works. Generated once by briefs/W48-logs/generate-words-files.py in the
// staff app repo and kept by hand from here on; server/rules/admin/words.test.ts holds this file to the old
// sentences (read from the old code with the TypeScript parser, pinned in testing/old-words.json), both ways. A sentence that takes a value is a
// function of it. Not here, on purpose (the same test holds that they stay out): the plumbing between Retool and
// the legacy routes ("returned an HTML page", "Unauthorized", "Missing required fields", "Internal server
// error", the fallbacks for an error with no words) and "saved but could not be read back", which one transaction
// can't leave.

export const PRICING_ADMIN_WORDS = {
  /** setBandPrice */
  setBandPrice: {
    priceMustValidNonNegativeAmount: 'Price must be a valid non-negative amount.',
  },
  /** setBandRules */
  setBandRules: {
    dayWeekMustWholeNumberFrom: 'Day of week must be a whole number from 0 (Sunday) to 6 (Saturday).',
    atLeastOneBandWindowRequired: 'At least one band window is required — the day must be fully covered.',
    windowTimesMustValidHhMm: 'Window times must be valid HH:MM times.',
    eachWindowMustEndAfterIt: 'Each window must end after it starts.',
    windowTimesMustFallWithinDay: 'Window times must fall within the day (00:00–24:00).',
    firstWindowMustStartAt00: 'The first window must start at 00:00 — the day must be fully covered.',
    windowsHaveGapOrOverlapEvery: 'The windows have a gap or overlap — every minute of the day must belong to exactly one band.',
    lastWindowMustEndAt24: 'The last window must end at 24:00 — the day must be fully covered.',
    oneSelectedBandsNoLongerExists: 'One of the selected bands no longer exists.',
  },
  /** setMembershipBandTerm */
  setMembershipBandTerm: {
    membershipLevelRequired: 'Membership level is required.',
    discountPercentMustBetween0And: 'Discount percent must be between 0 and 100.',
  },
  /** setPostageSettings */
  setPostageSettings: {
    standardPriceMustNonNegativeNumber: 'Standard price must be a non-negative number.',
    expressPriceMustNonNegativeNumber: 'Express price must be a non-negative number.',
    freeShippingThresholdMustNonNegative: 'Free-shipping threshold must be a non-negative number (0 = no free shipping).',
    postageSettingsHaveNotBeenConfigured: 'Postage settings have not been configured yet. Run the postage_settings migration (CREATE TABLE + seed row) to set them up.',
  },
} as const

/**
 * W54 (brief item 11; W48 call 9 and "For the Worker step" 8): the words for refusals that had none. Not old
 * sentences, so they are kept apart from PRICING_ADMIN_WORDS (server/rules/admin/words.test.ts holds that file to
 * the old code, both ways); server/rules/pricing/admin.test.ts holds these.
 *  - `bandNoLongerExists`: setBandPrice answered `updated: false` with no words for a band that isn't there, and the
 *    Pricing page showed nothing at all; setMembershipBandTerm showed the database's own foreign key error.
 *  - `membershipLevelNotOne`: setMembershipBandTerm showed the database's own check error for a level that isn't one
 *    of the two (the screen can't send one).
 */
export const PRICING_ADMIN_NEW_WORDS = {
  bandNoLongerExists: 'That band no longer exists. Reload the page and try again.',
  membershipLevelNotOne: 'Membership level must be Core or All-Access.',
} as const
