import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { expect, userEvent, waitFor } from 'storybook/test'

import { OverlayTexture } from '@/components/ui/Overlay'

import { FrameShell } from './FrameShell'
import { EMPTY_FRAME, SAMPLE_FRAME, SamplePage } from './sample-content'

const meta = {
  title: 'Frame/Whole page',
  component: FrameShell,
  parameters: { padded: false, layout: 'fullscreen', nextjs: { appDirectory: true } },
  args: { variant: 'global', content: SAMPLE_FRAME, children: <SamplePage /> },
  // As the root layout does: the Overlay's texture filter, once for the page.
  decorators: [
    (Story) => (
      <>
        <OverlayTexture />
        <Story />
      </>
    ),
  ],
} satisfies Meta<typeof FrameShell>

export default meta
type Story = StoryObj<typeof meta>

/** The frame round a stand-in page, as the root layout puts it round every page: the header over the top, <main>, the footer. */
export const Global: Story = {
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    const main = canvasElement.querySelector('#main') as HTMLElement
    await expect(canvas.getByRole('main')).toBe(main)
    await expect(canvas.getByRole('banner')).toBeVisible()
    await expect(canvas.getByRole('contentinfo')).toBeInTheDocument()
    // One id, however many logos: none is used twice on the page.
    const ids = [...canvasElement.querySelectorAll('[id]')].map((element) => element.id)
    await expect(new Set(ids).size).toBe(ids.length)
  },
}

/** The same on a phone. */
export const GlobalOnAPhone: Story = {
  name: 'Global, on a phone',
  globals: { viewport: { value: 'mobile', isRotated: false } },
  play: async () => {
    await expect(document.documentElement.scrollWidth).toBe(document.documentElement.clientWidth)
  },
}

/** The checkout's frame: its own header and footer (a prop until the checkout route exists). */
export const Checkout: Story = {
  args: { variant: 'checkout' },
  globals: { viewport: { value: 'desktop', isRotated: false } },
}

/**
 * "Skip to content" (WQ13): press Tab once on any page and it shows top left as the small primary Button, with the
 * focus ring. Enter takes the keyboard to <main>.
 */
export const SkipToContent: Story = {
  name: 'Skip to content',
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    const skip = canvas.getByRole('link', { name: 'Skip to content' })
    await expect(getComputedStyle(skip).opacity).toBe('0')
    await userEvent.tab()
    await expect(skip).toHaveFocus()
    await waitFor(() => expect(getComputedStyle(skip).opacity).toBe('1'))
    const box = skip.getBoundingClientRect()
    // Figma's small Button is 33px tall: 12px above and below Label 12's capitals.
    await expect([box.left, box.top, Math.round(box.height)]).toEqual([16, 16, 33])
    await expect([getComputedStyle(skip).outlineStyle, getComputedStyle(skip).outlineWidth, getComputedStyle(skip).outlineOffset]).toEqual(['solid', '2px', '2px'])
    await userEvent.keyboard('{Enter}')
    await expect(canvasElement.querySelector('#main')).toHaveFocus()
    // The next Tab goes on into the page, not back to the header.
    await expect(getComputedStyle(skip).opacity).toBe('0')
  },
}

/** With nothing in Sanity yet the frame still stands: the logo, the Menu button over an empty menu, a footer with no links. */
export const NothingInSanityYet: Story = {
  name: 'Nothing in Sanity yet',
  args: { content: EMPTY_FRAME },
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('button', { name: 'Menu' })).toBeVisible()
    await expect(canvas.getByRole('contentinfo')).toBeInTheDocument()
    await expect(canvas.getByRole('link', { name: 'The Paddock Wellness Club' })).toBeVisible()
  },
}
