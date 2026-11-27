import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { expect } from 'storybook/test'

import { painted } from '@/components/ui/story-kit'

import { SectionSpacer } from './SectionSpacer'
import { box, DESKTOP, inDark, MOBILE } from './story-parts'

// Figma "SectionSpacer" (05 Modules > Content, 1648:14936): a story for each of Figma's two variants, in Light and
// in Dark. It is drawn between two lines of text here so its room can be seen.

const meta = {
  title: 'Modules/Content/SectionSpacer',
  component: SectionSpacer,
  parameters: { padded: false, layout: 'fullscreen' },
  args: { theme: null, sectionId: null },
  render: (args) => (
    <>
      <p className="px-16 text-copy-14">The section above</p>
      <SectionSpacer {...args} />
      <p className="px-16 text-copy-14">The section below</p>
    </>
  ),
} satisfies Meta<typeof SectionSpacer>

export default meta
type Story = StoryObj<typeof meta>

const spacerIn = (canvasElement: HTMLElement) => canvasElement.querySelector('[data-module="section-spacer"]') as HTMLElement

const variant = (globals: typeof DESKTOP, height: number): Story => ({
  globals,
  play: async ({ canvasElement }) => {
    const spacer = spacerIn(canvasElement)
    await expect([box(spacer).height, box(spacer).width]).toEqual([height, document.documentElement.clientWidth])
    // It holds nothing and is not read out; the page's own Surface/Primary shows through it.
    await expect([spacer.tagName, spacer.getAttribute('aria-hidden'), spacer.childElementCount, spacer.hasAttribute('data-theme')]).toEqual(['DIV', 'true', 0, false])
    await expect(getComputedStyle(spacer.parentElement!).backgroundColor).toBe(painted(spacer, 'bg-surface-primary'))
  },
})

/** Device=desktop (1648:14935): 120px. */
export const Desktop: Story = { ...variant(DESKTOP, 120), name: 'Device=desktop' }
export const DesktopDark: Story = { ...inDark(Desktop), name: 'Device=desktop (Dark)' }

/** Device=mobile (1648:14934): 80px. */
export const Mobile: Story = { ...variant(MOBILE, 80), name: 'Device=mobile' }
export const MobileDark: Story = { ...inDark(Mobile), name: 'Device=mobile (Dark)' }

/** WQ81: with a theme it is that theme's Surface/Primary, so a run of modules on one colour is not broken by it. */
export const OnMud: Story = {
  name: 'Theme=Mud',
  globals: DESKTOP,
  args: { theme: 'mud' },
  play: async ({ canvasElement }) => {
    const spacer = spacerIn(canvasElement)
    await expect([spacer.dataset.theme, getComputedStyle(spacer).backgroundColor, box(spacer).height]).toEqual(['mud', 'rgb(110, 98, 88)', 120])
  },
}
