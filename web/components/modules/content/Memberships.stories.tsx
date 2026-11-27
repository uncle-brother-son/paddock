import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { expect, fn, userEvent, waitFor, within } from 'storybook/test'

import { painted } from '@/components/ui/story-kit'

import { Memberships } from './Memberships'
import { SAMPLE_CARDS_MONTHLY_ONLY, SAMPLE_CARDS_ONE_OPTION, SAMPLE_MEMBERSHIP_CARDS, SAMPLE_NOTE, SAMPLE_SAVE_UP_TO } from './sample-memberships'
import { box, DESKTOP, fontsIn, inDark, MOBILE, near } from './story-parts'

// Figma "Memberships" (05 Modules > Content, 1842:46324): a story for each of Figma's four variants, under Figma's
// name for it, in Light and in Dark, with Figma's own words and prices; then what the brief asks beyond them.

const TABLET = { viewport: { value: 'tablet', isRotated: false } }
const LAPTOP = { viewport: { value: 'w1024', isRotated: false } }

const meta = {
  title: 'Modules/Content/Memberships',
  component: Memberships,
  parameters: { padded: false, layout: 'fullscreen', nextjs: { appDirectory: true } },
  args: { heading: null, saveUpTo: SAMPLE_SAVE_UP_TO, cards: SAMPLE_MEMBERSHIP_CARDS, note: SAMPLE_NOTE, theme: null, sectionId: 'memberships', onAdd: fn() },
} satisfies Meta<typeof Memberships>

export default meta
type Story = StoryObj<typeof meta>

const parts = (canvasElement: HTMLElement) => {
  const section = canvasElement.querySelector('[data-module="memberships"]') as HTMLElement
  return {
    section,
    toggle: section.querySelector('[data-toggle]') as HTMLElement,
    saving: section.querySelector('[data-memberships="saving"]') as HTMLElement,
    strip: section.querySelector('[data-plan-cards="strip"]') as HTMLElement,
    cards: [...section.querySelectorAll<HTMLElement>('article[data-plan-card]')],
    note: section.querySelector('.page-grid > div') as HTMLElement,
  }
}

/** What a card says: its line, its name, each offer's words and prices, and its two lists. */
const said = (card: HTMLElement) => ({
  line: card.querySelector('[data-plan-card="type"]')?.textContent ?? null,
  name: card.querySelector('[data-plan-card="name"]')!.textContent,
  offers: [...card.querySelectorAll('[data-offer-selector]')].map((offer) => [...offer.querySelectorAll('[data-offer="offer"] > span, [data-offer="price"] > *')].map((one) => one.textContent)),
  included: [...card.querySelectorAll('[data-plan-card="included"] [data-feature-item]')].map((one) => one.textContent),
  herd: [...card.querySelectorAll('[data-plan-card="herd"] [data-feature-item]')].map((one) => one.textContent),
})

/** A browser lays widths out in 64ths of a pixel: a third of a row (424.67) is held to a tenth. */
const about = (value: number, wanted: number): boolean => Math.abs(value - wanted) < 0.1

const yearly = async (canvasElement: HTMLElement) => {
  await userEvent.click(within(canvasElement).getByRole('radio', { name: 'Yearly' }))
  await waitFor(() => expect(parts(canvasElement).section.dataset.billing).toBe('yearly'))
}

const CORE = ['Core', 'Off-Peak and Core times']
const ALL = ['All-Access', 'Every session, including Peak']

/** Figma's words and prices, card by card, under each billing. */
const WORDS = {
  monthly: [
    { line: '4 Sessions a month', name: 'Foal', offers: [[...CORE, '£45'], [...ALL, '£59']], included: ['4 Sessions a month', 'Personalised sauna hat', 'Herd benefits after 6 months'] },
    { line: '8 Sessions a month', name: 'Yearling', offers: [[...CORE, '£79'], [...ALL, '£105']], included: ['8 Sessions a month', 'Personalised sauna hat', 'Herd benefits after 6 months'] },
    { line: 'Unlimited sessions', name: 'Champion', offers: [[...CORE, '£109'], [...ALL, '£149']], included: ['Unlimited sessions', 'Personalised sauna hat', 'Herd benefits after 6 months'] },
  ],
  yearly: [
    { line: '4 Sessions a month', name: 'Foal', offers: [[...CORE, 'was £540', 'now £490'], [...ALL, 'was £708', 'now £630']], included: ['4 Sessions a month', 'Personalised sauna hat', 'Immediate Herd benefits'] },
    { line: '8 Sessions a month', name: 'Yearling', offers: [[...CORE, 'was £948', 'now £850'], [...ALL, 'was £1,260', 'now £1,100']], included: ['8 Sessions a month', 'Personalised sauna hat', 'Immediate Herd benefits'] },
    { line: 'Unlimited sessions', name: 'Champion', offers: [[...CORE, 'was £1,308', 'now £1,100'], [...ALL, 'was £1,788', 'now £1,600']], included: ['Unlimited sessions', 'Personalised sauna hat', 'Immediate Herd benefits'] },
  ],
}

