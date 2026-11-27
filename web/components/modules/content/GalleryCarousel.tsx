'use client'

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react'

import type { GalleryCarouselContent } from '@/lib/modules/content'
import { usePrefersReducedMotion } from '@/lib/motion/reduced-motion'
import { DURATION_LONG, EASE_SMOOTH } from '@/lib/motion/tokens'

import { HeroMediaFill } from './HeroMedia'
import { ModuleSection } from './ModuleSection'

const clamp = (value: number, least: number, most: number): number => Math.min(Math.max(value, least), most)

/** How far a pressed mouse moves sideways before it is a drag and no longer a press (of a video's button, say). */
const DRAG_STARTS_AT = 4

/** The pointer's last moments before it lets go, which give the speed of the release. Milliseconds. */
const SPEED_OVER = 100

/**
 * The part of the site's one curve a glide plays (WQ82: "momentum on release, the curve"). A strip let go of is
 * already moving, so its glide starts where the curve is at its fastest and plays it from there to its end, the same
 * slowing to a stop, with no pause at the release. Since WQ88 the curve is a bezier that is fastest at its very
 * start, so a glide is the whole of it; this still finds the place, should the curve ever change again.
 * `at` is that moment of the curve (0 to 1), `done` how far the curve has come by then, `speed` how fast it is
 * going there (in curves per whole duration).
 */
const GLIDE = (() => {
  const step = 0.005
  let best = { at: 0, done: 0, speed: 0 }
  for (let at = 0; at < 1; at += step) {
    const speed = (EASE_SMOOTH(at + step) - EASE_SMOOTH(at)) / step
    if (speed > best.speed) best = { at, done: EASE_SMOOTH(at), speed }
  }
  return best
})()

/** A picture wider than it is tall is a landscape one; any other (a square too) an upright one (WQ89 amended). */
const kindOf = (shape: number): 'wide' | 'upright' => (shape > 1 ? 'wide' : 'upright')

/** Each picture's own shape: below 768px its shape for phones, from 768px its shape for desktops (app/globals.css: `gallery-item`). */
const SHAPE = '[--gallery-shape:var(--gallery-shape-phone)] md:[--gallery-shape:var(--gallery-shape-desktop)]'

/** How wide a picture of each kind is, on each width of screen: the grid's columns for an upright one, or for a landscape one. */
const SPAN = {
  phone: { upright: '[--gallery-span:var(--gallery-upright)]', wide: '[--gallery-span:var(--gallery-wide)]' },
  desktop: { upright: 'md:[--gallery-span:var(--gallery-upright)]', wide: 'md:[--gallery-span:var(--gallery-wide)]' },
} as const

/**
 * How wide each kind is drawn, as a share of the window, rounded up so the browser fetches a sharp enough file: below
 * 768px 5 of the grid's 6 columns (at most 80% of a phone's width) or all 6; from 768px 7 or 9 of its 24.
 */
const SIZES = { phone: { upright: '80vw', wide: '100vw' }, desktop: { upright: '30vw', wide: '38vw' } } as const

type Drag = { pointer: number; x: number; left: number; moved: boolean; trail: Array<{ at: number; x: number }> }

/** The strip's mark while script is moving it: the `gallery-strip` utility switches the browser's snapping off under it (WQ93). */
const SCRIPT_MOVES = 'data-script-moves'

/** Where the strip stands with each picture at the grid's left margin, where the first one starts. The last ones' places can be past the strip's end. */
const placesOf = (element: HTMLElement): number[] => {
  const row = element.firstElementChild
  const first = row?.firstElementChild?.getBoundingClientRect().left ?? 0
  return [...(row?.children ?? [])].map((item) => item.getBoundingClientRect().left - first)
}

type GalleryCarouselProps = GalleryCarouselContent & {
  /** For Storybook and tests: reduced motion on or off, whatever the visitor's own setting. */
  reducedMotion?: boolean
  /** The strip's name for a screen reader. */
  label?: string
}

