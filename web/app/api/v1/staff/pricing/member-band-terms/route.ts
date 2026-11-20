import { memberBandTermRouteInputSchema, memberBandTermRouteOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { setMembershipBandTerm } from '@/server/rules/pricing/admin'

/**
 * W54 (G-plan 4.3): setMembershipBandTerm, one membership level's terms in one band on the Pricing page (whether a
 * credit can be used there, and the member discount). Manage pricing (the rule, in the old words). One transaction
 * under the band's lock, with a `pricing.member_term_set` audit row. Idempotent: each press has its own key.
 * W54a: the press sends the term's `stamp` as the config read answered it; a term changed since is refused
 * `changed_since` and nothing is written. The answer carries the term's new stamp.
 */
export const POST = defineRoute({ auth: 'staff', input: memberBandTermRouteInputSchema, output: memberBandTermRouteOutputSchema, idempotent: true }, async ({ db, input, staff, requestId, idempotencyKey }) =>
  setMembershipBandTerm(db, input, { actor: adminActor(staff), requestId, pressKey: idempotencyKey })
)
