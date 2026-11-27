import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { expect } from 'storybook/test'

import { InBothModes, inEachMode, painted } from '@/components/ui/story-kit'

import { CheckboxControl } from './Checkbox'

// Figma "CheckboxControl" (03 UI, 891:5676): a story for each of Figma's four states, under Figma's name for it. It
// is the box of a Checkbox (components/ui/form-controls/Checkbox.tsx), which draws it round the real checkbox; here it stands
// alone, as Figma draws it, and is nothing to a screen reader.

const meta = {
  title: 'UI/Form controls/CheckboxControl',
  component: CheckboxControl,
  parameters: { padded: false },
  args: { checked: false },
  render: (args) => (
    <InBothModes>
      <CheckboxControl {...args} />
    </InBothModes>
  ),
} satisfies Meta<typeof CheckboxControl>

export default meta
type Story = StoryObj<typeof meta>

/** The box's fill and whether its tick shows; ticked, the tick's colour. */
const looks = async (canvasElement: HTMLElement, fill: string, tick: string | null) => {
  const found = inEachMode(canvasElement, '[data-checkbox-control]')
  await expect(found).toHaveLength(2)
  for (const box of found) {
    const at = box.getBoundingClientRect()
    await expect([at.width, at.height, getComputedStyle(box).borderRadius]).toEqual([20, 20, '4px'])
    await expect(getComputedStyle(box).backgroundColor).toBe(painted(box, fill))
    const drawn = box.querySelector('svg')!
    // The icon set's tick at 12px, 4px inside the box.
    await expect([drawn.getBoundingClientRect().width, drawn.getBoundingClientRect().left - at.left]).toEqual([12, 4])
    await expect(getComputedStyle(drawn).opacity).toBe(tick ? '1' : '0')
    if (tick) await expect(getComputedStyle(drawn).color).toBe(painted(box, tick, 'color'))
  }
}

/** Surface/Card Selected, empty. */
export const Default: Story = {
  name: 'State=default',
  play: async ({ canvasElement }) => looks(canvasElement, 'bg-surface-card-selected', null),
}

/** Under a mouse: the tick shows, in Text/Primary. */
export const Hover: Story = {
  name: 'State=hover',
  globals: { pseudo: 'hover' },
  play: async ({ canvasElement }) => looks(canvasElement, 'bg-surface-card-selected', 'text-text-primary'),
}

/** Ticked: Surface/Secondary with the tick in Text/Secondary. */
export const Selected: Story = {
  name: 'State=selected',
  args: { checked: true },
  play: async ({ canvasElement }) => looks(canvasElement, 'bg-surface-secondary', 'text-text-secondary'),
}

/** Disabled: Surface/Card Disabled, empty; a mouse over it shows nothing (drawn here as under one). */
export const Disabled: Story = {
  name: 'State=disabled',
  args: { disabled: true },
  globals: { pseudo: 'hover' },
  play: async ({ canvasElement }) => looks(canvasElement, 'bg-surface-card-disabled', null),
}
