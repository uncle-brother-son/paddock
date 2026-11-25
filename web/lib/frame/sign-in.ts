// W75: the one place a page asks a visitor to sign in (docs/url-map.md: Sign in is a popup over the page the visitor
// is on, with no address of its own). Accounts are built in the buying stage (WQ5), so it opens nothing yet and says
// so, as addToBag() does for the bag: an Event page's "Sign in" (a members-only event, WQ59) comes here, and nothing
// in it changes when sign-in exists.

/** Opens sign-in over the page. True when it opened; false while there is no sign-in to open. */
export function signIn(): boolean {
  return false
}
