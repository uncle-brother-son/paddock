import { scheduleSlotAddRouteInputSchema, scheduleSlotRowSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { addScheduleSlot } from '@/server/rules/sessions/admin'

/**
 * W51 (G-plan 4.3, level B; Wayne's Q50): addServiceTypeScheduleSlot, a weekly slot for a service type. Manage
 * pricing (Q50 part 2; the rule, in the old words). One transaction under the service type's lock: the old checks in
 * the old words, a slot already there refused, the slot, and a `timetable.slot_added` audit row. It makes no
 * session: the slot reaches only the dates the nightly job makes from now on (Q50 part 1). Idempotent: the same
 * press key gets the first press's answer.
 */
export const POST = defineRoute({ auth: 'staff', input: scheduleSlotAddRouteInputSchema, output: scheduleSlotRowSchema, idempotent: true }, async ({ db, input, staff, requestId, idempotencyKey }) =>
  addScheduleSlot(db, input.serviceTypeId, input.dayOfWeek, input.startTime, { actor: adminActor(staff), requestId, pressKey: idempotencyKey })
)
