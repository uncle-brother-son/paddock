import { sessionBlockRouteInputSchema, sessionBlockRouteOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { blockSession } from '@/server/rules/sessions/admin'

/**
 * W51 (G-plan 4.3, level B; bugs GB5 and GB7; W50 review L1): blockSession, Block Slot. Any active staff member.
 * One transaction under the session's lock: any booking on it that isn't cancelled (pending, confirmed, Payment
 * needed) refuses the block and is listed in the refusal's details (`bookings_in_the_way`); a session already
 * blocked is refused and keeps its reason; then the block, with who, and a `session.blocked` audit row. Idempotent:
 * each press has its own key.
 */
export const POST = defineRoute({ auth: 'staff', input: sessionBlockRouteInputSchema, output: sessionBlockRouteOutputSchema, idempotent: true }, async ({ db, input, staff, requestId, idempotencyKey }) =>
  blockSession(db, input.sessionId, input.reason, { actor: adminActor(staff), requestId, pressKey: idempotencyKey })
)
