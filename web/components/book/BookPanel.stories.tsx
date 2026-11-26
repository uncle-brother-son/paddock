import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { useMemo, useState } from 'react'
import { expect, userEvent, waitFor, within } from 'storybook/test'

import { Button } from '@/components/ui/Button'
import { OverlayTexture } from '@/components/ui/Overlay'

import { BookPanel } from './BookPanel'
import { SAMPLE_ADD_ONS, SAMPLE_TODAY, sampleNoSessions, sampleReads, sampleSessionsWithFull } from './sample-book'

type Day = 'available' | 'full' | 'loading' | 'none'

/** The panel over a page, opened as a visitor opens it and closed by its own Close; its three reads are answered by the samples. */
function Opened({ day = 'available', addOns = true }: { day?: Day; addOns?: boolean }) {
  const [open, setOpen] = useState(true)
  const reads = useMemo(
    () => sampleReads(day === 'loading' ? { sessions: 'never' } : day === 'none' ? { sessions: sampleNoSessions } : day === 'full' ? { sessions: sampleSessionsWithFull } : {}),
    [day],
  )
  return (
    <>
      <OverlayTexture />
      <div className="flex min-h-dvh items-start p-16">
        <Button onClick={() => setOpen(true)}>Book</Button>
      </div>
      <BookPanel open={open} onClose={() => setOpen(false)} addOns={addOns ? SAMPLE_ADD_ONS : []} reads={reads} today={SAMPLE_TODAY} />
    </>
  )
}

const meta = {
  title: 'Book/Panel',
  component: Opened,
  parameters: { padded: false, layout: 'fullscreen', nextjs: { appDirectory: true } },
  globals: { viewport: { value: 'desktop', isRotated: false } },
} satisfies Meta<typeof Opened>

export default meta
type Story = StoryObj<typeof meta>
type Play = NonNullable<Story['play']>

const box = (element: Element) => element.getBoundingClientRect()
const round = (...numbers: number[]) => numbers.map((number) => Math.round(number))
const part = (root: HTMLElement, name: string) => root.querySelector(`[data-book="${name}"]`) as HTMLElement
const rowsIn = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('[data-book="session"]')]
const wordsOf = (row: HTMLElement) => [...row.querySelectorAll('p')].map((words) => words.textContent)

/** The panel, once it has slid into its place and the day's sessions are in. */
const opened = async ({ canvasElement }: Parameters<Play>[0], rows = 5) => {
  const dialog = canvasElement.querySelector('[role="dialog"]') as HTMLElement
  await waitFor(() => expect(Math.round(box(dialog).top)).toBe(12), { timeout: 3000 })
  if (rows > 0) await waitFor(() => expect(dialog.querySelectorAll('[data-session-state]:not([data-session-state="loading"])')).toHaveLength(rows), { timeout: 3000 })
  return { dialog, panel: within(dialog) }
}

/**
 * Figma "BookingPanel", Step=sessions, View=public, Member=no, Day=available, Device=desktop (1174:13206; over a
 * page 931:10453): a Dark panel 12px inside every edge of the window, 80px down to the calendar (6 of its 24
 * columns, from the 2nd) and the day's heading (13 columns, from the 10th), with Close at its top right. It opens on
 * the first day with a session to book (WQ65): Thursday the 12th, chosen in the calendar.
 */
