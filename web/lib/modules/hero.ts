import { sizedImage, type SizedImage } from '@/lib/sanity/image'
import { BOOK_ADDRESS, linkHref } from '@/lib/sanity/links'
import { stillOf, videoOf, type ScreenVideo } from '@/lib/sanity/media'
import type { HeroModule } from '@/lib/sanity/schemas'

// What the Hero module shows (W73b), made from Sanity's answer. Nothing here reads Sanity.

/** Figma "Hero" (1213:29172): the media is 1600 by 900 on a desktop and 900 by 1600 on a phone, the whole window wide. */
export const HERO_RATIO = { desktop: 1600 / 900, mobile: 900 / 1600 } as const

/** The window's width on Figma's two frames, and wider and sharper screens. The first is the plain `src`. */
const WIDTHS = { desktop: [960, 1440, 1920, 2880], mobile: [390, 780, 1170] } as const

/**
 * The hero's picture (for a video, its poster) cut for each screen round the editor's hotspot: wide from 768px,
 * tall below. A video with a poster of its own for phones (WQ35) has that one for the tall cut. One alt for both.
 */
export type HeroPicture = { desktop: SizedImage; mobile: SizedImage; alt: string }

/** The hero's button: its words and where it goes. One with no link of its own goes to the booking panel. */
export type HeroButton = { text: string; href: string }

/** `video`: the hero's video, with its file for phones when it has one (lib/sanity/media.ts); null for a picture. */
export type HeroContent = { picture: HeroPicture; video: ScreenVideo | null; button: HeroButton | null }

function heroButton(button: HeroModule['button']): HeroButton | null {
  if (!button) return null
  if (!button.link) return { text: button.text, href: BOOK_ADDRESS }
  // A link to a page or an event that isn't published is hidden, and its button with it (WQ24).
  const href = linkHref(button.link)
  return href ? { text: button.text, href } : null
}

/** A Hero module as the site draws it, or null for one with no picture or video yet: it takes no room. */
export function heroContent(hero: HeroModule): HeroContent | null {
  if (!hero.media) return null
  const still = stillOf(hero.media)
  return {
    picture: {
      desktop: sizedImage(still.wide, HERO_RATIO.desktop, WIDTHS.desktop),
      mobile: sizedImage(still.phone, HERO_RATIO.mobile, WIDTHS.mobile),
      alt: still.alt,
    },
    video: videoOf(hero.media),
    button: heroButton(hero.button),
  }
}
