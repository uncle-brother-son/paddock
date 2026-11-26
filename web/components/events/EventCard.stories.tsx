import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { expect, waitFor } from 'storybook/test'

import { painted } from '@/components/ui/story-kit'

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

/** The card's own fonts are in before anything is measured: a line of capitals is a pixel shorter in a stand-in font. */
const fontsIn = async (canvasElement: HTMLElement) => {
  await document.fonts.ready
  await waitFor(() => expect([...canvasElement.querySelectorAll('[data-event="card"] span, [data-event="card"] time')].every((text) => document.fonts.check(getComputedStyle(text).font))).toBe(true))
}

/** The card's parts as Figma names them: the picture's frame, the name, the spaces, the date, the price, and "Members Only" when it is there. */
const partsOf = (card: HTMLElement) => {
  const [name, spaces] = [...card.querySelectorAll<HTMLElement>('[data-event="name-and-spaces"] > span')] as [HTMLElement, HTMLElement]
  const [price, membersOnly] = [...card.querySelectorAll<HTMLElement>('[data-event="price"] > span')] as [HTMLElement, HTMLElement | undefined]
  return { frame: card.querySelector('a > div') as HTMLElement, name, spaces, when: card.querySelector('time') as HTMLElement, price, membersOnly }
}

/** Copy 14 for the name and Copy 12 for the rest, in Text/Primary, the spaces in Text/Muted Primary: as every variant draws them. */
const expectStyles = async (card: HTMLElement) => {
  const { name, spaces, when, price, membersOnly } = partsOf(card)
  const texts = [name, spaces, when, price, ...(membersOnly ? [membersOnly] : [])]
  await expect(texts.map((text) => getComputedStyle(text).fontSize)).toEqual(['14px', '12px', '12px', '12px', ...(membersOnly ? ['12px'] : [])])
  await expect(texts.map((text) => getComputedStyle(text).textTransform)).toEqual(texts.map(() => 'none'))
  const primary = painted(name, 'text-text-primary', 'color')
  const muted = painted(name, 'text-text-muted-primary', 'color')
  await expect(primary).not.toBe(muted)
  await expect(texts.map((text) => getComputedStyle(text).color)).toEqual([primary, muted, primary, primary, ...(membersOnly ? [primary] : [])])
}

/**
 * Device=desktop's arrangement (329:7588, 1802:11329): 8px under the picture the name at the card's left with the
 * spaces on its line at the card's right; 8px under that line the date; 8px under the date the price.
 */
const expectDesktopArrangement = async (card: HTMLElement) => {
  const { frame, name, spaces, when, price } = partsOf(card)
  await expect([Math.round(box(name).left - box(frame).left), Math.round(box(frame).right - box(spaces).right)]).toEqual([0, 0])
  await expect([Math.round(box(name).top - box(frame).bottom), Math.round(box(spaces).top - box(frame).bottom)]).toEqual([8, 8])
  // The name has the line's width but for the spaces and the 8px between them.
  await expect(Math.round(box(spaces).left - box(name).right)).toBe(8)
  await expect([Math.round(box(when).left - box(frame).left), Math.round(box(when).top - box(name).bottom)]).toEqual([0, 8])
  await expect([Math.round(box(price).left - box(frame).left), Math.round(box(price).top - box(when).bottom)]).toEqual([0, 8])
}

/** Device=mobile's (1051:24234, 1802:11338): the spaces 8px under the name, at the card's left; then the date and the price as before. */
const expectMobileArrangement = async (card: HTMLElement) => {
  const { frame, name, spaces, when, price } = partsOf(card)
  await expect([Math.round(box(name).left - box(frame).left), Math.round(box(name).top - box(frame).bottom)]).toEqual([0, 8])
  await expect([Math.round(box(spaces).left - box(frame).left), Math.round(box(spaces).top - box(name).bottom)]).toEqual([0, 8])
  await expect([Math.round(box(when).left - box(frame).left), Math.round(box(when).top - box(spaces).bottom)]).toEqual([0, 8])
  await expect([Math.round(box(price).left - box(frame).left), Math.round(box(price).top - box(when).bottom)]).toEqual([0, 8])
}

/** Nothing of the card reaches past its edges, and no line of it lies over another. */
const expectNothingSpills = async (card: HTMLElement) => {
  const { frame, name, spaces, when, price, membersOnly } = partsOf(card)
  const texts = [name, spaces, when, price, ...(membersOnly ? [membersOnly] : [])]
  const within = box(card)
  await expect(texts.filter((text) => box(text).left < within.left - 0.5 || box(text).right > within.right + 0.5).map((text) => text.textContent)).toEqual([])
  await expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth)
  // Each part starts at or below the one before it, or beside it on its line; never across it.
  const overlapping = texts.flatMap((one, index) =>
    texts.slice(index + 1).filter((other) => box(one).left < box(other).right - 0.5 && box(other).left < box(one).right - 0.5 && box(one).top < box(other).bottom - 0.5 && box(other).top < box(one).bottom - 0.5).map((other) => `${one.textContent} / ${other.textContent}`),
  )
  await expect(overlapping).toEqual([])
  await expect(box(name).top).toBeGreaterThanOrEqual(box(frame).bottom)
}