export const Public: Story = {
  play: async (context) => {
    const { dialog, panel } = await opened(context)
    await expect([dialog.getAttribute('aria-modal'), dialog.dataset.theme, dialog.getAttribute('aria-label')]).toEqual(['true', 'dark', 'Book'])
    await expect(round(box(dialog).left, window.innerWidth - box(dialog).right, window.innerHeight - box(dialog).bottom)).toEqual([12, 12, 12])
    await expect(getComputedStyle(dialog).borderRadius).toBe('4px')
    const close = panel.getByRole('button', { name: 'Close' })
    await expect(close).toHaveFocus()
    await expect(round(box(dialog).right - box(close).right, box(close).top - box(dialog).top)).toEqual([12, 12])

    // The two columns, on the panel's own grid: 16px margins, 8px gutters, 24 columns.
    const column = (box(dialog).width - 32 - 23 * 8) / 24
    const calendar = part(dialog, 'calendar')
    const sessions = part(dialog, 'sessions')
    await expect(round(box(calendar).left - box(dialog).left, box(calendar).width, box(calendar).top - box(dialog).top)).toEqual(round(16 + column + 8, column * 6 + 40, 80))
    await expect(round(box(sessions).left - box(dialog).left, box(sessions).width, box(sessions).top - box(dialog).top)).toEqual(round(16 + (column + 8) * 9, column * 13 + 96, 80))

    // The calendar: six weeks tall, the 12th chosen, the days before it muted. A day ahead with no sessions (the
    // 18th, the 25th) is a day like any other (WQ78).
    await expect(panel.getByRole('heading', { name: 'November 2026' })).toBeVisible()
    await expect(panel.getByRole('button', { name: 'Thursday 12 November 2026' })).toHaveAttribute('aria-pressed', 'true')
    await expect(panel.getByRole('button', { name: 'Wednesday 11 November 2026' })).toHaveAttribute('aria-disabled', 'true')
    for (const day of ['Friday 13 November 2026', 'Wednesday 18 November 2026', 'Wednesday 25 November 2026']) await expect(panel.getByRole('button', { name: day })).toHaveAttribute('aria-disabled', 'false')
    await expect(panel.getByRole('button', { name: 'Previous month' })).toBeDisabled()
    // The log-in bar, 12px beneath it.
    const account = part(dialog, 'account')
    await expect(Math.round(box(account).top - box(calendar).bottom)).toBe(12)
    await expect(within(account).getByText('Member? Log in to use your credits.')).toBeVisible()
    await expect(within(account).getByRole('button', { name: 'Log in' })).toBeVisible()

    // The day's heading with the toggle at its right; 12px beneath, the line; 32px beneath that, the sessions.
    const heading = panel.getByRole('heading', { name: 'Thursday 12 November' })
    const toggle = panel.getByRole('radiogroup', { name: 'Kind of session' })
    await expect(Math.round(box(sessions).right - box(toggle).right)).toBe(0)
    await expect(within(toggle).getByRole('radio', { name: 'Public' })).toBeChecked()
    const note = part(dialog, 'note')
    await expect([note.textContent, getComputedStyle(note).fontSize]).toEqual(['Public sessions are shared. Up to 6 guests per session.', '12px'])
    await expect(Math.round(box(note).top - box(toggle).bottom)).toBe(12)
    const rows = rowsIn(dialog)
    await expect(Math.round(box(rows[0]!).top - box(note).bottom)).toBe(32)
    await expect(Math.round(box(rows[1]!).top - box(rows[0]!).bottom)).toBe(12)
    await expect(wordsOf(rows[0]!)).toEqual(['08:00', '60 min', 'Contrast Therapy', 'Off-Peak', '£15', '3 Spots Left'])
    await expect(rows.map((row) => row.querySelector('time')?.textContent)).toEqual(['08:00', '09:15', '10:30', '11:30', '12:45'])
    await expect(box(heading).left).toBe(box(rows[0]!).left)

    // Esc shuts it, and focus goes back to what opened it; the page's own Book opens it again, on a fresh visit.
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(dialog).not.toBeVisible(), { timeout: 3000 })
    await userEvent.click(within(context.canvasElement).getByRole('button', { name: 'Book' }))
    await waitFor(() => expect(Math.round(box(dialog).top)).toBe(12), { timeout: 3000 })
    await waitFor(() => expect(rowsIn(dialog)).toHaveLength(5))
  },
}

