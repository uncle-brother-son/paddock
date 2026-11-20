import { adminSetSessionBandOutputSchema, dayBandRouteInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { setSessionBand } from '@/server/rules/sessions/admin'

/**
 * W51 (G-plan 4.3, level B; W48 review L1): setSessionBand's press for a day: every session on it (public and
 * private) given the band by hand. Manage pricing, and the band must exist and be on (the rule, in the old words).
 * One transaction: the day's sessions locked in id order; the two counts the press sent (`seen`, as the quote
 * showed them) must still be right (`changed_since`, with the new ones); the band; and one `session.band_set` audit
 * row for the day. Idempotent: each press has its own key.
 */
export const POST = defineRoute({ auth: 'staff', input: dayBandRouteInputSchema, output: adminSetSessionBandOutputSchema, idempotent: true }, async ({ db, input, staff, requestId, idempotencyKey }) =>
  setSessionBand(db, { date: input.date }, input.bandId, input.seen, { actor: adminActor(staff), requestId, pressKey: idempotencyKey })
)
