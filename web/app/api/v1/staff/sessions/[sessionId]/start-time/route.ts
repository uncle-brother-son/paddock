import { sessionStartTimeRouteInputSchema, sessionStartTimeRouteOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { setSessionStartTime } from '@/server/rules/sessions/admin'

/**
 * W51 (G-plan 4.3, level B; bug GB6; W51-1): setSessionStartTime, one session's start moved once. Any active staff
 * member. One transaction: the band guard shared first, then the session's lock; ANY booking on it that isn't
 * cancelled refuses the change (`session_has_bookings`: a Payment needed booking too); another session of the
 * service type at that time refuses it; the times (the end follows the service type's length, the band follows the
 * time unless set by hand); and a `session.start_time_set` audit row. Idempotent: each press has its own key.
 */
export const POST = defineRoute({ auth: 'staff', input: sessionStartTimeRouteInputSchema, output: sessionStartTimeRouteOutputSchema, idempotent: true }, async ({ db, input, staff, requestId, idempotencyKey }) =>
  setSessionStartTime(db, input.sessionId, input.startTime, { actor: adminActor(staff), requestId, pressKey: idempotencyKey })
)
