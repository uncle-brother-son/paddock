'use client'

import { useEffect, useRef, useState, type RefObject } from 'react'

// For the foundation pages in Storybook: each value shown is read from the rendered page (the tokens as the
// browser has them), not typed into the story.

/**
 * Reads something from a rendered element (a computed style, a size) and keeps it current when the window is
 * resized or a font arrives.
 */
export function useMeasured<T extends HTMLElement>(read: (element: T) => string): [RefObject<T | null>, string] {
  const ref = useRef<T>(null)
  const [value, setValue] = useState('')

  useEffect(() => {
    const element = ref.current
    if (!element) return
    const update = () => setValue(read(element))
    const observer = new ResizeObserver(update)
    observer.observe(document.documentElement)
    document.fonts.addEventListener('loadingdone', update)
    return () => {
      observer.disconnect()
      document.fonts.removeEventListener('loadingdone', update)
    }
  }, [read])

  return [ref, value]
}

/**
 * A built stylesheet writes its values as short as it can (`#2226`, `.2`, a time in seconds). This writes one out in
 * full, as Figma and the tokens file show it: `#22222266`, `0.2`, a time in milliseconds. The value is unchanged.
 */
export function writtenOut(value: string): string {
  const shortHex = /^#([0-9a-f]{3,4})$/i.exec(value)
  if (shortHex) return `#${[...shortHex[1]!].map((digit) => digit + digit).join('')}`
  const inSeconds = /^(\d*\.?\d+)s$/.exec(value)
  if (inSeconds) return `${Math.round(Number(inSeconds[1]) * 1000)}ms`
  return value.replace(/(^|[\s(,])\.(\d)/g, '$10.$2')
}

/** The value a CSS variable has at this point in the page, e.g. `--color-surface-primary` inside a Dark section. */
export function VariableValue({ name }: { name: string }) {
  const [ref, value] = useMeasured<HTMLSpanElement>((element) => writtenOut(getComputedStyle(element).getPropertyValue(name).trim()))
  return <span ref={ref}>{value}</span>
}

/** Pixels to one decimal place: the browser's 22.390625 reads 22.4. */
export const px = (value: number): string => `${Math.round(value * 10) / 10}px`
