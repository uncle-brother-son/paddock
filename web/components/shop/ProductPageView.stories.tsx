import type { Meta, StoryObj } from '@storybook/nextjs-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'

import { OverlayTexture } from '@/components/ui/media/Overlay'
import type { ShopAvailabilityRouteOutput } from '@/contracts/shop'
import { DURATION_SHORT, EASE_SMOOTH_CSS } from '@/lib/motion/tokens'

import { ProductPageView } from './ProductPageView'
import { SAMPLE_PRODUCT, SAMPLE_PRODUCT_ON_SALE, SAMPLE_PRODUCT_ONE_LEFT, SAMPLE_PRODUCT_SOLD_OUT, SAMPLE_SIMILAR, SAMPLE_SIZES } from './sample-shop'

const meta = {
  title: 'Shop/Product',
  component: ProductPageView,
  parameters: { padded: false, layout: 'fullscreen', nextjs: { appDirectory: true } },
  // A story asks no route for its sizes: it shows what it was given.
  args: { view: SAMPLE_PRODUCT, similar: SAMPLE_SIMILAR, readSizes: null, reducedMotion: true },
  render: (args) => (
    <>
      <OverlayTexture />
      <ProductPageView {...args} />
    </>
  ),
} satisfies Meta<typeof ProductPageView>

export default meta
type Story = StoryObj<typeof meta>

const box = (element: Element) => element.getBoundingClientRect()
const part = (canvasElement: HTMLElement, name: string) => canvasElement.querySelector(`[data-shop="${name}"]`) as HTMLElement

/**
 * Figma "Product" (1684:41920). The gallery fills the window's left half to the end of the grid's 12th column, its
 * pictures stacked, each 4 by 5; the details (Figma "ProductInfoContainer", Type=product) are columns 15 to 21, 240px down, and stick
 * to the window's top while the gallery scrolls past. Then Similar Merch. The states of its button (Figma "CallToAction",
 * Type=product) are the stories below.
 */
export const Desktop: Story = {
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    const gallery = part(canvasElement, 'gallery')
    await expect([Math.round(box(gallery).left), Math.round(box(gallery).width)]).toEqual([0, 716])
    const pictures = [...gallery.querySelectorAll('[data-gallery-item]')]
    await expect(pictures.map((picture) => [Math.round(box(picture).width), Math.round(box(picture).height)])).toEqual([[716, 895], [716, 895], [716, 895]])
    await expect(Math.round(box(pictures[1]!).top - box(pictures[0]!).top)).toBe(895)
    // Only the first picture loads ahead of the rest.
    await expect([...gallery.querySelectorAll('img')].map((image) => image.loading)).toEqual(['eager', 'lazy', 'lazy'])
    const details = part(canvasElement, 'details')
    await expect([Math.round(box(details).left), Math.round(box(details).width)]).toEqual([842, 405])
    await expect(getComputedStyle(details).position).toBe('sticky')
    // Wayne, 26 Nov: read aloud with its colour, which tells one colour's page from another's; nothing seen changes
    // (the colour's words take no room in the heading: it is as tall as one line of its capitals, and no wider).
    // (A browser may count a space between the name and the hidden words; said aloud it is the same.)
    const name = canvas.getByRole('heading', { level: 1, name: /^The Paddock T-Shirt ?, Brown$/ })
    await expect(name.textContent).toBe('The Paddock T-Shirt, Brown')
    const colourAloud = name.querySelector('span') as HTMLElement
    await expect([colourAloud.textContent, getComputedStyle(colourAloud).position, Math.round(box(colourAloud).width), Math.round(box(colourAloud).height)]).toEqual([', Brown', 'absolute', 1, 1])
    await expect(name.firstChild?.textContent).toBe('The Paddock T-Shirt')
    await expect(Math.round(box(name).top)).toBe(240)
    await expect(getComputedStyle(name).fontSize).toBe('24px')
    // The price line: £45 (Member from £40), 24px under the name.
    const price = within(details).getByText('£45')
    await expect(price).toBeVisible()
    await expect(canvas.getByText('(Member from £40)')).toBeVisible()
    await expect(Math.round(box(price).top - box(name).bottom)).toBe(24)
    // Colour: its name, and a swatch for each colour of its family, a sixth of the width each, this one marked.
    await expect(canvas.getByText('Brown')).toBeVisible()
    const colours = within(canvas.getByRole('list', { name: 'Colours' }))
    const [brown, white] = colours.getAllByRole('link')
    await expect([brown!.getAttribute('aria-current'), white!.getAttribute('aria-current'), white!.getAttribute('href')]).toEqual(['page', null, '/shop/tee-white'])
    // WQ52: the swatch of the colour on show is the one marked. (A page arriving by a swatch gives focus to the name.)
    await expect(canvasElement.querySelector('[data-shop="swatch"][aria-current="page"]')).toBe(brown)
    await expect(Math.round(box(brown!).width)).toBe(64)
    await expect(Math.round(box(white!).left - box(brown!).right)).toBe(4)
    // Size: a chip for each (SizeSelect, Big: Copy 14, 16px above and below), 4px apart, across the details' width.
    const sizes = within(canvas.getByRole('radiogroup', { name: 'Size' })).getAllByRole('radio')
    await expect(sizes.map((size) => size.getAttribute('aria-label'))).toEqual(['S', 'M', 'L', 'XL'])
    const chips = sizes.map((size) => size.parentElement!)
    await expect([Math.round(box(chips[0]!).left), Math.round(box(chips[3]!).right), Math.round(box(chips[1]!).left - box(chips[0]!).right)]).toEqual([842, 1247, 4])
    await expect(canvas.getByRole('button', { name: 'Size guide' })).toBeVisible()
    // The button, the whole width, and the line under it.
    const button = canvas.getByRole('button', { name: 'Add to bag' })
    await expect([Math.round(box(button).width), Math.round(box(button).height)]).toEqual([405, 40])
    await expect(canvas.getByText('Delivery or collection from the Paddock.')).toBeVisible()
    // The links that open the Product Info Panel, in Label 12, 64px under the rest.
    await expect(['Description', 'Materials & care', 'Shipping & returns'].map((label) => canvas.getByRole('button', { name: label }).getAttribute('aria-haspopup'))).toEqual(['dialog', 'dialog', 'dialog'])
    // Similar Merch: its heading and "Shop all" to /shop, and four cards of 7 columns each, 8px apart.
    const similar = within(part(canvasElement, 'similar'))
    await expect(similar.getByRole('heading', { level: 2, name: 'Similar Merch' })).toBeVisible()
    await expect(similar.getByRole('link', { name: 'Shop all' }).getAttribute('href')).toBe('/shop')
    const cards = [...part(canvasElement, 'similar').querySelectorAll('article')]
    await expect(cards.map((card) => Math.round(box(card).left))).toEqual([16, 429, 842, 1255])
    await expect(Math.round(box(cards[0]!).width)).toBe(405)
  },
}

