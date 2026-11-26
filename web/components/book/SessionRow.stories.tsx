import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { useState } from 'react'
import { expect, userEvent, within } from 'storybook/test'

import type { PrivateSession, PublicSession } from '@/lib/book/api'

import { samplePrivate, samplePublic, SAMPLE_TODAY } from './sample-book'
import { SessionRow, SessionRowLoading } from './SessionRow'

/** A row with its stepper kept, in a list as the panel holds it; `loading` draws the loading row in its place. */
function Kept({ session, loading = false }: { session: PublicSession | PrivateSession; loading?: boolean }) {
  const [people, setPeople] = useState(1)
  return (
    // The sessions column on a desktop: 13 of the panel's columns.
    <ul className="max-w-[746px]">{loading ? <SessionRowLoading /> : <SessionRow session={session} people={people} onPeople={setPeople} onBook={() => undefined} />}</ul>
  )
}

const meta = {
  title: 'Book/SessionRow',
  component: Kept,
  args: { session: samplePublic(SAMPLE_TODAY, '08:00') },
  globals: { theme: 'dark', viewport: { value: 'desktop', isRotated: false } },
} satisfies Meta<typeof Kept>

export default meta
type Story = StoryObj<typeof meta>

const box = (element: Element) => element.getBoundingClientRect()
const round = (...numbers: number[]) => numbers.map((number) => Math.round(number))
const rowIn = (canvasElement: HTMLElement) => canvasElement.querySelector('[data-book="session"]') as HTMLElement
const MOBILE = { theme: 'dark', viewport: { value: 'mobile', isRotated: false } }
/** A height Figma gives with each line of capitals counted as 9px: here a line is a little under 9, so a few lines come to a pixel or two less. */
const near = (height: number, figma: number, lines: number) => height <= figma + 0.5 && height >= figma - lines

/**
 * Figma "SessionRow", State=Non Member, Device=desktop (784:5620): Surface/Card, 16px inside, 65px tall: the time
 * over its length (a 100px column), the service over its band, the price over the spots left (a 160px column), then
 * the stepper and Book, 8px apart, each 33px tall. The stepper's minus is dimmed at 1.
 */
export const NonMember: Story = {
  play: async ({ canvas, canvasElement }) => {
    const row = rowIn(canvasElement)
    await expect(round(box(row).height, box(row).width)).toEqual([65, 746])
    await expect([getComputedStyle(row).paddingLeft, getComputedStyle(row).borderRadius]).toEqual(['16px', '4px'])
    const [time, length, service, band, price, spots] = [...row.querySelectorAll<HTMLElement>('p')] as [HTMLElement, HTMLElement, HTMLElement, HTMLElement, HTMLElement, HTMLElement]
    await expect([time, length, service, band, price, spots].map((words) => words.textContent)).toEqual(['08:00', '60 min', 'Contrast Therapy', 'Off-Peak', '£15', '3 Spots Left'])
    await expect([getComputedStyle(time).textTransform, getComputedStyle(time).fontWeight, getComputedStyle(length).fontWeight, getComputedStyle(length).fontSize]).toEqual(['uppercase', '500', '400', '12px'])
    await expect(round(box(length).top - box(time).bottom, box(service).left - box(time).left, box(spots).left - box(price).left)).toEqual([8, 100, 0])
    const stepper = canvas.getByRole('group', { name: 'Number of people, 08:00' })
    const book = canvas.getByRole('button', { name: 'Book 08:00' })
    await expect(round(box(book).left - box(stepper).right, box(stepper).height, box(book).height, box(row).right - box(book).right, box(stepper).left - box(price).left)).toEqual([8, 33, 33, 16, 160])
    // From 1 to the most the session allows (3 spots left): minus is dimmed and does nothing at 1, plus at 3.
    const [fewer, more] = [canvas.getByRole('button', { name: 'One fewer' }), canvas.getByRole('button', { name: 'One more' })]
    await expect(fewer).toBeDisabled()
    await expect(getComputedStyle(fewer).color).not.toBe(getComputedStyle(more).color)
    await userEvent.click(more)
    await userEvent.click(more)
    await expect(canvas.getByRole('status')).toHaveTextContent('3')
    await expect(more).toBeDisabled()
    await expect(fewer).toBeEnabled()
  },
}

/** A private session (1174:13247): "Private - Off-Peak" under the service, and the group's price over the group: "£105", "1-6 People". */
export const Private: Story = {
  args: { session: samplePrivate(SAMPLE_TODAY, '08:00', 60) },
  play: async ({ canvasElement }) => {
    const row = rowIn(canvasElement)
    await expect([...row.querySelectorAll('p')].map((words) => words.textContent)).toEqual(['08:00', '60 min', 'Contrast Therapy', 'Private - Off-Peak', '£105', '1-6 People'])
    await expect(Math.round(box(row).height)).toBe(65)
  },
}

