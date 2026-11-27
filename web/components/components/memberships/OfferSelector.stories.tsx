import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { useState, type ComponentProps } from 'react'
import { expect, fn, userEvent, waitFor } from 'storybook/test'

import { InBothModes, inEachMode, painted } from '@/components/ui/story-kit'

import { OfferSelector } from './OfferSelector'

// Figma "OfferSelector" (04 Components > Memberships, 1841:45039): a story for each of Figma's six variants, under
// Figma's name for it, in Light and in Dark, at the width Figma draws the set (371px); then what the site adds.

const box = (element: Element): DOMRect => element.getBoundingClientRect()
const near = (value: number): number => Math.round(value * 100) / 100

async function fontsIn(...texts: Element[]): Promise<void> {
  await document.fonts.ready
  await Promise.all(texts.map((text) => document.fonts.load(getComputedStyle(text).font)))
}

/** One OfferSelector holding its own state, in a form of its own so the two modes' are not one group. */
function Held({ checked: start, onChange, ...rest }: ComponentProps<typeof OfferSelector>) {
  const [checked, setChecked] = useState(start)
  return (
    <form className="w-full">
      <OfferSelector
        {...rest}
        checked={checked}
        onChange={() => {
          setChecked(true)
          onChange()
        }}
      />
    </form>
  )
}

const meta = {
  title: 'Components/Memberships/OfferSelector',
  component: OfferSelector,
  parameters: { padded: false },
  args: { name: 'foal', value: 'core', checked: false, offer: 'Core', info: 'Off-Peak and Core times', price: '£45', comparePrice: null, device: 'desktop', onChange: fn() },
  render: (args) => (
    <InBothModes width="w-[371px]">
      <Held {...args} />
    </InBothModes>
  ),
} satisfies Meta<typeof OfferSelector>

export default meta
type Story = StoryObj<typeof meta>

const partsOf = (selector: HTMLElement) => {
  const offer = selector.querySelector('[data-offer="offer"]') as HTMLElement
  return {
    selector,
    radio: selector.querySelector('[data-radio]') as HTMLElement,
    dot: selector.querySelector('[data-radio] > span') as HTMLElement,
    input: selector.querySelector('input') as HTMLInputElement,
    info: selector.querySelector('[data-offer="info"]') as HTMLElement,
    offer,
    name: offer.children[0] as HTMLElement,
    words: offer.children[1] as HTMLElement,
    price: selector.querySelector('[data-offer="price"]') as HTMLElement,
  }
}

const selectors = (canvasElement: HTMLElement) => inEachMode(canvasElement, '[data-offer-selector]').map(partsOf)

/** What every variant has: its fill, corners and padding, the Radio, and the words in their styles. */
async function looks(canvasElement: HTMLElement, device: 'desktop' | 'mobile') {
  const found = selectors(canvasElement)
  await expect(found).toHaveLength(2)
  for (const { selector, radio, info, offer, name, words, price } of found) {
    await fontsIn(name, words, price.lastElementChild!)
    await expect(near(box(selector).width)).toBe(371)
    await expect([getComputedStyle(selector).backgroundColor, getComputedStyle(selector).borderRadius]).toEqual([painted(selector, 'bg-surface-primary'), '4px'])
    // 24px all round; the Radio, 12px, then the words.
    await expect([near(box(radio).left - box(selector).left), near(box(info).left - box(radio).right), near(box(offer).top - box(selector).top), near(box(selector).right - box(info).right)]).toEqual([24, 12, 24, 24])
    await expect([near(box(radio).width), near(box(radio).height)]).toEqual([20, 20])
    await expect(Math.abs(box(radio).top + box(radio).height / 2 - (box(selector).top + box(selector).height / 2))).toBeLessThan(0.51)
    // The level in Label 12; 8px under it what it covers, in Copy 12, Text/Muted Primary; the price in H2.
    await expect([getComputedStyle(name).fontSize, getComputedStyle(name).textTransform, getComputedStyle(name).color]).toEqual(['12px', 'uppercase', painted(selector, 'text-text-primary', 'color')])
    await expect([getComputedStyle(words).fontSize, getComputedStyle(words).color, near(box(words).top - box(name).bottom)]).toEqual(['12px', painted(selector, 'text-text-muted-primary', 'color'), 8])
    await expect(getComputedStyle(price.lastElementChild!).color).toBe(painted(selector, 'text-text-primary', 'color'))
    if (device === 'desktop') {
      // The price at the right, its foot level with the foot of the words.
      await expect(near(box(selector).right - box(price).right)).toBe(24)
      await expect(Math.abs(box(price).bottom - box(offer).bottom)).toBeLessThan(0.51)
      await expect(box(price).left).toBeGreaterThan(box(name).right)
    } else {
      // The price 12px under the words, at their left; the words the whole width.
      await expect([near(box(price).top - box(offer).bottom), near(box(price).left - box(offer).left), near(box(info).right - box(offer).right)]).toEqual([12, 0, 0])
      await expect(near(box(selector).bottom - box(price).bottom)).toBe(24)
    }
  }
  return found
}

