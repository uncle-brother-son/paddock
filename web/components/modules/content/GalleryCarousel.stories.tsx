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
 * Device=desktop (1627:5519): the pictures on one line, from the grid's left margin (16) and off the right of the
 * window. WQ89: every one is the height Figma draws (its 4 by 5 upright picture, 506.25) and as wide as its own shape
 * makes it, so a 4 by 5 is 405 wide and a 5 by 4 632.81 (Figma drew it 523 by 418.4, the 9-column rule WQ89 drops),
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
      [488, 632.8, 506.3, 0],
      [1187.8, 405, 506.3, 0],
      [1659.8, 632.8, 506.3, 0],
    ])
    // 16 + 405 + 67 + 632.81 + 67 + 405 + 67 + 632.81 + 16.
    await expect([near(box(strip).height), near(box(section).height), Math.abs(strip.scrollWidth - 2308.63) < 1]).toEqual([506.25, 506.25, true])
    await expect(items.map((one) => getComputedStyle(one).borderRadius)).toEqual(['4px', '4px', '4px', '4px'])
    await expect([getComputedStyle(strip).overflowX, getComputedStyle(strip).scrollbarWidth, getComputedStyle(strip).cursor]).toEqual(['auto', 'none', 'grab'])
    await expect(canvas.getAllByRole('img').map((image) => image.getAttribute('alt'))).toEqual(['Picture one', 'Picture two', 'Picture three', 'Picture four'])
    // The page itself is no wider than the window: only the strip scrolls.
    await expect(document.documentElement.scrollWidth).toBe(1440)
  },
}

export const DesktopDark: Story = { ...inDark(Desktop), name: 'Device=desktop (Dark)' }

/**
 * Device=mobile (1627:5518): every picture 371.25 tall, the height Figma draws its 4 by 5 one (5 of the grid's 6
 * columns, 297 wide), and as wide as its shape makes it: a 5 by 4 is 464.06 (Figma drew it 358 by 286.4). 8px apart.
 */
export const Mobile: Story = {
  name: 'Device=mobile',
  globals: MOBILE,
  play: async ({ canvasElement }) => {
    const { strip, items } = parts(canvasElement)
    await scrolls(strip)
    await expect(placesOf(strip, items)).toEqual([
      [16, 297, 371.3, 0],
      [321, 464.1, 371.3, 0],
      [793.1, 297, 371.3, 0],
      [1098.1, 464.1, 371.3, 0],
    ])
    // 16 + 297 + 8 + 464.06 + 8 + 297 + 8 + 464.06 + 16.
    await expect([near(box(strip).height), Math.abs(strip.scrollWidth - 1578.13) < 1, document.documentElement.scrollWidth]).toEqual([371.25, true, 390])
  },
}

export const MobileDark: Story = { ...inDark(Mobile), name: 'Device=mobile (Dark)' }

/**
 * WQ89: any shape, never cropped. A panorama (3 by 1), a square, a tall photo (2 by 3) and a video (16 by 9), each
 * the height Figma draws and as wide as its own shape makes it, whatever that is: the panorama is wider than the
 * window. Every box is its picture's own shape, so the picture fills it whole.
 */
const ANY_SHAPES = [
  item('panorama', 3000, 1000),
  item('square', 1000, 1000),
  item('tall', 1000, 1500),
  {
    ...item('video', 1600, 900),
    video: { url: 'https://example.invalid/wq89-carousel.mp4', phoneUrl: null, description: 'Picture video', captionsUrl: null, hasSound: false },
  },
]

/** Every picture's box against its own shape: the same, to a thousandth, so nothing of it is cut off. */
const shapesKept = (items: HTMLElement[]) => items.map((one, index) => Math.abs(box(one).width / box(one).height - ANY_SHAPES[index]!.shape.desktop) < 0.001)

export const AnyShapeDesktop: Story = {
  name: 'Any shape: a panorama, a square, a tall photo and a video (desktop)',
  globals: DESKTOP,
  args: { items: ANY_SHAPES },
  play: async ({ canvas, canvasElement }) => {
    const { strip, items } = parts(canvasElement)
    await scrolls(strip)
    await expect(placesOf(strip, items)).toEqual([
      [16, 1518.8, 506.3, 0],
      [1601.8, 506.3, 506.3, 0],
      [2175, 337.5, 506.3, 0],
      [2579.5, 900, 506.3, 0],
    ])
    await expect(shapesKept(items)).toEqual([true, true, true, true])
    // The video is drawn as HeroMedia draws one, with its own button, which a press still reaches.
    await expect(items[3]!.querySelector('video')).not.toBeNull()
    await expect(canvas.getByRole('button', { name: 'Play video' })).toBeInTheDocument()
    // The browser is told how wide each is drawn, to fetch a sharp enough file: the band (35.16% of the window) times its shape.
    await expect(items.map((one) => one.querySelector('source')!.getAttribute('sizes'))).toEqual(['106vw', '36vw', '24vw', '63vw'])
    // The keyboard still goes one picture at a time, and End reaches the video.
    strip.focus()
    // The square's place is 1585.75 (1601.75 less the margin); the browser scrolls in whole pixels.
    await userEvent.keyboard('{ArrowRight}')
    await expect(strip.scrollLeft).toBe(1586)
    await userEvent.keyboard('{End}')
    await expect(strip.scrollLeft).toBe(strip.scrollWidth - strip.clientWidth)
    // At the end the video stands the margin in from the window's right edge (to the pixel).
    await expect(Math.abs(box(items[3]!).right - 1424)).toBeLessThan(1)
  },
}

export const AnyShapeMobile: Story = {
  name: 'Any shape: a panorama, a square, a tall photo and a video (mobile)',
  globals: MOBILE,
  args: { items: ANY_SHAPES },
  play: async ({ canvasElement }) => {
    const { strip, items } = parts(canvasElement)
    await scrolls(strip)
    await expect(placesOf(strip, items)).toEqual([
      [16, 1113.8, 371.3, 0],
      [1137.8, 371.3, 371.3, 0],
      [1517, 247.5, 371.3, 0],
      [1772.5, 660, 371.3, 0],
    ])
    await expect(shapesKept(items)).toEqual([true, true, true, true])
    await expect(items.map((one) => one.querySelector('img')!.getAttribute('sizes'))).toEqual(['286vw', '96vw', '64vw', '170vw'])
    await expect(document.documentElement.scrollWidth).toBe(390)
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
    // 2309 (2308.63 laid out) less the window's 1440.
    await expect(end).toBe(869)
    await userEvent.tab()
    await expect(document.activeElement).toBe(strip)
    await expect([getComputedStyle(strip).outlineStyle, getComputedStyle(strip).outlineWidth, getComputedStyle(strip).outlineOffset]).toEqual(['solid', '2px', '-2px'])
    const press = async (key: string) => {
      await userEvent.keyboard(key)
      return near(strip.scrollLeft)
    }
    // The second picture's place is 472 (488 less the margin); the third's is past the end, so the strip stops there.
    await expect(await press('{ArrowRight}')).toBe(472)
    await expect(await press('{ArrowRight}')).toBe(869)
    await expect(await press('{ArrowRight}')).toBe(869)
    await expect(await press('{ArrowLeft}')).toBe(472)
    await expect(await press('{ArrowLeft}')).toBe(0)
    await expect(await press('{ArrowLeft}')).toBe(0)
    await expect(await press('{End}')).toBe(869)
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
