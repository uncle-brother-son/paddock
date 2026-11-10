import { finaliseReaderOrderOutputSchema, readerOrderInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { finaliseReaderOrder } from '@/server/rules/orders/reader-order'
import { createStripeClient, ORDER_STRIPE_LIMITS } from '@/server/stripe/client'

/**
 * W11: finaliseReaderOrder. The reader has taken the payment: the order is checked against Stripe (to
 * the exact penny) and marked paid by T2 in one transaction, with the card saved when the customer
 * agreed. Answers as data, as the old function did. Idempotent: a retry with the same key gets the same
 * answer; a new key is safe too, as T2 locks the order and re-checks it. Any active staff member, as
 * finaliseReaderOrder. Stripe calls end by the deadline from the request's start (server/stripe/deadline.ts).
 * Nothing calls this until the screen switches (W14).
 */
export const POST = defineRoute(
  { auth: 'staff', input: readerOrderInputSchema, output: finaliseReaderOrderOutputSchema, idempotent: true },
  async ({ db, input, staff, requestId, startedAt }) =>
    finaliseReaderOrder(db, createStripeClient(undefined, ORDER_STRIPE_LIMITS), input.orderId, { actor: { type: 'staff', id: staff.id }, requestId, startedAt })
)
