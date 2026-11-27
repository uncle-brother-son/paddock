import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { expect, userEvent, waitFor } from 'storybook/test'

import { LOGO_LABEL } from '@/components/brand/Logo'
import { OverlayTexture } from '@/components/ui/media/Overlay'

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
      <OverlayTexture />
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
  await waitFor(() => expect(Math.round(window.scrollY)).toBe(top), { timeout: 3000 })
}

/**
 * Figma Header, Device=desktop, Type=global: the logo, then Menu at column 18 and Book, Account and Bag at the right.
 * Book and Account are links (to /book and /account) with the buttons' look; every one of them shows the hand.
 * Hover the logo and it opens out to the full name. The header is see-through; over the dark first section its
 * words are the Dark mode's.
 */
export const Global: Story = {
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole('link', { name: LOGO_LABEL })).toBeVisible()
    for (const name of ['Menu', 'Bag']) await expect(canvas.getByRole('button', { name })).toBeVisible()
    await expect(canvas.getByRole('link', { name: 'Book' }).getAttribute('href')).toBe('/book')
    await expect(canvas.getByRole('link', { name: 'Account' }).getAttribute('href')).toBe('/account')
    // The same look, link or button: 8px all round, and the hand.
    const looks = ['Menu', 'Bag'].map((name) => canvas.getByRole('button', { name })).concat(['Book', 'Account'].map((name) => canvas.getByRole('link', { name })))
    for (const control of looks) await expect([getComputedStyle(control).padding, getComputedStyle(control).cursor]).toEqual(['8px', 'pointer'])
    // A link with words only is exactly as tall as a button with words only.
    const height = (control: HTMLElement) => control.getBoundingClientRect().height
    await expect([height(canvas.getByRole('link', { name: 'Book' })), height(canvas.getByRole('link', { name: 'Account' }))]).toEqual([height(canvas.getByRole('button', { name: 'Bag' })), height(canvas.getByRole('button', { name: 'Bag' }))])
    const header = headerIn(canvasElement)
    await waitFor(() => expect(header.dataset.theme).toBe('dark'), { timeout: 3000 })
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
    for (const name of ['Menu', 'Bag']) await expect(canvas.getByRole('button', { name })).toBeVisible()
    await expect(canvas.getByRole('link', { name: 'Book' })).toBeVisible()
    await expect(canvas.queryByRole('link', { name: 'Account' })).toBeNull()
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
    await waitFor(() => expect(header.dataset.theme).toBe('dark'), { timeout: 3000 })
    await scrollTo(900)
    await waitFor(() => expect(header.getBoundingClientRect().bottom).toBeLessThanOrEqual(0), { timeout: 3000 })
    await scrollTo(800)
    await waitFor(() => expect(header.getBoundingClientRect().top).toBe(0), { timeout: 3000 })
    await waitFor(() => expect(header.dataset.theme).toBe('light'), { timeout: 3000 })
    await scrollTo(0)
    await waitFor(() => expect(header.dataset.theme).toBe('dark'), { timeout: 3000 })
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
    await waitFor(() => expect(header.getBoundingClientRect().bottom).toBeLessThanOrEqual(0), { timeout: 3000 })
    await userEvent.tab()
    await expect(canvas.getByRole('link', { name: LOGO_LABEL })).toHaveFocus()
    await waitFor(() => expect(header.getBoundingClientRect().top).toBe(0), { timeout: 3000 })
  },
}
