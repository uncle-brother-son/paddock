import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { expect } from 'storybook/test'

import { EventCard } from './EventCard'
import { SAMPLE_EVENT_CARDS } from './sample-events'

const meta = {
  title: 'Events/EventCard',
  component: EventCard,
  parameters: { nextjs: { appDirectory: true } },
  args: { card: SAMPLE_EVENT_CARDS.plain },
  // Figma draws the card 458 wide in its component, and 464 (8 columns) on the pages.
  render: (args) => (
    <div style={{ width: 458 }}>
      <EventCard {...args} />
    </div>
  ),
} satisfies Meta<typeof EventCard>

export default meta
type Story = StoryObj<typeof meta>

const box = (element: Element) => element.getBoundingClientRect()

/**
 * Figma "EventCard" (329:7588): the picture 4 by 5 with 4px corners on Object/Product BG; 8px beneath it the date
 * and time in the card's short form at the left and the spaces left at the right, both Copy 12; 8px beneath them the
 * name in Copy 14. The text keeps 8px clear of the card's right edge. The whole card is one link to the event.
 */
export const Default: Story = {
  play: async ({ canvas, canvasElement }) => {
    const link = canvas.getByRole('link')
    await expect(link.getAttribute('href')).toBe('/events/aufguss-27-oct')
    await expect(canvas.queryAllByRole('button')).toHaveLength(0)
    const frame = (canvasElement.querySelector('img') as HTMLElement).parentElement as HTMLElement
    await expect([Math.round(box(frame).width), Math.round(box(frame).height)]).toEqual([458, 573])
    await expect(getComputedStyle(frame).borderRadius).toBe('4px')
    const when = canvas.getByText('16:00 — 27th Oct 2026')
    await expect([when.tagName, when.getAttribute('datetime')]).toEqual(['TIME', '2026-10-27T16:00:00+00:00'])
    const spaces = canvas.getByText('6 Spaces Left')
    const name = canvas.getByText('Aufguss Session with Henry')
    await expect([getComputedStyle(when).fontSize, getComputedStyle(spaces).fontSize, getComputedStyle(name).fontSize]).toEqual(['12px', '12px', '14px'])
    // The date at the card's left, the spaces 8px inside its right, on one line 8px under the picture.
    await expect([Math.round(box(when).left - box(frame).left), Math.round(box(frame).right - box(spaces).right)]).toEqual([0, 8])
    await expect(Math.round(box(when).top - box(frame).bottom)).toBe(8)
    await expect(Math.abs(box(when).top - box(spaces).top)).toBeLessThan(1)
    await expect(Math.round(box(name).top - box(when).bottom)).toBe(8)
  },
}

/** One space: "1 Space Left". */
export const OneSpaceLeft: Story = {
  name: 'One space left',
  args: { card: SAMPLE_EVENT_CARDS.oneSpaceLeft },
  play: async ({ canvas }) => {
    await expect(canvas.getByText('1 Space Left')).toBeVisible()
    await expect(canvas.getByText('16:00 — 3rd Nov 2026')).toBeVisible()
  },
}

/**
 * A sold-out event keeps its card (WQ17). Figma's card set draws no sold-out state, so the spaces line reads
 * "Sold out" in its place, as the brief says.
 */
export const SoldOut: Story = {
  name: 'Sold out',
  args: { card: SAMPLE_EVENT_CARDS.soldOut },
  play: async ({ canvas }) => {
    await expect(canvas.getByText('Sold out')).toBeVisible()
    await expect(canvas.queryByText(/Spaces? Left/)).toBeNull()
    await expect(canvas.getByRole('link').getAttribute('href')).toBe('/events/winter-solstice')
  },
}

/** A date in British Summer Time is written in UK time: 18:00 in London, whatever the visitor's own clock says. */
export const SummerTime: Story = {
  name: 'In summer time',
  args: { card: SAMPLE_EVENT_CARDS.summer },
  play: async ({ canvas }) => {
    await expect(canvas.getByText('18:00 — 22nd Jun 2027')).toBeVisible()
  },
}

/** An event with no picture yet: the card keeps its shape on Object/Product BG. */
export const NoPicture: Story = {
  name: 'No picture yet',
  args: { card: SAMPLE_EVENT_CARDS.noPicture },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvasElement.querySelector('img')).toBeNull()
    const frame = canvas.getByRole('link').firstElementChild as HTMLElement
    await expect([Math.round(box(frame).width), Math.round(box(frame).height)]).toEqual([458, 573])
  },
}

/** On a phone the pages draw the same card the whole width of the window's grid (358 on Figma's 390 frame). */
export const Mobile: Story = {
  globals: { viewport: { value: 'mobile', isRotated: false } },
  render: (args) => <EventCard {...args} />,
  play: async ({ canvas, canvasElement }) => {
    const frame = (canvasElement.querySelector('img') as HTMLElement).parentElement as HTMLElement
    await expect([Math.round(box(frame).width), Math.round(box(frame).height)]).toEqual([358, 448])
    const when = canvas.getByText('16:00 — 27th Oct 2026')
    const spaces = canvas.getByText('6 Spaces Left')
    await expect(Math.abs(box(when).top - box(spaces).top)).toBeLessThan(1)
    await expect(Math.round(box(frame).right - box(spaces).right)).toBe(8)
  },
}
