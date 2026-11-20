import { adminSetSessionBandOutputSchema, sessionBandRouteInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { setSessionBand } from '@/server/rules/sessions/admin'

/**
 * W51 (G-plan 4.3, level B): setSessionBand's press for one session: its band set by hand. Manage pricing, and the
 * band must exist and be on (the rule, in the old words). One transaction under the session's lock: the two counts
 * the press sent (`seen`, as the quote showed them) must still be right, or nothing is written and the refusal
 * carries the new ones (`changed_since`); the band; and a `session.band_set` audit row. Idempotent: each press has
 * its own key.
 */
export const POST = defineRoute({ auth: 'staff', input: sessionBandRouteInputSchema, output: adminSetSessionBandOutputSchema, idempotent: true }, async ({ db, input, staff, requestId, idempotencyKey }) =>
  setSessionBand(db, { sessionId: input.sessionId }, input.bandId, input.seen, { actor: adminActor(staff), requestId, pressKey: idempotencyKey })
)
