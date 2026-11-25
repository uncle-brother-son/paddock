import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { expect } from 'storybook/test'

import { StatusTag } from './StatusTag'
import { InBothModes, inEachMode, painted } from './story-kit'

// Figma "StatusTag" (03 UI, 1080:11824): a story for each of Figma's two variants, under Figma's name for it.

const meta = {
  title: 'UI/StatusTag',
  component: StatusTag,
  parameters: { padded: false },
  args: { children: 'Label' },
  render: (args) => (
    <InBothModes>
      <StatusTag {...args} />
    </InBothModes>
  ),
} satisfies Meta<typeof StatusTag>

export default meta
type Story = StoryObj<typeof meta>

const tags = (canvasElement: HTMLElement) => inEachMode(canvasElement, '[data-status-tag]')
const near = (value: number) => Math.round(value * 100) / 100

/** Its words in Label 10 and Text/Primary, 6px each side and 4px above and below, on Surface/Card with 4px corners. */
export const Default: Story = {
  name: 'State=default',
  play: async ({ canvasElement }) => {
    await document.fonts.ready
    const found = tags(canvasElement)
    await expect(found).toHaveLength(2)
    for (const line of found) {
      const tag = line.children[0] as HTMLElement
      const words = tag.children[0] as HTMLElement
      const style = getComputedStyle(tag)
      await expect([style.backgroundColor, style.borderRadius]).toEqual([painted(line, 'bg-surface-card'), '4px'])
      await expect([style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft]).toEqual(['4px', '6px', '4px', '6px'])
      await expect([getComputedStyle(words).fontSize, getComputedStyle(words).color]).toEqual(['10px', painted(line, 'text-text-primary', 'color')])
      // It takes the room of a line of Label 12's capitals, and overhangs that line equally above and below.
      const [lineBox, tagBox] = [line.getBoundingClientRect(), tag.getBoundingClientRect()]
      await expect(lineBox.height).toBeLessThan(tagBox.height)
      await expect(Math.abs(lineBox.top - tagBox.top - (tagBox.bottom - lineBox.bottom))).toBeLessThan(0.1)
      // About 3px each way (Figma: a 15px tag on a 9px line).
      await expect(Math.round(lineBox.top - tagBox.top)).toBe(3)
      await expect(near(lineBox.width)).toBe(near(tagBox.width))
    }
  },
}

/** A warning: the same tag with its words in Text/Error. */
export const Warning: Story = {
  name: 'State=warning',
  args: { warning: true },
  // A measured shortfall, for Wayne (W78a report; the code never adjusts a colour by itself): Text/Error on
  // Surface/Card is 4.45:1 in Light, where small text needs 4.5:1, as the newsletter's error is (W73). The rule is off
  // for this one story only, so the rest of its accessibility check still runs.
  parameters: { a11y: { config: { rules: [{ id: 'color-contrast', enabled: false }] } } },
  play: async ({ canvasElement }) => {
    for (const line of tags(canvasElement)) {
      const tag = line.children[0] as HTMLElement
      await expect(getComputedStyle(tag).backgroundColor).toBe(painted(line, 'bg-surface-card'))
      await expect(getComputedStyle(tag.children[0]!).color).toBe(painted(line, 'text-text-error', 'color'))
    }
  },
}

/** Beside a line of Label 12, as it is used: it sits level with the words and adds nothing to the line's height. */
export const BesideWords: Story = {
  name: 'Beside words',
  render: (args) => (
    <InBothModes>
      <p className="flex items-center gap-8">
        <span className="text-label-12 text-text-primary">Morning session</span>
        <StatusTag {...args} />
      </p>
    </InBothModes>
  ),
  play: async ({ canvasElement }) => {
    await document.fonts.ready
    for (const line of tags(canvasElement)) {
      const row = line.parentElement!
      const words = row.children[0] as HTMLElement
      // The row is as tall as its words alone, and the tag's middle is the words' middle.
      await expect(near(row.getBoundingClientRect().height)).toBe(near(words.getBoundingClientRect().height))
      const middle = (box: DOMRect) => box.top + box.height / 2
      await expect(Math.abs(middle(line.children[0]!.getBoundingClientRect()) - middle(words.getBoundingClientRect()))).toBeLessThan(0.51)
    }
  },
}
