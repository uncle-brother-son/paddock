import { z } from 'zod'

// --- W47r ("Try the payment again now"; Wayne, 18 Nov 2026; the W47 review's point 10): a past-due member's failed
// renewal, charged from the desk.
//
//   GET  /api/v1/staff/memberships/:membershipId/retry-payment/quote   what the window shows (read only)
//   POST /api/v1/staff/memberships/:membershipId/retry-payment         the press (Issue refunds; its own kind, `payment_retries`)
//
// In a file of its own, exported last from index.ts, so the types printed for the staff app (workerContracts.ts) only
// gain these.

const membershipInPath = { membershipId: z.guid() }

export const retryPaymentQuoteInputSchema = z.object({})
export type RetryPaymentQuoteInput = z.infer<typeof retryPaymentQuoteInputSchema>
export const retryPaymentQuoteRouteInputSchema = retryPaymentQuoteInputSchema.extend(membershipInPath)

/**
 * What the window shows before the press: the amount still to pay on the subscription's newest invoice as Stripe has
 * it now, the card that would be charged (the customer's saved card), and what a payment does for the membership's
 * bookings. `refusal`: why the payment can't be tried, in staff's words, or null. Read only: nothing is written and
 * nothing is sent to Stripe but reads.
 */
export const retryPaymentQuoteOutputSchema = z.object({
  membershipId: z.string(),
  customerId: z.string(),
  customerName: z.string(),
  planName: z.string().nullable(),
  /** Why "Try the payment again now" is refused right now (null: it can be pressed). */
  refusal: z.string().nullable(),
  /** The refusal's reason, for tests and support; null with no refusal. */
  reason: z.string().nullable(),
  /**
   * Stripe shows the payment has already gone through (one of its own retries got there first) and the membership
   * here hasn't caught up. The press then takes nothing: it only brings the membership up to date.
   */
  alreadyPaid: z.boolean(),
  /** The invoice the press would pay (or, `alreadyPaid`, the one Stripe shows paid); null when refused before it was read. */
  invoiceId: z.string().nullable(),
  /** Pounds still to pay on it; 0 when `alreadyPaid`; null when refused before it was read. */
  amount: z.number().nullable(),
  cardBrand: z.string().nullable(),
  cardLast4: z.string().nullable(),
  /**
   * W47r-a (the W47r review's S3): the card those are, as Stripe names it (the customer's saved payment method). The
   * window sends it back in `confirmed`, and the Worker charges nothing if it is no longer the saved card. Null when
   * the customer has none.
   */
  paymentMethodId: z.string().nullable(),
  /** The membership's credit bookings waiting for payment (Payment needed) right now. */
  bookingsWaiting: z.number(),
  /** What happens to those bookings if the payment goes through, in staff's words. */
  ifPaid: z.string(),
})
export type RetryPaymentQuoteOutput = z.infer<typeof retryPaymentQuoteOutputSchema>

/**
 * The press. `confirmed` is what the window showed (Q18's rule, as the payment date change's): the invoice, the
 * amount in pounds and (W47r-a) the card, as the quote's `paymentMethodId`. The Worker charges nothing if the invoice
 * or the amount is no longer what Stripe shows, or the card is no longer the customer's saved card. Loose, so a press
 * without any of them is refused in the rule's own words.
 */
export const retryPaymentInputSchema = z.object({
  confirmed: z.object({ invoiceId: z.string().nullish(), amount: z.number().nullish(), paymentMethodId: z.string().nullish() }).optional(),
})
export type RetryPaymentInput = z.infer<typeof retryPaymentInputSchema>
export const retryPaymentRouteInputSchema = retryPaymentInputSchema.extend(membershipInPath)

/**
 * A payment that went through (or that Stripe showed had already gone through). A decline, a refusal and a payment
 * with no clear answer are errors: PAYMENT_FAILED, CONFLICT and PAYMENT_UNCONFIRMED, each with `retryPaymentRefusalDetailsSchema`.
 */
export const retryPaymentOutputSchema = z.object({
  /** The retry's record; null when nothing was sent because Stripe already showed the invoice paid. */
  retryId: z.string().nullable(),
  invoiceId: z.string(),
  /** Pounds this press took on the card; 0 when Stripe already showed the invoice paid. */
  amountCharged: z.number(),
  /** Stripe showed the invoice already paid (its own retry got there first): this press took nothing. */
  alreadyPaid: z.boolean(),
  cardBrand: z.string().nullable(),
  cardLast4: z.string().nullable(),
  /** The membership was marked paid here, by the same write Stripe's own notice makes. False: `message` says why not. */
  membershipUpdated: z.boolean(),
  /** Credit bookings put back from Payment needed to confirmed by that write. */
  bookingsRestored: z.number(),
  /** Credit bookings of the membership still waiting for payment afterwards. */
  bookingsWaiting: z.number(),
  /** The membership's status and next payment date afterwards, as the database has them. */
  subscriptionStatus: z.string().nullable(),
  nextRenewalDate: z.string().nullable(),
  /** The result in staff's words. */
  message: z.string(),
})
export type RetryPaymentOutput = z.infer<typeof retryPaymentOutputSchema>

/**
 * The `details` of every retry refusal: its reason and the words staff see. `held`: the record of a payment with no
 * clear answer, which the automatic check settles (never press again for it). `amountNow`: the amount Stripe shows
 * now, when it is no longer the one the window showed. `kinds`: the switch kinds that are off for MEMBERSHIP_PATH_OFF.
 */
export const retryPaymentRefusalDetailsSchema = z.object({
  reason: z.string(),
  message: z.string(),
  action: z.enum(['payment_retry_quote', 'payment_retry']),
  held: z.object({ retryId: z.string() }).optional(),
  amountNow: z.number().optional(),
  kinds: z.array(z.string()).optional(),
})
export type RetryPaymentRefusalDetails = z.infer<typeof retryPaymentRefusalDetailsSchema>
