import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { expect } from 'storybook/test'

import { Icon } from '@/components/brand/Icon'
import { CLEAR, InBothModes, inEachMode, painted } from '@/components/ui/story-kit'

import { FrameButton, FrameButtonLabel } from './FrameButton'

// Figma "MenuButton" (03 UI, 206:2915): a story for each of Figma's three states, under Figma's name for it. On the
// site it is FrameButton (the header's Menu, Book, Account and Bag, a panel's Close, the Shop's ALL and SORT, "All
// Events"). Figma's own drawing of it holds every part it can have at once, and so do these: the burger, the close
// icon, the label with a count, and the chevron.

function Sample({ selected }: { selected?: boolean }) {
  return (
    <FrameButton {...(selected === undefined ? {} : { selected })}>
      <Icon name="burger" />
      <Icon name="close" />
      <span className="flex items-center gap-4">
        <FrameButtonLabel>Label</FrameButtonLabel>
        <FrameButtonLabel>3</FrameButtonLabel>
      </span>
      <Icon name="chevron" />
    </FrameButton>
  )
}

const meta = {
  title: 'UI/Buttons/MenuButton',
  component: Sample,
  parameters: { padded: false },
  render: (args) => (
    <InBothModes>
      <Sample {...args} />
    </InBothModes>
  ),
} satisfies Meta<typeof Sample>

export default meta
type Story = StoryObj<typeof meta>

const buttons = (canvasElement: HTMLElement) => inEachMode<HTMLButtonElement>(canvasElement, 'button')

/** 8px all round with 4px corners, its parts 8px apart, 25px tall; Text/Primary with nothing behind it. */
export const Default: Story = {
  name: 'State=default',
  play: async ({ canvasElement }) => {
    const found = buttons(canvasElement)
    await expect(found).toHaveLength(2)
    for (const button of found) {
      const style = getComputedStyle(button)
      await expect([style.paddingTop, style.paddingLeft, style.columnGap, style.borderRadius]).toEqual(['8px', '8px', '8px', '4px'])
      await expect(button.getBoundingClientRect().height).toBe(25)
      await expect(style.backgroundColor).toBe(CLEAR)
      await expect(style.color).toBe(painted(button, 'text-text-primary', 'color'))
    }
  },
}

/** One of several that is not the one chosen: its icons and words in Text/Muted Primary. */
export const NotSelected: Story = {
  name: 'State=not selected',
  args: { selected: false },
  play: async ({ canvasElement }) => {
    for (const button of buttons(canvasElement)) {
      await expect(getComputedStyle(button).backgroundColor).toBe(CLEAR)
      await expect(getComputedStyle(button).color).toBe(painted(button, 'text-text-muted-primary', 'color'))
      // The icons are drawn in the colour of the words.
      await expect(getComputedStyle(button.querySelector('svg')!).color).toBe(getComputedStyle(button).color)
    }
  },
}

/** Under a mouse: Surface/Card Selected behind it. */
export const Hover: Story = {
  name: 'State=hover',
  globals: { pseudo: 'hover' },
  play: async ({ canvasElement }) => {
    for (const button of buttons(canvasElement)) {
      await expect(getComputedStyle(button).backgroundColor).toBe(painted(button, 'bg-surface-card-selected'))
      await expect(getComputedStyle(button).color).toBe(painted(button, 'text-text-primary', 'color'))
    }
  },
}
