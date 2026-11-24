// What the Studio refuses, as plain functions: each answers true, or the words an editor sees. No Sanity import here,
// so web/lib/sanity/studio-checks.test.ts can test them (the website's build has no Studio packages).
import { slugProblem, type SlugPlace } from '../../web/lib/routes/reserved-slugs'

type Verdict = true | string
type Asset = { asset?: { _ref?: string } } | undefined

const hasAsset = (value: Asset): boolean => Boolean(value?.asset?._ref)

/** A slug's shape, and the site's own addresses where it goes (an event's are a page's: WQ26). */
export function checkSlug(slug: string | undefined, place: SlugPlace): Verdict {
  return slugProblem(slug, place) ?? true
}

/** Alt text: required once there is a picture, unless it is marked decorative. */
export function checkAlt(alt: string | undefined, picture: (Asset & { decorative?: boolean }) | undefined): Verdict {
  if (!hasAsset(picture) || picture?.decorative) return true
  return alt?.trim() ? true : 'Describe the picture, or mark it as decorative.'
}

export type MediaKind = 'image' | 'video'

/** A media item has the file its kind needs. */
export function checkMediaPicture(picture: Asset, kind: string | undefined): Verdict {
  return kind === 'video' || hasAsset(picture) ? true : 'Add a picture.'
}

export function checkMediaVideo(video: Asset, kind: string | undefined): Verdict {
  if (kind !== 'video') return true
  if (!hasAsset(video)) return 'Upload an MP4 file.'
  return /-mp4$/i.test(video?.asset?._ref ?? '') ? true : 'This is not an MP4 file. Upload an MP4.'
}

export function checkPoster(poster: Asset, kind: string | undefined): Verdict {
  return kind !== 'video' || hasAsset(poster) ? true : 'Add the picture shown before the video plays.'
}

export function checkVideoDescription(description: string | undefined, kind: string | undefined): Verdict {
  return kind !== 'video' || description?.trim() ? true : 'Say what the video shows, for people who cannot see it.'
}

export type LinkTo = { destination?: string; page?: { _ref?: string }; event?: { _ref?: string }; url?: string }

/** A link that has to go somewhere. */
export function checkLinkSet(link: LinkTo | undefined): Verdict {
  return link?.destination ? true : 'Choose where the link goes.'
}

/** The part of a link its destination needs. */
export function checkLinkPart(part: 'page' | 'event' | 'external', value: { _ref?: string } | string | undefined, link: LinkTo | undefined): Verdict {
  if (link?.destination !== part) return true
  const filled = typeof value === 'string' ? value.trim() !== '' : Boolean(value?._ref)
  if (filled) return true
  if (part === 'external') return 'Type the address.'
  return part === 'page' ? 'Choose the page.' : 'Choose the event.'
}

/** A hero's button has words once it is switched on. */
export function checkButtonText(text: string | undefined, shown: boolean | undefined): Verdict {
  return !shown || text?.trim() ? true : 'Type the words on the button, or switch it off.'
}

/** A size guide's row has one cell per column. */
export function checkRowCells(cells: readonly unknown[] | undefined, columns: readonly unknown[] | undefined): Verdict {
  const want = columns?.length ?? 0
  const have = cells?.length ?? 0
  return have === want ? true : `This row has ${have} of ${want} cells.`
}

/** An opening time, 24-hour ("09:00"). */
export function checkTime(time: string | undefined): Verdict {
  return !time || /^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? true : 'Use the 24-hour time, for example 09:00.'
}

export const VALIDITY_PLACEHOLDER = '{validity}'

/** The gift card terms name the placeholder the site fills in. It has to be whole: not half bold, half plain. */
export function checkValidityPlaceholder(blocks: readonly { children?: readonly { text?: string }[] }[] | undefined): Verdict {
  if (!blocks || blocks.length === 0) return true
  const whole = blocks.some((block) => block.children?.some((span) => span.text?.includes(VALIDITY_PLACEHOLDER)))
  return whole ? true : `Put ${VALIDITY_PLACEHOLDER} where the gift card's validity goes (all in one style); the site fills it in.`
}
