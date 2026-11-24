'use client'

import { MotionConfig } from 'framer-motion'
import { ReactLenis } from 'lenis/react'
import 'lenis/dist/lenis.css'
import type { ReactNode } from 'react'

import { usePrefersReducedMotion } from '@/lib/motion/reduced-motion'
import { DURATION_SHORT, EASE_SMOOTH } from '@/lib/motion/tokens'

/**
 * Smooth scroll and animation defaults for the whole site, set once in the root layout so every module inherits
 * them (docs/build-standards.md, section 1: Motion).
 *
 * - Lenis smooths the page's own scroll, with its defaults (the lead tunes it on the preview). It is not started
 *   when the visitor has reduced motion on. A panel that scrolls by itself (the menu, the bag, the booking panel)
 *   carries `data-lenis-prevent`, or Lenis takes its wheel and touch scrolling for the page behind it.
 * - Motion: every animation starts from the smooth curve and the short duration; with reduced motion on, movement
 *   is dropped and only fades are left (`reducedMotion="user"`).
 */
export function MotionProviders({ children, smoothScroll = true }: { children: ReactNode; smoothScroll?: boolean }) {
  const reducedMotion = usePrefersReducedMotion()

  return (
    <MotionConfig reducedMotion="user" transition={{ duration: DURATION_SHORT, ease: EASE_SMOOTH }}>
      {smoothScroll && !reducedMotion ? <ReactLenis root /> : null}
      {children}
    </MotionConfig>
  )
}
