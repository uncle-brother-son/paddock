import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { linkHref } from './links'
import { reads, readSanity } from './read'
import answers from './sample-answers.json'
import madeFrom from './sample-queries.json'
import type { Link } from './schemas'

// Brief W72, item 11. sample-answers.json is what ./queries.ts answered, run by Sanity's own GROQ engine (groq-js, from
// the Studio's packages) over sample documents of every type: one published, one a draft, one link to a page that isn't
// published, a video, a decorative picture, an image with no file, a product with no address.
// W72a: the product's, the event's and the gift card's samples were made again the same way, with galleries of pictures
// and videos (a video first, a picture with no file, a video with no poster), a product in a category, one whose
// category is not published, and a page with old slugs.

const fetched = vi.hoisted(() => vi.fn())
const created = vi.hoisted(() => vi.fn())
vi.mock('@sanity/client', () => ({
  createClient: (config: unknown) => {
    created(config)
    return { fetch: fetched }
  },
}))

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SANITY_PROJECT_ID', 'project')
  vi.stubEnv('NEXT_PUBLIC_SANITY_DATASET', 'production')
})
afterEach(() => {
  vi.unstubAllEnvs()
  fetched.mockReset()
  created.mockReset()
})

const names = Object.keys(reads) as (keyof typeof reads)[]

describe('each read', () => {
  it('has a sample answer, and no other', () => {
    expect(Object.keys(answers).sort()).toEqual([...names].sort())
  })

  it.each(names)('%s: its sample fits its type, with nothing left over', (name) => {
    expect(reads[name].schema.parse(answers[name])).toEqual(answers[name])
  })

  it.each(names)('%s: a document that is not there', (name) => {
    const isList = Array.isArray(answers[name])
    expect(reads[name].schema.safeParse(null).success).toBe(!isList)
    expect(reads[name].schema.safeParse([]).success).toBe(isList)
  })

  it('one whose answer does not fit is refused, not passed on', () => {
    expect(reads.siteSettings.schema.safeParse({ ...answers.siteSettings, siteName: null }).success).toBe(false)
    expect(reads.contentPage.schema.safeParse({ ...answers.contentPage, modules: [{ type: 'unknown', key: 'k' }] }).success).toBe(false)
  })
})

describe('readSanity', () => {
  it('asks for published documents and parses the answer', async () => {
    fetched.mockResolvedValue(answers.navigation)
    expect(await readSanity('navigation')).toEqual(answers.navigation)
    expect(created).toHaveBeenCalledWith({ projectId: 'project', dataset: 'production', apiVersion: '2025-02-19', useCdn: true, perspective: 'published' })
    expect(fetched).toHaveBeenCalledWith(reads.navigation.query, {})
  })

  it('a page by its slug: sent as a parameter, never in the query', async () => {
    fetched.mockResolvedValue(null)
    expect(await readSanity('contentPage', 'exclusive-hire')).toBeNull()
    expect(fetched).toHaveBeenCalledWith(reads.contentPage.query, { slug: 'exclusive-hire' })
  })

  it('an answer that does not fit throws', async () => {
    fetched.mockResolvedValue({ menuLinks: 'no' })
    await expect(readSanity('navigation')).rejects.toThrow()
  })

  it('W72a: where an old slug went takes the slug and the type, both as parameters', async () => {
    fetched.mockResolvedValue(answers.movedSlug)
    expect(await readSanity('movedSlug', 'private-hire', 'contentPage')).toEqual({ slug: 'exclusive-hire', isHome: false })
    expect(fetched).toHaveBeenCalledWith(reads.movedSlug.query, { slug: 'private-hire', type: 'contentPage' })
  })
})

describe('W72a: galleries and categories', () => {
  const kinds = (gallery: Array<{ kind: string }>) => gallery.map((item) => item.kind)

  // sample-queries.json: the query each of these samples was made from. A query changed since has a stale sample:
  // make it again with the real engine (briefs/W72a-logs/tools, in the staff app repo), and read what changes.
  it.each(Object.keys(madeFrom) as Array<keyof typeof madeFrom>)('%s: its sample was made by the query the site sends', (name) => {
    expect(madeFrom[name]).toBe(reads[name].query)
  })

  it('every read W72a changed has its query on record', () => {
    expect(Object.keys(madeFrom).sort()).toEqual(['event', 'eventCards', 'giftCard', 'movedSlug', 'product', 'productCards'])
  })

  it("a gallery keeps its order, videos among the pictures; an item with no file is left out", () => {
    // The sample product's gallery: a video, a picture, a picture with no file, a decorative picture, a video with no poster.
    expect(kinds(answers.product.gallery)).toEqual(['video', 'image', 'image'])
    expect(answers.product.gallery[0]).toMatchObject({ kind: 'video', url: 'https://cdn.sanity.io/files/p/d/vid.mp4', description: 'Steam', poster: { alt: 'Picture hero' } })
    expect(answers.product.gallery[2]).toMatchObject({ kind: 'image', image: { alt: '' } })
    expect(answers.productCards.map((card) => kinds(card.gallery))).toEqual([['image'], ['video', 'image', 'image']])
    expect(kinds(answers.product.colours[0]!.gallery)).toEqual(['image'])
    expect(kinds(answers.event.gallery)).toEqual(['image'])
  })

  it('the gift card has its two galleries, each its own', () => {
    expect(kinds(answers.giftCard.physicalGallery)).toEqual(['image'])
    expect(kinds(answers.giftCard.digitalGallery)).toEqual(['video'])
  })

  it("a product carries its category's id, title, slug and order; one whose category is not published has none", () => {
    expect(answers.product.category).toEqual({ id: 'cat-apparel', title: 'Apparel', slug: 'apparel', order: 1 })
    expect(answers.giftCard.category).toEqual({ id: 'cat-apparel', title: 'Apparel', slug: 'apparel', order: 1 })
    expect(answers.productCards.map((card) => card.category?.title ?? null)).toEqual([null, 'Apparel'])
  })

  it('the old `images` and the category as a word are refused', () => {
    const { gallery, ...noGallery } = answers.product
    expect(reads.product.schema.safeParse({ ...noGallery, images: gallery }).success).toBe(false)
    expect(reads.product.schema.safeParse({ ...answers.product, category: 'apparel' }).success).toBe(false)
    expect(reads.giftCard.schema.safeParse({ ...answers.giftCard, physicalGallery: undefined }).success).toBe(false)
    for (const query of [reads.productCards.query, reads.product.query, reads.eventCards.query, reads.event.query, reads.giftCard.query]) expect(query).not.toContain('images')
  })
})

describe('linkHref', () => {
  const links = [...answers.navigation.menuLinks, ...answers.navigation.footerLinks].map(({ label, link }) => [label, linkHref(link as Link)])

  it('each kind of link, and a link to a page that is not published is hidden', () => {
    expect(links).toEqual([
      ['Home', '/'],
      ['Exclusive Hire', '/exclusive-hire'],
      ['Shop', '/shop'],
      ['Solstice', '/events/solstice-2026'],
      ['Not published', null],
      ['Terms', '/info/terms'],
      ['Outside', 'https://example.com'],
    ])
  })
})
