import { shopBookingQuoteRouteInputSchema, shopBookingQuoteRouteOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { shopBookingQuote } from '@/server/rules/shop/booking'

/**
 * Brief W77a: what a group of visitors pays for a session, or why it can't be booked, for the booking panel. It books
 * nothing and holds no space. No sign-in. Never cached (the route factory's no-store).
 */
export const GET = defineRoute({ auth: 'public', input: shopBookingQuoteRouteInputSchema, output: shopBookingQuoteRouteOutputSchema }, async ({ db, input }) =>
  shopBookingQuote(db, input.session, Number(input.people))
)
