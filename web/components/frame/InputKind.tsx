'use client'

import { useEffect } from 'react'

/** Keys that are held with another key or with a click, and say nothing by themselves of how the visitor gets about. */
const HELD_KEYS = ['Shift', 'Control', 'Alt', 'Meta']

/**
 * Notes on <html> what the visitor last used: `data-input="key"` after a key, `data-input="pointer"` after a mouse, a
 * finger or a pen (W74c; WQ12 as Wayne made it plain on 25 Nov). The focus ring is drawn only when it was not a
 * pointer (the ring's rule and the `has-keyboard-focus` variant in app/globals.css), so choosing from the Shop's ALL
 * or SORT with the mouse leaves no ring, and tabbing to them shows it.
 *
 * It draws nothing. Until it has run, and with no script at all, there is no note and the ring is the browser's own
 * `:focus-visible`. A screen reader's own press comes as a click with neither a key nor a pointer: the note stays as
 * it was.
 */
export function InputKind() {
  useEffect(() => {
    const root = document.documentElement
    const key = (event: KeyboardEvent) => {
      if (!HELD_KEYS.includes(event.key)) root.dataset.input = 'key'
    }
    const pointer = () => {
      root.dataset.input = 'pointer'
    }
    // Before anything else hears them, so the note is right by the time focus moves.
    window.addEventListener('keydown', key, true)
    window.addEventListener('pointerdown', pointer, true)
    return () => {
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('pointerdown', pointer, true)
      delete root.dataset.input
    }
  }, [])
  return null
}
