import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { expect, userEvent, waitFor } from 'storybook/test'

import { LOGO_LABEL } from '@/components/brand/Logo'

import { Header } from './Header'
import { HeaderLogo } from './HeaderLogo'
import { SAMPLE_FRAME, SamplePage } from './sample-content'

const meta = {
  title: 'Frame/Header',
  component: Header,
  parameters: { padded: false, layout: 'fullscreen', nextjs: { appDirectory: true } },
  args: { variant: 'global', logo: <HeaderLogo animated />, menuLinks: SAMPLE_FRAME.menuLinks },
  render: (args) => (
    <>
      <Header {...args} />
      <main id="main" data-behind-popups="">
        <SamplePage />
      </main>
    </>
  ),
} satisfies Meta<typeof Header>

export default meta
type Story = StoryObj<typeof meta>

const headerIn = (canvasElement: HTMLElement) => canvasElement.querySelector('header') as HTMLElement

const scrollTo = async (top: number) => {
  window.scrollTo(0, top)
  await waitFor(() => expect(Math.round(window.scrollY)).toBe(top))
}

/**
 * Figma Header, Device=desktop, Type=global: the logo, then Menu at column 18 and Book, Account and Bag at the right.
 * Hover the logo and it opens out to the full name. The header is see-through; over the dark first section its
 * words are the Dark mode's.
 */
export const Global: Story = {
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole('link', { name: LOGO_LABEL })).toBeVisible()
    for (const name of ['Menu', 'Book', 'Account', 'Bag']) await expect(canvas.getByRole('button', { name })).toBeVisible()
    const header = headerIn(canvasElement)
    await waitFor(() => expect(header.dataset.theme).toBe('dark'))
    // Figma: 24px above and below a 25px row of buttons, and Menu starting at column 18 (1019px of 1440).
    await expect(Math.round(canvas.getByRole('button', { name: 'Menu' }).getBoundingClientRect().left)).toBe(1019)
    await expect(Math.round(canvas.getByRole('button', { name: 'Bag' }).getBoundingClientRect().right)).toBe(1424)
    await expect(getComputedStyle(header).backgroundColor).toBe('rgba(0, 0, 0, 0)')
  },
}

/** Figma Header, Device=mobile, Type=global: the wordmark, then Menu, Book and Bag. Account is in the menu. */
export const GlobalOnAPhone: Story = {
  name: 'Global, on a phone',
  globals: { viewport: { value: 'mobile', isRotated: false } },
  play: async ({ canvas }) => {
    for (const name of ['Menu', 'Book', 'Bag']) await expect(canvas.getByRole('button', { name })).toBeVisible()
    await expect(canvas.queryByRole('button', { name: 'Account' })).toBeNull()
    await expect(Math.round(canvas.getByRole('button', { name: 'Bag' }).getBoundingClientRect().right)).toBe(374)
  },
}

/** Figma Header, Type=checkout: the wordmark and Bag only, on grid columns 3 to 22. */
export const Checkout: Story = {
  args: { variant: 'checkout', logo: <HeaderLogo animated={false} /> },
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('button', { name: 'Bag' })).toBeVisible()
    await expect(canvas.queryByRole('button', { name: 'Menu' })).toBeNull()
    await expect(canvas.queryByRole('dialog')).toBeNull()
  },
}

/**
 * Scrolling down takes the header away; any scroll up brings it back, wherever the page is (Wayne, 24 Nov). Its
 * words follow the section beneath: Dark over the first section, Light further down.
 */
export const AwayOnTheWayDown: Story = {
  name: 'Away on the way down, back on the way up',
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async ({ canvasElement }) => {
    const header = headerIn(canvasElement)
    await waitFor(() => expect(header.dataset.theme).toBe('dark'))
    await scrollTo(900)
    await waitFor(() => expect(header.getBoundingClientRect().bottom).toBeLessThanOrEqual(0))
    await scrollTo(800)
    await waitFor(() => expect(header.getBoundingClientRect().top).toBe(0))
    await waitFor(() => expect(header.dataset.theme).toBe('light'))
    await scrollTo(0)
    await waitFor(() => expect(header.dataset.theme).toBe('dark'))
  },
}

/** Keyboard focus landing on the header while it is away brings it back: what has focus is never out of sight. */
export const BackForTheKeyboard: Story = {
  name: 'Back for the keyboard',
  tags: ['!dev'],
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    const header = headerIn(canvasElement)
    await scrollTo(900)
    await waitFor(() => expect(header.getBoundingClientRect().bottom).toBeLessThanOrEqual(0))
    await userEvent.tab()
    await expect(canvas.getByRole('link', { name: LOGO_LABEL })).toHaveFocus()
    await waitFor(() => expect(header.getBoundingClientRect().top).toBe(0))
  },
}
