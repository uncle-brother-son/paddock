import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  checkAlt,
  checkButtonLink,
  checkButtonText,
  checkLinkPart,
  checkLinkSet,
  checkMediaPicture,
  checkMediaVideo,
  checkPhoneVideo,
  checkPoster,
  checkRowCells,
  checkSlug,
  checkTime,
  checkValidityPlaceholder,
  hasPhoneVersion,
  checkVideoDescription,
  previousSlugsAfter,
  sameSlugs,
  SLUG_FREE_QUERY,
} from '../../../studio/lib/checks'
import cases from './slug-cases.json'

// Brief W72: what the Studio refuses (studio/lib/checks.ts). The slugs' own test is lib/routes/reserved-slugs.test.ts.
// Brief W72a: the old slugs a document keeps, which slugs are free, and how the Studio's types use both.

const STUDIO = path.resolve(__dirname, '../../../studio')
const studioFile = (file: string) => readFileSync(path.join(STUDIO, file), 'utf8')

const picture = { asset: { _ref: 'image-a-1x1-jpg' } }

describe('pictures and videos', () => {
  it('alt text: required once there is a picture, unless it is decorative', () => {
    expect(checkAlt(undefined, undefined)).toBe(true)
    expect(checkAlt(undefined, {})).toBe(true)
    expect(checkAlt(undefined, picture)).toContain('Describe the picture')
    expect(checkAlt('  ', picture)).toContain('Describe the picture')
    expect(checkAlt('A sauna', picture)).toBe(true)
    expect(checkAlt(undefined, { ...picture, decorative: true })).toBe(true)
  })

  it('an image needs its picture; a video needs an MP4, a poster and a description', () => {
    expect(checkMediaPicture(undefined, 'image')).toBe('Add a picture.')
    expect(checkMediaPicture(undefined, undefined)).toBe('Add a picture.')
    expect(checkMediaPicture(picture, 'image')).toBe(true)
    expect(checkMediaPicture(undefined, 'video')).toBe(true)
    expect(checkMediaVideo(undefined, 'image')).toBe(true)
    expect(checkMediaVideo(undefined, 'video')).toBe('Upload an MP4 file.')
    expect(checkMediaVideo({ asset: { _ref: 'file-a-mov' } }, 'video')).toContain('not an MP4')
    expect(checkMediaVideo({ asset: { _ref: 'file-a-mp4' } }, 'video')).toBe(true)
    expect(checkPoster(undefined, 'video')).toContain('before the video plays')
    expect(checkPoster(picture, 'video')).toBe(true)
    expect(checkPoster(undefined, 'image')).toBe(true)
    expect(checkVideoDescription(' ', 'video')).toContain('what the video shows')
    expect(checkVideoDescription('Steam', 'video')).toBe(true)
    expect(checkVideoDescription(undefined, 'image')).toBe(true)
  })
})