/**
 * View=private 60 (1174:13247): Private chosen, "You have the whole venue. Up to 10 guests per session." in Copy 14,
 * the day's lengths as a second toggle 32px beneath it, and each session with its group's price and the group
 * beneath: "£105" over "1-6 People", and at 7 people "£120" over "7 People" (1174:13242).
 */
export const PrivateSixty: Story = {
  play: async (context) => {
    const { dialog, panel } = await opened(context)
    await userEvent.click(panel.getByRole('radio', { name: 'Private' }))
    const note = part(dialog, 'note')
    await expect([note.textContent, getComputedStyle(note).fontSize]).toEqual(['You have the whole venue. Up to 10 guests per session.', '14px'])
    const lengths = panel.getByRole('radiogroup', { name: 'Length of session' })
    await expect(within(lengths).getAllByRole('radio').map((one) => [one.parentElement?.textContent, (one as HTMLInputElement).checked])).toEqual([['60 min', true], ['120 min', false]])
    await expect(round(box(lengths).top - box(note).bottom, box(lengths).left - box(note).left)).toEqual([32, 0])
    const rows = rowsIn(dialog)
    await expect(rows).toHaveLength(5)
    await expect(Math.round(box(rows[0]!).top - box(lengths).bottom)).toBe(32)
    await expect(wordsOf(rows[0]!)).toEqual(['08:00', '60 min', 'Contrast Therapy', 'Private - Off-Peak', '£105', '1-6 People'])
    // The stepper goes from 1 to the most the session allows; the price is the group's the count falls in.
    const row = within(rows[1]!)
    const more = row.getByRole('button', { name: 'One more' })
    await expect(row.getByRole('button', { name: 'One fewer' })).toBeDisabled()
    for (let people = 2; people <= 6; people += 1) await userEvent.click(more)
    await expect(wordsOf(rows[1]!).slice(4)).toEqual(['£105', '1-6 People'])
    await userEvent.click(more)
    await expect(wordsOf(rows[1]!).slice(4)).toEqual(['£120', '7 People'])
    for (let people = 8; people <= 10; people += 1) await userEvent.click(more)
    await expect(wordsOf(rows[1]!).slice(4)).toEqual(['£165', '10 People'])
    await expect(more).toBeDisabled()
  },
}

/** View=private 120 (1174:13266): the second length chosen, its three sessions, "120 min" and "£210" over "1-6 People". */
export const PrivateOneTwenty: Story = {
  play: async (context) => {
    const { dialog, panel } = await opened(context)
    await userEvent.click(panel.getByRole('radio', { name: 'Private' }))
    await userEvent.click(panel.getByRole('radio', { name: '120 min' }))
    const rows = rowsIn(dialog)
    await expect(rows.map((row) => row.querySelector('time')?.textContent)).toEqual(['08:00', '10:30', '12:45'])
    await expect(wordsOf(rows[0]!)).toEqual(['08:00', '120 min', 'Contrast Therapy', 'Private - Off-Peak', '£210', '1-6 People'])
  },
}

/** Day=loading (1180:20590): the heading, the toggle and five loading rows on Surface/Card Disabled, each the size of a session's row. */
export const Loading: Story = {
  args: { day: 'loading' },
  play: async (context) => {
    const { dialog, panel } = await opened(context, 0)
    await waitFor(() => expect(panel.getByRole('heading', { name: 'Thursday 12 November' })).toBeVisible())
    const rows = rowsIn(dialog)
    await expect(rows.map((row) => [row.dataset.sessionState, row.closest('li')?.getAttribute('aria-hidden')])).toEqual(Array.from({ length: 5 }, () => ['loading', 'true']))
    await expect(round(box(rows[0]!).height, box(rows[1]!).top - box(rows[0]!).bottom)).toEqual([65, 12])
    await expect(panel.getByText('Loading sessions')).toBeInTheDocument()
    await expect(dialog.querySelector('[aria-busy="true"]')).not.toBeNull()
    // A bar for each of the row's words, and one for its buttons.
    await expect(rows[0]!.querySelectorAll('p')).toHaveLength(6)
    await expect(getComputedStyle(rows[0]!.querySelector('p')!).color).toMatch(/rgba\(0, 0, 0, 0\)|transparent/)
  },
}

