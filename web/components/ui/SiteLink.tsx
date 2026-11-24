'use client'

import Link from 'next/link'
import type { ComponentPropsWithoutRef, MouseEvent } from 'react'

import { useFramePanels } from '@/components/frame/useFramePanels'
import { PAGE_TRANSITION_TYPES } from '@/lib/motion/page-transition'
import { isBookAddress } from '@/lib/sanity/links'

type SiteLinkProps = Omit<ComponentPropsWithoutRef<'a'>, 'href' | 'target' | 'rel'> & {
  href: string
  /** Opens in a new tab. Left out, every link opens in the same one, an outside address too. */
  newTab?: boolean
}

/** An address off the site: another site, an email address, a phone number. */
export const isOutsideAddress = (href: string): boolean => /^(https?:|mailto:|tel:|\/\/)/i.test(href)

/** A plain press of the main button, with no key held: anything else (a new tab, a new window) is left to the browser. */
const isPlainClick = (event: MouseEvent): boolean => event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey

/**
 * A link with no look of its own: Next's <Link> for a page of the site (no full reload), a plain <a> for an outside
 * address. The components that draw links (TextLink, the menu, the footer) put their own classes on it.
 *
 * W73b: this is the one place the site uses Next's <Link>, so every link from page to page inside the site carries
 * the page transition's type and is animated (components/frame/PageTransition.tsx). It is also the one place a link
 * to the booking panel (/book: the header's Book, a hero's button, a link an editor made in Sanity) asks
 * useFramePanels for the panel first: when the panel opens the visitor stays on the page; until it exists the link
 * is followed.
 */
export function SiteLink({ href, newTab = false, onClick, children, ...rest }: SiteLinkProps) {
  const panels = useFramePanels()
  const tab = newTab ? { target: '_blank', rel: 'noopener noreferrer' } : {}
  if (isOutsideAddress(href)) {
    return (
      <a href={href} onClick={onClick} {...tab} {...rest}>
        {children}
      </a>
    )
  }
  const click = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event)
    if (event.defaultPrevented || newTab || !isBookAddress(href) || !isPlainClick(event)) return
    if (panels.open('book')) event.preventDefault()
  }
  return (
    <Link href={href} transitionTypes={PAGE_TRANSITION_TYPES} onClick={click} {...tab} {...rest}>
      {children}
    </Link>
  )
}
