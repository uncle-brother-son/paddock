import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { expect, fn, userEvent, waitFor } from 'storybook/test'

import { bookingSummary, chosenSession, type ChosenSession } from '@/lib/book/book'

import { BookingSummary } from './BookingSummary'
import { SAMPLE_ADD_ONS, SAMPLE_TODAY, samplePrivate, samplePublic, sampleQuote } from './sample-book'

const PUBLIC = samplePublic(SAMPLE_TODAY, '08:00')
const PRIVATE = samplePrivate(SAMPLE_TODAY, '08:00', 60)
const chosen = (view: 'public' | 'private', people: number): ChosenSession => {
  const session = view === 'public' ? PUBLIC : PRIVATE
  return chosenSession(view, session, people, sampleQuote(session.id, people))!
}

const meta = {
  title: 'Book/BookingSummary',
  component: BookingSummary,
  args: { summary: bookingSummary(chosen('public', 1), SAMPLE_ADD_ONS, {}), onChange: fn(), onAddToBag: fn(), onBookNow: fn() },
  globals: { theme: 'dark' },
  // "Your booking" on a desktop: 7 of the panel's columns.
  decorators: [(Story) => <div className="max-w-[398px]">{Story()}</div>],
} satisfies Meta<typeof BookingSummary>

export default meta
type Story = StoryObj<typeof meta>

const box = (element: Element) => element.getBoundingClientRect()
const round = (...numbers: number[]) => numbers.map((number) => Math.round(number))
/** Waits until the words' own font is in: a height that hangs on a line of capitals is measured in that font, not a stand-in's. */
const fontIn = async (words: Element) => {
  await document.fonts.ready
  await waitFor(() => expect(document.fonts.check(getComputedStyle(words).font)).toBe(true))
}
/** A height Figma gives with each line of capitals counted as 9px: here a line is a little under 9, so a few lines come to a pixel or two less. */
const near = (height: number, figma: number, lines: number) => height <= figma + 0.5 && height >= figma - lines
const lines = (root: HTMLElement) => [...root.querySelectorAll('dt, dd')].map((one) => one.textContent)

/**
 * Figma "BookingSummary", Scenario=Non Member - One session (1178:20011), 285px tall: the session's card ("Your
 * Booking"; the service with Change at its right; when it is; what it is; "1 Person" with "£15.00"), 12px beneath it
 * the total's card ("Total to pay", then Add to bag and Book now, each half the card), and the two notes.
 */
export const OneSession: Story = {
  play: async ({ canvas, canvasElement, args }) => {
    const summary = canvas.getByRole('region', { name: 'Your booking' })
    await expect(near(box(summary).height, 285, 12)).toBe(true)
    const [session, total] = [...summary.querySelectorAll<HTMLElement>(':scope > div')] as [HTMLElement, HTMLElement]
    await expect(round(box(total).top - box(session).bottom)).toEqual([12])
    await expect([getComputedStyle(session).paddingLeft, getComputedStyle(session).paddingTop, getComputedStyle(total).paddingBottom, getComputedStyle(session).borderRadius]).toEqual(['12px', '16px', '12px', '4px'])
    const heading = canvas.getByRole('heading', { name: 'Your Booking' })
    const service = canvas.getByText('Contrast Therapy')
    await expect(round(box(service).top - box(heading).bottom)).toEqual([24])
    const when = canvas.getByText('08:00 Thursday 12 November 2026')
    await expect(when.getAttribute('datetime')).toBe(PUBLIC.startsAt)
    await expect(canvas.getByText('60 min - Public - Off-Peak')).toBeVisible()
    await expect(lines(canvasElement)).toEqual(['1 Person', '£15.00', 'Total to pay', '£15.00'])
    await expect(canvas.queryByRole('heading', { name: 'Add-Ons' })).toBeNull()
    // Change: an underlined link at the service's right, in Text/Muted Primary.
    const change = canvas.getByRole('button', { name: 'Change the session' })
    await expect(getComputedStyle(change).textDecorationLine).toBe('underline')
    await expect(Math.round(box(session).right - box(change).right)).toBe(12)
    await userEvent.click(change)
    await expect(args.onChange).toHaveBeenCalledTimes(1)
    const [add, now] = [canvas.getByRole('button', { name: 'Add to bag' }), canvas.getByRole('button', { name: 'Book now' })]
    await fontIn(add.firstElementChild!)
    await expect(round(box(add).width, box(now).width, box(now).left - box(add).right)).toEqual([181, 181, 12])
    // 12px above and below its label's capitals: Figma's 33, with the capitals counted as 9px.
    await expect(Math.abs(box(add).height - 33)).toBeLessThan(1)
    await userEvent.click(add)
    await userEvent.click(now)
    await expect([args.onAddToBag, args.onBookNow].map((press) => (press as ReturnType<typeof fn>).mock.calls.length)).toEqual([1, 1])
    const notes = canvas.getByText(/^Guests’ details are added at checkout\./)
    await expect(notes).toHaveTextContent('Cancel more than 24 hours before the session for store credit.')
    // 12px under the last card, and 12px in each side, level with the cards' own words.
    await expect([Math.round(box(notes).top - box(total).bottom), getComputedStyle(notes).paddingLeft, getComputedStyle(notes).paddingRight]).toEqual([12, '12px', '12px'])
  },
}

/**
 * Scenario=Non Member - User & 1 guest + add-ons, 388px tall: "2 People" with the session's price for them, and
 * between the two cards the add-ons' own: "Add-Ons", then a line for each with how many and that line's figure.
 */
export const TwoPeopleWithAddOns: Story = {
  args: { summary: bookingSummary(chosen('public', 2), SAMPLE_ADD_ONS, { 'towel-one': 1, 'smoothie-knoll': 2 }) },
  play: async ({ canvas, canvasElement }) => {
    await expect(near(box(canvas.getByRole('region', { name: 'Your booking' })).height, 388, 16)).toBe(true)
    await expect(canvas.getByRole('heading', { name: 'Add-Ons' })).toBeVisible()
    await expect(lines(canvasElement)).toEqual(['2 People', '£30.00', 'One Towel Hire × 1', '£3.00', 'Smoothie High Brown Knoll × 2', '£12.00', 'Total to pay', '£45.00'])
  },
}

/** Scenario=Private - 4 people: "60 min - Private", and the people's line says whose price it is. */
export const PrivateFourPeople: Story = {
  args: { summary: bookingSummary(chosen('private', 4), SAMPLE_ADD_ONS, {}) },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByText('60 min - Private')).toBeVisible()
    await expect(lines(canvasElement)).toEqual(['4 People - Group price for 1 to 6', '£105.00', 'Total to pay', '£105.00'])
  },
}

/** Scenario=Non Member - Long add-on list: every add-on chosen has its line, each figure at the right, and the total is all of them. */
export const LongAddOnList: Story = {
  args: { summary: bookingSummary(chosen('public', 2), SAMPLE_ADD_ONS, { 'towel-one': 1, 'towel-two': 1, robe: 2, 'smoothie-knoll': 2, coffee: 1 }) },
  play: async ({ canvas, canvasElement }) => {
    await expect(lines(canvasElement).slice(-2)).toEqual(['Total to pay', '£67.50'])
    await expect(canvas.getByText('Cold Brew Coffee with Oat Milk and Vanilla Syrup, Large × 1')).toBeVisible()
    const figure = canvas.getByText('£4.50')
    await expect(canvas.getAllByText('£12.00').map((one) => Math.round(box(one).right))).toEqual([Math.round(box(figure).right), Math.round(box(figure).right)])
  },
}
