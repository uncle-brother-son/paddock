/**
 * Extracts a human-readable message from an error thrown by a REST resource call.
 * Some REST clients attach the parsed response body to the error (e.g. `.response.data` or
 * `.data`) — that's where an endpoint's own error text (like a 4xx validation message) would
 * live, so this is tried first; falls back to the error's own message otherwise.
 */
export function extractApiErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) {
    const anyErr = err as unknown as Record<string, unknown>
    const nestedData = (anyErr['response'] as Record<string, unknown> | undefined)?.['data'] ?? anyErr['data']
    if (nestedData && typeof nestedData === 'object') {
      const message = (nestedData as Record<string, unknown>)['message'] ?? (nestedData as Record<string, unknown>)['error']
      if (typeof message === 'string' && message.trim()) return message
    }
    return err.message || fallback
  }
  return fallback
}
