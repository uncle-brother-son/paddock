import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { useState } from 'react'
import { expect, userEvent, waitFor, within } from 'storybook/test'

import { Grid } from './Grid'
import { StickyColumn } from './StickyColumn'

/** The gallery's height in these stories, and what follows the two columns (a page's next section and its footer). */
const GALLERY = 3000
const AFTER = 1200

/**
 * The two columns of the Product, Event and Gift Card pages, as boxes: a gallery on columns 1 to 12 and the details
 * on columns 15 to 21, placed as the pages place them, in the pages' own `StickyColumn`. "Longer" makes the details
 * 600px taller, as a field that opens does.
 */
function TwoColumns({ details }: { details: number }) {
  const [longer, setLonger] = useState(false)
  return (
    <>
      <Grid as="section" data-story="area" className="items-start">
        <div data-story="gallery" className="col-span-full bg-object-product-bg md:col-span-12" style={{ height: GALLERY }} />
        <StickyColumn
          place="col-span-full md:col-span-7 md:col-start-15"
          data-story="details"
          className="flex flex-col justify-between bg-surface-card p-16"
          style={{ height: details + (longer ? 600 : 0) }}
        >
          <p className="text-copy-14 text-text-primary">The top of the details</p>
          <button type="button" onClick={() => setLonger((now) => !now)} className="self-start p-8 text-label-12 text-text-primary">
            {longer ? 'Shorter' : 'Longer'}
          </button>
          <p className="text-copy-14 text-text-primary">The bottom of the details</p>
        </StickyColumn>
      </Grid>
      <div data-story="after" style={{ height: AFTER }} />
    </>
  )
}

const meta = {
  title: 'Shop/Details column',
  component: TwoColumns,
  parameters: { padded: false, layout: 'fullscreen' },
  globals: { viewport: { value: 'desktop', isRotated: false } },
} satisfies Meta<typeof TwoColumns>

export default meta
type Story = StoryObj<typeof meta>

const part = (canvasElement: HTMLElement, name: string) => canvasElement.querySelector(`[data-story="${name}"]`) as HTMLElement
const box = (element: Element) => element.getBoundingClientRect()
const top = (element: Element) => Math.round(box(element).top)
const frames = (count = 2) =>
  new Promise<void>((resolve) => {
    let left = count
    const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick))
    requestAnimationFrame(tick)
  })
/** Puts the window at `y` at once, as a wheel does with reduced motion on, and waits for the page to have heard. */
const scrollTo = async (y: number) => {
  window.scrollTo({ top: y, behavior: 'instant' })
  await frames()
}
/** The window's height: the stories' numbers are worked out from it, so they hold in any window. */
const windowHeight = () => document.documentElement.clientHeight
/** The spacer above the column: its height is how far down its parent the column's own place is. */
const spacerOf = (details: HTMLElement) => details.previousElementSibling as HTMLElement
const placed = (details: HTMLElement) => Math.round(parseFloat(spacerOf(details).style.height))
/** The scrolling has come to rest and the column has been looked at: its own place is where it stands. */
const rested = (details: HTMLElement, place: number) => waitFor(() => expect(placed(details)).toBe(place))

/**
 * WQ73, a details column taller than the window (1400 in a window of 900). Scrolling down it moves with the page
 * until its bottom reaches the bottom of the window and stays there until the gallery ends; scrolling up it moves
 * with the page until its top reaches the top of the window and stays there. At each turn it sets off from where it
 * stands: nothing jumps.
 */
