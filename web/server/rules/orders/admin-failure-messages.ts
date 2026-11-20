// Brief W48 item 1 (G-plan 4.1): the words of orders: a product line marked fulfilled (W53), moved word for word from
// the staff app's old
// functions as frozen at W48 (testing/legacy-admin). Unused yet: each slice that moves an action answers its refusals
// with these, so the screens' handling still works. Generated once by briefs/W48-logs/generate-words-files.py in the
// staff app repo and kept by hand from here on; server/rules/admin/words.test.ts reads the old sentences from the
// frozen copy with the TypeScript parser and holds this file to them, both ways. A sentence that takes a value is a
// function of it. Not here, on purpose (the same test holds that they stay out): the plumbing between Retool and
// the legacy routes ("returned an HTML page", "Unauthorized", "Missing required fields", "Internal server
// error", the fallbacks for an error with no words) and "saved but could not be read back", which one transaction
// can't leave.

export const ORDER_ADMIN_WORDS = {
} as const

/** The reasons each old function's own result type names, in its order. */
export const ORDER_ADMIN_REASONS = {
  setOrderLineItemFulfilled: ['not_found', 'not_a_product_line'],
} as const
