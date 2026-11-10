import { defineRoute } from '@/server/http/define-route'
import { cancelReaderFlowOutputSchema, readerFlowInputSchema } from '@/server/rules/orders/reconcile-contracts'
import { cancelReaderFlow } from '@/server/rules/orders/reader-flow'
import { createStripeClient, ORDER_STRIPE_LIMITS } from '@/server/stripe/client'

/**
 * W12: cancelReaderPayment for Move, Settle and Add Guest. Stripe is asked to cancel the intent, and the
 * flow's undo puts everything back in one transaction; a payment that had in fact succeeded is finalised
 * instead. Anything unclear from Stripe changes nothing. Answers as data, as the old function did.
 * Idempotent, and safe twice with a new key. Any active staff member. Only flows the Worker started (step D).
 */
export const POST = defineRoute(
  { auth: 'staff', input: readerFlowInputSchema, output: cancelReaderFlowOutputSchema, idempotent: true },
  async ({ db, input, staff, requestId, startedAt }) =>
    cancelReaderFlow(db, createStripeClient(undefined, ORDER_STRIPE_LIMITS), input.pendingId, { actor: { type: 'staff', id: staff.id }, requestId, startedAt })
)
