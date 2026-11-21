import { membershipSettingsQuoteRouteInputSchema, membershipSettingsQuoteRouteOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { quoteMembershipSettings } from '@/server/rules/catalog/plans'

/**
 * Brief W57 (G-plan 4.4; bug GB19): getMembershipSettingsQuote. What the waiting period control shows before the
 * press: how many members' Herd status a period would change (the rule `refresh_herd_flags()` applies, counted
 * without running it). Any active staff member; nothing is written.
 */
export const GET = defineRoute({ auth: 'staff', input: membershipSettingsQuoteRouteInputSchema, output: membershipSettingsQuoteRouteOutputSchema }, async ({ db, input, staff }) =>
  quoteMembershipSettings(db, input.addonCreditWaitMonths, adminActor(staff))
)
