// Brief W48 item 1 (G-plan 4.1): the words of promo codes: create and edit (W54), moved word for word from the staff
// app's old
// functions as they were at W48. Each action that moved (W49 to W57) answers its refusals
// with these, so the screens' handling still works. Generated once by briefs/W48-logs/generate-words-files.py in the
// staff app repo and kept by hand from here on; server/rules/admin/words.test.ts holds this file to the old
// sentences (read from the old code with the TypeScript parser, pinned in testing/old-words.json), both ways. A sentence that takes a value is a
// function of it. Not here, on purpose (the same test holds that they stay out): the plumbing between Retool and
// the legacy routes ("returned an HTML page", "Unauthorized", "Missing required fields", "Internal server
// error", the fallbacks for an error with no words) and "saved but could not be read back", which one transaction
// can't leave.

export const PROMO_ADMIN_WORDS = {
  /** promoCodes */
  promoCodes: {
    codeMust420CharactersUsing: 'The code must be 4–20 characters using only letters, numbers and dashes (stored upper-cased).',
    discountTypeMustPercentageOrFixed: 'Discount type must be "percentage" or "fixed".',
    discountValueMustGreaterThan0: 'The discount value must be greater than 0.',
    percentageDiscountCannotExceed100: 'A percentage discount cannot exceed 100%.',
    chooseAtLeastOneValidBasket: 'Choose at least one valid basket part this code applies to (booking, add-on, product, session pass, membership).',
    expiryMustDateYyyyMmDd: 'The expiry must be a date (YYYY-MM-DD) or empty.',
    maximumTotalUsesMustWholeNumber: 'Maximum total uses must be a whole number of at least 1, or empty for unlimited.',
    minimumSpendMustNonNegativeAmount: 'Minimum spend must be a non-negative amount, or empty for none.',
  },
  /** createPromoCode */
  createPromoCode: {
    restrictedCustomerDoesNotExist: 'The restricted customer does not exist.',
    promoCodeAlreadyExistsCodesAre: (first: unknown): string => `A promo code "${String(first)}" already exists (codes are unique, case-insensitive).`,
  },
  /** updatePromoCode */
  updatePromoCode: {
    thatPromoCodeNoLongerExists: 'That promo code no longer exists.',
    codeHasBeenRedeemedAtLeast: 'This code has been redeemed at least once — its text can no longer be changed. Deactivate it and create a new code instead.',
    restrictedCustomerDoesNotExist: 'The restricted customer does not exist.',
    promoCodeAlreadyExistsCodesAre: (first: unknown): string => `A promo code "${String(first)}" already exists (codes are unique, case-insensitive).`,
  },
} as const

/** The reasons each old function's own result type names, in its order. */
export const PROMO_ADMIN_REASONS = {
  updatePromoCode: ['not_found', 'code_locked'],
} as const
