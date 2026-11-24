'use client'

import { useLenis } from 'lenis/react'
import { useEffect, useRef, type RefObject } from 'react'

/**
 * Everything on the page but a popup and what holds it: at each level from the popup up to <body>, the elements
 * beside it. The shade (and any other popup layer, marked `data-frame-popup`) is left alone, so a click on it lands.
 */
function everythingElse(popup: HTMLElement): HTMLElement[] {
  const found: HTMLElement[] = []
  for (let inside: HTMLElement = popup; inside !== document.body && inside.parentElement; inside = inside.parentElement) {
    for (const beside of inside.parentElement.children) {
      if (beside === inside || !(beside instanceof HTMLElement)) continue
      if (beside.hasAttribute('data-frame-popup') || beside.inert || ['SCRIPT', 'STYLE', 'LINK', 'TEMPLATE'].includes(beside.tagName)) continue
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
    const behind = everythingElse(panel)
    for (const element of behind) element.inert = true
    document.documentElement.classList.add('overflow-hidden')
    lenis?.stop()
    firstFocus.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close.current()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      for (const element of behind) element.inert = false
      document.documentElement.classList.remove('overflow-hidden')
      lenis?.start()
      document.removeEventListener('keydown', onKey)
      opener.current?.focus()
      opener.current = null
    }
  }, [open, lenis, popup, firstFocus])
}
