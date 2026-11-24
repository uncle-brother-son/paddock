import type { Media, Picture } from './schemas'

// WQ35 (Wayne, 24 Nov): what a media block is on each width of screen, wherever it is drawn (the Hero now, the
// galleries later). An image is one file, cropped for each screen round its hotspot. A video is one film: a file
// for screens from 768px and, when an editor added it, a file for narrower ones, each with its poster; its
// description, captions and sound are said once and shared. Whoever draws it gives each screen only its own file.

/**
 * The still picture of a media block for each screen: the image itself, or a video's posters. `phone` is the
 * poster for phones when there is one, and otherwise the same picture as `wide` (cropped by whoever draws it).
 * `alt` describes both: a poster for phones has no alt of its own.
 */
export type ScreenStill = { wide: Picture; phone: Picture; alt: string }

export function stillOf(media: Media): ScreenStill {
  if (media.kind === 'image') return { wide: media.image, phone: media.image, alt: media.image.alt }
  return { wide: media.poster, phone: media.mobilePoster ?? media.poster, alt: media.poster.alt }
}

/**
 * A video's files for each screen. `phoneUrl` is null when the film has no file of its own for phones: `url` is
 * then shown on every screen. `hasSound`: the editor says it has sound, so the visitor gets the button for it.
 */
export type ScreenVideo = { url: string; phoneUrl: string | null; description: string; captionsUrl: string | null; hasSound: boolean }

/** The video of a media block, or null for an image. */
export function videoOf(media: Media): ScreenVideo | null {
  if (media.kind !== 'video') return null
  return { url: media.url, phoneUrl: media.mobileUrl, description: media.description, captionsUrl: media.captionsUrl, hasSound: media.hasSound }
}
