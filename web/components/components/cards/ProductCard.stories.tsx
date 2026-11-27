import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { expect, userEvent, waitFor } from 'storybook/test'

import { SAMPLE_CARDS } from '@/components/shop/sample-shop'
import { DURATION_SHORT } from '@/lib/motion/tokens'

import { ProductCard } from './ProductCard'

const meta = {
  title: 'Components/Cards/ProductCard',
  component: ProductCard,
  parameters: { nextjs: { appDirectory: true } },
  args: { card: SAMPLE_CARDS.newIn },
  // Figma draws the card 342 wide.
  render: (args) => (
    <div style={{ width: 342 }}>
      <ProductCard {...args} />
    </div>
  ),
} satisfies Meta<typeof ProductCard>

export default meta
type Story = StoryObj<typeof meta>

const strip = (canvasElement: HTMLElement) => canvasElement.querySelector('[role="group"]') as HTMLElement
const box = (element: Element) => element.getBoundingClientRect()

/**
 * Figma "ProductCard", State=default (258:5518): the picture 4 by 5 with 4px corners on Object/Product BG, the name
 * in Copy 14 and the price in Copy 12 beneath, 8px apart, and "New In" in Label 12 12px inside the picture's top
 * left while the product is new in. The whole card is one link to the product.
 */
export const NewIn: Story = {
  play: async ({ canvas, canvasElement }) => {
    const link = canvas.getByRole('link')
    await expect(link.getAttribute('href')).toBe('/shop/tee-charcoal')
    await expect(link.textContent).toContain('The Paddock T-Shirt')
    const picture = canvasElement.querySelector('img') as HTMLImageElement
    // In a <picture>, so React writes no preload link for it (W83).
    await expect(picture.parentElement!.tagName).toBe('PICTURE')
    const frame = picture.closest('picture')!.parentElement as HTMLElement
    await expect([Math.round(box(frame).width), Math.round(box(frame).height)]).toEqual([342, 428])
    await expect(getComputedStyle(frame).borderRadius).toBe('4px')
    const tag = canvas.getByText('New In')
    await expect([Math.round(box(tag).left - box(frame).left), Math.round(box(tag).top - box(frame).top)]).toEqual([12, 12])
    await expect(getComputedStyle(tag).textTransform).toBe('uppercase')
    await expect(getComputedStyle(canvas.getByText('The Paddock T-Shirt')).fontSize).toBe('14px')
    await expect(getComputedStyle(canvas.getByText('£45')).fontSize).toBe('12px')
    // The name sits 8px under the picture.
    await expect(Math.round(box(canvas.getByText('The Paddock T-Shirt')).top - box(frame).bottom)).toBe(8)
    // Until the card is hovered or takes focus its second picture is not in the page, so it is not fetched.
    await expect(canvasElement.querySelector('[data-card-hover]')).toBeNull()
    // The sizes are there for a screen reader, after the link, but can't be seen or pressed by accident.
    await expect(getComputedStyle(strip(canvasElement)).opacity).toBe('0')
    await expect(getComputedStyle(strip(canvasElement)).pointerEvents).toBe('none')
  },
}

/** A product that is neither new in nor on sale has no tag. */
export const NoTag: Story = {
  name: 'No tag',
  args: { card: SAMPLE_CARDS.plain },
  play: async ({ canvas }) => {
    await expect(canvas.queryByText('New In')).toBeNull()
  },
}

/** State=sale (1750:44156): the percent off as its tag, and the price before the sale struck through, muted, beside the price. */
export const Sale: Story = {
  args: { card: SAMPLE_CARDS.sale },
  play: async ({ canvas }) => {
    await expect(canvas.getByText('10% Off')).toBeVisible()
    const before = canvas.getByText('£45')
    await expect(before.tagName).toBe('S')
    await expect(getComputedStyle(before).textDecorationLine).toBe('line-through')
    const now = canvas.getByText('£40.50')
    await expect(getComputedStyle(now).color).not.toBe(getComputedStyle(before).color)
    // 8px between the two prices.
    await expect(Math.round(box(now).left - box(before).right)).toBe(8)
  },
}

/** State=sold out (1750:43464; WQ40): no tag, the price struck through, and "Sold Out" in Label 12 beneath it. */
export const SoldOut: Story = {
  name: 'Sold out',
  args: { card: { ...SAMPLE_CARDS.soldOut, tag: null } },
  play: async ({ canvas, canvasElement }) => {
    const price = canvas.getByText('£45')
    await expect(getComputedStyle(price).textDecorationLine).toBe('line-through')
    const label = canvas.getByText('Sold Out')
    await expect(getComputedStyle(label).textTransform).toBe('uppercase')
    await expect(Math.round(box(label).top - box(price).bottom)).toBe(8)
    await expect(canvasElement.querySelector('.absolute.top-12')).toBeNull()
    // Every size of its strip is in its OOS state, and can't be pressed.
    for (const size of ['S', 'M', 'L', 'XL']) await expect(canvas.getByRole('button', { name: `${size}, sold out` })).toBeDisabled()
  },
}

