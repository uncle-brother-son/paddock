import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { useState, type ComponentProps } from 'react'
import { expect, fn, userEvent, within } from 'storybook/test'

import { InBothModes, inEachMode, painted } from '@/components/ui/story-kit'

import { MembershipPlanCard } from './MembershipPlanCard'

// Figma "MembershipPlanCard" (04 Components > Memberships, 1841:45273): the component as Figma draws it (405px wide,
// Champion's yearly card), in Light and in Dark, and the ways the two modules use it.

const box = (element: Element): DOMRect => element.getBoundingClientRect()
const near = (value: number): number => Math.round(value * 100) / 100

async function fontsIn(...texts: Element[]): Promise<void> {
  await document.fonts.ready
  await Promise.all(texts.map((text) => document.fonts.load(getComputedStyle(text).font)))
}

/** The card holding which offer is chosen, in a form of its own so the two modes' radios are not one group. */
function Held({ chosen: start, onChoose, ...rest }: ComponentProps<typeof MembershipPlanCard>) {
  const [chosen, setChosen] = useState(start)
  return (
    <form className="flex w-full">
      <MembershipPlanCard
        {...rest}
        chosen={chosen}
        onChoose={(value) => {
          setChosen(value)
          onChoose(value)
        }}
      />
    </form>
  )
}

const CHAMPION = {
  type: 'Unlimited sessions',
  name: 'Champion',
  offers: [
    { value: 'core', offer: 'Core', info: 'Off-Peak and Core times', price: '£1,100', comparePrice: '£1,308' },
    { value: 'allAccess', offer: 'All-Access', info: 'Every session, including Peak', price: '£1,600', comparePrice: '£1,788' },
  ],
  features: [
    { key: 'f1', text: 'Unlimited sessions' },
    { key: 'f2', text: 'Personalised sauna hat' },
    { key: 'f3', text: 'Immediate Herd benefits' },
  ],
  herdFeatures: [
    { key: 'h1', text: '3 free Smoothies per month' },
    { key: 'h2', text: 'First access to free workshops' },
    { key: 'h3', text: 'Member event and merch pricing' },
    { key: 'h4', text: 'Invite to bi-annual Supper Club' },
  ],
}

const meta = {
  title: 'Components/Memberships/MembershipPlanCard',
  component: MembershipPlanCard,
  parameters: { padded: false },
  args: { ...CHAMPION, chosen: 'core', device: 'desktop', onChoose: fn(), onAdd: fn() },
  render: (args) => (
    <InBothModes width="w-[405px]">
      <Held {...args} />
    </InBothModes>
  ),
} satisfies Meta<typeof MembershipPlanCard>

export default meta
type Story = StoryObj<typeof meta>

const partsOf = (card: HTMLElement) => ({
  card,
  type: card.querySelector('[data-plan-card="type"]') as HTMLElement | null,
  name: card.querySelector('[data-plan-card="name"]') as HTMLElement,
  body: card.querySelector('[data-plan-card="body"]') as HTMLElement,
  purchase: card.querySelector('[data-plan-card="purchase"]') as HTMLElement,
  selectors: [...card.querySelectorAll<HTMLElement>('[data-offer-selector]')],
  button: card.querySelector('button') as HTMLButtonElement,
  included: card.querySelector('[data-plan-card="included"]') as HTMLElement | null,
  herd: card.querySelector('[data-plan-card="herd"]') as HTMLElement | null,
})

const cards = (canvasElement: HTMLElement) => inEachMode(canvasElement, 'article[data-plan-card]').map(partsOf)

/** Each line of a ticked list: the tick, 8px, then the words in Copy 14; 12px between two lines. */
async function ticked(list: Element) {
  const items = [...list.querySelectorAll<HTMLElement>('[data-feature-item]')]
  for (const [index, item] of items.entries()) {
    const [tick, words] = [item.querySelector('svg') as SVGElement, item.children[1] as HTMLElement]
    await expect([near(box(tick).width), near(box(tick).height), near(box(words).left - box(tick).right), getComputedStyle(words).fontSize]).toEqual([9, 9, 8, '14px'])
    // The tick is level with the capitals of the line (Figma: half a pixel inside a 10px line).
    await expect(Math.abs(box(tick).top + box(tick).height / 2 - (box(words).top + box(words).height / 2))).toBeLessThan(1)
    const next = items[index + 1]
    if (next) await expect(near(box(next).top - box(item).bottom)).toBe(12)
  }
  return items.map((item) => item.textContent)
}

