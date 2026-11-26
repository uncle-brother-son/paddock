'use client'

import { useLenis } from 'lenis/react'
import { usePathname } from 'next/navigation'
import * as React from 'react'
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'

import { animatesHistoryStep, hashId, leavePage, PAGE_AT_ONCE, PAGE_IN, PAGE_IN_ABOVE, PAGE_OUT, PAGE_TRANSITION, pageOf, takeArrivalInPlace, type HistoryStepEvent } from '@/lib/motion/page-transition'
import { REDUCED_MOTION } from '@/lib/motion/reduced-motion'
import { DURATION_LONG, EASE_SMOOTH } from '@/lib/motion/tokens'

/**
 * React's <ViewTransition>. It is in the React that Next's App Router runs the site on ("View transitions work in
 * the App Router with no configuration"), and not yet in the released React that Storybook and the unit tests load:
 * there a page is swapped at once, and the Storybook page plays the same CSS through the browser's own API.
 */
const ViewTransition = (React as { ViewTransition?: typeof React.ViewTransition }).ViewTransition

// W78a (WQ68): a link carries the page transition's type; Back and Forward carry none and are animated the same
// (`default`). Only a navigation that says "at once" swaps the page with no animation (WQ52: a colour swatch).
const ENTER = { [PAGE_TRANSITION]: PAGE_IN, [PAGE_AT_ONCE]: 'none', default: PAGE_IN }
const EXIT = { [PAGE_TRANSITION]: PAGE_OUT, [PAGE_AT_ONCE]: 'none', default: PAGE_OUT }

type RunningTransition = { ready: Promise<unknown>; finished: Promise<unknown>; skipTransition: () => void }

/** A Back or Forward step the site is animating: the browser's own restoring of the scroll, and the end of the step. */
type HeldStep = { scroll: () => void; release: () => void }

const runningTransition = (): RunningTransition | null => (document as Document & { activeViewTransition?: RunningTransition | null }).activeViewTransition ?? null

/**
 * W75 (WQ60): scrolls the page to a place on it that a link named ("All Events", to /exclusive-hire#events), once
 * the page transition has ended: smoothly with Lenis, over the long duration with the smooth curve; with reduced
 * motion on (Lenis is not running) it jumps there. A frame is waited first, so a transition that is starting is seen.
 */
function scrollToPlace(place: HTMLElement, lenis: ReturnType<typeof useLenis>) {
  const go = () => {
    if (!place.isConnected) return
    if (lenis) lenis.scrollTo(place, { duration: DURATION_LONG, easing: EASE_SMOOTH })
    else place.scrollIntoView()
  }
  requestAnimationFrame(() => {
    const running = runningTransition()
    if (running) running.finished.then(go, go)
    else go()
  })
}

const NOTHING_TO_FORGET = (): void => {}

/**
 * W78b (WQ52, as amended again): a page that arrived in place (a product's colour swatch swaps the page where it
 * stands) scrolls to its top: smoothly with Lenis, over the long duration with the smooth curve; with reduced motion
 * on (Lenis is not running) it jumps there. `then` is called once, when the scroll has ended: at the top, or when
 * the visitor takes the scrolling over with a wheel or a touch (Lenis drops its own scroll there, and never says it
 * finished). The function it gives back forgets the scroll: nothing is called after it.
 */
function scrollToTop(lenis: ReturnType<typeof useLenis>, then: () => void): () => void {
  if (!lenis) {
    window.scrollTo(0, 0)
    then()
    return NOTHING_TO_FORGET
  }
  let over = false
  const forget = () => {
    over = true
    window.removeEventListener('wheel', end, true)
    window.removeEventListener('touchmove', end, true)
  }
  function end() {
    if (over) return
    forget()
    then()
  }
  window.addEventListener('wheel', end, { capture: true, passive: true })
  window.addEventListener('touchmove', end, { capture: true, passive: true })
  lenis.scrollTo(0, { duration: DURATION_LONG, easing: EASE_SMOOTH, force: true, onComplete: end })
  return forget
}

/**
 * What happens on arriving at a page by a navigation inside the site (never on the first load):
 * - a link: the new page starts at its top, with Lenis told so (it would otherwise glide on towards where it was
 *   heading on the old page). Back and Forward arrive where the browser puts them (W78a: for a step the site
 *   animates, the browser is asked to put the window there as the new page comes in), and only stop a glide;
 * - a link to a place on the page (its address ends in #events): the page starts at its top all the same, and
 *   scrolls to that place once the page transition has ended (W75; WQ60);
 * - focus moves to the new page's h1 (or to main when it has none), without scrolling, so a keyboard or a screen
 *   reader starts from the new page. Next's own announcer reads the new page's title out;
 * - a link that changed the page where it stood (WQ52, as amended again: a product's colour swatch): the new page
 *   comes with the window where it was, scrolls to its top (`scrollToTop`), and focus goes to its h1, the product's
 *   name, once the scroll has ended;
 * - a press during a page transition ends it at once: what is pressed is then the page as it now is, so a second
 *   click made mid-way goes to its own page.
 */
