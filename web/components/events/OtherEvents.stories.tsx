import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { expect, within } from 'storybook/test'

import { OtherEvents } from './OtherEvents'
import { SAMPLE_LIST_ADDRESS, SAMPLE_OTHER_EVENTS } from './sample-events'

const meta = {
  title: 'Events/Other events',
  component: OtherEvents,
  parameters: { padded: false, layout: 'fullscreen', nextjs: { appDirectory: true } },
  args: { cards: SAMPLE_OTHER_EVENTS, allHref: SAMPLE_LIST_ADDRESS },
} satisfies Meta<typeof OtherEvents>

export default meta
type Story = StoryObj<typeof meta>

const box = (element: Element) => element.getBoundingClientRect()
const row = (canvasElement: HTMLElement) => canvasElement.querySelector('[data-event="others"]') as HTMLElement
const cardsOf = (canvasElement: HTMLElement) => [...canvasElement.querySelectorAll('[data-event="card"]')]

/**
 * Figma "UpSellRow", Device=desktop, Type=events (1402:50607; on the Event page 1684:41961): 160px above and below;
 * "Other Events" in Label 12, 8px in from the grid's edge, with "All Events" at the right (WQ60: to the events list
 * on Exclusive Hire); 32px beneath them three EventCards, 8 of the grid's columns each (464), 8px apart.
 */
export const Desktop: Story = {
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    const section = row(canvasElement)
    const heading = canvas.getByRole('heading', { level: 2, name: 'Other Events' })
    await expect([Math.round(box(heading).left), Math.round(box(heading).top - box(section).top)]).toEqual([24, 160])
    const all = canvas.getByRole('link', { name: 'All Events' })
    await expect(all.getAttribute('href')).toBe('/exclusive-hire#events')
    // Its label ends 8px inside the grid's edge, on the heading's line; its press reaches 8px round the label.
    const label = within(all).getByText('All Events')
    await expect([Math.round(box(label).right), Math.round(box(all).right)]).toEqual([1408, 1416])
    await expect(Math.abs(box(label).top - box(heading).top)).toBeLessThan(1)
    const cards = cardsOf(canvasElement)
    await expect(cards.map((card) => [Math.round(box(card).left), Math.round(box(card).width)])).toEqual([[16, 464], [488, 464], [960, 464]])
    await expect(Math.round(box(cards[0]!).top - box(heading).bottom)).toBe(32)
    await expect(Math.round(box(section).bottom - Math.max(...cards.map((card) => box(card).bottom)))).toBe(160)
    await expect(cards.map((card) => card.querySelector('a')?.getAttribute('href'))).toEqual(['/events/aufguss-3-nov', '/events/winter-solstice', '/events/midsummer-plunge'])
  },
}

/**
 * Device=mobile, Type=events (1402:50615; on Event (mobile) 1684:42029): 120px above and below, the cards one under
 * the other, the whole width of the grid, 80px apart.
 */
export const Mobile: Story = {
  globals: { viewport: { value: 'mobile', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    const section = row(canvasElement)
    const heading = canvas.getByRole('heading', { level: 2, name: 'Other Events' })
    await expect([Math.round(box(heading).left), Math.round(box(heading).top - box(section).top)]).toEqual([24, 120])
    await expect(canvas.getByRole('link', { name: 'All Events' })).toBeVisible()
    const cards = cardsOf(canvasElement)
    await expect(cards.map((card) => [Math.round(box(card).left), Math.round(box(card).width)])).toEqual([[16, 358], [16, 358], [16, 358]])
    await expect(Math.round(box(cards[0]!).top - box(heading).bottom)).toBe(32)
    await expect([Math.round(box(cards[1]!).top - box(cards[0]!).bottom), Math.round(box(cards[2]!).top - box(cards[1]!).bottom)]).toEqual([80, 80])
    await expect(Math.round(box(section).bottom - box(cards[2]!).bottom)).toBe(120)
    await expect(document.documentElement.scrollWidth).toBe(390)
  },
}

/** Fewer than three: each card keeps its own third of the row. */
export const OneOther: Story = {
  name: 'One other event',
  globals: { viewport: { value: 'desktop', isRotated: false } },
  args: { cards: SAMPLE_OTHER_EVENTS.slice(0, 1) },
  play: async ({ canvasElement }) => {
    await expect(cardsOf(canvasElement).map((card) => [Math.round(box(card).left), Math.round(box(card).width)])).toEqual([[16, 464]])
  },
}

/** Until a page holds the events list there is nowhere for "All Events" to go, and it is not drawn. */
export const NoListYet: Story = {
  name: 'No events list to go to',
  globals: { viewport: { value: 'desktop', isRotated: false } },
  args: { allHref: null },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('heading', { level: 2, name: 'Other Events' })).toBeVisible()
    await expect(canvas.queryByRole('link', { name: 'All Events' })).toBeNull()
  },
}

/** With no other upcoming event the row is not drawn. */
export const NoOthers: Story = {
  name: 'No other events',
  args: { cards: [] },
  play: async ({ canvasElement }) => {
    await expect(row(canvasElement)).toBeNull()
  },
}
