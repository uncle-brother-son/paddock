import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { useId } from 'react'
import { expect } from 'storybook/test'

import { CLEAR, InBothModes, inEachMode, painted } from '@/components/ui/story-kit'

import { SizeButton, SizeOption } from './SizeSelect'

// Figma "SizeSelect" (03 UI, 276:6625): a story for each of Figma's eight variants, under Figma's name for it. On the
// site Big=no is SizeButton (a ProductCard's strip of sizes) and Big=yes is SizeOption (the Product page's sizes, and
// the Gift Card page's amounts).

type SampleProps = {
  /** Figma's Big. */
  big: boolean
  /** In stock: false for Figma's OOS and sold out. */
  available?: boolean
  selected?: boolean
}

function Sample({ big, available = true, selected = false }: SampleProps) {
  // Each mode's chip is a radio group of its own.
  const name = useId()
  if (big) return <SizeOption name={name} size="S" available={available} selected={selected} onSelect={() => undefined} />
  return <SizeButton size="S" available={available} {...(selected ? { selected } : {})} aria-label={available ? 'S' : 'S, sold out'} />
}

const meta = {
  title: 'UI/SizeSelect',
  component: Sample,
  parameters: { padded: false },
  args: { big: false },
  // 80px wide, as Figma draws it: on the site a chip shares its row with the other sizes.
  render: (args) => (
    <InBothModes width="w-80">
      <Sample {...args} />
    </InBothModes>
  ),
} satisfies Meta<typeof Sample>

export default meta
type Story = StoryObj<typeof meta>

/** The chip as drawn: the button, or the label round the unseen radio button. */
const chips = (canvasElement: HTMLElement) => inEachMode(canvasElement, 'button, label')

const looks = async (canvasElement: HTMLElement, fill: string | null, words: string, big: boolean) => {
  const found = chips(canvasElement)
  await expect(found).toHaveLength(2)
  for (const chip of found) {
    const style = getComputedStyle(chip)
    await expect(style.backgroundColor).toBe(fill ? painted(chip, fill) : CLEAR)
    await expect(style.color).toBe(painted(chip, words, 'color'))
    await expect([style.paddingTop, style.borderRadius, getComputedStyle(chip.querySelector('span')!).fontSize]).toEqual(big ? ['16px', '4px', '14px'] : ['8px', '4px', '12px'])
    await expect(chip.getBoundingClientRect().width).toBe(80)
  }
}

/** A size that is gone: the line through it, 16px of Text/Muted Primary across its middle. */
const struck = async (canvasElement: HTMLElement) => {
  for (const chip of chips(canvasElement)) {
    const line = chip.querySelector<HTMLElement>('span[aria-hidden="true"]:empty')!
    const [box, at] = [chip.getBoundingClientRect(), line.getBoundingClientRect()]
    await expect([at.width, at.height]).toEqual([16, 1])
    await expect(Math.abs((at.left + at.right) / 2 - (box.left + box.right) / 2)).toBeLessThanOrEqual(0.5)
    await expect(getComputedStyle(line).backgroundColor).toBe(painted(chip, 'bg-text-muted-primary'))
  }
}

export const SmallDefault: Story = {
  name: 'State=default, Big=no',
  play: async ({ canvasElement }) => looks(canvasElement, null, 'text-text-primary', false),
}

export const SmallHover: Story = {
  name: 'State=hover, Big=no',
  globals: { pseudo: 'hover' },
  play: async ({ canvasElement }) => looks(canvasElement, 'bg-surface-card-selected', 'text-text-primary', false),
}

/** Out of stock: muted, struck through, and it can't be pressed; a mouse over it changes nothing (drawn here as under one). */
export const SmallOutOfStock: Story = {
  name: 'State=OOS, Big=no',
  args: { available: false },
  globals: { pseudo: 'hover' },
  play: async ({ canvasElement }) => {
    await looks(canvasElement, null, 'text-text-muted-primary', false)
    await struck(canvasElement)
    for (const chip of chips(canvasElement)) await expect(chip).toBeDisabled()
  },
}

export const SmallSelected: Story = {
  name: 'State=selected, Big=no',
  args: { selected: true },
  play: async ({ canvasElement }) => {
    await looks(canvasElement, 'bg-surface-secondary', 'text-text-secondary', false)
    for (const chip of chips(canvasElement)) await expect(chip.getAttribute('aria-pressed')).toBe('true')
  },
}

export const BigDefault: Story = {
  name: 'State=default, Big=yes',
  args: { big: true },
  play: async ({ canvasElement }) => looks(canvasElement, 'bg-surface-card', 'text-text-primary', true),
}

export const BigHover: Story = {
  name: 'State=hover, Big=yes',
  args: { big: true },
  globals: { pseudo: 'hover' },
  play: async ({ canvasElement }) => looks(canvasElement, 'bg-surface-card-selected', 'text-text-primary', true),
}

/** Sold out: Surface/Card Disabled, muted and struck through, and it can't be picked (drawn here as under a mouse, which changes nothing). */
export const BigSoldOut: Story = {
  name: 'State=sold out, Big=yes',
  args: { big: true, available: false },
  globals: { pseudo: 'hover' },
  play: async ({ canvasElement }) => {
    await looks(canvasElement, 'bg-surface-card-disabled', 'text-text-muted-primary', true)
    await struck(canvasElement)
    for (const chip of chips(canvasElement)) {
      await expect(chip.querySelector('input')).toBeDisabled()
      await expect(chip.querySelector('input')).toHaveAccessibleName('S, sold out')
    }
  },
}

export const BigSelected: Story = {
  name: 'State=selected, Big=yes',
  args: { big: true, selected: true },
  play: async ({ canvasElement }) => {
    await looks(canvasElement, 'bg-surface-secondary', 'text-text-secondary', true)
    for (const chip of chips(canvasElement)) await expect(chip.querySelector('input')).toBeChecked()
  },
}
