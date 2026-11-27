import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { expect, userEvent, waitFor } from 'storybook/test'

import { painted } from '@/components/ui/story-kit'

import { PageHeader } from './PageHeader'
import { box, DESKTOP, fontsIn, inDark, MOBILE, near, SAMPLE_TEXT } from './story-parts'

// Figma "PageHeader" (05 Modules > Content, 1460:12636): a story for each of Figma's four variants, under Figma's
// name for it, in Light and in Dark.

const meta = {
  title: 'Modules/Content/PageHeader',
  component: PageHeader,
  parameters: { padded: false, layout: 'fullscreen', nextjs: { appDirectory: true } },
  args: { title: 'Header', intro: SAMPLE_TEXT, layout: 'split', buttons: [{ key: 'b1', text: 'CTA', href: '/shop' }], theme: null, sectionId: null },
} satisfies Meta<typeof PageHeader>

export default meta
type Story = StoryObj<typeof meta>

const parts = (canvasElement: HTMLElement) => {
  const section = canvasElement.querySelector('[data-module="page-header"]') as HTMLElement
  return {
    section,
    title: section.querySelector('h1, h2') as HTMLElement,
    text: section.querySelector('[data-module-text]') as HTMLElement,
    buttons: section.querySelector('[data-page-header="buttons"]') as HTMLElement,
  }
}

/** What every variant has: the title in Label 12 and the intro in H2, both Text/Primary, and the button Figma's secondary one. */
const drawnAsFigma = async (canvasElement: HTMLElement) => {
  const { section, title, text, buttons } = parts(canvasElement)
  await fontsIn(title, text)
  await expect(title.tagName).toBe('H1')
  await expect([getComputedStyle(title).fontSize, getComputedStyle(title).textTransform, getComputedStyle(title).color]).toEqual(['12px', 'uppercase', painted(section, 'text-text-primary', 'color')])
  await expect(getComputedStyle(text).color).toBe(painted(section, 'text-text-primary', 'color'))
  const button = buttons.querySelector('a') as HTMLElement
  await expect([getComputedStyle(button).backgroundColor, getComputedStyle(button).borderRadius, getComputedStyle(button).paddingLeft, getComputedStyle(button).paddingTop]).toEqual([
    painted(section, 'bg-surface-card'),
    '4px',
    '32px',
    '12px',
  ])
  return { section, title, text, buttons }
}

/**
 * Device=desktop, Type=split (1460:12634): 240px above and below; the title at the grid's left, 8px in (24), and
 * the intro in its right half (from 724, 692 wide), the buttons 80px under the intro.
 */
export const DesktopSplit: Story = {
  name: 'Device=desktop, Type=split',
  globals: DESKTOP,
  play: async ({ canvasElement }) => {
    const { section, title, text, buttons } = await drawnAsFigma(canvasElement)
    await expect(getComputedStyle(text).fontSize).toBe('24px')
    await expect([near(box(title).left), near(box(title).top - box(section).top)]).toEqual([24, 240])
    await expect([near(box(text).left), near(box(text).width), near(box(text).top - box(section).top)]).toEqual([724, 692, 240])
    await expect([near(box(buttons).left), near(box(buttons).top - box(text).bottom), near(box(section).bottom - box(buttons).bottom)]).toEqual([724, 80, 240])
  },
}

export const DesktopSplitDark: Story = { ...inDark(DesktopSplit), name: 'Device=desktop, Type=split (Dark)' }

/**
 * Device=mobile, Type=split (1460:12635): 160px above and below; the title 8px in from the grid's edge (24, 342
 * wide), 40px under it the intro, 80px under that the buttons.
 */
export const MobileSplit: Story = {
  name: 'Device=mobile, Type=split',
  globals: MOBILE,
  play: async ({ canvasElement }) => {
    const { section, title, text, buttons } = await drawnAsFigma(canvasElement)
    await expect(getComputedStyle(text).fontSize).toBe('22px')
    await expect([near(box(title).left), near(box(title).top - box(section).top)]).toEqual([24, 160])
    await expect([near(box(text).left), near(box(text).width), near(box(text).top - box(title).bottom)]).toEqual([24, 342, 40])
    await expect([near(box(buttons).left), near(box(buttons).top - box(text).bottom), near(box(section).bottom - box(buttons).bottom)]).toEqual([24, 80, 160])
    await expect(document.documentElement.scrollWidth).toBe(390)
  },
}

export const MobileSplitDark: Story = { ...inDark(MobileSplit), name: 'Device=mobile, Type=split (Dark)' }

/**
 * Device=desktop, Type=stacked (1648:14887): one column from the grid's second column (75), 732 wide: the title,
 * 40px under it the intro, 40px under that the buttons; 240px above and below.
 */
export const DesktopStacked: Story = {
  name: 'Device=desktop, Type=stacked',
  globals: DESKTOP,
  args: { layout: 'stacked' },
  play: async ({ canvasElement }) => {
    const { section, title, text, buttons } = await drawnAsFigma(canvasElement)
    await expect([near(box(title).left), near(box(title).top - box(section).top)]).toEqual([75, 240])
    await expect([near(box(text).left), near(box(text).width), near(box(text).top - box(title).bottom)]).toEqual([75, 732, 40])
    await expect([near(box(buttons).left), near(box(buttons).top - box(text).bottom), near(box(section).bottom - box(buttons).bottom)]).toEqual([75, 40, 240])
  },
}

