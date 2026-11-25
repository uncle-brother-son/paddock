import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { expect } from 'storybook/test'

import { IconButton } from './IconButton'
import { CLEAR, InBothModes, inEachMode, painted } from './story-kit'

// Figma "IconButton" (03 UI, 608:2593): a story for each of Figma's five variants, under Figma's name for it.

const meta = {
  title: 'UI/IconButton',
  component: IconButton,
  parameters: { padded: false },
  args: { icon: 'plus', label: 'One more' },
  render: (args) => (
    <InBothModes>
      <IconButton {...args} />
    </InBothModes>
  ),
} satisfies Meta<typeof IconButton>

export default meta
type Story = StoryObj<typeof meta>

const buttons = (canvasElement: HTMLElement) => inEachMode<HTMLButtonElement>(canvasElement, 'button')

/** 8px round the 9px icon: 25px square, with 4px corners, nothing behind it, its icon in Text/Primary. */
export const PageDefault: Story = {
  name: 'State=default, Style=page',
  play: async ({ canvasElement }) => {
    const found = buttons(canvasElement)
    await expect(found).toHaveLength(2)
    for (const button of found) {
      const box = button.getBoundingClientRect()
      await expect([box.width, box.height]).toEqual([25, 25])
      await expect(getComputedStyle(button).borderRadius).toBe('4px')
      await expect(getComputedStyle(button).backgroundColor).toBe(CLEAR)
      await expect(getComputedStyle(button).color).toBe(painted(button, 'text-text-primary', 'color'))
      await expect(button).toHaveAccessibleName('One more')
    }
  },
}

/** Under a mouse: Surface/Card Selected behind it. */
export const PageHover: Story = {
  name: 'State=hover, Style=page',
  globals: { pseudo: 'hover' },
  play: async ({ canvasElement }) => {
    for (const button of buttons(canvasElement)) {
      await expect(getComputedStyle(button).backgroundColor).not.toBe(CLEAR)
      await expect(getComputedStyle(button).backgroundColor).toBe(painted(button, 'bg-surface-card-selected'))
    }
  },
}

/** Disabled: its icon in Text/Muted Primary, and a mouse over it changes nothing (drawn here as under one). */
export const PageDisabled: Story = {
  name: 'State=disabled, Style=page',
  args: { disabled: true },
  globals: { pseudo: 'hover' },
  play: async ({ canvasElement }) => {
    for (const button of buttons(canvasElement)) {
      await expect(button).toBeDisabled()
      await expect(getComputedStyle(button).backgroundColor).toBe(CLEAR)
      await expect(getComputedStyle(button).color).toBe(painted(button, 'text-text-muted-primary', 'color'))
    }
  },
}

/** Over a picture or a film: 8px round a 12px icon (28px square), Text/Secondary on Text/Muted Primary. */
export const ImageDefault: Story = {
  name: 'State=default, Style=image',
  args: { look: 'image', icon: 'pause', label: 'Pause video' },
  play: async ({ canvasElement }) => {
    for (const button of buttons(canvasElement)) {
      const box = button.getBoundingClientRect()
      await expect([box.width, box.height]).toEqual([28, 28])
      await expect(getComputedStyle(button).backgroundColor).toBe(painted(button, 'bg-text-muted-primary'))
      await expect(getComputedStyle(button).color).toBe(painted(button, 'text-text-secondary', 'color'))
    }
  },
}

/** Under a mouse: on Text/Primary. */
export const ImageHover: Story = {
  name: 'State=hover, Style=image',
  args: { look: 'image', icon: 'pause', label: 'Pause video' },
  globals: { pseudo: 'hover' },
  play: async ({ canvasElement }) => {
    for (const button of buttons(canvasElement)) {
      await expect(getComputedStyle(button).backgroundColor).toBe(painted(button, 'bg-text-primary'))
    }
  },
}
