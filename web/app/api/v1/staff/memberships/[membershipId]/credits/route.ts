import { adjustMembershipCreditsOutputSchema, adjustMembershipCreditsRouteInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adjustMembershipCredits } from '@/server/rules/memberships/credits'

/**
 * W37 (F-plan 4.5; bugs FB7 to FB10): adjustMembershipCredits. Session credits move the current period's allocation
 * from what is there, never below what is used; add-on credits never below zero; a reason is required. One
 * transaction under the credit period's and the membership's locks, with the adjustment row and its
 * `membership.credits_adjusted` audit row. Issue refunds, refused by the rule in the old words (`permission_denied`).
 * No Stripe, so no switch kind (lead call L3). Idempotent: the same press key gets the first press's answer.
 */
export const POST = defineRoute(
  { auth: 'staff', input: adjustMembershipCreditsRouteInputSchema, output: adjustMembershipCreditsOutputSchema, idempotent: true },
  async ({ db, input, staff, requestId }) => {
    const { membershipId, ...body } = input
    return adjustMembershipCredits(db, membershipId, body, { actor: { type: 'staff', id: staff.id, canIssueRefunds: staff.canIssueRefunds }, requestId })
  }
)
