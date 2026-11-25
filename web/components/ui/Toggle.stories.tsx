import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { useId, useState } from 'react'
import { expect, userEvent, waitFor } from 'storybook/test'

import { DURATION_SHORT, EASE_SMOOTH_CSS, linearEasingPoints } from '@/lib/motion/tokens'

import { CLEAR, InBothModes, inEachMode, painted } from './story-kit'
import { Toggle } from './Toggle'

// Figma "Toggle" (03 UI, 597:5432): a story for each of Figma's four variants, under Figma's name for it, and one
// that watches the selected area slide (W78a; WQ72). On the site: Digital and Physical on the Gift Card page, Public
// and Private and a private session's lengths in the Book panel.

const OPTIONS = [
  { value: 'one', label: 'Label 1' },
  { value: 'two', label: 'Label 2' },
] as const

type Choice = (typeof OPTIONS)[number]['value']

/** Figma's Switch: no is the first choice chosen, yes the second. */
function Sample({ chosen }: { chosen: Choice }) {
  // Each mode's Toggle is a radio group of its own.
  const name = useId()
  const [value, setValue] = useState<Choice>(chosen)
  return <Toggle label="Which label" name={name} value={value} options={OPTIONS} onChange={setValue} />
}

const meta = {
  title: 'UI/Toggle',
  component: Sample,
  parameters: { padded: false },
  args: { chosen: 'one' },
  render: (args) => (
    <InBothModes>
      <Sample {...args} />
    </InBothModes>
  ),
} satisfies Meta<typeof Sample>

export default meta
type Story = StoryObj<typeof meta>

const all = (canvasElement: HTMLElement) =>
  inEachMode(canvasElement, '[data-toggle]').map((track) => ({
    track,
    choices: [...track.querySelectorAll<HTMLElement>('label')],
    area: () => track.querySelector<HTMLElement>('[data-toggle-selected]'),
  }))

/** The selected area lies exactly over the choice it is on. */
const over = (area: HTMLElement | null, choice: HTMLElement): boolean => {
  if (!area) return false
  const [at, to] = [area.getBoundingClientRect(), choice.getBoundingClientRect()]
  return Math.abs(at.left - to.left) < 0.5 && Math.abs(at.width - to.width) < 0.5 && Math.abs(at.top - to.top) < 0.5 && Math.abs(at.height - to.height) < 0.5
}

/** The track's fill, and the selected area on the choice chosen with that choice's words in Text/Secondary, the other's in Text/Primary. */
const looks = async (canvasElement: HTMLElement, fill: string, chosen: 0 | 1) => {
  const found = all(canvasElement)
  await expect(found).toHaveLength(2)
  for (const { track, choices, area } of found) {
    const [on, off] = [choices[chosen]!, choices[1 - chosen]!]
    // Once it has finished changing colour: the Toggle measures itself as it is drawn, which is before a story's forced
    // hover is in. The token's colour is read first: reading it inside the wait would change the page and start the wait again.
    const filled = painted(track, fill)
    await waitFor(() => expect([getComputedStyle(track).backgroundColor, getComputedStyle(track).borderRadius]).toEqual([filled, '4px']))
    await waitFor(() => expect(over(area(), on)).toBe(true))
    await expect([getComputedStyle(area()!).backgroundColor, getComputedStyle(area()!).borderRadius]).toEqual([painted(track, 'bg-surface-secondary'), '4px'])
    await expect(getComputedStyle(on).color).toBe(painted(track, 'text-text-secondary', 'color'))
    await expect([getComputedStyle(off).color, getComputedStyle(off).backgroundColor]).toEqual([painted(track, 'text-text-primary', 'color'), CLEAR])
    // Each choice: 32px each side and 12px above and below its words in Label 12.
    await expect([getComputedStyle(on).paddingLeft, getComputedStyle(on).paddingTop, getComputedStyle(on.querySelector('span')!).fontSize]).toEqual(['32px', '12px', '12px'])
    await expect(on.querySelector('input')).toBeChecked()
    await expect(off.querySelector('input')).not.toBeChecked()
  }
}

/** The first choice chosen, on Surface/Card. */
export const FirstDefault: Story = {
  name: 'Switch=no, State=default',
  play: async ({ canvasElement }) => looks(canvasElement, 'bg-surface-card', 0),
}

/** Under a mouse the whole Toggle is Surface/Card Selected. */
export const FirstHover: Story = {
  name: 'Switch=no, State=hover',
  globals: { pseudo: 'hover' },
  play: async ({ canvasElement }) => looks(canvasElement, 'bg-surface-card-selected', 0),
}

export const SecondDefault: Story = {
  name: 'Switch=yes, State=default',
  args: { chosen: 'two' },
  play: async ({ canvasElement }) => looks(canvasElement, 'bg-surface-card', 1),
}

export const SecondHover: Story = {
  name: 'Switch=yes, State=hover',
  args: { chosen: 'two' },
  globals: { pseudo: 'hover' },
  play: async ({ canvasElement }) => looks(canvasElement, 'bg-surface-card-selected', 1),
}

/**
 * W78a (WQ72): press a choice and the selected area slides to it, over the short duration (320 ms) with the smooth
 * curve, the words changing colour as it goes. The arrow keys do the same. With reduced motion on it is there at once.
 */
export const Slides: Story = {
  name: 'The selected area slides to the choice made',
  play: async ({ canvasElement }) => {
    const [{ track, choices, area }] = all(canvasElement) as [ReturnType<typeof all>[number]]
    const [first, second] = choices as [HTMLElement, HTMLElement]
    await waitFor(() => expect(over(area(), first)).toBe(true))

    await userEvent.click(second)
    await expect(second.querySelector('input')).toBeChecked()
    // It is on its way: one element, moved and resized, on the motion tokens.
    const moving = area()!.getAnimations() as CSSTransition[]
    await expect(moving.map((one) => one.transitionProperty)).toContain('translate')
    await expect(moving.map((one) => one.transitionProperty).filter((property) => property !== 'translate' && property !== 'width')).toEqual([])
    for (const one of moving) {
      await expect(one.effect!.getComputedTiming().duration).toBe(DURATION_SHORT * 1000)
      await expect(linearEasingPoints(String(one.effect!.getComputedTiming().easing))).toEqual(linearEasingPoints(EASE_SMOOTH_CSS))
    }
    await expect(over(area(), second)).toBe(false)
    await waitFor(() => expect(over(area(), second)).toBe(true), { timeout: 2000 })
    await expect(getComputedStyle(track).position).toBe('relative')

    // The keyboard: Left goes back to the first, and the area follows.
    second.querySelector('input')!.focus()
    await userEvent.keyboard('{ArrowLeft}')
    await expect(first.querySelector('input')).toBeChecked()
    await waitFor(() => expect(over(area(), first)).toBe(true), { timeout: 2000 })
  },
}
