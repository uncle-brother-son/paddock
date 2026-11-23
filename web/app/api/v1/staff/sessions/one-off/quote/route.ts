import { oneOffSessionQuoteRouteInputSchema, oneOffSessionQuoteRouteOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { oneOffSessionQuote } from '@/server/rules/sessions/admin'

/**
 * W68 (Wayne's Q58; H12): the band a one-off session would get from the day's windows, and what it would sell at, shown in
 * the dialog before Create Session. Any active staff member; refused as the press would be (a service type that is off or
 * unfinished, a time that isn't one, a closed date, a session already there). Changes nothing.
 */
export const GET = defineRoute({ auth: 'staff', input: oneOffSessionQuoteRouteInputSchema, output: oneOffSessionQuoteRouteOutputSchema }, async ({ db, input, staff }) =>
  oneOffSessionQuote(db, input.serviceTypeId, input.startTime, { actor: adminActor(staff) })
)
