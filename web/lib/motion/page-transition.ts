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
