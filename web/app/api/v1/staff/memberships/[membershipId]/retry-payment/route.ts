import { retryPaymentOutputSchema, retryPaymentRouteInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { paymentRetryPathOff } from '@/server/rules/memberships/membership-switch'
import { retryPayment } from '@/server/rules/memberships/retry-payment'
import { createStripeClient, ORDER_STRIPE_LIMITS } from '@/server/stripe/client'

/**
 * W47r ("Try the payment again now"; the W47 review's point 10): a past-due membership's open renewal invoice paid
 * from the desk on the customer's saved card (server/rules/memberships/retry-payment.ts). The row's own refusals;
 * Stripe's subscription and its newest invoice read now; then one transaction under the customer's lock and the
 * membership's (the card, taking turns, the amount the window showed, the `started` record); then ONE `invoices.pay`
 * naming the card, under a key from the record. Paid: the route runs the webhook's own `invoice.paid` write, so the
 * member's flagged bookings are confirmed at once. Declined: nothing is written to the membership. No clear answer:
 * PAYMENT_UNCONFIRMED, the record held for the automatic check, which only reads. Issue refunds, checked by the rule
 * from the signed-in staff member. Gated by its own switch kind (`payment_retries`): off, nothing is read.
 * Idempotent: the same press key gets the first press's answer. The client is the order's (10 seconds a call, no
 * retries by the SDK), so nothing is sent a second time behind the rule's back.
 */
export const POST = defineRoute(
  { auth: 'staff', input: retryPaymentRouteInputSchema, output: retryPaymentOutputSchema, idempotent: true },
  async ({ db, input, staff, requestId, startedAt }) => {
    const off = paymentRetryPathOff(process.env.ORDER_SWITCH)
    if (off) throw off
    const { membershipId, ...press } = input
    return retryPayment(db, membershipId, press, {
      actor: { type: 'staff', id: staff.id, canIssueRefunds: staff.canIssueRefunds },
      requestId,
      startedAt,
      stripe: () => createStripeClient(undefined, ORDER_STRIPE_LIMITS),
    })
  }
)
