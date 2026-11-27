import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { useMemo } from 'react'
import { expect, userEvent, waitFor, within } from 'storybook/test'

import { OverlayTexture } from '@/components/ui/media/Overlay'
import type { BookingQuote } from '@/lib/book/api'

import { BookingPanel } from './BookingPanel'
import { misfitsIn } from './fits'
import { SAMPLE_ADD_ONS, SAMPLE_TODAY, sampleDays, sampleLongSessions, sampleNoSessions, sampleQuote, sampleReads } from './sample-book'

/** What a group pays for one of the long day's public sessions (£165 each), as booking-quote answers; a private one is the sample's. */
const longQuote = (session: string, people: number): BookingQuote =>
  session.startsWith('private') ? sampleQuote(session, people) : { session, people, reason: null, mostPeople: 10, total: `${165 * people}.00`, lines: [] }

/** The panel open over an empty page, on a day whose words are as long as the site's can be; the 18th and the 25th have no sessions. */
function Opened() {
  const reads = useMemo(
    () => sampleReads({ sessions: (date) => (sampleDays(date.slice(0, 7)).publicDays.includes(date) ? sampleLongSessions(date) : sampleNoSessions(date)), quote: longQuote }),
    [],
  )
  return (
    <>
      <OverlayTexture />
      <div className="min-h-dvh" />
      <BookingPanel open onClose={() => undefined} addOns={SAMPLE_ADD_ONS} reads={reads} today={SAMPLE_TODAY} />
    </>
  )
}

/**
 * W78b (WQ78): the booking panel at every width from a 320px phone to a wide desktop. Figma draws it at 390 and at 1440;
 * between and beyond those it keeps the drawn sizes of its parts and wraps or stacks them, and at no width does
 * anything overlap or get cut off. Each story here is one width: it walks the panel through its states with long
 * words in it (a long service name, a three-figure price, "10 Spots Left", a full session, private groups, a day with
 * no sessions, the add-ons step with add-ons chosen) and at each asks `misfitsIn` (fits.ts) for anything out of its
 * place. The same measure is run on the real panel (staff app repo, briefs/W78b-logs/tools/book-widths.cjs).
 */
const meta = {
  title: 'Modules/Booking/BookingPanel at every width',
  component: Opened,
  parameters: { padded: false, layout: 'fullscreen', nextjs: { appDirectory: true } },
} satisfies Meta<typeof Opened>

export default meta
type Story = StoryObj<typeof meta>
type Play = NonNullable<Story['play']>

const box = (element: Element) => element.getBoundingClientRect()
const rowsIn = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('[data-session-state]:not([data-session-state="loading"])')]

/** Everything out of its place in the panel as it now stands, read with what scrolls at its top (Close stays put over what scrolls beneath it). */
const misfits = (dialog: HTMLElement): string[] => {
  for (const scrolled of dialog.querySelectorAll('*')) if (scrolled.scrollTop > 0) scrolled.scrollTop = 0
  return misfitsIn(dialog)
}

