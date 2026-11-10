import { saveCustomerCardInputSchema, saveCustomerCardOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { saveCustomerCard } from '@/server/rules/payments/terminal'
import { createStripeClient, ORDER_STRIPE_LIMITS } from '@/server/stripe/client'
import { sendOptions, stripeTiming } from '@/server/stripe/deadline'

/**
 * W11: saveCustomerCardOnFile, ported as it is (W03-decisions Q19: existing memberships keep their old
 * card until step F). Reads which card the tap left (Stripe reads only, each under the 30 s deadline from
 * the request's start, server/stripe/deadline.ts) and writes it to the customer with its audit row.
 * Idempotent. Any active staff member, as the old function.
 */
export const POST = defineRoute(
  { auth: 'staff', input: saveCustomerCardInputSchema, output: saveCustomerCardOutputSchema, idempotent: true },
  async ({ db, input, staff, requestId, startedAt }) => {
    const timing = stripeTiming(startedAt)
    return saveCustomerCard(db, createStripeClient(undefined, ORDER_STRIPE_LIMITS), input, { actor: { type: 'staff', id: staff.id }, requestId, send: () => sendOptions(timing) })
  }
)
