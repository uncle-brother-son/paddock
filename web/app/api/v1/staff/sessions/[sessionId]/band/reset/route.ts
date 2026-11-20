import { sessionBandResetRouteOutputSchema, sessionByIdRouteInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { resetSessionBand } from '@/server/rules/sessions/admin'

/**
 * W51 (G-plan 4.3, level B; W51-1): resetSessionBand, a band set by hand back to automatic. Manage pricing (the
 * rule, in the old words). One transaction: the band guard shared first (a band-window save in progress is waited
 * for), then the session's lock; a session that isn't there or wasn't set by hand is refused with the old reason;
 * the band the day's windows give its time; and a `session.band_reset` audit row. Idempotent: each press has its
 * own key.
 */
export const POST = defineRoute({ auth: 'staff', input: sessionByIdRouteInputSchema, output: sessionBandResetRouteOutputSchema, idempotent: true }, async ({ db, input, staff, requestId, idempotencyKey }) =>
  resetSessionBand(db, input.sessionId, { actor: adminActor(staff), requestId, pressKey: idempotencyKey })
)
