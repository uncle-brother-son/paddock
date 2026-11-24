import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import answers from '@/lib/sanity/sample-answers.json'
import { BOOK_ADDRESS } from '@/lib/sanity/links'
import { contentPageSchema, type HeroModule } from '@/lib/sanity/schemas'

import { HERO_RATIO, heroContent } from './hero'

// Brief W73b, items 1 and 2, and its Level 3 fixes (Wayne, 24 Nov): what the Hero module shows, from Sanity's answer
// (the samples lib/sanity/read.test.ts holds, made by Sanity's own query engine).

const heroesOf = (page: unknown): HeroModule[] => contentPageSchema.parse(page).modules.filter((module): module is HeroModule => module.type === 'hero')
const home = heroesOf(answers.homePage)
const page = heroesOf(answers.contentPage)
const byKey = (key: string): HeroModule => page.find((hero) => hero.key === key)!
const widthsOf = (srcSet: string) => srcSet.split(', ').map((entry) => entry.split(' ')[1])

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SANITY_PROJECT_ID', 'project')
  vi.stubEnv('NEXT_PUBLIC_SANITY_DATASET', 'production')
})
afterEach(() => vi.unstubAllEnvs())

describe('a hero with one media for every screen', () => {
  it("a picture is cut both ways from Sanity's CDN: 16 by 9 for a desktop, 9 by 16 for a phone", () => {
    const { desktop, mobile, shared } = heroContent(byKey('h1'))!
    expect(shared).toBe(true)
    expect([desktop.video, mobile.video]).toEqual([null, null])
    expect([desktop.image.width, desktop.image.height, mobile.image.width, mobile.image.height]).toEqual([960, 540, 390, 693])
    expect(desktop.image.width / desktop.image.height).toBeCloseTo(HERO_RATIO.desktop, 2)
    expect(mobile.image.width / mobile.image.height).toBeCloseTo(HERO_RATIO.mobile, 2)
    // The same picture at each width, each cropped to its shape and in the browser's best format.
    expect(widthsOf(desktop.image.srcSet)).toEqual(['960w', '1440w', '1920w', '2880w'])
    expect(widthsOf(mobile.image.srcSet)).toEqual(['390w', '780w', '1170w'])
    for (const address of [desktop.image.src, mobile.image.src]) {
      expect(address).toContain('https://cdn.sanity.io/images/project/production/hero-1600x900.jpg')
      expect(address).toContain('fit=crop')
      expect(address).toContain('auto=format')
    }
    expect(desktop.image.src).toContain('w=960&h=540')
    expect(mobile.image.src).toContain('w=390&h=693')
    // A decorative picture has no alt text to read out.
    expect([desktop.alt, mobile.alt]).toEqual(['', ''])
  })

  it('a video is the same video on both, over its poster cut both ways; the media for phones with no poster counts as none', () => {
    // The sample hero h6: a video, and for phones a video with no poster (so nothing of their own).
    const { desktop, mobile, shared } = heroContent(byKey('h6'))!
    expect(shared).toBe(true)
    const video = { url: 'https://cdn.sanity.io/files/p/d/vid.mp4', description: 'Steam', captionsUrl: 'https://cdn.sanity.io/files/p/d/cap.vtt', hasSound: false }
    expect([desktop.video, mobile.video]).toEqual([video, video])
    expect([desktop.alt, mobile.alt]).toEqual(['Picture hero', 'Picture hero'])
    expect([desktop.image.height, mobile.image.height]).toEqual([540, 693])
  })

  it('a hero with no picture or video yet is not drawn at all, whatever phones have', () => {
    for (const key of ['h3', 'h4', 'h5']) expect(heroContent(byKey(key)), key).toBeNull()
    expect(byKey('h4').mobileMedia).not.toBeNull()
  })
})

