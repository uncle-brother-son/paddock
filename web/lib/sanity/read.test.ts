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
    // W81: and the two reads of the Membership and Session Pass cards (briefs/W81-logs/tools/gen-page-samples.mjs).
    // W82: and the navigation and the info page (briefs/W82-logs/tools/gen-page-samples.mjs).
    expect(Object.keys(madeFrom).sort()).toEqual([
      'addons',
      'contentPage',
      'event',
      'eventCards',
      'eventsListPage',
      'giftCard',
      'homePage',
      'infoPage',
      'membershipCards',
      'movedSlug',
      'navigation',
      'product',
      'productCards',
      'sessionPassCards',
    ])
  })

  // W77: each add-on's first picture, for the booking panel's cards. Its sample was made by the real engine
  // (briefs/W77-logs/tools/gen-samples.mjs, in the staff app repo) over six documents: an add-on with two pictures, one
  // whose picture has no alt text written, one with no pictures, one whose first picture has no file yet, a draft,
  // and a service type with a picture.
  it('W77: an add-on has its first picture, or none; drafts and other types are not read', () => {
    expect(answers.addons.map((addon) => [addon.id, addon.picture?.ref ?? null, addon.picture?.alt ?? null])).toEqual([
      ['addon-knoll', 'image-knoll-1200x1500-jpg', 'A bottle of High Brown Knoll'],
      ['addon-towel', 'image-towel-800x800-jpg', ''],
      ['addon-robe', null, null],
      ['addon-tea', null, null],
    ])
    expect(answers.addons[0]!.picture).toMatchObject({ width: 1200, height: 1500, crop: { top: 0.1, right: 0.05 }, hotspot: { x: 0.5, y: 0.4 } })
    expect(reads.addons.query).toContain('_type == "addon" && !(_id in path("drafts.**"))')
    expect(reads.addons.query).toContain('images[0]')
  })

  // W75 (WQ60): the page that holds the Upcoming Events list, found by its module. Its sample was made by the real
  // engine (briefs/W75-logs/tools/gen-samples.mjs, in the staff app repo) over five pages: the home page (no list), a
  // draft that holds one, a page with no address that holds one, Exclusive Hire (two lists), and a newer page with one.
  it('W75: the events list is on the first-made published page that holds the module, by its own slug', () => {
    // W80 (WQ83): with the Section ID an editor gave its list, which is none here: the list is `events`.
    expect(answers.eventsListPage).toEqual({ slug: 'exclusive-hire', isHome: false, sectionId: null })
    expect(reads.eventsListPage.query).toContain('!(_id in path("drafts.**"))')
    expect(reads.eventsListPage.query).toContain('defined(slug.current)')
    expect(reads.eventsListPage.query).toContain('order(_createdAt asc)[0]')
  })

  it("a gallery keeps its order, videos among the pictures; an item with no file is left out", () => {
    // The sample product's gallery: a video, a picture, a picture with no file, a decorative picture, a video with no poster.
    expect(kinds(answers.product.gallery)).toEqual(['video', 'image', 'image'])
    // W73c (WQ42): a video's poster has no alt of its own; its description ("Steam") is what describes it.
    expect(answers.product.gallery[0]).toMatchObject({ kind: 'video', url: 'https://cdn.sanity.io/files/p/d/vid.mp4', description: 'Steam', poster: { ref: 'image-hero-1600x900-jpg', alt: '' } })
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

// W73b (Wayne, 24 Nov): HeroMedia is a module of a page, not a field of every page. The two page samples were made
// again by the real engine (briefs/W73b-logs/tools/gen-samples.mjs) over a home page with one HeroMedia (a video, a button
// with no link) and a page with seven HeroMedia modules in every state among its other modules.
// W73b Level 3 (Wayne, 24 Nov): made again for a video's "Has Sound" switch and a link to the booking panel; and for
// WQ35: a video's file and poster for phones are in the media block itself, and HeroMedia's own "media for phones"
// is gone. The media query is the galleries' too, so their samples were made again with it (each video gained
// `hasSound`, `mobileUrl` and `mobilePoster`, nothing else changed).
describe('W73b: HeroMedia module', () => {
  type SamplePicture = { ref: string; alt: string; hotspot: { x: number; y: number } | null }
  type SampleMedia = { kind: string; hasSound?: boolean; url?: string; mobileUrl?: string | null; poster?: SamplePicture; mobilePoster?: SamplePicture | null }
  type SampleModule = { type: string; key: string; media?: SampleMedia | null; button?: { text: string; link: Link | null } | null; heading?: string | null }
  const homeModules = answers.homePage.modules as SampleModule[]
  // W80: the page sample gained the content modules after these nine, which keep their keys and their places
  // (lib/modules/content.test.ts holds the new ones).
  const modules = (answers.contentPage.modules as unknown as SampleModule[]).slice(0, 9)

  it("a page's modules keep their order, each with the fields of its own kind; a kind the site does not know is left out", () => {
    expect(modules.map((module) => [module.key, module.type])).toEqual([
      ['h1', 'heroMedia'],
      ['m', 'upcomingEvents'],
      ['h2', 'heroMedia'],
      ['h3', 'heroMedia'],
      ['h4', 'heroMedia'],
      ['h5', 'heroMedia'],
      ['h6', 'heroMedia'],
      ['h7', 'heroMedia'],
      ['m2', 'upcomingEvents'],
    ])
    for (const one of modules) expect(Object.keys(one).sort(), one.key).toEqual(one.type === 'heroMedia' ? ['button', 'key', 'media', 'sectionId', 'theme', 'type'] : ['heading', 'key', 'sectionId', 'theme', 'type'])
    expect(modules.filter((module) => module.type === 'upcomingEvents').map((module) => module.heading)).toEqual(['Upcoming', null])
  })

  it('a HeroMedia has its picture or its video; one with no file, or a video with no poster, has none', () => {
    expect(homeModules.map((module) => module.media?.kind)).toEqual(['video'])
    expect(homeModules[0]!.media).toMatchObject({ url: 'https://cdn.sanity.io/files/p/d/vid.mp4', description: 'Steam', poster: { ref: 'image-hero-1600x900-jpg' } })
    // h5: a video with no main poster is no video, whatever it has for phones.
    expect(modules.filter((module) => module.type === 'heroMedia').map((module) => module.media?.kind ?? null)).toEqual(['image', 'image', null, null, null, 'video', 'video'])
    // A decorative picture's alt is "".
    expect(modules[0]!.media).toMatchObject({ kind: 'image', image: { alt: '' } })
  })

  it('WQ35: a video is one film: a file and a poster for desktops, and for phones a file, a poster, both or neither', () => {
    const byKey = (key: string) => modules.find((module) => module.key === key)!.media!
    const forPhones = (media: SampleMedia) => [media.mobileUrl?.split('/').pop() ?? null, media.mobilePoster?.ref ?? null]
    // Home: both. h6: a file only. h7: a poster only. The main file and poster are always there.
    expect(forPhones(homeModules[0]!.media!)).toEqual(['tall.mp4', 'image-tall-900x1600-jpg'])
    expect(forPhones(byKey('h6'))).toEqual(['tall.mp4', null])
    expect(forPhones(byKey('h7'))).toEqual([null, 'image-tall-900x1600-jpg'])
    for (const media of [homeModules[0]!.media!, byKey('h6'), byKey('h7')]) expect([media.url, media.poster?.ref]).toEqual(['https://cdn.sanity.io/files/p/d/vid.mp4', 'image-hero-1600x900-jpg'])
    // The poster for phones keeps its hotspot. W73c (WQ42): neither poster has an alt of its own: the description
    // describes the film and its posters. The sample home hero's document still holds an alt and the decorative
    // switch under its poster (as the live Home did): neither is in the answer.
    expect(homeModules[0]!.media!.mobilePoster).toMatchObject({ alt: '', hotspot: { x: 0.5, y: 0.4 } })
    expect(homeModules[0]!.media!.poster!.alt).toBe('')
    expect(JSON.stringify(answers.homePage)).not.toMatch(/An old alt of its own|decorative/)
    for (const query of [reads.homePage.query, reads.product.query]) expect(query).toMatch(/"poster": poster\{[^}]*"alt": "",/)
    // One description, one captions file and one sound switch: nothing of them is said twice.
    expect(Object.keys(homeModules[0]!.media!).sort()).toEqual(['captionsUrl', 'description', 'hasSound', 'kind', 'mobilePoster', 'mobileUrl', 'poster', 'url'])
    // The galleries' videos have neither yet.
    const videos = [...answers.product.gallery, ...answers.giftCard.digitalGallery].filter((item) => item.kind === 'video') as SampleMedia[]
    expect(videos.map(forPhones)).toEqual([[null, null], [null, null]])
  })

  it("WQ35: a picture is one file, whatever is left in its block; and HeroMedia's own old media for phones is not asked for", () => {
    // The sample hero h2 is a picture whose document still holds a file and a poster for phones, and the module's old field.
    expect(Object.keys(modules[2]!.media!)).toEqual(['kind', 'image'])
    expect(JSON.stringify(answers.contentPage)).not.toContain('mobileMedia')
    for (const query of [reads.homePage.query, reads.contentPage.query]) expect(query).not.toContain('mobileMedia')
    expect(reads.contentPage.schema.safeParse({ ...answers.contentPage, modules: [{ ...modules[0], mobileMedia: null }] }).success).toBe(true)
    expect(reads.contentPage.schema.parse({ ...answers.contentPage, modules: [{ ...modules[0], mobileMedia: null }] })!.modules[0]).not.toHaveProperty('mobileMedia')
  })

  it('W73b Level 3: every video says whether it has sound: only one whose switch was turned on does', () => {
    expect(homeModules[0]!.media?.hasSound).toBe(true)
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
    expect(modules.filter((module) => module.type === 'heroMedia').map((module) => module.button?.text ?? null)).toEqual(['Shop', 'Gift Cards', null, 'Not yet', null, 'Book', null])
  })

  it('a button can go to the gift card (/shop/gift-card) or the booking panel (/book); one to a page that is not published is hidden', () => {
    const hrefs = modules.filter((module) => module.button).map((module) => [module.button!.text, module.button!.link ? linkHref(module.button!.link) : 'the booking panel'])
    expect(hrefs).toEqual([
      ['Shop', '/shop'],
      ['Gift Cards', '/shop/gift-card'],
      ['Not yet', null],
      ['Book', '/book'],
    ])
    expect(modules.find((module) => module.key === 'h6')!.button!.link).toEqual({ destination: 'book', document: null, url: null, sectionId: null })
  })

  it('a page no longer has a `hero` of its own: the old field is not asked for, and an unknown destination is refused', () => {
    expect(Object.keys(answers.contentPage)).not.toContain('hero')
    expect(Object.keys(answers.homePage)).not.toContain('hero')
    for (const query of [reads.homePage.query, reads.contentPage.query]) {
      expect(query).not.toContain('"hero":')
      expect(query).not.toContain('hero.media')
      expect(query).toContain(
        'modules[_type in ["heroMedia", "upcomingEvents", "pageHeader", "galleryCarousel", "accordionList", "textMediaSticky", "textBlock", "sectionSpacer", "memberships", "sessionPasses"]]',
      )
      // W83: the module's old name (`hero`, before W79) is no longer read: no document holds it.
      expect(query).toContain('"type": _type,')
      expect(query).not.toMatch(/"hero"/)
    }
    const withLink = (destination: string) => ({ ...answers.contentPage, modules: [{ ...modules[0], button: { text: 'Go', link: { destination, document: null, url: null, sectionId: null } } }] })
    expect(reads.contentPage.schema.safeParse(withLink('giftCard')).success).toBe(true)
    expect(reads.contentPage.schema.safeParse(withLink('somewhere')).success).toBe(false)
  })
})

// W82 (WQ90): a content page's and an info page's thumbnail is the media block, a picture or a video. The navigation
// and the info page samples were made by the real engine (briefs/W83-logs/tools: gen-samples-w72a.mjs and
// gen-page-samples.mjs) over Exclusive Hire's and Terms' thumbnails as media block pictures (Hire's with a crop), The
// Experience's a video, and Manage Cookies' the empty old default the live one held.
describe('W82: page thumbnails', () => {
  type Thumbnail = { kind: string; image?: { ref: string; crop: unknown }; url?: string; poster?: { ref: string }; description?: string } | null
  const thumbnailOf = (label: string): Thumbnail =>
    ((answers.navigation.menuLinks as Array<{ label: string; link: { document: { thumbnail: Thumbnail } | null } }>).find((link) => link.label === label)?.link.document?.thumbnail ?? null)

  it('a media block picture is read as a picture, its crop kept', () => {
    expect(thumbnailOf('Exclusive Hire')).toMatchObject({ kind: 'image', image: { ref: 'image-thumb-600x400-jpg', crop: { left: 0.1 } } })
    expect(answers.contentPage.thumbnail).toEqual(thumbnailOf('Exclusive Hire'))
  })

  it('a media block picture is a picture, and a video is its file, poster and description', () => {
    expect(answers.infoPage.thumbnail).toMatchObject({ kind: 'image', image: { ref: 'image-thumb-600x400-jpg', alt: 'Picture thumb' } })
    expect(thumbnailOf('The Experience')).toMatchObject({ kind: 'video', url: 'https://cdn.sanity.io/files/p/d/vid.mp4', poster: { ref: 'image-tall-900x1600-jpg', alt: '' }, description: 'Steam' })
  })

  it('the empty old default (no file), no thumbnail and an event are none', () => {
    expect(['Manage Cookies', 'Home', 'Solstice'].map(thumbnailOf)).toEqual([null, null, null])
  })

  it('the shape saved before W82 (a plain picture) is no longer read (W83): no thumbnail read names it', () => {
    for (const name of ['navigation', 'contentPage', 'infoPage'] as const) {
      expect(reads[name].query).toContain('"thumbnail": select(\n  defined(thumbnail) => thumbnail{"item": ')
      expect(reads[name].query).not.toContain('thumbnail.asset._ref')
    }
    expect(reads.contentPage.schema.safeParse({ ...answers.contentPage, thumbnail: { ref: 'image-thumb-600x400-jpg', width: 600, height: 400, alt: '', crop: null, hotspot: null } }).success).toBe(false)
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
      ['The Experience', '/the-experience'],
      ['Manage Cookies', '/info/manage-cookies'],
      ['Terms', '/info/terms'],
      ['Outside', 'https://example.com'],
    ])
  })
})
