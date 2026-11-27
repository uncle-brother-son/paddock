import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { expect, fn, userEvent } from 'storybook/test'

import { InBothModes, inEachMode, painted } from '@/components/ui/story-kit'

import { BigButton, BigSecondaryButton, Button, SecondaryButton } from './Button'

// Figma "Button" (03 UI, 329:7955): a story for each of Figma's sixteen variants, under Figma's name for it.

type SampleProps = {
  /** Figma's Type. */
  kind: 'primary' | 'secondary'
  /** Figma's Big. */
  big: boolean
  loading?: boolean
  disabled?: boolean
  onPress: () => void
}

/** The site's four buttons, picked as Figma picks a variant. */
function Sample({ kind, big, loading = false, disabled = false, onPress }: SampleProps) {
  const Drawn = kind === 'primary' ? (big ? BigButton : Button) : big ? BigSecondaryButton : SecondaryButton
  return (
    <Drawn loading={loading} disabled={disabled} onClick={onPress}>
      Label
    </Drawn>
  )
}

const meta = {
  title: 'UI/Buttons/Button',
  component: Sample,
  parameters: { padded: false },
  args: { kind: 'primary', big: false, onPress: fn() },
  // Big=Yes is the whole width of what holds it on the site: here, 240px.
  render: (args) => (
    <InBothModes {...(args.big ? { width: 'w-240' } : {})}>
      <Sample {...args} />
    </InBothModes>
  ),
} satisfies Meta<typeof Sample>

export default meta
type Story = StoryObj<typeof meta>

const buttons = (canvasElement: HTMLElement) => inEachMode<HTMLButtonElement>(canvasElement, 'button')

/** The fill and the label's colour of every button in the story, each against its own mode's tokens. */
const looks = async (canvasElement: HTMLElement, fill: string, words: string) => {
  const found = buttons(canvasElement)
  await expect(found).toHaveLength(2)
  for (const button of found) {
    await expect(getComputedStyle(button).backgroundColor).toBe(painted(button, fill))
    await expect(getComputedStyle(button).color).toBe(painted(button, words, 'color'))
    await expect(getComputedStyle(button).borderRadius).toBe('4px')
    await expect([getComputedStyle(button).paddingLeft, getComputedStyle(button).paddingTop]).toEqual(['32px', '12px'])
  }
}

/** Big=Yes: Figma's 42px is the scale's 40 (W73). Big=No: 12px above and below the capitals of Label 12. */
const sized = async (canvasElement: HTMLElement, big: boolean) => {
  for (const button of buttons(canvasElement)) {
    const { height } = button.getBoundingClientRect()
    if (big) await expect(height).toBe(40)
    else await expect(Math.round(height)).toBeGreaterThanOrEqual(32)
    if (!big) await expect(Math.round(height)).toBeLessThanOrEqual(33)
  }
}

/** Loading: it says "Loading", a screen reader hears it is busy, and a press does nothing. */
const busy = async (canvasElement: HTMLElement, onPress: unknown) => {
  for (const button of buttons(canvasElement)) {
    await expect(button).toHaveTextContent('Loading')
    await expect([button.getAttribute('aria-busy'), button.getAttribute('aria-disabled')]).toEqual(['true', 'true'])
    await userEvent.click(button)
  }
  await expect(onPress).not.toHaveBeenCalled()
}

export const PrimaryBigDefault: Story = {
  name: 'Type=primary, Big=Yes, State=default',
  args: { big: true },
  play: async ({ canvasElement, args }) => {
    await looks(canvasElement, 'bg-surface-secondary', 'text-text-secondary')
    await sized(canvasElement, true)
    await userEvent.click(buttons(canvasElement)[0]!)
    await expect(args.onPress).toHaveBeenCalledTimes(1)
  },
}

export const PrimarySmallDefault: Story = {
  name: 'Type=primary, Big=No, State=default',
  play: async ({ canvasElement }) => {
    await looks(canvasElement, 'bg-surface-secondary', 'text-text-secondary')
    await sized(canvasElement, false)
  },
}

/** Figma draws a primary button's hover the same as its rest. */
export const PrimaryBigHover: Story = {
  name: 'Type=primary, Big=Yes, State=hover',
  args: { big: true },
  globals: { pseudo: 'hover' },
  play: async ({ canvasElement }) => looks(canvasElement, 'bg-surface-secondary', 'text-text-secondary'),
}

export const PrimarySmallHover: Story = {
  name: 'Type=primary, Big=No, State=hover',
  globals: { pseudo: 'hover' },
  play: async ({ canvasElement }) => looks(canvasElement, 'bg-surface-secondary', 'text-text-secondary'),
}

