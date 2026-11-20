import { adminSetSessionBandOutputSchema, sessionBandQuoteRouteInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { sessionBandQuote } from '@/server/rules/sessions/admin'

/**
 * W51 (G-plan 4.2 item 4, 4.3): setSessionBand's count for one session, shown before the press: the session (1, or
 * 0 when it isn't there) and how many bookings on it aren't cancelled. Manage pricing, and the band (`bandId` in
 * the query) must exist and be on, in the old words, as the old first call. Changes nothing.
 */
export const GET = defineRoute({ auth: 'staff', input: sessionBandQuoteRouteInputSchema, output: adminSetSessionBandOutputSchema }, async ({ db, input, staff }) =>
  sessionBandQuote(db, { sessionId: input.sessionId }, input.bandId, { actor: adminActor(staff) })
)
