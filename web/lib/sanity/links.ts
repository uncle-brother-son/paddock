import type { Link } from './schemas'

/** The address a link goes to, or null for a link the site hides: its page or event isn't published (WQ24). */
export function linkHref(link: Link): string | null {
  switch (link.destination) {
    case 'shop':
      return '/shop'
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