const atRest = async (canvasElement: HTMLElement, device: 'desktop' | 'mobile') => {
  for (const { radio, dot, input } of await looks(canvasElement, device)) {
    await expect([getComputedStyle(radio).backgroundColor, getComputedStyle(dot).opacity]).toEqual([painted(radio, 'bg-surface-card-selected'), '0'])
    await expect(input).not.toBeChecked()
    await expect(input).toHaveAccessibleName('Core Off-Peak and Core times £45')
  }
}

const underMouse = async (canvasElement: HTMLElement, device: 'desktop' | 'mobile') => {
  for (const { radio, dot, input } of await looks(canvasElement, device)) {
    // The Radio's State=hover wherever the mouse is on the selector: its dot shows, in Text/Muted Primary.
    const muted = painted(radio, 'bg-text-muted-primary')
    await waitFor(() => expect([getComputedStyle(dot).opacity, getComputedStyle(dot).backgroundColor]).toEqual(['1', muted]))
    await expect(getComputedStyle(radio).backgroundColor).toBe(painted(radio, 'bg-surface-card-selected'))
    await expect(input).not.toBeChecked()
  }
}

const chosen = async (canvasElement: HTMLElement, device: 'desktop' | 'mobile') => {
  for (const { selector, radio, dot, input } of await looks(canvasElement, device)) {
    await expect([getComputedStyle(radio).backgroundColor, getComputedStyle(dot).backgroundColor, getComputedStyle(dot).opacity]).toEqual([painted(radio, 'bg-surface-secondary'), painted(radio, 'bg-text-secondary'), '1'])
    await expect(input).toBeChecked()
    // Only the Radio changes: the fill is the same.
    await expect(getComputedStyle(selector).backgroundColor).toBe(painted(selector, 'bg-surface-primary'))
  }
}

export const DesktopDefault: Story = { name: 'Device=desktop, State=default', play: async ({ canvasElement }) => atRest(canvasElement, 'desktop') }

export const DesktopHover: Story = { name: 'Device=desktop, State=hover', globals: { pseudo: 'hover' }, play: async ({ canvasElement }) => underMouse(canvasElement, 'desktop') }

export const DesktopSelected: Story = { name: 'Device=desktop, State=selected', args: { checked: true }, play: async ({ canvasElement }) => chosen(canvasElement, 'desktop') }

export const MobileDefault: Story = { name: 'Device=mobile, State=default', args: { device: 'mobile' }, play: async ({ canvasElement }) => atRest(canvasElement, 'mobile') }

export const MobileHover: Story = { name: 'Device=mobile, State=hover', args: { device: 'mobile' }, globals: { pseudo: 'hover' }, play: async ({ canvasElement }) => underMouse(canvasElement, 'mobile') }

export const MobileSelected: Story = { name: 'Device=mobile, State=selected', args: { device: 'mobile', checked: true }, play: async ({ canvasElement }) => chosen(canvasElement, 'mobile') }

/** Show Compare Price: a yearly price with the price it is struck against 4px before it, in Copy 12, Text/Muted Primary. */
export const ComparePrice: Story = {
  name: 'Show Compare Price=yes',
  args: { checked: true, price: '£1,100', comparePrice: '£1,308', value: 'core' },
  play: async ({ canvasElement }) => {
    for (const { selector, price, input, offer } of await looks(canvasElement, 'desktop')) {
      const [before, now] = [price.children[0] as HTMLElement, price.children[1] as HTMLElement]
      await expect(before.tagName).toBe('S')
      await expect([getComputedStyle(before).textDecorationLine, getComputedStyle(before).fontSize, getComputedStyle(before).color]).toEqual(['line-through', '12px', painted(selector, 'text-text-muted-primary', 'color')])
      await expect([near(box(now).left - box(before).right), Math.abs(box(now).bottom - box(before).bottom) < 0.51]).toEqual([4, true])
      // Both on one line beside the words, as Figma's Champion card draws them.
      await expect(box(price).left).toBeGreaterThan(box(offer.children[0]!).right)
      // A screen reader hears which is which.
      await expect(input).toHaveAccessibleName('Core Off-Peak and Core times was £1,308 now £1,100')
    }
  },
}