describe('W73b Level 3: a hero with media of its own for phones', () => {
  it('a picture for phones: the desktop has the main picture, wide; phones their own, tall; each its own alt', () => {
    const { desktop, mobile, shared } = heroContent(byKey('h2'))!
    expect(shared).toBe(false)
    expect(desktop.image.src).toContain('hero-1600x900.jpg')
    expect(desktop.image.src).toContain('w=960&h=540')
    expect(mobile.image.src).toContain('tall-900x1600.jpg')
    expect(mobile.image.src).toContain('w=390&h=693')
    expect([desktop.alt, mobile.alt]).toEqual(['Picture hero', 'Picture tall'])
    // Neither is cut the other way: a phone is never offered the desktop's picture, nor the reverse.
    expect(widthsOf(desktop.image.srcSet)).toEqual(['960w', '1440w', '1920w', '2880w'])
    expect(widthsOf(mobile.image.srcSet)).toEqual(['390w', '780w', '1170w'])
    expect(mobile.image.srcSet).not.toContain('hero-1600x900')
    expect(desktop.image.srcSet).not.toContain('tall-900x1600')
  })

  it('a video for phones: each screen has its own video, poster, description and captions', () => {
    const { desktop, mobile, shared } = heroContent(home[0]!)!
    expect(shared).toBe(false)
    expect(desktop.video).toEqual({ url: 'https://cdn.sanity.io/files/p/d/vid.mp4', description: 'Steam', captionsUrl: 'https://cdn.sanity.io/files/p/d/cap.vtt', hasSound: true })
    expect(mobile.video).toEqual({ url: 'https://cdn.sanity.io/files/p/d/tall.mp4', description: 'Steam, tall', captionsUrl: null, hasSound: false })
    expect(desktop.image.src).toContain('hero-1600x900.jpg')
    expect(mobile.image.src).toContain('tall-900x1600.jpg')
    expect([desktop.alt, mobile.alt]).toEqual(['Picture hero', 'Picture tall'])
  })
})

describe('W73b Level 3: a video\'s sound', () => {
  it('"Has Sound" is the editor\'s switch on each video: off unless it was switched on', () => {
    const { desktop, mobile } = heroContent(home[0]!)!
    expect([desktop.video?.hasSound, mobile.video?.hasSound]).toEqual([true, false])
    expect(heroContent(byKey('h6'))!.desktop.video?.hasSound).toBe(false)
  })

  it('the sound button is drawn only for a video that has sound; Pause always', () => {
    const hero = readFileSync(path.resolve(__dirname, '../../components/modules/Hero.tsx'), 'utf8')
    expect(hero).toMatch(/\{video\.hasSound \? \(\s*<HeroIconButton label=\{muted \? 'Unmute video' : 'Mute video'\}[^\n]*\n\s*\) : null\}\s*<HeroIconButton label=\{playing \? 'Pause video' : 'Play video'\}/)
  })
})

describe("the hero's button", () => {
  it('with no link of its own it goes to the booking panel (/book), as a link an editor points there does', () => {
    expect(heroContent(home[0]!)!.button).toEqual({ text: 'Book Your Experience', href: BOOK_ADDRESS })
    expect(byKey('h6').button?.link?.destination).toBe('book')
    expect(heroContent(byKey('h6'))!.button).toEqual({ text: 'Book', href: '/book' })
  })

  it('with a link it is that link: the shop, the gift card, an outside address', () => {
    expect(heroContent(byKey('h1'))!.button).toEqual({ text: 'Shop', href: '/shop' })
    expect(heroContent(byKey('h2'))!.button).toEqual({ text: 'Gift Cards', href: '/shop/gift-card' })
    const outside: HeroModule = { ...byKey('h2'), button: { text: 'Out', link: { destination: 'external', document: null, url: 'https://example.com' } } }
    expect(heroContent(outside)!.button).toEqual({ text: 'Out', href: 'https://example.com' })
  })

  it('a link to a page that is not published hides the button; so does a button switched off or with no words', () => {
    const unpublished: HeroModule = { ...byKey('h2'), button: byKey('h4').button }
    expect(unpublished.button?.text).toBe('Not yet')
    expect(heroContent(unpublished)!.button).toBeNull()
    expect(heroContent({ ...byKey('h2'), button: null })!.button).toBeNull()
  })
})

describe('W73b Level 3: where the button is, in the stylesheet', () => {
  const css = readFileSync(path.resolve(__dirname, '../../app/globals.css'), 'utf8')
  const rule = /@utility hero-button \{[\s\S]*?\n\}\n/.exec(css)?.[0] ?? ''

  it('its fade and its glide take the short duration with the smooth curve', () => {
    expect(rule).toContain('transition-property: opacity, translate;')
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
