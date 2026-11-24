import { sizedImage, type SizedImage } from '@/lib/sanity/image'
import { BOOK_ADDRESS, linkHref } from '@/lib/sanity/links'
import type { HeroModule, Media } from '@/lib/sanity/schemas'

// What the Hero module shows (W73b), made from Sanity's answer. Nothing here reads Sanity.

/** Figma "Hero" (1213:29172): the media is 1600 by 900 on a desktop and 900 by 1600 on a phone, the whole window wide. */
export const HERO_RATIO = { desktop: 1600 / 900, mobile: 900 / 1600 } as const

/** The window's width on Figma's two frames, and wider and sharper screens. The first is the plain `src`. */
const WIDTHS = { desktop: [960, 1440, 1920, 2880], mobile: [390, 780, 1170] } as const

/** A hero's video. `hasSound`: the editor says it has sound, so the visitor gets the button that turns it on. */
export type HeroVideo = { url: string; description: string; captionsUrl: string | null; hasSound: boolean }

/**
 * What one width of screen shows: `desktop` from 768px, `mobile` below. Its picture, cut to that screen's shape
 * round the editor's hotspot (for a video, its poster), and its video when it is one.
 */
export type HeroSide = { image: SizedImage; alt: string; video: HeroVideo | null }

/** The hero's button: its words and where it goes. One with no link of its own goes to the booking panel. */
export type HeroButton = { text: string; href: string }

export type HeroContent = {
  desktop: HeroSide
  mobile: HeroSide
  /** No media of its own for phones in Sanity: the one picture or video serves both, cut both ways. */
  shared: boolean
  button: HeroButton | null
}

const side = (media: Media, screen: keyof typeof HERO_RATIO): HeroSide => {
  const picture = media.kind === 'image' ? media.image : media.poster
  return {
    image: sizedImage(picture, HERO_RATIO[screen], WIDTHS[screen]),
    alt: picture.alt,
    video: media.kind === 'video' ? { url: media.url, description: media.description, captionsUrl: media.captionsUrl, hasSound: media.hasSound } : null,
  }
}

function heroButton(button: HeroModule['button']): HeroButton | null {
  if (!button) return null
  if (!button.link) return { text: button.text, href: BOOK_ADDRESS }
  // A link to a page or an event that isn't published is hidden, and its button with it (WQ24).
  const href = linkHref(button.link)
  return href ? { text: button.text, href } : null
}

/**
 * A Hero module as the site draws it, or null for one with no picture or video yet: it takes no room. With media
 * for phones (W73b, Wayne), screens narrower than 768px show that and wider ones the main media; with none, the
 * main media is on phones too.
 */
export function heroContent(hero: HeroModule): HeroContent | null {
  if (!hero.media) return null
  return {
    desktop: side(hero.media, 'desktop'),
    mobile: side(hero.mobileMedia ?? hero.media, 'mobile'),
    shared: hero.mobileMedia === null,
    button: heroButton(hero.button),
  }
}