const cardIn = (canvasElement: HTMLElement) => canvasElement.querySelector('[data-event="card"]') as HTMLElement

/**
 * Figma "EventCard", Device=desktop, Type=default (329:7588; W78b, WQ77): the picture 4 by 5 with 4px corners on
 * Object/Product BG; 8px beneath it the name in Copy 14 with the spaces left in Copy 12, Text/Muted Primary, at the
 * card's right; 8px beneath them the date and time in Copy 12 (WQ69's form); 8px beneath that the price in Copy 12.
 * The text reaches the card's edges. The whole card is one link to the event.
 */
export const Default: Story = {
  name: 'Device=desktop, Type=default',
  play: async ({ canvas, canvasElement }) => {
    await fontsIn(canvasElement)
    const link = canvas.getByRole('link')
    await expect(link.getAttribute('href')).toBe('/events/aufguss-27-oct')
    await expect(canvas.queryAllByRole('button')).toHaveLength(0)
    const card = cardIn(canvasElement)
    await expect(card.dataset.type).toBe('default')
    const { frame, name, spaces, when, price, membersOnly } = partsOf(card)
    await expect([Math.round(box(frame).width), Math.round(box(frame).height)]).toEqual([458, 573])
    await expect(getComputedStyle(frame).borderRadius).toBe('4px')
    await expect([name.textContent, spaces.textContent, when.textContent, price.textContent, membersOnly]).toEqual(['Aufguss Session with Henry', '6 Spaces Left', '16:00 - Tuesday 27 October', '£25', undefined])
    await expect([when.tagName, when.getAttribute('datetime')]).toEqual(['TIME', '2026-10-27T16:00:00+00:00'])
    await expectStyles(card)
    await expectDesktopArrangement(card)
    await expectNothingSpills(card)
  },
}

/**
 * Device=desktop, Type=members only (1802:11329): an event only a member can book now. The same card, with
 * "Members Only" in Copy 12, Text/Primary, 8px after the price on its line. The price is the member's.
 */
export const MembersOnly: Story = {
  name: 'Device=desktop, Type=members only',
  args: { card: SAMPLE_EVENT_CARDS.membersOnly },
  play: async ({ canvasElement }) => {
    await fontsIn(canvasElement)
    const card = cardIn(canvasElement)
    await expect(card.dataset.type).toBe('members only')
    const { price, membersOnly } = partsOf(card)
    await expect([price.textContent, membersOnly?.textContent]).toEqual(['£25', 'Members Only'])
    await expect([Math.round(box(membersOnly!).left - box(price).right), Math.round(Math.abs(box(membersOnly!).top - box(price).top))]).toEqual([8, 0])
    await expectStyles(card)
    await expectDesktopArrangement(card)
    await expectNothingSpills(card)
  },
}

/**
 * Device=mobile, Type=default (1051:24234): the card 183 wide, as Figma draws it. The spaces are 8px under the name,
 * at the card's left; the date and the price follow, 8px apart. No list Figma draws uses it yet (a phone's lists use
 * the desktop card at 358): it is asked for with `device="mobile"`.
 */
