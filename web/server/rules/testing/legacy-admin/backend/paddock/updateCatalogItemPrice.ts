import { extractApiErrorMessage } from './shared/extractApiErrorMessage'
import { isHtmlErrorPage } from './shared/isHtmlErrorPage'
import { extractStructuredApiError } from './shared/extractStructuredApiError'
import { requireCanManagePricing } from './shared/pricingStaff'

export type PricedItemType = 'service_type' | 'product' | 'addon' | 'membership_plan' | 'session_pass_type'

export interface UpdateCatalogItemPriceParams {
  itemType: PricedItemType
  itemId: string
  basePrice?: number
  memberPrice?: number
  salePrice?: number
  /** membership_plan only: the Worker archives + recreates the monthly Stripe price and writes price_monthly. */
  monthlyPrice?: number
  /** membership_plan only: the Worker archives + recreates (or creates) the yearly Stripe price and writes price_yearly. */
  yearlyPrice?: number
}

// Verified live against the deployed backend (2026-09-05): a bare { error: "message" } (no
// success field) comes back when the item has never been synced from Sanity to Stripe, e.g.
// "Item has no Stripe product. Sync from Sanity first." -- every catalog item in this database
// is currently in that state, so the { success, item, pricesUpdated } happy-path shape below
// reflects the endpoint's implied contract, not a directly observed success response yet.
export interface UpdateCatalogItemPriceResponse {
  success: boolean
  item: {
    id: string
    price?: string
    base_price?: string
    member_price?: string | null
    sale_price?: string | null
    [key: string]: unknown
  }
  pricesUpdated: Record<string, unknown>
}

// Calls the deployed catalog price endpoint; never writes prices to Postgres directly.
export default async function updateCatalogItemPrice(
  req: { params: UpdateCatalogItemPriceParams; user: User }
): Promise<UpdateCatalogItemPriceResponse> {
  // Catalog price edits (products, add-ons, membership plans, session passes, service types)
  // are restricted to staff with can_manage_pricing — same rule as the band pricing page.
  await requireCanManagePricing(req.user.email)
  const { itemType, itemId, basePrice, memberPrice, salePrice, monthlyPrice, yearlyPrice } = req.params

  if (!itemId) {
    throw new Error('itemId is required')
  }
  if (
    basePrice === undefined &&
    memberPrice === undefined &&
    salePrice === undefined &&
    monthlyPrice === undefined &&
    yearlyPrice === undefined
  ) {
    throw new Error('At least one price field must be provided')
  }
  for (const [label, value] of [
    ['basePrice', basePrice],
    ['memberPrice', memberPrice],
    ['salePrice', salePrice],
    ['monthlyPrice', monthlyPrice],
    ['yearlyPrice', yearlyPrice],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new Error(`${label} must be a non-negative number`)
    }
  }

  // Auth: this endpoint requires `Authorization: Bearer <RETOOL_API_KEY>`. That token must be
  // configured on the "Paddock Backend API" REST resource itself (its authentication settings
  // in Retool), not hardcoded here — same as createProductVariant.ts, refundBooking.ts, and
  // chargeSavedCard.ts. Price changes never write to Postgres directly from Retool: this call
  // is the only path, since the endpoint creates a new Stripe Price and updates the DB price
  // column together atomically.
  try {
    const response = await paddockBackendApi2.rawRequest<UpdateCatalogItemPriceResponse>({
      path: '/api/catalog/update-price',
      method: 'POST',
      body: {
        itemType,
        itemId,
        ...(basePrice !== undefined ? { basePrice } : {}),
        ...(memberPrice !== undefined ? { memberPrice } : {}),
        ...(salePrice !== undefined ? { salePrice } : {}),
        ...(monthlyPrice !== undefined ? { monthlyPrice } : {}),
        ...(yearlyPrice !== undefined ? { yearlyPrice } : {}),
      },
    })
    if (isHtmlErrorPage(response.data)) {
      throw new Error(
        'The catalog endpoint returned an HTML page instead of a JSON response, which means this ' +
          'request never reached a real backend — no price was changed. Check the "Paddock ' +
          'Backend API" resource\'s base URL.'
      )
    }
    const structuredError = extractStructuredApiError(response.data)
    if (structuredError) {
      throw new Error(structuredError)
    }
    return response.data
  } catch (err) {
    throw new Error(extractApiErrorMessage(err, 'Failed to update price'))
  }
}