const HERD = [
  ['1 free smoothie per month', '3rd group access to free workshops', 'Member event and merch pricing'],
  ['2 free Smoothies per month', '2nd group access to free workshops', 'Member event and merch pricing'],
  ['3 free Smoothies per month', 'First access to free workshops', 'Member event and merch pricing', 'Invite to bi-annual Supper Club'],
]

/**
 * One of Figma's variants. `padding`: above and below. `lefts` and `width`: where each card stands and how wide it
 * is. `noteAt`: the note's left and width. `scrolls`: whether the row of cards goes on past the window.
 */
const variant = (globals: typeof DESKTOP, billing: 'monthly' | 'yearly', { padding, lefts, width, noteAt, scrolls }: { padding: number; lefts: number[]; width: number; noteAt: [number, number]; scrolls: boolean }): Story => ({
  globals,
  play: async ({ canvasElement, canvas }) => {
    if (billing === 'yearly') await yearly(canvasElement)
    const { section, toggle, saving, strip, cards, note } = parts(canvasElement)
    await fontsIn(saving, note.firstElementChild!, cards[0]!.querySelector('[data-plan-card="name"]')!)
    // The Toggle, Monthly first; 16px under it "Save up to 16% yearly" in Copy 14, Text/Muted Primary; both centred.
    await expect(canvas.getAllByRole('radio', { name: /^(Monthly|Yearly)$/ }).map((radio) => [(radio as HTMLInputElement).value, (radio as HTMLInputElement).checked])).toEqual([
      ['monthly', billing === 'monthly'],
      ['yearly', billing === 'yearly'],
    ])
    await expect([saving.textContent, getComputedStyle(saving).fontSize, getComputedStyle(saving).color]).toEqual(['Save up to 16% yearly', '14px', painted(section, 'text-text-muted-primary', 'color')])
    const middle = (element: Element) => box(element).left + box(element).width / 2
    for (const one of [toggle, saving, note]) await expect(Math.abs(middle(one) - box(section).width / 2), one.className).toBeLessThan(1)
    // Padding above; 16px; 80px to the cards; 80px to the note; padding below.
    await expect([near(box(toggle).top - box(section).top), near(box(saving).top - box(toggle).bottom), near(box(strip).top - box(saving).bottom), near(box(note).top - box(strip).bottom), near(box(section).bottom - box(note).bottom)]).toEqual([
      padding,
      16,
      80,
      80,
      padding,
    ])
    // The cards: where Figma puts them, as wide as Figma draws them, 8px apart.
    await expect(
      cards.map((card, index) => about(box(card).left, lefts[index]!)),
      `the cards are at ${cards.map((card) => box(card).left).join(', ')}`,
    ).toEqual(lefts.map(() => true))
    for (const card of cards) await expect(about(box(card).width, width), `a card is ${box(card).width} wide`).toBe(true)
    if (scrolls) {
      // Figma's Carousel: the row goes on past the window's edge, and each card is as tall as what it holds.
      await expect(strip.scrollWidth).toBeGreaterThan(strip.clientWidth)
      await expect(box(cards[2]!).height).toBeGreaterThan(box(cards[0]!).height)
      await expect(cards.map((card) => near(box(card).top))).toEqual(cards.map(() => near(box(cards[0]!).top)))
    } else {
      // Every card as tall as the tallest, and nothing to scroll.
      await expect(strip.scrollWidth).toBeLessThanOrEqual(strip.clientWidth + 1)
      await expect(cards.map((card) => near(box(card).height))).toEqual(cards.map(() => near(box(cards[2]!).height)))
    }
    await expect(document.documentElement.scrollWidth).toBe(document.documentElement.clientWidth)
    // The note in Copy 14, Text/Muted Primary, centred.
    await expect([near(box(note).left), near(box(note).width)]).toEqual(noteAt)
    const words = note.querySelector('p')!
    await expect([getComputedStyle(words).fontSize, getComputedStyle(words).textAlign, getComputedStyle(words).color]).toEqual(['14px', 'center', painted(section, 'text-text-muted-primary', 'color')])
    // Figma's words and prices; Core chosen on every card.
    await expect(cards.map(said)).toEqual(WORDS[billing].map((card, index) => ({ ...card, herd: HERD[index] })))
    for (const card of cards) await expect((within(card).getAllByRole('radio') as HTMLInputElement[]).map((radio) => radio.checked)).toEqual([true, false])
    // The section is `memberships`, where PageHeader's button goes.
    await expect(section.id).toBe('memberships')
  },
})