/**
 * Figma "Product (mobile)" (1684:41990): the gallery is the window's whole width, a row to swipe, with the slider
 * beneath it (WQ76: one part for each picture, and one part's length filled, which follows the swipe: its own
 * stories are Shop/Gallery); the details follow, 24px under.
 */
export const Mobile: Story = {
  globals: { viewport: { value: 'mobile', isRotated: false } },
  play: async ({ canvas, canvasElement }) => {
    const gallery = part(canvasElement, 'gallery')
    const pictures = [...gallery.querySelectorAll('[data-gallery-item]')]
    await expect(pictures.slice(0, 2).map((picture) => [Math.round(box(picture).left), Math.round(box(picture).width), Math.round(box(picture).height)])).toEqual([[0, 390, 488], [390, 390, 488]])
    const slider = gallery.querySelector('[data-gallery-slider]') as HTMLElement
    const filled = slider.querySelector('[data-gallery-filled]') as HTMLElement
    await expect(slider.querySelectorAll('[data-gallery-slide]')).toHaveLength(3)
    await expect(Math.round(box(slider).top - box(pictures[0]!).bottom)).toBe(4)
    await expect([Math.round(box(filled).left), Math.round(box(filled).width)]).toEqual([0, 130])
    // Swiping to the second picture moves the filled part on.
    const row = canvas.getByRole('group', { name: 'Product pictures' })
    row.scrollTo({ left: 390, behavior: 'instant' })
    await waitFor(() => expect(Math.round(box(filled).left)).toBe(130))
    // The page itself never scrolls sideways.
    await expect(document.documentElement.scrollWidth).toBe(390)
    const name = canvas.getByRole('heading', { level: 1 })
    await expect([Math.round(box(name).left), Math.round(box(name).top - box(gallery).bottom)]).toEqual([16, 24])
    // Similar Merch: two cards to the window, the third begun.
    const cards = [...part(canvasElement, 'similar').querySelectorAll('article')]
    await expect(cards.slice(0, 3).map((card) => Math.round(box(card).left))).toEqual([16, 199, 382])
    await expect(Math.round(box(cards[0]!).width)).toBe(175)
  },
}

/**
 * WQ73: in a window shorter than the details (1024 by 768) the details move with the page until their bottom is at
 * the bottom of the window, and stay there; back up, their top stops at the top of the window. How it sticks has its
 * own stories (Shop/Details column); this is the Product page using it.
 */
