import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'

import { OverlayTexture } from '@/components/ui/Overlay'

import { EventPageView } from './EventPageView'
import { SAMPLE_EVENT, SAMPLE_EVENTS, SAMPLE_LIST_ADDRESS, SAMPLE_OTHER_EVENTS, sampleAvailability } from './sample-events'

const meta = {
  title: 'Events/Event page',
  component: EventPageView,
  parameters: { padded: false, layout: 'fullscreen', nextjs: { appDirectory: true } },
  // A story asks no route for its spaces: it shows what it was given.
  args: { view: SAMPLE_EVENT, others: SAMPLE_OTHER_EVENTS, listAddress: SAMPLE_LIST_ADDRESS, readLive: null, reducedMotion: true },
  render: (args) => (
    <>
      <OverlayTexture />
      <EventPageView {...args} />
    </>
  ),
} satisfies Meta<typeof EventPageView>

export default meta
type Story = StoryObj<typeof meta>

const box = (element: Element) => element.getBoundingClientRect()
const part = (canvasElement: HTMLElement, name: string) => canvasElement.querySelector(`[data-event="${name}"]`) as HTMLElement
const stepperOf = (canvasElement: HTMLElement) => canvasElement.querySelector('[data-stepper]') as HTMLElement

/**
 * Figma "Event" (1684:41950), CTA State=non-member (1684:41515): the event is open. The gallery fills the window's
 * left half to the end of the grid's 12th column, its pictures stacked, each 4 by 5; the details (Figma "PIC",
 * Type=event) are columns 15 to 21, 240px down, and stick to the window's top while the gallery scrolls past: the
 * name, "£25 (Member from £20)", the date and time in UK time, the quantity stepper beside "Add to bag",
 * "6 spaces left", and the two links that open the info panel. Then Other events.
 */
export const Open: Story = {
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    const gallery = canvasElement.querySelector('[data-shop="gallery"]') as HTMLElement
    await expect([Math.round(box(gallery).left), Math.round(box(gallery).width)]).toEqual([0, 716])
    const pictures = [...gallery.querySelectorAll('[data-gallery-item]')]
    await expect(pictures.map((picture) => [Math.round(box(picture).width), Math.round(box(picture).height)])).toEqual([[716, 895], [716, 895]])
    await expect(canvas.getByRole('group', { name: 'Event pictures' })).toBeVisible()
    const details = part(canvasElement, 'details')
    await expect([Math.round(box(details).left), Math.round(box(details).width), getComputedStyle(details).position]).toEqual([842, 405, 'sticky'])
    const name = canvas.getByRole('heading', { level: 1, name: 'Aufguss Session with Henry' })
    await expect([Math.round(box(name).top), getComputedStyle(name).fontSize]).toEqual([240, '24px'])
    // The price line, 24px under the name: £25, and (Member from £20) muted beside it.
    const price = within(details).getByText('£25')
    const member = within(details).getByText('(Member from £20)')
    await expect(Math.round(box(price).top - box(name).bottom)).toBe(24)
    await expect(Math.round(box(member).left - box(price).right)).toBe(8)
    await expect(getComputedStyle(member).color).not.toBe(getComputedStyle(price).color)
    // The date and time, 24px under the price, in Copy 14.
    const when = within(details).getByText('16:00 - Tuesday 27 October')
    await expect([when.tagName, when.getAttribute('datetime'), getComputedStyle(when.parentElement!).fontSize]).toEqual(['TIME', '2026-10-27T16:00:00+00:00', '14px'])
    await expect(Math.round(box(when.parentElement!).top - box(price).bottom)).toBe(24)
    // The stepper (minus, 1, plus: 33 + 36 + 33) and "Add to bag" beside it, 4px apart, across the details' width.
    const stepper = stepperOf(canvasElement)
    const button = canvas.getByRole('button', { name: 'Add to bag' })
    await expect(canvas.getByRole('group', { name: 'Number of places' })).toBe(stepper)
    await expect([Math.round(box(stepper).left), Math.round(box(stepper).width), Math.round(box(stepper).height)]).toEqual([842, 102, 40])
    await expect([Math.round(box(button).left - box(stepper).right), Math.round(box(button).right), Math.round(box(button).height)]).toEqual([4, 1247, 40])
    await expect(Math.round(box(stepper).top - box(when.parentElement!).bottom)).toBe(32)
    await expect(getComputedStyle(stepper).borderRadius).toBe('4px')
    // "6 spaces left", 8px under them, in Copy 12, muted.
    const spaces = within(details).getByText('6 spaces left')
    await expect([Math.round(box(spaces).top - box(button).bottom), getComputedStyle(spaces).fontSize, getComputedStyle(spaces).color]).toEqual([8, '12px', getComputedStyle(member).color])
    // The links that open the info panel, 64px under the rest, 16px apart.
    const [description, terms] = [canvas.getByRole('button', { name: 'Description' }), canvas.getByRole('button', { name: 'Event Terms & Conditions' })]
    await expect([description.getAttribute('aria-haspopup'), terms.getAttribute('aria-haspopup')]).toEqual(['dialog', 'dialog'])
    await expect([Math.round(box(description).top - box(spaces).bottom), Math.round(box(terms).top - box(description).bottom)]).toEqual([64, 16])
    // Other events, with "All Events" to the events list.
    const others = within(part(canvasElement, 'others'))
    await expect(others.getByRole('heading', { level: 2, name: 'Other Events' })).toBeVisible()
    await expect(others.getByRole('link', { name: 'All Events' }).getAttribute('href')).toBe('/exclusive-hire#events')
    await expect([...part(canvasElement, 'others').querySelectorAll('[data-event="card"]')]).toHaveLength(3)
  },
}

