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
 * right of the window. WQ89 amended (as wild.as/about): an upright one is 7 of the grid's 24 columns (405 by 506.25),
 * a landscape one 9 (523 by 418.4), each as tall as its shape makes it, with one empty column between two (67px).
 * Each has 4px corners on Object/Product Bg. The strip is named for a screen reader, takes focus (it scrolls), shows
 * no scrollbar and the hand that grabs; a picture is not read as a control.
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

/** Device=mobile (1627:5518): an upright picture is 5 of the grid's 6 columns (297 by 371.25) and a landscape one all 6 (358 by 286.4), 8px apart. */
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
 * WQ89 amended (as wild.as/about): any shape, never cropped. A panorama (3 by 1), a square, a tall photo (2 by 3) and
 * a video (16 by 9): the square and the tall photo are an upright picture's width, the panorama and the video a
 * landscape one's, and each is as tall as its own shape makes it, so the heights vary; the tall photo is not capped
 * and the line is as tall as it is. All are centred on the line. Every box is its picture's own shape, so the
 * picture fills it whole.
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
    // Panorama 523 by 174.33, square 405 by 405, tall photo 405 by 607.5, video 523 by 294.19; centred on a line 607.5 tall.
    await expect(placesOf(strip, items)).toEqual([
      [16, 523, 174.3, 216.6],
      [606, 405, 405, 101.3],
      [1078, 405, 607.5, 0],
      [1550, 523, 294.2, 156.7],
    ])
    await expect([near(box(strip).height), strip.scrollWidth]).toEqual([607.5, 2089])
    await expect(shapesKept(items)).toEqual([true, true, true, true])
    // The video is drawn as HeroMedia draws one, with its own button, which a press still reaches.
    await expect(items[3]!.querySelector('video')).not.toBeNull()
    await expect(canvas.getByRole('button', { name: 'Play video' })).toBeInTheDocument()
    // The browser is told how wide each is drawn, to fetch a sharp enough file: 9 of 24 columns or 7.
    await expect(items.map((one) => one.querySelector('source')!.getAttribute('sizes'))).toEqual(['38vw', '30vw', '30vw', '38vw'])
    // The keyboard still goes one picture at a time, and End reaches the video.
    strip.focus()
    // The square's place is 590 (606 less the margin).
    await userEvent.keyboard('{ArrowRight}')
    await expect(strip.scrollLeft).toBe(590)
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
    // Panorama 358 by 119.33, square 297 by 297, tall photo 297 by 445.5, video 358 by 201.38; centred on a line 445.5 tall.
    await expect(placesOf(strip, items)).toEqual([
      [16, 358, 119.3, 163.1],
      [382, 297, 297, 74.3],
      [687, 297, 445.5, 0],
      [992, 358, 201.4, 122.1],
    ])
    await expect([near(box(strip).height), strip.scrollWidth]).toEqual([445.5, 1366])
    await expect(shapesKept(items)).toEqual([true, true, true, true])
    await expect(items.map((one) => one.querySelector('img')!.getAttribute('sizes'))).toEqual(['100vw', '80vw', '80vw', '100vw'])
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
    // 2089 less the window's 1440.
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

/** Whether script is moving the strip, and the browser's snapping with it: off while script moves it, on again after. */
const snapping = (strip: HTMLElement) => [strip.hasAttribute('data-script-moves'), getComputedStyle(strip).scrollSnapType]

/**
 * A mouse drags it: press, move, let go. It follows the pointer exactly (200px to the left is 200px along), never
 * past either end, and a move of a few pixels is still a press. With reduced motion on there is no glide: let go of
 * while moving, it is at once on the next picture the way it was going, lined up at the grid's left margin (WQ93, WQ97).
 */
export const DraggedByAMouse: Story = {
  name: 'Dragged by a mouse',
  globals: DESKTOP,
  play: async ({ canvasElement }) => {
    const { strip, items } = parts(canvasElement)
    await scrolls(strip)
    await expect(snapping(strip)).toEqual([false, 'x mandatory'])
    await fireEvent.pointerDown(strip, pointer(800))
    // Three pixels: not yet a drag.
    await fireEvent.pointerMove(strip, pointer(797))
    await expect([strip.scrollLeft, strip.hasAttribute('data-dragging')]).toEqual([0, false])
    await fireEvent.pointerMove(strip, pointer(600))
    await expect(strip.scrollLeft).toBe(200)
    // While the mouse has it the browser's snapping is off: it would pull the strip from under the pointer.
    await expect(snapping(strip)).toEqual([true, 'none'])
    await waitFor(() => expect([strip.hasAttribute('data-dragging'), getComputedStyle(strip).cursor]).toEqual([true, 'grabbing']))
    await fireEvent.pointerMove(strip, pointer(500))
    await expect(strip.scrollLeft).toBe(300)
    await fireEvent.pointerUp(strip, pointer(500))
    await waitFor(() => expect(strip.hasAttribute('data-dragging')).toBe(false))
    // Reduced motion: no glide after the release. It is at once on the next picture the way it was going: the second,
    // whose place is 472, and which stands at the grid's margin. The browser has its snapping back.
    await expect([near(strip.scrollLeft), near(box(items[1]!).left)]).toEqual([472, 16])
    await expect(snapping(strip)).toEqual([false, 'x mandatory'])
    await new Promise((resolve) => setTimeout(resolve, 200))
    await expect(near(strip.scrollLeft)).toBe(472)
    // Dragged the other way, past the start: it stops at the start, and stays there.
    await fireEvent.pointerDown(strip, pointer(300))
    await fireEvent.pointerMove(strip, pointer(900))
    await expect(strip.scrollLeft).toBe(0)
    await fireEvent.pointerUp(strip, pointer(900))
    await expect([strip.scrollLeft, near(box(items[0]!).left)]).toEqual([0, 16])
    await expect(snapping(strip)).toEqual([false, 'x mandatory'])
  },
}

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

