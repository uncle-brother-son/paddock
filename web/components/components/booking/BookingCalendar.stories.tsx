import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { useState } from 'react'
import { expect, userEvent, waitFor } from 'storybook/test'

import { SAMPLE_MONTH, SAMPLE_TODAY } from '@/components/modules/booking/sample-book'

import { BookingCalendar } from './BookingCalendar'

/** The calendar with its month and its chosen day kept, as the panel keeps them. */
function Kept() {
  const [month, setMonth] = useState(SAMPLE_MONTH)
  const [chosen, setChosen] = useState<string | null>(SAMPLE_TODAY)
  return (
    // The sidebar on a desktop: 6 of the panel's columns.
    <div className="max-w-[340px]">
      <BookingCalendar month={month} today={SAMPLE_TODAY} chosen={chosen} firstMonth={SAMPLE_MONTH} lastMonth="2026-12" onMonth={setMonth} onChoose={setChosen} />
    </div>
  )
}

const meta = {
  title: 'Components/Booking/BookingCalendar',
  component: Kept,
  globals: { theme: 'dark' },
} satisfies Meta<typeof Kept>

export default meta
type Story = StoryObj<typeof meta>

const box = (element: Element) => element.getBoundingClientRect()
const round = (...numbers: number[]) => numbers.map((number) => Math.round(number))
/** Waits until the words' own font is in: a height that hangs on a line of capitals is measured in that font, not a stand-in's. */
const fontIn = async (words: Element) => {
  await document.fonts.ready
  await waitFor(() => expect(document.fonts.check(getComputedStyle(words).font)).toBe(true))
}
const NOV = (date: number) => `${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date(Date.UTC(2026, 10, date)).getUTCDay()]} ${date} November 2026`

/**
 * Figma "BookingCalendar" (1150:10981) with "CalendarDay" (577:2888): a Surface/Card card, 12px inside, 330px tall:
 * the month and its two arrows, 24px beneath the days of the week, then six weeks of 33px days, 6px apart, Monday
 * first. selected: Surface/Secondary with Text/Secondary; past (a day before today): Text/Muted Primary; default:
 * Text/Primary, with Surface/Card Selected under the pointer. W78b (WQ78): a day ahead with no sessions (the sample
 * month's 18th) is a day like any other, and can be chosen.
 */
export const November: Story = {
  play: async ({ canvas, canvasElement }) => {
    const card = canvasElement.querySelector('[data-book="calendar"]') as HTMLElement
    // Figma's 330 counts a line of capitals as 9px; here a line is a little under.
    await expect(Math.round(box(card).width)).toBe(340)
    await expect(Math.abs(box(card).height - 330)).toBeLessThan(3)
    await expect([getComputedStyle(card).paddingLeft, getComputedStyle(card).borderRadius]).toEqual(['12px', '4px'])
    await expect(canvas.getByRole('heading', { name: 'November 2026' })).toBeVisible()
    const [previous, next] = [canvas.getByRole('button', { name: 'Previous month' }), canvas.getByRole('button', { name: 'Next month' })]
    await expect(round(box(previous).width, box(previous).height, box(next).left - box(previous).right)).toEqual([25, 25, 8])
    // This month is the first the arrows go to.
    await expect(previous).toBeDisabled()
    await expect(next).toBeEnabled()

    const grid = canvas.getByRole('grid', { name: 'November 2026' })
    await expect(canvas.getAllByRole('columnheader').map((one) => [one.textContent, one.getAttribute('aria-label')])).toEqual([
      ['Mon', 'Monday'], ['Tue', 'Tuesday'], ['Wed', 'Wednesday'], ['Thu', 'Thursday'], ['Fri', 'Friday'], ['Sat', 'Saturday'], ['Sun', 'Sunday'],
    ])
    const days = [...grid.querySelectorAll<HTMLElement>('[data-day]')]
    await expect(days).toHaveLength(30)
    const [first, second, ninth] = [days[0]!, days[1]!, days[8]!]
    await fontIn(first)
    // The 1st is a Sunday: alone at the end of the first week, level with the card's inside edge.
    // The 2nd starts the second week and the 9th the third, 6px beneath it.
    await expect(round(box(card).right - box(first).right, box(second).left - box(card).left, box(ninth).top - box(second).bottom, box(ninth).left - box(second).left)).toEqual([12, 12, 6, 0])
    // A square: 12px round its number's capitals (Figma's 33, with the capitals counted as 9px).
    await expect(Math.abs(box(first).width - 33)).toBeLessThan(1)
    await expect(Math.abs(box(first).width - box(first).height)).toBeLessThan(0.1)
    const chosen = canvas.getByRole('button', { name: NOV(12) })
    const [past, none, open] = [canvas.getByRole('button', { name: NOV(11) }), canvas.getByRole('button', { name: NOV(18) }), canvas.getByRole('button', { name: NOV(13) })]
    await expect([chosen, past, none, open].map((day) => [day.getAttribute('aria-pressed'), day.getAttribute('aria-disabled')])).toEqual([['true', 'false'], ['false', 'true'], ['false', 'false'], ['false', 'false']])
    // A day with no sessions is drawn as any day ahead; only the days before today are muted.
    await expect(getComputedStyle(none).color).toBe(getComputedStyle(open).color)
    await expect(getComputedStyle(past).color).not.toBe(getComputedStyle(open).color)
    await expect(getComputedStyle(chosen).backgroundColor).not.toBe(getComputedStyle(open).backgroundColor)
    // A press on a past day chooses nothing; a press on a day ahead chooses it, with sessions or without.
    await userEvent.click(past)
    await expect(chosen).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(open)
    await expect([open.getAttribute('aria-pressed'), chosen.getAttribute('aria-pressed')]).toEqual(['true', 'false'])
    await userEvent.click(none)
    await expect([none.getAttribute('aria-pressed'), open.getAttribute('aria-pressed')]).toEqual(['true', 'false'])
  },
}

