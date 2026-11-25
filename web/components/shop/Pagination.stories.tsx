import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { expect } from 'storybook/test'

import { CLEAR, InBothModes, inEachMode, painted } from '@/components/ui/story-kit'

import { Pagination } from './Pagination'

// Figma "Pagination" (03 UI, 1402:47982): one component with no variants, here under Figma's name, and then as it is
// at the first page and under a mouse. On the site: beneath the Shop's products.

const meta = {
  title: 'UI/Pagination',
  component: Pagination,
  parameters: {
    padded: false,
    nextjs: { appDirectory: true },
    // The story draws it twice (Light and Dark), so there are two "Pages" landmarks here; a page of the site has one.
    a11y: { config: { rules: [{ id: 'landmark-unique', enabled: false }] } },
  },
  args: { page: 2, pages: 3, hrefOf: (page: number) => `/shop?page=${page}` },
  render: (args) => (
    <InBothModes>
      <Pagination {...args} />
    </InBothModes>
  ),
} satisfies Meta<typeof Pagination>

export default meta
type Story = StoryObj<typeof meta>

const all = (canvasElement: HTMLElement) =>
  inEachMode(canvasElement, 'nav').map((nav) => ({
    nav,
    arrows: [...nav.children].filter((part) => part.matches('a, span')) as HTMLElement[],
    words: nav.querySelector('p') as HTMLElement,
  }))

/** An IconButton each side of "2 / 3" in Label 12, 32px apart: each arrow 25px square, a link to the page before or after. */
export const AsDrawn: Story = {
  name: 'Pagination',
  play: async ({ canvasElement }) => {
    const found = all(canvasElement)
    await expect(found).toHaveLength(2)
    for (const { nav, arrows, words } of found) {
      await expect(arrows).toHaveLength(2)
      await expect(getComputedStyle(nav).columnGap).toBe('32px')
      await expect(nav.getBoundingClientRect().height).toBe(25)
      await expect([getComputedStyle(words).fontSize, getComputedStyle(words).color]).toEqual(['12px', painted(words, 'text-text-primary', 'color')])
      await expect(words).toHaveTextContent('Page 2 /of 3')
      for (const arrow of arrows) {
        const box = arrow.getBoundingClientRect()
        await expect([box.width, box.height, getComputedStyle(arrow).borderRadius, getComputedStyle(arrow).backgroundColor]).toEqual([25, 25, '4px', CLEAR])
      }
      await expect(arrows.map((arrow) => [arrow.tagName, arrow.getAttribute('aria-label'), arrow.getAttribute('href')])).toEqual([
        ['A', 'Previous page', '/shop?page=1'],
        ['A', 'Next page', '/shop?page=3'],
      ])
    }
  },
}

/** At the first page there is no page before: its arrow is drawn as designed, but is no link and is nothing to a screen reader. */
export const FirstPage: Story = {
  name: 'At the first page',
  args: { page: 1 },
  play: async ({ canvasElement }) => {
    for (const { arrows } of all(canvasElement)) {
      await expect(arrows.map((arrow) => [arrow.tagName, arrow.getAttribute('aria-hidden')])).toEqual([
        ['SPAN', 'true'],
        ['A', null],
      ])
    }
  },
}

/** Each arrow that is a link is an IconButton: Surface/Card Selected under a mouse. An arrow that is no link stays as it is. */
export const UnderAMouse: Story = {
  name: 'Under a mouse',
  args: { page: 1 },
  globals: { pseudo: 'hover' },
  play: async ({ canvasElement }) => {
    for (const { nav, arrows } of all(canvasElement)) {
      const [none, next] = arrows as [HTMLElement, HTMLElement]
      await expect(getComputedStyle(next).backgroundColor).toBe(painted(nav, 'bg-surface-card-selected'))
      await expect(getComputedStyle(none).backgroundColor).toBe(CLEAR)
    }
  },
}