describe('links and buttons', () => {
  it('a link goes somewhere, and has the part its destination needs', () => {
    expect(checkLinkSet(undefined)).toBe('Choose where the link goes.')
    expect(checkLinkSet({ destination: 'shop' })).toBe(true)
    expect(checkLinkPart('page', undefined, { destination: 'page' })).toBe('Choose the page.')
    expect(checkLinkPart('page', { _ref: 'x' }, { destination: 'page' })).toBe(true)
    expect(checkLinkPart('event', undefined, { destination: 'event' })).toBe('Choose the event.')
    expect(checkLinkPart('external', ' ', { destination: 'external' })).toBe('Type the address.')
    expect(checkLinkPart('external', 'https://example.com', { destination: 'external' })).toBe(true)
    expect(checkLinkPart('page', undefined, { destination: 'shop' })).toBe(true)
    expect(checkLinkPart('page', undefined, undefined)).toBe(true)
  })

  it('a button that shows has words', () => {
    expect(checkButtonText(undefined, true)).toContain('Type the words')
    expect(checkButtonText('Book', true)).toBe(true)
    expect(checkButtonText(undefined, false)).toBe(true)
  })

  it('W73b: a link can go to the gift card or the booking panel, which have nothing to pick', () => {
    const source = studioFile('schemaTypes/objects/linkTo.ts')
    // The destinations, in the order an editor sees them.
    expect([...source.matchAll(/\{ title: '([^']+)', value: '([^']+)' \}/g)].map((match) => [match[1], match[2]])).toEqual([
      ['A page', 'page'],
      ['An event', 'event'],
      ['The shop', 'shop'],
      ['The gift card', 'giftCard'],
      ['The booking panel', 'book'],
      ['An outside address', 'external'],
    ])
    for (const destination of ['giftCard', 'book']) {
      expect(checkLinkSet({ destination })).toBe(true)
      for (const part of ['page', 'event', 'external'] as const) expect(checkLinkPart(part, undefined, { destination })).toBe(true)
    }
    // The menu's list of links names where each of them goes.
    expect(studioFile('schemaTypes/objects/navLink.ts')).toContain("giftCard: 'The gift card', book: 'The booking panel'")
  })

  it('W73b Level 3: a video has a "Has Sound" switch, off until an editor turns it on, and shown for a video only', () => {
    const media = studioFile('schemaTypes/objects/media.ts')
    expect(media).toMatch(/name: 'hasSound',\s+title: 'Has Sound',\s+type: 'boolean',\s+fieldset: 'details',\s+description: '[^']+',\s+initialValue: false,\s+hidden: isNotVideo,/)
  })

  // WQ35 (Wayne, 24 Nov): every video is one film with a desktop file and an optional file for phones, sharing its text.
  it('WQ35: a video takes an optional file and an optional poster for phones; its description, captions and sound stay single', () => {
    const media = studioFile('schemaTypes/objects/media.ts')
    // The field names are as WQ35 made them (W73c only groups them): the site's query asks for these.
    for (const name of ['video', 'mobileVideo', 'poster', 'mobilePoster', 'videoDescription', 'captions', 'hasSound']) expect(media).toContain(`name: '${name}',`)
    // Both fields for phones are for a video only, and neither is required: a film may have one file.
    expect(media).toMatch(/name: 'mobileVideo',[\s\S]*?options: \{ accept: 'video\/mp4' \},[\s\S]*?hidden: isNotVideo,\s+validation: \(rule\) => rule\.custom\(\(value\) => checkPhoneVideo\(value\)\),/)
    expect(media).toMatch(/name: 'mobilePoster',\s+title: 'Poster for Phones',\s+type: 'image',\s+fieldset: PHONES_GROUP,\s+options: \{ hotspot: true \},\s+description: '[^']+',\s+hidden: isNotVideo,\s+\}\),/)
    expect(checkPhoneVideo(undefined)).toBe(true)
    expect(checkPhoneVideo({})).toBe(true)
    expect(checkPhoneVideo({ asset: { _ref: 'file-a-mp4' } })).toBe(true)
    expect(checkPhoneVideo({ asset: { _ref: 'file-a-mov' } })).toContain('not an MP4')
  })

  // W73c (WQ42, Wayne 24 Nov): clearer video fields. Fieldsets, not new objects, so every field keeps its name.
  describe('W73c: a video\'s fields in three groups', () => {
    const media = studioFile('schemaTypes/objects/media.ts')
    /** Every field of the block, in the order an editor meets it: its name, title, type and group. */
    const fields = [...media.matchAll(/defineField\(\{\s+name: '(\w+)',\s+title: '([^']+)',\s+type: '(\w+)',(?:\s+fieldset: ('\w+'|PHONES_GROUP),)?/g)].map((match) => [match[1], match[2], match[3], match[4]?.replace(/'/g, '') ?? null])

    it('Video (its file, its poster), For phones (the two for phones), Description & sound (description, captions, Has Sound), in that order', () => {
      expect(fields).toEqual([
        ['kind', 'Kind', 'string', null],
        ['image', 'Image', 'picture', null],
        ['video', 'Video (MP4)', 'file', 'video'],
        ['poster', 'Poster', 'image', 'video'],
        ['mobileVideo', 'Video for Phones (MP4)', 'file', 'PHONES_GROUP'],
        ['mobilePoster', 'Poster for Phones', 'image', 'PHONES_GROUP'],
        ['videoDescription', 'Video Description', 'string', 'details'],
        ['captions', 'Captions (WebVTT)', 'file', 'details'],
        ['hasSound', 'Has Sound', 'boolean', 'details'],
      ])
      expect(studioFile('components/MediaInput.ts')).toContain("export const PHONES_GROUP = 'phones'")
    })

    it('each group is there for a video only; Video and Description & sound are open, For phones can be closed and starts closed', () => {
      expect(media).toContain("{ name: 'video', title: 'Video', hidden: blockIsNotVideo },")
      expect(media).toContain("{ name: PHONES_GROUP, title: 'For phones (optional)', options: { collapsible: true, collapsed: true }, hidden: blockIsNotVideo },")
      expect(media).toContain("{ name: 'details', title: 'Description & sound', hidden: blockIsNotVideo },")
      // A fieldset's rule is handed the block itself as `value` (a field's rule gets it as `parent`).
      expect(media).toContain("const blockIsNotVideo = ({ value }: { value?: unknown }) => kindOf(value) !== 'video'")
    })

    it('For phones opens by itself when the video already has a file or a poster for phones, and only then', () => {
      const file = { asset: { _ref: 'file-a-mp4' } }
      const image = { asset: { _ref: 'image-a-1x1-jpg' } }
      expect(hasPhoneVersion({ kind: 'video', mobileVideo: file })).toBe(true)
      expect(hasPhoneVersion({ kind: 'video', mobilePoster: image })).toBe(true)
      expect(hasPhoneVersion({ kind: 'video', video: file, poster: image })).toBe(false)
      // A field cleared in the Studio can leave an empty object behind: that is not a file.
      expect(hasPhoneVersion({ kind: 'video', mobileVideo: {}, mobilePoster: { asset: {} } })).toBe(false)
      expect(hasPhoneVersion(undefined)).toBe(false)
      const input = studioFile('components/MediaInput.ts')
      expect(input).toContain('const hasPhones = hasPhoneVersion(value)')
      expect(input).toMatch(/useEffect\(\(\) => \{\s+if \(hasPhones\) expand\.current\(PHONES_GROUP\)\s+\}, \[hasPhones\]\)/)
      expect(media).toContain('components: { input: MediaInput },')
    })

    it('a poster is a plain image with a hotspot: no Alt Text, no Decorative switch; the Video Description says it is used for the posters', () => {
      expect(media).toMatch(/name: 'poster',\s+title: 'Poster',\s+type: 'image',\s+fieldset: 'video',\s+options: \{ hotspot: true \},\s+description: '[^']+',\s+hidden: isNotVideo,\s+validation: \(rule\) => rule\.custom\(\(value, context\) => checkPoster\(value as Picture, kindOf\(context\.parent\)\)\),/)
      expect(media).toContain(`description: "What the video shows, for people who can't see it. Also used for the posters",`)
      // An image (Kind = Image) is still the picture block, with its Alt Text and its Decorative switch.
      expect(fields[1]).toEqual(['image', 'Image', 'picture', null])
      const picture = studioFile('schemaTypes/objects/picture.ts')
      expect(picture).toContain("name: 'alt'")
      expect(picture).toContain("name: 'decorative'")
    })

    it('a video still needs its file, its poster and its description', () => {
      expect(media).toContain('checkMediaVideo(value, kindOf(context.parent))')
      expect(media).toContain('checkPoster(value as Picture, kindOf(context.parent))')
      expect(media).toContain('checkVideoDescription(value, kindOf(context.parent))')
      expect(checkMediaVideo(undefined, 'video')).toBe('Upload an MP4 file.')
      expect(checkPoster(undefined, 'video')).toContain('before the video plays')
      expect(checkVideoDescription('', 'video')).toContain('what the video shows')
    })

    it('every description is one line', () => {
      // A field's description, on a line of its own (the preview's `description` is another thing).
      const descriptions = [...media.matchAll(/^\s+description: (?:'([^']+)'|"([^"]+)"),$/gm)].map((match) => match[1] ?? match[2] ?? '')
      expect(descriptions).toHaveLength(7)
      for (const description of descriptions) expect(description.length, description).toBeLessThanOrEqual(90)
    })
  })

  describe("W73c: the Hero's button", () => {
    const hero = studioFile('schemaTypes/objects/hero.ts')

    it('Show a Button comes first; its words and its link show only while it is on', () => {
      const order = ['showButton', 'buttonText', 'buttonLink'].map((name) => hero.indexOf(`name: '${name}'`))
      expect(order.every((at) => at > 0)).toBe(true)
      expect([...order].sort((one, other) => one - other)).toEqual(order)
      expect(hero.match(/hidden: \(\{ parent \}\) => !shown\(parent\),/g)).toHaveLength(2)
    })

    it('the link is required while the button shows, and its hint no longer says to leave it empty', () => {
      expect(hero).toContain('validation: (rule) => rule.custom((value, context) => checkButtonLink(value as LinkTo | undefined, shown(context.parent))),')
      expect(checkButtonLink(undefined, true)).toContain('Choose where the button goes')
      expect(checkButtonLink({}, true)).toContain('Choose where the button goes')
      expect(checkButtonLink({ destination: 'book' }, true)).toBe(true)
      expect(checkButtonLink({ destination: 'page' }, true)).toBe(true)
      // Switched off, nothing is asked of it.
      expect(checkButtonLink(undefined, false)).toBe(true)
      expect(checkButtonLink(undefined, undefined)).toBe(true)
      expect(hero).not.toMatch(/[Ll]eave empty/)
      expect(hero).toContain(`description: 'Where the button goes. Choose "The booking panel" for a button that opens booking',`)
    })
  })

  it("WQ35: the Sanity webhook reads none of it: a gallery's picture for the staff app is still its first image", () => {
    const webhook = readFileSync(path.resolve(__dirname, '../../app/api/sanity/webhook/route.ts'), 'utf8')
    // W73c: nor a poster, but in the comment that says so.
    expect(webhook.match(/poster/gi)).toHaveLength(1)
    expect(webhook).toContain("A video's poster and file are never read.")
    expect(webhook).not.toMatch(/mobileVideo|mobilePoster|hasSound|videoDescription/)
    expect(webhook).toContain("if (item === null || typeof item !== 'object' || item.kind === 'video') continue")
    // What check:fast holds the webhook to reading of a media block: its kind and its image.
    const levels = readFileSync(path.resolve(__dirname, '../../scripts/check-fast-level.mjs'), 'utf8')
    expect(levels).toMatch(/export const WEBHOOK_BLOCKS = \{\s+media: \['kind', 'image'\],\s+picture: \[\],\s+\}/)
  })
})

