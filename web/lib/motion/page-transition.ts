import { BOOK_ADDRESS } from '@/lib/sanity/links'

// The page transition's names (W73b; WQ20, WQ22, WQ57), shared by what starts one (a link) and what draws it
// (components/frame/PageTransition.tsx, and the `page-out` and `page-in` rules in app/globals.css).

/**
 * The transition type a link's navigation carries. W78a (WQ68, amends WQ22): the browser's Back and Forward carry no
 * type and are animated as a link is, so every arrival at a new page is, but the one that says it is not to be.
 */
export const PAGE_TRANSITION = 'page'

/**
 * The type of a navigation that swaps the page at once (WQ52: a product's colour swatch, the only one). It has to
 * say so: a navigation with no type is Back or Forward, which is animated.
 */
export const PAGE_AT_ONCE = 'page-at-once'

/**
 * W77 (WQ64): the page an address's path shows, which is what the page transition is keyed by. /book is the home page
 * with the booking panel open over it, so it is the home page's own: closing the panel there changes the address to /
 * where the page stands, and the page is neither swapped nor drawn again.
 */
export const pageOf = (path: string): string => (path === BOOK_ADDRESS ? '/' : path)

/** As Next's <Link transitionTypes> and router.push take it. */
export const PAGE_TRANSITION_TYPES = [PAGE_TRANSITION]
export const PAGE_AT_ONCE_TYPES = [PAGE_AT_ONCE]

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

/**
 * W78a (WQ67, WQ68): the CSS variable, on <html>, that says how much of the page coming in lies above the window
 * (0 for a link, which arrives at the top; where the browser put it for Back and Forward). The browser's picture of
 * the new page is the whole page, and it starts a window's height down: without this, what is above the window
 * would be seen passing through it on the way up. It is not drawn while the page moves, as it is not once it rests.
 */
export const PAGE_IN_ABOVE = '--page-in-above'

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
  // W80 (WQ87): a page whose own theme is not Light (components/modules/PageTheme.tsx) is the first surface, under
  // every section's: the window behind it is Light, and would show as the page's background is taken out.
  const themed = [...(page.matches('[data-theme]') ? [page] : []), ...page.querySelectorAll<HTMLElement>('[data-theme]')]
  for (const section of themed) {
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

// W78a (WQ68): the browser's Back and Forward are animated as a link is. Two things stand in the way, and
// components/frame/PageTransition.tsx gets round both with the browser's Navigation API:
//   - React draws a history step at once, inside the browser's own `popstate` event, and starts no view transition
//     there. So the step's `popstate` is held and given to Next a moment later, outside that event: Next restores the
//     page as it always does, and React animates it as it does a link's;
//   - the browser puts the window where that entry was left straight after `popstate`, which would move the page
//     still on screen. So the step is intercepted with its scrolling kept back (`scroll: 'manual'`), and the browser
//     is asked to do it (`NavigateEvent.scroll()`: its own restoring, to its own place) once the new page is in.
// A browser without the Navigation API, reduced motion, and a step the browser animated itself (a phone's swipe:
// `hasUAVisualTransition`) are left exactly as the browser and React do them: at once.

/** The part of the Navigation API's `navigate` event that the page transition reads (TypeScript's own DOM types have none yet). */
export type HistoryStepEvent = {
  navigationType: string
  canIntercept: boolean
  hasUAVisualTransition?: boolean
  destination: { url: string }
  intercept: (options: { scroll: 'manual'; focusReset: 'manual'; handler: () => Promise<void> }) => void
  scroll: () => void
}

/**
 * Whether a step through history is one the site animates itself: Back or Forward to another page of this document.
 * Not a step that stays on the page (W77: the booking panel's own step; a list's category or sort), not one the browser
 * has already animated, and not with reduced motion.
 */
export function animatesHistoryStep(step: Pick<HistoryStepEvent, 'navigationType' | 'canIntercept' | 'hasUAVisualTransition' | 'destination'>, pageNow: string, reducedMotion: boolean): boolean {
  if (reducedMotion || step.navigationType !== 'traverse' || !step.canIntercept || step.hasUAVisualTransition === true) return false
  try {
    return pageOf(new URL(step.destination.url).pathname) !== pageNow
  } catch {
    return false
  }
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

// W74c, W78b (WQ52, as amended again): a link that changes the page where it stands (a product's colour swatch). It
// carries the "at once" type, so the pages swap at once, with the window left where it is; and it says here that the
// page it leads to arrives in place: the window then scrolls smoothly to the page's top, and focus goes to the page's
// heading (the product's name) once it is there (components/frame/PageTransition.tsx).

let arrivingInPlace: string | null = null

/** A link to `path` that changes the page where it stands was pressed: that page is to arrive in place. */
export function arriveInPlace(path: string): void {
  arrivingInPlace = path
}

/**
 * Whether the page now arriving at `path` arrives in place, because the link that led here said so: asked once, and
 * true only for that page (a link pressed and then not followed, opened in a new tab say, leaves nothing behind for
 * a later page).
 */
export function takeArrivalInPlace(path: string): boolean {
  const asked = arrivingInPlace
  arrivingInPlace = null
  return asked !== null && asked === path
}
