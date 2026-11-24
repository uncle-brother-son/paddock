import { connection } from 'next/server'
import { cache } from 'react'

import { isReservedSlug } from '@/lib/routes/reserved-slugs'
import { readSanity } from '@/lib/sanity/read'
import { movedAddress, type SluggedPlace } from '@/lib/sanity/redirects'
import type { ContentPage, InfoPage } from '@/lib/sanity/schemas'

// The pages Sanity holds (W73b): the home page at /, a content page at /[slug], an info page at /info/[slug]. Each
// is read once for a request (React's `cache`), though its route asks twice: for its title and for the page itself.
// `connection()` makes it a read at request time (lib/frame/read.ts). A read that fails throws: a page that could not
// be read is an error, never a "not found".

/** The page Site settings picks as the home page, or null when none is picked or published. */
export const readHomePage = cache(async (): Promise<ContentPage | null> => {
  await connection()
  return readSanity('homePage')
})

/**
 * What an address with a slug answers: the page, the address it has moved to (answered with a permanent redirect),
 * or nothing (a 404).
 */
export type Found<Page> = { page: Page; movedTo: null } | { page: null; movedTo: string } | { page: null; movedTo: null }

/** Nothing at this slug now: where the page that used to be here went (W72a), if one was. */
async function goneFrom<Page>(place: SluggedPlace, slug: string): Promise<Found<Page>> {
  const movedTo = await movedAddress(place, slug)
  return movedTo ? { page: null, movedTo } : { page: null, movedTo: null }
}

/**
 * The content page at /[slug]. The page Site settings picks as home lives at /, so its own slug (/home) has moved
 * there. One of the site's own words (/shop, /book) is no page's slug, and is not looked up.
 */
export const findContentPage = cache(async (slug: string): Promise<Found<ContentPage>> => {
  if (isReservedSlug(slug)) return { page: null, movedTo: null }
  await connection()
  const page = await readSanity('contentPage', slug)
  if (!page) return goneFrom('page', slug)
  return page.isHome ? { page: null, movedTo: '/' } : { page, movedTo: null }
})

/** The info page at /info/[slug]. */
export const findInfoPage = cache(async (slug: string): Promise<Found<InfoPage>> => {
  await connection()
  const page = await readSanity('infoPage', slug)
  return page ? { page, movedTo: null } : goneFrom('info', slug)
})
