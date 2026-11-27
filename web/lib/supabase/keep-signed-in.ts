// W85 (Wayne, 30 Nov): "Keep me signed in", the box on the sign-in popup's code step, ticked at first. Ticked (or never
// asked: a link opened from the email), the sign-in lasts until the customer logs out on that device, refreshed in the
// background (backend log 9): Supabase's own cookies, which live 400 days. Unticked, it ends when the browser is
// closed: the same cookies with no lifetime of their own. The choice is a cookie of the site's (`KEEP_SIGNED_IN`, "0"
// for no), itself gone when the browser closes, which the three places that write Supabase's cookies read (the
// browser's client, the server's and middleware.ts), so a refresh never turns a sign-in for this visit into a lasting
// one. No Supabase package is loaded here (server/no-service-role-key.test.ts).

/** The site's cookie that says the sign-in ends with the browser: "0". Not there (or anything else): it lasts. */
export const KEEP_SIGNED_IN = 'paddock-keep-signed-in'

type Named = { name: string; value: string }

/** Whether the sign-in lasts until log out, from the request's cookies. */
export function keepsSignedIn(cookies: readonly Named[]): boolean {
  return cookies.find((cookie) => cookie.name === KEEP_SIGNED_IN)?.value !== '0'
}

/** A cookie's options as Supabase gives them: only the lifetime is looked at. */
type Lifetime = { maxAge?: number; expires?: Date }

/**
 * The options a Supabase cookie is written with on this device: as given while the sign-in lasts; otherwise with no
 * lifetime, so the browser drops it when it closes. A cookie being taken away (a lifetime of 0, or a date passed) is
 * always written as given, or it would stay until the browser closed.
 */
export function forThisDevice<Options extends Lifetime>(options: Options, keep: boolean): Options {
  if (keep) return options
  const removing = options.maxAge !== undefined && options.maxAge <= 0
  const expired = options.expires !== undefined && options.expires.getTime() <= Date.now()
  if (removing || expired) return options
  const forVisit: Options = { ...options }
  delete forVisit.maxAge
  delete forVisit.expires
  return forVisit
}

/** What the browser is given to note the choice: a cookie for this visit only, or the same name taken away. */
export function keepSignedInCookie(keep: boolean): string {
  return keep ? `${KEEP_SIGNED_IN}=; Path=/; Max-Age=0; SameSite=Lax` : `${KEEP_SIGNED_IN}=0; Path=/; SameSite=Lax`
}
