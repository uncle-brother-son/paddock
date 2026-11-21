import { catalogPlanCreateRouteInputSchema, catalogPlanCreateRouteOutputSchema, catalogPlansRouteOutputSchema, emptyInputSchema } from '@/contracts'
import { defineRoute } from '@/server/http/define-route'
import { adminActor } from '@/server/rules/admin/refusal'
import { planChangePathOff } from '@/server/rules/catalog/plan-switch'
import { createPlan, listPlans } from '@/server/rules/catalog/plans'
import { createStripeClient, ORDER_STRIPE_LIMITS } from '@/server/stripe/client'

/**
 * Brief W57 (G-plan 4.3; bug GB14; Q53): getMembershipPlans, for Catalog -> Membership Plans and New Order's plan
 * picker. Every plan by name with named fields, its stamp, its live members per price, its Stripe set-up state and
 * whether a price change is open. Any active staff member (the old read checked nobody).
 */
export const GET = defineRoute({ auth: 'staff', input: emptyInputSchema, output: catalogPlansRouteOutputSchema }, async ({ db, staff }) =>
  listPlans(db, { channel: 'staff', actor: adminActor(staff) }) as Promise<never>
)

/**
 * Brief W57 (G-plan 4.4; bug GB20): createMembershipPlan. Gated by `plan_changes` (off: nothing is read). Manage
 * pricing; the old checks; the row (off sale) and its record in one transaction; the Stripe product and prices under
 * keys from the plan; the ids written and the plan put on sale in one transaction. Idempotent: the same press key
 * gets the first press's answer, so a repeated press makes one plan.
 */
export const POST = defineRoute(
  { auth: 'staff', input: catalogPlanCreateRouteInputSchema, output: catalogPlanCreateRouteOutputSchema, idempotent: true },
  async ({ db, input, staff, requestId, idempotencyKey, startedAt }) => {
    const off = planChangePathOff(process.env.ORDER_SWITCH)
    if (off) throw off
    return createPlan(db, input, { actor: adminActor(staff), requestId, pressKey: idempotencyKey, startedAt, stripe: () => createStripeClient(undefined, ORDER_STRIPE_LIMITS) }) as Promise<never>
  }
)
