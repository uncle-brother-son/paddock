import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { useState, type ComponentProps } from 'react'
import { expect, fn, userEvent } from 'storybook/test'

import { InBothModes, inEachMode, painted } from '@/components/ui/story-kit'

import { Select } from './Select'

// Figma "Select" (03 UI, 947:3179): a story for each of Figma's three variants, under Figma's name for it.

/** The Select holding its own choice, as a form would. */
function Chosen({ value: start, onValue, ...rest }: ComponentProps<typeof Select>) {
  const [value, setValue] = useState(start)
  return (
    <Select
      {...rest}
      value={value}
      onValue={(next) => {
        setValue(next)
        onValue(next)
      }}
      className="w-full"
    />
  )
}

const meta = {
  title: 'UI/Form controls/Select',
  component: Select,
  parameters: { padded: false },
  args: {
    label: 'Label',
    value: '',
    options: [
      { value: 'standard', label: 'Standard delivery' },
      { value: 'express', label: 'Express delivery' },
      { value: 'collect', label: 'Collect from the Paddock' },
    ],
    onValue: fn(),
  },
  // Figma's own width for it.
  render: (args) => (
    <InBothModes width="w-[411px]">
      <Chosen {...args} />
    </InBothModes>
  ),
} satisfies Meta<typeof Select>

export default meta
type Story = StoryObj<typeof meta>

/** What is drawn: the row with its fill, inside the element that paints Surface/Primary beneath it. */
const rows = (canvasElement: HTMLElement) => inEachMode(canvasElement, '[data-select] > div')

/**
 * Surface/Card over Surface/Primary with 4px corners, its words in Copy 14 and Text/Primary 16px in, and the chevron
 * in a square on Surface/Card, 6px in from the top, right and bottom. As tall as an Input.
 */
export const Default: Story = {
  name: 'State=default',
  play: async ({ canvasElement }) => {
    await document.fonts.ready
    const found = rows(canvasElement)
    await expect(found).toHaveLength(2)
    for (const row of found) {
      const style = getComputedStyle(row)
      await expect(getComputedStyle(row.parentElement!).backgroundColor).toBe(painted(row.parentElement!, 'bg-surface-primary'))
      await expect(style.backgroundColor).toBe(painted(row, 'bg-surface-card'))
      await expect([style.borderRadius, style.paddingLeft, style.paddingTop, style.paddingRight, style.paddingBottom]).toEqual(['4px', '16px', '6px', '6px', '6px'])
      await expect(row.getBoundingClientRect().width).toBe(411)
      const [words, square] = [row.children[0] as HTMLElement, row.children[1] as HTMLElement]
      await expect(words).toHaveTextContent('Label')
      await expect([getComputedStyle(words).fontSize, getComputedStyle(words).color]).toEqual(['14px', painted(row, 'text-text-primary', 'color')])
      // The square is what the 6px leaves of the row's height, and as wide as it is tall.
      const [rowBox, squareBox] = [row.getBoundingClientRect(), square.getBoundingClientRect()]
      await expect(Math.round((rowBox.height - squareBox.height) * 100) / 100).toBe(12)
      await expect(Math.round((squareBox.width - squareBox.height) * 100) / 100).toBe(0)
      await expect(Math.round((rowBox.right - squareBox.right) * 100) / 100).toBe(6)
      await expect([getComputedStyle(square).backgroundColor, getComputedStyle(square).borderRadius]).toEqual([painted(row, 'bg-surface-card'), '4px'])
      // As tall as an Input: 16px above and below Copy 14's capitals (Figma: 42px).
      await expect(Math.round(rowBox.height)).toBe(42)
      const select = row.querySelector('select')!
      await expect(select).toHaveAccessibleName('Label')
      await expect(select).toBeEnabled()
    }
  },
}

/** Under a mouse: Surface/Card Selected. */
export const Hover: Story = {
  name: 'State=hover',
  globals: { pseudo: 'hover' },
  play: async ({ canvasElement }) => {
    for (const row of rows(canvasElement)) {
      await expect(getComputedStyle(row).backgroundColor).toBe(painted(row, 'bg-surface-card-selected'))
      // The chevron's square keeps its own Surface/Card.
      await expect(getComputedStyle(row.children[1]!).backgroundColor).toBe(painted(row, 'bg-surface-card'))
    }
  },
}

/** Disabled: Surface/Card Disabled, its words and its chevron in Text/Muted Primary; a mouse over it changes nothing (drawn here as under one). */
export const Disabled: Story = {
  name: 'State=disabled',
  args: { disabled: true },
  globals: { pseudo: 'hover' },
  play: async ({ canvasElement }) => {
    for (const row of rows(canvasElement)) {
      await expect(getComputedStyle(row).backgroundColor).toBe(painted(row, 'bg-surface-card-disabled'))
      const muted = painted(row, 'text-text-muted-primary', 'color')
      await expect([getComputedStyle(row.children[0]!).color, getComputedStyle(row.querySelector('svg')!).color]).toEqual([muted, muted])
      await expect(getComputedStyle(row.children[1]!).backgroundColor).toBe(painted(row, 'bg-surface-card'))
      await expect(row.querySelector('select')).toBeDisabled()
    }
  },
}

/** Choosing: the browser's own list, by the keyboard or a press; the words drawn are those of the choice made. */
export const Choosing: Story = {
  play: async ({ canvasElement, args }) => {
    const [row] = rows(canvasElement) as [HTMLElement]
    const select = row.querySelector('select')!
    // The prompt is the list's first line until a choice is made, and can't be chosen.
    await expect([...select.options].map((option) => [option.label, option.disabled])).toEqual([
      ['Label', true],
      ['Standard delivery', false],
      ['Express delivery', false],
      ['Collect from the Paddock', false],
    ])
    await userEvent.tab()
    await expect(select).toHaveFocus()
    await userEvent.selectOptions(select, 'express')
    await expect(args.onValue).toHaveBeenCalledWith('express')
    await expect(row.children[0]).toHaveTextContent('Express delivery')
    await expect([...select.options].map((option) => option.label)).toEqual(['Standard delivery', 'Express delivery', 'Collect from the Paddock'])
  },
}
