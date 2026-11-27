import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { expect, fn, userEvent } from 'storybook/test'

import { CLEAR, InBothModes, inEachMode, painted } from '@/components/ui/story-kit'

import { CalendarDay } from './CalendarDay'

// Figma "CalendarDay" (03 UI > Calendar, 577:2888): a story for each of Figma's four states, under Figma's name for it. It is
// the day the booking panel's calendar draws (components/components/booking/BookingCalendar.tsx), the same component, here alone.

const meta = {
  title: 'UI/Calendar/CalendarDay',
  component: CalendarDay,
  parameters: { padded: false },
  args: { day: '2026-11-01', state: 'default', tabStop: true, onChoose: fn() },
  render: (args) => (
    <InBothModes>
      <CalendarDay {...args} />
    </InBothModes>
  ),
} satisfies Meta<typeof CalendarDay>

export default meta
type Story = StoryObj<typeof meta>

const days = (canvasElement: HTMLElement) => inEachMode<HTMLButtonElement>(canvasElement, 'button[data-day]')

/** 12px round the day's number in Label 12 (Figma's 33px square), with 4px corners. */
const looks = async (canvasElement: HTMLElement, fill: string | null, words: string) => {
  const found = days(canvasElement)
  await expect(found).toHaveLength(2)
  for (const day of found) {
    const box = day.getBoundingClientRect()
    await expect(box.width).toBe(box.height)
    await expect(Math.round(box.width)).toBeGreaterThanOrEqual(32)
    await expect(Math.round(box.width)).toBeLessThanOrEqual(33)
    await expect([getComputedStyle(day).borderRadius, getComputedStyle(day).fontSize]).toEqual(['4px', '12px'])
    await expect(day).toHaveTextContent('1')
    await expect(getComputedStyle(day).backgroundColor).toBe(fill ? painted(day, fill) : CLEAR)
    await expect(getComputedStyle(day).color).toBe(painted(day, words, 'color'))
  }
}

/** A day that can be chosen: Text/Primary, nothing behind it. A press chooses it. */
export const Default: Story = {
  name: 'State=default',
  play: async ({ canvasElement, args }) => {
    await looks(canvasElement, null, 'text-text-primary')
    const [light] = days(canvasElement)
    await expect(light).toHaveAccessibleName('Sunday 1 November 2026')
    await userEvent.click(light!)
    await expect(args.onChoose).toHaveBeenCalledWith('2026-11-01')
  },
}

/** Under a mouse: Surface/Card Selected. */
export const Hover: Story = {
  name: 'State=hover',
  globals: { pseudo: 'hover' },
  play: async ({ canvasElement }) => looks(canvasElement, 'bg-surface-card-selected', 'text-text-primary'),
}

/** The day chosen: Surface/Secondary with Text/Secondary. */
export const Selected: Story = {
  name: 'State=selected',
  args: { state: 'selected' },
  play: async ({ canvasElement }) => {
    await looks(canvasElement, 'bg-surface-secondary', 'text-text-secondary')
    for (const day of days(canvasElement)) await expect(day.getAttribute('aria-pressed')).toBe('true')
  },
}

/** A day gone by (W78b, WQ78: never a day ahead, whether or not it has sessions): Text/Muted Primary; a press does nothing, and a mouse over it changes nothing (drawn here as under one). */
export const Past: Story = {
  name: 'State=past',
  args: { state: 'past' },
  globals: { pseudo: 'hover' },
  play: async ({ canvasElement, args }) => {
    await looks(canvasElement, null, 'text-text-muted-primary')
    const [light] = days(canvasElement)
    await expect(light!.getAttribute('aria-disabled')).toBe('true')
    await userEvent.click(light!)
    await expect(args.onChoose).not.toHaveBeenCalled()
  },
}
