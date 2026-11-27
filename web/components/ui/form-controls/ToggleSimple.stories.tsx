import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { useState, type ComponentProps } from 'react'
import { expect, fn, userEvent, waitFor } from 'storybook/test'

import { InBothModes, inEachMode, painted } from '@/components/ui/story-kit'
import { ToggleSimple } from './ToggleSimple'

// Figma "toggle - simple" (03 UI, 882:4637): a story for each of Figma's two variants, under Figma's name for it.

/** The switch holding its own state. */
function Held({ on: start, onChange, ...rest }: ComponentProps<typeof ToggleSimple>) {
  const [on, setOn] = useState(start)
  return (
    <ToggleSimple
      {...rest}
      on={on}
      onChange={(next) => {
        setOn(next)
        onChange(next)
      }}
    />
  )
}

const meta = {
  title: 'UI/Form controls/ToggleSimple',
  component: ToggleSimple,
  parameters: { padded: false },
  args: { on: false, label: 'Email reminders', onChange: fn() },
  render: (args) => (
    <InBothModes>
      <Held {...args} />
    </InBothModes>
  ),
} satisfies Meta<typeof ToggleSimple>

export default meta
type Story = StoryObj<typeof meta>

const switches = (canvasElement: HTMLElement) => inEachMode(canvasElement, '[data-toggle-simple]')
const squareOf = (track: HTMLElement) => track.children[0] as HTMLElement

/** Off: 40 by 20 on Surface/Card Selected with 4px corners, and the 16px square in Text/Primary 2px in at its left. */
export const Off: Story = {
  name: 'On=No',
  play: async ({ canvasElement }) => {
    const found = switches(canvasElement)
    await expect(found).toHaveLength(2)
    for (const track of found) {
      const square = squareOf(track)
      const [box, squareBox] = [track.getBoundingClientRect(), square.getBoundingClientRect()]
      await expect([box.width, box.height, getComputedStyle(track).borderRadius]).toEqual([40, 20, '4px'])
      await expect([squareBox.width, squareBox.height, getComputedStyle(square).borderRadius]).toEqual([16, 16, '4px'])
      await expect([squareBox.left - box.left, squareBox.top - box.top]).toEqual([2, 2])
      await expect(getComputedStyle(track).backgroundColor).toBe(painted(track, 'bg-surface-card-selected'))
      await expect(getComputedStyle(square).backgroundColor).toBe(painted(track, 'bg-text-primary'))
      const control = track.querySelector('input')!
      await expect(control).toHaveRole('switch')
      await expect(control).toHaveAccessibleName('Email reminders')
      await expect(control).not.toBeChecked()
      // The press reaches 2px above and below the switch: 24px.
      await expect([control.getBoundingClientRect().height, box.top - control.getBoundingClientRect().top]).toEqual([24, 2])
    }
  },
}

/** On: Text/Primary, and the square in Surface/Primary 2px in at its right. */
export const On: Story = {
  name: 'On=Yes',
  args: { on: true },
  play: async ({ canvasElement }) => {
    for (const track of switches(canvasElement)) {
      const square = squareOf(track)
      const [box, squareBox] = [track.getBoundingClientRect(), square.getBoundingClientRect()]
      await expect([box.right - squareBox.right, squareBox.top - box.top]).toEqual([2, 2])
      await expect(getComputedStyle(track).backgroundColor).toBe(painted(track, 'bg-text-primary'))
      await expect(getComputedStyle(square).backgroundColor).toBe(painted(track, 'bg-surface-primary'))
      await expect(track.querySelector('input')).toBeChecked()
    }
  },
}

/** By the keyboard: Tab reaches it, Space switches it on and off again; the square slides across each time. */
export const Keyboard: Story = {
  play: async ({ canvasElement, args }) => {
    const [track] = switches(canvasElement) as [HTMLElement]
    const control = track.querySelector('input')!
    const square = squareOf(track)
    await userEvent.tab()
    await expect(control).toHaveFocus()
    await expect([getComputedStyle(track).outlineStyle, getComputedStyle(track).outlineWidth, getComputedStyle(track).outlineOffset]).toEqual(['solid', '2px', '2px'])
    await userEvent.keyboard(' ')
    await expect(control).toBeChecked()
    await expect(args.onChange).toHaveBeenLastCalledWith(true)
    await waitFor(() => expect(track.getBoundingClientRect().right - square.getBoundingClientRect().right).toBe(2))
    // The colour is read before the wait: `painted` changes the document, and a wait looks again at every change.
    const whenOn = painted(track, 'bg-text-primary')
    await waitFor(() => expect(getComputedStyle(track).backgroundColor).toBe(whenOn))
    await userEvent.keyboard(' ')
    await expect(control).not.toBeChecked()
    await expect(args.onChange).toHaveBeenLastCalledWith(false)
    await waitFor(() => expect(square.getBoundingClientRect().left - track.getBoundingClientRect().left).toBe(2))
  },
}
