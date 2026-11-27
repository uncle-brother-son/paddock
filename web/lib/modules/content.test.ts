import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { childNamed, readGlobalsCss, ruleNamed } from '@/lib/design/read-stylesheet'
import { themeVariable } from '@/lib/design/token-names'
import tokens from '@/lib/design/figma-tokens.json'
import { EVENTS_LIST_ID, eventsListAddress } from '@/lib/events/event'
import { linkHref } from '@/lib/sanity/links'
import answers from '@/lib/sanity/sample-answers.json'
import { contentPageSchema, type PageModule } from '@/lib/sanity/schemas'

import {
  accordionListContent,
  galleryCarouselContent,
  moduleButton,
  pageHeaderContent,
  paragraphsOf,
  sectionSettings,
  shapeOf,
  STICKY_MEDIA_RATIO,
  textBlockContent,
  textMediaStickyContent,
} from './content'
import { isSectionAddress, PAGE_THEME, PAGE_THEMED, SECTION_ID_PATTERN, SECTION_THEMES, sectionAddress, sectionIdOf, THEME_FADE, themeOf } from './section'

// Brief W80: the content modules (PageHeader, GalleryCarousel, AccordionList, TextMediaSticky, TextBlock,
// SectionSpacer), every module's theme and Section ID (WQ81, WQ83), and the page's fade (WQ87). The page sample is
// Sanity's own answer (lib/sanity/read.test.ts): made by its query engine over a page that holds each module in
// several states (briefs/W80-logs/tools/gen-page-samples.mjs, in the staff app repo).

const WEB = path.resolve(__dirname, '../..')
const read = (file: string) => readFileSync(path.join(WEB, file), 'utf8')

const modules = contentPageSchema.parse(answers.contentPage).modules
const byKey = <Type extends PageModule['type']>(key: string, type: Type) => {
  const found = modules.find((module) => module.key === key)
  if (!found || found.type !== type) throw new Error(`The sample has no ${type} with the key ${key}.`)
  return found as Extract<PageModule, { type: Type }>
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SANITY_PROJECT_ID', 'project')
  vi.stubEnv('NEXT_PUBLIC_SANITY_DATASET', 'production')
})
afterEach(() => vi.unstubAllEnvs())

describe("Sanity's answer for a page", () => {
  it('holds every kind of module in the order an editor gave them; a kind the site does not know is left out', () => {
    expect(modules.slice(9).map((module) => [module.key, module.type])).toEqual([
      ['p1', 'pageHeader'],
      ['p2', 'pageHeader'],
      ['g1', 'galleryCarousel'],
      ['g2', 'galleryCarousel'],
      ['a1', 'accordionList'],
      ['a2', 'accordionList'],
      ['t1', 'textMediaSticky'],
      ['t2', 'textMediaSticky'],
      ['k1', 'textBlock'],
      ['k2', 'textBlock'],
      ['k3', 'textBlock'],
      ['e1', 'sectionSpacer'],
      ['e2', 'sectionSpacer'],
      ['h8', 'heroMedia'],
      ['m3', 'upcomingEvents'],
      // W81: the Memberships and Session Passes modules (lib/memberships/cards.test.ts).
      ['mb1', 'memberships'],
      ['mb2', 'memberships'],
      ['sp1', 'sessionPasses'],
      ['sp2', 'sessionPasses'],
    ])
    expect(JSON.stringify(answers.contentPage)).not.toContain('somethingNew')
  })

  it('WQ81, WQ83: every module has its theme (one of the four, or none) and its Section ID (or none)', () => {
    for (const one of modules) expect(Object.keys(one), one.key).toEqual(expect.arrayContaining(['theme', 'sectionId']))
    const settings = Object.fromEntries(modules.map((module) => [module.key, [module.theme, module.sectionId]]))
    expect(settings).toMatchObject({
      p1: ['mud', 'top'],
      p2: [null, null],
      g1: [null, 'gallery'],
      a1: ['mud', 'faqs'],
      // A theme the site does not know is none.
      k1: [null, null],
      e1: ['dark', 'gap'],
      h8: ['light', 'film'],
      m3: ['fjord', 'whats-on'],
      // The modules made before W80 have neither.
      h1: [null, null],
      m: [null, null],
    })
    expect(SECTION_THEMES).toEqual(tokens.themeModes.map((mode) => mode.toLowerCase()))
  })

  it('a choice an editor has not made is its default', () => {
    expect(byKey('p2', 'pageHeader')).toMatchObject({ layout: 'split', buttons: [], intro: [] })
    expect(byKey('a2', 'accordionList').padding).toBe(true)
    expect(byKey('a1', 'accordionList').padding).toBe(false)
    expect(byKey('t2', 'textMediaSticky')).toMatchObject({ size: 'small', flip: false, button: null, media: null, text: [] })
    expect(byKey('t1', 'textMediaSticky')).toMatchObject({ size: 'big', flip: true })
    expect([byKey('k1', 'textBlock').align, byKey('k2', 'textBlock').align, byKey('k3', 'textBlock').align]).toEqual(['center', 'right', 'left'])
    expect(byKey('g2', 'galleryCarousel').items).toEqual([])
  })
})