/** At 1440: three cards share the 22 columns between an empty column each side (424.67px each). */
const AT_1440 = { padding: 120, lefts: [75, 507.67, 940.33], width: 424.67, noteAt: [370, 700] as [number, number], scrolls: false }
/** At 390: each card 5 of the 6 columns (297px), the second starting inside the window. */
const AT_390 = { padding: 80, lefts: [16, 321, 626], width: 297, noteAt: [16, 358] as [number, number], scrolls: true }

export const DesktopMonthly: Story = { name: 'Device=desktop, State=monthly', ...variant(DESKTOP, 'monthly', AT_1440) }
export const DesktopYearly: Story = { name: 'Device=desktop, State=yearly', ...variant(DESKTOP, 'yearly', AT_1440) }
export const MobileMonthly: Story = { name: 'Device=mobile, State=monthly', ...variant(MOBILE, 'monthly', AT_390) }
export const MobileYearly: Story = { name: 'Device=mobile, State=yearly', ...variant(MOBILE, 'yearly', AT_390) }

export const DesktopMonthlyDark: Story = { name: 'Device=desktop, State=monthly (Dark)', ...inDark(variant(DESKTOP, 'monthly', AT_1440)) }
export const DesktopYearlyDark: Story = { name: 'Device=desktop, State=yearly (Dark)', ...inDark(variant(DESKTOP, 'yearly', AT_1440)) }
export const MobileMonthlyDark: Story = { name: 'Device=mobile, State=monthly (Dark)', ...inDark(variant(MOBILE, 'monthly', AT_390)) }
export const MobileYearlyDark: Story = { name: 'Device=mobile, State=yearly (Dark)', ...inDark(variant(MOBILE, 'yearly', AT_390)) }

/** Item 4 of the brief: a plan off sale is not offered. Foal's All-Access is off sale, so Foal offers Core alone. */
export const OneOption: Story = {
  name: 'A card with one option',
  globals: DESKTOP,
  args: { cards: SAMPLE_CARDS_ONE_OPTION },
  play: async ({ canvasElement, args }) => {
    const { cards } = parts(canvasElement)
    await expect(cards.map((card) => within(card).getAllByRole('radio').length)).toEqual([1, 2, 2])
    const foal = within(cards[0]!)
    await expect(foal.getByRole('radio')).toBeChecked()
    await expect(foal.getByRole('radio')).toHaveAccessibleName('Core Off-Peak and Core times £45')
    await expect(foal.queryByText('All-Access')).toBeNull()
    // The cards are still as tall as one another, and Foal's button stands 8px under its one offer.
    await expect(cards.map((card) => near(box(card).height))).toEqual(cards.map(() => near(box(cards[2]!).height)))
    await userEvent.click(foal.getByRole('button', { name: 'Add to bag' }))
    await expect(args.onAdd).toHaveBeenLastCalledWith({ membershipPlan: 'plan-foal-core', billing: 'monthly' })
  },
}

