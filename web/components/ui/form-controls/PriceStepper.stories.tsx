import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { expect, fn, userEvent } from 'storybook/test'

import { CLEAR, InBothModes, inEachMode, painted } from '@/components/ui/story-kit'

import { PriceStepper } from './PriceStepper'

// Figma "PriceStepper" (03 UI, 1157:16352): Figma's one variant, under Figma's name for it.

const meta = {
  title: 'UI/Form controls/PriceStepper',
  component: PriceStepper,
  parameters: { padded: false },
  args: { price: '£1', label: 'Add a towel', onAdd: fn() },
  render: (args) => (
    <InBothModes>
      <PriceStepper {...args} />
    </InBothModes>
  ),
} satisfies Meta<typeof PriceStepper>

export default meta
type Story = StoryObj<typeof meta>

/** On Surface/Card with 4px corners: the price in Label 12 with 8px all round it, then the plus, an IconButton of 25px. */
export const Default: Story = {
  name: 'Switch=no, Big=no',
  play: async ({ canvasElement }) => {
    await document.fonts.ready
    const found = inEachMode(canvasElement, '[data-price-stepper]')
    await expect(found).toHaveLength(2)
    for (const stepper of found) {
      await expect([getComputedStyle(stepper).backgroundColor, getComputedStyle(stepper).borderRadius]).toEqual([painted(stepper, 'bg-surface-card'), '4px'])
      const [priceBox, plus] = [stepper.children[0] as HTMLElement, stepper.children[1] as HTMLButtonElement]
      await expect(priceBox).toHaveTextContent('£1')
      await expect(getComputedStyle(priceBox).padding).toBe('8px')
      await expect([getComputedStyle(priceBox.children[0]!).fontSize, getComputedStyle(priceBox.children[0]!).color]).toEqual(['12px', painted(stepper, 'text-text-primary', 'color')])
      const [box, plusBox] = [stepper.getBoundingClientRect(), plus.getBoundingClientRect()]
      await expect([plusBox.width, plusBox.height]).toEqual([25, 25])
      // The plus is at its right edge, as tall as the stepper, with nothing between the two parts.
      await expect([box.height, box.right - plusBox.right, plusBox.left - priceBox.getBoundingClientRect().right]).toEqual([25, 0, 0])
      await expect(getComputedStyle(plus).backgroundColor).toBe(CLEAR)
      await expect(plus).toHaveAccessibleName('Add a towel')
    }
  },
}

/** Adding: a press on the plus, or Enter on it. */
export const Adding: Story = {
  play: async ({ canvasElement, args }) => {
    const found = inEachMode(canvasElement, '[data-price-stepper]')
    await userEvent.click(found[0]!.querySelector('button')!)
    await expect(args.onAdd).toHaveBeenCalledTimes(1)
    // By the keyboard too: the plus is a real button.
    found[1]!.querySelector('button')!.focus()
    await userEvent.keyboard('{Enter}')
    await expect(args.onAdd).toHaveBeenCalledTimes(2)
  },
}
