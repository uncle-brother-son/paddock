import { shopBookingDaysRouteInputSchema, shopBookingDaysRouteOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { shopBookingDays } from '@/server/rules/shop/booking'

/**
 * Brief W77a (WQ65): the days of a month with a session bookable online, and the first from now, for the booking panel's
 * calendar. No sign-in: what it answers is what the panel shows anyone. Never cached (the route factory's no-store).
 */
export const GET = defineRoute({ auth: 'public', input: shopBookingDaysRouteInputSchema, output: shopBookingDaysRouteOutputSchema }, async ({ db, input }) =>
  shopBookingDays(db, input.month)
)