describe('a Section ID and a link to it (WQ83)', () => {
  it('is lowercase letters, numbers and hyphens; anything else is no id', () => {
    for (const id of ['memberships', 'session-passes', 'a1', '2026']) expect(sectionIdOf(id), id).toBe(id)
    for (const id of ['Memberships', 'two words', '-start', 'end-', 'two--hyphens', 'café', '#passes', '']) expect(sectionIdOf(id), id).toBeNull()
    expect(sectionIdOf('  passes  ')).toBe('passes')
    expect(sectionIdOf(null)).toBeNull()
    expect(SECTION_ID_PATTERN.source).toBe('^[a-z0-9]+(?:-[a-z0-9]+)*$')
  })

  it('a link to a section of the page is # and its id; one with no id, or one that is not an id, is hidden', () => {
    const link = (sectionId: string | null) => ({ destination: 'section' as const, document: null, url: null, sectionId })
    expect(linkHref(link('memberships'))).toBe('#memberships')
    expect(linkHref(link(null))).toBeNull()
    expect(linkHref(link('Not an id'))).toBeNull()
    expect(sectionAddress('passes')).toBe('#passes')
    expect([isSectionAddress('#passes'), isSectionAddress('#'), isSectionAddress('/shop#top'), isSectionAddress('/')]).toEqual([true, false, false, false])
    // Every other destination answers no section id.
    expect(byKey('p1', 'pageHeader').buttons.map((button) => [button.text, button.link.destination, button.link.sectionId])).toEqual([
      ['Memberships', 'section', 'memberships'],
      ['Shop', 'shop', null],
      ['Book', 'book', null],
    ])
  })

  it('the site scrolls to a section in one place: SiteLink hands every such address to SectionLink', () => {
    const siteLink = read('components/ui/SiteLink.tsx')
    expect(siteLink).toMatch(/if \(isSectionAddress\(href\)\) \{\s+return \(\s+<SectionLink href=\{href\} onClick=\{onClick\} \{\.\.\.tab\} \{\.\.\.rest\}>/)
    const sectionLink = read('components/ui/SectionLink.tsx')
    // Smoothly with Lenis, over the long duration with the smooth curve; with no Lenis (reduced motion) a jump.
    expect(sectionLink).toContain('if (lenis) lenis.scrollTo(place, { duration: DURATION_LONG, easing: EASE_SMOOTH })')
    expect(sectionLink).toContain('else place.scrollIntoView()')
    expect(sectionLink).toContain("window.history.pushState(null, '', href)")
    expect(sectionLink).toContain('place.focus({ preventScroll: true })')
  })

  it("the events list keeps `events` unless an editor gave it an id of its own, and All Events goes where it is", () => {
    expect(eventsListAddress({ slug: 'exclusive-hire', isHome: false })).toBe(`/exclusive-hire#${EVENTS_LIST_ID}`)
    expect(eventsListAddress({ slug: 'exclusive-hire', isHome: false, sectionId: null })).toBe('/exclusive-hire#events')
    expect(eventsListAddress({ slug: 'exclusive-hire', isHome: false, sectionId: 'whats-on' })).toBe('/exclusive-hire#whats-on')
    expect(eventsListAddress({ slug: 'home', isHome: true, sectionId: 'Not an id' })).toBe('/#events')
    const pageModules = read('components/modules/PageModules.tsx')
    expect(pageModules).toContain('id={one.section.sectionId ?? (index === firstEvents ? EVENTS_LIST_ID : null)}')
  })
})

describe('what each module shows', () => {
  it('a section has its theme and its id; an id that is not one is left out', () => {
    expect(sectionSettings({ theme: 'mud', sectionId: 'top' })).toEqual({ theme: 'mud', sectionId: 'top' })
    expect(sectionSettings({ theme: null, sectionId: 'Two Words' })).toEqual({ theme: null, sectionId: null })
    // Light is the page's own: a section carries a mode only for the other three.
    expect([themeOf('light'), themeOf(null), themeOf('mud'), themeOf('dark'), themeOf('fjord')]).toEqual([null, null, 'mud', 'dark', 'fjord'])
  })

  it('large text is paragraphs of plain words; an empty one is left out', () => {
    expect(paragraphsOf(byKey('p1', 'pageHeader').intro)).toEqual([
      { key: 'i1', text: 'Good company. Open countryside.' },
      { key: 'i3', text: 'A little time away from it all.' },
    ])
    expect(paragraphsOf([])).toEqual([])
  })

  it('WQ89: large text keeps its links, in order with the plain words; a link to an unpublished page is plain words', () => {
    const shop = { destination: 'shop' as const, document: null, url: null, sectionId: null }
    const unpublished = { destination: 'page' as const, document: null, url: null, sectionId: null }
    const span = (key: string, text: string, marks: string[] = []) => ({ _type: 'span' as const, _key: key, text, marks })
    const block = (key: string, children: ReturnType<typeof span>[], markDefs: Array<{ _key: string; _type: 'link'; link: typeof shop | typeof unpublished }>) => ({
      _type: 'block' as const,
      _key: key,
      style: 'normal' as const,
      listItem: null,
      level: null,
      children,
      markDefs,
    })
    expect(
      paragraphsOf([
        block('a', [span('a1', '  Visit '), span('a2', 'the shop', ['m1']), span('a3', ' today.  ')], [{ _key: 'm1', _type: 'link', link: shop }]),
        block('b', [span('b1', 'Plain words.')], []),
        block('c', [span('c1', 'See '), span('c2', 'this page', ['m2']), span('c3', '.')], [{ _key: 'm2', _type: 'link', link: unpublished }]),
        block('d', [span('d1', ' '), span('d2', ' Linked', ['m3']), span('d3', ' ')], [{ _key: 'm3', _type: 'link', link: shop }]),
      ]),
    ).toEqual([
      {
        key: 'a',
        text: 'Visit the shop today.',
        parts: [
          { key: 'a1', text: 'Visit ', href: null },
          { key: 'a2', text: 'the shop', href: '/shop' },
          { key: 'a3', text: ' today.', href: null },
        ],
      },
      { key: 'b', text: 'Plain words.' },
      { key: 'c', text: 'See this page.' },
      { key: 'd', text: 'Linked', parts: [{ key: 'd2', text: 'Linked', href: '/shop' }] },
    ])
  })

  it("a button has its words and its address; one to a page that is not published is hidden, and so is none at all", () => {
    expect(moduleButton(byKey('k1', 'textBlock').button)).toEqual({ text: 'Passes', href: '#passes' })
    expect(moduleButton(byKey('t1', 'textMediaSticky').button)).toEqual({ text: 'Book', href: '/book' })
    // The sample's k2 goes to a page that is not published: Sanity keeps the link, the site hides it.
    expect(byKey('k2', 'textBlock').button).toMatchObject({ text: 'Not yet', link: { destination: 'page', document: null } })
    expect(moduleButton(byKey('k2', 'textBlock').button)).toBeNull()
    expect(moduleButton(null)).toBeNull()
  })

  it('PageHeader: its title, intro and layout, and the first two of its whole buttons', () => {
    const header = pageHeaderContent(byKey('p1', 'pageHeader'))!
    expect(header).toMatchObject({ title: 'Exclusive Hire', layout: 'stacked', theme: 'mud', sectionId: 'top' })
    // The button with no link is not in Sanity's answer; of the three whole ones the site draws two.
    expect(header.buttons).toEqual([
      { key: 'b1', text: 'Memberships', href: '#memberships' },
      { key: 'b3', text: 'Shop', href: '/shop' },
    ])
    expect(pageHeaderContent(byKey('p2', 'pageHeader'))).toMatchObject({ title: 'Only a title', intro: [], buttons: [], layout: 'split' })
    expect(pageHeaderContent({ ...byKey('p2', 'pageHeader'), title: '  ' })).toBeNull()
  })

  it('GalleryCarousel: each picture keeps its own shape, after its crop; a video has its posters\' shapes; one with no file is left out', () => {
    const gallery = galleryCarouselContent(byKey('g1', 'galleryCarousel'))!
    expect(gallery.items.map((item) => item.key)).toEqual(['ga', 'gb', 'gd'])
    const [upright, film, wide] = gallery.items
    // 900 by 1600 with a tenth off the top and a fifth off the bottom: 900 by 1120.
    expect(upright!.shape.desktop).toBeCloseTo(900 / 1120, 5)
    expect(upright!.shape.phone).toBe(upright!.shape.desktop)
    expect([upright!.picture.desktop.width, upright!.picture.desktop.height]).toEqual([480, 597])
    // The CDN's own builder rounds the crop to whole pixels its own way.
    expect(upright!.picture.desktop.src).toContain('rect=0,161,900,1119')
    // The film: 16 by 9 on a desktop, and its own poster for phones, 9 by 16, below 768px (WQ35).
    expect([film!.shape.desktop, film!.shape.phone]).toEqual([1600 / 900, 900 / 1600])
    expect(film!.video).toMatchObject({ url: 'https://cdn.sanity.io/files/p/d/vid.mp4', phoneUrl: 'https://cdn.sanity.io/files/p/d/tall.mp4' })
    expect(film!.picture.alt).toBe('Steam')
    expect([wide!.shape.desktop, wide!.video, wide!.picture.alt]).toEqual([1600 / 900, null, 'Picture hero'])
    expect(galleryCarouselContent(byKey('g2', 'galleryCarousel'))).toBeNull()
    expect(shapeOf({ ref: 'r', width: 0, height: 0, alt: '', crop: null, hotspot: null })).toBe(1)
  })

  it('AccordionList: its heading, its padding and its questions, each with its answer as rich text; one with no question is left out', () => {
    const list = accordionListContent(byKey('a1', 'accordionList'))!
    expect(list).toMatchObject({ heading: 'Private Hire & Event Info', padding: false, theme: 'mud', sectionId: 'faqs' })
    expect(list.items.map((item) => [item.key, item.question, item.answer.length])).toEqual([
      ['q1', 'How many people?', 2],
      ['q2', 'Can we bring food?', 0],
    ])
    // The answer keeps its bold, its bullet and its link, here to a section of the page.
    const [paragraph, bullet] = list.items[0]!.answer
    expect(paragraph!.children.map((span) => [span.text, span.marks])).toEqual([['Up to ', []], ['twelve', ['strong']], ['. See ', []], ['the gallery', ['l1']]])
    expect(linkHref(paragraph!.markDefs[0]!.link)).toBe('#gallery')
    expect(bullet!.listItem).toBe('bullet')
    expect(accordionListContent({ ...byKey('a1', 'accordionList'), items: [] })).toBeNull()
  })

  it('TextMediaSticky: its words, its optional button, and its picture cut 4 by 5 for each screen', () => {
    const sticky = textMediaStickyContent(byKey('t1', 'textMediaSticky'))!
    expect(sticky).toMatchObject({ heading: 'The Herd', size: 'big', flip: true, button: { text: 'Book', href: '/book' } })
    expect(sticky.text.map((paragraph) => paragraph.text)).toEqual(['More than a membership. A community.', 'The Herd is our way of celebrating those who make The Paddock part of their routine.'])
    const { desktop, mobile } = sticky.media!.picture
    for (const cut of [desktop, mobile]) expect(cut.width / cut.height).toBeCloseTo(STICKY_MEDIA_RATIO, 2)
    expect(sticky.media!.video).toMatchObject({ hasSound: true, description: 'Steam' })
    // WQ79: no button, and no picture yet (one with no file is none).
    expect(textMediaStickyContent(byKey('t2', 'textMediaSticky'))).toMatchObject({ heading: 'Corporate Wellness', button: null, media: null, size: 'small', flip: false })
    expect(textMediaStickyContent({ ...byKey('t2', 'textMediaSticky'), heading: null })).toBeNull()
  })

  it('TextBlock: its heading, text and button, each optional, and where it stands', () => {
    expect(textBlockContent(byKey('k1', 'textBlock'))).toMatchObject({ heading: 'Book Your Experience today', align: 'center', button: { text: 'Passes', href: '#passes' }, theme: null })
    // Its button's page is not published: the block is drawn without it.
    expect(textBlockContent(byKey('k2', 'textBlock'))).toMatchObject({ heading: 'Right', align: 'right', button: null, text: [] })
    expect(textBlockContent(byKey('k3', 'textBlock'))).toMatchObject({ heading: null, align: 'left', text: [{ text: 'Only text' }] })
    expect(textBlockContent({ ...byKey('k3', 'textBlock'), text: [] })).toBeNull()
  })

  it('PageModules draws each kind with its own component, and the page\'s h1 is the first PageHeader\'s title', () => {
    const pageModules = read('components/modules/PageModules.tsx')
    for (const component of ['HeroMedia', 'UpcomingEventsModule', 'PageHeader', 'GalleryCarousel', 'AccordionList', 'TextMediaSticky', 'TextBlock', 'SectionSpacer']) {
      expect(pageModules, component).toMatch(new RegExp(`return (\\(\\s+// [^\\n]+\\s+)?<${component} key=\\{one\\.key\\}`))
    }
    expect(pageModules).toContain("const titled = shown.findIndex((one) => one.kind === 'pageHeader' && one.content.title !== null)")
    expect(pageModules).toContain('const h1 = titled < 0 ? <h1 className="sr-only">{heading}</h1> : null')
    expect(pageModules).toContain('<PageHeader key={one.key} {...one.content} headingLevel={index === titled ? 1 : 2} />')
  })
})

describe("the page's theme (WQ87)", () => {
  const css = readGlobalsCss()
  const themeColours = [...Object.keys(tokens.theme).map(themeVariable), '--color-selection-surface', '--color-selection-text']

  it('every theme colour is registered as a colour, so a browser can fade it', () => {
    expect(themeColours).toHaveLength(18)
    for (const colour of themeColours) {
      expect(ruleNamed(css, `@property ${colour}`).declarations, colour).toEqual({ syntax: '"<color>"', inherits: 'true', 'initial-value': 'transparent' })
    }
    // And nothing else is: only the theme's colours move.
    expect(css.rules.filter((rule) => rule.header.startsWith('@property ')).map((rule) => rule.header)).toEqual(themeColours.map((colour) => `@property ${colour}`))
  })

  it('the page, and the header with it, fade every one of them over the long duration with the smooth curve', () => {
    const fade = ruleNamed(css, `[${PAGE_THEME}="live"], [${THEME_FADE}]`).declarations
    expect(fade['--theme-fade']).toBe('var(--duration-long) var(--ease-smooth)')
    expect(fade['--theme-fade-colours']!.split(',').map((one) => one.trim())).toEqual(themeColours.map((colour) => `${colour} var(--theme-fade)`))
    expect(fade.transition).toBe('var(--theme-fade-colours)')
    // The header also slides away and back, which keeps the short duration.
    expect(ruleNamed(css, `[${THEME_FADE}]`).declarations.transition!.replace(/\s+/g, ' ')).toBe('translate var(--duration-short) var(--ease-smooth), var(--theme-fade-colours)')
  })

  it("while the page is watched, a module's section follows the page's theme in place of its own: every colour is the page's", () => {
    const follows = ruleNamed(css, `[${PAGE_THEME}] [${PAGE_THEMED}]`).declarations
    expect(follows).toEqual(Object.fromEntries(themeColours.map((colour) => [colour, 'inherit'])))
  })

  it('a section carries its theme and takes part; a HeroMedia has its own mode and takes none; PageTheme is drawn only when a module has a theme', () => {
    const section = read('components/modules/content/ModuleSection.tsx')
    expect(section).toContain("{...(mode ? { 'data-theme': mode, 'data-page-themed': '' } : {})}")
    expect(section).toContain("className={`${mode ? 'bg-surface-primary ' : ''}${className ?? ''}`}")
    const hero = read('components/modules/content/HeroMedia.tsx')
    expect(hero).toContain("data-theme={theme ?? 'dark'}")
    expect(hero).not.toContain('data-page-themed')
    const pageModules = read('components/modules/PageModules.tsx')
    expect(pageModules).toContain("const pageThemeOf = (one: Shown) => (one.kind === 'hero' ? null : themeOf('content' in one ? one.content.theme : one.section.theme))")
    expect(pageModules).toContain('{shown.some((one) => pageThemeOf(one) !== null) ? <PageTheme /> : null}')
    expect([PAGE_THEME, PAGE_THEMED, THEME_FADE]).toEqual(['data-page-theme', 'data-page-themed', 'data-theme-fade'])
  })

  it('the first look fades nothing, and a page being left keeps its theme and its background stays still', () => {
    const watcher = read('components/modules/PageTheme.tsx')
    expect(watcher).toMatch(/page\.setAttribute\(PAGE_THEME, 'first'\)\s+page\.dataset\.theme = theme\s+\/\/ [^\n]+\s+void page\.offsetHeight\s+page\.setAttribute\(PAGE_THEME, 'live'\)/)
    expect(watcher).toContain('if (page.hasAttribute(PAGE_LEAVING)) return')
    // The page's own themed background is the first of the still surfaces (lib/motion/page-transition.ts).
    expect(read('lib/motion/page-transition.ts')).toContain("const themed = [...(page.matches('[data-theme]') ? [page] : []), ...page.querySelectorAll<HTMLElement>('[data-theme]')]")
    // The header reads the page's theme through a section that follows it.
    expect(read('components/frame/Header.tsx')).toContain('const watched = holder?.hasAttribute(PAGE_THEMED) ? holder.closest<HTMLElement>(`[${PAGE_THEME}]`) : null')
  })
})

describe('the GalleryCarousel (WQ82)', () => {
  const css = readGlobalsCss()
  const base = childNamed(css, '@layer base')

  it("WQ89 amended: its pictures are columns of the page grid: Figma's 5 and 6 of 6 below 768px, 7 and 9 of 24 with an empty column between from 768px", () => {
    const root = childNamed(base, ':root').declarations
    const desktop = childNamed(childNamed(base, '@media (width >= 48rem)'), ':root').declarations
    const columns = (declared: Record<string, string>) => ['--gallery-upright-columns', '--gallery-wide-columns', '--gallery-gap-columns'].map((name) => declared[name])
    expect(columns(root)).toEqual(['5', '6', '0'])
    expect(columns(desktop)).toEqual(['7', '9', '1'])
    for (const declared of [root, desktop])
      expect(Object.keys(declared).filter((name) => name.startsWith('--gallery-'))).toEqual(['--gallery-upright-columns', '--gallery-wide-columns', '--gallery-gap-columns'])
    const strip = ruleNamed(css, '@utility gallery-strip').declarations
    expect(strip['--gallery-column']).toBe('calc((100cqw - 2 * var(--grid-margin) - (var(--grid-columns) - 1) * var(--grid-gutter)) / var(--grid-columns))')
    expect(strip['--gallery-upright']).toBe('calc(var(--gallery-upright-columns) * var(--gallery-column) + (var(--gallery-upright-columns) - 1) * var(--grid-gutter))')
    expect(strip['--gallery-wide']).toBe('calc(var(--gallery-wide-columns) * var(--gallery-column) + (var(--gallery-wide-columns) - 1) * var(--grid-gutter))')
    // ddc4907's one height for every picture is gone.
    expect(strip['--gallery-band']).toBeUndefined()
    expect([strip['overflow-x'], strip['overscroll-behavior-x'], strip['scrollbar-width']]).toEqual(['auto', 'contain', 'none'])
  })

  it('WQ89 amended: each picture is its columns wide and as tall as its own shape makes it, never cropped or capped; they are centred on one line', () => {
    expect(ruleNamed(css, '@utility gallery-item').declarations).toEqual({
      flex: 'none',
      width: 'var(--gallery-span)',
      'aspect-ratio': 'var(--gallery-shape)',
      // WQ93: the browser lines the strip up on a picture's start.
      'scroll-snap-align': 'start',
    })
    expect(ruleNamed(css, '@utility gallery-row').declarations).toMatchObject({ display: 'flex', 'align-items': 'center', 'column-gap': 'var(--gallery-gap)', 'padding-inline': 'var(--grid-margin)' })
  })

  it('Lenis leaves a sideways gesture over it to the browser, and the glide is the tail of the one curve', () => {
    const carousel = read('components/modules/content/GalleryCarousel.tsx')
    expect(carousel).toContain('data-lenis-prevent-horizontal=""')
    expect(carousel).toContain("import { DURATION_LONG, EASE_SMOOTH } from '@/lib/motion/tokens'")
    expect(carousel).toContain('if (reducedMotion || Math.abs(end - from) < 1) {')
    // W84 (WQ93): a release with no glide (reduced motion, a pointer taken away, held still) no longer stays where it
    // is: it goes to the nearest picture.
    expect(carousel).toContain("if (reducedMotion || event.type === 'pointercancel' || event.timeStamp - last.at > SPEED_OVER || last.at === first.at) {")
  })

  it('WQ93: it settles on a picture: the browser snaps each picture by its start at the grid margin, and never while script moves the strip', () => {
    const strip = ruleNamed(css, '@utility gallery-strip')
    expect([strip.declarations['scroll-snap-type'], strip.declarations['scroll-padding-inline-start']]).toEqual(['x mandatory', 'var(--grid-margin)'])
    // While a mouse drags it, it glides or a key moves it, the snapping is off: it would pull every place script sets.
    expect(childNamed(strip, '&[data-script-moves]').declarations).toEqual({ 'scroll-snap-type': 'none' })
    const carousel = read('components/modules/content/GalleryCarousel.tsx')
    expect(carousel).toContain("const SCRIPT_MOVES = 'data-script-moves'")
    // A mouse's glide ends at the place nearest to where it would have stopped, so it slows straight into line; a
    // release with no speed goes to the nearest from where it is. Neither place is past the strip's end.
    expect(carousel).toContain('moveTo(nearestStop(element, element.scrollLeft + distance), true)')
    expect(carousel).toContain('moveTo(nearestStop(element, element.scrollLeft), false)')
    expect(carousel).toContain('const stops = placesOf(element).map((place) => Math.min(place, end))')
  })

  it('WQ93 amended: the rows of Membership and Session Pass cards and Similar Merch settle the same way; the product gallery is as it was', () => {
    const strip = ruleNamed(css, '@utility plan-strip').declarations
    expect([strip['scroll-snap-type'], strip['scroll-padding-inline-start']]).toEqual(['x mandatory', 'var(--grid-margin)'])
    expect(ruleNamed(css, '@utility plan-card').declarations['scroll-snap-align']).toBe('start')
    // A card brought in for the keyboard comes to the same place the row rests at: its start at the margin.
    expect(read('components/modules/content/PlanCardRow.tsx')).toContain(
      'if (inner.left - margin < outer.left || inner.right + margin > outer.right) strip.scrollBy({ left: inner.left - margin - outer.left })',
    )
    const similar = read('components/modules/shop/UpSellRow.tsx')
    expect(similar).toContain('<ul className="flex snap-x snap-mandatory gap-8 overflow-x-auto px-16 ')
    expect(similar).toContain('shrink-0 snap-start scroll-ml-16 ')
    expect(read('components/shop/ProductGallery.tsx')).toContain('className="flex snap-x snap-mandatory overflow-x-auto [scrollbar-width:none] md:flex-col md:overflow-x-visible [&::-webkit-scrollbar]:hidden"')
  })
})