/** The switch: prices, the struck before-prices and the benefits follow it; what was chosen on a card stays chosen. */
export const Switching: Story = {
  name: 'Monthly to Yearly and back',
  globals: DESKTOP,
  play: async ({ canvasElement, canvas }) => {
    const { cards } = parts(canvasElement)
    const yearling = within(cards[1]!)
    await userEvent.click(yearling.getByText('All-Access'))
    await expect(yearling.getByRole('radio', { name: /All-Access/ })).toBeChecked()
    await yearly(canvasElement)
    const after = parts(canvasElement).cards
    await expect(after.map(said)).toEqual(WORDS.yearly.map((card, index) => ({ ...card, herd: HERD[index] })))
    // Yearling keeps All-Access; the others keep Core.
    await expect(after.map((card) => (within(card).getAllByRole('radio') as HTMLInputElement[]).map((radio) => radio.checked))).toEqual([
      [true, false],
      [false, true],
      [true, false],
    ])
    await expect(within(after[1]!).getByRole('radio', { name: /All-Access/ })).toHaveAccessibleName('All-Access Every session, including Peak was £1,260 now £1,100')
    // The arrow keys move the switch too: Left goes back to Monthly.
    canvas.getByRole('radio', { name: 'Yearly' }).focus()
    await userEvent.keyboard('{ArrowLeft}')
    await waitFor(() => expect(parts(canvasElement).section.dataset.billing).toBe('monthly'))
    await expect(parts(canvasElement).cards.map(said)).toEqual(WORDS.monthly.map((card, index) => ({ ...card, herd: HERD[index] })))
  },
}

/** Add to bag hands the bag the plan chosen on that card and the billing chosen above: never a price. */
export const AddToBag: Story = {
  name: 'Add to bag: the plan and the billing',
  globals: DESKTOP,
  play: async ({ canvasElement, args }) => {
    const card = (index: number) => within(parts(canvasElement).cards[index]!)
    await userEvent.click(card(0).getByRole('button', { name: 'Add to bag' }))
    await expect(args.onAdd).toHaveBeenLastCalledWith({ membershipPlan: 'plan-foal-core', billing: 'monthly' })
    await userEvent.click(card(2).getByText('All-Access'))
    await yearly(canvasElement)
    await userEvent.click(card(2).getByRole('button', { name: 'Add to bag' }))
    await expect(args.onAdd).toHaveBeenLastCalledWith({ membershipPlan: 'plan-champion-all', billing: 'yearly' })
    await userEvent.click(card(1).getByRole('button', { name: 'Add to bag' }))
    await expect(args.onAdd).toHaveBeenLastCalledWith({ membershipPlan: 'plan-yearling-core', billing: 'yearly' })
    await expect(args.onAdd).toHaveBeenCalledTimes(3)
  },
}

/** A heading an editor gives is the section's name for a screen reader and is not drawn; the cards' names are h3s under it. */
export const WithHeading: Story = {
  name: 'With a heading (for screen readers)',
  globals: DESKTOP,
  args: { heading: 'Memberships' },
  play: async ({ canvasElement, canvas }) => {
    const { section, toggle, cards } = parts(canvasElement)
    await expect(canvas.getByRole('region', { name: 'Memberships' })).toBe(section)
    const heading = canvas.getByRole('heading', { level: 2, name: 'Memberships' })
    await expect([box(heading).width, box(heading).height]).toEqual([1, 1])
    await expect(near(box(toggle).top - box(section).top)).toBe(120)
    await expect(canvas.getAllByRole('heading', { level: 3 }).map((one) => one.textContent)).toEqual(['Foal', 'Yearling', 'Champion'])
    await expect(cards).toHaveLength(3)
  },
}

/** With no heading the cards' names are the section's h2s. */
export const NoHeading: Story = {
  name: 'With no heading',
  globals: DESKTOP,
  play: async ({ canvas }) => {
    await expect(canvas.getAllByRole('heading', { level: 2 }).map((one) => one.textContent)).toEqual(['Foal', 'Yearling', 'Champion'])
    await expect(canvas.queryAllByRole('heading', { level: 3 })).toHaveLength(0)
  },
}

/** No yearly price on sale: nothing to switch between, so no Toggle and no saving; the cards start 120px down. */
export const OneBilling: Story = {
  name: 'One billing only: no Toggle',
  globals: DESKTOP,
  args: { cards: SAMPLE_CARDS_MONTHLY_ONLY, saveUpTo: null },
  play: async ({ canvasElement, canvas }) => {
    const { section, strip, cards } = parts(canvasElement)
    await expect(canvas.queryByRole('radiogroup', { name: 'How a membership is paid for' })).toBeNull()
    await expect(section.querySelector('[data-memberships="saving"]')).toBeNull()
    await expect(near(box(strip).top - box(section).top)).toBe(120)
    await expect(cards.map((card) => said(card).offers.map((offer) => offer[2]))).toEqual([
      ['£45', '£59'],
      ['£79', '£105'],
      ['£109', '£149'],
    ])
  },
}