export const MobileDefault: Story = {
  name: 'Device=mobile, Type=default',
  args: { device: 'mobile' },
  render: (args) => (
    <div style={{ width: 183 }}>
      <EventCard {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    await fontsIn(canvasElement)
    const card = cardIn(canvasElement)
    const { frame } = partsOf(card)
    await expect([card.dataset.device, Math.round(box(frame).width), Math.round(box(frame).height)]).toEqual(['mobile', 183, 229])
    await expectStyles(card)
    await expectMobileArrangement(card)
    await expectNothingSpills(card)
  },
}

/** Device=mobile, Type=members only (1802:11338): the 183 card with "Members Only" 8px after the price. */
export const MobileMembersOnly: Story = {
  name: 'Device=mobile, Type=members only',
  args: { card: SAMPLE_EVENT_CARDS.membersOnly, device: 'mobile' },
  render: (args) => (
    <div style={{ width: 183 }}>
      <EventCard {...args} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    await fontsIn(canvasElement)
    const card = cardIn(canvasElement)
    const { price, membersOnly } = partsOf(card)
    await expect([price.textContent, membersOnly?.textContent]).toEqual(['£25', 'Members Only'])
    await expect([Math.round(box(membersOnly!).left - box(price).right), Math.round(Math.abs(box(membersOnly!).top - box(price).top))]).toEqual([8, 0])
    await expectStyles(card)
    await expectMobileArrangement(card)
    await expectNothingSpills(card)
  },
}

/** How wide a card is in the lists from 768px, by the window's width: 8 of the grid's 24 columns. (Below 768px: components/events/EventList.stories.tsx.) */
const CARD_WIDTHS = [
  { wide: 768, card: 240 },
  { wide: 1024, card: 325 },
  { wide: 1440, card: 464 },
  { wide: 1920, card: 624 },
]

/**
 * W78b (Wayne, 26 Nov): from 768px a card left to itself takes the arrangement that fits. At every width a list
 * draws it there, with the longest it has to hold (a long name, "10:00 - Wednesday 10 February", "10 Spaces Left" or
 * "Sold out", a price with pence and "Members Only"), nothing reaches past the card's edge and no line lies over
 * another: the spaces are at the right of the name's line while the two fit on it (Device=desktop), and on a line of
 * their own under the name when they don't (Device=mobile), as at a tablet's 240 (W78a's report, point 2: there the
 * old card's spaces ran 19px past its edge). The mobile card, 183 wide, holds the same words too.
 */
export const EveryWidth: Story = {
  name: 'From 768px: the arrangement that fits, the longest words',
  parameters: { layout: 'fullscreen' },
  globals: { viewport: { value: 'desktop', isRotated: false } },
  render: () => (
    <div className="flex flex-col gap-32">
      {CARD_WIDTHS.flatMap(({ wide, card }) =>
        [SAMPLE_EVENT_CARDS.longest, { ...SAMPLE_EVENT_CARDS.longest, id: 'sold', spaces: 'Sold out' }, { ...SAMPLE_EVENT_CARDS.plain, when: SAMPLE_EVENT_CARDS.longest.when, spaces: '10 Spaces Left' }].map((sample, index) => (
          <div key={`${wide}-${index}`} data-window={wide} style={{ width: card }}>
            <EventCard card={sample} />
          </div>
        )),
      )}
      <div data-window="mobile card" style={{ width: 183 }}>
        <EventCard card={SAMPLE_EVENT_CARDS.longest} device="mobile" />
      </div>
    </div>
  ),
  play: async ({ canvasElement }) => {
    await fontsIn(canvasElement)
    const cards = [...canvasElement.querySelectorAll<HTMLElement>('[data-event="card"]')]
    await expect(cards).toHaveLength(CARD_WIDTHS.length * 3 + 1)
    for (const card of cards) await expectNothingSpills(card)
    // Each is wholly one of Figma's two arrangements: the spaces beside the name, or under it.
    const besideTheName = (card: HTMLElement) => Math.abs(box(partsOf(card).spaces).top - box(partsOf(card).name).top) < 1
    for (const card of cards.slice(0, -1)) await (besideTheName(card) ? expectDesktopArrangement(card) : expectMobileArrangement(card))
    await expectMobileArrangement(cards[cards.length - 1]!)
    // Figma's own name beside the longest spaces: the mobile card at a tablet's 240, the desktop card from 325 up,
    // and its name is on one line in both (a line of Copy 14 is its capitals' height, about 10px).
    const figmasName = (wide: number) => canvasElement.querySelectorAll<HTMLElement>(`[data-window="${wide}"] [data-event="card"]`)[2] as HTMLElement
    await expect(CARD_WIDTHS.map(({ wide }) => (besideTheName(figmasName(wide)) ? 'desktop' : 'mobile'))).toEqual(['mobile', 'desktop', 'desktop', 'desktop'])
    await expect(CARD_WIDTHS.map(({ wide }) => box(partsOf(figmasName(wide)).name).height < 14)).toEqual([true, true, true, true])
  },
}

/** One space: "1 Space Left". */
export const OneSpaceLeft: Story = {
  name: 'One space left',
  args: { card: SAMPLE_EVENT_CARDS.oneSpaceLeft },
  play: async ({ canvas }) => {
    await expect(canvas.getByText('1 Space Left')).toBeVisible()
    await expect(canvas.getByText('16:00 - Tuesday 3 November')).toBeVisible()
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
    await expect(canvas.getByText('18:00 - Tuesday 22 June')).toBeVisible()
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

/**
 * On a phone the pages draw the desktop card, Device=desktop, the whole width of the window's grid (358 on Figma's
 * 390 frame: EventList 1634:12822, UpSellRow 1402:50615): the spaces stay on the name's line.
 */
export const Mobile: Story = {
  name: 'In a phone’s list (the desktop card, 358 wide)',
  globals: { viewport: { value: 'mobile', isRotated: false } },
  render: (args) => <EventCard {...args} />,
  play: async ({ canvasElement }) => {
    await fontsIn(canvasElement)
    const card = cardIn(canvasElement)
    const { frame } = partsOf(card)
    await expect([Math.round(box(frame).width), Math.round(box(frame).height)]).toEqual([358, 448])
    await expectStyles(card)
    await expectDesktopArrangement(card)
    await expectNothingSpills(card)
  },
}
