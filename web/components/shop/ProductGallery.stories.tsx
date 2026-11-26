import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { expect, waitFor } from 'storybook/test'

import { painted } from '@/components/ui/story-kit'

import { ProductGallery } from './ProductGallery'
import { SAMPLE_PRODUCT } from './sample-shop'

const meta = {
  title: 'Shop/Gallery',
  component: ProductGallery,
  parameters: { padded: false, layout: 'fullscreen' },
  args: { items: SAMPLE_PRODUCT.gallery, reducedMotion: true },
  globals: { viewport: { value: 'mobile', isRotated: false } },
} satisfies Meta<typeof ProductGallery>

export default meta
type Story = StoryObj<typeof meta>

const box = (element: Element) => element.getBoundingClientRect()
const frames = (count = 2) =>
  new Promise<void>((resolve) => {
    let left = count
    const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick))
    requestAnimationFrame(tick)
  })
const parts = (canvasElement: HTMLElement) => {
  const gallery = canvasElement.querySelector('[data-shop="gallery"]') as HTMLElement
  const row = gallery.querySelector('[role="group"]') as HTMLElement
  const slider = gallery.querySelector<HTMLElement>('[data-gallery-slider]')
  return { gallery, row, slider, slides: [...(slider?.querySelectorAll<HTMLElement>('[data-gallery-slide]') ?? [])], filled: slider?.querySelector<HTMLElement>('[data-gallery-filled]') ?? null }
}
/** Puts the row where a swipe has it at one moment, and waits for the page to have heard. */
const swipeTo = async (row: HTMLElement, left: number) => {
  // With snapping on, a browser would carry the row on to the nearest picture: this holds it where the finger is.
  row.style.scrollSnapType = 'none'
  row.scrollTo({ left, behavior: 'instant' })
  await frames()
}

/**
 * Figma "Gallery" on a phone (1402:48763; W78b, WQ76): the pictures are a row to swipe, the window's whole width
 * each, and 4px under them the slider: one line, 1.2px, the window's whole width, in one part for each picture
 * (Surface/Card), with one part's length filled (Surface/Secondary). The filled part follows the swipe: half-way
 * between two pictures it is half-way between their parts.
 */
export const ThreePictures: Story = {
  play: async ({ canvasElement }) => {
    const { row, slider, slides, filled } = parts(canvasElement)
    await expect(slider).not.toBeNull()
    await expect(slider!.getAttribute('aria-hidden')).toBe('true')
    await expect([Math.round(box(slider!).left), Math.round(box(slider!).width), Number(box(slider!).height.toFixed(1)), Math.round(box(slider!).top - box(row).bottom)]).toEqual([0, 390, 1.2, 4])
    // One part for each picture, side by side, the line's whole length between them.
    await expect(slides.map((slide) => [Math.round(box(slide).left), Math.round(box(slide).width)])).toEqual([[0, 130], [130, 130], [260, 130]])
    await expect(slides.map((slide) => getComputedStyle(slide).backgroundColor)).toEqual(Array(3).fill(painted(slider!, 'bg-surface-card')))
    await expect(getComputedStyle(filled!).backgroundColor).toBe(painted(slider!, 'bg-surface-secondary'))
    const at = () => [Math.round(box(filled!).left), Math.round(box(filled!).width)]
    await expect(at()).toEqual([0, 130])
    // It follows the swipe, not only the end of it: a quarter, a half, the second picture, part-way to the third, the third.
    for (const [left, filledLeft] of [[97.5, 33], [195, 65], [390, 130], [546, 182], [780, 260]] as const) {
      await swipeTo(row, left)
      await waitFor(() => expect(at()).toEqual([filledLeft, 130]))
    }
    // And back, the same.
    await swipeTo(row, 195)
    await waitFor(() => expect(at()).toEqual([65, 130]))
    await swipeTo(row, 0)
    await waitFor(() => expect(at()).toEqual([0, 130]))
    row.style.scrollSnapType = ''
  },
}

/** Two pictures: two parts, half the line each. */
export const TwoPictures: Story = {
  args: { items: SAMPLE_PRODUCT.gallery.slice(0, 2) },
  play: async ({ canvasElement }) => {
    const { row, slides, filled } = parts(canvasElement)
    await expect(slides.map((slide) => Math.round(box(slide).width))).toEqual([195, 195])
    await expect([Math.round(box(filled!).left), Math.round(box(filled!).width)]).toEqual([0, 195])
    await swipeTo(row, 390)
    await waitFor(() => expect(Math.round(box(filled!).left)).toBe(195))
    await swipeTo(row, 0)
    row.style.scrollSnapType = ''
  },
}

/** One picture (WQ76): no slider at all, and nothing to swipe. */
export const OnePicture: Story = {
  args: { items: SAMPLE_PRODUCT.gallery.slice(0, 1) },
  play: async ({ canvasElement }) => {
    const { gallery, row, slider } = parts(canvasElement)
    await expect(slider).toBeNull()
    await expect(gallery.querySelectorAll('[data-gallery-item]')).toHaveLength(1)
    await expect(row.hasAttribute('tabindex')).toBe(false)
    // The gallery ends where its picture does.
    await expect(Math.round(box(gallery).bottom - box(row).bottom)).toBe(0)
  },
}

/** From 768px the pictures are stacked and there is nothing to swipe: no slider is drawn. */
export const Stacked: Story = {
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async ({ canvasElement }) => {
    const { slider } = parts(canvasElement)
    await expect(getComputedStyle(slider!).display).toBe('none')
  },
}
