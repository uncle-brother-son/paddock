import { sectionAddress } from '@/lib/modules/section'

import type { Link } from './schemas'

/** The gift card's page (WQ19): the site's own address, with no slug to pick. */
export const GIFT_CARD_ADDRESS = '/shop/gift-card'

/**
 * The booking panel's link (docs/url-map.md: /book?date=&type=). The panel opens over whatever page the visitor is
 * on: every link to it inside the site asks for the panel first (components/ui/SiteLink.tsx). Followed (a new tab, a
 * link from outside), it is the home page with the panel open (W77: app/book/page.tsx). The address's ?date= and ?type=
 * are not read yet: the panel opens on the first day with a session to book, in the Public view.
 */
export const BOOK_ADDRESS = '/book'

/** Whether an address is the booking panel's, with or without what to open it on (?date=, ?type=). */
export const isBookAddress = (href: string): boolean => href === BOOK_ADDRESS || href.startsWith(`${BOOK_ADDRESS}?`)

/**
 * The address a link goes to, or null for a link the site hides: its page or event isn't published (WQ24). W80
 * (WQ83): a link to a section of the page it is on is `#` and the section's id ("#memberships"), which
 * components/ui/SiteLink.tsx scrolls to; one whose id is not an id is hidden.
 */
export function linkHref(link: Link): string | null {
  switch (link.destination) {
    case 'shop':
      return '/shop'
    case 'giftCard':
      return GIFT_CARD_ADDRESS
    case 'book':
      return BOOK_ADDRESS
    case 'external':
      return link.url
    case 'section':
      return sectionAddress(link.sectionId)
    case 'page':
    case 'event': {
      const linked = link.document
      if (!linked) return null
      if (linked.type === 'event') return `/events/${linked.slug}`
      if (linked.type === 'infoPage') return `/info/${linked.slug}`
      return linked.isHome ? '/' : `/${linked.slug}`
    }
  }
}
