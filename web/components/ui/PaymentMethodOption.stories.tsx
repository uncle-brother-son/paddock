import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { useState, type ComponentProps } from 'react'
import { expect, fn, userEvent, waitFor } from 'storybook/test'

import { PaymentMethodOption } from './PaymentMethodOption'
import { InBothModes, inEachMode, painted } from './story-kit'

// Figma "PaymentMethodOption" (03 UI, 956:16243): a story for each of Figma's two variants, under Figma's name for it.

/** The option holding its own state. Each stands in a form of its own, so the two modes' are not one group. */
function Held({ selected: start, onSelect, ...rest }: ComponentProps<typeof PaymentMethodOption>) {
  const [selected, setSelected] = useState(start)
  return (
    <form className="w-full">
      <PaymentMethodOption
        {...rest}
        selected={selected}
        onSelect={() => {
          setSelected(true)
          onSelect()
        }}
      />
    </form>
  )
}

const meta = {
  title: 'UI/PaymentMethodOption',
  component: PaymentMethodOption,
  parameters: { padded: false },
  args: { name: 'payment', value: 'card', selected: false, children: 'Card', onSelect: fn() },
  // Figma's own width for it.
  render: (args) => (
    <InBothModes width="w-[360px]">
      <Held {...args} />
    </InBothModes>
  ),
} satisfies Meta<typeof PaymentMethodOption>

export default meta
type Story = StoryObj<typeof meta>

const options = (canvasElement: HTMLElement) => inEachMode<HTMLLabelElement>(canvasElement, '[data-payment-method]')

/** Not chosen: on Surface/Card with square corners, the Radio and its words in Copy 14 12px apart, 16px all round (52px tall). */
export const NotSelected: Story = {
  name: 'Selected=no',
  play: async ({ canvasElement }) => {
    const found = options(canvasElement)
    await expect(found).toHaveLength(2)
    for (const option of found) {
      const style = getComputedStyle(option)
      const box = option.getBoundingClientRect()
      await expect([box.width, box.height]).toEqual([360, 52])
      await expect([style.padding, style.columnGap, style.borderRadius]).toEqual(['16px', '12px', '0px'])
      await expect(style.backgroundColor).toBe(painted(option, 'bg-surface-card'))
      const [circle, words] = [option.children[0] as HTMLElement, option.children[1] as HTMLElement]
      await expect(getComputedStyle(circle).backgroundColor).toBe(painted(option, 'bg-surface-card-selected'))
      await expect(circle.getBoundingClientRect().width).toBe(20)
      await expect([getComputedStyle(words).fontSize, getComputedStyle(words).color]).toEqual(['14px', painted(option, 'text-text-primary', 'color')])
      // Its words are the radio's name.
      await expect(option.querySelector('input')).toHaveAccessibleName('Card')
      await expect(option.querySelector('input')).not.toBeChecked()
    }
  },
}

/** Chosen: on Surface/Card Selected, with the Radio in its chosen state. */
export const Selected: Story = {
  name: 'Selected=yes',
  args: { selected: true },
  play: async ({ canvasElement }) => {
    for (const option of options(canvasElement)) {
      await expect(getComputedStyle(option).backgroundColor).toBe(painted(option, 'bg-surface-card-selected'))
      await expect(getComputedStyle(option.children[0]!).backgroundColor).toBe(painted(option, 'bg-surface-secondary'))
      await expect(option.querySelector('input')).toBeChecked()
    }
  },
}

/** Choosing: a press anywhere on the row, its words included, or Space on the radio. */
export const Choosing: Story = {
  play: async ({ canvasElement, args }) => {
    const [light, dark] = options(canvasElement) as [HTMLLabelElement, HTMLLabelElement]
    await userEvent.click(light.children[1]!)
    await expect(light.querySelector('input')).toBeChecked()
    await expect(args.onSelect).toHaveBeenCalledTimes(1)
    // The colour is read before the wait: `painted` changes the document, and a wait looks again at every change.
    const chosen = painted(light, 'bg-surface-card-selected')
    await waitFor(() => expect(getComputedStyle(light).backgroundColor).toBe(chosen))
    dark.querySelector('input')!.focus()
    await userEvent.keyboard(' ')
    await expect(dark.querySelector('input')).toBeChecked()
    await expect(args.onSelect).toHaveBeenCalledTimes(2)
  },
}
