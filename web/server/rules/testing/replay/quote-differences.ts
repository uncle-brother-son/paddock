import type { AllowedDifference } from './compare'

/**
 * Where the basket quote may differ from what the old createOrder writes. Every entry names the
 * decision in W03-decisions.md that allows it: anything else fails quote-shadow.test.ts, and so does
 * an entry that stops happening. Paths are stableDiff's, under `figures`.
 */
const firstInvoice = /^figures\.firstInvoice$/

export const QUOTE_DIFFERENCES: Record<string, readonly AllowedDifference[]> = {
  'q1-postage-before-the-spill': [
    { name: 'Postage is paid before credit spills onto the membership, so the first invoice is higher', decision: 'W03-decisions Q1', path: firstInvoice },
  ],
  'q2-standalone-addon-before-the-spill': [
    { name: 'A standalone add-on is paid before credit spills onto the membership', decision: 'W03-decisions Q2', path: firstInvoice },
  ],
  'q3-buy-new-membership-with-a-pass': [
    { name: 'The pass gets its line, which the old order never wrote', decision: 'W03-decisions Q3', path: /^figures\.lines\./ },
  ],
  'q3-buy-new-pass-with-a-membership': [
    { name: 'The membership gets its line, which the old order never wrote', decision: 'W03-decisions Q3', path: /^figures\.lines\./ },
    { name: 'The membership gets its first invoice, which the old order never raised', decision: 'W03-decisions Q3', path: firstInvoice },
  ],
  'q3-reader-buy-new-membership-with-a-pass': [
    { name: 'The pass gets its line, which the old order never wrote, on the reader too', decision: 'W03-decisions Q3', path: /^figures\.lines\./ },
  ],
  'q3-reader-buy-new-pass-with-a-membership': [
    { name: 'The membership gets its line, which the old order never wrote, on the reader too', decision: 'W03-decisions Q3', path: /^figures\.lines\./ },
  ],
  'q4-shipped-gift-card-earns-free-postage': [
    { name: 'No postage on the order total', decision: 'W03-decisions Q4', path: /^figures\.orderTotal$/ },
    { name: 'No postage on the postage line', decision: 'W03-decisions Q4', path: /^figures\.lines\.1\.(unitPrice|lineTotal)$/ },
    { name: 'No postage in what is collected', decision: 'W03-decisions Q4', path: /^figures\.collected$/ },
  ],
  'q5-buy-new-keeps-address-and-requests': [
    { name: 'The delivery address is kept', decision: 'W03-decisions Q5', path: /^figures\.hasShippingAddress$/ },
    { name: 'The special requests are kept', decision: 'W03-decisions Q5', path: /^figures\.booking\.hasSpecialRequests$/ },
  ],
}

/**
 * Q6 keeps the server's rule, so the quote matches what the order writes. The difference is with the
 * old screen's preview, which left a buy-new booking's seats out of the promo.
 */
export const SCREEN_DIFFERENCE: AllowedDifference = {
  name: "The quote shows the promo on a buy-new booking's paid seats, which the old screen left out",
  decision: 'W03-decisions Q6',
  path: /^promoDiscount$/,
}
