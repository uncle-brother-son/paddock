/**
 * Detects a real (non-HTML) JSON error response from the deployed backend. Confirmed real
 * shapes seen from the live backend: a bare `{ error: "message" }` on failure (no `success`
 * field at all, sometimes with a `details` string alongside it — e.g. `{ error: "Failed to
 * create variant", details: "permission denied for table product_variants" }`), versus
 * `{ success: true, item: {...} }` on success. Some endpoints may also use
 * `{ success: false, message: "..." }` — handled here too, just in case.
 */
export function extractStructuredApiError(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null
  const obj = data as Record<string, unknown>
  if (typeof obj['error'] === 'string' && obj['error'].trim()) {
    const details = obj['details']
    if (typeof details === 'string' && details.trim()) {
      return `${obj['error']}: ${details}`
    }
    return obj['error']
  }
  if (obj['success'] === false) {
    const message = obj['message']
    return typeof message === 'string' && message.trim() ? message : 'Request failed'
  }
  return null
}
