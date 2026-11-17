import { membershipListInputSchema, membershipListOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { listMemberships } from '@/server/rules/memberships/list'

/**
 * W40 (F-plan 4.3; W35 row 10): getSubscriptions, the Subscriptions page's list: the newest 200 memberships with
 * their customer and plan, each with why "Change payment date" is refused and whether its order line was refunded
 * (`refunded`); `search` matches the customer or the plan. Named fields, from the same code as the profile's
 * membership rows (server/rules/memberships/list.ts). Any active staff member (FB16: the old read checked nobody).
 */
export const GET = defineRoute({ auth: 'staff', input: membershipListInputSchema, output: membershipListOutputSchema }, async ({ db, input }) => listMemberships(db, input))
