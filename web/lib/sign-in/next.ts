// W85 (backend log 27): where a sign-in goes back to. The email's Sign in button carries the page the visitor started
// from (`next`, Supabase's `{{ .RedirectTo }}`: this site's address and path, W85a decision 6); the link page goes
// there only when it is a page of this site, never another site. Anything else is the home page.

/**
 * The mark /auth/confirm leaves (sessionStorage, this tab) when the email's link has signed someone in: on the page it
 * goes back to, the frame finishes the sign-in (components/frame/SignInHost.tsx): a login with no customer yet is
 * shown Create your account at once, and a refusal its words.
 */
export const FINISH_SIGN_IN = 'paddockFinishSignIn'

/** The path a sign-in goes back to: a path on this site (with its query), from a path or this site's own address. */
export function returnPath(next: string | null | undefined, siteOrigin: string): string {
  if (!next) return '/'
  let address: URL
  try {
    // A path is read against this site; a whole address keeps its own origin, which must be this site's.
    address = new URL(next, siteOrigin)
  } catch {
    return '/'
  }
  if (address.origin !== siteOrigin) return '/'
  // `//elsewhere` and `/\elsewhere` are read by browsers as another site: the URL above has already made them one.
  return `${address.pathname}${address.search}${address.hash}` || '/'
}

/**
 * What the sign-in email's link is told to come back to (Supabase's `emailRedirectTo`): this site's origin and the
 * page's path, with no query string, because an `&` in it would cut the link's `next` short (W85a decision 6).
 */
export function emailReturnAddress(siteOrigin: string, path: string): string {
  const onlyPath = returnPath(path, siteOrigin).split(/[?#]/)[0] ?? '/'
  return `${siteOrigin}${onlyPath}`
}
