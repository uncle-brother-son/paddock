import { shopSessionsRouteInputSchema, shopSessionsRouteOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { shopSessions } from '@/server/rules/shop/booking'

/**
 * Brief W77a: one London date's sessions with their spaces and prices, for the booking panel. No sign-in: what it answers
 * is what the panel shows anyone. Never cached (the route factory's no-store).
 */
export const GET = defineRoute({ auth: 'public', input: shopSessionsRouteInputSchema, output: shopSessionsRouteOutputSchema }, async ({ db, input }) => shopSessions(db, input.date))
