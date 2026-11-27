import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { useState } from 'react'
import { expect, userEvent, waitFor } from 'storybook/test'

import { SAMPLE_ADD_ONS } from '@/components/modules/booking/sample-book'
import type { BookAddOn } from '@/lib/book/book'

import { AddOnCard } from './AddOnCard'

/** The card with how many are chosen kept, as the panel keeps it. */
function Kept({ addOn, start = 0 }: { addOn: BookAddOn; start?: number }) {
  const [quantity, setQuantity] = useState(start)
  return (
    // A card on a desktop: a third of the add-ons column.
    <ul className="max-w-[224px]">
      <AddOnCard addOn={addOn} quantity={quantity} onQuantity={setQuantity} />
    </ul>
  )
}

const meta = {
  title: 'Components/Cards/AddOnCard',
  component: Kept,
  args: { addOn: SAMPLE_ADD_ONS[3]! },
  globals: { theme: 'dark' },
} satisfies Meta<typeof Kept>

export default meta
type Story = StoryObj<typeof meta>

const box = (element: Element) => element.getBoundingClientRect()
const round = (...numbers: number[]) => numbers.map((number) => Math.round(number))
/** Waits until the words' own font is in: a height that hangs on a line of capitals is measured in that font, not a stand-in's. */
const fontIn = async (words: Element) => {
  await document.fonts.ready
  await waitFor(() => expect(document.fonts.check(getComputedStyle(words).font)).toBe(true))
}

/**
 * Figma "AddOnCard", Added=no (845:16649): the picture, 4 by 5 with 4px corners; 8px beneath, the name and the
 * price in Copy 12, 8px apart; 12px beneath, "Add": the small secondary button, the card's whole width, 33px tall.
 */
export const NotAdded: Story = {
  play: async ({ canvas, canvasElement }) => {
    const card = canvasElement.querySelector('[data-book="add-on"]') as HTMLElement
    // Its sample picture has no alt text, so it is decoration to a screen reader.
    const picture = canvasElement.querySelector('img')!.parentElement as HTMLElement
    await expect(round(box(picture).width, box(picture).height)).toEqual([224, 280])
    await expect(getComputedStyle(picture).borderRadius).toBe('4px')
    const [name, price] = [canvas.getByText('Smoothie High Brown Knoll'), canvas.getByText('£6')]
    await expect([getComputedStyle(name).fontSize, getComputedStyle(price).fontSize]).toEqual(['12px', '12px'])
    await expect(round(box(name).top - box(picture).bottom, box(price).top - box(name).bottom)).toEqual([8, 8])
    const add = canvas.getByRole('button', { name: 'Add Smoothie High Brown Knoll' })
    await expect(add).toHaveTextContent('Add')
    await fontIn(add.firstElementChild!)
    await expect(round(box(add).top - box(price).bottom, box(add).width)).toEqual([12, 224])
    // 12px above and below its label's capitals: Figma's 33, with the capitals counted as 9px.
    await expect(Math.abs(box(add).height - 33)).toBeLessThan(1)
    await expect(Math.round(box(card).bottom - box(add).bottom)).toBe(0)
  },
}

/**
 * Added=yes (845:16650): the stepper in the button's place, the card's whole width, its number between the two
 * icons. Add puts one in and moves focus to the stepper; taking the last one away brings "Add" back, with focus.
 */
export const Added: Story = {
  play: async ({ canvas }) => {
    const add = canvas.getByRole('button', { name: 'Add Smoothie High Brown Knoll' })
    const width = box(add).width
    await userEvent.click(add)
    const stepper = canvas.getByRole('group', { name: 'Smoothie High Brown Knoll: how many' })
    // In the button's place: 12px under the price, the card's whole width, 33px tall.
    await expect(round(box(stepper).top - box(canvas.getByText('£6')).bottom, box(stepper).width, box(stepper).height)).toEqual(round(12, width, 33))
    const [fewer, more] = [canvas.getByRole('button', { name: 'One fewer' }), canvas.getByRole('button', { name: 'One more' })]
    await waitFor(() => expect(more).toHaveFocus())
    await expect(canvas.getByRole('status')).toHaveTextContent('1')
    // The number sits midway between the two icons.
    const number = canvas.getByRole('status')
    await expect(Math.abs(box(number).left - box(fewer).right - (box(more).left - box(number).right))).toBeLessThan(1)
    await userEvent.click(more)
    await expect(canvas.getByRole('status')).toHaveTextContent('2')
    // At 1 the minus is live: it takes the add-on off again.
    await userEvent.click(fewer)
    await expect(fewer).toHaveAttribute('aria-disabled', 'false')
    await userEvent.click(fewer)
    await waitFor(() => expect(canvas.getByRole('button', { name: 'Add Smoothie High Brown Knoll' })).toHaveFocus())
    await expect(canvas.queryByRole('group')).toBeNull()
  },
}

/** An add-on with no picture in Sanity: its picture's place stays, empty, and the words sit where they would. */
export const NoPicture: Story = {
  args: { addOn: SAMPLE_ADD_ONS[5]! },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvasElement.querySelector('img')).toBeNull()
    const card = canvasElement.querySelector('[data-book="add-on"]') as HTMLElement
    const name = canvas.getByText('Cold Brew Coffee with Oat Milk and Vanilla Syrup, Large')
    await expect(Math.round(box(name).top - box(card).top)).toBe(288)
    await expect(canvas.getByText('£4.50')).toBeVisible()
  },
}
