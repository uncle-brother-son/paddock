import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { expect, fn, userEvent, within } from 'storybook/test'

import { painted } from '@/components/ui/story-kit'

import { SAMPLE_PASS_CARDS, SAMPLE_PASS_CARDS_TWO_LENGTHS } from './sample-memberships'
import { SessionPasses } from './SessionPasses'
import { box, DESKTOP, fontsIn, inDark, MOBILE, near } from './story-parts'

// Figma "SessionPasses" (05 Modules > Content, 1842:48611): a story for each of Figma's two variants, under Figma's
// name for it, in Light and in Dark, with Figma's own words and prices; then what the brief asks beyond them.

const TABLET = { viewport: { value: 'tablet', isRotated: false } }

const meta = {
  title: 'Modules/Content/SessionPasses',
  component: SessionPasses,
  parameters: { padded: false, layout: 'fullscreen', nextjs: { appDirectory: true } },
  args: { heading: null, cards: SAMPLE_PASS_CARDS, theme: null, sectionId: 'passes', onAdd: fn() },
} satisfies Meta<typeof SessionPasses>

export default meta
type Story = StoryObj<typeof meta>

const parts = (canvasElement: HTMLElement) => {
  const section = canvasElement.querySelector('[data-module="session-passes"]') as HTMLElement
  return { section, strip: section.querySelector('[data-plan-cards="strip"]') as HTMLElement, cards: [...section.querySelectorAll<HTMLElement>('article[data-plan-card]')] }
}

const said = (card: HTMLElement) => ({
  line: card.querySelector('[data-plan-card="type"]')?.textContent ?? null,
  name: card.querySelector('[data-plan-card="name"]')!.textContent,
  offers: [...card.querySelectorAll('[data-offer-selector]')].map((offer) => [...offer.querySelectorAll('[data-offer="offer"] > span, [data-offer="price"] > *')].map((one) => one.textContent)),
  ticked: [...card.querySelectorAll('[data-feature-item]')].map((one) => one.textContent),
})

/** Figma's words and prices. */
const WORDS = [
  { line: 'Session Pass', name: '5 Session', offers: [['Core', 'Off-Peak and Core times', '£70'], ['All-Access', 'Every session, including Peak', '£90']], ticked: ['Valid for 3 months'] },
  { line: 'Session Pass', name: '10 Session', offers: [['Core', 'Off-Peak and Core times', '£135'], ['All-Access', 'Every session, including Peak', '£175']], ticked: ['Valid for 6 months'] },
]

/** One of Figma's variants: `padding` above and below the cards, where each card stands and how wide it is. */
const variant = (globals: typeof DESKTOP, { padding, lefts, width, scrolls }: { padding: number; lefts: number[]; width: number; scrolls: boolean }): Story => ({
  globals,
  play: async ({ canvasElement }) => {
    const { section, strip, cards } = parts(canvasElement)
    await fontsIn(cards[0]!.querySelector('[data-plan-card="name"]')!, cards[0]!.querySelector('[data-plan-card="type"]')!)
    await expect([near(box(strip).top - box(section).top), near(box(section).bottom - box(strip).bottom)]).toEqual([padding, padding])
    await expect(cards.map((card) => [near(box(card).left), near(box(card).width)])).toEqual(lefts.map((left) => [left, width]))
    await expect(cards.map((card) => near(box(card).height))).toEqual(cards.map(() => near(box(cards[0]!).height)))
    if (scrolls) await expect(strip.scrollWidth).toBeGreaterThan(strip.clientWidth)
    else await expect(strip.scrollWidth).toBeLessThanOrEqual(strip.clientWidth + 1)
    await expect(document.documentElement.scrollWidth).toBe(document.documentElement.clientWidth)
    await expect(cards.map(said)).toEqual(WORDS)
    for (const card of cards) {
      await expect((within(card).getAllByRole('radio') as HTMLInputElement[]).map((radio) => radio.checked)).toEqual([true, false])
      await expect(getComputedStyle(card).backgroundColor).toBe(painted(card, 'bg-surface-card-selected'))
      // No Herd list on a pass, and no before-price.
      await expect([card.querySelector('[data-plan-card="herd"]'), card.querySelector('s')]).toEqual([null, null])
    }
    // The section is `passes`, where PageHeader's button goes.
    await expect(section.id).toBe('passes')
  },
})

