import { defineRoute } from '@/server/http/define-route'
import { finaliseReaderFlowOutputSchema, readerFlowInputSchema } from '@/contracts'
import { finaliseReaderFlow } from '@/server/rules/orders/reader-flow'
import { createStripeClient, ORDER_STRIPE_LIMITS } from '@/server/stripe/client'

/**
 * W12: finaliseReaderPayment for Move, Settle and Add Guest. The reader has taken the payment: it is checked
 * against Stripe to the exact penny and recorded by the flow's T2, in one transaction. Answers as data, as the
 * old function did. Idempotent; a new key is safe too (T2 locks the flow's row and re-checks it). Any active
 * staff member, as finaliseReaderPayment. Only flows the Worker started (step D); the old screens' are refused
 * (`old_reader_flow`). Nothing calls this until step D moves the flows (dark).
 */
export const POST = defineRoute(
  { auth: 'staff', input: readerFlowInputSchema, output: finaliseReaderFlowOutputSchema, idempotent: true },
  async ({ db, input, staff, requestId, startedAt }) =>
    finaliseReaderFlow(db, createStripeClient(undefined, ORDER_STRIPE_LIMITS), input.pendingId, { actor: { type: 'staff', id: staff.id }, requestId, startedAt })
)
