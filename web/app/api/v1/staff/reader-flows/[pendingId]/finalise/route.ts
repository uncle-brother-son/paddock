import { defineRoute } from '@/server/http/define-route'
import { finaliseReaderFlowOutputSchema, readerFlowInputSchema } from '@/contracts'
import { finaliseReaderFlow } from '@/server/rules/orders/reader-flow'
import { createStripeClient, ORDER_STRIPE_LIMITS } from '@/server/stripe/client'

/**
 * W12: finaliseReaderPayment for Move, Settle and Add Guest. The reader has taken the payment: it is checked
 * against Stripe to the exact penny and recorded by the flow's T2, in one transaction. Answers as data, as the
 * old function did. Idempotent; a new key is safe too (T2 locks the flow's row and re-checks it). Any active
 * staff member, as finaliseReaderPayment. Only reader flows the Worker started (every flow, since step D); anything
 * else is refused (`not_a_reader_flow`). The staff app's finaliseReaderPayment is a thin call to this.
 */
export const POST = defineRoute(
  { auth: 'staff', input: readerFlowInputSchema, output: finaliseReaderFlowOutputSchema, idempotent: true },
  async ({ db, input, staff, requestId, startedAt }) =>
    finaliseReaderFlow(db, createStripeClient(undefined, ORDER_STRIPE_LIMITS), input.pendingId, { actor: { type: 'staff', id: staff.id }, requestId, startedAt })
)
