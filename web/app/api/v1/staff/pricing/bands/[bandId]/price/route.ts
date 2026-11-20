import { adminSetBandPriceOutputSchema, bandPriceRouteInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { setBandPrice } from '@/server/rules/pricing/admin'

/**
 * W54 (G-plan 4.3): setBandPrice, a band's price on the Pricing page. Manage pricing (the rule, in the old words).
 * One transaction under the band's lock, with a `pricing.band_price_set` audit row of the price before and after.
 * Every quote reads the band's price live, so the next quote follows it; no booking already made changes.
 * Idempotent: each press has its own key.
 */
export const POST = defineRoute({ auth: 'staff', input: bandPriceRouteInputSchema, output: adminSetBandPriceOutputSchema, idempotent: true }, async ({ db, input, staff, requestId, idempotencyKey }) =>
  setBandPrice(db, input.bandId, input.price, { actor: adminActor(staff), requestId, pressKey: idempotencyKey })
)