/** State=Full (1180:19887): Surface/Card Disabled, "Fully booked", and a disabled "Full" at the right in the buttons' place. */
export const Full: Story = {
  args: { session: samplePublic(SAMPLE_TODAY, '08:00', { state: 'full', spotsLeft: 0, mostPeople: 0 }) },
  play: async ({ canvas, canvasElement }) => {
    const row = rowIn(canvasElement)
    await expect([...row.querySelectorAll('p')].map((words) => words.textContent)).toEqual(['08:00', '60 min', 'Contrast Therapy', 'Off-Peak', '£15', 'Fully booked'])
    const full = canvas.getByRole('button', { name: 'Full' })
    await expect(full).toBeDisabled()
    await expect(round(box(row).height, box(full).height, box(row).right - box(full).right)).toEqual([65, 33, 16])
    await expect(canvas.queryByRole('button', { name: /Book/ })).toBeNull()
  },
}

/** State=Loading (1180:19912): Surface/Card Disabled with a bar for each of the row's words and one for its buttons; nothing to a screen reader. */
export const Loading: Story = {
  args: { loading: true },
  play: async ({ canvasElement }) => {
    const row = rowIn(canvasElement)
    await expect([row.closest('li')?.getAttribute('aria-hidden'), Math.round(box(row).height)]).toEqual(['true', 65])
    const bars = [...row.querySelectorAll('p')]
    await expect(bars).toHaveLength(6)
    // Each bar is as tall as its words' capitals (Figma: 9px), with 2px corners.
    for (const bar of bars) await expect([Math.round(box(bar).height), getComputedStyle(bar).borderRadius]).toEqual([9, '2px'])
    await expect(within(row).queryByRole('button')).toBeNull()
  },
}

/**
 * Device=mobile (1176:17313): 165px tall: three lines of words, 8px apart, the first of each taking the room and the
 * second at the right; 16px beneath, the stepper and Book, 8px apart, each the row's whole width.
 */
export const NonMemberMobile: Story = {
  globals: MOBILE,
  play: async ({ canvas, canvasElement }) => {
    const row = rowIn(canvasElement)
    await expect(near(box(row).height, 165, 4)).toBe(true)
    const [time, length, service] = [...row.querySelectorAll<HTMLElement>('p')] as [HTMLElement, HTMLElement, HTMLElement]
    await expect(round(box(time).left - box(row).left, box(row).right - box(length).right, box(service).top - box(time).bottom)).toEqual([16, 16, 8])
    const stepper = canvas.getByRole('group', { name: 'Number of people, 08:00' })
    const book = canvas.getByRole('button', { name: 'Book 08:00' })
    const inside = box(row).width - 32
    await expect(round(box(stepper).width, box(book).width, box(book).top - box(stepper).bottom, box(stepper).height, box(book).height)).toEqual(round(inside, inside, 8, 33, 33))
  },
}

/** State=Full, Device=mobile (1180:19941): 124px tall, with "Full" the row's whole width. */
export const FullMobile: Story = {
  args: Full.args,
  globals: MOBILE,
  play: async ({ canvas, canvasElement }) => {
    const row = rowIn(canvasElement)
    const full = canvas.getByRole('button', { name: 'Full' })
    await expect(Math.round(box(full).width)).toBe(Math.round(box(row).width - 32))
    await expect(near(box(row).height, 124, 4)).toBe(true)
  },
}

/** State=Loading, Device=mobile (1180:19967): 124px tall, three lines of bars and one bar for the buttons. */
export const LoadingMobile: Story = {
  args: { loading: true },
  globals: MOBILE,
  play: async ({ canvasElement }) => {
    await expect(near(box(rowIn(canvasElement)).height, 124, 4)).toBe(true)
  },
}

/** A row in a list of the width given, whatever the window's: what the row answers to (W78b, WQ78). */
function InRoom({ width, session }: { width: number; session: PublicSession | PrivateSession }) {
  const [people, setPeople] = useState(1)
  return (
    <ul style={{ width }}>
      <SessionRow session={session} people={people} onPeople={setPeople} onBook={() => undefined} />
    </ul>
  )
}

/**
 * W78b (WQ78): the row answers to the room it has, not to the window. In the 1440 window: at 640px it is one line
 * (Device=desktop), every part on it and none over another; one pixel under, it is the stacked row (Device=mobile),
 * the stepper and Book each its whole width.
 */
export const ByItsOwnWidth: Story = {
  render: (args) => (
    <div className="flex flex-col gap-16">
      <InRoom width={640} session={args.session} />
      <InRoom width={639} session={args.session} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const [line, stacked] = [...canvasElement.querySelectorAll<HTMLElement>('[data-book="session"]')] as [HTMLElement, HTMLElement]
    await expect(Math.round(box(line).height)).toBe(65)
    const [, , service, , price] = [...line.querySelectorAll<HTMLElement>('p')] as [HTMLElement, HTMLElement, HTMLElement, HTMLElement, HTMLElement]
    const book = within(line).getByRole('button', { name: 'Book 08:00' })
    const stepper = within(line).getByRole('group', { name: 'Number of people, 08:00' })
    // The service's column is what is left: 137px, and "Contrast Therapy" is on one line in it, clear of the price.
    await expect(round(box(price).left - box(service).left, box(stepper).left - box(price).left, box(line).right - box(book).right)).toEqual([137, 160, 16])
    await expect(Math.round(box(service).height)).toBe(9)
    await expect(near(box(stacked).height, 165, 4)).toBe(true)
    const wide = within(stacked).getByRole('button', { name: 'Book 08:00' })
    await expect(Math.round(box(wide).width)).toBe(639 - 32)
  },
}
