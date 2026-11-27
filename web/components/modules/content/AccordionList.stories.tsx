import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { expect, userEvent, waitFor } from 'storybook/test'

import { painted } from '@/components/ui/story-kit'
import type { RichText } from '@/lib/sanity/schemas'

import { AccordionList } from './AccordionList'
import { box, DESKTOP, fontsIn, inDark, MOBILE, near } from './story-parts'

// Figma "AccordionList" (05 Modules > Content, 1634:13101): a story for each of Figma's four variants, under Figma's
// name for it, in Light and in Dark.

/** An answer as Sanity's rich text gives it: a paragraph with bold words, and a bullet. */
const answer = (key: string, words: string): RichText => [
  {
    _type: 'block',
    _key: `${key}-a`,
    style: 'normal',
    listItem: null,
    level: null,
    children: [
      { _type: 'span', _key: `${key}-1`, text: `${words} `, marks: [] },
      { _type: 'span', _key: `${key}-2`, text: 'In bold.', marks: ['strong'] },
    ],
    markDefs: [],
  },
  { _type: 'block', _key: `${key}-b`, style: 'normal', listItem: 'bullet', level: 1, children: [{ _type: 'span', _key: `${key}-3`, text: 'A bullet', marks: [] }], markDefs: [] },
]

const ITEMS = ['One', 'Two', 'Three', 'Four', 'Five', 'Six'].map((question) => ({ key: question, question, answer: answer(question, `The answer to ${question.toLowerCase()}.`) }))

const meta = {
  title: 'Modules/Content/AccordionList',
  component: AccordionList,
  parameters: { padded: false, layout: 'fullscreen', nextjs: { appDirectory: true } },
  args: { heading: 'Private Hire & Event Info', padding: true, items: ITEMS, theme: null, sectionId: null },
} satisfies Meta<typeof AccordionList>

export default meta
type Story = StoryObj<typeof meta>

const parts = (canvasElement: HTMLElement) => {
  const section = canvasElement.querySelector('[data-module="accordion-list"]') as HTMLElement
  return {
    section,
    heading: section.querySelector('h2') as HTMLElement,
    list: section.querySelector('[data-accordion-list="items"]') as HTMLElement,
    accordions: [...section.querySelectorAll<HTMLElement>('[data-accordion]')],
  }
}

/**
 * One variant: the list at `left`, `width` wide, with `padding` above and below (none with Padding=no); the heading
 * in H2, centred, 40px above the questions; each question an Accordion, 8px from the next.
 */
const variant = (globals: typeof DESKTOP, padded: boolean, left: number, width: number, padding: number): Story => ({
  globals,
  args: { padding: padded },
  play: async ({ canvas, canvasElement }) => {
    const { section, heading, list, accordions } = parts(canvasElement)
    await fontsIn(heading, accordions[0]!.querySelector('button')!)
    await expect(canvas.getByRole('region', { name: 'Private Hire & Event Info' })).toBe(section)
    await expect(section.dataset.padding).toBe(padded ? 'yes' : 'no')
    await expect([getComputedStyle(heading).textAlign, getComputedStyle(heading).color]).toEqual(['center', painted(section, 'text-text-primary', 'color')])
    await expect([near(box(heading).left), near(box(heading).width), near(box(heading).top - box(section).top)]).toEqual([left, width, padding])
    await expect([near(box(list).left), near(box(list).width), near(box(list).top - box(heading).bottom), near(box(section).bottom - box(list).bottom)]).toEqual([left, width, 40, padding])
    await expect(accordions).toHaveLength(6)
    for (const [index, accordion] of accordions.entries()) {
      await expect([near(box(accordion).width), getComputedStyle(accordion).backgroundColor]).toEqual([width, painted(section, 'bg-surface-card')])
      if (index > 0) await expect(near(box(accordion).top - box(accordions[index - 1]!).bottom)).toBe(8)
    }
    // Every question is a button that says it is shut; every answer is in the page.
    const buttons = canvas.getAllByRole('button')
    await expect(buttons.map((button) => [button.textContent, button.getAttribute('aria-expanded')])).toEqual(ITEMS.map((item) => [item.question, 'false']))
    await expect(section.textContent).toContain('The answer to six.')
    await expect(document.documentElement.scrollWidth).toBe(document.documentElement.clientWidth)
  },
})

