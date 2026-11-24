import type { Metadata } from 'next'

import { sizedImage } from '@/lib/sanity/image'
import type { Picture, Seo, SiteSettings } from '@/lib/sanity/schemas'
import { SITE_NAME } from '@/lib/site'

// A page's title, description, canonical address and link preview (W73b; docs/build-standards.md, sections 2 and 3):
// the page's own SEO section where an editor filled it, then what is made from the page, then Site settings' defaults.

/** A page's title as search results show it: "{Title} | The Paddock" (the root layout's template says the same). */
export const titleWithSite = (title: string): string => `${title} | The Paddock`

/** A share picture's size (docs/build-standards.md, section 3). */
const SHARE_IMAGE = { width: 1200, height: 630 } as const

type PageSeo = {
  /** The page's address on the site ("/", "/experience", "/info/terms"): lowercase, no trailing slash, no query. */
  path: string
  /** The page's own title, or null for the home page, whose title is the site's own (Site settings). */
  title: string | null
  seo: Seo | null
  settings: SiteSettings | null
  /** W74: a description made from the page (a product's first words, the Shop's intro), used when its SEO section has none. */
  description?: string | null
  /** W74: a picture made from the page (a product's first picture), used when its SEO section has no share picture. */
  picture?: Picture | null
}

const filled = (text: string | null | undefined): string | null => text?.trim() || null

/**
 * The metadata of one page. Its title is the editor's SEO title (the whole of it), or "{Title} | The Paddock", or for
 * the home page Site settings' title, then the site's name. Its description and share picture are the page's own or
 * Site settings'. The addresses are made whole by the root layout's `metadataBase` (the live domain).
 */
export function pageMetadata({ path, title, seo, settings, description: made, picture: madePicture }: PageSeo): Metadata {
  const defaults = settings?.defaultSeo ?? null
  const siteName = settings?.siteName ?? SITE_NAME
  const wholeTitle = filled(seo?.title) ?? (title ? titleWithSite(title) : (filled(defaults?.title) ?? siteName))
  const description = filled(seo?.description) ?? filled(made) ?? filled(defaults?.description)
  const picture = seo?.shareImage ?? madePicture ?? defaults?.shareImage ?? null
  const images = picture
    ? [{ url: sizedImage(picture, SHARE_IMAGE.width / SHARE_IMAGE.height, [SHARE_IMAGE.width]).src, ...SHARE_IMAGE, alt: picture.alt }]
    : null
  const shared = { title: wholeTitle, ...(description ? { description } : {}), ...(images ? { images } : {}) }

  return {
    title: { absolute: wholeTitle },
    ...(description ? { description } : {}),
    alternates: { canonical: path },
    // A page's Open Graph replaces the layout's whole, so the site's name, language and type are said again.
    openGraph: { ...shared, url: path, siteName, locale: 'en_GB', type: 'website' },
    twitter: { card: 'summary_large_image', ...shared },
  }
}
