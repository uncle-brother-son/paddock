import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { expect } from 'storybook/test'

import { painted } from '@/components/ui/story-kit'

import { box, DESKTOP, fontsIn, inDark, MOBILE, near, SAMPLE_BUTTON, SAMPLE_TEXT } from './story-parts'
import { TextBlock } from './TextBlock'

// Figma "TextBlock" (05 Modules > Content, 1627:11922): a story for each of Figma's six variants, under Figma's
// name for it, in Light and in Dark.

const meta = {
  title: 'Modules/Content/TextBlock',
  component: TextBlock,
  parameters: { padded: false, layout: 'fullscreen', nextjs: { appDirectory: true } },
  args: { heading: 'Header', text: SAMPLE_TEXT, button: SAMPLE_BUTTON, align: 'left', theme: null, sectionId: null },
} satisfies Meta<typeof TextBlock>

export default meta
type Story = StoryObj<typeof meta>

const parts = (canvasElement: HTMLElement) => {
  const section = canvasElement.querySelector('[data-module="text-block"]') as HTMLElement
  return {
    section,
    copy: section.querySelector('[data-text-block="copy"]') as HTMLElement,
    heading: section.querySelector('h2') as HTMLElement,
    text: section.querySelector('[data-module-text]') as HTMLElement,
    button: section.querySelector('a') as HTMLElement,
  }
}

/**
 * One variant: the words' column at `left`, `width` wide, with `padding` above and below; the heading in Label 12,
 * 40px under it the text in H2, 40px under that the button (Figma's secondary one). `centred`: the heading and the
 * text are centred in the column, and so is the button.
 */
const variant = (globals: typeof DESKTOP, align: 'left' | 'right' | 'center', left: number, width: number, padding: number): Story => ({
  globals,
  args: { align },
  play: async ({ canvas, canvasElement }) => {
    const { section, copy, heading, text, button } = parts(canvasElement)
    await fontsIn(heading, text)
    await expect(canvas.getByRole('region', { name: 'Header' })).toBe(section)
    await expect([near(box(copy).left), near(box(copy).width)]).toEqual([left, width])
    await expect([near(box(heading).top - box(section).top), near(box(text).top - box(heading).bottom), near(box(button).top - box(text).bottom), near(box(section).bottom - box(button).bottom)]).toEqual([
      padding,
      40,
      40,
      padding,
    ])
    await expect([getComputedStyle(heading).fontSize, getComputedStyle(heading).textTransform, getComputedStyle(heading).color]).toEqual(['12px', 'uppercase', painted(section, 'text-text-primary', 'color')])
    await expect([getComputedStyle(text).color, getComputedStyle(button).backgroundColor]).toEqual([painted(section, 'text-text-primary', 'color'), painted(section, 'bg-surface-card')])
    const centred = align === 'center'
    await expect([getComputedStyle(heading).textAlign, getComputedStyle(text).textAlign]).toEqual(centred ? ['center', 'center'] : ['start', 'start'])
    // The button hugs its label: at the column's left, or in its middle.
    const middle = (element: Element) => box(element).left + box(element).width / 2
    if (centred) await expect(Math.abs(middle(button) - middle(copy))).toBeLessThan(1)
    else await expect(near(box(button).left)).toBe(left)
    await expect(document.documentElement.scrollWidth).toBe(document.documentElement.clientWidth)
  },
})

/** Device=desktop, Orientation=left (1627:11921): 12 columns from the grid's second (75, 700 wide), 120px above and below. */
export const DesktopLeft: Story = { ...variant(DESKTOP, 'left', 75, 700, 120), name: 'Device=desktop, Orientation=left' }
export const DesktopLeftDark: Story = { ...inDark(DesktopLeft), name: 'Device=desktop, Orientation=left (Dark)' }

/** Device=mobile, Orientation=left (1627:11920): the grid's first five columns (16, 297 wide), 80px above and below. */
export const MobileLeft: Story = { ...variant(MOBILE, 'left', 16, 297, 80), name: 'Device=mobile, Orientation=left' }
export const MobileLeftDark: Story = { ...inDark(MobileLeft), name: 'Device=mobile, Orientation=left (Dark)' }

/** Device=desktop, Orientation=right (1627:11957): 12 columns from the grid's twelfth (665), set from the left. */
export const DesktopRight: Story = { ...variant(DESKTOP, 'right', 665, 700, 120), name: 'Device=desktop, Orientation=right' }
export const DesktopRightDark: Story = { ...inDark(DesktopRight), name: 'Device=desktop, Orientation=right (Dark)' }

/** Device=mobile, Orientation=right (1627:11975): the grid's last five columns (77, 297 wide). */
export const MobileRight: Story = { ...variant(MOBILE, 'right', 77, 297, 80), name: 'Device=mobile, Orientation=right' }
export const MobileRightDark: Story = { ...inDark(MobileRight), name: 'Device=mobile, Orientation=right (Dark)' }

/** Device=desktop, Orientation=center (1627:11983): the middle 12 columns (370), everything centred. */
export const DesktopCenter: Story = { ...variant(DESKTOP, 'center', 370, 700, 120), name: 'Device=desktop, Orientation=center' }
export const DesktopCenterDark: Story = { ...inDark(DesktopCenter), name: 'Device=desktop, Orientation=center (Dark)' }

/** Device=mobile, Orientation=center (1627:12000): the grid's whole width (16, 358 wide), everything centred. */
export const MobileCenter: Story = { ...variant(MOBILE, 'center', 16, 358, 80), name: 'Device=mobile, Orientation=center' }
export const MobileCenterDark: Story = { ...inDark(MobileCenter), name: 'Device=mobile, Orientation=center (Dark)' }

/** Figma's Show Header, Show Copy and Show Button: each part can be left out. Here only the text, in two paragraphs 8px apart beyond their lines. */
export const TextOnly: Story = {
  name: 'Show Header=no, Show Button=no',
  globals: DESKTOP,
  args: {
    heading: null,
    button: null,
    text: [
      { key: 'p1', text: 'More than a membership. A community.' },
      { key: 'p2', text: 'The Herd is our way of celebrating those who make The Paddock part of their routine.' },
    ],
  },
  play: async ({ canvas, canvasElement }) => {
    const { section, text } = parts(canvasElement)
    await expect(canvas.queryByRole('heading')).toBeNull()
    await expect(canvas.queryByRole('link')).toBeNull()
    await expect([near(box(text).top - box(section).top), near(box(section).bottom - box(text).bottom)]).toEqual([120, 120])
    const [first, second] = [...text.querySelectorAll('p')]
    // Figma's H2 has 8px between paragraphs, beyond the line's own height.
    await expect(getComputedStyle(second!).marginTop).toBe('8px')
    await expect(box(second!).top - box(first!).bottom).toBe(8)
  },
}

/** WQ81: on Fjord, the section carries the theme and stands on its Surface/Primary; WQ83: its Section ID is its id. */
export const ThemeAndSectionId: Story = {
  name: 'Theme=Fjord, with a Section ID',
  globals: DESKTOP,
  args: { theme: 'fjord', sectionId: 'book' },
  play: async ({ canvasElement }) => {
    const { section, heading } = parts(canvasElement)
    await expect([section.dataset.theme, section.id]).toEqual(['fjord', 'book'])
    await expect([getComputedStyle(section).backgroundColor, getComputedStyle(heading).color]).toEqual(['rgb(167, 187, 200)', 'rgb(34, 34, 34)'])
  },
}
