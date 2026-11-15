import { paymentIntentRefundsInputSchema, paymentIntentRefundsOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { listPaymentIntentRefunds } from '@/server/rules/payments/payment-intent-refunds'
import { createStripeClient, READ_STRIPE_LIMITS } from '@/server/stripe/client'

/**
 * Read-only, so not idempotent and no audit row. Any active staff member: settling an earlier refund
 * with no clear answer runs on any press, and this only reads what Stripe already did. With read
 * limits of its own (W10a), so Retool isn't left waiting on the SDK's defaults.
 */
export const GET = defineRoute({ auth: 'staff', input: paymentIntentRefundsInputSchema, output: paymentIntentRefundsOutputSchema }, async ({ input }) =>
  listPaymentIntentRefunds(createStripeClient(undefined, READ_STRIPE_LIMITS), input.paymentIntentId)
)
