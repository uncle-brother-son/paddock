import { shopEventAvailabilityRouteInputSchema, shopEventAvailabilityRouteOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { shopEventAvailability } from '@/server/rules/shop/events'

/**
 * Brief W75a: an event's spaces, state and prices now, for the Event page to ask once it has loaded. No sign-in: what
 * it answers is what the page shows anyone. Never cached (the route factory's no-store).
 */
export const GET = defineRoute({ auth: 'public', input: shopEventAvailabilityRouteInputSchema, output: shopEventAvailabilityRouteOutputSchema }, async ({ db, input }) =>
  shopEventAvailability(db, input.event)
)
