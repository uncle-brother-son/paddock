'use client'

import { useLenis } from 'lenis/react'
import type { MouseEvent } from 'react'

import { ButtonLabel, SMALL_PRIMARY_BUTTON } from '@/components/ui/Button'

/**
 * "Skip to content" (WQ13): the first thing Tab reaches on every page. Hidden until then, it shows top left over the
 * header as the small primary Button with the focus ring, and takes the keyboard to <main>. Lenis owns the page's
 * scrolling while it runs, so the jump is made here and not left to the address's `#main`: focus first, then the
 * scroll (Lenis's own when it is running, the browser's when it isn't).
 */
export function SkipLink() {
  const lenis = useLenis()

  const skip = (event: MouseEvent<HTMLAnchorElement>) => {
    const main = document.getElementById('main')
    if (!main) return
    event.preventDefault()
    main.focus({ preventScroll: true })
    if (lenis) lenis.scrollTo(main, { immediate: true, force: true })
    else main.scrollIntoView()
  }

  return (
    <a
      href="#main"
      onClick={skip}
      data-behind-popups=""
      // Always in the Tab order, at its place over the header; seen (and clickable) only while it has keyboard focus.
      className={`pointer-events-none fixed top-16 left-16 z-30 opacity-0 focus-visible:pointer-events-auto focus-visible:opacity-100 ${SMALL_PRIMARY_BUTTON}`}
    >
      <ButtonLabel>Skip to content</ButtonLabel>
    </a>
  )
}