/**
 * The quantity stepper goes from 1 to the spaces left (WQ61): minus is disabled at 1 and plus at the most. Here six
 * are left. "Add to bag" goes to the bag with the event and how many; the bag is not built yet, so nothing changes.
 */
export const Quantity: Story = {
  name: 'Open, choosing how many',
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    const count = stepperOf(canvasElement).querySelector('output') as HTMLElement
    const [fewer, more] = [canvas.getByRole('button', { name: 'One fewer' }), canvas.getByRole('button', { name: 'One more' })]
    await expect([count.textContent, fewer.hasAttribute('disabled'), more.hasAttribute('disabled')]).toEqual(['1', true, false])
    await userEvent.click(more)
    await expect([count.textContent, fewer.hasAttribute('disabled')]).toEqual(['2', false])
    for (let press = 0; press < 4; press += 1) await userEvent.click(more)
    await expect([count.textContent, more.hasAttribute('disabled')]).toEqual(['6', true])
    // At the most a press does nothing.
    await userEvent.click(more)
    await expect(count.textContent).toBe('6')
    await userEvent.click(fewer)
    await expect([count.textContent, more.hasAttribute('disabled')]).toEqual(['5', false])
    // The number keeps its width as it changes, so the button beside it never moves.
    await expect(Math.round(box(stepperOf(canvasElement)).width)).toBe(102)
    await userEvent.click(canvas.getByRole('button', { name: 'Add to bag' }))
    await expect(count.textContent).toBe('5')
  },
}

/** One space: "1 space left", and the stepper has nowhere to go. */
export const OneSpaceLeft: Story = {
  name: 'One space left',
  globals: { viewport: { value: 'desktop', isRotated: false } },
  args: { view: SAMPLE_EVENTS.oneSpaceLeft },
  play: async ({ canvas }) => {
    await expect(canvas.getByText('1 space left')).toBeVisible()
    await expect([canvas.getByRole('button', { name: 'One fewer' }).hasAttribute('disabled'), canvas.getByRole('button', { name: 'One more' }).hasAttribute('disabled')]).toEqual([true, true])
    await expect(canvas.getByRole('button', { name: 'Add to bag' })).toBeEnabled()
  },
}

/**
 * CTA, State=sold out (1684:41643): the event is full. The button is the whole width, disabled, reading "Sold out";
 * no stepper and no spaces line. The price line stays.
 */
export const SoldOut: Story = {
  name: 'Sold out',
  globals: { viewport: { value: 'desktop', isRotated: false } },
  args: { view: SAMPLE_EVENTS.soldOut },
  play: async ({ canvas, canvasElement }) => {
    const button = canvas.getByRole('button', { name: 'Sold out' })
    await expect(button).toBeDisabled()
    await expect([Math.round(box(button).left), Math.round(box(button).width)]).toEqual([842, 405])
    await expect(stepperOf(canvasElement)).toBeNull()
    await expect(canvas.queryByText(/spaces? left/)).toBeNull()
    await expect(canvas.getByText('(Member from £20)')).toBeVisible()
    // The links follow the button 64px under it, as there is no line between.
    await expect(Math.round(box(canvas.getByRole('button', { name: 'Description' })).top - box(button).bottom)).toBe(64)
  },
}

/**
 * CTA, State=member only signed out (1709:48988): a members-only event, for a visitor who isn't signed in. The price
 * line is the member price and "Member Only", both in Text/Primary; the button is the whole width and reads
 * "Sign in" (the one sign-in seam, which opens nothing yet); the spaces left are beneath it.
 */