/** The walk through the panel at one width; it ends on the add-ons step, where the accessibility check then runs. */
const fitsAt =
  (width: number): Play =>
  async ({ canvasElement }) => {
    await expect(window.innerWidth).toBe(width)
    const dialog = canvasElement.querySelector('[role="dialog"]') as HTMLElement
    const panel = within(dialog)
    await waitFor(() => expect(Math.round(box(dialog).top)).toBe(12), { timeout: 3000 })
    await waitFor(() => expect(rowsIn(dialog)).toHaveLength(3), { timeout: 3000 })
    await document.fonts.ready
    await waitFor(() => expect(document.fonts.check(getComputedStyle(rowsIn(dialog)[0]!.querySelector('p')!).font)).toBe(true))

    // Each state's misfits, by the state's name; only a state with something wrong is noted.
    const wrong: Record<string, string[]> = {}
    const look = (state: string) => {
      const found = misfits(dialog)
      if (found.length > 0) wrong[state] = found
    }

    look('public sessions')
    // The stepper at its widest number.
    const more = within(rowsIn(dialog)[0]!).getByRole('button', { name: 'One more' })
    for (let people = 2; people <= 10; people += 1) await userEvent.click(more)
    await expect(within(rowsIn(dialog)[0]!).getByRole('status')).toHaveTextContent('10')
    look('public sessions, 10 people')

    await userEvent.click(panel.getByRole('radio', { name: 'Private' }))
    await waitFor(() => expect(rowsIn(dialog)).toHaveLength(2))
    const morePrivate = within(rowsIn(dialog)[0]!).getByRole('button', { name: 'One more' })
    for (let people = 2; people <= 10; people += 1) await userEvent.click(morePrivate)
    await expect(rowsIn(dialog)[0]!).toHaveTextContent('10 People')
    look('private sessions, 60 min')
    await userEvent.click(panel.getByRole('radio', { name: '120 min' }))
    await waitFor(() => expect(rowsIn(dialog)).toHaveLength(1))
    look('private sessions, 120 min')

    // A day with no sessions (WQ78: it can be chosen), in Private and in Public.
    await userEvent.click(panel.getByRole('button', { name: 'Wednesday 18 November 2026' }))
    await waitFor(() => expect(panel.getByText('There are no sessions on this day. Choose another day.')).toBeVisible())
    look('a day with no sessions')
    await userEvent.click(panel.getByRole('radio', { name: 'Public' }))
    await userEvent.click(panel.getByRole('button', { name: 'Thursday 12 November 2026' }))
    await waitFor(() => expect(rowsIn(dialog)).toHaveLength(3))

    // The add-ons step, with two add-ons chosen: one twice, and the one with the longest name.
    await userEvent.click(within(rowsIn(dialog)[0]!).getByRole('button', { name: 'Book 08:00' }))
    const summary = await waitFor(() => panel.getByRole('region', { name: 'Your booking' }))
    look('add-ons, none chosen')
    await userEvent.click(panel.getByRole('button', { name: 'Add One Towel Hire' }))
    await waitFor(() => expect(within(panel.getByRole('region', { name: 'Add ons' })).getAllByRole('button', { name: 'One more' })).toHaveLength(1))
    await userEvent.click(within(panel.getByRole('region', { name: 'Add ons' })).getByRole('button', { name: 'One more' }))
    await userEvent.click(panel.getByRole('button', { name: 'Add Cold Brew Coffee with Oat Milk and Vanilla Syrup, Large' }))
    // Ten people at £165, two towel hires at £3 and a coffee at £4.50.
    await expect(within(summary).getByText('£1660.50')).toBeVisible()
    look('add-ons, two chosen')

    await expect(wrong).toEqual({})
  }

// Each story is written out in full: Storybook reads a story's own lines for its index.

/** The narrowest phone the site is built for. */
export const Width320: Story = {
  globals: { viewport: { value: 'w320', isRotated: false } },
  play: fitsAt(320),
}

/** Figma's phone frame. */
export const Width390: Story = {
  globals: { viewport: { value: 'mobile', isRotated: false } },
  play: fitsAt(390),
}

/** Where the Mobile values give way to the Desktop ones: the two columns side by side at their narrowest. */
export const Width768: Story = {
  globals: { viewport: { value: 'tablet', isRotated: false } },
  play: fitsAt(768),
}

export const Width1024: Story = {
  globals: { viewport: { value: 'w1024', isRotated: false } },
  play: fitsAt(1024),
}

export const Width1280: Story = {
  globals: { viewport: { value: 'w1280', isRotated: false } },
  play: fitsAt(1280),
}

/** Figma's desktop frame. */
export const Width1440: Story = {
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: fitsAt(1440),
}

export const Width1920: Story = {
  globals: { viewport: { value: 'w1920', isRotated: false } },
  play: fitsAt(1920),
}
