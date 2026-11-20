import { adminCreateStaffOutputSchema, adminGetStaffOutputSchema, emptyInputSchema, staffCreateRouteInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { createStaff, listStaff } from '@/server/rules/staff/admin'

/** W49 (G-plan 4.3): getStaff, the Staff page's list. Admins only, refused by the rule in the old words. */
export const GET = defineRoute({ auth: 'staff', input: emptyInputSchema, output: adminGetStaffOutputSchema }, async ({ db, staff }) => listStaff(db, adminActor(staff)))

/**
 * W49 (G-plan 4.3; bug GB16): createStaff, New Staff on the Staff page. Admins only (the rule, in the old words). One
 * transaction under the staff table's guard: an email already on file in any case refused, the row, and a
 * `staff.created` audit row. Idempotent: the same press key gets the first press's answer, so a lost answer pressed
 * again never tries to add the member twice.
 */
export const POST = defineRoute({ auth: 'staff', input: staffCreateRouteInputSchema, output: adminCreateStaffOutputSchema, idempotent: true }, async ({ db, input, staff, requestId, idempotencyKey }) =>
  createStaff(db, input, { actor: adminActor(staff), requestId, pressKey: idempotencyKey })
)
