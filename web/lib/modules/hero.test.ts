import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import answers from '@/lib/sanity/sample-answers.json'
import { contentPageSchema, type HeroModule } from '@/lib/sanity/schemas'

import { BOOK_ADDRESS, HERO_RATIO, heroContent } from './hero'

// Brief W73b, items 1 and 2: what the Hero module shows, from Sanity's answer (the samples lib/sanity/read.test.ts
// holds, made by Sanity's own query engine).

const heroesOf = (page: unknown): HeroModule[] => contentPageSchema.parse(page).modules.filter((module): module is HeroModule => module.type === 'hero')
const home = heroesOf(answers.homePage)
const page = heroesOf(answers.contentPage)
const byKey = (key: string): HeroModule => page.find((hero) => hero.key === key)!

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_SANITY_PROJECT_ID', 'project')
  vi.stubEnv('NEXT_PUBLIC_SANITY_DATASET', 'production')
})
afterEach(() => vi.unstubAllEnvs())

describe('the hero\'s picture or video', () => {
  it('a picture is cut both ways from Sanity\'s CDN: 16 by 9 for a desktop, 9 by 16 for a phone', () => {
    const media = heroContent(byKey('h2'))!.media
    if (media.kind !== 'image') throw new Error('The sample hero h2 is a picture.')
    expect(media.picture.alt).toBe('Picture hero')
    const { desktop, mobile } = media.picture
    expect([desktop.width, desktop.height, mobile.width, mobile.height]).toEqual([960, 540, 390, 693])
    expect(desktop.width / desktop.height).toBeCloseTo(HERO_RATIO.desktop, 2)
    expect(mobile.width / mobile.height).toBeCloseTo(HERO_RATIO.mobile, 2)
    // The same picture at each width, each cropped to its shape and in the browser's best format.
    expect(desktop.srcSet.split(', ').map((entry) => entry.split(' ')[1])).toEqual(['960w', '1440w', '1920w', '2880w'])
    expect(mobile.srcSet.split(', ').map((entry) => entry.split(' ')[1])).toEqual(['390w', '780w', '1170w'])
    for (const address of [desktop.src, mobile.src]) {
      expect(address).toContain('https://cdn.sanity.io/images/project/production/hero-1600x900.jpg')
      expect(address).toContain('fit=crop')
      expect(address).toContain('auto=format')
    }
    expect(desktop.src).toContain('w=960&h=540')
    expect(mobile.src).toContain('w=390&h=693')
  })

  it('a decorative picture has no alt text to read out', () => {
    const media = heroContent(byKey('h1'))!.media
    expect(media.kind === 'image' && media.picture.alt).toBe('')
  })

  it('a video has its file, its poster cut both ways, its description and its captions', () => {
    const media = heroContent(home[0]!)!.media
    if (media.kind !== 'video') throw new Error('The sample home hero is a video.')
    expect(media.url).toBe('https://cdn.sanity.io/files/p/d/vid.mp4')
    expect(media.description).toBe('Steam')
    expect(media.captionsUrl).toBe('https://cdn.sanity.io/files/p/d/cap.vtt')
    expect(media.poster.alt).toBe('Picture hero')
    expect([media.poster.desktop.height, media.poster.mobile.height]).toEqual([540, 693])
  })

  it('a hero with no picture or video yet is not drawn at all', () => {
    for (const key of ['h3', 'h4', 'h5']) expect(heroContent(byKey(key)), key).toBeNull()
  })
})

describe('the hero\'s button', () => {
  it('with no link of its own it asks for the booking panel, and goes to /book until there is one', () => {
    expect(heroContent(home[0]!)!.button).toEqual({ text: 'Book Your Experience', href: BOOK_ADDRESS, opensBooking: true, outside: false })
    expect(BOOK_ADDRESS).toBe('/book')
  })

  it('with a link it is that link: the shop, the gift card', () => {
    expect(heroContent(byKey('h1'))!.button).toEqual({ text: 'Shop', href: '/shop', opensBooking: false, outside: false })
    expect(heroContent(byKey('h2'))!.button).toEqual({ text: 'Gift Cards', href: '/shop/gift-card', opensBooking: false, outside: false })
  })

  it('an outside address is marked as one; a link to a page that is not published hides the button', () => {
    const base = byKey('h2')
    const outside: HeroModule = { ...base, button: { text: 'Out', link: { destination: 'external', document: null, url: 'https://example.com' } } }
    expect(heroContent(outside)!.button).toEqual({ text: 'Out', href: 'https://example.com', opensBooking: false, outside: true })
    const unpublished: HeroModule = { ...base, button: byKey('h4').button }
    expect(unpublished.button?.text).toBe('Not yet')
    expect(heroContent(unpublished)!.button).toBeNull()
  })

  it('no button when it is switched off or has no words', () => {
    const base = byKey('h2')
    expect(heroContent({ ...base, button: null })!.button).toBeNull()
  })
})
