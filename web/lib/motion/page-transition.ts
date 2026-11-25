// The page transition's names (W73b; WQ20, WQ22), shared by what starts one (a link) and what draws it
// (components/frame/PageTransition.tsx, and the `page-out` and `page-in` rules in app/globals.css).

/**
 * The transition type a link's navigation carries. Only a navigation with this type is animated: Back and Forward
 * carry none, so they swap the page at once (the browser's own swipe-back picture would otherwise be followed by a
 * second animation, and the scroll position it restores would be fought over).
 */
export const PAGE_TRANSITION = 'page'

/** As Next's <Link transitionTypes> and router.push take it. */
export const PAGE_TRANSITION_TYPES = [PAGE_TRANSITION]

/** The view transition classes of the page going and the page coming: `::view-transition-old(.page-out)`, `::view-transition-new(.page-in)`. */
export const PAGE_OUT = 'page-out'
export const PAGE_IN = 'page-in'

// W74c (WQ52): a link that changes the page where it stands (a product's colour swatch). It carries no transition
// type, so the pages swap at once, and it says here what on the new page is to have focus in place of the heading:
// the visitor's place in the page is kept, as far as a new page can keep it.

let focusOnArrival: { path: string; selector: string } | null = null

/** A link to `path` was pressed: when that page arrives, focus goes to the first element there matching `selector`. */
export function keepFocusOnArrival(path: string, selector: string): void {
  focusOnArrival = { path, selector }
}

/**
 * What the page now arriving at `path` is to focus, if the link that led here asked: once, and only for that page
 * (a link pressed and then not followed, opened in a new tab say, leaves nothing behind for a later page).
 */
export function takeFocusOnArrival(path: string): string | null {
  const asked = focusOnArrival
  focusOnArrival = null
  return asked && asked.path === path ? asked.selector : null
}
