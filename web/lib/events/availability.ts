import type { ShopEventAvailabilityRouteOutput, ShopEventState } from '@/contracts/shop'

// W75: an Event page's spaces, state and prices, asked again once it has loaded (W75a:
// GET /api/v1/shop/event-availability?event=, a public route, no sign-in, never cached). The page's own HTML may be
// up to a minute old; this is now.

export const eventAvailabilityAddress = (event: string): string => `/api/v1/shop/event-availability?event=${encodeURIComponent(event)}`

const STATES: readonly ShopEventState[] = ['open', 'sold_out', 'not_released_yet', 'members_only', 'started', 'cancelled']

const isText = (value: unknown): value is string | null => value === null || typeof value === 'string'
const isState = (value: unknown): value is ShopEventState => (STATES as readonly unknown[]).includes(value)

/**
 * The route's answer (`{ ok: true, data }`) as the page can use it, or null for anything else: a refusal (the event
 * went off sale), another event's answer, or a shape it doesn't know. The page then keeps what it was sent with.
 */
export function eventAvailabilityFrom(answer: unknown, event: string): ShopEventAvailabilityRouteOutput | null {
  if (typeof answer !== 'object' || answer === null) return null
  const { ok, data } = answer as { ok?: unknown; data?: unknown }
  if (ok !== true || typeof data !== 'object' || data === null) return null
  const { event: answered, spacesLeft, state, publicReleaseAt, price, memberPrice } = data as Record<string, unknown>
  if (answered !== event || typeof spacesLeft !== 'number' || !Number.isInteger(spacesLeft) || spacesLeft < 0) return null
  if (!isState(state) || !isText(publicReleaseAt) || !isText(price) || !isText(memberPrice)) return null
  return { event, spacesLeft, state, publicReleaseAt, price, memberPrice }
}

/** The event's spaces, state and prices now, or null when they could not be had (no network, a refusal): never an error. */
export async function readEventAvailability(event: string, signal?: AbortSignal): Promise<ShopEventAvailabilityRouteOutput | null> {
  try {
    const response = await fetch(eventAvailabilityAddress(event), { cache: 'no-store', ...(signal ? { signal } : {}) })
    if (!response.ok) return null
    return eventAvailabilityFrom(await response.json(), event)
  } catch {
    return null
  }
}
