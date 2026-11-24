import { shopAvailabilityRouteInputSchema, shopAvailabilityRouteOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { shopAvailability } from '@/server/rules/shop/reads'

/**
 * Brief W74a (WQ40): a product's sizes now, for the Product page to ask once it has loaded (its HTML can be up to a
 * minute old). No sign-in: what it answers is what the page shows anyone. Never cached (the route factory's no-store).
 */
export const GET = defineRoute({ auth: 'public', input: shopAvailabilityRouteInputSchema, output: shopAvailabilityRouteOutputSchema }, async ({ db, input }) => shopAvailability(db, input.product))
