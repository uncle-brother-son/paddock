import { catalogPlanActiveRouteInputSchema, catalogPlanActiveRouteOutputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { planChangePathOff } from '@/server/rules/catalog/plan-switch'
import { setPlanActive } from '@/server/rules/catalog/plans'
import { createStripeClient, ORDER_STRIPE_LIMITS } from '@/server/stripe/client'

/**
 * Brief W57 (G-plan 4.4): setMembershipPlanActive. Gated by `plan_changes` (off: nothing is read). Manage pricing.
 * On: Stripe's product first, then the row (a refusal changes nothing). Off: the row first, then Stripe's product as
 * a step left (sent now; reconcile's if unclear). Live members are not touched. Each call its own key (a switch).
 */
export const POST = defineRoute(
  { auth: 'staff', input: catalogPlanActiveRouteInputSchema, output: catalogPlanActiveRouteOutputSchema, idempotent: true },
  async ({ db, input, staff, requestId, idempotencyKey, startedAt }) => {
    const off = planChangePathOff(process.env.ORDER_SWITCH)
    if (off) throw off
    return setPlanActive(db, input.planId, input.active, { actor: adminActor(staff), requestId, pressKey: idempotencyKey, startedAt, stripe: () => createStripeClient(undefined, ORDER_STRIPE_LIMITS) })
  }
)