/**
 * GalleryCarousel (W80, WQ82; Figma "GalleryCarousel", 1627:5520, which was GalleryThreeUp): a row of pictures and
 * videos on one line, each keeping its own shape, centred on that line, starting at the grid's left margin and
 * running off the right of the window. No arrows, no dots, no loop.
 *
 * Sizes (the `gallery-strip` and `gallery-item` utilities in app/globals.css; WQ89 amended, Wayne, 27 Nov, as
 * wild.as/about): any number of pictures and videos of any shape, never cropped. An upright or square one is 7 of the
 * grid's 24 columns wide and a landscape one 9 (below 768px 5 and all 6 of its 6), and each is as tall as its own
 * shape makes it, so heights vary: a panorama is short, a tall photo tall (no cap). One empty column between two
 * pictures from 768px, 8px below.
 *
 * It is the browser's own sideways scrolling, so a finger swipes it as it does any row, with the phone's own
 * momentum, and a trackpad's sideways swipe moves it too (Lenis leaves a sideways gesture over it alone:
 * `data-lenis-prevent-horizontal`; an up-and-down one still scrolls the page smoothly).
 *
 * It settles on a picture (WQ93, Wayne, 27 Nov; as wild.as/about, a slider and not a free one): however it is moved,
 * it comes to rest with the nearest picture lined up at the grid's left margin. It is never forced past its end: there
 * the last pictures stop short of the margin.
 * - A finger and a trackpad: the browser's own scroll snapping (`gallery-strip`: each picture snaps by its start, the
 *   grid's margin in from the strip's edge), so the browser eases it into line itself.
 * - A mouse drags it: press, move, let go. Let go of while moving, it glides on along the site's curve (`GLIDE`), and
 *   the glide's end is the picture nearest to where it would have stopped, so it slows straight into line; let go of
 *   while still, it eases to the nearest picture. With reduced motion on there is no glide: it goes to the nearest
 *   picture at once. While script moves it the browser's snapping is off (`data-script-moves`), or the two would fight.
 * - The keyboard: while there is more than the window shows, the strip takes focus and the arrow keys move it one
 *   picture at a time (Home and End: its two ends), over the long duration with the smooth curve; reduced motion jumps.
 * A video is drawn as HeroMedia draws one (WQ35, WQ43), with its own buttons, which a press still reaches.
 */
