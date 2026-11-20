import { isHtmlErrorPage } from './shared/isHtmlErrorPage'
import { extractStructuredApiError } from './shared/extractStructuredApiError'
import { extractApiErrorMessage } from './shared/extractApiErrorMessage'
import { requireCanManagePricing } from './shared/pricingStaff'

export interface UpdateGiftCardPresetPriceParams {
  presetId: string
  amount: number
}

// Verified live against the deployed backend (2026-09-09): a bare { error: "message" } comes
// back for missing fields (e.g. "Missing required fields: presetId, amount"). The happy-path
// shape has not been directly observed — this endpoint creates a new Stripe Price and updates
// the DB amount column together, same pattern as updateTierPrice.ts, so it was not exercised
// with valid data during development. The response is returned to the caller as-is either way.
export interface UpdateGiftCardPresetPriceResponse {
  [key: string]: unknown
}

export default async function updateGiftCardPresetPrice(
  req: { params: UpdateGiftCardPresetPriceParams; user: User }
): Promise<UpdateGiftCardPresetPriceResponse> {
  // Gift card preset amounts are catalog prices — restricted to staff with can_manage_pricing.
  await requireCanManagePricing(req.user.email)
  const { presetId, amount } = req.params

  if (!presetId) {
    throw new Error('presetId is required')
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('amount must be a positive number')
  }

  // Auth: this endpoint requires `Authorization: Bearer <RETOOL_API_KEY>`. That token must be
  // configured on the "Paddock Backend API" REST resource itself (its authentication settings
  // in Retool), not hardcoded here — same as updateTierPrice.ts.
  try {
    const response = await paddockBackendApi2.rawRequest<UpdateGiftCardPresetPriceResponse>({
      path: '/api/catalog/update-gift-card-preset-price',
      method: 'POST',
      body: { presetId, amount },
    })
    if (isHtmlErrorPage(response.data)) {
      throw new Error(
        'The catalog endpoint returned an HTML page instead of a JSON response, which means this ' +
          'request never reached a real backend — no preset price was changed. Check the ' +
          '"Paddock Backend API" resource\'s base URL.'
      )
    }
    const structuredError = extractStructuredApiError(response.data)
    if (structuredError) {
      throw new Error(structuredError)
    }
    return response.data
  } catch (err) {
    throw new Error(extractApiErrorMessage(err, 'Failed to update gift card preset price'))
  }
}
