'use client'

import { useEffect, useRef, type ComponentPropsWithoutRef } from 'react'

type StickyColumnProps = ComponentPropsWithoutRef<'div'> & {
  /** Where the column sits on the page: its columns of the grid (`col-span-full md:col-span-7 md:col-start-15`). */
  place: string
}

const clamp = (value: number, least: number, most: number) => Math.min(Math.max(value, least), most)

/**
 * W78b (WQ73): a details column that sticks beside a taller gallery (the Product, Event and Gift Card pages), from
 * 768px. It is a child of the page's grid, as tall as the grid's row (so as the gallery), and what it is given is
 * drawn in the element that sticks inside it; every other prop goes to that element.
 *
 * - A column that fits the window sticks at the window's top, by the stylesheet alone (`md:sticky md:top-0`).
 * - A column taller than the window: scrolling down it moves with the page until its bottom reaches the bottom of
 *   the window, and stays there until the gallery ends; scrolling up it moves with the page until its top reaches
 *   the top of the window, and stays there. Nothing jumps when the direction changes.
 *
 * It is all the browser's own sticking, so the column never lags the page by a frame, with Lenis or without it. A
 * tall column is given the same negative `top` and `bottom` (the window's height less its own), which lets it lie
 * anywhere between "top at the window's top" and "bottom at the window's bottom"; and the spacer above it says where
 * between the gallery's top and its end the column would lie by itself. The browser then moves the column with the
 * page between those two ends and holds it at whichever it reaches.
 *
 * Script only sets the spacer's height, and only when the scrolling turns round or comes to rest (or a size
 * changes): to where the column is on the screen at that moment, so it sets off with the page from where it stands.
 * Where the column is at a scroll event is worked out, never read: a browser can still report where it stuck
 * before that scroll (WebKit does).
 *
 * Below 768px nothing sticks, and where the column is as tall as the gallery or taller it has nowhere to go: it is
 * left alone.
 */
export function StickyColumn({ place, className, children, ...rest }: StickyColumnProps) {
  const spacer = useRef<HTMLDivElement>(null)
  const column = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const element = column.current
    const above = spacer.current
    const area = element?.parentElement
    if (!element || !above || !area) return
    let lastY = window.scrollY
    let direction = 0
    // What the last look found: how far the column is taller than the window (0 or less: it is left alone), how far
    // it can go down its parent, and how far down its own place is (the spacer's height).
    let over = 0
    let room = 0
    let down = 0

    const putAt = (next: number) => {
      down = clamp(next, 0, room)
      above.style.height = `${down}px`
    }

    /** Sizes may have changed (its own, the gallery's, the window's): everything is looked at afresh. */
    const measure = () => {
      // Where it is drawn now, before anything is changed. After a change of size this is the browser's fresh answer.
      const drawnTop = element.getBoundingClientRect().top
      // Without the spacer the parent is as tall as the row is by itself (the gallery, or the column when that is taller).
      above.style.height = ''
      room = area.clientHeight - element.offsetHeight
      over = element.offsetHeight - document.documentElement.clientHeight
      if (getComputedStyle(element).position !== 'sticky' || over <= 0 || room <= 0) {
        over = 0
        down = 0
        element.style.top = ''
        element.style.bottom = ''
        return
      }
      element.style.top = `${-over}px`
      element.style.bottom = `${-over}px`
      putAt(drawnTop - area.getBoundingClientRect().top)
    }

    /** The scrolling turned round or came to rest: the column's own place becomes where the browser is holding it. */
    const settle = () => {
      if (over <= 0) return
      const areaTop = area.getBoundingClientRect().top
      // By itself it would be `down` below its parent's top; the browser holds it between the two ends, and inside its parent.
      const drawnTop = clamp(clamp(areaTop + down, -over, 0), areaTop, areaTop + room)
      putAt(drawnTop - areaTop)
    }

    const onScroll = () => {
      const now = Math.sign(window.scrollY - lastY)
      lastY = window.scrollY
      if (now === 0 || now === direction) return
      direction = now
      settle()
    }
    // At rest the next scroll event counts as a turn, whichever way it goes.
    const onRest = () => {
      direction = 0
      settle()
    }

    // The first look is the observer's own, before the page is painted.
    const sizes = new ResizeObserver(measure)
    sizes.observe(element)
    sizes.observe(area)
    window.addEventListener('scroll', onScroll, { passive: true })
    // Lenis says so too when one of its own scrolls ends, in every browser.
    window.addEventListener('scrollend', onRest)
    window.addEventListener('resize', measure)
    return () => {
      sizes.disconnect()
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('scrollend', onRest)
      window.removeEventListener('resize', measure)
      above.style.height = ''
      element.style.top = ''
      element.style.bottom = ''
    }
  }, [])

  return (
    // As tall as the grid's row, so the column has the gallery's whole height to move in.
    <div className={`md:self-stretch ${place}`}>
      <div ref={spacer} aria-hidden="true" />
      <div ref={column} className={`md:sticky md:top-0 ${className ?? ''}`} {...rest}>
        {children}
      </div>
    </div>
  )
}
