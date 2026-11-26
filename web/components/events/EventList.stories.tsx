import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { expect } from 'storybook/test'

import { EventList } from './EventList'
import { SAMPLE_EVENT_CARDS, SAMPLE_EVENT_LIST } from './sample-events'

const meta = {
  title: 'Events/Event list',
  component: EventList,
  parameters: { padded: false, layout: 'fullscreen', nextjs: { appDirectory: true } },
  args: { cards: SAMPLE_EVENT_LIST, heading: 'Upcoming Events', id: 'events' },
} satisfies Meta<typeof EventList>

export default meta
type Story = StoryObj<typeof meta>

const box = (element: Element) => element.getBoundingClientRect()
const list = (canvasElement: HTMLElement) => canvasElement.querySelector('[data-module="upcoming-events"]') as HTMLElement
const cardsOf = (canvasElement: HTMLElement) => [...canvasElement.querySelectorAll('[data-event="card"]')]

/**
 * Figma "EventList", Device=desktop (1634:12821; on Exclusive Hire 1684:41872): 120px above and below; the heading
 * in Label 12, 8px in from the grid's edge; 24px beneath it the EventCards three to a row, 8 of the grid's columns
 * each (464 on Figma's frame), 8px apart, 80px between rows. Every upcoming event, soonest first; a sold-out one
 * keeps its card. The section carries the id `events`, which "All Events" scrolls to.
 */
export const Desktop: Story = {
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    const section = list(canvasElement)
    await expect(section.id).toBe('events')
    const heading = canvas.getByRole('heading', { level: 2, name: 'Upcoming Events' })
    await expect(canvas.getByRole('region', { name: 'Upcoming Events' })).toBe(section)
    await expect([Math.round(box(heading).left), Math.round(box(heading).top - box(section).top), getComputedStyle(heading).textTransform]).toEqual([24, 120, 'uppercase'])
    const cards = cardsOf(canvasElement)
    await expect(cards).toHaveLength(7)
    await expect(cards.slice(0, 4).map((card) => [Math.round(box(card).left), Math.round(box(card).width)])).toEqual([[16, 464], [488, 464], [960, 464], [16, 464]])
    await expect(Math.round(box(cards[0]!).top - box(heading).bottom)).toBe(24)
    // 80px between one row's tallest card and the next row.
    const firstRowBottom = Math.max(...cards.slice(0, 3).map((card) => box(card).bottom))
    await expect(Math.round(box(cards[3]!).top - firstRowBottom)).toBe(80)
    await expect(Math.round(box(section).bottom - box(cards[6]!).bottom)).toBe(120)
    // Soonest first, as it was given; the sold-out one is among them.
    await expect(cards.map((card) => card.querySelector('time')?.textContent)).toEqual([
      '16:00 - Tuesday 27 October',
      '16:00 - Tuesday 3 November',
      '10:00 - Saturday 14 November',
      '16:00 - Tuesday 17 November',
      '19:30 - Monday 21 December',
      '11:00 - Friday 1 January',
      '18:00 - Tuesday 22 June',
    ])
    await expect(canvas.getByText('Sold out')).toBeVisible()
    // Only the first row's pictures load ahead of the rest.
    await expect([...section.querySelectorAll('img')].map((image) => image.loading)).toEqual(['eager', 'eager', 'lazy', 'lazy', 'lazy', 'lazy'])
  },
}

/**
 * Device=mobile (1634:12822; on Exclusive Hire (mobile) 1684:41916): 80px above and below, the cards one to a row,
 * the whole width of the grid (358 on Figma's frame), 64px apart.
 */
export const Mobile: Story = {
  globals: { viewport: { value: 'mobile', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    const section = list(canvasElement)
    const heading = canvas.getByRole('heading', { level: 2, name: 'Upcoming Events' })
    await expect([Math.round(box(heading).left), Math.round(box(heading).top - box(section).top)]).toEqual([24, 80])
    const cards = cardsOf(canvasElement)
    await expect(cards.slice(0, 2).map((card) => [Math.round(box(card).left), Math.round(box(card).width)])).toEqual([[16, 358], [16, 358]])
    await expect(Math.round(box(cards[0]!).top - box(heading).bottom)).toBe(24)
    await expect(Math.round(box(cards[1]!).top - box(cards[0]!).bottom)).toBe(64)
    await expect(Math.round(box(section).bottom - box(cards[6]!).bottom)).toBe(80)
    await expect(document.documentElement.scrollWidth).toBe(390)
  },
}

/**
 * W78b (WQ77): at 768px a card is 8 columns of a narrow grid (240px). With the longest words a card holds, and a
 * members only card among them, nothing reaches past a card's edge or into its neighbour, and the page is no wider
 * than the window (W78a's report, point 2: the old card's spaces ran 19px past its edge here).
 */
export const Tablet: Story = {
  name: 'At 768px, the longest words',
  globals: { viewport: { value: 'tablet', isRotated: false } },
  args: { cards: [SAMPLE_EVENT_CARDS.longest, { ...SAMPLE_EVENT_CARDS.plain, when: SAMPLE_EVENT_CARDS.longest.when, spaces: '10 Spaces Left' }, SAMPLE_EVENT_CARDS.membersOnly, SAMPLE_EVENT_CARDS.soldOut] },
  play: async ({ canvasElement }) => {
    await document.fonts.ready
    const cards = cardsOf(canvasElement)
    await expect(cards.slice(0, 3).map((card) => [Math.round(box(card).left), Math.round(box(card).width)])).toEqual([[16, 240], [264, 240], [512, 240]])
    for (const card of cards) {
      const spilt = [...card.querySelectorAll('span, time')].filter((text) => box(text).left < box(card).left - 0.5 || box(text).right > box(card).right + 0.5)
      await expect(spilt.map((text) => text.textContent)).toEqual([])
    }
    await expect(cards.map((card) => (card as HTMLElement).dataset.type)).toEqual(['members only', 'default', 'members only', 'default'])
    await expect(document.documentElement.scrollWidth).toBe(768)
  },
}

/** The module's heading is optional: without one the cards start the section, and it is still named for a screen reader. */
export const NoHeading: Story = {
  name: 'No heading',
  globals: { viewport: { value: 'desktop', isRotated: false } },
  args: { heading: null },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.queryByRole('heading')).toBeNull()
    await expect(canvas.getByRole('region', { name: 'Upcoming events' })).toBe(list(canvasElement))
    await expect(Math.round(box(cardsOf(canvasElement)[0]!).top - box(list(canvasElement)).top)).toBe(120)
  },
}

/** With no upcoming event the module draws nothing: no heading on its own, and no room taken. */
export const NoEvents: Story = {
  name: 'No events',
  args: { cards: [] },
  play: async ({ canvas, canvasElement }) => {
    await expect(list(canvasElement)).toBeNull()
    await expect(canvas.queryByText('Upcoming Events')).toBeNull()
  },
}
