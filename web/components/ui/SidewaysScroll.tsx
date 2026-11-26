'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'

/**
 * Something that scrolls sideways by itself when it is wider than its place (W78b: the Size Guide's table on a
 * phone, when a guide has more columns than fit). Only while it does scroll is it a thing the keyboard reaches, with
 * a name for a screen reader, so the arrow keys can move it (docs/build-standards.md: a region that scrolls must be
 * reachable by keyboard); when everything fits it is no stop in the Tab order at all. It has no scrollbar of its own.
 */
export function SidewaysScroll({ label, children }: { label: string; children: ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null)
  const [scrolls, setScrolls] = useState(false)

  useEffect(() => {
    const element = scroller.current
    if (!element) return
    const look = () => setScrolls(element.scrollWidth > element.clientWidth + 1)
    look()
    const watcher = new ResizeObserver(look)
    watcher.observe(element)
    return () => watcher.disconnect()
  }, [])

  return (
    <div
      ref={scroller}
      {...(scrolls ? { tabIndex: 0, role: 'group', 'aria-label': label } : {})}
      className="overflow-x-auto [scrollbar-width:none] focus-visible:-outline-offset-2 [&::-webkit-scrollbar]:hidden"
    >
      {children}
    </div>
  )
}
