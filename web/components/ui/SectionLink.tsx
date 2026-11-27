'use client'

import { useLenis } from 'lenis/react'
import type { ComponentPropsWithoutRef, MouseEvent } from 'react'

import { hashId } from '@/lib/motion/page-transition'
import { DURATION_LONG, EASE_SMOOTH } from '@/lib/motion/tokens'

type SectionLinkProps = Omit<ComponentPropsWithoutRef<'a'>, 'href'> & {
  /** The section's address on this page: `#memberships`. */
  href: string
}

/**
 * A link to a section of the page it is on (W80; WQ83: a link's "A section on this page" in Sanity, as PageHeader's
 * buttons to `#memberships` and `#passes`). It is a plain link to that place, so it works with no script, opens in
 * a new tab and can be copied. A plain press scrolls the page there smoothly with Lenis, over the long duration with
 * the smooth curve; with reduced motion on (Lenis is not running) the page jumps there. The address takes the
 * section's name as a history step of its own, as a browser does for such a link, so Back returns; and focus moves
 * to the section, so the keyboard and a screen reader carry on from where the page now is.
 *
 * components/ui/SiteLink.tsx hands every address that starts with `#` to this: it is the one place that scrolls to
 * a section. A link whose section is not on the page is left to the browser, which does nothing.
 */
export function SectionLink({ href, onClick, children, ...rest }: SectionLinkProps) {
  const lenis = useLenis()
  const click = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event)
    // A new tab or window is the browser's.
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const id = hashId(href)
    const place = id ? document.getElementById(id) : null
    if (!place) return
    event.preventDefault()
    if (window.location.hash !== href) window.history.pushState(null, '', href)
    if (lenis) lenis.scrollTo(place, { duration: DURATION_LONG, easing: EASE_SMOOTH })
    else place.scrollIntoView()
    // Focus by script only, never in the Tab order; a section shows no ring (it is not a control).
    if (!place.hasAttribute('tabindex')) {
      place.tabIndex = -1
      place.style.outline = 'none'
    }
    place.focus({ preventScroll: true })
  }
  return (
    <a href={href} onClick={click} {...rest}>
      {children}
    </a>
  )
}
