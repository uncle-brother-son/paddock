import { placeOrderInputSchema, placeOrderOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { placeOrder } from '@/server/rules/orders/place-order'
import { createStripeClient, ORDER_STRIPE_LIMITS } from '@/server/stripe/client'

/**
 * Places an order (W06: cash, or nothing owed; W10: the saved card). Idempotent: a retry with the
 * same key gets the same answer, refusals and PAYMENT_UNCONFIRMED included, and never runs it twice,
 * so never charges twice. Selling needs only an active staff member, as in createOrder; a sent price
 * counts only with Manage pricing. Anything not built yet answers NOT_BUILT before the order is
 * touched. Stripe is reached only for a card order, with the order's time limits and a deadline from
 * the request's start (collect-saved-card.ts, COLLECT_DEADLINE_MS). Nothing calls this
 * until the screen switches (W14).
 */
export const POST = defineRoute(
  { auth: 'staff', input: placeOrderInputSchema, output: placeOrderOutputSchema, idempotent: true },
  async ({ db, input, staff, requestId, startedAt }) =>
    placeOrder(db, input, {
      actor: { type: 'staff', id: staff.id },
      requestId,
      startedAt,
      allowPriceOverrides: staff.canManagePricing,
      stripe: () => createStripeClient(undefined, ORDER_STRIPE_LIMITS),
    })
)
