import updateCatalogItemPrice from './updateCatalogItemPrice'
import { requireCanManagePricing } from './shared/pricingStaff'
import type { MembershipPlanLevel, MembershipPlanRow } from './getMembershipPlans'

export interface SetMembershipPlanDetailsParams {
  planId: string
  name?: string
  level: MembershipPlanLevel
  isUnlimited: boolean
  sessionsIncluded: number
  addonsIncluded: number
  priceMonthly: number
  priceYearly: number
}

// Auth: this endpoint requires `Authorization: Bearer <RETOOL_API_KEY>`, configured on the
// "Paddock Backend API" REST resource itself. It creates the Stripe product plus recurring GBP
// prices from the plan's stored price_monthly / price_yearly and writes the stripe_product_id /
// stripe_price_id / stripe_price_id_yearly columns. rawRequest does not throw on the 400 it
// returns for an already-synced plan — the parsed body comes back and the check below detects it.
interface SyncStripeResponse {
  success?: boolean
  [key: string]: unknown
}

async function syncMembershipPlanToStripe(planId: string): Promise<void> {
  const response = await paddockBackendApi2.rawRequest<SyncStripeResponse>({
    path: '/api/catalog/sync-stripe',
    method: 'POST',
    body: { itemType: 'membership_plan', itemId: planId },
  })
  const data = response.data as Record<string, unknown> | undefined
  if (data && typeof data['error'] === 'string' && data['error'].trim()) {
    const details = data['details']
    throw new Error(
      typeof details === 'string' && details.trim()
        ? `${data['error'] as string}: ${details as string}`
        : (data['error'] as string)
    )
  }
}

export default async function setMembershipPlanDetails(
  req: { params: SetMembershipPlanDetailsParams; user: User }
): Promise<MembershipPlanRow | null> {
  // Plan prices (and their Stripe sync) are catalog pricing — restricted to staff with
  // can_manage_pricing.
  await requireCanManagePricing(req.user.email)
  const { planId, name, level, isUnlimited, addonsIncluded, priceMonthly, priceYearly } = req.params
  // Unlimited plans store sessions_included = 0 — the "Unlimited" flag is the source of truth,
  // so no positive number is required then.
  const sessionsIncluded = isUnlimited ? 0 : req.params.sessionsIncluded

  if (name !== undefined && !name.trim()) {
    throw new Error('Name is required')
  }
  if (level !== 'core' && level !== 'all_access') {
    throw new Error('Level must be either "core" or "all_access"')
  }
  if (!Number.isInteger(sessionsIncluded) || sessionsIncluded < 0) {
    throw new Error('Sessions included must be a non-negative whole number')
  }
  if (!isUnlimited && sessionsIncluded < 1) {
    throw new Error('Sessions included must be a positive whole number for non-unlimited plans')
  }
  if (!Number.isInteger(addonsIncluded) || addonsIncluded < 0) {
    throw new Error('Add-ons included must be a non-negative whole number')
  }
  if (!Number.isFinite(priceMonthly) || priceMonthly < 0) {
    throw new Error('Monthly price must be a non-negative number')
  }
  if (!Number.isFinite(priceYearly) || priceYearly < 0) {
    throw new Error('Yearly price must be a non-negative number')
  }

  const current = await paddockData.query<MembershipPlanRow>(
    'SELECT * FROM membership_plans WHERE id = $1',
    [planId]
  )
  const existing = current.data[0]
  if (!existing) {
    throw new Error('Membership plan not found')
  }

  // Prices only ever change through the Worker's update-price endpoint (which archives and
  // recreates the Stripe Prices and writes the new price columns together), never via a direct
  // UPDATE here. If the plan has never been synced, sync-stripe must run first — update-price
  // errors out on a plan with no Stripe product.
  const storedMonthly = existing.price_monthly !== null ? Number.parseFloat(existing.price_monthly) : null
  const storedYearly = existing.price_yearly !== null ? Number.parseFloat(existing.price_yearly) : null
  const monthlyChanged = storedMonthly === null || storedMonthly !== priceMonthly
  const yearlyChanged = storedYearly === null || storedYearly !== priceYearly

  // Besides pushing changed prices, also push any price whose Stripe id column is NULL while the
  // plan already has a Stripe product and a positive price stored for it — otherwise a plan
  // whose monthly/yearly price was never created in Stripe (id still NULL) would never get one
  // as long as the stored value itself doesn't change. Prices that are unchanged AND already
  // have a Stripe id are never re-pushed.
  const monthlyNeedsStripePrice =
    existing.stripe_price_id === null && storedMonthly !== null && storedMonthly > 0
  const yearlyNeedsStripePrice =
    existing.stripe_price_id_yearly === null && storedYearly !== null && storedYearly > 0
  const pushMonthly = monthlyChanged || monthlyNeedsStripePrice
  const pushYearly = yearlyChanged || yearlyNeedsStripePrice

  if (pushMonthly || pushYearly) {
    if (!existing.stripe_product_id) {
      await syncMembershipPlanToStripe(planId)
    }
    await updateCatalogItemPrice({
      params: {
        itemType: 'membership_plan',
        itemId: planId,
        ...(pushMonthly ? { monthlyPrice: priceMonthly } : {}),
        ...(pushYearly ? { yearlyPrice: priceYearly } : {}),
      },
      user: req.user,
    })
  }

  const result = await paddockData.query<MembershipPlanRow>(
    `UPDATE membership_plans
     SET name = COALESCE($1, name), level = $2, is_unlimited = $3, sessions_included = $4, addons_included = $5, updated_at = now()
     WHERE id = $6
     RETURNING *`,
    [name !== undefined ? name.trim() : null, level, isUnlimited, sessionsIncluded, addonsIncluded, planId]
  )
  return result.data[0] ?? null
}
