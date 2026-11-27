import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { expect, fireEvent, userEvent, waitFor } from 'storybook/test'

import type { GalleryCarouselItem } from '@/lib/modules/content'

import { GalleryCarousel } from './GalleryCarousel'
import { samplePicture } from './sample-media'
import { box, DESKTOP, inDark, MOBILE, near } from './story-parts'

// Figma "GalleryCarousel" (05 Modules > Content, 1627:5520; WQ82): a story for each of Figma's two variants, under
// Figma's name for it, in Light and in Dark; then how it is moved: by the keyboard, by a mouse, by a finger.

const item = (key: string, width: number, height: number): GalleryCarouselItem => ({
  key,
  picture: samplePicture(width, height, `Picture ${key}`),
  video: null,
  shape: { phone: width / height, desktop: width / height },
})

/** Figma's own four: 4 by 5, 5 by 4, 4 by 5, 5 by 4. */
const FIGMA_ITEMS = [item('one', 400, 500), item('two', 500, 400), item('three', 400, 500), item('four', 500, 400)]

const meta = {
  title: 'Modules/Content/GalleryCarousel',
  component: GalleryCarousel,
  parameters: { padded: false, layout: 'fullscreen', nextjs: { appDirectory: true } },
  // Reduced motion on: the strip goes where it is sent at once, so a story can say exactly where that is.
  args: { items: FIGMA_ITEMS, theme: null, sectionId: null, reducedMotion: true },
} satisfies Meta<typeof GalleryCarousel>

export default meta
type Story = StoryObj<typeof meta>

const parts = (canvasElement: HTMLElement) => {
  const section = canvasElement.querySelector('[data-module="gallery-carousel"]') as HTMLElement
  const strip = section.querySelector('[role="group"]') as HTMLElement
  return { section, strip, items: [...section.querySelectorAll<HTMLElement>('[data-gallery="item"]')] }
}

/** To a tenth of a pixel: a browser lays a shape out in 64ths of one, so Figma's 418.4 comes out as 418.39. */
const tenth = (value: number) => Math.round(value * 10) / 10

/** Each picture's left edge, width and height, and how far its top is under the strip's. */
const placesOf = (strip: HTMLElement, items: HTMLElement[]) => items.map((one) => [tenth(box(one).left), tenth(box(one).width), tenth(box(one).height), tenth(box(one).top - box(strip).top)])

/** The strip scrolls: found out after the first paint, so waited for. */
const scrolls = async (strip: HTMLElement) => waitFor(() => expect(strip.tabIndex).toBe(0))

const pointer = (x: number, type = 'mouse') => ({ pointerId: 1, pointerType: type, button: 0, isPrimary: true, clientX: x, clientY: 200 })

/**
 * Device=desktop (1627:5519): the pictures on one line, centred on it, from the grid's left margin (16) and off the
 * right of the window. An upright one is 7 of the grid's 24 columns (405 by 506.25), a wide one 9 (523 by 418.4),
 * with one empty column between two (67px). Each has 4px corners on Object/Product Bg. The strip is named for a
 * screen reader, takes focus (it scrolls), shows no scrollbar and the hand that grabs; a picture is not read as a
 * control.
 */
export const Desktop: Story = {
  name: 'Device=desktop',
  globals: DESKTOP,
  play: async ({ canvas, canvasElement }) => {
    const { section, strip, items } = parts(canvasElement)
    await scrolls(strip)
    await expect(canvas.getByRole('group', { name: 'Gallery' })).toBe(strip)
    await expect(placesOf(strip, items)).toEqual([
      [16, 405, 506.3, 0],
      [488, 523, 418.4, 43.9],
      [1078, 405, 506.3, 0],
      [1550, 523, 418.4, 43.9],
    ])
    await expect([near(box(strip).height), near(box(section).height), strip.scrollWidth]).toEqual([506.25, 506.25, 2089])
    await expect(items.map((one) => getComputedStyle(one).borderRadius)).toEqual(['4px', '4px', '4px', '4px'])
    await expect([getComputedStyle(strip).overflowX, getComputedStyle(strip).scrollbarWidth, getComputedStyle(strip).cursor]).toEqual(['auto', 'none', 'grab'])
    await expect(canvas.getAllByRole('img').map((image) => image.getAttribute('alt'))).toEqual(['Picture one', 'Picture two', 'Picture three', 'Picture four'])
    // The page itself is no wider than the window: only the strip scrolls.
    await expect(document.documentElement.scrollWidth).toBe(1440)
  },
}

export const DesktopDark: Story = { ...inDark(Desktop), name: 'Device=desktop (Dark)' }