export const SecondaryBigDefault: Story = {
  name: 'Type=secondary, Big=Yes, State=default',
  args: { kind: 'secondary', big: true },
  play: async ({ canvasElement }) => {
    await looks(canvasElement, 'bg-surface-card', 'text-text-primary')
    await sized(canvasElement, true)
  },
}

export const SecondarySmallDefault: Story = {
  name: 'Type=secondary, Big=No, State=default',
  args: { kind: 'secondary' },
  play: async ({ canvasElement }) => {
    await looks(canvasElement, 'bg-surface-card', 'text-text-primary')
    await sized(canvasElement, false)
  },
}

/** Under a mouse a secondary button is Surface/Card Selected. */
export const SecondaryBigHover: Story = {
  name: 'Type=secondary, Big=Yes, State=hover',
  args: { kind: 'secondary', big: true },
  globals: { pseudo: 'hover' },
  play: async ({ canvasElement }) => looks(canvasElement, 'bg-surface-card-selected', 'text-text-primary'),
}

export const SecondarySmallHover: Story = {
  name: 'Type=secondary, Big=No, State=hover',
  args: { kind: 'secondary' },
  globals: { pseudo: 'hover' },
  play: async ({ canvasElement }) => looks(canvasElement, 'bg-surface-card-selected', 'text-text-primary'),
}

/** Loading: "Loading" in Text/Muted Secondary on the same fill. */
export const PrimaryBigLoading: Story = {
  name: 'Type=primary, Big=Yes, State=loading',
  args: { big: true, loading: true },
  play: async ({ canvasElement, args }) => {
    await looks(canvasElement, 'bg-surface-secondary', 'text-text-muted-secondary')
    await busy(canvasElement, args.onPress)
  },
}

export const PrimarySmallLoading: Story = {
  name: 'Type=primary, Big=No, State=loading',
  args: { loading: true },
  play: async ({ canvasElement, args }) => {
    await looks(canvasElement, 'bg-surface-secondary', 'text-text-muted-secondary')
    await busy(canvasElement, args.onPress)
  },
}

/** Loading: "Loading" in Text/Muted Primary on Surface/Card; a mouse over it changes nothing (drawn here as under one). */
export const SecondaryBigLoading: Story = {
  name: 'Type=secondary, Big=Yes, State=loading',
  args: { kind: 'secondary', big: true, loading: true },
  globals: { pseudo: 'hover' },
  play: async ({ canvasElement, args }) => {
    await looks(canvasElement, 'bg-surface-card', 'text-text-muted-primary')
    await busy(canvasElement, args.onPress)
  },
}

export const SecondarySmallLoading: Story = {
  name: 'Type=secondary, Big=No, State=loading',
  args: { kind: 'secondary', loading: true },
  globals: { pseudo: 'hover' },
  play: async ({ canvasElement, args }) => {
    await looks(canvasElement, 'bg-surface-card', 'text-text-muted-primary')
    await busy(canvasElement, args.onPress)
  },
}

/** Disabled, either type: Surface/Card Disabled with its label in Text/Muted Primary. */
export const PrimaryBigDisabled: Story = {
  name: 'Type=primary, Big=Yes, State=disabled',
  args: { big: true, disabled: true },
  play: async ({ canvasElement }) => {
    await looks(canvasElement, 'bg-surface-card-disabled', 'text-text-muted-primary')
    for (const button of buttons(canvasElement)) await expect(button).toBeDisabled()
  },
}

export const PrimarySmallDisabled: Story = {
  name: 'Type=primary, Big=No, State=disabled',
  args: { disabled: true },
  play: async ({ canvasElement }) => looks(canvasElement, 'bg-surface-card-disabled', 'text-text-muted-primary'),
}

/** A mouse over a disabled button changes nothing (drawn here as under one). */
export const SecondaryBigDisabled: Story = {
  name: 'Type=secondary, Big=Yes, State=disabled',
  args: { kind: 'secondary', big: true, disabled: true },
  globals: { pseudo: 'hover' },
  play: async ({ canvasElement }) => looks(canvasElement, 'bg-surface-card-disabled', 'text-text-muted-primary'),
}

export const SecondarySmallDisabled: Story = {
  name: 'Type=secondary, Big=No, State=disabled',
  args: { kind: 'secondary', disabled: true },
  globals: { pseudo: 'hover' },
  play: async ({ canvasElement }) => looks(canvasElement, 'bg-surface-card-disabled', 'text-text-muted-primary'),
}
