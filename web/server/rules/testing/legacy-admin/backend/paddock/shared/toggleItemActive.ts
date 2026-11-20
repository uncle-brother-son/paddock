import { extractApiErrorMessage } from './extractApiErrorMessage'
import { isHtmlErrorPage } from './isHtmlErrorPage'
import { extractStructuredApiError } from './extractStructuredApiError'

export type ToggleableItemType =
  | 'service_type'
  | 'product'
  | 'addon'
  | 'membership_plan'
  | 'session_pass_type'
  | 'gift_card_type'
  | 'gift_card_preset'

export interface ToggleItemActiveResult {
  id: string
  active: boolean
  [key: string]: unknown
}

// Verified live against the deployed backend (2026-09-05): success is
// `{ success: true, item: {...} }` with `item` the full updated row (real Postgres column
// names). Failure is a bare `{ error: "message" }` with no `success` field at all — e.g.
// "Item has no Stripe product. Sync from Sanity first." when the item was never synced from
// Sanity to Stripe.
interface ToggleActiveResponse {
  success: boolean
  item: ToggleItemActiveResult
}

/**
 * Toggles a catalog item's `active` flag via the deployed backend's /api/catalog/toggle-active
 * endpoint, so Stripe's Product/Price active state stays in sync with Postgres. This must never
 * be replaced with a direct `paddockData` UPDATE — that's exactly what caused the drift this
 * endpoint exists to prevent.
 */
export async function toggleItemActive(
  itemType: ToggleableItemType,
  itemId: string,
  active: boolean
): Promise<ToggleItemActiveResult> {
  if (!itemId) {
    throw new Error('itemId is required')
  }

  // Auth: this endpoint requires `Authorization: Bearer <RETOOL_API_KEY>`. That token must be
  // configured on the "Paddock Backend API" REST resource itself (its authentication settings
  // in Retool), not hardcoded here — same as createProductVariant.ts and updateCatalogItemPrice.ts.
  try {
    const response = await paddockBackendApi2.rawRequest<ToggleActiveResponse>({
      path: '/api/catalog/toggle-active',
      method: 'POST',
      body: { itemType, itemId, active },
    })
    if (isHtmlErrorPage(response.data)) {
      throw new Error(
        'The catalog endpoint returned an HTML page instead of a JSON response, which means this ' +
          'request never reached a real backend — the active flag was not changed. Check the ' +
          '"Paddock Backend API" resource\'s base URL.'
      )
    }
    const structuredError = extractStructuredApiError(response.data)
    if (structuredError) {
      throw new Error(structuredError)
    }
    return response.data.item
  } catch (err) {
    throw new Error(extractApiErrorMessage(err, 'Failed to update active status'))
  }
}