/**
 * State=hover (258:5519), on a device with a mouse: the gallery's second picture, and the sizes in a strip of
 * Surface/Primary 4px inside the picture's foot (SizeSelect: Copy 12, 8px above and below). The keyboard gets the
 * same: this story moves focus into the card, as Tab does. A size in the strip adds it to the bag, which does
 * nothing yet.
 */
export const Hover: Story = {
  play: async ({ canvas, canvasElement }) => {
    await userEvent.tab()
    await expect(canvas.getByRole('link')).toHaveFocus()
    const sizes = strip(canvasElement)
    await waitFor(() => expect(getComputedStyle(sizes).opacity).toBe('1'))
    await expect(getComputedStyle(sizes).pointerEvents).toBe('auto')
    await expect(getComputedStyle(sizes).transitionDuration).toContain(`${DURATION_SHORT}s`)
    const frame = (canvasElement.querySelector('img') as HTMLElement).closest('picture')!.parentElement as HTMLElement
    await waitFor(() => expect([Math.round(box(sizes).left - box(frame).left), Math.round(box(frame).right - box(sizes).right), Math.round(box(frame).bottom - box(sizes).bottom)]).toEqual([4, 4, 4]))
    // The second picture is in the page now, over the first.
    const second = canvasElement.querySelector('[data-card-hover]') as HTMLImageElement
    await waitFor(() => expect(getComputedStyle(second).opacity).toBe('1'))
    // The sizes follow the link, in their order.
    await userEvent.tab()
    await expect(canvas.getByRole('button', { name: 'S' })).toHaveFocus()
    await userEvent.tab()
    await expect(canvas.getByRole('button', { name: 'M' })).toHaveFocus()
    await expect(getComputedStyle(canvas.getByRole('button', { name: 'M' }).firstElementChild as HTMLElement).fontSize).toBe('12px')
    // Pressing one changes nothing on the page: the bag is not built yet.
    await userEvent.keyboard('{Enter}')
    await expect(canvas.getByRole('button', { name: 'M' })).toHaveFocus()
  },
}

/** One size left: the others are in SizeSelect's OOS state (muted, struck through), and read "S, sold out". */
export const OneSizeLeft: Story = {
  name: 'Hover, one size left',
  args: { card: SAMPLE_CARDS.oneSizeLeft },
  play: async ({ canvas }) => {
    await userEvent.tab()
    await expect(canvas.getByRole('button', { name: 'L' })).toBeEnabled()
    for (const size of ['S', 'M', 'XL']) await expect(canvas.getByRole('button', { name: `${size}, sold out` })).toBeDisabled()
    // Tab passes over the sizes that are gone.
    await userEvent.tab()
    await expect(canvas.getByRole('button', { name: 'L' })).toHaveFocus()
  },
}

/** When its sizes differ in price the card says "From" before the lowest. */
export const FromPrice: Story = {
  name: 'From a price',
  args: { card: SAMPLE_CARDS.fromPrice },
  play: async ({ canvas }) => {
    await expect(canvas.getByText('From £45')).toBeVisible()
  },
}

/**
 * The gift card's card (WQ19, WQ41): its picture, "From" its lowest amount on sale, and a link to /shop/gift-card.
 * No tag and no sizes on hover.
 */
export const GiftCard: Story = {
  name: 'Gift card',
  args: { card: SAMPLE_CARDS.giftCard },
  play: async ({ canvas, canvasElement }) => {
    await expect(canvas.getByRole('link').getAttribute('href')).toBe('/shop/gift-card')
    await expect(canvas.getByText('From £15')).toBeVisible()
    await expect(canvas.queryAllByRole('button')).toHaveLength(0)
    await userEvent.tab()
    await expect(canvasElement.querySelector('[data-card-hover]')).toBeNull()
  },
}

/** Every state side by side, as Figma's component set. */
export const AllStates: Story = {
  name: 'All states',
  render: () => (
    <div className="grid grid-cols-2 gap-x-8 gap-y-40 md:grid-cols-4">
      <ProductCard card={SAMPLE_CARDS.newIn} />
      <ProductCard card={SAMPLE_CARDS.sale} />
      <ProductCard card={SAMPLE_CARDS.soldOut} />
      <ProductCard card={SAMPLE_CARDS.giftCard} />
    </div>
  ),
}
