import { cancelReaderOrderOutputSchema, readerOrderInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { cancelReaderOrder } from '@/server/rules/orders/reader-order'
import { createStripeClient, ORDER_STRIPE_LIMITS } from '@/server/stripe/client'

/**
 * W11: cancelReaderOrder. The reader payment was cancelled, declined or timed out: Stripe is asked to
 * cancel the intent, and the one undo gives everything back in one transaction; a payment that had in
 * fact succeeded is finalised instead. Anything unclear from Stripe changes nothing. Answers as data,
 * as the old function did. Idempotent, and safe twice with a new key (the second finds the order gone).
 * Any active staff member, as cancelReaderOrder. Nothing calls this until the screen switches (W14).
 */
export const POST = defineRoute(
  { auth: 'staff', input: readerOrderInputSchema, output: cancelReaderOrderOutputSchema, idempotent: true },
  async ({ db, input, staff, requestId, startedAt }) =>
    cancelReaderOrder(db, createStripeClient(undefined, ORDER_STRIPE_LIMITS), input.orderId, { actor: { type: 'staff', id: staff.id }, requestId, startedAt })
)
