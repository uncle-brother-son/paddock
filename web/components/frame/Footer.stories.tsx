import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { expect, within } from 'storybook/test'

import { Footer } from './Footer'
import { EMPTY_FRAME, SAMPLE_FRAME } from './sample-content'

const meta = {
  title: 'Frame/Footer',
  component: Footer,
  parameters: { padded: false, layout: 'fullscreen', nextjs: { appDirectory: true } },
  args: { variant: 'global', content: SAMPLE_FRAME.footer },
} satisfies Meta<typeof Footer>

export default meta
type Story = StoryObj<typeof meta>

const left = (element: Element) => Math.round(element.getBoundingClientRect().left)

/**
 * Figma Footer, Device=desktop, Type=global: the newsletter card, then the card with the house, the four groups of
 * links (each filled by an editor in Sanity's Navigation document) and the copyright line.
 */
export const Global: Story = {
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async ({ canvas }) => {
    const groups = within(canvas.getByRole('navigation', { name: 'Footer' })).getAllByRole('list')
    await expect(groups).toHaveLength(4)
    // Figma: the groups start at 32, 370, 724 and 1078px of 1440 (the page grid's columns 1, 7, 13 and 19).
    await expect(groups.map(left)).toEqual([32, 370, 724, 1078])
    await expect(within(groups[0]!).getAllByRole('link').map((link) => link.textContent)).toEqual(['TikTok', 'Instagram', 'Facebook'])
    await expect(canvas.getByRole('link', { name: 'Instagram' }).getAttribute('target')).toBeNull()
    // The newsletter card: eight columns, centred (488px in, 464px wide).
    const newsletter = canvas.getByRole('region', { name: 'Newsletter' })
    await expect([left(newsletter), Math.round(newsletter.getBoundingClientRect().width)]).toEqual([488, 464])
    await expect(canvas.getByText('©2026 The Paddock Wellness Club')).toBeVisible()
    await expect(canvas.queryByText('Manage Cookies')).toBeNull()
  },
}

/** Figma Footer, Device=mobile, Type=global: the same, stacked, with the house edge to edge in its card. */
export const GlobalOnAPhone: Story = {
  name: 'Global, on a phone',
  globals: { viewport: { value: 'mobile', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    const groups = within(canvas.getByRole('navigation', { name: 'Footer' })).getAllByRole('list')
    await expect(groups.map(left)).toEqual([32, 32, 32, 32])
    const house = canvasElement.querySelector('footer svg[viewBox="0 0 460 200"]') as SVGElement
    await expect(Math.round(house.getBoundingClientRect().width)).toBe(326)
    await expect(document.documentElement.scrollWidth).toBe(document.documentElement.clientWidth)
  },
}

/** Figma Footer, Type=checkout: the copyright line, and the Terms and Privacy pages Site settings picks. */
export const Checkout: Story = {
  args: { variant: 'checkout' },
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async ({ canvas }) => {
    await expect(canvas.getAllByRole('link').map((link) => link.textContent)).toEqual(['Terms & Conditions', 'Privacy Policy'])
    await expect(canvas.queryByRole('region', { name: 'Newsletter' })).toBeNull()
    // Grid columns 3 and 15 (Wayne, 24 Nov: the nearest columns to Figma's 141 and 841px).
    await expect(left(canvas.getByText('©2026 The Paddock Wellness Club'))).toBe(134)
    await expect(left(canvas.getByRole('list'))).toBe(842)
  },
}

/** Figma Footer, Device=mobile, Type=checkout. */
export const CheckoutOnAPhone: Story = {
  name: 'Checkout, on a phone',
  args: { variant: 'checkout' },
  globals: { viewport: { value: 'mobile', isRotated: false } },
}

/** With no Site settings and no Navigation in Sanity yet: the newsletter field, the house and the copyright line; no links. */
export const NothingInSanityYet: Story = {
  name: 'Nothing in Sanity yet',
  args: { content: EMPTY_FRAME.footer },
  play: async ({ canvas }) => {
    await expect(canvas.queryAllByRole('link')).toHaveLength(0)
    await expect(canvas.queryByRole('navigation')).toBeNull()
    await expect(canvas.getByRole('textbox', { name: 'Enter your email address' })).toBeVisible()
  },
}
