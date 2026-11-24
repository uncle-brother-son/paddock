// The one list of words a page can't use as its address, because the site's own routes do (WQ26). Read by the site and
// by Sanity Studio (studio/lib/checks.ts imports this file), so it has no imports of its own. Never copy it.

export const RESERVED_SLUGS = ['shop', 'events', 'blog', 'info', 'checkout', 'account', 'auth', 'waiver', 'book', 'api'] as const

/** Whether an address is one of the site's own, however it is typed ("Shop" and " shop " too). */
export function isReservedSlug(slug: string): boolean {
  return (RESERVED_SLUGS as readonly string[]).includes(slug.trim().toLowerCase())
}

/** The one word a product can't use: /shop/gift-card is the gift card's own page (WQ19). */
export const RESERVED_PRODUCT_SLUGS = ['gift-card'] as const

export type SlugPlace = 'page' | 'info' | 'product'

/** The words taken where the slug goes. An info page has its own folder and nothing else in it. */
const TAKEN: Record<SlugPlace, readonly string[]> = { page: RESERVED_SLUGS, info: [], product: RESERVED_PRODUCT_SLUGS }

/** Lowercase letters and numbers, words joined with single hyphens (docs/url-map.md, Conventions). */
const SLUG_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** What is wrong with a slug, in words for an editor, or null when it can be used. Empty is left to the field's "required". */
export function slugProblem(slug: string | undefined, place: SlugPlace): string | null {
  if (!slug) return null
  if (TAKEN[place].includes(slug.trim().toLowerCase())) return `"${slug.trim()}" is used by the site itself. Choose another address.`
  if (!SLUG_SHAPE.test(slug)) return 'Use lowercase letters and numbers, with a hyphen between words (for example "our-story").'
  return null
}