/**
 * With no `device` it answers to its own width: Device=desktop from the width Figma draws that one at (371px), and
 * Device=mobile when narrower, as on a phone's card (265px).
 */
export const ByItsOwnWidth: Story = {
  name: 'Its own width decides: 371px is desktop, 265px is mobile',
  args: { price: '£1,600', comparePrice: '£1,788', offer: 'All-Access', info: 'Every session, including Peak', value: 'allAccess' },
  render: ({ device, ...args }) => {
    void device
    return (
      <div className="flex flex-col gap-16 p-16">
        <form data-width="371" className="w-[371px]">
          <OfferSelector {...args} />
        </form>
        <form data-width="370" className="w-[370px]">
          <OfferSelector {...args} />
        </form>
        <form data-width="265" className="w-[265px]">
          <OfferSelector {...args} />
        </form>
      </div>
    )
  },
  play: async ({ canvasElement }) => {
    const at = (width: number) => partsOf(canvasElement.querySelector(`[data-width="${width}"] [data-offer-selector]`) as HTMLElement)
    await fontsIn(at(371).name, at(371).words, at(371).price.lastElementChild!)
    const beside = ({ price, offer }: ReturnType<typeof partsOf>) => box(price).left >= box(offer).right && Math.abs(box(price).bottom - box(offer).bottom) < 0.51
    const beneath = ({ price, offer }: ReturnType<typeof partsOf>) => near(box(price).top - box(offer).bottom) === 12 && near(box(price).left - box(offer).left) === 0
    await expect([beside(at(371)), beneath(at(371))]).toEqual([true, false])
    await expect([beside(at(370)), beneath(at(370))]).toEqual([false, true])
    await expect([beside(at(265)), beneath(at(265))]).toEqual([false, true])
    // Nothing is cut off or runs out of it at a phone card's width.
    const narrow = at(265)
    await expect(box(narrow.price).right).toBeLessThanOrEqual(box(narrow.selector).right - 24 + 0.01)
    await expect(narrow.selector.scrollWidth).toBeLessThanOrEqual(narrow.selector.clientWidth)
  },
}

/** Two of them in a card's radio group: a press anywhere on one chooses it, and the arrow keys move between them. */
function Pair({ onChange }: { onChange: (value: string) => void }) {
  const [value, setValue] = useState('core')
  const choose = (next: string) => {
    setValue(next)
    onChange(next)
  }
  return (
    <div role="radiogroup" aria-label="Foal" className="flex w-[371px] flex-col gap-8 p-16">
      <OfferSelector name="pair" value="core" checked={value === 'core'} onChange={() => choose('core')} offer="Core" info="Off-Peak and Core times" price="£45" />
      <OfferSelector name="pair" value="allAccess" checked={value === 'allAccess'} onChange={() => choose('allAccess')} offer="All-Access" info="Every session, including Peak" price="£59" />
    </div>
  )
}

export const Choosing: Story = {
  name: 'Chosen by a press anywhere on it, and by the arrow keys',
  render: ({ onChange }) => <Pair onChange={onChange as unknown as (value: string) => void} />,
  play: async ({ canvas, args }) => {
    const group = canvas.getByRole('radiogroup', { name: 'Foal' })
    const [core, allAccess] = canvas.getAllByRole('radio') as [HTMLInputElement, HTMLInputElement]
    await expect(group).toContainElement(core)
    await expect([core.checked, allAccess.checked]).toEqual([true, false])
    // A press on the price, far from the Radio, chooses it: the whole of it is the radio's label.
    await userEvent.click(canvas.getByText('£59'))
    await expect([core.checked, allAccess.checked]).toEqual([false, true])
    await expect(args.onChange).toHaveBeenLastCalledWith('allAccess')
    allAccess.focus()
    await userEvent.keyboard('{ArrowUp}')
    await expect([core.checked, allAccess.checked]).toEqual([true, false])
    await expect(core).toHaveFocus()
    await userEvent.keyboard('{ArrowDown}')
    await expect(allAccess).toBeChecked()
  },
}
