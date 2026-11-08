import { placeOrderInputSchema, placeOrderOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { placeOrder } from '@/server/rules/orders/place-order'

/**
 * Places an order (W06: cash, or nothing owed). Idempotent: a retry with the same key gets the same
 * answer, refusals included, and never runs it twice. Selling needs only an active staff member, as
 * in createOrder; a sent price counts only with Manage pricing. Anything not built yet answers
 * NOT_BUILT before the order is touched. Nothing calls this until the screen switches (W14).
 */
export const POST = defineRoute(
  { auth: 'staff', input: placeOrderInputSchema, output: placeOrderOutputSchema, idempotent: true },
  async ({ db, input, staff, requestId }) =>
    placeOrder(db, input, { actor: { type: 'staff', id: staff.id }, requestId, allowPriceOverrides: staff.canManagePricing })
)