export const TallerThanTheWindow: Story = {
  args: { details: 1400 },
  play: async ({ canvasElement }) => {
    const details = part(canvasElement, 'details')
    const area = part(canvasElement, 'area')
    const height = 1400
    const over = height - windowHeight()
    await scrollTo(0)
    await waitFor(() => expect(details.style.top).toBe(`${-over}px`))
    await expect([getComputedStyle(details).position, details.style.bottom, top(details)]).toEqual(['sticky', `${-over}px`, 0])

    // Down: with the page, until its bottom is at the bottom of the window; then it stays.
    await scrollTo(200)
    await expect(top(details)).toBe(-200)
    await scrollTo(over)
    await expect([top(details), Math.round(box(details).bottom)]).toEqual([-over, windowHeight()])
    await scrollTo(1500)
    await expect([top(details), Math.round(box(details).bottom)]).toEqual([-over, windowHeight()])

    // The turn: it sets off with the page from where it stands, pixel for pixel, and stops with its top at the top.
    await rested(details, 1500 - over)
    await scrollTo(1499)
    await expect(top(details)).toBe(-over + 1)
    await scrollTo(1400)
    await expect(top(details)).toBe(-over + 100)
    await scrollTo(1500 - over)
    await expect(top(details)).toBe(0)
    await scrollTo(600)
    await expect(top(details)).toBe(0)

    // And down again from there: with the page at once, and to the bottom of the window again.
    await rested(details, 600)
    await scrollTo(601)
    await expect(top(details)).toBe(-1)
    await scrollTo(650)
    await expect(top(details)).toBe(-50)
    await scrollTo(600 + over + 300)
    await expect(Math.round(box(details).bottom)).toBe(windowHeight())

    // A turn made without a pause: nothing jumps (it is never further from where it was than the page moved).
    let last = top(details)
    for (const y of [600 + over + 290, 600 + over + 270, 600 + over + 240, 600 + over + 250, 600 + over + 280, 600 + over + 200]) {
      const before = window.scrollY
      await scrollTo(y)
      await expect(Math.abs(top(details) - last)).toBeLessThanOrEqual(Math.abs(y - before))
      last = top(details)
    }

    // The gallery ends: the column leaves with it, their bottoms together, and the parent is no taller for it.
    await scrollTo(GALLERY - 600)
    await expect([Math.round(box(details).bottom), Math.round(box(area).bottom), Math.round(box(area).height)]).toEqual([600, 600, GALLERY])
    // Back up from past the end: with the page again until its top is at the top of the window.
    await rested(details, GALLERY - height)
    await scrollTo(GALLERY - 600 - 100)
    await expect(Math.round(box(details).bottom)).toBe(700)
    await scrollTo(GALLERY - height - 100)
    await expect(top(details)).toBe(0)
    await scrollTo(0)
    await expect([top(details), Math.round(box(area).height)]).toEqual([0, GALLERY])
  },
}

/**
 * A details column that fits the window (500) sticks at the window's top, as it always did, by the stylesheet alone:
 * the script leaves it be.
 */
export const FitsTheWindow: Story = {
  args: { details: 500 },
  play: async ({ canvasElement }) => {
    const details = part(canvasElement, 'details')
    await scrollTo(0)
    await frames()
    await expect([getComputedStyle(details).position, getComputedStyle(details).top, details.style.top, details.style.bottom, spacerOf(details).style.height, Math.round(box(spacerOf(details)).height)]).toEqual(['sticky', '0px', '', '', '', 0])
    await scrollTo(800)
    await expect(top(details)).toBe(0)
    await scrollTo(700)
    await expect(top(details)).toBe(0)
    // The gallery ends: the column leaves with it.
    await scrollTo(GALLERY - 200)
    await expect(Math.round(box(details).bottom)).toBe(200)
    await scrollTo(0)
    await expect(top(details)).toBe(0)
  },
}

/**
 * A column that grows past the window's height where it stands (a field opens, an error line appears): its top
 * stays where it is, and from then on it sticks as a tall one does; made short again, it is a short one again.
 */
export const GrowsWhereItStands: Story = {
  args: { details: 800 },
  play: async ({ canvasElement }) => {
    const details = part(canvasElement, 'details')
    const canvas = within(canvasElement)
    await scrollTo(1000)
    await expect([top(details), details.style.top]).toEqual([0, ''])
    await userEvent.click(canvas.getByRole('button', { name: 'Longer' }))
    const over = 1400 - windowHeight()
    await waitFor(() => expect(details.style.top).toBe(`${-over}px`))
    await expect(top(details)).toBe(0)
    await scrollTo(1100)
    await expect(top(details)).toBe(-100)
    await scrollTo(1000 + over + 200)
    await expect(Math.round(box(details).bottom)).toBe(windowHeight())
    // Short again where it stands with its bottom at the window's bottom: it fits, so its top is at the top.
    await userEvent.click(canvas.getByRole('button', { name: 'Shorter' }))
    await waitFor(() => expect([details.style.top, details.style.bottom, spacerOf(details).style.height, top(details)]).toEqual(['', '', '', 0]))
    await scrollTo(0)
  },
}

/**
 * Below 768px the details follow the gallery down the page and nothing sticks: the script leaves the column alone.
 */
export const OnAPhone: Story = {
  args: { details: 1400 },
  globals: { viewport: { value: 'mobile', isRotated: false } },
  play: async ({ canvasElement }) => {
    const details = part(canvasElement, 'details')
    await scrollTo(0)
    await frames()
    await expect([getComputedStyle(details).position, details.style.top, details.style.bottom, spacerOf(details).style.height]).toEqual(['static', '', '', ''])
    await expect(top(details)).toBe(GALLERY)
    await scrollTo(500)
    await expect(top(details)).toBe(GALLERY - 500)
    await scrollTo(0)
  },
}
