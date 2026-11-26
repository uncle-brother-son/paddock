import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { expect, waitFor } from 'storybook/test'

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

/** The longest words a card holds, Figma's own name beside two figures of spaces, a members only card and a sold-out one. */
const LONGEST_WORDS = [SAMPLE_EVENT_CARDS.longest, { ...SAMPLE_EVENT_CARDS.plain, when: SAMPLE_EVENT_CARDS.longest.when, spaces: '10 Spaces Left' }, SAMPLE_EVENT_CARDS.membersOnly, SAMPLE_EVENT_CARDS.soldOut]

const nameOf = (card: Element) => card.querySelector('[data-event="name-and-spaces"] > span:first-child') as HTMLElement
const spacesOf = (card: Element) => card.querySelector('[data-event="name-and-spaces"] > span:last-child') as HTMLElement

/** A text's width on one line, however it is wrapped now. */
const onOneLine = (text: HTMLElement) => {
  const copy = text.cloneNode(true) as HTMLElement
  copy.style.cssText = 'position: absolute; visibility: hidden; white-space: nowrap; flex: none'
  text.parentElement!.append(copy)
  const { width } = box(copy)
  copy.remove()
  return width
}

/** Which of Figma's two arrangements a card is in: the spaces on the name's line at the card's right (desktop), or 8px under the name at its left (mobile). */
const arrangementOf = (card: Element) => {
  const [name, spaces] = [box(nameOf(card)), box(spacesOf(card))]
  if (Math.abs(spaces.top - name.top) < 1 && Math.round(box(card).right - spaces.right) === 0) return 'desktop'
  if (Math.round(spaces.top - name.bottom) === 8 && Math.round(spaces.left - box(card).left) === 0) return 'mobile'
  return 'neither'
}

/** Everything wrong with where a card's words are: a line cut off by the card's edge, or one lying over another. Empty when all is well. */
const misplacedIn = (card: Element) => {
  const texts = [...card.querySelectorAll<HTMLElement>('[data-event="name-and-spaces"] > span, time, [data-event="price"] > span')]
  const within = box(card)
  const clipped = texts.filter((text) => box(text).left < within.left - 0.5 || box(text).right > within.right + 0.5 || box(text).bottom > within.bottom + 0.5).map((text) => `clipped: ${text.textContent}`)
  const line = card.querySelector('[data-event="name-and-spaces"]') as HTMLElement
  const cutOff = line.scrollWidth > line.clientWidth ? ['the first line is wider than the card'] : []
  const overlapping = texts.flatMap((one, index) =>
    texts
      .slice(index + 1)
      .filter((other) => box(one).left < box(other).right - 0.5 && box(other).left < box(one).right - 0.5 && box(one).top < box(other).bottom - 0.5 && box(other).top < box(one).bottom - 0.5)
      .map((other) => `overlap: ${one.textContent} / ${other.textContent}`),
  )
  return [...clipped, ...cutOff, ...overlapping]
}

/**
 * The list at one width of window, with the longest words (Wayne, 26 Nov): the spaces are never cut off and never
 * lie over another line; each card is in the arrangement that fits (from 768px: the desktop card while the name and
 * the spaces fit on one line with 8px between them, the mobile card when they don't; below: always the desktop card);
 * and the page is no wider than the window. `expected` is each card's arrangement, in order.
 */
const atWidth = (viewport: string, wide: number, card: number, expected: string[]): Story => ({
  globals: { viewport: { value: viewport, isRotated: false } },
  args: { cards: LONGEST_WORDS },
  play: async ({ canvasElement }) => {
    await document.fonts.ready
    const cards = cardsOf(canvasElement)
    await waitFor(() => expect(cards.every((one) => [nameOf(one), spacesOf(one)].every((text) => document.fonts.check(getComputedStyle(text).font)))).toBe(true))
    await expect(cards.map((one) => Math.round(box(one).width))).toEqual(cards.map(() => card))
    await expect(cards.flatMap(misplacedIn)).toEqual([])
    await expect(cards.map(arrangementOf)).toEqual(expected)
    // The rule itself, from the words' own widths.
    const fits = (one: Element) => onOneLine(nameOf(one)) + 8 + box(spacesOf(one)).width <= box(one).width + 0.5
    await expect(cards.map(arrangementOf)).toEqual(cards.map((one) => (wide < 768 || fits(one) ? 'desktop' : 'mobile')))
    await expect(cards.map((one) => (one as HTMLElement).dataset.type)).toEqual(['members only', 'default', 'members only', 'default'])
    await expect(document.documentElement.scrollWidth).toBe(wide)
  },
})

/**
 * At 768px a card is 8 columns of a narrow grid, 240px: too narrow for Figma's own name beside its spaces, so those
 * cards are the mobile card, the spaces under the name (W78a's report, point 2: the old card's spaces ran 19px past
 * its edge here). A short name still has its spaces beside it.
 */
export const At768: Story = atWidth('tablet', 768, 240, ['mobile', 'mobile', 'mobile', 'desktop'])

/** At 1024px a card is 325px: Figma's name and its spaces fit on one line again; only the longest name does not. */
export const At1024: Story = atWidth('w1024', 1024, 325, ['mobile', 'desktop', 'desktop', 'desktop'])

/** At 1440px, Figma's frame, a card is 464px: the desktop card, as drawn; only a name too long for the line with its spaces is the mobile card. */
export const At1440: Story = atWidth('desktop', 1440, 464, ['desktop', 'desktop', 'desktop', 'desktop'])

/** On a phone (390px) every card is the desktop card, as Figma's phone list draws it: a long name goes on to another line beside its spaces. */
export const At390: Story = atWidth('mobile', 390, 358, ['desktop', 'desktop', 'desktop', 'desktop'])

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
