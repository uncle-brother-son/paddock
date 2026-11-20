import { emptyInputSchema, postageSettingsOutputSchema, postageSettingsRouteInputSchema, postageSettingsRouteOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { setPostageSettings } from '@/server/rules/pricing/admin'
import { getPostageSettings } from '@/server/rules/pricing/postage-settings'

export const GET = defineRoute({ auth: 'staff', input: emptyInputSchema, output: postageSettingsOutputSchema }, async ({ db }) => getPostageSettings(db))

/**
 * W54 (G-plan 4.3; W48 review S1): setPostageSettings, the postage figures on the Pricing page. Manage pricing (the
 * rule, in the old words). One transaction under the settings row's lock, so two saves at once take turns, with a
 * `postage.set` audit row of the figures before and after. Idempotent: each press has its own key.
 * W54a: the press sends the settings row's `stamp` as the read above answered it; settings changed since are refused
 * `changed_since` and nothing is written. The answer carries the row's new stamp.
 */
export const POST = defineRoute({ auth: 'staff', input: postageSettingsRouteInputSchema, output: postageSettingsRouteOutputSchema, idempotent: true }, async ({ db, input, staff, requestId, idempotencyKey }) =>
  setPostageSettings(db, input, { actor: adminActor(staff), requestId, pressKey: idempotencyKey })
)