/**
 * The keyboard: Tab stops on one day, the chosen one, and the arrow keys move from it through every day of the
 * month, the ones that can't be chosen too: Left and Right a day, Up and Down a week, Home and End to the week's
 * ends, Page Down and Page Up a month. Moving past the month's end goes into the next month.
 */
export const ByKeyboard: Story = {
  play: async ({ canvas, canvasElement }) => {
    const day = (date: string) => canvasElement.querySelector(`[data-day="${date}"]`) as HTMLElement
    await expect([...canvasElement.querySelectorAll('[data-day][tabindex="0"]')].map((one) => (one as HTMLElement).dataset.day)).toEqual(['2026-11-12'])
    day('2026-11-12').focus()
    await userEvent.keyboard('{ArrowRight}')
    await expect(day('2026-11-13')).toHaveFocus()
    await userEvent.keyboard('{ArrowDown}')
    await expect(day('2026-11-20')).toHaveFocus()
    await userEvent.keyboard('{ArrowLeft}{ArrowLeft}')
    // The 18th has no sessions: it can be chosen as any day ahead can (WQ78).
    await expect(day('2026-11-18')).toHaveFocus()
    await expect(day('2026-11-18')).toHaveAttribute('aria-disabled', 'false')
    await userEvent.keyboard('{Enter}')
    await expect(day('2026-11-18')).toHaveAttribute('aria-pressed', 'true')
    // A day before today takes focus all the same, says it can't be chosen, and a press does nothing.
    day('2026-11-11').focus()
    await expect(day('2026-11-11')).toHaveAttribute('aria-disabled', 'true')
    await userEvent.keyboard('{Enter}')
    await expect(day('2026-11-18')).toHaveAttribute('aria-pressed', 'true')
    day('2026-11-18').focus()
    await userEvent.keyboard('{Home}')
    await expect(day('2026-11-16')).toHaveFocus()
    await userEvent.keyboard('{End}')
    await expect(day('2026-11-22')).toHaveFocus()
    await userEvent.keyboard('{ArrowUp}')
    await expect(day('2026-11-15')).toHaveFocus()
    // The day the keyboard is on is now the one Tab stop.
    await expect([...canvasElement.querySelectorAll('[data-day][tabindex="0"]')].map((one) => (one as HTMLElement).dataset.day)).toEqual(['2026-11-15'])
    await userEvent.keyboard(' ')
    await expect(day('2026-11-15')).toHaveAttribute('aria-pressed', 'true')

    // Past the 30th is December, which the arrows may go to; December is the last, so Page Down there does nothing.
    day('2026-11-30').focus()
    await userEvent.keyboard('{ArrowRight}')
    await waitFor(() => expect(day('2026-12-01')).toHaveFocus())
    await expect(canvas.getByRole('heading', { name: 'December 2026' })).toBeVisible()
    await expect(canvas.getByRole('button', { name: 'Next month' })).toBeDisabled()
    await userEvent.keyboard('{PageDown}')
    await expect(day('2026-12-01')).toHaveFocus()
    await userEvent.keyboard('{PageUp}')
    await waitFor(() => expect(day('2026-11-01')).toHaveFocus())
    // Before this month there is nothing: Left on the 1st stays.
    await userEvent.keyboard('{ArrowLeft}')
    await expect(day('2026-11-01')).toHaveFocus()
  },
}
