import { requireCanManagePricing } from './shared/pricingStaff'
import { isHtmlErrorPage } from './shared/isHtmlErrorPage'
import { extractStructuredApiError } from './shared/extractStructuredApiError'
import { extractApiErrorMessage } from './shared/extractApiErrorMessage'

export interface CreateGiftCardPresetParams {
  giftCardTypeId: string
  amount: number
}

// Verified live against the deployed backend (2026-09-09): a bare { error: "message" } comes
// back for missing/invalid fields (e.g. "Missing required fields: giftCardTypeId, amount (must
// be > 0)"). The happy-path shape has not been directly observed — this endpoint creates a real
// Stripe Price, so it was not exercised with valid data during development; the response is
// returned to the caller as-is either way. This is the only way to create a preset: it creates
// the Stripe Price and the gift_card_presets row together, same pattern as
// createProductVariant.ts / createServiceTypePriceTier.ts's price-confirmation step.
export interface CreateGiftCardPresetResponse {
  [key: string]: unknown
}

export default async function createGiftCardPreset(
  req: { params: CreateGiftCardPresetParams; user: User }
): Promise<CreateGiftCardPresetResponse> {
  // A preset is a price — Manage pricing only.
  await requireCanManagePricing(req.user.email)
  const { giftCardTypeId, amount } = req.params

  if (!giftCardTypeId) {
    throw new Error('giftCardTypeId is required')
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error('amount must be a positive number')
  }

  // Auth: this endpoint requires `Authorization: Bearer <RETOOL_API_KEY>`. That token must be
  // configured on the "Paddock Backend API" REST resource itself (its authentication settings
  // in Retool), not hardcoded here — same as createProductVariant.ts.
  try {
    const response = await paddockBackendApi2.rawRequest<CreateGiftCardPresetResponse>({
      path: '/api/catalog/create-gift-card-preset',
      method: 'POST',
      body: { giftCardTypeId, amount },
    })
    if (isHtmlErrorPage(response.data)) {
      throw new Error(
        'The catalog endpoint returned an HTML page instead of a JSON response, which means this ' +
          'request never reached a real backend — no preset was created. Check the "Paddock ' +
          'Backend API" resource\'s base URL.'
      )
    }
    const structuredError = extractStructuredApiError(response.data)
    if (structuredError) {
      throw new Error(structuredError)
    }
    return response.data
  } catch (err) {
    throw new Error(extractApiErrorMessage(err, 'Failed to create gift card preset'))
  }
}
