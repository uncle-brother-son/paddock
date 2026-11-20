import { bandRulesRouteInputSchema, bandRulesRouteOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { setBandRules } from '@/server/rules/pricing/admin'

/**
 * W54 (G-plan 4.3; bug GB8; W48 review L1): setBandRules, one day's band windows on the Pricing page (0 = Sunday to
 * 6 = Saturday, in the path). Manage pricing (the rule, in the old words). One transaction: the day's windows
 * replaced, with no moment when the day has no band and nothing to put back; the sessions it re-bands locked first,
 * in id order, then re-banded; and a `pricing.band_rules_set` audit row. Idempotent: each press has its own key.
 * W54a: the press sends the day's `stamp` as the config read answered it; a day whose windows have changed since is
 * refused `changed_since` and nothing is written. The answer carries the day's new stamp.
 */
export const POST = defineRoute({ auth: 'staff', input: bandRulesRouteInputSchema, output: bandRulesRouteOutputSchema, idempotent: true }, async ({ db, input, staff, requestId, idempotencyKey }) =>
  setBandRules(db, input.dayOfWeek, input.rules, input.stamp, { actor: adminActor(staff), requestId, pressKey: idempotencyKey })
)
