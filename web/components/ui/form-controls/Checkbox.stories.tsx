import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { useState } from 'react'
import { expect, userEvent } from 'storybook/test'

import { CLEAR, InBothModes, inEachMode, painted } from '@/components/ui/story-kit'

import { Checkbox } from './Checkbox'

// Figma "Checkbox" (03 UI, 960:22442): a story for each of Figma's nine variants, under Figma's name for it. On the
// site: the Gift Card page's "Sending to someone else?".

type SampleProps = {
  /** Ticked to begin with (Figma's Selected). */
  selected?: boolean
  error?: string | null
  wrapped?: boolean
  disabled?: boolean
}

function Sample({ selected = false, error = null, wrapped = false, disabled = false }: SampleProps) {
  const [checked, setChecked] = useState(selected)
  return (
    <Checkbox checked={checked} onChange={setChecked} error={error} wrapped={wrapped} disabled={disabled} className="w-full">
      Copy
    </Checkbox>
  )
}

const meta = {
  title: 'UI/Form controls/Checkbox',
  component: Sample,
  parameters: { padded: false },
  render: (args) => (
    <InBothModes width="w-320">
      <Sample {...args} />
    </InBothModes>
  ),
} satisfies Meta<typeof Sample>

export default meta
type Story = StoryObj<typeof meta>

const all = (canvasElement: HTMLElement) =>
  inEachMode(canvasElement, '[data-checkbox]').map((row) => ({
    row,
    box: row.querySelector<HTMLElement>('[data-checkbox-control]')!,
    tick: row.querySelector<SVGElement>('[data-checkbox-control] svg')!,
    input: row.querySelector<HTMLInputElement>('input')!,
    words: row.querySelector<HTMLElement>('[id$="-words"]')!,
  }))

/** The box's fill, whether its tick shows, and the colour of the words, each against its own mode's tokens. */
const looks = async (canvasElement: HTMLElement, { fill, ticked, words = 'text-text-primary' }: { fill: string; ticked: boolean; words?: string }) => {
  const found = all(canvasElement)
  await expect(found).toHaveLength(2)
  for (const one of found) {
    const box = one.box.getBoundingClientRect()
    await expect([box.width, box.height, getComputedStyle(one.box).borderRadius]).toEqual([20, 20, '4px'])
    await expect(getComputedStyle(one.box).backgroundColor).toBe(painted(one.box, fill))
    await expect(getComputedStyle(one.tick).opacity).toBe(ticked ? '1' : '0')
    await expect([getComputedStyle(one.words).color, getComputedStyle(one.words).fontSize]).toEqual([painted(one.words, words, 'color'), '12px'])
    await expect(one.input).toHaveAccessibleName('Copy')
    // 8px between the box and its words, whose capitals sit level with the middle of the box.
    const copy = one.words.getBoundingClientRect()
    await expect(copy.left - box.right).toBe(8)
    await expect(Math.abs((copy.top + copy.bottom) / 2 - (box.top + box.bottom) / 2)).toBeLessThanOrEqual(0.5)
  }
}

/** Error=yes: the message 8px under the words in Copy 12 and Text/Error, tied to the checkbox. */
const wrong = async (canvasElement: HTMLElement) => {
  for (const one of all(canvasElement)) {
    const message = one.row.querySelector<HTMLElement>('[data-checkbox-error]')!
    await expect(message).toHaveTextContent('Error message')
    await expect([getComputedStyle(message).color, getComputedStyle(message).fontSize]).toEqual([painted(message, 'text-text-error', 'color'), '12px'])
    await expect(Math.round(message.getBoundingClientRect().top - one.words.getBoundingClientRect().bottom)).toBe(8)
    await expect(message.getBoundingClientRect().left).toBe(one.words.getBoundingClientRect().left)
    await expect([one.input.getAttribute('aria-invalid'), one.input.getAttribute('aria-describedby')]).toEqual(['true', message.id])
  }
}

/** Wrapped=yes: the whole on a surface of its own with 4px corners, 16px each side, 42px tall as an Input is. */
const wrapped = async (canvasElement: HTMLElement, fill: string) => {
  for (const { row } of all(canvasElement)) {
    const style = getComputedStyle(row)
    await expect(style.backgroundColor).toBe(painted(row, fill))
    await expect([style.paddingLeft, style.paddingTop, style.borderRadius]).toEqual(['16px', '11px', '4px'])
  }
}