/** As Figma draws it: Champion, Yearly, Core chosen. */
export const AsDrawn: Story = {
  name: 'As Figma draws it (Champion, yearly)',
  play: async ({ canvasElement }) => {
    const found = cards(canvasElement)
    await expect(found).toHaveLength(2)
    for (const { card, type, name, body, purchase, selectors, button, included, herd } of found) {
      await fontsIn(type!, name, button.firstElementChild!)
      await expect(near(box(card).width)).toBe(405)
      await expect([getComputedStyle(card).backgroundColor, getComputedStyle(card).borderRadius]).toEqual([painted(card, 'bg-surface-card-selected'), '4px'])
      // 16px at its top and sides, 32px at its foot.
      await expect([near(box(type!).top - box(card).top), near(box(type!).left - box(card).left), near(box(card).right - box(purchase).right), near(box(card).bottom - box(body).bottom)]).toEqual([16, 16, 16, 32])
      // The line in Label 12; 80px under it the name in H1; 120px under that the offers.
      await expect([getComputedStyle(type!).fontSize, getComputedStyle(type!).textTransform, near(box(name).top - box(type!).bottom), near(box(body).top - box(name).bottom)]).toEqual(['12px', 'uppercase', 80, 120])
      await expect([name.tagName, getComputedStyle(name).fontSize, getComputedStyle(name).color]).toEqual(['H3', '28px', painted(card, 'text-text-primary', 'color')])
      // Two OfferSelectors and the button, 8px apart, each the card's whole inner width (373px).
      await expect(selectors).toHaveLength(2)
      await expect([near(box(selectors[1]!).top - box(selectors[0]!).bottom), near(box(button).top - box(selectors[1]!).bottom)]).toEqual([8, 8])
      await expect([...selectors, button].map((one) => near(box(one).width))).toEqual([373, 373, 373])
      await expect([button.textContent, getComputedStyle(button).backgroundColor]).toEqual(['Add to bag', painted(card, 'bg-surface-secondary')])
      // 40px under the button the ticked list; 32px under that "Herd benefits" in Label 12, its own list 12px under it.
      await expect(near(box(included!).top - box(button).bottom)).toBe(40)
      await expect(await ticked(included!)).toEqual(['Unlimited sessions', 'Personalised sauna hat', 'Immediate Herd benefits'])
      const title = herd!.children[0] as HTMLElement
      await expect([near(box(herd!).top - box(included!).bottom), title.textContent, getComputedStyle(title).fontSize, getComputedStyle(title).textTransform]).toEqual([32, 'Herd benefits', '12px', 'uppercase'])
      await expect(near(box(herd!.children[1]!).top - box(title).bottom)).toBe(12)
      await expect(await ticked(herd!.children[1]!)).toEqual(['3 free Smoothies per month', 'First access to free workshops', 'Member event and merch pricing', 'Invite to bi-annual Supper Club'])
      // The offers are a radio group named by the card; Core is chosen; the button is told apart by the card's name.
      const inside = within(card)
      const group = inside.getByRole('radiogroup', { name: 'Champion' })
      const radios = within(group).getAllByRole('radio') as HTMLInputElement[]
      await expect(radios.map((radio) => radio.checked)).toEqual([true, false])
      await expect(radios[0]).toHaveAccessibleName('Core Off-Peak and Core times was £1,308 now £1,100')
      await expect(inside.getByRole('button', { name: 'Add to bag' })).toHaveAccessibleDescription('Champion')
      await expect(inside.getByRole('list', { name: 'Herd benefits' })).toBe(herd!.children[1])
      await expect(card).toHaveAccessibleName('Champion')
    }
  },
}