function usePageArrival(page: string) {
  const lenis = useLenis()
  const arrived = useRef(page)
  const byHistory = useRef(false)
  // W78a (WQ68): the Back or Forward step now under way that the site animates itself, until its page has arrived.
  const step = useRef<HeldStep | null>(null)
  // W78b (WQ52): forgets the scroll to the top of a page that arrived in place, while it is still under way.
  const forgetScroll = useRef(NOTHING_TO_FORGET)

  useEffect(() => {
    let endedByPress = false
    // W77: Back from the Book panel's own history step stays on the page (WQ64): no page arrives, so nothing is noted
    // for the next one that does.
    const noteHistory = () => {
      byHistory.current = pageOf(window.location.pathname) !== arrived.current
    }
    // W78a (WQ68): Back and Forward to another page are animated (lib/motion/page-transition.ts says how and when).
    // The step is intercepted with its scrolling kept back, and stays under way until its page has arrived.
    const holdStep = (event: Event) => {
      const stepEvent = event as Event & HistoryStepEvent
      // Next writes its own note on the entry it has arrived at (a `replace` of the same address): not a new step.
      if (stepEvent.navigationType === 'replace') return
      step.current?.release()
      step.current = null
      if (!animatesHistoryStep(stepEvent, arrived.current, window.matchMedia(REDUCED_MOTION).matches)) return
      let release = () => {}
      const arrival = new Promise<void>((resolve) => {
        release = resolve
      })
      stepEvent.intercept({ scroll: 'manual', focusReset: 'manual', handler: () => arrival })
      step.current = { scroll: () => stepEvent.scroll(), release }
    }
    // Its `popstate` is kept from Next and given to it again in a task of its own: outside the browser's event React
    // treats the step as it does a link's navigation, and animates it. Next reads only the event's state.
    const again = new WeakSet<Event>()
    const holdPopstate = (event: PopStateEvent) => {
      if (!step.current || again.has(event)) return
      event.stopImmediatePropagation()
      const { state } = event
      setTimeout(() => {
        const replay = new PopStateEvent('popstate', { state })
        again.add(replay)
        window.dispatchEvent(replay)
      })
    }
    const navigation = (window as Window & { navigation?: EventTarget }).navigation
    navigation?.addEventListener('navigate', holdStep)
    if (navigation) window.addEventListener('popstate', holdPopstate, true)
    const endTransition = () => {
      const running = runningTransition()
      endedByPress = Boolean(running)
      // Only once it is animating: ending it earlier would be an error to React, which is still putting the page in.
      running?.ready.then(() => running.skipTransition()).catch(() => undefined)
    }
    // While a transition runs the browser shows pictures of the pages, so the press that ended it began on the
    // document itself and its click comes here addressed to the document. It is handed on to what is under the
    // pointer now that the page is there: a link pressed mid-way is followed.
    const handOn = (event: MouseEvent) => {
      if (!endedByPress) return
      endedByPress = false
      if (event.target !== document.documentElement) return
      const under = document.elementFromPoint(event.clientX, event.clientY)
      if (under instanceof HTMLElement && under !== document.documentElement && under !== document.body) under.click()
    }
    window.addEventListener('popstate', noteHistory)
    window.addEventListener('pointerdown', endTransition, true)
    window.addEventListener('click', handOn, true)
    return () => {
      navigation?.removeEventListener('navigate', holdStep)
      window.removeEventListener('popstate', holdPopstate, true)
      window.removeEventListener('popstate', noteHistory)
      window.removeEventListener('pointerdown', endTransition, true)
      window.removeEventListener('click', handOn, true)
    }
  }, [])

  useLayoutEffect(() => {
    if (arrived.current === page) return
    arrived.current = page
    // W78a (WQ68): the new page is in, and the browser has not pictured it yet: the browser now puts the window
    // where this entry was left (its own restoring, kept back until here), and the step is over.
    const held = step.current
    step.current = null
    if (held && byHistory.current) {
      try {
        held.scroll()
      } catch {
        // The step was overtaken by another, or the browser has already scrolled: there is nothing to restore.
      }
    }
    held?.release()
    // W78b (WQ52): a page that arrives in place (a colour swatch's) stays where the window is, and goes to its top
    // by itself afterwards. Asked for every arrival, so what a link said is never left for a later page.
    const saidInPlace = takeArrivalInPlace(page)
    const inPlace = saidInPlace && !byHistory.current
    const top = byHistory.current || inPlace ? window.scrollY : 0
    document.documentElement.style.setProperty(PAGE_IN_ABOVE, `${top}px`)
    // W75 (WQ60): a link that names a place on the new page. Back and Forward keep the place the browser puts them.
    const placeId = byHistory.current ? null : hashId(window.location.hash)
    byHistory.current = false
    if (lenis) lenis.scrollTo(top, { immediate: true, force: true })
    else if (top === 0) window.scrollTo(0, 0)
    const place = placeId ? document.getElementById(placeId) : null
    if (place) scrollToPlace(place, lenis)

    const main = document.getElementById('main')
    const heading = main?.querySelector('h1') ?? null
    if (heading && !heading.hasAttribute('tabindex')) {
      // Focus by script only, never in the Tab order; a heading shows no ring (it is not a control).
      heading.tabIndex = -1
      heading.style.outline = 'none'
    }
    const toHeading = () => (heading ?? main)?.focus({ preventScroll: true })
    // An earlier page's scroll to its top, still under way, is that page's: this one starts afresh.
    forgetScroll.current()
    // WQ52: the page that came in place scrolls to its top, and only then does focus go to its heading (the product's name).
    forgetScroll.current = inPlace ? scrollToTop(lenis, toHeading) : NOTHING_TO_FORGET
    if (!inPlace) toHeading()
  }, [page, lenis])
}

