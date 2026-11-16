import { membershipCreditAdjustmentsInputSchema, membershipCreditAdjustmentsOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { listCreditAdjustments } from '@/server/rules/memberships/credits'

/**
 * W37 (F-plan 4.5): getMembershipCreditAdjustments, the history the Credits dialog lists: every adjustment of the
 * membership, newest first, with who made it. Any active staff member (FB16: the old read checked nobody).
 */
export const GET = defineRoute(
  { auth: 'staff', input: membershipCreditAdjustmentsInputSchema, output: membershipCreditAdjustmentsOutputSchema },
  async ({ db, input }) => listCreditAdjustments(db, input.membershipId)
)
