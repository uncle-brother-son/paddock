import { retryPaymentQuoteOutputSchema, retryPaymentQuoteRouteInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { paymentRetryPathOff } from '@/server/rules/memberships/membership-switch'
import { retryPaymentQuote } from '@/server/rules/memberships/retry-payment'
import { createStripeClient, ORDER_STRIPE_LIMITS } from '@/server/stripe/client'

/**
 * W47r: what the "Try the payment again now" window shows before the press: the amount still to pay on the
 * subscription's newest invoice as Stripe has it now, the card that would be charged, what a payment does for the
 * membership's bookings waiting for payment, or why the payment can't be tried
 * (server/rules/memberships/retry-payment.ts). Read only: two reads of Stripe, nothing sent and nothing written. Any
 * active staff member (the press needs Issue refunds). It asks the press's own switch kind (`payment_retries`), so
 * with the kind off the window says so at once and Stripe isn't read. No such membership is NOT_FOUND.
 */
export const GET = defineRoute({ auth: 'staff', input: retryPaymentQuoteRouteInputSchema, output: retryPaymentQuoteOutputSchema }, async ({ db, input, startedAt }) => {
  const off = paymentRetryPathOff(process.env.ORDER_SWITCH)
  if (off) throw off
  return retryPaymentQuote(db, input.membershipId, { startedAt, stripe: () => createStripeClient(undefined, ORDER_STRIPE_LIMITS) })
})
