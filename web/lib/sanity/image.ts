import { createImageUrlBuilder } from '@sanity/image-url'

import type { Picture } from './schemas'

/** An image ready for an <img>: one address, and the same picture at each width for `srcset`. */
export type SizedImage = { src: string; srcSet: string; width: number; height: number }

/**
 * A Sanity picture cropped to `ratio` (width over height) around the editor's hotspot, from Sanity's image CDN in
 * the browser's best format (docs/build-standards.md, section 6; Next's own optimiser does not run on Workers).
 * `widths`: the widths to offer, smallest first; the first is the plain `src`.
 */
export function sizedImage(picture: Picture, ratio: number, widths: readonly [number, ...number[]]): SizedImage {
  const builder = createImageUrlBuilder({
    projectId: process.env.NEXT_PUBLIC_SANITY_PROJECT_ID!,
    dataset: process.env.NEXT_PUBLIC_SANITY_DATASET!,
  })
  const source = {
    asset: { _ref: picture.ref },
    ...(picture.crop ? { crop: picture.crop } : {}),
    ...(picture.hotspot ? { hotspot: picture.hotspot } : {}),
  }
  const at = (width: number) => builder.image(source).width(width).height(Math.round(width / ratio)).fit('crop').auto('format').url()
  return {
    src: at(widths[0]),
    srcSet: widths.map((width) => `${at(width)} ${width}w`).join(', '),
    width: widths[0],
    height: Math.round(widths[0] / ratio),
  }
}
