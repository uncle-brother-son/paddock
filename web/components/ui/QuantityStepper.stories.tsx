import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { useState } from 'react'
import { expect, userEvent } from 'storybook/test'

import { QuantityStepper } from './QuantityStepper'
import { InBothModes, inEachMode, painted } from './story-kit'

// Figma "QuantityStepper" (03 UI, 608:2424): a story for each of Figma's four variants, under Figma's name for it. On
// the site (all Big=yes): an event's places, a session's people and an add-on's count.

type SampleProps = {
  /** The number it starts on. Figma's Switch=no is the least (1: the minus does nothing); Switch=yes is 2. */
  start: number
  /** Figma's Big. */
  big: boolean
}

function Sample({ start, big }: SampleProps) {
  const [value, setValue] = useState(start)
  return <QuantityStepper value={value} max={8} onChange={setValue} big={big} />
}

const meta = {
  title: 'UI/QuantityStepper',
  component: Sample,
  parameters: { padded: false },
  args: { start: 1, big: false },
  render: (args) => (
    <InBothModes>
      <Sample {...args} />
    </InBothModes>
  ),
} satisfies Meta<typeof Sample>

export default meta
type Story = StoryObj<typeof meta>

const all = (canvasElement: HTMLElement) =>
  inEachMode(canvasElement, '[data-stepper]').map((stepper) => ({
    stepper,
    minus: stepper.querySelector<HTMLButtonElement>('button[aria-label="One fewer"]')!,
    plus: stepper.querySelector<HTMLButtonElement>('button[aria-label="One more"]')!,
    number: stepper.querySelector<HTMLElement>('output')!,
  }))

/**
 * Surface/Card with 4px corners; the number in Label 12, 20px wide with 8px each side; an IconButton each side of it,
 * 8px round its icon (25px) or, Big, 12px (33px). At the least the minus is disabled, its icon in Text/Muted Primary.
 */
const looks = async (canvasElement: HTMLElement, { value, big }: { value: number; big: boolean }) => {
  const found = all(canvasElement)
  await expect(found).toHaveLength(2)
  const side = big ? 33 : 25
  for (const { stepper, minus, plus, number } of found) {
    await expect([getComputedStyle(stepper).backgroundColor, getComputedStyle(stepper).borderRadius]).toEqual([painted(stepper, 'bg-surface-card'), '4px'])
    const box = stepper.getBoundingClientRect()
    await expect([box.width, box.height]).toEqual([side + 36 + side, side])
    await expect([plus.getBoundingClientRect().width, plus.getBoundingClientRect().height, getComputedStyle(plus).paddingTop]).toEqual([side, side, big ? '12px' : '8px'])
    await expect(number).toHaveTextContent(String(value))
    await expect([getComputedStyle(number).paddingLeft, getComputedStyle(number.querySelector('span')!).width]).toEqual(['8px', '20px'])
    await expect(plus).toBeEnabled()
    await expect(getComputedStyle(plus).color).toBe(painted(stepper, 'text-text-primary', 'color'))
    if (value === 1) {
      await expect(minus).toBeDisabled()
      await expect(getComputedStyle(minus).color).toBe(painted(stepper, 'text-text-muted-primary', 'color'))
    } else {
      await expect(minus).toBeEnabled()
      await expect(getComputedStyle(minus).color).toBe(painted(stepper, 'text-text-primary', 'color'))
    }
  }
}

/** At the least: the minus does nothing. A press on the plus goes up one, and the minus can then be pressed. */
export const SmallAtTheLeast: Story = {
  name: 'Switch=no, Big=no',
  play: async ({ canvasElement }) => {
    await looks(canvasElement, { value: 1, big: false })
    const [light] = all(canvasElement)
    await userEvent.click(light!.plus)
    await expect(light!.number).toHaveTextContent('2')
    await expect(light!.minus).toBeEnabled()
    await userEvent.click(light!.minus)
    await expect(light!.number).toHaveTextContent('1')
    await expect(light!.minus).toBeDisabled()
  },
}

export const Small: Story = {
  name: 'Switch=yes, Big=no',
  args: { start: 2 },
  play: async ({ canvasElement }) => looks(canvasElement, { value: 2, big: false }),
}

export const BigAtTheLeast: Story = {
  name: 'Switch=no, Big=yes',
  args: { big: true },
  play: async ({ canvasElement }) => looks(canvasElement, { value: 1, big: true }),
}

export const Big: Story = {
  name: 'Switch=yes, Big=yes',
  args: { start: 2, big: true },
  play: async ({ canvasElement }) => looks(canvasElement, { value: 2, big: true }),
}

/** Each of its two buttons is an IconButton: Surface/Card Selected under a mouse, but never while it is disabled. */
export const UnderAMouse: Story = {
  name: 'Under a mouse',
  args: { big: true },
  globals: { pseudo: 'hover' },
  play: async ({ canvasElement }) => {
    for (const { stepper, minus, plus } of all(canvasElement)) {
      await expect(getComputedStyle(plus).backgroundColor).toBe(painted(stepper, 'bg-surface-card-selected'))
      await expect(minus).toBeDisabled()
      await expect(getComputedStyle(minus).backgroundColor).toBe('rgba(0, 0, 0, 0)')
    }
  },
}