/** At 1440: two cards share the 16 columns between four empty columns each side (464px each: 8 columns). */
const AT_1440 = { padding: 120, lefts: [252, 724], width: 464, scrolls: false }
/** At 390: each card 5 of the 6 columns (297px), the second starting inside the window. */
const AT_390 = { padding: 80, lefts: [16, 321], width: 297, scrolls: true }

export const Desktop: Story = { name: 'Device=desktop', ...variant(DESKTOP, AT_1440) }
export const Mobile: Story = { name: 'Device=mobile', ...variant(MOBILE, AT_390) }
export const DesktopDark: Story = { name: 'Device=desktop (Dark)', ...inDark(variant(DESKTOP, AT_1440)) }
export const MobileDark: Story = { name: 'Device=mobile (Dark)', ...inDark(variant(MOBILE, AT_390)) }

/** "Valid for N months" is the pass that is chosen: here 10 Session's All-Access lasts 12 months and its Core 6. */
export const ValidFor: Story = {
  name: 'Valid for N months follows the pass chosen',
  globals: DESKTOP,
  args: { cards: SAMPLE_PASS_CARDS_TWO_LENGTHS },
  play: async ({ canvasElement }) => {
    const ten = () => parts(canvasElement).cards[1]!
    await expect(said(ten()).ticked).toEqual(['Valid for 6 months'])
    await userEvent.click(within(ten()).getByText('All-Access'))
    await expect(said(ten()).ticked).toEqual(['Valid for 12 months'])
    await expect(said(parts(canvasElement).cards[0]!).ticked).toEqual(['Valid for 3 months'])
    // The arrow keys move between the two passes of a card.
    ;(within(ten()).getByRole('radio', { name: /All-Access/ }) as HTMLInputElement).focus()
    await userEvent.keyboard('{ArrowUp}')
    await expect(within(ten()).getByRole('radio', { name: 'Core Off-Peak and Core times £135' })).toBeChecked()
    await expect(said(ten()).ticked).toEqual(['Valid for 6 months'])
  },
}

/** Add to bag hands the bag the pass chosen on that card: never a price. */
export const AddToBag: Story = {
  name: 'Add to bag: the pass',
  globals: DESKTOP,
  play: async ({ canvasElement, args }) => {
    const card = (index: number) => within(parts(canvasElement).cards[index]!)
    await userEvent.click(card(0).getByRole('button', { name: 'Add to bag' }))
    await expect(args.onAdd).toHaveBeenLastCalledWith({ sessionPass: 'pass-5-core' })
    await userEvent.click(card(1).getByText('All-Access'))
    await userEvent.click(card(1).getByRole('button', { name: 'Add to bag' }))
    await expect(args.onAdd).toHaveBeenLastCalledWith({ sessionPass: 'pass-10-all' })
    await expect(card(1).getByRole('button', { name: 'Add to bag' })).toHaveAccessibleDescription('10 Session')
  },
}

/** Item 4 of the brief: a pass off sale is not offered, and a card with neither is not shown. One card stands in the middle. */
export const OneCardOneOption: Story = {
  name: 'One card, with one option',
  globals: DESKTOP,
  args: { cards: [{ ...SAMPLE_PASS_CARDS[0]!, offers: [SAMPLE_PASS_CARDS[0]!.offers[1]!] }] },
  play: async ({ canvasElement, args }) => {
    const { section, cards } = parts(canvasElement)
    await expect(cards).toHaveLength(1)
    const only = within(cards[0]!)
    await expect(only.getByRole('radio')).toBeChecked()
    await expect(only.getByRole('radio')).toHaveAccessibleName('All-Access Every session, including Peak £90')
    // It keeps the width Figma draws a pass's card (8 columns, 464px), in the middle of the page.
    await expect([near(box(cards[0]!).left), near(box(cards[0]!).width)]).toEqual([488, 464])
    await expect(Math.abs(box(cards[0]!).left + box(cards[0]!).width / 2 - box(section).width / 2)).toBeLessThan(0.5)
    await userEvent.click(only.getByRole('button', { name: 'Add to bag' }))
    await expect(args.onAdd).toHaveBeenLastCalledWith({ sessionPass: 'pass-5-all' })
  },
}

