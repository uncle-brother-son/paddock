import { sizedImage, type SizedImage } from '@/lib/sanity/image'
import { linkHref } from '@/lib/sanity/links'
import type { HeroModule, Picture } from '@/lib/sanity/schemas'

// What the Hero module shows (W73b), made from Sanity's answer. Nothing here reads Sanity.

/** Figma "Hero" (1213:29172): the media is 1600 by 900 on a desktop and 900 by 1600 on a phone, the whole window wide. */
export const HERO_RATIO = { desktop: 1600 / 900, mobile: 900 / 1600 } as const

/** The window's width on Figma's two frames, and wider and sharper screens. The first is the plain `src`. */
const DESKTOP_WIDTHS = [960, 1440, 1920, 2880] as const
const MOBILE_WIDTHS = [390, 780, 1170] as const

/** Where Book goes until the booking panel opens over the page (the header's Book goes there too). */
export const BOOK_ADDRESS = '/book'

/** One picture cut both ways: wide for a desktop, tall for a phone, each round the editor's hotspot. */
export type HeroPicture = { desktop: SizedImage; mobile: SizedImage; alt: string }

export type HeroMedia =
  | { kind: 'image'; picture: HeroPicture }
  | { kind: 'video'; url: string; poster: HeroPicture; description: string; captionsUrl: string | null }

/**
 * The hero's button. `opensBooking`: it has no link of its own, so it asks for the booking panel and goes to
 * BOOK_ADDRESS when there is none (as on the home page). `outside`: an address off the site.
 */
export type HeroButton = { text: string; href: string; opensBooking: boolean; outside: boolean }

export type HeroContent = { media: HeroMedia; button: HeroButton | null }

const heroPicture = (picture: Picture): HeroPicture => ({
  desktop: sizedImage(picture, HERO_RATIO.desktop, DESKTOP_WIDTHS),
  mobile: sizedImage(picture, HERO_RATIO.mobile, MOBILE_WIDTHS),
  alt: picture.alt,
})

function heroButton(button: HeroModule['button']): HeroButton | null {
  if (!button) return null
  if (!button.link) return { text: button.text, href: BOOK_ADDRESS, opensBooking: true, outside: false }
  // A link to a page or an event that isn't published is hidden, and its button with it (WQ24).
  const href = linkHref(button.link)
  return href ? { text: button.text, href, opensBooking: false, outside: button.link.destination === 'external' } : null
}

/** A Hero module as the site draws it, or null for one with no picture or video yet: it takes no room. */
export function heroContent(hero: HeroModule): HeroContent | null {
  if (!hero.media) return null
  const media: HeroMedia =
    hero.media.kind === 'image'
      ? { kind: 'image', picture: heroPicture(hero.media.image) }
      : { kind: 'video', url: hero.media.url, poster: heroPicture(hero.media.poster), description: hero.media.description, captionsUrl: hero.media.captionsUrl }
  return { media, button: heroButton(hero.button) }
}