describe('W73b: the Hero is a module of a page', () => {
  it('a page has no `hero` field of its own; Hero is the first kind of module, beside Upcoming Events', () => {
    const page = studioFile('schemaTypes/contentPage.ts')
    expect(page).not.toMatch(/name: 'hero'/)
    expect(page).toContain("of: [defineArrayMember({ type: 'hero' }), defineArrayMember({ type: 'upcomingEvents' })],")
    expect(studioFile('schemaTypes/infoPage.ts')).not.toMatch(/hero/)
  })

  it('the module is media (an image or an MP4) and the optional button: a show switch, its words, its link; it has no media for phones of its own (WQ35)', () => {
    const hero = studioFile('schemaTypes/objects/hero.ts')
    expect(hero).toContain("name: 'hero'")
    expect(hero).toContain("type: 'object'")
    // The type itself, then its fields in order.
    expect([...hero.matchAll(/name: '(\w+)', title: '[^']+', type: '(\w+)'|name: '(\w+)',\s+title: '[^']+',\s+type: '(\w+)'/g)].map((match) => [match[1] ?? match[3], match[2] ?? match[4]])).toEqual([
      ['hero', 'object'],
      ['media', 'media'],
      ['showButton', 'boolean'],
      ['buttonText', 'string'],
      ['buttonLink', 'linkTo'],
    ])
    // In a list of modules it says what it is.
    expect(hero).toContain("return { title: 'Hero'")
    expect(studioFile('schemaTypes/index.ts')).toMatch(/\n {2}hero,\n/)
  })
})