/** A heading an editor gives is the section's name for a screen reader and is not drawn; without one the names are h2s. */
export const WithHeading: Story = {
  name: 'With a heading (for screen readers)',
  globals: DESKTOP,
  args: { heading: 'Session Passes' },
  play: async ({ canvasElement, canvas }) => {
    const { section, strip } = parts(canvasElement)
    await expect(canvas.getByRole('region', { name: 'Session Passes' })).toBe(section)
    await expect(canvas.getAllByRole('heading', { level: 3 }).map((one) => one.textContent)).toEqual(['5 Session', '10 Session'])
    await expect(near(box(strip).top - box(section).top)).toBe(120)
  },
}

/** No card on sale: the module draws nothing at all. */
export const NoCards: Story = {
  name: 'No card on sale: nothing',
  args: { cards: [] },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector('[data-module="session-passes"]')).toBeNull()
  },
}

/** Between Figma's two frames, at 768px: two cards, each Figma's narrowest (297px), in the middle of the page. */
export const Tablet: Story = {
  name: 'At 768px',
  globals: TABLET,
  play: async ({ canvasElement }) => {
    const { section, strip, cards } = parts(canvasElement)
    await expect(cards.map((card) => near(box(card).width))).toEqual([297, 297])
    await expect(Math.abs((box(cards[0]!).left + box(cards[1]!).right) / 2 - box(section).width / 2)).toBeLessThan(0.5)
    await expect(strip.scrollWidth).toBeLessThanOrEqual(strip.clientWidth + 1)
    await expect(document.documentElement.scrollWidth).toBe(document.documentElement.clientWidth)
  },
}

/** A theme of its own (WQ81): the section carries it, and every colour follows. Every theme, as W80's modules (WQ91). */
export const ThemeFjord: Story = {
  name: 'Theme=Fjord, on a Light page',
  globals: DESKTOP,
  args: { theme: 'fjord' },
  // WQ91: the muted words on Fjord fail the same way as on Mud (3.64:1), so the rule is off here too, and only here.
  parameters: { a11y: { config: { rules: [{ id: 'color-contrast', enabled: false }] } } },
  play: async ({ canvasElement }) => {
    const { section, cards } = parts(canvasElement)
    await expect([section.dataset.theme, getComputedStyle(section).backgroundColor]).toEqual(['fjord', painted(section.firstElementChild!, 'bg-surface-primary')])
    await expect(getComputedStyle(cards[0]!).backgroundColor).toBe(painted(cards[0]!, 'bg-surface-card-selected'))
  },
}

export const ThemeMud: Story = {
  name: 'Theme=Mud, on a Light page',
  globals: DESKTOP,
  args: { theme: 'mud' },
  // WQ91 (Wayne, 27 Nov): the muted words on Mud are 3.55:1, where small text needs 4.5:1, and Wayne accepts them as
  // drawn. The rule is off for this one story only, so the rest of its accessibility check still runs.
  parameters: { a11y: { config: { rules: [{ id: 'color-contrast', enabled: false }] } } },
  play: async ({ canvasElement }) => {
    const { section, cards } = parts(canvasElement)
    await expect([section.dataset.theme, getComputedStyle(section).backgroundColor]).toEqual(['mud', painted(section.firstElementChild!, 'bg-surface-primary')])
    await expect(getComputedStyle(cards[0]!).backgroundColor).toBe(painted(cards[0]!, 'bg-surface-card-selected'))
  },
}
