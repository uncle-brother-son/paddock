'use client'

import { useEffect, useRef, useState } from 'react'

import { HeroMedia } from '@/components/modules/Hero'
import { usePrefersReducedMotion } from '@/lib/motion/reduced-motion'
import type { GalleryItem } from '@/lib/shop/product'

type ProductGalleryProps = {
  items: GalleryItem[]
  /** For Storybook and tests: reduced motion on or off, whatever the visitor's own setting. */
  reducedMotion?: boolean
}

/**
 * A product's gallery (Figma "Gallery": desktop 1684:41922, mobile 1684:41992), its pictures and videos in the
 * editor's order, each 4 by 5 on Object/Product BG.
 * - From 768px they are stacked, one under the other, down the left half of the window.
 * - Below, they are a row to swipe through, one the whole window wide at a time, with the slider beneath: a hairline
 *   in as many parts as there are pictures, the one on show in Surface/Secondary.
 *
 * A video is drawn as the Hero draws one (WQ35; lib/sanity/media.ts): each width of screen gets only its own file
 * and poster, it plays muted and looped only while on screen, and it has Pause, and the sound button when it has
 * sound. Only the first picture loads ahead of the rest.
 */
export function ProductGallery({ items, reducedMotion: reducedMotionSet }: ProductGalleryProps) {
  const visitorReducedMotion = usePrefersReducedMotion()
  const reducedMotion = reducedMotionSet ?? visitorReducedMotion
  const row = useRef<HTMLDivElement>(null)
  const [onShow, setOnShow] = useState(0)
  // Only while it is a row to swipe is it a thing the keyboard needs to reach.
  const [swiped, setSwiped] = useState(false)

  useEffect(() => {
    const element = row.current
    if (!element) return
    const look = () => {
      setSwiped(element.scrollWidth > element.clientWidth + 1)
      setOnShow(element.clientWidth > 0 ? Math.round(element.scrollLeft / element.clientWidth) : 0)
    }
    look()
    element.addEventListener('scroll', look, { passive: true })
    window.addEventListener('resize', look)
    return () => {
      element.removeEventListener('scroll', look)
      window.removeEventListener('resize', look)
    }
  }, [items.length])

  if (items.length === 0) return <div data-shop="gallery" className="aspect-4/5 w-full bg-object-product-bg" />

  return (
    <div data-shop="gallery" className="flex flex-col gap-4 md:gap-0">
      <div
        ref={row}
        role="group"
        aria-label="Product pictures"
        {...(swiped ? { tabIndex: 0 } : {})}
        className="flex snap-x snap-mandatory overflow-x-auto [scrollbar-width:none] md:flex-col md:overflow-x-visible [&::-webkit-scrollbar]:hidden"
      >
        {items.map((item, index) => (
          <div key={item.key} data-gallery-item="" className="relative aspect-4/5 w-full shrink-0 snap-start overflow-clip bg-object-product-bg">
            <HeroMedia picture={item.picture} video={item.video} priority={index === 0} reducedMotion={reducedMotion} desktopSizes="50vw" />
          </div>
        ))}
      </div>
      {items.length > 1 ? (
        <div aria-hidden="true" data-gallery-slider="" className="flex md:hidden">
          {items.map((item, index) => (
            <span key={item.key} className={`h-px flex-1 transition-colors duration-short ease-smooth ${index === onShow ? 'bg-surface-secondary' : 'bg-surface-card'}`} />
          ))}
        </div>
      ) : null}
    </div>
  )
}
