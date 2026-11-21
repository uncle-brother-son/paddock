import { catalogPlanDetailsRouteInputSchema, catalogPlanDetailsRouteOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { planChangePathOff } from '@/server/rules/catalog/plan-switch'
import { setPlanDetails } from '@/server/rules/catalog/plans'
import { createStripeClient, ORDER_STRIPE_LIMITS } from '@/server/stripe/client'

/**
 * Brief W57 (G-plan 4.4; bugs GB1, GB2; Wayne's Q53): setMembershipPlanDetails, and updateCatalogItemPrice's plan
 * branch (a price-only press). Gated by `plan_changes` (off: nothing is read). D1 in one transaction (Manage pricing;
 * the old checks; the stamp; the details; when a price changes, the member count confirmed and the record); then
 * the new Stripe price under the record's key, D2 (the price and its id together, one move step per live member),
 * the old price archived, and each member's move sent (server/rules/catalog/plans.ts, plan-stripe.ts). Idempotent.
 */
export const POST = defineRoute(
  { auth: 'staff', input: catalogPlanDetailsRouteInputSchema, output: catalogPlanDetailsRouteOutputSchema, idempotent: true },
  async ({ db, input, staff, requestId, idempotencyKey, startedAt }) => {
    const off = planChangePathOff(process.env.ORDER_SWITCH)
    if (off) throw off
    const { planId, ...press } = input
    return setPlanDetails(db, planId, press, { actor: adminActor(staff), requestId, pressKey: idempotencyKey, startedAt, stripe: () => createStripeClient(undefined, ORDER_STRIPE_LIMITS) }) as Promise<never>
  }
)
