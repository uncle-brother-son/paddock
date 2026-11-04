import 'server-only'

export interface RequestLogEntry {
  event: 'api_request'
  requestId: string
  route: string
  method: string
  /** "staff:<id>", "customer:<id>", "public", or null if authentication failed. */
  actor: string | null
  status: number
  durationMs: number
  errorCode: string | null
  /** INTERNAL failures only: the real error, redacted. */
  errorDetail?: string
}

const MAX_DETAIL_LENGTH = 500

/** Error text can quote the values involved, so take out anything personal or secret. */
export function redactForLog(text: string): string {
  return text
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)?/g, '[token]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [token]')
    .replace(/[^\s@"'<>()]+@[^\s@"'<>()]+\.[^\s@"'<>()]+/g, '[email]')
    .replace(/\b(?:\d[ -]?){12,19}\b/g, '[number]')
    .slice(0, MAX_DETAIL_LENGTH)
}

/** One JSON line per request. Wrangler observability keeps these. */
export function writeRequestLog(entry: RequestLogEntry): void {
  const line = JSON.stringify(entry)
  if (entry.status >= 500) console.error(line)
  else console.log(line)
}