describe('the rest', () => {
  it("a size guide's row has one cell per column", () => {
    expect(checkRowCells(['S', '100'], ['Size', 'Chest'])).toBe(true)
    expect(checkRowCells(['S'], ['Size', 'Chest'])).toBe('This row has 1 of 2 cells.')
    expect(checkRowCells(undefined, ['Size'])).toBe('This row has 0 of 1 cells.')
  })

  it.each(['00:00', '09:30', '23:59'])('%s is a time', (time) => {
    expect(checkTime(time)).toBe(true)
  })

  it.each(['9:30', '24:00', '09:60', '9am'])('%s is not a 24-hour time', (time) => {
    expect(checkTime(time)).toContain('24-hour')
  })

  it('the gift card terms hold {validity}, whole', () => {
    const terms = (...texts: string[]) => [{ children: texts.map((text) => ({ text })) }]
    expect(checkValidityPlaceholder(undefined)).toBe(true)
    expect(checkValidityPlaceholder(terms('Valid for {validity}.'))).toBe(true)
    expect(checkValidityPlaceholder(terms('Valid for a year.'))).toContain('{validity}')
    expect(checkValidityPlaceholder(terms('Valid for {vali', 'dity}.'))).toContain('{validity}')
  })
})

describe('W72a: the old slugs a document keeps', () => {
  it('a changed slug is published: the slug it had joins the list', () => {
    expect(previousSlugsAfter(undefined, 'hire', 'private-hire')).toEqual(['hire'])
    expect(previousSlugsAfter(['hire'], 'private-hire', 'exclusive-hire')).toEqual(['hire', 'private-hire'])
  })

  it('nothing to keep: a first publish, a publish with the same slug, a document with no slug yet', () => {
    expect(previousSlugsAfter(undefined, undefined, 'new-page')).toEqual([])
    expect(previousSlugsAfter(undefined, 'same', 'same')).toEqual([])
    expect(previousSlugsAfter(['old'], 'same', 'same')).toEqual(['old'])
    expect(previousSlugsAfter(['old'], undefined, undefined)).toEqual(['old'])
    expect(previousSlugsAfter(['old'], '', 'now')).toEqual(['old'])
  })

  it('a slug that comes back to an old value leaves the list, so it never points at itself', () => {
    // winter-swim, then winter-dip, then winter-swim again.
    const once = previousSlugsAfter(undefined, 'winter-swim', 'winter-dip')
    expect(once).toEqual(['winter-swim'])
    const back = previousSlugsAfter(once, 'winter-dip', 'winter-swim')
    expect(back).toEqual(['winter-dip'])
    expect(back).not.toContain('winter-swim')
    // Whatever order it happens in, the current slug is never among the old ones.
    for (const [previous, published, next] of [[['a', 'b'], 'c', 'a'], [['a', 'b', 'c'], 'c', 'b'], [['a'], 'a', 'a'], [['a', 'a'], 'b', 'a']] as const) {
      expect(previousSlugsAfter(previous, published, next), `${previous} ${published} ${next}`).not.toContain(next)
    }
  })

  it('a slug is kept once, however often it is left', () => {
    expect(previousSlugsAfter(['a', 'b'], 'a', 'c')).toEqual(['a', 'b'])
    expect(previousSlugsAfter(['a', 'a', 'b'], 'b', 'c')).toEqual(['a', 'b'])
  })

  it('a publish that changes none of them writes nothing', () => {
    expect(sameSlugs([], previousSlugsAfter([], 'same', 'same'))).toBe(true)
    expect(sameSlugs(['a'], previousSlugsAfter(['a'], 'b', 'b'))).toBe(true)
    expect(sameSlugs(['a'], previousSlugsAfter(['a'], 'b', 'c'))).toBe(false)
    expect(sameSlugs(['a', 'b'], ['b', 'a'])).toBe(false)
    expect(sameSlugs(['a'], [])).toBe(false)
  })
})

