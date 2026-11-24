import type { ShopAvailabilityRouteOutput, ShopSize } from '@/contracts/shop'

// W74: the Product page's sizes, asked again once it has loaded (W74a: GET /api/v1/shop/availability?product=, the
// one public route, no sign-in, never cached). The page's own HTML may be up to a minute old; this is now.

export const availabilityAddress = (product: string): string => `/api/v1/shop/availability?product=${encodeURIComponent(product)}`

const isText = (value: unknown): value is string | null => value === null || typeof value === 'string'

const isSize = (value: unknown): value is ShopSize => {
  if (typeof value !== 'object' || value === null) return false
  const size = value as Record<string, unknown>
  return isText(size.size) && typeof size.available === 'boolean' && isText(size.price) && isText(size.memberPrice) && isText(size.priceBeforeSale) && (size.percentOff === null || typeof size.percentOff === 'number')
}

/**
 * The route's answer (`{ ok: true, data }`) as the page can use it, or null for anything else: a refusal (the product
 * went off sale), another product's answer, or a shape it doesn't know. The page then keeps what it was sent with.
 */
export function availabilityFrom(answer: unknown, product: string): ShopAvailabilityRouteOutput | null {
  if (typeof answer !== 'object' || answer === null) return null
  const { ok, data } = answer as { ok?: unknown; data?: unknown }
  if (ok !== true || typeof data !== 'object' || data === null) return null
  const { product: answered, soldOut, sizes } = data as Record<string, unknown>
  if (answered !== product || typeof soldOut !== 'boolean' || !Array.isArray(sizes) || !sizes.every(isSize)) return null
  return { product, soldOut, sizes }
}

/** The product's sizes now, or null when they could not be had (no network, a refusal): never an error. */
export async function readAvailability(product: string, signal?: AbortSignal): Promise<ShopAvailabilityRouteOutput | null> {
  try {
    const response = await fetch(availabilityAddress(product), { cache: 'no-store', ...(signal ? { signal } : {}) })
    if (!response.ok) return null
    return availabilityFrom(await response.json(), product)
  } catch {
    return null
  }
}