export const ShortWindow: Story = {
  globals: { viewport: { value: 'w1024', isRotated: false } },
  play: async ({ canvasElement }) => {
    const details = part(canvasElement, 'details')
    const height = () => document.documentElement.clientHeight
    const over = details.offsetHeight - height()
    await expect(over).toBeGreaterThan(0)
    await waitFor(() => expect([getComputedStyle(details).position, details.style.top, details.style.bottom]).toEqual(['sticky', `${-over}px`, `${-over}px`]))
    window.scrollTo({ top: Math.round(over / 2), behavior: 'instant' })
    await waitFor(() => expect(Math.round(box(details).top)).toBe(-Math.round(over / 2)))
    window.scrollTo({ top: over + 300, behavior: 'instant' })
    await waitFor(() => expect(Math.round(box(details).bottom)).toBe(height()))
    window.scrollTo({ top: 0, behavior: 'instant' })
    await waitFor(() => expect(Math.round(box(details).top)).toBe(0))
  },
}

/**
 * CallToAction, State=select size (1684:39453): pressing "Add to bag" with no size picked says "Please select a size" in
 * Text/Error under the sizes. Picking one clears it and fills the chip (Surface/Secondary); pressing again goes to
 * the bag, which does nothing yet.
 */
export const SelectSize: Story = {
  name: 'Select size',
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async ({ canvas }) => {
    const button = canvas.getByRole('button', { name: 'Add to bag' })
    await userEvent.click(button)
    const wrong = await canvas.findByRole('alert')
    await expect(wrong.textContent).toBe('Please select a size')
    await expect(getComputedStyle(wrong).fontSize).toBe('12px')
    const medium = canvas.getByRole('radio', { name: 'M' })
    await expect(medium.getAttribute('aria-describedby')).toBe(wrong.id)
    await userEvent.click(medium)
    await expect(medium).toBeChecked()
    await expect(canvas.queryByRole('alert')).toBeNull()
    const chip = medium.parentElement!
    await waitFor(() => expect(getComputedStyle(chip).backgroundColor).toBe(getComputedStyle(button).backgroundColor))
    // The arrow keys move between the sizes, as on any group of radio buttons.
    await userEvent.keyboard('{ArrowRight}')
    await expect(canvas.getByRole('radio', { name: 'L' })).toBeChecked()
    await userEvent.click(button)
    await expect(canvas.queryByRole('alert')).toBeNull()
  },
}

/**
 * WQ51: with no size chosen, a mouse over the button slides "Add to bag" up out of it and "Select size" in from
 * beneath, over the short duration with the smooth curve; leaving reverses it. Only a mouse does it (never a touch
 * screen, the keyboard or reduced motion: `label-swap` in app/globals.css, held by lib/design/tokens.test.ts), and
 * the button's name stays "Add to bag". Once a size is picked there is no second label. Hover it to see.
 */
export const SelectSizeOnHover: Story = {
  name: 'Select size, on hover',
  globals: { viewport: { value: 'desktop', isRotated: false } },
  play: async ({ canvas }) => {
    const button = canvas.getByRole('button', { name: 'Add to bag' })
    const [rest, onHover] = [button.querySelector('[data-label="rest"]') as HTMLElement, button.querySelector('[data-label="hover"]') as HTMLElement]
    // Its name is its own label alone: the second is for the eye only.
    await expect([rest.textContent, onHover.textContent, onHover.getAttribute('aria-hidden')]).toEqual(['Add to bag', 'Select size', 'true'])
    await expect(button).toHaveAccessibleName('Add to bag')
    // The button as it was: the whole width, 40 tall, its label in the middle.
    await expect([Math.round(box(button).width), Math.round(box(button).height)]).toEqual([405, 40])
    const label = rest.firstElementChild as HTMLElement
    await expect(Math.abs(box(label).top + box(label).height / 2 - (box(button).top + 20))).toBeLessThan(1)
    await expect(Math.abs(box(label).left + box(label).width / 2 - (box(button).left + box(button).width / 2))).toBeLessThan(1)
    // At rest "Select size" waits one button's height beneath, where the button clips it.
    await expect([Math.round(box(onHover).top - box(button).bottom), getComputedStyle(button).overflow]).toEqual([0, 'clip'])
    // Each travels over the short duration with the smooth curve, and nothing but its place changes.
    for (const one of [rest, onHover]) {
      const style = getComputedStyle(one)
      await expect([style.transitionProperty, style.transitionDuration]).toEqual(['translate', `${DURATION_SHORT}s`])
      await expect(style.transitionTimingFunction).toBe(EASE_SMOOTH_CSS)
    }
    // Keyboard focus changes nothing: the label stays.
    button.focus()
    await expect([getComputedStyle(rest).translate, Math.round(box(onHover).top - box(button).bottom)]).toEqual(['none', 0])
    // A press with no size still shows the error, exactly as before.
    await userEvent.click(button)
    await expect((await canvas.findByRole('alert')).textContent).toBe('Please select a size')
    await expect(button.querySelector('[data-label="hover"]')).not.toBeNull()
    // With a size picked there is nothing to say on hover: one label, "Add to bag".
    await userEvent.click(canvas.getByRole('radio', { name: 'M' }))
    await waitFor(() => expect(button.querySelector('[data-label]')).toBeNull())
    await expect(button.textContent).toBe('Add to bag')
    await expect(canvas.getByRole('button', { name: 'Add to bag' })).toBe(button)
  },
}