/** No note, and no saving to speak of: the Toggle stands alone and the section ends 120px under the cards. */
export const NoNote: Story = {
  name: 'No note, no saving',
  globals: DESKTOP,
  args: { note: [], saveUpTo: null },
  play: async ({ canvasElement, canvas }) => {
    const { section, toggle, strip } = parts(canvasElement)
    await expect(canvas.getByRole('radiogroup', { name: 'How a membership is paid for' })).toBe(toggle)
    await expect(section.querySelector('[data-memberships="saving"]')).toBeNull()
    await expect([near(box(strip).top - box(toggle).bottom), near(box(section).bottom - box(strip).bottom)]).toEqual([80, 120])
  },
}

/** No card on sale: the module draws nothing at all. */
export const NoCards: Story = {
  name: 'No card on sale: nothing',
  args: { cards: [] },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector('[data-module="memberships"]')).toBeNull()
  },
}

/**
 * Between Figma's two frames. At 768px three cards can't each be as wide as Figma's narrowest (297px), so the row
 * scrolls sideways as it does on a phone, starting at the grid's margin; at 1024px they just fit.
 */
export const Tablet: Story = {
  name: 'At 768px: the row scrolls sideways',
  globals: TABLET,
  play: async ({ canvasElement }) => {
    const { strip, cards } = parts(canvasElement)
    await fontsIn(cards[0]!.querySelector('[data-plan-card="name"]')!)
    for (const card of cards) await expect(near(box(card).width)).toBe(297)
    await expect(near(box(cards[0]!).left)).toBe(16)
    await expect(strip.scrollWidth).toBeGreaterThan(strip.clientWidth)
    await expect(cards.map((card) => near(box(card).height))).toEqual(cards.map(() => near(box(cards[2]!).height)))
    await expect(document.documentElement.scrollWidth).toBe(document.documentElement.clientWidth)
    // The keyboard: focus on the button of the last card, which is half out of the window, brings the whole card in
    // with the grid's margin after it; going back to the first card brings that one in.
    const button = (index: number) => within(cards[index]!).getByRole('button', { name: 'Add to bag' })
    await expect(box(button(2)).right).toBeGreaterThan(768)
    button(2).focus()
    await waitFor(() => expect(near(768 - box(cards[2]!).right)).toBe(16))
    button(0).focus()
    await waitFor(() => expect(near(box(cards[0]!).left)).toBe(16))
    // A press with a mouse or a finger moves nothing under the pointer.
    document.documentElement.dataset.input = 'pointer'
    button(2).focus()
    await expect(strip.scrollLeft).toBe(0)
    delete document.documentElement.dataset.input
    // Each OfferSelector is Figma's Device=mobile at this width: its price under its words, nothing cut off.
    for (const offer of cards[2]!.querySelectorAll<HTMLElement>('[data-offer-selector]')) {
      const [words, price] = [offer.querySelector('[data-offer="offer"]')!, offer.querySelector('[data-offer="price"]')!]
      await expect(near(box(price).top - box(words).bottom)).toBe(12)
      await expect(offer.scrollWidth).toBeLessThanOrEqual(offer.clientWidth)
    }
  },
}

export const Laptop: Story = {
  name: 'At 1024px: three cards just fit',
  globals: LAPTOP,
  play: async ({ canvasElement }) => {
    const { strip, cards } = parts(canvasElement)
    await expect(strip.scrollWidth).toBeLessThanOrEqual(strip.clientWidth + 1)
    for (const card of cards) await expect(box(card).width).toBeGreaterThanOrEqual(297)
    await expect(about(box(cards[2]!).right, 1024 - box(cards[0]!).left)).toBe(true)
    await expect(document.documentElement.scrollWidth).toBe(document.documentElement.clientWidth)
  },
}

/**
 * A theme of its own (WQ81): the section carries it, and every colour follows. Light or Dark only: the cards are
 * forms, and Fjord and Mud are never used for forms (docs/build-standards.md).
 */
export const ThemeDark: Story = {
  name: 'Theme=Dark, on a Light page',
  globals: DESKTOP,
  args: { theme: 'dark' },
  play: async ({ canvasElement }) => {
    const { section, cards } = parts(canvasElement)
    await expect([section.dataset.theme, getComputedStyle(section).backgroundColor]).toEqual(['dark', painted(section.firstElementChild!, 'bg-surface-primary')])
    await expect(getComputedStyle(cards[0]!).backgroundColor).toBe(painted(cards[0]!, 'bg-surface-card-selected'))
  },
}