describe('W72a: a slug in use, or in any document\'s old slugs, cannot be taken by another document of its type', () => {
  // slug-cases.json: what SLUG_FREE_QUERY answered, run by Sanity's own engine (groq-js) over the sample documents of
  // redirects.test.ts. It carries the query it was made from.
  const free = (type: string, published: string, slug: string): boolean => {
    const found = cases.slugFree.cases.find((one) => one.type === type && one.published === published && one.slug === slug)
    if (!found) throw new Error(`slug-cases.json has no case for ${type} ${published} "${slug}".`)
    return found.answer
  }

  it('the cases were made by the query the Studio sends', () => {
    expect(cases.slugFree.query).toBe(SLUG_FREE_QUERY)
    expect(studioFile('lib/slugs.ts')).toContain('client.fetch<boolean>(SLUG_FREE_QUERY, { type: document._type, published: getPublishedId(document._id), slug })')
    // Every version of every document is read: another document's draft holds its slug too.
    expect(studioFile('lib/slugs.ts')).toContain("withConfig({ perspective: 'raw' })")
  })

  it.each([
    ['a slug another product has', 'product', 'prod-new', 'herd-hoodie-moss', false],
    ['a slug another product had before', 'product', 'prod-new', 'hoodie-moss', false],
    ['the same, for a product that exists', 'product', 'prod-2', 'hoodie-moss', false],
    ["a slug another product's draft has", 'product', 'prod-new', 'draft-product', false],
    ["a slug an event's draft had before", 'event', 'event-new', 'draft-old', false],
    ["an old slug of another event", 'event', 'event-1', 'winter-dip', false],
    ["a page's old slug, for another page", 'contentPage', 'page-new', 'private-hire', false],
    ['a slug nobody has or had', 'product', 'prod-new', 'brand-new', true],
    ["its own slug (its draft holds it too)", 'product', 'prod-1', 'herd-hoodie-moss', true],
    ['its own old slug, to go back to', 'product', 'prod-1', 'hoodie-moss', true],
    ["its own draft's slug and old slug", 'event', 'event-3', 'draft-new', true],
    ['its own old slug, on an event', 'event', 'event-7', 'winter-dip', true],
    ["an event's slug, for a product: another part of the site", 'product', 'prod-new', 'solstice-2026', true],
    ["a product's old slug, for an event", 'event', 'event-new', 'hoodie-moss', true],
    ["a page's old slug, for an info page", 'infoPage', 'info-new', 'private-hire', true],
  ])('%s: free %s', (_what, type, published, slug, expected) => {
    expect(free(type, published, slug)).toBe(expected)
  })

  it('the Studio: each type with an address checks it that way, keeps a hidden read-only list, and Publish and Duplicate are the ones that keep and drop it', () => {
    for (const file of ['contentPage.ts', 'infoPage.ts', 'product.ts', 'event.ts']) {
      const source = studioFile(`schemaTypes/${file}`)
      expect(source, file).toContain('isUnique: isSlugFree')
      expect(source, file).toMatch(/\n {4}previousSlugs,\n/)
    }
    const field = studioFile('schemaTypes/fields/previousSlugs.ts')
    expect(field).toContain("name: 'previousSlugs'")
    expect(field).toContain('hidden: true')
    expect(field).toContain('readOnly: true')
    const action = studioFile('actions/keepPreviousSlugs.ts')
    expect(action).toContain("const KEEPS_PREVIOUS_SLUGS = ['contentPage', 'infoPage', 'product', 'event']")
    expect(action).toContain('const after = previousSlugsAfter(before, published?.slug?.current, draft.slug?.current)')
    // The list is patched before the original publish runs, so the publish carries it.
    expect(action.indexOf('patch.execute([{set: {previousSlugs: after}}])')).toBeGreaterThan(0)
    expect(action.indexOf('patch.execute([{set: {previousSlugs: after}}])')).toBeLessThan(action.indexOf('original.onHandle?.()'))
    expect(action).toContain('delete copy.previousSlugs')
    const config = studioFile('sanity.config.ts')
    expect(config).toContain("if (action.action === 'publish') return keepPreviousSlugsOnPublish(action)")
    expect(config).toContain("if (action.action === 'duplicate') return duplicateWithoutPreviousSlugs(action)")
    // The gift card's address is the site's own: no slug, so nothing to keep.
    expect(studioFile('schemaTypes/giftCardType.ts')).not.toMatch(/name: 'slug'|previousSlugs|isSlugFree/)
  })
})

