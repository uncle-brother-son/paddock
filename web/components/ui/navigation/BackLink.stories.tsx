import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { expect, userEvent } from 'storybook/test'

import { InBothModes, inEachMode, painted } from '@/components/ui/story-kit'

import { BackLink } from './BackLink'

// Figma "BackLink" (03 UI, 1138:11231): Figma's one drawing of it, under Figma's name for it.

const meta = {
  title: 'UI/Navigation/BackLink',
  component: BackLink,
  parameters: { padded: false, nextjs: { appDirectory: true } },
  args: { href: '/account/bookings', children: 'Back to Bookings' },
  render: (args) => (
    <InBothModes>
      <BackLink {...args} />
    </InBothModes>
  ),
} satisfies Meta<typeof BackLink>

export default meta
type Story = StoryObj<typeof meta>

/** The arrow, turned to point left, and 8px from it the words in Label 12, both in Text/Muted Primary. */
export const Default: Story = {
  name: 'BackLink',
  play: async ({ canvasElement }) => {
    await document.fonts.ready
    const found = inEachMode<HTMLAnchorElement>(canvasElement, '[data-back-link]')
    await expect(found).toHaveLength(2)
    for (const link of found) {
      await expect(link).toHaveRole('link')
      await expect(link).toHaveAccessibleName('Back to Bookings')
      await expect(link.getAttribute('href')).toBe('/account/bookings')
      const muted = painted(link, 'text-text-muted-primary', 'color')
      const [arrow, words] = [link.querySelector('svg')!, link.children[1] as HTMLElement]
      await expect([getComputedStyle(link).color, getComputedStyle(arrow).color, getComputedStyle(words).color]).toEqual([muted, muted, muted])
      await expect([getComputedStyle(link).columnGap, getComputedStyle(arrow).rotate, getComputedStyle(words).fontSize]).toEqual(['8px', '180deg', '12px'])
      // Its room for a press (8px above and below) is taken back by its margin: it stands where its words do.
      await expect([getComputedStyle(link).paddingTop, getComputedStyle(link).marginTop, getComputedStyle(link).paddingBottom, getComputedStyle(link).marginBottom]).toEqual(['8px', '-8px', '8px', '-8px'])
      await expect(link.getBoundingClientRect().height).toBeGreaterThanOrEqual(24)
    }
  },
}

/** By the keyboard: Tab reaches it, with the ring every link has. */
export const Keyboard: Story = {
  play: async ({ canvasElement }) => {
    const found = inEachMode<HTMLAnchorElement>(canvasElement, '[data-back-link]')
    await userEvent.tab()
    await expect(found[0]).toHaveFocus()
    await expect([getComputedStyle(found[0]!).outlineStyle, getComputedStyle(found[0]!).outlineWidth, getComputedStyle(found[0]!).outlineOffset]).toEqual(['solid', '2px', '2px'])
  },
}
