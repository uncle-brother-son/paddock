import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { useState } from 'react'
import { expect, userEvent, waitFor } from 'storybook/test'

import { InBothModes, inEachMode, painted } from '@/components/ui/story-kit'

import { QuantityStepper } from './QuantityStepper'

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
  title: 'UI/Form controls/QuantityStepper',
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
 * 8px round its icon (25px) or, Big, 12px (33px). At the least the minus is unavailable (`aria-disabled`), its icon in
 * Text/Muted Primary.
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
    await expect(plus).toHaveAttribute('aria-disabled', 'false')
    await expect(getComputedStyle(plus).color).toBe(painted(stepper, 'text-text-primary', 'color'))
    if (value === 1) {
      await expect([minus.getAttribute('aria-disabled'), minus.disabled]).toEqual(['true', false])
      await expect(getComputedStyle(minus).color).toBe(painted(stepper, 'text-text-muted-primary', 'color'))
    } else {
      await expect(minus).toHaveAttribute('aria-disabled', 'false')
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
    // At the least a press on the minus is ignored.
    await userEvent.click(light!.minus)
    await expect(light!.number).toHaveTextContent('1')
    await userEvent.click(light!.plus)
    await expect(light!.number).toHaveTextContent('2')
    await expect(light!.minus).toHaveAttribute('aria-disabled', 'false')
    await userEvent.click(light!.minus)
    await expect(light!.number).toHaveTextContent('1')
    await expect(light!.minus).toHaveAttribute('aria-disabled', 'true')
  },
}

/**
 * W83 noticed 2 (Wayne, 27 Nov): pressed by keyboard up to the most (8 here), the plus keeps focus, says it is
 * unavailable and is faded, and a further press does nothing. A disabled button would have dropped focus to the page.
 */
export const KeyboardToTheMost: Story = {
  name: 'By keyboard, up to the most',
  play: async ({ canvasElement }) => {
    const [light] = all(canvasElement)
    const { stepper, minus, plus, number } = light!
    // The minus at the least is still a Tab stop; Tab goes on to the plus.
    minus.focus()
    await expect(minus).toHaveFocus()
    await userEvent.tab()
    await expect(plus).toHaveFocus()
    for (let press = 2; press <= 8; press += 1) await userEvent.keyboard('{Enter}')
    await expect(number).toHaveTextContent('8')
    await expect(plus).toHaveFocus()
    await expect([plus.getAttribute('aria-disabled'), plus.disabled]).toEqual(['true', false])
    // It fades over the short duration. The colour is read before the wait: `painted` changes the document.
    const muted = painted(stepper, 'text-text-muted-primary', 'color')
    await waitFor(() => expect(getComputedStyle(plus).color).toBe(muted))
    await userEvent.keyboard('{Enter}')
    await userEvent.keyboard(' ')
    await expect(number).toHaveTextContent('8')
    await expect(plus).toHaveFocus()
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

/** Each of its two buttons is an IconButton: Surface/Card Selected under a mouse, but never while it is unavailable. */
export const UnderAMouse: Story = {
  name: 'Under a mouse',
  args: { big: true },
  globals: { pseudo: 'hover' },
  play: async ({ canvasElement }) => {
    for (const { stepper, minus, plus } of all(canvasElement)) {
      await expect(getComputedStyle(plus).backgroundColor).toBe(painted(stepper, 'bg-surface-card-selected'))
      await expect(minus).toHaveAttribute('aria-disabled', 'true')
      await expect(getComputedStyle(minus).backgroundColor).toBe('rgba(0, 0, 0, 0)')
    }
  },
}
