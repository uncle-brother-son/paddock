import { sessionDayRouteInputSchema, unblockDayQuoteRouteOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { unblockDayQuote } from '@/server/rules/sessions/admin'

/**
 * W51 (G-plan 4.2 item 4; bugs GB7 and GB14): what Unblock Day would do, shown before the press: how many sessions
 * a Block Day blocked (the press reopens them) and how many were blocked on their own before the day was (they stay
 * blocked). Any active staff member (the old count asked nobody who they were). Changes nothing.
 */
export const GET = defineRoute({ auth: 'staff', input: sessionDayRouteInputSchema, output: unblockDayQuoteRouteOutputSchema }, async ({ db, input, staff }) => unblockDayQuote(db, input.date, { actor: adminActor(staff) }))
