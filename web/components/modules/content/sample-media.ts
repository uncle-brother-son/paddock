import type { HeroMediaPicture } from '@/lib/modules/hero-media'
import type { SizedImage } from '@/lib/sanity/image'

// For the Modules stories only: pictures and a video made on the spot, so a story fetches nothing. The site's own
// pictures and videos come from Sanity.

type Colours = { above: string; below: string; ring: string }

/** A drawn stand-in for a photograph: two of the palette's colours and a ring, so the two crops can be told apart. */
const drawn = (width: number, height: number, { above, below, ring }: Colours): SizedImage => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="${below}"/><rect width="${width}" height="${height / 2}" fill="${above}"/><circle cx="${width / 2}" cy="${height / 2}" r="${Math.min(width, height) / 4}" fill="none" stroke="${ring}" stroke-width="2"/></svg>`
  const src = `data:image/svg+xml,${encodeURIComponent(svg)}`
  return { src, srcSet: `${src} ${width}w`, width, height }
}

const MAIN: Colours = { above: '#193028', below: '#6e6258', ring: '#bd9b5d' }
const FOR_PHONES: Colours = { above: '#a7bbc8', below: '#193028', ring: '#f1eee3' }

/** A hero's picture in its two cuts: 16 by 9 for a desktop, 9 by 16 for a phone. */
export const SAMPLE_PICTURE: HeroMediaPicture = { desktop: drawn(160, 90, MAIN), mobile: drawn(90, 160, MAIN), alt: 'A sample picture' }

/** A video's posters when it has one of its own for phones (WQ35): another picture for the tall cut, the same alt. */
export const SAMPLE_PICTURE_WITH_PHONE_POSTER: HeroMediaPicture = { ...SAMPLE_PICTURE, mobile: drawn(90, 160, FOR_PHONES) }

const VIDEO = { width: 320, height: 180, milliseconds: 1200 }

/**
 * A short silent video, recorded here from a drawing (a band crossing Moss), as a blob address. A story can't carry
 * a video file of its own without one being added to the site's public files.
 */
export async function recordSampleVideo(band = '#bd9b5d'): Promise<string> {
  const canvas = document.createElement('canvas')
  canvas.width = VIDEO.width
  canvas.height = VIDEO.height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('This browser gave no canvas to draw the sample video on.')
  const recorder = new MediaRecorder(canvas.captureStream())
  const parts: Blob[] = []
  recorder.ondataavailable = (event) => parts.push(event.data)
  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve()
  })
  recorder.start()
  const started = performance.now()
  await new Promise<void>((resolve) => {
    const draw = (now: number) => {
      const done = (now - started) / VIDEO.milliseconds
      context.fillStyle = '#193028'
      context.fillRect(0, 0, VIDEO.width, VIDEO.height)
      context.fillStyle = band
      context.fillRect(done * VIDEO.width - 40, 0, 80, VIDEO.height)
      if (done < 1) requestAnimationFrame(draw)
      else resolve()
    }
    requestAnimationFrame(draw)
  })
  recorder.stop()
  await stopped
  return URL.createObjectURL(new Blob(parts, { type: recorder.mimeType }))
}
