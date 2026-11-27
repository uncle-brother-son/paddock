import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { useState, type ComponentProps } from 'react'
import { expect, fn, userEvent, waitFor } from 'storybook/test'

import { InBothModes, inEachMode, painted } from '@/components/ui/story-kit'

import { PriceStepper } from './PriceStepper'

// Figma "PriceStepper" (03 UI, 1157:16352): Figma's one variant, under Figma's name for it, and the stepper at work
// (WQ80: £1 steps, within its limits, typed too).

/** The stepper holding its own amount, as a page would. */
function Held({ value: start, onChange, ...rest }: ComponentProps<typeof PriceStepper>) {
  const [value, setValue] = useState(start)
  return (
    <PriceStepper
      {...rest}
      value={value}
      onChange={(next) => {
        setValue(next)
        onChange(next)
      }}
    />
  )
}

const meta = {
  title: 'UI/Form controls/PriceStepper',
  component: PriceStepper,
  parameters: { padded: false },
  args: { value: 1, min: 1, max: 5, label: 'Amount', onChange: fn() },
  render: (args) => (
    <InBothModes>
      <Held {...args} />
    </InBothModes>
  ),
} satisfies Meta<typeof PriceStepper>

export default meta
type Story = StoryObj<typeof meta>

const steppers = (canvasElement: HTMLElement) => inEachMode(canvasElement, '[data-price-stepper]')
const near = (value: number) => Math.round(value * 100) / 100
const partsOf = (stepper: HTMLElement) => ({
  amount: stepper.querySelector('input')!,
  up: stepper.querySelector<HTMLButtonElement>('[data-step="up"]')!,
  down: stepper.querySelector<HTMLButtonElement>('[data-step="down"]')!,
  said: stepper.querySelector<HTMLElement>('[data-price-said]')!,
})

/**
 * At its lowest, as drawn: on Surface/Card with 4px corners and 25px tall, "£1" in Label 12 with 8px each side, then
 * the 25px IconButton with the up-and-down icon 8px in and 6px down. At the lowest the lower arrow is Text/Muted
 * Primary and does nothing.
 */
export const Default: Story = {
  name: 'Switch=no, Big=no',
  play: async ({ canvasElement }) => {
    await document.fonts.ready
    const found = steppers(canvasElement)
    await expect(found).toHaveLength(2)
    for (const stepper of found) {
      const { amount, up, down } = partsOf(stepper)
      const style = getComputedStyle(stepper)
      await expect([style.backgroundColor, style.borderRadius]).toEqual([painted(stepper, 'bg-surface-card'), '4px'])
      const box = stepper.getBoundingClientRect()
      // Figma's frame: 54 by 25.
      await expect([Math.round(box.width), box.height]).toEqual([54, 25])
      // The amount: "£" and the digits in Label 12, 8px each side, on one baseline.
      const priceBox = stepper.children[0] as HTMLElement
      await expect([getComputedStyle(priceBox).paddingLeft, getComputedStyle(priceBox).paddingRight]).toEqual(['8px', '8px'])
      await expect([getComputedStyle(amount).fontSize, getComputedStyle(amount).fontWeight, getComputedStyle(amount).color]).toEqual(['12px', '500', painted(stepper, 'text-text-primary', 'color')])
      await expect(amount.value).toBe('1')
      const pound = priceBox.children[0] as HTMLElement
      await expect(pound).toHaveTextContent('£')
      await expect(Math.round(pound.getBoundingClientRect().bottom)).toBe(Math.round(amount.getBoundingClientRect().bottom))
      // The field is as wide as what it holds ("1": its unseen copy), so the part is "£1" with 8px each side, as drawn.
      const copy = amount.previousElementSibling as HTMLElement
      await expect([copy.textContent, amount.getBoundingClientRect().width]).toEqual(['1', copy.getBoundingClientRect().width])
      await expect(near(priceBox.getBoundingClientRect().width)).toBe(near(16 + pound.getBoundingClientRect().width + copy.getBoundingClientRect().width))
      // The IconButton: 25px square at the right, the two halves one above the other, nothing behind them at rest.
      const [upBox, downBox] = [up.getBoundingClientRect(), down.getBoundingClientRect()]
      await expect([upBox.width, upBox.height + downBox.height, box.right - upBox.right, downBox.top - upBox.bottom]).toEqual([25, 25, 0, 0])
      await expect([getComputedStyle(up).backgroundColor, getComputedStyle(up).borderTopRightRadius, getComputedStyle(up).borderBottomRightRadius]).toEqual(['rgba(0, 0, 0, 0)', '4px', '0px'])
      // The icon, 9 by 13, 8px in and 6px down in the 25px square: each half shows its own arrow of it.
      for (const half of [up, down]) {
        const icon = half.querySelector('svg')!.getBoundingClientRect()
        await expect([icon.width, icon.height, icon.left - upBox.left, icon.top - upBox.top]).toEqual([9, 13, 8, 6])
      }
      // At the lowest: the lower arrow is muted and does nothing; the upper can be pressed.
      await expect([down.disabled, up.disabled]).toEqual([true, false])
      await expect(getComputedStyle(down).color).toBe(painted(stepper, 'text-text-muted-primary', 'color'))
      await expect(getComputedStyle(up).color).toBe(painted(stepper, 'text-text-primary', 'color'))
      // For a screen reader: a spin button with its name and its amount in pounds; the halves have names of their own.
      await expect(amount).toHaveRole('spinbutton')
      await expect(amount).toHaveAccessibleName('Amount')
      await expect([amount.getAttribute('aria-valuetext'), amount.getAttribute('aria-valuemin'), amount.getAttribute('aria-valuemax')]).toEqual(['£1', '1', '5'])
      await expect(up).toHaveAccessibleName('One pound more')
      await expect(down).toHaveAccessibleName('One pound less')
    }
  },
}

