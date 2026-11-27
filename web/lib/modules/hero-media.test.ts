import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import answers from '@/lib/sanity/sample-answers.json'
import { BOOK_ADDRESS } from '@/lib/sanity/links'
import { stillOf, videoOf } from '@/lib/sanity/media'
import { contentPageSchema, productSchema, type HeroMediaModule } from '@/lib/sanity/schemas'

import { HERO_RATIO, heroMediaContent } from './hero-media'

// Brief W73b, items 1 and 2, its Level 3 fixes and WQ35 (Wayne, 24 Nov): what HeroMedia module shows, from Sanity's
// answer (the samples lib/sanity/read.test.ts holds, made by Sanity's own query engine).

const heroesOf = (page: unknown): HeroMediaModule[] => contentPageSchema.parse(page).modules.filter((module): module is HeroMediaModule => module.type === 'heroMedia')
const home = heroesOf(answers.homePage)
const page = heroesOf(answers.contentPage)
const byKey = (key: string): HeroMediaModule => page.find((hero) => hero.key === key)!
const widthsOf = (srcSet: string) => srcSet.split(', ').map((entry) => entry.split(' ')[1])

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SANITY_PROJECT_ID', 'project')
  vi.stubEnv('NEXT_PUBLIC_SANITY_DATASET', 'production')
})
afterEach(() => vi.unstubAllEnvs())

describe("the hero's picture", () => {
  it("is one file, cut both ways from Sanity's CDN: 16 by 9 for a desktop, 9 by 16 for a phone", () => {
    const { picture, video } = heroMediaContent(byKey('h1'))!
    expect(video).toBeNull()
    const { desktop, mobile } = picture
    expect([desktop.width, desktop.height, mobile.width, mobile.height]).toEqual([960, 540, 390, 693])
    expect(desktop.width / desktop.height).toBeCloseTo(HERO_RATIO.desktop, 2)
    expect(mobile.width / mobile.height).toBeCloseTo(HERO_RATIO.mobile, 2)
    // The same picture at each width, each cropped to its shape and in the browser's best format.
    expect(widthsOf(desktop.srcSet)).toEqual(['960w', '1440w', '1920w', '2880w'])
    expect(widthsOf(mobile.srcSet)).toEqual(['390w', '780w', '1170w'])
    for (const address of [desktop.src, mobile.src]) {
      expect(address).toContain('https://cdn.sanity.io/images/project/production/hero-1600x900.jpg')
      expect(address).toContain('fit=crop')
      expect(address).toContain('auto=format')
    }
    expect(desktop.src).toContain('w=960&h=540')
    expect(mobile.src).toContain('w=390&h=693')
    // A decorative picture has no alt text to read out.
    expect(picture.alt).toBe('')
    expect(heroMediaContent(byKey('h2'))!.picture.alt).toBe('Picture hero')
  })

  it('a hero with no picture or video yet is not drawn at all', () => {
    for (const key of ['h3', 'h4', 'h5']) expect(heroMediaContent(byKey(key)), key).toBeNull()
  })
})

