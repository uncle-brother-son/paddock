'use client'

import { useLenis } from 'lenis/react'
import { usePathname } from 'next/navigation'
import * as React from 'react'
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'

import { hashId, leavePage, PAGE_IN, PAGE_OUT, PAGE_TRANSITION, takeFocusOnArrival } from '@/lib/motion/page-transition'
import { DURATION_LONG, EASE_SMOOTH } from '@/lib/motion/tokens'

/**
 * React's <ViewTransition>. It is in the React that Next's App Router runs the site on ("View transitions work in
 * the App Router with no configuration"), and not yet in the released React that Storybook and the unit tests load:
 * there a page is swapped at once, and the Storybook page plays the same CSS through the browser's own API.
 */
const ViewTransition = (React as { ViewTransition?: typeof React.ViewTransition }).ViewTransition

const ENTER = { [PAGE_TRANSITION]: PAGE_IN, default: 'none' }
const EXIT = { [PAGE_TRANSITION]: PAGE_OUT, default: 'none' }

type RunningTransition = { ready: Promise<unknown>; finished: Promise<unknown>; skipTransition: () => void }

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

/**
 * What happens on arriving at a page by a navigation inside the site (never on the first load):
 * - a link: the new page starts at its top, with Lenis told so (it would otherwise glide on towards where it was
 *   heading on the old page). Back and Forward keep the place the browser puts them, and only stop a glide;
 * - a link to a place on the page (its address ends in #events): the page starts at its top all the same, and
 *   scrolls to that place once the page transition has ended (W75; WQ60);
 * - focus moves to the new page's h1 (or to main when it has none), without scrolling, so a keyboard or a screen
 *   reader starts from the new page. Next's own announcer reads the new page's title out. A link that changed the
 *   page where it stood (WQ52: a product's colour swatch) keeps focus on what it asked for instead;
 * - a press during a page transition ends it at once: what is pressed is then the page as it now is, so a second
 *   click made mid-way goes to its own page.
 */
function usePageArrival(page: string) {
  const lenis = useLenis()
  const arrived = useRef(page)
  const byHistory = useRef(false)

  useEffect(() => {
    let endedByPress = false
    const noteHistory = () => {
      byHistory.current = true
    }
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
      window.removeEventListener('popstate', noteHistory)
      window.removeEventListener('pointerdown', endTransition, true)
      window.removeEventListener('click', handOn, true)
    }
  }, [])

  useLayoutEffect(() => {
    if (arrived.current === page) return
    arrived.current = page
    const top = byHistory.current ? window.scrollY : 0
    // W75 (WQ60): a link that names a place on the new page. Back and Forward keep the place the browser puts them.
    const placeId = byHistory.current ? null : hashId(window.location.hash)
    byHistory.current = false
    if (lenis) lenis.scrollTo(top, { immediate: true, force: true })
    else if (top === 0) window.scrollTo(0, 0)
    const place = placeId ? document.getElementById(placeId) : null
    if (place) scrollToPlace(place, lenis)

    const main = document.getElementById('main')
    // WQ52: a link that changed the page where it stood (a colour swatch) keeps focus on its like in the new page.
    const kept = takeFocusOnArrival(page)
    const keeper = kept ? (main?.querySelector<HTMLElement>(kept) ?? null) : null
    if (keeper) {
      keeper.focus({ preventScroll: true })
      return
    }
    const heading = main?.querySelector('h1') ?? null
    if (heading && !heading.hasAttribute('tabindex')) {
      // Focus by script only, never in the Tab order; a heading shows no ring (it is not a control).
      heading.tabIndex = -1
      heading.style.outline = 'none'
    }
    ;(heading ?? main)?.focus({ preventScroll: true })
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
 * One page of the site as the page transition sees it (W73b; WQ20, WQ22, WQ57): everything that changes from page
 * to page, which is main and the footer; the header stays where it is. `page` names the page shown: when it changes,
 * the old page leaves and the new one comes in, and a navigation that carries the page transition's type (every link
 * inside the site: components/ui/SiteLink.tsx) is animated by the `page-out` and `page-in` rules in app/globals.css,
 * over the long duration with the smooth curve. Reduced motion, Back and Forward: the page is swapped at once.
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

/** The page transition on the site: the page is the address's path, so a change of query alone moves nothing. */
export function PageTransition({ children }: { children: ReactNode }) {
  return <PageTransitionView page={usePathname()}>{children}</PageTransitionView>
}
