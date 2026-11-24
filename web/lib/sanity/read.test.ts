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
  // make it again with the real engine (briefs/W72a-logs/tools and briefs/W73b-logs/tools, in the staff app repo),
  // and read what changes.
  it.each(Object.keys(madeFrom) as Array<keyof typeof madeFrom>)('%s: its sample was made by the query the site sends', (name) => {
    expect(madeFrom[name]).toBe(reads[name].query)
  })

  it('every read W72a and W73b changed has its query on record', () => {
    expect(Object.keys(madeFrom).sort()).toEqual(['contentPage', 'event', 'eventCards', 'giftCard', 'homePage', 'movedSlug', 'product', 'productCards'])
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

// W73 (Wayne, 24 Nov): the footer's columns are groups of links an editor fills. The navigation sample was made again
// by the real engine (the same sample documents; its menu links came out as W72's), with three groups: one holding a
// link with no destination yet, one of an outside address, one made and not filled.
/** The sample's footer links in one list. The JSON's own type is a different shape for each group, so it is said here. */
const footerLinks = (answers.navigation.footerGroups as Array<{ links: Array<{ key: string; label: string; link: unknown }> }>).flatMap((group) => group.links)

describe('W73: the footer groups', () => {
  it('each group keeps its place and its links; a link with no destination is left out; an empty group is an empty list', () => {
    expect(answers.navigation.footerGroups.map((group) => [group.key, group.links.map((link) => link.label)])).toEqual([
      ['g1', ['Terms']],
      ['g2', ['Outside']],
      ['g3', []],
    ])
  })

  it('the old single list of footer links is refused', () => {
    const { footerGroups, ...rest } = answers.navigation
    expect(footerGroups).toHaveLength(3)
    expect(reads.navigation.schema.safeParse({ ...rest, footerLinks }).success).toBe(false)
    expect(reads.navigation.query).not.toContain('footerLinks')
  })
})

// W73b (Wayne, 24 Nov): the Hero is a module of a page, not a field of every page. The two page samples were made
// again by the real engine (briefs/W73b-logs/tools/gen-samples.mjs) over a home page with one Hero (a video, a button
// with no link) and a page with six Heroes in every state among its other modules.
// W73b Level 3 (Wayne, 24 Nov): made again for a video's "Has Sound" switch, a Hero's media for phones and a link to
// the booking panel. The media query is the galleries' too, so their samples were made again with it (each video
// gained `hasSound`, nothing else changed).
describe('W73b: the Hero module', () => {
  type SampleMedia = { kind: string; hasSound?: boolean; url?: string }
  type SampleModule = { type: string; key: string; media?: SampleMedia | null; mobileMedia?: SampleMedia | null; button?: { text: string; link: Link | null } | null; heading?: string | null }
  const homeModules = answers.homePage.modules as SampleModule[]
  const modules = answers.contentPage.modules as SampleModule[]

  it("a page's modules keep their order, each with the fields of its own kind; a kind the site does not know is left out", () => {
    expect(modules.map((module) => [module.key, module.type])).toEqual([
      ['h1', 'hero'],
      ['m', 'upcomingEvents'],
      ['h2', 'hero'],
      ['h3', 'hero'],
      ['h4', 'hero'],
      ['h5', 'hero'],
      ['h6', 'hero'],
      ['m2', 'upcomingEvents'],
    ])
    for (const one of modules) expect(Object.keys(one).sort(), one.key).toEqual(one.type === 'hero' ? ['button', 'key', 'media', 'mobileMedia', 'type'] : ['heading', 'key', 'type'])
    expect(modules.filter((module) => module.type === 'upcomingEvents').map((module) => module.heading)).toEqual(['Upcoming', null])
  })

  it('a Hero has its picture or its video; one with no file, or a video with no poster, has none', () => {
    expect(homeModules.map((module) => module.media?.kind)).toEqual(['video'])
    expect(homeModules[0]!.media).toMatchObject({ url: 'https://cdn.sanity.io/files/p/d/vid.mp4', description: 'Steam', poster: { alt: 'Picture hero' } })
    expect(modules.filter((module) => module.type === 'hero').map((module) => module.media?.kind ?? null)).toEqual(['image', 'image', null, null, null, 'video'])
    // A decorative picture's alt is "".
    expect(modules[0]!.media).toMatchObject({ kind: 'image', image: { alt: '' } })
  })

  it('W73b Level 3: a Hero can have a picture or a video of its own for phones; with none, or one with no file or no poster, it has none', () => {
    expect(homeModules[0]!.mobileMedia).toMatchObject({ kind: 'video', url: 'https://cdn.sanity.io/files/p/d/tall.mp4', description: 'Steam, tall', captionsUrl: null, poster: { alt: 'Picture tall' } })
    // h1 none; h2 a picture; h3 none; h4 a picture (though it has no main picture); h5 none; h6 a video with no poster.
    expect(modules.filter((module) => module.type === 'hero').map((module) => module.mobileMedia?.kind ?? null)).toEqual([null, 'image', null, 'image', null, null])
    expect(modules[2]!.mobileMedia).toMatchObject({ kind: 'image', image: { ref: 'image-tall-900x1600-jpg', alt: 'Picture tall' } })
  })

  it('W73b Level 3: every video says whether it has sound: only one whose switch was turned on does', () => {
    expect([homeModules[0]!.media?.hasSound, homeModules[0]!.mobileMedia?.hasSound]).toEqual([true, false])
    expect(modules.find((module) => module.key === 'h6')!.media?.hasSound).toBe(false)
    // The galleries' videos too: the switch has never been touched there.
    const videos = [...answers.product.gallery, ...answers.giftCard.digitalGallery].filter((item) => item.kind === 'video') as SampleMedia[]
    expect(videos.map((item) => item.hasSound)).toEqual([false, false])
    const { hasSound, ...oldVideo } = homeModules[0]!.media as SampleMedia
    expect(hasSound).toBe(true)
    expect(reads.homePage.schema.safeParse({ ...answers.homePage, modules: [{ ...homeModules[0], media: oldVideo }] }).success).toBe(false)
    // Images have no such switch.
    expect(Object.keys(modules[0]!.media!)).toEqual(['kind', 'image'])
  })

  it('its button is there only when it is switched on and has words; with no link it opens the booking panel', () => {
    expect(homeModules[0]!.button).toEqual({ text: 'Book Your Experience', link: null })
    expect(modules.filter((module) => module.type === 'hero').map((module) => module.button?.text ?? null)).toEqual(['Shop', 'Gift Cards', null, 'Not yet', null, 'Book'])
  })

  it('a button can go to the gift card (/shop/gift-card) or the booking panel (/book); one to a page that is not published is hidden', () => {
    const hrefs = modules.filter((module) => module.button).map((module) => [module.button!.text, module.button!.link ? linkHref(module.button!.link) : 'the booking panel'])
    expect(hrefs).toEqual([
      ['Shop', '/shop'],
      ['Gift Cards', '/shop/gift-card'],
      ['Not yet', null],
      ['Book', '/book'],
    ])
    expect(modules.find((module) => module.key === 'h6')!.button!.link).toEqual({ destination: 'book', document: null, url: null })
  })

  it('a page no longer has a `hero` of its own: the old field is not asked for, and an unknown destination is refused', () => {
    expect(Object.keys(answers.contentPage)).not.toContain('hero')
    expect(Object.keys(answers.homePage)).not.toContain('hero')
    for (const query of [reads.homePage.query, reads.contentPage.query]) {
      expect(query).not.toContain('"hero":')
      expect(query).not.toContain('hero.media')
      expect(query).toContain('modules[_type in ["hero", "upcomingEvents"]]')
    }
    const withLink = (destination: string) => ({ ...answers.contentPage, modules: [{ ...modules[0], button: { text: 'Go', link: { destination, document: null, url: null } } }] })
    expect(reads.contentPage.schema.safeParse(withLink('giftCard')).success).toBe(true)
    expect(reads.contentPage.schema.safeParse(withLink('somewhere')).success).toBe(false)
  })
})

describe('linkHref', () => {
  const links = [...answers.navigation.menuLinks, ...footerLinks].map(({ label, link }) => [label, linkHref(link as Link)])

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
