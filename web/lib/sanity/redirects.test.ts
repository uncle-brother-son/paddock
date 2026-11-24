import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MOVED_SLUG_QUERY } from './queries'
import { reads } from './read'
import { movedAddress, type SluggedPlace } from './redirects'
import cases from './slug-cases.json'

// Brief W72a, item 6: an old slug is answered with a redirect to the document's current address. slug-cases.json is
// what MOVED_SLUG_QUERY answered, run by Sanity's own GROQ engine (groq-js, from the Studio's packages) over sample
// documents with old slugs in every state a lookup can meet: one and two moves back, the home page, another type's
// slug, a draft, a document with no slug, two documents with one old slug, a slug that went away and came back, and
// a document whose own slug is (wrongly) among its old ones. The file carries the query it was made from, so a
// changed query fails here until the cases are made again by the real engine.

const fetched = vi.hoisted(() => vi.fn())
const created = vi.hoisted(() => vi.fn())
vi.mock('@sanity/client', () => ({
  createClient: (config: unknown) => {
    created(config)
    return { fetch: fetched }
  },
}))

type Moved = { slug: string; isHome: boolean } | null
const answered = (type: string, slug: string): Moved => {
  const found = cases.movedSlug.cases.find((one) => one.type === type && one.slug === slug)
  if (!found) throw new Error(`slug-cases.json has no case for ${type} "${slug}": the engine never answered it.`)
  return found.answer
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SANITY_PROJECT_ID', 'project')
  vi.stubEnv('NEXT_PUBLIC_SANITY_DATASET', 'production')
  // Sanity, answering as its engine did.
  fetched.mockImplementation(async (_query: string, params: { type: string; slug: string }) => answered(params.type, params.slug))
})
afterEach(() => {
  vi.unstubAllEnvs()
  fetched.mockReset()
  created.mockReset()
})

/** Each lookup: where it was asked, the old slug, and the address it must give (null: nothing moved from there). */
const LOOKUPS: Array<[SluggedPlace, string, string | null]> = [
  ['page', 'private-hire', '/exclusive-hire'],
  // Two moves back: straight to the current address, never by way of the slug in between.
  ['page', 'hire', '/exclusive-hire'],
  // The page that is now the home page is at /.
  ['page', 'welcome', '/'],
  ['page', 'never-was', null],
  ['info', 'terms-and-conditions', '/info/terms'],
  // A page's old slug is not an info page's.
  ['info', 'private-hire', null],
  ['product', 'hoodie-moss', '/shop/herd-hoodie-moss'],
  // The same word was a product's old slug and an event's: each leads to its own.
  ['product', 'solstice', '/shop/herd-hoodie-moss'],
  ['event', 'solstice', '/events/solstice-2026'],
  ['event', 'hoodie-moss', null],
  ['event', 'moonrise', '/events/full-moon'],
  // A draft's old slug moves nobody yet; a document with no slug has nowhere to send anyone.
  ['event', 'draft-old', null],
  ['event', 'lost', null],
  // Two documents with one old slug: the one changed last.
  ['event', 'shared-old', '/events/b-new'],
  ['event', 'winter-dip', '/events/winter-swim'],
]
const TYPES: Record<SluggedPlace, string> = { page: 'contentPage', info: 'infoPage', product: 'product', event: 'event' }

describe('the cases', () => {
  it('were made by the query the site sends', () => {
    expect(cases.movedSlug.query).toBe(MOVED_SLUG_QUERY)
    expect(reads.movedSlug.query).toBe(MOVED_SLUG_QUERY)
  })

  it('each answer fits its type', () => {
    for (const { answer } of cases.movedSlug.cases) expect(reads.movedSlug.schema.parse(answer)).toEqual(answer)
  })
})

describe('an old slug', () => {
  it.each(LOOKUPS)('%s "%s" has moved to %s', async (place, slug, address) => {
    expect(await movedAddress(place, slug)).toBe(address)
  })

  it('costs one lookup, by the slug and the type of the place, through the CDN', async () => {
    expect(await movedAddress('product', 'hoodie-moss')).toBe('/shop/herd-hoodie-moss')
    expect(fetched).toHaveBeenCalledTimes(1)
    expect(fetched).toHaveBeenCalledWith(MOVED_SLUG_QUERY, { slug: 'hoodie-moss', type: 'product' })
    expect(created).toHaveBeenCalledWith({ projectId: 'project', dataset: 'production', apiVersion: '2025-02-19', useCdn: true, perspective: 'published' })
  })

  it('each place asks for its own type', async () => {
    for (const place of Object.keys(TYPES) as SluggedPlace[]) {
      fetched.mockClear()
      fetched.mockResolvedValueOnce(null)
      await movedAddress(place, 'any-slug')
      expect(fetched).toHaveBeenCalledWith(MOVED_SLUG_QUERY, { slug: 'any-slug', type: TYPES[place] })
    }
  })

  it('no slug at all asks nothing', async () => {
    expect(await movedAddress('page', '')).toBeNull()
    expect(fetched).not.toHaveBeenCalled()
  })

  it('an answer that does not fit is thrown, never followed', async () => {
    fetched.mockResolvedValueOnce({ slug: 7 })
    await expect(movedAddress('event', 'solstice')).rejects.toThrow()
  })
})

describe('no loop', () => {
  it.each(LOOKUPS.filter(([, , address]) => address !== null))('%s "%s": where it leads, nothing has moved from', async (place, _slug, address) => {
    // The last part of the address it gave is a slug in use: asked for in the same place, it leads nowhere else.
    const landed = (address as string).split('/').pop() as string
    expect(await movedAddress(place, landed === '' ? 'home' : landed)).toBeNull()
  })

  it('a slug in use is never sent on, even when its own document (wrongly) lists it among its old ones', async () => {
    // event-2's slug is "full-moon", and its old slugs hold "full-moon" too.
    expect(answered('event', 'full-moon')).toBeNull()
    expect(await movedAddress('event', 'full-moon')).toBeNull()
    // A slug that went away and came back (winter-swim, then winter-dip, then winter-swim again).
    expect(await movedAddress('event', 'winter-swim')).toBeNull()
    expect(await movedAddress('page', 'exclusive-hire')).toBeNull()
  })

  it('the query leaves out the document that has the slug now, and the answer is checked again: an address is never sent to itself', async () => {
    expect(MOVED_SLUG_QUERY).toContain('slug.current != $slug')
    for (const place of Object.keys(TYPES) as SluggedPlace[]) {
      fetched.mockResolvedValueOnce({ slug: 'same-slug', isHome: false })
      expect(await movedAddress(place, 'same-slug'), place).toBeNull()
    }
  })

  it('no lookup ever gives the address it was asked for', async () => {
    const ADDRESS: Record<SluggedPlace, (slug: string) => string> = { page: (slug) => `/${slug}`, info: (slug) => `/info/${slug}`, product: (slug) => `/shop/${slug}`, event: (slug) => `/events/${slug}` }
    for (const [place, type] of Object.entries(TYPES) as Array<[SluggedPlace, string]>) {
      for (const { slug } of cases.movedSlug.cases.filter((one) => one.type === type)) {
        expect(await movedAddress(place, slug), `${place} ${slug}`).not.toBe(ADDRESS[place](slug))
      }
    }
  })
})
