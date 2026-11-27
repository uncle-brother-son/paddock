'use client'

import Link from 'next/link'
import type { ComponentPropsWithoutRef, MouseEvent } from 'react'

import { useFramePanels } from '@/components/frame/useFramePanels'
import { ACCOUNT_ADDRESS } from '@/lib/account/sections'
import { isSectionAddress } from '@/lib/modules/section'
import { arriveInPlace, PAGE_AT_ONCE_TYPES, PAGE_TRANSITION_TYPES } from '@/lib/motion/page-transition'
import { isBuiltAddress } from '@/lib/routes/not-built'
import { isBookAddress } from '@/lib/sanity/links'

import { SectionLink } from './SectionLink'

type SiteLinkProps = Omit<ComponentPropsWithoutRef<'a'>, 'href' | 'target' | 'rel'> & {
  href: string
  /** Opens in a new tab. Left out, every link opens in the same one, an outside address too. */
  newTab?: boolean
  /**
   * W74c (WQ52): false for a link that changes the page where it stands (a product's colour swatch): it goes to the
   * new address, so Back works and the link can be shared, with no page transition. Every other link has it.
   * W78a (WQ68): it says so with a type of its own, since a navigation with no type at all (Back, Forward) is animated.
   * W78b (WQ52, as amended again): the window is left where it is when the new page comes (Next is told not to scroll),
   * and a plain press says the page arrives in place: it then scrolls smoothly to its top (lib/motion/page-transition.ts).
   */
  transition?: boolean
}

/** An address off the site: another site, an email address, a phone number. */
export const isOutsideAddress = (href: string): boolean => /^(https?:|mailto:|tel:|\/\/)/i.test(href)

/** A plain press of the main button, with no key held: anything else (a new tab, a new window) is left to the browser. */
export const isPlainClick = (event: MouseEvent): boolean => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey

/** An address's path alone, without what it asks (?colour=) or the place it names (#top): what the page transition knows a page by. */
const pathOf = (href: string): string => href.split(/[?#]/)[0] ?? href

/**
 * A link with no look of its own: Next's <Link> for a page of the site (no full reload), a plain <a> for an outside
 * address. The components that draw links (TextLink, the menu, the footer) put their own classes on it.
 *
 * W73b: this is the one place the site uses Next's <Link>, so every link from page to page inside the site carries
 * the page transition's type and is animated (components/frame/PageTransition.tsx). It is also the one place a link
 * to the booking panel (/book: the header's Book, a hero's button, a link an editor made in Sanity) asks
 * useFramePanels for the panel first: when the panel opens the visitor stays on the page (W77: inside the frame it
 * always does); with no panel to open the link is followed, to /book, which is the home page with the panel open.
 *
 * W80 (WQ83): an address that names a section of the page it is on (`#memberships`) is a SectionLink, which scrolls
 * the page there (components/ui/SectionLink.tsx).
 *
 * W85: a link to /account (the header's Account, the phone menu's) asks useFramePanels too: signed out, the sign-in
 * popup opens over the page, and goes on to /account once signed in; signed in, the link is followed.
 *
 * Next fetches each link it can see ahead of a press. A page that is not built yet (lib/routes/not-built.ts: /account,
 * /checkout) is never fetched ahead, on sight or on hover; a press still follows the link.
 */
export function SiteLink({ href, newTab = false, transition = true, onClick, children, ...rest }: SiteLinkProps) {
  const panels = useFramePanels()
  const tab = newTab ? { target: '_blank', rel: 'noopener noreferrer' } : {}
  if (isSectionAddress(href)) {
    return (
      <SectionLink href={href} onClick={onClick} {...tab} {...rest}>
        {children}
      </SectionLink>
    )
  }
  if (isOutsideAddress(href)) {
    return (
      <a href={href} onClick={onClick} {...tab} {...rest}>
        {children}
      </a>
    )
  }
  const click = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event)
    if (event.defaultPrevented || newTab || !isPlainClick(event)) return
    // WQ52: the page this link leads to comes where this one stands, and scrolls to its top by itself.
    if (!transition) arriveInPlace(pathOf(href))
    // W85: Account (the header's, the phone menu's), signed out, opens sign-in over the page, then goes on.
    if (pathOf(href) === ACCOUNT_ADDRESS && panels.open('account')) return event.preventDefault()
    if (isBookAddress(href) && panels.open('book')) event.preventDefault()
  }
  return (
    <Link href={href} prefetch={isBuiltAddress(href) ? 'auto' : false} scroll={transition} transitionTypes={transition ? PAGE_TRANSITION_TYPES : PAGE_AT_ONCE_TYPES} onClick={click} {...tab} {...rest}>
      {children}
    </Link>
  )
}
