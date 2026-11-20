import { isHtmlErrorPage } from './shared/isHtmlErrorPage'
import { extractStructuredApiError } from './shared/extractStructuredApiError'
import { requireStaffId, resolveStaffId } from './shared/resolveStaffId'
import { insertStockAdjustment } from './shared/stockAdjustments'

export interface CreateProductVariantParams {
  productId: string
  size: string
  sku: string
  /** Optional starting stock; if > 0, a matching "Initial stock" row is written to the ledger. */
  stockQuantity?: number
}

// Verified live against the deployed backend (2026-09-05): a bare { error: "message" } comes
// back when the product has never been synced from Sanity to Stripe, e.g. "Product has no
// Stripe product. Sync from Sanity first." -- every product in this database is currently in
// that state, so the true success shape has not been directly observed yet. Because of that
// uncertainty, this function does not rely on the response body to learn the new variant's id —
// it looks the row up by sku (globally unique) right after a successful call instead.
export interface CreateProductVariantResponse {
  [key: string]: unknown
}

// price_override is intentionally not accepted here — it predates the base/sale/member
// three-tier pricing model and is retired from this app's UI/API surface. The Postgres column
// itself is left alone (it's populated by the external Cloudflare Worker backend, not Retool),
// so this function simply never sends or reads it.
export default async function createProductVariant(
  req: { params: CreateProductVariantParams; user: User }
): Promise<CreateProductVariantResponse> {
  const { productId, size, sku, stockQuantity } = req.params

  // Refuses an inactive account before the variant is created below.
  await resolveStaffId(req.user.email)

  if (!productId || !size.trim() || !sku.trim()) {
    throw new Error('productId, size, and sku are required')
  }
  if (stockQuantity !== undefined && (!Number.isInteger(stockQuantity) || stockQuantity < 0)) {
    throw new Error('stockQuantity must be a non-negative whole number')
  }

  // Auth: the deployed endpoint requires `Authorization: Bearer <RETOOL_API_KEY>`. That token
  // must be configured on the "Paddock Backend API" REST resource itself (its authentication
  // settings in Retool), not hardcoded here — this call relies on the resource applying it
  // automatically to every request, the same way database credentials are never handled in
  // app code.
  const response = await paddockBackendApi2.rawRequest<CreateProductVariantResponse>({
    path: '/api/catalog/create-variant',
    method: 'POST',
    body: {
      productId,
      size: size.trim(),
      sku: sku.trim(),
      ...(stockQuantity !== undefined ? { stockQuantity } : {}),
    },
  })

  if (isHtmlErrorPage(response.data)) {
    throw new Error(
      'The catalog endpoint returned an HTML page instead of a JSON response, which means this ' +
        'request never reached a real backend — no variant was created. Check the "Paddock ' +
        'Backend API" resource\'s base URL.'
    )
  }

  const structuredError = extractStructuredApiError(response.data)
  if (structuredError) {
    throw new Error(structuredError)
  }

  // Log the starting stock as the variant's first ledger entry, so the running total ties out
  // from creation. Looked up by sku (globally unique) rather than trusting an uncertain response
  // shape from the external endpoint.
  if (stockQuantity !== undefined && stockQuantity > 0) {
    const created = await paddockData.query<{ id: string }>(
      'SELECT id FROM product_variants WHERE sku = $1',
      [sku.trim()]
    )
    const newVariantId = created.data[0]?.id
    if (newVariantId) {
      const staffId = await requireStaffId(req.user.email)
      await insertStockAdjustment({
        variantId: newVariantId,
        changeAmount: stockQuantity,
        reason: 'Initial stock',
        staffId,
      })
    }
  }

  return response.data
}
