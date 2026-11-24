import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { expect, userEvent, waitFor } from 'storybook/test'

import { DURATION_SHORT } from '@/lib/motion/tokens'

import { TextLink } from './TextLink'

const meta = {
  title: 'UI/TextLink',
  component: TextLink,
  parameters: { nextjs: { appDirectory: true } },
  args: { href: '/info/terms', children: 'Terms & Conditions' },
} satisfies Meta<typeof TextLink>

export default meta
type Story = StoryObj<typeof meta>

/**
 * Figma "Link 14" (WQ28): underlined always, Text/Muted Primary, turning Text/Primary on hover and on keyboard
 * focus, where it also gets the focus ring (WQ12: 2px in Text/Primary with a 2px gap, keyboard only).
 */
export const Link14: Story = {
  play: async ({ canvas }) => {
    const link = canvas.getByRole('link', { name: 'Terms & Conditions' })
    const style = getComputedStyle(link)
    const muted = style.color
    await expect(style.textDecorationLine).toBe('underline')
    await expect(style.fontSize).toBe('14px')
    await expect(style.transitionDuration).toBe(`${DURATION_SHORT}s`)
    await expect(style.outlineStyle).toBe('none')
    await expect(link.getAttribute('target')).toBeNull()

    await userEvent.tab()
    await expect(link).toHaveFocus()
    await waitFor(() => expect(getComputedStyle(link).color).not.toBe(muted))
    await expect([getComputedStyle(link).outlineStyle, getComputedStyle(link).outlineWidth, getComputedStyle(link).outlineOffset]).toEqual(['solid', '2px', '2px'])
    // Once the colour has finished changing, the ring is the same Text/Primary.
    await waitFor(() => expect(getComputedStyle(link).outlineColor).toBe(getComputedStyle(link).color))
  },
}

/** Figma "Link 12", for a link in Copy 12. */
export const Link12: Story = {
  args: { size: 12 },
  play: async ({ canvas }) => {
    await expect(getComputedStyle(canvas.getByRole('link')).fontSize).toBe('12px')
  },
}

/** In running text a link takes its paragraph's size. An outside address opens in the same tab unless the link says otherwise. */
export const InAParagraph: Story = {
  name: 'In a paragraph',
  render: () => (
    <p className="max-w-320 text-copy-14">
      Sessions can be moved up to 24 hours before they start: see our <TextLink href="/info/terms">terms</TextLink>, or find us on{' '}
      <TextLink href="https://www.instagram.com/">Instagram</TextLink>. The waiver opens in a{' '}
      <TextLink href="https://example.com/waiver" newTab>
        new tab
      </TextLink>
      .
    </p>
  ),
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('link', { name: 'Instagram' }).getAttribute('target')).toBeNull()
    const newTab = canvas.getByRole('link', { name: 'new tab' })
    await expect([newTab.getAttribute('target'), newTab.getAttribute('rel')]).toEqual(['_blank', 'noopener noreferrer'])
  },
}