export const DesktopStackedDark: Story = { ...inDark(DesktopStacked), name: 'Device=desktop, Type=stacked (Dark)' }

/** Device=mobile, Type=stacked (1648:14894): as Device=mobile, Type=split. */
export const MobileStacked: Story = {
  name: 'Device=mobile, Type=stacked',
  globals: MOBILE,
  args: { layout: 'stacked' },
  play: async ({ canvasElement }) => {
    const { section, title, text, buttons } = await drawnAsFigma(canvasElement)
    await expect([near(box(title).left), near(box(title).top - box(section).top)]).toEqual([24, 160])
    await expect([near(box(text).left), near(box(text).width), near(box(text).top - box(title).bottom)]).toEqual([24, 342, 40])
    await expect([near(box(buttons).left), near(box(buttons).top - box(text).bottom), near(box(section).bottom - box(buttons).bottom)]).toEqual([24, 80, 160])
  },
}

export const MobileStackedDark: Story = { ...inDark(MobileStacked), name: 'Device=mobile, Type=stacked (Dark)' }

/**
 * Two buttons (Figma's Show Button 1 and 2), as Memberships & Passes has (1830:42949): side by side, 8px apart. Each
 * goes to a section of the page (WQ83): a press scrolls there, the address takes the section's name, and focus
 * goes to the section. Here there is no smooth scroll (Storybook runs none), so the page jumps, as it does with
 * reduced motion on.
 */
export const TwoButtonsToSections: Story = {
  name: 'Two buttons, to sections of the page',
  globals: DESKTOP,
  args: {
    title: 'Memberships & Passes',
    buttons: [
      { key: 'b1', text: 'Memberships', href: '#memberships' },
      { key: 'b2', text: 'Session Passes', href: '#passes' },
    ],
  },
  render: (args) => (
    <>
      <PageHeader {...args} />
      {['memberships', 'passes'].map((id) => (
        <section key={id} id={id} aria-label={id} className="h-[1200px] p-16">
          <p className="text-copy-14">{id}</p>
        </section>
      ))}
    </>
  ),
  play: async ({ canvas, canvasElement }) => {
    const [first, second] = [canvas.getByRole('link', { name: 'Memberships' }), canvas.getByRole('link', { name: 'Session Passes' })]
    await expect([first.getAttribute('href'), second.getAttribute('href')]).toEqual(['#memberships', '#passes'])
    await expect([near(box(second).left - box(first).right), near(box(second).top - box(first).top)]).toEqual([8, 0])
    const passes = canvasElement.querySelector('#passes') as HTMLElement
    const before = window.location.hash
    try {
      await userEvent.click(second)
      await waitFor(() => expect(Math.abs(box(passes).top)).toBeLessThan(1))
      await expect(window.location.hash).toBe('#passes')
      await expect(document.activeElement).toBe(passes)
      // Focus by script only: the section is not in the Tab order and shows no ring.
      await expect([passes.tabIndex, passes.style.outline]).toEqual([-1, 'none'])
      await userEvent.click(first)
      await waitFor(() => expect(Math.abs(box(canvasElement.querySelector('#memberships') as HTMLElement).top)).toBeLessThan(1))
      await expect(window.location.hash).toBe('#memberships')
    } finally {
      // The test runner's own address is left as it was.
      window.history.replaceState(null, '', before || window.location.pathname + window.location.search)
      window.scrollTo(0, 0)
    }
  },
}

/** A later PageHeader on a page: its title is an h2 (the page has one h1). With no buttons and no intro there is only the title. */
export const TitleOnly: Story = {
  name: 'Title only, as a second header',
  globals: DESKTOP,
  args: { intro: [], buttons: [], headingLevel: 2 },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole('heading', { level: 2, name: 'Header' })).toBeVisible()
    await expect(canvasElement.querySelector('[data-page-header="intro"]')).toBeNull()
    await expect(canvas.queryByRole('link')).toBeNull()
  },
}

/** No title: in Type=split the intro keeps its place in the right half. */
export const NoTitle: Story = {
  name: 'No title',
  globals: DESKTOP,
  args: { title: null },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.queryByRole('heading')).toBeNull()
    await expect(near(box(canvasElement.querySelector('[data-module-text]') as HTMLElement).left)).toBe(724)
  },
}

/** WQ81: a module with a theme carries it on its section, and stands on that theme's Surface/Primary. WQ83: its Section ID is the section's id. */
export const ThemeAndSectionId: Story = {
  name: 'Theme=Mud, with a Section ID',
  globals: DESKTOP,
  args: { theme: 'mud', sectionId: 'top' },
  play: async ({ canvasElement }) => {
    const { section, title } = parts(canvasElement)
    await expect([section.dataset.theme, section.id, section.hasAttribute('data-page-themed')]).toEqual(['mud', 'top', true])
    await expect(getComputedStyle(section).backgroundColor).toBe('rgb(110, 98, 88)')
    await expect(getComputedStyle(title).color).toBe('rgb(255, 255, 255)')
  },
}
