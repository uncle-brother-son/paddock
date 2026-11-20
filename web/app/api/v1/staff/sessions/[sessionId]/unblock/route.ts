import { sessionByIdRouteInputSchema, sessionRowSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { unblockSession } from '@/server/rules/sessions/admin'

/**
 * W51 (G-plan 4.3, level B; bug GB7): unblockSession, Unblock on a session's card. Any active staff member. One
 * transaction under the session's lock: a session that isn't blocked is refused and left as it is (`not_blocked`);
 * then the reopening, and a `session.unblocked` audit row. Answers the session's row. Idempotent: each press has
 * its own key.
 */
export const POST = defineRoute({ auth: 'staff', input: sessionByIdRouteInputSchema, output: sessionRowSchema, idempotent: true }, async ({ db, input, staff, requestId, idempotencyKey }) =>
  unblockSession(db, input.sessionId, { actor: adminActor(staff), requestId, pressKey: idempotencyKey })
)
