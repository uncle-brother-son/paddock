import { readSanity } from './read'

// W72a (docs/build-standards.md, section 2; docs/url-map.md, Redirects): when an editor changes a slug, the old
// address keeps working. Sanity keeps each document's old slugs (`previousSlugs`, added by the Studio's Publish
// action), and the site answers an old one with a permanent redirect to the current address.
//
// How a page uses it (no page is built yet): it reads its document by the slug as always. Only when nothing is there
// does it call `movedAddress`: an address, and the page redirects there for good; null, and it is a 404. So a slug in
// use never costs a lookup, and an old one costs one query, which Sanity's CDN keeps until the dataset next changes
// (./read.ts).
//
// No loop: the lookup never answers the document that has the slug now (the query leaves it out, and the answer is
// checked again here), and the Studio takes a slug out of a document's old slugs when the document goes back to it.

/** Where a document with a slug lives on the site. */
export type SluggedPlace = 'page' | 'info' | 'product' | 'event'

const PLACES: Record<SluggedPlace, { type: string; address: (slug: string) => string }> = {
  page: { type: 'contentPage', address: (slug) => `/${slug}` },
  info: { type: 'infoPage', address: (slug) => `/info/${slug}` },
  product: { type: 'product', address: (slug) => `/shop/${slug}` },
  event: { type: 'event', address: (slug) => `/events/${slug}` },
}

/**
 * The current address of the document that used to be at this slug, or null when none was (a 404). `place` is the
 * part of the site the slug was asked for in: an old product slug never leads to an event. A page that has become
 * the home page is at `/`.
 */
export async function movedAddress(place: SluggedPlace, slug: string): Promise<string | null> {
  if (!slug) return null
  const { type, address } = PLACES[place]
  const moved = await readSanity('movedSlug', slug, type)
  if (!moved || moved.slug === slug) return null
  if (place === 'page' && moved.isHome) return '/'
  return address(moved.slug)
}
