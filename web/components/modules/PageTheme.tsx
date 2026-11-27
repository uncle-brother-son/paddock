'use client'

import { useLayoutEffect, useRef } from 'react'

import { PAGE_THEME, PAGE_THEME_EVENT, PAGE_THEMED } from '@/lib/modules/section'
import { PAGE_LEAVING } from '@/lib/motion/page-transition'

/**
 * The page's theme (W80; WQ87, Wayne, 27 Nov): when a section in another theme reaches the middle of the window, the
 * whole page (its background, its words, the header) fades to that theme over the long duration, and back when the
 * section has passed. With reduced motion on the change is instant (the site's rule in app/globals.css).
 *
 * components/modules/PageModules.tsx draws this once, after a page's modules, when one of them has a theme. It
 * watches the page's scrolling and writes the theme of the section at the middle of the window on the page's own
 * element (the one the page transition moves, which holds main and the footer; in Storybook, what holds the modules)
 * as W73's `data-theme`. Light, the page's own, is the theme wherever no themed section is at the middle: a module
 * with no theme, a HeroMedia (which is a picture, not a colour), the footer.
 *
 * While it watches, a themed section follows the page's theme in place of its own (`data-page-themed`), so there is
 * one colour on screen at a time. Before the script has run, and without it, each themed section simply stands on
 * its own colour. The first look changes nothing by a fade: a page that opens on a themed section is that theme at once.
 */
export function PageTheme() {
  const marker = useRef<HTMLSpanElement>(null)

  useLayoutEffect(() => {
    const here = marker.current
    const page = here?.closest<HTMLElement>('[data-page-transition]') ?? here?.parentElement
    if (!here || !page) return
    let frame = 0

    const look = () => {
      frame = 0
      // A page being left keeps the theme it had: its picture is being taken.
      if (page.hasAttribute(PAGE_LEAVING)) return
      const middle = window.innerHeight / 2
      const section = [...page.querySelectorAll<HTMLElement>(`[${PAGE_THEMED}]`)].find((one) => {
        const box = one.getBoundingClientRect()
        return box.top <= middle && box.bottom > middle
      })
      const theme = section?.dataset.theme ?? 'light'
      const first = !page.hasAttribute(PAGE_THEME)
      if (!first && page.dataset.theme === theme) return
      if (first) {
        page.setAttribute(PAGE_THEME, 'first')
        page.dataset.theme = theme
        // The page has its first theme before the fade is switched on: nothing fades in as the page opens.
        void page.offsetHeight
        page.setAttribute(PAGE_THEME, 'live')
      } else {
        page.dataset.theme = theme
      }
      window.dispatchEvent(new Event(PAGE_THEME_EVENT))
    }
    const lookSoon = () => {
      if (frame === 0) frame = requestAnimationFrame(look)
    }

    look()
    window.addEventListener('scroll', lookSoon, { passive: true })
    window.addEventListener('resize', lookSoon)
    // A section that grows or shrinks (an accordion opening) can bring another to the middle with no scroll.
    const sizes = new ResizeObserver(lookSoon)
    sizes.observe(page)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', lookSoon)
      window.removeEventListener('resize', lookSoon)
      sizes.disconnect()
      page.removeAttribute(PAGE_THEME)
      delete page.dataset.theme
      window.dispatchEvent(new Event(PAGE_THEME_EVENT))
    }
  }, [])

  return <span ref={marker} hidden data-page-theme-watch="" />
}
