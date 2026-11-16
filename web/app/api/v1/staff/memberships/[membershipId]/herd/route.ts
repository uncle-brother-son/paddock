import { setMembershipHerdOutputSchema, setMembershipHerdRouteInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { setMembershipHerd } from '@/server/rules/memberships/credits'

/**
 * W37 (F-plan 4.5; bug FB11; lead call L13): setMembershipHerd. true or false sets the override and the flag; null
 * clears the override and applies the automatic rule to this membership. One transaction under the membership's lock,
 * with a `membership.herd_set` audit row (who, and before and after). Issue refunds, refused by the rule in the old
 * words. No Stripe, so no switch kind. Idempotent: the same press key gets the first press's answer.
 */
export const POST = defineRoute(
  { auth: 'staff', input: setMembershipHerdRouteInputSchema, output: setMembershipHerdOutputSchema, idempotent: true },
  async ({ db, input, staff, requestId }) => setMembershipHerd(db, input.membershipId, input.herd, { actor: { type: 'staff', id: staff.id, canIssueRefunds: staff.canIssueRefunds }, requestId })
)
