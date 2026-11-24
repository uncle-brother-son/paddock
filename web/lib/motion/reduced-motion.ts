'use client'

import { useSyncExternalStore } from 'react'

/** The media query a visitor's "reduce motion" setting answers. */
export const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'

function subscribeToReducedMotion(onChange: () => void): () => void {
  const query = window.matchMedia(REDUCED_MOTION)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

/**
 * The visitor's reduced-motion setting, followed live. On the server and for the first paint it answers "reduced",
 * so nothing starts moving and then stops for a visitor who has it on.
 */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeToReducedMotion,
    () => window.matchMedia(REDUCED_MOTION).matches,
    () => true,
  )
}