/** Drags the strip with a mouse from `from` to `to` (the pointer's places), holds it still, and lets go: no speed, so no glide. */
const dragAndHold = async (strip: HTMLElement, from: number, to: number) => {
  await fireEvent.pointerDown(strip, pointer(from))
  await fireEvent.pointerMove(strip, pointer((from + to) / 2))
  await fireEvent.pointerMove(strip, pointer(to))
  await wait(150)
  await fireEvent.pointerUp(strip, pointer(to))
}

/**
 * WQ93 (Wayne, 27 Nov; as wild.as/about): a drag ends lined up. Held still and let go of between two pictures (no
 * speed: WQ97's rule for a moving release is the glide story's), the strip eases to the
 * nearest one, which comes to rest at the grid's left margin (16): on to the next when that is nearer, back when the
 * one it came from is. At the strip's end it is not forced on: the last pictures stop short of the margin, the last
 * one the margin in from the window's right edge.
 */
export const ADragEndsLinedUp: Story = {
  name: 'A drag ends lined up on a picture',
  globals: DESKTOP,
  args: { reducedMotion: false },
  play: async ({ canvasElement }) => {
    const { strip, items } = parts(canvasElement)
    await scrolls(strip)
    // Where it comes to rest, and where each picture then stands.
    const rest = async (at: number) => {
      await waitFor(() => expect(near(strip.scrollLeft)).toBe(at), { timeout: 3000 })
      await waitFor(() => expect(snapping(strip)).toEqual([false, 'x mandatory']))
      // Handed back to the browser, it stays: the place script left it at is one the browser snaps to.
      await wait(150)
      await expect(near(strip.scrollLeft)).toBe(at)
      return items.map((one) => near(box(one).left))
    }

    // 300 along: the second picture's place (472) is the nearer. It eases on to it, never backwards, and no jump at the end.
    const seen: number[] = []
    const watch = setInterval(() => seen.push(strip.scrollLeft), 16)
    await dragAndHold(strip, 900, 600)
    await expect(strip.scrollLeft).toBe(300)
    await expect((await rest(472))[1]).toBe(16)
    clearInterval(watch)
    await expect(seen.every((left, index) => index === 0 || left >= seen[index - 1]!)).toBe(true)

    // 100 back from there (372): the second picture is still the nearer, so it eases back to it.
    await dragAndHold(strip, 600, 700)
    await expect(near(strip.scrollLeft)).toBe(372)
    await expect((await rest(472))[1]).toBe(16)

    // Back to 150: the first picture is the nearer.
    await dragAndHold(strip, 500, 822)
    await expect(near(strip.scrollLeft)).toBe(150)
    await expect((await rest(0))[0]).toBe(16)

    // Towards the end (600 of 649): it stops at the end and is not forced on. The third picture stops short of the
    // margin, and the last one stands the margin in from the window's right edge.
    await dragAndHold(strip, 1000, 400)
    await expect(strip.scrollLeft).toBe(600)
    const atTheEnd = await rest(649)
    await expect(atTheEnd[2]).toBe(429)
    await expect(near(1440 - box(items[3]!).right)).toBe(16)
  },
}

/** Throws the strip with a mouse: pressed at `from`, moved through each of `through` 20 ms apart, and let go of while still moving. */
const throwIt = async (strip: HTMLElement, from: number, through: number[]) => {
  await fireEvent.pointerDown(strip, pointer(from))
  for (const x of through) {
    await wait(20)
    await fireEvent.pointerMove(strip, pointer(x))
  }
  await fireEvent.pointerUp(strip, pointer(through[through.length - 1]!))
}

/**
 * Momentum (WQ82): let go of while it is moving, the strip glides on the way it was going and slows to a stop along
 * the site's curve, never backwards and never past its end. WQ97 (Wayne, 27 Nov; as wild.as): it always carries on to
 * the next picture that way, however gently it was thrown and however near the picture behind it is, and never goes
 * back behind where it was let go of. WQ93: the glide ends on that picture's place, so it slows straight into line
 * (no stop and then a nudge). A press ends a glide; let go of, the strip eases on to the nearest picture.
 */
