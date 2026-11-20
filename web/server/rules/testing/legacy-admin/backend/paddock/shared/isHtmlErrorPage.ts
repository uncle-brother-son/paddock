/**
 * Detects when a `rawRequest` response body is actually an HTML error/challenge page (e.g. a
 * hosting platform's 403/404 page) rather than real JSON data from an API. This resource's
 * `rawRequest` never throws on non-2xx statuses and never exposes the HTTP status code — a
 * non-JSON body just comes back as `{ message: "<the raw text>" }` — so this is the only
 * available signal that a call silently hit the wrong thing instead of a real API.
 */
export function isHtmlErrorPage(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false
  const message = (data as Record<string, unknown>)['message']
  if (typeof message !== 'string') return false
  const trimmed = message.trim().toLowerCase()
  return trimmed.startsWith('<!doctype html') || trimmed.startsWith('<html')
}