/**
 * Day=none (1180:20451): in the list's place, 32px under the heading, a Surface/Card card saying so in Copy 12 and
 * Text/Primary; no line above it.
 */
export const NoSessions: Story = {
  args: { day: 'none' },
  play: async (context) => {
    const { dialog, panel } = await opened(context, 0)
    const card = await waitFor(() => panel.getByText('There are no sessions on this day. Choose another day.'))
    await expect(card.dataset.book).toBe('no-sessions')
    await expect(part(dialog, 'note')).toBeNull()
    const toggle = panel.getByRole('radiogroup', { name: 'Kind of session' })
    await expect(round(box(card).top - box(toggle).bottom, box(card).height)).toEqual([32, 25])
    await expect([getComputedStyle(card).paddingLeft, getComputedStyle(card).fontSize]).toEqual(['16px', '12px'])
    await expect(rowsIn(dialog)).toHaveLength(0)
  },
}

/**
 * W78b (WQ78): a day ahead with no sessions can be chosen, and says so where its sessions would be (Day=none); the
 * days before today can't. The panel still opens on the first day with a session to book (WQ65): the 12th. Choosing
 * the 18th, which has none, shows the card under the day's own heading; the 13th brings its sessions back; Private
 * on a day with none says the same.
 */
export const DayWithNoSessions: Story = {
  play: async (context) => {
    const { dialog, panel } = await opened(context)
    const day = (name: string) => panel.getByRole('button', { name })
    await expect(day('Thursday 12 November 2026')).toHaveAttribute('aria-pressed', 'true')
    const none = day('Wednesday 18 November 2026')
    await expect(getComputedStyle(none).color).toBe(getComputedStyle(day('Friday 13 November 2026')).color)
    await userEvent.click(none)
    await expect(none).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() => expect(panel.getByRole('heading', { name: 'Wednesday 18 November' })).toBeVisible())
    const card = await waitFor(() => panel.getByText('There are no sessions on this day. Choose another day.'))
    await expect([card.getAttribute('role'), card.dataset.book]).toEqual(['status', 'no-sessions'])
    await expect(rowsIn(dialog)).toHaveLength(0)
    await expect(part(dialog, 'note')).toBeNull()
    await userEvent.click(panel.getByRole('radio', { name: 'Private' }))
    await expect(panel.getByText('There are no sessions on this day. Choose another day.')).toBeVisible()
    await expect(panel.queryByRole('radiogroup', { name: 'Length of session' })).toBeNull()
    await userEvent.click(panel.getByRole('radio', { name: 'Public' }))

    // A day gone by takes no press: the 18th stays chosen.
    await userEvent.click(day('Wednesday 11 November 2026'))
    await expect(none).toHaveAttribute('aria-pressed', 'true')
    // A day with sessions brings them back.
    await userEvent.click(day('Friday 13 November 2026'))
    await waitFor(() => expect(rowsIn(dialog)).toHaveLength(5))
    await expect(panel.queryByText('There are no sessions on this day. Choose another day.')).toBeNull()
  },
}

/**
 * A day with a full session (Figma "SessionRow", State=Full, 1180:19887; no panel variant draws one in a list): the
 * 09:15 row on Surface/Card Disabled, "Fully booked" under its price, and a disabled "Full" where its stepper and
 * Book would be, its right edge level with the other rows' Book.
 */
