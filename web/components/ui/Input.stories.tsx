import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { useState } from 'react'
import { expect, userEvent, waitFor } from 'storybook/test'

import { TextInput } from './Field'
import { InBothModes, inEachMode, painted } from './story-kit'

// Figma "Input" (03 UI, 948:9227): a story for each of Figma's six variants, under Figma's name for it. On the site it
// is TextInput (components/ui/Field.tsx).

type SampleProps = {
  /** What is typed in it to begin with: none for State=empty. */
  typed?: string
  error?: string | null
  disabled?: boolean
}

function Sample({ typed = '', error = null, disabled = false }: SampleProps) {
  const [value, setValue] = useState(typed)
  return <TextInput label="Label" value={value} onValue={setValue} error={error} disabled={disabled} className="w-full" />
}

const meta = {
  title: 'UI/Input',
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

const fields = (canvasElement: HTMLElement) => inEachMode<HTMLInputElement>(canvasElement, 'input')

/** The fill of every field in the story, against its own mode's token. */
const filled = async (canvasElement: HTMLElement, fill: string) => {
  const found = fields(canvasElement)
  await expect(found).toHaveLength(2)
  for (const field of found) await expect(getComputedStyle(field).backgroundColor).toBe(painted(field, fill))
}

/** Error=yes: the message 8px beneath in Copy 12 and Text/Error, 16px in, tied to the field. */
const wrong = async (canvasElement: HTMLElement) => {
  for (const field of fields(canvasElement)) {
    const message = field.closest('[data-field]')!.querySelector<HTMLElement>('[data-field-error]')!
    await expect(message).toHaveTextContent('Error message')
    await expect(getComputedStyle(message).color).toBe(painted(field, 'text-text-error', 'color'))
    await expect([getComputedStyle(message).fontSize, getComputedStyle(message).marginTop, getComputedStyle(message).paddingLeft]).toEqual(['12px', '8px', '16px'])
    await expect([field.getAttribute('aria-invalid'), field.getAttribute('aria-describedby')]).toEqual(['true', message.id])
  }
}

/** Surface/Card with 4px corners, 16px to its left, 16px above and below the capitals of Copy 14; the prompt in Text/Muted Primary. */
export const Empty: Story = {
  name: 'State=empty, Error=no',
  play: async ({ canvasElement }) => {
    await filled(canvasElement, 'bg-surface-card')
    for (const field of fields(canvasElement)) {
      await expect([field.placeholder, field.value]).toEqual(['Label', ''])
      await expect(field).toHaveAccessibleName('Label')
      await expect([getComputedStyle(field).paddingLeft, getComputedStyle(field).borderRadius, getComputedStyle(field).fontSize]).toEqual(['16px', '4px', '14px'])
      await expect(getComputedStyle(field, '::placeholder').color).toBe(painted(field, 'text-text-muted-primary', 'color'))
      // Figma's 42px: 16, the capitals (10 in Figma), 16.
      await expect(Math.round(field.getBoundingClientRect().height)).toBeGreaterThanOrEqual(41)
      await expect(Math.round(field.getBoundingClientRect().height)).toBeLessThanOrEqual(42)
    }
  },
}

export const EmptyError: Story = {
  name: 'State=empty, Error=yes',
  args: { error: 'Error message' },
  play: async ({ canvasElement }) => {
    await filled(canvasElement, 'bg-surface-card-error')
    await wrong(canvasElement)
  },
}

/**
 * With the cursor in it: Surface/Card Selected. Only one field of a page can have the cursor, so here it is put in
 * the Light one and then in the Dark one, where it stays: press Tab or click to move it.
 */
export const Focus: Story = {
  name: 'State=focus, Error=no',
  play: async ({ canvasElement }) => {
    for (const field of fields(canvasElement)) {
      await userEvent.click(field)
      await expect(field).toHaveFocus()
      // The token's colour is read first: reading it inside the wait would change the page and start the wait again.
      const selected = painted(field, 'bg-surface-card-selected')
      await waitFor(() => expect(getComputedStyle(field).backgroundColor).toBe(selected))
    }
  },
}

/** With something typed: the words in Text/Primary. */
export const Full: Story = {
  name: 'State=full, Error=no',
  args: { typed: 'Input' },
  play: async ({ canvasElement }) => {
    await filled(canvasElement, 'bg-surface-card')
    for (const field of fields(canvasElement)) {
      await expect(field.value).toBe('Input')
      await expect(getComputedStyle(field).color).toBe(painted(field, 'text-text-primary', 'color'))
    }
  },
}

export const FullError: Story = {
  name: 'State=full, Error=yes',
  args: { typed: 'Input', error: 'Error message' },
  play: async ({ canvasElement }) => {
    await filled(canvasElement, 'bg-surface-card-error')
    await wrong(canvasElement)
  },
}

/** Disabled: Surface/Card Disabled with its words in Text/Muted Primary. */
export const Disabled: Story = {
  name: 'State=disabled, Error=no',
  args: { typed: 'Input', disabled: true },
  play: async ({ canvasElement }) => {
    await filled(canvasElement, 'bg-surface-card-disabled')
    for (const field of fields(canvasElement)) {
      await expect(field).toBeDisabled()
      await expect(getComputedStyle(field).color).toBe(painted(field, 'text-text-muted-primary', 'color'))
      await expect(getComputedStyle(field).opacity).toBe('1')
    }
  },
}
