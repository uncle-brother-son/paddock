import { staffRoleRouteInputSchema, staffRoleRouteOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { setStaffRole } from '@/server/rules/staff/admin'

/**
 * W49 (G-plan 4.3; bug GB16): setStaffRole, the role picker on the Staff page. Admins only (the rule, in the old
 * words). One transaction under the staff table's guard: the last active admin keeps the role, and a
 * `staff.role_set` audit row says who changed it. Idempotent: each call of the picker has its own key.
 */
export const POST = defineRoute({ auth: 'staff', input: staffRoleRouteInputSchema, output: staffRoleRouteOutputSchema, idempotent: true }, async ({ db, input, staff, requestId, idempotencyKey }) =>
  setStaffRole(db, input.staffId, input.role, { actor: adminActor(staff), requestId, pressKey: idempotencyKey })
)
