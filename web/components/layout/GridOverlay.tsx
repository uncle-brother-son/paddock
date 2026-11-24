'use client'

import { lazy, Suspense, useSyncExternalStore } from 'react'

import { isLiveHost } from '@/lib/site'

// The overlay itself is a file of its own, fetched only when it is rendered: on the live domain it never is, so
// the live page's script holds this gate and nothing of the overlay.
const GridOverlayColumns = lazy(() => import('./GridOverlayColumns'))

// The host never changes while a page is open.
const subscribeToNothing = () => () => {}

/**
 * The grid overlay for test copies (W71a, item 3): Ctrl + G, or `?grid=1` in the address, draws the page grid's
 * columns over the page. It never exists on the live domain: there this renders nothing and loads nothing. On the
 * server it renders nothing either (the third argument below), so the page's HTML is the same on every host and
 * the overlay only ever starts in a browser.
 *
 * `host` is for Storybook and tests; the root layout leaves it out and the window's own host is used.
 */
export function GridOverlay({ host }: { host?: string }) {
  const testCopy = useSyncExternalStore(
    subscribeToNothing,
    () => !isLiveHost(host ?? window.location.host),
    () => false,
  )
  if (!testCopy) return null
  return (
    <Suspense fallback={null}>
      <GridOverlayColumns />
    </Suspense>
  )
}
