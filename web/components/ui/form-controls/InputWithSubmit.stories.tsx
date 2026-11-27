import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { useState } from 'react'
import { expect, fn, userEvent, waitFor } from 'storybook/test'

import { CLEAR, InBothModes, inEachMode, painted } from '@/components/ui/story-kit'

import { InputWithSubmit } from './InputWithSubmit'

// Figma "InputWithSubmit" (03 UI, 911:9431): a story for each of Figma's four states, under Figma's name for it. On
// the site it is the footer's newsletter field (components/frame/NewsletterForm.tsx).

type SampleProps = {
  /** What is typed in it to begin with: none for State=empty. */
  typed?: string
  error?: string | null
  onSend: (value: string) => void
}

function Sample({ typed = '', error = null, onSend }: SampleProps) {
  const [value, setValue] = useState(typed)
  return (
    <form
      noValidate
      className="w-full"
      onSubmit={(event) => {
        event.preventDefault()
        onSend(value)
      }}
    >
      <InputWithSubmit label="Label" submitLabel="Send" value={value} onValue={setValue} error={error} />
    </form>
  )
}

const meta = {
  title: 'UI/Form controls/InputWithSubmit',
  component: Sample,
  parameters: { padded: false },
  args: { onSend: fn() },
  render: (args) => (
    <InBothModes width="w-320">
      <Sample {...args} />
    </InBothModes>
  ),
} satisfies Meta<typeof Sample>

export default meta
type Story = StoryObj<typeof meta>

const fields = (canvasElement: HTMLElement) => inEachMode<HTMLInputElement>(canvasElement, 'input')

/** The field as drawn: the box round the words and the arrow, which is what carries the fill. */
const boxOf = (field: HTMLInputElement) => field.parentElement as HTMLElement
const arrowOf = (field: HTMLInputElement) => boxOf(field).querySelector('button') as HTMLButtonElement

/** Surface/Card with 4px corners, 16px to its left and 6px round the arrow; the prompt in Text/Muted Primary, the arrow with no fill. */
export const Empty: Story = {
  name: 'State=empty',
  play: async ({ canvasElement }) => {
    const found = fields(canvasElement)
    await expect(found).toHaveLength(2)
    for (const field of found) {
      const box = getComputedStyle(boxOf(field))
      await expect(box.backgroundColor).toBe(painted(boxOf(field), 'bg-surface-card'))
      await expect([box.paddingLeft, box.paddingRight, box.paddingTop, box.borderRadius]).toEqual(['16px', '6px', '6px', '4px'])
      await expect(field).toHaveAccessibleName('Label')
      await expect(getComputedStyle(field, '::placeholder').color).toBe(painted(field, 'text-text-muted-primary', 'color'))
      await expect(arrowOf(field)).toHaveAccessibleName('Send')
      await expect(getComputedStyle(arrowOf(field)).backgroundColor).toBe(CLEAR)
      // The arrow is the scale's 32px (Figma's 30; Wayne, 24 Nov), so the field is 44px tall.
      await expect(boxOf(field).getBoundingClientRect().height).toBe(44)
    }
  },
}

/**
 * With the cursor in it: Surface/Card Selected. Only one field of a page can have the cursor, so here it is put in
 * the Light one and then in the Dark one, where it stays.
 */
export const Focus: Story = {
  name: 'State=focus',
  play: async ({ canvasElement }) => {
    for (const field of fields(canvasElement)) {
      await userEvent.click(field)
      await expect(field).toHaveFocus()
      // The token's colour is read first: reading it inside the wait would change the page and start the wait again.
      const selected = painted(boxOf(field), 'bg-surface-card-selected')
      await waitFor(() => expect(getComputedStyle(boxOf(field)).backgroundColor).toBe(selected))
    }
  },
}

/** With something typed: the words in Text/Primary, and the arrow gains Surface/Card. Enter, or the arrow, sends it. */
export const Full: Story = {
  name: 'State=full',
  args: { typed: 'Input' },
  play: async ({ canvasElement, args }) => {
    for (const field of fields(canvasElement)) {
      await expect(field.value).toBe('Input')
      await expect(getComputedStyle(field).color).toBe(painted(field, 'text-text-primary', 'color'))
      await expect(getComputedStyle(boxOf(field)).backgroundColor).toBe(painted(boxOf(field), 'bg-surface-card'))
      await expect(getComputedStyle(arrowOf(field)).backgroundColor).toBe(painted(arrowOf(field), 'bg-surface-card'))
    }
    await userEvent.click(arrowOf(fields(canvasElement)[0]!))
    await expect(args.onSend).toHaveBeenCalledWith('Input')
  },
}

/** Something is wrong: Surface/Card Error, with the message 8px beneath in Copy 12 and Text/Error, tied to the field and read out at once. */
export const Wrong: Story = {
  name: 'State=error',
  args: { typed: 'Input', error: 'Error message' },
  play: async ({ canvasElement }) => {
    for (const field of fields(canvasElement)) {
      await expect(getComputedStyle(boxOf(field)).backgroundColor).toBe(painted(boxOf(field), 'bg-surface-card-error'))
      const message = field.closest('[data-input-with-submit]')!.querySelector<HTMLElement>('p')!
      await expect(message).toHaveTextContent('Error message')
      await expect(getComputedStyle(message).color).toBe(painted(field, 'text-text-error', 'color'))
      await expect(getComputedStyle(message).fontSize).toBe('12px')
      await expect(Math.round(message.getBoundingClientRect().top - boxOf(field).getBoundingClientRect().bottom)).toBe(8)
      await expect([field.getAttribute('aria-invalid'), field.getAttribute('aria-describedby')]).toEqual(['true', message.id])
      await expect(message.parentElement?.getAttribute('aria-live')).toBe('assertive')
    }
  },
}