/** On sale: the price before the sale struck through beside the price, as CallToAction's member state draws a struck price. */
export const Sale: Story = {
  globals: { viewport: { value: 'desktop', isRotated: false } },
  args: { view: SAMPLE_PRODUCT_ON_SALE },
  play: async ({ canvas, canvasElement }) => {
    const details = within(part(canvasElement, 'details'))
    const before = details.getByText('£45')
    await expect(getComputedStyle(before).textDecorationLine).toBe('line-through')
    await expect(details.getByText('£40.50')).toBeVisible()
    await expect(canvas.getByText('(Member from £40)')).toBeVisible()
  },
}

/**
 * CallToAction, State=sold out (1684:39402): every size in its sold-out state (Surface/Card Disabled, muted, struck through)
 * and the button disabled, reading "Sold out".
 */
export const SoldOut: Story = {
  name: 'Sold out',
  globals: { viewport: { value: 'desktop', isRotated: false } },
  args: { view: SAMPLE_PRODUCT_SOLD_OUT },
  play: async ({ canvas }) => {
    const button = canvas.getByRole('button', { name: 'Sold out' })
    await expect(button).toBeDisabled()
    for (const size of ['S', 'M', 'L', 'XL']) await expect(canvas.getByRole('radio', { name: `${size}, sold out` })).toBeDisabled()
    await userEvent.click(button)
    await expect(canvas.queryByRole('alert')).toBeNull()
  },
}

/** One size left: the others are struck through and can't be picked, and read "S, sold out". */
export const OneSizeLeft: Story = {
  name: 'One size left',
  globals: { viewport: { value: 'desktop', isRotated: false } },
  args: { view: SAMPLE_PRODUCT_ONE_LEFT },
  play: async ({ canvas }) => {
    await expect(canvas.getByRole('radio', { name: 'L' })).toBeEnabled()
    for (const size of ['S', 'M', 'XL']) await expect(canvas.getByRole('radio', { name: `${size}, sold out` })).toBeDisabled()
    await expect(canvas.getByRole('button', { name: 'Add to bag' })).toBeEnabled()
  },
}

/**
 * The page's HTML can be up to a minute old, so once it has loaded it asks the availability route for its sizes
 * again. Here the route says M has gone since: it is struck through as soon as the answer is in.
 */
export const SizesAskedAgain: Story = {
  name: 'Sizes asked again after load',
  globals: { viewport: { value: 'desktop', isRotated: false } },
  args: {
    readSizes: async (product: string): Promise<ShopAvailabilityRouteOutput> => ({ product, soldOut: false, sizes: SAMPLE_SIZES.map((size) => ({ ...size, available: size.size !== 'M' })) }),
  },
  play: async ({ canvas }) => {
    await expect(await canvas.findByRole('radio', { name: 'M, sold out' })).toBeDisabled()
    await expect(canvas.getByRole('radio', { name: 'S' })).toBeEnabled()
  },
}

/** A product with no family has no swatches: its colour's name alone. */
export const NoFamily: Story = {
  name: 'No family',
  globals: { viewport: { value: 'desktop', isRotated: false } },
  args: { view: { ...SAMPLE_PRODUCT, colours: [] } },
  play: async ({ canvas }) => {
    await expect(canvas.getByText('Brown')).toBeVisible()
    await expect(canvas.queryByRole('list', { name: 'Colours' })).toBeNull()
  },
}

/** A product with no size guide has no "Size guide" link (WQ39), and its panel no Size Guide tab. */
export const NoSizeGuide: Story = {
  name: 'No size guide',
  globals: { viewport: { value: 'desktop', isRotated: false } },
  args: { view: { ...SAMPLE_PRODUCT, sizeGuide: null } },
  play: async ({ canvas }) => {
    await expect(canvas.queryByRole('button', { name: 'Size guide' })).toBeNull()
    await expect(canvas.queryByRole('tab', { name: 'Size Guide', hidden: true })).toBeNull()
    await expect(canvas.getAllByRole('tab', { hidden: true })).toHaveLength(3)
  },
}

/** With nothing similar on sale the Similar Merch row is not drawn. */
export const NothingSimilar: Story = {
  name: 'Nothing similar',
  globals: { viewport: { value: 'desktop', isRotated: false } },
  args: { similar: [] },
  play: async ({ canvasElement }) => {
    await expect(part(canvasElement, 'similar')).toBeNull()
  },
}
