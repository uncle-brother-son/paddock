import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { expect, userEvent } from 'storybook/test'

import { DURATION_SHORT } from '@/lib/motion/tokens'

import { BothModes, Named } from './BothModes'
import { Fence, HouseIllustration, Logo, LogoHover, LOGO_LABEL, LOGO_VARIANTS, type LogoVariant } from './Logo'

/** The names on Figma's 01 Logo page. */
const FIGMA_NAME: Record<LogoVariant, string> = {
  wordmark: 'Wordmark',
  original: 'Logo Original',
  'hover-static': 'LogoHover, hover=static',
  'hover-logo': 'LogoHover, hover=logo',
  'hover-extended': 'LogoHover, hover=extended',
}

const meta = {
  title: 'Brand/Logos',
  component: Logo,
  parameters: { padded: false },
} satisfies Meta<typeof Logo>

export default meta
type Story = StoryObj<typeof meta>

/** Every logo beside its Figma name, in Light and Dark, each at its file's own size. */
export const All: Story = {
  args: { variant: 'wordmark' },
  render: () => (
    <BothModes>
      <ul className="flex flex-col gap-32">
        {LOGO_VARIANTS.map((variant) => (
          <Named key={variant} name={FIGMA_NAME[variant]}>
            <Logo variant={variant} />
          </Named>
        ))}
        <Named name="Fence">
          <Fence />
        </Named>
        <Named name="HouseIllustration">
          <HouseIllustration className="h-auto max-w-full" />
        </Named>
      </ul>
    </BothModes>
  ),
  play: async ({ canvas, canvasElement }) => {
    // Seven drawings twice over, each labelled with the club's name, and no id used twice on the page.
    await expect(canvas.getAllByRole('img', { name: LOGO_LABEL })).toHaveLength(14)
    const ids = [...canvasElement.querySelectorAll('svg [id]')].map((element) => element.id)
    await expect(ids.length).toBeGreaterThan(0)
    await expect(new Set(ids).size).toBe(ids.length)
    // Every reference inside a drawing points at an id that is there.
    const references = [...canvasElement.querySelectorAll('svg use')].map((use) => use.getAttribute('href')?.slice(1))
    for (const reference of references) await expect(ids).toContain(reference)
  },
}

/** Where the name is already beside it, a logo is decoration: hidden from a screen reader. */
export const Decorative: Story = {
  args: { variant: 'wordmark', decorative: true },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.queryByRole('img')).toBeNull()
    await expect(canvasElement.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
  },
}

/**
 * The desktop header's logo: hover it (or Tab to it) and it opens out to "The Paddock Wellness Club" in 320 ms,
 * as Figma's LogoHover prototype does.
 */
export const HeaderHover: Story = {
  name: 'Header hover',
  args: { variant: 'hover-logo' },
  render: () => (
    <a href="#logo" className="group inline-block">
      <LogoHover />
    </a>
  ),
  play: async ({ canvas, canvasElement }) => {
    const link = canvas.getByRole('link', { name: LOGO_LABEL })
    const frame = canvasElement.querySelector('a > span') as HTMLElement
    // At rest: the wordmark's own width.
    await expect(frame.getBoundingClientRect().width).toBe(107)
    await userEvent.tab()
    await expect(link).toHaveFocus()
    await expect(getComputedStyle(frame).transitionDuration).toBe(`${DURATION_SHORT}s`)
  },
}
