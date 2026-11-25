import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { useState, type ComponentProps } from 'react'
import { expect, fn, userEvent, waitFor } from 'storybook/test'

import { Radio } from './Radio'
import { InBothModes, inEachMode, painted } from './story-kit'

// Figma "Radio" (03 UI, 891:5691): a story for each of Figma's three variants, under Figma's name for it.

/** The Radio holding its own state. Each stands in a form of its own, so the two modes' are not one group. */
function Held({ checked: start, onChange, ...rest }: ComponentProps<typeof Radio>) {
  const [checked, setChecked] = useState(start)
  return (
    <form>
      <Radio
        {...rest}
        checked={checked}
        onChange={() => {
          setChecked(true)
          onChange()
        }}
      />
    </form>
  )
}

const meta = {
  title: 'UI/Radio',
  component: Radio,
  parameters: { padded: false },
  args: { name: 'payment', value: 'card', checked: false, label: 'Card', onChange: fn() },
  render: (args) => (
    <InBothModes>
      <Held {...args} />
    </InBothModes>
  ),
} satisfies Meta<typeof Radio>

export default meta
type Story = StoryObj<typeof meta>

const circles = (canvasElement: HTMLElement) => inEachMode(canvasElement, '[data-radio]')
const dotOf = (circle: HTMLElement) => circle.children[0] as HTMLElement

/** A 20px circle on Surface/Card Selected, with no dot. */
export const Default: Story = {
  name: 'State=default',
  play: async ({ canvasElement }) => {
    const found = circles(canvasElement)
    await expect(found).toHaveLength(2)
    for (const circle of found) {
      const box = circle.getBoundingClientRect()
      await expect([box.width, box.height]).toEqual([20, 20])
      await expect(parseFloat(getComputedStyle(circle).borderRadius)).toBeGreaterThanOrEqual(10)
      await expect(getComputedStyle(circle).backgroundColor).toBe(painted(circle, 'bg-surface-card-selected'))
      await expect(getComputedStyle(dotOf(circle)).opacity).toBe('0')
      const radio = circle.querySelector('input')!
      await expect(radio).toHaveAccessibleName('Card')
      await expect(radio).not.toBeChecked()
      // The press reaches 2px beyond the circle all round: 24px.
      const press = radio.getBoundingClientRect()
      await expect([press.width, press.height, box.left - press.left, box.top - press.top]).toEqual([24, 24, 2, 2])
    }
  },
}

/** Chosen: Surface/Secondary, with the 10px dot in Text/Secondary. */
export const Selected: Story = {
  name: 'State=selected',
  args: { checked: true },
  play: async ({ canvasElement }) => {
    for (const circle of circles(canvasElement)) {
      await expect(getComputedStyle(circle).backgroundColor).toBe(painted(circle, 'bg-surface-secondary'))
      const dot = dotOf(circle)
      const [box, dotBox] = [circle.getBoundingClientRect(), dot.getBoundingClientRect()]
      await expect([dotBox.width, dotBox.height, dotBox.left - box.left, dotBox.top - box.top]).toEqual([10, 10, 5, 5])
      await expect([getComputedStyle(dot).backgroundColor, getComputedStyle(dot).opacity]).toEqual([painted(circle, 'bg-text-secondary'), '1'])
      await expect(circle.querySelector('input')).toBeChecked()
    }
  },
}

/** Under a mouse, not chosen: the dot in Text/Muted Primary. */
export const Hover: Story = {
  name: 'State=hover',
  globals: { pseudo: 'hover' },
  play: async ({ canvasElement }) => {
    for (const circle of circles(canvasElement)) {
      await expect(getComputedStyle(circle).backgroundColor).toBe(painted(circle, 'bg-surface-card-selected'))
      const dot = dotOf(circle)
      await expect([getComputedStyle(dot).backgroundColor, getComputedStyle(dot).opacity]).toEqual([painted(circle, 'bg-text-muted-primary'), '1'])
      await expect(dot.getBoundingClientRect().width).toBe(10)
    }
  },
}

/** By the keyboard: Tab reaches it, Space chooses it. */
export const Keyboard: Story = {
  play: async ({ canvasElement, args }) => {
    const [circle] = circles(canvasElement) as [HTMLElement]
    const radio = circle.querySelector('input')!
    await userEvent.tab()
    await expect(radio).toHaveFocus()
    await userEvent.keyboard(' ')
    await expect(radio).toBeChecked()
    await expect(args.onChange).toHaveBeenCalledTimes(1)
    // The colour is read before the wait: `painted` changes the document, and a wait looks again at every change.
    const chosen = painted(circle, 'bg-surface-secondary')
    await waitFor(() => expect(getComputedStyle(circle).backgroundColor).toBe(chosen))
    // The ring is the keyboard's, drawn round the circle that is seen.
    await expect([getComputedStyle(circle).outlineStyle, getComputedStyle(circle).outlineWidth, getComputedStyle(circle).outlineOffset]).toEqual(['solid', '2px', '2px'])
  },
}