/** A Session Pass's card: its line, its name, the two passes and one ticked line. No Herd list. */
export const SessionPass: Story = {
  name: 'A Session Pass',
  args: {
    type: 'Session Pass',
    name: '5 Session',
    offers: [
      { value: 'core', offer: 'Core', info: 'Off-Peak and Core times', price: '£70' },
      { value: 'allAccess', offer: 'All-Access', info: 'Every session, including Peak', price: '£90' },
    ],
    features: [{ key: 'valid', text: 'Valid for 3 months' }],
    herdFeatures: [],
  },
  play: async ({ canvasElement }) => {
    for (const { card, button, included, herd, selectors } of cards(canvasElement)) {
      await fontsIn(button.firstElementChild!)
      await expect(selectors).toHaveLength(2)
      await expect(near(box(included!).top - box(button).bottom)).toBe(40)
      await expect(await ticked(included!)).toEqual(['Valid for 3 months'])
      await expect(herd).toBeNull()
      await expect(card.querySelector('s')).toBeNull()
      await expect(near(box(card).bottom - box(included!).bottom)).toBe(32)
    }
  },
}

/** One offer on sale: a group of one, already chosen. */
export const OneOffer: Story = {
  name: 'One offer',
  args: { offers: [CHAMPION.offers[0]!] },
  play: async ({ canvasElement }) => {
    for (const { card, selectors, button } of cards(canvasElement)) {
      await expect(selectors).toHaveLength(1)
      const radios = within(card).getAllByRole('radio') as HTMLInputElement[]
      await expect(radios.map((radio) => radio.checked)).toEqual([true])
      await expect(near(box(button).top - box(selectors[0]!).bottom)).toBe(8)
    }
  },
}

/** No line above the name, and no lists: the card ends 32px under its button. A name on a page with no heading above the cards is an h2. */
export const NameAlone: Story = {
  name: 'No line, no lists',
  args: { type: null, features: [], herdFeatures: [], headingLevel: 2 },
  play: async ({ canvasElement }) => {
    for (const { card, type, name, button } of cards(canvasElement)) {
      await fontsIn(name)
      await expect(type).toBeNull()
      await expect([name.tagName, near(box(name).top - box(card).top), near(box(card).bottom - box(button).bottom)]).toEqual(['H2', 16, 32])
      await expect(card.querySelector('[data-plan-card="features"]')).toBeNull()
    }
  },
}

/** A benefit too long for one line wraps under itself, and its tick stays at the start of its first line. */
export const LongBenefit: Story = {
  name: 'A benefit that wraps',
  args: { device: 'mobile', features: [{ key: 'f1', text: 'Unlimited sessions at every time of day, every day of the week, the whole year round' }] },
  render: (args) => (
    <InBothModes width="w-[297px]">
      <Held {...args} />
    </InBothModes>
  ),
  play: async ({ canvasElement }) => {
    for (const { card, included, selectors } of cards(canvasElement)) {
      const item = included!.querySelector('[data-feature-item]') as HTMLElement
      const [tick, words] = [item.querySelector('svg') as SVGElement, item.children[1] as HTMLElement]
      await fontsIn(words)
      await expect(box(words).height).toBeGreaterThan(20)
      // Level with the first line's capitals, not the middle of the three lines.
      await expect(box(tick).top - box(words).top).toBeLessThan(2)
      await expect(box(words).right).toBeLessThanOrEqual(box(card).right - 16 + 0.01)
      // At a phone card's width (297px) each OfferSelector is Figma's Device=mobile.
      const price = selectors[0]!.querySelector('[data-offer="price"]') as HTMLElement
      await expect(near(box(price).top - box(selectors[0]!.querySelector('[data-offer="offer"]')!).bottom)).toBe(12)
    }
  },
}

/** Choosing an offer, by a press and by the keyboard, and Add to bag. */
export const Choosing: Story = {
  name: 'Choosing an offer, and Add to bag',
  render: (args) => (
    <div className="w-[405px] p-16">
      <Held {...args} />
    </div>
  ),
  play: async ({ canvas, args }) => {
    const [core, allAccess] = canvas.getAllByRole('radio') as [HTMLInputElement, HTMLInputElement]
    await expect([core.checked, allAccess.checked]).toEqual([true, false])
    await userEvent.click(canvas.getByText('All-Access'))
    await expect([core.checked, allAccess.checked]).toEqual([false, true])
    await expect(args.onChoose).toHaveBeenLastCalledWith('allAccess')
    allAccess.focus()
    await userEvent.keyboard('{ArrowUp}')
    await expect(core).toBeChecked()
    await expect(args.onChoose).toHaveBeenLastCalledWith('core')
    await userEvent.click(canvas.getByRole('button', { name: 'Add to bag' }))
    await expect(args.onAdd).toHaveBeenCalledTimes(1)
  },
}
