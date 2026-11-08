import { orderDryRunOutputSchema, placeOrderInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { dryRunOrder } from '@/server/rules/orders/place-order'

/**
 * The real order transaction on the real database, read back and rolled back: nothing is kept, no
 * key is stored and nothing reaches Stripe, so it is a read and not idempotent. The staff app's
 * createOrder shadow calls it before the old order runs and compares the two (W03-plan 3.1 layer 4).
 * Refusals answer exactly as the order route would. Removed at W16.
 */
export const POST = defineRoute(
  { auth: 'staff', input: placeOrderInputSchema, output: orderDryRunOutputSchema },
  async ({ db, input, staff, requestId }) =>
    dryRunOrder(db, input, { actor: { type: 'staff', id: staff.id }, requestId, allowPriceOverrides: staff.canManagePricing })
)
