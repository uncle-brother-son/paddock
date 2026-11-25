import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { expect, userEvent, waitFor } from 'storybook/test'

import { Accordion } from './Accordion'
import { InBothModes, inEachMode, painted } from './story-kit'

// Figma "Accordion" (03 UI, 1492:11780): a story for each of Figma's two variants, under Figma's name for it.

const meta = {
  title: 'UI/Accordion',
  component: Accordion,
  parameters: { padded: false },
  args: { label: 'Label', children: 'Content' },
  // Figma's own width for it.
  render: (args) => (
    <InBothModes width="w-[698px]">
      <Accordion {...args} className="w-full" />
    </InBothModes>
  ),
} satisfies Meta<typeof Accordion>

export default meta
type Story = StoryObj<typeof meta>

const accordions = (canvasElement: HTMLElement) => inEachMode(canvasElement, '[data-accordion]')
const partsOf = (accordion: HTMLElement) => {
  const button = accordion.querySelector('button')!
  return { button, heading: button.children[0] as HTMLElement, chevron: button.querySelector('svg')!, held: accordion.querySelector<HTMLElement>('[role="group"]')! }
}
const near = (value: number) => Math.round(value * 100) / 100

/** Shut: on Surface/Card with 4px corners and 16px all round, the heading in Label 12 and the chevron 8px to its right. */
export const Shut: Story = {
  name: 'Open=no',
  play: async ({ canvasElement }) => {
    await document.fonts.ready
    const found = accordions(canvasElement)
    await expect(found).toHaveLength(2)
    for (const accordion of found) {
      const { button, heading, chevron, held } = partsOf(accordion)
      const style = getComputedStyle(accordion)
      await expect([style.backgroundColor, style.borderRadius, style.padding]).toEqual([painted(accordion, 'bg-surface-card'), '4px', '16px'])
      await expect([getComputedStyle(heading).fontSize, getComputedStyle(heading).color]).toEqual(['12px', painted(accordion, 'text-text-primary', 'color')])
      // The button is the whole of the shut accordion, with the heading 16px in and the chevron 16px from the right.
      const [box, buttonBox, headingBox, chevronBox] = [accordion, button, heading, chevron].map((part) => part.getBoundingClientRect()) as [DOMRect, DOMRect, DOMRect, DOMRect]
      await expect([box.width, near(buttonBox.width), near(buttonBox.height - box.height)]).toEqual([698, 698, 0])
      await expect([near(headingBox.left - box.left), near(headingBox.top - box.top), near(box.right - chevronBox.right), near(chevronBox.left - headingBox.right)]).toEqual([16, 16, 16, 8])
      await expect([chevronBox.width, chevronBox.height, getComputedStyle(chevron).rotate]).toEqual([9, 9, 'none'])
      await expect(button).toHaveAccessibleName('Label')
      await expect(button.getAttribute('aria-expanded')).toBe('false')
      await expect(button.getAttribute('aria-controls')).toBe(held.id)
      // What it holds is in the page, and not shown.
      await expect(held).toHaveTextContent('Content')
      await expect(held).not.toBeVisible()
    }
  },
}

/** Open: the chevron turned half-way round, and what it holds in Copy 14 under the heading, 32px above and below it, as wide as the heading. */
export const Open: Story = {
  name: 'Open=yes',
  args: { defaultOpen: true },
  play: async ({ canvasElement }) => {
    await document.fonts.ready
    for (const accordion of accordions(canvasElement)) {
      const { button, heading, chevron, held } = partsOf(accordion)
      await expect(button.getAttribute('aria-expanded')).toBe('true')
      await expect(held).toBeVisible()
      await expect(held).toHaveAccessibleName('Label')
      await expect(getComputedStyle(chevron).rotate).toBe('180deg')
      const words = held.querySelector('p')!
      await expect([getComputedStyle(words).fontSize, getComputedStyle(words).color]).toEqual(['14px', painted(accordion, 'text-text-primary', 'color')])
      await expect([getComputedStyle(held).paddingTop, getComputedStyle(held).paddingBottom]).toEqual(['32px', '32px'])
      const [box, buttonBox, headingBox, wordsBox] = [accordion, button, heading, words].map((part) => part.getBoundingClientRect()) as [DOMRect, DOMRect, DOMRect, DOMRect]
      // The heading stays where it was, 16px down; the button is still only the heading's row.
      await expect([near(headingBox.top - box.top), near(buttonBox.top - box.top)]).toEqual([16, 0])
      // What it holds: the heading's own width (clear of the chevron's column), and 32px then the accordion's 16px beneath it.
      await expect([near(wordsBox.left - headingBox.left), near(wordsBox.width - headingBox.width), near(box.bottom - wordsBox.bottom)]).toEqual([0, 0, 48])
      // 32px under the heading's row, which is as tall as the chevron.
      await expect(near(wordsBox.top - (box.top + 16 + 9))).toBe(32)
    }
  },
}

/** By the keyboard: Tab reaches the heading, Enter and Space open and shut it. */
export const Keyboard: Story = {
  play: async ({ canvasElement }) => {
    const [accordion] = accordions(canvasElement) as [HTMLElement]
    const { button, chevron, held } = partsOf(accordion)
    await userEvent.tab()
    await expect(button).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    await expect(button.getAttribute('aria-expanded')).toBe('true')
    await expect(held).toBeVisible()
    await waitFor(() => expect(getComputedStyle(chevron).rotate).toBe('180deg'))
    await userEvent.keyboard(' ')
    await expect(button.getAttribute('aria-expanded')).toBe('false')
    await expect(held).not.toBeVisible()
    await waitFor(() => expect(getComputedStyle(chevron).rotate).toBe('none'))
  },
}
