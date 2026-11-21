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

/**
 * W53 (brief item 3; G-plan 4.2, level C): the words for the fulfilled tick's refusals. The old function had no
 * sentence at all (it answered a reason alone for a line that isn't there or isn't a product, and the screen said
 * "Failed to update fulfillment status"), and it checked nothing else, so none of these is an old sentence: they are
 * kept apart from ORDER_ADMIN_WORDS (server/rules/admin/words.test.ts holds that to the old code, both ways), and
 * server/rules/orders/admin.test.ts holds these.
 *  - `lineNotFound` and `notAProductLine` go with the two old reasons, which the staff app's function still answers
 *    as `updated: false` with the reason; the sentence now rides beside it.
 *  - `nothingToFulfil`: a product line that never had a fulfilment state (one written before products were tracked).
 *  - `lineRefunded`: the line has been refunded, so there is nothing left to hand over, or to take back.
 *  - `orderCancelled`: the order's payment failed, so none of it was sold.
 */
export const ORDER_ADMIN_NEW_WORDS = {
  lineNotFound: 'That line is no longer on the order. Reload the page and try again.',
  notAProductLine: "Only a product can be marked fulfilled. This line isn't one.",
  nothingToFulfil: "This line has nothing to hand over, so it can't be marked fulfilled or not fulfilled.",
  lineRefunded: "This line has been refunded, so it can't be marked fulfilled or not fulfilled.",
  orderCancelled: "This order's payment failed, so its items can't be marked fulfilled or not fulfilled.",
  lineChanged: 'The order changed while this was being saved, so nothing was changed. Reload the page and try again.',
} as const

/** The reasons the fulfilled tick refuses with (`details.reason`), by what the staff app's function makes of them. */
export const ORDER_FLAG_REASONS = {
  /** The old function's two: answered as `updated: false` with the reason, as before (now with the words beside it). */
  old: ['not_found', 'not_a_product_line'],
  /** New in W53: answered as `updated: false` with the reason and the words, which the screen shows. */
  refused: ['nothing_to_fulfil', 'line_refunded', 'order_cancelled', 'line_changed'],
} as const

/**
 * W53 (lead call L9; G-plan 2.4, "The store-credit-only own order has `payment_method` null"): how an order was paid,
 * in words, as the order list answers it (`payment_method_label`). One label for each value orders.payment_method can
 * hold (Q9's table). An order with no method recorded reads "Store credit" when store credit paid for it (every
 * store-credit-only order Add Guest wrote before W53, which recorded none), "Nothing to pay" when it cost nothing,
 * and has no label otherwise.
 */
export const ORDER_PAYMENT_METHOD_LABELS = {
  card: 'Card',
  reader: 'Card reader',
  cash: 'Cash',
  gift_card: 'Gift card',
  store_credit: 'Store credit',
  split: 'Split payment',
  nothingToPay: 'Nothing to pay',
} as const
