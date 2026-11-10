import { z } from 'zod'

/**
 * W11: the card reader's set-up and saving a card, ported from the staff app's
 * getTerminalConnectionToken, createTerminalSetupIntent and saveCustomerCardOnFile with their
 * answers' shapes, so the staff app's functions stay thin. Input is loose where the old function
 * answered for itself, so its own words come back instead of zod's.
 */

// --- POST /api/v1/staff/terminal/connection-token

export const terminalConnectionTokenInputSchema = z.object({
  /** Only for a second location one day; the club's one Terminal location otherwise. */
  locationId: z.string().optional(),
})
export type TerminalConnectionTokenInput = z.infer<typeof terminalConnectionTokenInputSchema>

export const terminalConnectionTokenOutputSchema = z.object({ secret: z.string() })
export type TerminalConnectionTokenOutput = z.infer<typeof terminalConnectionTokenOutputSchema>

// --- POST /api/v1/staff/terminal/setup-intents

export const terminalSetupIntentInputSchema = z.object({ customerId: z.string().optional() })
export type TerminalSetupIntentInput = z.infer<typeof terminalSetupIntentInputSchema>

/** What the reader collects a card against, with no charge. */
export const terminalSetupIntentOutputSchema = z.object({
  clientSecret: z.string(),
  setupIntentId: z.string(),
  stripeCustomerId: z.string(),
})
export type TerminalSetupIntentOutput = z.infer<typeof terminalSetupIntentOutputSchema>

// --- POST /api/v1/staff/customers/:customerId/saved-card

/** Exactly one of the two: a reader charge with "save card" ticked, or a card-save with no charge. */
export const saveCustomerCardInputSchema = z.object({
  customerId: z.string(),
  paymentIntentId: z.string().optional(),
  setupIntentId: z.string().optional(),
})
export type SaveCustomerCardInput = z.infer<typeof saveCustomerCardInputSchema>

/** The customer's card as saved (saveCustomerCardOnFile's answer). */
export const saveCustomerCardOutputSchema = z.object({
  id: z.string(),
  stripe_customer_id: z.string().nullable(),
  saved_payment_method_id: z.string().nullable(),
  saved_card_last4: z.string().nullable(),
  saved_card_brand: z.string().nullable(),
})
export type SaveCustomerCardOutput = z.infer<typeof saveCustomerCardOutputSchema>
