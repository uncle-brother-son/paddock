'use client'

import { useEffect, useState } from 'react'

import {
  GRID_OVERLAY_STORAGE_KEY,
  gridOverlayFromAddress,
  gridOverlayFromStorage,
  gridOverlayToStorage,
  isGridOverlayShortcut,
  isTypingTarget,
} from '@/lib/design/grid-overlay'

import { Grid } from './Grid'
import { useGridColumns } from './useGridColumns'

// sessionStorage can refuse (a private window, storage switched off): the overlay then works for the page it is
// on and is simply not remembered.
function remembered(): boolean {
  try {
    return gridOverlayFromStorage(window.sessionStorage.getItem(GRID_OVERLAY_STORAGE_KEY))
  } catch {
    return false
  }
}

function remember(on: boolean): void {
  try {
    window.sessionStorage.setItem(GRID_OVERLAY_STORAGE_KEY, gridOverlayToStorage(on))
  } catch {
    // Not remembered; nothing else to do.
  }
}

/**
 * The page grid's columns drawn over the page, for holding a test copy against Figma (W71a, item 3). Off until
 * Ctrl + G is pressed or the address carries `?grid=1`; the tab remembers it.
 *
 * Loaded only by GridOverlay, in the browser, and only on a host that isn't the live domain: it is never rendered
 * on the server, so it can read the address and sessionStorage as it starts.
 *
 * It sits over the page's content (z-40) and takes no clicks. Popups (the menu, the panels, dialogs) go above it.
 */
export default function GridOverlayColumns() {
  const [on, setOn] = useState(() => gridOverlayFromAddress(window.location.search) ?? remembered())
  const columns = useGridColumns()

  useEffect(() => {
    remember(on)
  }, [on])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isGridOverlayShortcut(event) || isTypingTarget(event.target as HTMLElement | null)) return
      event.preventDefault()
      setOn((was) => !was)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  if (!on) return null

  return (
    <Grid aria-hidden="true" data-grid-overlay="" className="pointer-events-none fixed inset-0 z-40">
      {Array.from({ length: columns }, (_, index) => (
        <div key={index} data-grid-overlay-column={index + 1} className="border-x border-mustard-65 bg-mustard-8" />
      ))}
    </Grid>
  )
}
