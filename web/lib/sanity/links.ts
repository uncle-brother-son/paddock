import type { Link } from './schemas'

/** The gift card's page (WQ19): the site's own address, with no slug to pick. */
export const GIFT_CARD_ADDRESS = '/shop/gift-card'

/**
 * The booking panel's link (docs/url-map.md: /book?date=&type=). The panel opens over whatever page the visitor is
 * on; until it is built the link is followed. Every link to it inside the site asks for the panel first
 * (components/ui/SiteLink.tsx).
 */
export const BOOK_ADDRESS = '/book'

/** Whether an address is the booking panel's, with or without what to open it on (?date=, ?type=). */
export const isBookAddress = (href: string): boolean => href === BOOK_ADDRESS || href.startsWith(`${BOOK_ADDRESS}?`)

/** The address a link goes to, or null for a link the site hides: its page or event isn't published (WQ24). */
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
