import { sizedImage } from '@/lib/sanity/image'
import { linkHref } from '@/lib/sanity/links'
import { stillOf, videoOf, type ScreenVideo } from '@/lib/sanity/media'
import type {
  AccordionListModule,
  GalleryCarouselModule,
  Media,
  ModuleButtonLink,
  PageHeaderModule,
  PageModule,
  Picture,
  RichText,
  TextBlockModule,
  TextMediaStickyModule,
} from '@/lib/sanity/schemas'

import type { HeroMediaPicture } from './hero-media'
import { sectionIdOf, type SectionSettings } from './section'

// W80: what the content modules show (PageHeader, GalleryCarousel, AccordionList, TextMediaSticky, TextBlock), made
// from Sanity's answer. Nothing here reads Sanity. A module with nothing to show is null: it takes no room.

/** What a module's section is given (WQ81, WQ83): its theme, and its id when it is one. */
export const sectionSettings = (module: Pick<PageModule, 'theme' | 'sectionId'>): SectionSettings => ({ theme: module.theme, sectionId: sectionIdOf(module.sectionId) })

/** A module's button: its words and where it goes. */
export type ModuleButton = { text: string; href: string }

/** A button as the site draws it, or null: none, or one whose page or event isn't published (WQ24: it is hidden). */
export function moduleButton(button: ModuleButtonLink | null): ModuleButton | null {
  if (!button || !button.text.trim()) return null
  const href = linkHref(button.link)
  return href ? { text: button.text.trim(), href } : null
}

/** One paragraph of a module's large text. */
export type Paragraph = { key: string; text: string }

/**
 * A module's large text (the Studio's Large Text: paragraphs of plain words) as paragraphs. Figma draws no bold, no
 * bullet and no link in H2, so only the words are taken; a paragraph with none is left out.
 */
export function paragraphsOf(text: RichText): Paragraph[] {
  return text.flatMap((block) => {
    const words = block.children
      .map((span) => span.text)
      .join('')
      .trim()
    return words ? [{ key: block._key, text: words }] : []
  })
}

/** PageHeader draws two buttons at most (Figma: Show Button 1, Show Button 2). */
export const PAGE_HEADER_BUTTONS = 2

export type PageHeaderContent = SectionSettings & {
  title: string | null
  intro: Paragraph[]
  layout: PageHeaderModule['layout']
  buttons: Array<ModuleButton & { key: string }>
}

export function pageHeaderContent(module: PageHeaderModule): PageHeaderContent | null {
  const title = module.title?.trim() || null
  const intro = paragraphsOf(module.intro)
  const buttons = module.buttons
    .flatMap((button) => {
      const drawn = moduleButton(button)
      return drawn ? [{ ...drawn, key: button.key }] : []
    })
    .slice(0, PAGE_HEADER_BUTTONS)
  if (!title && intro.length === 0 && buttons.length === 0) return null
  return { ...sectionSettings(module), title, intro, layout: module.layout, buttons }
}

/** A picture's own shape, width over height, after the editor's crop. */
export function shapeOf(picture: Picture): number {
  const crop = picture.crop ?? { top: 0, bottom: 0, left: 0, right: 0 }
  const width = picture.width * (1 - crop.left - crop.right)
  const height = picture.height * (1 - crop.top - crop.bottom)
  return width > 0 && height > 0 ? width / height : 1
}

/** The widths a carousel's picture is offered at: Figma's 297 to 523 across its two frames, and wider and sharper screens. */
const CAROUSEL_WIDTHS = [480, 360, 720, 1080, 1440] as const

/**
 * One picture or video of a GalleryCarousel (WQ82): it keeps its own shape. `shape` is width over height on each
 * width of screen: a video with a poster of its own for phones (WQ35) has that poster's shape there.
 */
export type GalleryCarouselItem = { key: string; picture: HeroMediaPicture; video: ScreenVideo | null; shape: { phone: number; desktop: number } }

export type GalleryCarouselContent = SectionSettings & { items: GalleryCarouselItem[] }

export function galleryCarouselContent(module: GalleryCarouselModule): GalleryCarouselContent | null {
  const items = module.items.map(({ key, media }): GalleryCarouselItem => {
    const still = stillOf(media)
    const shape = { phone: shapeOf(still.phone), desktop: shapeOf(still.wide) }
    return {
      key,
      picture: { desktop: sizedImage(still.wide, shape.desktop, CAROUSEL_WIDTHS), mobile: sizedImage(still.phone, shape.phone, CAROUSEL_WIDTHS), alt: still.alt },
      video: videoOf(media),
      shape,
    }
  })
  return items.length > 0 ? { ...sectionSettings(module), items } : null
}

export type AccordionListContent = SectionSettings & {
  heading: string | null
  padding: boolean
  items: Array<{ key: string; question: string; answer: RichText }>
}

export function accordionListContent(module: AccordionListModule): AccordionListContent | null {
  const items = module.items.filter((item) => item.question.trim() !== '').map((item) => ({ key: item.key, question: item.question.trim(), answer: item.answer }))
  if (items.length === 0) return null
  return { ...sectionSettings(module), heading: module.heading?.trim() || null, padding: module.padding, items }
}

/** Figma's Media in TextMediaSticky: Ratio=4:5, in every variant. */
export const STICKY_MEDIA_RATIO = 4 / 5

/** Its widths: 236 (a phone, Size=small) to 523 (a desktop, Size=big) on Figma's frames, and wider and sharper screens. */
const STICKY_WIDTHS = [480, 360, 720, 1080, 1440] as const

export type StickyMedia = { picture: HeroMediaPicture; video: ScreenVideo | null }

const stickyMedia = (media: Media): StickyMedia => {
  const still = stillOf(media)
  return {
    picture: { desktop: sizedImage(still.wide, STICKY_MEDIA_RATIO, STICKY_WIDTHS), mobile: sizedImage(still.phone, STICKY_MEDIA_RATIO, STICKY_WIDTHS), alt: still.alt },
    video: videoOf(media),
  }
}

export type TextMediaStickyContent = SectionSettings & {
  heading: string | null
  text: Paragraph[]
  button: ModuleButton | null
  media: StickyMedia | null
  size: TextMediaStickyModule['size']
  flip: boolean
}

export function textMediaStickyContent(module: TextMediaStickyModule): TextMediaStickyContent | null {
  const heading = module.heading?.trim() || null
  const text = paragraphsOf(module.text)
  const media = module.media ? stickyMedia(module.media) : null
  if (!heading && text.length === 0 && !media) return null
  return { ...sectionSettings(module), heading, text, button: moduleButton(module.button), media, size: module.size, flip: module.flip }
}

export type TextBlockContent = SectionSettings & {
  heading: string | null
  text: Paragraph[]
  button: ModuleButton | null
  align: TextBlockModule['align']
}

export function textBlockContent(module: TextBlockModule): TextBlockContent | null {
  const heading = module.heading?.trim() || null
  const text = paragraphsOf(module.text)
  const button = moduleButton(module.button)
  if (!heading && text.length === 0 && !button) return null
  return { ...sectionSettings(module), heading, text, button, align: module.align }
}