describe('WQ35: a video is one film, with a file for desktops and, when it has one, a file for phones', () => {
  const film = { description: 'Steam', captionsUrl: 'https://cdn.sanity.io/files/p/d/cap.vtt' }

  it('a film with a file and a poster for phones: each screen has its own file and its own poster', () => {
    const { picture, video } = heroMediaContent(home[0]!)!
    expect(video).toEqual({ url: 'https://cdn.sanity.io/files/p/d/vid.mp4', phoneUrl: 'https://cdn.sanity.io/files/p/d/tall.mp4', ...film, hasSound: true })
    expect(picture.desktop.src).toContain('hero-1600x900.jpg')
    expect(picture.desktop.src).toContain('w=960&h=540')
    expect(picture.mobile.src).toContain('tall-900x1600.jpg')
    expect(picture.mobile.src).toContain('w=390&h=693')
    // A phone is never offered the desktop's poster, nor the reverse.
    expect(picture.mobile.srcSet).not.toContain('hero-1600x900')
    expect(picture.desktop.srcSet).not.toContain('tall-900x1600')
    // The poster for phones is cropped round its own hotspot (a focal point, in the address).
    expect(picture.mobile.src).toMatch(/fp-x=0\.5&fp-y=0\.4|rect=/)
  })

  it('its description, captions and sound are said once and shared', () => {
    const { video } = heroMediaContent(home[0]!)!
    expect(Object.keys(video!).sort()).toEqual(['captionsUrl', 'description', 'hasSound', 'phoneUrl', 'url'])
  })

  // W73c (WQ42): a poster is a plain image with no alt text of its own.
  it("WQ42: the Video Description is the alt text of the film's posters, the phones' too; a poster's own alt is never read", () => {
    const media = home[0]!.media!
    if (media.kind !== 'video') throw new Error('The sample home hero is a video.')
    // The sample home hero's document still holds an alt under its poster, as the live Home did before W73c.
    expect([media.poster.alt, media.mobilePoster?.alt, media.description]).toEqual(['', '', 'Steam'])
    expect(heroMediaContent(home[0]!)!.picture.alt).toBe('Steam')
    expect(stillOf(media).alt).toBe('Steam')
    // The film is described the same once it plays: the video's own name is that description too.
    expect(heroMediaContent(home[0]!)!.video?.description).toBe('Steam')
    // A film with no description yet has posters with nothing to read out, as a decorative picture has.
    expect(stillOf({ ...media, description: '' }).alt).toBe('')
    // An image keeps its own alt text ("" when it is decorative).
    expect([heroMediaContent(byKey('h2'))!.picture.alt, heroMediaContent(byKey('h1'))!.picture.alt]).toEqual(['Picture hero', ''])
    const hero = readFileSync(path.resolve(__dirname, '../../components/modules/content/HeroMedia.tsx'), 'utf8')
    // W74: the same line with one more thing passed on (how wide a product's gallery draws it); what is read out is unchanged.
    expect(hero).toContain("<HeroMediaImage picture={picture} alt={started ? '' : picture.alt} priority={priority} {...(desktopSizes ? { desktopSizes } : {})} />")
    expect(hero).toContain("{...(started ? { 'aria-label': video.description } : { 'aria-hidden': true })}")
  })

  it('a file for phones with no poster for them: the main poster, cut tall', () => {
    const { picture, video } = heroMediaContent(byKey('h6'))!
    expect(video).toEqual({ url: 'https://cdn.sanity.io/files/p/d/vid.mp4', phoneUrl: 'https://cdn.sanity.io/files/p/d/tall.mp4', ...film, hasSound: false })
    expect(picture.mobile.src).toContain('hero-1600x900.jpg')
    expect(picture.mobile.src).toContain('w=390&h=693')
  })

  it('a poster for phones with no file for them: the one file on every screen, over each screen\'s poster', () => {
    const { picture, video } = heroMediaContent(byKey('h7'))!
    expect(video).toEqual({ url: 'https://cdn.sanity.io/files/p/d/vid.mp4', phoneUrl: null, ...film, hasSound: false })
    expect(picture.desktop.src).toContain('hero-1600x900.jpg')
    expect(picture.mobile.src).toContain('tall-900x1600.jpg')
  })

  it('wherever media is drawn: the same two answers for a gallery\'s video and picture (lib/sanity/media.ts)', () => {
    const [video, picture] = productSchema.parse(answers.product).gallery
    expect(videoOf(video!)).toEqual({ url: 'https://cdn.sanity.io/files/p/d/vid.mp4', phoneUrl: null, ...film, hasSound: false })
    const still = stillOf(video!)
    expect([still.wide.ref, still.phone.ref, still.alt]).toEqual(['image-hero-1600x900-jpg', 'image-hero-1600x900-jpg', 'Steam'])
    expect(videoOf(picture!)).toBeNull()
    expect(stillOf(picture!).wide).toBe(stillOf(picture!).phone)
  })

  it('HeroMedia draws one picture, and one player for each file: each hidden, and so never fetched, on the other width of screen', () => {
    const hero = readFileSync(path.resolve(__dirname, '../../components/modules/content/HeroMedia.tsx'), 'utf8')
    expect(hero).toContain("const ON_SCREENS: Record<Screens, string> = { both: '', mobile: 'md:hidden', desktop: 'hidden md:block' }")
    expect(hero).toMatch(/\{video\?\.phoneUrl \? \(\s*<>\s*\{player\(video\.phoneUrl, 'mobile'\)\}\s*\{player\(video\.url, 'desktop'\)\}\s*<\/>\s*\) : video \? \(\s*player\(video\.url, 'both'\)\s*\) : null\}/)
    // A file loads nothing until it is played, and is played only while it is on screen.
    expect(hero).toContain('preload="none"')
    expect(hero).toMatch(/if \(onScreen\) element\.play\(\)\.catch\(\(\) => undefined\)\s+else element\.pause\(\)/)
    // The picture: the browser picks the cut before it fetches.
    expect(hero).toContain('<source media="(width >= 48rem)" srcSet={picture.desktop.srcSet}')
  })
})

