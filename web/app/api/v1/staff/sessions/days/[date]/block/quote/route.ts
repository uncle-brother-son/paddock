import { blockDayQuoteRouteOutputSchema, sessionDayRouteInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { blockDayQuote } from '@/server/rules/sessions/admin'

/**
 * W51 (G-plan 4.2 item 4; bugs GB5 and GB7): what Block Day would do, shown before the press: how many sessions the
 * day has, how many it would block, how many are blocked already and keep their own reason, and the bookings in the
 * way (every one that isn't cancelled). Any active staff member. Changes nothing.
 */
export const GET = defineRoute({ auth: 'staff', input: sessionDayRouteInputSchema, output: blockDayQuoteRouteOutputSchema }, async ({ db, input, staff }) => blockDayQuote(db, input.date, { actor: adminActor(staff) }))
