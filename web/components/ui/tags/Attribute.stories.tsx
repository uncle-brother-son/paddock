import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { expect, fn, userEvent } from 'storybook/test'

import { InBothModes, inEachMode, painted } from '@/components/ui/story-kit'

import { Attribute } from './Attribute'

// Figma "Attribute" (03 UI, 1027:5427): a story for each of Figma's two variants, under Figma's name for it.

const meta = {
  title: 'UI/Tags/Attribute',
  component: Attribute,
  parameters: { padded: false },
  args: { children: 'Label', onRemove: fn() },
  render: (args) => (
    <InBothModes>
      <Attribute {...args} />
    </InBothModes>
  ),
} satisfies Meta<typeof Attribute>

export default meta
type Story = StoryObj<typeof meta>

const attributes = (canvasElement: HTMLElement) => inEachMode<HTMLButtonElement>(canvasElement, '[data-attribute]')

/** Its words in Label 12 and the close icon 4px to their right, 8px all round, on Surface/Card with 4px corners. */
export const Default: Story = {
  name: 'State=default',
  play: async ({ canvasElement }) => {
    await document.fonts.ready
    const found = attributes(canvasElement)
    await expect(found).toHaveLength(2)
    for (const attribute of found) {
      const style = getComputedStyle(attribute)
      await expect([style.backgroundColor, style.borderRadius, style.padding, style.columnGap]).toEqual([painted(attribute, 'bg-surface-card'), '4px', '8px', '4px'])
      await expect(style.color).toBe(painted(attribute, 'text-text-primary', 'color'))
      await expect(getComputedStyle(attribute.children[0]!).fontSize).toBe('12px')
      const icon = attribute.querySelector('svg')!.getBoundingClientRect()
      await expect([icon.width, icon.height]).toEqual([9, 9])
      // 8px round the 9px icon: 25px tall, as Figma has it.
      await expect(attribute.getBoundingClientRect().height).toBe(25)
      // Its name says what a press does, then its own words.
      await expect(attribute).toHaveAccessibleName('Remove Label')
    }
  },
}

/** Removing: a press anywhere on it, or Enter on it. */
export const Removing: Story = {
  play: async ({ canvasElement, args }) => {
    const found = attributes(canvasElement)
    await userEvent.click(found[0]!)
    await expect(args.onRemove).toHaveBeenCalledTimes(1)
    found[1]!.focus()
    await userEvent.keyboard('{Enter}')
    await expect(args.onRemove).toHaveBeenCalledTimes(2)
  },
}

/** Under a mouse: Surface/Card Selected. */
export const Hover: Story = {
  name: 'State=hover',
  globals: { pseudo: 'hover' },
  play: async ({ canvasElement }) => {
    for (const attribute of attributes(canvasElement)) {
      await expect(getComputedStyle(attribute).backgroundColor).toBe(painted(attribute, 'bg-surface-card-selected'))
    }
  },
}
