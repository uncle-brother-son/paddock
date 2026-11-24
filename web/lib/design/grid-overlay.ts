// The grid overlay for test copies (W71a, item 3): the page grid's columns drawn over the page, to hold a build
// against Figma. These are its decisions, kept apart from the component so they can be tested without a browser.
// Only components/layout/GridOverlayColumns.tsx reads this file, and that file is never loaded on the live domain.

/** Where the tab remembers whether the overlay is on: "1" or "0" in sessionStorage. */
export const GRID_OVERLAY_STORAGE_KEY = 'paddock-grid-overlay'

/** `?grid=1` in the address switches the overlay on (for a phone, which has no Ctrl + G); `?grid=0` switches it off. */
export const GRID_OVERLAY_PARAM = 'grid'

/** What the address asks for: on, off, or nothing (`null`), in which case the tab's remembered setting stands. */
export function gridOverlayFromAddress(search: string): boolean | null {
  const value = new URLSearchParams(search).get(GRID_OVERLAY_PARAM)
  if (value === '1') return true
  if (value === '0') return false
  return null
}

/** What sessionStorage holds, as on or off. Anything but "1" (nothing stored, or storage refused) is off. */
export const gridOverlayFromStorage = (stored: string | null | undefined): boolean => stored === '1'

export const gridOverlayToStorage = (on: boolean): string => (on ? '1' : '0')

type KeyPress = { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; repeat?: boolean }

/** Ctrl + G and nothing else: not Cmd + G (the browser's "find next" on a Mac), not with Alt or Shift, not a held key. */
export function isGridOverlayShortcut(event: KeyPress): boolean {
  return event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && !event.repeat && event.key.toLowerCase() === 'g'
}

type MaybeField = { tagName?: string; isContentEditable?: boolean } | null | undefined

/** True when a key press landed in something the visitor types into, where the shortcut must do nothing. */
export function isTypingTarget(target: MaybeField): boolean {
  if (!target) return false
  if (target.isContentEditable) return true
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes((target.tagName ?? '').toUpperCase())
}