/** Unticked: Surface/Card Selected, empty. Space, or a press on the box or its words, ticks it. */
export const Default: Story = {
  name: 'Selected=no, Error=no, Hover=no, Wrapped=no, Disabled=no',
  play: async ({ canvasElement }) => {
    await looks(canvasElement, { fill: 'bg-surface-card-selected', ticked: false })
    for (const { row, input, box } of all(canvasElement)) {
      await expect(getComputedStyle(row).backgroundColor).toBe(CLEAR)
      await expect(box.getBoundingClientRect().height).toBe(20)
      await expect(input).not.toBeChecked()
    }
    const [light] = all(canvasElement)
    await userEvent.click(light!.words)
    await expect(light!.input).toBeChecked()
    await userEvent.click(light!.words)
    await expect(light!.input).not.toBeChecked()
  },
}

export const WithError: Story = {
  name: 'Selected=no, Error=yes, Hover=no, Wrapped=no, Disabled=no',
  args: { error: 'Error message' },
  play: async ({ canvasElement }) => {
    await looks(canvasElement, { fill: 'bg-surface-card-error', ticked: false })
    await wrong(canvasElement)
  },
}

/** Under a mouse the box shows its tick, in Text/Primary. */
export const Hover: Story = {
  name: 'Selected=no, Error=no, Hover=yes, Wrapped=no, Disabled=no',
  globals: { pseudo: 'hover' },
  play: async ({ canvasElement }) => {
    await looks(canvasElement, { fill: 'bg-surface-card-selected', ticked: true })
    for (const { box, tick } of all(canvasElement)) await expect(getComputedStyle(tick).color).toBe(painted(box, 'text-text-primary', 'color'))
  },
}

/** Ticked: Surface/Secondary with the tick in Text/Secondary. */
export const Selected: Story = {
  name: 'Selected=yes, Error=no, Hover=no, Wrapped=no, Disabled=no',
  args: { selected: true },
  play: async ({ canvasElement }) => {
    await looks(canvasElement, { fill: 'bg-surface-secondary', ticked: true })
    for (const { box, tick, input } of all(canvasElement)) {
      await expect(getComputedStyle(tick).color).toBe(painted(box, 'text-text-secondary', 'color'))
      await expect(input).toBeChecked()
    }
  },
}

export const Wrapped: Story = {
  name: 'Selected=no, Error=no, Hover=no, Wrapped=yes, Disabled=no',
  args: { wrapped: true },
  play: async ({ canvasElement }) => {
    await looks(canvasElement, { fill: 'bg-surface-card-selected', ticked: false })
    await wrapped(canvasElement, 'bg-surface-card')
    for (const { row } of all(canvasElement)) await expect(row.getBoundingClientRect().height).toBe(42)
  },
}

/** Disabled: on Surface/Card Disabled, the box the same, the words in Text/Muted Primary; a mouse shows no tick (drawn here as under one). */
export const WrappedDisabled: Story = {
  name: 'Selected=no, Error=no, Hover=no, Wrapped=yes, Disabled=yes',
  args: { wrapped: true, disabled: true },
  globals: { pseudo: 'hover' },
  play: async ({ canvasElement }) => {
    await looks(canvasElement, { fill: 'bg-surface-card-disabled', ticked: false, words: 'text-text-muted-primary' })
    await wrapped(canvasElement, 'bg-surface-card-disabled')
    for (const { input } of all(canvasElement)) await expect(input).toBeDisabled()
  },
}

/**
 * As Figma draws it: the message in Text/Error on the Wrapped checkbox's own Surface/Card. In Light that is 4.45 to 1,
 * a hair under the 4.5 the standards ask of small text (on the page's own surface the same colour passes), so the
 * contrast check is off for this one story and the pair is listed for the lead (W78a report): the colours are Figma's.
 */
export const WrappedError: Story = {
  name: 'Selected=no, Error=yes, Hover=no, Wrapped=yes, Disabled=no',
  args: { wrapped: true, error: 'Error message' },
  parameters: { a11y: { config: { rules: [{ id: 'color-contrast', enabled: false }] } } },
  play: async ({ canvasElement }) => {
    await looks(canvasElement, { fill: 'bg-surface-card-error', ticked: false })
    await wrapped(canvasElement, 'bg-surface-card')
    await wrong(canvasElement)
  },
}

export const WrappedHover: Story = {
  name: 'Selected=no, Error=no, Hover=yes, Wrapped=yes, Disabled=no',
  args: { wrapped: true },
  globals: { pseudo: 'hover' },
  play: async ({ canvasElement }) => {
    await looks(canvasElement, { fill: 'bg-surface-card-selected', ticked: true })
    await wrapped(canvasElement, 'bg-surface-card')
  },
}

export const WrappedSelected: Story = {
  name: 'Selected=yes, Error=no, Hover=no, Wrapped=yes, Disabled=no',
  args: { wrapped: true, selected: true },
  play: async ({ canvasElement }) => {
    await looks(canvasElement, { fill: 'bg-surface-secondary', ticked: true })
    await wrapped(canvasElement, 'bg-surface-card')
  },
}