export const MembersOnly: Story = {
  name: 'Members only',
  globals: { viewport: { value: 'desktop', isRotated: false } },
  args: { view: SAMPLE_EVENTS.membersOnly },
  play: async ({ canvas, canvasElement }) => {
    const details = within(part(canvasElement, 'details'))
    const [price, only] = [details.getByText('£20'), details.getByText('Member Only')]
    await expect(getComputedStyle(only).color).toBe(getComputedStyle(price).color)
    await expect(Math.round(box(only).left - box(price).right)).toBe(8)
    await expect(details.queryByText(/Member from/)).toBeNull()
    await expect(details.queryByText('£25')).toBeNull()
    const button = canvas.getByRole('button', { name: 'Sign in' })
    await expect(button).toBeEnabled()
    await expect(Math.round(box(button).width)).toBe(405)
    await expect(stepperOf(canvasElement)).toBeNull()
    await expect(canvas.queryByRole('button', { name: 'Add to bag' })).toBeNull()
    await expect(details.getByText('6 spaces left')).toBeVisible()
    // A press changes nothing on the page: sign-in is not built yet.
    await userEvent.click(button)
    await expect(button).toBeEnabled()
  },
}

/**
 * A members-first event before it opens to everyone shows as the members-only one (WQ59): it has a public price,
 * which a visitor can't pay yet, so the line is the member price and "Member Only", with "Sign in".
 */
export const MembersFirst: Story = {
  name: 'Members first, not open to everyone yet',
  globals: { viewport: { value: 'desktop', isRotated: false } },
  args: { view: SAMPLE_EVENTS.notReleasedYet },
  play: async ({ canvas, canvasElement }) => {
    const details = within(part(canvasElement, 'details'))
    await expect(details.getByText('£20')).toBeVisible()
    await expect(details.getByText('Member Only')).toBeVisible()
    await expect(details.queryByText('£25')).toBeNull()
    await expect(canvas.getByRole('button', { name: 'Sign in' })).toBeEnabled()
  },
}

/**
 * CTA, State=closed (1684:41716): the event has started, so booking is closed and the page stays (WQ59). The button
 * is disabled and reads "Closed"; no stepper and no spaces line.
 */
export const Started: Story = {
  globals: { viewport: { value: 'desktop', isRotated: false } },
  args: { view: SAMPLE_EVENTS.started },
  play: async ({ canvas, canvasElement }) => {
    const button = canvas.getByRole('button', { name: 'Closed' })
    await expect(button).toBeDisabled()
    await expect(Math.round(box(button).width)).toBe(405)
    await expect(stepperOf(canvasElement)).toBeNull()
    await expect(canvas.queryByText(/spaces? left/)).toBeNull()
    await expect(canvas.queryByText('This event has been cancelled')).toBeNull()
    await expect(canvas.getByText('16:00 - Tuesday 27 October')).toBeVisible()
  },
}

/**
 * A cancelled event's page stays, in the closed state, and says it is cancelled (WQ59). The designs have no words
 * for it: "This event has been cancelled" sits where the spaces line does, in its style (Copy 12, muted), 8px under
 * the "Closed" button.
 */
export const Cancelled: Story = {
  globals: { viewport: { value: 'desktop', isRotated: false } },
  args: { view: SAMPLE_EVENTS.cancelled },
  play: async ({ canvas }) => {
    const button = canvas.getByRole('button', { name: 'Closed' })
    await expect(button).toBeDisabled()
    const line = canvas.getByText('This event has been cancelled')
    await expect([Math.round(box(line).top - box(button).bottom), getComputedStyle(line).fontSize]).toEqual([8, '12px'])
    await expect(canvas.queryByText(/spaces? left/)).toBeNull()
  },
}

/**
 * Figma "Event (mobile)" (1684:42018): the gallery is the window's whole width, a row to swipe, with the slider
 * beneath it; the details follow, 24px under, 16px in from each edge; then Other events, one card under another.
 */
