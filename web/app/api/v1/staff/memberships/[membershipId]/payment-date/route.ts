import { changePaymentDateOutputSchema, changePaymentDateRouteInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { paymentDatePathOff } from '@/server/rules/memberships/membership-switch'
import { changePaymentDate } from '@/server/rules/memberships/payment-date'
import { createStripeClient, ORDER_STRIPE_LIMITS } from '@/server/stripe/client'

/**
 * W41 (F-plan 4.4; bugs FB1 to FB4, FB20; Q10 / lead call L8; Q18): changeMembershipPaymentDate. P1 in one transaction
 * under the customer's lock and then the membership's (every old refusal in the old order, the window, the six-month
 * rule, Q10, the confirmed figure, the pending record and its audit row), then Stripe: the subscription read, the saved
 * card charged once under a key from the record, the billing date moved, and P2 (the order, the membership's new date,
 * the record done) in one transaction; a refused move refunds the charge once, watched
 * (server/rules/memberships/payment-date.ts). No clear answer leaves the record pending for the automatic check and
 * answers PAYMENT_UNCONFIRMED: the card is never charged again. Issue refunds, checked by the rule from the signed-in
 * staff member, in the old words. Gated by its own switch kind (W41a: `payment_date_changes`, never
 * `membership_changes`): off, nothing is read. Idempotent: the same press key gets the first press's answer.
 */
export const POST = defineRoute(
  { auth: 'staff', input: changePaymentDateRouteInputSchema, output: changePaymentDateOutputSchema, idempotent: true },
  async ({ db, input, staff, requestId, startedAt }) => {
    const off = paymentDatePathOff(process.env.ORDER_SWITCH)
    if (off) throw off
    const { membershipId, ...change } = input
    return changePaymentDate(db, membershipId, change, {
      actor: { type: 'staff', id: staff.id, canIssueRefunds: staff.canIssueRefunds },
      requestId,
      startedAt,
      stripe: () => createStripeClient(undefined, ORDER_STRIPE_LIMITS),
    })
  }
)