/** The halves: £1 up and down, said aloud each time, and the upper one does nothing at the highest. */
export const Stepping: Story = {
  play: async ({ canvasElement, args }) => {
    const [stepper] = steppers(canvasElement) as [HTMLElement]
    const { amount, up, down, said } = partsOf(stepper)
    await userEvent.click(up)
    await expect(amount.value).toBe('2')
    await expect(args.onChange).toHaveBeenLastCalledWith(2)
    await expect(said).toHaveTextContent('£2')
    await expect(amount.getAttribute('aria-valuetext')).toBe('£2')
    await expect(down.disabled).toBe(false)
    await userEvent.click(down)
    await expect([amount.value, said.textContent]).toEqual(['1', '£1'])
    await expect(down.disabled).toBe(true)
    // Up to the highest, £5: there the upper arrow is muted and does nothing.
    for (let press = 0; press < 4; press += 1) await userEvent.click(up)
    await expect([amount.value, up.disabled]).toEqual(['5', true])
    // The colour is read before the wait: `painted` changes the document, and a wait looks again at every change.
    const muted = painted(stepper, 'text-text-muted-primary', 'color')
    await waitFor(() => expect(getComputedStyle(up).color).toBe(muted))
    await expect(args.onChange).toHaveBeenCalledTimes(6)
    // The halves are not Tab stops: Tab goes to the amount, then on past the stepper.
    await userEvent.tab()
    await expect(amount).toHaveFocus()
  },
}

/** The keyboard: the arrow keys step the amount by £1 within its limits. */
export const Keyboard: Story = {
  args: { value: 3 },
  play: async ({ canvasElement, args }) => {
    const [stepper] = steppers(canvasElement) as [HTMLElement]
    const { amount } = partsOf(stepper)
    await userEvent.tab()
    await expect(amount).toHaveFocus()
    // While the amount has focus the fill is Surface/Card Selected, as a text field's is.
    const focused = painted(stepper, 'bg-surface-card-selected')
    await waitFor(() => expect(getComputedStyle(stepper).backgroundColor).toBe(focused))
    await userEvent.keyboard('{ArrowUp}')
    await expect([amount.value, amount.getAttribute('aria-valuenow')]).toEqual(['4', '4'])
    await userEvent.keyboard('{ArrowUp}{ArrowUp}{ArrowUp}')
    await expect(amount.value).toBe('5')
    await userEvent.keyboard('{ArrowDown}')
    await expect(amount.value).toBe('4')
    await expect(args.onChange).toHaveBeenLastCalledWith(4)
  },
}

/**
 * Typing: digits only (whole pounds), taken on Enter or when focus leaves. Past a limit it is put at the limit and
 * that is said; left empty it goes back to the amount it was.
 */
export const Typing: Story = {
  args: { value: 2, max: 20 },
  play: async ({ canvasElement, args }) => {
    const [stepper] = steppers(canvasElement) as [HTMLElement]
    const { amount, up, said } = partsOf(stepper)
    await userEvent.tripleClick(amount)
    await userEvent.keyboard('12.50')
    // Only digits are taken: "1250", not yet the amount.
    await expect(amount.value).toBe('1250')
    await expect(args.onChange).not.toHaveBeenCalled()
    // The field grows with what is typed.
    await expect(Math.round(amount.getBoundingClientRect().width)).toBeGreaterThan(20)
    await userEvent.keyboard('{Enter}')
    await expect(amount.value).toBe('20')
    await expect(args.onChange).toHaveBeenLastCalledWith(20)
    await expect(said).toHaveTextContent('£20')
    await expect(up.disabled).toBe(true)
    // Within the limits it is taken as it is when focus leaves.
    await userEvent.tripleClick(amount)
    await userEvent.keyboard('7')
    await userEvent.tab()
    await expect(amount.value).toBe('7')
    await expect(args.onChange).toHaveBeenLastCalledWith(7)
    // Below the lowest: the lowest.
    await userEvent.tripleClick(amount)
    await userEvent.keyboard('0{Enter}')
    await expect([amount.value, said.textContent]).toEqual(['1', '£1'])
    // Left empty: back to the amount it was, and nothing changes.
    const calls = args.onChange.mock.calls.length
    await userEvent.tripleClick(amount)
    await userEvent.keyboard('{Backspace}')
    await expect(amount.value).toBe('')
    await userEvent.tab()
    await expect(amount.value).toBe('1')
    await expect(args.onChange).toHaveBeenCalledTimes(calls)
    // A half pressed while typing takes the typed amount first, and steps from it: focus stays in the amount.
    await userEvent.tripleClick(amount)
    await userEvent.keyboard('9')
    await userEvent.click(up)
    await expect(amount.value).toBe('10')
    await expect(amount).toHaveFocus()
  },
}