/** Device=mobile (1627:5518): an upright picture is 5 of the grid's 6 columns (297 by 371.25) and a wide one all 6 (358 by 286.4), 8px apart. */
export const Mobile: Story = {
  name: 'Device=mobile',
  globals: MOBILE,
  play: async ({ canvasElement }) => {
    const { strip, items } = parts(canvasElement)
    await scrolls(strip)
    await expect(placesOf(strip, items)).toEqual([
      [16, 297, 371.3, 0],
      [321, 358, 286.4, 42.4],
      [687, 297, 371.3, 0],
      [992, 358, 286.4, 42.4],
    ])
    await expect([near(box(strip).height), strip.scrollWidth, document.documentElement.scrollWidth]).toEqual([371.25, 1366, 390])
  },
}

export const MobileDark: Story = { ...inDark(Mobile), name: 'Device=mobile (Dark)' }

/**
 * Each picture keeps its own shape (WQ82), whatever it is. A square is an upright picture's width (405 by 405). One
 * taller than 4 by 5 would stand above the band, so it is the band's height and narrower (9 by 16: 284.77 by
 * 506.25). One wider than 5 by 4 is a wide picture's width and shorter (16 by 9: 523 by 294.19). All centred on one line.
 */
export const OwnShapes: Story = {
  name: 'Each picture keeps its own shape',
  globals: DESKTOP,
  args: { items: [item('square', 500, 500), item('tall', 900, 1600), item('wide', 1600, 900), item('upright', 400, 500)] },
  play: async ({ canvasElement }) => {
    const { strip, items } = parts(canvasElement)
    await expect(placesOf(strip, items)).toEqual([
      [16, 405, 405, 50.6],
      [488, 284.8, 506.3, 0],
      [839.8, 523, 294.2, 106],
      [1429.8, 405, 506.3, 0],
    ])
  },
}

/**
 * The keyboard: the strip takes focus (with the ring, drawn just inside its edge) and the arrow keys move it one
 * picture at a time, each to the grid's left margin, never past the strip's end; Home and End go to its two ends.
 */
export const Keyboard: Story = {
  name: 'Moved by the keyboard',
  globals: DESKTOP,
  play: async ({ canvasElement }) => {
    const { strip } = parts(canvasElement)
    await scrolls(strip)
    const end = strip.scrollWidth - strip.clientWidth
    await expect(end).toBe(649)
    await userEvent.tab()
    await expect(document.activeElement).toBe(strip)
    await expect([getComputedStyle(strip).outlineStyle, getComputedStyle(strip).outlineWidth, getComputedStyle(strip).outlineOffset]).toEqual(['solid', '2px', '-2px'])
    const press = async (key: string) => {
      await userEvent.keyboard(key)
      return near(strip.scrollLeft)
    }
    // The second picture's place is 472 (488 less the margin); the third's is past the end, so the strip stops there.
    await expect(await press('{ArrowRight}')).toBe(472)
    await expect(await press('{ArrowRight}')).toBe(649)
    await expect(await press('{ArrowRight}')).toBe(649)
    await expect(await press('{ArrowLeft}')).toBe(472)
    await expect(await press('{ArrowLeft}')).toBe(0)
    await expect(await press('{ArrowLeft}')).toBe(0)
    await expect(await press('{End}')).toBe(649)
    await expect(await press('{Home}')).toBe(0)
    // The page's own keys are left alone.
    await userEvent.keyboard('{ArrowDown}')
    await expect(strip.scrollLeft).toBe(0)
  },
}

/**
 * A mouse drags it: press, move, let go. It follows the pointer exactly (200px to the left is 200px along), never
 * past either end, and a move of a few pixels is still a press. With reduced motion on it stops where it is let go of.
 */
export const DraggedByAMouse: Story = {
  name: 'Dragged by a mouse',
  globals: DESKTOP,
  play: async ({ canvasElement }) => {
    const { strip } = parts(canvasElement)
    await scrolls(strip)
    await fireEvent.pointerDown(strip, pointer(800))
    // Three pixels: not yet a drag.
    await fireEvent.pointerMove(strip, pointer(797))
    await expect([strip.scrollLeft, strip.hasAttribute('data-dragging')]).toEqual([0, false])
    await fireEvent.pointerMove(strip, pointer(600))
    await expect(strip.scrollLeft).toBe(200)
    await waitFor(() => expect([strip.hasAttribute('data-dragging'), getComputedStyle(strip).cursor]).toEqual([true, 'grabbing']))
    await fireEvent.pointerMove(strip, pointer(500))
    await expect(strip.scrollLeft).toBe(300)
    await fireEvent.pointerUp(strip, pointer(500))
    await waitFor(() => expect(strip.hasAttribute('data-dragging')).toBe(false))
    // Reduced motion: no glide after the release.
    await new Promise((resolve) => setTimeout(resolve, 200))
    await expect(strip.scrollLeft).toBe(300)
    // Dragged the other way, past the start: it stops at the start.
    await fireEvent.pointerDown(strip, pointer(300))
    await fireEvent.pointerMove(strip, pointer(900))
    await expect(strip.scrollLeft).toBe(0)
    await fireEvent.pointerUp(strip, pointer(900))
  },
}