describe('W72a: categories and galleries in the Studio', () => {
  it("a category has a title, a slug and a whole-number order; its slug is only held to an address's shape", () => {
    const source = studioFile('schemaTypes/productCategory.ts')
    expect(source).toContain("name: 'productCategory'")
    for (const field of ["name: 'title'", "name: 'slug'", "name: 'order'"]) expect(source).toContain(field)
    expect(source).toContain('rule.required().integer()')
    expect(checkSlug('shop', 'category')).toBe(true)
    expect(checkSlug('gift-card', 'category')).toBe(true)
    expect(checkSlug('Food & Drink', 'category')).toContain('Use lowercase letters and numbers')
    expect(studioFile('schemaTypes/index.ts')).toMatch(/\n {2}productCategory,\n/)
    expect(studioFile('structure.ts')).toContain("S.documentTypeList('productCategory')")
  })

  it('a product and the gift card pick a category by reference (a strong one, so a category in use cannot be deleted); the three fixed words are gone', () => {
    for (const file of ['product.ts', 'giftCardType.ts']) {
      const source = studioFile(`schemaTypes/${file}`)
      expect(source, file).toMatch(/name: 'category',\s+title: 'Category',\s+type: 'reference',\s+to: \[\{ type: 'productCategory' \}\],/)
      expect(source, file).not.toMatch(/apparel|accessories|equipment/i)
    }
    // Weak references are named as such where they are meant (similar merch); the category's is not one.
    const category = /name: 'category',[\s\S]*?\}\),/.exec(studioFile('schemaTypes/product.ts'))?.[0] ?? ''
    expect(category).not.toContain('weak')
    expect(category).toContain('rule.required()')
  })

  it('a product, an event and the gift card have galleries of the media block and no `images`; the other four types keep `images`', () => {
    const galleries: Record<string, string[]> = { 'product.ts': ['gallery'], 'event.ts': ['gallery'], 'giftCardType.ts': ['physicalGallery', 'digitalGallery'] }
    for (const [file, names] of Object.entries(galleries)) {
      const source = studioFile(`schemaTypes/${file}`)
      for (const name of names) expect(source, `${file} ${name}`).toMatch(new RegExp(`name: '${name}',\\s+title: '[^']+',\\s+type: 'array',\\s+of: \\[defineArrayMember\\(\\{ type: 'media' \\}\\)\\],`))
      expect(source, file).not.toContain("name: 'images'")
    }
    for (const file of ['serviceType.ts', 'addon.ts', 'membershipPlan.ts', 'sessionPassType.ts']) expect(studioFile(`schemaTypes/${file}`), file).toContain("name: 'images'")
  })
})
