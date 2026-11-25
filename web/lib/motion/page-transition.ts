// The page transition's names (W73b; WQ20, WQ22, WQ57), shared by what starts one (a link) and what draws it
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

// W74d (WQ57): each page's background stays solid and still, and only its content moves. A page has a background of
// its own (Surface/Primary, on the element the transition moves), and a section that sets a mode (`data-theme`)
// paints its own surface over it. Just before a page is left, `leavePage` takes those backgrounds out of the page,
// so the browser's picture of it holds its content only, and writes them down as a still layer: the stylesheet
// draws that layer behind the page while it is still there (so nothing is seen to change), and behind its picture
// for the length of the transition (`::view-transition-group(.page-out)`), where the content drifts and fades over it.

/** The CSS variable, on <html>, that holds the surfaces of the page being left: one background layer for each. */
export const PAGE_OUT_SURFACES = '--page-out-surfaces'

/** On the page being left, once its backgrounds are out of it; and on each section whose surface was taken out. */
export const PAGE_LEAVING = 'data-page-leaving'
export const PAGE_SURFACE = 'data-page-surface'

const px = (value: number) => `${Number(value.toFixed(3))}px`

/** A colour as the browser reports it that paints nothing: `transparent`, or any colour at no opacity. */
const paintsNothing = (colour: string) => colour === 'transparent' || /^rgba\(.*,\s*0\)$/.test(colour) || /\/\s*0\)$/.test(colour)

/**
 * A page is about to be left: `page` is the element the transition moves (`[data-page-transition]`), still in the
 * document. Call it before the browser takes its picture of the page; a second call for the same page does nothing.
 *
 * A surface is a section that sets a mode and has a background colour, square-cornered and part of the page's flow
 * (a popup fixed over the page, or a rounded card, is content and moves with it). Each becomes one layer of the
 * still background, at the place it has in the page, so it is right wherever the page is scrolled to.
 */
export function leavePage(page: HTMLElement): void {
  if (page.hasAttribute(PAGE_LEAVING)) return
  const box = page.getBoundingClientRect()
  const layers: string[] = []
  for (const section of page.querySelectorAll<HTMLElement>('[data-theme]')) {
    const style = getComputedStyle(section)
    const at = section.getBoundingClientRect()
    if (paintsNothing(style.backgroundColor) || style.position === 'fixed' || style.visibility === 'hidden') continue
    if (at.width === 0 || at.height === 0 || parseFloat(style.borderTopLeftRadius) > 0) continue
    section.setAttribute(PAGE_SURFACE, '')
    // A section inside another is drawn over it: the first layer of a CSS background is the one on top.
    layers.unshift(`linear-gradient(${style.backgroundColor}, ${style.backgroundColor}) ${px(at.left - box.left)} ${px(at.top - box.top)} / ${px(at.width)} ${px(at.height)} no-repeat`)
  }
  document.documentElement.style.setProperty(PAGE_OUT_SURFACES, layers.length > 0 ? layers.join(', ') : 'none')
  page.setAttribute(PAGE_LEAVING, '')
}

// W75 (WQ60): a link to a place on another page ("All Events", to /exclusive-hire#events). The new page arrives at its
// top as every page does, and once the page transition has ended it scrolls to that place.

/** The id a hash names ("#events" is `events`), or null: no hash, an empty one, or one that can't be read. */
export function hashId(hash: string): string | null {
  const name = hash.startsWith('#') ? hash.slice(1) : hash
  if (!name) return null
  try {
    return decodeURIComponent(name)
  } catch {
    return null
  }
}

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
