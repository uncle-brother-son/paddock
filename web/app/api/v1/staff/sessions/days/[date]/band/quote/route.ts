import { adminSetSessionBandOutputSchema, dayBandQuoteRouteInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { sessionBandQuote } from '@/server/rules/sessions/admin'

/**
 * W51 (G-plan 4.2 item 4, 4.3): setSessionBand's count for a day, shown before the press: how many sessions the day
 * has and how many bookings on them aren't cancelled. Manage pricing, and the band (`bandId` in the query) must
 * exist and be on, in the old words, as the old first call. Changes nothing.
 */
export const GET = defineRoute({ auth: 'staff', input: dayBandQuoteRouteInputSchema, output: adminSetSessionBandOutputSchema }, async ({ db, input, staff }) =>
  sessionBandQuote(db, { date: input.date }, input.bandId, { actor: adminActor(staff) })
)
