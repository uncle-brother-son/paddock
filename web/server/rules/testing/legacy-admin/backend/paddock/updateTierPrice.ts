import { extractApiErrorMessage } from './shared/extractApiErrorMessage'
import { isHtmlErrorPage } from './shared/isHtmlErrorPage'
import { extractStructuredApiError } from './shared/extractStructuredApiError'
import { requireCanManagePricing } from './shared/pricingStaff'

export interface UpdateTierPriceParams {
  tierId: string
  price: number
}

// Verified live against the deployed backend (2026-09-05): a bare { error: "message" } (no
// success field) comes back for a failure -- e.g. "Tier not found" was returned for a tier id
// that does exist in this app's own database, so the endpoint likely resolves tiers through a
// path that requires the owning service_type to have a synced Stripe product first (none of
// this database's service types have one yet). The { success, tier, stripePriceId } happy-path
// shape below has not been directly observed yet -- it reflects the endpoint's implied contract.
export interface UpdateTierPriceResponse {
  success: boolean
  tier: {
    id: string
    price: string
    [key: string]: unknown
  }
  stripePriceId: string
}

export default async function updateTierPrice(
  req: { params: UpdateTierPriceParams; user: User }
): Promise<UpdateTierPriceResponse> {
  // Session pricing tier prices are part of the band-pricing surface — restricted to staff with
  // can_manage_pricing.
  await requireCanManagePricing(req.user.email)
  const { tierId, price } = req.params

  if (!tierId) {
    throw new Error('tierId is required')
  }
  if (!Number.isFinite(price) || price < 0) {
    throw new Error('price must be a non-negative number')
  }

  // Auth: this endpoint requires `Authorization: Bearer <RETOOL_API_KEY>`. That token must be
  // configured on the "Paddock Backend API" REST resource itself (its authentication settings
  // in Retool), not hardcoded here — same as updateCatalogItemPrice.ts and the other catalog/payment
  // functions. This is the only path for changing a tier's price: the endpoint creates a new
  // Stripe Price and updates the DB price column together atomically.
  try {
    const response = await paddockBackendApi2.rawRequest<UpdateTierPriceResponse>({
      path: '/api/catalog/update-tier-price',
      method: 'POST',
      body: { tierId, price },
    })
    if (isHtmlErrorPage(response.data)) {
      throw new Error(
        'The catalog endpoint returned an HTML page instead of a JSON response, which means this ' +
          'request never reached a real backend — no tier price was changed. Check the "Paddock ' +
          'Backend API" resource\'s base URL.'
      )
    }
    const structuredError = extractStructuredApiError(response.data)
    if (structuredError) {
      throw new Error(structuredError)
    }
    return response.data
  } catch (err) {
    throw new Error(extractApiErrorMessage(err, 'Failed to update tier price'))
  }
}
