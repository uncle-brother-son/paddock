'use client'

import type { HeroMediaPicture } from '@/lib/modules/hero-media'
import { usePrefersReducedMotion } from '@/lib/motion/reduced-motion'
import type { ScreenVideo } from '@/lib/sanity/media'

import { HeroMediaFill } from './HeroMedia'

type ModuleMediaProps = {
  picture: HeroMediaPicture
  video: ScreenVideo | null
  /** How wide it is drawn from 768px (`33vw`), so a screen fetches a picture of its own size. */
  desktopSizes: string
  /** Its shape and place: `aspect-4/5 w-full`. */
  className?: string
  /** For Storybook and tests: reduced motion on or off, whatever the visitor's own setting. */
  reducedMotion?: boolean
}

/**
 * A content module's picture or video (Figma "Media", 1273:35851: Type=image, Type=video): on Object/Product Bg
 * with 4px corners, drawn as HeroMedia draws one (WQ35, WQ43): a video is muted, looped and inline, plays only while
 * it is on screen, each width of screen fetches only its own file and poster, and it has Pause, and the sound button
 * when it has sound, 16px inside its bottom right corner.
 */
export function ModuleMedia({ picture, video, desktopSizes, className, reducedMotion: reducedMotionSet }: ModuleMediaProps) {
  const visitorReducedMotion = usePrefersReducedMotion()
  return (
    <div data-module-media={video ? 'video' : 'image'} className={`relative overflow-clip rounded-s bg-object-product-bg ${className ?? ''}`}>
      <HeroMediaFill picture={picture} video={video} priority={false} reducedMotion={reducedMotionSet ?? visitorReducedMotion} desktopSizes={desktopSizes} />
    </div>
  )
}
