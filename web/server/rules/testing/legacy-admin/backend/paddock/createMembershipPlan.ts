import { requireCanManagePricing } from './shared/pricingStaff'
import { extractApiErrorMessage } from './shared/extractApiErrorMessage'
import { isHtmlErrorPage } from './shared/isHtmlErrorPage'
import { extractStructuredApiError } from './shared/extractStructuredApiError'
import { toggleItemActive } from './shared/toggleItemActive'
import type { MembershipPlanLevel, MembershipPlanRow } from './getMembershipPlans'

export interface CreateMembershipPlanParams {
  name: string
  level: MembershipPlanLevel
  sessionsIncluded: number
  addonsIncluded: number
  isUnlimited: boolean
  priceMonthly: number | null
  priceYearly: number | null
}

// Auth: this endpoint requires `Authorization: Bearer <RETOOL_API_KEY>`, configured on the
// "Paddock Backend API" REST resource itself — same as updateCatalogItemPrice.ts and
// toggleItemActive.ts. It creates the Stripe product plus recurring GBP prices from the plan's
// stored price_monthly (month) / price_yearly (year) and writes stripe_product_id /
// stripe_price_id / stripe_price_id_yearly. It returns 400 if the plan already has a
// stripe_product_id, which rawRequest surfaces as a parsed body (it does not throw), so
// extractStructuredApiError below is what actually detects that failure.
interface SyncStripeResponse {
  success?: boolean
  item?: {
    id: string
    stripe_product_id?: string | null
    [key: string]: unknown
  }
  [key: string]: unknown
}

async function syncMembershipPlanToStripe(planId: string): Promise<void> {
  try {
    const response = await paddockBackendApi2.rawRequest<SyncStripeResponse>({
      path: '/api/catalog/sync-stripe',
      method: 'POST',
      body: { itemType: 'membership_plan', itemId: planId },
    })
    if (isHtmlErrorPage(response.data)) {
      throw new Error(
        'The catalog endpoint returned an HTML page instead of a JSON response, which means this ' +
          'request never reached a real backend — the plan was not synced to Stripe. Check the ' +
          '"Paddock Backend API" resource\'s base URL.'
      )
    }
    const structuredError = extractStructuredApiError(response.data)
    if (structuredError) {
      throw new Error(structuredError)
    }
  } catch (err) {
    throw new Error(extractApiErrorMessage(err, 'Failed to sync membership plan to Stripe'))
  }
}

export default async function createMembershipPlan(
  req: { params: CreateMembershipPlanParams; user: User }
): Promise<MembershipPlanRow> {
  // A new plan is price structure — Manage pricing only.
  await requireCanManagePricing(req.user.email)
  const name = req.params.name?.trim()
  const level = req.params.level
  const isUnlimited = req.params.isUnlimited
  const addonsIncluded = req.params.addonsIncluded
  const priceMonthly = req.params.priceMonthly
  const priceYearly = req.params.priceYearly
  // Unlimited plans store sessions_included = 0 — the "Unlimited" flag is the source of truth,
  // so any supplied number is normalized away and no positive number is required.
  const sessionsIncluded = isUnlimited ? 0 : req.params.sessionsIncluded

  if (!name) {
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
  if (typeof isUnlimited !== 'boolean') {
    throw new Error('isUnlimited must be true or false')
  }
  if (priceMonthly === null && priceYearly === null) {
    throw new Error('At least one price must be provided')
  }
  if (priceMonthly !== null && (!Number.isFinite(priceMonthly) || priceMonthly < 0)) {
    throw new Error('Monthly price must be a non-negative number')
  }
  if (priceYearly !== null && (!Number.isFinite(priceYearly) || priceYearly < 0)) {
    throw new Error('Yearly price must be a non-negative number')
  }

  // Created inactive: the plan only goes live once the Stripe sync below has succeeded, so the
  // catalog never shows a plan that can't actually be purchased.
  const inserted = await paddockData.query<{ id: string }>(
    `INSERT INTO membership_plans (name, level, is_unlimited, sessions_included, addons_included, price_monthly, price_yearly, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, false)
     RETURNING id`,
    [name, level, isUnlimited, sessionsIncluded, addonsIncluded, priceMonthly, priceYearly]
  )
  const planId = inserted.data[0]!.id

  await syncMembershipPlanToStripe(planId)
  await toggleItemActive('membership_plan', planId, true)

  // Re-select the full row: the Worker wrote the Stripe ids, and toggleItemActive set active.
  const final = await paddockData.query<MembershipPlanRow>(
    'SELECT * FROM membership_plans WHERE id = $1',
    [planId]
  )
  return final.data[0]!
}