export function GalleryCarousel({ items, theme, sectionId, reducedMotion: reducedMotionSet, label = 'Gallery' }: GalleryCarouselProps) {
  const visitorReducedMotion = usePrefersReducedMotion()
  const reducedMotion = reducedMotionSet ?? visitorReducedMotion
  const strip = useRef<HTMLDivElement>(null)
  const drag = useRef<Drag | null>(null)
  const frame = useRef(0)
  const dragged = useRef(false)
  // Only while there is more than the window shows is it a thing to drag, or one the keyboard needs to reach. Until
  // it has been measured, a strip of more than one picture is taken to be: it is then reachable from the first
  // paint, and with no script.
  const [scrolls, setScrolls] = useState(items.length > 1)
  const [dragging, setDragging] = useState(false)

  useEffect(() => {
    const element = strip.current
    if (!element) return
    const look = () => setScrolls(element.scrollWidth > element.clientWidth + 1)
    const sizes = new ResizeObserver(look)
    sizes.observe(element)
    if (element.firstElementChild) sizes.observe(element.firstElementChild)
    return () => {
      sizes.disconnect()
      cancelAnimationFrame(frame.current)
    }
  }, [])

  const stop = () => {
    cancelAnimationFrame(frame.current)
    frame.current = 0
  }

  /**
   * WQ93: while script moves the strip (a mouse's drag, a glide, a keyboard step) the browser's own snapping is off,
   * by this mark (`gallery-strip` in app/globals.css): it would pull every place script sets to the nearest picture
   * at once. Script always leaves the strip at a place the browser snaps to, so nothing moves when it is handed back.
   */
  const scriptMoves = (moving: boolean) => strip.current?.toggleAttribute(SCRIPT_MOVES, moving)

  /** Ends whatever script was doing and hands the strip back to the browser, which lines it up itself. */
  const handBack = () => {
    stop()
    scriptMoves(false)
  }

  /**
   * WQ93: the place the strip settles at, nearest to `to`: a picture lined up at the grid's left margin, or the
   * strip's end, where the last pictures stop short (it is never forced past its end). The browser's own snapping
   * (a finger, a trackpad) settles at the same places.
   */
  const nearestStop = (element: HTMLDivElement, to: number): number => {
    const end = element.scrollWidth - element.clientWidth
    const stops = placesOf(element).map((place) => Math.min(place, end))
    return stops.reduce((best, place) => (Math.abs(place - to) < Math.abs(best - to) ? place : best), 0)
  }

  /** Moves the strip to `to`, never past either end: along the whole curve, or as a glide along its slowing part. */
  const moveTo = (to: number, glide: boolean) => {
    const element = strip.current
    if (!element) return
    stop()
    const from = element.scrollLeft
    const end = clamp(to, 0, element.scrollWidth - element.clientWidth)
    if (reducedMotion || Math.abs(end - from) < 1) {
      element.scrollLeft = end
      scriptMoves(false)
      return
    }
    scriptMoves(true)
    const startsAt = glide ? GLIDE.at : 0
    const doneAtStart = glide ? GLIDE.done : 0
    const length = DURATION_LONG * 1000 * (1 - startsAt)
    const began = performance.now()
    const step = (now: number) => {
      const through = clamp((now - began) / length, 0, 1)
      const done = (EASE_SMOOTH(startsAt + through * (1 - startsAt)) - doneAtStart) / (1 - doneAtStart)
      element.scrollLeft = from + (end - from) * done
      if (through < 1) {
        frame.current = requestAnimationFrame(step)
        return
      }
      frame.current = 0
      scriptMoves(false)
    }
    frame.current = requestAnimationFrame(step)
  }

  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    // A finger swipes it natively, with the phone's own momentum. Whatever presses it, a glide under way ends here.
    stop()
    const element = strip.current
    if (!element || !scrolls || event.pointerType === 'touch' || event.button !== 0) {
      scriptMoves(false)
      return
    }
    drag.current = { pointer: event.pointerId, x: event.clientX, left: element.scrollLeft, moved: false, trail: [{ at: event.timeStamp, x: event.clientX }] }
    dragged.current = false
  }

  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const element = strip.current
    const now = drag.current
    if (!element || !now || now.pointer !== event.pointerId) return
    const moved = event.clientX - now.x
    if (!now.moved) {
      if (Math.abs(moved) < DRAG_STARTS_AT) return
      now.moved = true
      dragged.current = true
      // From here every move and the release come to the strip, wherever the pointer goes. A browser refuses a
      // pointer it no longer has (one lifted in the same moment): the drag then just ends when it leaves the strip.
      try {
        element.setPointerCapture(event.pointerId)
      } catch {
        // Nothing to do: the strip still follows the pointer while it is over it.
      }
      setDragging(true)
      scriptMoves(true)
    }
    element.scrollLeft = now.left - moved
    now.trail.push({ at: event.timeStamp, x: event.clientX })
    while (now.trail.length > 2 && event.timeStamp - now.trail[0]!.at > SPEED_OVER) now.trail.shift()
  }

  const pointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const element = strip.current
    const now = drag.current
    if (!element || !now || now.pointer !== event.pointerId) return
    drag.current = null
    if (!now.moved) {
      // A press that ended a glide part-way, and no drag after it: the strip is between two pictures, so it eases
      // on to the nearest.
      if (element.hasAttribute(SCRIPT_MOVES)) moveTo(nearestStop(element, element.scrollLeft), false)
      return
    }
    // The click a browser sends after the release comes before any timer: it is the one `clickAfterDrag` stops. If
    // none comes, nothing is left behind to stop a later press.
    setTimeout(() => {
      dragged.current = false
    })
    setDragging(false)
    if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId)
    const first = now.trail[0]!
    const last = now.trail[now.trail.length - 1]!
    // Held still before letting go (or the browser took the pointer away): no speed, no glide. WQ93: it eases to the
    // nearest picture from where it is; with reduced motion it goes there at once (`moveTo`).
    if (reducedMotion || event.type === 'pointercancel' || event.timeStamp - last.at > SPEED_OVER || last.at === first.at) {
      moveTo(nearestStop(element, element.scrollLeft), false)
      return
    }
    // Pixels a millisecond, the way the strip was going (the strip moves against the pointer).
    const speed = -(last.x - first.x) / (last.at - first.at)
    // How far a glide that sets off at that speed goes, along the slowing part of the curve.
    const distance = (speed * DURATION_LONG * 1000 * (1 - GLIDE.done)) / GLIDE.speed
    // WQ93: the glide's end is the picture nearest to where that glide would have stopped, so it eases straight
    // there along the same curve and stops lined up: it never stops and is then nudged.
    moveTo(nearestStop(element, element.scrollLeft + distance), true)
  }

  /**
   * A press that ended a glide part-way, whose mouse then leaves the strip before it has become a drag: its release
   * will not come here, so the strip eases on to the nearest picture now, as it does when that press is let go of.
   */
  const pointerLeave = (event: PointerEvent<HTMLDivElement>) => {
    const element = strip.current
    const now = drag.current
    if (!element || !now || now.pointer !== event.pointerId || now.moved || !element.hasAttribute(SCRIPT_MOVES)) return
    drag.current = null
    moveTo(nearestStop(element, element.scrollLeft), false)
  }

  /** A drag ends in no press: the click that follows it goes nowhere. */
  const clickAfterDrag = (event: MouseEvent<HTMLDivElement>) => {
    if (!dragged.current) return
    dragged.current = false
    event.preventDefault()
    event.stopPropagation()
  }

  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const element = strip.current
    // Only the strip's own keys: a video's button inside it keeps its own.
    if (!element || event.target !== element || event.altKey || event.ctrlKey || event.metaKey) return
    const stops = placesOf(element)
    const at = element.scrollLeft
    const to =
      event.key === 'ArrowRight' ? stops.find((place) => place > at + 1) ?? element.scrollWidth
      : event.key === 'ArrowLeft' ? [...stops].reverse().find((place) => place < at - 1) ?? 0
      : event.key === 'Home' ? 0
      : event.key === 'End' ? element.scrollWidth
      : null
    if (to === null) return
    event.preventDefault()
    moveTo(to, false)
  }

  return (
    <ModuleSection module="gallery-carousel" theme={theme} sectionId={sectionId} className="@container">
      <div
        ref={strip}
        role="group"
        aria-label={label}
        data-lenis-prevent-horizontal=""
        {...(scrolls ? { tabIndex: 0 } : {})}
        {...(dragging ? { 'data-dragging': '' } : {})}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={pointerUp}
        onPointerLeave={pointerLeave}
        onClickCapture={clickAfterDrag}
        // A trackpad's swipe (or a wheel) is the browser's own scrolling, which lines it up itself.
        onWheel={handBack}
        onKeyDown={keyDown}
        // A picture is dragged with the strip, never out of it.
        onDragStart={(event) => event.preventDefault()}
        // The strip is the window's whole width, so its focus ring is drawn just inside its edge, where it can be seen.
        className={`gallery-strip -outline-offset-2 select-none ${scrolls ? (dragging ? 'cursor-grabbing' : 'cursor-grab') : ''}`}
      >
        <div data-gallery="row" className="gallery-row">
          {items.map((item) => (
            <div
              key={item.key}
              data-gallery="item"
              data-phone={kindOf(item.shape.phone)}
              data-desktop={kindOf(item.shape.desktop)}
              style={{ '--gallery-shape-phone': item.shape.phone, '--gallery-shape-desktop': item.shape.desktop } as CSSProperties}
              className={`gallery-item relative overflow-clip rounded-s bg-object-product-bg ${SHAPE} ${SPAN.phone[kindOf(item.shape.phone)]} ${SPAN.desktop[kindOf(item.shape.desktop)]}`}
            >
              <HeroMediaFill
                picture={item.picture}
                video={item.video}
                priority={false}
                reducedMotion={reducedMotion}
                desktopSizes={SIZES.desktop[kindOf(item.shape.desktop)]}
                mobileSizes={SIZES.phone[kindOf(item.shape.phone)]}
              />
            </div>
          ))}
        </div>
      </div>
    </ModuleSection>
  )
}
