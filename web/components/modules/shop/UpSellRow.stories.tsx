import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { expect, waitFor, within } from 'storybook/test'

import { SAMPLE_LIST_ADDRESS, SAMPLE_OTHER_EVENTS } from '@/components/events/sample-events'
import { SAMPLE_SIMILAR } from '@/components/shop/sample-shop'

import { UpSellRow } from './UpSellRow'

const meta = {
  title: 'Modules/Shop/UpSellRow',
  component: UpSellRow,
  parameters: { padded: false, layout: 'fullscreen', nextjs: { appDirectory: true } },
  args: { type: 'events', cards: SAMPLE_OTHER_EVENTS, allHref: SAMPLE_LIST_ADDRESS },
} satisfies Meta<typeof UpSellRow>

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
  args: { type: 'events', cards: SAMPLE_OTHER_EVENTS.slice(0, 1), allHref: SAMPLE_LIST_ADDRESS },
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

/**
 * Type=products, Similar Merch (mobile 1402:49921): cards of 3 of the grid's 6 columns (175), 8px apart, running off
 * the window's right edge. WQ93 amended (Wayne, 27 Nov): the row settles as the GalleryCarousel does, by the browser's
 * own scroll snapping: on the nearest card, lined up at the grid's left margin (16). At its end it is not forced on:
 * the last card stands the margin in from the window's right edge.
 */
export const SimilarMerchSettles: Story = {
  name: 'Type=products: the row settles on the nearest card',
  globals: { viewport: { value: 'mobile', isRotated: false } },
  args: { type: 'products', cards: SAMPLE_SIMILAR },
  play: async ({ canvasElement }) => {
    const list = canvasElement.querySelector('[data-shop="similar"] ul') as HTMLElement
    const cards = [...list.children]
    await expect(cards.map((card) => [Math.round(box(card).left), Math.round(box(card).width)])).toEqual([[16, 175], [199, 175], [382, 175], [565, 175]])
    await expect(getComputedStyle(list).scrollSnapType).toBe('x mandatory')
    // Lenis leaves a sideways gesture over the row to the browser, as it does over the gallery and the rows of cards.
    await expect(list.hasAttribute('data-lenis-prevent-horizontal')).toBe(true)
    await expect(cards.map((card) => [getComputedStyle(card).scrollSnapAlign, getComputedStyle(card).scrollMarginLeft])).toEqual(cards.map(() => ['start', '16px']))
    // The cards' places: 0, 183 (a card's 175 and the 8 after it), and the row's end, 366.
    await expect(list.scrollWidth - list.clientWidth).toBe(366)
    list.scrollTo({ left: 120, behavior: 'instant' })
    await waitFor(() => expect([Math.round(list.scrollLeft), Math.round(box(cards[1]!).left)]).toEqual([183, 16]))
    list.scrollTo({ left: 60, behavior: 'instant' })
    await waitFor(() => expect([Math.round(list.scrollLeft), Math.round(box(cards[0]!).left)]).toEqual([0, 16]))
    list.scrollTo({ left: 330, behavior: 'instant' })
    await waitFor(() => expect([Math.round(list.scrollLeft), Math.round(390 - box(cards[3]!).right)]).toEqual([366, 16]))
    await expect(document.documentElement.scrollWidth).toBe(390)
  },
}
