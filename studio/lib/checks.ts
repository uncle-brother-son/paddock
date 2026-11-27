// What the Studio refuses, as plain functions: each answers true, or the words an editor sees. No Sanity import here,
// so web/lib/sanity/studio-checks.test.ts can test them (the website's build has no Studio packages).
import { SECTION_ID_PATTERN } from '../../web/lib/modules/section'
import { slugProblem, type SlugPlace } from '../../web/lib/routes/reserved-slugs'

type Verdict = true | string
type Asset = { asset?: { _ref?: string } } | undefined

const hasAsset = (value: Asset): boolean => Boolean(value?.asset?._ref)

/** A slug's shape, and the site's own addresses where it goes (an event's are a page's: WQ26). */
export function checkSlug(slug: string | undefined, place: SlugPlace): Verdict {
  return slugProblem(slug, place) ?? true
}

/**
 * W72a: a document's old slugs after a publish. The slug being replaced (the published one) joins the list, once;
 * the slug the document now has leaves it, so a slug that goes back to an old value never points at itself.
 */
export function previousSlugsAfter(previous: readonly string[] | undefined, published: string | undefined, next: string | undefined): string[] {
  const kept = [...new Set(previous ?? [])].filter((slug) => slug !== next)
  if (published && published !== next && !kept.includes(published)) kept.push(published)
  return kept
}

/** Whether two lists of old slugs are the same, in order: a publish that changes none writes none. */
export function sameSlugs(before: readonly string[], after: readonly string[]): boolean {
  return before.length === after.length && before.every((slug, index) => slug === after[index])
}

/**
 * W72a: whether a slug is free for a document: true when no other document of its type (`$type`) has it now or had
 * it before (in its `previousSlugs`). `$published` is the document's own published id: none of its versions (its
 * draft, one in a release) counts as another document. Run by lib/slugs.ts over every version of every document.
 */
export const SLUG_FREE_QUERY = '!defined(*[_type == $type && !sanity::versionOf($published) && (slug.current == $slug || $slug in previousSlugs)][0]._id)'

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

/** WQ35: a video's file for phones is optional; when there is one, it is an MP4 as the main one is. */
export function checkPhoneVideo(video: Asset): Verdict {
  if (!hasAsset(video)) return true
  return /-mp4$/i.test(video?.asset?._ref ?? '') ? true : 'This is not an MP4 file. Upload an MP4.'
}

export function checkPoster(poster: Asset, kind: string | undefined): Verdict {
  return kind !== 'video' || hasAsset(poster) ? true : 'Add the picture shown before the video plays.'
}

export function checkVideoDescription(description: string | undefined, kind: string | undefined): Verdict {
  return kind !== 'video' || description?.trim() ? true : 'Say what the video shows, for people who cannot see it.'
}

export type LinkTo = { destination?: string; page?: { _ref?: string }; event?: { _ref?: string }; url?: string; sectionId?: string }

/** A link that has to go somewhere. */
export function checkLinkSet(link: LinkTo | undefined): Verdict {
  return link?.destination ? true : 'Choose where the link goes.'
}

/** The part of a link its destination needs. */
export function checkLinkPart(part: 'page' | 'event' | 'external' | 'section', value: { _ref?: string } | string | undefined, link: LinkTo | undefined): Verdict {
  if (link?.destination !== part) return true
  const filled = typeof value === 'string' ? value.trim() !== '' : Boolean(value?._ref)
  if (filled) return true
  if (part === 'external') return 'Type the address.'
  if (part === 'section') return "Type the section's ID."
  return part === 'page' ? 'Choose the page.' : 'Choose the event.'
}

// W80 (WQ83): a module's Section ID, and a link to a section on the same page.

/** The id the first Upcoming Events list of a page has when an editor gives it none (WQ60: the site's `EVENTS_LIST_ID`). */
export const EVENTS_SECTION_ID = 'events'

/** A module of a page as these checks read it. */
export type PageModuleValue = { _key?: string; _type?: string; sectionId?: string }

/** A Section ID's shape: lowercase letters, numbers and hyphens. None at all is allowed: it is optional. */
export function checkSectionId(id: string | undefined): Verdict {
  if (!id) return true
  return SECTION_ID_PATTERN.test(id) ? true : 'Use lowercase letters, numbers and hyphens only, for example session-passes.'
}

/**
 * The id each module's section has on the site, by the module's key: the one an editor gave it, and for the page's
 * first Upcoming Events list with none of its own, `events`.
 */
export function sectionIdsOf(modules: readonly PageModuleValue[] | undefined): Array<{ key: string | undefined; id: string }> {
  const list = modules ?? []
  const firstEvents = list.find((module) => module._type === 'upcomingEvents')
  return list.flatMap((module) => {
    const id = module.sectionId?.trim() || (module === firstEvents ? EVENTS_SECTION_ID : '')
    return id ? [{ key: module._key, id }] : []
  })
}

/** A Section ID is the only one of its name on its page (the events list's own `events` counts). */
export function checkSectionIdUnique(id: string | undefined, key: string | undefined, modules: readonly PageModuleValue[] | undefined): Verdict {
  if (!id) return true
  const others = sectionIdsOf(modules).filter((section) => section.key !== key && section.id === id)
  if (others.length === 0) return true
  return id === EVENTS_SECTION_ID ? `Another section on this page is "${id}" (the Upcoming Events list is, unless it has an ID of its own).` : `Another section on this page has the ID "${id}".`
}

/** A link to a section goes to one this page has. Only a page built from modules has sections. */
export function checkSectionLink(link: LinkTo | undefined, documentType: string | undefined, modules: readonly PageModuleValue[] | undefined): Verdict {
  if (link?.destination !== 'section') return true
  const id = link.sectionId?.trim()
  if (!id) return true
  if (documentType !== 'contentPage') return 'Only a link on a page built from modules can go to one of its sections.'
  const shape = checkSectionId(id)
  if (shape !== true) return shape
  return sectionIdsOf(modules).some((section) => section.id === id) ? true : `No section on this page has the ID "${id}". Give it to a module, in its Section settings.`
}

/** A module's button, as these checks read it. */
export type ModuleButtonValue = { text?: string; link?: LinkTo }

/** W80: a module's button has both its words and its link, or neither (then there is no button). */
export function checkModuleButtonPart(part: 'text' | 'link', button: ModuleButtonValue | undefined): Verdict {
  const hasText = Boolean(button?.text?.trim())
  const hasLink = Boolean(button?.link?.destination)
  if (part === 'text') return hasText || !hasLink ? true : 'Type the words on the button.'
  return hasLink || !hasText ? true : 'Choose where the button goes.'
}

/** A hero's button has words once it is switched on. */
export function checkButtonText(text: string | undefined, shown: boolean | undefined): Verdict {
  return !shown || text?.trim() ? true : 'Type the words on the button, or switch it off.'
}

/** WQ42: a hero's button that shows has somewhere to go ("The booking panel" is one of the places). */
export function checkButtonLink(link: LinkTo | undefined, shown: boolean | undefined): Verdict {
  return !shown || link?.destination ? true : 'Choose where the button goes, or switch the button off.'
}

/** WQ42: whether a video has anything of its own for phones (a file or a poster): its "For phones" group then starts open. */
export function hasPhoneVersion(media: unknown): boolean {
  const { mobileVideo, mobilePoster } = (media ?? {}) as { mobileVideo?: Asset; mobilePoster?: Asset }
  return hasAsset(mobileVideo) || hasAsset(mobilePoster)
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
