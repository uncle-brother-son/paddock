import { defineRoute } from '@/server/http/define-route'
import { MANUAL_LIMITS, reconcile } from '@/server/rules/orders/reconcile'
import { reconcileRunInputSchema, reconcileRunOutputSchema } from '@/server/rules/orders/reconcile-contracts'
import { createStripeClient, ORDER_STRIPE_LIMITS } from '@/server/stripe/client'

/**
 * W12: run reconcile now (the Orders page's Resolve now button from W14; the schedule runs it every 5
 * minutes on its own, server/scheduled.ts). Any active staff member, as the old sweep. The run is bounded
 * to end inside Retool's 60 seconds (MANUAL_LIMITS, and every Stripe call by the press deadline); what is
 * left waits for the schedule. Idempotent: a lost answer is given again for the same key. Safe beside the
 * schedule and another press: T2 and the undo lock and re-check, and every Stripe step is keyed.
 */
export const POST = defineRoute(
  { auth: 'staff', input: reconcileRunInputSchema, output: reconcileRunOutputSchema, idempotent: true },
  async ({ db, staff, requestId, startedAt }) =>
    reconcile(db, createStripeClient(undefined, ORDER_STRIPE_LIMITS), { actor: { type: 'staff', id: staff.id }, requestId, startedAt, ...MANUAL_LIMITS })
)
