import { membershipCancelOutputSchema, membershipCancelRouteInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { cancelMembership } from '@/server/rules/memberships/cancel'
import { membershipChangePathOff } from '@/server/rules/memberships/membership-switch'
import { createStripeClient, ORDER_STRIPE_LIMITS } from '@/server/stripe/client'

/**
 * W40 (F-plan 4.3; bugs FB5, FB6, FB20, FB22; Q33): setMembershipCancellation, cancel: true. M1 in one transaction
 * under the membership's lock (found, active, no cancel scheduled, no payment date change in progress, a next renewal
 * date; the end date, clamped; cancel_effective_date; the audit row; the Stripe step left), then Stripe's `cancel_at`
 * with `proration_behavior: 'none'` on the membership's own subscription: done, refused (M1 put back, Stripe's reason)
 * or left for the automatic check (server/rules/memberships/cancel.ts, left.ts). Issue refunds, checked by the rule
 * from the signed-in staff member, in the old words. Gated by the switch (`membership_changes`): off, nothing is read.
 * Idempotent: the same press key gets the first press's answer.
 */
export const POST = defineRoute(
  { auth: 'staff', input: membershipCancelRouteInputSchema, output: membershipCancelOutputSchema, idempotent: true },
  async ({ db, input, staff, requestId, startedAt }) => {
    const off = membershipChangePathOff(process.env.ORDER_SWITCH)
    if (off) throw off
    return cancelMembership(db, input.membershipId, {
      actor: { channel: 'staff', id: staff.id, canIssueRefunds: staff.canIssueRefunds },
      requestId,
      startedAt,
      stripe: () => createStripeClient(undefined, ORDER_STRIPE_LIMITS),
    })
  }
)
