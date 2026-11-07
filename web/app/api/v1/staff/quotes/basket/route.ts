import { basketQuoteInputSchema, basketQuoteOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { priceBasket } from '@/server/rules/orders/price-basket'

/**
 * Read-only, so not idempotent and no audit row. POST because the input is a structured body.
 * The rule knows nothing of staff: only someone with Manage pricing may change a price, and for
 * anyone else a sent price is ignored, as in createOrder.
 */
export const POST = defineRoute({ auth: 'staff', input: basketQuoteInputSchema, output: basketQuoteOutputSchema }, async ({ db, input, staff }) =>
  priceBasket(db, input, { allowPriceOverrides: staff.canManagePricing })
)