export const FullSession: Story = {
  args: { day: 'full' },
  play: async (context) => {
    const { dialog } = await opened(context)
    const rows = rowsIn(dialog)
    await expect(rows.map((row) => row.dataset.sessionState)).toEqual(['bookable', 'full', 'bookable', 'bookable', 'bookable'])
    const full = within(rows[1]!)
    await expect(wordsOf(rows[1]!)).toEqual(['09:15', '60 min', 'Contrast Therapy', 'Off-Peak', '£15', 'Fully booked'])
    const button = full.getByRole('button', { name: 'Full' })
    await expect(button).toBeDisabled()
    await expect(full.queryByRole('group')).toBeNull()
    const book = within(rows[0]!).getByRole('button', { name: 'Book 08:00' })
    await expect(round(box(button).right, box(button).height, box(rows[1]!).height)).toEqual(round(box(book).right, box(book).height, box(rows[0]!).height))
    await expect(getComputedStyle(rows[1]!).backgroundColor).not.toBe(getComputedStyle(rows[0]!).backgroundColor)
    // The price's column is where every other row's is.
    await expect(Math.round(box(full.getByText('£15')).left)).toBe(Math.round(box(within(rows[0]!).getByText('£15')).left))
  },
}

/**
 * Step=add-ons (1174:13322, with BookingSummary's non-member scenarios): after Book, "Add ons" over the cards, three
 * to a row (12 columns, from the 2nd), and "Your booking" (7 columns, from the 16th). An add-on added shows its
 * stepper, has its line in the summary and is in the total; Change goes back with the day and the people kept.
 */
export const AddOns: Story = {
  play: async (context) => {
    const { dialog, panel } = await opened(context)
    const first = within(rowsIn(dialog)[0]!)
    await userEvent.click(first.getByRole('button', { name: 'One more' }))
    await userEvent.click(first.getByRole('button', { name: 'Book 08:00' }))
    const summary = await waitFor(() => panel.getByRole('region', { name: 'Your booking' }))
    await waitFor(() => expect(within(summary).getByRole('heading', { name: 'Your Booking' })).toHaveFocus())

    const column = (box(dialog).width - 32 - 23 * 8) / 24
    const addOns = panel.getByRole('region', { name: 'Add ons' })
    const cards = [...addOns.querySelectorAll<HTMLElement>('[data-book="add-on"]')]
    await expect(cards).toHaveLength(6)
    await expect(round(box(cards[0]!).left - box(dialog).left, box(cards[0]!).width, box(cards[1]!).left - box(cards[0]!).right, box(cards[3]!).top - box(cards[0]!).bottom)).toEqual(round(16 + column + 8, (column * 12 + 88 - 8) / 3, 4, 40))
    await expect(round(box(summary).left - box(dialog).left, box(summary).width, box(summary).top - box(dialog).top)).toEqual(round(16 + (column + 8) * 15, column * 7 + 48, 80))

    const words = (root: HTMLElement) => [...root.querySelectorAll('dt, dd')].map((one) => one.textContent)
    await expect(within(summary).getByText('Contrast Therapy')).toBeVisible()
    await expect(within(summary).getByText('08:00 - Thursday 12 November')).toBeVisible()
    await expect(within(summary).getByText('60 min - Public - Off-Peak')).toBeVisible()
    await expect(words(summary)).toEqual(['2 People', '£30.00', 'Total to pay', '£30.00'])

    // Add one towel hire, then a second; and a coffee, which has no picture.
    await userEvent.click(panel.getByRole('button', { name: 'Add One Towel Hire' }))
    const towels = within(cards[0]!)
    await waitFor(() => expect(towels.getByRole('button', { name: 'One more' })).toHaveFocus())
    await userEvent.click(towels.getByRole('button', { name: 'One more' }))
    await userEvent.click(panel.getByRole('button', { name: 'Add Cold Brew Coffee with Oat Milk and Vanilla Syrup, Large' }))
    await expect(words(summary)).toEqual(['2 People', '£30.00', 'One Towel Hire × 2', '£6.00', 'Cold Brew Coffee with Oat Milk and Vanilla Syrup, Large × 1', '£4.50', 'Total to pay', '£40.50'])
    await expect(within(summary).getByRole('heading', { name: 'Add-Ons' })).toBeVisible()
    await expect(cards[5]!.querySelector('img')).toBeNull()
    await expect(cards[0]!.querySelector('img')).not.toBeNull()

    // Add to bag and Book now, side by side; the two notes beneath.
    const [add, now] = [within(summary).getByRole('button', { name: 'Add to bag' }), within(summary).getByRole('button', { name: 'Book now' })]
    await expect(round(box(now).left - box(add).right, box(add).width - box(now).width, box(add).height)).toEqual([12, 0, 33])
    await expect(within(summary).getByText(/^Guests’ details are added at checkout\./)).toHaveTextContent('Cancel more than 24 hours before the session for store credit.')

    // Change: back to the sessions, the 12th still chosen and the stepper still on 2.
    await userEvent.click(within(summary).getByRole('button', { name: 'Change the session' }))
    await waitFor(() => expect(rowsIn(dialog)).toHaveLength(5))
    await expect(panel.getByRole('button', { name: 'Thursday 12 November 2026' })).toHaveAttribute('aria-pressed', 'true')
    const again = within(rowsIn(dialog)[0]!)
    await expect(again.getByRole('status')).toHaveTextContent('2')
    await waitFor(() => expect(again.getByRole('button', { name: 'Book 08:00' })).toHaveFocus())
  },
}

