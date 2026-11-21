import { emptyInputSchema, membershipSettingsRouteOutputSchema, membershipSettingsSetRouteInputSchema, membershipSettingsSetRouteOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { readMembershipSettings, setMembershipSettings } from '@/server/rules/catalog/plans'

/**
 * Brief W57 (G-plan 4.3; bug GB14): getMembershipSettings, the add-on credits waiting period, for Catalog ->
 * Membership Plans and New Order. Any active staff member (the old read checked nobody). No row: the default, 6.
 */
export const GET = defineRoute({ auth: 'staff', input: emptyInputSchema, output: membershipSettingsRouteOutputSchema }, async ({ db, staff }) => readMembershipSettings(db, adminActor(staff)))

/**
 * Brief W57 (G-plan 4.4; bug GB19): setMembershipSettings. Level B, so no switch. Manage pricing; the old check; one
 * transaction under the settings row's lock: the count of members whose Herd status changes confirmed (as the
 * control showed it), the period set, the Herd rule run again, and a `membership_settings.set` row with both counts.
 * Idempotent: the same press key gets the first press's answer.
 */
export const POST = defineRoute(
  { auth: 'staff', input: membershipSettingsSetRouteInputSchema, output: membershipSettingsSetRouteOutputSchema, idempotent: true },
  async ({ db, input, staff, requestId, idempotencyKey }) => setMembershipSettings(db, input.addonCreditWaitMonths, input.herdFlagsToChange, { actor: adminActor(staff), requestId, pressKey: idempotencyKey })
)