/**
 * Where the pages stand: the one element round whichever page is shown, which stays while they change (WQ57).
 *
 * It is a class for `getSnapshotBeforeUpdate`, the one moment React gives before it changes the document: the page
 * about to be left is still there, and the browser has not yet taken its picture of it for the transition. That is
 * when `leavePage` takes the page's backgrounds out of it and writes them down as the still layer, which the
 * stylesheet draws on this element until the page is gone, and behind the page's picture after that.
 */
class PageStage extends React.Component<{ page: string; children: ReactNode }> {
  private readonly stage = React.createRef<HTMLDivElement>()

  override getSnapshotBeforeUpdate(before: { page: string }): null {
    const leaving = before.page === this.props.page ? null : this.stage.current?.querySelector<HTMLElement>(':scope > [data-page-transition]')
    if (leaving) leavePage(leaving)
    return null
  }

  // React asks for this beside getSnapshotBeforeUpdate; there is nothing to do once the new page is in.
  override componentDidUpdate(): void {}

  override render(): ReactNode {
    return (
      <div ref={this.stage} data-page-stage="" className="flex flex-1 flex-col">
        {this.props.children}
      </div>
    )
  }
}

/**
 * One page of the site as the page transition sees it (W73b; WQ20, WQ57; W78a: WQ67, WQ68): everything that changes
 * from page to page, which is main and the footer; the header stays where it is. `page` names the page shown: when it
 * changes, the old page leaves and the new one comes in, animated by the `page-out` and `page-in` rules in
 * app/globals.css over the long duration with the smooth curve: for every link inside the site
 * (components/ui/SiteLink.tsx), and for the browser's Back and Forward. Reduced motion, and a link that asks for no
 * transition (WQ52: a colour swatch): the page is swapped at once.
 *
 * The page has a solid background of its own (Surface/Primary, the colour of the window behind it), so the page
 * coming in covers the one being left wherever it has come in.
 */
export function PageTransitionView({ page, children }: { page: string; children: ReactNode }) {
  usePageArrival(page)
  const content = (
    <div key={page} data-page-transition="" className="flex flex-1 flex-col bg-surface-primary">
      {children}
    </div>
  )
  if (!ViewTransition) return <PageStage page={page}>{content}</PageStage>
  return (
    <PageStage page={page}>
      <ViewTransition key={page} enter={ENTER} exit={EXIT} default="none">
        {content}
      </ViewTransition>
    </PageStage>
  )
}

/**
 * The page transition on the site: the page is the address's path, so a change of query alone moves nothing. W77:
 * /book is the home page with the Book panel over it, so it counts as the home page's own path (`pageOf`).
 */
export function PageTransition({ children }: { children: ReactNode }) {
  return <PageTransitionView page={pageOf(usePathname())}>{children}</PageTransitionView>
}
