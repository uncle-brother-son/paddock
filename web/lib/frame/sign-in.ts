// W75: the one place a page asks a visitor to sign in (docs/url-map.md: Sign in is a popup over the page the visitor
// is on, with no address of its own). W85: the frame's sign-in (components/frame/SignInHost.tsx) listens here, so the
// callers (an Event page's "Sign in", the booking panel's AccountBar "Log in", the header's Account) stay as they were
// and the popup opens over the page they are on. Outside the frame (a story of one component) nothing listens, and
// it says so.

export type SignInRequest = {
  /**
   * The page to be on once signed in: a path on this site. Left out, the page the visitor is on, which the popup
   * closes back to. The header's Account gives /account; an /account page asked for while signed out gives its own.
   */
  next?: string
  /** Closing the popup without signing in: what else happens (an /account page asked for while signed out: go home). */
  onGiveUp?: () => void
}

type Opener = (request: SignInRequest) => void

let opener: Opener | null = null

/** The frame's sign-in listens (one at a time); gives back the way to stop. */
export function listenForSignIn(open: Opener): () => void {
  opener = open
  return () => {
    if (opener === open) opener = null
  }
}

/** Opens sign-in over the page. True when it opened; false where there is no sign-in to open (outside the frame). */
export function signIn(request: SignInRequest = {}): boolean {
  if (!opener) return false
  opener(request)
  return true
}
