import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { useState, type ComponentProps } from 'react'
import { expect, fn, userEvent, waitFor } from 'storybook/test'

import { InBothModes, inEachMode, painted } from '@/components/ui/story-kit'

import { CodeInput } from './CodeInput'

// Figma "CodeInput" (03 UI, 1174:12397): a story for each of Figma's two variants, under Figma's name for it.

/** The code input holding its own digits, as a form would. */
function Held({ value: start, onValue, ...rest }: ComponentProps<typeof CodeInput>) {
  const [value, setValue] = useState(start)
  return (
    <CodeInput
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
  title: 'UI/Form controls/CodeInput',
  component: CodeInput,
  parameters: { padded: false },
  args: { label: 'Sign-in code', value: '', onValue: fn() },
  // Figma's own width for it.
  render: (args) => (
    <InBothModes width="w-[836px]">
      <Held {...args} />
    </InBothModes>
  ),
} satisfies Meta<typeof CodeInput>

export default meta
type Story = StoryObj<typeof meta>

const groups = (canvasElement: HTMLElement) => inEachMode(canvasElement, '[data-code-input]')
const fieldsOf = (group: HTMLElement) => [...group.querySelectorAll('input')]
const digitsIn = (group: HTMLElement) => fieldsOf(group).map((field) => field.value)

/**
 * Six fields 8px apart, sharing the width, each on Surface/Card with 4px corners, as tall as an Input. The one with
 * focus is Surface/Card Selected: the first here, in Light (only one field of a page has focus).
 */
export const Default: Story = {
  name: 'State=default',
  play: async ({ canvasElement }) => {
    await document.fonts.ready
    const found = groups(canvasElement)
    await expect(found).toHaveLength(2)
    for (const group of found) {
      await expect(group).toHaveRole('group')
      await expect(group).toHaveAccessibleName('Sign-in code')
      await expect(getComputedStyle(group).columnGap).toBe('8px')
      const fields = fieldsOf(group)
      await expect(fields.map((field) => field.getAttribute('aria-label'))).toEqual(['Digit 1 of 6', 'Digit 2 of 6', 'Digit 3 of 6', 'Digit 4 of 6', 'Digit 5 of 6', 'Digit 6 of 6'])
      // Each is a sixth of what the five gaps leave: (836 - 5 x 8) / 6, Figma's 132.67.
      await expect(group.getBoundingClientRect().width).toBe(836)
      await expect(fields.map((field) => Math.round(field.getBoundingClientRect().width * 10) / 10)).toEqual([132.7, 132.7, 132.7, 132.7, 132.7, 132.7])
      for (const field of fields) {
        const style = getComputedStyle(field)
        await expect([style.borderRadius, style.paddingLeft, style.paddingRight, style.textAlign, style.fontSize]).toEqual(['4px', '8px', '6px', 'center', '14px'])
        await expect(Math.round(field.getBoundingClientRect().height)).toBe(42)
        await expect([field.autocomplete, field.inputMode, field.getAttribute('aria-invalid')]).toEqual(['one-time-code', 'numeric', 'false'])
      }
      await expect(getComputedStyle(fields[1]!).backgroundColor).toBe(painted(group, 'bg-surface-card'))
    }
    const first = fieldsOf(found[0]!)[0]!
    first.focus()
    // The colour is read before the wait: `painted` changes the document, and a wait looks again at every change.
    const withFocus = painted(found[0]!, 'bg-surface-card-selected')
    await waitFor(() => expect(getComputedStyle(first).backgroundColor).toBe(withFocus))
    // A field shows its designed focus state in place of the ring.
    await expect(getComputedStyle(first).outlineStyle).toBe('none')
  },
}

/** The code was refused: every field on Surface/Card Error, its digits in Text/Primary. */
export const Refused: Story = {
  name: 'State=error',
  args: { value: '123456', invalid: true },
  play: async ({ canvasElement }) => {
    for (const group of groups(canvasElement)) {
      await expect(digitsIn(group)).toEqual(['1', '2', '3', '4', '5', '6'])
      for (const field of fieldsOf(group)) {
        await expect(getComputedStyle(field).backgroundColor).toBe(painted(group, 'bg-surface-card-error'))
        await expect(getComputedStyle(field).color).toBe(painted(group, 'text-text-primary', 'color'))
        await expect(field.getAttribute('aria-invalid')).toBe('true')
      }
    }
  },
}

/** Typing: a digit moves on to the next field, anything else is left out, Backspace clears and then goes back, the arrows move. */
export const Typing: Story = {
  play: async ({ canvasElement, args }) => {
    const [group] = groups(canvasElement) as [HTMLElement]
    const fields = fieldsOf(group)
    await userEvent.tab()
    await expect(fields[0]).toHaveFocus()
    await userEvent.keyboard('12a3')
    await expect(digitsIn(group)).toEqual(['1', '2', '3', '', '', ''])
    await expect(fields[3]).toHaveFocus()
    await userEvent.keyboard('456')
    await expect(digitsIn(group)).toEqual(['1', '2', '3', '4', '5', '6'])
    await expect(args.onValue).toHaveBeenLastCalledWith('123456')
    // The last field keeps focus once the code is whole.
    await expect(fields[5]).toHaveFocus()
    // Backspace clears the field it is in, then goes back a field and clears that.
    await userEvent.keyboard('{Backspace}')
    await expect(digitsIn(group)).toEqual(['1', '2', '3', '4', '5', ''])
    await expect(fields[5]).toHaveFocus()
    await userEvent.keyboard('{Backspace}')
    await expect(digitsIn(group)).toEqual(['1', '2', '3', '4', '', ''])
    await expect(fields[4]).toHaveFocus()
    // Left and Right move between the fields; a digit typed over another takes its place.
    await userEvent.keyboard('{ArrowLeft}{ArrowLeft}{ArrowLeft}')
    await expect(fields[1]).toHaveFocus()
    await userEvent.keyboard('9')
    await expect(digitsIn(group)).toEqual(['1', '9', '3', '4', '', ''])
    await expect(fields[2]).toHaveFocus()
    await userEvent.keyboard('{ArrowRight}')
    await expect(fields[3]).toHaveFocus()
  },
}

/** A code pasted, or filled in by the phone, fills every field from the first, whichever field it arrives at. */
export const Pasting: Story = {
  play: async ({ canvasElement, args }) => {
    const [group] = groups(canvasElement) as [HTMLElement]
    const fields = fieldsOf(group)
    fields[2]!.focus()
    await userEvent.paste('654 321')
    await expect(digitsIn(group)).toEqual(['6', '5', '4', '3', '2', '1'])
    await expect(args.onValue).toHaveBeenLastCalledWith('654321')
    await expect(fields[5]).toHaveFocus()
    // Part of a code goes on from the field it arrives at.
    await userEvent.keyboard('{Backspace}{Backspace}{Backspace}')
    await expect(digitsIn(group)).toEqual(['6', '5', '4', '', '', ''])
    await expect(fields[3]).toHaveFocus()
    await userEvent.paste('78')
    await expect(digitsIn(group)).toEqual(['6', '5', '4', '7', '8', ''])
    await expect(fields[5]).toHaveFocus()
  },
}