export const Mobile: Story = {
  globals: { viewport: { value: 'mobile', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    const gallery = canvasElement.querySelector('[data-shop="gallery"]') as HTMLElement
    const pictures = [...gallery.querySelectorAll('[data-gallery-item]')]
    await expect(pictures.map((picture) => [Math.round(box(picture).left), Math.round(box(picture).width), Math.round(box(picture).height)])).toEqual([[0, 390, 488], [390, 390, 488]])
    await expect([...(gallery.querySelector('[data-gallery-slider]') as HTMLElement).children]).toHaveLength(2)
    const name = canvas.getByRole('heading', { level: 1 })
    await expect([Math.round(box(name).left), Math.round(box(name).top - box(gallery).bottom)]).toEqual([16, 24])
    const stepper = stepperOf(canvasElement)
    const button = canvas.getByRole('button', { name: 'Add to bag' })
    await expect([Math.round(box(stepper).left), Math.round(box(stepper).width), Math.round(box(button).left - box(stepper).right), Math.round(box(button).right)]).toEqual([16, 102, 4, 374])
    // 120px under the links, Other events begins: its own 120px, then its heading.
    const details = part(canvasElement, 'details')
    const terms = canvas.getByRole('button', { name: 'Event Terms & Conditions' })
    await expect(Math.round(box(details).bottom - box(terms).bottom)).toBe(120)
    const cards = [...part(canvasElement, 'others').querySelectorAll('[data-event="card"]')]
    await expect(cards.map((card) => Math.round(box(card).width))).toEqual([358, 358, 358])
    // The page itself never scrolls sideways.
    await expect(document.documentElement.scrollWidth).toBe(390)
  },
}

/**
 * The page's HTML can be up to a minute old, so once it has loaded it asks the event's route for its spaces and state
 * again. Here the route says two are left: the line changes, and the stepper stops at two.
 */
export const SpacesAskedAgain: Story = {
  name: 'Spaces asked again after load',
  globals: { viewport: { value: 'desktop', isRotated: false } },
  args: { readLive: async (event: string) => sampleAvailability({ event, spacesLeft: 2 }) },
  play: async ({ canvas }) => {
    await expect(await canvas.findByText('2 spaces left')).toBeVisible()
    const more = canvas.getByRole('button', { name: 'One more' })
    await userEvent.click(more)
    await expect(more).toBeDisabled()
  },
}

/** And here the route says it has sold out since: the button is disabled and reads "Sold out". */
export const SoldOutSinceLoad: Story = {
  name: 'Sold out since the page was made',
  globals: { viewport: { value: 'desktop', isRotated: false } },
  args: { readLive: async (event: string) => sampleAvailability({ event, state: 'sold_out', spacesLeft: 0 }) },
  play: async ({ canvas, canvasElement }) => {
    await expect(await canvas.findByRole('button', { name: 'Sold out' })).toBeDisabled()
    await expect(stepperOf(canvasElement)).toBeNull()
  },
}

/**
 * The info panel, the Product page's own (Figma "ProductInfoPanel", 1402:53321): "Description" opens it on the
 * event's description; "Event Terms & Conditions" on Events settings' terms summary, with the event's extra waiver
 * after it. Close, Esc and the shade shut it, and focus goes back to the link that opened it.
 */
export const InfoPanel: Story = {
  name: 'Info panel',
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async ({ canvas }) => {
    // Every tab's words are in the page from the start, hidden until asked for.
    await expect(canvas.getAllByRole('tab', { hidden: true }).map((tab) => tab.textContent)).toEqual(['Description', 'Event Terms & Conditions'])
    const link = canvas.getByRole('button', { name: 'Event Terms & Conditions' })
    await userEvent.click(link)
    const panel = await canvas.findByRole('dialog', { name: 'Event information' })
    const terms = within(panel).getByRole('tab', { name: 'Event Terms & Conditions' })
    await waitFor(() => expect(terms).toHaveFocus())
    await expect(terms.getAttribute('aria-selected')).toBe('true')
    await expect(within(panel).getByText(/Places are for those aged 18 and over/)).toBeVisible()
    // The event's own extra waiver follows the summary, a paragraph for each the editor typed.
    await expect(within(panel).getByText(/Aufguss is hot/)).toBeVisible()
    await expect(within(panel).getByText(/Do not take part if you are pregnant/)).toBeVisible()
    await userEvent.keyboard('{ArrowLeft}')
    await expect(within(panel).getByRole('tab', { name: 'Description' }).getAttribute('aria-selected')).toBe('true')
    await expect(within(panel).getByText(/An hour of Aufguss with Henry/)).toBeVisible()
    await userEvent.click(within(panel).getByRole('button', { name: 'Close' }))
    await waitFor(() => expect(link).toHaveFocus())
  },
}

/** With no other upcoming event the Other events row is not drawn. */
export const NoOtherEvents: Story = {
  name: 'No other events',
  globals: { viewport: { value: 'desktop', isRotated: false } },
  args: { others: [] },
  play: async ({ canvasElement }) => {
    await expect(part(canvasElement, 'others')).toBeNull()
  },
}