/** Device=desktop, Padding=yes (1634:13099): the middle 12 of the grid's 24 columns (370, 700 wide), 120px above and below. */
export const DesktopPadding: Story = { ...variant(DESKTOP, true, 370, 700, 120), name: 'Device=desktop, Padding=yes' }
export const DesktopPaddingDark: Story = { ...inDark(DesktopPadding), name: 'Device=desktop, Padding=yes (Dark)' }

/** Device=mobile, Padding=yes (1634:13100): the grid's whole width (16, 358 wide), 80px above and below. */
export const MobilePadding: Story = { ...variant(MOBILE, true, 16, 358, 80), name: 'Device=mobile, Padding=yes' }
export const MobilePaddingDark: Story = { ...inDark(MobilePadding), name: 'Device=mobile, Padding=yes (Dark)' }

/** Device=desktop, Padding=no (1864:9402): no space above or below, for a list straight under another module. */
export const DesktopNoPadding: Story = { ...variant(DESKTOP, false, 370, 700, 0), name: 'Device=desktop, Padding=no' }
export const DesktopNoPaddingDark: Story = { ...inDark(DesktopNoPadding), name: 'Device=desktop, Padding=no (Dark)' }

/** Device=mobile, Padding=no (1864:9424). */
export const MobileNoPadding: Story = { ...variant(MOBILE, false, 16, 358, 0), name: 'Device=mobile, Padding=no' }
export const MobileNoPaddingDark: Story = { ...inDark(MobileNoPadding), name: 'Device=mobile, Padding=no (Dark)' }

/**
 * A question opens its answer with the Accordion's own motion (W79b), by a press or by the keyboard, and shuts
 * again; the answer is Sanity's rich text in Copy 14, bold and bullets included. The others stay as they are.
 */
export const OpensAndShuts: Story = {
  name: 'A question opens and shuts',
  globals: DESKTOP,
  play: async ({ canvas, canvasElement }) => {
    const { accordions } = parts(canvasElement)
    const second = canvas.getByRole('button', { name: 'Two' })
    const held = accordions[1]!.querySelector('[role="group"]') as HTMLElement
    await expect(getComputedStyle(held).visibility).toBe('hidden')
    await userEvent.click(second)
    await expect(second.getAttribute('aria-expanded')).toBe('true')
    await waitFor(() => expect(box(held).height).toBeGreaterThan(60))
    await expect(getComputedStyle(held).visibility).toBe('visible')
    const paragraph = held.querySelector('p') as HTMLElement
    await expect([paragraph.textContent, getComputedStyle(paragraph).fontSize, getComputedStyle(held.querySelector('strong')!).fontWeight]).toEqual(['The answer to two. In bold.', '14px', '500'])
    await expect(held.querySelectorAll('li')).toHaveLength(1)
    await expect(canvas.getAllByRole('button').map((button) => button.getAttribute('aria-expanded'))).toEqual(['false', 'true', 'false', 'false', 'false', 'false'])
    // The keyboard shuts it again.
    second.focus()
    await userEvent.keyboard('{Enter}')
    await expect(second.getAttribute('aria-expanded')).toBe('false')
    await waitFor(() => expect(getComputedStyle(held).visibility).toBe('hidden'))
  },
}

/** WQ81: on Mud, as the Session Pass FAQs are on Memberships & Passes (1864:14969). The heading is optional. */
export const OnMudNoHeading: Story = {
  name: 'Theme=Mud, no heading',
  globals: DESKTOP,
  args: { theme: 'mud', heading: null, sectionId: 'faqs' },
  play: async ({ canvas, canvasElement }) => {
    const { section, list } = parts(canvasElement)
    await expect(canvas.queryByRole('heading')).toBeNull()
    await expect([section.dataset.theme, section.id, getComputedStyle(section).backgroundColor]).toEqual(['mud', 'faqs', 'rgb(110, 98, 88)'])
    await expect(near(box(list).top - box(section).top)).toBe(120)
  },
}