/**
 * Momentum (WQ82): let go of while it is moving, the strip glides on the way it was going and slows to a stop along
 * the site's curve, never backwards and never past its end. A press ends a glide.
 */
export const GlidesOnRelease: Story = {
  name: 'Glides on after the release',
  globals: DESKTOP,
  args: { reducedMotion: false },
  play: async ({ canvasElement }) => {
    const { strip } = parts(canvasElement)
    await scrolls(strip)
    const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))
    await fireEvent.pointerDown(strip, pointer(900))
    for (const x of [880, 850, 810, 760]) {
      await wait(20)
      await fireEvent.pointerMove(strip, pointer(x))
    }
    await fireEvent.pointerUp(strip, pointer(760))
    const letGoAt = strip.scrollLeft
    await expect(letGoAt).toBe(140)
    // It goes on, the same way, and comes to rest further along.
    const seen: number[] = []
    const watch = setInterval(() => seen.push(strip.scrollLeft), 16)
    await waitFor(() => expect(strip.scrollLeft).toBeGreaterThan(letGoAt + 20), { timeout: 3000 })
    await wait(900)
    clearInterval(watch)
    const rest = strip.scrollLeft
    await wait(150)
    await expect(strip.scrollLeft).toBe(rest)
    await expect(seen.every((left, index) => index === 0 || left >= seen[index - 1]!)).toBe(true)
    await expect(rest).toBeLessThanOrEqual(strip.scrollWidth - strip.clientWidth)
    // A press stops a glide where it is.
    await fireEvent.pointerDown(strip, pointer(900))
    for (const x of [860, 800, 720]) {
      await wait(20)
      await fireEvent.pointerMove(strip, pointer(x))
    }
    await fireEvent.pointerUp(strip, pointer(720))
    await wait(60)
    await fireEvent.pointerDown(strip, pointer(500))
    const held = strip.scrollLeft
    await wait(200)
    await expect(strip.scrollLeft).toBe(held)
    await fireEvent.pointerUp(strip, pointer(500))
  },
}

/**
 * A finger swipes it as it does any row: the strip is the browser's own sideways scrolling, so the phone moves it,
 * with its own momentum, and the script leaves a finger's moves alone. Lenis leaves a sideways gesture over it to
 * the browser too, and the strip's ends do not hand the swipe on (to Back or Forward).
 */
export const SwipedByAFinger: Story = {
  name: 'Swiped by a finger',
  globals: MOBILE,
  play: async ({ canvasElement }) => {
    const { strip } = parts(canvasElement)
    await scrolls(strip)
    await expect([getComputedStyle(strip).overflowX, getComputedStyle(strip).overscrollBehaviorX, strip.hasAttribute('data-lenis-prevent-horizontal')]).toEqual(['auto', 'contain', true])
    // Nothing of the script's own keeps a finger from panning it.
    await expect(getComputedStyle(strip).touchAction).toBe('auto')
    await fireEvent.pointerDown(strip, pointer(300, 'touch'))
    await fireEvent.pointerMove(strip, pointer(100, 'touch'))
    await expect([strip.scrollLeft, strip.hasAttribute('data-dragging')]).toEqual([0, false])
    await fireEvent.pointerUp(strip, pointer(100, 'touch'))
    // What the browser's own swipe does: the strip scrolls, to its end and no further.
    strip.scrollLeft = 5000
    await expect(strip.scrollLeft).toBe(strip.scrollWidth - strip.clientWidth)
    strip.scrollLeft = 0
  },
}

/** When everything fits there is nothing to drag or to reach with the keyboard: the strip takes no focus and shows no grabbing hand. */
export const NothingToScroll: Story = {
  name: 'One picture: nothing to scroll',
  globals: DESKTOP,
  args: { items: [item('one', 400, 500)] },
  play: async ({ canvasElement }) => {
    const { strip } = parts(canvasElement)
    await new Promise((resolve) => setTimeout(resolve, 100))
    await expect([strip.hasAttribute('tabindex'), getComputedStyle(strip).cursor, strip.scrollWidth <= strip.clientWidth]).toEqual([false, 'auto', true])
  },
}

/** WQ81: on Mud the section carries the theme and stands on its Surface/Primary. WQ83: its Section ID is its id. */
export const ThemeAndSectionId: Story = {
  name: 'Theme=Mud, with a Section ID',
  globals: DESKTOP,
  args: { theme: 'mud', sectionId: 'gallery' },
  play: async ({ canvasElement }) => {
    const { section } = parts(canvasElement)
    await expect([section.dataset.theme, section.id, getComputedStyle(section).backgroundColor]).toEqual(['mud', 'gallery', 'rgb(110, 98, 88)'])
  },
}