/**
 * Device=mobile (1176:17691; over a page 1576:62766): 12px inside every edge, 64px down to the calendar, Close 24px
 * down and 16px in; one column, the calendar and the log-in bar, then 32px beneath the heading with the toggle
 * under it, the line and the sessions, each row its three lines of words over a full-width stepper and Book.
 */
export const Mobile: Story = {
  globals: { viewport: { value: 'mobile', isRotated: false } },
  play: async (context) => {
    const { dialog, panel } = await opened(context)
    await expect(round(box(dialog).left, box(dialog).top, window.innerWidth - box(dialog).right, window.innerHeight - box(dialog).bottom)).toEqual([12, 12, 12, 12])
    const close = panel.getByRole('button', { name: 'Close' })
    await expect(round(box(dialog).right - box(close).right, box(close).top - box(dialog).top)).toEqual([16, 24])
    const calendar = part(dialog, 'calendar')
    const account = part(dialog, 'account')
    const sessions = part(dialog, 'sessions')
    await expect(round(box(calendar).left - box(dialog).left, box(dialog).right - box(calendar).right, box(calendar).top - box(dialog).top)).toEqual([16, 16, 64])
    await expect(round(box(account).top - box(calendar).bottom, box(sessions).top - box(account).bottom)).toEqual([12, 32])
    const heading = panel.getByRole('heading', { name: 'Thursday 12 November' })
    const toggle = panel.getByRole('radiogroup', { name: 'Kind of session' })
    await expect(round(box(toggle).top - box(heading).bottom, box(toggle).left - box(heading).left)).toEqual([16, 0])
    const note = part(dialog, 'note')
    await expect(Math.round(box(note).top - box(toggle).bottom)).toBe(32)
    const row = rowsIn(dialog)[0]!
    const stepper = within(row).getByRole('group', { name: 'Number of people, 08:00' })
    const book = within(row).getByRole('button', { name: 'Book 08:00' })
    await expect(round(box(stepper).width, box(book).width, box(book).top - box(stepper).bottom)).toEqual(round(box(row).width - 32, box(row).width - 32, 8))
    // Figma's 165 counts each of its lines of capitals as 9px; here a line is a little under.
    await expect(Math.abs(box(row).height - 165)).toBeLessThan(4)
    // The whole column scrolls inside the panel; Close stays put.
    const scroller = dialog.querySelector('[data-book-step]') as HTMLElement
    await expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight)
    scroller.scrollTop = 200
    await expect(Math.round(box(close).top - box(dialog).top)).toBe(24)
  },
}
