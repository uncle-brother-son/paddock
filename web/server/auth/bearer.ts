import 'server-only'

/** The token from an `Authorization: Bearer <token>` header. */
export function bearerToken(headers: Headers): string | null {
  const header = headers.get('authorization')
  return header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null
}
