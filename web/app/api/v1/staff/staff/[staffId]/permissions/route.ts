import { staffPermissionRouteInputSchema, staffPermissionRouteOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { setStaffPermission } from '@/server/rules/staff/admin'

/**
 * W49 (G-plan 4.3; bug GB16): setStaffPermission (Issue refunds, active) and setStaffCanManagePricing (Manage
 * pricing), the three switches on the Staff page: one switch a press, named by its column. Admins only (the rule, in
 * the old words). One transaction under the staff table's guard: the last active admin stays active, the last
 * active Manage pricing holder keeps it and stays active, and a `staff.permission_set` audit row says who changed
 * what. Idempotent: each call of a switch has its own key.
 */
export const POST = defineRoute({ auth: 'staff', input: staffPermissionRouteInputSchema, output: staffPermissionRouteOutputSchema, idempotent: true }, async ({ db, input, staff, requestId, idempotencyKey }) =>
  setStaffPermission(db, input.staffId, input.field, input.value, { actor: adminActor(staff), requestId, pressKey: idempotencyKey })
)
