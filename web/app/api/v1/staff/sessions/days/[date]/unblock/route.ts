import { unblockDayRouteInputSchema, unblockDayRouteOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { unblockDay } from '@/server/rules/sessions/admin'

/**
 * W51 (G-plan 4.3, level B; bug GB7; W48 review L1): unblockDay, Unblock Day. Any active staff member. One
 * transaction: the day's sessions locked in id order; the figures the press sent (`seen`, as the quote showed them)
 * must still be right (`changed_since`, with the new ones); the sessions a Block Day blocked are reopened, and the
 * ones blocked on their own stay blocked; and one `session.unblocked` audit row for the day. Idempotent: each press
 * has its own key.
 */
export const POST = defineRoute({ auth: 'staff', input: unblockDayRouteInputSchema, output: unblockDayRouteOutputSchema, idempotent: true }, async ({ db, input, staff, requestId, idempotencyKey }) =>
  unblockDay(db, input.date, input.seen, { actor: adminActor(staff), requestId, pressKey: idempotencyKey })
)
