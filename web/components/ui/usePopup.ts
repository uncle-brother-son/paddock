'use client'

import { useLenis } from 'lenis/react'
import { useEffect, useRef, type RefObject } from 'react'

/**
 * W85: the popups open now, the newest last. Sign-in can open over the booking panel (its AccountBar's Log in): Esc
 * closes only the newest, the one beneath is inert while it is open, and the page starts to scroll again only when the
 * last one has closed.
 */
const openPopups: HTMLElement[] = []

/** A popup open beneath (or what holds one): inert with the rest of the page while a newer one is open. */
const holdsAnOpenPopup = (element: HTMLElement): boolean => openPopups.some((open) => element === open || element.contains(open))

/**
 * Everything on the page but a popup and what holds it: at each level from the popup up to <body>, the elements
 * beside it. The shade (and any other popup layer, marked `data-frame-popup`) is left alone, so a click on it lands;
 * but not a popup already open beneath this one.
 */
function everythingElse(popup: HTMLElement): HTMLElement[] {
  const found: HTMLElement[] = []
  for (let inside: HTMLElement = popup; inside !== document.body && inside.parentElement; inside = inside.parentElement) {
    for (const beside of inside.parentElement.children) {
      if (beside === inside || !(beside instanceof HTMLElement)) continue
      if ((beside.hasAttribute('data-frame-popup') && !holdsAnOpenPopup(beside)) || beside.inert || ['SCRIPT', 'STYLE', 'LINK', 'TEMPLATE'].includes(beside.tagName)) continue
      found.push(beside)
    }
  }
  return found
}

type Popup = {
  open: boolean
  onClose: () => void
  /** The popup itself. */
  popup: RefObject<HTMLElement | null>
  /** What takes focus when it opens. */
  firstFocus: RefObject<HTMLElement | null>
}

/**
 * The popup rules of the build standards (docs/build-standards.md, section 1), for a popup that sits inside the page
 * it covers, so its words are in the page's HTML: on opening focus moves into it, everything else on the page is
 * inert and the page does not scroll (Lenis stopped; the popup itself carries `data-lenis-prevent`); Esc closes it;
 * on closing focus goes back to whatever opened it. The menu (components/frame/Menu.tsx) follows the same rules by
 * itself: it sits outside the page and makes the page's own parts inert by name.
 */
export function usePopup({ open, onClose, popup, firstFocus }: Popup): void {
  const lenis = useLenis()
  const opener = useRef<HTMLElement | null>(null)
  // The newest onClose, without opening the popup afresh each time its owner draws.
  const close = useRef(onClose)
  useEffect(() => {
    close.current = onClose
  }, [onClose])

  useEffect(() => {
    const panel = popup.current
    if (!open || !panel) return
    // Whatever had focus opened it: remembered before focus moves in.
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // A popup already open beneath this one is made inert with the rest, and given back as it was on closing.
    const behind = everythingElse(panel)
    for (const element of behind) element.inert = true
    openPopups.push(panel)
    document.documentElement.classList.add('overflow-hidden')
    lenis?.stop()
    // W85: without scrolling to it, so a popup still sliding in from below isn't scrolled to where it isn't yet.
    firstFocus.current?.focus({ preventScroll: true })
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && openPopups.at(-1) === panel) close.current()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      for (const element of behind) element.inert = false
      openPopups.splice(openPopups.indexOf(panel), 1)
      if (openPopups.length === 0) {
        document.documentElement.classList.remove('overflow-hidden')
        lenis?.start()
      }
      document.removeEventListener('keydown', onKey)
      opener.current?.focus()
      opener.current = null
    }
  }, [open, lenis, popup, firstFocus])
}