describe("W73b Level 3: a video's sound", () => {
  it('"Has Sound" is the editor\'s switch on the film: off unless it was switched on', () => {
    expect(heroMediaContent(home[0]!)!.video?.hasSound).toBe(true)
    expect(heroMediaContent(byKey('h6'))!.video?.hasSound).toBe(false)
  })

  it('the sound button is drawn only for a video that has sound; Pause always', () => {
    const hero = readFileSync(path.resolve(__dirname, '../../components/modules/content/HeroMedia.tsx'), 'utf8')
    expect(hero).toMatch(/\{video\.hasSound \? \(\s*<IconButton look="image" label=\{muted \? 'Unmute video' : 'Mute video'\}[^\n]*\n\s*\) : null\}\s*<IconButton look="image" label=\{playing \? 'Pause video' : 'Play video'\}/)
  })
})

describe("the hero's button", () => {
  it('with no link of its own it goes to the booking panel (/book), as a link an editor points there does', () => {
    expect(heroMediaContent(home[0]!)!.button).toEqual({ text: 'Book Your Experience', href: BOOK_ADDRESS })
    expect(byKey('h6').button?.link?.destination).toBe('book')
    expect(heroMediaContent(byKey('h6'))!.button).toEqual({ text: 'Book', href: '/book' })
  })

  it('with a link it is that link: the shop, the gift card, an outside address', () => {
    expect(heroMediaContent(byKey('h1'))!.button).toEqual({ text: 'Shop', href: '/shop' })
    expect(heroMediaContent(byKey('h2'))!.button).toEqual({ text: 'Gift Cards', href: '/shop/gift-card' })
    const outside: HeroMediaModule = { ...byKey('h2'), button: { text: 'Out', link: { destination: 'external', document: null, url: 'https://example.com' } } }
    expect(heroMediaContent(outside)!.button).toEqual({ text: 'Out', href: 'https://example.com' })
  })

  it('a link to a page that is not published hides the button; so does a button switched off or with no words', () => {
    const unpublished: HeroMediaModule = { ...byKey('h2'), button: byKey('h4').button }
    expect(unpublished.button?.text).toBe('Not yet')
    expect(heroMediaContent(unpublished)!.button).toBeNull()
    expect(heroMediaContent({ ...byKey('h2'), button: null })!.button).toBeNull()
    expect(heroMediaContent(byKey('h7'))!.button).toBeNull()
  })
})

describe('W73b Level 3: where the button is, in the stylesheet', () => {
  const css = readFileSync(path.resolve(__dirname, '../../app/globals.css'), 'utf8')
  const rule = /@utility hero-button \{[\s\S]*?\n\}\n/.exec(css)?.[0] ?? ''

  it('its fade takes the short duration with the smooth curve; its place has no transition (WQ80: it follows the pointer directly)', () => {
    expect(rule).toContain('transition-property: opacity;')
    expect(rule).not.toMatch(/transition-property:[^;]*translate/)
    expect(rule).toContain('transition-duration: var(--duration-short);')
    expect(rule).toContain('transition-timing-function: var(--ease-smooth);')
  })

  it('only a device whose main pointer is a mouse hides it until it is shown; a touch screen always shows it', () => {
    expect(rule).toMatch(/@media \(hover: hover\) and \(pointer: fine\) \{\s*&:not\(\[data-shown\]\) \{\s*opacity: 0;\s*pointer-events: none;\s*\}\s*\}/)
    // Nothing outside that question hides it.
    expect(rule.match(/opacity: 0;/g)).toHaveLength(1)
  })

  it('reduced motion keeps its fade (it moves nowhere then)', () => {
    expect(rule).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*transition-duration: var\(--duration-short\) !important;\s*\}/)
  })
})