export const GlidesOnRelease: Story = {
  name: 'Glides on after the release, to the next picture',
  globals: DESKTOP,
  args: { reducedMotion: false },
  play: async ({ canvasElement }) => {
    const { strip, items } = parts(canvasElement)
    await scrolls(strip)
    // The places it can rest at: the first picture's, the second's, and the strip's end (the third's and fourth's are past it).
    const stops = [0, 472, 649]
    /** Throws it, watches it go, and waits until it is at rest at `at`, handed back to the browser, which moves nothing. */
    const thrownTo = async (from: number, through: number[], letGoAt: number, at: number) => {
      const seen: number[] = []
      await throwIt(strip, from, through)
      await expect(near(strip.scrollLeft)).toBe(letGoAt)
      // Script has it while it glides: the browser's snapping is off until it is at rest.
      await expect(snapping(strip)).toEqual([true, 'none'])
      const watch = setInterval(() => seen.push(strip.scrollLeft), 16)
      await waitFor(() => expect(near(strip.scrollLeft)).toBe(at), { timeout: 3000 })
      await waitFor(() => expect(snapping(strip)).toEqual([false, 'x mandatory']))
      await wait(150)
      clearInterval(watch)
      await expect(near(strip.scrollLeft)).toBe(at)
      return [letGoAt, ...seen]
    }
    const onwardsOnly = (seen: number[]) => seen.every((left, index) => index === 0 || left >= seen[index - 1]!)
    const backOnly = (seen: number[]) => seen.every((left, index) => index === 0 || left <= seen[index - 1]!)

    // A gentle throw onwards, let go of at 100. The first picture's place (0) is the nearer; it still carries on to
    // the second's (472), never backwards, and the second picture stands at the grid's margin.
    await expect(onwardsOnly(await thrownTo(900, [890, 875, 855, 830, 800], 100, 472))).toBe(true)
    await expect(near(box(items[1]!).left)).toBe(16)
    // Onwards again, let go of at 562: no picture's place is ahead, so it carries on to the strip's end and no further.
    await expect(onwardsOnly(await thrownTo(900, [880, 850, 810], 562, 649))).toBe(true)
    await expect(near(1440 - box(items[3]!).right)).toBe(16)
    // Thrown back, let go of at 600. The end (649) is the nearer; it carries on back to the second picture, never onwards.
    await expect(backOnly(await thrownTo(300, [310, 325, 349], 600, 472))).toBe(true)
    await expect(near(box(items[1]!).left)).toBe(16)
    // Back again, let go of at 352 (the second picture's place is the nearer): on back to the first.
    await expect(backOnly(await thrownTo(300, [330, 370, 420], 352, 0))).toBe(true)
    await expect(near(box(items[0]!).left)).toBe(16)

    // A press stops a glide where it is.
    await throwIt(strip, 900, [860, 800, 720])
    await wait(60)
    await fireEvent.pointerDown(strip, pointer(500))
    const held = strip.scrollLeft
    await wait(200)
    await expect(strip.scrollLeft).toBe(held)
    // Let go of with no drag (no speed): it does not stay between two pictures, it eases on to the nearest.
    await fireEvent.pointerUp(strip, pointer(500))
    await waitFor(() => expect(stops).toContain(near(strip.scrollLeft)), { timeout: 3000 })
    await waitFor(() => expect(snapping(strip)).toEqual([false, 'x mandatory']))
  },
}

/**
 * A finger swipes it as it does any row: the strip is the browser's own sideways scrolling, so the phone moves it,
 * with its own momentum, and the script leaves a finger's moves alone. Lenis leaves a sideways gesture over it to
 * the browser too, and the strip's ends do not hand the swipe on (to Back or Forward). WQ93: the browser lines it up
 * too, by its own scroll snapping: each picture by its start, the grid's margin (16) in from the strip's edge.
 */
export const SwipedByAFinger: Story = {
  name: 'Swiped by a finger',
  globals: MOBILE,
  play: async ({ canvasElement }) => {
    const { strip, items } = parts(canvasElement)
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
    // WQ93: and it settles on a picture. The snapping is the browser's (mandatory, along the strip), the script's mark is not on.
    await expect([...snapping(strip), getComputedStyle(strip).scrollPaddingInlineStart]).toEqual([false, 'x mandatory', '16px'])
    await expect(items.map((one) => getComputedStyle(one).scrollSnapAlign)).toEqual(['start', 'start', 'start', 'start'])
    // A scroll the browser is left to finish, from between the first two pictures (their places: 0 and 305), ends on
    // the nearer one, at the margin.
    strip.scrollTo({ left: 200, behavior: 'instant' })
    await waitFor(() => expect([near(strip.scrollLeft), near(box(items[1]!).left)]).toEqual([305, 16]))
    strip.scrollTo({ left: 100, behavior: 'instant' })
    await waitFor(() => expect([near(strip.scrollLeft), near(box(items[0]!).left)]).toEqual([0, 16]))
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
