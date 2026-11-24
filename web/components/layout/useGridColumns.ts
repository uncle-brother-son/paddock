'use client'

import { useSyncExternalStore } from 'react'

function subscribeToResize(onChange: () => void): () => void {
  window.addEventListener('resize', onChange)
  return () => window.removeEventListener('resize', onChange)
}

/** `--grid-columns` as the page has it now: the Mobile count below 768px, the Desktop count from 768px. */
function readGridColumns(): number {
  return Number.parseInt(getComputedStyle(document.documentElement).getPropertyValue('--grid-columns'), 10) || 0
}

/**
 * How many columns the page grid has at the window's present width, read from the grid tokens in app/globals.css
 * and followed as the window is resized. 0 on the server, where there is no window.
 */
export function useGridColumns(): number {
  return useSyncExternalStore(subscribeToResize, readGridColumns, () => 0)
}
