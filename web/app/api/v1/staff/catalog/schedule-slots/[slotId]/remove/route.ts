import { adminDeleteServiceTypeScheduleSlotOutputSchema, scheduleSlotRemoveRouteInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { removeScheduleSlot } from '@/server/rules/sessions/admin'

/**
 * W51 (G-plan 4.3, level B; Wayne's Q50): deleteServiceTypeScheduleSlot, a weekly slot removed. Manage pricing (Q50
 * part 2; the rule, in the old words). One transaction under the slot's lock: the slot deleted, and a
 * `timetable.slot_removed` audit row that keeps it as it was. Sessions already on the calendar stay, and stay
 * bookable (Q50 part 1). Idempotent: each press has its own key.
 */
export const POST = defineRoute({ auth: 'staff', input: scheduleSlotRemoveRouteInputSchema, output: adminDeleteServiceTypeScheduleSlotOutputSchema, idempotent: true }, async ({ db, input, staff, requestId, idempotencyKey }) =>
  removeScheduleSlot(db, input.slotId, { actor: adminActor(staff), requestId, pressKey: idempotencyKey })
)
