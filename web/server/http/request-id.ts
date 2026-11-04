import 'server-only'

const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/

/** The caller's X-Request-Id when it looks like one (it reaches the logs), else a new uuid. */
export function resolveRequestId(headers: Headers): string {
  const given = headers.get('x-request-id')
  return given && REQUEST_ID.test(given) ? given : crypto.randomUUID()
}
