import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { useState } from 'react'
import { expect, userEvent, within } from 'storybook/test'

import { SAMPLE_GIFT_CARD } from '@/components/shop/sample-shop'
import { amountOf, type AmountChoice } from '@/lib/shop/gift-card'

import { AmountField } from './AmountField'

const LIMITS = SAMPLE_GIFT_CARD.other

/** The piece with its choice kept, as the Gift Card page keeps it: what is wrong is W76a's rule on what is typed. */
function Kept({ start, other = true }: { start: AmountChoice; other?: boolean }) {
  const [choice, setChoice] = useState<AmountChoice>(start)
  return (
    // The details' width on a desktop: 7 columns of the grid.
    <div className="max-w-[405px]">
      <AmountField amounts={SAMPLE_GIFT_CARD.amounts} other={other} choice={choice} onChoice={setChoice} wrong={amountOf(choice, LIMITS).wrong} />
    </div>
  )
}

const meta = {
  title: 'Components/Shop/AmountField',
  component: Kept,
  args: { start: { kind: 'preset', amount: '15.00' } },
} satisfies Meta<typeof Kept>

export default meta
type Story = StoryObj<typeof meta>

const box = (element: Element) => element.getBoundingClientRect()
const chipOf = (radio: HTMLElement) => radio.parentElement as HTMLElement

/**
 * Figma "AmountField", State=default (1389:39345): "Amount" in Copy 12, 12px over the chips; a chip for each
 * preset and Other, three to a row, 4px apart (SizeSelect, Big: Copy 14, 16px above and below); the lowest chosen,
 * in Surface/Secondary with Text/Secondary.
 */
export const Default: Story = {
  play: async ({ canvas }) => {
    const label = canvas.getByText('Amount')
    await expect(getComputedStyle(label).fontSize).toBe('12px')
    const group = canvas.getByRole('radiogroup', { name: 'Amount' })
    await expect(Math.round(box(group).top - box(label).bottom)).toBe(12)
    const chips = within(group).getAllByRole('radio')
    await expect(chips.map((chip) => [chip.getAttribute('aria-label'), (chip as HTMLInputElement).checked])).toEqual([
      ['£15', true],
      ['£30', false],
      ['£60', false],
      ['£90', false],
      ['£150', false],
      ['Other', false],
    ])
    const boxes = chips.map((chip) => box(chipOf(chip)))
    // Two rows of three, each a third of the width less the gaps.
    await expect(boxes.map((one) => Math.round(one.width))).toEqual([132, 132, 132, 132, 132, 132])
    await expect([Math.round(boxes[1]!.left - boxes[0]!.right), Math.round(boxes[3]!.top - boxes[0]!.bottom), Math.round(boxes[3]!.left - boxes[0]!.left)]).toEqual([4, 4, 0])
    await expect(getComputedStyle(chipOf(chips[0]!)).backgroundColor).not.toBe(getComputedStyle(chipOf(chips[1]!)).backgroundColor)
    await expect(canvas.queryByRole('textbox')).toBeNull()
  },
}

/** State=selected (1389:39344): another preset chosen. The arrow keys move the choice along, as on any group of radio buttons. */
export const Selected: Story = {
  args: { start: { kind: 'preset', amount: '30.00' } },
  play: async ({ canvas }) => {
    const thirty = canvas.getByRole('radio', { name: '£30' })
    await expect(thirty).toBeChecked()
    await userEvent.click(canvas.getByRole('radio', { name: '£90' }))
    await expect(canvas.getByRole('radio', { name: '£90' })).toBeChecked()
    await expect(thirty).not.toBeChecked()
    await userEvent.keyboard('{ArrowRight}')
    await expect(canvas.getByRole('radio', { name: '£150' })).toBeChecked()
  },
}

/** State=other (1389:39343): Other chosen, and the amount field open beneath the chips with its prompt. */
export const Other: Story = {
  args: { start: { kind: 'other', typed: '' } },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('radio', { name: 'Other' })).toBeChecked()
    const field = canvas.getByRole('textbox', { name: 'Enter an amount' })
    await expect([(field as HTMLInputElement).value, field.getAttribute('placeholder')]).toEqual(['', 'Enter an amount'])
    const chip = box(chipOf(canvas.getByRole('radio', { name: 'Other' })))
    await expect([Math.round(box(field).top - chip.bottom), Math.round(box(field).width)]).toEqual([4, 405])
    await expect(Math.abs(box(field).height - chip.height)).toBeLessThan(0.5)
    // Its words are Copy 14 with the browser's own line: the field is not trimmed to its capitals.
    await expect([getComputedStyle(field).fontSize, getComputedStyle(field).getPropertyValue('text-box-trim')]).toEqual(['14px', 'none'])
  },
}

/** State=other full (1389:39685): an amount typed, shown with its pound sign. */
export const OtherFull: Story = {
  name: 'Other full',
  args: { start: { kind: 'other', typed: '200' } },
  play: async ({ canvas }) => {
    const field = canvas.getByRole('textbox', { name: 'Enter an amount' })
    await expect(field).toHaveValue('£200')
    await expect(field.getAttribute('aria-invalid')).toBe('false')
    // Rubbing it all out leaves the prompt, not a pound sign alone.
    await userEvent.clear(field)
    await expect(field).toHaveValue('')
    await userEvent.type(field, '£50')
    await expect(field).toHaveValue('£50')
  },
}

/**
 * An amount the rule refuses (WQ63): the Input's error state, as drawn (Figma "Input", Error=yes, 975:6926): the
 * field in Surface/Card Error, and the words 8px beneath it, 16px in, in Copy 12 and Text/Error.
 */
export const OtherWrong: Story = {
  name: 'Other, an amount it can’t take',
  args: { start: { kind: 'other', typed: '25.50' } },
  play: async ({ canvas, canvasElement }) => {
    const field = canvas.getByRole('textbox', { name: 'Enter an amount' })
    const wrong = canvasElement.querySelector('[data-field-error]') as HTMLElement
    await expect(wrong.textContent).toBe('Enter an amount in whole pounds')
    await expect([field.getAttribute('aria-invalid'), field.getAttribute('aria-describedby')]).toEqual(['true', wrong.id])
    await expect([Math.round(box(wrong).top - box(field).bottom), getComputedStyle(wrong).paddingLeft, getComputedStyle(wrong).fontSize]).toEqual([8, '16px', '12px'])
    await userEvent.clear(field)
    await userEvent.type(field, '2000')
    await expect((canvasElement.querySelector('[data-field-error]') as HTMLElement).textContent).toBe('Enter an amount between £1 and £1,000')
    await userEvent.clear(field)
    await userEvent.type(field, '20')
    await expect(canvasElement.querySelector('[data-field-error]')).toBeNull()
  },
}

/** A type with Other switched off: the presets alone. */
export const NoOther: Story = {
  args: { other: false },
  play: async ({ canvas }) => {
    await expect(canvas.queryByRole('radio', { name: 'Other' })).toBeNull()
    await expect(canvas.getAllByRole('radio')).toHaveLength(5)
  },
}
