import { blockDayRouteInputSchema, blockDayRouteOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { blockDay } from '@/server/rules/sessions/admin'

/**
 * W51 (G-plan 4.3, level B; bugs GB5 and GB7; W48 review L1): blockDay, Block Day. Any active staff member. One
 * transaction: the day's sessions locked in id order; any booking that isn't cancelled on any of them refuses the
 * block and is listed in the refusal's details (`bookings_in_the_way`); the figures the press sent (`seen`, as the
 * quote showed them) must still be right (`changed_since`, with the new ones); every session that isn't blocked is
 * blocked, and the ones blocked before keep their own reason; and one `session.blocked` audit row for the day.
 * Idempotent: each press has its own key.
 */
export const POST = defineRoute({ auth: 'staff', input: blockDayRouteInputSchema, output: blockDayRouteOutputSchema, idempotent: true }, async ({ db, input, staff, requestId, idempotencyKey }) =>
  blockDay(db, input.date, input.reason, input.seen, { actor: adminActor(staff), requestId, pressKey: idempotencyKey })
)
