import { z } from 'zod'

export const staffRoleSchema = z.enum(['admin', 'manager', 'staff'])
export type StaffRole = z.infer<typeof staffRoleSchema>

/** The acting staff member, as established by staff auth on every /api/v1/staff request. */
export const staffContextSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: staffRoleSchema,
  canIssueRefunds: z.boolean(),
  canManagePricing: z.boolean(),
})
export type StaffContext = z.infer<typeof staffContextSchema>

/** For endpoints that take no input. */
export const emptyInputSchema = z.object({})
export type EmptyInput = z.infer<typeof emptyInputSchema>

/** GET /api/v1/staff/health */
export const staffHealthOutputSchema = z.object({
  database: z.literal('ok'),
  /** The deployed Worker version id, or "dev" when running locally. */
  version: z.string(),
})
export type StaffHealthOutput = z.infer<typeof staffHealthOutputSchema>

/** GET /api/v1/staff/whoami */
export const staffWhoamiOutputSchema = staffContextSchema
export type StaffWhoamiOutput = z.infer<typeof staffWhoamiOutputSchema>

/**
 * GET /api/v1/staff/payments/refunds: one PaymentIntent's refunds, newest first, each with the
 * Stripe key it was sent with. Stripe forgets a key after 24 hours, but the refund keeps it in its
 * metadata, so a refund with no clear answer can be found later without sending it again.
 */
export const paymentIntentRefundsInputSchema = z.object({
  paymentIntentId: z.string().regex(/^pi_[A-Za-z0-9_]+$/, 'A PaymentIntent id starts pi_.'),
})
export type PaymentIntentRefundsInput = z.infer<typeof paymentIntentRefundsInputSchema>

export const paymentIntentRefundSchema = z.object({
  id: z.string(),
  /** Pounds. */
  amount: z.number(),
  /** Stripe's status: succeeded, pending, requires_action, failed or canceled. */
  status: z.string(),
  /** The key it was sent with, or null for a refund made without one (or in Stripe by hand). */
  key: z.string().nullable(),
  createdAt: z.string(),
})
export type PaymentIntentRefund = z.infer<typeof paymentIntentRefundSchema>

export const paymentIntentRefundsOutputSchema = z.object({ refunds: z.array(paymentIntentRefundSchema) })
export type PaymentIntentRefundsOutput = z.infer<typeof paymentIntentRefundsOutputSchema>
